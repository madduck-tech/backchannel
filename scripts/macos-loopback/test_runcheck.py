"""The void rules and the label match, fed fabricated records (#291 V4, V6, V7, and P4/P5 by unit).

The record is the shape the page writes. The live run calls the same `resolve` and `void_reasons`,
so each rule shown firing here is the one that decides a live run. V1-V3 and V5 are also shown
firing live, by the page's test parameters and an unseeded profile.
"""
import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runcheck  # noqa: E402

DEVICES = [
    {"kind": "audioinput", "deviceId": "default", "label": "Default - soundcore Space One (Bluetooth)"},
    {"kind": "audioinput", "deviceId": "bh2", "label": "BlackHole 2ch (Virtual)"},
    {"kind": "audioinput", "deviceId": "sc", "label": "soundcore Space One (Bluetooth)"},
    {"kind": "audiooutput", "deviceId": "default", "label": "Default - soundcore Space One (Bluetooth)"},
    {"kind": "audiooutput", "deviceId": "bh16", "label": "BlackHole 16ch (Virtual)"},
    {"kind": "audiooutput", "deviceId": "sc-out", "label": "soundcore Space One (Bluetooth)"},
]

GOOD = {
    "requested": {"input_device_id": "bh2", "output_device_id": "bh16", "sample_rate": 48000},
    "applied": {"input": {"deviceId": "bh2", "sampleRate": 48000, "echoCancellation": False,
                          "noiseSuppression": False, "autoGainControl": False},
                "sinkId": "bh16", "contextState": "running"},
    "ice": {"connectionState": "connected",
            "selectedPair": {"local": {"address": "192.168.88.17"}, "remote": {"address": "192.168.88.17"}}},
    "interfaces": ["127.0.0.1", "192.168.88.17", "10.0.0.2"],
    "stats": {"codec": {"mimeType": "audio/opus", "clockRate": 48000},
              "bytes": [{"t": 10.0, "bytesSent": 100000}, {"t": 40.0, "bytesSent": 100000 + 4000 * 30}]},
    "noise_window": [10.0, 40.0],
}


def with_(path, value):
    r = copy.deepcopy(GOOD)
    node = r
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return r


class TheLabelMatch(unittest.TestCase):

    def test_a_label_resolves_with_or_without_chromes_suffix(self):
        self.assertEqual(runcheck.resolve(DEVICES, "audioinput", "BlackHole 2ch"), "bh2")
        self.assertEqual(runcheck.resolve(DEVICES, "audioinput", "BlackHole 2ch (Virtual)"), "bh2")
        self.assertEqual(runcheck.resolve(DEVICES, "audiooutput", "soundcore Space One"), "sc-out")

    def test_the_suffixes_chrome_reported_on_this_mac_are_stripped(self):
        seen = [{"kind": "audioinput", "deviceId": "dock", "label": "DL-Dock (17e9:6000)"},
                {"kind": "audiooutput", "deviceId": "lg", "label": "LG ULTRAFINE (HDMI)"},
                {"kind": "audioinput", "deviceId": "mic", "label": "Микрофон MacBook Pro (Built-in)"}]
        self.assertEqual(runcheck.resolve(seen, "audioinput", "DL-Dock"), "dock")
        self.assertEqual(runcheck.resolve(seen, "audiooutput", "LG ULTRAFINE"), "lg")
        self.assertEqual(runcheck.resolve(seen, "audioinput", "Микрофон MacBook Pro"), "mic")

    def test_p5_the_localised_default_entry_is_void(self):
        ru = [{"kind": "audioinput", "deviceId": "default", "label": "По умолчанию - soundcore Space One (Bluetooth)"},
              {"kind": "audioinput", "deviceId": "sc", "label": "soundcore Space One (Bluetooth)"}]
        with self.assertRaisesRegex(runcheck.Void, "default entry"):
            runcheck.resolve(ru, "audioinput", "По умолчанию - soundcore Space One")

    def test_p4_a_label_that_does_not_exist_is_void(self):
        with self.assertRaisesRegex(runcheck.Void, "no audioinput labelled 'No Such Device'"):
            runcheck.resolve(DEVICES, "audioinput", "No Such Device")

    def test_p5_the_default_entry_is_void_not_resolved(self):
        with self.assertRaisesRegex(runcheck.Void, "default entry"):
            runcheck.resolve(DEVICES, "audioinput", "Default - soundcore Space One (Bluetooth)")

    def test_v6_two_devices_matching_one_label_is_void(self):
        twice = DEVICES + [{"kind": "audioinput", "deviceId": "bh2b", "label": "BlackHole 2ch"}]
        with self.assertRaisesRegex(runcheck.Void, "ambiguous label"):
            runcheck.resolve(twice, "audioinput", "BlackHole 2ch")

    def test_v5_labels_unreadable_is_void(self):
        blank = [dict(d, label="") for d in DEVICES]
        with self.assertRaisesRegex(runcheck.Void, "labels unreadable"):
            runcheck.resolve(blank, "audioinput", "BlackHole 2ch")


class TheVoidRules(unittest.TestCase):

    def test_a_run_that_measured_what_it_was_asked_is_not_void(self):
        self.assertEqual(runcheck.void_reasons(GOOD), [])

    def test_v1_processing_on_is_void(self):
        reasons = runcheck.void_reasons(with_(["applied", "input", "echoCancellation"], True))
        self.assertEqual(reasons, ["echoCancellation is True, not false"])

    def test_v2_a_suspended_context_is_void(self):
        reasons = runcheck.void_reasons(with_(["applied", "contextState"], "suspended"))
        self.assertEqual(reasons, ["AudioContext 'suspended', not running"])

    def test_v3_another_sample_rate_is_void(self):
        reasons = runcheck.void_reasons(with_(["applied", "input", "sampleRate"], 44100))
        self.assertEqual(reasons, ["sample rate applied 44100, requested 48000"])

    def test_v4_a_non_local_candidate_pair_is_void(self):
        reasons = runcheck.void_reasons(with_(["ice", "selectedPair", "remote", "address"], "203.0.113.5"))
        self.assertEqual(reasons, ["candidate pair remote address '203.0.113.5' is not one of this Mac's interfaces"])

    def test_v7_a_codec_other_than_opus_is_void(self):
        reasons = runcheck.void_reasons(with_(["stats", "codec", "mimeType"], "audio/PCMU"))
        self.assertEqual(reasons, ["codec 'audio/PCMU', not audio/opus"])

    def test_v7_a_bitrate_of_64_kbits_is_void(self):
        r = with_(["stats", "bytes"], [{"t": 10.0, "bytesSent": 0}, {"t": 40.0, "bytesSent": 8000 * 30}])
        self.assertEqual(runcheck.void_reasons(r), ["bitrate 64.0 kbit/s over the noise window, pinned 32 ±20%"])

    def test_a_sink_other_than_requested_is_void(self):
        reasons = runcheck.void_reasons(with_(["applied", "sinkId"], "steam"))
        self.assertEqual(reasons, ["sink applied 'steam', requested 'bh16'"])

    def test_an_independent_capture_with_a_gap_is_void(self):
        r = with_(["capture"], {"frames": 100, "gaps": 1, "gap_frames": 512})
        self.assertEqual(runcheck.void_reasons(r), ["independent capture not continuous: {'frames': 100, 'gaps': 1, 'gap_frames': 512}"])
        self.assertEqual(runcheck.void_reasons(with_(["capture"], {"frames": 100, "gaps": 0, "gap_frames": 0})), [])

    def test_a_label_refused_before_capture_is_the_one_reason(self):
        r = {"requested": {"input_device_id": None, "output_device_id": None}, "applied": {},
             "void_before_capture": "no audioinput labelled 'No Such Device'"}
        self.assertEqual(runcheck.void_reasons(r), ["before capture: no audioinput labelled 'No Such Device'"])

    def test_a_connection_that_never_connected_is_void(self):
        reasons = runcheck.void_reasons(with_(["ice", "connectionState"], "failed"))
        self.assertEqual(reasons, ["connection 'failed', not connected"])


if __name__ == "__main__":
    unittest.main()
