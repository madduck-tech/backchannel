#!/usr/bin/env python3
"""What played into the tone sink, read from the PipeWire graph across one press. (#173)

The row's own answer cannot tell a tone from anything else that reached the sink: WirePlumber's
`follow` policy moves streams that are already playing into a new default output. So the graph is
sampled for the length of the press and every link *into* the sink is attributed to the process that
made it. A link out of the sink's monitor is the application listening. It is not "into", and it is
the positive sentinel: without it an empty sink means only that nobody was looking.

    tone-graph.py watch <sink-id> <out.jsonl>   samples `pw-dump` every 250 ms until SIGTERM
    tone-graph.py judge <out.jsonl>             one line, then exits 0 (the tone, alone) or 1

The process binary is read from the node's props, or else from the client its `client.id` names.
pipewire-pulse copies it onto the node only for PulseAudio streams; the `pw-cat` node in this
machine's graph carried it on its client alone.
"""
import json
import signal
import subprocess
import sys
import time

EXPECTED = 'WebKitWebProcess'
INTERVAL = 0.25


def props(obj):
    return (obj.get('info') or {}).get('props') or {}


def attribute(by_id, node_id):
    node = by_id.get(node_id) or {}
    p = props(node)
    binary, where = p.get('application.process.binary'), 'node'
    if not binary:
        client = by_id.get(p.get('client.id')) or {}
        binary, where = props(client).get('application.process.binary'), 'client'
    names = {k: p.get(k) for k in ('client.api', 'media.software', 'node.name') if p.get(k)}
    return {'node': node.get('id'), 'binary': binary, 'binary_from': where if binary else None, 'names': names}


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


def sample(sink):
    by_id = dump()
    into, out_of = [], []
    for o in by_id.values():
        if o.get('type') != 'PipeWire:Interface:Link':
            continue
        info = o.get('info') or {}
        if info.get('input-node-id') == sink:
            into.append(attribute(by_id, info.get('output-node-id')))
        elif info.get('output-node-id') == sink:
            out_of.append(attribute(by_id, info.get('input-node-id')))
    return into, out_of


def watch(sink, out):
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    with open(out, 'w') as f:
        while not stop:
            t = time.monotonic()
            try:
                into, out_of = sample(sink)
                f.write(json.dumps({'t': round(t, 3), 'into': into, 'out_of': out_of}) + '\n')
            except Exception as e:  # a sample that could not be taken is recorded, not dropped
                f.write(json.dumps({'t': round(t, 3), 'error': str(e)}) + '\n')
            f.flush()
            time.sleep(max(0.0, INTERVAL - (time.monotonic() - t)))


def judge(path):
    rows = [json.loads(line) for line in open(path) if line.strip()]
    errors = [r for r in rows if 'error' in r]
    samples = [r for r in rows if 'into' in r]
    foreign = [l for r in samples for l in r['into'] if l['binary'] != EXPECTED]
    ours = [l for r in samples for l in r['into'] if l['binary'] == EXPECTED]
    listening = sum(1 for r in samples if r['out_of'])
    head = f'{len(samples)} samples, {len(errors)} not taken, {listening} with the monitor being read'
    if errors:
        print(f'{head}: a sample that could not be read cannot vouch for that moment ({errors[0]["error"]})')
        return 1
    if foreign:
        seen = sorted({json.dumps({'binary': l['binary'], **l['names']}) for l in foreign})
        print(f'{head}: something other than {EXPECTED} played into the tone sink: {"; ".join(seen)}')
        return 1
    if not listening:
        print(f'{head}: nothing read the sink\'s monitor, so an empty sink says nothing about the tone')
        return 1
    if not ours:
        print(f'{head}: no link entered the tone sink from {EXPECTED}')
        return 1
    l = ours[0]
    reader = next(x for r in samples for x in r['out_of'])
    missing = [k for k in ('client.api', 'media.software') if k not in l['names']]
    named = ', '.join(f'{k}={v}' for k, v in l['names'].items()) or 'no name keys at all'
    print(f'{head}: {sum(1 for r in samples if any(x["binary"] == EXPECTED for x in r["into"]))} with a link from '
          f'{EXPECTED} (binary read from its {l["binary_from"]}; {named}'
          f'{"; missing " + ", ".join(missing) if missing else ""}), none from anything else; the monitor was read by '
          f'{reader["binary"]} ({", ".join(f"{k}={v}" for k, v in reader["names"].items()) or "no name keys"})')
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'watch':
        watch(int(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == 'judge':
        sys.exit(judge(sys.argv[2]))
    else:
        sys.exit(__doc__)
