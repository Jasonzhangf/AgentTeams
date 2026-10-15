import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpFault } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { RelationRole } from '../control-protocol/teams-connection.ts'
import type { AcpPolicySnapshot } from '../config/acp-policy.ts'
import type { AcpHost } from '../agent-host/acp-host.ts'
import type { MembershipChannelObservation } from './teams-membership.ts'
import type { TeamsConnectionHistory, TeamsConnectionHistoryEntry } from './teams-connection-history.ts'
import {
  negotiatedAgreement,
  negotiationFault,
  runTeamsNegotiation,
  type TeamsNegotiationState,
} from './teams-negotiation.ts'
import { createTeamsSession, type TeamsSession, type TeamsSessionTransport } from './teams-session.ts'
import type { WssFrame } from './wss-connection.ts'

/**
 * Teams production ingress (owner: network).
 *
 * It turns one authenticated direct-WSS connection into the responder side of
 * the D05 chain: the frozen Teams negotiation, then one authenticated ACP
 * session into the injected `AcpHost`. It is the only production composer of
 * `runTeamsNegotiation` + `createTeamsSession`; the isolated observation drives
 * the same two functions directly.
 *
 * R1: the ingress carries only the frozen Teams frames. It never sends
 * `acp.open` (the remote initiator opens the channel) and declares no second
 * envelope.
 *
 * R2: the ingress never hands a peer wire ref to the host. It wraps the host
 * only to observe `open`/`close`; `createTeamsSession` allocates this side's
 * `connectionId`/`channelId` and rebuilds `targetGeneration`/`engineInstanceId`
 * before any host call, so the wrapper only ever sees a local ref.
 *
 * Live connection truth lives in `createTeamsConnectionLedger`, never in the
 * history log: history is the durable record, the ledger is the live view.
 */

const DEFAULT_TIMEOUT_MS = 10_000

/** The byte-level socket the direct listener already authenticated. */
export interface TeamsFrameSocket {
  /** Resolves when the socket is gone, from either side. */
  readonly closed: Promise<unknown>
  read(): Promise<WssFrame>
  send(frame: WssFrame): Promise<void>
  close(): Promise<void>
}

export interface TeamsIngressConnection {
  /** The listener's authenticated transport connection id. */
  readonly connectionId: string
  /** The authenticated peer identity; never read from a payload. */
  readonly peer: AuthenticatedAgent
  readonly connection: TeamsFrameSocket
}

/**
 * The Teams session transport over the existing wss frame shape. It owns the
 * bytes/JSON codec boundary and the socket lifecycle: a Teams frame is a JSON
 * text frame, and a binary or non-JSON frame is refused explicitly.
 */
export function createTeamsFrameTransport(connection: TeamsFrameSocket, peer: AuthenticatedAgent): TeamsSessionTransport {
  return {
    peer,
    read: async (): Promise<unknown> => {
      const frame = await connection.read()
      if (frame.binary) {
        throw new AcpError('INVALID_ACP_FRAME', 'teams-ingress: a Teams frame must be a JSON text frame')
      }
      try {
        return JSON.parse(frame.bytes.toString('utf8'))
      } catch (cause) {
        throw new AcpError('INVALID_ACP_FRAME',
          `teams-ingress: a Teams frame must be valid JSON (${cause instanceof Error ? cause.message : 'parse failed'})`)
      }
    },
    send: async frame => {
      await connection.send({ bytes: Buffer.from(JSON.stringify(frame)), binary: false })
    },
    closed: connection.closed,
    close: () => connection.close(),
  }
}

/**
 * Live per-connection truth over the existing `MembershipChannelObservation`
 * shape. `list()` is the only source `projectTeamsMembership` reads for live
 * channels; a closed or failed connection keeps its record and is never rebuilt
 * from history or logs.
 */
export interface TeamsConnectionLedger {
  /** Register a new live connection. A duplicate connection id is a conflict. */
  open(observation: MembershipChannelObservation): void
  /** Replace the live record of an existing connection. An unknown id is a conflict. */
  update(observation: MembershipChannelObservation): void
  /** Move an existing connection to `closed`; its record is retained. */
  close(connectionId: string, observedAt: string): void
  list(): readonly MembershipChannelObservation[]
}

function connectionKey(observation: MembershipChannelObservation): string {
  if (typeof observation.connectionId !== 'string' || observation.connectionId.length === 0) {
    throw new AcpError('INVALID_ACP_FRAME', 'teams-ingress: a live connection observation requires a connectionId')
  }
  return observation.connectionId
}

export function createTeamsConnectionLedger(): TeamsConnectionLedger {
  const entries = new Map<string, MembershipChannelObservation>()
  return {
    open: observation => {
      const key = connectionKey(observation)
      if (entries.has(key)) throw new AcpError('CONFLICT', `teams-ingress: connection ${key} is already in the ledger`)
      entries.set(key, observation)
    },
    update: observation => {
      const key = connectionKey(observation)
      if (!entries.has(key)) throw new AcpError('CONFLICT', `teams-ingress: connection ${key} is not in the ledger`)
      entries.set(key, observation)
    },
    close: (connectionId, observedAt) => {
      const existing = entries.get(connectionId)
      if (existing === undefined) throw new AcpError('CONFLICT', `teams-ingress: connection ${connectionId} is not in the ledger`)
      const { error: _error, ...rest } = existing
      entries.set(connectionId, { ...rest, state: 'closed', observedAt })
    },
    list: () => [...entries.values()],
  }
}

export interface OpenTeamsIngressInput {
  readonly connection: TeamsIngressConnection
  /** This daemon's own authenticated identity. */
  readonly self: AuthenticatedAgent
  readonly selfGeneration: number
  readonly selfCapabilitiesRevision: string
  /** The accepted config revision; never a policy snapshot hash. */
  readonly selfPolicyRevision: number
  readonly allowedRoles: readonly RelationRole[]
  readonly admittedCapabilities: readonly string[]
  readonly host: AcpHost
  readonly policy: AcpPolicySnapshot
  readonly engineInstanceId: string
  readonly history: TeamsConnectionHistory
  readonly ledger: TeamsConnectionLedger
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  /** Live clock; defaults to the system clock. */
  readonly now?: () => string
  /** Observable history-write failure; never carried inside a Teams frame. */
  readonly onHistoryFault?: (fault: AcpFault) => void
}

export interface TeamsIngressHandle {
  readonly connectionId: string
  readonly peer: AuthenticatedAgent
  readonly negotiation: TeamsNegotiationState
  readonly session: TeamsSession
  /** Settles when the session read loop ends; a read-loop failure is recorded, never thrown here. */
  readonly done: Promise<void>
}

function faultFrom(error: unknown): AcpFault {
  if (error instanceof AcpError) return error.toFault()
  return { code: 'RESULT_UNKNOWN', message: error instanceof Error ? error.message : 'teams-ingress: the connection failed' }
}

/**
 * Open the responder side of one authenticated connection.
 *
 * A rejected or timed-out negotiation records `connection.failed`, marks the
 * ledger entry failed and throws the typed fault, so the listener can terminate
 * the transport. An agreed negotiation records `connection.negotiated`, creates
 * the ACP session and starts its read loop; the caller never awaits the loop.
 */
export async function openTeamsIngress(input: OpenTeamsIngressInput): Promise<TeamsIngressHandle> {
  const { connectionId, peer, connection } = input.connection
  const now = input.now ?? (() => new Date().toISOString())
  const transport = createTeamsFrameTransport(connection, peer)

  // Append after an effect already happened: report a write fault, never block
  // live behavior and never let it corrupt the transport or session state.
  const record = async (entry: TeamsConnectionHistoryEntry): Promise<void> => {
    try {
      await input.history.record(entry)
    } catch (cause) {
      input.onHistoryFault?.(faultFrom(cause))
    }
  }

  input.ledger.open({
    remoteAgentId: peer.agentId,
    connectionId,
    state: 'negotiating',
    targetGeneration: input.selfGeneration,
    observedAt: now(),
  })

  const negotiation = await runTeamsNegotiation({
    options: {
      side: 'responder',
      connectionId,
      self: input.self,
      peer,
      selfGeneration: input.selfGeneration,
      selfCapabilitiesRevision: input.selfCapabilitiesRevision,
      selfPolicyRevision: input.selfPolicyRevision,
      allowedRoles: input.allowedRoles,
      admittedCapabilities: input.admittedCapabilities,
      // D00 amendment A3: publish this side's live engine instance so the remote
      // initiator can name it on acp.open. It is the same value this side later
      // validates in createTeamsSession, so the two can never disagree.
      engineInstanceId: input.engineInstanceId,
    },
    port: transport,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })

  if (negotiation.state !== 'agreed') {
    const fault = negotiationFault(negotiation)
    await record({ event: 'connection.failed', agentId: peer.agentId, occurredAt: now(), connectionId, error: fault })
    input.ledger.update({
      remoteAgentId: peer.agentId,
      connectionId,
      state: 'failed',
      targetGeneration: input.selfGeneration,
      observedAt: now(),
      error: fault,
    })
    throw new AcpError(fault.code, fault.message)
  }

  const agreement = negotiatedAgreement(negotiation)
  await record({ event: 'connection.negotiated', agentId: peer.agentId, occurredAt: now(), connectionId, agreement })
  input.ledger.update({
    remoteAgentId: peer.agentId,
    connectionId,
    state: 'ready',
    targetGeneration: input.selfGeneration,
    role: agreement.targetRole,
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

  const done = session.run().then(
    () => {
      input.ledger.close(connectionId, now())
    },
    async cause => {
      const fault = faultFrom(cause)
      await record({ event: 'connection.failed', agentId: peer.agentId, occurredAt: now(), connectionId, error: fault })
      input.ledger.update({
        remoteAgentId: peer.agentId,
        connectionId,
        state: 'failed',
        targetGeneration: input.selfGeneration,
        observedAt: now(),
        error: fault,
      })
    },
  )
  void done
  return { connectionId, peer, negotiation, session, done }
}
