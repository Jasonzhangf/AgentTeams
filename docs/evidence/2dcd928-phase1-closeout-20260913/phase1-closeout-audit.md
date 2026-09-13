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

## Evidence fingerprint

The runtime gates were executed against the exact source base below; this
delivery unit only records evidence and does not change runtime source.

- Unit: `2dcd928-phase1-closeout-20260913`
- Base commit: `3354271d4ddc72c270f2d6304e2430558c0c6eaa`
- Base tree: `3394031b78a0ad1642ae6379e0f92b393b80fad9`
- Evidence candidate commit: `99a3437314b5a80183eb91d63a0269615fb1cec4`
- Evidence candidate tree: `ced75c1f1f25bc040614e2791ee817f6c32ed82a`
- Allowed paths: `docs/evidence/2dcd928-phase1-closeout-20260913/**`
- Actual changed paths: `diff-check.log`, `focused-tests.log`,
  `phase1-closeout-audit.md`, `pnpm-verify.log`, `remote-main-before.md`,
  `review-receipt.md`, `review-r2-receipt.md`, `review-r3-receipt.md`
- Clean-worktree proof: `git status --short --branch` returned only the branch
  line and no changed paths at `2026-09-13T07:12:31Z`.
- Dependency/tool fingerprint: `pnpm-lock.yaml` SHA-256
  `d6ffb637673ac0ef8c6f4e7f03a2a76eb58ed3e1b13e53a19122d8eca7053d37`;
  Node `v22.22.2`; pnpm `10.31.0`; AppSDK executable
  `/Users/fanzhang/.cargo/bin/appsdk`, SHA-256
  `5664b496686e254577d7fb437bc7519c404b4ec2da13d45c8dfa8fdf3c28a460`
  (the installed CLI exposes usage but no version flag).
- Maps/contracts fingerprint: resource map
  `ce62aea1c8c154a542670285b1998fd1932f6a6b23979ebf53ef828e61151d96`;
  function map `18dc65bf1b804ec2b55152691f7d7bf1d0b61e50bb93a79422abff67203636be`;
  mainline map `cf75203344106834adb9ebb0a44327f1b4b238b77c695570e60326752d446791`;
  verification map `1d01b5176737dc4d590070992e36ad8b85a1b7288b571cd726fe2bf2c58130b8`;
  protocol manifest `a38c9f90c30a9b1f5171fd29c5e992f7278dee4f6758cb45487192a0f9c63177`;
  governance `00053f65adccdfa35253c8c290188561becc9f62bbc9e359e7a5e830cdec70eb`.
- Environment/entrypoint: clean local worktree under
  `playground/l1-local-launcher-audit-20260913`; `pnpm verify` and the focused
  Phase 1 replay ran from the repository root with the checked-in lockfile.

Gate artifacts are bound to this fingerprint by their hashes:

| Gate artifact | SHA-256 | Bound source |
| --- | --- | --- |
| `focused-tests.log` | `a73abb40149420350b3bb53951ed9a1ac32ef0abfb438540e1e75983333c8ce9` | base commit/tree above |
| `pnpm-verify.log` | `3ce3d935cec53f8560180fc08cfa18901c49ba2e81bd5325c1f64f0284219cfc` | base commit/tree above |
| `diff-check.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | evidence candidate tree above |
| `remote-main-before.md` | `440f6c42dca40f0292600ce5b1810b6563f3058a79df72bf741b8ee7946df69b` | base commit resolved before gates |

## Current candidate verification

The exact source base was checked in a clean worktree. The command output is
retained beside this receipt and is bound to the fingerprint above:

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
