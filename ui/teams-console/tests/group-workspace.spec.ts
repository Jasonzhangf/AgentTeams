import { describe, expect, it } from 'vitest'
import { applyAccess, applyRefusal, applyReply, applyUnknown, defaultActor, groupActors, groupPhase, initialGroupWorkspaceState, intentKeyOf, isReadFrame, mergeMessages, recentGroupId, withCommitId, assignableMembers, canRefuseAction, canReportAction, commandTargets, grantTargets, invitableAgents, requestTargets } from '../src/state/group-workspace.ts'

const reply = {
  kind: 'group.list', requestId: 'r1',
  groups: [
    { groupId: 'g1', name: 'Alpha', ownerAgentId: 'agent-a', createdAt: '2026-10-20T00:00:00.000Z', members: [{ agentId: 'agent-a', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] }] },
    { groupId: 'g2', name: 'Beta', ownerAgentId: 'agent-a', createdAt: '2026-10-22T00:00:00.000Z', members: [{ agentId: 'agent-a', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-22T00:00:00.000Z' }] }] },
  ],
} as const

describe('group workspace model', () => {
  it('defaults to the most recent group', () => {
    const state = applyReply(initialGroupWorkspaceState, reply)
    expect(state.selectedGroupId).toBe('g2')
    expect(state.listStatus).toBe('ready')
  })

  it('keeps a typed empty state when the owner lists no group', () => {
    const state = applyReply(initialGroupWorkspaceState, { kind: 'group.list', requestId: 'r1', groups: [] })
    expect(state.listStatus).toBe('empty')
    expect(groupPhase(state)).toBe('empty')
  })

  it('separates not-configured from unreachable access', () => {
    const notConfigured = applyAccess(initialGroupWorkspaceState, { kind: 'not-configured', message: 'owner missing' })
    const unreachable = applyAccess(initialGroupWorkspaceState, { kind: 'unreachable', message: 'socket refused' })
    expect(groupPhase(notConfigured)).toBe('failed')
    expect(groupPhase(unreachable)).toBe('failed')
    expect(notConfigured.outcome).toMatchObject({ code: 'GROUP_ENDPOINT_NOT_CONFIGURED' })
    expect(unreachable.outcome).toMatchObject({ code: 'GROUP_ENDPOINT_UNREACHABLE' })
  })

  it('keeps an unknown mutation retryable with the same request and commit id', () => {
    const frame = { kind: 'message.send', requestId: 'req-1', commitId: 'commit-1', groupId: 'g1', targetAgentIds: ['agent-a'], replyRequired: false, body: 'hello' } as const
    const state = applyUnknown(initialGroupWorkspaceState, frame, 'no answer')
    expect(state.outcome.kind).toBe('unknown')
    expect(state.retryable?.requestId).toBe('req-1')
    expect(state.retryable?.commitId).toBe('commit-1')
    expect(withCommitId(state.retryable!.frame, state.retryable!.commitId!)).toEqual(frame)
  })

  it('surfaces an unreadable message page as an unknown workspace phase', () => {
    const loaded = applyReply(initialGroupWorkspaceState, reply)
    const state = applyUnknown(loaded, { kind: 'message.page', requestId: 'r2', groupId: 'g2' }, 'no answer')
    expect(groupPhase(state)).toBe('unknown')
  })

  it('renders a refused write as refusal, never as a delivery', () => {
    const state = applyRefusal(initialGroupWorkspaceState, 'FORBIDDEN', 'not declared', 'message.send')
    expect(state.outcome).toMatchObject({ kind: 'refused', code: 'FORBIDDEN' })
    expect(state.retryable).toBeNull()
  })

  it('scopes a refused read to its own section and never overwrites a write result', () => {
    const listed = applyReply(initialGroupWorkspaceState, reply)
    const failed = applyRefusal(listed, 'FORBIDDEN', 'not declared', 'group.list')
    expect(failed.listStatus).toBe('ready')
    expect(failed.readError).toMatchObject({ section: 'list', code: 'FORBIDDEN' })
    expect(failed.outcome.kind).toBe(listed.outcome.kind)
  })

  it('keeps an unknown external close outcome out of the closed state', () => {
    const session = { sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1', initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1 }
    const closeFrame = { kind: 'issue.close', requestId: 'r1', commitId: 'c1', sessionId: 's1', reason: 'done', conclusion: 'shipped' } as const
    const base = {
      ...initialGroupWorkspaceState,
      issue: session,
      mutation: { intentKey: intentKeyOf(closeFrame), requestId: 'r1', commitId: 'c1', frame: closeFrame, context: { actorId: 'agent-a', groupId: 'g1' } },
    }
    const state = applyReply(base, { kind: 'issue.closed', requestId: 'r1', session: { ...session, state: 'closed' as const }, outcome: 'unknown' as const }, 'issue.close')
    expect(state.outcome.kind).toBe('unknown')
    expect(state.issue?.state).toBe('closed')
    expect(state.retryable?.requestId).toBe('r1')
  })

  it('merges messages by id and keeps the owner sequence order', () => {
    const existing = [{ messageId: 'm2', commitId: 'c2', sequence: 2, groupId: 'g1', fromAgentId: 'a', targetAgentIds: [], replyRequired: false, body: 'two', sentAt: 't2' }] as const
    const incoming = [{ messageId: 'm1', commitId: 'c1', sequence: 1, groupId: 'g1', fromAgentId: 'a', targetAgentIds: [], replyRequired: false, body: 'one', sentAt: 't1' }] as const
    expect(mergeMessages(existing, incoming).map(message => message.messageId)).toEqual(['m1', 'm2'])
    expect(mergeMessages(existing, existing)).toHaveLength(1)
  })

  it('never offers the control owner as a group actor', () => {
    expect(groupActors(['control', 'agent-a', 'agent-b'])).toEqual(['agent-a', 'agent-b'])
    expect(defaultActor(['agent-a', 'agent-b'], 'agent-a')).toBe('agent-a')
    expect(defaultActor(['agent-a', 'agent-b'], undefined)).toBeUndefined()
    expect(defaultActor(['agent-a'], undefined)).toBe('agent-a')
    expect(defaultActor(['control'], undefined)).toBeUndefined()
  })

  it('derives one intent key per mutation so a retry reuses its commit', () => {
    const first = intentKeyOf({ kind: 'action.refuse', requestId: 'r1', actionId: 'a1', reason: 'no' })
    const second = intentKeyOf({ kind: 'action.refuse', requestId: 'r2', actionId: 'a1', reason: 'no' })
    expect(first).toBe(second)
  })
})

describe('write results survive unrelated reads', () => {
  const sendFrame = { kind: 'message.send', requestId: 'req-1', commitId: 'commit-1', groupId: 'g1', targetAgentIds: ['agent-a'], replyRequired: false, body: 'hello' } as const
  const submitFrame = { kind: 'action.submit', requestId: 'req-2', resultCommitId: 'result-1', actionId: 'a1', resultBody: 'done' } as const
  const unknownSend = applyUnknown(
    { ...initialGroupWorkspaceState, actorId: 'agent-a', selectedGroupId: 'g1' },
    sendFrame,
    'no answer',
  )

  it('keeps an unknown submit through successful list and page reads', () => {
    const listed = applyReply(unknownSend, { kind: 'action.list', requestId: 'r1', actions: [] }, 'action.list')
    const paged = applyReply(listed, { kind: 'message.page', requestId: 'r2', messages: [], revision: 1, hasMore: false }, 'message.page')
    const grouped = applyReply(paged, { kind: 'group.list', requestId: 'r3', groups: [] }, 'group.list')
    expect(grouped.outcome).toMatchObject({ kind: 'unknown', frame: 'message.send' })
    expect(grouped.retryable?.requestId).toBe('req-1')
    expect(grouped.retryable?.commitId).toBe('commit-1')
    expect(grouped.mutation).toBeNull()
  })

  it('keeps an unknown submit when the list read itself is refused', () => {
    // The controller retains the commit id; a refused read must not clear it.
    const withCommit = { ...unknownSend, commits: { 'agent-a::message.send:g1:hello': 'commit-1' } }
    const refused = applyRefusal(withCommit, 'ENDPOINT_UNREACHABLE_READ', 'list denied', 'action.list')
    // The list failure is reported on its own section; the write result stays visible.
    expect(refused.actionStatus).toBe('refused')
    expect(refused.readError).toMatchObject({ section: 'actions' })
    expect(refused.outcome).toMatchObject({ kind: 'unknown', frame: 'message.send' })
    expect(refused.retryable?.requestId).toBe('req-1')
    expect(refused.commits).toMatchObject({ 'agent-a::message.send:g1:hello': 'commit-1' })
  })

  it('settles only the write that the reply answers', () => {
    // A submit is pending; an answer attributed to another write must not clear it.
    const pending = {
      ...initialGroupWorkspaceState,
      actorId: 'agent-a',
      selectedGroupId: 'g1',
      mutation: { intentKey: intentKeyOf(submitFrame), requestId: 'req-2', commitId: 'result-1', frame: submitFrame, context: { actorId: 'agent-a', groupId: 'g1' } },
      outcome: { kind: 'pending' as const, frame: 'action.submit' as const, requestId: 'req-2' },
    }
    const other = applyReply(pending, { kind: 'group.created', requestId: 'req-9', group: { groupId: 'g2', name: 'Beta', ownerAgentId: 'agent-a', createdAt: 'now', members: [] } }, 'group.create')
    expect(other.outcome.kind).toBe('pending')
    expect(other.mutation?.requestId).toBe('req-2')
    // The answer to the pending submit does settle it, with its own frame.
    const action = { actionId: 'a1', commitId: 'ac1', sessionId: 's1', initiatorAgentId: 'agent-a', assigneeAgentId: 'agent-b', kind: 'reply' as const, reason: 'r', expectedResult: 'e', replyRequired: false, state: 'completed' as const, createdAt: 'now' }
    const settled = applyReply(pending, { kind: 'action.updated', requestId: 'req-2', action }, 'action.submit')
    expect(settled.outcome).toMatchObject({ kind: 'succeeded', frame: 'action.submit' })
    expect(settled.mutation).toBeNull()
  })

  it('does not settle a write with a read reply of the same family', () => {
    const pendingCreate = {
      ...initialGroupWorkspaceState,
      actorId: 'agent-a',
      selectedGroupId: 'g1',
      mutation: { intentKey: 'issue.create:x', requestId: 'req-3', commitId: 'c3', frame: { kind: 'issue.create', requestId: 'req-3', commitId: 'c3', groupId: 'g1', vikunjaProjectId: 'p', title: 't', body: 'b' } as const, context: { actorId: 'agent-a', groupId: 'g1' } },
      outcome: { kind: 'pending' as const, frame: 'issue.create' as const },
    }
    const session = { sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p', vikunjaIssueId: 'i', initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1 }
    const queried = applyReply(pendingCreate, { kind: 'issue.session', requestId: 'req-4', session }, 'issue.query')
    expect(queried.outcome.kind).toBe('pending')
    expect(queried.mutation?.requestId).toBe('req-3')
    const created = applyReply(pendingCreate, { kind: 'issue.session', requestId: 'req-3', session }, 'issue.create')
    expect(created.outcome).toMatchObject({ kind: 'succeeded', frame: 'issue.create' })
  })

  it('treats the issue list frame as a read', () => {
    expect(isReadFrame('issue.list')).toBe(true)
    expect(isReadFrame('action.list')).toBe(true)
    expect(isReadFrame('action.submit')).toBe(false)
  })

  it('populates the issue list from its own read without touching a pending write', () => {
    const pending = {
      ...initialGroupWorkspaceState,
      actorId: 'agent-a',
      selectedGroupId: 'g1',
      mutation: { intentKey: intentKeyOf(sendFrame), requestId: 'req-1', commitId: 'commit-1', frame: sendFrame, context: { actorId: 'agent-a', groupId: 'g1' } },
      outcome: { kind: 'pending' as const, frame: 'message.send' as const, requestId: 'req-1' },
      retryable: { intentKey: intentKeyOf(submitFrame), requestId: 'req-2', commitId: 'result-1', frame: submitFrame, context: { actorId: 'agent-a', groupId: 'g1' } },
      commits: { 'agent-a::message.send:g1:hello': 'commit-1' },
    }
    const session = { sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1', initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1 }
    const listed = applyReply(pending, { kind: 'issue.list', requestId: 'req-4', sessions: [session] }, 'issue.list')
    expect(listed.issues).toEqual([session])
    expect(listed.issueListStatus).toBe('ready')
    // A read never writes over the pending mutation, its answer or its commit memory.
    expect(listed.outcome).toEqual(pending.outcome)
    expect(listed.mutation).toBe(pending.mutation)
    expect(listed.retryable).toBe(pending.retryable)
    expect(listed.commits).toEqual(pending.commits)
    // An empty answer is a readable empty section, not a failure.
    const empty = applyReply(pending, { kind: 'issue.list', requestId: 'req-5', sessions: [] }, 'issue.list')
    expect(empty.issues).toEqual([])
    expect(empty.issueListStatus).toBe('empty')
    expect(empty.outcome).toEqual(pending.outcome)
  })
})

describe('command edge helpers', () => {
  const member = (agentId: string, role: 'master' | 'peer', mastersOf: string[] = []) => ({
    agentId,
    role,
    mastersOf,
    intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }],
  })
  const build = (members: ReturnType<typeof member>[], ownerAgentId = 'agent-a') => ({
    groupId: 'g1',
    name: 'Alpha',
    ownerAgentId,
    createdAt: '2026-10-20T00:00:00.000Z',
    members,
  })

  it('offers grant targets only to the owner and never for an existing edge', () => {
    const group = build([member('agent-a', 'master', ['agent-b']), member('agent-b', 'peer'), member('agent-c', 'peer')])
    expect(grantTargets(group, 'agent-a')).toEqual(['agent-c'])
    // A peer holds no owner authority, so it gets no control at all.
    expect(grantTargets(group, 'agent-b')).toEqual([])
    expect(grantTargets(build([member('agent-a', 'master'), member('agent-b', 'peer')], 'agent-b'), 'agent-a')).toEqual([])
  })

  it('offers only members that share an explicit edge with the acting agent', () => {
    const group = build([member('agent-a', 'master', ['agent-b']), member('agent-b', 'peer'), member('agent-c', 'peer')])
    expect(assignableMembers(group, 'agent-a')).toEqual(['agent-b'])
    // The peer requests the master through the same edge; an edgeless peer is absent.
    expect(assignableMembers(group, 'agent-b')).toEqual(['agent-a'])
    expect(assignableMembers(group, 'agent-c')).toEqual([])
    expect(assignableMembers(group, undefined)).toEqual([])
  })

  it('derives both assign and request targets from the same directional edge', () => {
    const group = build([member('agent-a', 'master', ['agent-b']), member('agent-b', 'peer')])
    // The master commands the peer, so the master can assign to the peer.
    expect(assignableMembers(group, 'agent-a')).toEqual(['agent-b'])
    // The same edge also lets the peer request the master even though the peer's own
    // mastersOf list is empty.
    expect(assignableMembers(group, 'agent-b')).toEqual(['agent-a'])
    expect(commandTargets(group, 'agent-a')).toEqual(['agent-b'])
    expect(requestTargets(group, 'agent-a')).toEqual([])
    expect(commandTargets(group, 'agent-b')).toEqual([])
    expect(requestTargets(group, 'agent-b')).toEqual(['agent-a'])
  })

  it('lets only the assignee report a pending or in-progress action', () => {
    const group = build([member('agent-a', 'master', ['agent-b']), member('agent-b', 'peer')])
    const action = (state: 'pending' | 'in_progress' | 'blocked') => ({
      actionId: 'a1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-a',
      assigneeAgentId: 'agent-b', kind: 'reply' as const, reason: 'work',
      expectedResult: 'result', replyRequired: false, state, createdAt: 'now',
    })
    expect(canReportAction(group, action('pending'), 'agent-b')).toBe(true)
    expect(canReportAction(group, action('in_progress'), 'agent-b')).toBe(true)
    // The initiator is not the owner of the report; a terminal action has no report entry.
    expect(canReportAction(group, action('pending'), 'agent-a')).toBe(false)
    expect(canReportAction(group, action('blocked'), 'agent-b')).toBe(false)
    expect(canReportAction(group, action('pending'), undefined)).toBe(false)
  })

  it('lets a master refuse a peer request only through its own explicit edge', () => {
    const group = build([member('agent-a', 'master', ['agent-b']), member('agent-b', 'peer')])
    const request = {
      actionId: 'a1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-b',
      assigneeAgentId: 'agent-a', kind: 'reply' as const, reason: 'please review',
      expectedResult: 'result', replyRequired: true, state: 'pending' as const, createdAt: 'now',
    }
    expect(canRefuseAction(group, request, 'agent-a')).toBe(true)
    // The peer receiving a master assignment holds no edge back to the master.
    expect(canRefuseAction(group, { ...request, initiatorAgentId: 'agent-a', assigneeAgentId: 'agent-b' }, 'agent-b')).toBe(false)
    expect(canRefuseAction(group, { ...request, state: 'in_progress' }, 'agent-a')).toBe(false)
  })

  it('invites declared agents that are not already active members', () => {
    const group = build([member('agent-a', 'master'), member('agent-b', 'peer')])
    expect(invitableAgents(['agent-a', 'agent-b', 'agent-c'], group)).toEqual(['agent-c'])
    expect(invitableAgents(['agent-a'], undefined)).toEqual(['agent-a'])
  })
})

describe('issue close stop report', () => {
  const openSession = {
    sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1',
    initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1,
  }
  const closedSession = { ...openSession, state: 'closed' as const, closedAt: 'now' }
  const closeFrame = {
    kind: 'issue.close' as const, requestId: 'r1', commitId: 'c1', sessionId: 's1',
    reason: 'done', conclusion: 'shipped',
  }
  const pendingClose = {
    ...initialGroupWorkspaceState,
    actorId: 'agent-a',
    selectedGroupId: 'g1',
    issue: openSession,
    mutation: {
      intentKey: intentKeyOf(closeFrame),
      requestId: 'r1',
      commitId: 'c1',
      frame: closeFrame,
      context: { actorId: 'agent-a', groupId: 'g1', sessionId: 's1' },
    },
  }
  const unstopped = [
    { actionId: 'a-accepted', assigneeAgentId: 'agent-b', state: 'accepted' as const },
    { actionId: 'a-running', assigneeAgentId: 'agent-b', state: 'in_progress' as const },
    { actionId: 'a-stopping', assigneeAgentId: 'agent-c', state: 'cancel_requested' as const },
    { actionId: 'a-unknown', assigneeAgentId: 'agent-d', state: 'unknown' as const },
  ]
  const reply = {
    kind: 'issue.closed' as const,
    requestId: 'r1',
    session: closedSession,
    outcome: 'closed' as const,
    unstopped,
  }

  it('keeps the close stop report when the action list is re-read', () => {
    const closed = applyReply(pendingClose, reply, 'issue.close')
    expect(closed.outcome).toMatchObject({ kind: 'succeeded', frame: 'issue.close' })
    expect(closed.stopReport).toEqual({ sessionId: 's1', entries: unstopped })

    const refreshed = applyReply(closed, {
      kind: 'action.list',
      requestId: 'r2',
      actions: [{
        actionId: 'a-accepted', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-a',
        assigneeAgentId: 'agent-b', kind: 'reply', reason: 'old work', expectedResult: 'x',
        replyRequired: false, state: 'cancelled' as const, createdAt: 'now',
      }],
    }, 'action.list')

    // The owner now reports cancelled, but the reply's stop facts are still shown.
    expect(refreshed.actions[0]?.state).toBe('cancelled')
    expect(refreshed.stopReport).toEqual({ sessionId: 's1', entries: unstopped })
  })

  it('does not keep a completed stop report for an unknown, failed or conflict close', () => {
    for (const outcome of ['unknown', 'failed', 'conflict'] as const) {
      const state = applyReply(pendingClose, { ...reply, outcome }, 'issue.close')
      expect(state.stopReport, outcome).toBeNull()
      expect(state.outcome.kind, outcome).toBe(outcome === 'unknown' ? 'unknown' : 'failed')
    }
  })

  it('keeps only the reply entries and never invents a pending stop entry', () => {
    const pendingAction = {
      actionId: 'a-pending', commitId: 'c2', sessionId: 's1', initiatorAgentId: 'agent-a',
      assigneeAgentId: 'agent-b', kind: 'reply' as const, reason: 'queued', expectedResult: 'x',
      replyRequired: false, state: 'pending' as const, createdAt: 'now',
    }
    const state = applyReply({ ...pendingClose, actions: [pendingAction] }, reply, 'issue.close')
    expect(state.stopReport?.entries.map(entry => entry.actionId))
      .toEqual(['a-accepted', 'a-running', 'a-stopping', 'a-unknown'])
    expect(state.stopReport?.entries.some(entry => entry.actionId === 'a-pending')).toBe(false)
  })
})
