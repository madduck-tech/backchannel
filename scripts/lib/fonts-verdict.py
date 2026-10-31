#!/usr/bin/env python3
"""The verdict on scripts/lib/fonts-probe.js's answer, read on stdin. (#264)

    fonts-verdict.py PROBE.js < answer.json

Prints `ok: …` when the answer covers each of the ten faces the probe declares, once and in order, each
asked about every symbol the probe declares; when each face's text would be drawn with exactly that
face, loaded; and when no face would draw a symbol. Otherwise one sentence naming every face that does
not. The faces and symbols are read from the probe's own FACES and SYMBOLS: fonts-verdict.test.mjs
holds FACES to fonts.css and SYMBOLS to the four the product owner left to the system. So an edit to the
probe's loops cannot drop a face or a symbol from the answer unnoticed. It cannot tell whether the
probe asked WebKit at all: an answer filled in without `document.fonts.load` reads as a pass.
stage2-ui-check.sh dies on anything but `ok:`.
"""
import json
import re
import sys

probe = open(sys.argv[1], encoding='utf-8').read()
FACES = [' '.join(m) for m in re.findall(r"\['(IBM Plex \w+)', '(\d+)', '(\w+)'\]", probe)]
m = re.search(r"const SYMBOLS = \[([^\]]*)\];", probe)
SYMBOLS = re.findall(r"'([^']+)'", m.group(1)) if m else []
if len(FACES) != 10 or not SYMBOLS:
    print('fonts-probe.js declares %d faces and %d symbols, not ten faces and at least one symbol' % (len(FACES), len(SYMBOLS)))
    raise SystemExit

try:
    d = json.load(sys.stdin)
except ValueError as e:
    print('the font probe answered something that is not JSON: %s' % e)
    raise SystemExit
if not isinstance(d, dict):
    print('the font probe answered JSON that is not an object: %s' % json.dumps(d, ensure_ascii=False)[:200])
    raise SystemExit
if 'error' in d:
    print('the font probe failed: ' + str(d['error']))
    raise SystemExit
faces = d.get('faces')
if not isinstance(faces, list) or not all(isinstance(f, dict) and isinstance(f.get('face'), str) for f in faces):
    print('the font probe answered no list of faces: %s' % json.dumps(d, ensure_ascii=False)[:200])
    raise SystemExit
names = [f['face'] for f in faces]
if names != FACES:
    print('the font probe reported the faces %s, not the ten fonts-probe.js declares' % json.dumps(names, ensure_ascii=False))
    raise SystemExit
bad = []
for f in faces:
    family, weight, style = f['face'].rsplit(' ', 2)
    want = '|'.join([family, weight, style, 'loaded'])
    if f.get('text') != [want]:
        bad.append(f['face'] + ' would draw text with ' + json.dumps(f.get('text'), ensure_ascii=False) + ', not [' + want + ']')
    symbols = f.get('symbols')
    if not isinstance(symbols, dict) or sorted(symbols) != sorted(SYMBOLS):
        bad.append(f['face'] + ' was asked about ' + json.dumps(sorted(symbols) if isinstance(symbols, dict) else symbols, ensure_ascii=False) + ', not ' + ' '.join(SYMBOLS))
        continue
    for sym in SYMBOLS:
        if symbols[sym]:
            bad.append(f['face'] + ' would draw ' + sym + ' with ' + json.dumps(symbols[sym], ensure_ascii=False))
print('; '.join(bad) if bad else 'ok: %d faces loaded, each at its own weight and style, and none draws %s' % (len(FACES), ' '.join(SYMBOLS)))
