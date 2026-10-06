import { once as onceEvent } from 'node:events'
import { chmod, lstat, mkdir, stat } from 'node:fs/promises'
import { createServer, createConnection, type Socket, type Server } from 'node:net'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { assertEnvelopeKeys, assertJsonValue } from '../control-protocol/json-value.ts'
import type { JsonValue, ResourceDemand } from '../control-protocol/agent-services.ts'
import type { ProjectExecutionControl, ProjectExecutionReceipt } from './dagpipe/host.ts'

export type LocalWorkControlKind = 'work.submit' | 'work.query' | 'work.open' | 'work.request' | 'work.close'

interface LocalWorkControlBaseControl {
  readonly receiverAgentId: string
  readonly expectedLauncherGeneration: number
  readonly startToken: string
  readonly executionId: string
  readonly attemptId: string
  readonly workId: string
  readonly requestId: string
}

export interface LocalWorkSubmitControl extends LocalWorkControlBaseControl {}
export interface LocalWorkQueryEndpointControl extends LocalWorkControlBaseControl {
  readonly serviceSelection: 'endpoint'
}
export interface LocalWorkQueryCapabilityControl extends LocalWorkControlBaseControl {
  readonly serviceSelection: 'capability'
  readonly targetAgentId: string
  readonly targetGeneration: number
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly linkGeneration?: number
}
export interface LocalWorkOpenControl extends LocalWorkControlBaseControl {
  readonly targetAgentId: string
  readonly targetGeneration: number
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly demands: readonly ResourceDemand[]
  readonly policyRevision?: number
}
export interface LocalWorkRequestControl extends LocalWorkControlBaseControl {
  readonly targetAgentId: string
  readonly targetGeneration: number
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly demands: readonly ResourceDemand[]
}
export interface LocalWorkCloseControl extends LocalWorkControlBaseControl {
  readonly targetAgentId: string
  readonly targetGeneration: number
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
}

export type LocalWorkControlRequest =
  | { readonly kind: 'work.submit'; readonly requestId: string; readonly control: LocalWorkSubmitControl; readonly business: JsonValue }
  | { readonly kind: 'work.query'; readonly requestId: string; readonly control: LocalWorkQueryEndpointControl }
  | { readonly kind: 'work.query'; readonly requestId: string; readonly control: LocalWorkQueryCapabilityControl }
  | { readonly kind: 'work.open'; readonly requestId: string; readonly control: LocalWorkOpenControl; readonly business: JsonValue }
  | { readonly kind: 'work.request'; readonly requestId: string; readonly control: LocalWorkRequestControl; readonly business: JsonValue }
  | { readonly kind: 'work.close'; readonly requestId: string; readonly control: LocalWorkCloseControl }

export type LocalWorkControlReply =
  | { readonly kind: 'work.result'; readonly requestId: string; readonly receipt: ProjectExecutionReceipt }
  | { readonly kind: 'work.error'; readonly requestId: string; readonly error: { readonly code: string; readonly message: string } }

export type LocalWorkControlDelivery = 'written' | 'unconfirmed'

export type LocalWorkControlErrorCode = 'LOCAL_CONTROL_UNAVAILABLE' | 'HOST_PROTOCOL' | 'NOT_AUTHORIZED' | 'STALE_GENERATION' | 'RECEIVER_NOT_FOUND'

export class LocalWorkControlError extends Error {
  constructor(
    readonly code: LocalWorkControlErrorCode | string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LocalWorkControlError'
  }
}

/**
 * The binding a persistent Work frame already fixed. A failed or unconfirmed
 * receipt must carry it, so the caller can query or close the Work with the
 * original identity instead of rebuilding it from config or logs.
 */
export function localWorkFrameBinding(frame: LocalWorkControlRequest): Partial<ProjectExecutionControl> {
  if (frame.kind === 'work.submit') return {}
  if (frame.kind === 'work.query') {
    if (frame.control.serviceSelection !== 'capability') return { serviceSelection: 'endpoint' }
    const control = frame.control
    return {
      providerAgentId: control.targetAgentId,
      targetGeneration: control.targetGeneration,
      ...(control.linkGeneration === undefined ? {} : { linkGeneration: control.linkGeneration }),
      serviceSelection: 'capability',
      capabilityId: control.capabilityId,
      capabilityVersion: control.capabilityVersion,
      operation: control.operation,
    }
  }
  const control = frame.control
  return {
    providerAgentId: control.targetAgentId,
    targetGeneration: control.targetGeneration,
    capabilityId: control.capabilityId,
    capabilityVersion: control.capabilityVersion,
    operation: control.operation,
  }
}

/**
 * The single owner of the failed or unconfirmed Work receipt shape. The CLI
 * pre-dispatch refusal path and the receiver post-dispatch path both build it
 * from the frame they already hold, so the projectId literal, the generated
 * identity and the fixed binding projection cannot diverge between them.
 */
export function failedLocalWorkReceipt(
  frame: LocalWorkControlRequest,
  error: { readonly code: string; readonly message: string },
  deliveryState?: 'unconfirmed',
): ProjectExecutionReceipt {
  return {
    status: 'failed',
    control: {
      projectId: 'agentteams-local-work',
      graphId: '',
      graphVersion: '',
      executionId: frame.control.executionId,
      attemptId: frame.control.attemptId,
      workId: frame.control.workId,
      requestId: frame.control.requestId,
      ...localWorkFrameBinding(frame),
      ...(deliveryState === undefined ? {} : { deliveryState }),
      error,
    },
    cleanup: { channelsOpened: 0, channelsDisposed: 0 },
    evidence: { execution: 'failed', graphId: '', graphVersion: '', nodeSchedule: [], nodeCompletion: [], hostOperations: [] },
  }
}

export interface LocalWorkControlHandlerInput {
  readonly frame: LocalWorkControlRequest
  readonly peer: Duplex
  readonly disconnected: Promise<void>
  respond(reply: ProjectExecutionReceipt | { readonly code: string; readonly message: string }): Promise<LocalWorkControlDelivery>
}

export interface LocalWorkControlListenerOptions {
  readonly socketPath: string
  readonly launcherGeneration: number
  readonly startToken: string
  readonly receivers: Readonly<Record<string, boolean>>
  readonly handler: (input: LocalWorkControlHandlerInput) => Promise<ProjectExecutionReceipt | { readonly code: string; readonly message: string }>
}

export interface LocalWorkControlSendOptions {
  readonly socketPath: string
  readonly frame: LocalWorkControlRequest
  readonly timeoutMs?: number
}

export interface LocalWorkControlServer {
  readonly socketPath: string
  close(): Promise<void>
}

const REQUEST_KEYS: Record<LocalWorkControlKind, readonly string[]> = {
  'work.submit': ['kind', 'requestId', 'control', 'business'],
  'work.query': ['kind', 'requestId', 'control'],
  'work.open': ['kind', 'requestId', 'control', 'business'],
  'work.request': ['kind', 'requestId', 'control', 'business'],
  'work.close': ['kind', 'requestId', 'control'],
}

const CONTROL_KEYS: Record<LocalWorkControlKind, readonly string[]> = {
  'work.submit': ['receiverAgentId', 'expectedLauncherGeneration', 'startToken', 'executionId', 'attemptId', 'workId', 'requestId'],
  'work.query': ['serviceSelection', 'receiverAgentId', 'expectedLauncherGeneration', 'startToken', 'executionId', 'attemptId', 'workId', 'requestId', 'targetAgentId', 'targetGeneration', 'capabilityId', 'capabilityVersion', 'operation', 'linkGeneration'],
  'work.open': ['receiverAgentId', 'expectedLauncherGeneration', 'startToken', 'executionId', 'attemptId', 'workId', 'requestId', 'targetAgentId', 'targetGeneration', 'capabilityId', 'capabilityVersion', 'operation', 'demands', 'policyRevision'],
  'work.request': ['receiverAgentId', 'expectedLauncherGeneration', 'startToken', 'executionId', 'attemptId', 'workId', 'requestId', 'targetAgentId', 'targetGeneration', 'capabilityId', 'capabilityVersion', 'operation', 'demands'],
  'work.close': ['receiverAgentId', 'expectedLauncherGeneration', 'startToken', 'executionId', 'attemptId', 'workId', 'requestId', 'targetAgentId', 'targetGeneration', 'capabilityId', 'capabilityVersion', 'operation'],
}

const QUERY_ENDPOINT_CONTROL_KEYS = ['serviceSelection', 'receiverAgentId', 'expectedLauncherGeneration', 'startToken', 'executionId', 'attemptId', 'workId', 'requestId']
const QUERY_CAPABILITY_CONTROL_KEYS = [...QUERY_ENDPOINT_CONTROL_KEYS, 'targetAgentId', 'targetGeneration', 'capabilityId', 'capabilityVersion', 'operation', 'linkGeneration']

export function encodeLocalWorkControlFrame(frame: LocalWorkControlRequest | LocalWorkControlReply): string {
  return `${JSON.stringify(frame)}\n`
}

function protocol(message: string): LocalWorkControlError {
  return new LocalWorkControlError('HOST_PROTOCOL', message)
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocol(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) throw protocol(`${label} is required`)
  return plainObject(value, label)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw protocol(`${label} must be a non-empty string`)
  return value
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw protocol(`${label} must be a safe integer`)
  return value
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, label)
}

function baseControl(value: unknown, kind: LocalWorkControlKind): LocalWorkControlBaseControl {
  const control = requiredRecord(value, 'control')
  assertEnvelopeKeys(control, CONTROL_KEYS[kind], 'control')
  return {
    receiverAgentId: requiredString(control.receiverAgentId, 'control.receiverAgentId'),
    expectedLauncherGeneration: requiredInteger(control.expectedLauncherGeneration, 'control.expectedLauncherGeneration'),
    startToken: requiredString(control.startToken, 'control.startToken'),
    executionId: requiredString(control.executionId, 'control.executionId'),
    attemptId: requiredString(control.attemptId, 'control.attemptId'),
    workId: requiredString(control.workId, 'control.workId'),
    requestId: requiredString(control.requestId, 'control.requestId'),
  }
}

function durableBinding(control: Record<string, unknown>, kind: LocalWorkControlKind): Pick<LocalWorkOpenControl, 'targetAgentId' | 'targetGeneration' | 'capabilityId' | 'capabilityVersion' | 'operation'> {
  return {
    targetAgentId: requiredString(control.targetAgentId, 'control.targetAgentId'),
    targetGeneration: requiredInteger(control.targetGeneration, 'control.targetGeneration'),
    capabilityId: requiredString(control.capabilityId, 'control.capabilityId'),
    capabilityVersion: requiredString(control.capabilityVersion, 'control.capabilityVersion'),
    operation: requiredString(control.operation, 'control.operation'),
  }
}

function demands(value: unknown, label: string): readonly ResourceDemand[] {
  if (!Array.isArray(value)) throw protocol(`${label} must be an array`)
  return value.map((item, index) => {
    const demand = requiredRecord(item, `${label}[${index}]`)
    assertEnvelopeKeys(demand, ['resourceId', 'amount'], `${label}[${index}]`)
    const amount = requiredInteger(demand.amount, `${label}[${index}].amount`)
    if (amount < 1) throw protocol(`${label}[${index}].amount must be positive`)
    return {
      resourceId: requiredString(demand.resourceId, `${label}[${index}].resourceId`),
      amount,
    }
  })
}

export function decodeLocalWorkControlRequest(value: unknown): LocalWorkControlRequest {
  const frame = plainObject(value, 'request')
  const kind = frame.kind
  if (typeof kind !== 'string' || !Object.hasOwn(REQUEST_KEYS, kind)) throw protocol(`request.kind must be one of ${Object.keys(REQUEST_KEYS).join(', ')}`)
  const typedKind = kind as LocalWorkControlKind
  assertEnvelopeKeys(frame, REQUEST_KEYS[typedKind], 'request')
  const correlation = requiredString(frame.requestId, 'requestId')
  const frameControl = requiredRecord(frame.control, 'control')
  const base = baseControl(frameControl, typedKind)
  const withBusiness = typedKind === 'work.submit' || typedKind === 'work.open' || typedKind === 'work.request'

  if (typedKind === 'work.query') {
    const selection = frameControl.serviceSelection
    if (selection === 'endpoint') {
      assertEnvelopeKeys(frameControl, QUERY_ENDPOINT_CONTROL_KEYS, 'control')
      return { kind: typedKind, requestId: correlation, control: { ...base, serviceSelection: 'endpoint' } }
    }
    if (selection === 'capability') {
      assertEnvelopeKeys(frameControl, QUERY_CAPABILITY_CONTROL_KEYS, 'control')
      const linkGeneration = optionalInteger(frameControl.linkGeneration, 'control.linkGeneration')
      return {
        kind: typedKind,
        requestId: correlation,
        control: {
          ...base,
          serviceSelection: 'capability',
          ...durableBinding(frameControl, 'work.query'),
          ...(linkGeneration === undefined ? {} : { linkGeneration }),
        },
      }
    }
    throw protocol('control.serviceSelection must be endpoint or capability')
  }
  if (typedKind === 'work.open' || typedKind === 'work.request' || typedKind === 'work.close') {
    const result = {
      kind: typedKind,
      requestId: correlation,
      control: { ...base, ...durableBinding(frameControl, typedKind) },
    }
    if (typedKind === 'work.close') return result as LocalWorkControlRequest
    const execution = {
      ...result,
      kind: typedKind,
      control: { ...result.control, demands: demands(frameControl.demands, 'control.demands') },
    }
    if (typedKind === 'work.open') {
      const policyRevision = optionalInteger(frameControl.policyRevision, 'control.policyRevision')
      if (policyRevision !== undefined) Object.assign(execution.control, { policyRevision })
    }
    assertJsonValue(frame.business, 'business')
    return { ...execution, business: frame.business }
  }
  if (withBusiness) assertJsonValue(frame.business, 'business')
  if (frame.business === undefined) throw protocol('business is required')
  assertJsonValue(frame.business, 'business')
  return { kind: 'work.submit', requestId: correlation, control: base, business: frame.business }
}

export function decodeLocalWorkControlReply(value: unknown, expectedRequestId: string): LocalWorkControlReply {
  const frame = plainObject(value, 'reply')
  const requestId = requiredString(frame.requestId, 'requestId')
  if (requestId !== expectedRequestId) throw protocol('reply requestId must match the request correlation')
  const kind = frame.kind
  if (kind === 'work.result') {
    assertEnvelopeKeys(frame, ['kind', 'requestId', 'receipt'], 'reply')
    assertJsonValue(frame.receipt, 'receipt')
    return { kind, requestId, receipt: frame.receipt as unknown as ProjectExecutionReceipt }
  }
  if (kind === 'work.error') {
    assertEnvelopeKeys(frame, ['kind', 'requestId', 'error'], 'reply')
    const error = plainObject(frame.error, 'error')
    assertEnvelopeKeys(error, ['code', 'message'], 'error')
    return { kind, requestId, error: { code: requiredString(error.code, 'error.code'), message: requiredString(error.message, 'error.message') } }
  }
  throw protocol('reply.kind must be work.result or work.error')
}

async function prepareSocketDirectory(path: string): Promise<void> {
  const directory = dirname(path)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const existing = await stat(directory)
    if (!existing.isDirectory()) throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', 'socket parent path is not a directory')
    await chmod(directory, 0o700)
    return
  } catch (cause) {
    if (cause instanceof LocalWorkControlError) throw cause
    throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', `cannot prepare local Work socket directory: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

function disconnected(peer: Duplex): Promise<void> {
  if (peer.destroyed) return Promise.resolve()
  return onceEvent(peer, 'close').then(() => undefined)
}

export async function startLocalWorkControlListener(options: LocalWorkControlListenerOptions): Promise<LocalWorkControlServer> {
  if (!Number.isSafeInteger(options.launcherGeneration) || options.launcherGeneration < 0) {
    throw protocol('launcherGeneration must be a non-negative safe integer')
  }
  if (typeof options.startToken !== 'string' || options.startToken.length === 0) {
    throw protocol('startToken must be a non-empty string')
  }
  await prepareSocketDirectory(options.socketPath)
  try {
    const existing = await lstat(options.socketPath)
    throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', `local Work socket already exists: ${options.socketPath}`, { cause: undefined })
  } catch (cause) {
    if (cause instanceof LocalWorkControlError) throw cause
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', `local Work socket path cannot be inspected: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }

  const accepted = new Set<Promise<void>>()
  const idle = new Set<Socket>()
  let closing = false
  let dispatchFailure: unknown
  const server = createServer((peer: Socket) => {
    if (closing) {
      peer.destroy()
      return
    }
    idle.add(peer)
    const handling = handleConnection(peer, options, () => {
      if (closing) throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', 'local Work listener is closing')
      idle.delete(peer)
    })
    accepted.add(handling)
    void handling.then(
      () => { accepted.delete(handling); idle.delete(peer) },
      cause => {
        accepted.delete(handling)
        idle.delete(peer)
        dispatchFailure ??= cause
      },
    )
  })
  server.unref()
  const opened = new Promise<void>((resolveOpen, rejectOpen) => {
    const onListening = () => {
      server.removeListener('error', onError)
      resolveOpen()
    }
    const onError = (cause: Error) => {
      server.removeListener('listening', onListening)
      rejectOpen(cause)
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(options.socketPath)
  })

  try {
    await opened
    const existing = await lstat(options.socketPath)
    if (!existing.isSocket()) throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', 'local Work socket path is not a socket')
    await chmod(options.socketPath, 0o600)
  } catch (cause) {
    try {
      await new Promise<void>((resolveClosed, rejectClosed) => {
        if (!server.listening) {
          resolveClosed()
          return
        }
        server.close(closeError => closeError === undefined ? resolveClosed() : rejectClosed(closeError))
      })
    } catch (cleanupCause) {
      throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', 'local Work socket startup and cleanup failed', {
        cause: new AggregateError([cause, cleanupCause], 'startup and cleanup causes'),
      })
    }
    throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', `cannot listen local Work socket: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }

  return {
    socketPath: options.socketPath,
    async close() {
      closing = true
      const closed = closeServer(server, accepted)
      for (const peer of idle) peer.destroy()
      await closed
      if (dispatchFailure !== undefined) throw dispatchFailure
    },
  }
}

async function closeServer(server: Server, accepted?: Set<Promise<void>>): Promise<void> {
  const closed = new Promise<void>((resolveClosed, rejectClosed) => {
    server.close(closeError => closeError === undefined ? resolveClosed() : rejectClosed(closeError))
  })
  const settled = await Promise.allSettled([
    closed,
    ...(accepted === undefined ? [] : [...accepted]),
  ])
  if (settled[0]?.status === 'rejected') throw settled[0].reason
  const failedDispatch = settled.slice(1).find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failedDispatch !== undefined) throw failedDispatch.reason
}

function receiveLine(peer: Socket): Promise<string | undefined> {
  return new Promise((resolveLine, rejectLine) => {
    let buffered = ''
    const cleanup = () => {
      peer.removeListener('data', onData)
      peer.removeListener('end', onEnd)
      peer.removeListener('close', onEnd)
      peer.removeListener('error', onError)
    }
    const onData = (data: string | Buffer) => {
      buffered += data.toString('utf8')
      const index = buffered.indexOf('\n')
      if (index < 0) return
      cleanup()
      resolveLine(buffered.slice(0, index))
    }
    const onEnd = () => { cleanup(); resolveLine(undefined) }
    const onError = (cause: Error) => { cleanup(); rejectLine(cause) }
    peer.on('data', onData)
    peer.once('end', onEnd)
    peer.once('close', onEnd)
    peer.once('error', onError)
  })
}

async function handleConnection(peer: Socket, options: LocalWorkControlListenerOptions, admit: () => void): Promise<void> {
  peer.setEncoding('utf8')
  let correlation = 'unknown'
  try {
    const line = await receiveLine(peer)
    if (line === undefined) return

    let decoded: LocalWorkControlRequest
    try {
      decoded = decodeLocalWorkControlRequest(JSON.parse(line))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'invalid Work request'
      await sendReply(peer, { kind: 'work.error', requestId: 'unknown', error: { code: 'HOST_PROTOCOL', message } })
      return
    }
    correlation = decoded.requestId

    if (decoded.control.startToken !== options.startToken) {
      await sendReply(peer, error('NOT_AUTHORIZED', 'Work start token does not match the current launcher', decoded.requestId))
      return
    }
    if (decoded.control.expectedLauncherGeneration !== options.launcherGeneration) {
      await sendReply(peer, error('STALE_GENERATION', 'Work request targets a stale launcher generation', decoded.requestId))
      return
    }
    if (options.receivers[decoded.control.receiverAgentId] !== true) {
      await sendReply(peer, error('RECEIVER_NOT_FOUND', `Work receiver ${decoded.control.receiverAgentId} is not available`, decoded.requestId))
      return
    }

    admit()
    await options.handler({
      frame: decoded,
      peer,
      disconnected: disconnected(peer),
      respond: async result => {
        const reply: LocalWorkControlReply = 'status' in result
          ? { kind: 'work.result', requestId: decoded.requestId, receipt: result }
          : error(result.code, result.message, decoded.requestId)
        return sendReply(peer, reply)
      },
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'local Work control handler failed'
    try {
      await sendReply(peer, error('HOST_PROTOCOL', message, correlation))
    } catch (sendCause) {
      throw new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', `local Work control reply failed: ${sendCause instanceof Error ? sendCause.message : String(sendCause)}`, { cause })
    }
    throw new LocalWorkControlError('HOST_PROTOCOL', message, { cause })
  } finally {
    peer.destroy()
  }
}

function error(code: string, message: string, requestId = 'unknown'): LocalWorkControlReply {
  return { kind: 'work.error', requestId, error: { code, message } }
}

async function sendReply(peer: Duplex, reply: LocalWorkControlReply): Promise<LocalWorkControlDelivery> {
  if (!peer.writable || peer.destroyed) return 'unconfirmed'
  await new Promise<void>((resolveWrite, rejectWrite) => {
    peer.write(encodeLocalWorkControlFrame(reply), (writeError: Error | null | undefined) => writeError ? rejectWrite(writeError) : resolveWrite())
  })
  return 'written'
}

export async function sendLocalWorkControlRequest(options: LocalWorkControlSendOptions): Promise<LocalWorkControlReply> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw protocol('timeoutMs must be a positive integer')
  const frame = decodeLocalWorkControlRequest(options.frame)
  const socket = createConnection({ path: options.socketPath })
  socket.setEncoding('utf8')

  const result = new Promise<LocalWorkControlReply>((resolve, reject) => {
    let buffered = ''
    let settled = false
    const fail = (cause: unknown) => {
      if (settled) return
      settled = true
      reject(cause instanceof LocalWorkControlError ? cause : new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', `local Work control socket is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }))
    }

    socket.once('error', fail)
    socket.once('timeout', () => fail(new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', 'local Work control request timed out')))
    socket.once('close', () => {
      if (buffered.trim()) {
        const text = buffered.trim()
        const index = text.indexOf('\n')
        try {
          resolve(decodeLocalWorkControlReply(JSON.parse(index >= 0 ? text.slice(0, index) : text), frame.requestId))
          return
        } catch (cause) {
          fail(cause)
          return
        }
      }
      if (!settled) fail(new LocalWorkControlError('LOCAL_CONTROL_UNAVAILABLE', 'local Work control socket closed before reply'))
    })
    socket.on('data', chunk => {
      buffered += chunk.toString('utf8')
      const index = buffered.indexOf('\n')
      if (index < 0) return
      const text = buffered.slice(0, index)
      try {
        resolve(decodeLocalWorkControlReply(JSON.parse(text), frame.requestId))
        settled = true
      } catch (cause) {
        fail(cause)
      }
    })
    socket.once('connect', () => {
      socket.write(encodeLocalWorkControlFrame(frame), writeError => {
        if (writeError) fail(writeError)
      })
    })
  }).finally(() => {
    socket.setTimeout(0)
    socket.destroy()
  })

  socket.setTimeout(timeoutMs)
  return result
}
