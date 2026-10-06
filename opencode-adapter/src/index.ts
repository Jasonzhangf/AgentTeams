import type { PluginInput, Hooks } from '@opencode-ai/plugin'
import type { Session } from '@opencode-ai/sdk'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { assertEnvelopeKeys, assertJsonValue } from '../../control-protocol/json-value.ts'
import type { JsonValue } from '../../control-protocol/agent-services.ts'
import type { ConsoleSessionEventView, OpenCodeStructuredError, SessionCreateResult, SessionObservationState } from '../../control-protocol/console-api.ts'
import type {
  ConfigApplyResult,
  ModelEntry,
  ProviderInstance,
  RuntimeConfigApplier,
  VersionedRuntimeConfig,
} from '../../config/runtime-config.ts'

export type OpenCodeAdapterErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE' | 'UNAVAILABLE' | 'UNSUPPORTED_OPERATION' | 'INVALID_INPUT'

export class OpenCodeAdapterError extends Error {
  readonly code: OpenCodeAdapterErrorCode
  readonly operation: string
  readonly status?: number

  constructor(operation: string, code: OpenCodeAdapterErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'OpenCodeAdapterError'
    this.code = code
    this.operation = operation
    this.status = status
  }
}

export interface OpenCodePluginInput {
  readonly client: unknown
  readonly project: unknown
  readonly directory: string
  readonly worktree: string
  readonly experimental_workspace: unknown
  readonly serverUrl: URL
  readonly $: unknown
}

export interface OpenCodeEvent {
  readonly type: string
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface OpenCodeEventInput {
  readonly event: OpenCodeEvent
}

export interface OpenCodePermissionInput {
  readonly id: string
  readonly sessionID: string
}

export interface OpenCodeHooks {
  readonly event?: (input: OpenCodeEventInput) => Promise<void>
  readonly 'permission.ask'?: (input: OpenCodePermissionInput, output: {
    status: 'ask' | 'deny' | 'allow'
  }) => Promise<void>
}

export interface OpenCodeNotification {
  readonly source: 'opencode'
  readonly kind:
    | 'session-created'
    | 'session-updated'
    | 'session-deleted'
    | 'session-status'
    | 'message-updated'
    | 'permission-request'
    | 'permission-processed'
  readonly sessionId: string
  readonly requestId?: string
  readonly interactive: boolean
  readonly status: 'pending' | 'processed'
  readonly priority: 'normal' | 'high'
  readonly occurredAt: string
}

export type OpenCodeNotificationSink = (notification: OpenCodeNotification) => void

export interface OpenCodeNotificationStore {
  readonly pending: readonly OpenCodeNotification[]
  readonly processed: readonly OpenCodeNotification[]
}

export interface OpenCodeNotificationStoreBinding {
  readonly get: () => OpenCodeNotificationStore
  readonly sink: OpenCodeNotificationSink
  readonly acknowledge: (notificationId: string) => void
}

export interface OpenCodeSessionProjection {
  readonly id: string
  readonly title?: string
  readonly directory?: string
  readonly time?: Readonly<Record<string, unknown>>
}

export interface OpenCodeHostProjection {
  readonly sessions: readonly OpenCodeSessionProjection[]
  readonly notifications: OpenCodeNotificationStore
}

export interface OpenCodeAgentIdentity {
  readonly agentId: string
  readonly machineId: string
  readonly label: string
  readonly machine: string
  readonly provider: string
  readonly model: string
  readonly sessionIds: readonly string[]
  readonly currentSessionId?: string
}

export interface OpenCodeTeamsProjection {
  readonly agents: readonly OpenCodeAgentIdentity[]
  readonly sessions: readonly (OpenCodeSessionProjection & { readonly agentId: string; readonly running: boolean })[]
  readonly notifications: OpenCodeNotificationStore
}

export interface TeamsNotificationProjectionItem {
  readonly id: string
  readonly sessionId: string
  readonly requestId?: string
  readonly interactive: boolean
  readonly processed: boolean
  readonly priority: 'high' | 'medium'
  readonly createdAt: string
}

export interface OpenCodeHostActions {
  readonly openSession: (sessionId: string) => Promise<void>
  readonly sendMessage: (sessionId: string, payload: JsonValue) => Promise<void>
  readonly replyPermission: (sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject') => Promise<void>
  readonly acknowledgeNotification: (notificationId: string) => void
}

export interface OpenCodeHostFacade {
  readonly projection: () => OpenCodeHostProjection
  readonly teamsProjection: (identities: readonly OpenCodeAgentIdentity[]) => OpenCodeTeamsProjection
  readonly refreshSessions: (directory?: string) => Promise<readonly OpenCodeSessionProjection[]>
  readonly subscribe: (listener: (projection: OpenCodeHostProjection) => void) => () => void
  readonly actions: OpenCodeHostActions
}

export interface OpenCodePluginRuntime {
  readonly facade: OpenCodeHostFacade
  readonly hooks: Hooks
}

export interface OpenCodeSdkResponse<T> {
  readonly data?: T
  readonly error?: unknown
  readonly response?: { readonly status: number }
}

export type OpenCodeSdkResult<T> = T | OpenCodeSdkResponse<T>

export interface OpenCodeModelTarget {
  readonly providerID: string
  readonly modelID: string
}

export interface OpenCodeSessionPromptBody {
  readonly parts: [{ type: 'text'; text: string }]
  readonly model?: OpenCodeModelTarget
  readonly messageID?: string
}

export interface OpenCodeSessionClient {
  readonly session: {
    list(options?: Readonly<Record<string, unknown>>): Promise<OpenCodeSdkResult<readonly Session[]>>
    get(options: { path: { id: string } }): Promise<OpenCodeSdkResult<Session>>
    create(options?: { body?: { readonly parentID?: string; readonly title?: string }; query?: { readonly directory?: string } }): Promise<OpenCodeSdkResult<Session>>
    prompt(options: { path: { id: string }; body: OpenCodeSessionPromptBody }): Promise<OpenCodeSdkResult<unknown>>
    abort(options: { path: { id: string } }): Promise<OpenCodeSdkResult<boolean>>
    messages(options: { path: { id: string }; query?: { readonly directory?: string; readonly limit?: number } }): Promise<OpenCodeSdkResult<readonly OpenCodeSessionMessageEntry[]>>
    status(options?: { query?: { readonly directory?: string } }): Promise<OpenCodeSdkResult<Readonly<Record<string, OpenCodeSessionStatus>>>>
  }
  readonly postSessionIdPermissionsPermissionId: (options: { path: { id: string; permissionID: string }; body: { response: 'once' | 'always' | 'reject' } }) => Promise<OpenCodeSdkResult<unknown>>
}

/** 1.18.23 `session.messages` entry: one opaque message info plus its parts. */
export type OpenCodeSessionMessageEntry = {
  readonly info: unknown
  readonly parts: readonly unknown[]
}

/** 1.18.23 `session.status` value, keyed by session id. */
export interface OpenCodeSessionStatus {
  readonly type: 'idle' | 'retry' | 'busy'
}

/** Raw SDK event; only the wire `type` and opaque `properties` are read by the pure classifier. */
export interface OpenCodeSdkEvent {
  readonly type: string
  readonly properties: Readonly<Record<string, unknown>>
}

export interface OpenCodeEventSubscription {
  readonly stream: AsyncGenerator<OpenCodeSdkEvent>
}

export interface OpenCodeEventClient {
  readonly event: {
    subscribe(options?: Readonly<Record<string, unknown>>): Promise<OpenCodeSdkResult<OpenCodeEventSubscription>>
  }
}

/** Single-event classification result produced only by `projectOpenCodeSessionEvent`. */
export type OpenCodeSessionEventProjection =
  | { readonly kind: 'event'; readonly event: ConsoleSessionEventView; readonly parentMessageId?: string }
  | { readonly kind: 'unsupported'; readonly reason: string; readonly raw: JsonValue }
  | { readonly kind: 'invalid'; readonly reason: string; readonly raw: JsonValue }

export interface OpenCodeCompiledTarget {
  /** The Teams provider-instance id; OpenCode does not own this identity. */
  readonly provider: string
  readonly model: string
  readonly protocol: ProviderInstance['protocol']
  readonly baseUrl: string
  /** An opaque reference only. The credential value never enters this projection. */
  readonly credentialRef?: string
}

export interface OpenCodeCompiledConfig {
  readonly agentId: string
  readonly acceptedRevision: number
  readonly primary: OpenCodeCompiledTarget
  readonly backup?: OpenCodeCompiledTarget
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function responseStatus(response: Readonly<Record<string, unknown>>): number | undefined {
  const nested = response.response
  if (isRecord(nested) && typeof nested.status === 'number') return nested.status
  return typeof response.status === 'number' ? response.status : undefined
}

function responseMessage(value: unknown, operation: string): string {
  if (value instanceof Error && value.message.length > 0) return value.message
  if (isRecord(value) && typeof value.message === 'string' && value.message.length > 0) return value.message
  return `OpenCode ${operation} failed`
}

function errorCodeForStatus(status: number | undefined): OpenCodeAdapterErrorCode {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status !== undefined && status >= 500) return 'UPSTREAM_ERROR'
  return 'INVALID_RESPONSE'
}

function unwrapOpenCodeResponse<T>(response: OpenCodeSdkResult<T>, operation: string, allowUndefined = false): T | undefined {
  if (!isRecord(response)) {
    if (response === undefined && !allowUndefined) throw new OpenCodeAdapterError(operation, 'INVALID_RESPONSE', `OpenCode ${operation} returned no data`)
    return response as T | undefined
  }
  const status = responseStatus(response)
  if (status !== undefined && (status < 200 || status >= 300)) {
    throw new OpenCodeAdapterError(operation, errorCodeForStatus(status), responseMessage(response.error, operation), status)
  }
  const hasEnvelope = 'data' in response || 'error' in response || 'response' in response
  if (!hasEnvelope) {
    if (status !== undefined) {
      if (allowUndefined) return undefined
      throw new OpenCodeAdapterError(operation, 'INVALID_RESPONSE', `OpenCode ${operation} returned no data`, status)
    }
    return response as T
  }
  if (response.error !== undefined) {
    throw new OpenCodeAdapterError(operation, errorCodeForStatus(status), responseMessage(response.error, operation), status)
  }
  if (response.data === undefined) {
    if (allowUndefined) return undefined
    throw new OpenCodeAdapterError(operation, errorCodeForStatus(status), `OpenCode ${operation} returned no data`, status)
  }
  return response.data as T
}

export async function listOpenCodeSessions(client: OpenCodeSessionClient, directory?: string): Promise<readonly OpenCodeSessionProjection[]> {
  const result = await client.session.list(directory === undefined ? {} : { query: { directory } })
  const sessions = unwrapOpenCodeResponse(result, 'session.list')
  if (sessions === undefined) throw new OpenCodeAdapterError('session.list', 'INVALID_RESPONSE', 'OpenCode session.list returned no data')
  return sessions.map(session => ({ id: session.id, title: session.title, directory: session.directory, time: session.time }))
}

export async function getOpenCodeSession(client: OpenCodeSessionClient, sessionId: string): Promise<OpenCodeSessionProjection> {
  const result = await client.session.get({ path: { id: sessionId } })
  const session = unwrapOpenCodeResponse(result, 'session.get')
  if (session === undefined) throw new OpenCodeAdapterError('session.get', 'NOT_FOUND', `OpenCode session not found: ${sessionId}`, 404)
  return { id: session.id, title: session.title, directory: session.directory, time: session.time }
}

function invalidOpenCodeModelTarget(message: string): never {
  throw new OpenCodeAdapterError('session.prompt', 'INVALID_INPUT', message)
}

function validateOpenCodeModelTarget(target: OpenCodeModelTarget | undefined): OpenCodeModelTarget | undefined {
  if (target === undefined) return undefined
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    return invalidOpenCodeModelTarget('OpenCode model target must be a plain object')
  }

  try {
    assertJsonValue(target, 'OpenCode model target')
    assertEnvelopeKeys(target as unknown as Record<string, unknown>, ['providerID', 'modelID'], 'OpenCode model target')
  } catch (error) {
    return invalidOpenCodeModelTarget(error instanceof Error ? error.message : 'OpenCode model target is invalid')
  }

  const input = target as unknown as Record<string, unknown>
  const providerID = input.providerID
  const modelID = input.modelID
  if (typeof providerID !== 'string' || providerID.trim() === '' || typeof modelID !== 'string' || modelID.trim() === '') {
    return invalidOpenCodeModelTarget('OpenCode model target requires non-empty providerID and modelID')
  }
  return { providerID, modelID }
}

export async function sendOpenCodeMessage(client: OpenCodeSessionClient, sessionId: string, text: string, target?: OpenCodeModelTarget): Promise<void> {
  if (text.trim() === '') throw new Error('OpenCode message must not be empty')
  const selectedTarget = validateOpenCodeModelTarget(target)
  const body: OpenCodeSessionPromptBody = {
    parts: [{ type: 'text', text }],
    ...(selectedTarget === undefined ? {} : { model: selectedTarget }),
  }
  const result = await client.session.prompt({ path: { id: sessionId }, body })
  unwrapOpenCodeResponse(result, 'session.prompt', true)
}

function validatePromptMessageId(messageId: string | undefined): string | undefined {
  if (messageId === undefined) return undefined
  if (typeof messageId !== 'string' || messageId.trim() === '') throw new OpenCodeAdapterError('session.prompt', 'INVALID_INPUT', 'OpenCode prompt messageID must be a non-empty string')
  return messageId
}

/**
 * Dispatches one SDK prompt with an explicit, owner-resolved model target and an
 * owner-allocated user messageID. Both are required in the Session dispatch
 * path; the messageID is the SDK body field, never a Teams business part.
 */
export async function promptOpenCodeSession(
  client: OpenCodeSessionClient,
  sessionId: string,
  text: string,
  target: OpenCodeModelTarget,
  messageId: string,
): Promise<void> {
  if (text.trim() === '') throw new OpenCodeAdapterError('session.prompt', 'INVALID_INPUT', 'OpenCode message must not be empty')
  const selectedTarget = validateOpenCodeModelTarget(target)
  if (selectedTarget === undefined) throw new OpenCodeAdapterError('session.prompt', 'INVALID_INPUT', 'OpenCode prompt requires an effective model target')
  const validatedMessageId = validatePromptMessageId(messageId)
  const body = {
    messageID: validatedMessageId,
    parts: [{ type: 'text' as const, text }] as [{ type: 'text'; text: string }],
    model: selectedTarget,
  }
  const result = await client.session.prompt({ path: { id: sessionId }, body })
  unwrapOpenCodeResponse(result, 'session.prompt', true)
}

/**
 * Maps the real 1.18.23 `Session` envelope; never synthesizes a default title or id.
 * `agentId` comes from the validated Teams target, never from the SDK.
 */
export async function createOpenCodeSession(client: OpenCodeSessionClient, agentId: string, title?: string): Promise<SessionCreateResult> {
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new OpenCodeAdapterError('session.create', 'INVALID_INPUT', 'OpenCode session create requires a target agent id')
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    throw new OpenCodeAdapterError('session.create', 'INVALID_INPUT', 'OpenCode session title must be a non-empty string when provided')
  }
  const result = await client.session.create(title === undefined ? {} : { body: { title } })
  const session = unwrapOpenCodeResponse(result, 'session.create')
  if (session === undefined || typeof session.id !== 'string' || session.id.length === 0) {
    throw new OpenCodeAdapterError('session.create', 'INVALID_RESPONSE', 'OpenCode session.create returned no session id')
  }
  return {
    kind: 'session.create',
    agentId,
    sessionId: session.id,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.directory === undefined ? {} : { directory: session.directory }),
    ...(session.time === undefined ? {} : { time: session.time as Readonly<Record<string, JsonValue>> }),
  }
}

/** 1.18.23 `session.abort` base acceptance; never proof the cancel completed. */
export async function cancelOpenCodeSession(client: OpenCodeSessionClient, sessionId: string): Promise<boolean> {
  const result = await client.session.abort({ path: { id: sessionId } })
  const accepted = unwrapOpenCodeResponse(result, 'session.abort', true)
  return accepted === true
}

/** Reads the real message/part list for one session; identity is preserved verbatim. */
export async function readOpenCodeSessionMessages(client: OpenCodeSessionClient, sessionId: string): Promise<readonly OpenCodeSessionMessageEntry[]> {
  const result = await client.session.messages({ path: { id: sessionId } })
  const messages = unwrapOpenCodeResponse(result, 'session.messages')
  if (messages === undefined) throw new OpenCodeAdapterError('session.messages', 'INVALID_RESPONSE', 'OpenCode session.messages returned no data')
  return messages
}

/** Reads session-level status as a supporting observation; never the sole cancel confirmation. */
export async function readOpenCodeSessionStatus(client: OpenCodeSessionClient): Promise<Readonly<Record<string, OpenCodeSessionStatus>>> {
  const result = await client.session.status({})
  const status = unwrapOpenCodeResponse(result, 'session.status')
  return status ?? {}
}

export type OpenCodeSessionMessageV1 = {
  readonly text: string
}

/**
 * Binds the real `@opencode-ai/sdk` client to one owner-scoped managed handle.
 * The runtime consumes only the adapter; nothing else imports the SDK transport.
 */
export function createOpenCodeSessionClient(handle: { readonly url: string; readonly authorization: string }): OpenCodeSessionClient & OpenCodeEventClient {
  if (typeof handle.url !== 'string' || handle.url.length === 0 || typeof handle.authorization !== 'string') {
    throw new OpenCodeAdapterError('client.create', 'INVALID_INPUT', 'OpenCode client requires a managed url and authorization')
  }
  return createOpencodeClient({ baseUrl: handle.url, headers: { authorization: handle.authorization } }) as unknown as OpenCodeSessionClient & OpenCodeEventClient
}

/**
 * Sole Session message decoder: converts a supported business payload into the
 * SDK prompt input shape. It rejects lossy/extra shapes before any side effect.
 */
export function decodeOpenCodeSessionMessage(payload: JsonValue): OpenCodeSessionMessageV1 {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OpenCodeAdapterError('session.prompt', 'INVALID_INPUT', 'OpenCode session message payload must be a { text } object')
  }
  assertEnvelopeKeys(payload as unknown as Record<string, unknown>, ['text'], 'OpenCode session message payload')
  const text = (payload as { readonly text?: unknown }).text
  if (typeof text !== 'string' || text.length === 0) {
    throw new OpenCodeAdapterError('session.prompt', 'INVALID_INPUT', 'OpenCode session message requires a non-empty text string')
  }
  return { text }
}

/**
 * Thin wrapper over the real `client.event.subscribe`. It establishes no second
 * connection, performs no retry, buffers nothing, and holds no lifecycle state;
 * it only forwards the SDK stream to the caller and honors the abort signal.
 */
export async function* subscribeOpenCodeEvents(client: OpenCodeEventClient, signal: AbortSignal): AsyncGenerator<OpenCodeSdkEvent> {
  // The SDK owns the SSE retry loop and only observes an abort signal it is given, so the
  // caller's signal is forwarded. Without it the loop retries forever and never closes.
  const subscription = unwrapOpenCodeResponse(await client.event.subscribe({ signal }), 'event.subscribe')
  if (subscription === undefined) throw new OpenCodeAdapterError('event.subscribe', 'INVALID_RESPONSE', 'OpenCode event.subscribe returned no stream')
  if (typeof subscription.stream?.[Symbol.asyncIterator] !== 'function') {
    throw new OpenCodeAdapterError('event.subscribe', 'INVALID_RESPONSE', 'OpenCode event.subscribe returned no event stream')
  }
  const iterator = subscription.stream[Symbol.asyncIterator]()
  const aborted = new Promise<{ readonly kind: 'abort' }>(resolve => {
    if (signal.aborted) resolve({ kind: 'abort' })
    else signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true })
  })
  try {
    while (true) {
      if (signal.aborted) return
      const outcome = await Promise.race([
        iterator.next().then(value => ({ kind: 'next' as const, value })),
        aborted,
      ])
      if (outcome.kind === 'abort') return
      if (outcome.value.done === true) return
      yield outcome.value.value
    }
  } finally {
    // Closing the SDK generator resumes only after its pending retry sleep settles, so an
    // aborted caller must not wait for it: the SDK loop already stops on the same signal.
    const returned = iterator.return?.(undefined)
    if (returned !== undefined) await Promise.race([returned.then(() => undefined, () => undefined), aborted])
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function structuredError(value: unknown): OpenCodeStructuredError | undefined {
  const error = asRecord(value)
  if (error === undefined) return undefined
  const name = error.name
  if (name !== 'ProviderAuthError' && name !== 'UnknownError' && name !== 'MessageOutputLengthError' && name !== 'MessageAbortedError' && name !== 'APIError') return undefined
  if (error.data === undefined) return undefined
  try { assertJsonValue(error.data, 'OpenCode structured error data') } catch { return undefined }
  return { name, data: error.data as JsonValue }
}

// Observed part tags (everything except text/reasoning/tool) map to the frozen observed variants.
type ObservedPartType = 'file' | 'step-start' | 'step-finish' | 'snapshot' | 'patch' | 'agent' | 'retry' | 'compaction' | 'subtask'
const OBSERVED_PART_TAGS: Readonly<Record<string, ObservedPartType>> = {
  file: 'file', 'step-start': 'step-start', 'step-finish': 'step-finish', snapshot: 'snapshot',
  patch: 'patch', agent: 'agent', retry: 'retry', compaction: 'compaction', subtask: 'subtask',
} as const

function eventBase(type: string, sessionId: string, messageId?: string): { readonly eventId: string; readonly sessionId: string } {
  return { eventId: `${type}:${sessionId}:${messageId ?? ''}`, sessionId }
}

/**
 * The sole SDK-shape classifier. Pure: it holds no state, decides nothing about
 * stream lifetime or observation status, and returns exactly one typed event,
 * `unsupported`, or `invalid` for one raw SDK event/part.
 */
export function projectOpenCodeSessionEvent(raw: unknown): OpenCodeSessionEventProjection {
  const event = asRecord(raw)
  const rawJson = (asRecord(raw) ?? {}) as unknown as JsonValue
  if (event === undefined || typeof event.type !== 'string') return { kind: 'invalid', reason: 'event is not a typed OpenCode event', raw: rawJson }
  const properties = asRecord(event.properties)
  const type = event.type
  if (type.startsWith('message.part.updated')) {
    if (properties === undefined) return { kind: 'invalid', reason: 'part event is missing properties', raw: rawJson }
    return classifyPart(type, properties, rawJson)
  }
  if (type === 'message.updated') {
    if (properties === undefined) return { kind: 'invalid', reason: 'message event is missing properties', raw: rawJson }
    return classifyMessage(type, properties, rawJson)
  }
  if (type === 'session.error') {
    const sessionId = stringField(properties?.sessionID)
    const error = structuredError(properties?.error)
    if (sessionId === undefined || error === undefined) return { kind: 'invalid', reason: 'session.error is missing session identity or structured error', raw: rawJson }
    const messageId = stringField(properties?.messageID)
    return { kind: 'event', event: { eventId: `${type}:${sessionId}`, agentId: '', sessionId, kind: 'error', state: 'failed', error,
      correlation: messageId === undefined ? { kind: 'session', sessionId } : { kind: 'message', messageId } } }
  }
  if (type === 'permission.updated') {
    const sessionId = stringField(properties?.sessionID)
    const permissionId = stringField(properties?.id) ?? stringField(properties?.permissionID)
    const messageId = stringField(properties?.messageID)
    const title = stringField(properties?.title)
    const metadata = properties?.metadata
    if (sessionId === undefined || permissionId === undefined || messageId === undefined || title === undefined || metadata === undefined) {
      return { kind: 'invalid', reason: 'permission.updated is missing id, messageID, title, or metadata', raw: rawJson }
    }
    try { assertJsonValue(metadata, 'permission metadata') } catch { return { kind: 'invalid', reason: 'permission metadata is not JSON', raw: rawJson } }
    const callId = stringField(properties?.callID)
    return { kind: 'event', event: { ...eventBase(type, sessionId), agentId: '', kind: 'permission', state: 'pending', permissionId, messageId,
      ...(callId === undefined ? {} : { callId }), title, metadata: metadata as JsonValue } }
  }
  if (type === 'permission.replied') {
    const sessionId = stringField(properties?.sessionID)
    const permissionId = stringField(properties?.permissionID) ?? stringField(properties?.id)
    const response = properties?.response
    if (sessionId === undefined || permissionId === undefined || typeof response !== 'string') return { kind: 'invalid', reason: 'permission.replied is missing session, permissionID, or string response', raw: rawJson }
    const decision = response === 'once' || response === 'always' || response === 'reject' ? response : 'unknown'
    return { kind: 'event', event: { ...eventBase(type, sessionId), agentId: '', kind: 'permission', state: 'resolved', permissionId, decision, ...(decision === 'unknown' ? { rawResponse: response } : {}) } }
  }
  return { kind: 'unsupported', reason: `unsupported OpenCode event ${type}`, raw: rawJson }
}

function classifyMessage(type: string, properties: Readonly<Record<string, unknown>>, raw: JsonValue): OpenCodeSessionEventProjection {
  const info = asRecord(properties.info)
  const messageId = stringField(info?.id)
  const role = info?.role
  const sessionId = stringField(info?.sessionID) ?? stringField(properties.sessionID)
  if (messageId === undefined || sessionId === undefined || (role !== 'user' && role !== 'assistant')) return { kind: 'invalid', reason: 'message.updated is missing a user/assistant message id', raw }
  const messageRole: 'user' | 'assistant' = role === 'assistant' ? 'assistant' : 'user'
  const base = eventBase(type, sessionId, messageId)
  const parentMessageId = stringField(info?.parentID)
  if (info?.error !== undefined) {
    const error = structuredError(info.error)
    if (error === undefined) return { kind: 'invalid', reason: 'message.updated error is not a structured OpenCode error', raw }
    const event = messageRole === 'assistant'
      ? { ...base, agentId: '', kind: 'final' as const, state: 'failed' as const, messageId, error }
      : { ...base, agentId: '', kind: 'message' as const, state: 'failed' as const, messageId, role: messageRole, error }
    return { kind: 'event', event, ...(parentMessageId === undefined ? {} : { parentMessageId }) }
  }
  const completed = asRecord(info?.time)?.completed
  if (messageRole === 'assistant' && completed !== undefined) {
    const finish = stringField(info?.finish)
    const event = { ...base, agentId: '', kind: 'final' as const, state: 'completed' as const, messageId, ...(finish === undefined ? {} : { finish }) }
    return { kind: 'event', event, ...(parentMessageId === undefined ? {} : { parentMessageId }) }
  }
  const event = { ...base, agentId: '', kind: 'message' as const, state: completed === undefined ? 'pending' as const : 'completed' as const, messageId, role: messageRole }
  return { kind: 'event', event, ...(parentMessageId === undefined ? {} : { parentMessageId }) }
}

function classifyPart(type: string, properties: Readonly<Record<string, unknown>>, raw: JsonValue): OpenCodeSessionEventProjection {
  const part = asRecord(properties.part) ?? asRecord(properties)
  if (part === undefined) return { kind: 'invalid', reason: 'part event has no part object', raw }
  const partType = stringField(part.type)
  const messageId = stringField(part.messageID)
  const partId = stringField(part.id)
  const sessionId = stringField(part.sessionID)
  if (partType === undefined || messageId === undefined || partId === undefined || sessionId === undefined) return { kind: 'invalid', reason: 'part event is missing type, id, messageID, or sessionID', raw }
  const base = eventBase(type, sessionId, messageId)
  const rawPart = part as unknown as JsonValue
  if (partType === 'text' || partType === 'reasoning') {
    if (typeof part.text !== 'string') return { kind: 'invalid', reason: `${partType} part is missing text`, raw }
    const completed = part.time !== undefined
    return { kind: 'event', event: { ...base, agentId: '', kind: 'part', state: completed ? 'completed' : 'pending', messageId, partId, partType, text: part.text } }
  }
  if (partType === 'tool') {
    const state = asRecord(part.state)
    const tool = stringField(part.tool)
    const callId = stringField(part.callID)
    if (state === undefined || tool === undefined || callId === undefined) return { kind: 'invalid', reason: 'tool part is missing state, tool, or callID', raw }
    const common = { ...base, agentId: '', kind: 'tool' as const, messageId, partId, callId, tool }
    const input = state.input as JsonValue
    switch (state.status) {
      case 'pending': return { kind: 'event', event: { ...common, state: 'pending', input, raw: typeof state.raw === 'string' ? state.raw : '' } }
      case 'running': return { kind: 'event', event: { ...common, state: 'running', input, ...(state.title === undefined ? {} : { title: String(state.title) }), ...(state.metadata === undefined ? {} : { metadata: state.metadata as JsonValue }) } }
      case 'completed': return { kind: 'event', event: { ...common, state: 'completed', input, output: String(state.output ?? ''), title: String(state.title ?? ''), metadata: (state.metadata ?? {}) as JsonValue, ...(Array.isArray(state.attachments) ? { attachments: state.attachments as readonly JsonValue[] } : {}) } }
      case 'error': return { kind: 'event', event: { ...common, state: 'error', input, error: String(state.error ?? ''), ...(state.metadata === undefined ? {} : { metadata: state.metadata as JsonValue }) } }
      default: return { kind: 'invalid', reason: `tool part has an unknown state ${String(state.status)}`, raw }
    }
  }
  const observed = OBSERVED_PART_TAGS[partType]
  if (observed === undefined) return { kind: 'unsupported', reason: `unsupported part type ${partType}`, raw }
  return { kind: 'event', event: { ...base, agentId: '', kind: 'part', state: 'observed', messageId, partId, partType: observed, sourcePart: rawPart } }
}

export async function replyOpenCodePermission(client: OpenCodeSessionClient, permissionId: string, sessionId: string, response: 'once' | 'always' | 'reject'): Promise<void> {
  const result = await client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: permissionId }, body: { response } })
  unwrapOpenCodeResponse(result, 'permission.reply', true)
}

function modelEntryFor(config: VersionedRuntimeConfig, providerInstanceId: string, modelId: string): ModelEntry | undefined {
  return config.catalogs[providerInstanceId]?.entries.find(entry => entry.ref.providerInstanceId === providerInstanceId && entry.ref.modelId === modelId)
}

function compileTarget(config: VersionedRuntimeConfig, providerInstanceId: string, modelId: string): OpenCodeCompiledTarget {
  const provider: ProviderInstance | undefined = config.providers[providerInstanceId]
  if (provider === undefined) {
    throw new OpenCodeAdapterError('config.compile', 'NOT_FOUND', `OpenCode provider not found: ${providerInstanceId}`)
  }
  if (!provider.enabled) {
    throw new OpenCodeAdapterError('config.compile', 'UNAVAILABLE', `OpenCode provider is disabled: ${providerInstanceId}`)
  }
  const entry = modelEntryFor(config, providerInstanceId, modelId)
  if (entry === undefined) {
    throw new OpenCodeAdapterError('config.compile', 'NOT_FOUND', `OpenCode model not found: ${providerInstanceId}/${modelId}`)
  }
  if (entry.availability === 'unavailable') {
    throw new OpenCodeAdapterError('config.compile', 'UNAVAILABLE', `OpenCode model is unavailable: ${providerInstanceId}/${modelId}`)
  }
  return {
    provider: provider.id,
    model: entry.ref.modelId,
    protocol: provider.protocol,
    baseUrl: provider.apiBaseUrl,
    ...(provider.auth.kind === 'bearer' ? { credentialRef: provider.auth.credentialRef } : {}),
  }
}

export function compileOpenCodeConfig(config: VersionedRuntimeConfig, agentId: string): OpenCodeCompiledConfig {
  if (agentId.trim() === '') throw new OpenCodeAdapterError('config.compile', 'INVALID_INPUT', 'OpenCode agent id is required')
  const binding = config.agents[agentId]
  if (binding === undefined) throw new OpenCodeAdapterError('config.compile', 'NOT_FOUND', `OpenCode Agent binding not found: ${agentId}`)
  return {
    agentId,
    acceptedRevision: config.acceptedRevision,
    primary: compileTarget(config, binding.primary.providerInstanceId, binding.primary.modelId),
    ...(binding.backup === undefined ? {} : { backup: compileTarget(config, binding.backup.providerInstanceId, binding.backup.modelId) }),
  }
}

export function createOpenCodeConfigApplier(): RuntimeConfigApplier {
  return {
    apply: async (_config): Promise<ConfigApplyResult> => ({
      status: 'unsupported',
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'OpenCode config apply API is unsupported',
      },
    }),
  }
}

export function createOpenCodeHostFacade(client: OpenCodeSessionClient, binding = createOpenCodeNotificationStoreBinding()): OpenCodeHostFacade {
  let sessions: readonly OpenCodeSessionProjection[] = []
  const listeners = new Set<(projection: OpenCodeHostProjection) => void>()
  const notify = () => { for (const listener of listeners) listener({ sessions, notifications: binding.get() }) }
  return {
    projection: () => ({ sessions, notifications: binding.get() }),
    teamsProjection: identities => projectOpenCodeTeamsProjection(sessions, binding.get(), identities),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refreshSessions: async directory => {
      sessions = await listOpenCodeSessions(client, directory)
      notify()
      return sessions
    },
    actions: {
      openSession: async (sessionId) => { await getOpenCodeSession(client, sessionId) },
      sendMessage: async (sessionId, payload) => { await sendOpenCodeMessage(client, sessionId, decodeOpenCodeSessionMessage(payload).text) },
      replyPermission: async (sessionId, permissionId, response) => { await replyOpenCodePermission(client, permissionId, sessionId, response) },
      acknowledgeNotification: notificationId => {
        binding.acknowledge(notificationId)
        notify()
      },
    },
  }
}

export function projectOpenCodeTeamsProjection(
  sessions: readonly OpenCodeSessionProjection[],
  notifications: OpenCodeNotificationStore,
  identities: readonly OpenCodeAgentIdentity[],
): OpenCodeTeamsProjection {
  const sessionOwner = new Map(identities.flatMap(identity => identity.sessionIds.map(sessionId => [sessionId, identity.agentId] as const)))
  const projectedSessions = sessions.flatMap(session => {
    const agentId = sessionOwner.get(session.id)
    return agentId === undefined ? [] : [{ ...session, agentId, running: true }]
  })
  return { agents: identities, sessions: projectedSessions, notifications }
}

export function projectOpenCodeNotifications(notifications: OpenCodeNotificationStore): readonly TeamsNotificationProjectionItem[] {
  return sortOpenCodeNotifications([...notifications.pending, ...notifications.processed]).map(notification => ({
    id: notificationIdFor(notification),
    sessionId: notification.sessionId,
    ...(notification.requestId === undefined ? {} : { requestId: notification.requestId }),
    interactive: notification.interactive,
    processed: notification.status === 'processed',
    priority: notification.priority === 'high' ? 'high' : 'medium',
    createdAt: notification.occurredAt,
  }))
}

export async function createOpenCodePluginRuntime(input: PluginInput, binding = createOpenCodeNotificationStoreBinding()): Promise<OpenCodePluginRuntime> {
  const facade = createOpenCodeHostFacade(input.client, binding)
  await facade.refreshSessions(input.directory)
  const hooks = registerOpenCodeHooks(notification => {
    binding.sink(notification)
    void facade.refreshSessions(input.directory)
  }) as Hooks
  return { facade, hooks }
}

const notificationSinks = new Set<OpenCodeNotificationSink>()

export function acknowledgeOpenCodeNotification(store: OpenCodeNotificationStore, notificationId: string): OpenCodeNotificationStore {
  const all = [...store.pending, ...store.processed]
  const target = all.find(item => notificationIdFor(item) === notificationId)
  if (target === undefined) throw new Error(`OpenCode notification not found: ${notificationId}`)
  return {
    pending: store.pending.filter(item => notificationIdFor(item) !== notificationId),
    processed: [...store.processed, { ...target, status: 'processed' }],
  }
}

export function createOpenCodeNotificationStoreBinding(initial: OpenCodeNotificationStore = { pending: [], processed: [] }): OpenCodeNotificationStoreBinding {
  let store = initial
  return {
    get: () => store,
    sink: notification => {
      if (notification.status === 'processed') {
        const id = notificationIdFor(notification)
        store = {
          pending: store.pending.filter(item => notificationIdFor(item) !== id),
          processed: [...store.processed, notification],
        }
        return
      }
      store = { pending: sortOpenCodeNotifications([...store.pending, notification]), processed: store.processed }
    },
    acknowledge: notificationId => { store = acknowledgeOpenCodeNotification(store, notificationId) },
  }
}

export function sortOpenCodeNotifications(notifications: readonly OpenCodeNotification[]): readonly OpenCodeNotification[] {
  return [...notifications].sort((left, right) => {
    const priority = Number(right.priority === 'high') - Number(left.priority === 'high')
    return priority || right.occurredAt.localeCompare(left.occurredAt)
  })
}

function notificationIdFor(notification: OpenCodeNotification): string {
  return `${notification.kind}:${notification.sessionId}:${notification.requestId ?? notification.occurredAt}`
}

export function subscribeOpenCodeNotifications(sink: OpenCodeNotificationSink): () => void {
  notificationSinks.add(sink)
  return () => { notificationSinks.delete(sink) }
}

function sessionIdFromEvent(event: OpenCodeEvent): string | undefined {
  const properties = event.properties
  if (typeof properties?.sessionID === 'string') return properties.sessionID
  if (typeof properties?.info !== 'object' || properties.info === null) return undefined
  const info = properties.info as Record<string, unknown>
  if (typeof info.sessionID === 'string') return info.sessionID
  return typeof info.id === 'string' ? info.id : undefined
}

function permissionIdFromEvent(event: OpenCodeEvent): string | undefined {
  const properties = event.properties
  if (typeof properties?.permissionID === 'string') return properties.permissionID
  if (typeof properties?.id === 'string') return properties.id
  return undefined
}

export function projectOpenCodeEvent(event: OpenCodeEvent): OpenCodeNotification | undefined {
  const properties = event.properties
  const sessionId = sessionIdFromEvent(event)
  if (sessionId === undefined) return undefined

  switch (event.type) {
    case 'session.created':
      return notification('session-created', sessionId, false)
    case 'session.updated':
      return notification('session-updated', sessionId, false)
    case 'session.deleted':
      return notification('session-deleted', sessionId, false)
    case 'session.status':
      return notification('session-status', sessionId, false)
    case 'message.updated':
      return notification('message-updated', sessionId, false)
    case 'permission.updated': {
      const requestId = permissionIdFromEvent(event)
      if (requestId === undefined) return undefined
      return { ...notification('permission-request', sessionId, true), requestId }
    }
    case 'permission.replied': {
      const requestId = permissionIdFromEvent(event)
      if (requestId === undefined) return undefined
      return { ...notification('permission-processed', sessionId, true, 'processed'), requestId }
    }
    default:
      return undefined
  }
}

function notification(kind: OpenCodeNotification['kind'], sessionId: string, interactive: boolean, status: OpenCodeNotification['status'] = 'pending'): OpenCodeNotification {
  return { source: 'opencode', kind, sessionId, interactive, status, priority: interactive ? 'high' : 'normal', occurredAt: new Date().toISOString() }
}

export function projectOpenCodePermission(
  permission: OpenCodePermissionInput,
): OpenCodeNotification {
  return {
    source: 'opencode',
    kind: 'permission-request',
    sessionId: permission.sessionID,
    requestId: permission.id,
    interactive: true,
    status: 'pending',
    priority: 'high',
    occurredAt: new Date().toISOString(),
  }
}

export function registerOpenCodeHooks(sink: OpenCodeNotificationSink): OpenCodeHooks {
  return {
    event: async ({ event }) => {
      const notification = projectOpenCodeEvent(event)
      if (notification !== undefined) sink(notification)
    },
    'permission.ask': async (permission) => {
      sink(projectOpenCodePermission(permission))
    },
  }
}

export type OpenCodePlugin = (input: PluginInput) => Promise<Hooks>

export function createTeamsOpenCodePlugin(sink: OpenCodeNotificationSink): OpenCodePlugin {
  return async () => registerOpenCodeHooks(sink)
}

export const TeamsOpenCodePluginWithNotifications: OpenCodePlugin = async input => {
  const binding = createOpenCodeNotificationStoreBinding()
  const hooks = registerOpenCodeHooks(notification => {
    binding.sink(notification)
    for (const sink of notificationSinks) sink(notification)
  }) as Hooks
  void input
  return {
    ...hooks,
    event: async eventInput => {
      await hooks.event?.(eventInput)
    },
    'permission.ask': async (permission, output) => {
      await hooks['permission.ask']?.(permission, output)
    },
  }
}

export const TeamsOpenCodePlugin = TeamsOpenCodePluginWithNotifications

export default {
  id: 'teams-opencode-adapter',
  server: TeamsOpenCodePlugin,
}
