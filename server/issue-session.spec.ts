import { describe, expect, it } from 'vitest'
import {
  closeIssueSession,
  confirmIssueOperation,
  createIssueSessionRegistry,
  decideExternalState,
  listIssueSessions,
  openIssueSession,
  operationsForSession,
  reopenIssueSession,
  sessionForIssue,
  sessionOfIssue,
  type IssueSessionRegistry,
} from './issue-session.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:01:00.000Z'
const T2 = '2026-10-22T00:02:00.000Z'
const T3 = '2026-10-22T00:03:00.000Z'
const T4 = '2026-10-22T00:04:00.000Z'

function open(state: IssueSessionRegistry = createIssueSessionRegistry()): IssueSessionRegistry {
  return openIssueSession(state, {
    sessionId: 's1',
    groupId: 'g1',
    vikunjaProjectId: 'p1',
    vikunjaIssueId: 'i1',
    initiatorAgentId: 'agent-a',
  }, T0)
}

describe('issue session binding', () => {
  it('binds one issue to one session across the group and vikunja ids', () => {
    const state = open()
    const session = sessionOfIssue(state, 's1')
    expect(session.state).toBe('open')
    expect(session.lastOpSeq).toBe(0)
    expect(sessionForIssue(state, 'g1', 'p1', 'i1').sessionId).toBe('s1')
    expect(listIssueSessions(state, 'g1')).toHaveLength(1)
    expect(listIssueSessions(state, 'g2')).toHaveLength(0)
  })

  it('rejects a duplicate session or a duplicate issue binding', () => {
    const state = open()
    expect(() => openIssueSession(state, {
      sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i2', initiatorAgentId: 'agent-a',
    }, T1)).toThrow(/session s1 already exists/)
    expect(() => openIssueSession(state, {
      sessionId: 's2', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1', initiatorAgentId: 'agent-a',
    }, T1)).toThrow(/already bound/)
  })
})

describe('issue session open and close operations', () => {
  it('records a close intent with a monotonic opSeq but leaves the projection open', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    const session = sessionOfIssue(state, 's1')
    expect(session.state).toBe('open')
    expect(session.lastOpSeq).toBe(1)
    expect(operationsForSession(state, 's1')[0]).toMatchObject({
      commitId: 'c1', kind: 'issue.close', targetState: 'closed', opSeq: 1, state: 'pending',
    })
  })

  it('is idempotent for the same close commit and rejects a different one', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    const repeated = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T2)
    expect(repeated).toBe(state)
    expect(() => closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'changed', conclusion: 'merged',
    }, T2)).toThrow(/conflicts with an existing open\/close operation/)
  })

  it('applies a readback only when the state matches and the ordinal confirms the intent', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    const result = confirmIssueOperation(state, {
      commitId: 'c1', externalState: 'closed', externalOpSeq: 1,
    }, T2)
    expect(result.decision.outcome).toBe('applied')
    expect(result.state).not.toBe(state)
    expect(sessionOfIssue(result.state, 's1').state).toBe('closed')
    expect(sessionOfIssue(result.state, 's1').closedAt).toBe(T2)
    expect(operationsForSession(result.state, 's1')[0].state).toBe('confirmed')
  })

  it('requires a readback and refuses to write a stale target over a newer operation', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    state = confirmIssueOperation(state, {
      commitId: 'c1', externalState: 'closed', externalOpSeq: 1,
    }, T2).state
    state = reopenIssueSession(state, {
      sessionId: 's1', commitId: 'c2', reason: 'not done yet',
    }, T3)
    const session = sessionOfIssue(state, 's1')
    const op1 = operationsForSession(state, 's1')[0]
    const decision = decideExternalState({
      session,
      operations: state.operations,
      operation: op1,
      externalState: 'open',
      externalOpSeq: 1,
      now: T4,
    })
    expect(decision.outcome).toBe('conflict')
    expect(sessionOfIssue(state, 's1').state).toBe('closed')
  })

  it('reports conflict when a newer external operation supersedes the intent', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    const session = sessionOfIssue(state, 's1')
    const op = operationsForSession(state, 's1')[0]
    const decision = decideExternalState({
      session,
      operations: state.operations,
      operation: op,
      externalState: 'open',
      externalOpSeq: 2,
      now: T2,
    })
    expect(decision.outcome).toBe('conflict')
  })

  it('reports unknown when the state differs and the order cannot be established', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    const session = sessionOfIssue(state, 's1')
    const op = operationsForSession(state, 's1')[0]
    const decision = decideExternalState({
      session,
      operations: state.operations,
      operation: op,
      externalState: 'open',
      now: T2,
    })
    expect(decision.outcome).toBe('unknown')
  })

  it('keeps the projection alone when a confirmation is unknown or conflicted', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    const result = confirmIssueOperation(state, {
      commitId: 'c1', externalState: 'open',
    }, T2)
    expect(result.decision.outcome).toBe('unknown')
    expect(sessionOfIssue(result.state, 's1').state).toBe('open')
    expect(operationsForSession(result.state, 's1')[0].state).toBe('unknown')
  })

  it('rejects a reopen on an open session and a close on a closed session', () => {
    const state = open()
    expect(() => reopenIssueSession(state, {
      sessionId: 's1', commitId: 'c2', reason: 'reopen',
    }, T1)).toThrow(/is not closed/)
    const closed = confirmIssueOperation(closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1), { commitId: 'c1', externalState: 'closed', externalOpSeq: 1 }, T2).state
    expect(() => closeIssueSession(closed, {
      sessionId: 's1', commitId: 'c3', reason: 'again', conclusion: 'merged',
    }, T3)).toThrow(/is not open/)
  })

  it('alternates opSeq for close and reopen and removes closedAt on reopen', () => {
    let state = open()
    state = closeIssueSession(state, {
      sessionId: 's1', commitId: 'c1', reason: 'done', conclusion: 'merged',
    }, T1)
    state = confirmIssueOperation(state, {
      commitId: 'c1', externalState: 'closed', externalOpSeq: 1,
    }, T2).state
    state = reopenIssueSession(state, {
      sessionId: 's1', commitId: 'c2', reason: 'reopen for more review',
    }, T3)
    const result = confirmIssueOperation(state, {
      commitId: 'c2', externalState: 'open', externalOpSeq: 2,
    }, T4)
    expect(result.decision.outcome).toBe('applied')
    const session = sessionOfIssue(result.state, 's1')
    expect(session.state).toBe('open')
    expect(session.closedAt).toBeUndefined()
    expect(session.lastOpSeq).toBe(2)
    expect(operationsForSession(result.state, 's1').map(op => op.opSeq)).toEqual([1, 2])
  })
})
