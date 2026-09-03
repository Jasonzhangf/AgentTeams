import { describe, expect, it } from 'vitest'
import { projectCapabilityUseGraph, reportCapabilityUseByConsumer, reportCapabilityUseByProvider } from './relation-graph.ts'

const base = { relationId: 'rel-1', consumer: 'planner', provider: 'reviewer', capabilityId: 'review', relationPermission: 'granted' as const, reportedAt: '2026-09-01T17:00:00Z', reportRevision: 1 }

describe('Teams capability-use graph', () => {
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
})
