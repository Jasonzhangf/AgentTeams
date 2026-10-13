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
const DEFAULT_OPEN_TIMEOUT_MS = 10_000

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

export interface TeamsSessionOpenInput {
  /** How long the initiator waits for `acp.open_ack`; defaults to 10s. */
  readonly timeoutMs?: number
}

export interface TeamsSession {
  readonly connectionId: string
  readonly peer: AuthenticatedAgent
  readonly channels: readonly TeamsSessionChannelView[]
  /**
   * Initiator only (D00 amendment A3). Open one outbound ACP channel: name the
   * responder's own engine instance on `acp.open`, then adopt the `acp.open_ack`
   * ref as this side's peer ref. Call it before `run()`, because the handshake
   * drives its own reads. A responder session refuses it: the responder waits for
   * `acp.open` and never initiates a channel.
   */
  open(input?: TeamsSessionOpenInput): Promise<TeamsSessionChannelView>
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
  /** The peer's wire ref: the lookup key for inbound frames and their freshness reference. */
  readonly peerRef: AcpChannelRef
  /** The ref this side hands the host. It always carries this side's own generation and engine instance. */
  readonly localRef: AcpChannelRef
  /**
   * The ref this side puts on outbound frames. For the responder it is the local
   * ref. For the initiator it is the ref it sent in `acp.open`, which names the
   * target's generation and engine instance, because that is what the responder
   * validates and keys by.
   */
  readonly outboundRef: AcpChannelRef
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
  /** The initiator owns the outbound `acp.open`; the responder waits for one. */
  const initiator = input.negotiation.side === 'initiator'
  let running = false

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
    channels.set(peerKey, { peerKey, peerRef: ref, localRef, outboundRef: localRef, cursor: 0 })
    await send({ version: 1, kind: 'acp.open_ack', ref: localRef })
  }

  const receiveFrame = async (entry: TeamsAcpFrame): Promise<void> => {
    const record = channels.get(peerKeyOf(entry.ref))
    if (record === undefined) {
      await sendError(entry.ref, { code: 'STALE_GENERATION', message: 'teams-session: the ACP channel is not open' })
      return
    }
    // Freshness is judged against the ref this peer actually opened with, so the
    // rule is the same on both sides: the responder checks its own generation and
    // engine instance, the initiator checks the target's, and each stored them in
    // `peerRef`.
    if (entry.ref.targetGeneration !== record.peerRef.targetGeneration || entry.ref.engineInstanceId !== record.peerRef.engineInstanceId) {
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
        await send({ version: 1, kind: 'acp.frame', ref: record.outboundRef, frame: rpcErrorFrame(requestId, fault) })
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

  const viewOf = (record: ChannelRecord): TeamsSessionChannelView => ({
    peerConnectionId: record.peerRef.connectionId,
    peerChannelId: record.peerRef.channelId,
    localRef: record.localRef,
    open: true,
  })

  /**
   * D00 amendment A3: the initiator opens the channel and names the responder's
   * own engine instance on `acp.open`. `targetGeneration`/`engineInstanceId`
   * always describe the target (responder) side, on both the ref this side sends
   * and the ref it receives. The responder's own local ref, returned in the ack,
   * becomes this side's peer ref, so the shared flush/close paths need no change.
   *
   * The handshake drives its own reads, so it must run before `run()`.
   */
  const open = async (openInput: TeamsSessionOpenInput = {}): Promise<TeamsSessionChannelView> => {
    if (!initiator) {
      throw new AcpError('CONFLICT', 'teams-session: only the initiator opens a channel; the responder waits for acp.open')
    }
    if (running) {
      throw new AcpError('CONFLICT', 'teams-session: open must run before the read loop owns the transport')
    }
    if (closed) throw new AcpError('CONFLICT', 'teams-session: the session is closed')
    const targetEngineInstanceId = input.negotiation.targetEngineInstanceId
    if (typeof targetEngineInstanceId !== 'string' || targetEngineInstanceId.length === 0) {
      throw new AcpError('INVALID_ACP_FRAME', 'teams-session: the agreed context published no engine instance to name on acp.open')
    }
    const targetGenerationValue = input.negotiation.targetGeneration
    if (!Number.isSafeInteger(targetGenerationValue) || (targetGenerationValue ?? 0) < 1) {
      throw new AcpError('INVALID_ACP_FRAME', 'teams-session: the agreed context published no target generation to name on acp.open')
    }
    const timeoutMs = openInput.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new AcpError('INVALID_ACP_FRAME', 'teams-session: timeoutMs must be a positive safe integer')
    }
    channelCounter += 1
    const channelId = `teams-${input.connectionId}-${channelCounter}`
    // The host accepts only this side's own generation and engine instance
    // (`agent-host/acp-host.ts` refuses anything else with STALE_GENERATION), so
    // the host-facing ref carries local values.
    const localRef: AcpChannelRef = {
      connectionId: input.connectionId,
      channelId,
      targetGeneration,
      engineInstanceId: input.engineInstanceId,
    }
    // The wire ref names the target's generation and engine instance: that is the
    // value the responder validates and the value A3 publishes on the context.
    const openRef: AcpChannelRef = {
      connectionId: input.connectionId,
      channelId,
      targetGeneration: targetGenerationValue as number,
      engineInstanceId: targetEngineInstanceId,
    }
    try {
      await input.host.open({ ref: localRef, principal: peer, policy: input.policy })
    } catch (cause) {
      const fault = faultFrom(cause, 'CONFLICT')
      throw new AcpError(fault.code, fault.message)
    }
    // Release the local host channel on every handshake failure, so a channel the
    // peer never acknowledged cannot stay open on this side.
    const refuse = async (fault: AcpFault): Promise<never> => {
      try { await input.host.close(localRef) } catch { /* the host channel is already gone */ }
      throw new AcpError(fault.code, fault.message)
    }
    await send({ version: 1, kind: 'acp.open', ref: openRef })
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      input.transport.read().then(frame => ({ kind: 'frame' as const, frame })),
      input.transport.closed.then(() => ({ kind: 'closed' as const })),
      new Promise<{ readonly kind: 'timeout' }>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome.kind === 'timeout') {
      // The project's own handshake convention: a deadline leaves the outcome unknown.
      return await refuse({ code: 'RESULT_UNKNOWN', message: 'teams-session: the peer did not acknowledge acp.open' })
    }
    if (outcome.kind === 'closed') {
      return await refuse({ code: 'CONFLICT', message: 'teams-session: the transport closed before acp.open was acknowledged' })
    }
    let parsed: ReturnType<typeof parseTeamsConnectionFrame>
    try {
      parsed = parseTeamsConnectionFrame(outcome.frame)
    } catch {
      return await refuse({ code: 'INVALID_ACP_FRAME', message: 'teams-session: a malformed frame arrived before acp.open_ack' })
    }
    if (parsed.kind === 'acp.error') {
      if (peerKeyOf(parsed.ref) !== peerKeyOf(openRef)) {
        return await refuse({ code: 'INVALID_ACP_FRAME', message: 'teams-session: an acp.error for a different channel arrived before acp.open_ack' })
      }
      return await refuse(parsed.error)
    }
    if (parsed.kind !== 'acp.open_ack') {
      return await refuse({ code: 'INVALID_ACP_FRAME', message: `teams-session: unexpected ${parsed.kind} before acp.open_ack` })
    }
    const ack = parsed.ref
    if (ack.connectionId !== agreement.connectionId) {
      return await refuse({ code: 'INVALID_ACP_FRAME', message: 'teams-session: the acknowledgement names a different connection' })
    }
    if (ack.targetGeneration !== targetGenerationValue) {
      return await refuse({ code: 'STALE_GENERATION', message: 'teams-session: the acknowledgement names a stale target generation' })
    }
    if (ack.engineInstanceId !== targetEngineInstanceId) {
      return await refuse({ code: 'STALE_GENERATION', message: 'teams-session: the acknowledgement names a different engine instance' })
    }
    const peerKey = peerKeyOf(ack)
    if (channels.has(peerKey)) {
      return await refuse({ code: 'CONFLICT', message: 'teams-session: the ACP channel is already open' })
    }
    const record: ChannelRecord = { peerKey, peerRef: ack, localRef, outboundRef: openRef, cursor: 0 }
    channels.set(peerKey, record)
    return viewOf(record)
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
        await send({ version: 1, kind: 'acp.frame', ref: record.outboundRef, frame: delivery.frame })
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
        // Only the responder waits for `acp.open`; an initiator that receives one
        // is facing a peer that broke R1, and never becomes the responder.
        if (initiator) throw new AcpError('INVALID_ACP_FRAME', 'teams-session: the initiator never receives acp.open')
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
      try { await input.transport.send({ version: 1, kind: 'acp.close', ref: record.outboundRef }) } catch { /* transport gone */ }
      try { await input.host.close(record.localRef) } catch { /* host channel already gone */ }
    }
    try { await input.transport.close() } catch { /* the transport is already gone */ }
  }

  const run = async (): Promise<void> => {
    running = true
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
      running = false
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
      return [...channels.values()].map(viewOf)
    },
    open,
    receive,
    flush: serializedFlush,
    run,
    close,
  }
}
