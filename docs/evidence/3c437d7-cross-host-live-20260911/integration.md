# Cross-host blocker integration receipt

- delivery unit: `3c437d7-cross-host-live-20260911`
- source candidate commit: `93f0632fb6d5685a6959f7ac59c34c380777e4fd`
- integration base: `origin/main@3c7dfb94226547fc60bbd9e299f931abbd680c2f`
- integrated candidate: `0277f0a`
- integration worktree: `playground/integration-3c437d7-20260911`
- integration mode: clean fast-forward candidate from the latest `origin/main`

The worktree contained only the cross-host blocker evidence for this delivery
unit. `git diff --check` passed. After dependencies were installed with
`pnpm install --frozen-lockfile`, the merged candidate passed `pnpm verify`,
`appsdk compile`, and `appsdk verify`.

This integration receipt preserves the live boundary: the cross-host Claw /
coder2new replay remains `BLOCKED` because outbound DNS/TCP/SSH access was
denied. Local verification does not promote that blocker to a live network
pass.
