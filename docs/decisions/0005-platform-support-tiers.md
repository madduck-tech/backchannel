# ADR 0005: Platform support tiers and development environment

Date: 2026-09-01
Status: accepted

## Context

The spec requires Windows/macOS/Linux (§45) and an overlay with always-on-top, hotkeys and share protection (§9).
Development happens on a single machine: Ubuntu, GNOME 46, Wayland, PipeWire 1.0.5. No Mac is available.

Facts (2026-09-01):

- **macOS.** The fork's default system audio backend is a Core Audio process tap ("Audio capture" permission,
  macOS 14.4+); ScreenCaptureKit is the fallback. Overlay, always-on-top, content protection and global hotkeys
  are supported by Tauri natively.
- **Windows.** WASAPI loopback via cpal in the fork. Content protection in Tauri works only as a runtime call
  after window creation; the config flag has no effect there.
- **Linux.**
  - The fork's system audio looks for ALSA devices with `monitor` in the name via cpal; on PipeWire systems
    there are none (verified: ALSA exposes only `pipewire`, `default` and hardware). The path effectively does not work.
  - Always-on-top: tao documents "Wayland: Unsupported"; GNOME does not implement layer-shell.
  - Content protection: unsupported.
  - Global hotkeys: the `global-hotkey` crate is X11 only; the GlobalShortcuts portal is absent in GNOME 46.
  - In an "Ubuntu on Xorg" session always-on-top and hotkeys work; share protection does not.

## Decision

1. **Support tiers.** macOS and Windows: full overlay. Linux: full audio and copilot; the overlay is a normal
   window on Wayland, hotkeys and always-on-top only in an X11 session, no share protection.
   Stated as such in the README; the Setup Master detects the session type and says so immediately.
2. **Milestone 0, item 1** gains a sub-item: Linux system audio via the PulseAudio protocol
   (`libpulse-binding` through pipewire-pulse / PulseAudio, opening `<sink>.monitor`).
   The native `pipewire` crate is the alternative if libpulse proves insufficient. Without this, Linux does not pass Milestone 0.
3. **macOS:** keep the Core Audio tap as the default with ScreenCaptureKit as fallback.
4. **Windows:** content protection is enabled at runtime.
5. **The development environment is this Linux machine only.** Consequences:
   - Milestone 0 is passed on Linux first; the overlay is developed in an Xorg session.
   - macOS and Windows are verified in Milestone 0 by CI builds only. Manual verification of audio and overlay
     on them is postponed until machines are available (a Windows VM, a borrowed Mac, or a self-contained
     smoke test in CI later).
   - Platform-specific code for macOS/Windows is written blind and marked as unverified.
