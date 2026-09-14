# C1 apply error recovery review

- Reviewer: independent GCM Codex reviewer
- Candidate tree: `codex/c1-apply-error-20260914`
- Candidate source anchor: dirty diff at `HEAD=43af91670215cfcbee2164efae7c48e6ce4579d4`
- Exact changed paths: `config/runtime-config.ts`, `config/runtime-config.spec.ts`
- Verdict: `PASS`

The reviewer found no P0/P1 issue. The success branch removes only the stale
`lastApplyError`, preserves accepted/effective revision semantics, persists the
observation before updating in-memory state, and leaves mismatched effective
revisions on the explicit error path. The added test covers durable readback.

The final owner-worktree validation reran the focused three-file suite,
`pnpm typecheck`, and `git diff --check` successfully.
