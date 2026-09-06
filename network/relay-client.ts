import { randomUUID } from 'node:crypto'
import type { RelayClientControl, RelayGrant, RelayPeer, RelayServerControl } from '../control-protocol/agent-services.ts'
import { parseRelayServerControl } from '../control-protocol/relay-codec.ts'
import { RelayProtocolError } from '../control-protocol/relay-admission.ts'
import { loginRelay, type RelayLoginOptions } from './relay-login.ts'
import { connectWss, type WssConnection } from './wss-connection.ts'

type Event = Extract<RelayServerControl, { kind: 'relay.changed' | 'relay.offer' | 'relay.closed' }>
type Reply = Extract<RelayServerControl, { kind: 'relay.directory' | 'relay.grant' }>
export interface RelayClientOptions extends RelayLoginOptions {
  readonly requestTimeoutMs: number
  readonly maxPendingRequests: number
  readonly maxDataConnections: number
  /** Receiver owns execution admission/capacity; failures close this control connection. */
  readonly onEvent?: (event: Event) => void | Promise<void>
}
export interface RelayClient {
  readonly generation: number
  readonly closed: Promise<Error>
  directory(subscribe: boolean): Promise<readonly RelayPeer[]>
  connect(targetAgentId: string, targetGeneration: number): Promise<RelayGrant>
  openData(grant: RelayGrant): Promise<WssConnection>
  presence(): Promise<void>
  close(): Promise<void>
}
interface Pending {
  readonly kind: Reply['kind']
  readonly resolve: (value: Reply) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
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
  const data = new Map<string, WssConnection>()
  const opening = new Set<string>()
  const connecting = new Set<Promise<WssConnection>>()
  let stopped: Error | undefined
  let resolveClosed!: (error: Error) => void
  const closed = new Promise<Error>(resolve => { resolveClosed = resolve })
  let shutdown: Promise<void> | undefined
  const stop = (error: Error): Promise<void> => {
    if (shutdown) return shutdown
    stopped = error
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
    shutdown = (async () => {
      await Promise.all([login.transport.close(), ...[...data.values()].map(socket => socket.close()),
        ...[...connecting].map(attempt => attempt.then(socket => socket.close(), () => undefined))])
      data.clear()
      resolveClosed(error)
    })()
    return shutdown
  }
  const send = (message: RelayClientControl) => {
    if (stopped) return Promise.reject(stopped)
    return login.transport.send({ bytes: Buffer.from(JSON.stringify(message)), binary: false })
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
          const request = message.requestId === undefined ? undefined : pending.get(message.requestId)
          if (!request) throw error
          pending.delete(message.requestId!)
          clearTimeout(request.timer)
          request.reject(error)
        } else if (message.kind === 'relay.directory' || message.kind === 'relay.grant') {
          const request = pending.get(message.requestId)
          if (!request || request.kind !== message.kind) throw new RelayProtocolError('INVALID_INPUT', 'relay: unexpected response correlation')
          if (message.kind === 'relay.directory') {
            if (message.peers.some(peer => peer.declaration.identity.accountId !== identity.accountId || peer.declaration.scopeId !== scopeId)) {
              throw new RelayProtocolError('FORBIDDEN', 'relay: directory contains an out-of-scope peer')
            }
          } else checkGrant(message.grant)
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
        } else throw new RelayProtocolError('INVALID_INPUT', 'relay: unexpected admitted-control message')
      }
    } catch (error) { await stop(error instanceof Error ? error : new Error('relay: control loop failed')) }
  }
  void pump()
  const request = (kind: Reply['kind'], message: RelayClientControl & { requestId: string }): Promise<Reply> => {
    if (stopped) return Promise.reject(stopped)
    if (pending.size >= options.maxPendingRequests) return Promise.reject(new RelayProtocolError('RESOURCE_EXHAUSTED', 'relay: pending request capacity exhausted'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation can have an unknown remote result. Never retry it.
        void stop(new RelayProtocolError('RESULT_UNKNOWN', 'relay: request deadline elapsed'))
      }, options.requestTimeoutMs)
      pending.set(message.requestId, { kind, resolve, reject, timer })
      void send(message).catch(error => stop(error instanceof Error ? error : new Error('relay: control write failed')))
    })
  }
  return {
    generation: login.receipt.generation,
    closed,
    directory: async subscribe => {
      const response = await request('relay.directory', { kind: 'relay.directory', requestId: randomUUID(), subscribe })
      if (response.kind !== 'relay.directory') throw new RelayProtocolError('INVALID_INPUT', 'relay: directory response expected')
      return response.peers
    },
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
      const grant = structuredClone(input)
      checkGrant(grant)
      if (opening.has(grant.grantId) || data.has(grant.grantId)) throw new RelayProtocolError('CONFLICT', 'relay: grant already has a local data connection')
      if (new Set([...opening, ...data.keys()]).size >= options.maxDataConnections) throw new RelayProtocolError('RESOURCE_EXHAUSTED', 'relay: data connection capacity exhausted')
      if (Date.parse(grant.expiresAt) <= Date.now()) throw new RelayProtocolError('UNAVAILABLE', 'relay: grant has expired')
      opening.add(grant.grantId)
      let socket: WssConnection | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const attempt = connectWss(options.transport)
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
    close: () => stop(new RelayProtocolError('UNAVAILABLE', 'relay: client stopped locally')),
  }
}
