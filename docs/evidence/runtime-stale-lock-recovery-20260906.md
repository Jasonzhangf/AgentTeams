# Runtime stale Work lock recovery

## Candidate and delivery

- Candidate: `0ceb455` based on `74db9ff`.
- Mainline receipt: fast-forwarded to `0ceb455`.
- AGY exact commit review: `agentteams-stale-lock-20260906-r1`, controller
  `verdict=pass`, `outcomeReason=controller_no_blocking_findings`.
- Review archive:
  `playground/evidence-archive/runtime-stale-lock-recovery-20260906/review-evidence.tgz`
  SHA-256 `e5690bd90957c128c820923f25acf3ae8b4fba63bece57aca053473eec5a06da`.

## Behavior proved

`runtime/agent-process.ts` now persists a private `runtime-owner.json` record
containing the daemon PID, process start token and configured lease port. On a
restart, a stale `work.json.lock` is recoverable only when the daemon has
reacquired the exclusive loopback lease and the lock metadata matches the
previous owner record. Missing or mismatched proof fails closed. Normal
shutdown removes the owner record while retaining the existing Work ledger
semantics.

The real child-process regression created a stale lock and prior owner record,
started an Agent daemon, observed successful registration and lock removal, and
verified owner-record cleanup on SIGTERM. The existing recovery test still
verifies active Work is durably marked `unknown` and startup refuses to serve
until trusted reconciliation.

## Verification

- `pnpm exec vitest run runtime/agent-process.spec.ts agent/work-resource.spec.ts`:
  2 files, 18 tests passed.
- `pnpm test`: 60 files, 320 tests passed.
- `pnpm typecheck`: passed.
- `pnpm verify`: passed; AppSDK result `{"ok":true,"project_id":"agentteams","stage":"contract_bound"}`.
- Mainline focused replay after merge: 2 files, 18 tests passed; `pnpm typecheck`
  and `appsdk verify` passed.

## Limits

This closes stale file-lock recovery for the daemon-owned work store. It does
not prove active browser/Camo state reconciliation, completion of unknown
external side effects, public Relay, NAT/direct transport, production service
installation or physical mobile replay.
