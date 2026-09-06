import WebSocket, { type RawData } from 'ws'
import type { ServiceErrorCode } from '../control-protocol/agent-services.ts'

/** Network owns bytes and socket lifecycle; callers own the wire protocol. */
export interface WssFrame { readonly bytes: Buffer; readonly binary: boolean }
export interface WssConnectionOptions {
  readonly endpoint: string
  readonly credential: string
  readonly ca?: string | Buffer
  readonly connectTimeoutMs: number
  readonly maxMessageBytes: number
  readonly maxBufferedBytes: number
  readonly maxPendingFrames: number
}
export class WssConnectionError extends Error {
  constructor(readonly code: ServiceErrorCode, message: string, cause?: unknown) { super(message, { cause }) }
}
export interface WssConnection {
  /** Resolves on actual socket closure. Never interpreted as request completion. */
  readonly closed: Promise<WssConnectionError>
  read(): Promise<WssFrame>
  /** Completion means local transport write only, never peer execution. */
  send(frame: WssFrame): Promise<void>
  close(): Promise<void>
}

function failure(code: ServiceErrorCode, message: string, cause?: unknown): WssConnectionError {
  return new WssConnectionError(code, message, cause)
}

function validate(options: WssConnectionOptions): void {
  let url: URL
  try { url = new URL(options.endpoint) } catch { throw failure('INVALID_INPUT', 'network: invalid WSS endpoint') }
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash) {
    throw failure('INVALID_INPUT', 'network: endpoint requires WSS without URL credentials or fragment')
  }
  if (typeof options.credential !== 'string' || !options.credential || /[\r\n]/.test(options.credential)) {
    throw failure('INVALID_INPUT', 'network: a valid authorization credential is required')
  }
  for (const limit of [options.connectTimeoutMs, options.maxMessageBytes, options.maxBufferedBytes, options.maxPendingFrames]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw failure('INVALID_INPUT', 'network: limits must be positive safe integers')
  }
  if (options.connectTimeoutMs > 2_147_483_647) throw failure('INVALID_INPUT', 'network: connection timeout exceeds timer range')
}

function bytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
}

export async function connectWss(options: WssConnectionOptions, signal?: AbortSignal): Promise<WssConnection> {
  validate(options)
  if (signal?.aborted) throw failure('UNAVAILABLE', 'network: connection cancelled')
  // No insecure TLS override or redirect: credentials belong to this configured endpoint.
  const socket = new WebSocket(options.endpoint, {
    ca: options.ca,
    rejectUnauthorized: true,
    followRedirects: false,
    handshakeTimeout: options.connectTimeoutMs,
    maxPayload: options.maxMessageBytes,
    perMessageDeflate: false,
    headers: { authorization: options.credential },
  })
  const queue: WssFrame[] = []
  let queuedBytes = 0
  let terminal: WssConnectionError | undefined
  let reader: { resolve(frame: WssFrame): void; reject(error: WssConnectionError): void } | undefined
  let resolveClosed!: (error: WssConnectionError) => void
  const closed = new Promise<WssConnectionError>(resolve => { resolveClosed = resolve })
  const terminate = (error: WssConnectionError) => {
    if (!terminal) {
      terminal = error
      queue.length = 0
      queuedBytes = 0
      reader?.reject(error)
      reader = undefined
    }
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
  const abort = () => terminate(failure('UNAVAILABLE', 'network: connection cancelled'))
  // Attach all handlers before awaiting open; frames can arrive with the handshake.
  socket.on('message', (data, binary) => {
    if (terminal) return
    const frame = { bytes: bytes(data), binary }
    if (reader) {
      const pending = reader
      reader = undefined
      pending.resolve(frame)
      return
    }
    if (queue.length >= options.maxPendingFrames || frame.bytes.length > options.maxBufferedBytes - queuedBytes) {
      terminate(failure('RESOURCE_EXHAUSTED', 'network: receive buffer exhausted'))
      return
    }
    queuedBytes += frame.bytes.length
    queue.push(frame)
  })
  socket.on('error', error => terminate(failure('UNAVAILABLE', 'network: WSS connection failed', error)))
  socket.on('close', () => {
    signal?.removeEventListener('abort', abort)
    terminate(terminal ?? failure('UNAVAILABLE', 'network: WSS connection closed'))
    resolveClosed(terminal!)
  })
  const opened = new Promise<void>((resolve, reject) => {
    const opened = () => { socket.off('close', failed); socket.off('error', failed); resolve() }
    const failed = () => {
      socket.off('open', opened)
      socket.off('close', failed)
      socket.off('error', failed)
      reject(terminal ?? failure('UNAVAILABLE', 'network: WSS connection failed'))
    }
    socket.once('open', opened)
    socket.once('close', failed)
    socket.once('error', failed)
  })
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try { await opened } catch (error) { await closed; throw error }
  return {
    closed,
    read: async () => {
      if (terminal) throw terminal
      if (reader) throw failure('CONFLICT', 'network: only one frame reader is allowed')
      const frame = queue.shift()
      if (frame) { queuedBytes -= frame.bytes.length; return frame }
      return new Promise<WssFrame>((resolve, reject) => { reader = { resolve, reject } })
    },
    send: async frame => {
      if (terminal) throw terminal
      if (socket.readyState !== WebSocket.OPEN) throw failure('UNAVAILABLE', 'network: socket is not open')
      if (!Buffer.isBuffer(frame.bytes) || typeof frame.binary !== 'boolean') throw failure('INVALID_INPUT', 'network: invalid frame')
      if (frame.bytes.length > options.maxMessageBytes || frame.bytes.length > options.maxBufferedBytes - socket.bufferedAmount) {
        throw failure('RESOURCE_EXHAUSTED', 'network: send buffer exhausted')
      }
      await new Promise<void>((resolve, reject) => {
        socket.send(frame.bytes, { binary: frame.binary }, error => {
          if (!error) { resolve(); return }
          const failed = failure('UNAVAILABLE', 'network: frame write failed')
          terminate(failed)
          reject(failed)
        })
      })
    },
    close: async () => {
      terminate(failure('UNAVAILABLE', 'network: connection stopped locally'))
      await closed
    },
  }
}
