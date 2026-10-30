"""L3a, L3b: a loss is attributed to the recorder or to the peer path (#302), and L4a, L4b: the
block stream's acoustic validity (`blocks.py level`).

Streams are generated and mutated here and decoded by `blocks.py` with a threshold tuned in a
scratch copy, as in test_blocks.py, so the attribution and level checks read real decodes.
"""
import json
import os
import subprocess
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_blocks import Fixture, run  # noqa: E402

B48 = 2880


class TheAttribution(Fixture):

    def attribute(self, side_b, capture):
        paths = []
        for name, x in (("side_b", side_b), ("capture", capture)):
            d = self.decode(f"attr-{name}-{id(x)}", x, track=name)
            p = os.path.join(self.repo, f"attr-{name}-{id(x)}.json")
            with open(p, "w") as f:
                json.dump(d, f)
            paths.append(p)
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "attribute.py"), *paths], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def without(self, k):
        return np.concatenate([self.clean[:self.at(k)], self.clean[self.at(k + 1):]])

    def test_l3a_a_loss_at_side_b_only_is_the_recorders(self):
        rep = self.attribute(self.without(150), self.clean)
        self.assertEqual((rep["recorder"], rep["peer_path"]), ([150], []))

    def test_l3b_the_same_loss_at_both_is_the_peer_paths(self):
        rep = self.attribute(self.without(150), self.without(150))
        self.assertEqual((rep["recorder"], rep["peer_path"]), ([], [150]))


class TheBlockLevel(Fixture):

    def level(self, name, floor_db, gain_db, lead_s=14.0):
        rng = np.random.default_rng(2)
        x = np.concatenate([np.zeros(int(lead_s * 48000)), self.clean * 10 ** (gain_db / 20)])
        x = x + rng.standard_normal(x.size) * 10 ** (floor_db / 20) * 1.6
        d = self.decode(f"lvl-{name}", x)
        p = os.path.join(self.repo, f"lvl-{name}.json")
        with open(p, "w") as f:
            json.dump(d, f)
        r = run(self.repo, "level", os.path.join(self.repo, f"lvl-{name}", "x.wav"), p)
        return r.returncode, json.loads(r.stdout)

    def test_blocks_well_over_a_live_floor_are_valid(self):
        code, rep = self.level("ok", -65, -3)
        self.assertEqual(code, 0, rep)

    def test_l4a_a_floor_outside_the_range_is_void(self):
        code, rep = self.level("dead", -100, -3)
        self.assertEqual(code, 2, rep)
        self.assertTrue(any(r.startswith("floor") for r in rep["reasons"]), rep)

    def test_l4b_blocks_under_floor_plus_15_db_are_void(self):
        code, rep = self.level("quiet", -50, -40)
        self.assertEqual(code, 2, rep)
        self.assertTrue(any("not delivered acoustically" in r for r in rep["reasons"]), rep)


if __name__ == "__main__":
    unittest.main()
