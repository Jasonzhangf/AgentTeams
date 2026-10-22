import type { ServiceError, ServiceErrorCode } from '../control-protocol/agent-services.ts'
import {
  parseGroupWireReply,
  parseGroupWireRequest,
  type GroupWireReply,
  type GroupWireRequest,
} from '../control-protocol/group-wire.ts'

/**
 * Client-side group request/reply channel.
 *
 * The transport is injected because this channel runs on the registration
 * client's existing Relay connection. It never opens a socket of its own. The
 * registration owner feeds inbound group frames to `onMessage`, reports a
 * dropped connection through `disconnect`, and reports the same client online
 * again through `reconnected`; the latter runs the resubscribe hook.
 */

export interface GroupChannelTransport {
  /** Sends one JSON text frame on the already established registration connection. */
  readonly send: (text: string) => void | Promise<void>
  /** Registers the inbound frame handler on that same connection. Returns a detach function. */
  readonly onMessage: (handler: (text: string) => void) => () => void
}

export type GroupChannelRequester = (frame: GroupWireRequest) => Promise<GroupWireReply>

/** Server pushes: frames not correlated to a requestId. */
export type GroupChannelPush = Extract<GroupWireReply, {
  kind: 'group.changed' | 'message.received' | 'issue.changed' | 'action.changed' | 'op.execute'
}>

export type GroupChannelState = 'open' | 'disconnected' | 'closed'

export interface GroupChannelStatus {
  readonly state: GroupChannelState
  readonly pending: number
  readonly lastError?: ServiceError
}

export interface GroupChannelOptions {
  readonly transport: GroupChannelTransport
  readonly timeoutMs: number
  readonly maxPendingRequests: number
  /**
   * Rebuilds server-side subscriptions after the registration connection
   * recovers. It runs only on a disconnected -> open transition and receives
   * this channel's request function. It never opens a connection.
   */
  readonly resubscribe?: (request: GroupChannelRequester) => void | Promise<void>
  /** Uncorrelated relay errors and malformed inbound frames. Never turns one into a success. */
  readonly onError?: (error: ServiceError) => void
}

export interface GroupChannel {
  status(): GroupChannelStatus
  /** Resolves with the correlated reply, or rejects with a typed group channel error. */
  request(frame: GroupWireRequest): Promise<GroupWireReply>
  /** Subscribes to server pushes. Returns a detach function. */
  subscribe(listener: (push: GroupChannelPush) => void): () => void
  /** The registration owner reports that its live connection dropped. */
  disconnect(error?: ServiceError): void
  /** The registration owner reports the same client online again; runs resubscribe once. */
  reconnected(): Promise<void>
  /** Detaches from the shared connection; it does not close the registration client. */
  close(error?: ServiceError): void
}

export class GroupChannelError extends Error {
  readonly code: ServiceErrorCode
  readonly serviceError: ServiceError

  constructor(serviceError: ServiceError, options?: ErrorOptions) {
    super(serviceError.message, options)
    this.name = 'GroupChannelError'
    this.code = serviceError.code
    this.serviceError = serviceError
  }
}

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

function serviceErrorOf(cause: unknown, fallback: ServiceErrorCode): ServiceError {
  if (cause instanceof GroupChannelError) return cause.serviceError
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code
    return { code: isServiceErrorCode(code) ? code : fallback, message: cause.message }
  }
  return { code: fallback, message: String(cause) }
}

function validateOptions(options: GroupChannelOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
    throw new GroupChannelError({ code: 'INVALID_INPUT', message: 'group channel: timeoutMs must be a positive safe integer' })
  }
  if (!Number.isSafeInteger(options.maxPendingRequests) || options.maxPendingRequests < 1) {
    throw new GroupChannelError({ code: 'INVALID_INPUT', message: 'group channel: maxPendingRequests must be a positive safe integer' })
  }
  if (typeof options.transport.send !== 'function' || typeof options.transport.onMessage !== 'function') {
    throw new GroupChannelError({ code: 'INVALID_INPUT', message: 'group channel: transport send and onMessage are required' })
  }
}

function isPush(reply: GroupWireReply): reply is GroupChannelPush {
  return reply.kind === 'group.changed' || reply.kind === 'message.received' ||
    reply.kind === 'issue.changed' || reply.kind === 'action.changed' || reply.kind === 'op.execute'
}

interface PendingRequest {
  readonly resolve: (reply: GroupWireReply) => void
  readonly reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export function createGroupChannel(options: GroupChannelOptions): GroupChannel {
  validateOptions(options)
  const pending = new Map<string, PendingRequest>()
  const listeners = new Set<(push: GroupChannelPush) => void>()
  let state: GroupChannelState = 'open'
  let lastError: ServiceError | undefined
  let detachTransport: (() => void) | undefined

  const report = (error: ServiceError): void => {
    lastError = error
    try {
      options.onError?.(error)
    } catch {
      // An observer must not break the shared registration pump.
    }
  }

  const rejectAll = (error: ServiceError): void => {
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer)
      request.reject(new GroupChannelError(error))
    }
    pending.clear()
  }

  const disconnect = (error: ServiceError = { code: 'UNAVAILABLE', message: 'group channel is disconnected' }): void => {
    if (state === 'closed') return
    state = 'disconnected'
    lastError = error
    rejectAll(error)
  }

  const close = (error: ServiceError = { code: 'UNAVAILABLE', message: 'group channel is closed' }): void => {
    if (state === 'closed') return
    state = 'closed'
    lastError = error
    rejectAll(error)
    detachTransport?.()
    detachTransport = undefined
  }

  const onText = (text: string): void => {
    if (state !== 'open') return
    let reply: GroupWireReply
    try {
      reply = parseGroupWireReply(text)
    } catch (cause) {
      report({ code: 'INVALID_INPUT', message: `group channel rejected an inbound frame: ${messageOf(cause)}` })
      return
    }

    if (reply.kind === 'relay.error') {
      if (reply.requestId !== undefined) {
        const request = pending.get(reply.requestId)
        if (request !== undefined) {
          if (request.timer !== undefined) clearTimeout(request.timer)
          pending.delete(reply.requestId)
          request.reject(new GroupChannelError(reply.error))
          return
        }
      }
      // A late error for a timed-out request has no waiter left. Keep it
      // observable instead of resolving any request with a success.
      report(reply.error)
      return
    }

    if (isPush(reply)) {
      for (const listener of [...listeners]) {
        try {
          listener(reply)
        } catch (cause) {
          report({ code: 'UPSTREAM_ERROR', message: `group channel push listener failed: ${messageOf(cause)}` })
        }
      }
      return
    }

    const request = pending.get(reply.requestId)
    // A reply with no pending request is a late answer after a timeout. Never
    // attribute it to a different request.
    if (request === undefined) return
    if (request.timer !== undefined) clearTimeout(request.timer)
    pending.delete(reply.requestId)
    request.resolve(reply)
  }

  const request = async (frame: GroupWireRequest): Promise<GroupWireReply> => {
    if (state === 'closed') throw new GroupChannelError({ code: 'UNAVAILABLE', message: 'group channel is closed' })
    if (state === 'disconnected') throw new GroupChannelError(lastError ?? { code: 'UNAVAILABLE', message: 'group channel is disconnected' })

    let validated: GroupWireRequest
    try {
      const text = JSON.stringify(frame)
      if (typeof text !== 'string') throw new Error('group request must be JSON serializable')
      validated = parseGroupWireRequest(text)
    } catch (cause) {
      throw new GroupChannelError({ code: 'INVALID_INPUT', message: `group channel rejected an outbound request: ${messageOf(cause)}` }, { cause })
    }

    const requestId = validated.requestId
    if (pending.has(requestId)) {
      throw new GroupChannelError({ code: 'CONFLICT', message: `group request ${requestId} is already pending` })
    }
    if (pending.size >= options.maxPendingRequests) {
      throw new GroupChannelError({ code: 'RESOURCE_EXHAUSTED', message: 'group channel pending request capacity exhausted' })
    }

    return await new Promise<GroupWireReply>((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject }
      pending.set(requestId, entry)
      void (async () => {
        try {
          await options.transport.send(JSON.stringify(validated))
          if (pending.get(requestId) !== entry || state !== 'open') return
          entry.timer = setTimeout(() => {
            if (pending.get(requestId) !== entry) return
            pending.delete(requestId)
            reject(new GroupChannelError({
              code: 'RESULT_UNKNOWN',
              message: 'group request deadline elapsed; result is unknown, do not replay',
            }))
          }, options.timeoutMs)
        } catch (cause) {
          const error = serviceErrorOf(cause, 'UNAVAILABLE')
          if (pending.delete(requestId)) {
            if (entry.timer !== undefined) clearTimeout(entry.timer)
            reject(new GroupChannelError(error, { cause }))
          }
          // A failed write means the shared connection is unusable for every
          // waiting request, not only this one.
          disconnect(error)
        }
      })()
    })
  }

  const reconnected = async (): Promise<void> => {
    if (state === 'closed') throw new GroupChannelError({ code: 'UNAVAILABLE', message: 'group channel is closed' })
    if (state === 'open') return
    state = 'open'
    if (options.resubscribe === undefined) return
    try {
      await options.resubscribe(request)
    } catch (cause) {
      // Subscription rebuild is not critical to the directory or heartbeat.
      report(serviceErrorOf(cause, 'UPSTREAM_ERROR'))
    }
  }

  const subscribe = (listener: (push: GroupChannelPush) => void): (() => void) => {
    if (typeof listener !== 'function') {
      throw new GroupChannelError({ code: 'INVALID_INPUT', message: 'group channel push listener must be a function' })
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const status = (): GroupChannelStatus => ({
    state,
    pending: pending.size,
    ...(lastError === undefined ? {} : { lastError }),
  })

  detachTransport = options.transport.onMessage(onText)

  return { status, request, subscribe, disconnect, reconnected, close }
}
