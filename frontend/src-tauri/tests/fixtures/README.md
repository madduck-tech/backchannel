# Fixtures recorded on the engine before #169

All of these were recorded on transcribe.cpp `553f109`, the pin before #169 moved the engine to v0.4.1, and are compared after the move by `audio::diarization` and `transcribe_engine::measurements`. Each says its `engine_revision`. The models are named, with their revision and sha256, in #169's commits and in `~/.cache/backchannel-measure-models/PROVENANCE.txt`.

| fixture | recorded by | how |
|---|---|---|
| `diarizer-sortformer-2spk-mix.json` | `record_the_diarizers_segments_on_the_pinned_engine`, commit `232fedf` | `run_diarizer` at VeryHighLatency, on the CPU |
| `decode-{fun,sensevoicesmall}-{jfk,zh}-553f109.json` | `record_a_decode_on_the_pinned_engine`, commit `ba7b736` | `RunOptions::default()`, no language hint |
| `decode-{fun,sensevoicesmall}-jfk-en-553f109.json`, `…-zh-zh-553f109.json` | the same recorder, **with a change that is in no commit** | `RunOptions { language: BC_RECORD_LANG, ..Default::default() }`, and the fixture records `"language"` |

The last four were recorded after the move had been committed, from a scratch worktree at `ba7b736` (553f109). The recorder there was edited by hand in two places, and the edit was not committed: it took its hint from `BC_RECORD_LANG`, and it wrote that hint into the fixture. That is how `"language"` comes to be in those four files and absent from the rest. The edit, against `ba7b736`'s `frontend/src-tauri/src/transcribe_engine/engine.rs`:

```diff
-        let transcript = session.run(&audio, &super::RunOptions::default()).expect("the decode runs");
+        let transcript = session.run(&audio, &super::RunOptions { language: std::env::var("BC_RECORD_LANG").ok(), ..Default::default() }).expect("the decode runs");
@@
             "sample": sample,
+            "language": std::env::var("BC_RECORD_LANG").ok(),
             "text": transcript.text.trim(),
```

`decode-fun-zh-zh-553f109.json` closes with `。`. That is fun-asr-mlt-nano's own output with a `zh` hint on 553f109, not ITN. For that row the comparison is of the text, `。` included, and the ITN property check is skipped because the pin's own output fails it.
