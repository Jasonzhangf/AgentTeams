import type { JsonValue } from './agent-services.ts'
import { parseConsoleCommand, parseConsoleWorkRelationProjection, type ConsoleCommandV1, type ConsoleCommandResultV1, type ConsoleProjectionV1 } from './console-api.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'
import { parseServiceError, RelayProtocolError } from './relay-codec.ts'

interface ConsoleRequestControl {
  readonly correlationId: string
  readonly targetGeneration: number
}
export type ConsoleWireRequest = ConsoleRequestControl & (
  | { readonly kind: 'console.projection'; readonly agentId: string }
  | { readonly kind: 'console.command'; readonly command: ConsoleCommandV1 }
  | { readonly kind: 'console.session'; readonly agentId: string; readonly sessionId: string; readonly payload: JsonValue }
)
export type ConsoleWireReply =
  | { readonly kind: 'console.projection.result'; readonly correlationId: string; readonly projection: ConsoleProjectionV1 }
  | { readonly kind: 'console.result'; readonly correlationId: string; readonly result: ConsoleCommandResultV1 }

/** This decoder grants no permission: runtime binds the authenticated peer and checks generation. */
export function parseConsoleWireRequest(text: string): ConsoleWireRequest {
  const input: unknown = JSON.parse(text)
  assertJsonValue(input, 'Console wire request')
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new RelayProtocolError('INVALID_INPUT', 'Console request must be an object')
  const frame = input as Record<string, unknown>
  const requireText = (value: unknown) => {
    if (typeof value !== 'string' || !value) throw new RelayProtocolError('INVALID_INPUT', 'Console request identity is required')
  }
  requireText(frame.correlationId)
  if (!Number.isSafeInteger(frame.targetGeneration) || (frame.targetGeneration as number) < 1) throw new RelayProtocolError('INVALID_INPUT', 'Console request generation is invalid')
  const common = ['kind', 'correlationId', 'targetGeneration']
  switch (frame.kind) {
    case 'console.projection':
      assertEnvelopeKeys(frame, [...common, 'agentId'], 'Console projection request')
      requireText(frame.agentId)
      break
    case 'console.command':
      assertEnvelopeKeys(frame, [...common, 'command'], 'Console command request')
      parseConsoleCommand(frame.command)
      break
    case 'console.session':
      assertEnvelopeKeys(frame, [...common, 'agentId', 'sessionId', 'payload'], 'Console Session request')
      requireText(frame.agentId); requireText(frame.sessionId)
      if (!Object.hasOwn(frame, 'payload')) throw new RelayProtocolError('INVALID_INPUT', 'Console Session payload is required')
      break
    default: throw new RelayProtocolError('INVALID_INPUT', 'Unknown Console request')
  }
  return frame as unknown as ConsoleWireRequest
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Console response object required')
  const result = value as Record<string, unknown>
  assertEnvelopeKeys(result, keys, 'Console response')
  return result
}
function string(value: unknown): void {
  if (typeof value !== 'string' || !value) throw new Error('Console response identity required')
}
function optionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throw new Error('Console response string required')
}
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Console response revision invalid')
}
function choice(value: unknown, values: readonly unknown[]): void {
  if (!values.includes(value)) throw new Error('Console response enum invalid')
}
function array(value: unknown, validate: (item: unknown) => void): void {
  if (!Array.isArray(value)) throw new Error('Console response array required')
  value.forEach(validate)
}
function error(value: unknown): void {
  const input = record(value, ['code', 'message', 'execution', 'status', 'providerInstanceId'])
  // Validate shared fields through their owner; the Console-only credential code is retained verbatim.
  parseServiceError({ code: input.code === 'CREDENTIAL_UNAVAILABLE' ? 'UNAVAILABLE' : input.code, message: input.message,
    ...(input.execution === undefined ? {} : { execution: input.execution }) }, 'Console error')
  optionalString(input.providerInstanceId)
  if (input.status !== undefined && (!Number.isSafeInteger(input.status) || (input.status as number) < 100 || (input.status as number) > 599)) throw new Error('Console response HTTP status invalid')
}
function projection(value: unknown): void {
  const input = record(value, ['version', 'agents', 'sessions', 'notifications', 'configs', 'sessionEvents', 'works', 'relations'])
  choice(input.version, [1])
  array(input.agents, item => {
    const agent = record(item, ['agentId', 'label', 'machineId', 'generation', 'presence', 'capabilities', 'currentSessionId', 'providerId', 'modelId'])
    string(agent.agentId); string(agent.machineId); string(agent.label)
    if (agent.generation !== undefined && (!Number.isSafeInteger(agent.generation) || (agent.generation as number) < 1)) throw new Error('Console agent generation invalid')
    choice(agent.presence, ['online', 'offline', 'unknown']); array(agent.capabilities, string)
    optionalString(agent.currentSessionId); optionalString(agent.providerId); optionalString(agent.modelId)
  })
  array(input.sessions, item => {
    const session = record(item, ['agentId', 'sessionId', 'title'])
    string(session.agentId); string(session.sessionId); optionalString(session.title)
  })
  array(input.notifications, item => {
    const notice = record(item, ['agentId', 'notificationId', 'sessionId', 'kind', 'state', 'title', 'permissionId'])
    string(notice.agentId); string(notice.notificationId); string(notice.title)
    choice(notice.kind, ['notice', 'permission']); choice(notice.state, ['pending', 'resolved'])
    optionalString(notice.sessionId); optionalString(notice.permissionId)
  })
  array(input.configs, item => {
    const config = record(item, ['agentId', 'acceptedRevision', 'effectiveRevision', 'providers', 'error'])
    string(config.agentId); revision(config.acceptedRevision)
    if (config.effectiveRevision !== undefined) revision(config.effectiveRevision)
    if (config.error !== undefined) error(config.error)
    array(config.providers, item => {
      const provider = record(item, ['id', 'label', 'protocol', 'apiBaseUrl', 'enabled', 'authKind', 'catalogState', 'models', 'error'])
      string(provider.id); string(provider.label); string(provider.apiBaseUrl)
      choice(provider.protocol, ['openai-chat', 'openai-responses']); choice(provider.enabled, [true, false])
      choice(provider.authKind, ['none', 'bearer']); choice(provider.catalogState, ['ready', 'empty', 'stale', 'error'])
      if (provider.error !== undefined) error(provider.error)
      array(provider.models, item => { const model = record(item, ['id', 'label']); string(model.id); optionalString(model.label) })
    })
  })
  if (input.works !== undefined || input.relations !== undefined) parseConsoleWorkRelationProjection(input)
}

export function parseConsoleWireReply(text: string): ConsoleWireReply {
  const value: unknown = JSON.parse(text)
  assertJsonValue(value, 'Console response')
  const frame = record(value, ['kind', 'correlationId', 'projection', 'result'])
  string(frame.correlationId)
  if (frame.kind === 'console.projection.result') {
    assertEnvelopeKeys(frame, ['kind', 'correlationId', 'projection'], 'Console projection response')
    projection(frame.projection)
  } else if (frame.kind === 'console.result') {
    assertEnvelopeKeys(frame, ['kind', 'correlationId', 'result'], 'Console command response')
    const result = record(frame.result, ['ok', 'result', 'error'])
    choice(result.ok, [true, false])
    if (result.ok === true) assertEnvelopeKeys(result, ['ok', 'result'], 'Console success')
    else { assertEnvelopeKeys(result, ['ok', 'error'], 'Console failure'); error(result.error) }
  } else throw new Error('Unknown Console response kind')
  return frame as unknown as ConsoleWireReply
}
