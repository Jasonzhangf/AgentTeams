import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server as HttpsServer } from 'node:https'
import type { IncomingMessage } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { assertEnvelopeKeys } from '../control-protocol/json-value.ts'
import { parseAgentDeclaration } from '../control-protocol/relay-codec.ts'
import { attachDeclarationEndpoints, projectPeerEndpoints } from './endpoint-discovery.ts'
import { assertEndpointIdentity } from '../control-protocol/endpoint-ref.ts'
import type {
  AgentDeclaration,
  AuthenticatedAgent,
  RelayGrant,
  RelayPeer,
  RelayServerControl,
  ServiceError,
  ServiceErrorCode,
} from '../control-protocol/agent-services.ts'

type MaybePromise<T> = T | Promise<T>
type Credential = string | undefined
type Socket = WebSocket
type RawData = WebSocket.RawData
type SocketRole = 'unknown' | 'control' | 'data'
type RelaySide = 'source' | 'target'

export interface RelayServerOptions {
  readonly host?: string
  readonly port: number
  readonly key: string | Buffer
  readonly cert: string | Buffer
  readonly maxPayload: number
  readonly maxConnections: number
  readonly maxGrants: number
  readonly maxBufferedAmount: number
  readonly maxPendingMessages: number
  readonly maxPendingBytes: number
  readonly grantTtlMs: number
  readonly authenticate: (credential: Credential) => MaybePromise<AuthenticatedAgent | null>
  readonly authorizeTarget?: (source: AuthenticatedAgent, target: RelayPeer) => MaybePromise<boolean>
  readonly now?: () => Date
  readonly idFactory?: () => string
}

export interface RelayServer {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

interface RelaySocketState {
  readonly socket: Socket
  readonly request: IncomingMessage
  readonly connectionId: string
  queue: Promise<void>
  pendingMessages: number
  pendingBytes: number
  role: SocketRole
  auth?: AuthenticatedAgent
  identityKey?: string
  generation?: number
  declaration?: AgentDeclaration
  subscribed: boolean
  grantId?: string
  side?: RelaySide
  opened: boolean
  closed: boolean
  closing: boolean
}

interface RelayGrantState {
  readonly grant: RelayGrant
  readonly sourceConnectionId: string
  readonly targetConnectionId: string
  expiryTimer: ReturnType<typeof setTimeout>
  sourceData?: RelaySocketState
  targetData?: RelaySocketState
  sourceRequestId?: string
  targetRequestId?: string
}

class RelayFailure extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly requestId?: string,
    readonly closeSocket = false,
  ) {
    super(message)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RelayFailure('INVALID_INPUT', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RelayFailure('INVALID_INPUT', `${label} must be a non-empty string`)
  }
  return value
}

function knownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  try {
    assertEnvelopeKeys(value, fields, label)
  } catch (error) {
    throw new RelayFailure('INVALID_INPUT', error instanceof Error ? error.message : `${label} has unsupported fields`)
  }
}

function parseDeclaration(value: unknown): AgentDeclaration {
  try {
    return parseAgentDeclaration(value)
  } catch (error) {
    throw new RelayFailure('INVALID_INPUT', error instanceof Error ? error.message : 'invalid declaration')
  }
}

function endpointsFor(declaration: AgentDeclaration): RelayPeer['endpoints'] {
  try {
    return attachDeclarationEndpoints(declaration)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code as ServiceErrorCode
      : 'INVALID_INPUT'
    throw new RelayFailure(code, error instanceof Error ? error.message : 'invalid Endpoint admission')
  }
}

function peerWithEndpoints(peer: Omit<RelayPeer, 'endpoints'> & { endpoints?: RelayPeer['endpoints'] }): RelayPeer {
  return { ...peer, endpoints: endpointsFor(peer.declaration) }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RelayFailure('INVALID_INPUT', `${label} must be a positive safe integer`)
  }
  return value as number
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new RelayFailure('INVALID_INPUT', `${label} must be boolean`)
  return value
}

function parseControlMessage(data: RawData, isBinary: boolean): Record<string, unknown> {
  if (isBinary) throw new RelayFailure('INVALID_INPUT', 'control message must be text', undefined, true)
  let parsed: unknown
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString('utf8')
        : data.toString()
    parsed = JSON.parse(text)
  } catch {
    throw new RelayFailure('INVALID_INPUT', 'control message is not valid JSON', undefined, true)
  }
  const input = object(parsed, 'control message')
  const kind = string(input.kind, 'kind')
  const fields: Readonly<Record<string, readonly string[]>> = {
    'relay.login': ['kind', 'protocolVersion', 'declaration'],
    'relay.publish': ['kind', 'generation', 'declaration'],
    'relay.presence': ['kind', 'generation'],
    'relay.logout': ['kind', 'requestId', 'generation'],
    'relay.directory': ['kind', 'requestId', 'subscribe'],
    'relay.connect': ['kind', 'requestId', 'generation', 'targetAgentId', 'targetGeneration'],
    'relay.open': ['kind', 'requestId', 'grantId', 'generation'],
  }
  const allowed = fields[kind]
  if (allowed) knownFields(input, allowed, `control message ${kind}`)
  return input
}

function identityKey(agent: AuthenticatedAgent): string {
  return JSON.stringify([agent.accountId, agent.scopeId, agent.agentId])
}

function sameIdentity(agent: AuthenticatedAgent, declaration: AgentDeclaration): boolean {
  return agent.accountId === declaration.identity.accountId
    && agent.scopeId === declaration.scopeId
    && agent.agentId === declaration.identity.agentId
}

function validateAuthenticatedAgent(value: AuthenticatedAgent): AuthenticatedAgent {
  if (typeof value !== 'object' || value === null) throw new RelayFailure('UNAUTHENTICATED', 'authentication returned no agent')
  string(value.accountId, 'authenticated accountId')
  string(value.scopeId, 'authenticated scopeId')
  string(value.agentId, 'authenticated agentId')
  return value
}

function authorization(request: IncomingMessage): Credential {
  const value = request.headers.authorization
  return Array.isArray(value) ? value[0] : value
}

function errorValue(failure: RelayFailure): ServiceError {
  return { code: failure.code, message: failure.message }
}

function open(socket: Socket): boolean {
  return socket.readyState === WebSocket.OPEN
}

function rawDataSize(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0)
  return data.byteLength
}

function safeCloseReason(reason: string): string {
  return Buffer.byteLength(reason, 'utf8') <= 123 ? reason : 'relay error'
}

class RelayServerImpl implements RelayServer {
  private readonly sockets = new Set<RelaySocketState>()
  private readonly controls = new Map<string, RelaySocketState>()
  private readonly activeByIdentity = new Map<string, RelaySocketState>()
  private readonly generations = new Map<string, number>()
  private readonly peers = new Map<string, RelayPeer>()
  private readonly grants = new Map<string, RelayGrantState>()
  private readonly now: () => Date
  private readonly idFactory: () => string
  private revision = 0
  private closing = false
  private closePromise?: Promise<void>

  constructor(
    private readonly options: RelayServerOptions,
    private readonly httpsServer: HttpsServer,
    private readonly wsServer: InstanceType<typeof WebSocketServer>,
  ) {
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
  }

  get port(): number {
    const address = this.httpsServer.address()
    if (address === null || typeof address === 'string') throw new Error('relay: server has no bound address')
    return address.port
  }

  get url(): string {
    return `wss://${this.options.host ?? '127.0.0.1'}:${this.port}`
  }

  accept(socket: Socket, request: IncomingMessage): void {
    if (this.closing || this.sockets.size >= this.options.maxConnections) {
      socket.close(1013, 'relay connection limit')
      return
    }
    const state: RelaySocketState = {
      socket,
      request,
      connectionId: this.idFactory(),
      queue: Promise.resolve(),
      pendingMessages: 0,
      pendingBytes: 0,
      role: 'unknown',
      subscribed: false,
      opened: false,
      closed: false,
      closing: false,
    }
    this.sockets.add(state)
    socket.on('message', (data, isBinary) => {
      if (state.closed || state.closing) return
      const bytes = rawDataSize(data)
      const overMessageLimit = state.pendingMessages >= this.options.maxPendingMessages
      const overByteLimit = bytes > this.options.maxPendingBytes || state.pendingBytes > this.options.maxPendingBytes - bytes
      if (overMessageLimit || overByteLimit) {
        this.handleFailure(state, new RelayFailure(
          'RESOURCE_EXHAUSTED',
          overMessageLimit ? 'relay pending message limit reached' : 'relay pending byte limit reached',
          undefined,
          true,
        ))
        return
      }
      state.pendingMessages += 1
      state.pendingBytes += bytes
      state.queue = state.queue
        .then(() => this.handleMessage(state, data, isBinary))
        .catch((error: unknown) => this.handleFailure(state, error))
        .finally(() => {
          state.pendingMessages -= 1
          state.pendingBytes -= bytes
        })
    })
    socket.on('close', () => this.handleClose(state))
    socket.on('error', () => undefined)
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      for (const grantId of [...this.grants.keys()]) this.closeGrant(grantId, { code: 'UNAVAILABLE', message: 'relay closing' })
      for (const state of this.sockets) state.socket.terminate()
      await new Promise<void>((resolve) => {
        this.wsServer.close(() => resolve())
      })
      await new Promise<void>((resolve, reject) => {
        this.httpsServer.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        })
      })
    })()
    return this.closePromise
  }

  private async handleMessage(state: RelaySocketState, data: RawData, isBinary: boolean): Promise<void> {
    if (state.closed || state.closing) return
    if (state.role === 'data' && state.opened) {
      this.forwardData(state, data, isBinary)
      return
    }
    if (state.role === 'data') {
      const input = parseControlMessage(data, isBinary)
      if (input.kind !== 'relay.open') throw new RelayFailure('INVALID_INPUT', 'data connection must open with relay.open', undefined, true)
      await this.openDataConnection(state, input)
      return
    }
    const input = parseControlMessage(data, isBinary)
    if (state.role === 'unknown') {
      if (input.kind === 'relay.open') {
        await this.openDataConnection(state, input)
        return
      }
      if (input.kind !== 'relay.login') {
        throw new RelayFailure('UNAUTHENTICATED', 'relay.login is required before control operations', undefined, true)
      }
      await this.login(state, input)
      return
    }
    await this.handleControl(state, input)
  }

  private async authenticate(state: RelaySocketState): Promise<AuthenticatedAgent> {
    if (state.auth) return state.auth
    let result: AuthenticatedAgent | null
    try {
      result = await this.options.authenticate(authorization(state.request))
    } catch {
      throw new RelayFailure('UNAUTHENTICATED', 'authentication failed', undefined, true)
    }
    if (!result) throw new RelayFailure('UNAUTHENTICATED', 'authentication failed', undefined, true)
    state.auth = validateAuthenticatedAgent(result)
    return state.auth
  }

  private async login(state: RelaySocketState, input: Record<string, unknown>): Promise<void> {
    const protocolVersion = positiveInteger(input.protocolVersion, 'protocolVersion')
    if (protocolVersion !== 2) throw new RelayFailure('UNSUPPORTED_VERSION', `protocol version ${protocolVersion} is unsupported`, undefined, true)
    const authenticated = await this.authenticate(state)
    if (state.closed || !open(state.socket)) throw new RelayFailure('UNAVAILABLE', 'connection closed during authentication', undefined, true)
    const declaration = parseDeclaration(input.declaration)
    if (!sameIdentity(authenticated, declaration)) {
      throw new RelayFailure('FORBIDDEN', 'declaration identity does not match authenticated identity', undefined, true)
    }
    const key = identityKey(authenticated)
    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)
    const previous = this.activeByIdentity.get(key)
    if (previous && previous !== state) {
      this.invalidateGrantsForConnection(previous.connectionId, { code: 'UNAVAILABLE', message: 'control connection replaced' })
      this.closeSocket(previous, 4001, 'control connection replaced')
    }
    state.role = 'control'
    state.identityKey = key
    state.generation = generation
    state.declaration = declaration
    state.subscribed = false
    this.activeByIdentity.set(key, state)
    this.controls.set(state.connectionId, state)
    const peer: RelayPeer = peerWithEndpoints({
      declaration,
      connectionId: state.connectionId,
      generation,
      lastSeenAt: this.now().toISOString(),
      presence: 'online',
    })
    this.setPeer(peer)
    this.send(state.socket, { kind: 'relay.admitted', connectionId: state.connectionId, generation })
  }

  private async handleControl(state: RelaySocketState, input: Record<string, unknown>): Promise<void> {
    if (input.kind !== 'relay.login') this.assertCurrentControl(state)
    switch (input.kind) {
      case 'relay.login':
        throw new RelayFailure('CONFLICT', 'control connection is already admitted')
      case 'relay.publish':
        await this.publish(state, input)
        return
      case 'relay.presence':
        this.presence(state, input)
        return
      case 'relay.logout':
        this.logout(state, input)
        return
      case 'relay.directory':
        this.directory(state, input)
        return
      case 'relay.connect':
        await this.connect(state, input)
        return
      case 'relay.open':
        throw new RelayFailure('UNSUPPORTED_OPERATION', 'relay.open requires a dedicated data connection')
      default:
        throw new RelayFailure('UNSUPPORTED_OPERATION', `unsupported relay operation ${String(input.kind)}`)
    }
  }

  private assertCurrentControl(state: RelaySocketState, requestId?: string): void {
    if (!state.identityKey || state.closed || !open(state.socket) || this.activeByIdentity.get(state.identityKey) !== state) {
      throw new RelayFailure('STALE_GENERATION', 'control connection is no longer current', requestId, true)
    }
  }

  private assertCurrentGeneration(state: RelaySocketState, value: unknown, label: string): number {
    const generation = positiveInteger(value, label)
    if (generation !== state.generation) throw new RelayFailure('STALE_GENERATION', `${label} is stale`)
    return generation
  }

  private async publish(state: RelaySocketState, input: Record<string, unknown>): Promise<void> {
    this.assertCurrentGeneration(state, input.generation, 'generation')
    const declaration = parseDeclaration(input.declaration)
    if (!state.auth || !sameIdentity(state.auth, declaration)) throw new RelayFailure('FORBIDDEN', 'declaration identity does not match authenticated identity')
    const key = state.identityKey
    if (!key) throw new RelayFailure('UNAUTHENTICATED', 'control identity is unavailable')
    const previous = this.peers.get(key)
    if (!previous || declaration.revision <= previous.declaration.revision) {
      throw new RelayFailure('REVISION_CONFLICT', 'declaration revision must increase')
    }
    state.declaration = declaration
    this.setPeer(peerWithEndpoints({ ...previous, declaration, lastSeenAt: this.now().toISOString(), presence: 'online' }))
  }

  private presence(state: RelaySocketState, input: Record<string, unknown>): void {
    this.assertCurrentGeneration(state, input.generation, 'generation')
    const key = state.identityKey
    if (!key) throw new RelayFailure('UNAUTHENTICATED', 'control identity is unavailable')
    const previous = this.peers.get(key)
    if (!previous) throw new RelayFailure('NOT_FOUND', 'authenticated peer is not published')
    this.setPeer({ ...previous, lastSeenAt: this.now().toISOString(), presence: 'online', connectionId: state.connectionId, generation: state.generation ?? previous.generation })
  }

  private logout(state: RelaySocketState, input: Record<string, unknown>): void {
    const requestId = string(input.requestId, 'requestId')
    this.assertCurrentGeneration(state, input.generation, 'generation')
    const key = state.identityKey
    if (!key) throw new RelayFailure('UNAUTHENTICATED', 'control identity is unavailable', requestId)
    const previous = this.peers.get(key)
    if (!previous) throw new RelayFailure('NOT_FOUND', 'authenticated peer is not published', requestId)
    if (previous.presence === 'online') {
      this.setPeer({ ...previous, lastSeenAt: this.now().toISOString(), presence: 'offline', connectionId: state.connectionId, generation: state.generation ?? previous.generation })
    }
    this.send(state.socket, { kind: 'relay.logged-out', requestId })
  }

  private directory(state: RelaySocketState, input: Record<string, unknown>): void {
    const requestId = string(input.requestId, 'requestId')
    state.subscribed = boolean(input.subscribe, 'subscribe')
    if (!state.auth) throw new RelayFailure('UNAUTHENTICATED', 'control identity is unavailable', requestId)
    const peers = [...this.peers.values()]
      .filter((peer) => peer.declaration.identity.accountId === state.auth?.accountId && peer.declaration.scopeId === state.auth?.scopeId)
      .map((peer) => projectPeerEndpoints(peer, state.auth!))
    this.send(state.socket, { kind: 'relay.directory', requestId, revision: this.revision, peers })
  }

  private async connect(state: RelaySocketState, input: Record<string, unknown>): Promise<void> {
    const requestId = string(input.requestId, 'requestId')
    const generation = this.assertCurrentGeneration(state, input.generation, 'generation')
    const rawTarget = string(input.targetAgentId, 'targetAgentId')
    let targetAgentId: string
    try {
      targetAgentId = assertEndpointIdentity(rawTarget, 'targetAgentId')
    } catch (error) {
      throw new RelayFailure('INVALID_INPUT', error instanceof Error ? error.message : 'targetAgentId is not a transport target')
    }
    const targetGeneration = positiveInteger(input.targetGeneration, 'targetGeneration')
    if (!state.auth || !state.identityKey) throw new RelayFailure('UNAUTHENTICATED', 'control identity is unavailable', requestId)
    const target = [...this.peers.values()].find((peer) => peer.declaration.identity.accountId === state.auth?.accountId && peer.declaration.scopeId === state.auth?.scopeId && peer.declaration.identity.agentId === targetAgentId)
    if (!target) throw new RelayFailure('FORBIDDEN', 'target is outside the authenticated scope', requestId)
    if (target.declaration.identity.agentId === state.auth.agentId) throw new RelayFailure('FORBIDDEN', 'self relay is not allowed', requestId)
    if (target.presence !== 'online') throw new RelayFailure('UNAVAILABLE', 'target is offline', requestId)
    if (target.generation !== targetGeneration) throw new RelayFailure('STALE_GENERATION', 'target generation is stale', requestId)
    const targetState = this.controls.get(target.connectionId)
    if (!targetState || targetState.closed || !open(targetState.socket) || targetState.generation !== targetGeneration) {
      throw new RelayFailure('STALE_GENERATION', 'target connection generation is stale', requestId)
    }
    if (this.options.authorizeTarget && !(await this.options.authorizeTarget(state.auth, target))) {
      throw new RelayFailure('FORBIDDEN', 'target policy denied the connection', requestId)
    }
    this.assertCurrentControl(state, requestId)
    const targetKey = identityKey({
      accountId: target.declaration.identity.accountId,
      scopeId: target.declaration.scopeId,
      agentId: target.declaration.identity.agentId,
    })
    if (targetState.closed || !open(targetState.socket) || this.activeByIdentity.get(targetKey) !== targetState || targetState.generation !== targetGeneration) {
      throw new RelayFailure('STALE_GENERATION', 'target connection generation is stale', requestId)
    }
    this.purgeExpiredGrants()
    if (this.grants.size >= this.options.maxGrants) throw new RelayFailure('RESOURCE_EXHAUSTED', 'relay grant capacity is exhausted', requestId)
    const grant: RelayGrant = {
      grantId: this.idFactory(),
      accountId: state.auth.accountId,
      scopeId: state.auth.scopeId,
      sourceAgentId: state.auth.agentId,
      targetAgentId,
      sourceGeneration: generation,
      targetGeneration,
      expiresAt: new Date(this.now().getTime() + this.options.grantTtlMs).toISOString(),
    }
    const stored: RelayGrantState = {
      grant,
      sourceConnectionId: state.connectionId,
      targetConnectionId: targetState.connectionId,
      expiryTimer: setTimeout(() => this.expireGrant(grant.grantId), this.options.grantTtlMs),
    }
    ;(stored.expiryTimer as NodeJS.Timeout).unref?.()
    this.grants.set(grant.grantId, stored)
    this.send(state.socket, { kind: 'relay.grant', requestId, grant })
    this.send(targetState.socket, { kind: 'relay.offer', grant })
  }

  private async openDataConnection(state: RelaySocketState, input: Record<string, unknown>): Promise<void> {
    const requestId = string(input.requestId, 'requestId')
    const grantId = string(input.grantId, 'grantId')
    const generation = positiveInteger(input.generation, 'generation')
    const authenticated = await this.authenticate(state)
    if (state.closed || !open(state.socket)) throw new RelayFailure('UNAVAILABLE', 'connection closed during authentication', requestId, true)
    const stored = this.grants.get(grantId)
    if (!stored) throw new RelayFailure('NOT_FOUND', 'relay grant is unknown', requestId, true)
    if (Date.parse(stored.grant.expiresAt) <= this.now().getTime()) {
      this.closeGrant(grantId, { code: 'UNAVAILABLE', message: 'relay grant expired' })
      throw new RelayFailure('UNAVAILABLE', 'relay grant expired', requestId, true)
    }
    const side = this.grantSide(stored.grant, authenticated, generation, requestId)
    const controlKey = identityKey({
      accountId: stored.grant.accountId,
      scopeId: stored.grant.scopeId,
      agentId: authenticated.agentId,
    })
    const control = this.activeByIdentity.get(controlKey)
    const expectedConnectionId = side === 'source' ? stored.sourceConnectionId : stored.targetConnectionId
    const expectedGeneration = side === 'source' ? stored.grant.sourceGeneration : stored.grant.targetGeneration
    if (!control || control.closed || !open(control.socket) || control.connectionId !== expectedConnectionId || control.generation !== expectedGeneration) {
      throw new RelayFailure('STALE_GENERATION', 'relay grant is bound to an older control connection', requestId, true)
    }
    if (side === 'source' && stored.sourceData) throw new RelayFailure('CONFLICT', 'source data connection already exists', requestId, true)
    if (side === 'target' && stored.targetData) throw new RelayFailure('CONFLICT', 'target data connection already exists', requestId, true)
    state.role = 'data'
    state.auth = authenticated
    state.grantId = grantId
    state.side = side
    if (side === 'source') {
      stored.sourceData = state
      stored.sourceRequestId = requestId
    } else {
      stored.targetData = state
      stored.targetRequestId = requestId
    }
    if (!stored.sourceData || !stored.targetData) return
    stored.sourceData.opened = true
    stored.targetData.opened = true
    this.send(stored.sourceData.socket, { kind: 'relay.opened', requestId: stored.sourceRequestId ?? requestId, grantId })
    this.send(stored.targetData.socket, { kind: 'relay.opened', requestId: stored.targetRequestId ?? requestId, grantId })
  }

  private grantSide(grant: RelayGrant, authenticated: AuthenticatedAgent, generation: number, requestId: string): RelaySide {
    const sameScope = authenticated.accountId === grant.accountId && authenticated.scopeId === grant.scopeId
    if (!sameScope) throw new RelayFailure('FORBIDDEN', 'relay grant scope does not match authentication', requestId, true)
    if (authenticated.agentId === grant.sourceAgentId) {
      if (generation !== grant.sourceGeneration) throw new RelayFailure('STALE_GENERATION', 'source generation is stale', requestId, true)
      return 'source'
    }
    if (authenticated.agentId === grant.targetAgentId) {
      if (generation !== grant.targetGeneration) throw new RelayFailure('STALE_GENERATION', 'target generation is stale', requestId, true)
      return 'target'
    }
    throw new RelayFailure('FORBIDDEN', 'authenticated agent is not a grant participant', requestId, true)
  }

  private forwardData(state: RelaySocketState, data: RawData, isBinary: boolean): void {
    const grant = state.grantId ? this.grants.get(state.grantId) : undefined
    if (!grant || !state.side) {
      throw new RelayFailure('UNAVAILABLE', 'relay data connection is no longer active', undefined, true)
    }
    if (Date.parse(grant.grant.expiresAt) <= this.now().getTime()) {
      this.closeGrant(grant.grant.grantId, { code: 'UNAVAILABLE', message: 'relay grant expired' })
      throw new RelayFailure('UNAVAILABLE', 'relay grant expired', undefined, true)
    }
    const target = state.side === 'source' ? grant.targetData : grant.sourceData
    if (!target || !target.opened || !open(target.socket)) {
      throw new RelayFailure('UNAVAILABLE', 'relay peer data connection is not open', undefined, true)
    }
    const frameSize = rawDataSize(data)
    if (frameSize > this.options.maxBufferedAmount || target.socket.bufferedAmount > this.options.maxBufferedAmount - frameSize) {
      const failure: ServiceError = { code: 'RESOURCE_EXHAUSTED', message: 'relay peer send buffer limit reached' }
      this.closeGrant(grant.grant.grantId, failure)
      throw new RelayFailure(failure.code, failure.message, undefined, true)
    }
    try {
      target.socket.send(data, { binary: isBinary }, (error?: Error) => {
        if (error) this.closeGrant(grant.grant.grantId, { code: 'UPSTREAM_ERROR', message: 'relay peer send failed' })
      })
    } catch (error) {
      const failure: ServiceError = { code: 'UPSTREAM_ERROR', message: error instanceof Error ? error.message : 'relay peer send failed' }
      this.closeGrant(grant.grant.grantId, failure)
      throw new RelayFailure(failure.code, failure.message, undefined, true)
    }
  }

  private handleFailure(state: RelaySocketState, error: unknown): void {
    if (state.closed || state.closing) return
    const failure = error instanceof RelayFailure
      ? error
      : new RelayFailure('UPSTREAM_ERROR', error instanceof Error ? error.message : 'relay operation failed', undefined, true)
    if (state.role === 'data' && state.opened) {
      if (state.grantId) this.closeGrant(state.grantId, errorValue(failure))
      this.closeSocket(state, 1008, failure.message)
      return
    }
    this.send(state.socket, { kind: 'relay.error', ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }), error: errorValue(failure) })
    if (failure.closeSocket || state.role === 'unknown' || state.role === 'data') this.closeSocket(state, 1008, failure.message)
  }

  private handleClose(state: RelaySocketState): void {
    if (state.closed) return
    state.closed = true
    this.sockets.delete(state)
    if (state.role === 'data' && state.grantId) {
      this.closeGrant(state.grantId, { code: 'UNAVAILABLE', message: 'relay data connection closed' })
      return
    }
    if (state.role !== 'control' || !state.identityKey) return
    this.controls.delete(state.connectionId)
    if (this.activeByIdentity.get(state.identityKey) !== state) return
    this.activeByIdentity.delete(state.identityKey)
    this.invalidateGrantsForConnection(state.connectionId, { code: 'UNAVAILABLE', message: 'control connection closed' })
    const previous = this.peers.get(state.identityKey)
    if (previous?.presence === 'online') this.setPeer({ ...previous, connectionId: state.connectionId, generation: state.generation ?? previous.generation, presence: 'offline', lastSeenAt: this.now().toISOString() })
  }

  private closeGrant(grantId: string, error?: ServiceError): void {
    const stored = this.grants.get(grantId)
    if (!stored) return
    clearTimeout(stored.expiryTimer)
    this.grants.delete(grantId)
    for (const data of [stored.sourceData, stored.targetData]) {
      if (data && !data.closed) data.socket.close(1000, 'relay closed')
    }
    const source = this.controls.get(stored.sourceConnectionId)
    const target = this.controls.get(stored.targetConnectionId)
    const message: RelayServerControl = { kind: 'relay.closed', grantId, ...(error === undefined ? {} : { error }) }
    if (source) this.send(source.socket, message)
    if (target && target !== source) this.send(target.socket, message)
  }

  private invalidateGrantsForConnection(connectionId: string, error: ServiceError): void {
    for (const [grantId, stored] of this.grants) {
      if (stored.sourceConnectionId === connectionId || stored.targetConnectionId === connectionId) this.closeGrant(grantId, error)
    }
  }

  private purgeExpiredGrants(): void {
    const now = this.now().getTime()
    for (const [grantId, stored] of this.grants) {
      if (Date.parse(stored.grant.expiresAt) <= now) this.closeGrant(grantId, { code: 'UNAVAILABLE', message: 'relay grant expired' })
    }
  }

  private expireGrant(grantId: string): void {
    const stored = this.grants.get(grantId)
    if (!stored) return
    const remainingMs = Date.parse(stored.grant.expiresAt) - this.now().getTime()
    if (remainingMs > 0) {
      stored.expiryTimer = setTimeout(() => this.expireGrant(grantId), remainingMs)
      ;(stored.expiryTimer as NodeJS.Timeout).unref?.()
      return
    }
    this.closeGrant(grantId, { code: 'UNAVAILABLE', message: 'relay grant expired' })
  }

  private setPeer(peer: RelayPeer): void {
    const key = identityKey({
      accountId: peer.declaration.identity.accountId,
      scopeId: peer.declaration.scopeId,
      agentId: peer.declaration.identity.agentId,
    })
    this.peers.set(key, peer)
    this.revision += 1
    for (const state of this.controls.values()) {
      if (!state.identityKey || this.activeByIdentity.get(state.identityKey) !== state || !state.subscribed || !state.auth || !open(state.socket)) continue
      if (state.auth.accountId !== peer.declaration.identity.accountId || state.auth.scopeId !== peer.declaration.scopeId) continue
      this.send(state.socket, { kind: 'relay.changed', revision: this.revision, peer: projectPeerEndpoints(peer, state.auth) })
    }
  }

  private closeSocket(state: RelaySocketState, code: number, reason: string): void {
    if (state.closed || state.closing) return
    state.closing = true
    if (open(state.socket)) state.socket.close(code, safeCloseReason(reason))
    if (state.role === 'control') this.invalidateGrantsForConnection(state.connectionId, { code: 'UNAVAILABLE', message: 'control connection closed' })
  }

  private stateForSocket(socket: Socket): RelaySocketState | undefined {
    for (const state of this.sockets) {
      if (state.socket === socket) return state
    }
    return undefined
  }

  private closeSocketAfterSendFailure(socket: Socket, code: number, reason: string): void {
    const state = this.stateForSocket(socket)
    if (state) {
      this.closeSocket(state, code, reason)
      return
    }
    if (open(socket)) socket.close(code, safeCloseReason(reason))
  }

  private send(socket: Socket, message: RelayServerControl): void {
    if (!open(socket)) return
    const payload = JSON.stringify(message)
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (payloadBytes > this.options.maxBufferedAmount || socket.bufferedAmount > this.options.maxBufferedAmount - payloadBytes) {
      this.closeSocketAfterSendFailure(socket, 1013, 'relay control send buffer limit reached')
      return
    }
    try {
      socket.send(payload, (error?: Error) => {
        if (error) this.closeSocketAfterSendFailure(socket, 1011, 'relay control send failed')
      })
    } catch {
      this.closeSocketAfterSendFailure(socket, 1011, 'relay control send failed')
    }
  }
}

export async function createRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('relay: port is invalid')
  if (!Number.isInteger(options.maxPayload) || options.maxPayload < 1) throw new Error('relay: maxPayload must be positive')
  if (!Number.isInteger(options.maxConnections) || options.maxConnections < 1) throw new Error('relay: maxConnections must be positive')
  if (!Number.isInteger(options.maxGrants) || options.maxGrants < 1) throw new Error('relay: maxGrants must be positive')
  if (!Number.isInteger(options.maxBufferedAmount) || options.maxBufferedAmount < 1) throw new Error('relay: maxBufferedAmount must be positive')
  if (!Number.isInteger(options.maxPendingMessages) || options.maxPendingMessages < 1) throw new Error('relay: maxPendingMessages must be positive')
  if (!Number.isInteger(options.maxPendingBytes) || options.maxPendingBytes < 1) throw new Error('relay: maxPendingBytes must be positive')
  if (!Number.isInteger(options.grantTtlMs) || options.grantTtlMs < 1) throw new Error('relay: grantTtlMs must be positive')
  const httpsServer = createServer({ key: options.key, cert: options.cert })
  const wsServer = new WebSocketServer({ server: httpsServer, maxPayload: options.maxPayload })
  const relay = new RelayServerImpl(options, httpsServer, wsServer)
  wsServer.on('connection', (socket, request) => relay.accept(socket, request))
  const listening = once(httpsServer, 'listening')
  httpsServer.listen(options.port, options.host ?? '127.0.0.1')
  await listening
  return relay
}
