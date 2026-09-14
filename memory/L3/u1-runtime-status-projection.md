<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-09-14T16:13:11.392680+00:00","id":"u1-runtime-status-projection","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["local-mvp,runtime,ai-reviewed,human-unreviewed"],"updated_at":"2026-09-14T16:13:11.392680+00:00"} -->

# Runtime projects authoritative daemon status

Local MVP runtime owns endpoint status projection at <config-dir>/.internal/daemon-status.json. Agent child emits daemon.registered and daemon.status; supervisor validates identity, role, presence, state, capabilities, resources, PID, entry/config ownership, startToken, and child generation against launcher generation. Projection writes are atomic and status rejects missing, malformed, stale-generation, or ownership-mismatched records explicitly. Verified on candidate a1ed1fce and integrated main 20912da: focused runtime 35 tests, runtime tsc, pnpm typecheck, pnpm build:runtime, appsdk compile, appsdk verify, and git diff --check passed. Exact review PASS bound to candidate tree; remote main is 20912da4d156d8dfa3c14dc42fad745b3a1dbc84. ai-reviewed; human-unreviewed.
<!-- project-memory:end -->
