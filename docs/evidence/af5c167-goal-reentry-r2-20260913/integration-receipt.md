# Integration receipt

- Integration worktree: `playground/af5c167-goal-reentry-r2-integration-20260913`.
- Integration base: `origin/main@a0ef263a339abd9edd22646973d500de501026be`.
- Cherry-picked candidate commits: `6da502a`, `1be56b3`.
- Integrated head before this receipt: `994b47d`.
- `pnpm install --frozen-lockfile` completed without lockfile changes.
- Exact integration `pnpm verify`: PASS; 77 test files and 458 tests passed, typecheck,
  AppSDK compile/verify, and packaged Console/runtime smoke passed.
- The first integration regression invocation was a transient 1-test failure; an immediate
  standalone rerun and the complete verify both passed. No source or dependency changed.
- No runtime, public Relay, NAT/STUN, provider live, Console-offline, or device acceptance
  is claimed by this documentation-only unit.
