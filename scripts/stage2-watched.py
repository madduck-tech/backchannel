#!/usr/bin/env python3
"""Run gopnik.json's stage 2 with every entry that brings the harness up beside a silent recorder. (#293)

    scripts/stage2-watched.py <outdir> [--only N,N,...] [--plan]

The entries that bring the audio harness up run under `scripts/stage2-capture-watch.sh`, and each is then
judged by `scripts/lib/capture-graph.py check` (#293 item 2): `onboarding resumes`, every core pass, and the
record pass. Entries are found by what they run, not by number, so a renumbering cannot point the watch at
the wrong entry. Every other entry runs as the gate runs it.

- **The record pass is two entries,** the harness's `up` and the pass. They run in one shell, the first
  unchanged, the second unchanged under `trap '<its own tail, from APID= to down>' EXIT`, so a TERM from
  the watch still stops its application and runs `down`; the trap ignores INT and TERM, so a second
  signal does not cut that `down` short. Its application leads a group of its own, found
  by the pid file the pass writes.
- **The system device each check allows:** the harness sink and the tone sink in the core passes, the
  default sink of each sample in the record pass, none in `resumes`. The core and record passes record,
  so their checks also require the harness and a system device linked at once.
- **In a worktree** `.git` is a file, and gopnik.json's `.git/backchannel-*` roots (#257) are rewritten to
  `"$(git rev-parse --git-dir)"/backchannel-*`, and the log says so.

An entry's exit is its command's; a watched entry also fails when its check does. `--plan` prints what
would run, and how, and runs nothing.
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CORE = ['--system', 'backchannel_harness_sink', '--system', 'backchannel_tone_sink*', '--recording']
RECORD = ['--system-default-sink', '--recording']
RECORD_PIDS = '/tmp/backchannel-stage2-audio.*/pid'
OLD, NEW = '.git/backchannel-', '"$(git rev-parse --git-dir)"/backchannel-'


def plan(cmds):
    """[(label, command, check args or None, pid glob or None)], in gate order."""
    up = [i for i, c in enumerate(cmds) if 'harness_guard_after_up' in c and 'up --system-only' in c]
    rec = [i for i, c in enumerate(cmds) if 'stage2-record-check.sh' in c]
    if len(up) != 1 or len(rec) != 1 or rec[0] != up[0] + 1:
        sys.exit(f'stage2-watched: wanted one harness up entry directly before one record entry, found up {up} and record {rec}')
    e28, e29 = cmds[up[0]], cmds[rec[0]]
    tail = e29[e29.index('APID='):e29.rindex('; exit $RC')]
    if "'" in tail or not tail.endswith('scripts/audio-harness.sh down'):
        sys.exit(f'stage2-watched: the record entry no longer ends in the tail this joins under a trap: {tail!r}')
    out = []
    for i, c in enumerate(cmds):
        n = i + 1
        if i == up[0]:
            continue
        if i == rec[0]:
            out.append((f'{n - 1:02d}-{n:02d}', f"{e28}\ntrap 'trap \"\" INT TERM; {tail}' EXIT\n{e29}", RECORD, RECORD_PIDS))
        elif re.search(r'stage2-onboarding-check\.sh "\$APP" resumes$', c):
            out.append((f'{n:02d}', c, [], None))
        elif re.search(r'stage2-core-check\.sh "\$APP" \w+$', c):
            out.append((f'{n:02d}', c, CORE, None))
        else:
            out.append((f'{n:02d}', c, None, None))
    return out


def main(argv):
    outdir = argv[0]
    only = None
    if '--only' in argv:
        only = {int(x) for x in argv[argv.index('--only') + 1].split(',')}
    cmds = json.load(open(os.path.join(ROOT, 'gopnik.json')))['verification']['stage2']
    steps = plan(cmds)
    worktree = os.path.isfile(os.path.join(ROOT, '.git'))
    if '--plan' in argv:
        for label, c, check, glob in steps:
            how = 'plain' if check is None else f"watched, check {' '.join(check) or '(no system device)'}" + (f', pids {glob}' if glob else '')
            print(f'{label}\t{how}\t{c.splitlines()[0][:100]}')
        return 0
    os.makedirs(outdir, exist_ok=True)
    summary = open(os.path.join(outdir, 'summary.txt'), 'a')
    failed = 0
    for label, c, check, glob in steps:
        if only and not only & {int(x) for x in label.split('-')}:
            continue
        run_c = c.replace(OLD, NEW) if worktree else c
        t = time.time()
        with open(os.path.join(outdir, f'{label}.log'), 'w') as log:
            log.write(f'$ {c}\n')
            if run_c != c:
                log.write(f'# run as (worktree root, {c.count(OLD)} substitution(s)):\n$ {run_c}\n')
            log.flush()
            verdict = ''
            if check is None:
                rc = subprocess.call(['bash', '-c', run_c], stdout=log, stderr=subprocess.STDOUT, cwd=ROOT)
            else:
                wd = os.path.join(outdir, f'watch-{label}')
                argv_w = [os.path.join(HERE, 'stage2-capture-watch.sh'), wd] + (['--app-pgid-glob', glob] if glob else []) + ['--', run_c]
                rc = subprocess.call(argv_w, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT)
                ck = subprocess.run(['python3', '-I', os.path.join(HERE, 'lib', 'capture-graph.py'), 'check', os.path.join(wd, 'graph.jsonl')] + check,
                                    capture_output=True, text=True)
                open(os.path.join(wd, 'check.txt'), 'w').write(ck.stdout + ck.stderr)
                verdict = f" check={'HELD' if ck.returncode == 0 else 'BROKEN'}"
                rc = rc or ck.returncode
        failed += rc != 0
        line = f'stage2 #{label} exit={rc}{verdict} {int(time.time() - t)}s{" [wt-root]" if run_c != c else ""}  {c.splitlines()[0][:110]}'
        print(line, flush=True)
        summary.write(line + '\n')
        summary.flush()
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
