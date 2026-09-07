import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileLegacyAgentCapabilities } from './compile.ts'
import { isEndpointError } from './errors.ts'
import {
  createEndpointRegistry,
  disableEndpoint,
  listEndpoints,
  registerEndpoint,
  requireCapability,
  requireResource,
  reviseEndpoint,
  useEndpoint,
} from './registry.ts'
import type { EndpointDescriptor, OperationDescriptor, ResourceDescriptor } from './types.ts'
import { validateEndpointDescriptor } from './validate.ts'

const operation: OperationDescriptor = {
  operation: 'navigate',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  cancellation: 'cooperative',
}

const resource = (resourceId: string): ResourceDescriptor => ({
  resourceId,
  capacity: 1,
  unit: 'slot',
  sharing: 'exclusive',
  allocationScope: 'work',
})

function browserEndpoint(overrides: Partial<EndpointDescriptor> & Pick<EndpointDescriptor, 'endpointId' | 'ownerAgentId'>): EndpointDescriptor {
  return {
    kind: 'browser',
    label: overrides.label ?? overrides.endpointId,
    revision: 1,
    lifecycle: 'active',
    capabilities: [{ capabilityId: 'browser-control', version: 'v1', operations: [operation] }],
    resources: [resource(`${overrides.endpointId}-slot`)],
    ...overrides,
  }
}

function codeOf(run: () => unknown): string {
  try {
    run()
    throw new Error('expected EndpointError')
  } catch (error) {
    expect(isEndpointError(error)).toBe(true)
    if (!isEndpointError(error)) throw error
    return error.code
  }
}

describe('Endpoint descriptor validation', () => {
  it('rejects missing identity and unknown lifecycle', () => {
    expect(codeOf(() => validateEndpointDescriptor(browserEndpoint({ endpointId: '', ownerAgentId: 'agent-1' })))).toBe('INVALID_IDENTITY')
    expect(codeOf(() => validateEndpointDescriptor(browserEndpoint({ endpointId: 'profile-a', ownerAgentId: '' })))).toBe('INVALID_IDENTITY')
    expect(codeOf(() => validateEndpointDescriptor({
      ...browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1' }),
      lifecycle: 'archived',
    } as unknown))).toBe('INVALID_LIFECYCLE')
    expect(codeOf(() => validateEndpointDescriptor({
      ...browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1' }),
      revision: 0,
    }))).toBe('INVALID_REVISION')
  })
})

describe('Endpoint registry', () => {
  it('lets one Agent register two same-schema Endpoint descriptors', () => {
    const registry = createEndpointRegistry()
    const first = registerEndpoint(registry, 'agent-1', browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1' }))
    const second = registerEndpoint(registry, 'agent-1', browserEndpoint({ endpointId: 'profile-b', ownerAgentId: 'agent-1' }))
    expect(first.capabilities[0]).toEqual(second.capabilities[0])
    expect(listEndpoints(registry, 'agent-1').map(item => item.endpointId)).toEqual(['profile-a', 'profile-b'])
  })

  it('rejects duplicate EndpointId, cross-Agent ownership, and extra capability/resource mounts', () => {
    const registry = createEndpointRegistry()
    registerEndpoint(registry, 'agent-1', browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1' }))
    expect(codeOf(() => registerEndpoint(registry, 'agent-1', browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1' })))).toBe('DUPLICATE_ENDPOINT_ID')
    expect(codeOf(() => registerEndpoint(registry, 'agent-2', browserEndpoint({ endpointId: 'profile-b', ownerAgentId: 'agent-1' })))).toBe('CROSS_AGENT_OWNERSHIP')
    expect(codeOf(() => requireCapability(registry, 'agent-1', 'profile-a', 'file-search'))).toBe('CAPABILITY_OUTSIDE_ENDPOINT')
    expect(codeOf(() => requireResource(registry, 'agent-1', 'profile-a', 'missing-slot'))).toBe('RESOURCE_OUTSIDE_ENDPOINT')
    expect(codeOf(() => registerEndpoint(registry, 'agent-1', browserEndpoint({
      endpointId: 'profile-c',
      ownerAgentId: 'agent-1',
      resources: [resource('profile-a-slot')],
    })))).toBe('RESOURCE_OUTSIDE_ENDPOINT')
  })

  it('rejects disabled Endpoint use, stale revision, and invalid lifecycle transitions', () => {
    const registry = createEndpointRegistry()
    registerEndpoint(registry, 'agent-1', browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1' }))
    expect(codeOf(() => reviseEndpoint(registry, 'agent-1', {
      endpointId: 'profile-a',
      expectedRevision: 9,
      descriptor: browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1', revision: 10 }),
    }))).toBe('STALE_REVISION')
    const draining = reviseEndpoint(registry, 'agent-1', {
      endpointId: 'profile-a',
      expectedRevision: 1,
      descriptor: browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1', revision: 2, lifecycle: 'draining' }),
    })
    expect(draining.lifecycle).toBe('draining')
    expect(useEndpoint(registry, 'agent-1', 'profile-a').lifecycle).toBe('draining')
    expect(codeOf(() => reviseEndpoint(registry, 'agent-1', {
      endpointId: 'profile-a',
      expectedRevision: 2,
      descriptor: browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1', revision: 3, lifecycle: 'active' }),
    }))).toBe('INVALID_LIFECYCLE')
    disableEndpoint(registry, 'agent-1', { endpointId: 'profile-a', expectedRevision: 2 })
    expect(codeOf(() => useEndpoint(registry, 'agent-1', 'profile-a'))).toBe('ENDPOINT_DISABLED')
    expect(codeOf(() => requireCapability(registry, 'agent-1', 'profile-a', 'browser-control'))).toBe('ENDPOINT_DISABLED')
    expect(codeOf(() => disableEndpoint(registry, 'agent-1', { endpointId: 'profile-a', expectedRevision: 3 }))).toBe('INVALID_LIFECYCLE')
    expect(codeOf(() => reviseEndpoint(registry, 'agent-1', {
      endpointId: 'profile-a',
      expectedRevision: 3,
      descriptor: browserEndpoint({ endpointId: 'profile-a', ownerAgentId: 'agent-1', revision: 4 }),
    }))).toBe('ENDPOINT_DISABLED')
  })

  it('rejects registering a non-active Endpoint', () => {
    const registry = createEndpointRegistry()
    expect(codeOf(() => registerEndpoint(registry, 'agent-1', browserEndpoint({
      endpointId: 'profile-a',
      ownerAgentId: 'agent-1',
      lifecycle: 'disabled',
    })))).toBe('INVALID_LIFECYCLE')
  })
})

describe('legacy Agent capability compile', () => {
  it('converts old Agent capability input through one compile entry', () => {
    const compiled = compileLegacyAgentCapabilities({
      ownerAgentId: 'agent-1',
      endpointId: 'shell-default',
      kind: 'shell',
      label: 'default shell',
      capabilities: [{
        capabilityId: 'file-search',
        version: 'v1',
        operations: [{
          operation: 'search',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          cancellation: 'unsupported',
        }],
        resources: [resource('search-slot')],
      }],
    })
    const registry = createEndpointRegistry()
    expect(registerEndpoint(registry, 'agent-1', compiled).endpointId).toBe('shell-default')
    expect(requireCapability(registry, 'agent-1', 'shell-default', 'file-search').version).toBe('v1')
  })
})

describe('Endpoint module boundary', () => {
  it('does not import network, server, agent, runtime, or ui', () => {
    const dir = import.meta.dirname
    const sources = readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    const forbidden = ['../network', '../server', '../agent/', '../runtime', '../ui/', '../cli-adapter']
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8')
      for (const path of forbidden) {
        expect(text.includes(`from '${path}`)).toBe(false)
      }
    }
  })
})
