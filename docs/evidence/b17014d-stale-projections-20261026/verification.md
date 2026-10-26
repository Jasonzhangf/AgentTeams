# b17014d stale child projection cleanup

Date: 2026-10-26

## Boundary

- Source worktree: `/Volumes/Intel/playground/agentteams/b17014d-stale-projections-r1`
- Branch: `codex/b17014d-stale-projections-r1`
- Base: `origin/main@846b219e9a883643f8a1ed9b11f766fd767aea3d`
- Scope: `runtime/local-config.ts` and `runtime/local-config.spec.ts`.
- Evidence level: source-only focused test and typecheck evidence. This record makes no merge, push, install, restart, deployed-entrypoint, or delivery claim.

## Change

`projectLocalChildConfigs` now tracks the current relay, console, and enabled
non-orphaned daemon projection paths. It atomically materializes those children
through the existing `materializeEndpoint` owner. It then removes only stale
valid child JSON files inside `resolve(dirname(internalPath), '.internal',
'projections')`. Relay, console, and daemon projection path confinement remains
enforced by `assertProjectionPath`. Disabled and removed daemon intent remains
unchanged; their stale files are removed without materializing them.

## Red before

The final three focused regressions were run against the clean base
implementation, then the fixed source was restored.

```text
removes disabled and removed daemon projections ... × expected true to be false
reconciles only stale child projections ...       × expected true to be false
rejects a current daemon projection path ...      ✓

Tests  2 failed | 1 passed | 40 skipped (43)
```

Raw log: `.worker-runs/b17014d-stale-projections-r1/gcm-r1/red-final.log`.

## Green after

```text
pnpm exec vitest run runtime/local-config.spec.ts \
  -t 'removes disabled and removed daemon projections|reconciles only stale child projections|rejects a current daemon projection path'

Test Files  1 passed (1)
Tests       3 passed | 40 skipped (43)
exit        0
```

Raw log: `.worker-runs/b17014d-stale-projections-r1/gcm-r1/green-final-focused.log`.

## Full focused file

The required exact command was run:

```text
pnpm exec vitest run runtime/local-config.spec.ts
Tests  16 failed | 27 passed (43)
exit   1
```

All three new regressions pass. The 16 failures are pre-existing cases that
call `availableTcpPort()` and stop at `listen EPERM: operation not permitted
127.0.0.1` before their subject assertion in this sandbox. They do not show a
product assertion failure. Raw log:
`.worker-runs/b17014d-stale-projections-r1/gcm-r1/full-focused.log`.

## Static checks

```text
pnpm exec tsc -p tsconfig.runtime.json --noEmit   exit 0
git diff --check                                   exit 0
```

Logs: `.worker-runs/b17014d-stale-projections-r1/gcm-r1/typecheck.log` and
`.worker-runs/b17014d-stale-projections-r1/gcm-r1/diff-check.log`.

## Residual risk

- The full focused file cannot be declared green in this sandbox because 16
  existing tests are blocked by loopback bind permission, not by an assertion
  in the changed behavior.
- Runtime lifecycle and an actual child launch are outside this source-only
  task and were not run.
