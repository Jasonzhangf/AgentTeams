import WebSocket from 'ws'
import type { AgentDeclaration, ServiceError } from '../control-protocol/agent-services.ts'
import type { GroupWireReply, GroupWireRequest } from '../control-protocol/group-wire.ts'
import { parseGroupWireReply } from '../control-protocol/group-wire.ts'
import { startLocalMessageSocket, type LocalMessageSocketServer } from './local-message-socket.ts'
import { createVikunjaSync, type VikunjaSync } from './vikunja-sync.ts'

/**
 * The agent-side group messaging composition.
 *
 * It owns one control connection to the relay and one local socket for the CLI.
 * A CLI request is forwarded over the relay as a `relay.group` frame and the
 * reply is returned to the caller. When the hub delegates an external write
 * (`op.execute`), this process runs it against Vikunja and returns exactly one
 * receipt: confirmed, failed with a typed error, or unknown. Ambiguity is never
 * turned into success.
 */

export interface AgentMessagingVikunjaOptions {
  readonly baseUrl: string
  readonly token: string
}

export interface AgentMessagingOptions {
  readonly relayUrl: string
  readonly credential: string
  readonly declaration: AgentDeclaration
  readonly socketPath: string
  readonly vikunja?: AgentMessagingVikunjaOptions
  readonly requestTimeoutMs?: number
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

interface Pending {
  readonly resolve: (reply: GroupWireReply) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

function serviceError(code: ServiceError['code'], message: string): ServiceError {
  return { code, message }
}

export async function createAgentMessaging(options: AgentMessagingOptions): Promise<AgentMessaging> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const externalOpTimeoutMs = options.externalOpTimeoutMs ?? 15_000
  const agentId = options.declaration.identity.agentId
  const pending = new Map<string, Pending>()
  let socket: WebSocket | undefined
  let server: LocalMessageSocketServer | undefined
  let lastError: ServiceError | undefined
  let closing = false
  const vikunja: VikunjaSync | undefined = options.vikunja === undefined
    ? undefined
    : createVikunjaSync({ baseUrl: options.vikunja.baseUrl, token: options.vikunja.token, timeoutMs: externalOpTimeoutMs })

  const send = (frame: Record<string, unknown>): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('agent-messaging: relay connection is not open')
    socket.send(JSON.stringify(frame))
  }

  const request = (frame: GroupWireRequest): Promise<GroupWireReply> => {
    return new Promise<GroupWireReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(frame.requestId)
        reject(serviceError('RESULT_UNKNOWN', `no reply for ${frame.requestId} within ${requestTimeoutMs}ms`) as unknown as Error)
      }, requestTimeoutMs)
      pending.set(frame.requestId, { resolve, reject, timer })
      try {
        send({ kind: 'relay.group', requestId: frame.requestId, frame })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(frame.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const runOp = async (frame: { readonly opId: string; readonly opKind: string; readonly params: Record<string, unknown> }): Promise<Record<string, unknown>> => {
    const { opId, opKind, params } = frame
    const commitId = typeof params.commitId === 'string' ? params.commitId : typeof params.resultCommitId === 'string' ? params.resultCommitId : opId
    const unavailable = (): Record<string, unknown> => ({ kind: 'op.failed', opId, commitId, error: serviceError('UNAVAILABLE', 'Vikunja is not configured for this daemon') })
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
        if (result.status === 'ok') return { kind: 'op.confirmed', opId, commitId, result: { issueId: result.value.issueId, actualState: result.value.state } }
        if (result.status === 'failed') return { kind: 'op.failed', opId, commitId, error: result.error }
        return { kind: 'op.unknown', opId, commitId, reason: 'issue.query outcome is not confirmable' }
      }
      return { kind: 'op.failed', opId, commitId, error: serviceError('UNSUPPORTED_OPERATION', `unsupported external op ${opKind}`) }
    } catch (error) {
      return { kind: 'op.unknown', opId, commitId, reason: error instanceof Error ? error.message : 'external op failed unexpectedly' }
    }
  }

  const onRelayMessage = (data: WebSocket.RawData, binary: boolean): void => {
    if (binary) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    if (message.kind === 'relay.group.reply') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
      const entry = requestId === undefined ? undefined : pending.get(requestId)
      if (entry === undefined || requestId === undefined) return
      clearTimeout(entry.timer)
      pending.delete(requestId)
      try {
        entry.resolve(parseGroupWireReply(JSON.stringify(message.frame)))
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (message.kind === 'relay.group.push') {
      const frame = message.frame as Record<string, unknown> | undefined
      if (frame?.kind === 'op.execute') {
        const opId = String(frame.opId ?? '')
        void runOp({ opId, opKind: String(frame.opKind ?? ''), params: (frame.params ?? {}) as Record<string, unknown> })
          .then((outcome) => send({ kind: 'relay.group', requestId: `op:${opId}`, frame: outcome }))
          .catch((error: unknown) => {
            lastError = serviceError('UPSTREAM_ERROR', error instanceof Error ? error.message : 'op execution failed')
          })
      }
      return
    }
    if (message.kind === 'relay.error') {
      const error = message.error as ServiceError | undefined
      if (error) lastError = error
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
      const entry = requestId === undefined ? undefined : pending.get(requestId)
      if (entry && requestId) {
        clearTimeout(entry.timer)
        pending.delete(requestId)
        entry.reject(Object.assign(new Error(error?.message ?? 'relay error'), { serviceError: error }))
      }
    }
  }

  const start = async (): Promise<void> => {
    socket = new WebSocket(options.relayUrl, { rejectUnauthorized: false, headers: { authorization: options.credential } })
    socket.on('error', (error) => { lastError = serviceError('UNAVAILABLE', error.message) })
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', () => resolve())
      socket!.once('error', reject)
    })
    socket.on('message', onRelayMessage)
    const admitted = new Promise<void>((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString()) as Record<string, unknown>
          if (message.kind !== 'relay.admitted') return
          socket!.off('message', onMessage)
          resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      socket!.on('message', onMessage)
    })
    send({ kind: 'relay.login', protocolVersion: 2, declaration: options.declaration })
    await admitted
    server = await startLocalMessageSocket({
      socketPath: options.socketPath,
      handler: (frame) => request(frame),
    })
  }

  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(Object.assign(new Error('agent-messaging is closing'), { serviceError: serviceError('UNAVAILABLE', 'agent-messaging is closing') }))
      pending.delete(requestId)
    }
    await server?.close()
    server = undefined
    if (socket) {
      socket.terminate()
      socket = undefined
    }
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
