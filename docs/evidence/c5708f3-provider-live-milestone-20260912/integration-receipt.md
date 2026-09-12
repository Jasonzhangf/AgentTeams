# Integration receipt

- Delivery unit: `c5708f3-provider-live-milestone-20260912`
- Source candidate reviewed by Astra: `9e0c3214ae097f23ff97ac182691b79bcec138cf`
- Source base: `f9e90dbd3e721abed38cafb482f240de6e004137`
- Clean integration worktree: `codex/integration-c5708f3-provider-live-milestone-20260912`
- Integrated main candidate: `ac302f6454584b532e9f09400b1120e426119a9f`

The four reviewed evidence commits were cherry-picked into a clean worktree from
the then-current `origin/main`. Integration checks passed:

```text
git diff --check origin/main...HEAD
node --check docs/evidence/.../live-harness.mjs
node --check docs/evidence/.../opencode-harness.mjs
appsdk verify -> {"ok":true,"project_id":"agentteams","stage":"contract_bound"}
```

The integrated tree contained only the provider live milestone evidence directory.
No product source, provider credential or unrelated worktree was changed.
