import type { AgentDeclaration, AuthenticatedAgent, RelayPeer } from '../control-protocol/agent-services.ts'
import {
  filterVisibleEndpoints,
  parseEndpointDiscoveryView,
  type EndpointDiscoveryView,
} from '../control-protocol/endpoint-ref.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'
import { compileLegacyAgentCapabilities } from '../endpoint/compile.ts'
import { isEndpointError } from '../endpoint/errors.ts'

function asProtocol(error: unknown): never {
  if (error instanceof RelayProtocolError) throw error
  throw new RelayProtocolError('INVALID_INPUT', isEndpointError(error) ? error.message : error instanceof Error ? error.message : 'invalid Endpoint admission')
}

/** Sole compile/admission conversion from published Agent capabilities into discovery summaries. */
export function compileDeclarationEndpoints(declaration: AgentDeclaration): EndpointDiscoveryView[] {
  if (declaration.capabilities.length === 0) return []
  try {
    const compiled = compileLegacyAgentCapabilities({
      ownerAgentId: declaration.identity.agentId,
      endpointId: declaration.identity.agentId,
      kind: 'service',
      label: declaration.identity.label,
      capabilities: declaration.capabilities,
    })
    return [parseEndpointDiscoveryView({
      endpointId: compiled.endpointId,
      ownerAgentId: compiled.ownerAgentId,
      scopeId: declaration.scopeId,
      kind: compiled.kind,
      revision: compiled.revision,
      lifecycle: compiled.lifecycle,
      capabilities: compiled.capabilities.map(capability => ({
        capabilityId: capability.capabilityId,
        version: capability.version,
        operations: capability.operations.map(operation => operation.operation),
      })),
      resources: compiled.resources.map(resource => ({
        resourceId: resource.resourceId,
        capacity: resource.capacity,
        unit: resource.unit,
      })),
    })]
  } catch (error) {
    asProtocol(error)
  }
}

export function attachDeclarationEndpoints(declaration: AgentDeclaration): EndpointDiscoveryView[] {
  return compileDeclarationEndpoints(declaration)
}

export function projectPeerEndpoints(peer: RelayPeer, viewer: AuthenticatedAgent): RelayPeer {
  const endpoints = peer.endpoints ?? attachDeclarationEndpoints(peer.declaration)
  return { ...peer, endpoints: filterVisibleEndpoints(endpoints, viewer) }
}
