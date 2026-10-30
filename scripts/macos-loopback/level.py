#!/usr/bin/env python3
"""Whether an acoustic run's markers reached the microphone, and over what floor (#291 L2d-L2h).

    level.py <recording> <detection.json> <schedule.json>

The detection places the WAV on the recording's clock by its sync (`markers.py detect`). Then,
in the 300-3400 Hz band the markers occupy:
  - floor:   RMS over the 10 s that end 2 s before the sync, while only the room was playing;
  - markers: RMS over every scheduled marker's 200 ms, aligned.
Exits 0 when the floor lies within [-85, -45] dBFS and the markers are at least 15 dB above it,
2 (void) otherwise, with the reason. A floor above -45 is a noisy room, one below -85 a microphone
that is not live (#273 measured -91 dB with the lid closed), and markers under floor + 15 dB were
not delivered acoustically; none of these says anything about the detector.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import markers  # noqa: E402

FLOOR_RANGE = (-85.0, -45.0)
MARGIN_DB = 15.0


def band(x, rate, taps=255):
    """300-3400 Hz by a windowed-sinc FIR, so a loud passage rings for 8 ms either side and no
    further. The first version zeroed bins of one FFT over the whole recording: its ringing spread
    the stream into the silence before it and measured a -100 dBFS floor as -58.8 (#302)."""
    n = np.arange(taps) - (taps - 1) / 2
    lo, hi = markers.BAND[0] / rate, markers.BAND[1] / rate
    h = (2 * hi * np.sinc(2 * hi * n) - 2 * lo * np.sinc(2 * lo * n)) * np.hamming(taps)
    return np.convolve(x, h, mode="same")


def dbfs(x):
    return 20 * np.log10(max(np.sqrt(np.mean(x ** 2)), 1e-12))


def main():
    recording, detection, schedule = sys.argv[1:4]
    det = json.load(open(detection))
    sched = json.load(open(schedule))
    if det.get("void"):
        print(json.dumps({"void": True, "reason": f"markers not delivered acoustically: {det['void']}"}))
        sys.exit(2)
    rate = markers.DETECT_RATE
    x = band(markers.read_audio(recording, rate), rate)
    sync = det["sync_at"]
    f0, f1 = int((sync - 12.0) * rate), int((sync - 2.0) * rate)
    if f0 < 0:
        print(json.dumps({"void": True, "reason": f"less than 12 s before the sync ({sync:.1f} s)"}))
        sys.exit(2)
    floor = dbfs(x[f0:f1])
    slots = []
    for m in sched["markers"]:
        i0 = int(round((m["onset"] + det["offset"]) * rate))
        slots.append(x[i0:i0 + int(markers.MARKER_S * rate)])
    level = dbfs(np.concatenate(slots))
    reasons = []
    if not FLOOR_RANGE[0] <= floor <= FLOOR_RANGE[1]:
        reasons.append(f"floor {floor:.1f} dBFS outside {FLOOR_RANGE}")
    if level < floor + MARGIN_DB:
        reasons.append(f"markers not delivered acoustically: {level:.1f} dBFS, floor {floor:.1f} + {MARGIN_DB:.0f}")
    print(json.dumps({"void": bool(reasons), "floor_dbfs": round(floor, 1), "marker_dbfs": round(level, 1),
                      "snr_db": round(level - floor, 1), "markers": len(slots), "reasons": reasons}))
    sys.exit(2 if reasons else 0)


if __name__ == "__main__":
    main()
