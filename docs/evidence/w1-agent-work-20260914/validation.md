# W1 Agent Work validation

- Base: `ff781ca049033414f1b0884ac1ac0330081fbe25`
- AppSDK bug: `cabd162`
- Candidate tree: current worktree `codex/w1-agent-work-20260914`
- Allowed paths: `agent/**`, `runtime/agent-work-client.ts`, `runtime/agent-work-client.spec.ts`, `docs/evidence/w1-agent-work-20260914/**`
- Changed paths: `agent/work-resource.spec.ts`, `runtime/agent-work-client.spec.ts`, `runtime/agent-work-client.ts`

## Focused verification

```text
pnpm exec vitest run agent/agent-boundary.spec.ts agent/notification-projection.spec.ts agent/relation-graph.spec.ts agent/work-resource.spec.ts runtime/agent-work-client.spec.ts control-protocol/work-wire.spec.ts
6 files / 51 tests passed

pnpm exec tsc --noEmit
exit 0

git diff --check
exit 0
```

The focused suite covers version/operation matching, provider admission, stale
generation, resource capacity and atomicity, one consumer across capabilities,
duplicate request idempotency, cancellation, recovery and explicit errors.

The broader runtime socket suite was attempted but cannot bind `127.0.0.1` in
this desktop sandbox (`listen EPERM`). That is an environment limitation for
the local socket gate, recorded separately; it is not used as W1 code evidence.
