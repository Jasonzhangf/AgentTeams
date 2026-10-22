import { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import type { AgentDeclaration, JsonValue, RelayClientControl, RelayGrant, RelayPeer, RelayServerControl, ServiceError } from '../control-protocol/agent-services.ts'
import { encodeRelayClientControl, parseAgentDeclaration, parseRelayServerControl } from '../control-protocol/relay-codec.ts'
import { RelayProtocolError } from '../control-protocol/relay-admission.ts'
import { loginRelay, type RelayLoginOptions } from './relay-login.ts'
import { connectWss, type WssConnection } from './wss-connection.ts'

type Event = Extract<RelayServerControl, { kind: 'relay.changed' | 'relay.offer' | 'relay.closed' }>
type Reply = Extract<RelayServerControl, { kind: 'relay.directory' | 'relay.grant' | 'relay.logged-out' }>
/** Group traffic shares the admitted control connection; an error carries the correlated failure. */
export type RelayGroupMessage =
  | { readonly kind: 'relay.group.reply'; readonly requestId: string; readonly frame: JsonValue }
  | { readonly kind: 'relay.group.push'; readonly frame: JsonValue }
  | { readonly kind: 'relay.error'; readonly requestId?: string; readonly error: ServiceError }
export interface RelayClientOptions extends RelayLoginOptions {
  readonly requestTimeoutMs: number
  readonly maxPendingRequests: number
  readonly maxDataConnections: number
  /** Receiver owns execution admission/capacity; failures close this control connection. */
  readonly onEvent?: (event: Event) => void | Promise<void>
}
export interface RelayDirectorySnapshot {
  readonly revision: number
  readonly peers: readonly RelayPeer[]
}
export interface RelayClient {
  readonly generation: number
  readonly closed: Promise<Error>
  directory(subscribe: boolean): Promise<readonly RelayPeer[]>
  directorySnapshot(subscribe: boolean): Promise<RelayDirectorySnapshot>
  connect(targetAgentId: string, targetGeneration: number): Promise<RelayGrant>
  openData(grant: RelayGrant): Promise<WssConnection>
  presence(): Promise<void>
  publish(declaration: AgentDeclaration): Promise<void>
  /** Writes one group request frame on this control connection. The reply arrives through `onGroup`. */
  sendGroup(requestId: string, frame: JsonValue): Promise<void>
  /** Receives group replies, pushes, correlated errors and the typed stop report. Returns a detach function. */
  onGroup(handler: (message: RelayGroupMessage) => void): () => void
  close(): Promise<void>
}
interface Pending {
  readonly kind: Reply['kind']
  readonly resolve: (value: Reply) => void
  readonly reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

function serviceFailure(error: Error): ServiceError {
  return { code: error instanceof RelayProtocolError ? error.code : 'UNAVAILABLE', message: error.message }
}

export async function createRelayClient(input: RelayClientOptions): Promise<RelayClient> {
  const { onEvent, ...rest } = input
  const options: RelayClientOptions = { ...structuredClone(rest), onEvent,
    transport: { ...input.transport, ca: Buffer.isBuffer(input.transport.ca) ? Buffer.from(input.transport.ca) : input.transport.ca } }
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(options.maxPendingRequests) || options.maxPendingRequests < 1 ||
    !Number.isSafeInteger(options.maxDataConnections) || options.maxDataConnections < 1) {
    throw new RelayProtocolError('INVALID_INPUT', 'relay: invalid request limits')
  }
  const login = await loginRelay(options)
  const identity = structuredClone(options.declaration.identity)
  const scopeId = options.declaration.scopeId
  const pending = new Map<string, Pending>()
  // Outstanding group request ids, so a reply or a group error can be routed to
  // the group owner. A request whose caller gave up is remembered for one TTL so
  // a late error still goes to the group owner instead of failing the control
  // loop, then forgotten: the set never grows without bound.
  const groupRequests = new Set<string>()
  const expiredGroupRequests = new Map<string, number>()
  const groupHandlers = new Set<(message: RelayGroupMessage) => void>()
  const data = new Map<string, WssConnection>()
  const opening = new Set<string>()
  const connecting = new Set<Promise<WssConnection>>()
  const dataLifetime = new AbortController()
  setMaxListeners(options.maxDataConnections, dataLifetime.signal)
  let stopped: Error | undefined
  let resolveClosed!: (error: Error) => void
  const closed = new Promise<Error>(resolve => { resolveClosed = resolve })
  let shutdown: Promise<void> | undefined
  let gracefulShutdown: Promise<void> | undefined
  let publishing = false
  let closing = false
  let declarationRevision = options.declaration.revision
  /** How long a given-up group request id is still routed to the group owner. */
  const EXPIRED_GROUP_REQUEST_TTL_MS = 300_000
  /** Bound on remembered ids whose caller already gave up. */
  const EXPIRED_GROUP_REQUESTS = 256
  const expireGroupRequests = (now: number): void => {
    for (const [requestId, deadline] of expiredGroupRequests) {
      if (deadline > now) break
      expiredGroupRequests.delete(requestId)
    }
  }
  const forgetGroupRequest = (requestId: string, now: number): boolean => {
    groupRequests.delete(requestId)
    expiredGroupRequests.set(requestId, now + EXPIRED_GROUP_REQUEST_TTL_MS)
    while (expiredGroupRequests.size > EXPIRED_GROUP_REQUESTS) {
      const oldest = expiredGroupRequests.keys().next()
      if (oldest.done === true) break
      expiredGroupRequests.delete(oldest.value)
    }
    return true
  }
  const notifyGroup = (message: RelayGroupMessage): void => {
    for (const handler of [...groupHandlers]) {
      try { handler(message) } catch { /* An observer must not break the shared control pump. */ }
    }
  }
  const stop = (error: Error): Promise<void> => {
    if (shutdown) return shutdown
    stopped = error
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
    if (groupRequests.size > 0) {
      const failure = serviceFailure(error)
      for (const requestId of groupRequests) notifyGroup({ kind: 'relay.error', requestId, error: failure })
    }
    groupRequests.clear()
    expiredGroupRequests.clear()
    dataLifetime.abort()
    shutdown = (async () => {
      await Promise.all([login.transport.close(), ...[...data.values()].map(socket => socket.close()),
        ...[...connecting].map(attempt => attempt.then(socket => socket.close(), () => undefined))])
      data.clear()
      resolveClosed(error)
    })()
    return shutdown
  }
  const send = (message: RelayClientControl, allowDuringClose = false) => {
    if (stopped) return Promise.reject(stopped)
    if (closing && !allowDuringClose) return Promise.reject(new RelayProtocolError('UNAVAILABLE', 'relay: client is closing'))
    return login.transport.send({ bytes: Buffer.from(encodeRelayClientControl(message)), binary: false })
  }
  const checkGrant = (grant: RelayGrant) => {
    if (grant.accountId !== identity.accountId || grant.scopeId !== scopeId ||
      (grant.sourceAgentId !== identity.agentId && grant.targetAgentId !== identity.agentId)) {
      throw new RelayProtocolError('FORBIDDEN', 'relay: grant is outside this authenticated participant')
    }
    const generation = grant.sourceAgentId === identity.agentId ? grant.sourceGeneration : grant.targetGeneration
    if (generation !== login.receipt.generation) throw new RelayProtocolError('STALE_GENERATION', 'relay: grant generation is stale')
  }
  const pump = async () => {
    try {
      while (!stopped) {
        const frame = await login.transport.read()
        if (frame.binary) throw new RelayProtocolError('INVALID_INPUT', 'relay: control frame must be text')
        const message = parseRelayServerControl(frame.bytes.toString('utf8'))
        if (message.kind === 'relay.error') {
          const error = new RelayProtocolError(message.error.code, message.error.message)
          // A group failure belongs to its request, not to the protocol request table.
          // Reporting it to the group owner keeps the control connection alive.
          if (message.requestId !== undefined && groupRequests.has(message.requestId)) {
            forgetGroupRequest(message.requestId, Date.now())
            notifyGroup({ kind: 'relay.error', requestId: message.requestId, error: message.error })
            continue
          }
          // A late error for a group request whose caller already gave up still
          // belongs to the group owner; it must not fail the control loop.
          if (message.requestId !== undefined && expiredGroupRequests.has(message.requestId)) {
            expiredGroupRequests.delete(message.requestId)
            notifyGroup({ kind: 'relay.error', requestId: message.requestId, error: message.error })
            continue
          }
          const request = message.requestId === undefined ? undefined : pending.get(message.requestId)
          if (!request) throw error
          pending.delete(message.requestId!)
          clearTimeout(request.timer)
          request.reject(error)
        } else if (message.kind === 'relay.directory' || message.kind === 'relay.grant' || message.kind === 'relay.logged-out') {
          const request = pending.get(message.requestId)
          if (!request || request.kind !== message.kind) throw new RelayProtocolError('INVALID_INPUT', 'relay: unexpected response correlation')
          if (message.kind === 'relay.directory') {
            if (message.peers.some(peer => peer.declaration.identity.accountId !== identity.accountId || peer.declaration.scopeId !== scopeId)) {
              throw new RelayProtocolError('FORBIDDEN', 'relay: directory contains an out-of-scope peer')
            }
          } else if (message.kind === 'relay.grant') checkGrant(message.grant)
          pending.delete(message.requestId)
          clearTimeout(request.timer)
          request.resolve(message)
        } else if (message.kind === 'relay.changed' || message.kind === 'relay.offer' || message.kind === 'relay.closed') {
          if (message.kind === 'relay.offer') checkGrant(message.grant)
          if (message.kind === 'relay.changed' && (message.peer.declaration.identity.accountId !== identity.accountId || message.peer.declaration.scopeId !== scopeId)) {
            throw new RelayProtocolError('FORBIDDEN', 'relay: event contains an out-of-scope peer')
          }
          if (message.kind === 'relay.closed') {
            const socket = data.get(message.grantId)
            if (socket) { await socket.close(); data.delete(message.grantId) }
          }
          // Do not block replies: a receiver may itself request directory/grant data.
          // Observe async failure rather than leaving an unhandled rejection and a false live client.
          void Promise.resolve(options.onEvent?.(message)).catch(error =>
            stop(error instanceof Error ? error : new Error('relay: event receiver failed')))
        } else if (message.kind === 'relay.group.reply' || message.kind === 'relay.group.push') {
          if (message.kind === 'relay.group.reply') {
            groupRequests.delete(message.requestId)
            expiredGroupRequests.delete(message.requestId)
          }
          notifyGroup(message)
        } else throw new RelayProtocolError('INVALID_INPUT', 'relay: unexpected admitted-control message')
      }
    } catch (error) { await stop(error instanceof Error ? error : new Error('relay: control loop failed')) }
  }
  void pump()
  const request = (kind: Reply['kind'], message: RelayClientControl & { requestId: string },
    publication?: Extract<RelayClientControl, { kind: 'relay.publish' }>, allowDuringClose = false): Promise<Reply> => {
    if (stopped) return Promise.reject(stopped)
    if (closing && !allowDuringClose) return Promise.reject(new RelayProtocolError('UNAVAILABLE', 'relay: client is closing'))
    if (!allowDuringClose && pending.size >= options.maxPendingRequests) return Promise.reject(new RelayProtocolError('RESOURCE_EXHAUSTED', 'relay: pending request capacity exhausted'))
    return new Promise((resolve, reject) => {
      const request: Pending = { kind, resolve, reject }
      pending.set(message.requestId, request)
      void (async () => {
        try {
          // Reserve the correlated readback slot before sending its publication mutation.
          if (publication) await send(publication, allowDuringClose)
          await send(message, allowDuringClose)
          // The deadline covers reply latency only. Starting it before send lets a delayed
          // outbound write leave the remote owner unstarted while reporting RESULT_UNKNOWN.
          if (pending.get(message.requestId) !== request) return
          request.timer = setTimeout(() => {
            // A timed-out mutation can have an unknown remote result. Never retry it.
            void stop(new RelayProtocolError('RESULT_UNKNOWN', 'relay: request deadline elapsed'))
          }, options.requestTimeoutMs)
        } catch (error) {
          await stop(error instanceof Error ? error : new Error('relay: control write failed'))
        }
      })()
    })
  }
  const directorySnapshot = async (subscribe: boolean): Promise<RelayDirectorySnapshot> => {
    const response = await request('relay.directory', { kind: 'relay.directory', requestId: randomUUID(), subscribe })
    if (response.kind !== 'relay.directory') throw new RelayProtocolError('INVALID_INPUT', 'relay: directory response expected')
    if (!Number.isSafeInteger(response.revision) || response.revision < 0) {
      throw new RelayProtocolError('INVALID_INPUT', 'relay: directory revision is invalid')
    }
    return { revision: response.revision, peers: response.peers }
  }
  return {
    generation: login.receipt.generation,
    closed,
    directorySnapshot,
    directory: async subscribe => (await directorySnapshot(subscribe)).peers,
    connect: async (targetAgentId, targetGeneration) => {
      const response = await request('relay.grant', { kind: 'relay.connect', requestId: randomUUID(), generation: login.receipt.generation, targetAgentId, targetGeneration })
      if (response.kind !== 'relay.grant') throw new RelayProtocolError('INVALID_INPUT', 'relay: grant response expected')
      if (response.grant.sourceAgentId !== identity.agentId || response.grant.targetAgentId !== targetAgentId || response.grant.targetGeneration !== targetGeneration) {
        await stop(new RelayProtocolError('FORBIDDEN', 'relay: grant does not match requested target'))
        throw stopped
      }
      return response.grant
    },
    openData: async input => {
      if (stopped) throw stopped
      if (closing) throw new RelayProtocolError('UNAVAILABLE', 'relay: client is closing')
      const grant = structuredClone(input)
      checkGrant(grant)
      if (opening.has(grant.grantId) || data.has(grant.grantId)) throw new RelayProtocolError('CONFLICT', 'relay: grant already has a local data connection')
      if (new Set([...opening, ...data.keys()]).size >= options.maxDataConnections) throw new RelayProtocolError('RESOURCE_EXHAUSTED', 'relay: data connection capacity exhausted')
      if (Date.parse(grant.expiresAt) <= Date.now()) throw new RelayProtocolError('UNAVAILABLE', 'relay: grant has expired')
      opening.add(grant.grantId)
      let socket: WssConnection | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const attempt = connectWss(options.transport, dataLifetime.signal)
        connecting.add(attempt)
        try { socket = await attempt } finally { connecting.delete(attempt) }
        if (stopped) throw stopped
        data.set(grant.grantId, socket)
        const requestId = randomUUID()
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RelayProtocolError('UNAVAILABLE', 'relay: data open timed out')), options.requestTimeoutMs) })
        await Promise.race([deadline, (async () => {
          await socket!.send({ bytes: Buffer.from(JSON.stringify({ kind: 'relay.open', requestId, grantId: grant.grantId, generation: login.receipt.generation })), binary: false })
          const frame = await socket!.read()
          if (frame.binary) throw new RelayProtocolError('INVALID_INPUT', 'relay: data handshake must be text')
          const response = parseRelayServerControl(frame.bytes.toString('utf8'))
          if (response.kind === 'relay.error') throw new RelayProtocolError(response.error.code, response.error.message)
          if (response.kind !== 'relay.opened' || response.grantId !== grant.grantId || response.requestId !== requestId) {
            throw new RelayProtocolError('INVALID_INPUT', 'relay: mismatched data handshake')
          }
        })()])
        const opened = socket
        void opened.closed.then(() => { if (data.get(grant.grantId) === opened) data.delete(grant.grantId) })
        return opened
      } catch (error) {
        await socket?.close()
        data.delete(grant.grantId)
        throw error
      } finally { clearTimeout(timer); opening.delete(grant.grantId) }
    },
    presence: () => send({ kind: 'relay.presence', generation: login.receipt.generation }),
    publish: async declaration => {
      if (publishing) throw new RelayProtocolError('CONFLICT', 'relay: declaration publication already in progress')
      const value = parseAgentDeclaration(structuredClone(declaration))
      const identityFields = ['hostId', 'machineId', 'agentId', 'accountId', 'agentKind'] as const
      if (identityFields.some(field => value.identity[field] !== identity[field]) || value.scopeId !== scopeId || value.revision <= declarationRevision) {
        throw new RelayProtocolError('INVALID_INPUT', 'relay: publication must preserve identity and advance declaration revision')
      }
      publishing = true
      try {
        const response = await request('relay.directory', { kind: 'relay.directory', requestId: randomUUID(), subscribe: false },
          { kind: 'relay.publish', generation: login.receipt.generation, declaration: value })
        if (response.kind !== 'relay.directory' || !response.peers.some(peer => peer.generation === login.receipt.generation &&
          JSON.stringify(peer.declaration) === JSON.stringify(value))) throw new RelayProtocolError('UNAVAILABLE', 'relay: publication readback mismatch')
        declarationRevision = value.revision
      } finally { publishing = false }
    },
    sendGroup: async (requestId, frame) => {
      if (stopped) throw stopped
      if (closing) throw new RelayProtocolError('UNAVAILABLE', 'relay: client is closing')
      if (typeof requestId !== 'string' || requestId.length === 0) throw new RelayProtocolError('INVALID_INPUT', 'relay: group request id must be a non-empty string')
      if (groupRequests.has(requestId)) throw new RelayProtocolError('CONFLICT', `relay: group request ${requestId} is already outstanding`)
      expireGroupRequests(Date.now())
      groupRequests.add(requestId)
      try {
        await send({ kind: 'relay.group', requestId, frame })
      } catch (error) {
        groupRequests.delete(requestId)
        throw error
      }
    },
    onGroup: handler => {
      if (typeof handler !== 'function') throw new RelayProtocolError('INVALID_INPUT', 'relay: group handler must be a function')
      groupHandlers.add(handler)
      return () => { groupHandlers.delete(handler) }
    },
    close: () => {
      if (gracefulShutdown) return gracefulShutdown
      closing = true
      gracefulShutdown = (async () => {
        if (!stopped) {
          try {
            const response = await request('relay.logged-out', { kind: 'relay.logout', requestId: randomUUID(), generation: login.receipt.generation }, undefined, true)
            if (response.kind !== 'relay.logged-out') throw new RelayProtocolError('INVALID_INPUT', 'relay: logout acknowledgement expected')
          } catch (error) {
            await stop(error instanceof Error ? error : new Error('relay: logout failed'))
            throw error
          }
        }
        await stop(new RelayProtocolError('UNAVAILABLE', 'relay: client stopped locally'))
      })()
      return gracefulShutdown
    },
  }
}
