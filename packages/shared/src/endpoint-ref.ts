import type { ServiceErrorCode } from './agent-services.ts'
import { assertEnvelopeKeys } from './json-value.ts'

const ENDPOINT_KINDS = ['browser', 'shell', 'filesystem', 'llm', 'device', 'service'] as const
const ENDPOINT_LIFECYCLES = ['active', 'draining', 'disabled'] as const

export type EndpointKind = (typeof ENDPOINT_KINDS)[number]
export type EndpointLifecycle = (typeof ENDPOINT_LIFECYCLES)[number]

export interface EndpointCapabilitySummary {
  readonly capabilityId: string
  readonly version: string
  readonly operations: readonly string[]
}

export interface EndpointResourceSummary {
  readonly resourceId: string
  readonly capacity: number
  readonly unit: 'slot' | 'context'
}

export interface EndpointDiscoveryView {
  readonly endpointId: string
  readonly ownerAgentId: string
  readonly scopeId: string
  readonly kind: EndpointKind
  readonly revision: number
  readonly lifecycle: EndpointLifecycle
  readonly capabilities: readonly EndpointCapabilitySummary[]
  readonly resources: readonly EndpointResourceSummary[]
}

export interface EndpointReference {
  readonly providerAgentId: string
  readonly endpointId: string
  readonly revision: number
}

export interface WorkEndpointReference extends EndpointReference {
  readonly workId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
}

export interface EndpointViewer {
  readonly agentId: string
  readonly scopeId: string
}

const VIEW_FIELDS = ['endpointId', 'ownerAgentId', 'scopeId', 'kind', 'revision', 'lifecycle', 'capabilities', 'resources'] as const
const REF_FIELDS = ['providerAgentId', 'endpointId', 'revision'] as const
const WORK_REF_FIELDS = ['workId', 'providerAgentId', 'endpointId', 'revision', 'capabilityId', 'capabilityVersion', 'operation'] as const
const CAP_FIELDS = ['capabilityId', 'version', 'operations'] as const
const RESOURCE_FIELDS = ['resourceId', 'capacity', 'unit'] as const

function fail(code: ServiceErrorCode, message: string): never {
  const error = new Error(`${code}: ${message}`) as Error & { code: ServiceErrorCode }
  error.code = code
  throw error
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_INPUT', `${label} must be an object`)
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('INVALID_INPUT', `${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('INVALID_INPUT', `${label} must be a positive safe integer`)
  return value as number
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail('INVALID_INPUT', `${label} is unsupported`)
  return value as T
}

/** Endpoint identity is not a URL, route candidate, or target transport. */
export function assertEndpointIdentity(value: string, label: string): string {
  if (/:\/\//.test(value) || /^(wss?|https?):/i.test(value)) {
    fail('INVALID_INPUT', `${label} is not a URL or transport target`)
  }
  return value
}

function known(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  try {
    assertEnvelopeKeys(value, fields, label)
  } catch (error) {
    fail('INVALID_INPUT', error instanceof Error ? error.message : `${label} has unsupported fields`)
  }
}

function parseCapabilitySummary(value: unknown, index: number): EndpointCapabilitySummary {
  const label = `endpoint.capabilities[${index}]`
  const input = object(value, label)
  known(input, CAP_FIELDS, label)
  const capabilityId = assertEndpointIdentity(stringValue(input.capabilityId, `${label}.capabilityId`), `${label}.capabilityId`)
  if (!Array.isArray(input.operations) || input.operations.some(item => typeof item !== 'string' || item.length === 0)) {
    fail('INVALID_INPUT', `${label}.operations must be non-empty strings`)
  }
  return {
    capabilityId,
    version: stringValue(input.version, `${label}.version`),
    operations: input.operations as string[],
  }
}

function parseResourceSummary(value: unknown, index: number): EndpointResourceSummary {
  const label = `endpoint.resources[${index}]`
  const input = object(value, label)
  known(input, RESOURCE_FIELDS, label)
  return {
    resourceId: assertEndpointIdentity(stringValue(input.resourceId, `${label}.resourceId`), `${label}.resourceId`),
    capacity: positiveInteger(input.capacity, `${label}.capacity`),
    unit: enumValue(input.unit, ['slot', 'context'], `${label}.unit`),
  }
}

export function parseEndpointDiscoveryView(value: unknown): EndpointDiscoveryView {
  const input = object(value, 'endpoint view')
  known(input, VIEW_FIELDS, 'endpoint view')
  if (!Array.isArray(input.capabilities) || !Array.isArray(input.resources)) fail('INVALID_INPUT', 'endpoint summaries must be arrays')
  return {
    endpointId: assertEndpointIdentity(stringValue(input.endpointId, 'endpointId'), 'endpointId'),
    ownerAgentId: stringValue(input.ownerAgentId, 'ownerAgentId'),
    scopeId: stringValue(input.scopeId, 'scopeId'),
    kind: enumValue(input.kind, ENDPOINT_KINDS, 'kind'),
    revision: positiveInteger(input.revision, 'revision'),
    lifecycle: enumValue(input.lifecycle, ENDPOINT_LIFECYCLES, 'lifecycle'),
    capabilities: input.capabilities.map(parseCapabilitySummary),
    resources: input.resources.map(parseResourceSummary),
  }
}

export function parseEndpointReference(value: unknown): EndpointReference {
  const input = object(value, 'endpoint reference')
  known(input, REF_FIELDS, 'endpoint reference')
  return {
    providerAgentId: stringValue(input.providerAgentId, 'providerAgentId'),
    endpointId: assertEndpointIdentity(stringValue(input.endpointId, 'endpointId'), 'endpointId'),
    revision: positiveInteger(input.revision, 'revision'),
  }
}

export function parseWorkEndpointReference(value: unknown): WorkEndpointReference {
  const input = object(value, 'work endpoint reference')
  known(input, WORK_REF_FIELDS, 'work endpoint reference')
  return {
    workId: stringValue(input.workId, 'workId'),
    providerAgentId: stringValue(input.providerAgentId, 'providerAgentId'),
    endpointId: assertEndpointIdentity(stringValue(input.endpointId, 'endpointId'), 'endpointId'),
    revision: positiveInteger(input.revision, 'revision'),
    capabilityId: assertEndpointIdentity(stringValue(input.capabilityId, 'capabilityId'), 'capabilityId'),
    capabilityVersion: stringValue(input.capabilityVersion, 'capabilityVersion'),
    operation: stringValue(input.operation, 'operation'),
  }
}

export function filterVisibleEndpoints(catalog: readonly EndpointDiscoveryView[], viewer: EndpointViewer): EndpointDiscoveryView[] {
  return catalog.filter(view => view.scopeId === viewer.scopeId && (view.lifecycle !== 'disabled' || view.ownerAgentId === viewer.agentId))
}

export function admitEndpointReference(
  catalog: readonly EndpointDiscoveryView[],
  viewer: EndpointViewer,
  ref: EndpointReference,
): EndpointDiscoveryView {
  const parsed = parseEndpointReference({
    providerAgentId: ref.providerAgentId,
    endpointId: ref.endpointId,
    revision: ref.revision,
  })
  const owned = catalog.find(view => view.endpointId === parsed.endpointId && view.ownerAgentId === parsed.providerAgentId)
  if (!owned) {
    if (catalog.some(view => view.endpointId === parsed.endpointId)) fail('FORBIDDEN', 'Endpoint owner does not match provider')
    fail('NOT_FOUND', `unknown Endpoint ${parsed.endpointId}`)
  }
  if (owned.scopeId !== viewer.scopeId) fail('FORBIDDEN', 'Endpoint is outside the viewer scope')
  if (owned.lifecycle === 'disabled' && owned.ownerAgentId !== viewer.agentId) fail('FORBIDDEN', 'disabled Endpoint is not visible')
  if (parsed.revision !== owned.revision) fail('REVISION_CONFLICT', `Endpoint revision is ${owned.revision}, not ${parsed.revision}`)
  return owned
}

export function admitWorkEndpointReference(
  catalog: readonly EndpointDiscoveryView[],
  viewer: EndpointViewer,
  ref: WorkEndpointReference,
): EndpointDiscoveryView {
  const parsed = parseWorkEndpointReference(ref)
  const view = admitEndpointReference(catalog, viewer, parsed)
  if (view.lifecycle !== 'active') {
    fail('FORBIDDEN', `Endpoint ${parsed.endpointId} lifecycle ${view.lifecycle} is not active`)
  }
  const capability = view.capabilities.find(item => item.capabilityId === parsed.capabilityId && item.version === parsed.capabilityVersion)
  if (!capability) fail('NOT_FOUND', `capability ${parsed.capabilityId} is not mounted on Endpoint ${parsed.endpointId}`)
  if (!capability.operations.includes(parsed.operation)) fail('NOT_FOUND', `operation ${parsed.operation} is not on ${parsed.capabilityId}`)
  return view
}
