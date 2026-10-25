import type { Action, Group, GroupWireReply, GroupWireRequest, IssueSession, Message } from '../../../../packages/shared/src/group-wire.ts'
import type { GroupAccessState } from '../client/group-client.ts'

/**
 * Group workspace view model.
 *
 * This module owns UI-facing state derivation only. It never decides business truth:
 * every field is either read from a typed owner reply or is an explicit UI phase
 * (`loading`, `failed`, `unknown`, `refused`). A mutation whose owner reply is missing
 * stays `unknown` and is never rendered as delivered.
 */

export type GroupSectionStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed' | 'refused' | 'unknown'

export type GroupPhase = 'idle' | 'loading' | 'live' | 'empty' | 'failed' | 'unknown' | 'refused'

export type GroupMutationKind =
  | 'group.create'
  | 'group.invite'
  | 'group.respond'
  | 'group.leave'
  | 'message.send'
  | 'message.ack'
  | 'issue.create'
  | 'issue.reference'
  | 'issue.close'
  | 'issue.reopen'
  | 'action.create'
  | 'action.submit'
  | 'action.report'
  | 'action.refuse'

export type GroupOutcomeKind = 'idle' | 'pending' | 'succeeded' | 'refused' | 'unknown' | 'failed'

export interface GroupOutcome {
  readonly kind: GroupOutcomeKind
  readonly frame?: GroupWireRequest['kind']
  readonly requestId?: string
  readonly commitId?: string
  readonly code?: string
  readonly message?: string
}

/**
 * A mutation kept for an explicit user retry. Both the request id and the commit id
 * survive the retry: a repeated submit must not create a second business object.
 */
export interface GroupMutationMemory {
  readonly intentKey: string
  readonly requestId: string
  readonly commitId?: string
  readonly frame: GroupWireRequest
}

export interface GroupWorkspaceState {
  readonly access: GroupAccessState
  readonly listStatus: GroupSectionStatus
  readonly groups: readonly Group[]
  readonly selectedGroupId?: string
  readonly messageStatus: GroupSectionStatus
  readonly messages: readonly Message[]
  readonly messageHasMore: boolean
  readonly messageCursor?: number
  readonly issue: IssueSession | null
  readonly issueStatus: GroupSectionStatus
  readonly actions: readonly Action[]
  readonly actionStatus: GroupSectionStatus
  readonly composer: string
  /** Agents this Console may act as for group traffic; `control` is never an actor. */
  readonly actors: readonly string[]
  readonly actorId?: string
  readonly mutation: GroupMutationMemory | null
  readonly retryable: GroupMutationMemory | null
  /** commit id per intent, so an unknown or timed-out retry reuses the same commit. */
  readonly commits: Readonly<Record<string, string>>
  readonly outcome: GroupOutcome
  /** A prepared critical action that needs an explicit confirmation before it is sent. */
  readonly confirm: GroupMutationMemory | null
  readonly error?: { readonly code: string; readonly message: string }
}

export const initialGroupWorkspaceState: GroupWorkspaceState = {
  access: { kind: 'ready' },
  listStatus: 'idle',
  groups: [],
  messageStatus: 'idle',
  messages: [],
  messageHasMore: false,
  issue: null,
  issueStatus: 'idle',
  actions: [],
  actionStatus: 'idle',
  composer: '',
  actors: [],
  mutation: null,
  retryable: null,
  commits: {},
  outcome: { kind: 'idle' },
  confirm: null,
}

/**
 * Derive the single phase the view renders. A missing actor outranks everything: while
 * several agents could act and none is chosen the workspace must show that choice instead
 * of a content phase it cannot load.
 */
export function groupPhase(state: GroupWorkspaceState): GroupPhase {
  if (state.actors.length > 1 && state.actorId === undefined) return 'idle'
  if (state.access.kind !== 'ready') return 'failed'
  if (state.listStatus === 'refused') return 'refused'
  if (state.listStatus === 'failed') return 'failed'
  if (state.listStatus === 'idle') return 'idle'
  if (state.listStatus === 'loading' && state.groups.length === 0) return 'loading'
  if (state.groups.length === 0) return state.listStatus === 'empty' ? 'empty' : 'loading'
  if (state.messageStatus === 'refused') return 'refused'
  if (state.messageStatus === 'failed') return 'failed'
  if (state.messageStatus === 'unknown') return 'unknown'
  if (state.messageStatus === 'idle' || (state.messageStatus === 'loading' && state.messages.length === 0)) return 'loading'
  return 'live'
}

/** Newest group first. The default selection is the most recently created group. */
export function recentGroupId(groups: readonly Group[]): string | undefined {
  let selected: Group | undefined
  for (const group of groups) {
    if (selected === undefined) {
      selected = group
      continue
    }
    const next = Date.parse(group.createdAt)
    const current = Date.parse(selected.createdAt)
    if (Number.isNaN(next)) continue
    if (Number.isNaN(current) || next >= current) selected = group
  }
  return selected?.groupId
}

function upsertGroup(groups: readonly Group[], group: Group): readonly Group[] {
  const index = groups.findIndex(candidate => candidate.groupId === group.groupId)
  if (index < 0) return [...groups, group]
  const next = [...groups]
  next[index] = group
  return next
}

function upsertAction(actions: readonly Action[], action: Action): readonly Action[] {
  const index = actions.findIndex(candidate => candidate.actionId === action.actionId)
  if (index < 0) return [...actions, action]
  const next = [...actions]
  next[index] = action
  return next
}

/** Messages merge by id and order by the owner sequence; a re-read never duplicates a row. */
export function mergeMessages(existing: readonly Message[], incoming: readonly Message[]): readonly Message[] {
  const byId = new Map<string, Message>()
  for (const message of existing) byId.set(message.messageId, message)
  for (const message of incoming) byId.set(message.messageId, message)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

function succeeded(state: GroupWorkspaceState, patch: Partial<GroupWorkspaceState> = {}, frame?: GroupMutationKind): GroupWorkspaceState {
  return {
    ...state,
    ...patch,
    mutation: null,
    retryable: null,
    commits: {},
    outcome: { kind: 'succeeded', ...(frame === undefined ? {} : { frame }) },
  }
}

/** Apply one validated owner reply. Unknown reply kinds cannot reach here. */
export function applyReply(input: GroupWorkspaceState, reply: GroupWireReply): GroupWorkspaceState {
  // A validated reply proves the endpoint is reachable again, so a stale access failure
  // cannot outlive the answer that disproves it.
  return applyReplyKind(input.access.kind === 'ready' ? input : { ...input, access: { kind: 'ready' } }, reply)
}

function applyReplyKind(state: GroupWorkspaceState, reply: GroupWireReply): GroupWorkspaceState {
  switch (reply.kind) {
    case 'group.list': {
      const groups = reply.groups
      const selection = state.selectedGroupId !== undefined && groups.some(group => group.groupId === state.selectedGroupId)
        ? state.selectedGroupId
        : recentGroupId(groups)
      return {
        ...state,
        access: { kind: 'ready' },
        groups,
        listStatus: groups.length === 0 ? 'empty' : 'ready',
        selectedGroupId: selection,
        messageStatus: selection === state.selectedGroupId ? state.messageStatus : 'idle',
        messages: selection === state.selectedGroupId ? state.messages : [],
        messageHasMore: selection === state.selectedGroupId ? state.messageHasMore : false,
        messageCursor: selection === state.selectedGroupId ? state.messageCursor : undefined,
        issue: selection === state.selectedGroupId ? state.issue : null,
        issueStatus: selection === state.selectedGroupId ? state.issueStatus : 'idle',
        actions: selection === state.selectedGroupId ? state.actions : [],
        actionStatus: selection === state.selectedGroupId ? state.actionStatus : 'idle',
      }
    }
    case 'group.created':
    case 'group.member': {
      const groups = upsertGroup(state.groups, reply.group)
      return succeeded(
        { ...state, groups, listStatus: 'ready', selectedGroupId: reply.group.groupId },
        { messageStatus: 'idle', messages: [], messageHasMore: false, messageCursor: undefined, issue: null, issueStatus: 'idle', actions: [], actionStatus: 'idle' },
        reply.kind === 'group.created' ? 'group.create' : undefined,
      )
    }
    case 'group.changed': {
      return { ...state, groups: upsertGroup(state.groups, reply.group), listStatus: 'ready' }
    }
    case 'group.invited': {
      return succeeded(state, {}, 'group.invite')
    }
    case 'message.page': {
      return {
        ...state,
        messageStatus: reply.messages.length === 0 && state.messages.length === 0 ? 'empty' : 'ready',
        messages: mergeMessages(state.messages, reply.messages),
        messageHasMore: reply.hasMore,
        messageCursor: reply.messages.length === 0 ? state.messageCursor : reply.messages.at(-1)?.sequence,
      }
    }
    case 'message.received': {
      return { ...state, messages: mergeMessages(state.messages, [reply.message]), messageStatus: 'ready' }
    }
    case 'message.sent': {
      return succeeded(state, {}, 'message.send')
    }
    case 'message.acked': {
      return succeeded(state, {}, 'message.ack')
    }
    case 'issue.session': {
      return succeeded({ ...state, issue: reply.session, issueStatus: 'ready' })
    }
    case 'issue.changed': {
      if (state.issue === null || state.issue.sessionId !== reply.sessionId) return state
      return { ...state, issue: { ...state.issue, state: reply.state } }
    }
    case 'issue.closed': {
      const unknown = reply.outcome === 'unknown'
      const failed = reply.outcome === 'failed' || reply.outcome === 'conflict'
      const patched: GroupWorkspaceState = { ...state, issue: reply.session, issueStatus: 'ready' }
      if (unknown) {
        // An unknown external outcome is not a close. It stays retryable and never
        // renders as a completed close.
        return {
          ...patched,
          mutation: null,
          retryable: state.retryable,
          outcome: { kind: 'unknown', frame: 'issue.close', code: 'RESULT_UNKNOWN', message: 'Issue owner reported an unknown close outcome.' },
        }
      }
      if (failed) {
        return {
          ...patched,
          mutation: null,
          retryable: null,
          commits: {},
          outcome: { kind: 'failed', frame: 'issue.close', code: reply.outcome.toUpperCase(), message: `Issue close reported ${reply.outcome}.` },
        }
      }
      return succeeded(patched, {}, 'issue.close')
    }
    case 'issue.reopened': {
      const unknown = reply.outcome === 'unknown'
      const failed = reply.outcome === 'failed' || reply.outcome === 'conflict'
      const patched: GroupWorkspaceState = { ...state, issue: reply.session, issueStatus: 'ready' }
      if (unknown) {
        return {
          ...patched,
          mutation: null,
          outcome: { kind: 'unknown', frame: 'issue.reopen', code: 'RESULT_UNKNOWN', message: 'Issue owner reported an unknown reopen outcome.' },
        }
      }
      if (failed) {
        return {
          ...patched,
          mutation: null,
          retryable: null,
          commits: {},
          outcome: { kind: 'failed', frame: 'issue.reopen', code: reply.outcome.toUpperCase(), message: `Issue reopen reported ${reply.outcome}.` },
        }
      }
      return succeeded(patched, {}, 'issue.reopen')
    }
    case 'action.created':
    case 'action.updated': {
      return succeeded({ ...state, actions: upsertAction(state.actions, reply.action), actionStatus: 'ready' }, {}, reply.kind === 'action.created' ? 'action.create' : undefined)
    }
    case 'action.changed': {
      return { ...state, actions: upsertAction(state.actions, reply.action), actionStatus: 'ready' }
    }
    case 'action.list': {
      return succeeded({ ...state, actions: reply.actions, actionStatus: reply.actions.length === 0 ? 'empty' : 'ready' })
    }
    case 'relay.error': {
      return {
        ...state,
        mutation: null,
        commits: {},
        outcome: { kind: 'refused', code: reply.error.code, message: reply.error.message },
        error: { code: reply.error.code, message: reply.error.message },
      }
    }
    case 'op.execute': {
      // External operation prompts belong to the daemon that executes them; the Console
      // shows nothing until the owner reports the confirmed, failed or unknown result.
      return state
    }
    default:
      return state
  }
}

/** Access state transition. A recovered endpoint keeps existing content. */
export function applyAccess(state: GroupWorkspaceState, access: GroupAccessState): GroupWorkspaceState {
  if (access.kind === 'ready') return { ...state, access }
  return {
    ...state,
    access,
    listStatus: state.groups.length === 0 ? 'failed' : state.listStatus,
    messageStatus: state.messages.length === 0 ? 'failed' : state.messageStatus,
    mutation: null,
    outcome: { kind: 'failed', code: access.kind === 'not-configured' ? 'GROUP_ENDPOINT_NOT_CONFIGURED' : 'GROUP_ENDPOINT_UNREACHABLE', message: access.message },
  }
}

/** A refused request is a business answer, not a reachability problem. */
export function applyRefusal(state: GroupWorkspaceState, code: string, message: string, frameKind?: GroupWireRequest['kind']): GroupWorkspaceState {
  const next: GroupWorkspaceState = { ...state, outcome: { kind: 'refused', code, message, ...(frameKind === undefined ? {} : { frame: frameKind }) }, error: { code, message } }
  switch (frameKind) {
    case 'group.list': return { ...next, listStatus: state.groups.length === 0 ? 'refused' : state.listStatus, mutation: null, retryable: null, commits: {} }
    case 'message.page': return { ...next, messageStatus: state.messages.length === 0 ? 'refused' : state.messageStatus, mutation: null, retryable: null, commits: {} }
    case 'action.list': return { ...next, actionStatus: state.actions.length === 0 ? 'refused' : state.actionStatus, mutation: null, retryable: null, commits: {} }
    case 'issue.query': return { ...next, issueStatus: state.issue === null ? 'refused' : state.issueStatus, mutation: null, retryable: null, commits: {} }
    default: return { ...next, mutation: null, retryable: null, commits: {} }
  }
}

/**
 * A missing or unreadable owner answer. A mutation stays retryable with the same commit
 * so a repeated submit cannot create a second business object.
 */
export function applyUnknown(state: GroupWorkspaceState, frame: GroupWireRequest, message: string): GroupWorkspaceState {
  const retryable: GroupMutationMemory = {
    intentKey: intentKeyOf(frame),
    requestId: frame.requestId,
    frame,
    ...(('commitId' in frame && typeof frame.commitId === 'string') ? { commitId: frame.commitId } : {}),
    ...(('resultCommitId' in frame && typeof frame.resultCommitId === 'string') ? { commitId: frame.resultCommitId } : {}),
  }
  const base: GroupWorkspaceState = {
    ...state,
    mutation: null,
    outcome: { kind: 'unknown', frame: frame.kind, code: 'RESULT_UNKNOWN', message },
    error: { code: 'RESULT_UNKNOWN', message },
  }
  switch (frame.kind) {
    case 'group.list': return { ...base, listStatus: state.groups.length === 0 ? 'failed' : state.listStatus, retryable }
    case 'message.page': return { ...base, messageStatus: state.messages.length === 0 ? 'unknown' : state.messageStatus, retryable }
    case 'action.list': return { ...base, actionStatus: state.actions.length === 0 ? 'unknown' : state.actionStatus, retryable }
    case 'issue.query': return { ...base, issueStatus: state.issue === null ? 'unknown' : state.issueStatus, retryable }
    default: return { ...base, retryable }
  }
}

/** Attach the retained commit id to the frame field its owner contract defines. */
export function withCommitId(frame: GroupWireRequest, commitId: string): GroupWireRequest {
  switch (frame.kind) {
    case 'message.send':
    case 'issue.create':
    case 'issue.reference':
    case 'issue.close':
    case 'issue.reopen':
    case 'action.create':
      return { ...frame, commitId }
    case 'action.submit':
      return { ...frame, resultCommitId: commitId }
    default:
      return frame
  }
}

export function intentKeyOf(frame: GroupWireRequest): string {
  switch (frame.kind) {
    case 'message.send': return `message.send:${frame.groupId}:${frame.body}`
    case 'issue.close':
    case 'issue.reopen': return `${frame.kind}:${frame.sessionId}`
    case 'issue.create': return `issue.create:${frame.groupId}:${frame.title}`
    case 'issue.reference': return `issue.reference:${frame.groupId}:${frame.vikunjaIssueId}`
    case 'action.create': return `action.create:${frame.sessionId}:${frame.assigneeAgentId}:${frame.reason}`
    case 'action.submit': return `action.submit:${frame.actionId}`
    case 'action.report': return `action.report:${frame.actionId}:${frame.report}`
    case 'action.refuse': return `action.refuse:${frame.actionId}`
    case 'group.create': return `group.create:${frame.name}`
    case 'group.invite': return `group.invite:${frame.groupId}:${frame.agentId}`
    case 'group.respond': return `group.respond:${frame.groupId}:${String(frame.accept)}`
    case 'group.leave': return `group.leave:${frame.groupId}`
    default: return frame.kind
  }
}

export function isMutatingFrame(frame: GroupWireRequest): boolean {
  return frame.kind !== 'group.list' && frame.kind !== 'message.page' && frame.kind !== 'issue.query' && frame.kind !== 'action.list'
}

/** Critical actions need a target and a confirmation before they leave the UI. */
export function needsConfirmation(frame: GroupWireRequest): boolean {
  return frame.kind === 'issue.close' || frame.kind === 'issue.reopen' || frame.kind === 'action.refuse' || frame.kind === 'group.leave'
}

/**
 * Group actors: every projected agent except the Console control owner. A single actor
 * is selected automatically; several actors need an explicit visible choice, and no
 * actor means the UI must not send anything.
 */
export function groupActors(agentIds: readonly string[]): readonly string[] {
  return agentIds.filter(agentId => agentId !== 'control')
}

export function defaultActor(candidates: readonly string[], selectedAgentId: string | undefined): string | undefined {
  const actors = groupActors(candidates)
  if (actors.length === 0) return undefined
  if (selectedAgentId !== undefined && actors.includes(selectedAgentId)) return selectedAgentId
  return actors.length === 1 ? actors[0] : undefined
}

/**
 * The access state the view may claim. No eligible actor is a typed not-configured
 * condition of this Console, not a reachability failure of the group endpoint.
 */
export function effectiveAccess(state: GroupWorkspaceState): 'ready' | 'not-configured' | 'unreachable' {
  if (state.actors.length === 0) return 'not-configured'
  return state.access.kind
}
