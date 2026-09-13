# 159b78b Internal Config Compiler evidence

Date: 2026-09-13
Worktree: `playground/159b78b-internal-config-20260913`

## Scope

Implemented the v2 local config compiler boundary: `config.toml` is parsed as user
intent, `internal.toml` is atomically written as the runtime-owned resolved config
source, and child JSON files are projected from `internal.toml` at supervisor start.

## Changed paths

- `runtime/local-config.ts`
- `runtime/local-supervisor.ts`
- `runtime/local-config.spec.ts`
- `docs/architecture/function-map.json`
- `docs/architecture/mainline-call-map.json`
- `docs/architecture/resource-map.json`
- `docs/architecture/verification-map.json`

## Verification

`pnpm exec vitest run runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-process.spec.ts --reporter=dot`

- Passed: 16 tests.

`pnpm exec tsc -p tsconfig.runtime.json --noEmit && pnpm build:runtime`

- Passed.

`pnpm typecheck`

- Passed.

`git diff --check`

- Passed.

## Blockers

Local network replay specs could not complete in this sandbox:

- `runtime/local-relay-bridge.spec.ts`
- `runtime/local-two-agent.spec.ts`

Both failed with `listen EPERM: operation not permitted 127.0.0.1` while binding a
test listener. This is an environment/network permission blocker, not a compile or
type failure.

## Master verification after lifecycle/source fix

- Added regression coverage for reloading the same config revision after lifecycle state is
  written and the legacy relay JSON is removed.
- `pnpm exec vitest run runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-process.spec.ts --reporter=dot`: 17 tests passed.
- `pnpm exec tsc -p tsconfig.runtime.json --noEmit && pnpm build:runtime`: passed.
- `pnpm typecheck`: passed.
- `git diff --check`: passed.
- GCM implementation and independent review sessions both hit response-stream/network failures;
  no PASS from those sessions is reused. This candidate requires a fresh exact review.

## Exact review and follow-up

- Independent Codex Review task `159b78b-internal-config-review-r2` reviewed the current
  uncommitted candidate and returned `FAIL` with two P1 findings.
- The relative relay TLS path finding was fixed before this candidate: v2 compilation now
  resolves relative `tls.keyFile` and `tls.certFile` against the legacy relay JSON directory;
  the regression test asserts both `internal.toml` and projected relay JSON use those absolute
  paths.
- The projection path safety finding was fixed in the same candidate: `projectLocalChildConfigs`
  now accepts only the exact `.internal/projections/relay.json` and validated daemon projection
  paths derived from `internal.toml`; a regression test proves an outside path is rejected before
  writing.
- Post-fix focused gate: 3 files, 18 tests passed; runtime tsc/build, full typecheck and
  `git diff --check` passed.
- The lifecycle review still reports a P1 evidence blocker: the mapped local bridge replay has
  not completed because this environment rejects `listen` with `EPERM` on `127.0.0.1`. The U0
  candidate remains blocked/awaiting real replay and must not be committed or integrated until
  the exact current candidate is reviewed again with that required evidence.
- Review also reported stale projection cleanup as P2 advisory. It is tracked separately as AppSDK
  issue `b17014d` and remains outside this U0 fix.

## Post-fix exact review

- Independent Codex Review task `159b78b-internal-config-review-r3` inspected the post-fix
  candidate and confirmed the TLS path and projection-path safety fixes; it returned `FAIL` only
  because the mapped real local bridge replay is still unavailable in this environment (P1) and
  retained the stale-projection advisory (P2).
- The candidate therefore remains `blocked`/`awaiting-integration`; no candidate commit, merge,
  push, issue close or U0 completion claim is allowed until the exact current tree has successful
  local replay evidence and a review rerun.

## Replay recovery

- On the current post-fix tree, `pnpm exec vitest run runtime/local-relay-bridge.spec.ts
  runtime/local-two-agent.spec.ts --reporter=dot` passed: 2 files, 2 tests.
- The mapped lifecycle command was then rerun with
  `runtime/local-config.spec.ts`, `runtime/local-supervisor.spec.ts`,
  `runtime/local-process.spec.ts`, and `runtime/local-relay-bridge.spec.ts`: 4 files, 19 tests
  passed.
- Runtime tsc/build, full typecheck and `git diff --check` passed on the same tree. The earlier
  `listen EPERM` is retained as historical evidence only; it is not the current replay result.

## Exact review PASS

- Independent Codex Review task `159b78b-internal-config-review-r4` completed with controller
  verdict `PASS` for the current uncommitted tree, base `3447fc43314d2a517601e988df644660f862eca9`.
- No P0/P1 findings remain. The only finding is P2 stale projection cleanup, already tracked as
  AppSDK issue `b17014d` and excluded from this U0 candidate.
- The review confirms the config.toml → internal.toml → child projection owner boundary, relative
  relay TLS resolution, projection-path confinement, lifecycle persistence and local bridge replay.
