import { describe, expect, it } from 'vitest'
import {
  actionNeedsExecutionFor,
  canTransitionAction,
  isTerminalActionState,
  parseExternalOpReply,
  parseGroup,
  parseGroupAction,
  parseGroupMessage,
  parseGroupWireReply,
  parseGroupWireRequest,
  type Action,
  type Group,
} from './group-wire.ts'

const action: Action = {
  actionId: 'a1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-a',
  assigneeAgentId: 'agent-b', kind: 'review', reason: 'check the plan',
  expectedResult: 'a written verdict', replyRequired: false, state: 'pending',
  createdAt: '2026-10-22T00:00:00.000Z',
}

const group: Group = {
  groupId: 'g1', name: 'release', ownerAgentId: 'agent-a', createdAt: '2026-10-22T00:00:00.000Z',
  members: [
    { agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'], intervals: [{ joinedAt: '2026-10-22T00:00:00.000Z' }] },
    { agentId: 'agent-b', role: 'peer', mastersOf: [], intervals: [{ joinedAt: '2026-10-22T00:01:00.000Z' }] },
  ],
}

function request(value: unknown): string {
  return JSON.stringify(value)
}

describe('group wire requests', () => {
  it('parses a message send with explicit action fields', () => {
    const parsed = parseGroupWireRequest(request({
      kind: 'message.send', requestId: 'r1', commitId: 'c1', groupId: 'g1', sessionId: 's1',
      actionId: 'a1', targetAgentIds: ['agent-b'], replyRequired: false,
      body: 'please review', inReplyToMessageId: 'm0',
    }))
    expect(parsed).toMatchObject({ kind: 'message.send', targetAgentIds: ['agent-b'], replyRequired: false })
  })

  it('parses a close request with the stable commit id', () => {
    const parsed = parseGroupWireRequest(request({
      kind: 'issue.close', requestId: 'r2', commitId: 'c9', sessionId: 's1',
      reason: 'done', conclusion: 'merged', evidence: { pr: 7 },
    }))
    expect(parsed).toMatchObject({ kind: 'issue.close', commitId: 'c9' })
  })

  it('rejects an unknown field so a second semantic cannot leak in', () => {
    expect(() => parseGroupWireRequest(request({
      kind: 'message.send', requestId: 'r1', commitId: 'c1', groupId: 'g1',
      targetAgentIds: ['agent-b'], replyRequired: false, body: 'x', target: 'broadcast',
    }))).toThrow(/unsupported field/)
  })

  it('rejects a repeated target id', () => {
    expect(() => parseGroupWireRequest(request({
      kind: 'message.send', requestId: 'r1', commitId: 'c1', groupId: 'g1',
      targetAgentIds: ['agent-b', 'agent-b'], replyRequired: false, body: 'x',
    }))).toThrow(/must not repeat/)
  })

  it('rejects a missing commit id on an idempotent operation', () => {
    expect(() => parseGroupWireRequest(request({
      kind: 'action.create', requestId: 'r3', sessionId: 's1', assigneeAgentId: 'agent-b',
      actionKind: 'review', reason: 'x', expectedResult: 'y', replyRequired: true,
    }))).toThrow(/commitId/)
  })

  it('rejects an unknown action kind', () => {
    expect(() => parseGroupWireRequest(request({
      kind: 'action.create', requestId: 'r3', commitId: 'c3', sessionId: 's1', assigneeAgentId: 'agent-b',
      actionKind: 'gossip', reason: 'x', expectedResult: 'y', replyRequired: true,
    }))).toThrow(/Action kind/)
  })

  it('rejects an unknown frame kind', () => {
    expect(() => parseGroupWireRequest(request({ kind: 'message.broadcast', requestId: 'r1' }))).toThrow(/Unknown group request/)
  })
})

describe('issue list requests', () => {
  it('parses the group-scoped issue list so a page can restore the sessions it owns', () => {
    const parsed = parseGroupWireRequest(request({ kind: 'issue.list', requestId: 'r1', groupId: 'g1' }))
    expect(parsed).toEqual({ kind: 'issue.list', requestId: 'r1', groupId: 'g1' })
  })

  it('rejects an issue list with an unknown field, so no second filter can leak in', () => {
    expect(() => parseGroupWireRequest(request({
      kind: 'issue.list', requestId: 'r2', groupId: 'g1', sessionId: 's1',
    }))).toThrow(/unsupported field/)
  })
})

describe('group grant requests', () => {
  it('parses the one frame that retargets a member role and its command edges', () => {
    const parsed = parseGroupWireRequest(request({
      kind: 'group.grant', requestId: 'r1', groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'],
    }))
    expect(parsed).toEqual({ kind: 'group.grant', requestId: 'r1', groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'] })
  })

  it('parses a grant without an edge list, so the member keeps or clears its edges', () => {
    const parsed = parseGroupWireRequest(request({
      kind: 'group.grant', requestId: 'r2', groupId: 'g1', agentId: 'agent-b', role: 'peer',
    }))
    expect(parsed).toEqual({ kind: 'group.grant', requestId: 'r2', groupId: 'g1', agentId: 'agent-b', role: 'peer' })
  })

  it('rejects a grant with an unsupported role, a repeated edge or an unknown field', () => {
    expect(() => parseGroupWireRequest(request({
      kind: 'group.grant', requestId: 'r3', groupId: 'g1', agentId: 'agent-a', role: 'owner',
    }))).toThrow(/Grant role is not a supported value/)
    expect(() => parseGroupWireRequest(request({
      kind: 'group.grant', requestId: 'r4', groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-b', 'agent-b'],
    }))).toThrow(/must not repeat/)
    expect(() => parseGroupWireRequest(request({
      kind: 'group.grant', requestId: 'r5', groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'], force: true,
    }))).toThrow(/unsupported field/)
  })
})

describe('group wire replies', () => {
  it('parses a page reply and carries an explicit gap', () => {
    const parsed = parseGroupWireReply(request({
      kind: 'message.page', requestId: 'r1', revision: 4, hasMore: false, gapBeforeSequence: 3,
      messages: [{
        messageId: 'm1', commitId: 'c1', sequence: 5, groupId: 'g1', fromAgentId: 'agent-a',
        targetAgentIds: ['agent-b'], replyRequired: true, body: 'hi', sentAt: '2026-10-22T00:00:00.000Z',
      }],
    }))
    expect(parsed).toMatchObject({ kind: 'message.page', gapBeforeSequence: 3 })
  })

  it('parses an issue list reply that carries the sessions of one group', () => {
    const parsed = parseGroupWireReply(request({
      kind: 'issue.list', requestId: 'r1',
      sessions: [{
        sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: '42',
        initiatorAgentId: 'agent-a', state: 'open', openedAt: '2026-10-22T00:00:00.000Z', lastOpSeq: 1,
      }],
    }))
    expect(parsed).toMatchObject({ kind: 'issue.list', sessions: [{ sessionId: 's1', groupId: 'g1' }] })
  })

  it('parses a closed reply that names the actions not confirmed stopped', () => {
    const parsed = parseGroupWireReply(request({
      kind: 'issue.closed', requestId: 'r1',
      session: {
        sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: '42',
        initiatorAgentId: 'agent-a', state: 'closed', openedAt: '2026-10-22T00:00:00.000Z', lastOpSeq: 2,
      },
      outcome: 'closed',
      unstopped: [{ actionId: 'a1', assigneeAgentId: 'agent-b', state: 'cancel_requested' }],
    }))
    expect(parsed).toMatchObject({
      kind: 'issue.closed',
      outcome: 'closed',
      unstopped: [{ actionId: 'a1', assigneeAgentId: 'agent-b', state: 'cancel_requested' }],
    })
  })

  it('parses an op execute frame as hub to owner', () => {
    const parsed = parseGroupWireReply(request({
      kind: 'op.execute', opId: 'op1', opKind: 'issue.close', params: { sessionId: 's1' },
    }))
    expect(parsed).toMatchObject({ kind: 'op.execute', opKind: 'issue.close' })
  })

  it('parses an authenticated owner receipt', () => {
    expect(parseExternalOpReply(request({ kind: 'op.confirmed', opId: 'op1', commitId: 'c1', result: { done: true } })))
      .toMatchObject({ kind: 'op.confirmed' })
    expect(parseExternalOpReply(request({
      kind: 'op.failed', opId: 'op1', commitId: 'c1',
      error: { code: 'FORBIDDEN', message: 'no token' },
    }))).toMatchObject({ kind: 'op.failed' })
    expect(parseExternalOpReply(request({ kind: 'op.unknown', opId: 'op1', commitId: 'c1', reason: 'timeout' })))
      .toMatchObject({ kind: 'op.unknown' })
  })

  it('rejects an unknown service error code', () => {
    expect(() => parseExternalOpReply(request({
      kind: 'op.failed', opId: 'op1', commitId: 'c1',
      error: { code: 'WHATEVER', message: 'x' },
    }))).toThrow(/Service error code/)
  })
})

describe('group entities', () => {
  it('keeps member intervals as the access record', () => {
    const parsed = parseGroup(group)
    expect(parsed.members[1]?.intervals).toHaveLength(1)
  })

  it('rejects a member without an interval', () => {
    expect(() => parseGroup({ ...group, members: [{ agentId: 'agent-b', role: 'peer', mastersOf: [], intervals: [] }] }))
      .toThrow(/non-empty array/)
  })

  it('parses an action in cancel_requested', () => {
    const parsed = parseGroupAction({ ...action, state: 'cancel_requested' })
    expect(parsed.state).toBe('cancel_requested')
  })

  it('rejects a message with sequence zero', () => {
    expect(() => parseGroupMessage({
      messageId: 'm1', commitId: 'c1', sequence: 0, groupId: 'g1', fromAgentId: 'agent-a',
      targetAgentIds: [], replyRequired: false, body: 'x', sentAt: 'now',
    })).toThrow(/sequence/)
  })
})

describe('action execution and transitions', () => {
  it('executes a replyRequired false action for its assignee', () => {
    expect(actionNeedsExecutionFor(action, 'agent-b')).toBe(true)
    expect(actionNeedsExecutionFor({ ...action, replyRequired: true }, 'agent-b')).toBe(true)
  })

  it('does not execute a foreign action', () => {
    expect(actionNeedsExecutionFor(action, 'agent-a')).toBe(false)
    expect(actionNeedsExecutionFor(action, 'agent-c')).toBe(false)
  })

  it('does not execute a terminal action', () => {
    expect(actionNeedsExecutionFor({ ...action, state: 'cancelled' }, 'agent-b')).toBe(false)
  })

  it('moves inflight cancellation through cancel_requested', () => {
    expect(canTransitionAction('in_progress', 'cancelled')).toBe(false)
    expect(canTransitionAction('in_progress', 'cancel_requested')).toBe(true)
    expect(canTransitionAction('cancel_requested', 'cancelled')).toBe(true)
    expect(canTransitionAction('cancel_requested', 'unknown')).toBe(true)
  })

  it('keeps terminal states terminal', () => {
    expect(isTerminalActionState('completed')).toBe(true)
    expect(isTerminalActionState('refused')).toBe(true)
    expect(isTerminalActionState('cancelled')).toBe(true)
    expect(isTerminalActionState('unknown')).toBe(false)
    expect(canTransitionAction('completed', 'in_progress')).toBe(false)
    expect(canTransitionAction('cancelled', 'completed')).toBe(false)
  })

  it('converges unknown by readback only', () => {
    expect(canTransitionAction('unknown', 'completed')).toBe(true)
    expect(canTransitionAction('unknown', 'failed')).toBe(true)
  })
})
