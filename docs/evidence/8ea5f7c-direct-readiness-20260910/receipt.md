# 8ea5f7c N3 direct/network resilience readiness audit

## Verdict

**NOT READY for a real Claw-to-coder2 direct endpoint.** The network client-side
direct route contract is implemented and locally verified, but the live Agent
process does not publish or serve a direct target endpoint and does not assemble
`connectPeerRoute` from a confirmed directory. The only current cross-host
Claw/coder2 evidence is explicit Relay transport evidence.

This is a read-only audit. No source, architecture map, AppSDK, server, formal
Claw relay, or formal Agent was modified, started, stopped, or restarted.

## Exact binding

- Issue: `8ea5f7c`.
- Worktree: `/Volumes/extension/code/AgentTeams/playground/8ea5f7c-direct-readiness-20260910`.
- Branch: `codex/8ea5f7c-direct-readiness-20260910`.
- Base: `origin/main@d15ae34c3fa7d826e6046b63ec0be82ef039aa34`.
- `HEAD`: `d15ae34c3fa7d826e6046b63ec0be82ef039aa34`.
- `HEAD^{tree}`: `bcd1922eb54299515ef6959051b1177d3f149a50`.
- Audit time: `2026-09-10T14:40:39Z` (2026-09-10 America/Los_Angeles).
- Final tracked tree: unchanged; `git diff --check` passed. The only expected
  untracked path is this receipt directory.
- No commit was created.

## Audit commands and results

The setup commands below changed only this disposable worktree's dependency and
build state; the audit did not change tracked source or external services.

| Command | Result |
|---|---|
| `git fetch origin main` | exit `0`; `origin/main` resolved to `d15ae34c3fa7d826e6046b63ec0be82ef039aa34` |
| `git worktree add -b codex/8ea5f7c-direct-readiness-20260910 ... origin/main` | exit `0`; clean independent worktree created under project `playground/` |
| `pnpm install --frozen-lockfile` | exit `0`; dependencies installed; no tracked file changed |
| `pnpm exec vitest run network/peer-route.spec.ts network/route-plan.spec.ts network/target-transport.spec.ts network/wss-connection.spec.ts runtime/agent-daemon.spec.ts runtime/agent-process.spec.ts` | exit `0`; 6 files, 52 tests passed |
| `pnpm typecheck` | exit `0`; root TypeScript, OpenCode adapter, Console Host, and Teams Console type checks passed |
| `git diff --check` | exit `0` |

The focused tests create only temporary local TLS/WebSocket fixtures and close
them in test cleanup. They do not contact Claw or coder2.

## Flow audit

### Direct versus relay candidate ownership

- `network/route-plan.ts:44-69` rejects `relay-ws`/`relay-webrtc` from a direct
  plan and requires a credential-free explicit `wss://` endpoint.
- `network/peer-route.ts:168-204` requires a confirmed directory generation,
  ready peer, selected non-relay candidate, valid transport credentials, and
  builds a typed `direct-wss` binding.
- `network/peer-route.ts:207-223` keeps relay candidates in the separate
  `assembleRelayPeerRoute` result. `network/peer-route.ts:225-230` does not
  silently convert a relay route into direct transport.
- `network/route-plan.ts:107-126` makes candidate state transitions explicit;
  a failed candidate is retired and a succeeded plan cannot be rewritten as
  failed. The direct client currently uses a manual one-candidate plan.

### Direct handshake, reconnect, old generation, and isolation

- `network/direct-route.ts:70-126` opens WSS, sends typed `transport.hello`,
  requires `transport.hello_ack` for the requested target generation, and only
  then marks the target ready/succeeds the route.
- `network/direct-route.ts:97-99` maps a hello deadline to
  `RESULT_UNKNOWN` with an explicit “do not replay” message. Failed handshakes
  close the socket and retire the candidate (`:170-179`).
- `network/direct-route.ts:118-120` rejects a stale hello acknowledgement as
  `STALE_GENERATION`.
- `network/direct-route.ts:127-169` binds target state to one connection,
  closes it explicitly, and reconnects only after closure. Concurrent reconnect
  calls share one attempt.
- `network/target-transport.ts:29-65` enforces connecting/ready/closed/failed
  transitions and target-generation checks.
- Local direct tests in `network/wss-connection.spec.ts:82-247` cover hello
  success, hello error, hello timeout/`RESULT_UNKNOWN`, stale ack, separate
  target sockets, explicit reconnect, and reconnect de-duplication.

### Runtime assembly and connection cleanup

- `runtime/agent-daemon.ts:41-58` logs into the configured Relay and performs
  an initial directory query before reporting online.
- `runtime/agent-daemon.ts:63-122` exposes `connectPeer` and
  `connectPeerRoute`, but the direct connector is an optional injection and
  the route call is a library entrypoint; no directory-to-target selection loop
  is assembled here.
- `runtime/agent-daemon.ts:123-174` tracks connecting/registered targets,
  de-duplicates reconnects, closes direct peers on daemon stop or Relay failure,
  and preserves cleanup failures. `runtime/agent-daemon.spec.ts` verifies these
  local lifecycle semantics.
- `runtime/agent-process.ts:187-208` starts only the Relay-backed daemon/data
  path. Its `relay.offer` handler opens Relay data and dispatches Work/Console
  ingress; it never calls `connectPeerRoute`.
- `runtime/agent-process.ts:219-238` publishes the process declaration and
  creates the consumer Work client, but no direct target listener or direct
  target connector is assembled.

## First divergence and missing live node

The first missing node is **direct target endpoint serving and declaration
publication at the live Agent process boundary**:

1. `runtime/process-config.ts:28-37` accepts Relay transport configuration
   only; it has no direct listener address, TLS certificate/key, target auth, or
   direct transport configuration.
2. `runtime/agent-process.ts:79` constructs the process declaration with
   `routes: []`. The published declaration at `:219-233` retains that empty
   route list. The process has no direct WSS target listener; the only listener
   it creates is the loopback ownership lease at `:102-109`.
3. `agent-host/agent-host.ts:62-79` likewise publishes exactly one
   `relay-ws` route candidate for its registration projection. It does not
   publish an actual LAN/IPv4/IPv6/Tailscale/gateway `wss://` target.
4. `server/relay.ts` owns the Relay service listener, which is a directory and
   connection-assistance service, not the peer Agent's direct target listener.

Therefore the current live Claw/coder2 Agent publication cannot supply the
explicit direct candidate required by `assembleDirectWssTargetOptions`, and no
live caller supplies the direct transport credential/CA and confirmed
directory snapshot to `connectPeerRoute`. The implemented direct client cannot
create an endpoint that the Agent process never serves or publishes. The Relay
directory must not synthesize that Agent-owned endpoint.

## Existing external evidence and boundary

- `docs/evidence/3c437d7-coder2-m2m-20260910/receipt.md:6-22` proves a real
  Claw Relay (`wss://claw.codewhisper.cc:9443`) cross-host Work replay, with
  Claw as provider and coder2new as consumer. Its boundary at `:43-45`
  explicitly says it does not prove direct transport or dual-NAT traversal.
- `docs/evidence/3c437d7-coder2-restart-20260910/receipt.md:8-46` proves
  Relay generation restart isolation (`STALE_GENERATION` followed by a fresh
  successful Work), while its boundary at `:58-60` explicitly excludes direct
  transport.
- `docs/evidence/daemon-execution-candidate-20260906.md:53-68` records that
  the earlier candidate evidence proved Relay only and left direct/public NAT
  validation pending.
- Local WSS tests use a temporary `127.0.0.1` HTTPS/WebSocket server from the
  test file itself. They prove direct client semantics, not an endpoint on
  Claw, coder2, a public hostname, a certificate chain, or a NAT path.

No executable real Claw↔coder2 direct endpoint is evidenced by this candidate.
The formal Relay and Agents were intentionally left untouched, so this audit
does not claim a current external listener or perform a live direct replay.

## Minimal next delivery write scope

The next delivery must close the first missing node in the owning layers:

1. **Network owner:** add the explicit direct target listener/acceptor and its
   target `hello`/`hello_ack`, generation, credential, and connection-isolation
   contract. The listener must be a target Agent endpoint, distinct from the
   Relay service and from the data-directory lease.
2. **Runtime/config owner:** extend the Agent process configuration and
   `startAgentProcess` assembly to bind that listener's TLS/auth settings,
   publish a real reachable direct route candidate, and provide the confirmed
   directory/binding/transport inputs to the existing `connectPeerRoute` API.
3. **Agent registration owner:** publish the actual direct candidate for each
   live Claw/coder2 Agent, with a current `wss://` endpoint and
   certificate/credential admission. The Relay/server remains limited to
   directory storage and admission; it must not invent or proxy an
   Agent-owned direct endpoint. Relay candidates remain a separate explicit
   route.
4. Add only the mapped tests/maps/evidence needed for the listener-to-directory
   path, then run a real Claw↔coder2 direct replay with exact endpoint, TLS,
   target generation, handshake, request result, and cleanup evidence. Direct
   success must be independently recorded from Relay success; no automatic
   fallback or request replay may be introduced.

## Cleanup

- No formal Claw relay or Agent was started, stopped, restarted, or modified.
- Focused test fixtures cleaned their temporary TLS/WebSocket listeners and
  temporary files.
- `node_modules` and generated build outputs are ignored dependency/build state;
  the tracked worktree is clean and this receipt is the sole untracked
  deliverable.
- This owned worktree is intentionally retained for the parent task's receipt
  consumption. No commit, push, merge, or branch deletion was performed.
