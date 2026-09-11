# V1 integration receipt

- delivery unit: `v1-cross-host-live-20260911`
- integration worktree: `/Volumes/extension/code/AgentTeams/playground/integration-v1-cross-host-20260911`
- base: `origin/main@498dbb29ae05b4d1c99ca1d3bbbe68287c2bd6fa`
- integrated candidate before this receipt: `1b5b22a0a31fb5d1d58ef9603e18cccafbc8d8f4`
- integrated tree before this receipt: `9c0a1a1d65982fb7cb0b4a3835bede540023f5ed`
- worker candidate commit: `36ac55f`
- result: blocker receipt integrated; real cross-host acceptance remains blocked

## Integration

The V1 blocker receipt was cherry-picked onto a clean worktree from the latest
remote main. It contains evidence only; no runtime, network, relay, provider,
consumer, or configuration source changed.

The isolated worktree installed its locked dependencies offline from the local
package store:

```text
Lockfile is up to date, resolution step is skipped
Packages: +97
reused 97, downloaded 0
Done in 944ms using pnpm v10.31.0
```

## Verification

Passed:

```text
pnpm typecheck
appsdk guide compile
appsdk compile
appsdk verify
git diff --check
```

`appsdk compile` produced artifact hash:

```text
sha256:070d65aebacaf47907519618a01a71cf022a6c20d63482d38f603fe25c91414d
```

The full regression reached the runner and retained the local environment
boundary:

```text
123 suites total; 116 passed; 7 failed
420 tests total; 384 passed; 36 failed
```

The failures are local listener permission/startup-timeout paths. The packaged
Console smoke passed its authenticated UI/API and Session JSON checks. Runtime
smoke was stopped after the local TLS listener remained blocked; it produces no
provider, Relay, NAT, or cross-device acceptance evidence.

The V1 receipt remains explicitly `BLOCKED`: no current-SHA Relay login,
directory discovery, capability match, Agent Work, ledger readback, restart
generation replay, or real coder2new NAT result is claimed. The RCC provider
listener and live provider acceptance remain unobserved.

## Cleanup

Integration-only dependencies, generated output, and smoke temporary state will
be removed before the integration worktree is deleted. No remote service or
daemon was started by this integration unit.
