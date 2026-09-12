# 8990d68 E2 Endpoint-to-Work binding (run notes)

- Worktree: `playground/8990d68-e2-work-binding-gcm-20260911`
- Branch: `codex/8990d68-e2-work-binding-gcm-20260911`
- Base: `origin/main@9943593de922af0e5e883fb38881bc6215f495db`
- Owner: Worker for issue 8990d68 (Endpoint-to-Work admission binding).
- Scope: `control-protocol/agent-services.ts`, `control-protocol/endpoint-ref.ts`, `agent/work-resource.ts`, `runtime/agent-work-client.ts`, `runtime/agent-process.ts` plus their tests. Maps were not modified because `agent_work_endpoint_admission` and the `teams-endpoint-work-binding` gate already bind the targeted paths.

## Exploration

- `control-protocol/endpoint-ref.ts` already defines `admitWorkEndpointReference` and
  `WorkEndpointReference`. `agent/work-resource.ts` calls it from `validateEndpointBinding`
  inside `proposeWork` and uses the stored `work.endpoint` to bind the request operation
  in `requestWork`.
- `runtime/agent-work-client.ts` selects a visible Endpoint revision from the directory
  and carries the typed reference into the proposal; the wire schema
  (`control-protocol/work-wire.ts`) restricts the proposal envelope and request control
  envelope so endpoint identity and session metadata cannot leak into payload.

## First divergence

Two acceptance edges were not enforced:

1. `admitWorkEndpointReference` allowed non-`active` lifecycles (`draining` passed) for
   Work admission; the gate expects an explicit `inactive endpoint` rejection.
2. The provider admission never validated that the bound Endpoint actually mounts the
   capability's declared resources. The current proposal path only validated the
   capability/version/operation pair, so a `capability/resource mismatch` could pass
   silently when the Endpoint resource summary was a strict subset of the capability.

## Root-cause fix (minimal)

- `control-protocol/endpoint-ref.ts`: `admitWorkEndpointReference` now fails with
  `FORBIDDEN` when the admitted Endpoint view's lifecycle is not `active`.
- `agent/work-resource.ts`:
  - `validateEndpointBinding` returns the admitted Endpoint view.
  - A new `validateEndpointResources` helper fails with `NOT_FOUND` when the bound
    Endpoint does not mount every resource declared by the proposal's capability.
  - `proposeWork` calls `validateEndpointResources` after the capability/version check,
    keeping the same single owner for proposal admission.
  - `requestWork` continues to use the bound operation from `work.endpoint` and does
    not re-read mutable discovery state. The acceptance contract says control state
    must not be reconstructed from later discovery.
- Reused `admitWorkEndpointReference` for both checks (single owner), and extracted the
  helper to remove a duplicated try/catch.

## Verification

Focused source path (non-network):

```
vitest run --config vitest.config.ts \
  control-protocol/endpoint-ref.spec.ts \
  control-protocol/work-wire.spec.ts \
  agent/work-resource.spec.ts \
  runtime/agent-work-client.spec.ts \
  runtime/agent-process-config.spec.ts
-> Test Files  5 passed (5)
-> Tests       44 passed (44)
```

`runtime/agent-process.spec.ts` remains blocked by the sandbox `listen EPERM` on
`127.0.0.1`; the failure is environmental and pre-exists this worker. The remaining
mapped gate (`teams-endpoint-work-binding`) command cannot complete end-to-end in this
sandbox without real Relay/Node Agent process replay.

`git diff --check` clean for the candidate. No package or lockfile edits.

## Boundaries

- Maps were not modified because the targeted functions are already bound by
  `function-map.json -> agent_work_endpoint_admission` and the gate
  `teams-endpoint-work-binding` already lists the same paths.
- No install/restart/live replay evidence was attempted; the work is bound to source
  regression, typecheck, mapped gate command, and `git diff --check`.
- The resource check at proposal admission uses `validateEndpointResources` against the
  capability declaration. Runtime allocation capacity still comes from the provider
  capability ledger; the Endpoint view supplies the owner-visible mount verification.

## Delivery state

- Candidate produced on the worker branch with five files modified. No commit, push, or
  merge performed.
- No memory updates performed; the work belongs to the integration owner and stays
  blocked on public Relay / Node process evidence.
