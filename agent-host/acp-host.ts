import type { AuthenticatedAgent, JsonValue } from '../packages/shared/src/agent-services.ts'
import type {
  AcpChannelRef,
  AcpDelivery,
  AcpFault,
  AcpFrame,
  AcpIngress,
  AcpRpcId,
  HistoryRecord,
} from '../packages/shared/src/acp.ts'
import { AcpError, parseAcpFrame } from '../packages/shared/src/acp.ts'
import type {
  ConsolePermissionOption,
  ConsoleSessionEventView,
  OpenCodeStructuredError,
} from '../packages/shared/src/console-api.ts'
import type { EngineHandle } from '../packages/shared/src/engine.ts'
import type { AcpPolicySnapshot } from '../config/acp-policy.ts'
import type { AcpHistoryPort } from './acp-history.ts'

/**
 * Agent-host ACP owner: logical channels, RPC/callback correlation, Session
 * ownership, execution admission and execution-history semantics.
 *
 * Owner: agent-host. It consumes the frozen D00 contracts (`AcpFrame`,
 * `AcpFault`, `AcpError`, `parseAcpFrame`, `AcpDuplex`/`EngineHandle`,
 * `AcpPolicySnapshot`) and declares no second frame, fault, duplex, policy or
 * history-read type. `AcpIngress` is flat: a ref plus `frame`, never `{ ref }`.
 */

export type AcpDirection = 'to-engine' | 'from-engine'

/**
 * Injected D00 policy assertion (`config/acp-policy.ts#assertAcpAllowed`). The
 * host never compiles policy and never imports the config store at runtime.
 */
export type AcpPolicyAssert = (input: {
  readonly policy: AcpPolicySnapshot
  readonly direction: AcpDirection
  readonly frame: AcpFrame
}) => void

/**
 * One engine callback that awaits a controller reply, with the identity and the real option
 * set the controller needs (A2.6).
 *
 * `permissionId` is the id the controller received with the request, which is also the
 * address a reply must use. It is the Console-facing identity because it is the one the
 * controller can really see; the host keeps its own history record id separately as the
 * durable audit identity.
 */
export interface AcpPendingPermission {
  readonly ref: AcpChannelRef
  readonly sessionId: string
  readonly permissionId: string
  /** The engine's real choice set; empty when the engine offered no options. */
  readonly options: readonly ConsolePermissionOption[]
}

export interface AcpHost {
  open(input: {
    readonly ref: AcpChannelRef
    readonly principal: AuthenticatedAgent
    readonly policy: AcpPolicySnapshot
  }): Promise<void>
  receive(ingress: AcpIngress): Promise<void>
  /** Read and consume the channel's live deliveries after `afterSequence`. */
  read(ref: AcpChannelRef, afterSequence: number, limit: number): Promise<{
    readonly frames: readonly AcpDelivery[]
    readonly nextSequence: number
  }>
  close(ref: AcpChannelRef): Promise<void>
  /**
   * The engine permission callbacks awaiting a controller reply. The host is the A2.6
   * permission owner, so this is the only place that knows which callbacks are still open
   * and which options the engine really offered.
   */
  pendingPermissions(): readonly AcpPendingPermission[]
  /**
   * The host-facing ref of the channel that owns `sessionId`, or `undefined` when no open
   * channel owns it. A caller never invents a ref for a Session it does not own.
   */
  channelForSession(sessionId: string): AcpChannelRef | undefined
  /**
   * The Session ids an open channel really owns, in the order this host learned them.
   *
   * The host is the Session owner, so it is the only place that knows which engine Sessions
   * are still held by a live channel. This is a read of the host's own record, never a
   * second session source: a Session whose channel closed is not reported, and no title or
   * transcript is invented here.
   */
  openedSessions(): readonly string[]
  /**
   * The ordered Console events the open channels projected from real engine frames.
   *
   * The host is the one boundary every engine frame crosses, so it is the owner of this
   * projection: a Session that a channel no longer holds contributes no events, and the
   * buffer is cleared with the same `releaseSessions` lifecycle as its Session ids.
   *
   * `createAcpHost` always provides this projection. Legacy observability wrappers in
   * `network/` implement the same transport surface but are outside this module's lifetime,
   * so they may omit it; the publisher treats a missing source as an empty event set.
   */
  sessionEvents?(): readonly ConsoleSessionEventView[]
}

export interface CreateAcpHostInput {
  readonly handle: EngineHandle
  /**
   * The genuine successful `initialize` response captured once by the runtime
   * bootstrap as the sole reader before ownership transfer. The host serves it
   * to every channel under that channel's policy and never initializes the
   * child again.
   */
  readonly initializeResult: AcpFrame
  readonly policy: AcpPolicySnapshot
  readonly history: AcpHistoryPort
  readonly assertAllowed: AcpPolicyAssert
  /** Local Agent identity used for request history. Defaults to the engine instance. */
  readonly agentId?: string
  readonly maxDeliveryBacklog?: number
  /** Observable history-write failure; never carried inside an ACP payload. */
  readonly onHistoryFault?: (fault: AcpFault) => void
}

interface PendingRequest {
  readonly originalId: AcpRpcId
  readonly originalIdKey: string
  readonly channelKey: string
  readonly childId: string
  readonly method: string
  readonly sessionId?: string
  readonly recordId: string
  readonly frame: AcpFrame
}

interface PendingCallback {
  readonly engineId: AcpRpcId
  readonly outwardId: string
  readonly channelKey: string
  readonly sessionId?: string
  readonly method: string
  readonly recordId: string
  /** The engine's real permission choice set; absent when the engine offered none. */
  readonly permissionOptions?: readonly ConsolePermissionOption[]
}

interface ActivePrompt {
  readonly sessionId: string
  readonly userMessageId: string
  readonly assistantMessageId: string
  readonly assistantPartId: string
  readonly reasoningPartId: string
  text: string
  reasoning: string
  textObserved: boolean
  reasoningObserved: boolean
}

interface ChannelState {
  readonly key: string
  readonly ref: AcpChannelRef
  readonly principal: AuthenticatedAgent
  readonly policy: AcpPolicySnapshot
  readonly sessions: Set<string>
  readonly pendingRequests: Map<string, PendingRequest>
  readonly pendingCallbacks: Map<string, PendingCallback>
  deliveries: AcpDelivery[]
  nextSequence: number
  initialized: boolean
  closed: boolean
  /**
   * The prompts in flight per Session. One channel serves many Sessions, so admission is
   * per Session: a prompt on Session B must not conflict with a pending prompt on Session A.
   */
  readonly activePrompts: Map<string, ActivePrompt>
  /**
   * Session admissions reserved before the first asynchronous boundary. A prompt holds this
   * reservation until its durable request append establishes the `ActivePrompt` entry.
   */
  readonly promptAdmissions: Set<string>
  events: ConsoleSessionEventView[]
}

type HistoryInput = Omit<HistoryRecord, 'recordId' | 'sequence'>

const DEFAULT_MAX_DELIVERY_BACKLOG = 1024
const MAX_READ_LIMIT = 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AcpError('INVALID_ACP_FRAME', `${label} must be a non-empty string`)
  }
  return value
}

/** Canonical correlation key for a JSON-RPC id, preserving `string` vs `number`. */
export function rpcIdKey(id: AcpRpcId): string {
  return `${typeof id}:${String(id)}`
}

function methodOf(frame: AcpFrame): string | undefined {
  return typeof frame.method === 'string' && frame.method.length > 0 ? frame.method : undefined
}

function isRequestFrame(frame: AcpFrame): boolean {
  return methodOf(frame) !== undefined && Object.hasOwn(frame, 'id')
}

function isNotificationFrame(frame: AcpFrame): boolean {
  return methodOf(frame) !== undefined && !Object.hasOwn(frame, 'id')
}

function isResponseFrame(frame: AcpFrame): boolean {
  return methodOf(frame) === undefined && Object.hasOwn(frame, 'id')
}

function sessionIdOf(frame: AcpFrame): string | undefined {
  const params = frame.params
  if (!isRecord(params)) return undefined
  const sessionId = params.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

function resultSessionId(frame: AcpFrame): string | undefined {
  const result = frame.result
  if (!isRecord(result)) return undefined
  const sessionId = result.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(value)) output[key] = cloneJson(value[key] as JsonValue)
    return output
  }
  return value
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The user text a `session/prompt` carried, when every prompt block is text. */
function promptText(frame: AcpFrame): string | undefined {
  if (!isRecord(frame.params)) return undefined
  const prompt = frame.params.prompt
  if (!Array.isArray(prompt)) return undefined
  const texts: string[] = []
  for (const block of prompt) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return undefined
    texts.push(block.text)
  }
  return texts.length === 0 ? undefined : texts.join('')
}

/** The engine's own permission subject when its callback carries one; never invented. */
function permissionTitle(frame: AcpFrame): string | undefined {
  if (!isRecord(frame.params)) return undefined
  const toolCall = frame.params.toolCall
  return isRecord(toolCall) ? stringField(toolCall.title) : undefined
}

/**
 * Extract the text of an ACP `ToolCallContent` array. ACP wraps every block as
 * `{ type: 'content', content: { type: 'text' | 'error', text: string } }`. Any other shape
 * is a protocol fault at this owning boundary, never an empty successful result.
 */
function extractToolCallContentText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new AcpError('INVALID_ACP_FRAME', 'tool_call_update content must be an array')
  }
  if (value.length === 0) return undefined
  const texts: string[] = []
  for (const block of value) {
    if (!isRecord(block) || block.type !== 'content' || !isRecord(block.content)) {
      throw new AcpError('INVALID_ACP_FRAME', 'unsupported or malformed tool_call_update content block')
    }
    const content = block.content
    if ((content.type !== 'text' && content.type !== 'error') || typeof content.text !== 'string') {
      throw new AcpError('INVALID_ACP_FRAME', 'unsupported or malformed tool_call_update content block')
    }
    texts.push(content.text)
  }
  return texts.join('')
}

/** Preserve the real ACP error facts in the frozen Console structured-error shape. */
function structuredErrorOf(frame: AcpFrame): OpenCodeStructuredError {
  const error = isRecord(frame.error) ? frame.error : {}
  const code = typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : 'UPSTREAM_ERROR'
  return {
    name: 'UnknownError',
    data: { code, message: typeof error.message === 'string' ? error.message : 'engine prompt failed' },
  }
}

/** The operator's decision, read from the engine option set the callback really offered. */
function permissionDecisionOf(
  result: JsonValue | undefined,
  options: readonly ConsolePermissionOption[] | undefined,
): 'once' | 'always' | 'reject' | 'unknown' {
  if (!isRecord(result) || !isRecord(result.outcome) || result.outcome.outcome !== 'selected') return 'unknown'
  const optionId = stringField(result.outcome.optionId)
  if (optionId === undefined) return 'unknown'
  return options?.find(candidate => candidate.optionId === optionId)?.kind ?? 'unknown'
}

function upsertEvent(events: ConsoleSessionEventView[], event: ConsoleSessionEventView): void {
  const index = events.findIndex(candidate => candidate.eventId === event.eventId)
  if (index < 0) events.push(event)
  else events[index] = event
}

type ToolEvent = Extract<ConsoleSessionEventView, { readonly kind: 'tool' }>

/**
 * Derive a tool row identity from its owning Session, prompt message and the engine call
 * id. The call id alone is not channel-unique: two Sessions or two prompts may reuse it.
 * The public `callId` keeps the engine's original value; only this derived id is scoped.
 */
function toolProjectionId(input: {
  readonly sessionId: string
  readonly messageId: string
  readonly callId: string
}): string {
  return `tool-${input.sessionId}-${input.messageId}-${input.callId}`
}

/**
 * Project one engine `tool_call`/`tool_call_update` into the frozen Console tool union.
 * The update's own identity and fields win; a later update that carries only a status
 * reuses the tool and input the earlier frame really reported.
 */
function projectToolEvent(input: {
  readonly agentId: string
  readonly sessionId: string
  readonly messageId: string
  readonly occurredAt: string
  readonly update: Record<string, unknown>
  readonly previous?: ToolEvent
}): ToolEvent | undefined {
  const callId = stringField(input.update.toolCallId) ?? input.previous?.callId
  if (callId === undefined) return undefined
  const projectionId = toolProjectionId({ sessionId: input.sessionId, messageId: input.messageId, callId })
  const tool = stringField(input.update.title) ?? input.previous?.tool ?? stringField(input.update.kind) ?? 'tool'
  const partId = input.previous?.partId ?? projectionId
  const toolInput = cloneJson((input.update.rawInput ?? input.update.input ?? input.previous?.input ?? {}) as JsonValue)
  const base = {
    eventId: projectionId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
    kind: 'tool' as const,
    messageId: input.messageId,
    partId,
    callId,
    tool,
    input: toolInput,
  }
  const metadata = isRecord(input.update.metadata) ? input.update.metadata as JsonValue : undefined
  const status = stringField(input.update.status) ?? (input.previous === undefined ? 'pending' : input.previous.state)
  switch (status) {
    case 'pending':
      return { ...base, state: 'pending', raw: typeof input.update.rawInput === 'string' ? input.update.rawInput : JSON.stringify(toolInput) }
    case 'in_progress':
    case 'running':
      return {
        ...base,
        state: 'running',
        ...(stringField(input.update.title) === undefined ? {} : { title: stringField(input.update.title) }),
        ...(metadata === undefined ? {} : { metadata }),
      }
    case 'completed': {
      const output = extractToolCallContentText(input.update.content)
      if (output === undefined) {
        throw new AcpError('INVALID_ACP_FRAME', 'completed tool_call_update requires ToolCallContent text')
      }
      return {
        ...base,
        state: 'completed',
        output,
        title: stringField(input.update.title) ?? (input.previous?.state === 'completed' ? input.previous.title : tool),
        metadata: metadata ?? {},
        ...(Array.isArray(input.update.attachments) ? { attachments: input.update.attachments as readonly JsonValue[] } : {}),
      }
    }
    case 'failed':
    case 'error': {
      const error = extractToolCallContentText(input.update.content) ?? stringField(input.update.error)
      if (error === undefined) {
        throw new AcpError('INVALID_ACP_FRAME', 'failed tool_call_update requires error content')
      }
      return {
        ...base,
        state: 'error',
        error,
        ...(metadata === undefined ? {} : { metadata }),
      }
    }
    default: {
      if (input.previous !== undefined) return input.previous
      return { ...base, state: 'pending', raw: JSON.stringify(toolInput) }
    }
  }
}

/**
 * Project the engine's declared capabilities under the channel policy. A
 * denied capability becomes `false` in the served result; the declaration is
 * the policy's projection, never a second editable source.
 */
function projectCapabilityNode(node: Record<string, unknown>, pointer: string, policy: AcpPolicySnapshot): void {
  for (const key of Object.keys(node)) {
    const value = node[key]
    const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1')
    const childPointer = `${pointer}/${escaped}`
    if (value === true) {
      if (!policy.effective.includes(`capability:${childPointer}`)) node[key] = false
    } else if (isRecord(value)) {
      projectCapabilityNode(value, childPointer, policy)
    }
  }
}

function projectInitializeResult(frame: AcpFrame, policy: AcpPolicySnapshot): AcpFrame {
  const result = frame.result
  if (!isRecord(result)) return frame
  const cloned = cloneJson(result as JsonValue)
  if (!isRecord(cloned)) return frame
  const agentCapabilities = cloned.agentCapabilities
  if (isRecord(agentCapabilities)) projectCapabilityNode(agentCapabilities, '', policy)
  return { ...frame, result: cloned }
}

function faultFrom(error: unknown, fallback: AcpFault['code']): AcpFault {
  if (error instanceof AcpError) return error.toFault()
  return { code: fallback, message: error instanceof Error ? error.message : 'ACP operation failed' }
}

function toAcpError(error: unknown, fallback: AcpFault['code']): AcpError {
  if (error instanceof AcpError) return error
  return new AcpError(fallback, error instanceof Error ? error.message : 'ACP operation failed')
}

function faultData(fault: AcpFault): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = { code: fault.code, message: fault.message }
  if (fault.detail !== undefined) output.detail = fault.detail
  return output
}

/**
 * The one ACP JSON-RPC error envelope. Exported so the runtime serve transport
 * answers a frame the host rejects with the same envelope instead of declaring
 * a second one.
 */
export function rpcErrorFrame(id: AcpRpcId, fault: AcpFault): AcpFrame {
  return { jsonrpc: '2.0', id, error: { code: -32000, message: fault.message, data: faultData(fault) } }
}

/**
 * The ACP `session/request_permission` option kinds, in the exact vocabulary the engine
 * sends. Each maps onto the frozen Console decision vocabulary without inventing a value.
 */
const ACP_PERMISSION_OPTION_KINDS: Readonly<Record<string, ConsolePermissionOption['kind']>> = {
  allow_once: 'once',
  allow_always: 'always',
  reject_once: 'reject',
  reject_always: 'reject',
}

function permissionParams(frame: AcpFrame): Record<string, unknown> {
  const params = frame.params
  if (!isRecord(params)) throw new AcpError('INVALID_ACP_FRAME', 'session/request_permission requires object params')
  return params
}

/**
 * Engine-side projection of the real engine-supplied permission choice set (A2.6).
 *
 * The option set is read verbatim from the engine's own `session/request_permission`
 * params: this function never mints an option the engine did not offer, and it returns
 * `undefined` when the engine offered none (the field is additive and stays absent). A
 * malformed option fails explicitly at this owning boundary instead of reaching a
 * controller as an unactionable or ambiguous choice.
 */
export function projectPermissionOptions(frame: AcpFrame): readonly ConsolePermissionOption[] | undefined {
  const raw = permissionParams(frame).options
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new AcpError('INVALID_ACP_FRAME', 'session/request_permission options must be an array')
  if (raw.length === 0) return undefined
  const seen = new Set<string>()
  return raw.map(entry => {
    if (!isRecord(entry)) throw new AcpError('INVALID_ACP_FRAME', 'session/request_permission option must be an object')
    const optionId = requireText(entry.optionId, 'permission option.optionId')
    const name = requireText(entry.name, 'permission option.name')
    const kind = typeof entry.kind === 'string' ? ACP_PERMISSION_OPTION_KINDS[entry.kind] : undefined
    if (kind === undefined) {
      throw new AcpError('INVALID_ACP_FRAME', `permission option.kind ${String(entry.kind)} is not an ACP permission option kind`)
    }
    if (seen.has(optionId)) throw new AcpError('INVALID_ACP_FRAME', `permission optionId ${optionId} is offered twice`)
    seen.add(optionId)
    return { optionId, name, kind }
  })
}

/**
 * Adjudicates one controller reply against the engine's real option set (A2.6).
 *
 * The engine is answered with a selection it really offered. A selection the engine never
 * offered, a selection when the engine offered no options, or an unknown outcome fails
 * typed; a missing or stale callback never becomes an approval and the host never supplies
 * an `optionId` of its own.
 */
export function adjudicatePermissionReply(
  result: unknown,
  options: readonly ConsolePermissionOption[] | undefined,
): { readonly outcome: { readonly outcome: 'selected'; readonly optionId: string } | { readonly outcome: 'cancelled' } } {
  if (!isRecord(result)) throw new AcpError('INVALID_ACP_FRAME', 'permission reply result must be an object')
  const outcome = result.outcome
  if (!isRecord(outcome)) throw new AcpError('INVALID_ACP_FRAME', 'permission reply result requires an outcome object')
  if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } }
  if (outcome.outcome !== 'selected') {
    throw new AcpError('INVALID_ACP_FRAME', `permission reply outcome ${String(outcome.outcome)} is not selected or cancelled`)
  }
  const optionId = requireText(outcome.optionId, 'permission reply outcome.optionId')
  if (options === undefined || !options.some(option => option.optionId === optionId)) {
    throw new AcpError('INVALID_ACP_FRAME',
      `permission reply optionId ${optionId} is not an option the engine offered for this callback`)
  }
  return { outcome: { outcome: 'selected', optionId } }
}

function assertRefShape(ref: unknown): asserts ref is AcpChannelRef {
  if (!isRecord(ref)) throw new AcpError('INVALID_ACP_FRAME', 'ACP channel ref must be an object')
  requireText(ref.connectionId, 'ref.connectionId')
  requireText(ref.channelId, 'ref.channelId')
  requireText(ref.engineInstanceId, 'ref.engineInstanceId')
  if (!Number.isSafeInteger(ref.targetGeneration) || (ref.targetGeneration as number) < 1) {
    throw new AcpError('INVALID_ACP_FRAME', 'ref.targetGeneration must be a positive safe integer')
  }
}

function assertPrincipal(principal: unknown): asserts principal is AuthenticatedAgent {
  if (!isRecord(principal)) throw new AcpError('AUTHENTICATION_REQUIRED', 'ACP channel principal is required')
  requireText(principal.accountId, 'principal.accountId')
  requireText(principal.scopeId, 'principal.scopeId')
  requireText(principal.agentId, 'principal.agentId')
}

function assertPolicyShape(policy: unknown): asserts policy is AcpPolicySnapshot {
  if (!isRecord(policy)) throw new AcpError('UNSUPPORTED_POLICY', 'ACP policy snapshot is required')
  requireText(policy.revision, 'policy.revision')
  requireText(policy.engineInstanceId, 'policy.engineInstanceId')
  for (const [label, value] of [
    ['policy.supported', policy.supported],
    ['policy.effective', policy.effective],
    ['policy.denied', policy.denied],
  ] as const) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
      throw new AcpError('UNSUPPORTED_POLICY', `${label} must be an array of non-empty strings`)
    }
  }
}

function channelKeyOf(ref: AcpChannelRef): string {
  return `${ref.engineInstanceId}\u0000${ref.targetGeneration}\u0000${ref.connectionId}\u0000${ref.channelId}`
}

export function createAcpHost(input: CreateAcpHostInput): AcpHost {
  if (input === null || typeof input !== 'object') {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'createAcpHost input is required')
  }
  const engineInstanceId = requireText(input.handle?.engineInstanceId, 'handle.engineInstanceId')
  if (!Number.isSafeInteger(input.handle?.targetGeneration) || input.handle.targetGeneration < 1) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'handle.targetGeneration must be a positive safe integer')
  }
  if (typeof input.handle?.acp?.read !== 'function' || typeof input.handle.acp.send !== 'function') {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'handle.acp must be an AcpDuplex')
  }
  const initializeResult = parseAcpFrame(input.initializeResult)
  if (Object.hasOwn(initializeResult, 'error') || !Object.hasOwn(initializeResult, 'result')) {
    throw new AcpError('ENGINE_UNAVAILABLE', 'a genuine successful initialize result is required before host handoff')
  }
  assertPolicyShape(input.policy)
  if (input.policy.engineInstanceId !== engineInstanceId) {
    throw new AcpError('STALE_GENERATION', 'host policy does not belong to the initialized engine instance')
  }
  if (typeof input.assertAllowed !== 'function') {
    throw new AcpError('UNSUPPORTED_POLICY', 'an injected ACP policy assertion is required')
  }
  if (typeof input.history?.append !== 'function') {
    throw new AcpError('HISTORY_UNAVAILABLE', 'an injected ACP history write port is required')
  }
  const maxDeliveryBacklog = input.maxDeliveryBacklog ?? DEFAULT_MAX_DELIVERY_BACKLOG
  if (!Number.isSafeInteger(maxDeliveryBacklog) || maxDeliveryBacklog < 1) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'maxDeliveryBacklog must be a positive safe integer')
  }
  const localAgentId = input.agentId ?? engineInstanceId

  const channels = new Map<string, ChannelState>()
  const sessionOwners = new Map<string, string>()
  const childRequests = new Map<string, PendingRequest>()
  const outwardCallbacks = new Map<string, PendingCallback>()
  let childCounter = 0
  let callbackCounter = 0
  let engineEnded = false

  const historyEntry = (
    event: string,
    extras: Partial<Omit<HistoryInput, 'agentId' | 'occurredAt' | 'kind' | 'event'>> = {},
  ): HistoryInput => ({
    agentId: localAgentId,
    occurredAt: new Date().toISOString(),
    kind: 'request',
    event,
    ...extras,
  })

  /** Append that fails the operation: used before any engine effect. */
  const appendRecord = async (record: HistoryInput): Promise<HistoryRecord> => {
    try {
      return await input.history.append(record)
    } catch (cause) {
      throw new AcpError('HISTORY_UNAVAILABLE', cause instanceof Error ? cause.message : 'ACP history append failed')
    }
  }

  /** Append after an effect already happened: report the fault, never block live behavior. */
  const safeAppend = async (record: HistoryInput): Promise<void> => {
    try {
      await input.history.append(record)
    } catch (cause) {
      input.onHistoryFault?.(faultFrom(cause, 'HISTORY_UNAVAILABLE'))
    }
  }

  const channelBySession = (sessionId: string): ChannelState | undefined => {
    const key = sessionOwners.get(sessionId)
    return key === undefined ? undefined : channels.get(key)
  }

  /** Bounded live delivery. Returns false when the frame could not be delivered. */
  const enqueue = (channel: ChannelState, frame: AcpFrame): boolean => {
    if (channel.deliveries.length >= maxDeliveryBacklog) {
      void safeAppend(historyEntry('delivery.overflow', {
        connectionId: channel.ref.connectionId,
        channelId: channel.ref.channelId,
        engineInstanceId,
        frame,
        outcome: 'unknown',
        error: { code: 'CONFLICT', message: 'ACP live delivery backlog is full' },
      }))
      return false
    }
    channel.deliveries.push({ ...channel.ref, frame, sequence: channel.nextSequence })
    channel.nextSequence += 1
    return true
  }

  const assertSessionOwner = (channel: ChannelState, sessionId: string): void => {
    if (sessionOwners.get(sessionId) !== channel.key) {
      throw new AcpError('SESSION_OWNERSHIP_CONFLICT', `session ${sessionId} is not owned by this channel`)
    }
  }

  const requireSessionId = (frame: AcpFrame): string => {
    const sessionId = sessionIdOf(frame)
    if (sessionId === undefined) throw new AcpError('INVALID_ACP_FRAME', 'ACP session method requires params.sessionId')
    return sessionId
  }

  const nextChildId = (): string => {
    childCounter += 1
    return `acp-child-${engineInstanceId}-${childCounter}`
  }

  const nextCallbackId = (): string => {
    callbackCounter += 1
    return `acp-callback-${engineInstanceId}-${callbackCounter}`
  }

  const removePendingRequest = (pending: PendingRequest): void => {
    channels.get(pending.channelKey)?.pendingRequests.delete(pending.originalIdKey)
    childRequests.delete(rpcIdKey(pending.childId))
  }

  const respondCallbackError = async (engineId: AcpRpcId, fault: AcpFault): Promise<void> => {
    if (engineEnded) return
    try {
      await input.handle.acp.send({
        jsonrpc: '2.0',
        id: engineId,
        error: { code: -32601, message: fault.message, data: faultData(fault) },
      })
    } catch {
      // The child is gone; the callback obligation stays an explicit unknown.
    }
  }

  /**
   * A permission callback with no controller is answered with the ACP
   * cancellation outcome. The host never converts "nobody replied" into an
   * approval.
   */
  const sendPermissionCancellation = async (engineId: AcpRpcId): Promise<void> => {
    if (engineEnded) return
    try {
      await input.handle.acp.send({ jsonrpc: '2.0', id: engineId, result: { outcome: { outcome: 'cancelled' } } })
    } catch {
      // No controller and no child: the callback remains an explicit unknown.
    }
  }

  const settlePendingCallbacks = async (channel: ChannelState, reason: string): Promise<void> => {
    const pending = [...channel.pendingCallbacks.values()]
    channel.pendingCallbacks.clear()
    for (const item of pending) {
      outwardCallbacks.delete(rpcIdKey(item.outwardId))
      await safeAppend(historyEntry('callback.unknown', {
        connectionId: channel.ref.connectionId,
        channelId: channel.ref.channelId,
        engineInstanceId,
        sessionId: item.sessionId,
        requestRecordId: item.recordId,
        outcome: 'unknown',
        error: { code: 'CALLBACK_UNAVAILABLE', message: `${reason} before a callback reply` },
      }))
      if (!engineEnded) {
        if (item.method === 'session/request_permission') await sendPermissionCancellation(item.engineId)
        else await respondCallbackError(item.engineId, {
          code: 'CALLBACK_UNAVAILABLE',
          message: `${reason} before a callback reply`,
        })
      }
    }
  }

  const settlePendingRequests = async (channel: ChannelState, reason: string): Promise<void> => {
    const pending = [...channel.pendingRequests.values()]
    for (const item of pending) {
      removePendingRequest(item)
      await safeAppend(historyEntry('result.unknown', {
        connectionId: channel.ref.connectionId,
        channelId: channel.ref.channelId,
        engineInstanceId,
        sessionId: item.sessionId,
        requestRecordId: item.recordId,
        frame: item.frame,
        outcome: 'unknown',
        error: { code: 'RESULT_UNKNOWN', message: `${reason} before a result` },
      }))
      enqueue(channel, rpcErrorFrame(item.originalId, { code: 'RESULT_UNKNOWN', message: `${reason} before a result` }))
    }
  }

  const releaseSessions = (channel: ChannelState): void => {
    for (const sessionId of channel.sessions) sessionOwners.delete(sessionId)
    channel.sessions.clear()
    // The projection buffer belongs to the Sessions this channel held, so it leaves with
    // them; a later channel can never inherit another channel's history.
    channel.events.length = 0
    // The prompts in flight are owned by the Sessions this channel held, so they leave with
    // them; a fresh channel starts with none.
    channel.activePrompts.clear()
    channel.promptAdmissions.clear()
  }

  const onEngineEnd = (reason: string): void => {
    if (engineEnded) return
    engineEnded = true
    childRequests.clear()
    outwardCallbacks.clear()
    for (const channel of channels.values()) {
      if (channel.closed) continue
      channel.closed = true
      void settlePendingRequests(channel, `engine ${reason}`)
      for (const item of [...channel.pendingCallbacks.values()]) {
        void safeAppend(historyEntry('callback.unknown', {
          connectionId: channel.ref.connectionId,
          channelId: channel.ref.channelId,
          engineInstanceId,
          sessionId: item.sessionId,
          requestRecordId: item.recordId,
          outcome: 'unknown',
          error: { code: 'CALLBACK_UNAVAILABLE', message: `engine ${reason} before a callback reply` },
        }))
      }
      channel.pendingCallbacks.clear()
      releaseSessions(channel)
    }
  }

  const handleInitialize = async (channel: ChannelState, frame: AcpFrame): Promise<void> => {
    if (channel.initialized) throw new AcpError('CONFLICT', 'ACP initialize has already completed for this channel')
    input.assertAllowed({ policy: channel.policy, direction: 'to-engine', frame })
    await appendRecord(historyEntry('initialize', {
      connectionId: channel.ref.connectionId,
      channelId: channel.ref.channelId,
      engineInstanceId,
      frame,
    }))
    channel.initialized = true
    enqueue(channel, { ...projectInitializeResult(initializeResult, channel.policy), id: frame.id as AcpRpcId })
  }

  const dispatchToEngine = async (
    channel: ChannelState,
    frame: AcpFrame,
    onDispatched?: (entry: HistoryRecord) => void,
  ): Promise<void> => {
    const method = methodOf(frame)
    if (method === undefined) throw new AcpError('INVALID_ACP_FRAME', 'ACP dispatch requires a method')
    const originalId = frame.id as AcpRpcId
    const originalIdKey = rpcIdKey(originalId)
    if (channel.pendingRequests.has(originalIdKey)) {
      throw new AcpError('CONFLICT', `pending ACP request id ${String(originalId)} cannot be reused`)
    }
    if (engineEnded) throw new AcpError('ENGINE_UNAVAILABLE', 'ACP engine is not available')
    const childId = nextChildId()
    const sessionId = sessionIdOf(frame)
    const entry = await appendRecord(historyEntry('request.dispatched', {
      connectionId: channel.ref.connectionId,
      channelId: channel.ref.channelId,
      engineInstanceId,
      sessionId,
      frame,
    }))
    // The caller records its own projection row before the engine sees the frame, so a fast
    // engine response can never be attributed to a prompt whose identity is not set yet.
    onDispatched?.(entry)
    const pending: PendingRequest = {
      originalId,
      originalIdKey,
      channelKey: channel.key,
      childId,
      method,
      sessionId,
      recordId: entry.recordId,
      frame,
    }
    channel.pendingRequests.set(originalIdKey, pending)
    childRequests.set(rpcIdKey(childId), pending)
    try {
      await input.handle.acp.send({ ...frame, id: childId })
    } catch (cause) {
      removePendingRequest(pending)
      await safeAppend(historyEntry('request.send.failed', {
        connectionId: channel.ref.connectionId,
        channelId: channel.ref.channelId,
        engineInstanceId,
        sessionId,
        frame,
        outcome: 'unknown',
        error: faultFrom(cause, 'ENGINE_UNAVAILABLE'),
      }))
      throw toAcpError(cause, 'ENGINE_UNAVAILABLE')
    }
  }

  const handlePrompt = async (channel: ChannelState, frame: AcpFrame): Promise<void> => {
    const sessionId = requireSessionId(frame)
    assertSessionOwner(channel, sessionId)
    // Admission is reserved before any await. `dispatchToEngine` awaits the durable request
    // append before it can establish the in-flight prompt, so two overlapping prompts for
    // one Session must be rejected from this synchronous reservation instead of both passing
    // the same check. Prompts on other Sessions remain independent.
    if (channel.activePrompts.has(sessionId) || channel.promptAdmissions.has(sessionId)) {
      throw new AcpError('CONFLICT', `session ${sessionId} already has a prompt in flight`)
    }
    channel.promptAdmissions.add(sessionId)
    const dispatchedEventIds: string[] = []
    try {
      await dispatchToEngine(channel, frame, entry => {
        const userMessageId = `msg-${entry.recordId}`
        const assistantMessageId = `msg-asst-${entry.recordId}`
        const occurredAt = new Date().toISOString()
        const prompt: ActivePrompt = {
          sessionId,
          userMessageId,
          assistantMessageId,
          assistantPartId: `part-asst-${entry.recordId}`,
          reasoningPartId: `part-reasoning-${entry.recordId}`,
          text: '',
          reasoning: '',
          textObserved: false,
          reasoningObserved: false,
        }
        channel.activePrompts.set(sessionId, prompt)
        channel.promptAdmissions.delete(sessionId)
        const userEventId = `evt-user-${entry.recordId}`
        channel.events.push({
          eventId: userEventId,
          agentId: localAgentId,
          sessionId,
          occurredAt,
          kind: 'message',
          state: 'completed',
          messageId: userMessageId,
          role: 'user',
        })
        dispatchedEventIds.push(userEventId)
        const text = promptText(frame)
        if (text !== undefined) {
          const userPartEventId = `evt-part-user-${entry.recordId}`
          channel.events.push({
            eventId: userPartEventId,
            agentId: localAgentId,
            sessionId,
            occurredAt,
            kind: 'part',
            state: 'completed',
            messageId: userMessageId,
            partId: `part-user-${entry.recordId}`,
            partType: 'text',
            text,
          })
          dispatchedEventIds.push(userPartEventId)
        }
      })
    } catch (cause) {
      // Roll back only the rows this dispatch created. Another Session can append tool,
      // permission or final events while this dispatch is in flight, and those rows must
      // never be removed by an unrelated failure.
      for (const eventId of dispatchedEventIds) {
        const index = channel.events.findIndex(event => event.eventId === eventId)
        if (index >= 0) channel.events.splice(index, 1)
      }
      channel.activePrompts.delete(sessionId)
      channel.promptAdmissions.delete(sessionId)
      throw cause
    }
  }

  const handleSessionAdoption = async (channel: ChannelState, frame: AcpFrame): Promise<void> => {
    assertSessionOwner(channel, requireSessionId(frame))
    await dispatchToEngine(channel, frame)
  }

  const receiveClientRequest = async (channel: ChannelState, frame: AcpFrame): Promise<void> => {
    const method = methodOf(frame)
    if (method === undefined) throw new AcpError('INVALID_ACP_FRAME', 'ACP request requires a method')
    if (method === 'initialize') {
      await handleInitialize(channel, frame)
      return
    }
    if (!channel.initialized) throw new AcpError('CONFLICT', 'ACP initialize must precede other channel traffic')
    input.assertAllowed({ policy: channel.policy, direction: 'to-engine', frame })
    if (method === 'session/load' || method === 'session/resume') {
      await handleSessionAdoption(channel, frame)
      return
    }
    if (method === 'session/prompt') {
      await handlePrompt(channel, frame)
      return
    }
    const sessionId = sessionIdOf(frame)
    if (sessionId !== undefined && method !== 'session/new') {
      assertSessionOwner(channel, sessionId)
    }
    await dispatchToEngine(channel, frame)
  }

  const receiveClientNotification = async (channel: ChannelState, frame: AcpFrame): Promise<void> => {
    if (!channel.initialized) throw new AcpError('CONFLICT', 'ACP initialize must precede other channel traffic')
    input.assertAllowed({ policy: channel.policy, direction: 'to-engine', frame })
    const method = methodOf(frame)
    if (method === 'initialize') {
      // `initialize` is a request whose only legitimate answer is the captured
      // bootstrap result. A notification form cannot be answered, so it must
      // never reach the engine as a second initialize.
      throw new AcpError('UNSUPPORTED_METHOD', 'ACP initialize must be a request and cannot be sent as a notification')
    }
    const sessionId = sessionIdOf(frame)
    if (sessionId !== undefined) assertSessionOwner(channel, sessionId)
    if (engineEnded) throw new AcpError('ENGINE_UNAVAILABLE', 'ACP engine is not available')

    if (method === 'session/cancel') {
      // A cancel request is recorded separately from the prompt's terminal
      // result; only the engine result confirms the prompt ended.
      await appendRecord(historyEntry('cancel.requested', {
        connectionId: channel.ref.connectionId,
        channelId: channel.ref.channelId,
        engineInstanceId,
        sessionId,
        frame,
      }))
      try {
        await input.handle.acp.send(frame)
      } catch (cause) {
        throw toAcpError(cause, 'ENGINE_UNAVAILABLE')
      }
      return
    }

    await appendRecord(historyEntry('notification.dispatched', {
      connectionId: channel.ref.connectionId,
      channelId: channel.ref.channelId,
      engineInstanceId,
      sessionId,
      frame,
    }))
    try {
      await input.handle.acp.send(frame)
    } catch (cause) {
      throw toAcpError(cause, 'ENGINE_UNAVAILABLE')
    }
  }

  const receiveClientResponse = async (channel: ChannelState, frame: AcpFrame): Promise<void> => {
    const id = frame.id as AcpRpcId
    const idKey = rpcIdKey(id)
    const pending = outwardCallbacks.get(idKey)
    if (pending === undefined) {
      throw new AcpError('CALLBACK_UNAVAILABLE', 'no pending engine callback matches this response id')
    }
    if (pending.channelKey !== channel.key) {
      throw new AcpError('SESSION_OWNERSHIP_CONFLICT', 'callback response belongs to another channel')
    }
    // The engine's real option set adjudicates the controller's selection (A2.6). A reply
    // that selects an option the engine never offered, or that selects anything while the
    // engine offered no options, fails typed before the pending callback is consumed, so a
    // rejected reply never becomes an approval and the callback stays answerable. The
    // refusal is recorded as one durable callback.denied fact instead of being dropped.
    let delivered = frame
    if (pending.method === 'session/request_permission' && Object.hasOwn(frame, 'result')) {
      try {
        delivered = { ...frame, result: adjudicatePermissionReply(frame.result, pending.permissionOptions) as JsonValue }
      } catch (cause) {
        await safeAppend(historyEntry('callback.denied', {
          connectionId: channel.ref.connectionId,
          channelId: channel.ref.channelId,
          engineInstanceId,
          sessionId: pending.sessionId,
          requestRecordId: pending.recordId,
          frame,
          outcome: 'denied',
          error: faultFrom(cause, 'CALLBACK_UNAVAILABLE'),
        }))
        throw cause
      }
    }
    outwardCallbacks.delete(idKey)
    channel.pendingCallbacks.delete(idKey)
    if (pending.method === 'session/request_permission' && pending.sessionId !== undefined) {
      const pendingEvent = channel.events.find(event =>
        event.kind === 'permission' && event.state === 'pending' && event.permissionId === pending.outwardId)
      if (pendingEvent !== undefined) {
        upsertEvent(channel.events, {
          eventId: pendingEvent.eventId,
          agentId: pendingEvent.agentId,
          sessionId: pendingEvent.sessionId,
          ...(pendingEvent.occurredAt === undefined ? {} : { occurredAt: pendingEvent.occurredAt }),
          kind: 'permission',
          state: 'resolved',
          permissionId: pending.outwardId,
          decision: permissionDecisionOf(delivered.result, pending.permissionOptions),
        })
      }
    }
    await safeAppend(historyEntry('callback.reply', {
      connectionId: channel.ref.connectionId,
      channelId: channel.ref.channelId,
      engineInstanceId,
      sessionId: pending.sessionId,
      requestRecordId: pending.recordId,
      frame: delivered,
    }))
    if (engineEnded) throw new AcpError('ENGINE_UNAVAILABLE', 'ACP engine is not available')
    try {
      await input.handle.acp.send({ ...delivered, id: pending.engineId })
    } catch (cause) {
      await safeAppend(historyEntry('callback.send.failed', {
        connectionId: channel.ref.connectionId,
        channelId: channel.ref.channelId,
        engineInstanceId,
        sessionId: pending.sessionId,
        requestRecordId: pending.recordId,
        frame: delivered,
        outcome: 'unknown',
        error: faultFrom(cause, 'ENGINE_UNAVAILABLE'),
      }))
      throw toAcpError(cause, 'ENGINE_UNAVAILABLE')
    }
  }

  const handleEngineResponse = async (frame: AcpFrame): Promise<void> => {
    const id = frame.id as AcpRpcId
    const pending = childRequests.get(rpcIdKey(id))
    if (pending === undefined) {
      await safeAppend(historyEntry('result.unmatched', { engineInstanceId, frame, outcome: 'unknown' }))
      return
    }
    removePendingRequest(pending)
    const channel = channels.get(pending.channelKey)
    if (channel === undefined) {
      await safeAppend(historyEntry('result.channel-missing', {
        engineInstanceId,
        sessionId: pending.sessionId,
        requestRecordId: pending.recordId,
        frame,
        outcome: 'unknown',
      }))
      return
    }
    // The execution result is real even when its durable record is not. The
    // result is delivered; a failed append is reported through onHistoryFault.
    await safeAppend(historyEntry('result.received', {
      connectionId: channel.ref.connectionId,
      channelId: channel.ref.channelId,
      engineInstanceId,
      sessionId: pending.sessionId,
      requestRecordId: pending.recordId,
      frame,
      outcome: Object.hasOwn(frame, 'error') ? 'failed' : 'completed',
    }))

    let delivery: AcpFrame = { ...frame, id: pending.originalId }
    if (pending.method === 'session/new') {
      const sessionId = resultSessionId(frame)
      if (sessionId !== undefined) {
        const owner = sessionOwners.get(sessionId)
        if (owner !== undefined && owner !== channel.key) {
          delivery = rpcErrorFrame(pending.originalId, {
            code: 'SESSION_OWNERSHIP_CONFLICT',
            message: `engine returned session ${sessionId} already owned by another channel`,
          })
        } else {
          channel.sessions.add(sessionId)
          sessionOwners.set(sessionId, channel.key)
        }
      }
    }
    if (pending.method === 'session/prompt' && pending.sessionId !== undefined) {
      const prompt = channel.activePrompts.get(pending.sessionId)
      if (prompt !== undefined) {
        const failed = Object.hasOwn(frame, 'error')
        const occurredAt = new Date().toISOString()
        if (prompt.textObserved) {
          upsertEvent(channel.events, {
            eventId: `evt-part-${prompt.assistantPartId}`,
            agentId: localAgentId,
            sessionId: prompt.sessionId,
            occurredAt,
            kind: 'part',
            state: 'completed',
            messageId: prompt.assistantMessageId,
            partId: prompt.assistantPartId,
            partType: 'text',
            text: prompt.text,
          })
        }
        if (prompt.reasoningObserved) {
          upsertEvent(channel.events, {
            eventId: `evt-part-${prompt.reasoningPartId}`,
            agentId: localAgentId,
            sessionId: prompt.sessionId,
            occurredAt,
            kind: 'part',
            state: 'completed',
            messageId: prompt.assistantMessageId,
            partId: prompt.reasoningPartId,
            partType: 'reasoning',
            text: prompt.reasoning,
          })
        }
        channel.events.push({
          eventId: `evt-asst-${prompt.assistantMessageId}`,
          agentId: localAgentId,
          sessionId: prompt.sessionId,
          occurredAt,
          kind: 'message',
          ...(failed ? { state: 'failed' as const, error: structuredErrorOf(frame) } : { state: 'completed' as const }),
          messageId: prompt.assistantMessageId,
          role: 'assistant',
        })
        const stopReason = isRecord(frame.result) ? stringField(frame.result.stopReason) : undefined
        channel.events.push({
          eventId: `evt-final-${prompt.assistantMessageId}`,
          agentId: localAgentId,
          sessionId: prompt.sessionId,
          occurredAt,
          kind: 'final',
          ...(failed
            ? { state: 'failed' as const, error: structuredErrorOf(frame) }
            : { state: 'completed' as const, ...(stopReason === undefined ? {} : { finish: stopReason }) }),
          messageId: prompt.assistantMessageId,
        })
        channel.activePrompts.delete(pending.sessionId)
        channel.promptAdmissions.delete(pending.sessionId)
      }
    }
    enqueue(channel, delivery)
  }

  const handleEngineCallback = async (frame: AcpFrame): Promise<void> => {
    const method = methodOf(frame)
    if (method === undefined) throw new AcpError('INVALID_ACP_FRAME', 'engine callback requires a method')
    const engineId = frame.id as AcpRpcId
    // The engine's real permission choice set is projected once, at the owning boundary,
    // before the callback reaches a controller (A2.6). A malformed set is refused here and
    // never forwarded as an unactionable permission request.
    let permissionOptions: readonly ConsolePermissionOption[] | undefined
    if (method === 'session/request_permission') {
      try {
        permissionOptions = projectPermissionOptions(frame)
      } catch (cause) {
        const fault = faultFrom(cause, 'CALLBACK_UNAVAILABLE')
        await safeAppend(historyEntry('callback.denied', { engineInstanceId, frame, outcome: 'denied', error: fault }))
        await respondCallbackError(engineId, fault)
        return
      }
    }
    try {
      input.assertAllowed({ policy: input.policy, direction: 'from-engine', frame })
    } catch (cause) {
      const fault = faultFrom(cause, 'CALLBACK_UNAVAILABLE')
      await safeAppend(historyEntry('callback.denied', { engineInstanceId, frame, outcome: 'denied', error: fault }))
      await respondCallbackError(engineId, fault)
      return
    }

    const sessionId = sessionIdOf(frame)
    let target: ChannelState | undefined
    if (sessionId !== undefined) {
      target = channelBySession(sessionId)
    } else {
      const open = [...channels.values()].filter(channel => !channel.closed)
      if (open.length === 1) target = open[0]
    }
    if (target === undefined || target.closed) {
      const fault: AcpFault = { code: 'CALLBACK_UNAVAILABLE', message: 'no controller channel owns this callback' }
      await safeAppend(historyEntry('callback.unavailable', { engineInstanceId, sessionId, frame, outcome: 'unknown', error: fault }))
      if (method === 'session/request_permission') await sendPermissionCancellation(engineId)
      else await respondCallbackError(engineId, fault)
      return
    }

    const outwardId = nextCallbackId()
    const idKey = rpcIdKey(outwardId)
    let entry: HistoryRecord
    try {
      entry = await appendRecord(historyEntry('callback.dispatched', {
        connectionId: target.ref.connectionId,
        channelId: target.ref.channelId,
        engineInstanceId,
        sessionId,
        frame,
      }))
    } catch (cause) {
      // The callback must not reach an executor without a record; refuse it.
      await respondCallbackError(engineId, faultFrom(cause, 'HISTORY_UNAVAILABLE'))
      return
    }
    const pending: PendingCallback = { engineId, outwardId, channelKey: target.key, sessionId, method, recordId: entry.recordId,
      ...(permissionOptions === undefined ? {} : { permissionOptions }) }
    outwardCallbacks.set(idKey, pending)
    target.pendingCallbacks.set(idKey, pending)
    if (!enqueue(target, { ...frame, id: outwardId })) {
      // A callback the controller cannot receive is answered now, so the
      // engine never waits on an undelivered permission request.
      outwardCallbacks.delete(idKey)
      target.pendingCallbacks.delete(idKey)
      if (method === 'session/request_permission') await sendPermissionCancellation(engineId)
      else await respondCallbackError(engineId, { code: 'CALLBACK_UNAVAILABLE', message: 'controller delivery backlog is full' })
      return
    }
    if (method === 'session/request_permission' && sessionId !== undefined) {
      target.events.push({
        eventId: `permission:${outwardId}`,
        agentId: localAgentId,
        sessionId,
        occurredAt: new Date().toISOString(),
        kind: 'permission',
        state: 'pending',
        permissionId: outwardId,
        // The callback belongs to the prompt in flight when there is one; otherwise its
        // own stable callback identity is the only correlation the engine really gave.
        messageId: (sessionId === undefined ? undefined : target.activePrompts.get(sessionId)?.assistantMessageId) ?? `prompt:${outwardId}`,
        title: permissionTitle(frame) ?? 'Permission request',
        metadata: isRecord(frame.params) ? frame.params as JsonValue : {},
        ...(permissionOptions === undefined || permissionOptions.length === 0 ? {} : { options: permissionOptions }),
      })
    }
  }

  /**
   * Project the engine's own `session/update` frames onto the frozen Console event union.
   * Every identity comes from the prompt in flight or the engine's update; an update with
   * no active prompt owns no assistant message and is delivered without an event.
   */
  const captureSessionUpdate = (channel: ChannelState, sessionId: string, update: Record<string, unknown>): void => {
    const prompt = channel.activePrompts.get(sessionId)
    if (prompt === undefined) return
    const sessionUpdate = stringField(update.sessionUpdate)
    const occurredAt = new Date().toISOString()
    if (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'agent_thought_chunk') {
      const content = isRecord(update.content) ? update.content : undefined
      const text = content === undefined || typeof content.text !== 'string' ? undefined : content.text
      if (text === undefined) return
      const isThought = sessionUpdate === 'agent_thought_chunk'
      const partId = isThought ? prompt.reasoningPartId : prompt.assistantPartId
      if (isThought) {
        prompt.reasoning += text
        prompt.reasoningObserved = true
      } else {
        prompt.text += text
        prompt.textObserved = true
      }
      upsertEvent(channel.events, {
        eventId: `evt-part-${partId}`,
        agentId: localAgentId,
        sessionId,
        occurredAt,
        kind: 'part',
        state: 'pending',
        messageId: prompt.assistantMessageId,
        partId,
        partType: isThought ? 'reasoning' : 'text',
        text: isThought ? prompt.reasoning : prompt.text,
      })
      return
    }
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return
    const callId = stringField(update.toolCallId)
    const previous = callId === undefined
      ? undefined
      : channel.events.find((event): event is ToolEvent =>
          event.kind === 'tool' &&
          event.sessionId === sessionId &&
          event.messageId === prompt.assistantMessageId &&
          event.callId === callId)
    const event = projectToolEvent({
      agentId: localAgentId,
      sessionId,
      messageId: prompt.assistantMessageId,
      occurredAt,
      update,
      ...(previous === undefined ? {} : { previous }),
    })
    if (event !== undefined) upsertEvent(channel.events, event)
  }

  const handleEngineNotification = async (frame: AcpFrame): Promise<void> => {
    const sessionId = sessionIdOf(frame)
    const target = sessionId === undefined ? undefined : channelBySession(sessionId)
    if (target === undefined || target.closed) {
      // A necessary notification is recorded, never silently dropped.
      await safeAppend(historyEntry('notification.unrouted', { engineInstanceId, sessionId, frame, outcome: 'unknown' }))
      return
    }
    await safeAppend(historyEntry('notification.received', {
      connectionId: target.ref.connectionId,
      channelId: target.ref.channelId,
      engineInstanceId,
      sessionId,
      frame,
    }))
    if (methodOf(frame) === 'session/update' && sessionId !== undefined && isRecord(frame.params) && isRecord(frame.params.update)) {
      captureSessionUpdate(target, sessionId, frame.params.update)
    }
    enqueue(target, frame)
  }

  const handleEngineFrame = async (frame: AcpFrame): Promise<void> => {
    if (isResponseFrame(frame)) {
      await handleEngineResponse(frame)
      return
    }
    if (isRequestFrame(frame)) {
      await handleEngineCallback(frame)
      return
    }
    if (isNotificationFrame(frame)) {
      await handleEngineNotification(frame)
      return
    }
    throw new AcpError('INVALID_ACP_FRAME', 'engine produced an unrecognized ACP frame')
  }

  const pump = async (): Promise<void> => {
    while (!engineEnded) {
      let frame: AcpFrame
      try {
        frame = await input.handle.acp.read()
      } catch {
        onEngineEnd('stream ended')
        return
      }
      try {
        await handleEngineFrame(parseAcpFrame(frame))
      } catch (cause) {
        await safeAppend(historyEntry('engine.protocol-fault', {
          engineInstanceId,
          frame,
          outcome: 'failed',
          error: faultFrom(cause, 'INVALID_ACP_FRAME'),
        }))
        onEngineEnd('protocol fault')
        return
      }
    }
  }
  void pump()
  void input.handle.exited.then(() => onEngineEnd('exited'), () => onEngineEnd('exited'))
  void input.handle.acp.closed.then(() => onEngineEnd('closed'), () => onEngineEnd('closed'))

  const open = async (openInput: {
    readonly ref: AcpChannelRef
    readonly principal: AuthenticatedAgent
    readonly policy: AcpPolicySnapshot
  }): Promise<void> => {
    if (engineEnded) throw new AcpError('ENGINE_UNAVAILABLE', 'ACP engine is not available')
    if (openInput === null || typeof openInput !== 'object') {
      throw new AcpError('INVALID_ACP_FRAME', 'ACP open input is required')
    }
    assertRefShape(openInput.ref)
    assertPrincipal(openInput.principal)
    assertPolicyShape(openInput.policy)
    if (openInput.ref.engineInstanceId !== engineInstanceId
      || openInput.ref.targetGeneration !== input.handle.targetGeneration) {
      throw new AcpError('STALE_GENERATION', 'ACP channel ref does not match the initialized engine instance')
    }
    if (openInput.policy.engineInstanceId !== engineInstanceId || openInput.policy.revision !== input.policy.revision) {
      throw new AcpError('UNSUPPORTED_POLICY', 'ACP channel policy is not the active host policy')
    }
    const key = channelKeyOf(openInput.ref)
    if (channels.has(key)) throw new AcpError('CONFLICT', 'ACP channel is already open')
    await appendRecord(historyEntry('channel.open', {
      connectionId: openInput.ref.connectionId,
      channelId: openInput.ref.channelId,
      engineInstanceId,
    }))
    channels.set(key, {
      key,
      ref: { ...openInput.ref },
      principal: { ...openInput.principal },
      policy: openInput.policy,
      sessions: new Set<string>(),
      pendingRequests: new Map<string, PendingRequest>(),
      pendingCallbacks: new Map<string, PendingCallback>(),
      deliveries: [],
      nextSequence: 1,
      initialized: false,
      closed: false,
      activePrompts: new Map<string, ActivePrompt>(),
      promptAdmissions: new Set<string>(),
      events: [],
    })
  }

  const receive = async (ingress: AcpIngress): Promise<void> => {
    if (ingress === null || typeof ingress !== 'object') throw new AcpError('INVALID_ACP_FRAME', 'ACP ingress must be an object')
    assertRefShape(ingress)
    if (ingress.engineInstanceId !== engineInstanceId || ingress.targetGeneration !== input.handle.targetGeneration) {
      throw new AcpError('STALE_GENERATION', 'ACP ingress ref does not match the initialized engine instance')
    }
    const channel = channels.get(channelKeyOf(ingress))
    if (channel === undefined) throw new AcpError('STALE_GENERATION', 'ACP channel is not open')
    if (engineEnded) throw new AcpError('ENGINE_UNAVAILABLE', 'ACP engine is not available')
    if (channel.closed) throw new AcpError('CONFLICT', 'ACP channel is closed')
    const frame = parseAcpFrame(ingress.frame)
    if (isResponseFrame(frame)) {
      await receiveClientResponse(channel, frame)
      return
    }
    if (isRequestFrame(frame)) {
      await receiveClientRequest(channel, frame)
      return
    }
    if (isNotificationFrame(frame)) {
      await receiveClientNotification(channel, frame)
      return
    }
    throw new AcpError('INVALID_ACP_FRAME', 'ACP ingress must be a request, notification, or response')
  }

  const read = async (ref: AcpChannelRef, afterSequence: number, limit: number): Promise<{
    readonly frames: readonly AcpDelivery[]
    readonly nextSequence: number
  }> => {
    assertRefShape(ref)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new AcpError('INVALID_ACP_FRAME', 'afterSequence must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
      throw new AcpError('INVALID_ACP_FRAME', `limit must be an integer from 1 to ${MAX_READ_LIMIT}`)
    }
    if (ref.engineInstanceId !== engineInstanceId || ref.targetGeneration !== input.handle.targetGeneration) {
      throw new AcpError('STALE_GENERATION', 'ACP read ref does not match the initialized engine instance')
    }
    const channel = channels.get(channelKeyOf(ref))
    if (channel === undefined) throw new AcpError('STALE_GENERATION', 'ACP channel is not open')
    const frames = channel.deliveries.filter(delivery => delivery.sequence > afterSequence).slice(0, limit)
    const nextSequence = frames.length > 0 ? frames[frames.length - 1].sequence : afterSequence
    channel.deliveries = channel.deliveries.filter(delivery => delivery.sequence > nextSequence)
    return { frames, nextSequence }
  }

  const close = async (ref: AcpChannelRef): Promise<void> => {
    assertRefShape(ref)
    const channel = channels.get(channelKeyOf(ref))
    if (channel === undefined) throw new AcpError('STALE_GENERATION', 'ACP channel is not open')
    if (channel.closed) return
    channel.closed = true
    await settlePendingRequests(channel, 'channel closed')
    await settlePendingCallbacks(channel, 'controller channel closed')
    releaseSessions(channel)
    await safeAppend(historyEntry('channel.close', {
      connectionId: channel.ref.connectionId,
      channelId: channel.ref.channelId,
      engineInstanceId,
    }))
  }

  const pendingPermissions = (): readonly AcpPendingPermission[] => {
    const rows: AcpPendingPermission[] = []
    for (const channel of channels.values()) {
      if (channel.closed) continue
      for (const pending of channel.pendingCallbacks.values()) {
        // Only a permission callback carries an option set, and only a callback with a
        // Session can be matched to a Session write.
        if (pending.method !== 'session/request_permission' || pending.sessionId === undefined) continue
        rows.push({
          ref: channel.ref,
          sessionId: pending.sessionId,
          permissionId: pending.outwardId,
          options: pending.permissionOptions ?? [],
        })
      }
    }
    return rows
  }

  const channelForSession = (sessionId: string): AcpChannelRef | undefined => {
    const channel = channelBySession(sessionId)
    // A closed channel cannot accept a write, so it must not be reported as the owner.
    return channel === undefined || channel.closed ? undefined : channel.ref
  }

  const openedSessions = (): readonly string[] => {
    const rows: string[] = []
    for (const channel of channels.values()) {
      // A closed channel holds no Session any more, so it must not be reported as one — the same
      // rule `channelForSession` and `pendingPermissions` already apply. `releaseSessions` clears
      // the ids, but `close()` marks the channel closed and only then awaits its durable settling,
      // so a reader that samples this host inside that window would otherwise see the Sessions of
      // a channel that already stopped accepting writes.
      if (channel.closed) continue
      for (const sessionId of channel.sessions) rows.push(sessionId)
    }
    return rows
  }

  const sessionEvents = (): readonly ConsoleSessionEventView[] => {
    const rows: ConsoleSessionEventView[] = []
    for (const channel of channels.values()) {
      if (channel.closed) continue
      rows.push(...channel.events)
    }
    return rows
  }

  return { open, receive, read, close, pendingPermissions, channelForSession, openedSessions, sessionEvents }
}
