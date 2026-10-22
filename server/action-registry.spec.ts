import { describe, expect, it } from 'vitest'
import {
  acceptAction,
  actionExecutableBy,
  actionOf,
  confirmActionStopped,
  createAction,
  createActionRegistry,
  executableActionsFor,
  listActions,
  markActionStopUnknown,
  refuseAction,
  reportAction,
  requestActionCancel,
  restoreActionRegistry,
  startAction,
  submitActionResult,
  transitionAction,
  type ActionRegistryState,
} from './action-registry.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:01:00.000Z'
const T2 = '2026-10-22T00:02:00.000Z'
const T3 = '2026-10-22T00:03:00.000Z'
const T4 = '2026-10-22T00:04:00.000Z'

function create(
  state: ActionRegistryState = createActionRegistry(),
  overrides: Partial<Parameters<typeof createAction>[1]> = {},
): { state: ActionRegistryState; actionId: string } {
  const result = createAction(state, {
    commitId: 'c1',
    sessionId: 's1',
    initiatorAgentId: 'agent-a',
    assigneeAgentId: 'agent-b',
    kind: 'review',
    reason: 'check the plan',
    expectedResult: 'a written verdict',
    replyRequired: false,
    ...overrides,
  }, T0)
  return { state: result.state, actionId: result.action.actionId }
}

function started(): { state: ActionRegistryState; actionId: string } {
  const seeded = create()
  return { state: startAction(seeded.state, seeded.actionId, T1), actionId: seeded.actionId }
}

describe('action registry creation', () => {
  it('creates a pending action with the assignee as the only responsibility source', () => {
    const { state, actionId } = create()
    const action = actionOf(state, actionId)
    expect(action.state).toBe('pending')
    expect(action.assigneeAgentId).toBe('agent-b')
    expect(action.replyRequired).toBe(false)
    expect(actionExecutableBy(state, actionId, 'agent-b')).toBe(true)
    expect(actionExecutableBy(state, actionId, 'agent-a')).toBe(false)
  })

  it('still executes when replyRequired is false', () => {
    const { state, actionId } = create(undefined, { replyRequired: false })
    expect(executableActionsFor(state, 'agent-b')).toHaveLength(1)
    expect(executableActionsFor(state, 'agent-a')).toHaveLength(0)
    const required = create(undefined, { commitId: 'c2', replyRequired: true })
    expect(executableActionsFor(required.state, 'agent-b')).toHaveLength(1)
  })

  it('returns the original record for the same commit and rejects different content', () => {
    const seeded = create()
    const repeated = createAction(seeded.state, {
      commitId: 'c1',
      sessionId: 's1',
      initiatorAgentId: 'agent-a',
      assigneeAgentId: 'agent-b',
      kind: 'review',
      reason: 'check the plan',
      expectedResult: 'a written verdict',
      replyRequired: false,
    }, T1)
    expect(repeated.state).toBe(seeded.state)
    expect(repeated.action.actionId).toBe(seeded.actionId)
    expect(() => createAction(seeded.state, {
      commitId: 'c1',
      sessionId: 's1',
      initiatorAgentId: 'agent-a',
      assigneeAgentId: 'agent-c',
      kind: 'review',
      reason: 'check the plan',
      expectedResult: 'a written verdict',
      replyRequired: false,
    }, T1)).toThrow(/conflicts with an existing action/)
  })

  it('rejects an inReplyTo action from another session', () => {
    const first = create()
    expect(() => createAction(first.state, {
      commitId: 'c2',
      sessionId: 's2',
      initiatorAgentId: 'agent-a',
      assigneeAgentId: 'agent-b',
      kind: 'followup',
      reason: 'follow up',
      expectedResult: 'answer',
      replyRequired: true,
      inReplyToActionId: first.actionId,
    }, T1)).toThrow(/same session/)
  })
})

describe('action registry execution transitions', () => {
  it('accepts and starts an action through the declared edges only', () => {
    let { state, actionId } = create()
    state = acceptAction(state, actionId, T1)
    expect(actionOf(state, actionId).state).toBe('accepted')
    state = startAction(state, actionId, T2)
    expect(actionOf(state, actionId).state).toBe('in_progress')
    const { state: pendingState, actionId: refusedId } = create(undefined, { commitId: 'c2' })
    const refused = refuseAction(pendingState, refusedId, T1)
    expect(actionOf(refused, refusedId).state).toBe('refused')
    expect(() => transitionAction(refused, refusedId, 'accepted', T1)).toThrow(/cannot transition/)
  })

  it('never moves in_progress directly to cancelled', () => {
    const { state, actionId } = started()
    expect(() => transitionAction(state, actionId, 'cancelled', T2)).toThrow(/cannot transition/)
    const requested = requestActionCancel(state, actionId, T2)
    expect(actionOf(requested, actionId).state).toBe('cancel_requested')
    const stopped = confirmActionStopped(requested, actionId, T3)
    expect(actionOf(stopped, actionId).state).toBe('cancelled')
    expect(actionOf(stopped, actionId).executionStopped).toBe(true)
  })

  it('cancels pending work immediately but waits for a stop confirmation after start', () => {
    const pending = create()
    expect(actionOf(requestActionCancel(pending.state, pending.actionId, T1), pending.actionId).state).toBe('cancelled')
    const accepted = acceptAction(pending.state, pending.actionId, T1)
    expect(actionOf(requestActionCancel(accepted, pending.actionId, T2), pending.actionId).state).toBe('cancel_requested')
  })

  it('keeps unknown non-terminal and records the unconfirmed stop fact', () => {
    const { state, actionId } = started()
    const requested = requestActionCancel(state, actionId, T2)
    const unknown = markActionStopUnknown(requested, actionId, T3)
    const action = actionOf(unknown, actionId)
    expect(action.state).toBe('unknown')
    expect(action.executionStopped).toBe(false)
    expect(() => confirmActionStopped(unknown, actionId, T4)).toThrow(/cannot transition/)
  })

  it('reports blocked and failed without auto-advancing', () => {
    const blocked = started()
    const blockedState = reportAction(blocked.state, blocked.actionId, 'blocked', T2)
    expect(actionOf(blockedState, blocked.actionId).state).toBe('blocked')
    const failed = started()
    const failedState = reportAction(failed.state, failed.actionId, 'failed', T2)
    expect(actionOf(failedState, failed.actionId).state).toBe('failed')
    expect(() => startAction(failedState, failed.actionId, T3)).toThrow(/cannot transition/)
  })
})

describe('action registry result submission', () => {
  it('completes with a result reference and is idempotent by resultCommitId', () => {
    const { state, actionId } = started()
    const submitted = submitActionResult(state, {
      actionId, resultCommitId: 'r1', resultRef: 'comment-1',
    }, T2)
    const completed = actionOf(submitted.state, actionId)
    expect(completed.state).toBe('completed')
    expect(completed.resultCommitId).toBe('r1')
    expect(completed.resultRef).toBe('comment-1')
    expect(completed.completedAt).toBe(T2)
    const repeated = submitActionResult(submitted.state, {
      actionId, resultCommitId: 'r1', resultRef: 'comment-1',
    }, T3)
    expect(repeated.state).toBe(submitted.state)
    expect(() => submitActionResult(submitted.state, {
      actionId, resultCommitId: 'r1', resultRef: 'comment-2',
    }, T3)).toThrow(/conflicts with the recorded result reference/)
  })

  it('requires a result reference and a result commit for completed', () => {
    const { state, actionId } = started()
    expect(() => transitionAction(state, actionId, 'completed', T2)).toThrow(/resultCommitId is required/)
    expect(() => submitActionResult(state, {
      actionId, resultCommitId: 'r1', resultRef: '',
    }, T2)).toThrow(/resultRef is required/)
  })

  it('does not revive a terminal action with a different result commit', () => {
    const { state, actionId } = started()
    const completed = submitActionResult(state, {
      actionId, resultCommitId: 'r1', resultRef: 'comment-1',
    }, T2).state
    expect(() => submitActionResult(completed, {
      actionId, resultCommitId: 'r2', resultRef: 'comment-2',
    }, T3)).toThrow(/already completed/)
    expect(() => transitionAction(completed, actionId, 'in_progress', T3)).toThrow(/cannot transition/)
  })

  it('allows a readback completion from unknown but not from pending', () => {
    const { state, actionId } = started()
    const requested = requestActionCancel(state, actionId, T2)
    const unknown = markActionStopUnknown(requested, actionId, T3)
    const completed = submitActionResult(unknown, {
      actionId, resultCommitId: 'r1', resultRef: 'comment-1',
    }, T4)
    expect(actionOf(completed.state, actionId).state).toBe('completed')
    const pending = create(undefined, { commitId: 'c9' })
    expect(() => submitActionResult(pending.state, {
      actionId: pending.actionId, resultCommitId: 'r9', resultRef: 'comment-9',
    }, T2)).toThrow(/cannot transition/)
  })
})

describe('action registry list and restore', () => {
  it('lists actions by session and assignee', () => {
    const first = create()
    const second = create(first.state, { commitId: 'c2', sessionId: 's2' })
    expect(listActions(second.state, 's1')).toHaveLength(1)
    expect(listActions(second.state, 's2')).toHaveLength(1)
    expect(executableActionsFor(second.state, 'agent-b', 's2')).toHaveLength(1)
  })

  it('restores records and rejects duplicate identity keys or a completed record without a result', () => {
    const record = {
      actionId: 'action:c1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-a',
      assigneeAgentId: 'agent-b', kind: 'review', reason: 'check', expectedResult: 'verdict',
      replyRequired: false, state: 'pending', createdAt: T0,
    }
    const restored = restoreActionRegistry([record])
    expect(actionOf(restored, 'action:c1').state).toBe('pending')
    expect(() => restoreActionRegistry([record, { ...record }])).toThrow(/duplicate actionId/)
    expect(() => restoreActionRegistry([record, { ...record, actionId: 'action:other' }]))
      .toThrow(/duplicate action commitId/)
    expect(() => restoreActionRegistry([{
      ...record, state: 'completed', resultCommitId: 'r1', completedAt: T1,
    }])).toThrow(/missing its result reference/)
  })
})
