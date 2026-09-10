# N3 D4-A Relay directory projection receipt

- Issue: `8ea5f7c` (`[N3 P1] Direct transport and network resilience audit`), remains open.
- Base: `2ccb2b8949e3028c56781662e71bad237298888a` (`origin/main` before this unit).
- Candidate: `39c5c03a77aa1f0df171596703e3fd48ea476c55`.
- Candidate review: independent GCM exact review `PASS`.
- Integration: `fe49aa136a1bca3cddab6fec06daddb6f30690f7` from the latest base.
- Integration review: independent GCM exact review `PASS`.
- Remote push receipt at delivery time: `git ls-remote origin refs/heads/main` returned `fe49aa136a1bca3cddab6fec06daddb6f30690f7`.

## Scope

`RelayDirectorySnapshot` retains the relay directory revision while `directory()` keeps its legacy peer-list view. The account-directory projection validates account, scope, directory revision, declaration revision, peer generation, duplicate hosts, and backwards refreshes. The existing route projection owner reconstructs route candidates without raw credentials. Revision zero remains unconfirmed and cannot satisfy peer-route confirmation.

## Validation

- Focused: `pnpm exec vitest run network/relay-client.spec.ts network/account-directory.spec.ts network/peer-route.spec.ts` — 3 files / 27 tests passed.
- `pnpm typecheck` — passed.
- `pnpm test` — 71 files / 410 tests passed.
- `pnpm verify` — passed, including Guidance compile, AppSDK compile/verify, packaged Console smoke and runtime smoke.
- `git diff --check` — passed.

The first integration `pnpm verify` attempt had one real-DOM timing failure (409/410); the unchanged source rerun passed 410/410 and the subsequent full `pnpm verify` passed. The transient failure is retained as evidence and was not masked by a code change.

## Boundaries

This unit does not wire the projection into a production runtime caller and does not claim direct Work, public direct reachability, NAT/dual-NAT traversal, Claw/coder2new device replay, production install/restart, or Console-offline acceptance. Those remain separate delivery units.
