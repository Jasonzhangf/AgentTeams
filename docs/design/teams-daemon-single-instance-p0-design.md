# Teams P0 Detailed Design & Architectural Review: Daemon Single-Instance Convergence & BB13 Clean-Clone Fix

- **Date**: 2026-10-27
- **Author**: `David` (`architect`)
- **Target Orchestrator**: `Jenny` (`master`)
- **Reviewed Worktree**: `/Volumes/Intel/playground/agentteams/daemon-single-instance-p0` (branch `codex/daemon-single-instance-p0`)
- **Scope**:
  1. P0 User Directive: Single-instance convergence on daemon startup (`SIGTERM` graceful stop -> `SIGKILL` hard kill on timeout, with strict PID + ownership verification).
  2. Root-cause diagnosis and deterministic fix for `BB13 clean2` (`runtime/control-process.spec.ts` 8 tests timing out in fresh `git clone` fixture).

---

## 1. Executive Verdict on `/Volumes/Intel/playground/agentteams/daemon-single-instance-p0`

- **Review Status**: **CHANGES REQUIRED Before Integration**
- **What Is Already Solid (`PASS`)**:
  1. `runtime/local-ownership.ts` (`terminateProcess(pid, { gracefulMs, hardMs })`, lines 52-74) and `runtime/local-ownership.spec.ts`: cleanly implements explicit-PID `SIGTERM` polling followed by `SIGKILL` escalation and returns `'exited' | 'killed' | 'unresponsive'`. Never uses forbidden `pkill` or `killall`.
  2. `runtime/control-process.ts` (lines 369-377, 472-478) and `runtime/registry-process.ts` (lines 374-382, 475-481): `startControlDaemon` and `startRegistryDaemon` verify `processOwnsControlToken` / `processOwnsRegistryToken` (failing with `STALE_OWNER` on PID reuse so an unrelated process is never signaled), terminate the previous live instance via `terminateProcess(previous.pid, { gracefulMs: 5_000, hardMs: 2_000 })`, and increment `generation = (previous?.generation ?? 0) + 1`.
- **4 Required Changes Before Candidate Gate & Integration**:
  1. **[P0 Blocker — Missed v4 Daemon Kind] `runtime/acp-serve.ts` (`agent` daemon `--serve <opencode|dsh>`) lacks single-instance convergence**:
     - Each v4 config declares one of three daemon kinds: `agent`, `control`, or `registry`. `control` and `registry` now replace a running instance on start, and legacy `local-process.ts` replaces its supervisor, but `runtime/acp-serve.ts` (`startAcpServe`) has no runtime state/PID record in `agent.daemon.dataDirectory`.
     - Worse: if a second `startAcpServe` starts on the same `dataDirectory` while the first is live, either it binds a second ephemeral port (`port = 0`) and runs a duplicate daemon sharing `acp-history.sqlite` / intent watermarks, or it fails on `EADDRINUSE` and executes `removeOwnedDirectory()` (`runtime/acp-serve.ts:1845`), which deletes `join(dataDirectory, 'engine')` out from under the live first daemon.
  2. **[P0 Blocker — Black-Box Regression] `scripts/blackbox-user-mvp.mjs:6399-6415` (`BB14`) and `runtime/local-process.spec.ts:159-175` still assert old `ALREADY_RUNNING` behavior**:
     - `runBB14` runs a duplicate `agentteams start --config ...` with `expectNonZero: true`, asserts `/already running|ALREADY_RUNNING/iu`, and asserts `parsedBeforeStop.generation === lifecycle.parsed.generation`. With `startLocalProcess` now replacing the old launcher, `BB14` will fail unless updated to assert single-instance replacement (`generation` increments, old PID exits, new PID is live).
  3. **[P1 Edge Case] `runtime/local-process.ts:341-346` skips `stopRetainedConsoleRuntime` when `previous.state === 'stopped'`**:
     - If the launcher state is `'stopped'` (or after `recoverDeadLauncher`) while `current.consoleRuntime` still holds a live retained Console child PID, `startLocalProcess` does not call `stopRetainedConsoleRuntime(config, current)`, leaving the retained Console child occupying the Console port (`CONSOLE_PORT_OCCUPIED`).
  4. **[P0 Blocker — Architecture Map & `BB13` Build Script Drift]**:
     - `package.json:27` `"test"` runs `pnpm build:runtime && pnpm --dir opencode-adapter build && node scripts/regression.mjs` without building `console-host` or `ui/teams-console`. In `BB13`'s fresh `git clone`, `ui/teams-console/lib/browser.js` does not exist during `pnpm test`, causing all 8 tests in `runtime/control-process.spec.ts` to fail/time out waiting for the control child!
     - The architecture maps (`docs/architecture/mainline-call-map.json`, `function-map.json`, `module-registry.json`, `verification-map.json`) and `docs/development-governance.md` still state `"refuses a second start with a typed ALREADY_RUNNING"`.

---

## 2. Root Cause & Deterministic Fix for `BB13 clean2` (`control-process.spec.ts` Timeout)

### 2.1 Exact Root Cause Chain
1. `runBB13` (`scripts/blackbox-user-mvp.mjs:6267-6330`) runs `git clone` into a fresh `fixtureRoot` in `tmpdir()`, links `node_modules`, and runs `pnpm verify` (`scripts/blackbox-user-mvp.mjs:6288`).
2. `package.json:36` defines:
   ```json
   "verify": "pnpm test && pnpm typecheck && node scripts/appsdk.mjs guide compile && node scripts/appsdk.mjs compile && pnpm smoke && node scripts/appsdk.mjs verify"
   ```
3. `package.json:27` defines:
   ```json
   "test": "pnpm build:runtime && pnpm --dir opencode-adapter build && node scripts/regression.mjs"
   ```
4. Notice that `"test"` does **not** run `pnpm --dir console-host build` or `pnpm --dir ui/teams-console build`!
5. In the main workspace or an existing worktree where `pnpm build` was previously run, `ui/teams-console/lib/browser.js` and `console-host/lib/index.mjs` already sit on disk (gitignored), so `pnpm exec vitest run runtime/control-process.spec.ts` passes in `1.2s`.
6. In `BB13`'s fresh `git clone` (`fixtureRoot`), `ui/teams-console/lib/browser.js` does not exist when `pnpm test` runs first inside `pnpm verify`. When `runtime/control-process.spec.ts` calls `startControlDaemon`, the child checks `presentationRoots()` (`runtime/control-process.ts:288-296`, requiring `ui/teams-console/lib/browser.js`), fails startup, and causes the 8 tests in `runtime/control-process.spec.ts` to fail!

### 2.2 Required Fix (`package.json`)
- **Owner**: `package.json` (lines 27-28)
- Change `"test"` and `"prepack"` so all workspace packages required by runtime tests (`opencode-adapter`, `console-host`, `ui/teams-console`, and `runtime`) are built before `scripts/regression.mjs`:
  ```json
  "test": "pnpm build && node scripts/regression.mjs",
  "prepack": "pnpm build",
  ```

---

## 3. Detailed Design for Complete Daemon Single-Instance Convergence

### 3.1 Invariant & Ownership Contract
- **Invariant**: One daemon config / one `dataDirectory` (or `internalPath` for the legacy local launcher) owns at most one live runtime instance at any time.
- **Startup Convergence Sequence**:
  1. Read the persisted runtime ownership record in the daemon's owned `dataDirectory` / `internalPath`.
  2. If a previous PID is recorded and `processAlive(pid)` is true:
     - Verify ownership of `pid` using the persisted `startToken` / `entryPath` / `configPath` (`processCommand(pid)`).
     - If `pid` belongs to an unrelated process (PID reuse), fail explicitly with `STALE_OWNER` and **never** signal the unrelated PID.
     - If ownership is verified, call `terminateProcess(pid, { gracefulMs, hardMs })`:
       - Send `SIGTERM` and poll `processAlive(pid)` every `25ms` up to `gracefulMs`.
       - If still alive after `gracefulMs`, send `SIGKILL` and poll up to `hardMs`.
       - If still alive after `SIGKILL`, fail explicitly with `STOP_TIMEOUT` / `ENGINE_UNAVAILABLE`.
  3. Advance `generation = (previous?.generation ?? 0) + 1` and start the new instance.

### 3.2 Change 1: `runtime/acp-serve.ts` (`agent` Daemon Single-Instance Convergence)
- **Owner**: `runtime/acp-serve.ts`
- **Problem**:
  - `startAcpServe` (`runtime/acp-serve.ts:1400`) spawns an engine child (`daemon.handle.pid`) and binds local/LAN channels using `dataDirectory = resolve(agent.daemon.dataDirectory)` and `ownedDirectory = join(dataDirectory, 'engine')`, without checking or stopping any prior `acp-serve` instance on the same `dataDirectory`.
- **Design**:
  1. Define the state file path in `dataDirectory`:
     ```ts
     const SERVE_STATE_FILE = 'agent-serve-state.json'
     export function acpServeStatePath(dataDirectory: string): string {
       return join(resolve(dataDirectory), SERVE_STATE_FILE)
     }
     ```
  2. Track in-process handles per `dataDirectory` for programmatic callers/tests that call `startAcpServe` multiple times within the same `process.pid`:
     ```ts
     const activeInProcessServes = new Map<string, () => Promise<unknown>>()
     ```
  3. Define the persisted state record:
     ```ts
     interface PersistedAcpServeState {
       readonly version: 1
       readonly agentId: string
       readonly daemonPid: number
       readonly enginePid: number
       readonly engineInstanceId: string
       readonly dataDirectory: string
       readonly configPath: string | null
     }
     ```
  4. At the beginning of `startAcpServe(intent, options)` (right after `await mkdir(dataDirectory, { recursive: true, mode: 0o700 })` at line 1421, **before** creating or touching `ownedDirectory = join(dataDirectory, 'engine')`):
     - First, if `activeInProcessServes.has(dataDirectory)` (same `process.pid` programmatic/test caller), await `activeInProcessServes.get(dataDirectory)!()` and delete the entry.
     - Next, read `<dataDirectory>/agent-serve-state.json` if it exists:
       - If `previous.daemonPid > 0 && previous.daemonPid !== process.pid && processAlive(previous.daemonPid)`:
         - Check `const cmd = await processCommand(previous.daemonPid)`. Verify `cmd !== undefined` and (`cmd.includes('--serve')` or `cmd.includes(dataDirectory)` or `(previous.configPath !== null && cmd.includes(previous.configPath))`). If not matched, throw `new AcpError('ENGINE_UNAVAILABLE', \`existing daemonPid=${previous.daemonPid} does not match agent ${agent.daemon.id} ownership\`)`.
         - Call `const term = await terminateProcess(previous.daemonPid, { gracefulMs: stopTimeoutMs, hardMs: 2_000 })`. If `term === 'unresponsive'`, throw `new AcpError('ENGINE_UNAVAILABLE', \`previous agent daemon pid=${previous.daemonPid} did not exit after SIGTERM and SIGKILL\`)`.
       - Next, check `previous.enginePid`: if `previous.enginePid > 0 && previous.enginePid !== process.pid && processAlive(previous.enginePid)` (for example, if the previous `daemonPid` exited abnormally or was killed before reaping its engine child):
         - Check `const engineCmd = await processCommand(previous.enginePid)`. Verify `engineCmd !== undefined` and (`engineCmd.includes(executable)` or `engineCmd.includes(ownedDirectory)` or `engineCmd.includes(dataDirectory)`).
         - Call `const engineTerm = await terminateProcess(previous.enginePid, { gracefulMs: stopTimeoutMs, hardMs: 2_000 })`. If `engineTerm === 'unresponsive'`, throw `new AcpError('ENGINE_UNAVAILABLE', \`previous engine child pid=${previous.enginePid} did not exit after SIGTERM and SIGKILL\`)`.
       - Remove `<dataDirectory>/agent-serve-state.json` (`await rm(statePath, { force: true })`).
  5. Immediately after `const daemon = outcome.daemon` (line 1497), write `<dataDirectory>/agent-serve-state.json` atomically (`mode: 0o600`) with `{ version: 1, agentId: agent.daemon.id, daemonPid: process.pid, enginePid: daemon.handle.pid, engineInstanceId, dataDirectory, configPath: intent.configPath }`.
  6. Register `activeInProcessServes.set(dataDirectory, stop)` when returning the handle, and in both `stop()` (line 1768) and the startup failure `catch` block (line 1845), delete `activeInProcessServes.get(dataDirectory)` (if it matches `stop`) and remove `<dataDirectory>/agent-serve-state.json` (`await rm(statePath, { force: true }).catch(() => undefined)`).
  7. Add a unit test in `runtime/acp-serve.spec.ts` proving that starting a second `startAcpServe` on the same `dataDirectory` stops the first instance (and its `enginePid`) cleanly and serves on the new instance without deleting the new instance's `ownedDirectory`.

### 3.3 Change 2: `runtime/local-process.ts` Retained Console Cleanup on Start
- **Owner**: `runtime/local-process.ts` (lines 340-347)
- **Required Change**:
  In `startLocalProcess` (`runtime/local-process.ts:340-347`), ensure that even if `previous === undefined` or `previous.state === 'stopped'`, any retained Console child recorded in `current.consoleRuntime` is stopped before spawning the new launcher generation:
  ```ts
  const current = await readLocalInternalConfig(config.internalPath!)
  const previous = current.launcher
  if (previous !== undefined && previous.state !== 'stopped') {
    // A start replaces the previous launcher generation for this config. Recovery
    // owns the graceful stop and its explicit-PID SIGKILL fallback.
    await recoverDeadLauncher(config.internalPath!, config.configPath, current, previous, 'stopped', config.console?.configPath)
  } else {
    await stopRetainedConsoleRuntime(config, current)
  }
  ```

### 3.4 Change 3: Update `scripts/blackbox-user-mvp.mjs` (`BB14`) & `runtime/local-process.spec.ts`
- **Owner**: `scripts/blackbox-user-mvp.mjs` (lines 6397-6416) and `runtime/local-process.spec.ts` (lines 159-175)
- **Required Change in `scripts/blackbox-user-mvp.mjs:6397-6416` (`runBB14`)**:
  Replace the old `ALREADY_RUNNING` assertion with the single-instance replacement assertion:
  1. Capture the initial `firstLifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb14')`.
  2. Run `const duplicate = runChecked(fixture.cli, ['start', '--config', fixture.configPath], { cwd: fixture.temporaryRoot, env: fixture.env, logPath: join(evidenceDir, 'bb14-duplicate-start.json') })`.
  3. Assert ` !processAlive(firstLifecycle.parsed.pid) ` (the first launcher PID was stopped when the second `start` converged).
  4. Run `statusBeforeStop` and assert:
     - `parsedBeforeStop.state === 'running'`
     - `parsedBeforeStop.generation === firstLifecycle.parsed.generation + 1`
     - `parsedBeforeStop.pid !== firstLifecycle.parsed.pid && processAlive(parsedBeforeStop.pid)`
  5. Re-read `lifecycle` for generation 2 (or update `lifecycle.parsed = parsedBeforeStop` and `lifecycle.internal = readInternalFacts(fixture)`) before calling `stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb14')`.
- **Required Change in `runtime/local-process.spec.ts:159-175`**:
  Test calling `startLocalProcess` directly while `first` is in `state: 'running'` (without first overwriting `state: 'failed'`), verifying that `firstLauncher.pid` is terminated and `second` reaches `state: 'running', generation: 2`.

### 3.5 Change 4: Update Architecture Maps & Governance Table
- Update the 4 architecture maps and `docs/development-governance.md` in the same commit:
  1. `docs/architecture/mainline-call-map.json` (line 35)
  2. `docs/architecture/function-map.json` (line 2082)
  3. `docs/architecture/module-registry.json` (line 239)
  4. `docs/architecture/verification-map.json` (line 1097)
  5. `docs/development-governance.md` (line 154)

---

## 4. Verification Plan & Acceptance Gates

1. **Focused Unit & Gate Specs**:
   ```bash
   pnpm exec vitest run --no-file-parallelism \
     runtime/local-ownership.spec.ts \
     runtime/control-process.spec.ts \
     runtime/registry-process.spec.ts \
     runtime/local-process.spec.ts \
     runtime/acp-serve.spec.ts \
     cli/agentteams.spec.ts
   ```
2. **Real Black-Box Entrypoints**:
   - `node docs/evidence/acp-d06-control-20261011/black-box-control.mjs`
   - `node scripts/blackbox-user-mvp.mjs --scenario BB13` (verifies fresh-clone `pnpm verify` with `"test": "pnpm build && node scripts/regression.mjs"`)
   - `node scripts/blackbox-user-mvp.mjs --scenario BB14` (verifies single-instance replacement on second `agentteams start`)
3. **Full Repository Gate**:
   - `pnpm verify`

---

## 5. Follow-Up Review of `6298d91` & Architectural Decision on BB13 Engine Initialize Budget (2026-10-28)

### 5.1 Architectural Review of `6298d91` (`codex/daemon-single-instance-p0`)
- **Single-Instance Implementation Verdict**: **PASS**
  - All 4 previously required items (`package.json` `"test": "pnpm build && node scripts/regression.mjs"`, `runtime/acp-serve.ts` single-instance convergence with `agent-serve-state.json` + `agent-serve-state.lock` + `daemonStart`/`engineStart` ownership verification + retained-engine failure recording, `runtime/local-process.ts` retained Console cleanup + `BB14` replacement black-box check, and the 5 `docs/architecture/*.json` + `docs/development-governance.md` updates) are cleanly implemented and verified (`74/74` source gate, `black-box-serve-replacement.mjs` PASS, `BB14` PASS, and `1652/1654` in `BB13` with all `8/8` `control-process.spec.ts` passing).

### 5.2 Architectural Decision on BB13 Real OpenCode Engine `initialize` Timeout
- **Selected Direction**: **Option 1 — Raise the real-engine bootstrap `initialize` timeout budget from `20_000ms` to `45_000ms` (or `60_000ms`) in the two owning surfaces**:
  1. `runtime/acp-serve.ts:125`:
     Change `const DEFAULT_INITIALIZE_TIMEOUT_MS = 20_000` to `const DEFAULT_INITIALIZE_TIMEOUT_MS = 45_000` (or `60_000`).
  2. `opencode-adapter/tests/acp-engine.real.spec.ts:147`:
     Change `initialize: { params: { protocolVersion: 1, clientCapabilities: {} }, timeoutMs: 20_000 }` to `timeoutMs: 45_000` (or `60_000`).
- **Rationale**:
  - `scripts/regression.mjs:14` already executes Vitest with `--no-file-parallelism` (1 file at a time), so Option 3 (reducing file parallelism) is already at its floor (`1`).
  - In both `opencode-adapter/tests/acp-engine.real.spec.ts` and `runtime/acp-serve.spec.ts`, the test timeouts (`90_000ms` / `120_000ms`), the frame wait timeouts (`awaitFrame(..., 60_000)`), and `SERVE_START_LOCK_TIMEOUT_MS` (`60_000ms`) are already sized for cold real-engine I/O under full-suite execution; only the bootstrap `initialize` timeout (`20_000ms`) was left at a tighter bound that a cold `/Users/fanzhang/.opencode/bin/opencode acp` launch (Bun runtime + fresh `tmpdir` SQLite DB migration + plugin load) exceeds (`21s–35s`) during a full `BB13` run.
  - All fake-engine unit tests (`runtime/acp-daemon.spec.ts:93` with `5_000ms`, `runtime/acp-serve.spec.ts` with `15_000ms`) pass explicit `initializeTimeoutMs` overrides, so raising the default to `45_000ms` (or `60_000ms`) affects only real-engine cold start without slowing down any fake-engine or negative-timeout test.
- **Acceptance Condition for Final Closure**:
  - Apply the `45_000ms` (or `60_000ms`) `initialize` timeout update in `runtime/acp-serve.ts:125` and `opencode-adapter/tests/acp-engine.real.spec.ts:147`.
  - In `runtime/console-process.spec.ts` (all 9 `rm(..., { recursive: true, force: true })` cleanup calls in `finally` blocks, lines 96, 129, 153, 194, 198, 214, 236, 263, 280), add `maxRetries: 5, retryDelay: 50` (matching `runtime/acp-serve.ts:1677`) to eliminate the macOS `rmdir` `ENOTEMPTY` teardown race when child sockets close asynchronously.
  - Run `BB13` once (`node scripts/blackbox-user-mvp.mjs --case BB13 ...`) to confirm `exit 0` (`1654/1654` passed), then integrate to `main`.

### 5.3 Final Sign-Off on `621f0ed` (`PASS`)
- **Candidate**: `621f0ed` (`origin/codex/daemon-single-instance-p0`, tree `d448891`)
- **Verification Evidence**:
  - Source gate `74/74` PASS (`exit 0`), `tsc --noEmit` PASS (`exit 0`), `runtime/console-process.spec.ts` `8/8` PASS (`2.6s`).
  - `black-box-serve-replacement.mjs`: PASS (`exit 0`).
  - `BB14`: PASS (`exit 0`).
  - `BB13` clean clone (`bb13-final2-receipt.json`): PASS (`exit 0`).
- **Final Architect Review Verdict**: **PASS — Approved for Integration to `main`**.


