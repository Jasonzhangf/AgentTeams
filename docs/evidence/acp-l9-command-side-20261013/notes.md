# L9 command-side — the agent daemon dials its declared peers itself (2026-10-13)

This directory records the L9 command-side increment: the one production caller of
the delivered initiator egress `network/teams-egress.ts`. Before this increment
`runtime/acp-serve.ts` composed only the inbound path
(`buildLanChannel` -> `openTeamsIngress`), so `openTeamsEgress` had no production
caller. Now `startAcpServe` composes `runtime/serve-egress.ts` after the listener
and registration are ready and dials every peer the accepted intent declares.

The execution model is the user's decision and this increment does not change it:
the agent daemon reacts on its own and dials/tears down itself; the control daemon
is never a relay; there is no control -> agent channel.

## Scope delivered

1. `runtime/serve-egress.ts` — `createServeEgressOwner(input)` returns
   `{ connect, disconnect, list, failures, close }`. `connect(peerName)` resolves
   the `PeerIntent` from the accepted intent, builds the route plan with
   `buildDirectWssRoutePlan`, dials with `connectDirectWssTarget` (the same dialer
   the D05 closure black box proves) and composes `openTeamsEgress` over the
   authenticated `DirectWssTarget.connection`. `disconnect(agentId)` closes the
   live session and transport and removes the row. `list()` returns live rows
   only. `close()` closes every live row.
2. `runtime/acp-serve.ts` — after the LAN listener and registration are ready,
   `startAcpServe` creates the owner, connects every declared peer, exposes
   `egress` and `egressFailures` on `AcpServeHandle`, and closes the egress rows
   first in the stop path (before the host). A peer that cannot be dialed records
   a typed failure; the start never crashes and never skips a peer silently.
3. Tests — `runtime/serve-egress.spec.ts` (5 cases, real TLS loopback direct-WSS
   listener + real `openTeamsIngress`) and one new `runtime/acp-serve.spec.ts`
   wiring case.
4. Real black-box evidence — `black-box-self-dial.mjs` (two real `--serve`
   daemons, real registry, real TLS LAN listener).
5. Map + governance updates for the affected ownership, call edge and counts.

## Exact truth source for the two target facts

`openTeamsEgress` needs `expectedTargetGeneration` and
`expectedTargetCapabilitiesRevision`. `PeerIntent` carries neither, and no new
config key was added. The two values come from existing truth:

- `expectedTargetCapabilitiesRevision` — the responder's published declaration
  revision, read from the **existing D04 registration client**
  (`RegistrationClient.directorySnapshot(false)` ->
  `snapshot.peers.find(peer => peer.declaration.identity.agentId === <target>).declaration.revision`
  -> `String(...)`). This is exactly the value the D05 closure black box reads
  and asserts equals the responder's readiness `capabilitiesRevision`. The
  black-box run confirms it: the dialer's recorded agreement has
  `targetCapabilitiesRevision = "2"`, equal to the responder's readiness line
  `capabilitiesRevision=2`.
- `expectedTargetGeneration` — the serve entry's own published listener constant
  (`runtime/acp-serve.ts`, `targetGeneration = 1`). The direct listener target,
  the ingress responder `teams.connection.context` and the egress initiator all
  read this one constant, so both ends of a declared peer dial agree without a
  second config key. The directory does **not** carry this value: `RelayPeer.generation`
  is the relay per-identity login generation, which diverges after a reconnect
  (stated in the D05 closure driver header and shown by the D08 restart
  evidence), so it is deliberately **not** used for the hello or the negotiation.
  Aligning the wire generation with the relay login generation remains D06 work.
- `directoryGeneration` (route plan input) — `snapshot.revision`, the confirmed
  directory revision the readback was taken from.

## Changed files

Source:

- `runtime/serve-egress.ts` (new)
- `runtime/acp-serve.ts` (egress owner composition, handle fields, stop order)
- `tsconfig.runtime.json` (add `runtime/serve-egress.ts` to the build entry list)

Tests:

- `runtime/serve-egress.spec.ts` (new, 5 cases)
- `runtime/acp-serve.spec.ts` (+1 wiring case, `dshAgentConfig` gained an optional
  `peers` section)

Evidence:

- `docs/evidence/acp-l9-command-side-20261013/black-box-self-dial.mjs` (new)
- `docs/evidence/acp-l9-command-side-20261013/black-box-self-dial.log` (run output)
- `docs/evidence/acp-l9-command-side-20261013/receipt.json` (driver receipts)
- `docs/evidence/acp-l9-command-side-20261013/notes.md` (this file)

Maps and governance:

- `docs/architecture/function-map.json` — new `serve_egress_owner` (runtime),
  `teams_connection_egress` production-caller note, `acp_serve_entry` note/stop order
- `docs/architecture/mainline-call-map.json` — the initiator step now names
  `runtime/serve-egress.ts`; the chain note no longer says "no daemon dials an egress"
- `docs/architecture/module-registry.json` — network note (production caller in
  runtime) and runtime note (egress owner + stop order)
- `docs/architecture/resource-map.json` — new `daemon-egress-ownership` resource
- `docs/architecture/verification-map.json` — `teams-acp-d05-network` command now
  includes `runtime/serve-egress.spec.ts`; counts 98/98 -> 103/103; note updated
- `docs/development-governance.md` — gate row command/note and the D05 narrative

## Test surface

New `runtime/serve-egress.spec.ts` drives the owner against a **real** loopback
direct-WSS listener whose responder runs the **real** `openTeamsIngress`, the real
`createTeamsSession` on both ends and the real `createAcpHost` on both ends, over
real TLS with real HTTP admission and a real `transport.hello` handshake. Cases:

1. dials a declared peer over a real TLS socket, negotiates as initiator and opens
   the one ACP channel — asserts the recorded agreement (source = dialer,
   target = responder, `peer`/`master`, `targetGeneration` 1,
   `targetCapabilitiesRevision` equal to the responder's real facts), one host
   channel open on each side, and both ledgers reaching `ready`.
2. disconnect closes the live channel and the transport, removes the row, and a
   second disconnect is a typed `CONFLICT`.
3. duplicate connect while live is a typed `CONFLICT` and the live row is untouched.
4. unknown peer -> `FORBIDDEN`; peer with no explicit endpoint ->
   `UNSUPPORTED_CONFIGURATION`; no transport opened.
5. refused dial (real admission rejects the credential) records a typed failure
   and leaves no live row and no responder application record.

One new `runtime/acp-serve.spec.ts` case starts the real `startAcpServe` with two
declared peers (one without an endpoint, one with an endpoint but no `[discovery]`)
and asserts the daemon still serves, `egress.list()` is empty and both typed
failures are recorded on the owner and on `handle.egressFailures`.

## Mutation evidence (red-first)

Each mutation was applied to the pristine file, the named case was observed red,
then the file was restored byte-identical from a pristine copy (`cp`, `diff -q`,
md5 match). Pristine md5:

- `runtime/serve-egress.ts` `ab49e2751f12d8ee86e731f763d06147`
- `runtime/serve-egress.spec.ts` `ba42fb85c0924d4bce4728ff2119ba5d`
- `runtime/acp-serve.ts` `0d98911de63aeca7ef50bd749280378d`
- `runtime/acp-serve.spec.ts` `784434c38b01994df8ca695fcecc792e`

| ID | File | Mutation | Case turned red | Observed failure |
| -- | ---- | -------- | --------------- | ---------------- |
| M1 | `runtime/serve-egress.ts` | `expectedTargetGeneration: facts.targetGeneration + 1` | serve-egress 1 | `AcpError STALE_GENERATION: teams-negotiation: stale target generation in the connection context` |
| M2 | `runtime/serve-egress.ts` | remove `live.delete(agentId)` in `disconnect` | serve-egress 2 | `expected [ { peerName: 'responder', ... } ] to deeply equal []` |
| M3 | `runtime/serve-egress.ts` | remove the duplicate-connect `CONFLICT` guard | serve-egress 3 | `promise resolved "{ peerName: 'responder', ... }" instead of rejecting` |
| M4 | `runtime/serve-egress.ts` | fabricate the missing dial facts in `dialablePeer` | serve-egress 4 | `expected ... to match object { code: 'UNSUPPORTED_CONFIGURATION' }` (got `ENGINE_UNAVAILABLE`) |
| M5 | `runtime/serve-egress.ts` | `throw error` instead of `throw recordFailure(...)` in the connect catch | serve-egress 5 | `expected undefined to be defined` (no recorded failure) |
| M6 | `runtime/acp-serve.ts` | skip declared peers (`for (const peerName of [] as string[])`) | acp-serve wiring case | `expected [] to deeply equal [ 'no-endpoint', 'with-endpoint' ]` |

## Verification (exact commands and counts)

1. New spec plus affected existing spec:
   `pnpm exec vitest run runtime/acp-serve.spec.ts runtime/serve-egress.spec.ts`
   -> exit 0, 2 files, **32 passed** (acp-serve 27, serve-egress 5).
2. Declared D05 gate, read verbatim from
   `docs/architecture/verification-map.json` (`teams-acp-d05-network`) after adding
   `runtime/serve-egress.spec.ts` to its command:
   `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts network/teams-egress.spec.ts runtime/serve-egress.spec.ts control-protocol/teams-connection.spec.ts`
   -> exit 0, 11 files, **103 passed** (was 98/98 before this increment).
3. `teams-acp-serve-entry` gate:
   `pnpm exec vitest run runtime/acp-serve.spec.ts cli/agentteams.spec.ts --no-file-parallelism`
   -> exit 0, 2 files, **60 passed**.
4. `pnpm typecheck` -> exit 0.
5. `pnpm build` -> exit 0.
6. Black box:
   `node docs/evidence/acp-l9-command-side-20261013/black-box-self-dial.mjs`
   -> exit 0, PASS, receipt written to `receipt.json`, owned temp root removed.

`pnpm verify` was **not** run: the AppSDK compile/verify gate has a pre-existing
BLOCKED baseline (`PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014`), recorded in the
D05 gate note before this increment.

## Black-box evidence detail

`black-box-self-dial.mjs` starts a real registry through the real
`registry start` CLI, then two real `agentteams --serve opencode` daemons on a real
non-loopback LAN address with real openssl TLS material and real HTTP admission.
The responder is started first and reports `registration state=online`; the dialer
is then started with one declared peer `l9-responder`. After starting the dialer
the driver only reads the daemons' own durable connection history
(`<dataDir>/acp-history.json`); it never opens a socket to either daemon.

Observed receipts (2026-10-14, exit 0):

- dialer LAN listener `192.168.0.3:<port>`, readiness `capabilitiesRevision=2`,
  `registration=online`.
- dialer durable `connection.negotiated` for `l9-responder`:
  `source = {local, local, l9-dialer}`, `target = {local, local, l9-responder}`,
  `sourceRole = peer`, `targetRole = master`, `sourceGeneration = 1`,
  `targetGeneration = 1`, `targetCapabilitiesRevision = "2"`.
- responder durable `connection.negotiated` for `l9-dialer` with the same wire
  agreement connection id and the same identities and roles.
- both sides record `channel.opened` (one ACP channel), and neither side records
  `connection.failed` for the peer.
- provider calls: 0 (the OpenCode engine's readiness uses the local stub provider;
  the increment is about the daemon and the initiator leg, not a model).

## Explicit NOT delivered

- **No retry of a peer that is offline at start.** The wiring dials each declared
  peer once, after registration is online. A peer whose directory readback is not
  yet available records a typed `UNSUPPORTED_CONFIGURATION`/`ENGINE_UNAVAILABLE`
  failure and is not re-dialed. There is no background re-dial or reconnect loop.
- **No periodic re-dial after a peer disconnects.** `disconnect` tears a peer down;
  nothing re-establishes it automatically.
- **No control -> agent channel and no control-side relay** (by the execution model).
- **No new config key.** A peer is dialable only when its own `PeerIntent` declares
  `endpoint`, `admissionRef`, `credentialRef` and `tlsTrustRef`.
- **Role pair is derived, not declared.** The dialer requests `peer` for itself and
  `master` for the target when the daemon's accepted `relations.allowed` includes
  `master`; a daemon whose accepted relations do not include `peer` cannot dial
  (typed `FORBIDDEN`). The default `relations.allowed = ["peer"]` requests
  `peer`/`peer`, which the frozen role pairs allow.
- **No installed-copy, restart, deployed-entrypoint or cross-device evidence.** The
  black box runs the worktree's compiled `generated/runtime-lib` through the source
  CLI, not an installed artifact.
- **`expectedTargetGeneration` is still the serve entry's constant (1).** The
  directory's relay login generation is not used; aligning the wire generation
  with it remains D06 work.
