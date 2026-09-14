# AgentTeams Phase 1 Local MVP current-SHA receipt

- Issue: `af5c167` (existing long-running goal; no duplicate issue)
- Candidate source/base: `3ab618aab39e4bc809294ae554c1714aabc35016`
- Worktree: `playground/af5c167-phase1-current-20260914`
- Scope: current-SHA verification of the Local MVP U0–U4 gates. Evidence only; no product source change.

## Current-SHA verification

- The mapped Phase 1 suite passed: 24 files, 172 tests (`focused-tests.log`). It covers local config/internal state, launcher restart and generation handling, local socket bridge, provider/receiver Work and resources, direct/relay route contracts, OpenCode config/readback, Console projection, UI daemon discovery, and fixed CLI capabilities.
- `pnpm verify` passed (`pnpm-verify.log`): source regression, typecheck, OpenCode and Console builds, AppSDK guide/compile, packaged smoke, runtime smoke, and `appsdk verify` command. AppSDK reports `development_ready=true`; `delivery_assessed=false` and `delivery_verified=false` because this verification unit did not request delivery admission.
- The current-SHA local user-path replay is retained in `docs/evidence/af5c167-local-mvp-rerun-20260914/`: `agentteams init/start/status/work/stop`, restart generation increment, stale-generation stop rejection, and second configured Work all passed over real local sockets with Console absent.
- The current-SHA provider/OpenCode replay is retained in `docs/evidence/c5708f3-current-syah-live-20260914/`: RCC HTTP 200 empty catalog with explicit manual model, credentialed GoAIChat 18-model refresh, Agent/Relay apply/readback `acceptedRevision=5/effectiveRevision=5` after runtime stop/start, and independent OpenCode dispatch to both targets.
- `git diff --check` passed. No credentials are stored in this evidence tree.

## Boundary

This closes the Local MVP evidence profile only. Public Relay deployment, NAT/STUN, direct internet, mobile entry, OS-level daemon installation, automatic provider failover, relation governance, and production release remain post-MVP and are not inferred from these local results.
