import { describe, expect, it } from 'vitest'
import {
  admitEndpointReference,
  admitWorkEndpointReference,
  filterVisibleEndpoints,
  parseEndpointDiscoveryView,
  parseEndpointReference,
  parseWorkEndpointReference,
  type EndpointDiscoveryView,
} from './endpoint-ref.ts'

const view = (overrides: Partial<EndpointDiscoveryView> = {}): EndpointDiscoveryView => ({
  endpointId: 'profile-a',
  ownerAgentId: 'agent-a',
  scopeId: 'scope-a',
  kind: 'browser',
  revision: 2,
  lifecycle: 'active',
  capabilities: [{ capabilityId: 'browser-control', version: 'v1', operations: ['navigate'] }],
  resources: [{ resourceId: 'profile-a-slot', capacity: 1, unit: 'slot' }],
  ...overrides,
})

const viewer = { agentId: 'agent-b', scopeId: 'scope-a' }

function codeOf(run: () => unknown): string {
  try {
    run()
    throw new Error('expected Endpoint admission error')
  } catch (error) {
    expect(error).toMatchObject({ code: expect.any(String) })
    return (error as { code: string }).code
  }
}

describe('Endpoint discovery wire', () => {
  it('parses identity/kind/revision/capability/resource summaries', () => {
    expect(parseEndpointDiscoveryView(view())).toEqual(view())
  })

  it('rejects Endpoint URL/transport targets and business payload control state', () => {
    expect(codeOf(() => parseEndpointDiscoveryView(view({ endpointId: 'wss://relay.example/profile-a' })))).toBe('INVALID_INPUT')
    expect(codeOf(() => parseEndpointDiscoveryView({ ...view(), endpoint: 'https://host/path' }))).toBe('INVALID_INPUT')
    expect(codeOf(() => parseEndpointDiscoveryView({ ...view(), sessionId: 'ses-1' }))).toBe('INVALID_INPUT')
    expect(codeOf(() => parseEndpointReference({
      providerAgentId: 'agent-a', endpointId: 'profile-a', revision: 2, payload: { text: 'hi' },
    }))).toBe('INVALID_INPUT')
    expect(codeOf(() => parseEndpointReference({
      providerAgentId: 'agent-a', endpointId: 'profile-a', revision: 2, targetAgentId: 'agent-a',
    }))).toBe('INVALID_INPUT')
  })
})

describe('Endpoint/Capability/Operation/Work admission', () => {
  it('hides other-scope and disabled Endpoints from consumers', () => {
    const catalog = [
      view(),
      view({ endpointId: 'profile-b', lifecycle: 'disabled' }),
      view({ endpointId: 'other', ownerAgentId: 'agent-c', scopeId: 'scope-b' }),
    ]
    expect(filterVisibleEndpoints(catalog, viewer).map(item => item.endpointId)).toEqual(['profile-a'])
  })

  it('rejects unknown, stale, cross-scope, owner mismatch, and missing capability/operation', () => {
    const catalog = [view()]
    const ref = { providerAgentId: 'agent-a', endpointId: 'profile-a', revision: 2 }
    expect(admitEndpointReference(catalog, viewer, ref).endpointId).toBe('profile-a')
    expect(codeOf(() => admitEndpointReference(catalog, viewer, { ...ref, endpointId: 'missing' }))).toBe('NOT_FOUND')
    expect(codeOf(() => admitEndpointReference(catalog, viewer, { ...ref, revision: 1 }))).toBe('REVISION_CONFLICT')
    expect(codeOf(() => admitEndpointReference(catalog, { ...viewer, scopeId: 'scope-b' }, ref))).toBe('FORBIDDEN')
    expect(codeOf(() => admitEndpointReference(catalog, viewer, { ...ref, providerAgentId: 'agent-other' }))).toBe('FORBIDDEN')
    expect(codeOf(() => admitWorkEndpointReference(catalog, viewer, {
      workId: 'work-1', ...ref, capabilityId: 'file-search', capabilityVersion: 'v1', operation: 'navigate',
    }))).toBe('NOT_FOUND')
    expect(codeOf(() => admitWorkEndpointReference(catalog, viewer, {
      workId: 'work-1', ...ref, capabilityId: 'browser-control', capabilityVersion: 'v1', operation: 'click',
    }))).toBe('NOT_FOUND')
  })

  it('rejects non-active Endpoint lifecycles for Work admission', () => {
    const catalog = [view({ lifecycle: 'draining' }), view({ endpointId: 'profile-b', lifecycle: 'disabled' })]
    expect(codeOf(() => admitWorkEndpointReference(catalog, viewer, {
      workId: 'work-1', providerAgentId: 'agent-a', endpointId: 'profile-a', revision: 2,
      capabilityId: 'browser-control', capabilityVersion: 'v1', operation: 'navigate',
    }))).toBe('FORBIDDEN')
    expect(codeOf(() => admitWorkEndpointReference(catalog, viewer, {
      workId: 'work-1', providerAgentId: 'agent-a', endpointId: 'profile-b', revision: 2,
      capabilityId: 'browser-control', capabilityVersion: 'v1', operation: 'navigate',
    }))).toBe('FORBIDDEN')
  })
})
