# C1 apply error recovery integration

- Delivery unit: `776fcad`
- Source candidate: `e48e9e38c4859840b089c026e0ee9ab7823bcf23`
- Integration base: `43af91670215cfcbee2164efae7c48e6ce4579d4`
- Integration tree: `codex/integration-c1-apply-error-20260914`

The candidate was cherry-picked into a clean worktree from the then-current
`origin/main`. Integration verification passed:

```text
pnpm exec vitest run config/runtime-config.spec.ts config/config-boundary.spec.ts runtime/console-config.spec.ts
3 files passed; 21 tests passed

pnpm typecheck
passed (root, OpenCode adapter, Console Host, Console UI)

appsdk verify
ok=true; stage=contract_bound

git diff --check
passed
```

Only the C1 config owner fix and its evidence are present in this integration
commit. No runtime, network, UI, provider payload, or deployment path changed.
