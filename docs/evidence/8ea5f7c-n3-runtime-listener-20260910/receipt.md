# 8ea5f7c N3-D2 runtime direct-listener assembly receipt

- Issue: `8ea5f7c`
- Delivery unit: N3-D2 runtime direct-listener lifecycle
- Base: `f4b2ed2871fc185082b6477f9d6cfa37d9577fc9`
- Worker candidate: `1e0f731d96109228b980aaca3d5af65d80f356d6`
- Integrated candidate: `d92e46318deced30822c67b82a09aa4a9d96d4a9`
- Integrated tree: `cd20ddf6bd951c9fc18f959bcc24970af1ce886e`
- Remote main receipt: `d92e46318deced30822c67b82a09aa4a9d96d4a9`

## Exact scope

Changed paths are limited to:

- `runtime/process-config.ts`
- `runtime/agent-process.ts`
- `runtime/agent-process-config.spec.ts`
- `runtime/agent-process.spec.ts`
- `runtime/direct-listener.receipt.md`

The runtime config keeps direct-listener identity, protocol, capability revision,
TLS paths, credential reference, bind and queue limits. The dynamic Relay login
generation is not persisted in config; after admission the runtime constructs the
listener target with the current `daemon.network.generation`. The same config
restart regression proves generations `1 -> 2`, current-generation direct hello,
old-generation `STALE_GENERATION`, and listener closure. Relay and direct control
configuration remain separate, and credentials/TLS data do not enter declarations,
metadata, or business payloads.

## Review and verification

- Exact candidate review: PASS, index tree `cd20ddf6bd951c9fc18f959bcc24970af1ce886e`, no P0/P1/P2 findings.
- Exact integration review: PASS, commit `d92e46318deced30822c67b82a09aa4a9d96d4a9`, no findings.
- Focused runtime/network: 3 files, 16 tests passed.
- Mainline regression: `pnpm test`, 71 files, 407 tests passed.
- Typecheck: `pnpm typecheck` passed.
- Runtime build: `pnpm build:runtime` passed.
- AppSDK: `appsdk guide compile`, `appsdk compile`, and `appsdk verify` passed; verify stage `contract_bound`.
- `git diff --check` passed on candidate and integration trees.

## Delivery boundary

This delivery proves runtime listener creation, typed identity/auth/generation
binding, and lifecycle cleanup. It does not prove route publication into the
Agent Host/server directory, peer discovery, public reachability, NAT traversal,
Claw/coder2new replay, or device acceptance. Those remain N3-D3 and later live
network delivery units under issue `8ea5f7c`.

## Resource cleanup

The worker and integration worktrees are retained until the cleanup command below
records their removal. No production relay, device, or public endpoint was started
by this delivery.
