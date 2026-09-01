# ADR 0004: Echo and leakage of other participants' speech into the YOU channel

Date: 2026-09-01
Status: accepted

## Context

With split streams (ADR 0003) a laptop microphone on speakers hears the other participants: their speech is
transcribed twice — as OTHERS and as YOU. With headphones there is no problem. This is degradation, not breakage.

Facts (2026-09-01):

- Conversationaly has no real AEC; only a mic/sys level heuristic used to guess the speaker on the mixed stream.
- The fork classifies the output device (speakers / headphones / headset / Bluetooth) by name on all three OSes
  (`audio/playback_monitor.rs`).
- Project Raven: WebRTC AEC3 via GStreamer plus a "residual echo gate" (`src/main/residualEchoGate.ts`, ~150 lines):
  correlation of a 100 ms microphone window against the last 400 ms of system PCM with lag search,
  threshold 0.32, 400 ms holdover. Works without AEC as well.
- Rust AEC: crate `webrtc-audio-processing` 2.1.0 (May 2026), alive, but requires building a C++ library on three OSes.

## Decision

1. **No real AEC in the MVP.** `webrtc-audio-processing` is a post-MVP candidate.
2. **The speaker warning ships in the MVP.** The Setup Master's audio check and the meeting start screen warn that
   on speakers other participants' speech may leak into YOU, and suggest headphones.
3. **A correlation echo gate modeled on Raven** is the last item of Milestone 0, "if time permits", otherwise
   right after. Ported to Rust without external dependencies; the system channel's PCM is passed into the
   transcriber instead of RMS.
4. **Wording for the README and the Master:** separate YOU/OTHERS are guaranteed with headphones;
   on speakers they work with caveats.
