# U2 776fcad target/path validation worktree notes

Primary packaging note: raw command logs are losslessly stored as `.log.gz`.
The logical `.log` names below map to the physical archive paths in
`raw-log-archive.json`; decompression restores the original bytes. No output
was stripped. The 40-character product/evidence hashes below are Git blob
identities, not SHA256. Primary SHA256 readback for all seven frozen changed
paths is preserved externally, and all seven remain byte-identical to the
frozen repair author. The final staged tree includes only additional evidence;
its identity is recorded externally after staging, not in its own source.

Worker identity: fresh validation worker, reported to Desktop primary. No Collab/TUI/builtin subagents/AGY/model investigation/global memory used.

Tree: `/Volumes/Intel/playground/agentteams/u2-target-validation-20261004`
Branch: `codex/u2-target-validation-20261004`; HEAD/base `dd4ffa9075b1fbc215e99070147865b4fa1495bb`
Staged frozen candidate tree: `dcd99fc1606a875cacd78c9d0285fdee75a48a46` (`git write-tree`)

Product/evidence hashes:

- `config/runtime-config.ts`: `257db381b0da20438f91bb2b14a590095caae6dd`
- `config/runtime-config.spec.ts`: `d3ed818ec56ddd7503474914931bde959eb3c78f`
- `runtime/agent-process.ts`: `1b9baee1b3988e92185908b14bb2e7096b3ae79b`
- `runtime/local-config.ts`: `945253250103a40a2aa1888ef55f50b4ea2d5e5d`
- `runtime/local-config.spec.ts`: `9f4ee9d0f2b7f98daec28ee67613c49a21babd22`
- `runtime/local-process.ts`: `9414cbe24e105b6cb0b3f5dd72a2661242b2de6a`
- `runtime/local-supervisor.ts`: `7489e375c173a40c341540e05651cc15456c01fb`

Build fingerprint (generated/runtime-lib): `8b3f6c2faa25b76354c89968018fa1fabdcbbf3681f5e45aefc435f1e078ac3d`
Inherited consumer hash: `e03feb22633d071717c48b7d3235be9a17c82197`
New consumer hash: `5bab035ee871ba035c0a70eb1cb5d6cd29811a00`

## Commands and raw results

### 1. Focused gate

Time: `2026-10-04T09:47:39Z` to `2026-10-04T09:47:41Z`; exit `0`.

Command: `pnpm exec vitest run runtime/local-config.spec.ts config/runtime-config.spec.ts runtime/managed-config-owner.spec.ts runtime/agent-process-config.spec.ts`
Result: 4 files, 55 tests, all passed.
Evidence: `focused.log`

### 2. Mapped regression gate

Time: `2026-10-04T09:47:46Z` to `2026-10-04T09:47:55Z`; exit `0`.

Command: `pnpm exec vitest run runtime/local-process.spec.ts runtime/local-supervisor.spec.ts runtime/agent-process.spec.ts runtime/managed-config-live.spec.ts runtime/console-config.spec.ts config/config-boundary.spec.ts cli/agentteams.spec.ts`
Result: 7 files, 42 tests, all passed.
Evidence: `regression.log`

### 3. Typecheck and runtime build

Time: `2026-10-04T09:48:01Z` to `2026-10-04T09:48:12Z`; both exit `0`.

Commands:

- `pnpm typecheck`
- `pnpm build:runtime`

Evidence: `typecheck.log`, `build-runtime.log`

### 4. Config graph validation

Time: `2026-10-04T09:48:25Z`; exit `0`.

Graphs validated:

- `docs/design/dagpipe/graphs/provider-config.graph.json` (`agentteams.provider-config`)
- `docs/design/dagpipe/graphs/console-observe.graph.json` (`agentteams.console-observe`)

No other guessed graph names were used. Evidence: `graph-validation.log`

### 5. Canonical AppSDK compile and verify

Time: `2026-10-04T09:48:32Z` to `2026-10-04T09:48:42Z`.

Commands:

- `$HOME/.cargo/bin/appsdk compile .`; exit `0`
- `$HOME/.cargo/bin/appsdk verify .`; exit `0`, `command_ok:true`, `development_ready:true`, `delivery_assessed:false`, `ok:false`, `reason:"delivery_not_evaluated"`

`appsdk --version` is unsupported by the installed CLI (usage text, exit `1`). That is tool metadata, not the compile/verify gate.
Evidence: `appsdk-compile.log`, `appsdk-verify.log`, `appsdk-version.log`

### 6. Inherited real recovery consumer

Time: `2026-10-04T09:48:49Z` to `2026-10-04T09:48:57Z`; exit `0`.

Command: `node docs/evidence/776fcad-u2-recovery-live-20261004/real-consumer.mjs`
Result: `SUMMARY total=27 pass=27 fail=0`; `RESULT {"ok":true,"assertions":27}`. Agent/daemon and OpenCode cleaned by harness.
Evidence: `recovery-consumer.log`

### 7. New public passed-env/custom-source consumer

First failed harness run (before the harness created its per-case directory): `2026-10-04T09:57:55Z` to `2026-10-04T09:57:56Z`, exit `1`, error `ENOENT .../passed-env/config.toml`. Raw preserved in `public-env-first-error.log`. This was a harness bug, not a product failure.

Corrected run: `2026-10-04T10:00:07Z` to `2026-10-04T10:00:10Z`; exit `0`.

Command: `node docs/evidence/776fcad-u2-target-validation-20261004/public-env-consumer.mjs`
Result: `SUMMARY total=31 pass=31 fail=0`; `RESULT {"ok":true,"assertions":31}`.
Evidence: `public-env-consumer.mjs`, `public-env-consumer.log`

Coverage:

- Passed env with custom `TEAMS_LOCAL_CONFIG_PATH`/`TEAMS_LOCAL_INTERNAL_PATH`; `process.env` unchanged; ambient default path untouched.
- Machine TOML with bearer provider first and auth-none provider second; binding targets auth-none; real daemon start, real OpenCode serve, public Console apply succeeds, effective clean.
- Wrong fingerprint rejected `APPLY_TARGET_MISMATCH`; internal/config bytes unchanged.
- Corrupt persisted relay projection and invalid port both reject public `loadLocalConfig` and `startLocalProcess`; config/internal bytes unchanged; no launcher child spawn marker.
- Real `startLocalProcess` v2 fixture confirms resolved `TEAMS_LOCAL_CONFIG_PATH` and `TEAMS_LOCAL_INTERNAL_PATH` are forwarded into the child.

Not claimed:

- Occupied port policy from the live launcher was not fabricated or tested.
- Full v3 service decoder/startup (`U3`) was not modified or claimed; this uses the compiled daemon boundary plus genuine TOML source, consistent with the recovery consumer pattern.

## Resource cleanup

- Harness finally removed its temp directory for both successful and failed runs.
- Check for `/tmp/u2-public-env-*` and `/tmp/u2-recovery-live-*`: none present after the pass.
- No stray `opencode serve --pure` or harness processes were listed after the pass.

## Not done

- No commit, merge, push, review, close-bug, or product-source edit.
- Only new evidence under `docs/evidence/776fcad-u2-target-validation-20261004/` was created; inherited product and evidence were preserved.
