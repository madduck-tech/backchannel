"""The census comparator (#316 S3c, S3d, S10a), on censuses built here.

A real census is taken once and then edited the way an install, a removal or a damaged sentinel
would leave it, so each test asserts what the comparator names about one difference.
"""
import copy
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import census  # noqa: E402

BASE = {
    "hal_plugins": {"BlackHole2ch.driver": {"Identifier": "audio.existential.BlackHole2ch", "TeamIdentifier": "Q5C99V536K"},
                    "SteamStreamingSpeakers.driver": {"Identifier": "com.valvesoftware.audio", "TeamIdentifier": "MXGJJ98X76"}},
    "devices": [{"uid": "BlackHole2ch_UID", "name": "BlackHole 2ch", "in": 2, "out": 2}],
    "backchannel_uids": {u: None for u in census.BACKCHANNEL_UIDS},
    "defaults": {"input": "BuiltInMicrophoneDevice", "output": "BuiltInSpeakerDevice", "system_output": "BuiltInSpeakerDevice"},
    "device_settings_keys": ["BlackHole2ch_UID"],
    "launchd_services": ["com.apple.foo"],
    "launch_agents": [],
    "helper": None,
    "driver_hosts": ["Core Audio Driver (BlackHole2ch.driver)"],
    "identities": [],
    "tcc": "not observable",
}


def installed():
    c = copy.deepcopy(BASE)
    c["hal_plugins"]["BackchannelSpike.driver"] = {"Identifier": "BackchannelSpike", "Signature": "adhoc"}
    c["devices"] += [{"uid": "tech.madduck.backchannel.microphone", "name": "Backchannel Microphone", "in": 1, "out": 0},
                     {"uid": "tech.madduck.backchannel.speakers", "name": "Backchannel Speakers", "in": 0, "out": 2}]
    c["backchannel_uids"] = {u: {"id": 1, "hidden": "bridge" in u} for u in census.BACKCHANNEL_UIDS}
    c["driver_hosts"].append("Core Audio Driver (BackchannelSpike.driver)")
    c["device_settings_keys"] += ["tech.madduck.backchannel.microphone", "tech.madduck.backchannel.speakers"]
    return c


EXPECT = ["Backchannel", "tech.madduck.backchannel"]


class TheComparator(unittest.TestCase):

    def test_an_unchanged_machine_has_no_difference(self):
        self.assertEqual(census.compare(BASE, copy.deepcopy(BASE)), ([], []))

    def test_s3b_an_install_adds_only_what_is_expected(self):
        diffs, unexpected = census.compare(BASE, installed(), EXPECT)
        self.assertTrue(diffs)
        self.assertEqual(unexpected, [])

    def test_s3c_a_changed_sentinel_signature_is_named(self):
        after = installed()
        after["hal_plugins"]["SteamStreamingSpeakers.driver"]["TeamIdentifier"] = "XXXXXXXXXX"
        _, unexpected = census.compare(BASE, after, EXPECT)
        self.assertEqual(unexpected, [("plugin signature changed", "SteamStreamingSpeakers.driver")])

    def test_a_removed_sentinel_is_named(self):
        after = installed()
        del after["hal_plugins"]["BlackHole2ch.driver"]
        _, unexpected = census.compare(BASE, after, EXPECT)
        self.assertIn(("plugin removed", "BlackHole2ch.driver"), unexpected)

    def test_changed_defaults_are_named(self):
        after = installed()
        after["defaults"]["input"] = "tech.madduck.backchannel.microphone"
        _, unexpected = census.compare(BASE, after, EXPECT)
        self.assertEqual([k for k, _ in unexpected], ["defaults changed"])

    def test_s3d_a_backchannel_device_left_after_removal_is_named(self):
        removed = copy.deepcopy(BASE)
        removed["devices"].append({"uid": "tech.madduck.backchannel.speakers", "name": "Backchannel Speakers", "in": 0, "out": 2})
        _, unexpected = census.compare(BASE, removed, [], census.BACKCHANNEL_UIDS)
        self.assertEqual(unexpected, [("device added", "tech.madduck.backchannel.speakers")])

    def test_s10a_device_settings_residue_is_allowed_only_for_backchannel_uids(self):
        removed = copy.deepcopy(BASE)
        removed["device_settings_keys"] += ["tech.madduck.backchannel.microphone", "SomeoneElse_UID"]
        _, unexpected = census.compare(BASE, removed, [], census.BACKCHANNEL_UIDS)
        self.assertEqual(unexpected, [("device_settings_keys added", "SomeoneElse_UID")])

    def test_an_unreadable_field_is_a_difference(self):
        after = copy.deepcopy(BASE)
        after["device_settings_keys"] = "unreadable: permission denied"
        _, unexpected = census.compare(BASE, after)
        self.assertEqual([k for k, _ in unexpected], ["device_settings_keys unreadable"])

    def test_a_census_names_tcc_as_not_observable(self):
        self.assertIn("not observable", BASE["tcc"])
        self.assertIn('"tcc": "not observable', open(census.__file__).read().replace("'", '"'))


if __name__ == "__main__":
    unittest.main()
