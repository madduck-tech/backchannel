#!/usr/bin/env python3
"""Timed PCM markers and their codec-tolerant detector, for the virtual audio experiment (#291).

    markers.py gen <out-dir> --minutes M --seed S [--spacing SEC] [--jitter-ms J] [--pairs]
                   [--noise-segment] [--ids 0,1,...] [--judge]
        writes markers.wav (48 kHz mono s16), schedule.json (nominal onsets: what the detector
        is given) and truth.json (the onsets actually written: what only `judge` reads)
    markers.py free <out-dir> --minutes M
        a marker-free recording: `say` speech in two voices, pink noise, silence, a 1 kHz tone
    markers.py chain <in.wav> <out.wav> --resample HZ [--bitrate 32k]
        the offline stand-in for the live path: a resample through HZ, then libopus `voip`
    markers.py tune <markers.wav> <schedule.json> <free.wav> --seed S_t
        places the threshold and writes threshold.json (T1a, T1b)
    markers.py detect <recording> <schedule.json> [--channel N] > detection.json
    markers.py judge <detection.json> <truth.json> [--p95-ms 5] [--zero-misses] [--zero-false]
        exits 1 when any stated condition fails, 2 when the detection is void

Every marker is band-limited pseudo-noise, 300-3400 Hz, so it survives Opus and both Bluetooth
HFP codecs (CVSD at 8 kHz, mSBC at 16 kHz). Its spectrum is fixed on a 1/duration grid with
seeded phases, so the same waveform is sampled exactly at 48 kHz for playback and at 8 kHz for
detection. Round 1 of #291's critic measured noise ids separating 3.3-3.8x where chirps gave 1.2x.

Detection is at 8 kHz: the band fits under its Nyquist and an hour is 28.8 M samples. The score
is the normalised correlation of the recording with each template (by the template's energy and
the recording's local energy), computed in chunks. The sync marker aligns the nominal schedule;
each scheduled marker owns a slot of +/-100 ms around its aligned onset, and a detection of an id
outside every slot of that id is a false match.

The threshold is frozen (T1c): `gen --judge` refuses unless threshold.json and this file are
committed and clean, refuses the tuning seed, and stamps the commit and a hash of both files into
the schedule; `detect` refuses a judge schedule whose hash no longer matches. A new seed after a
retune is honesty-based.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
THRESHOLD = os.path.join(HERE, "threshold.json")
PLAY_RATE = 48000
DETECT_RATE = 8000
BAND = (300.0, 3400.0)
MARKER_S = 0.200
SYNC_S = 0.500
IDS = 8
SLOT_S = 0.100
FADE_S = 0.010
PAIR_OFFSET_S = 0.250
SYNC_AT_S = 2.0
LEVEL_RMS = 0.125  # about -18 dBFS RMS, peaks near -6 dBFS


def die(msg, code=1):
    print(f"markers: {msg}", file=sys.stderr)
    sys.exit(code)


# --- waveforms ---------------------------------------------------------------------------------

def waveform(name, rate):
    """The marker `name` ("sync" or "0".."7") sampled at `rate`; identical signal at any rate."""
    dur = SYNC_S if name == "sync" else MARKER_S
    seed = 9000 if name == "sync" else 1000 + int(name)
    n = int(round(dur * rate))
    t = np.arange(n) / rate
    rng = np.random.default_rng(seed)
    freqs = np.arange(int(BAND[0] * dur) + 1, int(BAND[1] * dur)) / dur
    phases = rng.uniform(0, 2 * np.pi, freqs.size)
    x = np.zeros(n)
    for f, p in zip(freqs, phases):
        x += np.cos(2 * np.pi * f * t + p)
    fade = int(round(FADE_S * rate))
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(fade) / fade)
    x[:fade] *= ramp
    x[-fade:] *= ramp[::-1]
    return x * (LEVEL_RMS / np.sqrt(np.mean(x ** 2)))


# --- audio i/o ---------------------------------------------------------------------------------

def write_wav(path, x, rate=PLAY_RATE):
    pcm = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def read_audio(path, rate, channel=1):
    """Any file ffmpeg reads, as float32 mono at `rate`, taking one channel (1-based)."""
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path,
           "-af", f"pan=mono|c0=c{channel - 1}", "-ar", str(rate), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        die(f"ffmpeg could not read {path}: {out.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(out.stdout, dtype="<f4").astype(np.float64)


# --- scoring -----------------------------------------------------------------------------------

# A window quieter than this RMS is silence and scores 0. Its correlation is rounding error divided
# by a near-zero energy: measured on #291, a window of digital silence after 30 s of noise had a
# numerator of 1.2e-10 (FFT rounding) and a true energy of 5.7e-13, its running-sum energy came out
# exactly 0, and it scored 1.24 for a template it had never seen. No marker this detector judges is
# this quiet; L2's floor starts at -85 dBFS.
SILENCE_RMS = 1e-5  # -100 dBFS


def ncc(x, h, chunk=1 << 20):
    """Normalised correlation of `x` with template `h` at every lag (score[i] for x[i:i+len(h)])."""
    L = h.size
    n = x.size - L + 1
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    h = h / np.linalg.norm(h)
    out = np.empty(n, dtype=np.float32)  # nine of these over an hour at 8 kHz: 1 GB, not 2
    floor = L * SILENCE_RMS ** 2
    size = 1
    while size < chunk + L:
        size <<= 1
    H = np.conj(np.fft.rfft(h, size))
    step = size - L + 1
    for start in range(0, n, step):
        seg = x[start:start + size]
        c = np.fft.irfft(np.fft.rfft(seg, size) * H, size)
        m = min(step, n - start)
        cs = np.concatenate([[0.0], np.cumsum(seg[: m + L - 1] ** 2)])
        e = cs[L:L + m] - cs[:m]
        out[start:start + m] = np.where(e < floor, 0.0, c[:m] / np.sqrt(np.maximum(e, floor)))
    return out


def peaks(score, threshold, min_gap):
    """Local maxima above threshold, at least `min_gap` samples apart, strongest first."""
    idx = np.flatnonzero(score > threshold)
    found = []
    for i in idx[np.argsort(-score[idx])]:
        if all(abs(i - j) >= min_gap for j in found):
            found.append(int(i))
    return sorted(found)


def refine(score, i):
    """Sub-sample peak position by parabolic interpolation."""
    if 0 < i < score.size - 1:
        a, b, c = (float(v) for v in score[i - 1:i + 2])
        d = a - 2 * b + c
        if d < 0:
            return i + 0.5 * (a - c) / d
    return float(i)


# --- threshold freeze (T1c) --------------------------------------------------------------------

def freeze_hash():
    h = hashlib.sha256()
    for p in (os.path.abspath(__file__), THRESHOLD):
        with open(p, "rb") as f:
            h.update(f.read())
    return h.hexdigest()


def git(*args):
    return subprocess.run(["git", "-C", HERE, *args], capture_output=True, text=True)


def frozen_threshold():
    if not os.path.exists(THRESHOLD):
        die(f"no {THRESHOLD}: run `tune` first")
    with open(THRESHOLD) as f:
        return json.load(f)


def require_committed_and_clean():
    for p in (os.path.abspath(__file__), THRESHOLD):
        if git("ls-files", "--error-unmatch", p).returncode != 0:
            die(f"{p} is not committed; the threshold is not frozen")
        if git("status", "--porcelain", "--", p).stdout.strip():
            die(f"{p} has uncommitted changes; the threshold is not frozen")


# --- commands ----------------------------------------------------------------------------------

def cmd_gen(a):
    header = {"judge": False, "seed": a.seed}
    if a.judge:
        th = frozen_threshold()
        require_committed_and_clean()
        if a.seed == th["seed_tuning"]:
            die(f"seed {a.seed} is the tuning seed; judging recordings need another")
        header = {"judge": True, "seed": a.seed, "commit": git("rev-parse", "HEAD").stdout.strip(),
                  "hash": freeze_hash()}
    rng = np.random.default_rng(a.seed)
    total = int(round(a.minutes * 60 * PLAY_RATE))
    x = np.zeros(total)
    sync = waveform("sync", PLAY_RATE)
    s0 = int(SYNC_AT_S * PLAY_RATE)
    x[s0:s0 + sync.size] += sync
    templates = {str(i): waveform(str(i), PLAY_RATE) for i in range(IDS)}
    nominal, truth, pairs = [], [], []
    noise_at = None
    if a.noise_segment:
        noise_at = SYNC_AT_S + SYNC_S + 2.0
        n0, n1 = int(noise_at * PLAY_RATE), int((noise_at + 30.0) * PLAY_RATE)
        x[n0:n1] += pink_noise(n1 - n0, rng)
    t = (noise_at + 32.0) if noise_at is not None else SYNC_AT_S + SYNC_S + 2.0
    ids_used = [str(i) for i in a.ids] if a.ids else [str(i) for i in range(IDS)]
    k = 0
    end = a.minutes * 60 - 1.0
    while t + (PAIR_OFFSET_S + MARKER_S if a.pairs else MARKER_S) < end:
        ids = [ids_used[k % len(ids_used)]]
        if a.pairs:
            ids.append(ids_used[(k + 3) % len(ids_used)])
        group = []
        for j, mid in enumerate(ids):
            nom = t + j * PAIR_OFFSET_S
            jit = rng.uniform(0, a.jitter_ms / 1000.0) if a.jitter_ms else 0.0
            true = nom + jit
            i0 = int(round(true * PLAY_RATE))
            w = templates[mid]
            x[i0:i0 + w.size] += w
            nominal.append({"n": len(nominal), "id": mid, "onset": nom})
            truth.append({"n": len(truth), "id": mid, "onset": true})
            group.append(len(nominal) - 1)
        if a.pairs:
            pairs.append({"first": group[0], "second": group[1], "offset": PAIR_OFFSET_S})
        k += 1
        t += a.spacing
    os.makedirs(a.out, exist_ok=True)
    write_wav(os.path.join(a.out, "markers.wav"), x)
    common = {"rate": PLAY_RATE, "sync": SYNC_AT_S, "slot": SLOT_S, "pairs": pairs,
              "noise_segment": noise_at, "header": header}
    with open(os.path.join(a.out, "schedule.json"), "w") as f:
        json.dump({**common, "markers": nominal}, f)
    with open(os.path.join(a.out, "truth.json"), "w") as f:
        json.dump({**common, "markers": truth}, f)
    print(json.dumps({"markers": len(nominal), "pairs": len(pairs), "seconds": a.minutes * 60,
                      "header": header}))


def pink_noise(n, rng):
    """Pink noise by 1/sqrt(f) shaping, RMS at the marker level."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(spec.size)
    spec[1:] /= np.sqrt(f[1:])
    spec[0] = 0
    y = np.fft.irfft(spec, n)
    return y * (LEVEL_RMS / np.sqrt(np.mean(y ** 2)))


# The marker-free material T1 was tuned on: seed 7, Samantha and Daniel, the first text. A judging
# recording (K3) must be other material, so `free --judge` refuses this seed.
TUNING_FREE_SEED = 7
VOICES = ("Samantha", "Daniel", "Karen", "Moira", "Fred", "Kathy", "Reed", "Shelley")
TEXTS = (
    "The quarterly numbers were discussed at length, and the team agreed to revisit the "
    "budget next week after the vendor sends the revised estimate for the migration.",
    "Before we move on, can someone confirm whether the release notes went out yesterday, "
    "because two customers asked about the change to the export format this morning.",
    "I think the simplest option is to keep the old endpoint running for a month, measure "
    "who still calls it, and then decide whether a migration guide is worth writing.",
    "Let me share my screen for a second. This chart shows the error rate by region, and the "
    "spike on Tuesday lines up with the configuration push to the eastern cluster.",
)


def cmd_free(a):
    """Marker-free material, cycled to length: speech in two voices, pink noise, silence, tone."""
    header = {"judge": False, "seed": a.seed}
    if a.judge:
        frozen_threshold()
        require_committed_and_clean()
        if a.seed == TUNING_FREE_SEED:
            die(f"seed {a.seed} is the marker-free material T1 was tuned on; judging needs another")
        header = {"judge": True, "seed": a.seed, "commit": git("rev-parse", "HEAD").stdout.strip(),
                  "hash": freeze_hash()}
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(a.seed)
    if a.seed == TUNING_FREE_SEED:
        voices, text = ("Samantha", "Daniel"), TEXTS[0]
    else:
        voices = tuple(rng.choice(VOICES[2:], 2, replace=False))
        text = TEXTS[1 + int(rng.integers(len(TEXTS) - 1))]
    parts = []
    with tempfile.TemporaryDirectory() as tmp:
        for voice in voices:
            aiff = os.path.join(tmp, f"{voice}.aiff")
            r = subprocess.run(["say", "-v", voice, "-o", aiff, text], capture_output=True)
            if r.returncode != 0:
                die(f"say -v {voice} failed: {r.stderr.decode(errors='replace').strip()}")
            s = read_audio(aiff, PLAY_RATE)
            parts.append(s * (LEVEL_RMS / max(np.sqrt(np.mean(s ** 2)), 1e-9)))
    ten = 10 * PLAY_RATE
    parts.append(pink_noise(ten, rng))
    parts.append(np.zeros(ten))
    tt = np.arange(ten) / PLAY_RATE
    parts.append(np.sqrt(2) * LEVEL_RMS * np.sin(2 * np.pi * 1000 * tt))
    cycle = np.concatenate(parts)
    total = int(round(a.minutes * 60 * PLAY_RATE))
    x = np.tile(cycle, total // cycle.size + 1)[:total]
    write_wav(os.path.join(a.out, "free.wav"), x)
    sched = {"rate": PLAY_RATE, "sync": None, "slot": SLOT_S, "pairs": [], "noise_segment": None,
             "markers": [], "header": header}
    with open(os.path.join(a.out, "schedule.json"), "w") as f:
        json.dump(sched, f)
    print(json.dumps({"seconds": a.minutes * 60, "cycle_s": cycle.size / PLAY_RATE,
                      "voices": list(voices), "header": header}))


def cmd_chain(a):
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", a.input,
           "-af", f"aresample={a.resample},aresample={PLAY_RATE}", "-ac", "1",
           "-c:a", "libopus", "-b:a", a.bitrate, "-application", "voip"]
    with tempfile.TemporaryDirectory() as tmp:
        opus = os.path.join(tmp, "x.opus")
        for c in (cmd + [opus], ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", opus,
                                 "-ar", str(PLAY_RATE), "-ac", "1", "-c:a", "pcm_s16le", a.output]):
            r = subprocess.run(c, capture_output=True)
            if r.returncode != 0:
                die(f"chain step failed: {r.stderr.decode(errors='replace').strip()}")


def all_scores(x):
    return {mid: ncc(x, waveform(mid, DETECT_RATE)) for mid in ["sync"] + [str(i) for i in range(IDS)]}


def locate_sync(scores, threshold, sched):
    """The detected sync onset in seconds, the count of sync detections, or None."""
    s = scores["sync"]
    found = peaks(s, threshold, int(SYNC_S * DETECT_RATE))
    if not found:
        return None, 0
    best = max(found, key=lambda i: s[i])
    return refine(s, best) / DETECT_RATE, len(found)


def match(scores, sched, threshold):
    """Hits, misses and false matches against the nominal schedule, aligned on the sync marker."""
    if sched["sync"] is None:
        # Marker-free material (K3): nothing to align, every detection is false, sync included.
        sync_count = len(peaks(scores["sync"], threshold, int(SYNC_S * DETECT_RATE)))
        sync_at, offset = None, 0.0
    else:
        sync_at, sync_count = locate_sync(scores, threshold, sched)
        if sync_at is None:
            return {"void": "no sync"}
        offset = sync_at - sched["sync"]
    slot = int(sched["slot"] * DETECT_RATE)
    gap = int(MARKER_S * DETECT_RATE)
    hits, misses, false = [], [], []
    by_id = {}
    for m in sched["markers"]:
        by_id.setdefault(m["id"], []).append(m)
    for mid, ms in by_id.items():
        s = scores[mid]
        det = peaks(s, threshold, gap)
        claimed = set()
        for m in ms:
            centre = int(round((m["onset"] + offset) * DETECT_RATE))
            inside = [i for i in det if abs(i - centre) <= slot and i not in claimed]
            if inside:
                i = max(inside, key=lambda j: s[j])
                claimed.add(i)
                hits.append({"n": m["n"], "id": mid, "onset": refine(s, i) / DETECT_RATE - offset,
                             "score": float(s[i])})
            else:
                misses.append({"n": m["n"], "id": mid, "onset": m["onset"]})
        for i in det:
            if i not in claimed:
                false.append({"id": mid, "at": i / DETECT_RATE - offset, "score": float(s[i])})
    for mid in [str(i) for i in range(IDS)]:
        if mid not in by_id:
            for i in peaks(scores[mid], threshold, gap):
                false.append({"id": mid, "at": i / DETECT_RATE - offset,
                              "score": float(scores[mid][i])})
    return {"void": None, "sync_at": sync_at, "sync_detections": sync_count, "offset": offset,
            "hits": sorted(hits, key=lambda h: h["n"]), "misses": misses,
            "false_matches": sorted(false, key=lambda f: f["at"])}


def cmd_detect(a):
    with open(a.schedule) as f:
        sched = json.load(f)
    th = frozen_threshold()
    if sched["header"].get("judge"):
        if sched["header"]["hash"] != freeze_hash():
            die("this judge schedule was generated under another threshold or detector; regenerate it")
        require_committed_and_clean()
    x = read_audio(a.recording, DETECT_RATE, a.channel)
    result = match(all_scores(x), sched, th["value"])
    result.update({"threshold": th["value"], "recording": a.recording,
                   "header": sched["header"]})
    json.dump(result, sys.stdout)
    print()


def cmd_tune(a):
    with open(a.schedule) as f:
        sched = json.load(f)
    x = read_audio(a.markers, DETECT_RATE)
    free = read_audio(a.free, DETECT_RATE)
    sm, sf = all_scores(x), all_scores(free)
    # Align on the sync by its maximum: the threshold does not exist yet.
    s = sm["sync"]
    offset = refine(s, int(np.argmax(s))) / DETECT_RATE - sched["sync"]
    slot = int(sched["slot"] * DETECT_RATE)
    true_scores, ratios = [], []
    mask = np.zeros(x.size, dtype=bool)
    for m in sched["markers"]:
        c = int(round((m["onset"] + offset) * DETECT_RATE))
        lo, hi = max(c - slot, 0), c + slot + 1
        own = float(sm[m["id"]][lo:hi].max())
        other = max(float(sm[o][lo:hi].max()) for o in sm if o not in ("sync", m["id"]))
        true_scores.append(own)
        ratios.append(own / max(other, 1e-9))
        mask[max(c - 2 * slot, 0):c + 2 * slot + int(MARKER_S * DETECT_RATE)] = True
    sync_c = int(round((sched["sync"] + offset) * DETECT_RATE))
    mask[max(sync_c - slot, 0):sync_c + int(SYNC_S * DETECT_RATE) + slot] = True
    non = []
    for mid in sm:
        non.append(float(sf[mid].max()))
        rest = sm[mid][~mask[:sm[mid].size]]
        if rest.size:
            non.append(float(rest.max()))
    min_true, max_non = min(true_scores), max(non)
    value = float(np.sqrt(min_true * max_non))
    record = {"value": value, "seed_tuning": a.seed, "min_true_score": min_true,
              "max_non_marker_score": max_non, "margin": min_true / max_non,
              "id_ratio_min": min(ratios), "markers": len(true_scores),
              "rule": "geometric mean of min true-marker score and max non-marker score"}
    with open(THRESHOLD, "w") as f:
        json.dump(record, f, indent=2)
        f.write("\n")
    print(json.dumps(record))


def cmd_judge(a):
    with open(a.detection) as f:
        det = json.load(f)
    with open(a.truth) as f:
        truth = json.load(f)
    if det.get("void"):
        print(json.dumps({"void": det["void"]}))
        sys.exit(2)
    true_by_n = {m["n"]: m for m in truth["markers"]}
    det_by_n = {h["n"]: h for h in det["hits"]}
    sync_true = truth["sync"]
    errors = []
    for h in det["hits"]:
        # Both sides relative to the sync: the detector's onset is already aligned on it.
        errors.append({"n": h["n"], "id": h["id"],
                       "error_ms": 1000 * ((h["onset"] - truth["sync"]) - (true_by_n[h["n"]]["onset"] - sync_true))})
    pair_errors = []
    for p in truth.get("pairs", []):
        a1, b1 = det_by_n.get(p["first"]), det_by_n.get(p["second"])
        if a1 and b1:
            measured = b1["onset"] - a1["onset"]
            true_off = true_by_n[p["second"]]["onset"] - true_by_n[p["first"]]["onset"]
            pair_errors.append(1000 * (measured - true_off))
    abs_e = np.abs([e["error_ms"] for e in errors]) if errors else np.array([np.inf])
    report = {
        "markers": len(truth["markers"]), "hits": len(det["hits"]), "misses": det["misses"],
        "false_matches": det["false_matches"], "sync_detections": det["sync_detections"],
        "timing_p95_ms": float(np.percentile(abs_e, 95)) if errors else None,
        "timing_max_ms": float(abs_e.max()) if errors else None,
        "timing_n": len(errors),
        "pairs_n": len(pair_errors),
        "pair_p95_ms": float(np.percentile(np.abs(pair_errors), 95)) if pair_errors else None,
        "late": [e for e in errors if abs(e["error_ms"]) > a.p95_ms],
    }
    failed = []
    if truth["markers"] and a.p95_ms is not None and (report["timing_p95_ms"] is None or report["timing_p95_ms"] > a.p95_ms):
        p95 = report["timing_p95_ms"]
        failed.append(f"timing p95 {'none (no hits)' if p95 is None else f'{p95:.3f} ms'} > {a.p95_ms} ms")
    if a.per_marker and report["late"]:
        failed.append(f"{len(report['late'])} markers with error beyond {a.p95_ms} ms: "
                      + ", ".join(f"n={e['n']} id={e['id']} {e['error_ms']:.1f} ms" for e in report["late"][:10]))
    if a.pairs and (report["pair_p95_ms"] is None or report["pair_p95_ms"] > a.p95_ms):
        failed.append(f"pair offset p95 {report['pair_p95_ms']} ms > {a.p95_ms} ms")
    if a.zero_misses and det["misses"]:
        failed.append("misses: " + ", ".join(f"n={m['n']} id={m['id']}" for m in det["misses"][:10]))
    if a.zero_false and det["false_matches"]:
        failed.append("false matches: " + ", ".join(f"id={f['id']} at {f['at']:.3f}s" for f in det["false_matches"][:10]))
    expected_sync = 0 if truth["sync"] is None else 1
    if a.zero_false and det["sync_detections"] > expected_sync:
        failed.append(f"false sync detections: {det['sync_detections'] - expected_sync}")
    report["failed"] = failed
    print(json.dumps(report))
    sys.exit(1 if failed else 0)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen")
    g.add_argument("out")
    g.add_argument("--minutes", type=float, required=True)
    g.add_argument("--seed", type=int, required=True)
    g.add_argument("--spacing", type=float, default=6.0)
    g.add_argument("--jitter-ms", type=float, default=0.0)
    g.add_argument("--pairs", action="store_true")
    g.add_argument("--noise-segment", action="store_true")
    g.add_argument("--judge", action="store_true")
    g.add_argument("--ids", type=lambda v: [int(x) for x in v.split(",")], default=None,
                   help="only these ids, e.g. 0,1,2,3,4,5,6 for call markers and 7 for a sentinel")
    f = sub.add_parser("free")
    f.add_argument("out")
    f.add_argument("--minutes", type=float, required=True)
    f.add_argument("--seed", type=int, default=TUNING_FREE_SEED)
    f.add_argument("--judge", action="store_true")
    c = sub.add_parser("chain")
    c.add_argument("input")
    c.add_argument("output")
    c.add_argument("--resample", type=int, required=True)
    c.add_argument("--bitrate", default="32k")
    t = sub.add_parser("tune")
    t.add_argument("markers")
    t.add_argument("schedule")
    t.add_argument("free")
    t.add_argument("--seed", type=int, required=True)
    d = sub.add_parser("detect")
    d.add_argument("recording")
    d.add_argument("schedule")
    d.add_argument("--channel", type=int, default=1)
    j = sub.add_parser("judge")
    j.add_argument("detection")
    j.add_argument("truth")
    j.add_argument("--p95-ms", type=float, default=5.0)
    j.add_argument("--per-marker", action="store_true", help="fail any single marker beyond --p95-ms")
    j.add_argument("--pairs", action="store_true")
    j.add_argument("--zero-misses", action="store_true")
    j.add_argument("--zero-false", action="store_true")
    a = p.parse_args()
    {"gen": cmd_gen, "free": cmd_free, "chain": cmd_chain, "tune": cmd_tune,
     "detect": cmd_detect, "judge": cmd_judge}[a.cmd](a)


if __name__ == "__main__":
    main()
