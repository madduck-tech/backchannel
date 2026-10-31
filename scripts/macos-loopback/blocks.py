#!/usr/bin/env python3
"""A continuous stream of numbered blocks and its decoder, for A3 (#302).

    blocks.py gen <out-dir> --minutes M --seed S [--direction 0|1] [--judge]
        writes blocks.wav (48 kHz mono s16) and schedule.json (N, the first number, direction)
    blocks.py tune <recording> <schedule.json> <free-recording> --seed S_t
        places the energy floor and symbol threshold, measures tau, writes blocks-threshold.json
    blocks.py decode <recording> <schedule.json> [--track LABEL] [--direction D] > decode.json
    blocks.py judge <decode.json> [--zero CATEGORY ...]
        exits 1 when a named category is not zero, 2 when the decode is void
    blocks.py level <recording> <decode.json>
        the acoustic validity checks, as level.py does for markers

Block: L = 60 ms, 12 symbols of 5 ms, each symbol one of 16 tones 400-3400 Hz on a 200 Hz grid
(the grid a 5 ms symbol resolves), phase-continuous, so the envelope is constant and never
silent. Payload: 48 bits = direction (1) | sequence number (23) | CRC-24 (OpenPGP polynomial,
non-zero init and xorout, so no all-zero word is a codeword). F0 on #302 chose this encoding:
uncoded, it decoded 240 000 symbols through #291's Opus chains without one error.

Decoding is at 16 kHz, where a symbol is 80 samples and the tones fall on DFT bins 2-17. Each
tone's energy over every 80-sample window comes from a running sum of x * exp(-j w n), so a
block at any position reads its 12 symbols by lookup. Every block's position is refined by a fine
search within +/-FINE samples of the stride prediction, so a loss that does not break decoding
still shows as a step. After an undecodable or no-signal block the next CRC pass is searched over
one block length.

A decoded number counts only once anchored: K = 3 consecutive decodes with consecutive numbers at
spacing L (+/- tau) form an anchor and are counted retroactively. After it, a decode counts if its
number is within +/-1 of what its position predicts from the anchor, which stays where it formed
(so a duplicate is counted twice, a swap out of order, a lost block missing). A decode that does
not agree is pending; K pending decodes that agree with each other re-anchor (the step is
reported). Pending decodes that never anchor are unexpected (after an anchor existed) or
unanchored (before one).
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import markers  # noqa: E402  (audio i/o and the git helpers only)

THRESHOLD = os.path.join(HERE, "blocks-threshold.json")
PLAY_RATE = 48000
RATE = 16000
SYM = 80                       # samples per symbol at RATE (5 ms)
SYMS = 12
L = SYM * SYMS                 # 960 samples at RATE = 60 ms
M = 16
TONES = 400.0 + 200.0 * np.arange(M)
LEVEL = 0.177                  # sine amplitude: about -18 dBFS RMS
K = 3
FINE = 32                      # +/- samples at RATE (2 ms), under half a symbol
SEQ_BITS = 23
CRC_INIT, CRC_POLY, CRC_XOR = 0xB704CE, 0x864CFB, 0xFFFFFF
TAU_MIN = 1                    # samples at RATE; a step is never finer than one detection sample


def die(msg, code=1):
    print(f"blocks: {msg}", file=sys.stderr)
    sys.exit(code)


# --- payload -----------------------------------------------------------------------------------

def crc24(value24):
    c = CRC_INIT
    for byte in value24.to_bytes(3, "big"):
        c ^= byte << 16
        for _ in range(8):
            c <<= 1
            if c & 0x1000000:
                c ^= CRC_POLY
    return (c & 0xFFFFFF) ^ CRC_XOR


def word(direction, seq):
    head = (direction << SEQ_BITS) | (seq & ((1 << SEQ_BITS) - 1))
    return (head << 24) | crc24(head)


def decode_block(E, pos):
    """(direction, seq, corrected) for the block at pos, or None. When the check fails, the CRC is
    used as the code: each of the 2 least confident symbols is tried at all 15 other values, then
    both together at every pair of other values; 255 trials at most, so the false-accept cost is
    255 x 2^-24 per failing block (1.5e-5), and anchoring guards it. F0 left one block in
    20 000 undecodable through the 16 kHz chain: Opus had replaced one symbol's tone outright (the
    true tone kept 6.6 % of the winner's energy), so a second-choice trial could not restore it."""
    idx = pos + SYM * np.arange(SYMS)
    if pos < 0 or idx[-1] >= E.shape[0]:
        return None
    e = E[idx]
    order = np.argsort(e, axis=1)
    first, second = order[:, -1], order[:, -2]
    r = parse(first)
    if r:
        return r[0], r[1], 0
    conf = e[np.arange(SYMS), first] / np.maximum(e[np.arange(SYMS), second], 1e-12)
    weak = list(np.argsort(conf))
    for i in weak[:2]:
        for v in range(M):
            if v == first[i]:
                continue
            syms = first.copy()
            syms[i] = v
            r = parse(syms)
            if r:
                return r[0], r[1], 1
    # Both of the 2 weakest at every value: Opus also breaks two adjacent symbols together
    # (C1 at 433e3f2: symbols 5 and 6 both became 1400 Hz, the true tones ranked third and fifth).
    i, j = weak[0], weak[1]
    for v in range(M):
        for w in range(M):
            if v == first[i] or w == first[j]:
                continue
            syms = first.copy()
            syms[i], syms[j] = v, w
            r = parse(syms)
            if r:
                return r[0], r[1], 2
    return None


def symbols_of(w):
    return [(w >> (44 - 4 * i)) & 0xF for i in range(SYMS)]


def parse(syms):
    """(direction, seq) when the CRC holds, else None."""
    w = 0
    for s in syms:
        w = (w << 4) | int(s)
    head, check = w >> 24, w & 0xFFFFFF
    if crc24(head) != check:
        return None
    return head >> SEQ_BITS, head & ((1 << SEQ_BITS) - 1)


def synth(syms, rate=PLAY_RATE, phase=0.0):
    """Phase-continuous FSK for a run of symbols; returns (samples, end phase)."""
    n = rate * SYM // RATE
    t = np.arange(n) / rate
    out = np.empty(len(syms) * n)
    for k, s in enumerate(syms):
        w = 2 * np.pi * TONES[s]
        out[k * n:(k + 1) * n] = np.sin(phase + w * t)
        phase = (phase + w * n / rate) % (2 * np.pi)
    return LEVEL * out, phase


def stream(direction, first, count, rate=PLAY_RATE):
    syms = []
    for i in range(count):
        syms += symbols_of(word(direction, first + i))
    return synth(syms, rate)[0]


# --- freeze (as markers.py) --------------------------------------------------------------------

def freeze_hash():
    h = hashlib.sha256()
    for p in (os.path.abspath(__file__), THRESHOLD):
        with open(p, "rb") as f:
            h.update(f.read())
    return h.hexdigest()


def git(*args):
    return subprocess.run(["git", "-C", HERE, *args], capture_output=True, text=True)


def require_committed_and_clean():
    for p in (os.path.abspath(__file__), THRESHOLD):
        if git("ls-files", "--error-unmatch", p).returncode != 0:
            die(f"{p} is not committed; the threshold is not frozen")
        if git("status", "--porcelain", "--", p).stdout.strip():
            die(f"{p} has uncommitted changes; the threshold is not frozen")


def frozen():
    if not os.path.exists(THRESHOLD):
        die(f"no {THRESHOLD}: run `tune` first")
    with open(THRESHOLD) as f:
        return json.load(f)


# --- energies ----------------------------------------------------------------------------------

CHUNK = 1 << 20                # samples at RATE per energy chunk (about 65 s)
PAD = 3 * L + 2 * FINE + SYM   # every lookup from a position in a chunk stays inside its pad


def tone_energy(x, a=0, b=None):
    """E[t, m] for t in [a, b): energy of tone m over x[t:t+SYM] (float32). Computed from a running
    sum of x * exp(-j w n) local to the span, so the cancellation error stays small."""
    b = x.size - SYM + 1 if b is None else min(b, x.size - SYM + 1)
    n = max(b - a, 0)
    E = np.empty((n, M), dtype=np.float32)
    if n == 0:
        return E
    seg = x[a:b + SYM - 1]
    k = np.arange(seg.size)
    for m, f in enumerate(TONES):
        c = np.concatenate([[0], np.cumsum(seg * np.exp(-2j * np.pi * f * k / RATE))])
        E[:, m] = np.abs(c[SYM:SYM + n] - c[:n]) ** 2
    return E


class Energy:
    """Tone energies over a whole recording, computed a chunk at a time and cached (an hour at
    16 kHz would be 3.7 GB at once)."""

    def __init__(self, x):
        self.x = x
        self.n = max(x.size - SYM + 1, 0)
        self.shape = (self.n, M)
        self.cache = {}

    def chunk(self, c):
        if c not in self.cache:
            if len(self.cache) >= 2:
                self.cache.pop(min(self.cache))
            self.cache[c] = tone_energy(self.x, c * CHUNK, c * CHUNK + CHUNK + PAD)
        return self.cache[c]

    def __getitem__(self, idx):
        idx = np.asarray(idx)
        c = int(idx.min()) // CHUNK
        return self.chunk(c)[idx - c * CHUNK]


def silent(E, pos, floor):
    """A block more than half of whose symbols are below the floor: a partial block at the edge of
    silence, not a damaged one (a block with 10 ms zeroed has 2 of 12 silent, B4)."""
    idx = pos + SYM * np.arange(SYMS)
    if pos < 0 or idx[-1] >= E.shape[0]:
        return True
    return int((E[idx].max(1) < floor).sum()) > SYMS // 2


def read_block(E, pos):
    """(symbols, quality, energy) of the block starting at pos; None past the end."""
    idx = pos + SYM * np.arange(SYMS)
    if idx[-1] >= E.shape[0] or pos < 0:
        return None
    e = E[idx]
    order = np.sort(e, axis=1)
    top, second = order[:, -1], order[:, -2]
    quality = float(np.min(top / np.maximum(second, 1e-12)))
    return e.argmax(1), quality, float(top.mean())


def block_score(E, pos):
    idx = pos + SYM * np.arange(SYMS)
    return float(E[idx].max(1).sum())


# --- decoding ----------------------------------------------------------------------------------

def scan(E, th, start, end):
    """Every block position from start: (pos, kind, direction, seq), kind in decoded/undecodable/
    no_signal. Positions are refined per block; after a failure the next CRC pass is searched."""
    out = []
    pos = start
    floor = th["floor"]
    searching = True
    last_start = E.shape[0] - SYM * (SYMS - 1)   # a block needs its last symbol's window
    # pos - FINE: a block ending at the recording's last sample may be predicted a sample or two past
    # it; the fine search looks back.
    while pos - FINE < last_start and pos + L <= end + SYM + FINE:
        if searching:
            found = None
            # Centred on the prediction: after a cut inside the damaged block the next block starts
            # earlier than predicted, and a window starting at the prediction skipped it (#302 B1b).
            lo_s = max(pos - L // 2, 0) if out and out[-1][1] != "decoded" else pos
            last = min(lo_s + L, last_start)
            cand = np.arange(lo_s, last)
            if cand.size:
                idx = cand[:, None] + SYM * np.arange(SYMS)[None, :]
                e = E[idx]                                  # cand x SYMS x M
                srt = np.sort(e, axis=2)
                q = np.min(srt[:, :, -1] / np.maximum(srt[:, :, -2], 1e-12), axis=1)
                en = srt[:, :, -1].mean(axis=1)
                # Quality only ranks the candidates: a tone in speech or music can be as clean as
                # a symbol (a 1 kHz tone is one of the 16), so false numbers are kept out by the
                # CRC and the anchor rule, not by a quality gate.
                ok = np.flatnonzero(en >= floor)
                for i in ok[np.argsort(-q[ok])][:64]:
                    r = decode_block(E, int(cand[i]))
                    if r:
                        found = (int(cand[i]), r)
                        break
            if found is None:
                kind = "no_signal" if silent(E, pos, floor) else "undecodable"
                out.append((pos, kind, None, None))
                pos += L
                continue
            p, (d, n, corr) = found
            if p > pos:
                # The search window holds a gap before the found block: one position, unread.
                kind = "no_signal" if silent(E, pos, floor) else "undecodable"
                if p - pos >= L // 2:
                    out.append((pos, kind, None, None))
            out.append((p, "decoded", d, n, corr))
            pos = p + L
            searching = False
            continue
        # Tracking. The block is decoded where the stride predicts it, which is exact while
        # nothing is lost; if its check fails, at the measured position, then at the positions
        # nearest to it. Its position for steps is always the measured one (the energy peak within
        # +/- FINE), so a shift that still decodes is seen. Decoding at the measured position
        # alone failed about 3e-4 of blocks through the 16 kHz chain (#302 F0, first run).
        lo, hi = max(pos - FINE, 0), min(pos + FINE, last_start - 1)
        if hi < lo:
            break
        meas = max(range(lo, hi + 1), key=lambda p: block_score(E, p))
        rb = read_block(E, meas)
        if rb is None:
            break
        if silent(E, meas, floor):
            out.append((pos, "no_signal", None, None))
            searching = True
            pos += L
            continue
        found = None
        for p in [pos, meas] + sorted(range(lo, hi + 1), key=lambda q: abs(q - meas)):
            r = decode_block(E, p)
            if r:
                found = (p, r)
                break
        if found is None:
            out.append((meas, "undecodable", None, None))
            searching = True
            pos = meas + L
            continue
        p, r = found
        out.append((meas, "decoded", r[0], r[1], r[2]))
        pos = p + L
    return out


def anchor_and_count(rows, tau):
    """Classify decoded rows: counted, unexpected, unanchored; and steps.

    Anchors are found first: every maximal run of at least K consecutive decodes with consecutive
    numbers at spacing L (+/- tau). Each anchor fixes an offset, number minus block position. Every
    decode is then judged against the nearest anchor before it and the nearest after it: inside an
    anchor, or within +/-1 of what either neighbour's offset predicts, it is counted; otherwise it
    is unexpected, or unanchored when the recording has no anchor at all. A duplicate or a swap next
    to a loss is therefore counted (and reported as duplicated or out of order), where the first
    rule, one anchor carried forward, turned it unexpected (the gate on #302, round 1)."""
    dec = [r for r in rows if r[1] == "decoded"]
    # Runs of consecutive numbers at spacing L.
    runs, start = [], 0
    for i in range(1, len(dec) + 1):
        if i == len(dec) or not (dec[i][3] == dec[i - 1][3] + 1 and abs((dec[i][0] - dec[i - 1][0]) - L) <= tau):
            if i - start >= K:
                runs.append((start, i))
            start = i
    in_anchor = set(i for a, b in runs for i in range(a, b))
    offsets = [(dec[a][0], dec[b - 1][0], dec[a][3] - round(dec[a][0] / L)) for a, b in runs]
    counted, unexpected, unanchored = [], [], []
    k = 0
    for i, r in enumerate(dec):
        if i in in_anchor:
            counted.append(r)
            continue
        if not offsets:
            unanchored.append(r)
            continue
        while k + 1 < len(offsets) and offsets[k + 1][0] <= r[0]:
            k += 1
        near = [offsets[k]] + ([offsets[k + 1]] if k + 1 < len(offsets) else [])
        if k > 0:
            near.append(offsets[k - 1])
        if any(abs(r[3] - (round(r[0] / L) + off)) <= 1 for _, _, off in near):
            counted.append(r)
        else:
            unexpected.append(r)
    steps = []
    # A cut inside a block that still decodes moves that block's measured position halfway: two
    # adjacent changes (+96 then -222 for a 128-sample cut). Changes on blocks within two numbers
    # of each other are one step, and its size is the median offset of the 3 counted blocks after
    # it minus that of the 3 before it, so the damaged block's own position does not enter.
    offs = [r[0] - L * r[3] for r in counted]
    raw = [i for i in range(1, len(counted)) if abs(offs[i] - offs[i - 1]) > tau]
    groups = []
    for i in raw:
        if groups and counted[i - 1][3] - counted[groups[-1][1]][3] <= 2:
            groups[-1][1] = i
        else:
            groups.append([i, i])
    for first_i, last_i in groups:
        before = offs[max(first_i - 3, 0):first_i]
        after = offs[last_i:last_i + 3]
        if not before or not after:
            continue
        delta = float(np.median(after) - np.median(before))
        if abs(delta) > tau:
            steps.append({"after": counted[first_i - 1][3], "at": counted[last_i][3],
                          "samples_48k": int(round(delta * PLAY_RATE / RATE)),
                          "pos_s": round(counted[last_i][0] / RATE, 4)})
    return counted, unexpected, unanchored, steps


def cmd_decode(a):
    sched = json.load(open(a.schedule))
    th = frozen()
    if sched["header"].get("judge"):
        if sched["header"]["hash"] != freeze_hash():
            die("this judge schedule was generated under another threshold or decoder; regenerate it")
        require_committed_and_clean()
    x = markers.read_audio(a.recording, RATE, a.channel)
    E = Energy(x)
    rows = scan(E, th, 0, x.size)
    tau = th["tau"]
    counted, unexpected, unanchored, steps = anchor_and_count(rows, tau)
    direction = a.direction if a.direction is not None else sched["direction"]
    first, N = sched["first"], sched["N"]
    nums = [r[3] - first for r in counted]
    seen, dup, ooo = set(), [], []
    hi = -1
    for v in nums:
        if v in seen:
            dup.append(v)
        if v < hi:
            ooo.append(v)
        hi = max(hi, v)
        seen.add(v)
    lo_c = min(seen) if seen else None
    hi_c = max(seen) if seen else None
    # From 0, not from the first counted block: losing the head of the stream was invisible to
    # every category (the gate on #302, round 1). head_loss names that part apart, since A3 may
    # start its window at the first block the client detects.
    missing = [v for v in range(0, hi_c + 1) if v not in seen] if seen else []
    head = lo_c if seen else 0
    tail = list(range(hi_c + 1, N)) if seen else list(range(N))
    out = {
        "track": a.track, "expected_direction": direction, "N": N, "first": first,
        "counted": len(counted), "window": [lo_c, hi_c],
        "missing": missing, "duplicated": dup, "out_of_order": ooo,
        "unexpected": [{"n": r[3] - first, "pos_s": round(r[0] / RATE, 4)} for r in unexpected],
        "unanchored": len(unanchored),
        "wrong_direction": sorted({r[3] - first for r in counted if r[2] != direction}),
        # Inside the window: positions before the first counted block or after the last are not
        # the stream's (L1 at e8a6880 counted 520 in a marker preamble, and 0 inside the window).
        "undecodable": [round(r[0] / RATE, 4) for r in rows if r[1] == "undecodable"
                        and counted and counted[0][0] < r[0] < counted[-1][0]],
        "undecodable_outside": sum(1 for r in rows if r[1] == "undecodable"
                                   and not (counted and counted[0][0] < r[0] < counted[-1][0])),
        # Inside the window only: the silence before the first block and after the last is the
        # recording's edge, not a loss (tail loss is reported apart).
        "no_signal": [round(r[0] / RATE, 4) for r in rows if r[1] == "no_signal"
                      and counted and counted[0][0] < r[0] < counted[-1][0]],
        "corrected": sum(1 for r in counted if len(r) > 4 and r[4]),
        "steps": steps, "tail_loss": len(tail), "head_loss": head,
        # Net offset over the window: what step merging and sub-tau cuts can leave unnamed
        # (a loss and a gain within 3 blocks, or many cuts under tau) still shows here.
        "net_offset_48k": int(round(((counted[-1][0] - L * counted[-1][3]) - (counted[0][0] - L * counted[0][3]))
                                    * PLAY_RATE / RATE)) if counted else None,
        "positions": [[r[3] - first, r[0]] for r in counted],
        "tau": tau, "header": sched["header"],
    }
    json.dump(out, sys.stdout)
    print()


CATEGORIES = ("missing", "duplicated", "out_of_order", "unexpected", "unanchored", "wrong_direction",
              "undecodable", "no_signal", "steps", "tail_loss", "head_loss")


def size(v):
    return v if isinstance(v, int) else len(v)


def cmd_judge(a):
    d = json.load(open(a.decode))
    report = {"track": d["track"], "direction": d["expected_direction"], "N": d["N"], "counted": d["counted"],
              **{c: size(d[c]) for c in CATEGORIES}}
    failed = [f"{d['track']}: {c} {size(d[c])}" + (f" e.g. {d[c][:5]}" if isinstance(d[c], list) and d[c] else "")
              for c in (a.zero or []) if size(d[c])]
    report["failed"] = failed
    print(json.dumps(report))
    sys.exit(1 if failed else 0)


# --- generation and tuning ---------------------------------------------------------------------

def cmd_gen(a):
    header = {"judge": False, "seed": a.seed}
    if a.judge:
        th = frozen()
        require_committed_and_clean()
        if a.seed == th["seed_tuning"]:
            die(f"seed {a.seed} is the tuning seed; judging recordings need another")
        header = {"judge": True, "seed": a.seed, "commit": git("rev-parse", "HEAD").stdout.strip(), "hash": freeze_hash()}
    rng = np.random.default_rng(a.seed)
    N = int(round(a.minutes * 60 * 1000 / 60))
    first = int(rng.integers(0, (1 << SEQ_BITS) - N))
    pad = np.zeros(PLAY_RATE)       # 1 s before and after: a codec's start-up is not a block
    x = np.concatenate([pad, stream(a.direction, first, N), pad])
    os.makedirs(a.out, exist_ok=True)
    markers.write_wav(os.path.join(a.out, "blocks.wav"), x)
    sched = {"N": N, "first": first, "direction": a.direction, "L_ms": 60, "rate": PLAY_RATE, "header": header}
    with open(os.path.join(a.out, "schedule.json"), "w") as f:
        json.dump(sched, f)
    print(json.dumps({"N": N, "first": first, "seconds": N * 0.06, "header": header}))


def cmd_tune(a):
    sched = json.load(open(a.schedule))
    x = markers.read_audio(a.recording, RATE)
    free = markers.read_audio(a.free, RATE)
    E, Ef = Energy(x), Energy(free)
    # Block energy and quality at the true positions (found by a permissive scan).
    loose = {"floor": 0.0}
    rows = [r for r in scan(E, loose, 0, x.size) if r[1] == "decoded"]
    if not rows:
        die("nothing decoded in the tuning recording")
    q_true, en_true = [], []
    for r in rows:
        syms, q, en = read_block(E, r[0])
        q_true.append(q)
        en_true.append(en)
    # Non-signal: every block-length window of the free material.
    q_free, en_free = [], []
    for p in range(0, Ef.shape[0] - L, L // 4):
        rb = read_block(Ef, p)
        if rb:
            q_free.append(rb[1])
            en_free.append(rb[2])
    floor = float(min(en_true) * 1e-3)    # 30 dB under the weakest true block
    deltas = []
    # tau over every tuning chain given: the recording itself and each --also (#302 v4).
    for path in [a.recording] + (a.also or []):
        Ex = E if path == a.recording else Energy(markers.read_audio(path, RATE))
        rws = [r for r in scan(Ex, loose, 0, Ex.n + SYM - 1) if r[1] == "decoded"]
        counted, *_ = anchor_and_count(rws, L)
        deltas += [abs((b[0] - L * b[3]) - (a_[0] - L * a_[3])) for a_, b in zip(counted, counted[1:])]
    tau = max(TAU_MIN, 2 * (max(deltas) if deltas else 0))
    rec = {"floor": floor, "tau": tau, "seed_tuning": a.seed, "blocks": len(rows), "tau_blocks": len(deltas) + 1,
           "min_true_quality": min(q_true), "free_quality_p999": float(np.percentile(q_free, 99.9)),
           "max_consecutive_delta": max(deltas) if deltas else 0,
           "rule": "floor: weakest true block -30 dB; tau: 2 x max consecutive delta (samples at 16 kHz), at least 1; no quality gate"}
    with open(THRESHOLD, "w") as f:
        json.dump(rec, f, indent=2)
        f.write("\n")
    print(json.dumps(rec))


def cmd_level(a):
    d = json.load(open(a.decode))
    if not d["positions"]:
        print(json.dumps({"void": True, "reasons": ["no blocks counted: level not measured (cannot place the blocks)"]}))
        sys.exit(2)
    x = markers.read_audio(a.recording, RATE)
    import level
    xb = level.band(x, RATE)
    first_pos = d["positions"][0][1]
    f0, f1 = first_pos - 12 * RATE, first_pos - 2 * RATE
    if f0 < 0:
        print(json.dumps({"void": True, "reasons": [f"less than 12 s before the first block ({first_pos / RATE:.1f} s)"]}))
        sys.exit(2)
    floor = level.dbfs(xb[f0:f1])
    blocks = np.concatenate([xb[p:p + L] for _, p in d["positions"]])
    lvl = level.dbfs(blocks)
    reasons = []
    if not level.FLOOR_RANGE[0] <= floor <= level.FLOOR_RANGE[1]:
        reasons.append(f"floor {floor:.1f} dBFS outside {level.FLOOR_RANGE}")
    if lvl < floor + level.MARGIN_DB:
        reasons.append(f"blocks not delivered acoustically: {lvl:.1f} dBFS, floor {floor:.1f} + {level.MARGIN_DB:.0f}")
    print(json.dumps({"void": bool(reasons), "floor_dbfs": round(floor, 1), "block_dbfs": round(lvl, 1),
                      "snr_db": round(lvl - floor, 1), "reasons": reasons}))
    sys.exit(2 if reasons else 0)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen")
    g.add_argument("out")
    g.add_argument("--minutes", type=float, required=True)
    g.add_argument("--seed", type=int, required=True)
    g.add_argument("--direction", type=int, default=0, choices=(0, 1))
    g.add_argument("--judge", action="store_true")
    t = sub.add_parser("tune")
    t.add_argument("recording")
    t.add_argument("schedule")
    t.add_argument("free")
    t.add_argument("--seed", type=int, required=True)
    t.add_argument("--also", action="append", help="another tuning chain of the same stream, for tau")
    d = sub.add_parser("decode")
    d.add_argument("recording")
    d.add_argument("schedule")
    d.add_argument("--track", default="unlabelled")
    d.add_argument("--direction", type=int, choices=(0, 1))
    d.add_argument("--channel", type=int, default=1)
    j = sub.add_parser("judge")
    j.add_argument("decode")
    j.add_argument("--zero", nargs="*", choices=CATEGORIES)
    lv = sub.add_parser("level")
    lv.add_argument("recording")
    lv.add_argument("decode")
    a = p.parse_args()
    {"gen": cmd_gen, "tune": cmd_tune, "decode": cmd_decode, "judge": cmd_judge, "level": cmd_level}[a.cmd](a)


if __name__ == "__main__":
    main()
