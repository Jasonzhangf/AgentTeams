import { describe, expect, it } from 'vitest'
import { applyAccess, applyRefusal, applyReply, applyUnknown, defaultActor, groupActors, groupPhase, initialGroupWorkspaceState, intentKeyOf, mergeMessages, recentGroupId, withCommitId, assignableMembers, grantTargets, invitableAgents } from '../src/state/group-workspace.ts'

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

  it('renders a refused request as refusal, never as a delivery', () => {
    const state = applyRefusal(initialGroupWorkspaceState, 'FORBIDDEN', 'not declared', 'group.list')
    expect(state.listStatus).toBe('refused')
    expect(state.outcome).toMatchObject({ kind: 'refused', code: 'FORBIDDEN' })
    expect(groupPhase(state)).toBe('refused')
  })

  it('keeps an unknown external close outcome out of the closed state', () => {
    const base = { ...initialGroupWorkspaceState, issue: { sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1', initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1 } }
    const state = applyReply(base, { kind: 'issue.closed', requestId: 'r1', session: { ...base.issue!, state: 'closed' as const }, outcome: 'unknown' as const })
    expect(state.outcome.kind).toBe('unknown')
    expect(state.issue?.state).toBe('closed')
    expect(state.outcome).not.toMatchObject({ kind: 'succeeded' })
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

  it('assigns work only to members the acting agent already commands', () => {
    const group = build([member('agent-a', 'master', ['agent-b']), member('agent-b', 'peer'), member('agent-c', 'peer')])
    expect(assignableMembers(group, 'agent-a')).toEqual(['agent-b'])
    expect(assignableMembers(group, 'agent-b')).toEqual([])
    expect(assignableMembers(group, undefined)).toEqual([])
  })

  it('invites declared agents that are not already active members', () => {
    const group = build([member('agent-a', 'master'), member('agent-b', 'peer')])
    expect(invitableAgents(['agent-a', 'agent-b', 'agent-c'], group)).toEqual(['agent-c'])
    expect(invitableAgents(['agent-a'], undefined)).toEqual(['agent-a'])
  })
})
