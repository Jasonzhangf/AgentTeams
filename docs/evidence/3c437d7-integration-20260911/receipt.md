# 3c437d7 integration receipt

- Issue: `3c437d7` (N1/V1 public Relay and NAT deployment readiness), remains open pending live deployment and replay.
- Candidate: `5a4a3f5f501c6cf184cebeb935eafce73efeaa51`; candidate tree `472c6dad5bdf4a53fa27dc7d67f95a715cca8bf0`.
- Integration base: `9df5736f1cebbaebc0a317b6272b11823ed1b66c`.
- Integration candidate: `5da7cdc31f573743b6aa9639ec4a5e6215bc2c56`; tree `c011f94072bb193c9f848b48faa2673474df5ab5`.
- Integration branch: `codex/integration-3c437d7-20260911`.

## Scope

This docs-only unit adds the retained public Relay/NAT runbook and receipt
template. It makes the external prerequisites, credential-reference boundary,
artifact identity, daemon login/discovery/Work replay, restart generation check,
and exact cleanup evidence explicit. It does not claim that any public Relay,
Claw/coder2new deployment, NAT egress, install, restart, or live Work replay has
completed.

## Validation

- `vitest run server/deployment-contract.spec.ts` — 1 file / 4 tests passed on the exact integration tree.
- `appsdk verify` — passed: `{"ok":true,"project_id":"agentteams","stage":"contract_bound"}`.
- `git diff --check` — passed.
- Independent GCM exact review of candidate — PASS, no P0/P1; P2 advisory recorded for the wording at runbook line 18 (`.ts` source vs compiled `.js` entrypoint).

## Boundaries

The runbook is a procedure and receipt template, not live evidence. Public TLS
admission, real NAT outbound, two-daemon Work, provider readback, Console-offline
continuation, production service installation/restart, and remote cleanup remain
open gates.
