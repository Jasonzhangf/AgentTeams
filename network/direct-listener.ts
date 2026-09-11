import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:https'
import type { IncomingMessage } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { parseTargetControlFrame, type TargetControlFrame } from '../control-protocol/frames.ts'
import type { AuthenticatedAgent, ServiceErrorCode } from '../control-protocol/agent-services.ts'
import {
  assertTargetGeneration,
  beginTargetTransport,
  closeTargetTransport,
  failTargetTransport,
  receiveHelloAck,
  type TargetTransportHello,
  type TargetTransportTarget,
  type TargetTransportState,
} from './target-transport.ts'
import { WssConnectionError, type WssFrame } from './wss-connection.ts'

type MaybePromise<T> = T | Promise<T>

export interface DirectWssListenerOptions {
  readonly host?: string
  readonly port: number
  readonly key: string | Buffer
  readonly cert: string | Buffer
  readonly admissions: readonly DirectWssAdmission[]
  readonly target: TargetTransportTarget
  readonly maxPayload: number
  readonly maxConnections: number
  readonly maxMessageBytes: number
  readonly maxBufferedBytes: number
  readonly maxPendingFrames: number
  readonly helloTimeoutMs: number
  readonly onConnection?: (connection: DirectWssAcceptedConnection) => MaybePromise<void>
}

/** Local admission truth. The reference may be published; the credential never is. */
export interface DirectWssAdmission {
  readonly admissionRef: string
  readonly peer: AuthenticatedAgent
  readonly credential: string
}

export interface DirectWssAcceptedConnection {
  readonly connectionId: string
  readonly hello: TargetTransportTarget
  readonly peer: AuthenticatedAgent
  readonly admissionRef: string
  readonly connection: {
    readonly closed: Promise<WssConnectionError>
    read(): Promise<WssFrame>
    send(frame: WssFrame): Promise<void>
    close(): Promise<void>
  }
  readonly closed: Promise<WssConnectionError>
  readonly state: TargetTransportState
  assertGeneration(generation: number): void
  close(reason?: string): Promise<void>
}

export interface DirectWssListener {
  readonly url: string
  readonly port: number
  readonly connections: readonly DirectWssAcceptedConnection[]
  close(): Promise<void>
}

function validLimit(value: number, label: string, timer = false): void {
  if (!Number.isSafeInteger(value) || value < 1 || (timer && value > 2_147_483_647)) {
    throw new Error(`direct-listener: ${label} must be a positive safe integer`)
  }
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
}

function frameError(code: ServiceErrorCode, message: string, cause?: unknown): WssConnectionError {
  return new WssConnectionError(code, message, cause)
}

function sameHello(actual: TargetTransportHello, expected: TargetTransportTarget): boolean {
  return actual.hostId === expected.hostId && actual.agentId === expected.agentId &&
    actual.targetGeneration === expected.targetGeneration && actual.protocolVersion === expected.protocolVersion &&
    actual.capabilitiesRevision === expected.capabilitiesRevision
}

function samePeer(actual: AuthenticatedAgent, expected: AuthenticatedAgent): boolean {
  return actual.accountId === expected.accountId && actual.scopeId === expected.scopeId && actual.agentId === expected.agentId
}

function writeHttpError(socket: import('node:net').Socket, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

export async function createDirectWssListener(options: DirectWssListenerOptions): Promise<DirectWssListener> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('direct-listener: port is invalid')
  if (options.admissions.length === 0) throw new Error('direct-listener: at least one admission is required')
  const admissionRefs = new Set<string>()
  const credentials = new Set<string>()
  const peers = new Set<string>()
  for (const admission of options.admissions) {
    if (admissionRefs.has(admission.admissionRef) || admission.admissionRef.length === 0) throw new Error('direct-listener: admission references must be unique')
    admissionRefs.add(admission.admissionRef)
    if (admission.credential.length === 0 || /[\r\n]/.test(admission.credential) || admission.peer.accountId.length === 0 || admission.peer.scopeId.length === 0 || admission.peer.agentId.length === 0) {
      throw new Error('direct-listener: admission is invalid')
    }
    const peerKey = `${admission.peer.accountId}\u0000${admission.peer.scopeId}\u0000${admission.peer.agentId}`
    if (credentials.has(admission.credential) || peers.has(peerKey)) throw new Error('direct-listener: credentials and peers must be unique per admission')
    credentials.add(admission.credential)
    peers.add(peerKey)
  }
  validLimit(options.maxPayload, 'maxPayload')
  validLimit(options.maxConnections, 'maxConnections')
  validLimit(options.maxMessageBytes, 'maxMessageBytes')
  validLimit(options.maxBufferedBytes, 'maxBufferedBytes')
  validLimit(options.maxPendingFrames, 'maxPendingFrames')
  validLimit(options.helloTimeoutMs, 'helloTimeoutMs', true)
  const httpsServer = createServer({ key: options.key, cert: options.cert })
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload })
  const active = new Map<string, DirectWssAcceptedConnection>()
  let closing = false
  let closePromise: Promise<void> | undefined

  const accept = (socket: WebSocket, request: IncomingMessage, admitted: DirectWssAdmission): void => {
    if (closing || active.size >= options.maxConnections) {
      socket.close(1013, 'direct listener connection limit')
      return
    }
    const connectionId = randomUUID()
    let state: TargetTransportState = beginTargetTransport({ ...options.target, source: admitted.peer, admissionRef: admitted.admissionRef })
    let terminal: WssConnectionError | undefined
    let resolveClosed!: (error: WssConnectionError) => void
    const closed = new Promise<WssConnectionError>(resolve => { resolveClosed = resolve })
    let reader: { resolve(frame: WssFrame): void; reject(error: WssConnectionError): void } | undefined
    const queue: WssFrame[] = []
    let queueBytes = 0
    let handshake = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let accepted!: DirectWssAcceptedConnection
    const admission = admitted

    const terminate = (error: WssConnectionError, stateName: 'closed' | 'failed' = 'failed'): void => {
      if (!terminal) {
        terminal = error
        queue.length = 0
        queueBytes = 0
        reader?.reject(error)
        reader = undefined
        if (stateName === 'failed' && (state.state === 'connecting' || state.state === 'ready')) {
          state = failTargetTransport(state, error.message)
        } else if (stateName === 'closed' && (state.state === 'connecting' || state.state === 'ready')) {
          state = closeTargetTransport(state, error.message)
        }
        resolveClosed(error)
      }
      if (timer !== undefined) clearTimeout(timer)
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
      active.delete(connectionId)
    }

    const sendRaw = (frame: WssFrame, enforceMessageLimit = true): Promise<void> => {
      if (terminal) return Promise.reject(terminal)
      if (!Buffer.isBuffer(frame.bytes) || typeof frame.binary !== 'boolean') return Promise.reject(frameError('INVALID_INPUT', 'direct-listener: invalid frame'))
      if ((enforceMessageLimit && frame.bytes.length > options.maxMessageBytes) || frame.bytes.length > options.maxBufferedBytes - socket.bufferedAmount) {
        const error = frameError('RESOURCE_EXHAUSTED', 'direct-listener: send buffer exhausted')
        terminate(error)
        return Promise.reject(error)
      }
      return new Promise<void>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          const error = frameError('UNAVAILABLE', 'direct-listener: socket is not open')
          terminate(error)
          reject(error)
          return
        }
        socket.send(frame.bytes, { binary: frame.binary }, error => {
          if (!error) { resolve(); return }
          const failed = frameError('UNAVAILABLE', 'direct-listener: frame write failed', error)
          terminate(failed)
          reject(failed)
        })
      })
    }

    const sendProtocolError = async (error: WssConnectionError): Promise<void> => {
      if (socket.readyState !== WebSocket.OPEN) return
      const targetGeneration = typeof state.targetGeneration === 'number' ? state.targetGeneration : options.target.targetGeneration
      const frame: TargetControlFrame = { kind: 'transport.error', targetGeneration,
        code: error.code, message: error.message }
      try { await sendRaw({ bytes: Buffer.from(JSON.stringify(frame)), binary: false }, false) } catch { /* close below preserves the original error */ }
    }

    const close = async (reason = 'direct listener connection closed'): Promise<void> => {
      if (!terminal) {
        const error = frameError('UNAVAILABLE', reason)
        terminate(error, 'closed')
      }
      await closed
    }

    const connection = {
      closed,
      read: async (): Promise<WssFrame> => {
        if (terminal) throw terminal
        if (reader) throw frameError('CONFLICT', 'direct-listener: only one frame reader is allowed')
        const frame = queue.shift()
        if (frame) { queueBytes -= frame.bytes.length; return frame }
        return new Promise<WssFrame>((resolve, reject) => { reader = { resolve, reject } })
      },
      send: sendRaw,
      close: () => close(),
    }
    accepted = {
      connectionId, hello: options.target, get peer() { return admission.peer }, get admissionRef() { return admission.admissionRef }, connection,
      closed, get state() { return state },
      assertGeneration: generation => assertTargetGeneration(state, generation),
      close,
    }
    active.set(connectionId, accepted)

    const finishHandshake = async (data: RawData, binary: boolean): Promise<void> => {
      const fail = async (error: WssConnectionError): Promise<void> => {
        await sendProtocolError(error)
        terminate(error)
      }
      if (!handshake) {
        const frame = { bytes: rawBytes(data), binary }
        if (frame.bytes.length > options.maxMessageBytes) {
          await fail(frameError('RESOURCE_EXHAUSTED', 'direct-listener: receive frame exceeds maxMessageBytes'))
          return
        }
        if (reader) { const pending = reader; reader = undefined; pending.resolve(frame); return }
        if (queue.length >= options.maxPendingFrames || frame.bytes.length > options.maxBufferedBytes - queueBytes) {
          terminate(frameError('RESOURCE_EXHAUSTED', 'direct-listener: receive buffer exhausted'))
          return
        }
        queueBytes += frame.bytes.length
        queue.push(frame)
        return
      }
      const bytes = rawBytes(data)
      if (bytes.length > options.maxMessageBytes) {
        await fail(frameError('RESOURCE_EXHAUSTED', 'direct-listener: hello exceeds maxMessageBytes'))
        return
      }
      if (binary) { await fail(frameError('INVALID_INPUT', 'direct-listener: hello must be text')); return }
      let parsed: TargetControlFrame
      try { parsed = parseTargetControlFrame(JSON.parse(bytes.toString('utf8'))) }
      catch (error) { await fail(frameError('INVALID_INPUT', 'direct-listener: invalid transport hello', error)); return }
      if (parsed.kind !== 'transport.hello') { await fail(frameError('INVALID_INPUT', 'direct-listener: expected transport.hello')); return }
      if (parsed.targetGeneration !== options.target.targetGeneration) { await fail(frameError('STALE_GENERATION', 'direct-listener: hello generation is stale')); return }
      if (!sameHello(parsed, options.target)) { await fail(frameError('FORBIDDEN', 'direct-listener: hello identity is not accepted')); return }
      if (!samePeer(parsed.source, admission.peer) || parsed.admissionRef !== admission.admissionRef) {
        await fail(frameError('FORBIDDEN', 'direct-listener: source admission is not accepted')); return
      }
      state = receiveHelloAck(beginTargetTransport(parsed))
      handshake = false
      if (timer !== undefined) clearTimeout(timer)
      await sendRaw({ bytes: Buffer.from(JSON.stringify({ kind: 'transport.hello_ack', targetGeneration: parsed.targetGeneration })), binary: false })
      try { await options.onConnection?.(accepted) } catch (error) {
        const failure = frameError('UNAVAILABLE', 'direct-listener: connection handler failed', error)
        await sendProtocolError(failure)
        terminate(failure)
      }
    }

    timer = setTimeout(() => { void (async () => {
      if (!handshake) return
      const error = frameError('RESULT_UNKNOWN', 'direct-listener: hello deadline elapsed')
      await sendProtocolError(error)
      terminate(error)
    })() }, options.helloTimeoutMs)
    socket.on('message', (data, binary) => { void finishHandshake(data, binary).catch(error => terminate(frameError('UNAVAILABLE', 'direct-listener: message handling failed', error))) })
    socket.on('close', () => {
      const error = terminal ?? frameError('UNAVAILABLE', 'direct-listener: connection closed')
      if (!terminal) terminate(error, 'closed')
      else { if (timer !== undefined) clearTimeout(timer); active.delete(connectionId) }
    })
    socket.on('error', error => { if (!terminal) terminate(frameError('UNAVAILABLE', 'direct-listener: connection failed', error)) })
  }

  const upgrade = (request: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void => {
    const authorization = request.headers.authorization
    const match = options.admissions.find(admission => admission.credential === authorization)
    if (!match) { writeHttpError(socket, 401, 'Unauthorized'); return }
    if (closing || active.size >= options.maxConnections) { writeHttpError(socket, 503, 'Unavailable'); return }
    wsServer.handleUpgrade(request, socket, head, client => {
      // Bind the HTTP admission to this socket before parsing any control frame.
      accept(client, request, match)
    })
  }
  httpsServer.on('upgrade', upgrade)
  const listening = once(httpsServer, 'listening')
  httpsServer.listen(options.port, options.host ?? '127.0.0.1')
  try { await listening } catch (error) { wsServer.close(); throw error }

  const listener: DirectWssListener = {
    get port() {
      const address = httpsServer.address()
      if (!address || typeof address === 'string') throw new Error('direct-listener: server has no bound address')
      return address.port
    },
    get url() { return `wss://${options.host ?? '127.0.0.1'}:${listener.port}` },
    get connections() { return [...active.values()] },
    close: async () => {
      if (closePromise) return closePromise
      closing = true
      closePromise = (async () => {
        await Promise.all([...active.values()].map(connection => connection.close('direct listener stopped')))
        await new Promise<void>(resolve => wsServer.close(() => resolve()))
        await new Promise<void>((resolve, reject) => httpsServer.close(error => error ? reject(error) : resolve()))
      })()
      return closePromise
    },
  }
  return listener
}
