"""The census comparator (#316 S3c, S3d, S10a), on censuses built here.

A hand-built census (BASE) is edited the way an install, a removal or a damaged sentinel would leave
it, so each test asserts what the comparator names about one difference; the parsers of `take`
are tested on recorded command output.
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

    def test_apple_launchd_services_coming_and_going_are_not_differences(self):
        after = copy.deepcopy(BASE)
        after["launchd_services"] = ["com.apple.AMPLibraryAgent"]   # com.apple.foo went, another came
        self.assertEqual(census.compare(BASE, after), ([], []))

    def test_a_non_apple_launchd_service_left_behind_is_named(self):
        after = copy.deepcopy(BASE)
        after["launchd_services"] = BASE["launchd_services"] + ["tech.madduck.backchannel.helper"]
        _, unexpected = census.compare(BASE, after)
        self.assertEqual(unexpected, [("launchd_services added", "tech.madduck.backchannel.helper")])

    def test_signatures_are_read_with_their_cdhash(self):
        self.assertIn('"codesign", "-dvvv"', open(census.__file__).read())

    def test_a_codesign_report_is_read_with_its_cdhash(self):
        report = ("Executable=/x\nIdentifier=tech.madduck.backchannel.spike.driver\nFormat=bundle\n"
                  "CodeDirectory v=20400 size=1790 flags=0x2(adhoc) hashes=49+3 location=embedded\n"
                  "CDHash=b8e3b936272471901c2d9cf68117328d0d6bbda2\nSignature=adhoc\nTeamIdentifier=not set\n")
        sig = census.parse_signature(report)
        self.assertEqual((sig["CDHash"], sig["Signature"], sig["flags"]), ("b8e3b936272471901c2d9cf68117328d0d6bbda2", "adhoc", "adhoc"))

    def test_a_rebuilt_bundle_is_a_signature_change(self):
        before, after = copy.deepcopy(BASE), copy.deepcopy(BASE)
        before["hal_plugins"]["BlackHole2ch.driver"]["CDHash"] = "aaaa"
        after["hal_plugins"]["BlackHole2ch.driver"]["CDHash"] = "bbbb"
        self.assertEqual(census.compare(before, after)[1], [("plugin signature changed", "BlackHole2ch.driver")])

    def test_a_census_without_cdhash_against_one_with_it_is_no_change(self):
        after = copy.deepcopy(BASE)
        after["hal_plugins"]["BlackHole2ch.driver"]["CDHash"] = "bbbb"
        self.assertEqual(census.compare(BASE, after), ([], []))

    def test_a_sentinel_that_becomes_unsigned_is_a_signature_change(self):
        # Only a missing CDHash is excused; every other one-sided key is a change (gate round 2 on #316).
        before, after = copy.deepcopy(BASE), copy.deepcopy(BASE)
        before["hal_plugins"]["BlackHole2ch.driver"]["CDHash"] = "aaaa"
        after["hal_plugins"]["BlackHole2ch.driver"] = {"unsigned_or_unreadable": "code object is not signed at all"}
        self.assertEqual(census.compare(before, after)[1], [("plugin signature changed", "BlackHole2ch.driver")])

    def test_a_visible_bridge_is_unexpected_even_when_backchannel_is_expected(self):
        after = installed()
        after["backchannel_uids"]["tech.madduck.backchannel.bridge-in"]["hidden"] = False
        _, unexpected = census.compare(BASE, after, EXPECT)
        self.assertEqual(unexpected, [("bridge visible", "tech.madduck.backchannel.bridge-in")])

    def test_the_visible_bridge_build_on_record_is_caught(self):
        run = os.path.join(census.REPO, "experiments", "hal-runs", "20261101-090423-install")
        if not os.path.exists(os.path.join(run, "after.json")):
            self.skipTest("the S2c run is on the development Mac only")
        with open(os.path.join(run, "before.json")) as f, open(os.path.join(run, "after.json")) as g:
            _, unexpected = census.compare(json.load(f), json.load(g), EXPECT)
        self.assertIn(("bridge visible", "tech.madduck.backchannel.bridge-out"), unexpected)

    def test_launchctl_services_are_parsed(self):
        out = ("gui/501 = {\n\tservices = {\n\t\t     612      0 \tcom.apple.Finder\n"
               "\t\t       -      0 \ttech.madduck.backchannel.helper\n\t}\n}\n")
        self.assertEqual(census.parse_launchctl(out), ["com.apple.Finder", "tech.madduck.backchannel.helper"])

    def test_residue_is_allowed_only_for_the_exact_uid(self):
        removed = copy.deepcopy(BASE)
        removed["device_settings_keys"] += ["tech.madduck.backchannel.microphone-other"]
        _, unexpected = census.compare(BASE, removed, [], census.BACKCHANNEL_UIDS)
        self.assertEqual(unexpected, [("device_settings_keys added", "tech.madduck.backchannel.microphone-other")])

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
