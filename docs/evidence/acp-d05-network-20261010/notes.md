# D05 network worker receipt (part 1: network-owned isolated transport; part 2: review-fix round)

- Task: D05 negotiation/session/history layer over the frozen D00 Teams contract,
  network-owned, **without** wiring the runtime serve entry.
- Base: `main == origin/main == f5d53e4`.
- Part-1 candidate commit: `ecf339a`, recorded by `b9dbf88` (the part-1 receipt
  commit on this branch).
- Part-2 fix commits on top of `b9dbf88` (no amend, no rebase, no force):
  - `b5cd92b` — A1/A2/A3/A4 code, spec and observation fixes.
  - `640a83c` — A5/A6/A8 record corrections (maps and governance).
  - This receipt commit records `b5cd92b` and `640a83c`.
- Worktree: `/Volumes/Intel/playground/agentteams/acp-d05-network-20261010`
- Branch: `codex/acp-d05-network-20261010`
- Forbidden paths in this change and left untouched: `runtime/acp-serve.ts`,
  `cli/agentteams.mjs`, `dsh-adapter/**`, `opencode-adapter/**`,
  `control-protocol/**`, `server/**`. The part-2 fixes touch only
  `network/teams-session.ts`, `network/teams-session.spec.ts`,
  `network/teams-negotiation.spec.ts`,
  `docs/evidence/acp-d05-network-20261010/isolated-transport-observation.mjs`,
  `docs/architecture/verification-map.json`,
  `docs/architecture/mainline-call-map.json` and `docs/development-governance.md`.

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
- Part-2 (A1): the per-frame re-check at `:192`-`:195` now has its own failing
  assertion. Spec `network/teams-session.spec.ts:304` "re-checks generation and
  engine instance on every acp.frame and refuses a stale ref before host.receive"
  opens a channel, then sends an `acp.frame` that reuses the open wire key but
  names a stale `targetGeneration` and, separately, a forged `engineInstanceId`.
  It asserts the typed `acp.error` `STALE_GENERATION` refusal and that the local
  `AcpHost` received zero ingress for both; a genuine frame on the same channel
  still reaches the host. The case fails when the `:192` guard is removed.
- Spec evidence: `network/teams-session.spec.ts` "refuses a forged or stale
  targetGeneration and engineInstanceId without opening a channel", "allocates
  local transport keys and rewrites generation and engine instance before
  host.open", "injects an inbound frame into host.receive with the payload
  preserved byte-for-byte", "closes every channel on transport close and
  refuses a replaced generation" and the new A1 case. The observation repeats
  both refusals over a real TLS socket.

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
- The caller-supplied `peerPolicyRevision` input was removed by D00 amendment
  A1 (2026-10-11). The responder now derives the peer policy revision from
  `TeamsConnectionPropose.sourcePolicyRevision` and the responder's own
  `TeamsConnectionContext.policyRevision`; it never trusts an unauthenticated
  caller-supplied revision. The Lead ruling below records the amended rule.
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
- Part-2 (A6/A8): `runtime/registry-registration.spec.ts` is now part of the
  `teams-acp-d05-network` gate command, because the R4 helpers live in that file
  and were otherwise covered only by the D04-owned gate command. Nothing in
  D04's semantics changed: the existing D04 tests still pass and the
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
  (`network/teams-session.ts:265`-`:270`); there is no replay path. Part-2 (A4)
  extends that release to the throwing exit path of `run()` (`:287`-`:292`).
- `network/teams-connection-history.ts` exposes exactly `record` and `query`;
  `network/teams-membership.ts` stores nothing.

## 2. Focused test surface

Exact gate command and result (part 2; `runtime/registry-registration.spec.ts`
added so the R4 helper spec is inside this gate, A6/A8):

```
pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts
```

Result: `Test Files 6 passed (6)`, `Tests 53 passed (53)`
(teams-negotiation 16, teams-session 13, teams-connection-history 5,
teams-membership 5, registration-client 7 including 2 R4 publication cases,
registry-registration 7 including the R4 declaration case).

The four new part-1 specs were written red first: the first run failed with
`Cannot find module './teams-negotiation.ts'` (4 files, 0 tests) before any
implementation existed. The three part-2 cases were each verified to fail
against the un-fixed code before the fix was restored (A1, A2, A4 below).

Affected regression suites:

```
pnpm exec vitest run --no-file-parallelism network server
```

Result: `Test Files 24 passed (24)`, `Tests 190 passed (190)`.

Gate plus every affected owner suite:

```
pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts runtime/acp-serve.spec.ts runtime/acp-daemon.spec.ts agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts config/daemon-intent.spec.ts config/acp-policy.spec.ts control-protocol
```

Result: `Test Files 24 passed (24)`, `Tests 218 passed (218)`.

Part-1 counts kept for the record (before the part-2 cases): gate 43/43,
`network server` 187/187, gate plus owner suites 215/215.

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

Part-2 (A3): the check that previously read "ack ref rebuilt, not echoed" was
non-discriminating, because a successful `acp.open` can only carry the local
generation/engine values (a mismatch is refused with `STALE_GENERATION`), so
comparing them could not fail. It is replaced
(`isolated-transport-observation.mjs:380`-`:382`) by a check that the `acp.open_ack`
ref is the same ref the listener handed to its own `AcpHost`, recorded by a thin
host wrapper. That check can fail: if the listener echoed the peer wire ref, the
`connectionId`/`channelId` would differ from the local host-open ref. The
generation/engine rebuild of those two fields is therefore proven by the
`STALE_GENERATION` refusal checks and by the session spec's per-frame re-check
(zero host ingress), not by an ack-field comparison. The observation still
counts 23 checks.

## 5. NOT proven (explicit) — D05 stays INCOMPLETE

- **D05 is INCOMPLETE and does not close.** The honest INCOMPLETE list for D05
  closure is:
  1. **Two-real-engine LAN black box.** The observation's peer engine is an
     in-process scripted duplex and the peer agent is in-process. D05 cannot
     close until the two-real-engine LAN run executes against the
     `--serve opencode` and `--serve dsh` entries. This change deliberately does
     not wire the serve entry.
  2. **Serve composition.** `runtime/acp-serve.ts` and `cli/agentteams.mjs` are
     outside this change's scope, so the serve entry does not compose the D05
     chain; `--serve dsh` still has no serve wiring.
  3. **`peerPolicyRevision` wire source.** SUPERSEDED by D00 amendment A1
     (2026-10-11, closure receipt): the unauthenticated caller input no longer
     exists. The responder now derives the peer revision from
     `TeamsConnectionPropose.sourcePolicyRevision` and its own
     `TeamsConnectionContext.policyRevision`. This change did not prove that
     source; the closure change does.
  4. **R4 publication wiring.** `listenerRouteCandidates` and
     `declarationWithPublishedSurfaces` are pure helpers covered at source level;
     no live daemon caller composes them into a running publish loop.
  5. **Live `onConnection`/ingress.** The real `network/direct-listener.ts`
     `onConnection` path is driven only by the isolated observation; no installed
     or live daemon runs it.
  6. **Membership consumer.** The membership view is a projection only. It has
     no live consumer yet, so nothing proves a UI or control daemon renders it.
  7. **Installed / restart / live / AppSDK.** No installed-artifact, no restart,
     no deployed-entrypoint and no browser/UI evidence exists for this change.
     No AppSDK compile/verify run is claimed: `appsdk compile` fails before it
     reads the maps with the pre-existing pin mismatch
     `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014:required_binary=appsdk-0.1.0014`
     (exit 1), which this change did not introduce and does not touch. The five
     architecture maps were therefore validated by JSON parse, gate-id
     cross-reference and the preserved per-map shape, not by the AppSDK gate.
- **Lead ruling (closure shape):** the closure black box is two separate daemons,
  each with its own engine plus its own `AcpHost`, driven by its own client. Two
  real `AcpHost` peers on one ACP channel is semantically impossible and is
  rejected: a callback arriving at the peer host would be handled as a client
  request. One real host side is the honest maximum for this channel shape.
- **Lead ruling (`peerPolicyRevision`):** SUPERSEDED by D00 amendment A1
  (2026-10-11). The ruling below kept the revision strict and unguessable, and
  that part still holds; the part that required an authenticated caller-supplied
  input is gone. A1 carries both revisions inside the frozen frames
  (`TeamsConnectionContext.policyRevision`,
  `TeamsConnectionPropose.sourcePolicyRevision`), so the responder no longer
  consumes a caller-supplied value and invents no source. The historical
  ruling: `peerPolicyRevision` was a required authenticated input that must
  never be guessed or defaulted.

## 6. Part-2 review-fix round (A1-A8)

| Finding | Resolution | Location |
| --- | --- | --- |
| A4 (real defect) | `run()` awaits `close()` inside the `finally`, so every exit path — including a malformed/unexpected frame that throws out of `receive()` — releases the host channels and the transport. New spec asserts both releases, not only error propagation. Verified red against the un-fixed `run()`. | `network/teams-session.ts:287`-`:292`; spec `network/teams-session.spec.ts:477` "closes the host channel and the transport when an unexpected inbound frame aborts the read loop" |
| A1 (missing failing assertion) | New spec opens a channel, then sends an `acp.frame` with a stale `targetGeneration` and a forged `engineInstanceId` on the open wire key; asserts typed `STALE_GENERATION` and zero `AcpHost` ingress, and that a genuine frame still reaches the host. Verified red with the `:192` guard neutralized. | implementation `network/teams-session.ts:192`-`:195`; spec `network/teams-session.spec.ts:304` "re-checks generation and engine instance on every acp.frame and refuses a stale ref before host.receive" |
| A2 (evidence precision) | Added a case that exercises this module's own outbound role-pair guard at the initiator start boundary (the frozen parser is not involved on that path). The existing responder-side `master/master` case now carries a comment that the frozen parser catches it. Verified red with `assertRolePair` neutralized. | guard `network/teams-negotiation.ts:244`; spec `network/teams-negotiation.spec.ts:161` "refuses an outbound master/master role pair at the initiator start boundary" |
| A3 (observation precision) | Removed the non-discriminating ack generation/engine equality and replaced it with a check against the ref the listener passed to its own `AcpHost`, which can fail. | `docs/evidence/acp-d05-network-20261010/isolated-transport-observation.mjs:380`-`:382` |
| A5 (D04 stale count) | Recorded here, not edited: the D04-owned `teams-acp-d04-registry` row still says 73/73, but the command now runs **75/75** (verified on this candidate: `server/relay 29, network/relay-client 21, network/registration-client 7, server/registry-intent 5, runtime/registry-process 6, runtime/registry-registration 7`). The extra two cases are the part-1 R4 additions in `network/registration-client.spec.ts` and `runtime/registry-registration.spec.ts`. The D04 row and the `acp-registry-v1` note belong to another owner and were left untouched. | receipt only |
| A6/A8 (own records) | The `acp-teams-network-v1` note no longer claims 50/50 for a gate that ran 43; the D05 gate command now includes `runtime/registry-registration.spec.ts` (the R4 helper spec), and the recorded count is the real 53/53. | `docs/architecture/mainline-call-map.json`; `docs/architecture/verification-map.json`; `docs/development-governance.md` |

Exact commands and results for this round:

```
pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts
# Test Files 6 passed (6); Tests 53 passed (53)

pnpm exec vitest run --no-file-parallelism network server
# Test Files 24 passed (24); Tests 190 passed (190)

pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts runtime/acp-serve.spec.ts runtime/acp-daemon.spec.ts agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts config/daemon-intent.spec.ts config/acp-policy.spec.ts control-protocol
# Test Files 24 passed (24); Tests 218 passed (218)

pnpm typecheck            # exit 0
pnpm build:runtime        # exit 0
node --experimental-transform-types docs/evidence/acp-d05-network-20261010/isolated-transport-observation.mjs
# OBSERVATION PASSED: 23 checks.

# D04 gate, run read-only to confirm the stale count (not edited):
pnpm exec vitest run --no-file-parallelism server/relay.spec.ts network/relay-client.spec.ts network/registration-client.spec.ts server/registry-intent.spec.ts runtime/registry-process.spec.ts runtime/registry-registration.spec.ts
# Test Files 6 passed (6); Tests 75 passed (75)
```

Red evidence for the three new cases (each run with only the relevant guard
neutralized, then the fix restored and the suite re-run green):
- A4: `session.channels` stayed length 1 and the transport was never closed.
- A1: the stale `acp.frame` reached `host.receive` (`host.ingresses` length 1).
- A2: `startTeamsNegotiation(master/master)` did not throw.

## 7. Map and governance bindings (same change)

- `docs/architecture/verification-map.json`: new `teams-acp-d05-network` gate
  (owner `network`, status `partial`, `required: true`) with the focused command
  above. Part-2 adds `runtime/registry-registration.spec.ts` to that command and
  updates the note to 53/53.
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
  with six owner edges and three planned bindings. Part-2 corrects its note to
  53/53. The `acp-serve-entry-v1` and `acp-dsh-engine-v1` rows were left
  untouched, and so was the D04-owned `acp-registry-v1` note.
- `docs/development-governance.md`: new D05 gate row plus a D05 paragraph, and
  the serve-entry row now states that D05 is delivered at source level but not
  composed by that entry. Part-2 adds the R4 helper spec to the D05 gate row and
  records 53/53.
- `.appsdk/project.json` was not modified: `network/**`, `runtime/**`, `cli/**`
  and `docs/**` are already `teams-source` owned/regression inputs, and
  `minimum_test_count: 304` is a minimum.

Five-map validation on this candidate: all five `docs/architecture/*.json` maps
parse; every `required_gates` reference in `function-map.json` and
`mainline-call-map.json` resolves to a `verification-map.json` gate id (0
missing); and the `teams-acp-d05-network` command string is byte-identical
between `verification-map.json` and the `development-governance.md` gate row.
`resource-map.json` and `module-registry.json` were unchanged by the part-2
records.

## 8. Resource cleanup

- The observation script creates one temporary directory and removes it in a
  `finally` block; it closes the listener, every client target and every session
  explicitly by handle. No `pkill`, `killall` or `kill $(...)` is used anywhere.
  Only explicit handles are closed.
- The part-2 verification created no stray processes and no leftover temporary
  directories (checked after the runs).
- The worktree and branch are retained until the parent integrates or discards
  them.
