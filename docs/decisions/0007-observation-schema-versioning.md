# ADR 0007: Versioning of the structured observation schema

Date: 2026-09-01
Status: accepted

## Context

An agent's observation schema is created and changed through chat (§12). After meetings accumulate,
the user adds or removes a field; older meetings lack the new fields. Analytics across a series of
meetings (§13) must work with heterogeneous records.

## Decision

- The agent stores its current schema with a version number; every change through chat creates a new version,
  and old versions are kept.
- Every meeting stores its observations together with the schema version they were extracted with.
- Analytics reads meetings as they are: a missing field is `null`, not an error. The analytics prompt receives
  every schema version present in the selection so the model understands why some meetings lack a field.
- No migration of old meetings to a new schema in the MVP. Later it can be offered as a
  "re-extract with the new schema" action with confirmation; transcripts are kept for that purpose.
