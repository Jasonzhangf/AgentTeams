import type {
  AgentRole,
  Group,
  GroupInvitation,
  GroupMember,
  IssueSession,
  MemberInterval,
} from '../packages/shared/src/group-wire.ts'

/**
 * Group and membership truth for the group messaging increment.
 *
 * The module owns groups, invitations, the explicit `mastersOf` command edge and
 * member validity intervals. Every function is pure: the caller passes the
 * current state and a timestamp, and receives the next state. No clock, no I/O.
 *
 * The command edge is directional and shared by both directions: a master's
 * `mastersOf` contains the peer. Assignment (master -> peer) and request
 * (peer -> master) both check that one edge. A reverse edge is never required.
 */

export interface GroupRegistryState {
  readonly groups: ReadonlyMap<string, Group>
  readonly invitations: readonly GroupInvitation[]
}

export interface CreateGroupInput {
  readonly groupId: string
  readonly name: string
  readonly ownerAgentId: string
}

export interface InviteMemberInput {
  readonly groupId: string
  readonly agentId: string
  readonly role: AgentRole
  readonly mastersOf?: readonly string[]
  readonly invitedByAgentId: string
}

export interface RespondInvitationInput {
  readonly groupId: string
  readonly agentId: string
  readonly accept: boolean
}

export interface LeaveGroupInput {
  readonly groupId: string
  readonly agentId: string
}

export interface GrantRoleInput {
  readonly groupId: string
  readonly agentId: string
  readonly role: AgentRole
  readonly mastersOf?: readonly string[]
  readonly grantedByAgentId: string
}

function fail(message: string): never {
  throw new Error(`group-registry: ${message}`)
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return value
}

function timestampOf(value: string, label: string): number {
  requireText(value, label)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) fail(`${label} must be an ISO timestamp`)
  return parsed
}

function uniqueIds(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  for (const id of value) requireText(id, label)
  if (new Set(value).size !== value.length) fail(`${label} must not repeat an id`)
  return [...value]
}

function memberOf(group: Group, agentId: string): GroupMember {
  const member = group.members.find(entry => entry.agentId === agentId)
  if (!member) fail(`unknown member ${agentId} in group ${group.groupId}`)
  return member
}

function hasOpenInterval(member: GroupMember): boolean {
  const last = member.intervals[member.intervals.length - 1]
  return last !== undefined && last.leftAt === undefined
}

function replaceMember(group: Group, member: GroupMember): Group {
  return {
    ...group,
    members: group.members.map(entry => (entry.agentId === member.agentId ? member : entry)),
  }
}

function copyWithGroup(state: GroupRegistryState, group: Group): GroupRegistryState {
  const groups = new Map(state.groups)
  groups.set(group.groupId, group)
  return { groups, invitations: state.invitations }
}

function checkCommandEdges(group: Group, memberAgentId: string, mastersOf: readonly string[], now: string): readonly string[] {
  const nowMs = timestampOf(now, 'now')
  uniqueIds(mastersOf, 'mastersOf')
  for (const masterId of mastersOf) {
    if (masterId === memberAgentId) fail('a member cannot command itself')
    const master = group.members.find(entry => entry.agentId === masterId)
    if (!master || !isActiveAt(master, nowMs)) fail(`command edge target ${masterId} is not an active member`)
  }
  return [...mastersOf]
}

function isActiveAt(member: GroupMember, atMs: number): boolean {
  return member.intervals.some(interval => {
    const joined = timestampOf(interval.joinedAt, 'interval joinedAt')
    const left = interval.leftAt === undefined ? undefined : timestampOf(interval.leftAt, 'interval leftAt')
    return joined <= atMs && (left === undefined || atMs < left)
  })
}

export function createGroupRegistry(): GroupRegistryState {
  return { groups: new Map(), invitations: [] }
}

export function groupOf(state: GroupRegistryState, groupId: string): Group {
  const group = state.groups.get(requireText(groupId, 'groupId'))
  if (!group) fail(`unknown group ${groupId}`)
  return group
}

export function listGroups(state: GroupRegistryState, agentId?: string): readonly Group[] {
  const groups = [...state.groups.values()]
  if (agentId === undefined) return groups
  return groups.filter(group => group.members.some(member => member.agentId === agentId && hasOpenInterval(member)))
}

export function invitationFor(state: GroupRegistryState, groupId: string, agentId: string): GroupInvitation | undefined {
  return [...state.invitations].reverse().find(invitation =>
    invitation.groupId === groupId && invitation.agentId === agentId && invitation.state === 'pending')
}

export function listInvitations(state: GroupRegistryState, groupId?: string): readonly GroupInvitation[] {
  return state.invitations.filter(invitation => groupId === undefined || invitation.groupId === groupId)
}

/**
 * Creates the group with its owner as the first active master. The owner runs the
 * group, but ownership never grants a command edge over another member by itself.
 */
export function createGroup(state: GroupRegistryState, input: CreateGroupInput, now: string): GroupRegistryState {
  const groupId = requireText(input.groupId, 'groupId')
  const name = requireText(input.name, 'name')
  const ownerAgentId = requireText(input.ownerAgentId, 'ownerAgentId')
  timestampOf(now, 'now')
  if (state.groups.has(groupId)) fail(`group ${groupId} already exists`)
  const owner: GroupMember = {
    agentId: ownerAgentId,
    role: 'master',
    mastersOf: [],
    intervals: [{ joinedAt: now }],
  }
  const group: Group = { groupId, name, ownerAgentId, createdAt: now, members: [owner] }
  return copyWithGroup(state, group)
}

/** Records a pending invitation. Accepting it opens a new interval for the invitee. */
export function inviteMember(state: GroupRegistryState, input: InviteMemberInput, now: string): GroupRegistryState {
  const group = groupOf(state, input.groupId)
  const inviter = requireText(input.invitedByAgentId, 'invitedByAgentId')
  const agentId = requireText(input.agentId, 'agentId')
  timestampOf(now, 'now')
  if (!canManageGroup(group, inviter)) fail(`${inviter} cannot manage group ${group.groupId}`)
  if (agentId === inviter) fail('a manager cannot invite itself')
  const existing = group.members.find(member => member.agentId === agentId)
  if (existing && hasOpenInterval(existing)) fail(`${agentId} is already an active member`)
  if (invitationFor(state, group.groupId, agentId) !== undefined) fail(`a pending invitation for ${agentId} already exists`)
  if (input.role === 'peer' && (input.mastersOf ?? []).length > 0) fail('a peer invitation cannot carry command edges')
  const mastersOf = checkCommandEdges(group, agentId, input.mastersOf ?? [], now)
  const invitation: GroupInvitation = {
    groupId: group.groupId,
    agentId,
    role: input.role,
    mastersOf,
    invitedByAgentId: inviter,
    state: 'pending',
    createdAt: now,
  }
  return { groups: state.groups, invitations: [...state.invitations, invitation] }
}

/**
 * Accepting adds the member or reopens a new interval after a previous exit.
 * Declining changes only the invitation record.
 */
export function respondToInvitation(state: GroupRegistryState, input: RespondInvitationInput, now: string): GroupRegistryState {
  const group = groupOf(state, input.groupId)
  const agentId = requireText(input.agentId, 'agentId')
  timestampOf(now, 'now')
  const invitation = invitationFor(state, group.groupId, agentId)
  if (!invitation) fail(`no pending invitation for ${agentId} in group ${group.groupId}`)
  const nextState = input.accept
    ? acceptInvitation(state, group, invitation, now)
    : declineInvitation(state, invitation)
  return nextState
}

function acceptInvitation(state: GroupRegistryState, group: Group, invitation: GroupInvitation, now: string): GroupRegistryState {
  const existing = group.members.find(member => member.agentId === invitation.agentId)
  if (existing && hasOpenInterval(existing)) fail(`${invitation.agentId} is already an active member`)
  if (invitation.role === 'peer' && invitation.mastersOf.length > 0) fail('a peer invitation cannot carry command edges')
  checkCommandEdges(group, invitation.agentId, invitation.mastersOf, now)
  const interval: MemberInterval = { joinedAt: now }
  const member: GroupMember = existing
    ? {
        agentId: existing.agentId,
        role: invitation.role,
        mastersOf: [...invitation.mastersOf],
        intervals: [...existing.intervals, interval],
      }
    : {
        agentId: invitation.agentId,
        role: invitation.role,
        mastersOf: [...invitation.mastersOf],
        intervals: [interval],
      }
  const nextGroup = existing ? replaceMember(group, member) : { ...group, members: [...group.members, member] }
  const invitations = state.invitations.map(entry =>
    entry === invitation ? { ...entry, state: 'accepted' as const } : entry)
  const groups = new Map(state.groups)
  groups.set(nextGroup.groupId, nextGroup)
  return { groups, invitations }
}

function declineInvitation(state: GroupRegistryState, invitation: GroupInvitation): GroupRegistryState {
  const invitations = state.invitations.map(entry =>
    entry === invitation ? { ...entry, state: 'declined' as const } : entry)
  return { groups: state.groups, invitations }
}

/**
 * Closes the open interval and clears both directions of every command edge that
 * mentions the leaving member. A later rejoin starts a new interval and never
 * inherits the previous one.
 */
export function leaveGroup(state: GroupRegistryState, input: LeaveGroupInput, now: string): GroupRegistryState {
  const group = groupOf(state, input.groupId)
  const agentId = requireText(input.agentId, 'agentId')
  timestampOf(now, 'now')
  const member = memberOf(group, agentId)
  if (!hasOpenInterval(member)) fail(`${agentId} is not an active member`)
  const intervals = member.intervals.map((interval, index) =>
    index === member.intervals.length - 1 ? { ...interval, leftAt: now } : interval)
  const leaving: GroupMember = { ...member, mastersOf: [], intervals }
  const members = group.members.map(entry => {
    const next = entry.agentId === agentId ? leaving : entry
    return next.mastersOf.includes(agentId)
      ? { ...next, mastersOf: next.mastersOf.filter(id => id !== agentId) }
      : next
  })
  return copyWithGroup(state, { ...group, members })
}

/** Replaces a member role and, when supplied, the command edges it owns. */
export function grantRole(state: GroupRegistryState, input: GrantRoleInput, now: string): GroupRegistryState {
  const group = groupOf(state, input.groupId)
  const actor = requireText(input.grantedByAgentId, 'grantedByAgentId')
  const agentId = requireText(input.agentId, 'agentId')
  timestampOf(now, 'now')
  if (!canManageGroup(group, actor)) fail(`${actor} cannot manage group ${group.groupId}`)
  const member = memberOf(group, agentId)
  if (!hasOpenInterval(member)) fail(`${agentId} is not an active member`)
  if (input.role === 'peer' && (input.mastersOf ?? []).length > 0) fail('a peer cannot own command edges')
  const mastersOf = input.mastersOf === undefined
    ? (input.role === 'peer' ? [] : [...member.mastersOf])
    : checkCommandEdges(group, agentId, input.mastersOf, now)
  return copyWithGroup(state, replaceMember(group, { ...member, role: input.role, mastersOf }))
}

/** Directional: returns the peers this member explicitly commands. */
export function mastersOf(group: Group, agentId: string): readonly string[] {
  return [...memberOf(group, agentId).mastersOf]
}

/** master -> peer assignment: the actor's own edge must name the target. */
export function canCommand(group: Group, actorAgentId: string, targetAgentId: string): boolean {
  const actor = group.members.find(member => member.agentId === actorAgentId && hasOpenInterval(member))
  const target = group.members.find(member => member.agentId === targetAgentId && hasOpenInterval(member))
  if (!actor || !target) return false
  return actor.mastersOf.includes(targetAgentId)
}

/** peer -> master request: the target master's edge must name the requester. */
export function canRequest(group: Group, requesterAgentId: string, masterAgentId: string): boolean {
  const requester = group.members.find(member => member.agentId === requesterAgentId && hasOpenInterval(member))
  const master = group.members.find(member => member.agentId === masterAgentId && hasOpenInterval(member))
  if (!requester || !master) return false
  return master.mastersOf.includes(requesterAgentId)
}

/** Group management belongs to the active owner. Roles never grant it implicitly. */
export function canManageGroup(group: Group, agentId: string): boolean {
  if (group.ownerAgentId !== agentId) return false
  const owner = group.members.find(member => member.agentId === agentId)
  return owner !== undefined && hasOpenInterval(owner)
}

/**
 * Close and reopen belong to the session initiator alone (design 7.3). A caller
 * cannot widen this by sending a delegate list; only the recorded initiator and
 * an active membership pass.
 */
export function canCloseIssue(
  session: Pick<IssueSession, 'initiatorAgentId'>,
  actorAgentId: string,
): boolean {
  return session.initiatorAgentId === actorAgentId
}

/** True when the member held a valid interval at the given instant. */
export function memberActiveAt(group: Group, agentId: string, at: string): boolean {
  const atMs = timestampOf(at, 'at')
  const member = group.members.find(entry => entry.agentId === agentId)
  return member !== undefined && isActiveAt(member, atMs)
}

/** Access record for one member; join and leave times are never collapsed into a watermark. */
export function memberIntervals(group: Group, agentId: string): readonly MemberInterval[] {
  return [...memberOf(group, agentId).intervals]
}

export function activeMemberIds(group: Group): readonly string[] {
  return group.members.filter(hasOpenInterval).map(member => member.agentId)
}
