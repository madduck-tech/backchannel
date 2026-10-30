#!/usr/bin/env python3
"""Whose loss is it: the page's recorder, or the path to the peer (#302 L3).

    attribute.py <side-b-decode.json> <capture-decode.json>

Both are `blocks.py decode` outputs of one run: side B as the page's MediaRecorder kept it, and the
independent AUHAL capture of the device side B played to. A number lost at side B (missing or
duplicated there) and not at the capture was lost by the recorder; one lost at both was lost on
the way to the peer (#291 found the page's recorders lossy while the capture was not). Numbers the
capture lost but side B kept are reported too: the capture's own loss. Prints JSON; always exits 0.
"""
import json
import sys


def lost(d):
    return set(d["missing"]) | set(d["duplicated"])


def main():
    side_b, capture = (json.load(open(p)) for p in sys.argv[1:3])
    b, c = lost(side_b), lost(capture)
    print(json.dumps({
        "recorder": sorted(b - c),
        "peer_path": sorted(b & c),
        "capture_only": sorted(c - b),
        "side_b_track": side_b["track"], "capture_track": capture["track"],
    }))


if __name__ == "__main__":
    main()
