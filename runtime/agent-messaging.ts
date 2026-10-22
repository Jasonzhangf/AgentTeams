import type { AgentDeclaration, ServiceError, ServiceErrorCode } from '../control-protocol/agent-services.ts'
import type { ExternalOpReply, GroupWireReply, GroupWireRequest } from '../control-protocol/group-wire.ts'
import { startLocalMessageSocket, type LocalMessageSocketServer } from './local-message-socket.ts'
import { createVikunjaSync, type VikunjaSync } from './vikunja-sync.ts'

/**
 * The agent-side group messaging composition.
 *
 * It owns one local socket for the CLI. The registration connection is injected
 * as a group channel: this module never opens, authenticates or restarts a relay
 * socket. A CLI request is forwarded over that channel and the reply is returned
 * to the caller. When the hub delegates an external write (`op.execute`), this
 * process runs it against Vikunja and returns exactly one receipt: confirmed,
 * failed with a typed error, or unknown. Ambiguity is never turned into success.
 */

/** The only server push this daemon executes itself. */
export interface AgentMessagingPush {
  readonly kind: 'op.execute'
  readonly opId: string
  readonly opKind: string
  readonly params: Record<string, unknown>
}

/**
 * Injected group transport owned by the registration client. The channel owns
 * request correlation, timeouts, reconnect attachment and the relay socket.
 */
export interface AgentMessagingChannel {
  /** Sends one CLI request and resolves with its correlated reply, or rejects with a typed failure. */
  request(frame: GroupWireRequest): Promise<GroupWireReply>
  /** Sends one external operation receipt. A receipt has no correlated group reply. */
  send(frame: ExternalOpReply): Promise<void>
  /** Subscribes to server pushes. Returns a detach function. */
  subscribe(listener: (push: AgentMessagingPush) => void): () => void
}

export interface AgentMessagingVikunjaOptions {
  readonly baseUrl: string
  readonly token: string
}

export interface AgentMessagingOptions {
  readonly channel: AgentMessagingChannel
  readonly declaration: AgentDeclaration
  readonly socketPath: string
  readonly vikunja?: AgentMessagingVikunjaOptions
  /** Abort one delegated write after this long and report unknown. */
  readonly externalOpTimeoutMs?: number
}

export interface AgentMessaging {
  readonly socketPath: string
  readonly agentId: string
  start(): Promise<void>
  close(): Promise<void>
  /** Most recent failure, retained for diagnostics. */
  lastError(): ServiceError | undefined
}

/** A channel failure already typed by its owner; the local socket returns the same ServiceError. */
class AgentMessagingChannelError extends Error {
  readonly code: ServiceErrorCode
  readonly serviceError: ServiceError

  constructor(serviceError: ServiceError, options?: ErrorOptions) {
    super(serviceError.message, options)
    this.name = 'AgentMessagingChannelError'
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

function serviceErrorOf(cause: unknown, fallback: ServiceErrorCode): ServiceError {
  if (cause instanceof AgentMessagingChannelError) return cause.serviceError
  if (cause instanceof Error) {
    const serviceError = (cause as { readonly serviceError?: unknown }).serviceError
    if (typeof serviceError === 'object' && serviceError !== null) {
      const code = (serviceError as { readonly code?: unknown }).code
      const message = (serviceError as { readonly message?: unknown }).message
      if (isServiceErrorCode(code) && typeof message === 'string') return { code, message }
    }
    const code = (cause as { readonly code?: unknown }).code
    return { code: isServiceErrorCode(code) ? code : fallback, message: cause.message }
  }
  return { code: fallback, message: String(cause) }
}

function serviceError(code: ServiceErrorCode, message: string): ServiceError {
  return { code, message }
}

export async function createAgentMessaging(options: AgentMessagingOptions): Promise<AgentMessaging> {
  const externalOpTimeoutMs = options.externalOpTimeoutMs ?? 15_000
  const agentId = options.declaration.identity.agentId
  const channel = options.channel
  if (channel === undefined || typeof channel.request !== 'function' || typeof channel.send !== 'function' ||
    typeof channel.subscribe !== 'function') {
    throw new AgentMessagingChannelError(serviceError('INVALID_INPUT', 'agent-messaging: an injected group channel with request, send and subscribe is required'))
  }
  const inFlight = new Map<string, (cause: unknown) => void>()
  let server: LocalMessageSocketServer | undefined
  let detachPush: (() => void) | undefined
  let lastError: ServiceError | undefined
  let closing = false
  const vikunja: VikunjaSync | undefined = options.vikunja === undefined
    ? undefined
    : createVikunjaSync({ baseUrl: options.vikunja.baseUrl, token: options.vikunja.token, timeoutMs: externalOpTimeoutMs })

  /** The only CLI request path: the channel owns correlation and its deadline. */
  const request = (frame: GroupWireRequest): Promise<GroupWireReply> => {
    if (closing) {
      const failure = serviceError('UNAVAILABLE', 'agent-messaging is closing')
      lastError = failure
      return Promise.reject(new AgentMessagingChannelError(failure))
    }
    return new Promise<GroupWireReply>((resolve, reject) => {
      const fail = (cause: unknown): void => {
        const failure = serviceErrorOf(cause, 'UNAVAILABLE')
        if (!inFlight.delete(frame.requestId)) return
        lastError = failure
        reject(new AgentMessagingChannelError(failure, cause instanceof Error ? { cause } : undefined))
      }
      inFlight.set(frame.requestId, fail)
      void channel.request(frame).then(
        reply => { if (inFlight.delete(frame.requestId)) resolve(reply) },
        fail,
      )
    })
  }

  const runOp = async (frame: AgentMessagingPush): Promise<ExternalOpReply> => {
    const { opId, opKind, params } = frame
    const commitId = typeof params.commitId === 'string' ? params.commitId : typeof params.resultCommitId === 'string' ? params.resultCommitId : opId
    const unavailable = (): ExternalOpReply => ({ kind: 'op.failed', opId, commitId, error: serviceError('UNAVAILABLE', 'Vikunja is not configured for this daemon') })
    if (!vikunja) return unavailable()
    try {
      if (opKind === 'issue.create') {
        const result = await vikunja.createIssue({
          projectId: String(params.vikunjaProjectId ?? ''),
          title: String(params.title ?? ''),
          body: String(params.body ?? ''),
          ref: commitId,
        })
        if (result.status === 'ok') return { kind: 'op.confirmed', opId, commitId, result: { issueId: result.value.issueId } }
        if (result.status === 'failed') return { kind: 'op.failed', opId, commitId, error: result.error }
        return { kind: 'op.unknown', opId, commitId, reason: 'issue.create outcome is not confirmable' }
      }
      if (opKind === 'issue.close' || opKind === 'issue.reopen') {
        const issueId = String(params.vikunjaIssueId ?? '')
        const result = opKind === 'issue.close'
          ? await vikunja.closeIssue({ issueId })
          : await vikunja.reopenIssue({ issueId })
        if (result.status === 'ok') {
          return { kind: 'op.confirmed', opId, commitId, result: { issueId, expectedState: result.value.expectedState, actualState: result.value.actualState } }
        }
        if (result.status === 'failed') return { kind: 'op.failed', opId, commitId, error: result.error }
        return { kind: 'op.unknown', opId, commitId, reason: `${opKind} outcome is not confirmable` }
      }
      if (opKind === 'action.result') {
        const issueId = String(params.vikunjaIssueId ?? '')
        if (issueId.length === 0) return { kind: 'op.failed', opId, commitId, error: serviceError('INVALID_INPUT', 'action.result needs the bound issue id') }
        const result = await vikunja.writeComment({ issueId, body: String(params.resultBody ?? ''), ref: commitId })
        if (result.status === 'ok') return { kind: 'op.confirmed', opId, commitId, result: { resultRef: result.value.commentId } }
        if (result.status === 'failed') return { kind: 'op.failed', opId, commitId, error: result.error }
        return { kind: 'op.unknown', opId, commitId, reason: 'action.result outcome is not confirmable' }
      }
      if (opKind === 'issue.query') {
        const result = await vikunja.readState({ issueId: String(params.vikunjaIssueId ?? '') })
        if (result.status === 'ok') {
          // The owning project rides back so a reference can bind it; without it
          // the hub cannot tell which project the issue belongs to.
          return {
            kind: 'op.confirmed',
            opId,
            commitId,
            result: {
              issueId: result.value.issueId,
              actualState: result.value.state,
              ...(result.value.projectId === undefined ? {} : { projectId: result.value.projectId }),
            },
          }
        }
        if (result.status === 'failed') return { kind: 'op.failed', opId, commitId, error: result.error }
        return { kind: 'op.unknown', opId, commitId, reason: 'issue.query outcome is not confirmable' }
      }
      return { kind: 'op.failed', opId, commitId, error: serviceError('UNSUPPORTED_OPERATION', `unsupported external op ${opKind}`) }
    } catch (cause) {
      return { kind: 'op.unknown', opId, commitId, reason: cause instanceof Error ? cause.message : 'external op failed unexpectedly' }
    }
  }

  const onPush = (push: AgentMessagingPush): void => {
    if (closing) return
    void runOp(push)
      .then(outcome => channel.send(outcome))
      .catch(cause => { lastError = serviceErrorOf(cause, 'UPSTREAM_ERROR') })
  }

  const start = async (): Promise<void> => {
    if (closing) throw new AgentMessagingChannelError(serviceError('UNAVAILABLE', 'agent-messaging is closing'))
    detachPush = channel.subscribe(onPush)
    try {
      server = await startLocalMessageSocket({
        socketPath: options.socketPath,
        handler: (frame) => request(frame),
      })
    } catch (cause) {
      detachPush()
      detachPush = undefined
      throw cause
    }
  }

  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    detachPush?.()
    detachPush = undefined
    const failure = serviceError('UNAVAILABLE', 'agent-messaging is closing')
    lastError = failure
    for (const fail of [...inFlight.values()]) fail(new AgentMessagingChannelError(failure))
    inFlight.clear()
    await server?.close()
    server = undefined
  }

  return {
    socketPath: options.socketPath,
    agentId,
    start,
    close,
    lastError: () => lastError,
  }
}

/** One deterministic socket per daemon data directory; the CLI discovers it here. */
export function localSocketPathFor(dataDirectory: string): string {
  return `${dataDirectory}/agent-messaging.sock`.replace(/\/+/gu, '/')
}
