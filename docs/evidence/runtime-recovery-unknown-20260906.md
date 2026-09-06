# Runtime active-work recovery boundary

Date: 2026-09-06. Candidate `aeb9b16` was reviewed and merged into
`origin/main` as `48f2b5d`.

The runtime now calls the existing trusted ledger `recover()` path when a
daemon restart finds active request or allocation state. With no trusted
external completion observation, recovery durably records active requests as
`unknown` and held request allocations as `unknown` before startup fails with
`RESULT_UNKNOWN`. The daemon does not replay the operation, release a resource,
or serve new Work from that state.

The child-process regression creates a real active ledger, restarts the Agent,
observes the explicit startup refusal, and reads the durable `unknown` states
back from `work.json`. Candidate validation passed the focused runtime suite
(3 tests), the full regression suite (60 files, 319 tests), typecheck,
`build:governance`, `smoke`, and AppSDK `guide compile`, `compile`, and
`verify`. AGY exact commit review
`agentteams-runtime-recovery-unknown-20260906` returned `PASS` with no
findings.

This closes the durable fail-closed transition only. It does not prove stale
file-lock recovery, trusted PID/start-token exit proof, Camo/browser
enumeration or destruction after daemon loss, public Relay, NAT/direct
transport, production deployment, or mobile replay.
