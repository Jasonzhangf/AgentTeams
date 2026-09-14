# W1 integration receipt

- Source candidate: `2cda5a7a3753e9ce3ea98144c22b2d4892ae66e2`
- Integration base: `ff781ca049033414f1b0884ac1ac0330081fbe25`
- Integrated tree: `3d386c0` (clean after receipt commit)
- Issue: `cabd162`

## Mainline verification

The candidate was cherry-picked into a clean worktree from `origin/main`.

```text
pnpm exec vitest run agent/agent-boundary.spec.ts agent/notification-projection.spec.ts agent/relation-graph.spec.ts agent/work-resource.spec.ts runtime/agent-work-client.spec.ts control-protocol/work-wire.spec.ts
6 files / 51 tests passed

pnpm exec tsc --noEmit
exit 0

git diff --check HEAD^ HEAD
exit 0
```

No unrelated paths changed. Runtime socket tests remain environment-blocked by
`listen EPERM: operation not permitted 127.0.0.1` in this desktop sandbox.
