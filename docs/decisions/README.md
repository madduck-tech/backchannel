# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-foundation-conversationaly-fork.md) | Foundation: hard fork of Conversationaly at `madduck-tech/backchannel` | accepted |
| [0002](0002-stt-russian-recommendation.md) | STT for Russian: catalog as is, recommendation by meeting language | accepted |
| [0003](0003-two-stt-streams-resource-budget.md) | Two STT streams: model instances and resource budget | accepted |
| [0004](0004-echo-cancellation-scope.md) | Echo: no AEC in the MVP, speaker warning, gate if time permits | accepted |
| [0005](0005-platform-support-tiers.md) | Platform support tiers; development on Linux only | accepted |
| [0006](0006-proactive-mode-design.md) | Proactive mode: mechanics of the intervention levels | accepted |
| [0007](0007-observation-schema-versioning.md) | Versioning of the observation schema | accepted |
| [0008](0008-latency-targets.md) | Latency targets for Milestone 0 and how to measure them | accepted |
| [0009](0009-positioning-share-protection.md) | Positioning: share protection, not stealth | accepted |
| [0010](0010-project-language-english.md) | The project language is English | accepted |
| [0011](0011-design-system-package-and-opendesign.md) | Design system as a repository package; OpenDesign for prototyping | accepted |
| [0012](0012-development-workflow.md) | Development workflow: approval gates, conventions | partly superseded by 0013 |
| [0013](0013-single-cycle-with-gopnik.md) | One cycle: issue → critic → design → implementation → gopnik gate → PR | accepted |

## Deferred questions

- **Embeddings in the MVP.** Knowledge requires indexing, so a default embedding model is needed even if the user
  never sees it. The spec defers the embeddings choice (§18). Deferred on 2026-09-01: revisit when designing Knowledge/RAG.
