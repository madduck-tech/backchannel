#!/usr/bin/env python3
"""What played into the tone sink, read from the PipeWire graph across one press. (#173)

The row's own answer cannot tell a tone from anything else that reached the sink: WirePlumber's
`follow` policy moves streams that are already playing into a new default output. So the graph is
sampled for the length of the press and every link *into* the sink is attributed to the process that
made it. A link out of the sink's monitor is the application listening. It is not "into", and it is
the positive sentinel: without it an empty sink means only that nobody was looking.

    tone-graph.py watch <sink-id> <root-pid> <out.jsonl>   samples `pw-dump` every 250 ms until SIGTERM
    tone-graph.py judge <out.jsonl>                        one line, then exits 0 (the tone, alone) or 1

**Ours, not merely WebKit's.** Every WebKitGTK program on the machine runs a `WebKitWebProcess`, so the
binary alone would let Epiphany's audio pass as the tone (#173's adversary). A node counts as the
application's when its `application.process.id` descends from `<root-pid>`, the pass's driver. That
is checked against `/proc` at the moment of the sample, while the process exists.

The binary and the process id are read from the node's props, or else from the client its
`client.id` names. pipewire-pulse copies them onto the node only for PulseAudio streams; the `pw-cat`
node in this machine's graph carried them on its client alone. The tone's link must also be
`active`: a link in `error` carried nothing.

**The application's own capture names itself.** cpal's PulseAudio host sends no process properties,
and pipewire-pulse then gives its client the server's own pid (2630 on 2026-10-25, the same as
`pipewire.sec.pid`). But cpal names the stream `cpal-pulseaudio-<pid>` from `std::process::id()`
(cpal 0.18.1, `src/host/pulseaudio/mod.rs:139`), so that name is read before the client's props.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time

EXPECTED = 'WebKitWebProcess'
INTERVAL = 0.25


def props(obj):
    return (obj.get('info') or {}).get('props') or {}


def descends(pid, root):
    """Whether `pid` is `root` or one of its descendants, read from `/proc` now."""
    for _ in range(64):
        if pid == root:
            return True
        if pid is None or pid <= 1:
            return False
        try:
            stat = open(f'/proc/{pid}/stat').read()
        except OSError:
            return False
        pid = int(stat[stat.rindex(')') + 2:].split()[1])
    return False


def attribute(by_id, node_id, root):
    node = by_id.get(node_id) or {}
    p = props(node)
    client = props(by_id.get(p.get('client.id')) or {})
    binary, where = p.get('application.process.binary'), 'node'
    if not binary:
        binary, where = client.get('application.process.binary'), 'client'
    cpal = re.fullmatch(r'cpal-pulseaudio-(\d+)', str(p.get('node.name', '')))
    pid, pid_from = p.get('application.process.id'), 'node'
    if not pid and cpal:
        pid, pid_from = cpal.group(1), 'cpal stream name'
    if not pid:
        pid, pid_from = client.get('application.process.id'), 'client'
    pid_from = pid_from if pid else None
    try:
        pid = int(pid) if pid is not None else None
    except (TypeError, ValueError):
        pid = None
    names = {k: p.get(k) for k in ('client.api', 'media.software', 'node.name') if p.get(k)}
    return {'node': node.get('id'), 'binary': binary, 'binary_from': where if binary else None,
            'pid': pid, 'pid_from': pid_from, 'ours': descends(pid, root), 'names': names}


def dump():
    # `pw-dump` can print more than one array when the graph changes while it reads (measured: one
    # sample in 39 across a press). Later arrays are updates; an object whose `info` is null is gone.
    text = subprocess.run(['pw-dump'], capture_output=True, text=True, check=True).stdout
    decoder, at, by_id = json.JSONDecoder(), 0, {}
    while True:
        while at < len(text) and text[at].isspace():
            at += 1
        if at == len(text):
            return by_id
        doc, at = decoder.raw_decode(text, at)
        for o in doc:
            if o.get('info') is None:
                by_id.pop(o.get('id'), None)
            else:
                by_id[o['id']] = o


def sample(sink, root):
    by_id = dump()
    into, out_of = [], []
    for o in by_id.values():
        if o.get('type') != 'PipeWire:Interface:Link':
            continue
        info = o.get('info') or {}
        if info.get('input-node-id') == sink:
            into.append({**attribute(by_id, info.get('output-node-id'), root), 'state': info.get('state')})
        elif info.get('output-node-id') == sink:
            out_of.append({**attribute(by_id, info.get('input-node-id'), root), 'state': info.get('state')})
    return into, out_of


def watch(sink, root, out):
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    with open(out, 'w') as f:
        while not stop:
            t = time.monotonic()
            try:
                into, out_of = sample(sink, root)
                f.write(json.dumps({'t': round(t, 3), 'into': into, 'out_of': out_of}) + '\n')
            except Exception as e:  # a sample that could not be taken is recorded, not dropped
                f.write(json.dumps({'t': round(t, 3), 'error': str(e)}) + '\n')
            f.flush()
            time.sleep(max(0.0, INTERVAL - (time.monotonic() - t)))


def describe(link):
    names = ', '.join(f'{k}={v}' for k, v in link['names'].items()) or 'no name keys'
    return (f'{link["binary"]} (pid {link["pid"]} from its {link["pid_from"]}, {"ours" if link["ours"] else "not ours"}; '
            f'{names})')


def judge(path):
    rows = [json.loads(line) for line in open(path) if line.strip()]
    errors = [r for r in rows if 'error' in r]
    samples = [r for r in rows if 'into' in r]
    is_tone = lambda l: l['binary'] == EXPECTED and l['ours']
    foreign = [l for r in samples for l in r['into'] if not is_tone(l)]
    tone = [l for r in samples for l in r['into'] if is_tone(l) and l['state'] == 'active']
    readers = [l for r in samples for l in r['out_of']]
    ours_reading = sum(1 for r in samples if any(l['ours'] for l in r['out_of']))
    head = f'{len(samples)} samples, {len(errors)} not taken, {ours_reading} with the application reading the monitor'
    readers_seen = '; '.join(sorted({describe(l) for l in readers})) or 'nobody'
    if errors:
        print(f'{head}: a sample that could not be read cannot vouch for that moment ({errors[0]["error"]})')
        return 1
    if foreign:
        seen = '; '.join(sorted({describe(l) for l in foreign}))
        print(f'{head}: something other than the application\'s {EXPECTED} played into the tone sink: {seen}')
        return 1
    if not ours_reading:
        print(f'{head}: the application never read the sink\'s monitor, so an empty sink says nothing about the tone (read by: {readers_seen})')
        return 1
    if not tone:
        states = sorted({l['state'] for r in samples for l in r['into']})
        print(f'{head}: no active link entered the tone sink from the application\'s {EXPECTED}'
              f'{" (its links were " + ", ".join(map(str, states)) + ")" if states else ""}; the monitor was read by {readers_seen}')
        return 1
    l = tone[0]
    missing = [k for k in ('client.api', 'media.software') if k not in l['names']]
    reader = next(x for x in readers if x['ours'])
    print(f'{head}: {sum(1 for r in samples if any(is_tone(x) and x["state"] == "active" for x in r["into"]))} with an active link '
          f'from {describe(l)}, binary read from its {l["binary_from"]}{"; missing " + ", ".join(missing) if missing else ""}; '
          f'none from anything else; the monitor was read by {describe(reader)}')
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == 'watch':
        watch(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
    elif len(sys.argv) == 3 and sys.argv[1] == 'judge':
        sys.exit(judge(sys.argv[2]))
    else:
        sys.exit(__doc__)
