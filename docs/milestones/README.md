# Milestone reports

`.claude/rules/docs.md` specifies the shape: *"Milestone reports live in `docs/milestones/<name>.md`
and list criteria, p50/p95 numbers, the hardware and models used, and everything skipped or failed."*

The directory did not exist until #65, and neither did any number to put in it. ADR 0008 set latency
targets on 2026-09-01 and nothing in this repository measured one for five days.

## What a report here may and may not claim

**A report is a measurement, not a check.** Nothing in CI can produce one: a hosted runner has no
audio device and none of the 1.2 GB of models a decode needs. So a regression is visible by
*comparing two reports*, by a person, and never by a job going red. #65 says so in place rather than
letting a printed number look like a gate.

**Every number carries the operation that produced it**, per `.claude/rules/testing.md`. For latency
that means at minimum: the machine, the model, the decode path (`transcription/mod.rs:85` branches
on `Capabilities::supports_streaming`, and the two paths have different segmentation), and whether
the run was under ADR 0008 decision 5's limit.

## ADR 0008 decision 5 is not optional

> *"Emulating the minimum machine on the development machine (16 cores, 30 GB):
> `systemd-run --user -p CPUQuota=400% -p MemoryMax=8G`. **Numbers without the limit are not
> accepted.**"*

A report states the command it ran under. Publishing the unlimited run *beside* the limited one is
encouraged — if they are close that is a finding about the emulation, and if they are far it is the
reason the clause exists — but the limited one is the number the criteria are judged against.

## Three of the six timestamps do not exist yet

ADR 0008 decision 4 asks for six: audio in, VAD closed, STT committed, LLM requested, first token,
overlay painted. The last three need the proactive overlay from ADR 0006, and
`grep -ri proactive frontend/src frontend/src-tauri/src` returns **0**. A report names them as
absent rather than averaging over three of six.
