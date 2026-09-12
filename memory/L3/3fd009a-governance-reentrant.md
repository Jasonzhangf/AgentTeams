<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-09-12T10:40:07.740343+00:00","id":"3fd009a-governance-reentrant","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["ai-reviewed","human-unreviewed"],"updated_at":"2026-09-12T10:40:07.740343+00:00"} -->

# Stage-reentrant lifecycle gates

Validated candidate c1c7b63 integrated as d3d019c and pushed as be151e4c772f7f71e28e0092487ba7551e0f8a8e. Lifecycle gates now persist per delivery unit with stage fingerprints, durable receipts, invalidation history, explicit executed/reused evidence lineage, candidate-scoped rerun records, and stale-validation recovery. Evidence: Codex exact review v5 PASS; node --check scripts/lifecycle-adapter.mjs; git diff --check; appsdk verify; appsdk compile; docs/evidence/3fd009a-governance-reentrant-20260912. Tags ai-reviewed, human-unreviewed.
<!-- project-memory:end -->
