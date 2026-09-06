import type {
  AgentDeclaration,
  CliExecutionFailure,
  JsonValue,
  RelayGrant,
  RelayPeer,
  RelayServerControl,
  ServiceError,
  ServiceErrorCode,
} from './agent-services.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'

export class RelayProtocolError extends Error {
  constructor(readonly code: ServiceErrorCode, message: string) { super(message) }
}

const errorCodes: readonly ServiceErrorCode[] = [
  'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATION', 'STALE_GENERATION', 'REVISION_CONFLICT', 'RESOURCE_EXHAUSTED',
  'CONFLICT', 'RESULT_UNKNOWN', 'UNAVAILABLE', 'UPSTREAM_ERROR',
]

type OperationDeclaration = AgentDeclaration['capabilities'][number]['operations'][number]
type ResourceDeclaration = AgentDeclaration['capabilities'][number]['resources'][number]
type CapabilityDeclaration = AgentDeclaration['capabilities'][number]
type RouteCandidate = AgentDeclaration['routes'][number]

function invalid(message: string): never {
  throw new RelayProtocolError('INVALID_INPUT', message)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} must be a positive safe integer`)
  return value as number
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a non-negative safe integer`)
  return value as number
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`)
  return value
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(`${label} is unsupported`)
  return value as T
}

function isoDate(value: unknown, label: string): string {
  const parsed = stringValue(value, label)
  if (Number.isNaN(Date.parse(parsed))) invalid(`${label} must be an ISO date`)
  return parsed
}

function jsonValue(value: unknown, label: string): void {
  try {
    assertJsonValue(value, label)
  } catch (error) {
    invalid(error instanceof Error ? error.message : `${label} must contain only JSON values`)
  }
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const input = object(value, label)
  jsonValue(input, label)
  return input as Readonly<Record<string, JsonValue>>
}

function knownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  try {
    assertEnvelopeKeys(value, fields, label)
  } catch (error) {
    invalid(error instanceof Error ? error.message : `${label} has unsupported fields`)
  }
}

function parseOperation(value: unknown, index: number): OperationDeclaration {
  const label = `declaration.capabilities[].operations[${index}]`
  const input = object(value, label)
  knownFields(input, ['operation', 'inputSchema', 'outputSchema', 'cancellation'], label)
  return {
    operation: stringValue(input.operation, `${label}.operation`),
    inputSchema: jsonObject(input.inputSchema, `${label}.inputSchema`),
    outputSchema: jsonObject(input.outputSchema, `${label}.outputSchema`),
    cancellation: enumValue(input.cancellation, ['unsupported', 'cooperative'], `${label}.cancellation`),
  }
}

function parseResource(value: unknown, index: number): ResourceDeclaration {
  const label = `declaration.capabilities[].resources[${index}]`
  const input = object(value, label)
  knownFields(input, ['resourceId', 'capacity', 'unit', 'sharing', 'allocationScope'], label)
  return {
    resourceId: stringValue(input.resourceId, `${label}.resourceId`),
    capacity: positiveInteger(input.capacity, `${label}.capacity`),
    unit: enumValue(input.unit, ['slot', 'context'], `${label}.unit`),
    sharing: enumValue(input.sharing, ['exclusive', 'shared'], `${label}.sharing`),
    allocationScope: enumValue(input.allocationScope, ['request', 'work'], `${label}.allocationScope`),
  }
}

function parseCapability(value: unknown, index: number): CapabilityDeclaration {
  const label = `declaration.capabilities[${index}]`
  const input = object(value, label)
  knownFields(input, ['capabilityId', 'version', 'operations', 'resources'], label)
  if (!Array.isArray(input.operations) || !Array.isArray(input.resources)) invalid(`${label} operations/resources must be arrays`)
  jsonValue(input.operations, `${label}.operations`)
  jsonValue(input.resources, `${label}.resources`)
  return {
    capabilityId: stringValue(input.capabilityId, `${label}.capabilityId`),
    version: stringValue(input.version, `${label}.version`),
    operations: input.operations.map((operation, operationIndex) => parseOperation(operation, operationIndex)),
    resources: input.resources.map((resource, resourceIndex) => parseResource(resource, resourceIndex)),
  }
}

function parseRoute(value: unknown, index: number): RouteCandidate {
  const label = `declaration.routes[${index}]`
  const input = object(value, label)
  knownFields(input, ['candidateId', 'kind', 'endpoint', 'port', 'authRequired', 'lastSeenAt'], label)
  const route: RouteCandidate = {
    candidateId: stringValue(input.candidateId, `${label}.candidateId`),
    kind: enumValue(input.kind, ['lan', 'tailscale', 'ipv6', 'ipv4', 'gateway', 'relay-ws', 'relay-webrtc'], `${label}.kind`),
    authRequired: booleanValue(input.authRequired, `${label}.authRequired`),
    lastSeenAt: isoDate(input.lastSeenAt, `${label}.lastSeenAt`),
  }
  if (input.endpoint !== undefined) route.endpoint = stringValue(input.endpoint, `${label}.endpoint`)
  if (input.port !== undefined) {
    const port = positiveInteger(input.port, `${label}.port`)
    if (port > 65535) invalid(`${label}.port is invalid`)
    route.port = port
  }
  return route
}

export function parseAgentDeclaration(value: unknown): AgentDeclaration {
  const input = object(value, 'declaration')
  const identityInput = object(input.identity, 'declaration.identity')
  knownFields(input, ['identity', 'scopeId', 'revision', 'capabilities', 'routes'], 'declaration')
  knownFields(identityInput, ['hostId', 'machineId', 'agentId', 'accountId', 'agentKind', 'label'], 'declaration.identity')
  if (!Array.isArray(input.capabilities) || !Array.isArray(input.routes)) invalid('declaration capabilities/routes must be arrays')
  jsonValue(input.capabilities, 'declaration.capabilities')
  jsonValue(input.routes, 'declaration.routes')
  return {
    identity: {
      hostId: stringValue(identityInput.hostId, 'declaration.identity.hostId'),
      machineId: stringValue(identityInput.machineId, 'declaration.identity.machineId'),
      agentId: stringValue(identityInput.agentId, 'declaration.identity.agentId'),
      accountId: stringValue(identityInput.accountId, 'declaration.identity.accountId'),
      agentKind: enumValue(identityInput.agentKind, ['opencode', 'acp', 'custom'], 'declaration.identity.agentKind'),
      label: stringValue(identityInput.label, 'declaration.identity.label'),
    },
    scopeId: stringValue(input.scopeId, 'declaration.scopeId'),
    revision: positiveInteger(input.revision, 'declaration.revision'),
    capabilities: input.capabilities.map((capability, index) => parseCapability(capability, index)),
    routes: input.routes.map((route, index) => parseRoute(route, index)),
  }
}

export function parseServiceError(value: unknown, label: string): ServiceError {
  const input = object(value, label)
  knownFields(input, ['code', 'message', 'execution'], label)
  let execution: CliExecutionFailure | undefined
  if (input.execution !== undefined) {
    const detail = object(input.execution, `${label}.execution`)
    knownFields(detail, ['kind', 'code', 'message', 'contextId', 'exitCode', 'signal', 'stdout', 'stderr'], `${label}.execution`)
    if (detail.kind !== 'cli') invalid(`${label}.execution.kind is unsupported`)
    if (detail.exitCode !== undefined && detail.exitCode !== null && (!Number.isSafeInteger(detail.exitCode) || (detail.exitCode as number) < 0)) invalid(`${label}.execution.exitCode is invalid`)
    if (detail.signal !== undefined && detail.signal !== null) stringValue(detail.signal, `${label}.execution.signal`)
    for (const field of ['stdout', 'stderr'] as const) {
      if (detail[field] !== undefined && typeof detail[field] !== 'string') invalid(`${label}.execution.${field} must be text`)
    }
    execution = { kind: 'cli', code: stringValue(detail.code, `${label}.execution.code`),
      message: stringValue(detail.message, `${label}.execution.message`),
      ...(detail.contextId === undefined ? {} : { contextId: stringValue(detail.contextId, `${label}.execution.contextId`) }),
      ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode as number | null }),
      ...(detail.signal === undefined ? {} : { signal: detail.signal as string | null }),
      ...(detail.stdout === undefined ? {} : { stdout: detail.stdout as string }),
      ...(detail.stderr === undefined ? {} : { stderr: detail.stderr as string }) }
  }
  return {
    code: enumValue(input.code, errorCodes, `${label}.code`),
    message: stringValue(input.message, `${label}.message`),
    ...(execution ? { execution } : {}),
  }
}

function parsePeer(value: unknown, index: number): RelayPeer {
  const label = `peer[${index}]`
  const input = object(value, label)
  knownFields(input, ['declaration', 'connectionId', 'generation', 'lastSeenAt', 'presence'], label)
  return {
    declaration: parseAgentDeclaration(input.declaration),
    connectionId: stringValue(input.connectionId, `${label}.connectionId`),
    generation: positiveInteger(input.generation, `${label}.generation`),
    lastSeenAt: isoDate(input.lastSeenAt, `${label}.lastSeenAt`),
    presence: enumValue(input.presence, ['online', 'offline'], `${label}.presence`),
  }
}

function parseGrant(value: unknown, label: string): RelayGrant {
  const input = object(value, label)
  knownFields(input, ['grantId', 'accountId', 'scopeId', 'sourceAgentId', 'targetAgentId', 'sourceGeneration', 'targetGeneration', 'expiresAt'], label)
  return {
    grantId: stringValue(input.grantId, `${label}.grantId`),
    accountId: stringValue(input.accountId, `${label}.accountId`),
    scopeId: stringValue(input.scopeId, `${label}.scopeId`),
    sourceAgentId: stringValue(input.sourceAgentId, `${label}.sourceAgentId`),
    targetAgentId: stringValue(input.targetAgentId, `${label}.targetAgentId`),
    sourceGeneration: positiveInteger(input.sourceGeneration, `${label}.sourceGeneration`),
    targetGeneration: positiveInteger(input.targetGeneration, `${label}.targetGeneration`),
    expiresAt: isoDate(input.expiresAt, `${label}.expiresAt`),
  }
}

function parseText(text: string): unknown {
  if (typeof text !== 'string') invalid('relay server control must be text')
  try {
    return JSON.parse(text)
  } catch {
    invalid('relay server control is not valid JSON')
  }
}

export function parseRelayServerControl(text: string): RelayServerControl {
  const input = object(parseText(text), 'relay server control')
  const kind = stringValue(input.kind, 'kind')
  switch (kind) {
    case 'relay.admitted':
      knownFields(input, ['kind', 'connectionId', 'generation'], kind)
      stringValue(input.connectionId, 'connectionId')
      positiveInteger(input.generation, 'generation')
      return input as unknown as RelayServerControl
    case 'relay.directory':
      knownFields(input, ['kind', 'requestId', 'revision', 'peers'], kind)
      stringValue(input.requestId, 'requestId')
      nonNegativeInteger(input.revision, 'revision')
      if (!Array.isArray(input.peers)) invalid('peers must be an array')
      jsonValue(input.peers, 'peers')
      input.peers.forEach((peer, index) => parsePeer(peer, index))
      return input as unknown as RelayServerControl
    case 'relay.changed':
      knownFields(input, ['kind', 'revision', 'peer'], kind)
      nonNegativeInteger(input.revision, 'revision')
      parsePeer(input.peer, 0)
      return input as unknown as RelayServerControl
    case 'relay.grant':
      knownFields(input, ['kind', 'requestId', 'grant'], kind)
      stringValue(input.requestId, 'requestId')
      parseGrant(input.grant, 'grant')
      return input as unknown as RelayServerControl
    case 'relay.offer':
      knownFields(input, ['kind', 'grant'], kind)
      parseGrant(input.grant, 'grant')
      return input as unknown as RelayServerControl
    case 'relay.opened':
      knownFields(input, ['kind', 'requestId', 'grantId'], kind)
      stringValue(input.requestId, 'requestId')
      stringValue(input.grantId, 'grantId')
      return input as unknown as RelayServerControl
    case 'relay.closed':
      knownFields(input, ['kind', 'grantId', 'error'], kind)
      stringValue(input.grantId, 'grantId')
      if (input.error !== undefined) parseServiceError(input.error, 'error')
      return input as unknown as RelayServerControl
    case 'relay.error':
      knownFields(input, ['kind', 'requestId', 'error'], kind)
      if (input.requestId !== undefined) stringValue(input.requestId, 'requestId')
      parseServiceError(input.error, 'error')
      return input as unknown as RelayServerControl
    default:
      invalid(`unknown relay server control: ${kind}`)
  }
}
