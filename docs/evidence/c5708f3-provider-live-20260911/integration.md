# Provider blocker integration receipt

- delivery unit: `c5708f3-provider-live-20260911`
- source candidate commit: `5e308e50657eca0ff5f3fb93ab92e5d73f9b9586`
- integration base: `origin/main@0143c220e2d51779b61b3c317ce850cd4e2af92a`
- integrated candidate: `6f43109`
- integration worktree: `playground/integration-c5708f3-20260911`
- integration mode: clean fast-forward candidate from the latest `origin/main`

The worktree contained only the provider blocker evidence for this delivery
unit. `git diff --check` passed. After `pnpm install --frozen-lockfile`, the
merged candidate passed `pnpm verify`, `appsdk compile`, and `appsdk verify`.

The integrated evidence remains a blocker: RCC `127.0.0.1:4444` was not
reachable, so no provider catalog/apply/readback or backup inference is
claimed.
