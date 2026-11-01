"""What the sudo scripts may touch (#316): only Backchannel plug-ins and agents, and TCC only by id.

They run with an administrator's password on the product owner's machine, so a mistake is
machine-wide. These tests read and run them without sudo: the refusal must come before any sudo.
"""
import os
import re
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def text(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


class TheScripts(unittest.TestCase):

    def test_install_refuses_a_bundle_that_is_not_backchannels_before_any_sudo(self):
        # A fake sudo first on PATH records any call and fails, so even with the guard broken the
        # test can never copy into /Library or restart coreaudiod.
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "BlackHole2ch.driver"))
        fake = os.path.join(d, "bin")
        os.makedirs(fake)
        marker = os.path.join(d, "sudo-called")
        with open(os.path.join(fake, "sudo"), "w") as f:
            f.write(f"#!/bin/sh\necho \"$@\" >> {marker}\nexit 1\n")
        os.chmod(os.path.join(fake, "sudo"), 0o755)
        r = subprocess.run(["bash", os.path.join(HERE, "install.sh"), os.path.join(d, "BlackHole2ch.driver")],
                           capture_output=True, text=True, env={**os.environ, "PATH": f"{fake}:/usr/bin:/bin"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("refusing to install BlackHole2ch.driver", r.stderr)
        self.assertFalse(os.path.exists(marker), "sudo was called")

    def fake(self, commands):
        """A temporary directory with every outside command faked to record its arguments in
        `calls`, a run directory for BC_HAL_RUNS and a HOME, so nothing reaches /Library, the real
        LaunchAgents or experiments/hal-runs."""
        d = tempfile.mkdtemp()
        fake = os.path.join(d, "bin")
        os.makedirs(fake)
        calls = os.path.join(d, "calls")
        open(calls, "w").close()
        base = {"sudo": "", "codesign": "", "log": "", "launchctl": "", "tccutil": "", "python3": 'echo "{}"'}
        base.update(commands)
        for name, body in base.items():
            with open(os.path.join(fake, name), "w") as f:
                f.write(f'#!/bin/sh\necho "{name} $*" >> {calls}\n{body}\nexit ${{RC:-0}}\n'
                        if name != "tccutil" else f'#!/bin/sh\necho "{name} $*" >> {calls}\n{body}\n')
            os.chmod(os.path.join(fake, name), 0o755)
        os.makedirs(os.path.join(d, "runs"))
        os.makedirs(os.path.join(d, "home", "Library", "LaunchAgents"))
        env = {**os.environ, "PATH": f"{fake}:/usr/bin:/bin", "BC_HAL_RUNS": os.path.join(d, "runs"),
               "HOME": os.path.join(d, "home")}
        return d, calls, env

    def calls(self, path):
        with open(path) as f:
            return f.read().splitlines()

    def test_install_copies_the_bundle_itself_even_with_a_trailing_slash(self):
        d, calls, env = self.fake({})
        bundle = os.path.join(d, "BackchannelSpike.driver")
        os.makedirs(os.path.join(bundle, "Contents"))
        r = subprocess.run(["bash", os.path.join(HERE, "install.sh"), bundle + "/"], capture_output=True, text=True, env=env)
        lines = self.calls(calls)
        cp = [l for l in lines if l.startswith("sudo cp")]
        self.assertEqual(len(cp), 1, (lines, r.stderr))
        self.assertTrue(cp[0].endswith(f"{bundle} /Library/Audio/Plug-Ins/HAL/BackchannelSpike.driver"), cp[0])

    def test_install_passes_the_helper_to_both_censuses_and_writes_its_run_where_told(self):
        d, calls, env = self.fake({})
        bundle = os.path.join(d, "BackchannelSpike.driver")
        os.makedirs(os.path.join(bundle, "Contents"))
        r = subprocess.run(["bash", os.path.join(HERE, "install.sh"), bundle], capture_output=True, text=True,
                           env={**env, "BC_HELPER": "/x/bchelper"})
        self.assertEqual(r.returncode, 0, r.stderr)
        takes = [l for l in self.calls(calls) if l.startswith("python3") and " take" in l]
        self.assertEqual(len(takes), 2, takes)
        self.assertTrue(all(l.endswith("take --helper /x/bchelper") for l in takes), takes)
        self.assertEqual(len(os.listdir(os.path.join(d, "runs"))), 1)

    def test_remove_restarts_coreaudiod_when_tcc_reset_fails_and_passes_the_helper(self):
        d, calls, env = self.fake({"tccutil": "exit 1"})
        before = os.path.join(d, "before.json")
        with open(before, "w") as f:
            f.write("{}")
        r = subprocess.run(["bash", os.path.join(HERE, "remove.sh"), before], capture_output=True, text=True,
                           env={**env, "BC_HELPER_BUNDLE_ID": "tech.madduck.backchannel.helper", "BC_HELPER": "/x/bchelper"})
        lines = self.calls(calls)
        self.assertIn("tccutil reset Microphone tech.madduck.backchannel.helper", lines, r.stderr)
        self.assertIn("sudo killall coreaudiod", lines, (lines, r.stderr))
        takes = [l for l in lines if l.startswith("python3") and " take" in l]
        self.assertEqual(len(takes), 1, takes)
        self.assertTrue(takes[0].endswith("take --helper /x/bchelper"), takes)
        self.assertEqual(len(os.listdir(os.path.join(d, "runs"))), 1)

    def test_every_removal_globs_only_backchannel(self):
        for name in ("remove.sh", "recover.sh"):
            for line in text(name).splitlines():
                if "rm -rf" in line and "HAL" in line:
                    self.assertRegex(line, r"HAL/Backchannel\*\.driver", (name, line))
                if "bundles=(" in line:
                    self.assertIn("Backchannel*.driver", line, (name, line))

    def test_tcc_is_reset_only_by_bundle_id(self):
        for name in ("install.sh", "remove.sh", "recover.sh"):
            for line in text(name).splitlines():
                if line.lstrip().startswith("#"):
                    continue
                if "tccutil" in line:
                    self.assertRegex(line, r'tccutil reset Microphone "\$BC_HELPER_BUNDLE_ID"', (name, line))

    def test_agents_are_removed_only_by_the_backchannel_prefix(self):
        for name in ("remove.sh", "recover.sh"):
            for line in text(name).splitlines():
                if "LaunchAgents/" in line and "for plist" in line:
                    self.assertIn("LaunchAgents/tech.madduck.backchannel.", line, (name, line))


if __name__ == "__main__":
    unittest.main()
