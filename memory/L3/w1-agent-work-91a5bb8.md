<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-09-14T08:45:48.982389+00:00","id":"w1-agent-work-91a5bb8","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["ai-reviewed,human-unreviewed"],"updated_at":"2026-09-14T08:45:48.982389+00:00"} -->

# W1 Agent Work matching and admission

W1 candidate 2cda5a7 integrated as 91a5bb8. Fixed consumer capability matching so operation is selected only from the same capability version declaration; added focused coverage for stale generation, one consumer across capabilities, unsupported cancellation, provider admission and explicit errors. Validation: docs/evidence/w1-agent-work-20260914/validation.md and integration-receipt.md; 6 files/51 tests and tsc passed. Runtime socket gate remains environment-blocked by listen EPERM on 127.0.0.1. Scope: local Agent Work matching/admission only; no public network or deployment claim.
<!-- project-memory:end -->
