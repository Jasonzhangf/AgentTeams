# c3c2e0e integration receipt

- Candidate commit: `acb5d77` (`fix(c3c2e0e): ship compiled agentteams CLI runtime`)
- Integration base: `origin/main@68ea2303a1acc70facb028b385c01bebdfa5e27b`
- Integration commit: `7f5e24d`
- Integration worktree: `playground/c3c2e0e-cli-entry-r2-integration-20260914`

## Validation on integration tree

- `pnpm install --frozen-lockfile`: exit 0.
- `pnpm build:runtime`: exit 0.
- `pnpm exec vitest run --config vitest.config.ts cli/agentteams.spec.ts runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-process.spec.ts`: 4 files, 36 tests passed.
- `pnpm typecheck`: exit 0.
- `pnpm test`: 78 files, 482 tests passed.
- `appsdk compile`: exit 0; artifact hash `sha256:cebad30d86b2608517d289dafeaaf0747ec7ff3f76c10fe471db9beae7dca1cb`.
- `appsdk verify`: `ok=true`, `stage=contract_bound`, `delivery_verified=false` because admission is requested after merge.
- Packaged replay: `prepack` built runtime; isolated consumer installed the tarball and ran `agentteams init/start/status/work/stop`, restart and final stop. All exited 0; Work returned `succeeded agent=receiver work=configured-search request=configured-search-1 state=succeeded`.

The integration tree is clean after this receipt is committed. Public Relay,
NAT/STUN, mobile and Console-offline acceptance remain outside this delivery unit.
