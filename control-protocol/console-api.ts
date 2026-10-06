import type { JsonValue, ServiceError, ServiceErrorCode, WorkState } from './agent-services.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'
export type { JsonValue } from './agent-services.ts'

/** Console config errors retain their owning service's code and provider/status context. */
export interface ConsoleServiceError extends Omit<ServiceError, 'code'> {
  readonly code: ServiceErrorCode | 'CREDENTIAL_UNAVAILABLE' | 'SOURCE_CHANGED' | 'MIGRATION_CONFLICT' | 'APPLY_TARGET_MISMATCH'
  readonly message: string
  readonly status?: number
  readonly providerInstanceId?: string
  /** Typed cancel unknown detail; never a business payload or log mirror. */
  readonly detail?: SessionCancelUnknownDetail
}

/** Console transport DTOs. Daemons own the source state and command authorization. */
export interface ConsoleProviderView {
  readonly id: string
  readonly label: string
  readonly protocol: 'openai-chat' | 'openai-responses'
  readonly apiBaseUrl: string
  readonly enabled: boolean
  readonly authKind: 'none' | 'bearer'
  readonly catalogState: 'ready' | 'empty' | 'stale' | 'error'
  readonly models: readonly { readonly id: string; readonly label?: string }[]
  readonly error?: ConsoleServiceError
}
export interface ConsoleModelMetadata {
  readonly label?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly tools?: boolean
  readonly streaming?: boolean
  readonly reasoning?: boolean
  readonly inputModalities?: readonly string[]
  readonly outputModalities?: readonly string[]
}
export interface ConsoleManualModelEntry {
  readonly ref: { readonly providerInstanceId: string; readonly modelId: string }
  readonly origin: 'manual'
  readonly base: ConsoleModelMetadata
  readonly overrides: ConsoleModelMetadata
  readonly availability?: 'available' | 'unavailable'
}
/** Independent event-observation health; never a ManagedRuntimeReadiness branch. */
export type SessionObservationState =
  | { readonly state: 'live' }
  | {
      readonly state: 'degraded'
      readonly reason: 'projection-loss' | 'stream-retry'
      readonly detail: string
      readonly droppedEvents: number
    }
  | { readonly state: 'lost'; readonly reason: 'stream-ended' | 'retry-exhausted'; readonly detail: string }

/** The exact OpenCode structured error union retained on failed message/final/error events. */
export interface OpenCodeStructuredError {
  readonly name: 'ProviderAuthError' | 'UnknownError' | 'MessageOutputLengthError' | 'MessageAbortedError' | 'APIError'
  readonly data: JsonValue
}

interface ConsoleSessionEventBase {
  readonly eventId: string
  readonly agentId: string
  readonly sessionId: string
  readonly occurredAt?: string
}

/** Closed owner-projected Session event union. Every required identity comes from a real SDK event/part. */
export type ConsoleSessionEventView =
  | ConsoleSessionEventBase & {
      readonly kind: 'message'
      readonly state: 'pending' | 'completed'
      readonly messageId: string
      readonly role: 'user' | 'assistant'
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'message'
      readonly state: 'failed'
      readonly messageId: string
      readonly role: 'user' | 'assistant'
      readonly error: OpenCodeStructuredError
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'part'
      readonly state: 'pending' | 'completed'
      readonly messageId: string
      readonly partId: string
      readonly partType: 'text' | 'reasoning'
      readonly text: string
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'part'
      readonly state: 'observed'
      readonly messageId: string
      readonly partId: string
      readonly partType:
        | 'file' | 'step-start' | 'step-finish' | 'snapshot'
        | 'patch' | 'agent' | 'retry' | 'compaction' | 'subtask'
      readonly sourcePart: JsonValue
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'tool'
      readonly state: 'pending'
      readonly messageId: string
      readonly partId: string
      readonly callId: string
      readonly tool: string
      readonly input: JsonValue
      readonly raw: string
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'tool'
      readonly state: 'running'
      readonly messageId: string
      readonly partId: string
      readonly callId: string
      readonly tool: string
      readonly input: JsonValue
      readonly title?: string
      readonly metadata?: JsonValue
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'tool'
      readonly state: 'completed'
      readonly messageId: string
      readonly partId: string
      readonly callId: string
      readonly tool: string
      readonly input: JsonValue
      readonly output: string
      readonly title: string
      readonly metadata: JsonValue
      readonly attachments?: readonly JsonValue[]
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'tool'
      readonly state: 'error'
      readonly messageId: string
      readonly partId: string
      readonly callId: string
      readonly tool: string
      readonly input: JsonValue
      readonly error: string
      readonly metadata?: JsonValue
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'permission'
      readonly state: 'pending'
      readonly permissionId: string
      readonly messageId: string
      readonly callId?: string
      readonly title: string
      readonly metadata: JsonValue
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'permission'
      readonly state: 'resolved'
      readonly permissionId: string
      readonly decision: 'once' | 'always' | 'reject' | 'unknown'
      readonly rawResponse?: string
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'final'
      readonly state: 'completed'
      readonly messageId: string
      readonly finish?: string
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'final'
      readonly state: 'failed'
      readonly messageId: string
      readonly error: OpenCodeStructuredError
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'error'
      readonly state: 'failed'
      readonly error: OpenCodeStructuredError
      readonly correlation:
        | { readonly kind: 'session'; readonly sessionId: string }
        | { readonly kind: 'message'; readonly messageId: string }
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'cancel'
      readonly state: 'accepted'
      readonly abortOperationId: string
      readonly operationId: string
      readonly sessionId: string
      readonly runtimeGeneration: number
      readonly effectiveRevision: number
      readonly promptMessageId: string
      readonly baseAccepted: true
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'cancel'
      readonly state: 'rejected'
      readonly abortOperationId: string
      readonly operationId: string
      readonly sessionId: string
      readonly runtimeGeneration: number
      readonly effectiveRevision: number
      readonly promptMessageId: string
      readonly baseAccepted: false
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'cancel'
      readonly state: 'reconciled'
      readonly abortOperationId: string
      readonly operationId: string
      readonly sessionId: string
      readonly runtimeGeneration: number
      readonly effectiveRevision: number
      readonly promptMessageId: string
      readonly baseAccepted: true
      readonly finalState: 'cancelled'
      readonly messageId: string
      readonly errorName: 'MessageAbortedError'
      readonly causalEvidence: 'unique-owned-message'
    }
  | ConsoleSessionEventBase & {
      readonly kind: 'cancel'
      readonly state: 'unknown'
      readonly abortOperationId?: string
      readonly operationId?: string
      readonly sessionId: string
      readonly runtimeGeneration?: number
      readonly effectiveRevision?: number
      readonly promptMessageId?: string
      readonly baseAccepted?: boolean
      readonly reason:
        | 'abort-rejected' | 'no-final' | 'link-lost' | 'uncorrelated-idle'
        | 'ambiguous-owner' | 'stale-generation' | 'superseded'
    }

/** Precise create result; carries only real OpenCode Session identity and never model/config truth. */
export interface SessionCreateResult {
  readonly kind: 'session.create'
  readonly agentId: string
  readonly sessionId: string
  readonly title?: string
  readonly directory?: string
  readonly time?: Readonly<Record<string, JsonValue>>
}

/** Typed cancel unknown detail retained by the owning Session runtime. */
export interface SessionCancelUnknownDetail {
  readonly kind: 'session.cancel'
  readonly sessionId: string
  readonly operationId?: string
  readonly promptMessageId?: string
  readonly runtimeGeneration?: number
  readonly effectiveRevision?: number
  readonly baseAccepted?: boolean
  readonly reconciliation: 'unknown'
  readonly finalState: 'unknown'
  readonly reason:
    | 'abort-rejected' | 'no-final' | 'link-lost' | 'uncorrelated-idle'
    | 'ambiguous-owner' | 'stale-generation' | 'superseded'
  readonly abortOperationId?: string
}

/** Confirmed cancel result; only a uniquely owned MessageAbortedError produces this shape. */
export interface SessionCancelConfirmed {
  readonly kind: 'session.cancel'
  readonly sessionId: string
  readonly operationId: string
  readonly promptMessageId: string
  readonly runtimeGeneration: number
  readonly effectiveRevision: number
  readonly baseAccepted: true
  readonly reconciliation: 'confirmed'
  readonly finalState: 'cancelled'
  readonly messageId: string
  readonly errorName: 'MessageAbortedError'
  readonly abortOperationId: string
  readonly causalEvidence: 'unique-owned-message'
}

/**
 * Agent management row. The runtime/directory discriminated union is not a Work capability and
 * is not a second source of config or runtime truth.
 */
export type ConsoleAgentObservationV1 =
  | {
      readonly kind: 'runtime'
      readonly agentId: string
      readonly label: string
      readonly machineId: string
      readonly generation?: number
      readonly presence: 'online' | 'offline' | 'unknown'
      readonly capabilities: readonly string[]
      readonly sessionCapable: true
      readonly sessionAvailability: 'changing' | 'stopped' | 'no-current' | 'uncertain' | 'current'
      readonly sessionObservation?: SessionObservationState
      readonly sessionEffectiveRevision?: number
      readonly currentSessionId?: string
      readonly providerId?: string
      readonly modelId?: string
    }
  | {
      readonly kind: 'runtime'
      readonly agentId: string
      readonly label: string
      readonly machineId: string
      readonly generation?: number
      readonly presence: 'online' | 'offline' | 'unknown'
      readonly capabilities: readonly string[]
      readonly sessionCapable: false
      readonly sessionAvailability: 'not-applicable'
    }
  | {
      readonly kind: 'directory'
      readonly agentId: string
      readonly label: string
      readonly machineId: string
      readonly generation?: number
      readonly presence: 'online' | 'offline' | 'unknown'
      readonly capabilities: readonly string[]
    }
export interface ConsoleProjectionV1 {
  readonly version: 1
  readonly agents: readonly ConsoleAgentObservationV1[]
  readonly sessions: readonly { readonly agentId: string; readonly sessionId: string; readonly title?: string }[]
  readonly notifications: readonly {
    readonly agentId: string; readonly notificationId: string; readonly sessionId?: string
    readonly kind: 'notice' | 'permission'; readonly state: 'pending' | 'resolved'; readonly title: string
    readonly permissionId?: string; readonly priority?: 'low' | 'normal' | 'high' | 'critical'
    readonly occurredAt?: string; readonly detail?: string
  }[]
  readonly configs: readonly {
    readonly agentId: string; readonly acceptedRevision: number; readonly effectiveRevision?: number
    /** Durable config-owner fence projection; always emitted by the U2 config binding. */
    readonly applyState?: 'clean' | 'uncertain'
    readonly providers: readonly ConsoleProviderView[]; readonly error?: ConsoleServiceError
  }[]
  readonly sessionEvents?: readonly ConsoleSessionEventView[]
  readonly works?: readonly ConsoleWorkView[]
  readonly relations?: readonly ConsoleRelationView[]
}
export interface ConsoleWorkView {
  readonly agentId: string
  readonly workId: string
  readonly consumerAgentId: string
  readonly providerAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly policyRevision: number
  readonly state: WorkState
}
export interface ConsoleRelationView {
  readonly agentId: string
  readonly consumerAgentId: string
  readonly providerAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly relationPermission: 'requested' | 'granted' | 'revoked'
  readonly workId?: string
}
export type ConsoleCommandV1 =
  | { readonly kind: 'session.open'; readonly agentId: string; readonly sessionId: string }
  | { readonly kind: 'session.create'; readonly agentId: string; readonly title?: string }
  | { readonly kind: 'session.cancel'; readonly agentId: string; readonly sessionId: string }
  | { readonly kind: 'permission.reply'; readonly agentId: string; readonly sessionId: string; readonly permissionId: string; readonly decision: 'once' | 'always' | 'reject' }
  | { readonly kind: 'notification.ack'; readonly agentId: string; readonly notificationId: string }
  | { readonly kind: 'config.refreshModels'; readonly agentId: string; readonly expectedRevision: number; readonly providerId: string }
  | { readonly kind: 'config.bindModel'; readonly agentId: string; readonly expectedRevision: number; readonly providerId: string; readonly modelId: string }
  | { readonly kind: 'config.model.put'; readonly agentId: string; readonly expectedRevision: number; readonly entry: ConsoleManualModelEntry }
  | { readonly kind: 'config.apply'; readonly agentId: string }
  | { readonly kind: 'config.agent.select-backup'; readonly agentId: string; readonly expectedRevision: number;
      readonly backup: { readonly providerInstanceId: string; readonly modelId: string } }
  | { readonly kind: 'config.putProvider'; readonly agentId: string; readonly expectedRevision: number;
      readonly provider: { readonly id: string; readonly label: string; readonly protocol: ConsoleProviderView['protocol']; readonly apiBaseUrl: string; readonly enabled: boolean;
        readonly auth: { readonly kind: 'none' } | { readonly kind: 'bearer'; readonly credentialRef: string } } }
export type ConsoleCommandResultV1 =
  | { readonly ok: true; readonly result?: JsonValue }
  | { readonly ok: false; readonly error: ConsoleServiceError }

/** Host binding; no success is inferred when the transport or daemon reports failure. */
export interface ConsoleClientV1 {
  readProjection(): Promise<ConsoleProjectionV1>
  command(command: ConsoleCommandV1): Promise<ConsoleCommandResultV1>
  /** Dedicated Session data ingress; business content never enters a host command. */
  sendSession(target: { readonly agentId: string; readonly sessionId: string }, payload: JsonValue): Promise<ConsoleCommandResultV1>
}

const WORK_STATES: readonly WorkState[] = ['accepted', 'closing', 'closed', 'rejected']
const RELATION_PERMISSIONS = ['requested', 'granted', 'revoked'] as const

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Console control must be an object')
  return value as Record<string, unknown>
}
function text(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Console control requires a non-empty string')
}
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid config revision')
}

function workView(value: unknown): ConsoleWorkView {
  const work = object(value)
  assertEnvelopeKeys(work, ['agentId', 'workId', 'consumerAgentId', 'providerAgentId', 'capabilityId', 'capabilityVersion', 'policyRevision', 'state'], 'Console work')
  for (const key of ['agentId', 'workId', 'consumerAgentId', 'providerAgentId', 'capabilityId', 'capabilityVersion']) text(work[key])
  revision(work.policyRevision)
  if (!WORK_STATES.includes(work.state as WorkState)) throw new Error('Invalid Console work state')
  return work as unknown as ConsoleWorkView
}

function relationView(value: unknown): ConsoleRelationView {
  const relation = object(value)
  assertEnvelopeKeys(relation, ['agentId', 'consumerAgentId', 'providerAgentId', 'capabilityId', 'capabilityVersion', 'relationPermission', 'workId'], 'Console relation')
  for (const key of ['agentId', 'consumerAgentId', 'providerAgentId', 'capabilityId', 'capabilityVersion']) text(relation[key])
  if (!RELATION_PERMISSIONS.includes(relation.relationPermission as typeof RELATION_PERMISSIONS[number])) throw new Error('Invalid Console relation permission')
  if (relation.workId !== undefined) text(relation.workId)
  return relation as unknown as ConsoleRelationView
}

/** Observe-only projection rows; request/Session payloads are rejected as undeclared fields. */
export function parseConsoleWorkRelationProjection(value: unknown): { readonly works: readonly ConsoleWorkView[]; readonly relations: readonly ConsoleRelationView[] } {
  const input = object(value)
  if (!Array.isArray(input.works) || !Array.isArray(input.relations)) throw new Error('Console projection requires work and relation observations')
  return { works: input.works.map(workView), relations: input.relations.map(relationView) }
}

/** Validate the closed control envelope before dispatch; authorization stays at the daemon. */
export function parseConsoleCommand(value: unknown): ConsoleCommandV1 {
  assertJsonValue(value, 'Console command')
  const command = object(value)
  text(command.agentId)
  let fields: readonly string[]
  switch (command.kind) {
    case 'session.open': fields = ['sessionId']; text(command.sessionId); break
    case 'session.create':
      fields = ['title']
      if (command.title !== undefined) text(command.title)
      break
    case 'session.cancel': fields = ['sessionId']; text(command.sessionId); break
    case 'permission.reply':
      fields = ['sessionId', 'permissionId', 'decision']
      text(command.sessionId); text(command.permissionId)
      if (!['once', 'always', 'reject'].includes(command.decision as string)) throw new Error('Invalid permission decision')
      break
    case 'notification.ack': fields = ['notificationId']; text(command.notificationId); break
    case 'config.refreshModels':
      fields = ['expectedRevision', 'providerId']; revision(command.expectedRevision); text(command.providerId); break
    case 'config.bindModel':
      fields = ['expectedRevision', 'providerId', 'modelId']
      revision(command.expectedRevision); text(command.providerId); text(command.modelId); break
    case 'config.model.put': {
      fields = ['expectedRevision', 'entry']; revision(command.expectedRevision)
      const entry = object(command.entry)
      assertEnvelopeKeys(entry, ['ref', 'origin', 'base', 'overrides', 'availability'], 'Console model entry')
      if (entry.origin !== 'manual') throw new Error('Console model entry must be manual')
      const ref = object(entry.ref)
      assertEnvelopeKeys(ref, ['providerInstanceId', 'modelId'], 'Console model reference')
      text(ref.providerInstanceId); text(ref.modelId)
      const parseMetadata = (value: unknown, label: string) => {
        const metadata = object(value)
        assertEnvelopeKeys(metadata, ['label', 'contextWindow', 'maxOutputTokens', 'tools', 'streaming', 'reasoning', 'inputModalities', 'outputModalities'], label)
        if (metadata.label !== undefined) text(metadata.label)
        for (const key of ['contextWindow', 'maxOutputTokens']) if (metadata[key] !== undefined) {
          if (!Number.isSafeInteger(metadata[key]) || (metadata[key] as number) < 1) throw new Error(`Invalid ${label} numeric metadata`)
        }
        for (const key of ['tools', 'streaming', 'reasoning']) if (metadata[key] !== undefined && typeof metadata[key] !== 'boolean') throw new Error(`Invalid ${label} boolean metadata`)
        for (const key of ['inputModalities', 'outputModalities']) if (metadata[key] !== undefined && (!Array.isArray(metadata[key]) || (metadata[key] as unknown[]).some(item => typeof item !== 'string' || item.length === 0))) throw new Error(`Invalid ${label} modalities`)
      }
      parseMetadata(entry.base, 'Console model base')
      parseMetadata(entry.overrides, 'Console model overrides')
      if (entry.availability !== undefined && entry.availability !== 'available' && entry.availability !== 'unavailable') throw new Error('Invalid Console model availability')
      break
    }
    case 'config.apply': fields = []; break
    case 'config.agent.select-backup': {
      fields = ['expectedRevision', 'backup']; revision(command.expectedRevision)
      const backup = object(command.backup)
      assertEnvelopeKeys(backup, ['providerInstanceId', 'modelId'], 'Backup model reference')
      text(backup.providerInstanceId); text(backup.modelId)
      break
    }
    case 'config.putProvider': {
      fields = ['expectedRevision', 'provider']; revision(command.expectedRevision)
      const provider = object(command.provider)
      assertEnvelopeKeys(provider, ['id', 'label', 'protocol', 'apiBaseUrl', 'enabled', 'auth'], 'Console provider')
      text(provider.id); text(provider.label); text(provider.apiBaseUrl)
      if (!['openai-chat', 'openai-responses'].includes(provider.protocol as string) || typeof provider.enabled !== 'boolean') throw new Error('Invalid provider declaration')
      const auth = object(provider.auth)
      if (auth.kind === 'none') assertEnvelopeKeys(auth, ['kind'], 'Provider auth')
      else if (auth.kind === 'bearer') {
        assertEnvelopeKeys(auth, ['kind', 'credentialRef'], 'Provider auth'); text(auth.credentialRef)
      } else throw new Error('Invalid provider authentication kind')
      break
    }
    default: throw new Error('Unknown Console command')
  }
  assertEnvelopeKeys(command, ['kind', 'agentId', ...fields], 'Console command')
  return command as unknown as ConsoleCommandV1
}

const PRESENCE = ['online', 'offline', 'unknown'] as const
const SESSION_AVAILABILITY = ['changing', 'stopped', 'no-current', 'uncertain', 'current'] as const
const OBSERVED_PART_TYPES = ['file', 'step-start', 'step-finish', 'snapshot', 'patch', 'agent', 'retry', 'compaction', 'subtask'] as const
const CANCEL_UNKNOWN_REASONS = ['abort-rejected', 'no-final', 'link-lost', 'uncorrelated-idle', 'ambiguous-owner', 'stale-generation', 'superseded'] as const
const STRUCTURED_ERROR_NAMES = ['ProviderAuthError', 'UnknownError', 'MessageOutputLengthError', 'MessageAbortedError', 'APIError'] as const

function optionalText(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) throw new Error(`${label} must be a non-empty string`)
}
function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
}
function counter(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
}
function json(value: unknown, label: string): void {
  assertJsonValue(value, label)
}
function choiceOf(value: unknown, allowed: readonly unknown[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`Invalid ${label}`)
}

function parseStructuredError(value: unknown): void {
  const error = object(value)
  assertEnvelopeKeys(error, ['name', 'data'], 'OpenCode structured error')
  choiceOf(error.name, STRUCTURED_ERROR_NAMES, 'OpenCode structured error name')
  json(error.data, 'OpenCode structured error data')
}

export function parseSessionObservationState(value: unknown): SessionObservationState {
  const observation = object(value)
  switch (observation.state) {
    case 'live':
      assertEnvelopeKeys(observation, ['state'], 'Session observation')
      break
    case 'degraded':
      assertEnvelopeKeys(observation, ['state', 'reason', 'detail', 'droppedEvents'], 'Session observation')
      choiceOf(observation.reason, ['projection-loss', 'stream-retry'], 'Session observation reason')
      text(observation.detail)
      counter(observation.droppedEvents, 'Session observation droppedEvents')
      break
    case 'lost':
      assertEnvelopeKeys(observation, ['state', 'reason', 'detail'], 'Session observation')
      choiceOf(observation.reason, ['stream-ended', 'retry-exhausted'], 'Session observation reason')
      text(observation.detail)
      break
    default:
      throw new Error('Invalid Session observation state')
  }
  return observation as unknown as SessionObservationState
}

/** Closed validation of one Agent management row; rejects session/model fields on directory/false rows. */
export function parseConsoleAgentObservation(value: unknown): ConsoleAgentObservationV1 {
  const agent = object(value)
  const common = ['kind', 'agentId', 'label', 'machineId', 'generation', 'presence', 'capabilities']
  text(agent.agentId); text(agent.label); text(agent.machineId)
  if (agent.generation !== undefined) {
    if (!Number.isSafeInteger(agent.generation) || (agent.generation as number) < 1) throw new Error('Console agent generation invalid')
  }
  choiceOf(agent.presence, PRESENCE, 'Console agent presence')
  if (!Array.isArray(agent.capabilities)) throw new Error('Console agent capabilities must be an array')
  for (const capability of agent.capabilities) text(capability)
  if (agent.kind === 'directory') {
    assertEnvelopeKeys(agent, common, 'Console directory agent')
    return agent as unknown as ConsoleAgentObservationV1
  }
  if (agent.kind !== 'runtime') throw new Error('Console agent kind is invalid')
  boolean(agent.sessionCapable, 'Console agent sessionCapable')
  if (agent.sessionCapable === false) {
    assertEnvelopeKeys(agent, [...common, 'sessionCapable', 'sessionAvailability'], 'Console passive runtime agent')
    if (agent.sessionAvailability !== 'not-applicable') throw new Error('Console passive runtime availability must be not-applicable')
    return agent as unknown as ConsoleAgentObservationV1
  }
  assertEnvelopeKeys(agent, [...common, 'sessionCapable', 'sessionAvailability', 'sessionObservation', 'sessionEffectiveRevision', 'currentSessionId', 'providerId', 'modelId'], 'Console runtime agent')
  choiceOf(agent.sessionAvailability, SESSION_AVAILABILITY, 'Console runtime availability')
  if (agent.sessionAvailability === 'current' && agent.sessionEffectiveRevision === undefined) {
    throw new Error('Console current runtime availability requires an effective revision')
  }
  if (agent.sessionEffectiveRevision !== undefined) revision(agent.sessionEffectiveRevision)
  optionalText(agent.currentSessionId, 'Console agent currentSessionId')
  optionalText(agent.providerId, 'Console agent providerId')
  optionalText(agent.modelId, 'Console agent modelId')
  if (agent.sessionObservation !== undefined) parseSessionObservationState(agent.sessionObservation)
  return agent as unknown as ConsoleAgentObservationV1
}

/** Closed validation of one owner-projected Session event; identity must match the variant. */
export function parseConsoleSessionEvent(value: unknown): ConsoleSessionEventView {
  const event = object(value)
  const base = ['eventId', 'agentId', 'sessionId', 'occurredAt']
  text(event.eventId); text(event.agentId); text(event.sessionId)
  optionalText(event.occurredAt, 'Console Session event occurredAt')
  const withState = (fields: readonly string[]): Record<string, unknown> => {
    assertEnvelopeKeys(event, [...base, 'kind', 'state', ...fields], 'Console Session event')
    return event
  }
  switch (event.kind) {
    case 'message':
      if (event.state === 'failed') {
        withState(['messageId', 'role', 'error'])
        text(event.messageId); choiceOf(event.role, ['user', 'assistant'], 'message role'); parseStructuredError(event.error)
      } else {
        withState(['messageId', 'role'])
        choiceOf(event.state, ['pending', 'completed'], 'message state')
        text(event.messageId); choiceOf(event.role, ['user', 'assistant'], 'message role')
      }
      break
    case 'part':
      if (event.state === 'observed') {
        withState(['messageId', 'partId', 'partType', 'sourcePart'])
        text(event.messageId); text(event.partId)
        choiceOf(event.partType, OBSERVED_PART_TYPES, 'observed part type')
        json(event.sourcePart, 'Console observed part sourcePart')
      } else {
        withState(['messageId', 'partId', 'partType', 'text'])
        choiceOf(event.state, ['pending', 'completed'], 'part state')
        text(event.messageId); text(event.partId)
        choiceOf(event.partType, ['text', 'reasoning'], 'part type')
        if (typeof event.text !== 'string') throw new Error('Console part text must be a string')
      }
      break
    case 'tool': {
      const identity = ['messageId', 'partId', 'callId', 'tool', 'input']
      if (event.state === 'pending') {
        withState([...identity, 'raw']); text(event.messageId); text(event.partId); text(event.callId); text(event.tool); json(event.input, 'tool input')
        if (typeof event.raw !== 'string') throw new Error('Console tool raw must be a string')
      } else if (event.state === 'running') {
        withState([...identity, 'title', 'metadata']); text(event.messageId); text(event.partId); text(event.callId); text(event.tool); json(event.input, 'tool input')
        optionalText(event.title, 'tool title'); if (event.metadata !== undefined) json(event.metadata, 'tool metadata')
      } else if (event.state === 'completed') {
        withState([...identity, 'output', 'title', 'metadata', 'attachments']); text(event.messageId); text(event.partId); text(event.callId); text(event.tool); json(event.input, 'tool input')
        if (typeof event.output !== 'string') throw new Error('Console tool output must be a string')
        text(event.title); json(event.metadata, 'tool metadata')
        if (event.attachments !== undefined) {
          if (!Array.isArray(event.attachments)) throw new Error('Console tool attachments must be an array')
          for (const attachment of event.attachments) json(attachment, 'tool attachment')
        }
      } else if (event.state === 'error') {
        withState([...identity, 'error', 'metadata']); text(event.messageId); text(event.partId); text(event.callId); text(event.tool); json(event.input, 'tool input')
        if (typeof event.error !== 'string') throw new Error('Console tool error must be a string')
        if (event.metadata !== undefined) json(event.metadata, 'tool metadata')
      } else throw new Error('Invalid Console tool state')
      break
    }
    case 'permission':
      if (event.state === 'pending') {
        withState(['permissionId', 'messageId', 'callId', 'title', 'metadata'])
        text(event.permissionId); text(event.messageId); optionalText(event.callId, 'permission callId'); text(event.title); json(event.metadata, 'permission metadata')
      } else if (event.state === 'resolved') {
        withState(['permissionId', 'decision', 'rawResponse'])
        text(event.permissionId); choiceOf(event.decision, ['once', 'always', 'reject', 'unknown'], 'permission decision'); optionalText(event.rawResponse, 'permission rawResponse')
      } else throw new Error('Invalid Console permission state')
      break
    case 'final':
      if (event.state === 'completed') {
        withState(['messageId', 'finish']); text(event.messageId); optionalText(event.finish, 'final finish')
      } else if (event.state === 'failed') {
        withState(['messageId', 'error']); text(event.messageId); parseStructuredError(event.error)
      } else throw new Error('Invalid Console final state')
      break
    case 'error': {
      withState(['error', 'correlation']); parseStructuredError(event.error)
      const correlation = object(event.correlation)
      if (correlation.kind === 'session') { assertEnvelopeKeys(correlation, ['kind', 'sessionId'], 'Console error correlation'); text(correlation.sessionId) }
      else if (correlation.kind === 'message') { assertEnvelopeKeys(correlation, ['kind', 'messageId'], 'Console error correlation'); text(correlation.messageId) }
      else throw new Error('Invalid Console error correlation')
      break
    }
    case 'cancel': {
      const identity = ['operationId', 'runtimeGeneration', 'effectiveRevision', 'promptMessageId']
      if (event.state === 'accepted' || event.state === 'rejected') {
        withState(['abortOperationId', ...identity, 'baseAccepted'])
        text(event.abortOperationId); text(event.operationId); revision(event.runtimeGeneration); revision(event.effectiveRevision); text(event.promptMessageId)
        boolean(event.baseAccepted, 'cancel baseAccepted')
        if (event.state === 'accepted' && event.baseAccepted !== true) throw new Error('Cancel accepted requires baseAccepted true')
        if (event.state === 'rejected' && event.baseAccepted !== false) throw new Error('Cancel rejected requires baseAccepted false')
      } else if (event.state === 'reconciled') {
        withState(['abortOperationId', ...identity, 'baseAccepted', 'finalState', 'messageId', 'errorName', 'causalEvidence'])
        text(event.abortOperationId); text(event.operationId); revision(event.runtimeGeneration); revision(event.effectiveRevision); text(event.promptMessageId)
        if (event.baseAccepted !== true) throw new Error('Cancel reconciled requires baseAccepted true')
        if (event.finalState !== 'cancelled') throw new Error('Cancel reconciled requires finalState cancelled')
        text(event.messageId)
        if (event.errorName !== 'MessageAbortedError') throw new Error('Cancel reconciled requires MessageAbortedError')
        if (event.causalEvidence !== 'unique-owned-message') throw new Error('Cancel reconciled requires unique-owned-message evidence')
      } else if (event.state === 'unknown') {
        withState(['abortOperationId', ...identity, 'baseAccepted', 'reason'])
        optionalText(event.abortOperationId, 'cancel abortOperationId')
        optionalText(event.operationId, 'cancel operationId')
        if (event.runtimeGeneration !== undefined) revision(event.runtimeGeneration)
        if (event.effectiveRevision !== undefined) revision(event.effectiveRevision)
        optionalText(event.promptMessageId, 'cancel promptMessageId')
        if (event.baseAccepted !== undefined) boolean(event.baseAccepted, 'cancel baseAccepted')
        choiceOf(event.reason, CANCEL_UNKNOWN_REASONS, 'cancel unknown reason')
      } else throw new Error('Invalid Console cancel state')
      break
    }
    default: throw new Error('Invalid Console Session event kind')
  }
  return event as unknown as ConsoleSessionEventView
}

/** Closed validation of a create success result; rejects model/config/provider fields. */
export function parseSessionCreateResult(value: unknown): SessionCreateResult {
  const result = object(value)
  assertEnvelopeKeys(result, ['kind', 'agentId', 'sessionId', 'title', 'directory', 'time'], 'Session create result')
  if (result.kind !== 'session.create') throw new Error('Session create result kind is invalid')
  text(result.agentId); text(result.sessionId)
  optionalText(result.title, 'Session create title')
  optionalText(result.directory, 'Session create directory')
  if (result.time !== undefined) {
    const time = object(result.time)
    for (const key of Object.keys(time)) json(time[key], `Session create time.${key}`)
  }
  return result as unknown as SessionCreateResult
}

/** Closed validation of a typed cancel unknown detail; baseAccepted stays three-state. */
export function parseSessionCancelUnknownDetail(value: unknown): SessionCancelUnknownDetail {
  const detail = object(value)
  assertEnvelopeKeys(detail, ['kind', 'sessionId', 'operationId', 'promptMessageId', 'runtimeGeneration', 'effectiveRevision', 'baseAccepted', 'reconciliation', 'finalState', 'reason', 'abortOperationId'], 'Session cancel detail')
  if (detail.kind !== 'session.cancel') throw new Error('Session cancel detail kind is invalid')
  text(detail.sessionId)
  optionalText(detail.operationId, 'cancel detail operationId')
  optionalText(detail.promptMessageId, 'cancel detail promptMessageId')
  if (detail.runtimeGeneration !== undefined) revision(detail.runtimeGeneration)
  if (detail.effectiveRevision !== undefined) revision(detail.effectiveRevision)
  if (detail.baseAccepted !== undefined) boolean(detail.baseAccepted, 'cancel detail baseAccepted')
  if (detail.reconciliation !== 'unknown' || detail.finalState !== 'unknown') throw new Error('Session cancel detail must stay unknown')
  choiceOf(detail.reason, CANCEL_UNKNOWN_REASONS, 'cancel detail reason')
  optionalText(detail.abortOperationId, 'cancel detail abortOperationId')
  return detail as unknown as SessionCancelUnknownDetail
}
