import { fail } from './errors.ts'
import type { CapabilityDescriptor, EndpointDescriptor, EndpointLifecycle, EndpointRegistry, ResourceDescriptor } from './types.ts'
import { endpointKey, validateEndpointDescriptor } from './validate.ts'

const LIFECYCLE_TRANSITIONS: Record<EndpointLifecycle, readonly EndpointLifecycle[]> = {
  active: ['active', 'draining', 'disabled'],
  draining: ['draining', 'disabled'],
  disabled: ['disabled'],
}

export function createEndpointRegistry(): EndpointRegistry {
  return { endpoints: new Map() }
}

function requireActor(actorAgentId: string, ownerAgentId: string): void {
  if (actorAgentId !== ownerAgentId) fail('CROSS_AGENT_OWNERSHIP', `agent ${actorAgentId} cannot mutate Endpoint owned by ${ownerAgentId}`)
}

function requirePresent(registry: EndpointRegistry, ownerAgentId: string, endpointId: string): EndpointDescriptor {
  const current = registry.endpoints.get(endpointKey(ownerAgentId, endpointId))
  if (current === undefined) fail('NOT_FOUND', `endpoint ${endpointId} is not registered for agent ${ownerAgentId}`)
  return current
}

function assertResourceOwnership(registry: EndpointRegistry, descriptor: EndpointDescriptor, replacing?: EndpointDescriptor): void {
  const reserved = new Set(replacing?.resources.map(resource => resource.resourceId) ?? [])
  for (const resource of descriptor.resources) {
    for (const existing of registry.endpoints.values()) {
      if (existing.ownerAgentId !== descriptor.ownerAgentId) continue
      if (existing.endpointId === descriptor.endpointId) continue
      if (existing.resources.some(item => item.resourceId === resource.resourceId) && !reserved.has(resource.resourceId)) {
        fail('RESOURCE_OUTSIDE_ENDPOINT', `resource ${resource.resourceId} is already owned by Endpoint ${existing.endpointId}`)
      }
    }
  }
}

function assertLifecycleTransition(from: EndpointLifecycle, to: EndpointLifecycle): void {
  if (!LIFECYCLE_TRANSITIONS[from].includes(to)) {
    fail('INVALID_LIFECYCLE', `cannot transition Endpoint lifecycle from ${from} to ${to}`)
  }
}

export function registerEndpoint(registry: EndpointRegistry, actorAgentId: string, value: unknown): EndpointDescriptor {
  const descriptor = validateEndpointDescriptor(value)
  requireActor(actorAgentId, descriptor.ownerAgentId)
  if (descriptor.lifecycle !== 'active') fail('INVALID_LIFECYCLE', 'new Endpoint must start active')
  if (descriptor.revision !== 1) fail('INVALID_REVISION', 'new Endpoint revision must be 1')
  const key = endpointKey(descriptor.ownerAgentId, descriptor.endpointId)
  if (registry.endpoints.has(key)) fail('DUPLICATE_ENDPOINT_ID', `endpoint ${descriptor.endpointId} is already registered for agent ${descriptor.ownerAgentId}`)
  assertResourceOwnership(registry, descriptor)
  registry.endpoints.set(key, descriptor)
  return descriptor
}

export function reviseEndpoint(
  registry: EndpointRegistry,
  actorAgentId: string,
  input: { readonly endpointId: string; readonly expectedRevision: number; readonly descriptor: unknown },
): EndpointDescriptor {
  const current = requirePresent(registry, actorAgentId, input.endpointId)
  requireActor(actorAgentId, current.ownerAgentId)
  if (current.lifecycle === 'disabled') fail('ENDPOINT_DISABLED', `disabled Endpoint ${current.endpointId} cannot be revised`)
  if (input.expectedRevision !== current.revision) {
    fail('STALE_REVISION', `endpoint ${current.endpointId} revision is ${current.revision}, not ${input.expectedRevision}`)
  }
  const next = validateEndpointDescriptor(input.descriptor)
  requireActor(actorAgentId, next.ownerAgentId)
  if (next.endpointId !== current.endpointId || next.ownerAgentId !== current.ownerAgentId) {
    fail('INVALID_IDENTITY', 'Endpoint identity cannot change across revisions')
  }
  if (next.revision !== current.revision + 1) fail('INVALID_REVISION', `next Endpoint revision must be ${current.revision + 1}`)
  assertLifecycleTransition(current.lifecycle, next.lifecycle)
  assertResourceOwnership(registry, next, current)
  registry.endpoints.set(endpointKey(next.ownerAgentId, next.endpointId), next)
  return next
}

export function disableEndpoint(
  registry: EndpointRegistry,
  actorAgentId: string,
  input: { readonly endpointId: string; readonly expectedRevision: number },
): EndpointDescriptor {
  const current = requirePresent(registry, actorAgentId, input.endpointId)
  requireActor(actorAgentId, current.ownerAgentId)
  if (input.expectedRevision !== current.revision) {
    fail('STALE_REVISION', `endpoint ${current.endpointId} revision is ${current.revision}, not ${input.expectedRevision}`)
  }
  if (current.lifecycle === 'disabled') fail('INVALID_LIFECYCLE', `endpoint ${current.endpointId} is already disabled`)
  const next: EndpointDescriptor = { ...current, revision: current.revision + 1, lifecycle: 'disabled' }
  registry.endpoints.set(endpointKey(current.ownerAgentId, current.endpointId), next)
  return next
}

export function useEndpoint(registry: EndpointRegistry, actorAgentId: string, endpointId: string): EndpointDescriptor {
  const current = requirePresent(registry, actorAgentId, endpointId)
  requireActor(actorAgentId, current.ownerAgentId)
  if (current.lifecycle === 'disabled') fail('ENDPOINT_DISABLED', `disabled Endpoint ${endpointId} cannot be used`)
  return current
}

export function requireCapability(
  registry: EndpointRegistry,
  actorAgentId: string,
  endpointId: string,
  capabilityId: string,
): CapabilityDescriptor {
  const endpoint = useEndpoint(registry, actorAgentId, endpointId)
  const capability = endpoint.capabilities.find(item => item.capabilityId === capabilityId)
  if (capability === undefined) {
    fail('CAPABILITY_OUTSIDE_ENDPOINT', `capability ${capabilityId} is not mounted on Endpoint ${endpointId}`)
  }
  return capability
}

export function requireResource(
  registry: EndpointRegistry,
  actorAgentId: string,
  endpointId: string,
  resourceId: string,
): ResourceDescriptor {
  const endpoint = useEndpoint(registry, actorAgentId, endpointId)
  const resource = endpoint.resources.find(item => item.resourceId === resourceId)
  if (resource === undefined) {
    fail('RESOURCE_OUTSIDE_ENDPOINT', `resource ${resourceId} is not mounted on Endpoint ${endpointId}`)
  }
  return resource
}

export function listEndpoints(registry: EndpointRegistry, ownerAgentId: string): readonly EndpointDescriptor[] {
  return [...registry.endpoints.values()].filter(endpoint => endpoint.ownerAgentId === ownerAgentId)
}
