# L9 increment receipt: the production initiator egress composer

- Task: compose the initiator side of one Teams connection in production code, so
  the A3 primitive delivered in L8 has a caller. Before this increment
  `network/teams-ingress.ts` was the only Teams connection composer in production
  and it answered `acp.open`; nothing sent one.
- Base: `main == origin/main == 0f9c1d0` (the L8 candidate, already integrated).
- Worktree: `/Volumes/Intel/playground/agentteams/acp-l9-initiator-20261013`
- Branch: `codex/acp-l9-initiator-20261013`
- Changed files in this increment: `network/teams-egress.ts`,
  `network/teams-egress.spec.ts`, `docs/architecture/function-map.json`,
  `docs/architecture/mainline-call-map.json`,
  `docs/architecture/verification-map.json`,
  `docs/architecture/module-registry.json`,
  `docs/design/teams-acp-daemon-config-v4.md`,
  `docs/development-governance.md`, and this receipt
  `docs/evidence/acp-l9-egress-20261013/notes.md`.
- Untouched: `network/teams-session.ts`, `control-protocol/**`, `agent-host/**`,
  `runtime/**`, `console-host/**`, `ui/**`.

Every surface below is reported separately. A later surface is never inferred
from an earlier one.

## 1. Source surface (delivered)

`network/teams-egress.ts` exposes `openTeamsEgress(input): Promise<TeamsEgressHandle>`
plus `TeamsEgressSocket`, `TeamsEgressEndpoint`, `OpenTeamsEgressInput` and
`TeamsEgressHandle`. It is the initiator counterpart of `openTeamsIngress` and it
composes only; it declares no mechanism of its own.

Order of operations, fixed:

1. Input guards: a non-empty `connectionId` and `engineInstanceId` are required,
   and a policy that belongs to another engine instance is refused with
   `STALE_GENERATION` before the socket is used.
2. `createTeamsFrameTransport(connection, peer)` is reused, not re-declared. It is
   the single bytes/JSON boundary owner, shared with `openTeamsIngress`.
3. `ledger.open` records `negotiating`; a live connection id already present is a
   `CONFLICT` the egress cannot swallow, so a dial cannot silently replace a live
   ledger record.
4. `runTeamsNegotiation` with `side: 'initiator'` and the `TeamsInitiatorOptions`
   contract exactly as it exists (`requestedRole`, `requestedPeerRole`,
   `requestedCapabilities`, `requestId`, `expectedTargetGeneration`,
   `expectedTargetCapabilitiesRevision`). No field was invented; the first draft of
   this module did not compile against these options and was corrected to the real
   contract rather than by widening it.
5. An agreed negotiation records `connection.negotiated` and marks the ledger
   `ready`. Anything else is one `connection.failed` fact, a `failed` ledger entry,
   a closed transport and the thrown typed fault.
6. The injected host is wrapped in a channel-lifecycle observer that records
   `channel.opened` / `channel.closed`. It forwards `open`, `receive`, `read` and
   `close` unchanged and adds only history writes.
7. `createTeamsSession(...)` is created once and `session.open()` is driven by the
   egress, because the egress must fail its own call on a handshake the peer never
   acknowledged. `session.run()` is started by the egress and never awaited by its
   caller; `done` records the closing ledger fact on either outcome.

The egress never answers an `acp.open` and never sends `acp.open_ack`. R1 holds: it
carries only the frozen Teams frames and declares no second envelope. R2 holds:
`createTeamsSession` allocates this side's `connectionId`/`channelId`, hands the
host only the local ref and keeps the target's `targetGeneration`/`engineInstanceId`
on the wire ref, so the observer above only ever sees local refs.

## 2. Test surface (8 cases, all passing)

`network/teams-egress.spec.ts` runs the **real** responder composer
(`openTeamsIngress`), the **real** `createTeamsSession` on both ends and the
**real** `createAcpHost` on both ends over a socket pair that carries real JSON
bytes. Nothing about the handshake, the host ref rule or the wire frames is mocked,
so a defect that a mock host would hide fails these cases.

1. `negotiates, opens the one channel and hands the host only its own ref` — the
   agreement is agreed, exactly one channel exists, the host-facing ref carries
   `conn-a` / generation 11 / `engine-a`, the adopted peer ref names `conn-b`, the
   wire `acp.open` carries the target pair (generation 22, `engine-b`), the
   responder's `acp.open_ack` carries its own pair, and the initiator never sends an
   ack of its own.
2. `relays a real engine callback to the initiator host with its own ref and a
   fresh outward id` — a permission callback raised by the responder engine reaches
   the initiator host addressed with `conn-a` / `engine-a` and a fresh outward id,
   never the engine's own id.
3. `fails the dial with the peer capability refusal, marks the ledger failed and
   closes the transport` — the responder admits the roles but no capability, so the
   dial fails with `CAPABILITY_DENIED` (not a timeout), one `connection.failed` is
   recorded with that code, the ledger entry is `failed`, the transport is closed
   once, no `connection.negotiated` is recorded and no host channel opens.
4. `records the negotiation and the channel, then closes the ledger when the
   session ends` — `connection.negotiated` then `channel.opened` are recorded in
   order, the ledger is `ready` with the remote agent id, and after
   `session.close()` the ledger entry becomes `closed` and `channel.closed` is
   recorded. The durable `channel.opened` record carries this side's own
   `connectionId` (never the peer's), the local `engineInstanceId` and the local
   channel id.
5. `refuses a dial whose policy belongs to another engine instance before it
   touches the socket` — `STALE_GENERATION`, nothing on the wire, no ledger entry,
   no history entry.
6. `refuses a reused connection id instead of replacing the live ledger record` —
   the second dial goes through `openTeamsEgress` itself, `ledger.open` is a
   `CONFLICT` for an id already live, the live record survives untouched and
   nothing reaches the wire.
7. `records connection.failed and a failed ledger when an unexpected frame aborts
   the read loop` — the responder sends a well-formed but foreign Teams frame
   (`teams.connection.context`) after the open; the initiator session rejects it
   typed, the read loop ends, the egress records exactly one `connection.failed`
   with `INVALID_ACP_FRAME` and the ledger entry becomes `failed` (the peer never
   gets a chance to leave a ready record and silence).
8. `reports a history write failure through onHistoryFault and never blocks the
   live connection` — a history whose `record` throws is injected; the dial still
   reaches `agreed`, the channel opens on both ends, the ledger stays `ready`, and
   `onHistoryFault` reports `HISTORY_UNAVAILABLE` without the connection changing.

Red-first evidence, measured as mutations against the delivered code. Each mutation
was applied, the suite was run, the file was restored and the suite was re-run green;
the restore was verified with `diff -q` (byte-identical) and `git status` was clean
afterwards.

| # | Mutation | Result |
|---|----------|--------|
| M1 | drop the engine-instance guard in `openTeamsEgress` | exactly case 5 fails |
| M2 | stop recording `channel.opened` in the observing host | exactly case 4 fails |
| M3 | stop closing the transport on the failure path | exactly case 3 fails |
| M4 | stop recording `connection.negotiated` | exactly case 4 fails |
| M5 | put the peer's `connectionId` on the outgoing `acp.open` wire ref | exactly case 1 fails |
| M6 | remove the read-loop failure handling in `done` | exactly case 7 fails |
| M7 | write a peer connection id into the durable `channel.opened` record | exactly case 4 fails |
| M8 | name the peer generation in the failed ledger entry | exactly cases 3 and 7 fail |
| M9 | swallow the history write failure instead of reporting it | exactly case 8 fails |
| M10 | let the egress skip `ledger.open` on the reused id | case 6 fails (the second dial opens a second record) |

M5 is the R2 rule the earlier standalone draft got wrong, and case 1 catches it.
M6–M9 were added after the first independent review: the reviewer proved that
without them, three failure-handling defects (a leaked ready ledger, a peer key
that could reach durable history, an unasserted failed-ledger generation) and one
dead assertion surface all survived the 6-case suite.

M5 is the R2 rule the earlier standalone draft got wrong, and case 1 catches it.
M6–M9 were added after the first independent review: the reviewer proved that
without them, three failure-handling defects (a leaked ready ledger, a peer key
that could reach durable history, an unasserted failed-ledger generation) and one
dead assertion surface all survived the 6-case suite.

## 3. Gate surface

- `teams-acp-d05-network` declared command, with `network/teams-egress.spec.ts`
  added: `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts
  network/teams-session.spec.ts network/teams-connection-history.spec.ts
  network/teams-membership.spec.ts network/registration-client.spec.ts
  runtime/registry-registration.spec.ts network/teams-ingress.spec.ts
  network/teams-status.spec.ts network/teams-egress.spec.ts
  control-protocol/teams-connection.spec.ts` → **98/98**
  (negotiation 22, session 26, connection-history 5, membership 5,
  registration-client 7, runtime/registry-registration 7, ingress 6, status 3,
  teams-connection 9, egress 8).
- `teams-acp-d06-control` declared command → **118/118** (unchanged by this
  increment; no control-process, acp-host, acp-serve, agentteams, http-api or
  console-api file was touched).
- `pnpm exec tsc -p tsconfig.json --noEmit` → exit 0.
- `git status --porcelain` → empty at commit time.

## 4. Not delivered, and not inferred

- **No daemon composes an egress.** `runtime/acp-serve.ts` still calls only
  `openTeamsIngress`. There is no production caller for `openTeamsEgress` yet, so no
  deployed process can dial an initiator channel.
- **No control-plane write side.** `runtime/control-process.ts` still hardcodes
  `sessions: []`, `notifications: []`, `configs: []`, still passes no `owner` to
  `createControlOwner`, and still answers `connection.connect`,
  `connection.disconnect`, `network.membership.apply` and `permission.reply` with
  typed refusals.
- **No Session/permission/notification event stream** behind SSE.
- **No installed-artifact, restart, deployed-entrypoint, live-browser or
  cross-device evidence.** Nothing in this increment was run from an installed copy
  or through a browser.
- **`pnpm verify` stays a recorded BLOCKED gate.** It fails at
  `scripts/regression.mjs` on a pre-existing load flake unrelated to this change
  (proven on the pristine base in the L8 increment).
- All eleven `teams-acp-*` gates stay `partial`.

## 5. Notes on how this increment was reached

- The first attempt at this milestone was a standalone `createTeamsEgress` that
  re-implemented the session handshake. It was rejected on evidence, not on
  preference: it set the host-facing `localRef` from the responder's
  `targetGeneration` and `targetEngineInstanceId`, which the real `AcpHost.open`
  refuses with `STALE_GENERATION` (`agent-host/acp-host.ts`), and its tests passed
  only because they used a host double that does not validate that pair. It also
  duplicated the channel map, the cursor and the release bookkeeping that
  `teams-session.ts` already owns, and its own mutation evidence included the
  "a peer ref reached the host" defect (call it M2) that the second owner would have
  made permanent. That draft is not merged and stays outside every worktree at
  `/Volumes/Intel/playground/agentteams/.l9-draft-recovery-20261013/` for the
  record.
- `TeamsInitiatorOptions` requires `requestId`, `expectedTargetGeneration`,
  `expectedTargetCapabilitiesRevision`, and it has no `admittedCapabilities` field.
  The egress takes these from its caller and passes them through unchanged. It does
  not widen the frozen negotiation contract to make its own input shape convenient.
- An independent review (2026-10-14) of the 6-case candidate returned FAIL with
  five findings, all coverage gaps rather than code defects: (1) a read-loop
  failure after a successful open was not proven to fail the ledger; (2) the
  durable `channel.opened` record's `connectionId` was unasserted, so a peer key
  could reach history without a test catching it; (3) the failed ledger's
  `targetGeneration` was unasserted and silently accepted the peer's generation;
  (4) `historyFaults` was collected but never asserted; (5) the reused-connection-id
  case called `ledger.open` directly and never exercised the egress. The reviewer
  also flagged that this receipt counted 6 changed files while listing 7 names.
  All five were fixed by adding cases 7 and 8, by asserting the `connectionId` and
  the failed `targetGeneration` in cases 3 and 4, by asserting `historyFaults` in
  case 8, and by sending the second dial through `openTeamsEgress` in case 6. The
  ten mutations M1–M10 above are the red-first evidence for every one of those
  assertions, each restored byte-identical. The counts in this receipt and in the
  maps now read 98/98 (egress 8).

## 6. Environment

- node v22.22.2, pnpm 10.31.0.
- opencode 1.18.23 at `/Users/fanzhang/.opencode/bin/opencode`; dsh at
  `/opt/homebrew/bin/dsh`.
- All egress cases run in-process over a socket pair that carries real JSON text
  frames; no network listener is opened by this increment.
