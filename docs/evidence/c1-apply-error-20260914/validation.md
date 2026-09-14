# C1 apply error recovery validation

- Issue: `776fcad`
- Base: `43af91670215cfcbee2164efae7c48e6ce4579d4`
- Candidate tree: `codex/c1-apply-error-20260914`
- Scope: `config/runtime-config.ts`, `config/runtime-config.spec.ts`

## Change

When an accepted provider configuration applies successfully at its accepted
revision, the config owner now removes the prior `lastApplyError` before
persisting the effective observation. A later successful apply therefore does
not leave stale failure state in memory or after store recreation.

## Verification

```text
pnpm exec vitest run config/runtime-config.spec.ts config/config-boundary.spec.ts runtime/console-config.spec.ts
3 files passed; 21 tests passed

pnpm typecheck
passed (root, OpenCode adapter, Console Host, Console UI)

git diff --check
passed

appsdk verify
ok=true; stage=contract_bound
```

The focused regression covers failure followed by success, `readEffective()`
state, and durable persistence after store recreation. No network, process,
packaging, or business payload path changed.
