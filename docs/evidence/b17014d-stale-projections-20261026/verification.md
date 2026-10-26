# b17014d stale child projection cleanup

Date: 2026-10-26

## Boundary

- Source worktree: `/Volumes/Intel/playground/agentteams/b17014d-stale-projections-r1`
- Branch: `codex/b17014d-stale-projections-r1`
- Base: `origin/main@846b219e9a883643f8a1ed9b11f766fd767aea3d`
- Scope: `runtime/local-config.ts` and `runtime/local-config.spec.ts`.
- Evidence level: source-only focused test and typecheck evidence. This record makes no merge, push, install, restart, deployed-entrypoint, or delivery claim.

## Change

`projectLocalChildConfigs` owns reconciliation of derived child projections. It
tracks the current relay, console, and enabled non-orphaned daemon projection
paths, atomically materializes those children through the existing
`materializeEndpoint` owner, and removes only stale valid child JSON files in
the owned `.internal/projections` directory.

The r2 review fix adds a real-directory check using `lstat` for both
`.internal` and its `projections` child before any materialization and again
before `readdir`/`unlink`. A symbolic-link or non-directory path fails with
`LocalConfigError`. A projection-named directory entry that is a symbolic link
also fails with `LocalConfigError` instead of being silently skipped.

Current internal intent semantics, disabled daemon handling, atomic writes, and
the 10-second bound are unchanged.

## Red before

The r1 red log was produced against the clean base implementation and is copied
into this directory from the r1 run.

```text
removes disabled and removed daemon projections ... × expected true to be false
reconciles only stale child projections ...       × expected true to be false
rejects a current daemon projection path ...      ✓

Tests  2 failed | 1 passed | 40 skipped (43)
```

Raw log: [red-r1-final.log](red-r1-final.log).

The r2 symlink regression was run against r1 commit `f7c3b87` before the review
fix. Reconciliation returned success for the redirected `.internal` path
instead of a typed error, proving the security gap at the cleanup boundary:

```text
does not follow a redirected projection directory ... ×
AssertionError: expected undefined to be an instance of LocalConfigError
Tests  1 failed | 4 passed | 40 skipped (45)
```

The direct-removal regression passed on r1 because its existing
`orphaned === true` skip already prevented recreation. That case remains a
regression guard for the reviewed contract.

Raw log: [red-r2.log](red-r2.log).

## Green after

```text
pnpm exec vitest run runtime/local-config.spec.ts \
  -t 'removes disabled and removed daemon projections|reconciles only stale child projections|rejects a current daemon projection path|does not follow a redirected projection directory|removed daemon projection'

Test Files  1 passed (1)
Tests       5 passed | 40 skipped (45)
exit        0
```

The symlink case covers a redirected `.internal` parent, a redirected
`projections` directory, and a symbolic-link matching projection entry. Each
case asserts `LocalConfigError` and verifies that the external matching JSON
file remains unchanged. The direct-removal case starts with an enabled receiver
projection, removes the receiver directly from user intent, removes its old
owned projection, and runs reconciliation again to prove it is not recreated.

r1 green log: [green-r1-focused.log](green-r1-focused.log).

r2 green log: [green-r2-focused.log](green-r2-focused.log).

## Full focused file

The required exact command was rerun in this r2 environment:

```text
pnpm exec vitest run runtime/local-config.spec.ts
Tests  16 failed | 29 passed (45)
exit   1
```

All five focused cases pass. The 16 failures are existing cases that bind
loopback through `availableTcpPort()` and stop at
`listen EPERM: operation not permitted 127.0.0.1` in this sandbox. This is the
same preserved blocker as r1, not a product assertion introduced by this
change.

Raw log: [full-r2-focused.log](full-r2-focused.log). The original r1 full-file
log is also available as [full-r1-focused.log](full-r1-focused.log).

## Static checks

```text
pnpm exec tsc -p tsconfig.runtime.json --noEmit   exit 0
git diff --check                                   exit 0
```

Logs: [typecheck-r2.log](typecheck-r2.log),
[diff-check-r2.log](diff-check-r2.log). The original r1 static-check logs are
also local: [typecheck-r1.log](typecheck-r1.log),
[diff-check-r1.log](diff-check-r1.log).

## Residual risk

- The full focused file cannot be declared green in this sandbox because 16
  existing tests are blocked by loopback bind permission. The master can rerun
  the same command in an environment that permits that bind.
- Runtime lifecycle and an actual child launch are outside this source-only
  task and were not run.
