"""The detector's controls, offline (#291 D1-D5, T1c, and Stage 0's mixed cells).

Each test drives the real command line on a recording it generated, in a scratch git repository
holding a copy of markers.py, so the threshold freeze is exercised against real `git` state and
nothing here writes the committed threshold. A test mutates the audio, the truth table or the
repository, and asserts what `detect` and `judge` report about that one mutation.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "markers.py")


def run(repo, *args, check=True):
    r = subprocess.run([sys.executable, "-I", os.path.join(repo, "markers.py"), *args],
                       capture_output=True, text=True)
    if check and r.returncode not in (0, 1, 2):
        raise AssertionError(f"markers.py {' '.join(args)} crashed: {r.stderr}")
    return r


def read(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.int32)


def write(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(np.clip(x, -32768, 32767).astype("<i2").tobytes())


class Fixture(unittest.TestCase):
    """One scratch repository with a tuned, committed threshold, shared by the tests."""

    @classmethod
    def setUpClass(cls):
        cls.repo = tempfile.mkdtemp(prefix="markers-test-")
        shutil.copy(SOURCE, cls.repo)
        for c in (["init", "-q"], ["config", "user.email", "t@example.invalid"],
                  ["config", "user.name", "test"]):
            subprocess.run(["git", "-C", cls.repo, *c], check=True)
        cls.tune_dir = os.path.join(cls.repo, "tune")
        run(cls.repo, "gen", cls.tune_dir, "--minutes", "1.5", "--seed", "3", "--jitter-ms", "80")
        # Marker-free material made here, not by `free`: that one speaks through `say`, which only
        # macOS has, and these tests also run in the Linux CI job.
        sys.path.insert(0, cls.repo)
        import markers
        rng = np.random.default_rng(8)
        t = np.arange(30 * 48000) / 48000
        free = np.concatenate([markers.pink_noise(30 * 48000, rng), np.zeros(30 * 48000),
                               0.17 * np.sin(2 * np.pi * 1000 * t)])
        os.makedirs(os.path.join(cls.repo, "free"))
        markers.write_wav(os.path.join(cls.repo, "free", "free.wav"), free)
        r = run(cls.repo, "tune", os.path.join(cls.tune_dir, "markers.wav"),
                os.path.join(cls.tune_dir, "schedule.json"),
                os.path.join(cls.repo, "free", "free.wav"), "--seed", "3")
        assert r.returncode == 0, r.stderr
        subprocess.run(["git", "-C", cls.repo, "add", "markers.py", "threshold.json"], check=True)
        subprocess.run(["git", "-C", cls.repo, "commit", "-qm", "freeze"], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.repo)

    def fresh(self, name, *extra):
        out = os.path.join(self.repo, name)
        r = run(self.repo, "gen", out, "--minutes", "1", "--seed", "21", "--jitter-ms", "40", *extra)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(out, "truth.json")) as f:
            return out, json.load(f)

    def detect_and_judge(self, out, wav="markers.wav", truth="truth.json", *flags):
        d = run(self.repo, "detect", os.path.join(out, wav), os.path.join(out, "schedule.json"))
        self.assertEqual(d.returncode, 0, d.stderr)
        det = os.path.join(out, "detection.json")
        with open(det, "w") as f:
            f.write(d.stdout)
        j = run(self.repo, "judge", det, os.path.join(out, truth), *flags)
        return j.returncode, json.loads(j.stdout)


class TheDetectorReportsEachMutation(Fixture):

    def test_an_unmutated_recording_is_all_hits(self):
        out, truth = self.fresh("clean")
        code, rep = self.detect_and_judge(out, "markers.wav", "truth.json",
                                          "--zero-misses", "--zero-false", "--per-marker")
        self.assertEqual(code, 0, rep)
        self.assertEqual(rep["hits"], len(truth["markers"]))

    def test_d1_a_removed_marker_is_a_miss_naming_its_id(self):
        out, truth = self.fresh("d1")
        x = read(os.path.join(out, "markers.wav"))
        m = truth["markers"][4]
        i0 = int(round(m["onset"] * 48000))
        x[i0:i0 + int(0.2 * 48000)] = 0
        write(os.path.join(out, "markers.wav"), x)
        code, rep = self.detect_and_judge(out, "markers.wav", "truth.json", "--zero-misses")
        self.assertEqual(code, 1)
        self.assertEqual([(e["n"], e["id"]) for e in rep["misses"]], [(m["n"], m["id"])])

    def test_d2_an_unscheduled_marker_is_a_false_match_naming_its_id_and_time(self):
        out, truth = self.fresh("d2")
        x = read(os.path.join(out, "markers.wav")).astype(np.float64)
        sys.path.insert(0, self.repo)
        import markers
        at = truth["markers"][3]["onset"] + 3.0  # between two scheduled markers, 6 s apart
        w = np.round(markers.waveform("6", 48000) * 32767)
        i0 = int(round(at * 48000))
        x[i0:i0 + w.size] += w
        write(os.path.join(out, "markers.wav"), x)
        code, rep = self.detect_and_judge(out, "markers.wav", "truth.json", "--zero-false")
        self.assertEqual(code, 1)
        self.assertEqual(len(rep["false_matches"]), 1, rep["false_matches"])
        self.assertEqual(rep["false_matches"][0]["id"], "6")
        self.assertAlmostEqual(rep["false_matches"][0]["at"], at, delta=0.005)

    def test_d3_a_truth_table_off_by_20_ms_fails_that_marker(self):
        out, truth = self.fresh("d3")
        truth["markers"][5]["onset"] += 0.020
        with open(os.path.join(out, "truth-off.json"), "w") as f:
            json.dump(truth, f)
        code, rep = self.detect_and_judge(out, "markers.wav", "truth-off.json", "--per-marker")
        self.assertEqual(code, 1)
        self.assertEqual([e["n"] for e in rep["late"]], [5])
        self.assertGreater(abs(rep["late"][0]["error_ms"]), 5)
        # The per-marker rule, not the p95: with nine markers one late marker also moves the p95.
        self.assertTrue(any(f.startswith("1 markers with error beyond") and "n=5 " in f for f in rep["failed"]), rep["failed"])

    def test_d4_two_swapped_ids_are_two_misses_and_two_false_matches(self):
        out, truth = self.fresh("d4")
        sys.path.insert(0, self.repo)
        import markers
        x = read(os.path.join(out, "markers.wav")).astype(np.float64)
        a, b = truth["markers"][2], truth["markers"][3]
        self.assertNotEqual(a["id"], b["id"])
        for m, other in ((a, b), (b, a)):
            i0 = int(round(m["onset"] * 48000))
            w_own = np.round(markers.waveform(m["id"], 48000) * 32767)
            w_other = np.round(markers.waveform(other["id"], 48000) * 32767)
            x[i0:i0 + w_own.size] += w_other - w_own
        write(os.path.join(out, "markers.wav"), x)
        code, rep = self.detect_and_judge(out, "markers.wav", "truth.json", "--zero-misses", "--zero-false")
        self.assertEqual(code, 1)
        self.assertEqual(sorted(e["n"] for e in rep["misses"]), sorted([a["n"], b["n"]]))
        self.assertEqual(sorted(f["id"] for f in rep["false_matches"]), sorted([a["id"], b["id"]]))

    def test_d5_no_sync_at_an_unknown_offset_is_void_not_misses(self):
        out, truth = self.fresh("d5")
        x = read(os.path.join(out, "markers.wav"))
        s0 = int(truth["sync"] * 48000)
        x[s0:s0 + int(0.5 * 48000)] = 0
        lead = np.zeros(int(np.random.default_rng(5).uniform(0, 10) * 48000), dtype=np.int32)
        write(os.path.join(out, "markers.wav"), np.concatenate([lead, x]))
        code, rep = self.detect_and_judge(out, "markers.wav", "truth.json", "--zero-misses")
        self.assertEqual(code, 2)
        self.assertEqual(rep, {"void": "no sync"})

    def test_a_hit_beside_a_false_match_of_the_same_id_is_both(self):
        out, truth = self.fresh("adjacent")
        sys.path.insert(0, self.repo)
        import markers
        m = truth["markers"][6]
        x = read(os.path.join(out, "markers.wav")).astype(np.float64)
        w = np.round(markers.waveform(m["id"], 48000) * 32767)
        i0 = int(round((m["onset"] + 0.300) * 48000))  # just outside the +/-100 ms slot
        x[i0:i0 + w.size] += w
        write(os.path.join(out, "markers.wav"), x)
        code, rep = self.detect_and_judge(out, "markers.wav", "truth.json", "--zero-misses", "--zero-false")
        self.assertEqual(code, 1)
        self.assertEqual(rep["misses"], [])
        self.assertEqual([f["id"] for f in rep["false_matches"]], [m["id"]])

    def test_pair_offsets_are_measured_against_the_truth(self):
        out, truth = self.fresh("pairs", "--pairs")
        code, rep = self.detect_and_judge(out, "markers.wav", "truth.json", "--pairs", "--zero-misses")
        self.assertEqual(code, 0, rep)
        self.assertEqual(rep["pairs_n"], len(truth["pairs"]))
        self.assertLess(rep["pair_p95_ms"], 5)


class TheThresholdIsFrozen(Fixture):

    def test_t1c_judging_with_the_tuning_seed_is_refused(self):
        r = run(self.repo, "gen", os.path.join(self.repo, "j1"), "--minutes", "0.5", "--seed", "3", "--judge")
        self.assertEqual(r.returncode, 1)
        self.assertIn("tuning seed", r.stderr)

    def test_t1c_a_judge_schedule_carries_the_commit_and_hash(self):
        r = run(self.repo, "gen", os.path.join(self.repo, "j2"), "--minutes", "0.5", "--seed", "4", "--judge")
        self.assertEqual(r.returncode, 0, r.stderr)
        header = json.loads(r.stdout)["header"]
        head = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.assertEqual((header["judge"], header["commit"]), (True, head))
        self.assertEqual(len(header["hash"]), 64)

    def test_t1c_detect_refuses_when_the_threshold_changed_after_generation(self):
        out = os.path.join(self.repo, "j3")
        r = run(self.repo, "gen", out, "--minutes", "0.5", "--seed", "5", "--judge")
        self.assertEqual(r.returncode, 0, r.stderr)
        path = os.path.join(self.repo, "threshold.json")
        with open(path) as f:
            original = f.read()
        try:
            data = json.loads(original)
            data["value"] *= 0.9
            with open(path, "w") as f:
                json.dump(data, f)
            d = run(self.repo, "detect", os.path.join(out, "markers.wav"), os.path.join(out, "schedule.json"))
            self.assertEqual(d.returncode, 1)
            self.assertIn("another threshold", d.stderr)
        finally:
            with open(path, "w") as f:
                f.write(original)

    def test_t1c_judging_with_a_dirty_threshold_is_refused(self):
        path = os.path.join(self.repo, "threshold.json")
        with open(path) as f:
            original = f.read()
        try:
            with open(path, "a") as f:
                f.write("\n")
            r = run(self.repo, "gen", os.path.join(self.repo, "j4"), "--minutes", "0.5", "--seed", "6", "--judge")
            self.assertEqual(r.returncode, 1)
            self.assertIn("uncommitted", r.stderr)
        finally:
            with open(path, "w") as f:
                f.write(original)


class WithoutAThreshold(unittest.TestCase):

    def test_judging_with_no_threshold_file_is_refused(self):
        repo = tempfile.mkdtemp(prefix="markers-none-")
        try:
            shutil.copy(SOURCE, repo)
            r = run(repo, "gen", os.path.join(repo, "x"), "--minutes", "0.5", "--seed", "1", "--judge")
            self.assertEqual(r.returncode, 1)
            self.assertIn("run `tune` first", r.stderr)
        finally:
            shutil.rmtree(repo)


if __name__ == "__main__":
    unittest.main()
