# Integration receipt: 288af52

- Base: `origin/main@40c4e74ca51a8c3a334c1e702ac00b23f45815a9`
- Integrated candidate: `0bda03f` (cherry-picked as `12a2b00` and `ed255e3`)
- Worktree: `playground/288af52-integration-20260913`
- Exact review: `288af52-exact-review-r7` PASS for candidate `0bda03f`.

## Verification

- Focused runtime: 7 files, 33 tests passed.
- Regression: 77 files, 455 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build:runtime`: passed.
- Compiled local two-agent replay: 1 test passed using generated runtime entrypoints.
- `appsdk compile`: passed; artifact hash `sha256:3321542fa73bc4c7d62260f518dabf506cdd3dacf3c4bdb657ff172791da0faf`.
- `appsdk verify`: passed; stage `contract_bound`.

The evidence covers the local bridge profile: Relay directory discovery, two daemon startup, provider capability/resource declaration, receiver matching, one Agent Work request/result/close, and `internal.toml` lifecycle persistence. Public Relay, NAT/STUN, mobile, and multi-machine deployment remain outside this delivery unit.
