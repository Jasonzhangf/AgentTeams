# Daemon single-instance P0 — evidence notes

- Date: 2026-10-28
- Candidate: `ebbdf95` on `codex/daemon-single-instance-p0`
- Worktree: `/Volumes/Intel/playground/agentteams/daemon-single-instance-p0`
- Owner: `runtime`

## Scope and hard boundary

- One config / one `dataDirectory` owns at most one live daemon instance at any
  time. `agent`, `control`, `registry` and the legacy local launcher converge a
  previous live generation on start.
- Convergence stops only ownership-checked explicit PIDs: `SIGTERM`, poll, then
  `SIGKILL` to the same PID after the bounded grace window. It never uses
  `pkill`, `killall`, `xargs kill`, command-substitution kill or any batch
  termination.
- No tmux server, host pane or shared Collab daemon lifecycle is touched.
- This P0 fixes the per-config layer only. A project-wide "one daemon per
  project" rule would contradict the v4 contract that one config declares one
  daemon; that conflict stays with David and the user.

## Implementation

- `runtime/acp-serve.ts`: per-`dataDirectory` cross-process start lock
  (`agent-serve-state.lock`, owner PID, dead-owner reclaim, 60s ceiling). The
  lock covers convergence, engine-home creation, engine start, state publish
  and listener startup.
- A previous in-process handle releases its map entry, state record and engine
  home only after the engine confirms exit. A retained engine keeps the state
  record, the engine home and the lock-visible ownership.
- A failed start whose `EngineStopResult` is `retained` writes a `daemonPid=0`
  ownership record naming the retained engine PID, so the next start converges
  that exact PID instead of creating a second engine.
- `runtime/control-process.ts`, `runtime/registry-process.ts` and
  `runtime/local-process.ts` converge their previous live generation by
  explicit PID on start.
- `runtime/acp-serve-retained.spec.ts` pins the retained-failure record and the
  next-start convergence.
- Architecture maps and `docs/development-governance.md` fold this increment
  into the existing `teams-acp-serve-entry` owner and gate. No second gate,
  resource or truth store was added.

## Evidence

1. Source gate (registered command, 2026-10-28):
   `pnpm exec vitest run --no-file-parallelism runtime/acp-serve.spec.ts runtime/acp-serve-retained.spec.ts runtime/relations-intent-watch.spec.ts cli/agentteams.spec.ts`
   → 4 files passed, 74 tests passed, exit 0.
2. Typecheck: `pnpm exec tsc --noEmit` → exit 0.
3. Real CLI replacement black box
   `node docs/evidence/daemon-single-instance-p0/black-box-serve-replacement.mjs`
   → PASS. Two real `--serve opencode` instances on different data directories:
   dataA was replaced (old daemon 38593 and engine 38667 exited; new daemon
   39815 / engine 39877), the replacement served a real ACP initialize,
   session and prompt through a stub provider, dataB (39449/39450) stayed
   alive, and explicit-PID stop removed the state record, engine home and
   engine child for both directories.
4. BB14 (installed package, real CLI, second `start` replacement):
   `node scripts/blackbox-user-mvp.mjs --case BB14 --receipt .../bb14-receipt.json`
   → `passed`, exit 0.
5. BB13 clean-clone matrix (the original 8 × 10s control-process timeout is
   gone; 1652 / 1654 tests pass, including all control-process tests):
   - run 1 receipt: `.worker-runs/daemon-single-instance-p0/bb13-receipt.json`,
     exit 1. The only failures were
     `opencode-adapter/tests/acp-engine.real.spec.ts` × 2, both
     `ACP initialize timed out after 20000ms`.
   - run 2 receipt: `.worker-runs/daemon-single-instance-p0/bb13-r2-receipt.json`,
     exit 1. The only failures were `runtime/acp-serve.spec.ts` × 2, both
     `ACP initialize timed out after 20000ms`.
   - Isolation: `pnpm exec vitest run opencode-adapter/tests/acp-engine.real.spec.ts --no-file-parallelism`
     → 4 / 4 passed (30s), and the registered gate above passes the
     `runtime/acp-serve.spec.ts` real-engine cases.
   - Conclusion: the remaining BB13 failure is real OpenCode engine startup
     exceeding the existing 20s initialize budget under full-suite load, not a
     regression in this candidate. Same failure mode twice, so retry stops
     here. No budget was raised.

## Not closed

- BB13 did not reach a full pass. The next decision belongs to David: whether
  the 20s engine initialize budget, the real-engine spec scheduling, or the
  load isolation of the BB13 fixture should change. This note does not change
  any bound.
- Independent review of `ebbdf95` is still required before integration.
- No merge, push or installed-copy/restart/deployed-entrypoint/cross-device
  receipt is claimed in this note.
