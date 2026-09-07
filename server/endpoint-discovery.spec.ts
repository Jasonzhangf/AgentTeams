import { describe, expect, it } from 'vitest'
import type { AgentDeclaration, RelayPeer } from '../control-protocol/agent-services.ts'
import { admitEndpointReference } from '../control-protocol/endpoint-ref.ts'
import { compileDeclarationEndpoints, projectPeerEndpoints } from './endpoint-discovery.ts'

const declaration = (overrides: Partial<AgentDeclaration> = {}): AgentDeclaration => ({
  identity: {
    hostId: 'host-a',
    machineId: 'machine-a',
    agentId: 'agent-a',
    accountId: 'account-a',
    agentKind: 'custom',
    label: 'Agent A',
  },
  scopeId: 'scope-a',
  revision: 1,
  capabilities: [{
    capabilityId: 'file-search',
    version: 'v1',
    operations: [{
      operation: 'search',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      cancellation: 'unsupported',
    }],
    resources: [{ resourceId: 'search-slot', capacity: 1, unit: 'slot', sharing: 'exclusive', allocationScope: 'work' }],
  }],
  routes: [],
  ...overrides,
})

describe('legacy declaration compile admission', () => {
  it('converts old Agent capabilities through one compile entry into discovery summaries', () => {
    const views = compileDeclarationEndpoints(declaration())
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      endpointId: 'agent-a',
      ownerAgentId: 'agent-a',
      scopeId: 'scope-a',
      kind: 'service',
      revision: 1,
      lifecycle: 'active',
      capabilities: [{ capabilityId: 'file-search', version: 'v1', operations: ['search'] }],
      resources: [{ resourceId: 'search-slot', capacity: 1, unit: 'slot' }],
    })
    expect(admitEndpointReference(views, { agentId: 'agent-b', scopeId: 'scope-a' }, {
      providerAgentId: 'agent-a', endpointId: 'agent-a', revision: 1,
    }).capabilities[0]?.capabilityId).toBe('file-search')
  })

  it('does not leak other-scope Endpoint summaries on projected directory peers', () => {
    const peer: RelayPeer = {
      declaration: declaration(),
      connectionId: 'c1',
      generation: 1,
      lastSeenAt: '2026-09-07T00:00:00.000Z',
      presence: 'online',
      endpoints: compileDeclarationEndpoints(declaration()),
    }
    expect(projectPeerEndpoints(peer, { agentId: 'agent-b', scopeId: 'scope-a' }).endpoints).toHaveLength(1)
    expect(projectPeerEndpoints(peer, { agentId: 'agent-c', scopeId: 'scope-b' }).endpoints).toHaveLength(0)
  })

  it('rejects business payload on compiled discovery views', () => {
    const views = compileDeclarationEndpoints(declaration())
    expect(views[0]).not.toHaveProperty('sessionId')
    expect(views[0]).not.toHaveProperty('payload')
    expect(() => compileDeclarationEndpoints({
      ...declaration(),
      capabilities: [{
        ...declaration().capabilities[0]!,
        capabilityId: 'https://evil.example/cap',
      }],
    })).toThrow(/URL or transport target/)
  })
})
