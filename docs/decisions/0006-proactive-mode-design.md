# ADR 0006: Proactive mode — mechanics of the intervention levels

Date: 2026-09-01
Status: accepted

## Context

The spec defines Low/Medium/High without separate triggers (§8) and requires that in-session commands
do not change the agent's persistent configuration (§5). The runtime must know what a level turns into.

Fact (2026-09-01): `llama-helper` creates a new `LlamaContext` per request and does not cache the prompt.
For proactivity with a local LLM this is unacceptable: every evaluation would reprocess the whole transcript.

## Decision

1. **The trigger is an event, not a timer.** Evaluation runs after every completed phrase (VAD segment,
   any channel), subject to a minimum interval. Segments are at most 8 s, so boundaries arrive regularly.
2. **One structured call.** Input: agent goal and instructions, session context, the transcript window for the
   last minutes plus a compressed summary of earlier content, knowledge snippets for the latest phrases,
   the list of hints already shown. Output — JSON: `intervene`, `kind`, `confidence`, `text`, `source`.
   For local models the format is enforced with a llama.cpp grammar.
3. **A level is three knobs** (starting values, hidden in Advanced Settings):

   | Level | Confidence threshold | Min interval | Cap / 10 min | Kinds |
   |---|---|---|---|---|
   | Low | 0.85 | 60 s | 2 | contradiction, history, action |
   | Medium | 0.7 | 30 s | 5 | + followup |
   | High | 0.5 | 15 s | 10 | + answer ("what to say") |

4. **Repeat protection.** Shown hints go back into the context; cooldown on the (kind, source) pair for
   several minutes; a hint in the overlay fades out on a timer.
5. **In-session commands** act on the same knobs for the current session only: "don't interrupt" — intervene off;
   "be shorter" — length cap; "dig into X" — focus in the prompt and a lowered threshold for X.
6. **Reactive is the same loop.** A hotkey question is a trigger with a forced answer. One runtime, two entry points.
7. **Feedback:** a "not this kind" button raises the threshold for that kind until the end of the session. Nothing more.
8. **Incremental LLM context — Milestone 0 sub-item (item 6).** A persistent context with KV-cache reuse (llama.cpp)
   or llama-server with a per-slot prompt cache; each evaluation processes only the delta.
9. **Recommendation engine:** High plus a local LLM without a GPU is tagged "needs a GPU or a cloud LLM".
   Medium on CPU with the cache is verified by the measurement from ADR 0003.

## Not in the MVP

Learned thresholds, separate triggers, personalization beyond the button in item 7.
