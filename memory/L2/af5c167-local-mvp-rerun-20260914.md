<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-09-14T17:10:09.656173+00:00","id":"af5c167-local-mvp-rerun-20260914","importance":0,"memory_level":2,"review_evidence":["docs/evidence/af5c167-local-mvp-rerun-20260914/review-receipt.md"],"review_status":"reviewed","source_refs":[],"tags":["agentteams","ai-reviewed","human-unreviewed","local-mvp"],"updated_at":"2026-09-14T17:10:20.554915+00:00"} -->

# Current SHA local MVP replay

At origin/main 66d7cf09, the current AgentTeams CLI path was replayed in a disposable HOME without Console: init, start, status, work, stop, restart, stale generation rejection, new Work, and final stop all behaved as recorded in docs/evidence/af5c167-local-mvp-rerun-20260914/replay-receipt.md and replay.log. Current-SHA Console projection tests (7 files, 32 tests), typecheck, build, AppSDK compile, packaged smoke, and verify command all passed. The evidence is local-only; public Relay, NAT, mobile, production, and full Console HTTP readback remain unproven. Source: docs/evidence/af5c167-local-mvp-rerun-20260914/.
<!-- project-memory:end -->
