import { describe, expect, it } from 'vitest'
import type { CapabilityDeclaration } from '../control-protocol/agent-services.ts'
import { matchCapability, projectCapabilityUseGraph, reportCapabilityUseByConsumer, reportCapabilityUseByProvider } from './relation-graph.ts'

const base = { relationId: 'rel-1', consumer: 'planner', provider: 'reviewer', capabilityId: 'review', capabilityVersion: '1.0.0', relationPermission: 'granted' as const, reportedAt: '2026-09-01T17:00:00Z', reportRevision: 1 }

describe('Teams capability-use graph', () => {
  it('matches an exact capability version and declared operation', () => {
    const capability: CapabilityDeclaration = {
      capabilityId: 'browser',
      version: '1.0.0',
      operations: [{ operation: 'open', inputSchema: {}, outputSchema: {}, cancellation: 'cooperative' }],
      resources: [],
    }
    expect(matchCapability([capability], { capabilityId: 'browser', capabilityVersion: '1.0.0', operation: 'open' })).toEqual({ capability, operation: capability.operations[0] })
    expect(() => matchCapability([capability], { capabilityId: 'browser', capabilityVersion: '2.0.0', operation: 'open' })).toThrow(/UNSUPPORTED_VERSION/)
    expect(() => matchCapability([capability], { capabilityId: 'browser', capabilityVersion: '1.0.0', operation: 'close' })).toThrow(/UNSUPPORTED_OPERATION/)
  })
  it('projects a matched two-sided relation without granting extra authority', () => {
    const graph = projectCapabilityUseGraph(
      [reportCapabilityUseByConsumer({ ...base, state: 'using' })],
      [reportCapabilityUseByProvider({ ...base, state: 'using' })],
      'peer',
    )
    expect(graph[0]).toMatchObject({ consistency: 'matched', classification: 'peer', relationPermission: 'granted' })
    expect(graph[0]).not.toHaveProperty('permission')
  })

  it('retains consumer-only and conflicting reports visibly', () => {
    const graph = projectCapabilityUseGraph(
      [
        { ...base, state: 'requested' },
        { ...base, relationId: 'rel-2', state: 'using' },
      ],
      [{ ...base, relationId: 'rel-2', state: 'denied' }],
      'master-slave',
    )
    expect(graph).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationId: 'rel-1', consistency: 'consumer-only' }),
      expect.objectContaining({ relationId: 'rel-2', consistency: 'conflict' }),
    ]))
  })

  it('keeps capability versions separate and ignores older reports', () => {
    const versionSplit = projectCapabilityUseGraph(
      [{ ...base, capabilityVersion: '1.0.0', state: 'using' }],
      [{ ...base, capabilityVersion: '2.0.0', state: 'using' }],
      'peer',
    )
    expect(versionSplit).toHaveLength(2)
    expect(versionSplit).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityVersion: '1.0.0', consistency: 'consumer-only' }),
      expect.objectContaining({ capabilityVersion: '2.0.0', consistency: 'provider-only' }),
    ]))

    const newest = projectCapabilityUseGraph(
      [{ ...base, state: 'using', reportRevision: 2 }, { ...base, state: 'requested', reportRevision: 1 }],
      [{ ...base, state: 'using', reportRevision: 2 }],
      'master-slave',
    )
    expect(newest).toMatchObject([{ consumerState: 'using', providerState: 'using', consistency: 'matched', reportRevision: 2 }])
  })
})
