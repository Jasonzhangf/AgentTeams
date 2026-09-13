# Candidate receipt: 288af52

- Base: `origin/main@40c4e74ca51a8c3a334c1e702ac00b23f45815a9`
- Worktree: `playground/288af52-local-config-two-agent-20260913`
- Scope: `runtime/local-config.ts`, `runtime/local-supervisor.ts`, `runtime/agent-process.ts`, and their focused tests.
- User configuration: v2 `config.toml` contains endpoint role, identity, provider policy, receiver target/capability/operation, and user paths.
- Internal state: supervisor atomically writes `internal.toml` with PID, generation, and online/stopped state; generated endpoint JSON is under `.internal/endpoints/` and is derived, not user edited.
- Runtime replay: `runtime/local-two-agent.spec.ts` starts one Relay and two independent daemon child processes. The receiver discovers the configured provider through the local Relay, proposes `file-search`, requests one slot, receives a successful result, and closes the Work before readiness is reported.
- Failure hardening: disabled v2 Relay is rejected; dotted daemon IDs use quoted TOML keys; startup retains a bounded stability window so a post-ready child exit fails startup.
- Selection/cleanup hardening: receiver discovery filters the explicit provider ID before capability selection; confirmed failed Work results close the accepted Work, while request errors remain explicit for reconciliation.

## Evidence

- Focused: `focused-vitest.log` — latest focused runtime set covers 7 files, 35 tests passed.
- Compiled entrypoint replay: `packaged-replay.log` — the same two-daemon scenario ran with `generated/runtime-lib/server/relay-process.js` and `generated/runtime-lib/runtime/agent-process.js` after `pnpm build:runtime`.
- Regression: `regression.log` — 77 files, 454 tests passed.
- Typecheck: `typecheck.log`, `typecheck-full.log` — passed.
- Formatting: `diff-check.log` — passed.
- AppSDK: `appsdk-compile.log`, `appsdk-verify.log` — compile and verify passed; artifact hash was recorded in compile output.

This is source and local-bridge evidence. Public Relay/NAT/mobile deployment remains outside this delivery unit.
