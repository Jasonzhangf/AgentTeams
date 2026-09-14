# L1 CLI integration receipt

- delivery unit: `3742b9a`
- source candidate: `b358a1ee633fd7740c55944d827cdb48b0dfaf35`
- integration base: `9387edad408556565658c0b2d41dbce0b61ed811`
- integrated SHA: `b405361`
- integrated tree: `ec8b9ab8fa71331c67fd4856e04610b200e19192`
- worktree: `playground/integration-l1-cli-b358-20260914`

Validation on the integrated tree:

- `node --check cli/agentteams.mjs`: exit 0
- `git diff --check origin/main..HEAD`: exit 0
- `vitest run --config vitest.config.ts cli/agentteams.spec.ts runtime/local-config.spec.ts runtime/local-process.spec.ts runtime/local-supervisor.spec.ts runtime/local-two-agent.spec.ts`: 5 files, 36 tests passed

The candidate's disposable-HOME lifecycle receipt was replayed before integration
and remains bound to the same source candidate. No generated dependency link was
left in this worktree.
