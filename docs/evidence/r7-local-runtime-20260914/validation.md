# r7 local-runtime delivery unit validation (20260914)

Owner: runtime (local-config / local-process). Scope: implement the runtime owner change
exposed by the retired L1 review, without touching `cli/agentteams.mjs`.

## Candidate identity

- Worktree: `playground/r7-local-runtime-20260914`, branch `codex/r7-local-runtime-20260914`.
- Base: `origin/main` = `69a3e4b3d0d9986a6640e892562ba51116e6db9c` (HEAD, clean worktree at
  start; no local commits ahead of base).
- Changed paths (scoped): `runtime/local-config.ts`, `runtime/local-config.spec.ts`,
  `runtime/local-process.ts`, `runtime/local-process.spec.ts`, this evidence file.

## Delivered changes (minimal diff)

1. `writeLocalConfig(path, text, { exclusive: true })` now creates the config with a
   kernel-exclusive `open(configPath, 'wx', 0o600)` and writes into that handle, so an
   existing file is rejected atomically with the raw `EEXIST` error and is never replaced.
   The failure-path cleanup unlinks only a file this call had actually created (the handle
   exists), so it cannot remove a pre-existing config. The default (non-exclusive) path keeps
   the previous atomic temp-file + `rename` replace semantics.
2. `runLocalConfiguredWork(configPath, env, options)` now accepts
   `LocalProcessStartOptions` and forwards them to the implicit `startLocalProcess` call, so
   when the launcher is not running, the implicit start uses the caller-supplied
   `relayEntry` / `agentEntry` / `nodeArguments` / `nodeExecutable` / `startupTimeoutMs`.
   Explicit `options.env` overrides the default `env` argument for the same keys.
3. Focused regression: exclusive write preserves the first file and rejects the second;
   configured Work implicit start forwards the explicit start options.

No fallback, no silent strip, no dual path; CLI is intentionally untouched.

## Checks

Environment note: this sandbox had no `node_modules`, no `ps`, and no DNS access to the npm
registry. Dependencies were linked with the machine's existing pnpm store copied to a
writable temp store; no committed dependency/lock changes.

```text
pnpm exec vitest run runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-process.spec.ts runtime/local-relay-bridge.spec.ts
  Test Files  2 failed | 2 passed (4)
  Tests       7 failed | 23 passed (30)
  PASS  runtime/local-config.spec.ts        15/15  (includes new exclusive-write regression)
  PASS  runtime/local-supervisor.spec.ts    all
  PASS  runtime/local-process.spec.ts > forwards explicit start options through the implicit configured Work start
  ENV-BLOCKED (7): 6 runtime/local-process.spec.ts detached/ps-dependent tests + 1
        runtime/local-relay-bridge.spec.ts listener test. Exact errors below.

pnpm exec tsc -p tsconfig.runtime.json --noEmit   => exit 0, no output
pnpm build:runtime                                => exit 0
pnpm typecheck                                    => exit 0 (opencode-adapter build + root/adapter/console/ui tsc)
appsdk compile                                    => stage source_implemented; source_hash sha256:3849f3c6f5d3b5178251aa3fb7f6095bb6d3c04fc3f35107f8950c5184cf1f60
appsdk verify                                     => {"ok":true,"project_id":"agentteams","stage":"contract_bound"}
git diff --check                                  => clean (no whitespace errors)
```

### Exact blocking conditions (not fabricated as pass)

- `runtime/local-relay-bridge.spec.ts > replays a config-driven local Relay bridge across
  independent daemon processes`:
  `Error: listen EPERM: operation not permitted 127.0.0.1` — loopback listener creation is
  denied by the sandbox.
- Six `runtime/local-process.spec.ts` detached-launcher tests fail with
  `LocalProcessError: local supervisor did not reach running: {...,"state":"running"}`
  (`code: 'START_TIMEOUT'`). Root cause is the same sandbox restriction: `startLocalProcess`
  readiness calls `processOwnsStartToken`, which runs `ps`, and `ps` is denied
  (`zsh:1: operation not permitted: ps` observed directly). `processCommand` returns
  `undefined`, ownership cannot be proven, and readiness times out. This is an environment
  restriction, not a semantic regression; existing test count/host behavior is unchanged
  because this unit touches only `writeLocalConfig` options and `runLocalConfiguredWork`
  forwarding.

### Test-design note (honesty)

The task asked to validate option forwarding "where existing test can validate". The existing
`persists configured Work receipts across detached restart generations` test cannot validate
forwarding of `source relayEntry/agentEntry/nodeArguments`, because it starts the launcher via
an explicit `startLocalProcess(path, options)` and then relies on that same stuck `ps`
readiness path. A fully successful end-to-end variant therefore cannot run in this sandbox.
The added regression instead proves the forwarding contract deterministically and
`ps`-independently: `runLocalConfiguredWork(path, {}, explicitOptions)` forces the implicit
start, and the recorded child launcher environment contains the explicit
`TEAMS_LOCAL_RELAY_ENTRY`, `TEAMS_LOCAL_AGENT_ENTRY`, and `TEAMS_LOCAL_NODE_ARGUMENTS`.

## Review status

Not yet independently reviewed. Commit, integration, push, memory promotion and cleanup remain
pending their own receipts. CLI facade (`cli/agentteams.mjs`) is explicitly out of scope for
this unit and is expected to be built after this runtime receipt.

## Candidate commit attempt

`git add runtime/local-config.ts runtime/local-config.spec.ts runtime/local-process.ts
runtime/local-process.spec.ts docs/evidence/r7-local-runtime-20260914/validation.md` was
attempted and rejected by the sandbox at the Git index lock boundary:

```text
fatal: Unable to create '/Volumes/extension/code/AgentTeams/.git/worktrees/r7-local-runtime-20260914/index.lock': Operation not permitted
```

No commit was created and no index state was changed. The candidate remains as an uncommitted
scoped worktree diff; integration/push are not attempted.
