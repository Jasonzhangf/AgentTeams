import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpFault } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { RelationRole } from '../control-protocol/teams-connection.ts'
import type { AcpPolicySnapshot } from '../config/acp-policy.ts'
import type { PeerIntent } from '../config/daemon-intent.ts'
import type { AcpHost } from '../agent-host/acp-host.ts'
import { DirectWssRouteError, connectDirectWssTarget, type DirectWssTarget } from '../network/direct-route.ts'
import { buildDirectWssRoutePlan } from '../network/route-plan.ts'
import type { TeamsConnectionHistory } from '../network/teams-connection-history.ts'
import type { TeamsConnectionLedger } from '../network/teams-ingress.ts'
import { openTeamsEgress, type TeamsEgressHandle } from '../network/teams-egress.ts'
import type { RouteCandidate } from '../server/directory.ts'

/**
 * Serve entry egress owner (owner: runtime).
 *
 * The agent daemon dials the peers its own accepted config declares. This module
 * is the one production caller of `network/teams-egress.ts`: it resolves one
 * declared `PeerIntent`, reads the target facts the initiator negotiation
 * requires from the scoped directory readback, dials the peer with the same
 * `buildDirectWssRoutePlan` + `connectDirectWssTarget` pair the D05 closure
 * black box proves, and composes `openTeamsEgress` over the authenticated
 * connection. It keeps the live handle keyed by the peer's own `agentId` so the
 * daemon can disconnect exactly the peer it dialed.
 *
 * The execution model is the user's decision: the agent daemon reacts on its own
 * and dials/tears down itself; the control daemon is never a relay and there is
 * no control -> agent channel. This module therefore owns composition and
 * lifecycle only. Every mechanism it needs already has one owner and is reused:
 * route planning (`network/route-plan.ts`), the authenticated direct-WSS dial
 * (`network/direct-route.ts`), the initiator negotiation and ACP channel
 * (`network/teams-egress.ts`), the durable `kind=connection` history and the
 * live ledger (network owners).
 *
 * Target facts. `openTeamsEgress` needs `expectedTargetGeneration` and
 * `expectedTargetCapabilitiesRevision`, and `PeerIntent` carries neither. They
 * are NOT invented here:
 *
 * - `expectedTargetCapabilitiesRevision` is the responder's published directory
 *   declaration revision (`RelayPeer.declaration.revision`). The D05 closure
 *   black box reads exactly that value and asserts it equals the responder's
 *   readiness `capabilitiesRevision`; this owner reads the same scoped directory
 *   through the existing registration client.
 * - `expectedTargetGeneration` is the responder's own published listener
 *   generation. The serve entry binds its listener target with one runtime
 *   constant (`TARGET_GENERATION`), and the responder's `teams.connection.context`
 *   echoes that same constant as `targetGeneration`; the directory does not carry
 *   it (the relay login generation is a different value). The caller therefore
 *   supplies it as the same runtime constant, never as a guessed per-peer value.
 */

/** The target facts an initiator dial must know before it opens the socket. */
export interface ServeEgressTargetFacts {
  /** The confirmed directory generation the route plan was assembled from. */
  readonly directoryGeneration: number
  /** The responder's published listener generation (`teams.connection.context.targetGeneration`). */
  readonly targetGeneration: number
  /** The responder's published declaration revision (`RelayPeer.declaration.revision`). */
  readonly targetCapabilitiesRevision: string
}

/** One real connect attempt that did not produce a live row. */
export interface ServeEgressFailure {
  readonly peerName: string
  readonly agentId: string
  readonly code: AcpFault['code']
  readonly message: string
}

/** One live dialed connection, keyed by the peer's own authenticated `agentId`. */
export interface ServeEgressRow {
  readonly peerName: string
  readonly agentId: string
  readonly connectionId: string
  /** The peer's own authenticated identity, never a payload value. */
  readonly peer: AuthenticatedAgent
  readonly role: RelationRole | undefined
  readonly state: string
}

export interface ServeEgressOwner {
  /** Dial one declared peer and keep its live row. Throws the typed refusal on failure. */
  connect(peerName: string): Promise<ServeEgressRow>
  /** Close the live session and transport of one peer, then remove its row. */
  disconnect(agentId: string): Promise<void>
  /** The live rows only; a failed or closed connection is never a live row. */
  list(): readonly ServeEgressRow[]
  /** Every recorded typed connect failure in this owner's lifetime. */
  failures(): readonly ServeEgressFailure[]
  /** Close every live row (daemon stop). */
  close(): Promise<void>
}

export interface ServeEgressOwnerInput {
  /** The accepted intent's declared peers, keyed by the config's peer name. */
  readonly peers: Readonly<Record<string, PeerIntent>>
  /** This daemon's own authenticated identity. */
  readonly self: AuthenticatedAgent
  readonly selfGeneration: number
  readonly selfCapabilitiesRevision: string
  /** The accepted config revision; never a policy snapshot hash. */
  readonly selfPolicyRevision: number
  /** `RelationsIntent.allowed` for this daemon. */
  readonly allowedRoles: readonly RelationRole[]
  /** The capabilities this side asks for; the peer admits or refuses each. */
  readonly requestedCapabilities: readonly string[]
  readonly host: AcpHost
  readonly policy: AcpPolicySnapshot
  readonly engineInstanceId: string
  readonly history: TeamsConnectionHistory
  readonly ledger: TeamsConnectionLedger
  /**
   * The scoped directory readback for one declared peer. It must return the
   * responder's own published facts, never a guessed value; a peer that the
   * directory cannot confirm is a typed failure.
   */
  readonly readTargetFacts: (input: { readonly peerName: string; readonly peer: PeerIntent }) => Promise<ServeEgressTargetFacts>
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => string
  /** Observable connect failure; a refused dial is recorded, never swallowed. */
  readonly onFailure?: (failure: ServeEgressFailure) => void
  readonly connectTimeoutMs?: number
  readonly helloTimeoutMs?: number
  readonly negotiationTimeoutMs?: number
  readonly openTimeoutMs?: number
  readonly maxMessageBytes?: number
  readonly maxBufferedBytes?: number
  readonly maxPendingFrames?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_HELLO_TIMEOUT_MS = 5_000
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 10_000
const DEFAULT_OPEN_TIMEOUT_MS = 10_000
/** The serve entry's own LAN operational limits; this owner dials with the same values. */
const DEFAULT_MAX_MESSAGE_BYTES = 262_144
const DEFAULT_MAX_BUFFERED_BYTES = 262_144
const DEFAULT_MAX_PENDING_FRAMES = 64

const ACP_FAULT_CODES: readonly AcpFault['code'][] = [
  'INVALID_ACP_FRAME', 'UNSUPPORTED_METHOD', 'UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_POLICY',
  'UNSUPPORTED_CONFIGURATION', 'CAPABILITY_DENIED', 'AUTHENTICATION_REQUIRED', 'STALE_GENERATION',
  'SESSION_OWNERSHIP_CONFLICT', 'CALLBACK_UNAVAILABLE', 'ENGINE_UNAVAILABLE', 'RESULT_UNKNOWN',
  'HISTORY_UNAVAILABLE', 'CONFLICT', 'FORBIDDEN',
]

function faultCodeOf(error: unknown): AcpFault['code'] {
  if (error instanceof AcpError) return error.code
  if (error instanceof DirectWssRouteError) {
    const code = error.code as AcpFault['code']
    return ACP_FAULT_CODES.includes(code) ? code : 'ENGINE_UNAVAILABLE'
  }
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code as AcpFault['code']
    if (ACP_FAULT_CODES.includes(code)) return code
  }
  return 'ENGINE_UNAVAILABLE'
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function fileRefPath(reference: string): string {
  return resolve(reference.startsWith('file:') ? reference.slice('file:'.length) : reference)
}

/**
 * Resolve one credential reference with the same vocabulary the serve entry uses
 * for admissions: `env:NAME`, `file:<path>` or a bare environment-variable name.
 */
async function resolveCredential(reference: string, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnvironment = (name: string): string => {
    const value = env[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new AcpError('AUTHENTICATION_REQUIRED', `serve-egress: credential environment variable ${name} is not set`)
    }
    return value
  }
  if (reference.startsWith('env:')) return fromEnvironment(reference.slice('env:'.length))
  if (reference.startsWith('file:')) {
    const path = fileRefPath(reference)
    try {
      const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '')
      if (value.length === 0) throw new AcpError('AUTHENTICATION_REQUIRED', `serve-egress: credential file ${path} is empty`)
      return value
    } catch (cause) {
      if (cause instanceof AcpError) throw cause
      throw new AcpError('AUTHENTICATION_REQUIRED', `serve-egress: credential file ${path} cannot be read: ${messageOf(cause, 'read failed')}`)
    }
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) return fromEnvironment(reference)
  throw new AcpError('UNSUPPORTED_CONFIGURATION', `serve-egress: credential reference ${reference} is not env:NAME, file:<path> or an environment-variable name`)
}

function portOf(endpoint: string): number | undefined {
  try {
    const url = new URL(endpoint)
    if (url.port.length === 0) return url.protocol === 'wss:' ? 443 : undefined
    const port = Number(url.port)
    return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined
  } catch {
    return undefined
  }
}

/** A peer is dialable only when its own declared config carries every dial fact. */
interface DialablePeer {
  readonly endpoint: string
  readonly admissionRef: string
  readonly credentialRef: string
  readonly tlsTrustRef: string
}

function dialablePeer(peer: PeerIntent): DialablePeer | undefined {
  const { endpoint, admissionRef, credentialRef, tlsTrustRef } = peer
  if (endpoint === undefined || admissionRef === undefined || tlsTrustRef === undefined) return undefined
  return { endpoint, admissionRef, credentialRef, tlsTrustRef }
}

interface LiveRow {
  readonly row: ServeEgressRow
  readonly handle: TeamsEgressHandle
  readonly target: DirectWssTarget
}

/**
 * Create the daemon's own egress owner. It dials nothing until `connect` is
 * called, and every live row it returns is a real, negotiated, channel-open
 * connection; a refused dial records a typed failure and leaves no row.
 */
export function createServeEgressOwner(input: ServeEgressOwnerInput): ServeEgressOwner {
  if (typeof input.self.agentId !== 'string' || input.self.agentId.length === 0) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'serve-egress: the daemon identity is required')
  }
  if (!Number.isSafeInteger(input.selfGeneration) || input.selfGeneration < 1) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'serve-egress: selfGeneration must be a positive safe integer')
  }
  const env = input.env ?? process.env
  const now = input.now ?? (() => new Date().toISOString())
  const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const helloTimeoutMs = input.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
  const negotiationTimeoutMs = input.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS
  const openTimeoutMs = input.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  const maxMessageBytes = input.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const maxBufferedBytes = input.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  const maxPendingFrames = input.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES
  const live = new Map<string, LiveRow>()
  const failures: ServeEgressFailure[] = []

  // The dialer's own role pair. The peer config declares no role, so the daemon's
  // accepted relations select it: peer/master when both are allowed, peer/peer
  // when the daemon only accepts `peer`. A daemon that does not accept `peer`
  // cannot dial at all, which is a typed refusal rather than an invented role.
  const requestedRole: RelationRole = 'peer'
  const requestedPeerRole: RelationRole = input.allowedRoles.includes('master') ? 'master' : 'peer'

  const recordFailure = (peerName: string, agentId: string, error: unknown): AcpError => {
    const code = faultCodeOf(error)
    const message = messageOf(error, 'serve-egress: the dial failed')
    const failure: ServeEgressFailure = { peerName, agentId, code, message }
    failures.push(failure)
    input.onFailure?.(failure)
    return error instanceof AcpError ? error : new AcpError(code, `serve-egress: peer ${peerName} could not be dialed: ${message}`)
  }

  const connect = async (peerName: string): Promise<ServeEgressRow> => {
    if (typeof peerName !== 'string' || peerName.length === 0) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', 'serve-egress: a peer name is required')
    }
    const peer = input.peers[peerName]
    if (peer === undefined) {
      throw recordFailure(peerName, '', new AcpError('FORBIDDEN', `serve-egress: peer ${peerName} is not declared by the accepted intent`))
    }
    if (!input.allowedRoles.includes(requestedRole)) {
      throw recordFailure(peerName, peer.agentId, new AcpError('FORBIDDEN',
        `serve-egress: the daemon's accepted relations ${JSON.stringify(input.allowedRoles)} do not allow the initiator role ${requestedRole}`))
    }
    const dialable = dialablePeer(peer)
    if (dialable === undefined) {
      throw recordFailure(peerName, peer.agentId, new AcpError('UNSUPPORTED_CONFIGURATION',
        `serve-egress: peer ${peerName} declares no explicit endpoint, admissionRef and tlsTrustRef; a peer without an explicit endpoint is never dialed`))
    }
    if (live.has(peer.agentId)) {
      throw recordFailure(peerName, peer.agentId, new AcpError('CONFLICT',
        `serve-egress: peer ${peerName} (${peer.agentId}) already has a live connection`))
    }

    const connectionId = `serve-egress-${randomUUID()}`
    let target: DirectWssTarget | undefined
    try {
      const [credential, ca, facts] = await Promise.all([
        resolveCredential(dialable.credentialRef, env),
        readFile(fileRefPath(dialable.tlsTrustRef)),
        input.readTargetFacts({ peerName, peer }),
      ])
      if (!Number.isSafeInteger(facts.directoryGeneration) || facts.directoryGeneration < 1) {
        throw new AcpError('STALE_GENERATION', 'serve-egress: the directory readback reported no confirmed generation')
      }
      if (!Number.isSafeInteger(facts.targetGeneration) || facts.targetGeneration < 1) {
        throw new AcpError('STALE_GENERATION', 'serve-egress: the target facts reported no target generation')
      }
      if (typeof facts.targetCapabilitiesRevision !== 'string' || facts.targetCapabilitiesRevision.length === 0) {
        throw new AcpError('CONFLICT', 'serve-egress: the target facts reported no capability revision')
      }
      const port = portOf(dialable.endpoint)
      const candidate: RouteCandidate = {
        candidateId: `${peer.agentId}-lan`,
        kind: 'lan',
        endpoint: dialable.endpoint,
        ...(port === undefined ? {} : { port }),
        authRequired: true,
        lastSeenAt: now(),
      }
      const plan = buildDirectWssRoutePlan({
        hostId: peer.hostId,
        directoryGeneration: facts.directoryGeneration,
        policy: 'manual',
        targetCandidateId: candidate.candidateId,
        candidates: [candidate],
      })
      target = await connectDirectWssTarget({
        transport: {
          endpoint: dialable.endpoint,
          credential,
          ca,
          connectTimeoutMs,
          maxMessageBytes,
          maxBufferedBytes,
          maxPendingFrames,
        },
        hello: {
          hostId: peer.hostId,
          agentId: peer.agentId,
          targetGeneration: facts.targetGeneration,
          protocolVersion: 1,
          capabilitiesRevision: facts.targetCapabilitiesRevision,
          source: input.self,
          admissionRef: dialable.admissionRef,
        },
        plan,
        helloTimeoutMs,
      })

      const handle = await openTeamsEgress({
        endpoint: { peer: { accountId: peer.accountId, scopeId: peer.scopeId, agentId: peer.agentId }, connection: target.connection },
        self: input.self,
        selfGeneration: input.selfGeneration,
        selfCapabilitiesRevision: input.selfCapabilitiesRevision,
        selfPolicyRevision: input.selfPolicyRevision,
        allowedRoles: input.allowedRoles,
        requestedRole,
        requestedPeerRole,
        requestedCapabilities: input.requestedCapabilities,
        requestId: `serve-egress-${randomUUID()}`,
        expectedTargetGeneration: facts.targetGeneration,
        expectedTargetCapabilitiesRevision: facts.targetCapabilitiesRevision,
        connectionId,
        host: input.host,
        policy: input.policy,
        engineInstanceId: input.engineInstanceId,
        history: input.history,
        ledger: input.ledger,
        timeoutMs: negotiationTimeoutMs,
        openTimeoutMs,
        now,
      })
      const row: ServeEgressRow = {
        peerName,
        agentId: peer.agentId,
        connectionId,
        peer: handle.peer,
        role: handle.negotiation.agreement?.sourceRole,
        state: handle.negotiation.state,
      }
      live.set(peer.agentId, { row, handle, target })
      return row
    } catch (error) {
      // A refused dial never fabricates a live row. The egress already recorded
      // its own typed history/ledger facts; the transport is released here.
      if (target !== undefined) await target.close('serve-egress dial failed').catch(() => undefined)
      throw recordFailure(peerName, peer.agentId, error)
    }
  }

  const disconnect = async (agentId: string): Promise<void> => {
    const entry = live.get(agentId)
    if (entry === undefined) {
      throw new AcpError('CONFLICT', `serve-egress: peer ${agentId} has no live connection to disconnect`)
    }
    live.delete(agentId)
    await entry.handle.session.close().catch(() => undefined)
    await entry.target.close('serve-egress disconnected').catch(() => undefined)
  }

  const list = (): readonly ServeEgressRow[] => [...live.values()].map(entry => entry.row)

  const close = async (): Promise<void> => {
    const entries = [...live.values()]
    live.clear()
    for (const entry of entries) {
      await entry.handle.session.close().catch(() => undefined)
      await entry.target.close('serve-egress owner closed').catch(() => undefined)
    }
  }

  return { connect, disconnect, list, failures: () => [...failures], close }
}
