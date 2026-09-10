# N3-D1 direct listener receipt

- Issue: `8ea5f7c`; delivery unit: `N3-D1 direct listener`.
- Base: `origin/main` at `448421522d9d1f575102b376c938a2976d147766`.
- Worktree: `playground/8ea5f7c-n3-direct-listener-20260910`.
- Branch: `codex/8ea5f7c-n3-direct-listener-20260910`.
- Candidate state: local uncommitted changes; no commit, push, merge, or runtime service action.

## Owned change

`network/direct-listener.ts` provides an Agent-owned TLS/WSS listener with explicit
credential admission, typed `transport.hello` / `transport.hello_ack`, target
generation and identity validation, isolated accepted connections, bounded frames,
and explicit close/error handling. Inbound hello and post-handshake frames are
bounded by `maxMessageBytes` independently of the WebSocket `maxPayload` limit.
`network/direct-listener.spec.ts` covers successful handshake and bidirectional
frames, stale generation, unauthorized admission, invalid hello, oversized hello
and post-handshake frames, connection isolation, and listener close.

## Verification

- `pnpm exec vitest run network/direct-listener.spec.ts network/wss-connection.spec.ts network/target-transport.spec.ts network/peer-route.spec.ts network/route-plan.spec.ts`: 5 files / 44 tests passed.
- `pnpm typecheck`: passed.
- `pnpm exec tsc --noEmit --pretty false`: passed.
- `git diff --check`: passed.

Runtime/config/registration assembly, direct route publication, public/NAT
reachability, and live Claw/coder2 replay remain outside this network delivery.
Relay candidates remain a separate route and are not converted into direct WSS.
