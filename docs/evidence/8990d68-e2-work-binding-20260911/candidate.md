# Candidate summary

Current worktree: `playground/8990d68-e2-work-binding-gcm-20260911`

Branch: `codex/8990d68-e2-work-binding-gcm-20260911`

Base: `origin/main@9943593de922af0e5e883fb38881bc6215f495db`

## Files changed

- `control-protocol/endpoint-ref.ts`
- `control-protocol/endpoint-ref.spec.ts`
- `control-protocol/work-wire.spec.ts`
- `agent/work-resource.ts`
- `agent/work-resource.spec.ts`
- `docs/evidence/8990d68-e2-work-binding-20260911/notes.md`

No commit, push, merge, or worktree deletion performed. The candidate is a working tree
state for the integration owner.

## Behavior added

- `admitWorkEndpointReference` rejects non-`active` Endpoint lifecycles with `FORBIDDEN`.
- `proposeWork` validates that the bound Endpoint mounts every resource declared by the
  proposal's capability, using the typed Endpoint admission helper.
- Work wire tests assert Endpoint identity and session metadata are not allowed inside
  `work.request` control.

## Verification

Bounded source checks:

- `vitest control-protocol/endpoint-ref.spec.ts` passed.
- `vitest control-protocol/work-wire.spec.ts` passed.
- `vitest agent/work-resource.spec.ts` passed.
- `vitest runtime/agent-work-client.spec.ts` passed.
- `vitest runtime/agent-process-config.spec.ts` passed.
- `git diff --check` passed.

Not completed in this sandbox:

- `runtime/agent-process.spec.ts` blocked by `listen EPERM 127.0.0.1`.
- Root `pnpm typecheck` and `pnpm verify` blocked by missing local node_modules and
  blocked registry access; package-specific symlinks were tried and removed, and the
  parent dependency tree does not satisfy the worktree package typecheck.
- Full regression and live Relay/Agent process replay remain for the integration owner.
