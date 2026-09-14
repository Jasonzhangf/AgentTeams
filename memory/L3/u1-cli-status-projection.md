<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-09-14T16:24:11.334797+00:00","id":"u1-cli-status-projection","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["local-mvp,cli,ai-reviewed,human-unreviewed"],"updated_at":"2026-09-14T16:24:11.334797+00:00"} -->

# CLI status preserves endpoint capability resources

agentteams status consumes runtime LocalDaemonEndpointProjection directly. It prints agentId, full identity, role, presence, endpoint generation, and each capability with its own nested resources in capability=id@version:operations[resource:capacity:unit] form. Missing endpoint arrays, malformed arrays, and malformed endpoint records are explicit output; CLI does not reconstruct status from config.toml or duplicate runtime truth. Verified on candidate f96b45c795526794fafda6f164e5f4e026709fa6 and integrated main 20f2b0eb8b9459505f5ad8ced2958262cdc4f148: CLI focused 9 tests, full 78 files/488 tests, pnpm typecheck, appsdk compile, appsdk verify and git diff --check passed. Exact review PASS bound to current candidate. ai-reviewed; human-unreviewed.
<!-- project-memory:end -->
