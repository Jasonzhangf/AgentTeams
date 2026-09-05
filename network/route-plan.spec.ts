import { describe, expect, it } from 'vitest'
import {
  beginRouteCandidate,
  buildRoutePlan,
  failRouteCandidate,
  succeedRouteCandidate,
} from './route-plan.ts'

const candidates = [
  {
    candidateId: 'candidate-1',
    kind: 'relay-ws' as const,
    endpoint: 'https://relay.test/1',
    port: 443,
    authRequired: true,
    lastSeenAt: '2026-09-04T00:00:00.000Z',
  },
  {
    candidateId: 'candidate-2',
    kind: 'lan' as const,
    endpoint: 'http://10.0.0.2:1234',
    port: 1234,
    authRequired: false,
    lastSeenAt: '2026-09-04T00:00:00.000Z',
  },
]

describe('Teams explicit route plan', () => {
  it('builds a manual route from an existing candidate with endpoint', () => {
    const plan = buildRoutePlan({
      hostId: 'host-a',
      directoryGeneration: 1,
      policy: 'manual',
      candidates,
      targetCandidateId: 'candidate-2',
    })
    expect(plan.candidateOrder).toEqual(['candidate-2'])
    expect(() => buildRoutePlan({
      hostId: 'host-a',
      directoryGeneration: 1,
      policy: 'manual',
      candidates,
      targetCandidateId: 'missing',
    })).toThrow(/manual route/)
  })

  it('consumes an ordered auto plan and retires failed candidate generations explicitly', () => {
    const plan = buildRoutePlan({
      hostId: 'host-a',
      directoryGeneration: 1,
      policy: 'auto',
      candidates,
    })
    expect(plan.candidateOrder).toEqual(['candidate-1', 'candidate-2'])
    const active = beginRouteCandidate(plan)
    const failed = failRouteCandidate(active, 'candidate-1', 'connection refused')
    expect(failed.state).toBe('pending')
    expect(failed.cursor).toBe(1)
    expect(failed.lastError).toBe('connection refused')
  })

  it('succeeds only for the active candidate and cannot rewrite success as failure', () => {
    const active = beginRouteCandidate(buildRoutePlan({
      hostId: 'host-a',
      directoryGeneration: 1,
      policy: 'auto',
      candidates,
    }))
    const succeeded = succeedRouteCandidate(active, 'candidate-1')
    expect(succeeded.state).toBe('succeeded')
    expect(() => failRouteCandidate(succeeded, 'candidate-1', 'late error')).toThrow(/succeeded/)
  })

  it('fails the whole plan when the last candidate is retired', () => {
    const plan = buildRoutePlan({
      hostId: 'host-a',
      directoryGeneration: 1,
      policy: 'auto',
      candidates: [candidates[0]],
    })
    const failed = failRouteCandidate(beginRouteCandidate(plan), 'candidate-1', 'all down')
    expect(failed.state).toBe('failed')
    expect(failed.lastError).toBe('all down')
  })
})
