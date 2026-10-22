import { chmod, lstat, mkdir, stat, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import type { ServiceError, ServiceErrorCode } from '../control-protocol/agent-services.ts'
import {
  parseGroupWireReply,
  parseGroupWireRequest,
  type GroupWireReply,
  type GroupWireRequest,
} from '../control-protocol/group-wire.ts'

/**
 * Local CLI -> daemon group messaging socket.
 *
 * One newline-delimited JSON request per connection, one reply, then the server
 * closes that peer. The server follows the local Work socket pattern: a private
 * Unix socket mode 0600, an injected handler, typed relay.error failures, and
 * removal of the socket file this listener owns on close. It serves the local
 * user only and adds no second authentication layer.
 */

export type LocalMessageSocketHandler = (request: GroupWireRequest) => GroupWireReply | Promise<GroupWireReply>

export interface LocalMessageSocketOptions {
  readonly socketPath: string
  readonly handler: LocalMessageSocketHandler
  /** Maximum UTF-8 line size. A larger frame receives relay.error INVALID_INPUT. */
  readonly maxFrameBytes?: number
}

export interface LocalMessageSocketServer {
  readonly socketPath: string
  close(): Promise<void>
}

export interface LocalMessageRequestOptions {
  readonly socketPath: string
  readonly request: GroupWireRequest
  readonly timeoutMs?: number
}

export class LocalMessageSocketError extends Error {
  readonly code: ServiceErrorCode

  constructor(readonly serviceError: ServiceError, options?: ErrorOptions) {
    super(serviceError.message, options)
    this.name = 'LocalMessageSocketError'
    this.code = serviceError.code
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_FRAME_BYTES = 1_048_576
const PROBE_TIMEOUT_MS = 250

const serviceErrorCodes: readonly ServiceErrorCode[] = [
  'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATION', 'STALE_GENERATION', 'REVISION_CONFLICT', 'RESOURCE_EXHAUSTED',
  'CONFLICT', 'RESULT_UNKNOWN', 'UNAVAILABLE', 'UPSTREAM_ERROR',
]

function isServiceErrorCode(value: unknown): value is ServiceErrorCode {
  return typeof value === 'string' && (serviceErrorCodes as readonly string[]).includes(value)
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function errorOf(cause: unknown, fallback: ServiceErrorCode): ServiceError {
  if (cause instanceof LocalMessageSocketError) return cause.serviceError
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code
    return { code: isServiceErrorCode(code) ? code : fallback, message: cause.message }
  }
  return { code: fallback, message: String(cause) }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new LocalMessageSocketError({ code: 'INVALID_INPUT', message: `local group message: ${label} must be a positive safe integer` })
  }
}

export function encodeLocalMessageFrame(frame: GroupWireRequest | GroupWireReply): string {
  return `${JSON.stringify(frame)}\n`
}

async function prepareSocketDirectory(socketPath: string): Promise<void> {
  try {
    const directory = dirname(socketPath)
    const created = await mkdir(directory, { recursive: true, mode: 0o700 })
    const existing = await stat(directory)
    if (!existing.isDirectory()) {
      throw new LocalMessageSocketError({ code: 'UNAVAILABLE', message: 'local group message socket parent is not a directory' })
    }
    if (created !== undefined) await chmod(directory, 0o700)
  } catch (cause) {
    if (cause instanceof LocalMessageSocketError) throw cause
    throw new LocalMessageSocketError({
      code: 'UNAVAILABLE',
      message: `cannot prepare local group message socket directory: ${messageOf(cause)}`,
    }, { cause })
  }
}

/** Distinguishes a stale owned socket left by a crash from a live daemon. */
async function probeSocket(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe, rejectProbe) => {
    const socket = createConnection(path)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (live: boolean, cause?: unknown): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      socket.destroy()
      if (cause === undefined) resolveProbe(live)
      else rejectProbe(cause)
    }
    timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS)
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', cause => {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') finish(false)
      else finish(true, new LocalMessageSocketError({
        code: 'UNAVAILABLE',
        message: `cannot probe the existing local group message socket: ${messageOf(cause)}`,
      }, { cause }))
    })
  })
}

async function requireOwnSocketPath(socketPath: string): Promise<void> {
  let existing
  try {
    existing = await lstat(socketPath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new LocalMessageSocketError({
      code: 'UNAVAILABLE',
      message: `cannot inspect the local group message socket path: ${messageOf(cause)}`,
    }, { cause })
  }
  if (!existing.isSocket()) {
    throw new LocalMessageSocketError({
      code: 'CONFLICT',
      message: `local group message socket path exists and is not a socket: ${socketPath}`,
    })
  }
  if (await probeSocket(socketPath)) {
    throw new LocalMessageSocketError({
      code: 'CONFLICT',
      message: `another local group message server is already listening: ${socketPath}`,
    })
  }
  try {
    await unlink(socketPath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LocalMessageSocketError({
        code: 'UNAVAILABLE',
        message: `cannot remove the stale local group message socket: ${messageOf(cause)}`,
      }, { cause })
    }
  }
}

interface SocketIdentity {
  readonly dev: number
  readonly ino: number
}

async function removeOwnSocket(socketPath: string, identity?: SocketIdentity): Promise<void> {
  try {
    const existing = await lstat(socketPath)
    if (!existing.isSocket()) return
    if (identity !== undefined && (existing.dev !== identity.dev || existing.ino !== identity.ino)) return
    await unlink(socketPath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new LocalMessageSocketError({
      code: 'UNAVAILABLE',
      message: `cannot remove the local group message socket: ${messageOf(cause)}`,
    }, { cause })
  }
}

async function closeServer(server: Server, peers: Set<Socket>, accepted: Set<Promise<void>>): Promise<void> {
  const closed = server.listening
    ? new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error === undefined ? resolveClose() : rejectClose(error))
    })
    : Promise.resolve()
  for (const peer of peers) peer.destroy()
  const settled = await Promise.allSettled([closed, ...accepted])
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed !== undefined) throw failed.reason
}

export async function startLocalMessageSocket(options: LocalMessageSocketOptions): Promise<LocalMessageSocketServer> {
  if (typeof options.socketPath !== 'string' || options.socketPath.length === 0) {
    throw new LocalMessageSocketError({ code: 'INVALID_INPUT', message: 'local group message: socketPath must be a non-empty string' })
  }
  if (typeof options.handler !== 'function') {
    throw new LocalMessageSocketError({ code: 'INVALID_INPUT', message: 'local group message: handler must be a function' })
  }
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  positiveInteger(maxFrameBytes, 'maxFrameBytes')

  await prepareSocketDirectory(options.socketPath)
  await requireOwnSocketPath(options.socketPath)

  const peers = new Set<Socket>()
  const accepted = new Set<Promise<void>>()
  let closing = false
  let failure: unknown
  const server = createServer((peer: Socket) => {
    if (closing) {
      peer.destroy()
      return
    }
    peers.add(peer)
    const handling = handleConnection(peer, options.handler, maxFrameBytes)
    accepted.add(handling)
    void handling.then(
      () => {
        accepted.delete(handling)
        peers.delete(peer)
      },
      cause => {
        accepted.delete(handling)
        peers.delete(peer)
        failure ??= cause
      },
    )
  })
  server.unref()

  const opened = new Promise<void>((resolveOpen, rejectOpen) => {
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolveOpen()
    }
    const onError = (cause: Error): void => {
      server.removeListener('listening', onListening)
      rejectOpen(cause)
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(options.socketPath)
  })

  let bound = false
  let identity: SocketIdentity | undefined
  try {
    await opened
    bound = true
    server.on('error', cause => { failure ??= cause })
    const existing = await lstat(options.socketPath)
    if (!existing.isSocket()) {
      throw new LocalMessageSocketError({
        code: 'UNAVAILABLE',
        message: 'local group message path is not a socket after listen',
      })
    }
    await chmod(options.socketPath, 0o600)
    identity = { dev: existing.dev, ino: existing.ino }
  } catch (cause) {
    await closeServer(server, peers, accepted).catch(() => undefined)
    if (bound) await removeOwnSocket(options.socketPath, identity).catch(() => undefined)
    if (cause instanceof LocalMessageSocketError) throw cause
    throw new LocalMessageSocketError({
      code: 'UNAVAILABLE',
      message: `cannot listen on the local group message socket: ${messageOf(cause)}`,
    }, { cause })
  }

  let closePromise: Promise<void> | undefined

  return {
    socketPath: options.socketPath,
    close: () => {
      if (closePromise !== undefined) return closePromise
      closing = true
      const closed = closeServer(server, peers, accepted)
      closePromise = (async () => {
        await closed
        await removeOwnSocket(options.socketPath, identity)
        if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure))
      })()
      return closePromise
    },
  }
}

function receiveLine(peer: Socket, maxFrameBytes: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolveLine, rejectLine) => {
    let buffered = ''
    let settled = false
    const cleanup = (): void => {
      peer.removeListener('data', onData)
      peer.removeListener('end', onEnd)
      peer.removeListener('close', onEnd)
      peer.removeListener('error', onError)
    }
    const finish = (line?: string, cause?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (cause !== undefined) rejectLine(cause)
      else resolveLine(line)
    }
    const tooLarge = (): LocalMessageSocketError => new LocalMessageSocketError({
      code: 'INVALID_INPUT',
      message: `local group message frame exceeds ${maxFrameBytes} bytes`,
    })
    const onData = (chunk: string | Buffer): void => {
      buffered += chunk.toString('utf8')
      const index = buffered.indexOf('\n')
      if (index >= 0) {
        const line = buffered.slice(0, index)
        if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) finish(undefined, tooLarge())
        else finish(line)
        return
      }
      if (Buffer.byteLength(buffered, 'utf8') > maxFrameBytes) finish(undefined, tooLarge())
    }
    const onEnd = (): void => finish(undefined)
    const onError = (cause: Error): void => finish(undefined, cause)
    peer.on('data', onData)
    peer.once('end', onEnd)
    peer.once('close', onEnd)
    peer.once('error', onError)
  })
}

type InboundFrame =
  | { readonly request: GroupWireRequest }
  | { readonly error: ServiceError; readonly requestId?: string }

function extractRequestId(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const requestId = (parsed as { readonly requestId?: unknown }).requestId
    return typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined
  } catch {
    return undefined
  }
}

function decodeInbound(line: string): InboundFrame {
  try {
    return { request: parseGroupWireRequest(line) }
  } catch (cause) {
    const requestId = extractRequestId(line)
    return {
      error: { code: 'INVALID_INPUT', message: `local group message frame is invalid: ${messageOf(cause)}` },
      ...(requestId === undefined ? {} : { requestId }),
    }
  }
}

function assertCorrelatedReply(reply: GroupWireReply, requestId: string): void {
  if (reply.kind === 'relay.error') {
    if (reply.requestId !== undefined && reply.requestId !== requestId) {
      throw new LocalMessageSocketError({
        code: 'UPSTREAM_ERROR',
        message: 'local group message handler changed the reply correlation',
      })
    }
    return
  }
  if (!('requestId' in reply) || reply.requestId !== requestId) {
    throw new LocalMessageSocketError({
      code: 'UPSTREAM_ERROR',
      message: 'local group message handler reply must answer its request',
    })
  }
}

function encodeValidatedReply(reply: GroupWireReply): string {
  const text = encodeLocalMessageFrame(reply)
  try {
    parseGroupWireReply(text)
  } catch (cause) {
    throw new LocalMessageSocketError({
      code: 'UPSTREAM_ERROR',
      message: `local group message reply is invalid: ${messageOf(cause)}`,
    }, { cause })
  }
  return text
}

async function writeFrame(peer: Duplex, text: string): Promise<void> {
  if (!peer.writable || peer.destroyed) return
  await new Promise<void>((resolveWrite, rejectWrite) => {
    peer.write(text, error => {
      if (error) rejectWrite(error)
      else resolveWrite()
    })
  })
}

async function writeError(peer: Duplex, error: ServiceError, requestId?: string): Promise<void> {
  const reply: GroupWireReply = {
    kind: 'relay.error',
    ...(requestId === undefined ? {} : { requestId }),
    error,
  }
  await writeFrame(peer, encodeValidatedReply(reply))
}

async function handleConnection(peer: Socket, handler: LocalMessageSocketHandler, maxFrameBytes: number): Promise<void> {
  peer.setEncoding('utf8')
  let requestId: string | undefined
  try {
    const line = await receiveLine(peer, maxFrameBytes)
    if (line === undefined) return
    const inbound = decodeInbound(line)
    if ('error' in inbound) {
      await writeError(peer, inbound.error, inbound.requestId)
      return
    }
    requestId = inbound.request.requestId
    let reply: GroupWireReply
    try {
      reply = await handler(inbound.request)
      assertCorrelatedReply(reply, requestId)
    } catch (cause) {
      await writeError(peer, errorOf(cause, 'UPSTREAM_ERROR'), requestId)
      return
    }
    await writeFrame(peer, encodeValidatedReply(reply))
  } catch (cause) {
    try {
      await writeError(peer, errorOf(cause, 'UNAVAILABLE'), requestId)
    } catch {
      // The peer is already gone; the finally block still runs.
    }
  } finally {
    peer.destroy()
  }
}

export async function sendLocalMessageRequest(options: LocalMessageRequestOptions): Promise<GroupWireReply> {
  if (typeof options.socketPath !== 'string' || options.socketPath.length === 0) {
    throw new LocalMessageSocketError({ code: 'INVALID_INPUT', message: 'local group message: socketPath must be a non-empty string' })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  positiveInteger(timeoutMs, 'timeoutMs')

  let request: GroupWireRequest
  try {
    const text = JSON.stringify(options.request)
    if (typeof text !== 'string') throw new Error('request must be JSON serializable')
    request = parseGroupWireRequest(text)
  } catch (cause) {
    throw new LocalMessageSocketError({
      code: 'INVALID_INPUT',
      message: `local group message request is invalid: ${messageOf(cause)}`,
    }, { cause })
  }

  const socket = createConnection({ path: options.socketPath })
  socket.setEncoding('utf8')
  const result = new Promise<GroupWireReply>((resolveReply, rejectReply) => {
    let buffered = ''
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      settle()
    }
    const fail = (cause: LocalMessageSocketError): void => finish(() => rejectReply(cause))
    const consume = (line: string): void => {
      let reply: GroupWireReply
      try {
        reply = parseGroupWireReply(line)
      } catch (cause) {
        fail(new LocalMessageSocketError({
          code: 'INVALID_INPUT',
          message: `local group message reply is invalid: ${messageOf(cause)}`,
        }, { cause }))
        return
      }
      if (reply.kind === 'relay.error') {
        if (reply.requestId !== undefined && reply.requestId !== request.requestId) {
          fail(new LocalMessageSocketError({
            code: 'INVALID_INPUT',
            message: 'local group message reply requestId does not match the request',
          }))
          return
        }
        finish(() => rejectReply(new LocalMessageSocketError(reply.error)))
        return
      }
      if (!('requestId' in reply) || reply.requestId !== request.requestId) {
        fail(new LocalMessageSocketError({
          code: 'INVALID_INPUT',
          message: 'local group message reply must answer the request',
        }))
        return
      }
      finish(() => resolveReply(reply))
    }

    socket.once('error', cause => fail(new LocalMessageSocketError({
      code: 'UNAVAILABLE',
      message: `local group message socket is unavailable: ${messageOf(cause)}`,
    }, { cause })))
    socket.once('timeout', () => fail(new LocalMessageSocketError({
      code: 'RESULT_UNKNOWN',
      message: 'local group message request timed out; result is unknown, do not replay',
    })))
    socket.once('close', () => {
      if (settled) return
      if (buffered.trim().length === 0) {
        fail(new LocalMessageSocketError({ code: 'UNAVAILABLE', message: 'local group message socket closed before a reply' }))
        return
      }
      const index = buffered.indexOf('\n')
      consume(index >= 0 ? buffered.slice(0, index) : buffered)
    })
    socket.on('data', (chunk: string | Buffer) => {
      if (settled) return
      buffered += chunk.toString('utf8')
      const index = buffered.indexOf('\n')
      if (index < 0) return
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      consume(line)
    })
    socket.once('connect', () => {
      socket.write(encodeLocalMessageFrame(request), error => {
        if (error) fail(new LocalMessageSocketError({
          code: 'UNAVAILABLE',
          message: `local group message write failed: ${messageOf(error)}`,
        }, { cause: error }))
      })
    })
  }).finally(() => {
    socket.setTimeout(0)
    socket.destroy()
  })

  socket.setTimeout(timeoutMs)
  return await result
}
