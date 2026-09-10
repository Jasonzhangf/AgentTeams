# N3-D1 direct listener delivery receipt

- Issue: `8ea5f7c`
- Delivery unit: `N3-D1 direct WSS listener`
- Base: `448421522d9d1f575102b376c938a2976d147766`
- Worker candidate: `ab8961b5b0ef67c744841b7688e657a18e837618`
- Integration candidate before receipt: `1ea630475b9c7d58da5b6d5b42403455ac2bc813`
- Integration worktree: `playground/8ea5f7c-n3-direct-listener-integration-20260910`
- Allowed paths: `network/direct-listener.ts`, `network/direct-listener.spec.ts`, `network/direct-listener.receipt.md`, and this evidence receipt.

## Change

Adds the Agent-owned TLS/WSS listener contract with explicit Authorization
admission, typed `transport.hello` / `transport.hello_ack`, target generation and
identity checks, bounded inbound and outbound frames, isolated accepted
connections, typed errors, and explicit listener/connection cleanup.

Relay candidates remain a separate transport. Runtime/config/registration
assembly, direct route publication, public/NAT reachability, and live
Claw-to-coder2 direct replay are outside this delivery unit.

## Verification

- Focused network regression: 5 files / 44 tests passed.
- Full source regression: 71 files / 404 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build:runtime`: passed.
- `appsdk compile`: passed; `stage=source_implemented`.
- `appsdk verify`: `ok=true`, `stage=contract_bound`.
- `git diff --check`: passed.
- Exact worker review: PASS after inbound `maxMessageBytes` fix.
- Exact integration review: PASS for `1ea630475b9c7d58da5b6d5b42403455ac2bc813`, tree `150838df1a4d6e030b71a6554a94cafc5cba1dcd`.

## Remaining boundary

This receipt does not claim a runnable daemon direct endpoint, route
registration, dual-NAT traversal, public deployment, mobile acceptance, or
Console-offline acceptance. Those remain open under issue `8ea5f7c` and later
delivery units.

## Push and cleanup receipt

- Remote push: `origin/main` = `de1a9eb9e2f557eb52f5321c6e29f3f9a940cf05` (cleanup receipt commit; the preceding integration candidate was `2a1f1524f440176570fa8412455ba2bb557123cf`).
- Cleanup time: `2026-09-10T15:26:04Z`.
- Worker and integration worktrees were clean and removed after push.
- Branches `codex/8ea5f7c-n3-direct-listener-20260910` and
  `codex/8ea5f7c-n3-direct-listener-integration-20260910` were removed locally.
- No delivery-owned process, listener, relay, port, lock, or claim remained.
- Evidence is retained on `main`; no external worktree was modified.
