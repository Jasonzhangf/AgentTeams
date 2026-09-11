# Integration receipt: 6d2f49f

- Issue: `6d2f49f`
- Integration base: `e4e9b74091b061ed694ab77bb01de345cb5ac794`
- Integrated candidate commits: `27417e3` (source/tests), `328ffb7` (review receipt)
- Integration worktree: `playground/6d2f49f-integration-20260911`
- Focused command/config regression: `pnpm exec vitest run control-protocol/console-api.spec.ts runtime/console-config.spec.ts config/runtime-config.spec.ts` — 21 passed.
- AppSDK admission: `appsdk compile` — passed.
- AppSDK verification: `appsdk verify` — passed.
- `git diff --check`: passed.

This is a control-plane-only integration. It does not close the issue or claim live Relay/provider acceptance.
