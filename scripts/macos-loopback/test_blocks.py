"""The block decoder's controls, offline (#302 B1-B13).

A scratch git repository holds a copy of blocks.py (with markers.py and level.py it imports), a
threshold tuned on a stream it generated, committed, so the freeze refusals meet real git state.
Each test mutates one stream at 48 kHz (a cut, a repeat, a swap, a forged block, silence) and
asserts what `decode` and `judge` report about that one mutation.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
B48 = 2880                     # one 60 ms block at 48 kHz
N = 400                        # 24 s
LEAD = 48000                   # gen's 1 s of silence before the stream


def run(repo, *args):
    r = subprocess.run([sys.executable, "-I", os.path.join(repo, "blocks.py"), *args], capture_output=True, text=True)
    if r.returncode not in (0, 1, 2):
        raise AssertionError(f"blocks.py {' '.join(args)} crashed: {r.stderr}")
    return r


class Fixture(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.repo = tempfile.mkdtemp(prefix="blocks-test-")
        for f in ("blocks.py", "markers.py", "level.py"):
            shutil.copy(os.path.join(HERE, f), cls.repo)
        for c in (["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "test"]):
            subprocess.run(["git", "-C", cls.repo, *c], check=True)
        sys.path.insert(0, cls.repo)
        import blocks
        import markers
        cls.b, cls.mk = blocks, markers
        run(cls.repo, "gen", os.path.join(cls.repo, "tune"), "--minutes", "0.5", "--seed", "3")
        rng = np.random.default_rng(8)
        t = np.arange(20 * 48000) / 48000
        free = np.concatenate([markers.pink_noise(20 * 48000, rng), np.zeros(20 * 48000), 0.17 * np.sin(2 * np.pi * 1000 * t)])
        os.makedirs(os.path.join(cls.repo, "free"))
        markers.write_wav(os.path.join(cls.repo, "free", "free.wav"), free)
        r = run(cls.repo, "tune", os.path.join(cls.repo, "tune", "blocks.wav"), os.path.join(cls.repo, "tune", "schedule.json"),
                os.path.join(cls.repo, "free", "free.wav"), "--seed", "3")
        assert r.returncode == 0, r.stderr
        cls.tau = json.load(open(os.path.join(cls.repo, "blocks-threshold.json")))["tau"]
        subprocess.run(["git", "-C", cls.repo, "add", "blocks.py", "blocks-threshold.json"], check=True)
        subprocess.run(["git", "-C", cls.repo, "commit", "-qm", "freeze"], check=True)
        cls.src = os.path.join(cls.repo, "src")
        run(cls.repo, "gen", cls.src, "--minutes", str(N * 0.06 / 60), "--seed", "21")
        cls.sched = json.load(open(os.path.join(cls.src, "schedule.json")))
        cls.clean = markers.read_audio(os.path.join(cls.src, "blocks.wav"), 48000)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.repo)

    def decode(self, name, x, *extra, track="test"):
        d = os.path.join(self.repo, name)
        os.makedirs(d, exist_ok=True)
        self.mk.write_wav(os.path.join(d, "x.wav"), x)
        r = run(self.repo, "decode", os.path.join(d, "x.wav"), os.path.join(self.src, "schedule.json"), "--track", track, *extra)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def at(self, k):
        return LEAD + k * B48     # gen puts 1 s of silence before the stream

    def block(self, n_rel, direction=0, forge=None):
        w = self.b.word(direction, self.sched["first"] + n_rel) if forge is None else forge
        return self.b.synth(self.b.symbols_of(w))[0]


class TheDecoderReportsEachMutation(Fixture):

    def test_b12_a_clean_stream_counts_every_block_from_zero(self):
        d = self.decode("b12", self.clean)
        self.assertEqual((d["counted"], d["window"], d["missing"], d["tail_loss"], d["steps"]), (N, [0, N - 1], [], 0, []))

    def test_b1a_a_removed_block_is_missing_and_the_rest_counted(self):
        x = np.concatenate([self.clean[:self.at(100)], self.clean[self.at(101):]])
        d = self.decode("b1a", x)
        self.assertEqual(d["missing"], [100])
        self.assertEqual(d["counted"], N - 1)  # B1a': every later block counted
        self.assertEqual(len(d["steps"]), 1)                    # expected, not a failure
        self.assertStep(d, -B48)

    def cut(self, name, start, n):
        x = np.concatenate([self.clean[:start], self.clean[start + n:]])
        return self.decode(name, x)

    def assertStep(self, d, samples):
        self.assertTrue(any(abs(s["samples_48k"] - samples) <= 3 * self.tau for s in d["steps"]), (samples, d["steps"]))

    def test_b1b_480_samples_cut_mid_block_is_a_step_and_the_rest_counted(self):
        d = self.cut("b1b", self.at(100) + 1000, 480)
        self.assertStep(d, -480)
        self.assertGreaterEqual(d["counted"], N - 1)            # B1b': only the damaged block may go
        self.assertEqual(d["unexpected"], [])

    def test_b1c_128_samples_cut_mid_block_is_a_step(self):
        self.assertStep(self.cut("b1c", self.at(100) + 1000, 128), -128)

    def test_b1d_1776_samples_cut_is_a_step_and_the_covered_numbers_are_not_others(self):
        d = self.cut("b1d", self.at(100) + 1000, 1776)
        self.assertStep(d, -1776)
        self.assertEqual((d["unexpected"], d["duplicated"], d["out_of_order"]), ([], [], []))  # B1d'
        self.assertTrue(set(d["missing"]) <= {100, 101}, d["missing"])

    def test_b2_a_repeated_block_is_duplicated(self):
        x = np.concatenate([self.clean[:self.at(101)], self.clean[self.at(100):self.at(101)], self.clean[self.at(101):]])
        self.assertEqual(self.decode("b2", x)["duplicated"], [100])

    def test_b3_two_swapped_blocks_are_out_of_order(self):
        a, b_ = self.clean[self.at(100):self.at(101)], self.clean[self.at(101):self.at(102)]
        x = np.concatenate([self.clean[:self.at(100)], b_, a, self.clean[self.at(102):]])
        d = self.decode("b3", x)
        self.assertEqual(d["out_of_order"], [100])
        self.assertEqual(d["missing"], [])

    def test_b4_a_block_with_10_ms_zeroed_is_never_another_number(self):
        x = self.clean.copy()
        x[self.at(100) + 600:self.at(100) + 1080] = 0
        d = self.decode("b4", x)
        self.assertEqual((d["unexpected"], d["duplicated"], d["out_of_order"], d["wrong_direction"]), ([], [], [], []))
        self.assertTrue(d["missing"] in ([], [100]), d["missing"])

    def test_b5_a_flipped_payload_bit_with_the_original_check_is_never_another_number(self):
        w = self.b.word(0, self.sched["first"] + 100) ^ (1 << 30)
        x = self.clean.copy()
        x[self.at(100):self.at(101)] = self.block(100, forge=w)
        d = self.decode("b5", x)
        # The issue: undecodable, or corrected to its own number; never another number.
        self.assertEqual((d["unexpected"], d["duplicated"], d["out_of_order"]), ([], [], []))
        if d["missing"]:
            self.assertEqual((d["missing"], len(d["undecodable"])), ([100], 1))
        else:
            self.assertGreaterEqual(d["corrected"], 1)
            self.assertIn(100, {n for n, _ in d["positions"]})

    def test_a_symbol_whose_true_tone_is_second_is_corrected_to_its_own_number(self):
        # Symbol 5 of block 100: a wrong tone at 0.6 over the true tone at 0.45, as a codec error
        # leaves it; the plain decision fails the check, the second choice restores it.
        syms = self.b.symbols_of(self.b.word(0, self.sched["first"] + 100))
        n = 48000 * self.b.SYM // self.b.RATE
        true_wave = self.b.synth([syms[5]])[0]
        wrong_wave = self.b.synth([(syms[5] + 7) % 16])[0]
        x = self.clean.copy()
        s0 = self.at(100) + 5 * n
        x[s0:s0 + n] = 0.6 * wrong_wave + 0.45 * true_wave
        d = self.decode("chase", x)
        self.assertEqual((d["missing"], d["undecodable"], d["unexpected"]), ([], [], []))
        self.assertEqual(d["corrected"], 1)

    def test_two_adjacent_symbols_broken_together_are_corrected(self):
        # As C1 at 433e3f2: symbols 5 and 6 both turned into one wrong tone, the true tones weak.
        syms = self.b.symbols_of(self.b.word(0, self.sched["first"] + 100))
        n = 48000 * self.b.SYM // self.b.RATE
        wrong = (syms[5] + 9) % 16
        if wrong == syms[6]:
            wrong = (wrong + 1) % 16
        x = self.clean.copy()
        for k in (5, 6):
            s0 = self.at(100) + k * n
            x[s0:s0 + n] = 0.7 * self.b.synth([wrong])[0] + 0.2 * self.b.synth([syms[k]])[0]
        d = self.decode("burst", x)
        self.assertEqual((d["missing"], d["undecodable"], d["unexpected"]), ([], [], []))
        self.assertEqual(d["corrected"], 1)

    def test_audio_before_the_stream_is_outside_the_window(self):
        # A preamble that is signal but not blocks (as #291's markers before L1's stream): its
        # failed positions are reported apart, not as undecodable blocks of the stream.
        rng = np.random.default_rng(4)
        pre = np.concatenate([self.mk.pink_noise(5 * 48000, rng), np.zeros(48000)])
        d = self.decode("preamble", np.concatenate([pre, self.clean]))
        self.assertEqual((d["undecodable"], d["missing"], d["counted"]), ([], [], N))
        self.assertGreater(d["undecodable_outside"], 0)

    def test_b6a_the_wrong_direction_is_reported(self):
        d = self.decode("b6a", self.clean, "--direction", "1")
        self.assertEqual(len(d["wrong_direction"]), N)

    def test_b6b_the_track_label_is_in_the_report(self):
        d = self.decode("b6b", self.clean, track="OTHERS")
        r = run(self.repo, "judge", os.path.join(self.repo, "b6b", "d.json")) if False else None
        self.assertEqual(d["track"], "OTHERS")

    def test_b7_a_valid_block_for_a_far_number_is_unexpected(self):
        x = self.clean.copy()
        x[self.at(100):self.at(101)] = self.block(5100)
        d = self.decode("b7", x)
        self.assertEqual([u["n"] for u in d["unexpected"]], [5100])
        self.assertEqual(d["missing"], [100])

    def test_b8_two_seconds_of_silence_are_no_signal_and_missing_without_a_step(self):
        x = self.clean.copy()
        x[self.at(100):self.at(133)] = 0
        d = self.decode("b8", x)
        self.assertGreaterEqual(len(d["no_signal"]), 30)                                  # B8a
        counted = {n for n, _ in d["positions"]}
        self.assertFalse(counted & set(range(100, 133)))                                 # B8b
        self.assertEqual(d["missing"], list(range(100, 133)))                            # B8b'
        self.assertEqual(d["steps"], [])                                                 # B8c

    def test_b9_a_cut_tail_is_tail_loss(self):
        d = self.decode("b9", self.clean[:self.at(N - 100)])
        self.assertEqual(d["tail_loss"], 100)
        self.assertEqual(d["missing"], [])

    def test_b11_ten_removed_blocks_are_missing_and_re_anchored(self):
        x = np.concatenate([self.clean[:self.at(100)], self.clean[self.at(110):]])
        d = self.decode("b11", x)
        self.assertEqual(d["missing"], list(range(100, 110)))                            # B11a
        self.assertStep(d, -10 * B48)                                                    # B11b
        self.assertEqual(d["counted"], N - 10)                                           # B11c
        self.assertEqual(d["unexpected"], [])

    def test_b13_a_cut_of_2_tau_where_the_blocks_still_decode_is_a_step(self):
        n48 = 2 * self.tau * 3
        d = self.cut("b13", self.at(200), n48)                  # at a block boundary: nothing damaged
        self.assertEqual(d["missing"], [])
        self.assertStep(d, -n48)


class TheThresholdIsFrozen(Fixture):

    def test_b10a_judging_with_the_tuning_seed_is_refused(self):
        r = run(self.repo, "gen", os.path.join(self.repo, "j1"), "--minutes", "0.1", "--seed", "3", "--judge")
        self.assertEqual(r.returncode, 1)
        self.assertIn("tuning seed", r.stderr)

    def test_b10b_decode_refuses_a_threshold_changed_after_generation(self):
        out = os.path.join(self.repo, "j2")
        r = run(self.repo, "gen", out, "--minutes", "0.1", "--seed", "4", "--judge")
        self.assertEqual(r.returncode, 0, r.stderr)
        path = os.path.join(self.repo, "blocks-threshold.json")
        with open(path) as f:
            original = f.read()
        try:
            data = json.loads(original)
            data["floor"] *= 0.5
            with open(path, "w") as f:
                json.dump(data, f)
            d = run(self.repo, "decode", os.path.join(out, "blocks.wav"), os.path.join(out, "schedule.json"))
            self.assertEqual(d.returncode, 1)
            self.assertIn("another threshold", d.stderr)
        finally:
            with open(path, "w") as f:
                f.write(original)


class TheCheck(unittest.TestCase):

    def test_no_all_zero_word_is_a_codeword_and_a_flipped_bit_fails(self):
        sys.path.insert(0, HERE)
        import blocks
        self.assertIsNone(blocks.parse([0] * 12))
        w = blocks.word(0, 12345)
        self.assertEqual(blocks.parse(blocks.symbols_of(w)), (0, 12345))
        self.assertIsNone(blocks.parse(blocks.symbols_of(w ^ (1 << 40))))


if __name__ == "__main__":
    unittest.main()
