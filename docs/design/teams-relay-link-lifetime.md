# Relay link admission and lifetime — 4e04166 design slice

Status: implemented candidate. Independent design review r2 passed before the
product change. `server/relay.ts` implements the admitted model and
`server/relay.spec.ts` covers its public TLS/WSS behavior. Public deployment
remains deferred.

## Problem and bounded decision

U3's real local browser consumer reproduced channel termination during
`context.create` with admission TTL 10000 ms. A direct Camo creation took
7.811 s; destruction took 8.483 s. With only diagnostic fixture TTL changed
to 60000 ms, two real creations succeeded and the third was rejected for
capacity. The later navigate rejection belongs to U4's fixed-operation versus
persistent-capability binding and is outside this slice.

Current `server/relay.ts` and its `stops forwarding after an opened grant
expires` test deliberately apply `grant.expiresAt` to opened data channels.
Local configuration defaults to 5000 ms. This policy cannot provide a normal
long-lived transport to a slow browser Work. Increasing TTL only moves the
failure. A retry could duplicate business effects and is forbidden.

`grant.expiresAt` will be the deadline for completing BOTH data-side admission
handshakes. After both sides are admitted before this deadline, the channel
remains valid while its two original authenticated control connections and
generations remain current. It closes on either data/control disconnection,
generation replacement, explicit owning shutdown, or a transport limit/error.
No grant renewal protocol, second scheduler, automatic replay, new editable
configuration, or alternate route is added. The server still owns transport
admission and revocation. The provider still owns Work/resource admission.

## Object, roles and state

Object: one authenticated Relay link connecting a single source and target.
Server owner: `RelayServer` in `server/relay.ts`. Network clients submit typed
`relay.connect` and `relay.open` controls; they do not extend authorization.
The Console does not participate. Business frames stay opaque on dedicated
data sockets. Errors and generation/expiry facts stay on typed control frames.

States: pending (zero or one data side), opened (both sides), closed (terminal).
The existing grant store and each socket's `opened` flag remain the truth.
The implementation must not add a competing lifetime registry.

| State/event | Owner/guard | Next state and observable result |
|---|---|---|
| no link / relay.connect | server authenticates scope and current generations; capacity available | pending; source gets grant, target gets offer |
| pending / first relay.open | server authenticates participant and original control connection; now < expiresAt | pending; one side held, no forwarding |
| pending / second relay.open | same guards and now < expiresAt | opened; both relay.opened receipts; admission timer cancelled |
| pending / deadline | server clock; both sides have not completed admission | closed; typed UNAVAILABLE and both owned data sockets closed |
| opened / admission deadline | deadline no longer governs an admitted link | opened; opaque frames still reach the paired socket |
| any live state / stale control generation or side disconnect | server's existing connection invalidation/close owner | closed; paired channels revoked and grant capacity released |
| any live state / backpressure or payload limit | existing transport limit owner | closed; typed transport error, no injected business control JSON |
| closed / any reuse | existing lookup/authentication owner | explicit missing/stale failure; no reopening or business replay |

Duplicate side opens remain CONFLICT. Expired pending or half-open grants
remain rejected. Opened grants still consume bounded `maxGrants` and connection
capacity until closed. This prevents an unbounded number of active links.

## DAG and implementation boundary

The static object flow is
`relay.link.intent -> authorize-link -> pair-data-sides -> forward-link ->
release-link -> relay.link.receipt` in
`docs/design/dagpipe/graphs/relay-link.graph.json`. Each node has one input/output ARC.
Pairing and forwarding events remain internal state transitions of their node;
there is no cross-node back edge. Every failure/cancellation is consumed by
the release owner and reaches the same terminal receipt.

These are static governance Operator bindings to the existing server owner,
not executable Work SDK Operators. U4's Work graphs and registry do not change.
Every ARC after intent carries the link's typed outcome discriminator:
`active | failed | cancelled`, with its owned socket references or the explicit
control error and any retained obligation. A failed/cancelled input crosses
the remaining nodes without further admission or forwarding effects and reaches
`release-link`. Its sole output is `relay.link.receipt` with
`closed | rejected | cleanup-required`. Release never claims a socket or
provider resource was closed without the owning operation's confirmation.
`teams.open-work-link@1` consumes the network channel; this design corrects its
transport dependency, not provider ledger state or Session payload semantics.

| Node/binding | ARC and effect | Terminal/validation |
|---|---|---|
| authorize-link / teams.authorize-relay-link@1 | intent -> admitted; existing authenticate/connect/current generation and grant capacity | typed auth/scope/stale/capacity failure or grant/offer |
| pair-data-sides / teams.pair-relay-data@1 | admitted -> channel; existing openDataConnection; expire pending only | opened receipts or expired/duplicate/stale failure; half-open cleanup |
| forward-link / teams.forward-relay-link@1 | channel -> outcome; existing forwardData; opaque business bytes | bytes delivered after deadline; side close/stale/limit/shutdown failure |
| release-link / teams.release-relay-link@1 | outcome -> receipt; existing closeGrant/invalidateGrantsForConnection | both data sockets closed, store capacity released, owning test server closed |

Implementation after independent design PASS is limited to `server/relay.ts`,
`server/relay.spec.ts`, corresponding server-owned map entries, and this
contract's integration into `docs/design/teams-service-contracts-r1.md` and
`server/relay-process.md`. The pending checks in openDataConnection keep their
deadline. Completion of pairing cancels the deadline timer. forwardData and
purgeExpiredGrants apply expiry only to pending links. expireGrant cannot
terminate an already opened pair, including a queued timer callback.
Existing invalidation, scope/generation checks, backpressure and close logic
remain authoritative. No runtime/config/network/client/Work/U3 changes.

## Verification and delivery

Prerequisites are available: current server source and tests, real TLS/WSS
fixture, server/Relay client public interfaces, installed package smoke, exact
review, normal Git integration, and explicit owned-resource cleanup. The
existing U3 diagnostic evidence is at
`~/.codex/task-evidence/agentteams/receipts/u3-camo-services-complete-20261004/`.
This design passed independent read-only review before the product code change.

The existing five architecture maps bind this server-owned subflow. Required
gate `teams-relay-link-topology` validates and inspects the graph and runs the
server-owned public TLS/WSS regression. Topology PASS alone is design evidence;
the implementation and public behavior are covered by `server/relay.spec.ts`.
Public Relay/NAT deployment remains deferred.

1. Add a red public test for an opened authenticated pair forwarding both
   directions after the original deadline. Use the real socket boundary and
   server timer or explicit injected clock, not private state inspection.
2. Retain positive expiry of unopened and half-open grants. Check duplicate,
   cross-scope, stale generation, replacement/disconnection, payload limits,
   `maxGrants` admission and released capacity. Do not simply delete expiry
   tests or increase TTL to pass.
3. Run `pnpm exec vitest run --no-file-parallelism server/relay.spec.ts
   server/relay-process.spec.ts network/relay-client.spec.ts`, then typecheck,
   build, graph validation and applicable source/installed package admission.
4. A real delayed public channel consumer must show the old server fails at
   the deadline and the candidate succeeds, then closes its own sockets and
   server. Full Camo create/navigate/snapshot/destroy remains dependent on
   U3/U4 and cannot be claimed by this link-only proof.
5. Bind evidence to the exact candidate, independently review the tested
   implementation, integrate/push one unit, preserve receipts, and remove
   owned processes/worktree. Any failed/blocked/cancelled node records its
   original error, owner and next action. Keep issue open until these finish.
