# Integration receipt: bc1cbcb

- Issue: `bc1cbcb`
- Base: `origin/main@4a5572620ca1a32c0b50aa10a2a3c49b086fceb2`
- Integrated commits: `06d63f0` (`f0daccac` candidate) and `f1982cf` (`f7a5dc2` fix candidate)
- Integrated tree: `f1982cf9611e0a5e8b3b531bbcb1bfca5407969d`
- Worktree: `/Volumes/extension/code/AgentTeams/playground/integration-bc1cbcb-20260912`

## Verification on the integrated tree

- `pnpm install --frozen-lockfile` — passed.
- `pnpm exec vitest run runtime/agent-process.spec.ts` — 1 file, 6 tests passed.
- `pnpm test` — 75 files, 447 tests passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `appsdk guide compile` — passed.
- `appsdk compile` — passed; artifact hash `sha256:d2ba55868d3e9a525e77c62a95c820dc41b9ef52c44d0b3e8bb3539493dade3d`.
- `pnpm smoke` — packaged Console and local TLS Relay smoke passed.
- `appsdk verify` — `ok=true`, `stage=contract_bound`.
- `pnpm lifecycle:admission` — passed; attempt `attempt-1789231628571-c0c27197-9743-481f-8dc8-dccdd079d7a5`, exact integrated candidate `f1982cf9611e0a5e8b3b531bbcb1bfca5407969d`.

The lifecycle records and command logs are archived under `integration-appsdk-records/` and `integration-lifecycle/`.
