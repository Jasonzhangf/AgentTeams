# Cleanup receipt: bc1cbcb

- Delivery unit: `bc1cbcb`
- Candidate and integration processes: stopped by their test harness; lifecycle install/restart processes completed and exited.
- Evidence: candidate and integration AppSDK records, lifecycle logs, review, integration, and push receipts are retained under this directory.
- Worktrees: candidate and integration worktrees remain temporarily until the final evidence commit is pushed; no other worktree is touched.
- Root workspace: historical dirty files remain untouched.
- Pending cleanup action: after this receipt is committed and pushed, remove only the owned candidate/integration worktrees, their branches, and untracked generated `.appsdk`/`.appsdk-control` records; retain this evidence directory on remote `main`.
