# Validation receipt: 3eee987

- `git diff --check`: PASS.
- `pnpm typecheck`: PASS (source and dependency inputs unchanged; candidate worktree used temporary
  symlinks to the existing root package stores, removed after the gate).
- `appsdk guide compile`: PASS.
- `appsdk compile`: PASS.
- `appsdk verify`: PASS (`project_id=agentteams`, `stage=contract_bound`).
- `pnpm verify`: NOT PASS. The existing regression run reached 457/458 tests and failed only at the
  pre-existing real fixed-root search test `agent-host/cli-executor.spec.ts`; this documentation candidate
  does not change that path. The exact failure is retained as an open validation limitation and is not
  represented as a product or deployment success.
