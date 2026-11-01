#!/usr/bin/env python3
"""The machine-wide audio state an install or removal can change, and a comparator (#316, A1/A11).

    census.py take [--helper PATH] > census.json
    census.py compare <before.json> <after.json> [--expect-added NAME_OR_UID ...]
                                                 [--allow-residue-uid UID ...]
        prints every difference; exit 0 when the only differences are the expected additions and
        the allowed residue, 1 otherwise

What is read:
  - /Library/Audio/Plug-Ins/HAL/: each bundle and its code signature (codesign -dv summary);
  - CoreAudio devices with their UIDs, and the Backchannel UIDs resolved even when hidden;
  - the OS default input, output and system output;
  - /Library/Preferences/Audio/com.apple.audio.DeviceSettings.plist: its keys;
  - launchd services of this user (gui/<uid>) and ~/Library/LaunchAgents;
  - the helper's path, when given;
  - Core Audio driver host processes;
  - code-signing identities.
Not observable, stated in every census: TCC (TCC.db needs Full Disk Access).

The comparator names every difference. Residue is allowed only for named UIDs: coreaudiod keeps
UID-keyed entries in DeviceSettings.plist after a device goes away, and removal does not edit a
file coreaudiod owns.
"""
import argparse
import json
import os
import plistlib
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HAL = "/Library/Audio/Plug-Ins/HAL"
DEVICE_SETTINGS = "/Library/Preferences/Audio/com.apple.audio.DeviceSettings.plist"
BACKCHANNEL_UIDS = ("tech.madduck.backchannel.microphone", "tech.madduck.backchannel.speakers",
                    "tech.madduck.backchannel.bridge-in", "tech.madduck.backchannel.bridge-out")


def run(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def coreaudio(*args):
    binary = os.path.join(REPO, "experiments", "bin", "coreaudio")
    src = os.path.join(HERE, "coreaudio.swift")
    if not os.path.exists(binary) or os.path.getmtime(src) > os.path.getmtime(binary):
        os.makedirs(os.path.dirname(binary), exist_ok=True)
        code, _, err = run("swiftc", "-O", "-o", binary, src)
        if code:
            raise SystemExit(f"census: could not build coreaudio: {err.strip()}")
    code, out, err = run(binary, *args)
    if code:
        raise SystemExit(f"census: coreaudio {' '.join(args)} failed: {err.strip()}")
    return json.loads(out)


def signature(path):
    # -dvvv: without it codesign prints no CDHash, and two ad-hoc builds of one bundle read the same
    # (#316: replacing the spike plug-in with a variant build was not reported as a change).
    _, _, err = run("codesign", "-dvvv", path)
    keep = {}
    for line in err.splitlines():
        for key in ("Identifier", "TeamIdentifier", "Signature", "Authority", "CDHash"):
            if line.startswith(key + "="):
                keep.setdefault(key, line.split("=", 1)[1])
    flags = re.search(r"flags=(0x[0-9a-f]+)\(([^)]*)\)", err)
    if flags:
        keep["flags"] = flags.group(2)
    return keep or {"unsigned_or_unreadable": err.strip()[:200]}


def take(helper=None):
    plugins = {}
    if os.path.isdir(HAL):
        for name in sorted(os.listdir(HAL)):
            plugins[name] = signature(os.path.join(HAL, name))
    settings = None
    if os.path.exists(DEVICE_SETTINGS):
        try:
            with open(DEVICE_SETTINGS, "rb") as f:
                settings = sorted(str(k) for k in plistlib.load(f))
        except Exception as e:  # unreadable is a value, not a silence
            settings = f"unreadable: {e}"
    uid = os.getuid()
    _, out, _ = run("launchctl", "print", f"gui/{uid}")
    services = sorted(set(re.findall(r"^\s+\d+\s+[-\d]+\s+(\S+)$", out, re.M)) |
                      set(re.findall(r"^\s+-\s+[-\d]+\s+(\S+)$", out, re.M)))
    agents_dir = os.path.expanduser("~/Library/LaunchAgents")
    agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []
    _, ps, _ = run("ps", "-axo", "comm=")
    hosts = sorted(l.strip() for l in ps.splitlines() if "Core Audio Driver" in l or "Core-Audio-Driver" in l)
    _, ids, _ = run("security", "find-identity", "-v", "-p", "codesigning")
    identities = sorted(re.findall(r'"([^"]+)"', ids))
    return {
        "hal_plugins": plugins,
        "devices": sorted(coreaudio("devices"), key=lambda d: str(d["uid"])),
        "backchannel_uids": coreaudio("resolve", *BACKCHANNEL_UIDS),
        "defaults": coreaudio("defaults"),
        "device_settings_keys": settings,
        "launchd_services": services,
        "launch_agents": agents,
        "helper": {"path": helper, "exists": os.path.exists(helper)} if helper else None,
        "driver_hosts": hosts,
        "identities": identities,
        "tcc": "not observable (TCC.db needs Full Disk Access)",
    }


def compare(before, after, expect_added=(), allow_residue_uid=()):
    """Differences as (kind, detail); `unexpected` is the subset that is neither an expected
    addition nor allowed residue."""
    diffs = []
    def keyed(field):
        return before.get(field) or {}, after.get(field) or {}
    b, a = keyed("hal_plugins")
    for name in sorted(set(b) | set(a)):
        if name not in a:
            diffs.append(("plugin removed", name))
        elif name not in b:
            diffs.append(("plugin added", name))
        elif b[name] != a[name]:
            diffs.append(("plugin signature changed", name))
    bd = {d["uid"]: d for d in before.get("devices", [])}
    ad = {d["uid"]: d for d in after.get("devices", [])}
    for u in sorted(set(bd) | set(ad), key=str):
        if u not in ad:
            diffs.append(("device removed", u))
        elif u not in bd:
            diffs.append(("device added", u))
        elif bd[u] != ad[u]:
            diffs.append(("device changed", u))
    for u in BACKCHANNEL_UIDS:
        if (before.get("backchannel_uids") or {}).get(u) != (after.get("backchannel_uids") or {}).get(u):
            diffs.append(("backchannel uid changed", u))
    if before.get("defaults") != after.get("defaults"):
        diffs.append(("defaults changed", json.dumps({"before": before.get("defaults"), "after": after.get("defaults")})))
    for field in ("device_settings_keys", "launchd_services", "launch_agents", "driver_hosts", "identities"):
        bs, as_ = before.get(field), after.get(field)
        if field == "launchd_services" and not isinstance(bs, str) and not isinstance(as_, str):
            # Apple's on-demand services come and go on their own: across #316's install and removal,
            # 14 h apart, AMPLibraryAgent appeared and XprotectFramework.PluginService and
            # timezoneupdates.tznotify went. Only services outside com.apple.* are compared.
            bs = [x for x in (bs or []) if not x.startswith("com.apple.")]
            as_ = [x for x in (as_ or []) if not x.startswith("com.apple.")]
        if isinstance(bs, str) or isinstance(as_, str):
            if bs != as_:
                diffs.append((f"{field} unreadable", f"{bs} / {as_}"))
            continue
        bs, as_ = set(bs or []), set(as_ or [])
        for x in sorted(as_ - bs):
            diffs.append((f"{field} added", x))
        for x in sorted(bs - as_):
            diffs.append((f"{field} removed", x))
    if before.get("helper") != after.get("helper"):
        diffs.append(("helper changed", json.dumps(after.get("helper"))))
    def allowed(kind, detail):
        if kind.endswith("added") and any(e in detail for e in expect_added):
            return True
        if kind == "backchannel uid changed" and any(e in detail for e in expect_added):
            return True
        if kind == "device_settings_keys added" and any(u in detail for u in allow_residue_uid):
            return True
        return False
    unexpected = [d for d in diffs if not allowed(*d)]
    return diffs, unexpected


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("take")
    t.add_argument("--helper")
    c = sub.add_parser("compare")
    c.add_argument("before")
    c.add_argument("after")
    c.add_argument("--expect-added", nargs="*", default=[])
    c.add_argument("--allow-residue-uid", nargs="*", default=[])
    a = p.parse_args()
    if a.cmd == "take":
        json.dump(take(a.helper), sys.stdout, indent=1, sort_keys=True)
        print()
        return
    before, after = (json.load(open(x)) for x in (a.before, a.after))
    diffs, unexpected = compare(before, after, a.expect_added, a.allow_residue_uid)
    print(json.dumps({"differences": diffs, "unexpected": unexpected}, indent=1))
    sys.exit(1 if unexpected else 0)


if __name__ == "__main__":
    main()
