# Console-offline blocker integration receipt

- delivery unit: `9b10ed3-console-offline-live-20260911`
- source candidate commit: `d087ae6bace564d4fa33e5bece96ee2f64bffffa`
- integration base: `origin/main@921b8ac3376c6a48a7ef2635d4c6a563bc784faa`
- integrated candidate: `613727f`
- integration worktree: `playground/integration-9b10ed3-20260911`
- integration mode: clean fast-forward candidate from the latest `origin/main`

The integrated change adds only the current-candidate public/NAT Console-offline
blocker receipt. Existing loopback receipts remain historical boundary evidence
and were not promoted to current-candidate network acceptance. `git diff
--check` passed. After `pnpm install --frozen-lockfile`, the merged candidate
passed `pnpm verify`, `appsdk compile`, and `appsdk verify`.

The current delivery unit remains `BLOCKED` until the real Claw relay/DNS/SSH
environment is available.
