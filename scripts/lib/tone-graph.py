#!/usr/bin/env python3
"""What played into the tone sink, read from the PipeWire graph across one press. (#173, #266)

The tone reaches its null sink by name: the driver launches the application with `PULSE_SINK` set to
this run's sink and every GStreamer audio sink but `pulsesink` ranked out, and the default output is
never moved (#266). The row's own answer still cannot tell the tone from anything else that reached the
sink, so the graph is sampled across the press and every link *into* the sink is attributed to the
process that made it. A link out of the sink's monitor is the application listening. It is not "into",
and it is the positive sentinel: without it an empty sink means only that nobody was looking.

Each sample also records both default-output keys (`default.configured.audio.sink`, `default.audio.sink`),
every link from our `WebKitWebProcess` into any node, and, with `--sentinel`, every link from one
process's nodes, so a stream that follows the default can be shown never to have moved.

    tone-graph.py watch <sink-id> <root-pid> <out.jsonl> [--sentinel <pid>]
                                                           samples `pw-dump` every 250 ms until SIGTERM
    tone-graph.py judge <out.jsonl> [--stamps <dir> <sink-id> <sink-name>]
                                                           the tone's file: one line, then exits 0 (the
                                                           tone, alone) or 1; with --stamps, also 1 unless
                                                           every check before the press left this run's
                                                           stamp in <dir>, in order, before the first sample
    tone-graph.py probe-judge <out.jsonl> <sink-id> <t> [--stamp <dir> <sink-name>]
                                                           the probe's file, <t> its answer's monotonic time
    tone-graph.py webenv <root-pid> <sink-name> <pin> [--stamp <dir> <sink-id>]
                                                           every WebKitWebProcess under <root-pid> carries
                                                           PULSE_SINK=<sink-name> and the pin; exits 1 naming
                                                           the first one that does not
    tone-graph.py stamp <dir> guard <sink-name> <sink-id>  the default-output guard's stamp, which the guard
                                                           writes once its read has passed
    tone-graph.py stamps-ok <dir> <sink-name> <sink-id> <tone.jsonl>
                                                           exits 0 when every check before the press left this
                                                           run's stamp, in order, and the tone's sampler holds
                                                           a sample later than all of them; else 1, naming why

**Each check before the press stamps its pass, and the press refuses without every stamp.** The four checks
(`webenv`, `one-sink`, the guard, `probe-judge`) each write `<check> <sink-name> <sink-id> <t>` to a file
of their own in the run's stamp directory, on a pass alone, with `t` on the monotonic clock the samples
use. The pass's one press goes through a function that runs `stamps-ok` first, and the judge requires the
same. A test of the pass's text can hold that the checks are there, not that they ran: round 2's stamps
covered two checks, and a one-line edit skipped the other two with the census green (#266's gate
adversary, round 3). A skipped, swallowed or reordered check now leaves the press nothing to accept.
    tone-graph.py closed <out.jsonl> <t>                   exits 0 once a sample taken at or after <t> holds
                                                           no link from our WebKitWebProcess
    tone-graph.py one-sink <family> <id> <name>            the graph holds one node of the family: <id>, <name>
    tone-graph.py nodes <node-name> | --family <family>    the ids of every node with that name, or of the
                                                           family (the name, or the name and `_`); exits 1
                                                           when the graph could not be read
    tone-graph.py name-of <id>                             that node's name, or nothing
    tone-graph.py ports <id>                               how many input ports that node has

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
COMM = EXPECTED[:15]  # the kernel keeps 15 characters of a process name
FAMILY = 'backchannel_tone_sink'
ROUTE = 'pipewire-pulse'  # the client.api of a stream from `pulsesink`, the one GStreamer sink the pin leaves
INTERVAL = 0.25
DEFAULT_KEYS = ('default.configured.audio.sink', 'default.audio.sink')


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
            # A removal is `"info": null`. A metadata object has no `info` at all, and is kept (#266).
            if 'info' in o and o['info'] is None:
                by_id.pop(o.get('id'), None)
            else:
                by_id[o['id']] = o


def in_family(name, family=FAMILY):
    return name == family or str(name or '').startswith(family + '_')


def defaults(by_id):
    found = {}
    for o in by_id.values():
        if str(o.get('type', '')).endswith('Metadata') and (o.get('props') or {}).get('metadata.name') == 'default':
            for m in o.get('metadata') or []:
                if m.get('key') in DEFAULT_KEYS:
                    v = m.get('value')
                    found[m['key']] = v.get('name') if isinstance(v, dict) else v
    return found


def owner_pid(by_id, node_id):
    p = props(by_id.get(node_id) or {})
    pid = p.get('application.process.id') or props(by_id.get(p.get('client.id')) or {}).get('application.process.id')
    try:
        return int(pid) if pid is not None else None
    except (TypeError, ValueError):
        return None


def sample(sink, root, sentinel=None):
    by_id = dump()
    into, out_of, web, sent = [], [], [], []
    for o in by_id.values():
        if o.get('type') != 'PipeWire:Interface:Link':
            continue
        info = o.get('info') or {}
        src, dst = info.get('output-node-id'), info.get('input-node-id')
        if dst == sink:
            into.append({**attribute(by_id, src, root), 'state': info.get('state')})
        elif src == sink:
            out_of.append({**attribute(by_id, dst, root), 'state': info.get('state')})
        who = attribute(by_id, src, root)
        if who['binary'] == EXPECTED and who['ours']:
            web.append({**who, 'into': dst, 'into_name': props(by_id.get(dst) or {}).get('node.name'), 'to_sink': dst == sink, 'state': info.get('state')})
        if sentinel is not None and owner_pid(by_id, src) == sentinel:
            sent.append({'into': dst, 'into_name': props(by_id.get(dst) or {}).get('node.name'), 'state': info.get('state')})
    row = {'into': into, 'out_of': out_of, 'web': web, 'defaults': defaults(by_id)}
    if sentinel is not None:
        row['sentinel'] = sent
        row['sentinel_alive'] = os.path.exists(f'/proc/{sentinel}')
    return row


def watch(sink, root, out, sentinel=None):
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    with open(out, 'w') as f:
        while not stop:
            t = time.monotonic()
            try:
                f.write(json.dumps({'t': round(t, 3), **sample(sink, root, sentinel)}) + '\n')
            except Exception as e:  # a sample that could not be taken is recorded, not dropped
                f.write(json.dumps({'t': round(t, 3), 'error': str(e)}) + '\n')
            f.flush()
            time.sleep(max(0.0, INTERVAL - (time.monotonic() - t)))


def describe(link):
    names = ', '.join(f'{k}={v}' for k, v in link['names'].items()) or 'no name keys'
    return (f'{link["binary"]} (pid {link["pid"]} from its {link["pid_from"]}, {"ours" if link["ours"] else "not ours"}; '
            f'{names})')


def named_default(samples):
    """The first sample in which a default-output key names a node of the tone sink's family (#266), or one
    with no `default.audio.sink` at all: real `pw-dump` output carries it in every sample (M1: 39 of 39 and
    14 of 14), so its absence is a sample that cannot show the default stayed put."""
    for r in samples:
        if not (r.get('defaults') or {}).get('default.audio.sink'):
            return f'at t={r["t"]} the sample holds no default.audio.sink, so nothing shows the default output stayed put'
    for r in samples:
        for key in DEFAULT_KEYS:
            if in_family((r.get('defaults') or {}).get(key)):
                return f'at t={r["t"]} {key} names the tone sink ({r["defaults"][key]}): the default output moved'
    return None


def route(link):
    api = link['names'].get('client.api')
    return None if api == ROUTE else f'client.api {"is absent" if api is None else "is " + api}, not {ROUTE}, on {describe(link)}'


STAMPS = ('webenv', 'one-sink', 'guard', 'probe')  # the checks before the press, in the order the pass runs them


def write_stamp(stamp_dir, check, name, sink):
    """A check that passed says so: which check, for which sink, and when, on the samples' clock."""
    with open(os.path.join(stamp_dir, check), 'w') as f:
        f.write(f'{check} {name} {sink} {time.monotonic():.6f}\n')


def stamps_fault(stamp_dir, name, sink, before=None):
    """None when every check before the press left this run's stamp, in order, each earlier than `before`."""
    last = None
    for check in STAMPS:
        path = os.path.join(stamp_dir, check)
        try:
            lines = open(path).read().splitlines()
        except OSError:
            return f'the {check} check before the press never passed in this run, so nothing shows it ran'
        parts = lines[0].split(' ') if len(lines) == 1 else []
        try:
            t = float(parts[3]) if len(parts) == 4 else None
        except ValueError:
            t = None
        if t is None or parts[:3] != [check, name, str(sink)]:
            return f'the {check} stamp reads {json.dumps(chr(10).join(lines))}, not "{check} {name} {sink} <t>": it is not this run\'s'
        if last and t <= last[1]:
            return f'the {check} stamp is not later than the {last[0]} stamp, so the checks did not run in the pass\'s order'
        if before is not None and t >= before:
            return f'the {check} stamp was written after the tone\'s first sample'
        last = (check, t)
    return None


def first_sample(path):
    try:
        rows = [json.loads(line) for line in open(path) if line.strip()]
    except (OSError, ValueError):
        return None
    return rows[0]['t'] if rows else None


def judge(path, stamps=None):
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
    unstamped = stamps_fault(stamps[0], stamps[2], stamps[1], rows[0]['t'] if rows else None) if stamps else None
    if unstamped:
        print(f'{head}: {unstamped}')
        return 1
    moved = named_default(samples)
    if moved:
        print(f'{head}: {moved}')
        return 1
    if samples and samples[0]['into']:
        print(f'{head}: the first sample, taken before the press, already held a link into the tone sink: {describe(samples[0]["into"][0])}')
        return 1
    if foreign:
        seen = '; '.join(sorted({describe(l) for l in foreign}))
        print(f'{head}: something other than the application\'s {EXPECTED} played into the tone sink: {seen}')
        return 1
    elsewhere = [l for r in samples for l in r.get('web', []) if not l['to_sink']]
    if elsewhere:
        print(f'{head}: the application\'s {EXPECTED} played into {elsewhere[0]["into_name"]} (node {elsewhere[0]["into"]}), not only the tone sink')
        return 1
    stray = sentinel_fault(samples)
    if stray:
        print(f'{head}: {stray}')
        return 1
    if not ours_reading:
        print(f'{head}: the application never read the sink\'s monitor, so an empty sink says nothing about the tone (read by: {readers_seen})')
        return 1
    if not tone:
        states = sorted({l['state'] for r in samples for l in r['into']})
        print(f'{head}: no active link entered the tone sink from the application\'s {EXPECTED}'
              f'{" (its links were " + ", ".join(map(str, states)) + ")" if states else ""}; the monitor was read by {readers_seen}')
        return 1
    off = next((f for f in map(route, tone) if f), None)
    if off:
        print(f'{head}: the tone did not take the route the gate pins: {off}')
        return 1
    l = tone[0]
    missing = [k for k in ('client.api', 'media.software') if k not in l['names']]
    reader = next(x for x in readers if x['ours'])
    print(f'{head}: {sum(1 for r in samples if any(is_tone(x) and x["state"] == "active" for x in r["into"]))} with an active link '
          f'from {describe(l)}, binary read from its {l["binary_from"]}{"; missing " + ", ".join(missing) if missing else ""}; '
          f'none from anything else; the monitor was read by {describe(reader)}')
    return 0


def sentinel_fault(samples):
    """With `--sentinel`: a stream that follows the default stayed off the tone sink, on a sink, alive (#266)."""
    watched = [r for r in samples if 'sentinel' in r]
    if not watched:
        return None
    for r in watched:
        links = r['sentinel']
        if any(in_family(l['into_name']) for l in links):
            return f'at t={r["t"]} the sentinel stream was linked into the tone sink'
        if not any(l['state'] == 'active' for l in links):
            return f'at t={r["t"]} the sentinel stream had no active link into any sink, so nothing shows where the default was'
    if not watched[-1].get('sentinel_alive'):
        return 'the sentinel stream was gone by the last sample'
    return None


def probe_judge(path, sink, answered, stamp=None):
    """The probe's own file: the route is the tone sink, through `pulsesink`, and it closes (#266)."""
    rows = [json.loads(line) for line in open(path) if line.strip()]
    errors = [r for r in rows if 'error' in r]
    samples = [r for r in rows if 'into' in r]
    head = f'{len(samples)} samples, {len(errors)} not taken'
    if errors:
        print(f'{head}: a sample that could not be read cannot vouch for that moment ({errors[0]["error"]})')
        return 1
    moved = named_default(samples)
    if moved:
        print(f'{head}: {moved}')
        return 1
    foreign = [l for r in samples for l in r['into'] if not (l['binary'] == EXPECTED and l['ours'])]
    if foreign:
        print(f'{head}: a link into the tone sink that is not ours: {describe(foreign[0])}')
        return 1
    elsewhere = [l for r in samples for l in r.get('web', []) if not l['to_sink']]
    if elsewhere:
        print(f'{head}: the probe\'s stream went into {elsewhere[0]["into_name"]} (node {elsewhere[0]["into"]}), not the tone sink: {describe(elsewhere[0])}')
        return 1
    ours = [l for r in samples for l in r.get('web', []) if l['to_sink'] and l['state'] == 'active']
    if not ours:
        print(f'{head}: no active link from the application\'s {EXPECTED} entered the tone sink, so nothing shows the route')
        return 1
    off = next((f for f in map(route, ours) if f), None)
    if off:
        print(f'{head}: the probe did not take the route the gate pins: {off}')
        return 1
    stray = sentinel_fault(samples)
    if stray:
        print(f'{head}: {stray}')
        return 1
    after = [r for r in samples if r['t'] >= answered]
    if not after:
        print(f'{head}: no sample was taken after the probe answered')
        return 1
    if after[-1].get('web'):
        print(f'{head}: a link from the application\'s {EXPECTED} was still there at the deadline, {after[-1]["t"] - answered:.2f} s after the probe answered')
        return 1
    closed = next(r for r in after if not r.get('web'))
    print(f'{head}: {sum(1 for r in samples if any(l["to_sink"] and l["state"] == "active" for l in r.get("web", [])))} with an active link '
          f'from {describe(ours[0])} into the tone sink and none elsewhere; none left {closed["t"] - answered:.2f} s after the probe answered')
    if stamp:
        write_stamp(stamp[0], 'probe', stamp[1], sink)
    return 0


def web_processes(root):
    """Our `WebKitWebProcess`es: descendants of `root` whose `exe` ends in the name or, only when `exe`
    cannot be read, whose `comm` is the name cut to 15 characters. Each as (pid, how it was found)."""
    found = []
    for n in os.listdir('/proc'):
        if not n.isdigit() or int(n) == os.getpid() or not descends(int(n), root):
            continue
        try:
            stat = open(f'/proc/{n}/stat').read()
        except OSError:
            continue
        if stat[stat.rindex(')') + 2] == 'Z':  # exited, not yet reaped: it plays nothing, and its exe reads as gone
            continue
        try:
            exe = os.readlink(f'/proc/{n}/exe')
        except OSError:
            exe = None
        if exe is not None:
            if os.path.basename(exe.removesuffix(' (deleted)')) == EXPECTED:
                found.append((int(n), 'exe'))
            continue
        try:
            comm = open(f'/proc/{n}/comm').read().strip()
        except OSError:
            continue
        if comm == COMM:
            found.append((int(n), 'comm'))
    return sorted(found)


def webenv(root, sink_name, pin, stamp=None):
    procs = web_processes(root)
    if not procs:
        print(f'no {EXPECTED} runs under the driver (pid {root}), so nothing shows where the tone will play')
        return 1
    for pid, how in procs:
        try:
            env = dict(kv.split('=', 1) for kv in open(f'/proc/{pid}/environ', 'rb').read().decode('utf-8', 'replace').split('\0') if '=' in kv)
        except OSError as e:
            print(f'{EXPECTED} pid {pid} (found by its {how}): its environ cannot be read ({e.strerror}), so nothing shows its route')
            return 1
        if env.get('PULSE_SINK') != sink_name:
            print(f'{EXPECTED} pid {pid} (found by its {how}) has PULSE_SINK={env.get("PULSE_SINK", "<unset>")}, not {sink_name}')
            return 1
        if env.get('GST_PLUGIN_FEATURE_RANK') != pin:
            print(f'{EXPECTED} pid {pid} (found by its {how}) has GST_PLUGIN_FEATURE_RANK={env.get("GST_PLUGIN_FEATURE_RANK", "<unset>")}, not the pin {pin}')
            return 1
    print(f'{len(procs)} {EXPECTED} under the driver, each with PULSE_SINK={sink_name} and the pin '
          f'(found by exe: {sum(1 for _, h in procs if h == "exe")}, by comm: {sum(1 for _, h in procs if h == "comm")})')
    if stamp:
        write_stamp(stamp[0], 'webenv', sink_name, stamp[1])
    return 0


def one_sink(family, sink, name, stamp_dir=None):
    nodes = [(o['id'], props(o).get('node.name')) for o in dump().values() if str(o.get('type', '')).endswith('Node') and in_family(props(o).get('node.name'), family)]
    if not nodes:
        print(f'no node of the {family} family is in the graph')
        return 1
    if len(nodes) > 1:
        print(f'{len(nodes)} nodes of the {family} family are in the graph ({", ".join(f"{i} {n}" for i, n in nodes)}), not this run\'s alone')
        return 1
    (i, n), = nodes
    if i != sink or n != name:
        print(f'the {family} node in the graph is {i} named {n}, not this run\'s {sink} named {name}')
        return 1
    print(f'one node of the family, {i}, named {n}')
    if stamp_dir:
        write_stamp(stamp_dir, 'one-sink', name, sink)
    return 0


def read_graph():
    # A guard reads this. One `json.load` raised on a split dump, printed nothing, and the guard read that
    # as "no stale node" (#173's adversary, round 3).
    try:
        return dump()
    except Exception as e:
        sys.exit(f'tone-graph: could not read the graph: {e}')


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['watch'] and len(a) in (4, 6) and (len(a) == 4 or a[4] == '--sentinel'):
        watch(int(a[1]), int(a[2]), a[3], int(a[5]) if len(a) == 6 else None)
    elif a[:1] == ['judge'] and len(a) == 2:
        sys.exit(judge(a[1]))
    elif a[:1] == ['judge'] and len(a) == 6 and a[2] == '--stamps':
        sys.exit(judge(a[1], (a[3], int(a[4]), a[5])))
    elif a[:1] == ['probe-judge'] and len(a) in (4, 7) and (len(a) == 4 or a[4] == '--stamp'):
        sys.exit(probe_judge(a[1], int(a[2]), float(a[3]), (a[5], a[6]) if len(a) == 7 else None))
    elif a[:1] == ['stamp'] and len(a) == 5 and a[2] == 'guard':
        # Only the guard stamps from the shell; the other three checks stamp from inside their own judgement.
        write_stamp(a[1], 'guard', a[3], int(a[4]))
    elif a[:1] == ['stamps-ok'] and len(a) == 5:
        first = first_sample(a[4])
        fault = stamps_fault(a[1], a[2], int(a[3]), first) if first is not None else "the tone's sampler holds no sample yet"
        print(fault or f'every check before the press passed for {a[2]} (node {a[3]}), in order, before the tone\'s first sample')
        sys.exit(1 if fault else 0)
    elif a[:1] == ['closed'] and len(a) == 3:
        rows = [json.loads(line) for line in open(a[1]) if line.strip()]
        last = [r for r in rows if 'into' in r and r['t'] >= float(a[2])]
        sys.exit(0 if last and not last[-1].get('web') else 1)
    elif a[:1] == ['webenv'] and len(a) in (4, 7) and (len(a) == 4 or a[4] == '--stamp'):
        sys.exit(webenv(int(a[1]), a[2], a[3], (a[5], int(a[6])) if len(a) == 7 else None))
    elif a[:1] == ['one-sink'] and len(a) in (4, 6) and (len(a) == 4 or a[4] == '--stamp'):
        # Its refusal is the pass's `die` text, so every one goes to stdout: an empty id went to stderr as a
        # traceback and the pass died on "before the press: " and nothing else (#266's Stage 2 control R2).
        try:
            sink = int(a[2])
        except ValueError:
            print(f'the tone sink\'s id is {json.dumps(a[2])}, not a node id, so nothing shows which node is this run\'s')
            sys.exit(1)
        try:
            sys.exit(one_sink(a[1], sink, a[3], a[5] if len(a) == 6 else None))
        except Exception as e:
            print(f'tone-graph: could not read the graph: {e}')
            sys.exit(1)
    elif a[:1] == ['nodes'] and len(a) in (2, 3):
        family = len(a) == 3 and a[1] == '--family'
        want = a[2] if family else a[1]
        for o in read_graph().values():
            name = props(o).get('node.name')
            if (in_family(name, want) if family else name == want):
                print(o['id'])
    elif a[:1] == ['name-of'] and len(a) == 2:
        print(props(read_graph().get(int(a[1])) or {}).get('node.name') or '')
    elif a[:1] == ['ports'] and len(a) == 2:
        print(sum(1 for o in read_graph().values() if str(o.get('type', '')).endswith('Port')
                  and (o.get('info') or {}).get('direction') == 'input' and props(o).get('node.id') == int(a[1])))
    else:
        sys.exit(__doc__)
