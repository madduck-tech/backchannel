#!/usr/bin/env python3
"""Where captures are linked from, read from the PipeWire graph across one gate entry. (#293)

A gate entry that makes the harness's source the default input moves every capture that follows the
default onto the harness, a call's microphone in a browser tab included (WirePlumber's `follow`). This
samples the graph every 250 ms and records, for each sample:
- **the recorder's source:** what the link into a silent `pw-record` with no target comes from. The
  recorder stands for every capture that follows the default.
- **the application's capture links:** every link into a `cpal-pulseaudio-<pid>` node, by where it
  comes from.
- **`default.configured.audio.source`, `default.audio.source` and `default.audio.sink`,** and
  `configured_present`: whether a node of the configured source's name is in the graph. When it is not,
  WirePlumber falls back through its stack, which is the case a stacked harness name took over.
- **foreign captures:** `Stream/Input/Audio` nodes that are neither the recorder's nor the pass's.
  With `--stop`, the first one stops the pass by sending TERM to its process group, so a gate never
  runs beside someone else's capture. A node whose pid is not on this host is `ended` for at most
  `ENDED_GRACE` seconds, then foreign, counted per object (its id, `object.serial` and pid, since PipeWire
  reuses ids): a node outlives its process for a moment, and on 2026-10-31 the
  harness's own level probe, sampled as its `timeout` ended it, stopped entries 28–29 that way. Past the
  grace it is foreign, because a sandboxed browser reports a pid from its own namespace, which is not on
  the host either, for as long as it records.
- **the pass's own captures:** the harness's level probes, by where they are linked from. A probe that
  targets a name WirePlumber has not resolved falls back to the default input, and would measure the
  person's microphone.

    capture-graph.py nodes                                      every node: id, name, media.class, description, tab-separated
    capture-graph.py app-linked <source> [<root-pid>]           exit 0 when an active link from <source> reaches a
                                                                `cpal-pulseaudio-*` capture whose process descends
                                                                from <root-pid>
    capture-graph.py inputs                                     every Stream/Input/Audio node, one per line
    capture-graph.py recorder <recorder-pid>                    the nodes linked into the recorder, one per line
    capture-graph.py watch <out.jsonl> <recorder-pid> <pass-pid> [--stop] [--app-pgid-glob GLOB]
    capture-graph.py summary <out.jsonl>                        what the recorder and the defaults went through
    capture-graph.py check <out.jsonl> [--system NAME]... [--system-default-sink] [--recording]
                                                                #293 item 2, exit 1 on any violation

`nodes` and `app-linked` are the graph reads the gate scripts share, so that each reads a split dump (below)
the same way; any `pw-dump` failure exits non-zero, never as an empty graph.

`check` holds, in every sample: the recorder is linked from that sample's effective default and nothing
else, which is never a harness node; neither default key names a harness node; every link into the
application's capture comes from this run's harness source (`backchannel_harness_src_<run id>`) or from a
system device the entry names (`--system`, a node name, or a prefix ending in `*`; `--system-default-sink`
for the node `default.audio.sink` names in that sample). At least one sample links the harness source
into the application, and every such link comes from one source name, so another run's source is not
taken for this one's. With `--recording`, at least one sample also links a system device at the same
time, which only a recording does: the audio check opens the microphone alone. An unreadable sample, or a
stop, is a failure: neither shows the invariant held.

A process is the pass's when it descends from `<pass-pid>`, read from `/proc` at the sample, or when its
process group is one a `GLOB` file names, written since the watch began: a kept or killed profile's pid
file names a group that may since belong to anyone. [29]'s `stage2-record-check.sh` starts the application
under `setsid` from a subshell, so it is reparented outside the pass; its group's leader is written to
`$PROFILE/pid`, which the glob finds. Attribution is `tone-graph.py`'s: `application.process.id`, else
the `cpal-pulseaudio-<pid>` name, else the client's.
"""
import glob
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time

_spec = importlib.util.spec_from_file_location('tone_graph', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tone-graph.py'))
tg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tg)

INTERVAL = 0.25
ENDED_GRACE = 1.0


def dump():
    # `pw-dump` can print a second array when the graph changes while it reads: 8 of 688 samples on
    # 2026-10-31. Later arrays are updates, and an object whose `info` is null is gone. Not
    # `tone-graph.py`'s reader, which keys removal on `info` and so drops every metadata object.
    text = subprocess.run(['pw-dump'], capture_output=True, text=True, timeout=10, check=True).stdout
    decoder, at, by_id = json.JSONDecoder(), 0, {}
    while True:
        while at < len(text) and text[at].isspace():
            at += 1
        if at == len(text):
            return list(by_id.values())
        doc, at = decoder.raw_decode(text, at)
        for o in doc:
            if 'info' in o and o['info'] is None:
                by_id.pop(o.get('id'), None)
            else:
                by_id[o['id']] = o


def defaults(objs):
    found = {}
    for o in objs:
        if str(o.get('type', '')).endswith('Metadata') and (o.get('props') or {}).get('metadata.name') == 'default':
            for m in o.get('metadata') or []:
                if m.get('key') in ('default.configured.audio.source', 'default.audio.source', 'default.audio.sink'):
                    v = m.get('value')
                    found[m['key']] = v.get('name') if isinstance(v, dict) else v
    return found


def capture_nodes(objs):
    return [o for o in objs if str(o.get('type', '')).endswith('Node') and tg.props(o).get('media.class') == 'Stream/Input/Audio']


def name_of(by_id, node_id):
    return tg.props(by_id.get(node_id) or {}).get('node.name')


def pass_pgids(pattern, since):
    pgids = set()
    for f in glob.glob(pattern) if pattern else []:
        try:
            if os.path.getmtime(f) < since:
                continue
            pgids.add(int(open(f).read().strip()))
        except (OSError, ValueError):
            pass
    return pgids


def ours(pid, recorder, pass_pid, pgids):
    if pid is None:
        return False
    if pid == recorder or tg.descends(pid, pass_pid):
        return True
    try:
        return os.getpgid(pid) in pgids
    except OSError:
        return False


def sample(recorder, pass_pid, pattern, since=0.0, ended_seen=None):
    objs = dump()
    by_id = {o.get('id'): o for o in objs}
    links = [o for o in objs if str(o.get('type', '')).endswith('Link')]
    now = time.monotonic()
    ended_seen = {} if ended_seen is None else ended_seen
    rec = {'t': round(now, 3), **defaults(objs), 'recorder_from': [], 'app_links': [], 'pass_links': [], 'foreign': [], 'ended': []}
    names = {tg.props(o).get('node.name') for o in objs if str(o.get('type', '')).endswith('Node')}
    rec['configured_present'] = rec.get('default.configured.audio.source') in names
    pgids = pass_pgids(pattern, since)
    for node in capture_nodes(objs):
        who = tg.attribute(by_id, node.get('id'), pass_pid)
        pid = who.get('pid')
        into = [name_of(by_id, (l.get('info') or {}).get('output-node-id')) for l in links if (l.get('info') or {}).get('input-node-id') == node.get('id')]
        name = tg.props(node).get('node.name', '')
        if pid == recorder:
            rec['recorder_from'] += into
        elif name.startswith('cpal-pulseaudio-') and ours(pid, recorder, pass_pid, pgids):
            rec['app_links'] += [{'into': name, 'from': f} for f in into]
        elif ours(pid, recorder, pass_pid, pgids):
            rec['pass_links'] += [{'into': name, 'from': f} for f in into]
        elif pid is not None and not os.path.exists(f'/proc/{pid}') and now - ended_seen.setdefault((node.get('id'), tg.props(node).get('object.serial'), pid), now) <= ENDED_GRACE:
            rec['ended'].append({'node': node.get('id'), 'serial': tg.props(node).get('object.serial'), 'name': name, 'pid': pid, 'binary': who.get('binary')})
        else:
            rec['foreign'].append({'node': node.get('id'), 'name': name, 'pid': pid, 'binary': who.get('binary')})
    return rec


def cmd_nodes():
    for o in dump():
        if str(o.get('type', '')).endswith('Node'):
            p = tg.props(o)
            print('\t'.join(str(x or '').replace('\t', ' ') for x in (o.get('id'), p.get('node.name'), p.get('media.class'), p.get('node.description'))))


def cmd_app_linked(source, root):
    objs = dump()
    by_id = {o.get('id'): o for o in objs}
    for l in (o for o in objs if str(o.get('type', '')).endswith('Link')):
        i = l.get('info') or {}
        into = by_id.get(i.get('input-node-id')) or {}
        # Active, as tone-graph.py reads it: a link that is still negotiating or has failed carries nothing.
        if i.get('state') != 'active' or name_of(by_id, i.get('output-node-id')) != source or not tg.props(into).get('node.name', '').startswith('cpal-pulseaudio-'):
            continue
        if root is None or tg.descends(tg.attribute(by_id, into.get('id'), root).get('pid'), root):
            return 0
    return 1


def cmd_inputs():
    for node in capture_nodes(dump()):
        p = tg.props(node)
        print(node.get('id'), p.get('node.name'), p.get('application.process.id'), p.get('application.name'))


def cmd_watch(out, recorder, pass_pid, stop, pattern):
    stopping = []
    since = time.time()
    ended_seen = {}
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    with open(out, 'a') as f:
        while not stopping:
            try:
                rec = sample(recorder, pass_pid, pattern, since, ended_seen)
            except Exception as e:  # a sample that could not be read is recorded, never skipped silently
                rec = {'t': round(time.monotonic(), 3), 'error': repr(e)}
            f.write(json.dumps(rec) + '\n')
            f.flush()
            if stop and rec.get('foreign'):
                f.write(json.dumps({'t': rec['t'], 'stopped': 'a foreign capture appeared', 'foreign': rec['foreign']}) + '\n')
                f.flush()
                try:
                    os.killpg(pass_pid, signal.SIGTERM)
                except OSError:
                    pass
                return
            time.sleep(INTERVAL)


def cmd_summary(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    samples = [r for r in rows if 'recorder_from' in r]
    errors = [r for r in rows if 'error' in r]
    stopped = [r for r in rows if 'stopped' in r]
    runs = []
    for r in samples:
        key = (tuple(sorted(set(r['recorder_from']))), r.get('default.configured.audio.source'), r.get('default.audio.source'))
        if not runs or runs[-1][0] != key:
            runs.append([key, r['t'], r['t'], 0])
        runs[-1][2] = r['t']
        runs[-1][3] += 1
    print(f"{len(samples)} samples, {len(errors)} unreadable, {'stopped: ' + json.dumps(stopped[0]) if stopped else 'not stopped'}")
    t0 = samples[0]['t'] if samples else 0
    for (rec, conf, eff), a, b, n in runs:
        print(f"  {a - t0:8.2f}–{b - t0:8.2f} s, {n:4d} samples: recorder from {list(rec) or '-'}; configured {conf}; effective {eff}")
    app = sorted({(l['into'], l['from']) for r in samples for l in r['app_links']})
    print(f"  application capture links: {app or '-'}")
    harness = [r for r in samples if any('backchannel_harness' in (x or '') for x in r['recorder_from'])]
    print(f"  recorder linked from a harness node in {len(harness)} of {len(samples)} samples")
    present = [r for r in samples if r.get('configured_present')]
    print(f"  the configured default source was in the graph in {len(present)} of {len(samples)} samples")
    probes = sorted({(l['into'], l['from']) for r in samples for l in r.get('pass_links', [])})
    print(f"  the pass's own capture links: {probes or '-'}")


HARNESS = 'backchannel_harness'
RUN_SOURCE = 'backchannel_harness_src_'


def cmd_check(path, systems, default_sink, recording):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    samples = [r for r in rows if 'recorder_from' in r]
    bad = []
    for r in rows:
        if 'error' in r:
            bad.append(f"t={r['t']}: unreadable sample: {r['error']}")
        if 'stopped' in r:
            bad.append(f"t={r['t']}: the pass was stopped: {json.dumps(r['foreign'])}")
    for r in samples:
        eff, conf = r.get('default.audio.source'), r.get('default.configured.audio.source')
        rec = set(r['recorder_from'])
        if rec != {eff}:
            bad.append(f"t={r['t']}: the recorder is linked from {sorted(rec)}, not the effective default {eff}")
        for key, v in (('default.audio.source', eff), ('default.configured.audio.source', conf)):
            if HARNESS in (v or ''):
                bad.append(f"t={r['t']}: {key} names a harness node, {v}")
        allowed = set()
        if default_sink and r.get('default.audio.sink'):
            allowed.add(r['default.audio.sink'])
        r['_system'] = False
        for link in r['app_links']:
            f = link['from'] or ''
            system = f in allowed or any(f == s or (s.endswith('*') and f.startswith(s[:-1])) for s in systems)
            r['_system'] = r['_system'] or system
            if not (f.startswith(RUN_SOURCE) or system):
                bad.append(f"t={r['t']}: {link['into']} is linked from {f}, neither the harness source nor the entry's system device")
        for link in r.get('pass_links', []):
            if HARNESS not in (link['from'] or ''):
                bad.append(f"t={r['t']}: the pass's own capture {link['into']} is linked from {link['from']}, not a harness node")
    ended = {}
    for r in samples:
        for e in r.get('ended', []):
            ended.setdefault((e['node'], e.get('serial'), e.get('pid')), [r['t'], r['t'], e])[1] = r['t']
    for first, last, e in ended.values():
        if last - first > ENDED_GRACE:
            bad.append(f"t={first}: node {e['node']} ({e['name']}, pid {e['pid']}) was read as ended for {last - first:.2f} s, longer than an exit takes")
    linked = [r for r in samples if any((l['from'] or '').startswith(RUN_SOURCE) for l in r['app_links'])]
    sources = sorted({l['from'] for r in samples for l in r['app_links'] if (l['from'] or '').startswith(RUN_SOURCE)})
    if not samples:
        bad.append('no samples')
    elif not linked:
        bad.append(f'no sample of {len(samples)} links the harness source into the application')
    if len(sources) > 1:
        bad.append(f'the application was linked from {len(sources)} harness sources, not one run\'s: {sources}')
    if recording and samples and not [r for r in linked if r['_system']]:
        bad.append('no sample links the harness source and a system device at once: nothing shows the recording took the harness')
    for b in bad[:20]:
        print(f'  BROKEN {b}')
    if len(bad) > 20:
        print(f'  ... and {len(bad) - 20} more')
    print(f"{'BROKEN' if bad else 'HELD'}: {len(samples)} samples, {len(linked)} with the harness source linked into the application, {len(bad)} violations")
    return 1 if bad else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['inputs']:
        cmd_inputs()
    elif a[:1] == ['recorder']:
        print('\n'.join(n or '' for n in sorted(set(sample(int(a[1]), int(a[1]), None)['recorder_from']))))
    elif a[:1] == ['watch']:
        pattern = a[a.index('--app-pgid-glob') + 1] if '--app-pgid-glob' in a else None
        cmd_watch(a[1], int(a[2]), int(a[3]), '--stop' in a, pattern)
    elif a[:1] == ['summary']:
        cmd_summary(a[1])
    elif a[:1] == ['check']:
        systems = [a[i + 1] for i, x in enumerate(a) if x == '--system']
        sys.exit(cmd_check(a[1], systems, '--system-default-sink' in a, '--recording' in a))
    elif a[:1] == ['nodes']:
        cmd_nodes()
    elif a[:1] == ['app-linked']:
        sys.exit(cmd_app_linked(a[1], int(a[2]) if len(a) > 2 else None))
    else:
        sys.exit(__doc__)
