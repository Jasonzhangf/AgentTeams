import type { RouteCandidate } from '../server/directory.ts'

export type RoutePlanPolicy = 'manual' | 'auto'
export type RoutePlanState = 'pending' | 'active' | 'succeeded' | 'failed'

export interface RoutePlan {
  readonly hostId: string
  readonly directoryGeneration: number
  readonly policy: RoutePlanPolicy
  readonly candidates: readonly RouteCandidate[]
  readonly candidateOrder: readonly string[]
  readonly cursor: number
  readonly state: RoutePlanState
  readonly lastError?: string
}

export interface BuildRoutePlanInput {
  readonly hostId: string
  readonly directoryGeneration: number
  readonly policy: RoutePlanPolicy
  readonly candidates: readonly RouteCandidate[]
  readonly targetCandidateId?: string
}

function containsEndpoint(candidate: RouteCandidate): boolean {
  return candidate.endpoint !== undefined
}

export function buildRoutePlan(input: BuildRoutePlanInput): RoutePlan {
  if (input.hostId.length === 0) throw new Error('route-plan: hostId is required')
  if (!Number.isInteger(input.directoryGeneration) || input.directoryGeneration < 1) {
    throw new Error('route-plan: directory generation must be a positive integer')
  }
  if (input.candidates.length === 0) throw new Error('route-plan: no route candidates')

  if (input.policy === 'manual') {
    const target = input.candidates.find((candidate) => candidate.candidateId === input.targetCandidateId)
    if (!target || !containsEndpoint(target)) {
      throw new Error('route-plan: manual route must select an existing candidate with endpoint')
    }
    return {
      hostId: input.hostId,
      directoryGeneration: input.directoryGeneration,
      policy: 'manual',
      candidates: [target],
      candidateOrder: [target.candidateId],
      cursor: 0,
      state: 'pending',
    }
  }

  const ordered = input.candidates.filter(containsEndpoint)
  if (ordered.length === 0) throw new Error('route-plan: auto route has no usable candidate with endpoint')
  return {
    hostId: input.hostId,
    directoryGeneration: input.directoryGeneration,
    policy: 'auto',
    candidates: ordered,
    candidateOrder: ordered.map((candidate) => candidate.candidateId),
    cursor: 0,
    state: 'pending',
  }
}

export function beginRouteCandidate(plan: RoutePlan): RoutePlan {
  if (plan.state !== 'pending' && plan.state !== 'active') throw new Error('route-plan: plan is not active')
  return { ...plan, state: 'active' }
}

export function succeedRouteCandidate(plan: RoutePlan, candidateId: string): RoutePlan {
  if (plan.candidateOrder[plan.cursor] !== candidateId) throw new Error('route-plan: candidate is not the active route')
  return { ...plan, state: 'succeeded' }
}

export function failRouteCandidate(plan: RoutePlan, candidateId: string, reason: string): RoutePlan {
  if (plan.state === 'succeeded') throw new Error('route-plan: succeeded route cannot be rewritten as failed')
  if (plan.candidateOrder[plan.cursor] !== candidateId) throw new Error('route-plan: candidate is not the active route')
  const nextCursor = plan.cursor + 1
  if (nextCursor >= plan.candidateOrder.length) {
    return { ...plan, state: 'failed', lastError: reason }
  }
  return { ...plan, cursor: nextCursor, state: 'pending', lastError: reason }
}
