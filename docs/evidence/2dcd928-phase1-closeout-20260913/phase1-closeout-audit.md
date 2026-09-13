# Phase 1 Local Network MVP closeout audit

- Issue: `2dcd928`
- Delivery unit: `2dcd928-phase1-closeout-20260913`
- Audited source base: `origin/main@3354271d4ddc72c270f2d6304e2430558c0c6eaa`
- Scope: reconcile the G0 profile and the already integrated local launcher,
  local bridge, provider/OpenCode, UI discovery, and Console-offline units.
- Source changes in this delivery unit: none. This unit adds only the current
  candidate evidence and the requirement matrix.
- Public Relay, NAT/STUN, mobile, direct internet, and full UI remain outside
  this Phase 1 audit.

## Current candidate verification

The exact source base was checked in a clean worktree. The command output is
retained beside this receipt:

- `focused-tests.log`: 24 files and 165 tests passed. It covers the local
  launcher, config persistence, local bridge process replay, daemon lifecycle,
  Work capacity, CLI execution, Console projection, UI directory discovery,
  and provider/OpenCode bindings.
- `pnpm-verify.log`: `pnpm verify` passed; 75 files and 447 tests passed,
  typecheck passed, OpenCode and Console packages built, AppSDK guide compile,
  AppSDK compile, packaged smoke, and `appsdk verify` passed.
- `diff-check.log`: `git diff --check` passed.
- `remote-main-before.md`: remote `main` resolved to the audited source base.

The source verification proves the current tree. It does not claim a public
Relay deployment, NAT traversal, mobile entry, or an installed OS service.

## Requirement matrix

| Requirement | Evidence | Result |
| --- | --- | --- |
| G0 profile uses Local Network MVP and removes DSH from active profile/design wording | `docs/evidence/c4387e4-local-governance-20260913/governance-receipt.md`; current `docs/goals/**` and maps | PASS |
| `~/.agentteams/config.toml` is the stable launcher source | `runtime/local-config.ts`, `runtime/local-config.spec.ts`, `memory/L2/memory-9cf5cadd8d250ebd.md` | PASS |
| One launcher config plans multiple independently owned daemon children and persists path configuration | `runtime/local-supervisor.ts`, `runtime/local-supervisor.spec.ts`, `runtime/local-relay-bridge.spec.ts` | PASS |
| Start/stop/reentrant cleanup and observable supervisor state are explicit | `runtime/local-supervisor.ts`, `runtime/local-process.ts`, focused test log | PASS |
| Config errors, reserved identities, duplicate ownership and startup failures are explicit | `runtime/local-config.spec.ts`, `runtime/agent-process.spec.ts`, `runtime/local-supervisor.spec.ts` | PASS |
| Two independent daemon processes use a real local socket bridge | `docs/evidence/2745502-local-relay-bridge-20260912/integration-receipt.md`; `runtime/local-relay-bridge.spec.ts` | PASS |
| Directory discovery, scoped broadcast, connect, capability/resource publication, Work proposal/request/result/close | local bridge integration receipt and current focused replay | PASS |
| Resource capacity, duplicate request idempotency, release, restart and stale generation behavior | `agent/work-resource.spec.ts`, `runtime/agent-process.spec.ts`, current focused replay | PASS |
| Passive file-search capability executes through an independent Agent process | `runtime/agent-process.spec.ts`, `runtime/local-relay-bridge.spec.ts` | PASS |
| Explicit RCC and GoAIChat provider instances, catalog/apply/readback and OpenCode dispatch | `docs/evidence/c5708f3-provider-live-milestone-20260912/milestone-receipt.md`; `milestone-review.md`; current provider tests | PASS |
| Empty RCC catalog does not trigger implicit backup or guessed model repair | provider milestone receipt and current provider tests | PASS |
| UI discovers daemon identity/presence/capability/resource through the directory projection | `docs/evidence/e8dc905-ui-directory-discovery-20260912/**`; current UI focused tests | PASS |
| Console is outside the Agent-to-Agent Work path and local Work survives Console shutdown | `docs/evidence/b701a57-local-console-offline-20260913/**`; `runtime/local-relay-bridge.spec.ts` | PASS |
| Current source, artifact, and AppSDK contract gates remain green | `pnpm-verify.log` | PASS |

## Boundaries that remain open

The following are deliberately not Phase 1 failure conditions:

- public Relay deployment and real NAT egress;
- STUN/ICE, NAT-to-NAT direct transport, or automatic direct/relay choice;
- mobile or cross-device entry;
- complete Console relation/Work UI and mobile layout;
- provider automatic failover and production platform behavior.

The root workspace is still an older dirty checkout and is not part of this
clean candidate. It must remain untouched during this audit and requires a
separate root cleanup/rebase operation before the long-running goal can close.
The audit therefore establishes Phase 1 source/evidence readiness but does not
close the long-running goal by itself.
