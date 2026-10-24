import { describe, expect, it } from 'vitest'
import { validateRelationReport } from './relation-report.ts'

describe('control-protocol relation report schema', () => {
  it('validates a typed consumer report', () => {
    expect(
      validateRelationReport({
        relationId: 'rel-1',
        reporterAgentId: 'agent-alpha',
        subjectAgentId: 'agent-beta',
        capabilityId: 'review',
        role: 'consumer',
        state: 'requested',
        reportRevision: 1,
        reportedAt: '2026-09-04T01:00:00Z',
      }),
    ).toMatchObject({ relationId: 'rel-1', role: 'consumer', state: 'requested' })
  })

  it('rejects self relation and invalid state', () => {
    expect(() =>
      validateRelationReport({
        relationId: 'rel-1',
        reporterAgentId: 'agent-alpha',
        subjectAgentId: 'agent-alpha',
        capabilityId: 'review',
        role: 'consumer',
        state: 'requested',
        reportRevision: 1,
        reportedAt: '2026-09-04T01:00:00Z',
      }),
    ).toThrow(/self/)
    expect(() =>
      validateRelationReport({
        relationId: 'rel-1',
        reporterAgentId: 'agent-alpha',
        subjectAgentId: 'agent-beta',
        capabilityId: 'review',
        role: 'consumer',
        state: 'granted',
        reportRevision: 1,
        reportedAt: '2026-09-04T01:00:00Z',
      }),
    ).toThrow(/state/)
  })
})
