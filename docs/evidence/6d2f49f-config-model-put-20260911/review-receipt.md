# Exact review receipt: 6d2f49f

- Issue: `6d2f49f`
- Base commit: `e4e9b74091b061ed694ab77bb01de345cb5ac794`
- Candidate commit: `a5fba2c`
- Candidate tree before commit: `823a0e7931c5419ca96424a8962490b5ab49a555`
- Exact changed paths: `control-protocol/console-api.ts`, `control-protocol/console-api.spec.ts`, `runtime/console-config.ts`, `runtime/console-config.spec.ts`
- Reviewer: primary Desktop owner (independent GCM reviewer attempted; response connection failed before review)
- Decision: PASS for the scoped source candidate.

## Findings

The new typed command is owned by the Console control protocol, admits only `origin: manual` entries, rejects surplus/invalid metadata, and preserves provider/model identity as a structured reference. Runtime dispatch delegates the CAS mutation to the existing `RuntimeConfigStore.putModelEntry`; no second catalog owner, fallback, payload metadata, or UI path was added. Projection readback uses the existing provider catalog projection.

## Verification

- `pnpm exec vitest run control-protocol/console-api.spec.ts runtime/console-config.spec.ts config/runtime-config.spec.ts`: 21 passed.
- `appsdk compile`: passed.
- `appsdk verify`: passed.
- `git diff --check`: passed.

No live relay/provider evidence is required for this control-plane-only delivery. Runtime build/install remains part of integration verification.
