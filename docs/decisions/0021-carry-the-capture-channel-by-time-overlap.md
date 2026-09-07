# 0021 — Carry the capture channel across a re-segmentation by time overlap

Date: 2026-09-07
Status: accepted

## Context

Since #112 the transcript renders from `channel`, the capture stream that carried each line: one side
is this machine's microphone, the other is system audio. **Nothing is spelled out — the side is the
label.** So losing the column does not degrade the transcript, it removes its only attribution.

Retranscription destroyed it. `audio/retranscription.rs` deleted every row for a meeting and
re-inserted from a fresh pass, and the INSERT never carried `channel`; `common.rs::create_transcript_segments`
additionally hard-coded `channel: None`. The same held for the batch export: two writers produce
`transcripts.json` and only one carried the column.

**The obvious fix was not available.** Measured at `b02d832`:

- `grep -n "sqlx::query" retranscription.rs` returns exactly two statements — the DELETE and the
  INSERT. The old rows were never read.
- New segments are produced by a fresh VAD pass with fresh identities
  (`id: format!("transcript-{}", Uuid::new_v4())`, `common.rs:169`) and a different row count.

There is no join key between the rows being deleted and the rows being written. Only time relates
them.

**And the audio cannot answer.** `ffprobe` on the reference recording's `audio.mp4`:
`codec_name=aac, sample_rate=48000, channels=1`. The mix is mono; the sides are not in the file.

**The mapping is therefore lossy, and by how much is measured.** On the reference recording
(137 rows, 2026-09-07), counting pairwise interval intersections between rows of different channels:

| | |
|---|---|
| cross-channel overlapping row pairs | 16 |
| total overlapping time | 38.6 s |
| rows touched by an overlap | **29 of 137 — 21.2%** |
| channel-change boundaries with a negative gap | 16 of 30 |

Every fifth row is part of a stretch where both people speak at once. A mono VAD segment covering one
of those contains both sides and can be given only one.

## Decision

1. **Read the prior rows before the DELETE, and map their channel onto the new segments by time
   overlap.** `carry_channels_by_overlap` in `audio/retranscription.rs`.
2. **A new segment takes the channel of the prior row it overlaps most.** Overlap is
   `min(ends) - max(starts)`, and must be strictly positive: touching intervals do not count.
3. **A tie goes to the earliest prior row**, so the result does not depend on the order rows come
   back in. `prior_rows` orders by `audio_start_time` and the two must stay together.
4. **A new segment that overlaps nothing keeps `None`.** It is not snapped to the nearest row.
   Inventing a side is worse than admitting there is none, because the side is the only label the
   transcript shows.
5. **Segments are never split.** The new boundaries are what the user asked for by retranscribing.
6. **`common.rs::write_transcripts_json` carries the column**, so the batch export stops having a
   different shape from the live one.

## Consequences

- **A retranscribed transcript is an approximation on overlapping speech**, and on the reference
  recording that is a fifth of its rows. It is still strictly better than the previous behaviour,
  which was to drop the column entirely and render one column with no attribution at all.
- **The user is not told.** #126 is the sentence in the retranscribe dialog, and it depends on this
  decision existing: the honest warning is *"on the parts where you both spoke at once, a line may
  change sides"*, which could not be written before the rule was chosen.
- **Only VAD+batch recordings are affected.** `streaming.rs:168` sets `channel: None` unconditionally,
  and five of six `RECOMMENDED_LIVE_MODELS` are streaming-native, so a large share of recordings have
  no channel to carry.
- **Import is unchanged.** A file has one mixed track and genuinely has no capture channel;
  `create_transcript_segments` still yields `None` there.
- **The rule is now the thing to argue with, not the code.** A future change that wants word-level
  timestamps could split segments instead of choosing — decision 5 is what it would supersede.
