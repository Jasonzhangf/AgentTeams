# Cleanup receipt: bc1cbcb

- Delivery unit: `bc1cbcb`
- Candidate and integration processes: stopped by their test harness; lifecycle install/restart processes completed and exited.
- Evidence: candidate and integration AppSDK records, lifecycle logs, review, integration, and push receipts are retained under this directory.
- Worktrees: candidate and integration worktrees were removed after the final evidence commit was pushed; no other worktree was touched.
- Root workspace: historical dirty files remain untouched.
- Removed resources: candidate branch/worktree `codex/bc1cbcb-real-console-directory-20260912`, integration branch/worktree `codex/integration-bc1cbcb-20260912`, and their generated `.appsdk`/`.appsdk-control` records.
- Verified after cleanup: `git worktree list` contains neither delivery worktree, and remote `main` retains this evidence directory.
