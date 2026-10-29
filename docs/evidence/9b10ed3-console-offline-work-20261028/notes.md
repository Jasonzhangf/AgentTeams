# 9b10ed3 Console-Offline Agent Work Acceptance (`BB04,BB07,BB09`)

## Scope
- Bug: `9b10ed3` (`[V1 P1] Console-offline Agent Work acceptance`)
- Driver: `scripts/blackbox-user-mvp.mjs` (`--case BB04,BB07,BB09`)
- Candidate receipt: `docs/evidence/9b10ed3-console-offline-work-20261028/receipt.json`

## Root Cause of Earlier `BB07` Timing Flake & Fix
- `runtime/local-config.ts` defaults `requestTimeoutMs` to `1000` (1 second) when not specified in `config.toml`.
- In `runBB07ExecutionFailure` (`scripts/blackbox-user-mvp.mjs`), two sequential `waitForAsync` calls polled `barrier.launches()` with a fixed `250ms` sleep (`setTimeout(resolveDelay, 250)`), consuming `500ms-750ms` of the `1000ms` `WorkChannel` request budget while `search-wrapper.mjs` spawned and waited on `barrier.release()`.
- Adding an optional `intervalMs = 250` parameter to `waitForAsync` in `scripts/blackbox-user-mvp.mjs` and passing `10` (`10ms`) for the two `BB07` barrier waits (plus `5ms` inside `search-wrapper.mjs`) eliminates the polling delay while preserving all production timeouts and assertions.

## Acceptance Result (`2026-10-28`)
- `BB04` (`installed agent work submit and query`): `passed`
- `BB07` (`installed agent work failure and recovery`, including Console-offline persistent Work continuation and real `rg` child interruption/recovery): `passed`
- `BB09` (`installed console directory discovery`, including Console stop/offline Work completion and Console restart observation): `passed`
- Overall exit code: `0` (`passed: 3`, `failed: 0`, `unverified: 0`)
