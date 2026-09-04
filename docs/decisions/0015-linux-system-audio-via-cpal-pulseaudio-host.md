# ADR 0015: Linux system audio through cpal's PulseAudio host

Date: 2026-09-04
Status: accepted (supersedes decision 2 of ADR 0005)

## Context

ADR 0005 decision 2 gave Linux system audio a sub-item of Milestone 0 item 1: a new capture path
built on `libpulse-binding` through pipewire-pulse, opening `<sink>.monitor`, with "the native
`pipewire` crate" named as the alternative if libpulse proved insufficient. Without it, Linux did not
pass Milestone 0.

The finding underneath that decision is correct and still reproduces on the development machine —
`arecord -L | grep -ci monitor` returns `0` with no hand-written ALSA config. The conclusion drawn
from it was heavier than the finding required, and the reason is that **both dependencies it proposed
to add are already inside the crate this repository pins**: cpal 0.18.1 ships `pipewire` and
`pulseaudio` as optional cargo features, off by default, and on Linux its `default_host()` prefers
them over ALSA when compiled in.

The crate behind the PulseAudio feature is a pure-Rust implementation of the protocol: `build = false`,
no build script, no `links` key, no `-sys` dependency. Against this repository's `Cargo.lock` it adds
three crates and **no system library**. libasound was already required and still is.

Issue #13 was raised to correct ADR 0005 and, in its first two forms, repeated the same blind spot —
proposing to generate ALSA configuration instead, on evidence that turned out not to say what it was
read as saying. Four adversarial critic rounds refuted, in order: that the gate on #8 had shown cpal
captures system audio (the harness captured a virtual source, not a monitor); that the existing
monitor filter would work against the new host (it matches nothing); that enabling the feature was an
application change rather than mostly a flag (it is both, and the flag half is wider); a published
measurement that did not reproduce; a defect in the measuring instrument itself; and an oracle clause
that could not come back negative.

## Decision

1. **Enable `cpal`'s `pulseaudio` feature on Linux** and route the application's device paths through
   it. It costs no new system build dependency; at runtime it needs a PulseAudio-protocol socket,
   which pipewire-pulse provides, and cpal falls back to its ALSA host when there is none.
2. **The native `pipewire` feature is not taken.** It needs `libpipewire-0.3` headers and `clang`,
   which are absent on the development machine and would have to be added to the CI image and
   declared in the `.deb` — the class of defect #5 is about. It remains the alternative if the
   PulseAudio protocol proves insufficient, exactly as ADR 0005 framed its own alternative.
3. **Devices are classified by id, not by display name.** A monitor is `<sink node name>.monitor`;
   the default system-audio device is the monitor **of** the default sink, paired by id. Display
   descriptions are free text that follows whatever a sink is called, and resolving identity from
   them is the class #9 and #10 are about.
4. **Presentation stays out of identity strings.** The `"<name> (System Audio)"` suffix is gone: the
   role is carried by `DeviceType`, and the suffix made a device that was offered in the UI
   impossible to resolve again.
5. **The host is decided once per process**, not per call site. `cpal::default_host()` caches
   nothing and was called at sixteen sites; against a PulseAudio socket that exists but never
   answers, each construction costs cpal's 2 s `INIT_TIMEOUT` and leaks the thread it cannot join.
   Measured: 2.02 s against 34.03 s for the same seventeen constructions.
6. **Milestone 0 item 1's sub-item is reworded** from "build a Linux system-audio capture path" to
   "select the host that already has one, and make the identity round-trip hold". It is done.

## Consequences

- Linux system audio works on an unprepared machine. Verified on the built application, clean
  profile, no harness and no `~/.asoundrc`: four real sink monitors enumerated, and a recording
  through one transcribed the speech that was playing, with two negative controls — silence, and the
  same sample played to a *different* sink — producing no transcript.
- Device identity on Linux changes for every path at once. Every stored `recording_preferences.json`
  written by an earlier build stops matching; it fails loudly rather than silently resolving to
  another device, which is guarded by a test.
- The symptom half of #10 disappears on machines whose PulseAudio descriptions are distinct, where
  the ALSA host returned one identical string for every input of a card. The class #10 states —
  resolving a device from a display description at all — is untouched, and #10 stays open.
- A sink's monitor carries every stream mixed into that sink, and nothing mixed into another. Capture
  therefore follows the sink, and capturing the wrong one fails **silently**, not noisily. The
  converse holds for independent hardware sinks; a loopback, combine or filter-chain sink is fed from
  another by construction.
- Not established, and not implied: a real PulseAudio server rather than pipewire-pulse, and whether
  PulseAudio descriptions collide for two identical devices. macOS and Windows take different
  branches (ADR 0005) and the feature is Linux-only in cpal.
- Two corrections from the same work that outlive it: cite a PipeWire node's `node.name`, never its
  id, which is stable only for an object's lifetime; and "the microphone on the development machine
  delivers silence" is a property of one source object, not of the machine — another source on it is
  live. Both had been load-bearing in earlier evidence.
