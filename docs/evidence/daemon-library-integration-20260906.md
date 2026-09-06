# Daemon library integration — 2026-09-06

Primary worktree: `playground/daemon-lifecycle-20260906`, base
`95e112f524dbf3f0c1edcca4898f16da77e2a3c9`.

Imported exact candidates:
- Provider HTTP catalog: `4f4f7d495c382b8c9d6f27966d6e0bcb9328cfff`.
- Shared Relay codec: `6275e3418164c95e4b6fe80327182f4fadc4743b`.

Primary added the live Relay client and in-process daemon registration lifecycle,
and included them in the runtime JS/declaration artifact. Console API V1 is a
typed UI port only; no HTTP backend or daemon binding is claimed here.

## Observed verification

- `pnpm verify`: 39 test files / 237 tests, typecheck, Guidance compile,
  AppSDK compile, packaged Console/runtime smoke and AppSDK verify passed.
  Exact local log: `playground/daemon-milestone-final-verify.log`.
- Real local TLS Relay tests cover directory correlation, scoped broadcasts,
  grant/opened correlation, opaque bytes, request/data capacity, closing during
  connect, and daemon cancellation/stop/re-registration.
- A real TLS test peer accepts a request and withholds its result: client closes
  with `RESULT_UNKNOWN`, observes peer closure and sends no replay.
- Async event failure regression first failed with an unhandled rejection and
  timeout (`playground/relay-event-red.log`). Observing the callback promise
  closes the failed client; the same test passed (`playground/relay-event-green.log`).
  Callback directory requests remain possible because the control reader does
  not await event processing. The receiving Agent owns execution admission and
  capacity; this client does not infer Work completion from callback or socket closure.
- Packaged Node JS starts the daemon library against an actual Relay, queries
  its scoped directory, stops it, and registers the same identity with a new
  server generation. Test certificates/listeners/sockets are closed by the smoke.

## Review and remaining scope

Primary inspected the shared codec, catalog, client and lifecycle boundaries.
Independent exact-integration engineering review is still pending at this record.
No commit, push, merge or worktree closure is claimed.

This is a library milestone. OS process configuration/start/restart, persistent
identity and execution recovery, Agent Work wire execution, managed OpenCode
apply, Console desktop/mobile runtime, public/NAT relay and direct remain pending.
The B1 CLI candidate is not included: primary review found browser concurrency,
subprocess timeout and stdin error issues and returned it to its owner for fixes.

Primary fact review may promote this bounded evidence with `ai-reviewed` and
`human-unreviewed`; promotion does not change any pending engineering or product state.
