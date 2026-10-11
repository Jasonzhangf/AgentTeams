import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpChannelRef, AcpDelivery, AcpFault, AcpFrame, AcpIngress } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type {
  TeamsAcpClose,
  TeamsAcpError,
  TeamsAcpFrame,
  TeamsAcpOpen,
  TeamsConnectionFrame,
} from '../control-protocol/teams-connection.ts'
import { parseTeamsConnectionFrame } from '../control-protocol/teams-connection.ts'
import type { AcpPolicySnapshot } from '../config/acp-policy.ts'
import type { AcpHost } from '../agent-host/acp-host.ts'
import { rpcErrorFrame } from '../agent-host/acp-host.ts'
import type { TeamsNegotiationState } from './teams-negotiation.ts'
import { negotiatedAgreement } from './teams-negotiation.ts'

/**
 * One authenticated peer connection's ACP session (owner: network).
 *
 * It requires an already agreed negotiation, then bridges exactly one
 * authenticated transport to the injected `AcpHost`. The host is driven with
 * `principal = connection.peer`; it never learns a registry address, a route, a
 * role, a diagnostic or the transport.
 *
 * R2 ref scoping: the wire carries the frozen `AcpChannelRef`, but
 * `connectionId`/`channelId` are this side's own transport-scoped correlation
 * keys. `targetGeneration`/`engineInstanceId` are validated against the local
 * daemon and then rebuilt from local values before any `AcpHost` call, so a
 * peer-supplied generation or engine instance never reaches the host and a
 * stale generation can neither open nor continue a channel.
 *
 * R1: the channel control frames are exactly `acp.open`, `acp.open_ack`,
 * `acp.frame`, `acp.close` and `acp.error`. No second envelope, no extra field.
 */

const DEFAULT_POLL_INTERVAL_MS = 5
const DEFAULT_DELIVERY_PAGE_LIMIT = 200

export interface TeamsSessionTransport {
  /** The authenticated peer identity of this connection; never read from a payload. */
  readonly peer: AuthenticatedAgent
  read(): Promise<unknown>
  send(frame: TeamsConnectionFrame): Promise<void>
  /** Resolves when the transport is gone, from either side. */
  readonly closed: Promise<unknown>
  close(): Promise<void>
}

export interface TeamsSessionChannelView {
  readonly peerConnectionId: string
  readonly peerChannelId: string
  readonly localRef: AcpChannelRef
  readonly open: boolean
}

export interface CreateTeamsSessionInput {
  /** The agreed negotiation for this connection; anything else refuses to open ACP. */
  readonly negotiation: TeamsNegotiationState
  /** This side's transport-scoped connection id. */
  readonly connectionId: string
  readonly transport: TeamsSessionTransport
  readonly host: AcpHost
  readonly policy: AcpPolicySnapshot
  /** This daemon's engine instance; never taken from the wire. */
  readonly engineInstanceId: string
  readonly pollIntervalMs?: number
  readonly deliveryPageLimit?: number
}

export interface TeamsSession {
  readonly connectionId: string
  readonly peer: AuthenticatedAgent
  readonly channels: readonly TeamsSessionChannelView[]
  /** Handle exactly one inbound Teams frame. */
  receive(frame: unknown): Promise<void>
  /** Relay one page of host deliveries for every open channel. */
  flush(): Promise<void>
  /** Read loop plus delivery pump; settles when the transport closes or `close` is called. */
  run(): Promise<void>
  close(reason?: string): Promise<void>
}

interface ChannelRecord {
  readonly peerKey: string
  readonly peerRef: AcpChannelRef
  readonly localRef: AcpChannelRef
  cursor: number
}

function sameIdentity(left: AuthenticatedAgent, right: AuthenticatedAgent): boolean {
  return left.accountId === right.accountId && left.scopeId === right.scopeId && left.agentId === right.agentId
}

function peerKeyOf(ref: AcpChannelRef): string {
  return `${ref.connectionId}\u0000${ref.channelId}`
}

function faultFrom(error: unknown, fallback: AcpFault['code']): AcpFault {
  if (error instanceof AcpError) return error.toFault()
  return { code: fallback, message: error instanceof Error ? error.message : 'teams-session: ACP operation failed' }
}

function requestIdOf(frame: AcpFrame): string | number | undefined {
  const id = frame.id
  if (typeof id === 'string') return id
  if (typeof id === 'number' && Number.isSafeInteger(id)) return id
  return undefined
}

export function createTeamsSession(input: CreateTeamsSessionInput): TeamsSession {
  const agreement = negotiatedAgreement(input.negotiation)
  if (typeof input.connectionId !== 'string' || input.connectionId.length === 0) {
    throw new AcpError('INVALID_ACP_FRAME', 'teams-session: connectionId is required')
  }
  if (typeof input.engineInstanceId !== 'string' || input.engineInstanceId.length === 0) {
    throw new AcpError('INVALID_ACP_FRAME', 'teams-session: engineInstanceId is required')
  }
  const localIsSource = sameIdentity(agreement.source, input.negotiation.self)
  const peer = localIsSource ? agreement.target : agreement.source
  if (!sameIdentity(input.transport.peer, peer)) {
    throw new AcpError('FORBIDDEN', 'teams-session: the authenticated transport peer does not match the negotiated peer')
  }
  const targetGeneration = input.negotiation.selfGeneration
  const policyEngineInstance = input.policy.engineInstanceId
  if (policyEngineInstance !== input.engineInstanceId) {
    throw new AcpError('STALE_GENERATION', 'teams-session: the policy belongs to a different engine instance')
  }

  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deliveryPageLimit = input.deliveryPageLimit ?? DEFAULT_DELIVERY_PAGE_LIMIT
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new AcpError('INVALID_ACP_FRAME', 'teams-session: pollIntervalMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(deliveryPageLimit) || deliveryPageLimit < 1) {
    throw new AcpError('INVALID_ACP_FRAME', 'teams-session: deliveryPageLimit must be a positive safe integer')
  }

  const channels = new Map<string, ChannelRecord>()
  let channelCounter = 0
  let closed = false
  let pumping: Promise<void> | undefined

  const send = async (frame: TeamsConnectionFrame): Promise<void> => {
    if (closed) throw new AcpError('CONFLICT', 'teams-session: the session is closed')
    await input.transport.send(frame)
  }

  const sendError = async (ref: AcpChannelRef, fault: AcpFault): Promise<void> => {
    const frame: TeamsAcpError = { version: 1, kind: 'acp.error', ref, error: fault }
    try { await send(frame) } catch { /* the transport is gone; the refusal stays local */ }
  }

  const openChannel = async (open: TeamsAcpOpen): Promise<void> => {
    const ref = open.ref
    if (ref.targetGeneration !== targetGeneration) {
      await sendError(ref, { code: 'STALE_GENERATION', message: 'teams-session: the peer named a stale target generation' })
      return
    }
    if (ref.engineInstanceId !== input.engineInstanceId) {
      await sendError(ref, { code: 'STALE_GENERATION', message: 'teams-session: the peer named a different engine instance' })
      return
    }
    const peerKey = peerKeyOf(ref)
    if (channels.has(peerKey)) {
      await sendError(ref, { code: 'CONFLICT', message: 'teams-session: the ACP channel is already open' })
      return
    }
    channelCounter += 1
    const localRef: AcpChannelRef = {
      connectionId: input.connectionId,
      channelId: `teams-${input.connectionId}-${channelCounter}`,
      targetGeneration,
      engineInstanceId: input.engineInstanceId,
    }
    try {
      await input.host.open({ ref: localRef, principal: peer, policy: input.policy })
    } catch (cause) {
      await sendError(ref, faultFrom(cause, 'CONFLICT'))
      return
    }
    channels.set(peerKey, { peerKey, peerRef: ref, localRef, cursor: 0 })
    await send({ version: 1, kind: 'acp.open_ack', ref: localRef })
  }

  const receiveFrame = async (entry: TeamsAcpFrame): Promise<void> => {
    const record = channels.get(peerKeyOf(entry.ref))
    if (record === undefined) {
      await sendError(entry.ref, { code: 'STALE_GENERATION', message: 'teams-session: the ACP channel is not open' })
      return
    }
    if (entry.ref.targetGeneration !== targetGeneration || entry.ref.engineInstanceId !== input.engineInstanceId) {
      await sendError(entry.ref, { code: 'STALE_GENERATION', message: 'teams-session: the ACP channel generation is stale' })
      return
    }
    // R2: the host only ever sees this side's local ref and the untouched payload.
    const ingress: AcpIngress = { ...record.localRef, frame: entry.frame }
    try {
      await input.host.receive(ingress)
    } catch (cause) {
      const fault = faultFrom(cause, 'CONFLICT')
      const requestId = requestIdOf(entry.frame)
      if (requestId !== undefined && typeof entry.frame.method === 'string') {
        await send({ version: 1, kind: 'acp.frame', ref: record.localRef, frame: rpcErrorFrame(requestId, fault) })
      } else {
        await sendError(entry.ref, fault)
      }
    }
  }

  const closeChannel = async (entry: TeamsAcpClose): Promise<void> => {
    const record = channels.get(peerKeyOf(entry.ref))
    if (record === undefined) return
    channels.delete(record.peerKey)
    try { await input.host.close(record.localRef) } catch { /* the host channel is already gone */ }
  }

  const flush = async (): Promise<void> => {
    for (const record of [...channels.values()]) {
      if (!channels.has(record.peerKey)) continue
      let page: { readonly frames: readonly AcpDelivery[]; readonly nextSequence: number }
      try {
        page = await input.host.read(record.localRef, record.cursor, deliveryPageLimit)
      } catch {
        // The host channel is gone. The session keeps its own liveness record and
        // never restores a callback or a prompt from a closed channel.
        continue
      }
      record.cursor = page.nextSequence
      for (const delivery of page.frames) {
        await send({ version: 1, kind: 'acp.frame', ref: record.localRef, frame: delivery.frame })
      }
    }
  }

  const serializedFlush = (): Promise<void> => {
    if (pumping !== undefined) return pumping
    pumping = flush().finally(() => { pumping = undefined })
    return pumping
  }

  const receive = async (frame: unknown): Promise<void> => {
    const parsed = parseTeamsConnectionFrame(frame)
    switch (parsed.kind) {
      case 'acp.open':
        await openChannel(parsed)
        return
      case 'acp.frame':
        await receiveFrame(parsed)
        return
      case 'acp.close':
        await closeChannel(parsed)
        return
      case 'acp.error':
        // This side never initiates a channel, so a peer error is informational:
        // there is no local pending open to fail and nothing to restore.
        return
      default:
        throw new AcpError('INVALID_ACP_FRAME', `teams-session: unexpected ${parsed.kind} on an ACP channel connection`)
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const record of [...channels.values()]) {
      channels.delete(record.peerKey)
      try { await input.transport.send({ version: 1, kind: 'acp.close', ref: record.localRef }) } catch { /* transport gone */ }
      try { await input.host.close(record.localRef) } catch { /* host channel already gone */ }
    }
    try { await input.transport.close() } catch { /* the transport is already gone */ }
  }

  const run = async (): Promise<void> => {
    const pump = setInterval(() => { void serializedFlush() }, pollIntervalMs)
    ;(pump as NodeJS.Timeout).unref?.()
    try {
      for (;;) {
        const frame = await Promise.race([
          input.transport.read(),
          input.transport.closed.then(() => undefined),
        ])
        if (frame === undefined) break
        await receive(frame)
        await serializedFlush()
      }
    } finally {
      clearInterval(pump)
      // Release every host channel and the transport on every exit path,
      // including a malformed or unexpected inbound frame that throws out of
      // `receive`. `close` never throws, so it cannot mask that error.
      await close()
    }
  }

  return {
    connectionId: input.connectionId,
    peer,
    get channels(): readonly TeamsSessionChannelView[] {
      return [...channels.values()].map(record => ({
        peerConnectionId: record.peerRef.connectionId,
        peerChannelId: record.peerRef.channelId,
        localRef: record.localRef,
        open: true,
      }))
    },
    receive,
    flush: serializedFlush,
    run,
    close,
  }
}
