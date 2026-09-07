import { fail } from './errors.ts'
import {
  ENDPOINT_KINDS,
  ENDPOINT_LIFECYCLES,
  type CapabilityDescriptor,
  type EndpointDescriptor,
  type EndpointKind,
  type EndpointLifecycle,
  type JsonValue,
  type OperationDescriptor,
  type ResourceDescriptor,
} from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertEnvelopeKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('INVALID_INPUT', `${path} has unsupported field ${key}`)
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('INVALID_IDENTITY', `${label} is required`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail('INVALID_REVISION', `${label} must be a positive integer`)
  }
  return value
}

function assertJsonValue(value: unknown, path: string, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || value === null) fail('INVALID_INPUT', `${path} must contain only JSON values`)
  if (ancestors.has(value)) fail('INVALID_INPUT', `${path} contains a JSON cycle`)
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT', `${path} must be a plain JSON object`)
  ancestors.add(value)
  try {
    const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'))
    if (array && keys.length !== value.length) fail('INVALID_INPUT', `${path} must be a dense JSON array`)
    for (const key of keys) {
      if (typeof key !== 'string') fail('INVALID_INPUT', `${path} has a non-JSON key`)
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('INVALID_INPUT', `${path} has a non-JSON array property`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) fail('INVALID_INPUT', `${path}.${key} must be a JSON data property`)
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function parseOperation(value: unknown, path: string): OperationDescriptor {
  if (!isRecord(value)) fail('INVALID_INPUT', `${path} must be an object`)
  assertEnvelopeKeys(value, ['operation', 'inputSchema', 'outputSchema', 'cancellation'], path)
  if (!isRecord(value.inputSchema)) fail('INVALID_INPUT', `${path}.inputSchema must be an object`)
  if (!isRecord(value.outputSchema)) fail('INVALID_INPUT', `${path}.outputSchema must be an object`)
  assertJsonValue(value.inputSchema, `${path}.inputSchema`)
  assertJsonValue(value.outputSchema, `${path}.outputSchema`)
  if (value.cancellation !== 'unsupported' && value.cancellation !== 'cooperative') {
    fail('INVALID_INPUT', `${path}.cancellation is unsupported`)
  }
  return {
    operation: requiredString(value.operation, `${path}.operation`),
    inputSchema: value.inputSchema,
    outputSchema: value.outputSchema,
    cancellation: value.cancellation,
  }
}

function parseCapability(value: unknown, path: string, seen: Set<string>): CapabilityDescriptor {
  if (!isRecord(value)) fail('INVALID_INPUT', `${path} must be an object`)
  assertEnvelopeKeys(value, ['capabilityId', 'version', 'operations'], path)
  const capabilityId = requiredString(value.capabilityId, `${path}.capabilityId`)
  if (seen.has(capabilityId)) fail('CONFLICT', `duplicate capability ${capabilityId} on Endpoint`)
  seen.add(capabilityId)
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    fail('INVALID_INPUT', `${path}.operations must be a non-empty array`)
  }
  const operations = value.operations.map((operation, index) => parseOperation(operation, `${path}.operations[${index}]`))
  const names = new Set<string>()
  for (const operation of operations) {
    if (names.has(operation.operation)) fail('CONFLICT', `duplicate operation ${operation.operation} on ${capabilityId}`)
    names.add(operation.operation)
  }
  return {
    capabilityId,
    version: requiredString(value.version, `${path}.version`),
    operations,
  }
}

function parseResource(value: unknown, path: string, seen: Set<string>): ResourceDescriptor {
  if (!isRecord(value)) fail('INVALID_INPUT', `${path} must be an object`)
  assertEnvelopeKeys(value, ['resourceId', 'capacity', 'unit', 'sharing', 'allocationScope'], path)
  const resourceId = requiredString(value.resourceId, `${path}.resourceId`)
  if (seen.has(resourceId)) fail('CONFLICT', `duplicate resource ${resourceId} on Endpoint`)
  seen.add(resourceId)
  if (typeof value.capacity !== 'number' || !Number.isInteger(value.capacity) || value.capacity < 1) {
    fail('INVALID_INPUT', `${path}.capacity must be a positive integer`)
  }
  if (value.unit !== 'slot' && value.unit !== 'context') fail('INVALID_INPUT', `${path}.unit is unsupported`)
  if (value.sharing !== 'exclusive' && value.sharing !== 'shared') fail('INVALID_INPUT', `${path}.sharing is unsupported`)
  if (value.allocationScope !== 'request' && value.allocationScope !== 'work') {
    fail('INVALID_INPUT', `${path}.allocationScope is unsupported`)
  }
  return {
    resourceId,
    capacity: value.capacity,
    unit: value.unit,
    sharing: value.sharing,
    allocationScope: value.allocationScope,
  }
}

export function parseEndpointKind(value: unknown, path: string): EndpointKind {
  if (typeof value !== 'string' || !(ENDPOINT_KINDS as readonly string[]).includes(value)) {
    fail('INVALID_IDENTITY', `${path} must be a known Endpoint kind`)
  }
  return value as EndpointKind
}

export function parseEndpointLifecycle(value: unknown, path: string): EndpointLifecycle {
  if (typeof value !== 'string' || !(ENDPOINT_LIFECYCLES as readonly string[]).includes(value)) {
    fail('INVALID_LIFECYCLE', `${path} must be active, draining, or disabled`)
  }
  return value as EndpointLifecycle
}

export function validateEndpointDescriptor(value: unknown): EndpointDescriptor {
  if (!isRecord(value)) fail('INVALID_INPUT', 'endpoint descriptor must be an object')
  assertEnvelopeKeys(value, [
    'endpointId',
    'ownerAgentId',
    'kind',
    'label',
    'revision',
    'lifecycle',
    'capabilities',
    'resources',
  ], 'endpoint')
  if (!Array.isArray(value.capabilities)) fail('INVALID_INPUT', 'endpoint.capabilities must be an array')
  if (!Array.isArray(value.resources)) fail('INVALID_INPUT', 'endpoint.resources must be an array')
  const capabilityIds = new Set<string>()
  const resourceIds = new Set<string>()
  const capabilities = value.capabilities.map((capability, index) => parseCapability(capability, `endpoint.capabilities[${index}]`, capabilityIds))
  const resources = value.resources.map((resource, index) => parseResource(resource, `endpoint.resources[${index}]`, resourceIds))
  const label = requiredString(value.label, 'endpoint.label')
  return {
    endpointId: requiredString(value.endpointId, 'endpoint.endpointId'),
    ownerAgentId: requiredString(value.ownerAgentId, 'endpoint.ownerAgentId'),
    kind: parseEndpointKind(value.kind, 'endpoint.kind'),
    label,
    revision: positiveInteger(value.revision, 'endpoint.revision'),
    lifecycle: parseEndpointLifecycle(value.lifecycle, 'endpoint.lifecycle'),
    capabilities,
    resources,
  }
}

export function endpointKey(ownerAgentId: string, endpointId: string): string {
  return `${ownerAgentId}\0${endpointId}`
}
