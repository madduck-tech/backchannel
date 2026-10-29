#!/usr/bin/env python3
"""The verdict on scripts/lib/fonts-probe.js's answer, read on stdin. (#264)

Prints `ok: …` when each of the ten faces draws text with exactly that face, loaded, and no face draws any
of the symbols the product owner left to the system; otherwise one sentence naming every face that does
not. stage2-ui-check.sh dies on anything but `ok:`. fonts-verdict.test.mjs holds it to that.
"""
import json
import sys

try:
    d = json.load(sys.stdin)
except ValueError as e:
    print('the font probe answered something that is not JSON: %s' % e)
    raise SystemExit
if 'error' in d:
    print('the font probe failed: ' + str(d['error']))
    raise SystemExit
faces = d.get('faces') or []
if len(faces) != 10:
    print('the font probe reported %d faces, not ten' % len(faces))
    raise SystemExit
bad = []
for f in faces:
    family, weight, style = f['face'].rsplit(' ', 2)
    want = '|'.join([family, weight, style, 'loaded'])
    if f['text'] != [want]:
        bad.append(f['face'] + ' draws text with ' + json.dumps(f['text'], ensure_ascii=False) + ', not [' + want + ']')
    for sym, got in f['symbols'].items():
        if got:
            bad.append(f['face'] + ' would draw ' + sym + ' with ' + json.dumps(got, ensure_ascii=False))
print('; '.join(bad) if bad else 'ok: %d faces loaded from the shipped files, and none draws %s' % (len(faces), ' '.join(faces[0]['symbols'])))
