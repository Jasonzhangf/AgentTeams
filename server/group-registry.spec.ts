import { describe, expect, it } from 'vitest'
import {
  activeMemberIds,
  canCloseIssue,
  canCommand,
  canManageGroup,
  canRequest,
  createGroup,
  createGroupRegistry,
  grantRole,
  groupOf,
  invitationFor,
  inviteMember,
  leaveGroup,
  listGroups,
  mastersOf,
  memberActiveAt,
  memberIntervals,
  respondToInvitation,
  type GroupRegistryState,
} from './group-registry.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:01:00.000Z'
const T2 = '2026-10-22T00:02:00.000Z'
const T3 = '2026-10-22T00:03:00.000Z'
const T4 = '2026-10-22T00:04:00.000Z'
const T5 = '2026-10-22T00:05:00.000Z'
const T6 = '2026-10-22T00:06:00.000Z'

function seed(): GroupRegistryState {
  let state = createGroupRegistry()
  state = createGroup(state, { groupId: 'g1', name: 'release', ownerAgentId: 'agent-a' }, T0)
  state = inviteMember(state, {
    groupId: 'g1', agentId: 'agent-b', role: 'peer', invitedByAgentId: 'agent-a',
  }, T1)
  state = respondToInvitation(state, { groupId: 'g1', agentId: 'agent-b', accept: true }, T2)
  return state
}

function withCommandEdge(state: GroupRegistryState): GroupRegistryState {
  return grantRole(state, {
    groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'], grantedByAgentId: 'agent-a',
  }, T3)
}

describe('group registry membership', () => {
  it('creates the group with the owner as the first active master', () => {
    let state = createGroupRegistry()
    state = createGroup(state, { groupId: 'g1', name: 'release', ownerAgentId: 'agent-a' }, T0)
    const group = groupOf(state, 'g1')
    expect(group.ownerAgentId).toBe('agent-a')
    expect(activeMemberIds(group)).toEqual(['agent-a'])
    expect(mastersOf(group, 'agent-a')).toEqual([])
    expect(canManageGroup(group, 'agent-a')).toBe(true)
    expect(canManageGroup(group, 'agent-b')).toBe(false)
  })

  it('records a pending invitation and opens an interval only when accepted', () => {
    let state = createGroupRegistry()
    state = createGroup(state, { groupId: 'g1', name: 'release', ownerAgentId: 'agent-a' }, T0)
    state = inviteMember(state, {
      groupId: 'g1', agentId: 'agent-b', role: 'peer', invitedByAgentId: 'agent-a',
    }, T1)
    expect(invitationFor(state, 'g1', 'agent-b')?.state).toBe('pending')
    expect(groupOf(state, 'g1').members).toHaveLength(1)
    state = respondToInvitation(state, { groupId: 'g1', agentId: 'agent-b', accept: true }, T2)
    expect(activeMemberIds(groupOf(state, 'g1'))).toEqual(['agent-a', 'agent-b'])
    expect(memberIntervals(groupOf(state, 'g1'), 'agent-b')).toEqual([{ joinedAt: T2 }])
  })

  it('declines an invitation without adding a member', () => {
    let state = createGroupRegistry()
    state = createGroup(state, { groupId: 'g1', name: 'release', ownerAgentId: 'agent-a' }, T0)
    state = inviteMember(state, {
      groupId: 'g1', agentId: 'agent-c', role: 'peer', invitedByAgentId: 'agent-a',
    }, T1)
    state = respondToInvitation(state, { groupId: 'g1', agentId: 'agent-c', accept: false }, T2)
    expect(groupOf(state, 'g1').members.map(member => member.agentId)).toEqual(['agent-a'])
    expect(invitationFor(state, 'g1', 'agent-c')).toBeUndefined()
    expect(() => respondToInvitation(state, { groupId: 'g1', agentId: 'agent-c', accept: true }, T3))
      .toThrow(/no pending invitation/)
  })

  it('rejects duplicate groups, active re-invites and peer command edges', () => {
    const state = seed()
    expect(() => createGroup(state, { groupId: 'g1', name: 'again', ownerAgentId: 'agent-a' }, T3))
      .toThrow(/already exists/)
    expect(() => inviteMember(state, {
      groupId: 'g1', agentId: 'agent-b', role: 'peer', invitedByAgentId: 'agent-a',
    }, T3)).toThrow(/already an active member/)
    expect(() => inviteMember(state, {
      groupId: 'g1', agentId: 'agent-c', role: 'peer', mastersOf: ['agent-b'], invitedByAgentId: 'agent-a',
    }, T3)).toThrow(/peer invitation cannot carry command edges/)
    expect(() => inviteMember(state, {
      groupId: 'missing', agentId: 'agent-c', role: 'peer', invitedByAgentId: 'agent-a',
    }, T3)).toThrow(/unknown group/)
  })

  it('requires group management to belong to the active owner', () => {
    let state = seed()
    state = grantRole(state, {
      groupId: 'g1', agentId: 'agent-b', role: 'master', grantedByAgentId: 'agent-a',
    }, T3)
    expect(canManageGroup(groupOf(state, 'g1'), 'agent-b')).toBe(false)
    expect(() => inviteMember(state, {
      groupId: 'g1', agentId: 'agent-c', role: 'peer', invitedByAgentId: 'agent-b',
    }, T4)).toThrow(/cannot manage group/)
  })
})

describe('group registry command edges', () => {
  it('uses one directional edge for assignment and request', () => {
    const state = withCommandEdge(seed())
    const group = groupOf(state, 'g1')
    expect(mastersOf(group, 'agent-a')).toEqual(['agent-b'])
    expect(canCommand(group, 'agent-a', 'agent-b')).toBe(true)
    expect(canRequest(group, 'agent-b', 'agent-a')).toBe(true)
    expect(canCommand(group, 'agent-b', 'agent-a')).toBe(false)
    expect(canRequest(group, 'agent-a', 'agent-b')).toBe(false)
  })

  it('does not require an owner role to grant or derive command authority', () => {
    const state = seed()
    const group = groupOf(state, 'g1')
    expect(canCommand(group, 'agent-a', 'agent-b')).toBe(false)
    expect(canRequest(group, 'agent-b', 'agent-a')).toBe(false)
    expect(() => grantRole(state, {
      groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-c'], grantedByAgentId: 'agent-a',
    }, T3)).toThrow(/not an active member/)
  })

  it('rejects a self edge and edges owned by a peer', () => {
    const state = seed()
    expect(() => grantRole(state, {
      groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-a'], grantedByAgentId: 'agent-a',
    }, T3)).toThrow(/cannot command itself/)
    expect(() => grantRole(state, {
      groupId: 'g1', agentId: 'agent-b', role: 'peer', mastersOf: ['agent-a'], grantedByAgentId: 'agent-a',
    }, T3)).toThrow(/peer cannot own command edges/)
  })
})

describe('group registry leave and reentry', () => {
  it('closes the interval and clears every command edge that mentions the member', () => {
    let state = withCommandEdge(seed())
    state = leaveGroup(state, { groupId: 'g1', agentId: 'agent-b' }, T4)
    const group = groupOf(state, 'g1')
    expect(memberIntervals(group, 'agent-b')).toEqual([{ joinedAt: T2, leftAt: T4 }])
    expect(mastersOf(group, 'agent-a')).toEqual([])
    expect(memberActiveAt(group, 'agent-b', T3)).toBe(true)
    expect(memberActiveAt(group, 'agent-b', T4)).toBe(false)
    expect(canCommand(group, 'agent-a', 'agent-b')).toBe(false)
    expect(() => leaveGroup(state, { groupId: 'g1', agentId: 'agent-b' }, T5))
      .toThrow(/not an active member/)
  })

  it('opens a new interval on reentry without inheriting the old one', () => {
    let state = withCommandEdge(seed())
    state = leaveGroup(state, { groupId: 'g1', agentId: 'agent-b' }, T4)
    state = inviteMember(state, {
      groupId: 'g1', agentId: 'agent-b', role: 'peer', invitedByAgentId: 'agent-a',
    }, T5)
    state = respondToInvitation(state, { groupId: 'g1', agentId: 'agent-b', accept: true }, T6)
    const group = groupOf(state, 'g1')
    expect(memberIntervals(group, 'agent-b')).toEqual([
      { joinedAt: T2, leftAt: T4 },
      { joinedAt: T6 },
    ])
    expect(memberActiveAt(group, 'agent-b', T4)).toBe(false)
    expect(memberActiveAt(group, 'agent-b', T2)).toBe(true)
    expect(memberActiveAt(group, 'agent-b', T6)).toBe(true)
    expect(mastersOf(group, 'agent-a')).toEqual([])
  })

  it('lists only joined groups and validates close authority', () => {
    const state = seed()
    expect(listGroups(state, 'agent-a')).toHaveLength(1)
    expect(listGroups(state, 'agent-b')).toHaveLength(1)
    expect(listGroups(state, 'agent-c')).toHaveLength(0)
    expect(canCloseIssue({ initiatorAgentId: 'agent-a' }, 'agent-a')).toBe(true)
    expect(canCloseIssue({ initiatorAgentId: 'agent-a' }, 'agent-b')).toBe(false)
    // A client-supplied delegate list never grants close authority.
    expect(canCloseIssue({ initiatorAgentId: 'agent-a' }, 'agent-b')).toBe(false)
  })
})
