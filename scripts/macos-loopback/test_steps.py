"""steps.py: a recorder's loss shows as a step, and a miss after it is the recorder's (#291).

The detections are built by hand: a lossless track keeps one offset, and a track that lost 37 ms
(as MediaRecorder did at 1628 s of L1) shifts every later marker by that much.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def run(detection, schedule):
    d = tempfile.mkdtemp(prefix="steps-test-")
    for name, obj in (("det.json", detection), ("sched.json", schedule)):
        with open(os.path.join(d, name), "w") as f:
            json.dump(obj, f)
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "steps.py"),
                        os.path.join(d, "det.json"), os.path.join(d, "sched.json")], capture_output=True, text=True)
    return json.loads(r.stdout)


SCHED = {"markers": [{"n": i, "id": str(i % 8), "onset": 10.0 + 6 * i} for i in range(10)]}


def hits(shift_from=None, shift=0.0, miss=()):
    out = []
    for m in SCHED["markers"]:
        if m["n"] in miss:
            continue
        lost = shift if shift_from is not None and m["n"] >= shift_from else 0.0
        out.append({"n": m["n"], "id": m["id"], "onset": m["onset"] + 0.002 - lost})
    return out


class TheStepsReport(unittest.TestCase):

    def test_a_lossless_track_has_no_step(self):
        rep = run({"hits": hits(), "misses": [], "false_matches": []}, SCHED)
        self.assertEqual((rep["steps"], rep["net_ms"]), ([], 0.0))

    def test_a_37_ms_loss_is_one_step_where_it_happened(self):
        rep = run({"hits": hits(5, 0.037), "misses": [], "false_matches": []}, SCHED)
        self.assertEqual(rep["steps"], [{"at_s": 40.0, "ms": -37.0}])

    def test_a_miss_after_the_step_is_counted_as_the_recorders(self):
        missing = [{"n": 7, "id": "7", "onset": 52.0}]
        rep = run({"hits": hits(5, 0.037, miss=(7,)), "misses": missing, "false_matches": []}, SCHED)
        self.assertEqual((rep["misses"], rep["misses_after_first_step"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
