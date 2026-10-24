import type { AuthenticatedAgent } from '../packages/shared/src/agent-services.ts'
import type { AcpFault } from '../packages/shared/src/acp.ts'
import { AcpError } from '../packages/shared/src/acp.ts'
import type { RelationRole } from '../packages/shared/src/teams-connection.ts'
import type { AcpPolicySnapshot } from '../config/acp-policy.ts'
import type { AcpHost } from '../agent-host/acp-host.ts'
import type { TeamsConnectionHistory, TeamsConnectionHistoryEntry } from './teams-connection-history.ts'
import {
  negotiatedAgreement,
  negotiationFault,
  runTeamsNegotiation,
  type TeamsNegotiationState,
} from './teams-negotiation.ts'
import { createTeamsFrameTransport, type TeamsConnectionLedger } from './teams-ingress.ts'
import { createTeamsSession, type TeamsSession } from './teams-session.ts'

/**
 * Teams production egress (owner: network).
 *
 * It is the initiator counterpart of `openTeamsIngress`: this daemon dials an
 * already-admitted peer, negotiates as the initiator over the frozen frames only,
 * opens the one ACP channel with `createTeamsSession.open()` and then serves the
 * peer through the injected `AcpHost`. `network/teams-ingress.ts` answers an
 * `acp.open` and never sends one; this module sends one and never answers.
 *
 * The egress owns composition only. Every mechanism it needs already has exactly
 * one owner and this module reuses it:
 *
 * - the byte/JSON socket boundary: `createTeamsFrameTransport` (ingress owner);
 * - the negotiation state machine: `runTeamsNegotiation`;
 * - the ACP channel handshake, the inbound mapping, the delivery pump and the
 *   release rules: `createTeamsSession`, including the D00 amendment A3
 *   initiator `open()` that names the peer's own engine instance on `acp.open`;
 * - the durable `kind=connection` facts: the injected `TeamsConnectionHistory`;
 * - the live connection truth: the injected `TeamsConnectionLedger`.
 *
 * R1: the egress carries only the frozen Teams frames and declares no second
 * envelope. It never sends `acp.open_ack`.
 *
 * R2: a peer wire ref never reaches the host. `createTeamsSession` allocates this
 * side's `connectionId`/`channelId`, hands the host only the local ref, and keeps
 * the target's `targetGeneration`/`engineInstanceId` on the wire ref, so the
 * observing wrapper below sees local refs only.
 *
 * Live connection truth lives in the ledger, never in the history log: history is
 * the durable record and the ledger is the live view.
 */

const DEFAULT_TIMEOUT_MS = 10_000

/** The byte-level socket this daemon dialed and authenticated. */
export interface TeamsEgressSocket {
  /** Resolves when the socket is gone, from either side. */
  readonly closed: Promise<unknown>
  read(): Promise<{ readonly bytes: Buffer; readonly binary: boolean }>
  send(frame: { readonly bytes: Buffer; readonly binary: boolean }): Promise<void>
  close(): Promise<void>
}

export interface TeamsEgressEndpoint {
  /** The authenticated peer identity; never read from a payload. */
  readonly peer: AuthenticatedAgent
  readonly connection: TeamsEgressSocket
}

export interface OpenTeamsEgressInput {
  readonly endpoint: TeamsEgressEndpoint
  /** This daemon's own authenticated identity. */
  readonly self: AuthenticatedAgent
  readonly selfGeneration: number
  readonly selfCapabilitiesRevision: string
  /** The accepted config revision; never a policy snapshot hash. */
  readonly selfPolicyRevision: number
  readonly allowedRoles: readonly RelationRole[]
  /** The role this side asks for and the role it asks the peer to take. */
  readonly requestedRole: RelationRole
  readonly requestedPeerRole: RelationRole
  /** The capabilities this side asks for; the peer admits or refuses each. */
  readonly requestedCapabilities: readonly string[]
  /** The fresh request id for this one negotiation attempt. */
  readonly requestId: string
  /** The target generation and capability revision from the directory/route. */
  readonly expectedTargetGeneration: number
  readonly expectedTargetCapabilitiesRevision: string
  /** The connection id this side allocates for the dialed transport. */
  readonly connectionId: string
  readonly host: AcpHost
  readonly policy: AcpPolicySnapshot
  readonly engineInstanceId: string
  readonly history: TeamsConnectionHistory
  readonly ledger: TeamsConnectionLedger
  readonly timeoutMs?: number
  readonly openTimeoutMs?: number
  readonly pollIntervalMs?: number
  /** Live clock; defaults to the system clock. */
  readonly now?: () => string
  /** Observable history-write failure; never carried inside a Teams frame. */
  readonly onHistoryFault?: (fault: AcpFault) => void
}

export interface TeamsEgressHandle {
  readonly connectionId: string
  readonly peer: AuthenticatedAgent
  readonly negotiation: TeamsNegotiationState
  /** The session whose one channel is already open; it serves the peer. */
  readonly session: TeamsSession
  /** Settles when the session read loop ends; a read-loop failure is recorded, never thrown here. */
  readonly done: Promise<void>
}

function faultFrom(error: unknown): AcpFault {
  if (error instanceof AcpError) return error.toFault()
  return { code: 'RESULT_UNKNOWN', message: error instanceof Error ? error.message : 'teams-egress: the connection failed' }
}

function assertNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AcpError('INVALID_ACP_FRAME', `teams-egress: ${label} must be a non-empty string`)
  }
  return value
}

/**
 * Open the initiator side of one authenticated connection.
 *
 * The order is fixed and never rearranged: ledger, negotiation, then the ACP
 * handshake. A rejected or timed-out negotiation records `connection.failed`,
 * marks the ledger entry failed, closes the transport and throws the typed fault,
 * so the dialing caller can report or retry. A peer that agreed but published no
 * D00 amendment A3 engine instance fails inside `session.open()` and is released
 * exactly like any other handshake failure.
 *
 * An agreed negotiation records `connection.negotiated`, creates the session,
 * opens the one channel, records `channel.opened` and starts the read loop; the
 * caller never awaits the loop.
 */
export async function openTeamsEgress(input: OpenTeamsEgressInput): Promise<TeamsEgressHandle> {
  assertNonEmpty(input.connectionId, 'connectionId')
  assertNonEmpty(input.engineInstanceId, 'engineInstanceId')
  if (input.policy.engineInstanceId !== input.engineInstanceId) {
    throw new AcpError('STALE_GENERATION', 'teams-egress: the policy belongs to a different engine instance')
  }
  const { peer, connection } = input.endpoint
  const connectionId = input.connectionId
  const now = input.now ?? (() => new Date().toISOString())
  const transport = createTeamsFrameTransport(connection, peer)

  // Append after an effect already happened: report a write fault, never block
  // live behavior and never let it corrupt transport or session state.
  const record = async (entry: TeamsConnectionHistoryEntry): Promise<void> => {
    try {
      await input.history.record(entry)
    } catch (cause) {
      input.onHistoryFault?.(faultFrom(cause))
    }
  }

  const markLedgerFailed = (error: AcpFault): void => {
    try {
      input.ledger.update({
        remoteAgentId: peer.agentId,
        connectionId,
        state: 'failed',
        targetGeneration: input.selfGeneration,
        observedAt: now(),
        error,
      })
    } catch { /* the ledger is a live view; a missing entry never masks the typed failure */ }
  }

  const fail = async (fault: AcpFault): Promise<never> => {
    await record({ event: 'connection.failed', agentId: peer.agentId, occurredAt: now(), connectionId, error: fault })
    markLedgerFailed(fault)
    try { await transport.close() } catch { /* the socket is already gone */ }
    throw new AcpError(fault.code, fault.message)
  }

  input.ledger.open({
    remoteAgentId: peer.agentId,
    connectionId,
    state: 'negotiating',
    targetGeneration: input.selfGeneration,
    observedAt: now(),
  })

  let negotiation: TeamsNegotiationState
  try {
    negotiation = await runTeamsNegotiation({
      options: {
        side: 'initiator',
        connectionId,
        self: input.self,
        peer,
        selfGeneration: input.selfGeneration,
        selfCapabilitiesRevision: input.selfCapabilitiesRevision,
        selfPolicyRevision: input.selfPolicyRevision,
        allowedRoles: input.allowedRoles,
        requestedRole: input.requestedRole,
        requestedPeerRole: input.requestedPeerRole,
        requestedCapabilities: input.requestedCapabilities,
        requestId: input.requestId,
        expectedTargetGeneration: input.expectedTargetGeneration,
        expectedTargetCapabilitiesRevision: input.expectedTargetCapabilitiesRevision,
      },
      port: transport,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  } catch (cause) {
    return await fail(faultFrom(cause))
  }

  if (negotiation.state !== 'agreed') {
    return await fail(negotiationFault(negotiation))
  }

  const agreement = negotiatedAgreement(negotiation)
  await record({ event: 'connection.negotiated', agentId: peer.agentId, occurredAt: now(), connectionId, agreement })
  input.ledger.update({
    remoteAgentId: peer.agentId,
    connectionId,
    state: 'ready',
    targetGeneration: input.selfGeneration,
    role: agreement.sourceRole,
    observedAt: now(),
  })

  // Observe channel lifecycle without ever seeing a peer wire ref: the session
  // passes this wrapper only the local ref it allocated itself.
  const observingHost: AcpHost = {
    open: async openInput => {
      await input.host.open(openInput)
      await record({
        event: 'channel.opened',
        agentId: peer.agentId,
        occurredAt: now(),
        connectionId,
        channelId: openInput.ref.channelId,
        engineInstanceId: openInput.ref.engineInstanceId,
        agreement,
      })
    },
    receive: ingress => input.host.receive(ingress),
    read: (ref, afterSequence, limit) => input.host.read(ref, afterSequence, limit),
    close: async ref => {
      await input.host.close(ref)
      await record({
        event: 'channel.closed',
        agentId: peer.agentId,
        occurredAt: now(),
        connectionId,
        channelId: ref.channelId,
        engineInstanceId: ref.engineInstanceId,
      })
    },
    // The wrapper observes channel lifecycle and must not hide what it wraps.
    pendingPermissions: () => input.host.pendingPermissions(),
    channelForSession: sessionId => input.host.channelForSession(sessionId),
    openedSessions: () => input.host.openedSessions(),
  }

  const session = createTeamsSession({
    negotiation,
    connectionId,
    transport,
    host: observingHost,
    policy: input.policy,
    engineInstanceId: input.engineInstanceId,
    ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
  })

  // The handshake is the egress's own step, so a channel the peer never
  // acknowledged fails here with a typed fault instead of inside the read loop,
  // and the transport is closed on the way out.
  try {
    await session.open({ timeoutMs: input.openTimeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  } catch (cause) {
    return await fail(faultFrom(cause))
  }

  const done = session.run().then(
    () => {
      input.ledger.close(connectionId, now())
    },
    async cause => {
      const fault = faultFrom(cause)
      await record({ event: 'connection.failed', agentId: peer.agentId, occurredAt: now(), connectionId, error: fault })
      markLedgerFailed(fault)
    },
  )
  void done
  return { connectionId, peer, negotiation, session, done }
}
