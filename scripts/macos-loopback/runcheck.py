#!/usr/bin/env python3
"""Whether a loopback run measured what it was asked to (#291): label matching and the void rules.

    runcheck.py resolve <devices.json> <audioinput|audiooutput> <label>   prints the deviceId, or
                                                                          the void reason and exits 2
    runcheck.py void <record.json>                                        prints the reasons; exit 0
                                                                          when there are none, 2 when
                                                                          the run is void

The page and the launcher call exactly these functions, and the unit tests feed them fabricated
records (V4, V6, V7), so a rule shown firing in a test is the rule that decides a live run.

A void run is rerun; it is never read as a pass or as a red. Its reasons say which applied value
differed from the request.
"""
import json
import re
import sys

# Entries Chrome adds for the OS defaults. Never matched: requesting one is a void (P5), because
# what it resolves to is whatever the OS default is at that moment.
DEFAULT_IDS = ("default", "communications")
# Suffixes Chrome 156 appends to a device label on macOS, as reported on this Mac on 2026-10-29
# (devices.json of the first live run): the transport, or a USB device's vendor:product.
SUFFIX = re.compile(r" \((?:Bluetooth|Built-in|Virtual|HDMI|DisplayPort|USB|[0-9a-f]{4}:[0-9a-f]{4})\)$")
PINNED_KBPS = 32.0
BITRATE_TOLERANCE = 0.20


class Void(Exception):
    pass


def strip_suffix(label):
    return SUFFIX.sub("", label)


def resolve(devices, kind, requested):
    """The deviceId of the one device of `kind` whose label is `requested`."""
    of_kind = [d for d in devices if d.get("kind") == kind]
    if not any(d.get("label") for d in of_kind):
        raise Void("labels unreadable")
    for d in of_kind:
        if d.get("deviceId") in DEFAULT_IDS and requested in (d.get("label"), strip_suffix(d.get("label", ""))):
            raise Void(f"'{requested}' is the {d['deviceId']} entry")
    matches = [d for d in of_kind if d.get("deviceId") not in DEFAULT_IDS
               and requested in (d.get("label"), strip_suffix(d.get("label", "")))]
    if not matches:
        raise Void(f"no {kind} labelled '{requested}'")
    if len(matches) > 1:
        raise Void(f"ambiguous label '{requested}': {len(matches)} {kind} devices match")
    return matches[0]["deviceId"]


def bitrate_kbps(samples, window):
    """Outbound bitrate over `window` (seconds) from cumulative `bytesSent` samples."""
    inside = [s for s in samples if window[0] <= s["t"] <= window[1]]
    if len(inside) < 2:
        return None
    first, last = inside[0], inside[-1]
    if last["t"] <= first["t"]:
        return None
    return 8 * (last["bytesSent"] - first["bytesSent"]) / (last["t"] - first["t"]) / 1000


def void_reasons(r):
    """Every reason the run is void; empty when it measured what it was asked to."""
    if r.get("void_before_capture"):
        # The label match refused before any input was opened (P4, P5): nothing else ran, so the
        # rest of the record is empty, and listing those empties would bury the one reason.
        return [f"before capture: {r['void_before_capture']}"]
    reasons = []
    req, app = r["requested"], r.get("applied") or {}
    inp = app.get("input") or {}
    for key in ("input", "output"):
        if req.get(f"{key}_device_id") is None:
            reasons.append(f"{key} not resolved")
    if inp.get("deviceId") != req.get("input_device_id"):
        reasons.append(f"input applied {inp.get('deviceId')!r}, requested {req.get('input_device_id')!r}")
    if app.get("sinkId") != req.get("output_device_id"):
        reasons.append(f"sink applied {app.get('sinkId')!r}, requested {req.get('output_device_id')!r}")
    for flag in ("echoCancellation", "noiseSuppression", "autoGainControl"):
        if inp.get(flag) is not False:
            reasons.append(f"{flag} is {inp.get(flag)!r}, not false")
    if inp.get("sampleRate") != req.get("sample_rate"):
        reasons.append(f"sample rate applied {inp.get('sampleRate')}, requested {req.get('sample_rate')}")
    if app.get("contextState") != "running":
        reasons.append(f"AudioContext {app.get('contextState')!r}, not running")
    ice = r.get("ice") or {}
    if ice.get("connectionState") != "connected":
        reasons.append(f"connection {ice.get('connectionState')!r}, not connected")
    pair = ice.get("selectedPair") or {}
    local = set(r.get("interfaces") or [])
    for end in ("local", "remote"):
        addr = (pair.get(end) or {}).get("address")
        if addr not in local:
            reasons.append(f"candidate pair {end} address {addr!r} is not one of this Mac's interfaces")
    stats = r.get("stats") or {}
    codec = (stats.get("codec") or {}).get("mimeType", "")
    if codec.lower() != "audio/opus":
        reasons.append(f"codec {codec!r}, not audio/opus")
    window = r.get("noise_window")
    kbps = bitrate_kbps(stats.get("bytes") or [], window) if window else None
    if kbps is None:
        reasons.append("bitrate not measurable over the noise window")
    elif abs(kbps - PINNED_KBPS) > BITRATE_TOLERANCE * PINNED_KBPS:
        reasons.append(f"bitrate {kbps:.1f} kbit/s over the noise window, pinned {PINNED_KBPS:.0f} ±{BITRATE_TOLERANCE:.0%}")
    if r.get("power_events"):
        reasons.append(f"the Mac slept during the run: {r['power_events'][0]}")
    if "capture" in r and (r["capture"] or {}).get("frames") == 0:
        reasons.append("independent capture recorded nothing (0 frames)")
    if "capture" in r and (r["capture"] or {}).get("gaps") != 0:
        reasons.append(f"independent capture not continuous: {r['capture']}")
    return reasons


def main():
    if len(sys.argv) == 5 and sys.argv[1] == "resolve":
        with open(sys.argv[2]) as f:
            devices = json.load(f)
        try:
            print(resolve(devices, sys.argv[3], sys.argv[4]))
        except Void as v:
            print(f"void: {v}")
            sys.exit(2)
    elif len(sys.argv) == 3 and sys.argv[1] == "void":
        with open(sys.argv[2]) as f:
            reasons = void_reasons(json.load(f))
        print(json.dumps({"void": bool(reasons), "reasons": reasons}))
        sys.exit(2 if reasons else 0)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(64)


if __name__ == "__main__":
    main()
