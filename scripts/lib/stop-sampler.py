#!/usr/bin/env python3
"""The stop, as the window shows it (#328 item 6).

From the press until the saved meeting's page commits, or a limit, the page is sampled every 50 ms through
WebDriver's `execute/sync`. Each sample holds the pathname, whether a Start control is drawn, and the text beside the
transport's spinner. One JSON object is printed. The exit status:

    0  the oracle holds: a stage message was seen in the spinner, and no Start was drawn before the navigation;
    1  it fails: no stage message in the spinner, or a Start drawn before the navigation;
    2  the samples cannot show it: no navigation within the limit, or no sample showed the spinner at all, which is
       the positive sentinel the absence of Start needs.

    stop-sampler.py <session base URL> <limit seconds> <stage message>...

A stage message matches a spinner text that starts with it, since the backend's 500 ms message carries a count.
"""
import json
import sys
import time
import urllib.request

PROBE = (
    "var b=[...document.querySelectorAll('button')];"
    "var sp=document.querySelector('div > svg.animate-spin + span');"
    "return JSON.stringify({p: location.pathname,"
    " s: b.some(function(x){return (x.textContent||'').trim()==='Start recording'}),"
    " t: sp ? sp.textContent : null});"
)


def sample(base):
    body = json.dumps({'script': PROBE, 'args': []}).encode()
    req = urllib.request.Request(f'{base}/execute/sync', data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        value = json.load(r).get('value')
    return json.loads(value) if isinstance(value, str) else None


def main(argv):
    base, limit, stages = argv[0], float(argv[1]), argv[2:]
    samples, nav = [], None
    end = time.monotonic() + limit
    while time.monotonic() < end:
        t0 = time.monotonic()
        try:
            s = sample(base)
        except Exception as e:  # a sample that fails is recorded, not skipped
            s = {'error': str(e)[:120]}
        samples.append(s)
        if s and str(s.get('p', '')).startswith('/meeting-details'):
            nav = len(samples) - 1
            break
        time.sleep(max(0.0, 0.05 - (time.monotonic() - t0)))
    before = samples if nav is None else samples[:nav]
    texts = [s['t'] for s in before if s and s.get('t')]
    seen = sorted({t for t in texts if any(t.startswith(m) for m in stages)})
    start_before = [i for i, s in enumerate(before) if s and s.get('s')]
    report = {
        'samples': len(samples),
        'navigation_at_sample': nav,
        'spinner_samples': len(texts),
        'stage_messages_seen': seen,
        'start_drawn_at_samples': start_before[:5],
        'errors': sum(1 for s in samples if s and 'error' in s),
    }
    print(json.dumps(report))
    if nav is None or not texts:
        return 2
    return 0 if seen and not start_before else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
