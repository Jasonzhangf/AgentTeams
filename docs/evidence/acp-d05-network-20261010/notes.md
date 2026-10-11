# D05 network worker receipt (part 1: network-owned isolated transport)

- Task: D05 negotiation/session/history layer over the frozen D00 Teams contract,
  network-owned, **without** wiring the runtime serve entry.
- Base: `main == origin/main == f5d53e4`.
- Candidate commit: `ecf339a` (this receipt's hash is recorded in the follow-up
  `docs(evidence)` commit on the same branch).
- Worktree: `/Volumes/Intel/playground/agentteams/acp-d05-network-20261010`
- Branch: `codex/acp-d05-network-20261010`
- Forbidden paths in this change and left untouched: `runtime/acp-serve.ts`,
  `cli/agentteams.mjs`, `dsh-adapter/**`, `opencode-adapter/**`,
  `control-protocol/**`, `server/**`.

Every surface below is reported separately. A later surface is never inferred
from an earlier one.

## 1. Source surface (delivered)

| File | What it owns |
| --- | --- |
| `network/teams-negotiation.ts` | The frozen-frame negotiation state machine and the only source of an agreement. |
| `network/teams-session.ts` | One authenticated connection bridged to the injected `AcpHost`. |
| `network/teams-connection-history.ts` | Typed `kind=connection` history over the injected store. |
| `network/teams-membership.ts` | Per-remote-agent connection/role view over the directory, route and registration surfaces. |
| `network/registration-client.ts` | Additive `RegistrationClient.publish` (R4). |
| `runtime/registry-registration.ts` | Additive pure `listenerRouteCandidates` and `declarationWithPublishedSurfaces` (R4). |
| `tsconfig.runtime.json` | Additive include entries for the four new modules; nothing removed. |

### R1 — one control vocabulary

Implemented fact: the D05 layer carries ACP over the existing transport using
only the frozen Teams frames.

- The negotiation emits and accepts exactly `teams.connection.context`
  (`network/teams-negotiation.ts:231`), `propose` (`:338`), `reject` (`:264`),
  `accept` (`:316`), `confirm` (`:382`) and `ready` (`:398`).
- The channel layer emits and accepts exactly `acp.open` (inbound),
  `acp.open_ack` (`network/teams-session.ts:183`), `acp.frame` (`:204`, `:231`),
  `acp.close` (`:268`) and `acp.error` (`:150`).
- No second envelope, no new frame type and no extra field on
  `transport.hello`/`hello_ack` exist. `network/teams-session.ts` parses every
  inbound frame through the frozen `parseTeamsConnectionFrame`; a frame that is
  not one of the five channel kinds is refused with `INVALID_ACP_FRAME`.
- The LAN channel reuses the existing code: the isolated observation drives the
  real `network/direct-listener.ts` `onConnection` path (no second listener and
  no second handshake were added).

### R2 — ref scoping

Implemented fact: the wire carries the frozen `AcpChannelRef`; `connectionId`
and `channelId` are transport-scoped correlation keys the receiving side
allocates; `targetGeneration`/`engineInstanceId` are rewritten at the receive
boundary from local values.

- `network/teams-session.ts:156` and `:160` refuse a peer ref whose
  `targetGeneration` or `engineInstanceId` does not match the local daemon, with
  `acp.error` code `STALE_GENERATION`, before any host call. No channel opens.
- `network/teams-session.ts:170`-`:173` allocates this side's own
  `connectionId`/`channelId`; `:177` calls `host.open` with that local ref only.
- `network/teams-session.ts:192` re-checks the generation and engine instance on
  every `acp.frame`, and `:197` builds the host ingress as
  `{ ...record.localRef, frame: entry.frame }`, so a peer-supplied generation or
  engine instance never reaches `AcpHost`.
- A closed or unknown channel is refused with `STALE_GENERATION` and never
  re-opened (`:186`).
- Spec evidence: `network/teams-session.spec.ts` "refuses a forged or stale
  targetGeneration and engineInstanceId without opening a channel", "allocates
  local transport keys and rewrites generation and engine instance before
  host.open", "injects an inbound frame into host.receive with the payload
  preserved byte-for-byte" and "closes every channel on transport close and
  refuses a replaced generation". The observation repeats both refusals over a
  real TLS socket.

### R3 — integer accepted config revision

Implemented fact: `TeamsAgreement.sourcePolicyRevision`/`targetPolicyRevision`
are the integer accepted config revision (`config/runtime-config.ts`
`acceptedRevision`), never the sha256 `AcpPolicySnapshot.revision`.

- `network/teams-negotiation.ts:31`-`:36` states the rule in code, `:56` and
  `:77` document the two option fields, and `:311` marks the assignment site.
- `:312`-`:313` copy the integers into the agreement with no hash and no
  truncation.
- `:218` and `positiveInteger(options.selfPolicyRevision, ...)` refuse a
  non-integer revision as an invalid input instead of coercing it.
- The responder's `peerPolicyRevision` is an explicit authenticated input
  (`:83`-`:86`); it is never guessed and never defaulted.
- Spec evidence: "carries the integer accepted config revision, never a hashed
  policy snapshot revision" asserts `Number.isSafeInteger` and refuses a
  64-character sha256 string.

### R4 — route publication (declared cross-owner edge, additive)

Implemented fact: the daemon's real listener route plus its ACP
capability/revision are published through the existing D04 registration path.
No second registry, directory or publication path was added.

- `network/registration-client.ts:76`-`:84` declares the additive
  `publish(declaration)`; `:277`-`:283` delegates to `relay.publish` behind the
  same `state === 'online'` guard and the same "never switch servers" rule as
  `directory`.
- `runtime/registry-registration.ts:195` `listenerRouteCandidates` projects the
  one declared agent listener into a single `lan` `RouteCandidate` and returns
  none for a control daemon or a daemon without a listener.
- `runtime/registry-registration.ts:219` `declarationWithPublishedSurfaces`
  composes the route plus the ACP capability, advances the declaration revision
  by one and preserves identity, scope and `agentKind`.
- The existing `relay.publish` boundary still owns identity/revision validation
  (`network/relay-client.ts`), so a declaration that does not advance its
  revision is refused.
- Spec evidence: `network/registration-client.spec.ts` "publishes the daemon
  listener route and ACP capability over the same registration path" (real relay,
  real `wss` socket, real directory readback, and a refused non-advancing
  revision) and "keeps the original unreachable-endpoint error and never switches
  servers" (offline publish guard);
  `runtime/registry-registration.spec.ts` "publishes the real listener route and
  the ACP capability as one advanced declaration".
- Nothing in D04's semantics changed: the existing D04 tests still pass and the
  `teams-acp-d04-registry` gate row is untouched.

### R5 — scope guard

Implemented fact: no UI, no control daemon, no second transport, no
session/model/tool policy in the transport, no master authority grant, no
election/scheduling and no prompt replay on reconnect.

- The transport layer performs connection-capability admission only: it admits
  or refuses capabilities and roles, and never chooses a session, a model or a
  tool policy.
- `AcpHost` is called with `principal = connection.peer` and the injected
  policy; it never learns a registry address, a route, a role or the transport.
- `acp.close` and transport close release the channel and restore nothing
  (`network/teams-session.ts:265`-`:270`); there is no replay path.
- `network/teams-connection-history.ts` exposes exactly `record` and `query`;
  `network/teams-membership.ts` stores nothing.

## 2. Focused test surface

Exact gate command and result:

```
pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts
```

Result: `Test Files 5 passed (5)`, `Tests 43 passed (43)`
(teams-negotiation 15, teams-session 11, teams-connection-history 5,
teams-membership 5, registration-client 7 including 2 R4 publication cases).

The four new specs were written red first: the first run failed with
`Cannot find module './teams-negotiation.ts'` (4 files, 0 tests) before any
implementation existed.

Affected regression suites:

```
pnpm exec vitest run --no-file-parallelism network server
```

Result: `Test Files 24 passed (24)`, `Tests 187 passed (187)`.

Gate plus every affected owner suite:

```
pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts runtime/acp-serve.spec.ts runtime/acp-daemon.spec.ts agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts config/daemon-intent.spec.ts config/acp-policy.spec.ts control-protocol
```

Result: `Test Files 24 passed (24)`, `Tests 215 passed (215)`.

Gate plus the R4 publication owner suite:

```
pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts
```

Result: `Test Files 6 passed (6)`, `Tests 50 passed (50)`.

## 3. Typecheck and build surface

```
pnpm typecheck
```

Result: exit 0 (root `tsc --noEmit` plus the opencode-adapter build/typecheck,
console-host typecheck and ui/teams-console typecheck).

```
pnpm build:runtime
```

Result: exit 0. `tsconfig.runtime.json` gained exactly four include entries
(`network/teams-negotiation.ts`, `network/teams-session.ts`,
`network/teams-connection-history.ts`, `network/teams-membership.ts`); nothing
was removed or reordered.

## 4. Isolated-transport observation surface

```
node --experimental-transform-types docs/evidence/acp-d05-network-20261010/isolated-transport-observation.mjs
```

Result: `OBSERVATION PASSED: 23 checks.`

What it really drives: real TLS material generated by `openssl`, a real
`createDirectWssListener` bound on `wss://127.0.0.1:<port>`, the real HTTP
`Authorization` admission (a wrong credential is refused before any application
frame is read), the real `transport.hello`/`transport.hello_ack` handshake, the
real `runTeamsNegotiation` on both sides, the real `createTeamsSession`, a real
`AcpHost` over an in-process scripted engine duplex, a real `acp.open` /
`acp.open_ack`, a real `initialize` served from the captured result, a real
`session/new` answered by the engine, a real `session/request_permission`
callback with its controller reply restored to the engine, a real `acp.close`,
two concurrent isolated connections, and the R2 refusals (`STALE_GENERATION` for
a stale `targetGeneration` and for a forged `engineInstanceId`).

## 5. NOT proven (explicit)

- **The peer engine is an in-process scripted duplex, and the peer agent is
  in-process.** The observation is not the D05 two-real-engine LAN black box.
- **D05 is INCOMPLETE and does not close.** D05 cannot close until the
  two-real-engine LAN black box runs against the `--serve opencode` and
  `--serve dsh` entries. This change deliberately does not wire the serve entry:
  `runtime/acp-serve.ts` and `cli/agentteams.mjs` are outside its scope, and
  `--serve dsh` still has no serve wiring.
- Two real `AcpHost` peers on one ACP channel are not exercised and are not
  possible: a callback arriving at the peer host would be handled as a client
  request. One real host side is the honest maximum for this channel shape.
- No installed-artifact, no restart, no deployed-entrypoint and no browser/UI
  evidence exists for this change.
- No AppSDK compile/verify run is claimed. `appsdk compile` fails before it reads
  the maps with the pre-existing pin mismatch
  `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014:required_binary=appsdk-0.1.0014`
  (exit 1), which this change did not introduce and does not touch. The five
  architecture maps were therefore validated by JSON parse plus the preserved
  per-map shape, not by the AppSDK gate.
- The membership view is a projection only. It has no live consumer yet, so
  nothing proves a UI or control daemon renders it.

## 6. Map and governance bindings (same change)

- `docs/architecture/verification-map.json`: new `teams-acp-d05-network` gate
  (owner `network`, status `partial`, `required: true`) with the exact focused
  command above.
- `docs/architecture/module-registry.json`: the `network` module note records the
  four new modules and the additive publication surface; the `runtime` note
  records the two pure helpers. No new module was declared, because
  `network/**` and `runtime/**` already own these paths.
- `docs/architecture/function-map.json`: new functions
  `teams_negotiation_execution`, `teams_authenticated_acp_session`,
  `teams_connection_history` and `teams_membership_projection`; the existing
  `registration_client_transport` and `registration_process_composition`
  entries gained the additive symbols and the D05 gate.
- `docs/architecture/mainline-call-map.json`: new chain `acp-teams-network-v1`
  with six owner edges and three planned bindings. The `acp-serve-entry-v1` and
  `acp-dsh-engine-v1` rows were left untouched.
- `docs/development-governance.md`: new D05 gate row plus a D05 paragraph, and
  the serve-entry row now states that D05 is delivered at source level but not
  composed by that entry.
- `.appsdk/project.json` was not modified: `network/**`, `runtime/**`, `cli/**`
  and `docs/**` are already `teams-source` owned/regression inputs, and
  `minimum_test_count: 304` is a minimum.

## 7. Resource cleanup

- The observation script creates one temporary directory and removes it in a
  `finally` block; it closes the listener, every client target and every session
  explicitly by handle. No `pkill`, `killall` or `kill $(...)` is used anywhere.
- The worktree and branch are retained until the parent integrates or discards
  them.
