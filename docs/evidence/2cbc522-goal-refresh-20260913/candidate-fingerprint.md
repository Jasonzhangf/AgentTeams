# Candidate fingerprint: Local MVP goal refresh

- Delivery unit: `2cbc522`.
- Candidate state: uncommitted exact working tree; commit is intentionally deferred until review PASS.
- Base commit: `412fc5fbc7bba328d9916906122192d4e7e60e2b8`.
- Candidate identity: see the per-file SHA-256 values below; the fingerprint excludes this receipt itself to avoid a self-referential hash.
- Allowed paths: `docs/goals/**`, `docs/evidence/2cbc522-goal-refresh-20260913/**`.
- Forbidden paths: runtime, network, server, agent, agent-host, config, opencode-adapter, console-host, UI, package/lock, architecture maps, generated or active artifacts.
- Actual changed paths:
  - `docs/goals/teams-local-mvp-execution-plan.md`
  - `docs/goals/teams-local-mvp-goal-prompt.md`
  - `docs/goals/teams-user-mvp-delivery.md`
  - `docs/evidence/2cbc522-goal-refresh-20260913/**`
- Dependency and contract identity: `pnpm-lock.yaml` and declared AppSDK/architecture maps are unchanged from base; the project contract was verified by `appsdk verify` in the recorded command.
- Environment: Node `v22.22.2`; pnpm `10.31.0`; AppSDK is the repository's managed global binary at `/Users/fanzhang/.cargo/bin/appsdk`.
- Base tree: `4097e23ba970463332bbc65e88206b4da1d3109c`.
- Base architecture-map tree: `e4e2dd23ebadf544497eee5c351b715c02bc350a`.
- Base AppSDK tree: `f8b7f0c7253c3dc95df78992d7c6d760d8781265`.
- Runtime candidate baseline proof: `merge-base(546e77f, origin/main@412fc5f)=412fc5fbc7bba328d9916906122192d4e7e60e2b8`.
- Canonical candidate tree (staged index, excluding this self-referential receipt): `e4812ead8fbf17cad45d47a97ab0c6e7204d96c8`.
- Tree rule: copy the staged index, remove only `candidate-fingerprint.md`, then run `git write-tree`; all other staged paths remain included.
- Commands: `git diff --check`; `pnpm verify`.
- Raw evidence: `pnpm-verify.log`; result summary: `validation-receipt.md`.
- MCPX limitation: workspace discovery listed `server`, `routecodex`, `zterm`, and `humanagent`, but not this AgentTeams worktree; the documented project CLI/Git commands were used once and this limitation is retained rather than presenting shell output as MCPX evidence.

## Per-file SHA-256

- `docs/goals/teams-local-mvp-execution-plan.md`: `abae1cb0af610c81b55c67c1f73f2f24db5ee9200782b062e998e46b0ddecba4`
- `docs/goals/teams-local-mvp-goal-prompt.md`: `e8233086e32f7c70883bba688409e651517013f790afaa9973708863f627c064`
- `docs/goals/teams-user-mvp-delivery.md`: `6f32a79df6207ac43503b12a7b8449e11861472a4de5f8786414504e772aa1d1`
- `docs/evidence/2cbc522-goal-refresh-20260913/base.txt`: `3eae81adc89d792e7d26f9ce693909cc909bfe18701fd11046c7278eb9eca3b6`
- `docs/evidence/2cbc522-goal-refresh-20260913/changed-paths.txt`: `45bfeb0601c6760a8d9e9f04e6000e83301cce708ba2671364fbf3da086da75c`
- `docs/evidence/2cbc522-goal-refresh-20260913/validation-receipt.md`: `dc371becd44855358a9fa6c79050dd2d0222bf424573e7db2f71d35d815e44a2`
- `docs/evidence/2cbc522-goal-refresh-20260913/pnpm-verify.log`: `7b3445b0cba74c7b3f55e20d3ee7ec8766fa410594bec0ebb693dff0d5d45353`
