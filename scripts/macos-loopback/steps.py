#!/usr/bin/env python3
"""Steps in a recording's alignment, and the misses they explain (#291).

    steps.py <detection.json> <schedule.json> [--ms 5]

A lossless recording keeps each marker at the same offset from the schedule. A recorder that
loses audio shifts every later marker by what it lost: MediaRecorder lost 37 ms at 1628 s of L1
in both tracks while the independent capture of the same output did not. This lists every change
of offset larger than --ms between consecutive detections (hits and unclaimed detections, matched
to the nearest scheduled marker of their id), and every miss that falls after a step: such a miss
is the recorder's, not the peer's. Prints JSON; always exits 0. It reports, it does not judge.
"""
import argparse
import json


def main():
    p = argparse.ArgumentParser()
    p.add_argument("detection")
    p.add_argument("schedule")
    p.add_argument("--ms", type=float, default=5.0)
    a = p.parse_args()
    det = json.load(open(a.detection))
    sched = json.load(open(a.schedule))
    if det.get("void"):
        print(json.dumps({"void": det["void"]}))
        return
    nominal = {m["n"]: m["onset"] for m in sched["markers"]}
    by_id = {}
    for m in sched["markers"]:
        by_id.setdefault(m["id"], []).append(m["onset"])
    points = [(nominal[h["n"]], h["onset"] - nominal[h["n"]]) for h in det["hits"]]
    for f in det["false_matches"]:
        if f["id"] in by_id:
            o = min(by_id[f["id"]], key=lambda x: abs(x - f["at"]))
            points.append((o, f["at"] - o))
    points.sort()
    steps = [{"at_s": round(b[0], 3), "ms": round(1000 * (b[1] - a_[1]), 2)}
             for a_, b in zip(points, points[1:]) if abs(1000 * (b[1] - a_[1])) > a.ms]
    first = steps[0]["at_s"] if steps else None
    misses_after = [m for m in det["misses"] if first is not None and m["onset"] >= first]
    offsets = [1000 * o for _, o in points]
    print(json.dumps({"steps": steps, "net_ms": round(offsets[-1] - offsets[0], 2) if offsets else None,
                      "misses": len(det["misses"]), "misses_after_first_step": len(misses_after)}))


if __name__ == "__main__":
    main()
