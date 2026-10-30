"""L2's validity sentinels: the floor and the markers' level over it (#291 L2d, L2f, L2g, L2h).

Each recording is built here from a generated marker WAV and seeded noise at a stated level, run
through `markers.py detect`, and judged by `level.py`, so each case exercises the commands an
acoustic run uses.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import markers  # noqa: E402


def db(x):
    return 10 ** (x / 20)


class TheLevelSentinels(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="level-test-")
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "markers.py"), "gen", cls.tmp,
                            "--minutes", "1", "--seed", "44", "--spacing", "4"], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        with open(os.path.join(cls.tmp, "schedule.json")) as f:
            cls.sched = json.load(f)
        cls.clean = markers.read_audio(os.path.join(cls.tmp, "markers.wav"), markers.PLAY_RATE)

    def judge(self, name, floor_db, marker_gain_db, lead_s=14.0):
        rng = np.random.default_rng(1)
        x = self.clean * db(marker_gain_db)
        x = np.concatenate([np.zeros(int(lead_s * markers.PLAY_RATE)), x])
        x = x + rng.standard_normal(x.size) * db(floor_db) * 1.6  # white; about 4 dB lands in the band
        path = os.path.join(self.tmp, f"{name}.wav")
        markers.write_wav(path, x)
        sched = dict(self.sched, sync=self.sched["sync"] + lead_s,
                     markers=[dict(m, onset=m["onset"] + lead_s) for m in self.sched["markers"]])
        spath = os.path.join(self.tmp, f"{name}.schedule.json")
        with open(spath, "w") as f:
            json.dump(sched, f)
        d = subprocess.run([sys.executable, "-I", os.path.join(HERE, "markers.py"), "detect", path, spath],
                           capture_output=True, text=True)
        dpath = os.path.join(self.tmp, f"{name}.det.json")
        with open(dpath, "w") as f:
            f.write(d.stdout)
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "level.py"), path, dpath, spath],
                           capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout)

    def test_markers_well_over_a_live_floor_are_valid(self):
        code, rep = self.judge("ok", -65, -20)
        self.assertEqual(code, 0, rep)
        self.assertGreaterEqual(rep["snr_db"], 15)

    def test_l2g_markers_under_floor_plus_15_db_are_void(self):
        code, rep = self.judge("quiet", -55, -48)
        self.assertEqual(code, 2, rep)
        self.assertTrue(any("not delivered acoustically" in r for r in rep.get("reasons", [rep.get("reason", "")])), rep)

    def test_l2d_a_floor_below_minus_85_is_a_microphone_not_live(self):
        code, rep = self.judge("dead", -100, -20)
        self.assertEqual(code, 2, rep)
        self.assertTrue(any(r.startswith("floor") for r in rep["reasons"]), rep)

    def test_l2d_a_floor_above_minus_45_is_a_noisy_room(self):
        code, rep = self.judge("noisy", -40, 0)
        self.assertEqual(code, 2, rep)
        self.assertTrue(any(r.startswith("floor") for r in rep["reasons"]), rep)


if __name__ == "__main__":
    unittest.main()
