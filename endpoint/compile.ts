import { fail } from './errors.ts'
import type { CompileLegacyAgentCapabilitiesInput, EndpointDescriptor, ResourceDescriptor } from './types.ts'
import { validateEndpointDescriptor } from './validate.ts'

/**
 * Sole compile/admission conversion from old Agent capability input into one Endpoint descriptor.
 * Callers must supply a stable endpointId; it is never derived from a capability name.
 */
export function compileLegacyAgentCapabilities(input: CompileLegacyAgentCapabilitiesInput): EndpointDescriptor {
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    fail('INVALID_INPUT', 'legacy capabilities must be a non-empty array')
  }
  const resources: ResourceDescriptor[] = []
  const seenResources = new Set<string>()
  const capabilities = input.capabilities.map(capability => {
    if (capability.resources === undefined) fail('INVALID_INPUT', `legacy capability ${capability.capabilityId} resources are required`)
    for (const resource of capability.resources) {
      if (seenResources.has(resource.resourceId)) {
        fail('CONFLICT', `legacy resource ${resource.resourceId} would have two owners`)
      }
      seenResources.add(resource.resourceId)
      resources.push(resource)
    }
    return {
      capabilityId: capability.capabilityId,
      version: capability.version,
      operations: capability.operations,
    }
  })
  return validateEndpointDescriptor({
    endpointId: input.endpointId,
    ownerAgentId: input.ownerAgentId,
    kind: input.kind,
    label: input.label,
    revision: 1,
    lifecycle: 'active',
    capabilities,
    resources,
  })
}
