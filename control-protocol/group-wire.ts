import type { JsonValue, ServiceError } from './agent-services.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'
import { RelayProtocolError } from './relay-codec.ts'

/**
 * Closed types and codecs for the group messaging wire.
 *
 * The module owns frame shape only. It holds no state, grants no permission and
 * never infers an action target from the message body. The runtime binds the
 * authenticated peer and checks authority at the owning module.
 */

export type AgentRole = 'master' | 'peer'
export type IssueState = 'open' | 'closed'
export type ActionKind = 'reply' | 'review' | 'comment' | 'audit' | 'followup'
export type ActionState =
  | 'pending' | 'accepted' | 'in_progress' | 'cancel_requested'
  | 'blocked' | 'failed' | 'completed' | 'refused' | 'cancelled' | 'unknown'
export type ExternalOpKind = 'issue.create' | 'issue.reference' | 'issue.close' | 'issue.reopen' | 'issue.query' | 'action.result'
export type ExternalOpState = 'pending' | 'inflight' | 'confirmed' | 'failed' | 'unknown'
export type InvitationState = 'pending' | 'accepted' | 'declined' | 'revoked'

/** One contiguous membership period. Rejoining opens a new interval. */
export interface MemberInterval {
  readonly joinedAt: string
  readonly leftAt?: string
}

export interface GroupMember {
  readonly agentId: string
  readonly role: AgentRole
  /** Peers this member commands. Directional: one edge serves both assign and request. */
  readonly mastersOf: readonly string[]
  readonly intervals: readonly MemberInterval[]
}

export interface Group {
  readonly groupId: string
  readonly name: string
  readonly ownerAgentId: string
  readonly createdAt: string
  readonly members: readonly GroupMember[]
}

export interface GroupInvitation {
  readonly groupId: string
  readonly agentId: string
  readonly role: AgentRole
  readonly mastersOf: readonly string[]
  readonly invitedByAgentId: string
  readonly state: InvitationState
  readonly createdAt: string
}

/** One Vikunja issue bound to exactly one session. Vikunja owns the open/closed state. */
export interface IssueSession {
  readonly sessionId: string
  readonly groupId: string
  readonly vikunjaProjectId: string
  readonly vikunjaIssueId: string
  readonly initiatorAgentId: string
  readonly state: IssueState
  readonly openedAt: string
  readonly closedAt?: string
  /** Monotonic open/close operation ordinal; decides recovery order. */
  readonly lastOpSeq: number
}

export interface Action {
  readonly actionId: string
  readonly commitId: string
  readonly sessionId: string
  readonly initiatorAgentId: string
  /** Only responsibility source. Execution needs this agent, not replyRequired. */
  readonly assigneeAgentId: string
  readonly kind: ActionKind
  readonly reason: string
  readonly expectedResult: string
  readonly replyRequired: boolean
  readonly replyRequiredReason?: string
  readonly inReplyToActionId?: string
  readonly state: ActionState
  readonly resultCommitId?: string
  readonly resultRef?: string
  readonly executionStopped?: boolean
  readonly createdAt: string
  readonly completedAt?: string
}

export interface Message {
  readonly messageId: string
  readonly commitId: string
  readonly sequence: number
  readonly groupId: string
  readonly sessionId?: string
  readonly actionId?: string
  readonly fromAgentId: string
  readonly targetAgentIds: readonly string[]
  readonly replyRequired: boolean
  readonly replyRequiredReason?: string
  readonly body: string
  readonly sentAt: string
  readonly inReplyToMessageId?: string
}

export interface MessageWatermark {
  readonly agentId: string
  readonly groupId: string
  readonly upToSequence: number
  readonly updatedAt: string
}

export interface ExternalOp {
  readonly opId: string
  readonly commitId: string
  readonly kind: ExternalOpKind
  readonly state: ExternalOpState
  readonly ownerAgentId: string
  /** Open/close ordinal, present for issue.close and issue.reopen. */
  readonly opSeq?: number
  readonly params: JsonValue
  readonly result?: JsonValue
  readonly error?: ServiceError
  readonly updatedAt: string
}

export type GroupWireRequest =
  | { readonly kind: 'group.create'; readonly requestId: string; readonly name: string }
  | { readonly kind: 'group.invite'; readonly requestId: string; readonly groupId: string; readonly agentId: string; readonly role: AgentRole; readonly mastersOf?: readonly string[] }
  | { readonly kind: 'group.respond'; readonly requestId: string; readonly groupId: string; readonly accept: boolean }
  | { readonly kind: 'group.leave'; readonly requestId: string; readonly groupId: string }
  | { readonly kind: 'group.list'; readonly requestId: string }
  | { readonly kind: 'message.send'; readonly requestId: string; readonly commitId: string; readonly groupId: string; readonly sessionId?: string; readonly actionId?: string; readonly targetAgentIds: readonly string[]; readonly replyRequired: boolean; readonly replyRequiredReason?: string; readonly body: string; readonly inReplyToMessageId?: string }
  | { readonly kind: 'message.ack'; readonly requestId: string; readonly groupId: string; readonly upToSequence: number }
  | { readonly kind: 'message.page'; readonly requestId: string; readonly groupId: string; readonly cursor?: number }
  | { readonly kind: 'issue.create'; readonly requestId: string; readonly commitId: string; readonly groupId: string; readonly vikunjaProjectId: string; readonly title: string; readonly body: string }
  | { readonly kind: 'issue.reference'; readonly requestId: string; readonly commitId: string; readonly groupId: string; readonly vikunjaIssueId: string }
  | { readonly kind: 'issue.query'; readonly requestId: string; readonly sessionId: string }
  | { readonly kind: 'issue.close'; readonly requestId: string; readonly commitId: string; readonly sessionId: string; readonly reason: string; readonly conclusion: string; readonly evidence?: JsonValue }
  | { readonly kind: 'issue.reopen'; readonly requestId: string; readonly commitId: string; readonly sessionId: string; readonly reason: string; readonly remainingActions?: readonly string[] }
  | { readonly kind: 'action.create'; readonly requestId: string; readonly commitId: string; readonly sessionId: string; readonly assigneeAgentId: string; readonly actionKind: ActionKind; readonly reason: string; readonly expectedResult: string; readonly replyRequired: boolean; readonly replyRequiredReason?: string; readonly inReplyToActionId?: string }
  | { readonly kind: 'action.submit'; readonly requestId: string; readonly resultCommitId: string; readonly actionId: string; readonly resultBody: string; readonly evidence?: JsonValue }
  | { readonly kind: 'action.report'; readonly requestId: string; readonly actionId: string; readonly report: 'blocked' | 'failed'; readonly reason: string; readonly evidence?: JsonValue }
  | { readonly kind: 'action.refuse'; readonly requestId: string; readonly actionId: string; readonly reason: string }
  | { readonly kind: 'action.list'; readonly requestId: string; readonly sessionId?: string }

export type IssueCloseOutcome = 'closed' | 'conflict' | 'failed' | 'unknown'
export type IssueReopenOutcome = 'reopened' | 'conflict' | 'failed' | 'unknown'

export type GroupWireReply =
  | { readonly kind: 'group.created'; readonly requestId: string; readonly group: Group }
  | { readonly kind: 'group.invited'; readonly requestId: string; readonly invitation: GroupInvitation }
  | { readonly kind: 'group.member'; readonly requestId: string; readonly group: Group }
  | { readonly kind: 'group.changed'; readonly group: Group }
  | { readonly kind: 'group.list'; readonly requestId: string; readonly groups: readonly Group[] }
  | { readonly kind: 'message.sent'; readonly requestId: string; readonly messageId: string; readonly sequence: number }
  | { readonly kind: 'message.received'; readonly groupId: string; readonly message: Message }
  | { readonly kind: 'message.acked'; readonly requestId: string; readonly groupId: string; readonly upToSequence: number }
  | { readonly kind: 'message.page'; readonly requestId: string; readonly messages: readonly Message[]; readonly revision: number; readonly hasMore: boolean; readonly gapBeforeSequence?: number }
  | { readonly kind: 'issue.changed'; readonly sessionId: string; readonly state: IssueState }
  | { readonly kind: 'issue.session'; readonly requestId: string; readonly session: IssueSession }
  | { readonly kind: 'issue.closed'; readonly requestId: string; readonly session: IssueSession; readonly outcome: IssueCloseOutcome }
  | { readonly kind: 'issue.reopened'; readonly requestId: string; readonly session: IssueSession; readonly outcome: IssueReopenOutcome }
  | { readonly kind: 'action.created'; readonly requestId: string; readonly action: Action }
  | { readonly kind: 'action.updated'; readonly requestId: string; readonly action: Action }
  | { readonly kind: 'action.changed'; readonly action: Action }
  | { readonly kind: 'action.list'; readonly requestId: string; readonly actions: readonly Action[] }
  | { readonly kind: 'op.execute'; readonly opId: string; readonly opKind: ExternalOpKind; readonly params: JsonValue }
  | { readonly kind: 'relay.error'; readonly requestId?: string; readonly error: ServiceError }

export type ExternalOpReply =
  | { readonly kind: 'op.confirmed'; readonly opId: string; readonly commitId: string; readonly result: JsonValue }
  | { readonly kind: 'op.failed'; readonly opId: string; readonly commitId: string; readonly error: ServiceError }
  | { readonly kind: 'op.unknown'; readonly opId: string; readonly commitId: string; readonly reason: string }

const roles: readonly AgentRole[] = ['master', 'peer']
const issueStates: readonly IssueState[] = ['open', 'closed']
const actionKinds: readonly ActionKind[] = ['reply', 'review', 'comment', 'audit', 'followup']
const actionStates: readonly ActionState[] = [
  'pending', 'accepted', 'in_progress', 'cancel_requested',
  'blocked', 'failed', 'completed', 'refused', 'cancelled', 'unknown',
]
const externalOpKinds: readonly ExternalOpKind[] = ['issue.create', 'issue.reference', 'issue.close', 'issue.reopen', 'issue.query', 'action.result']
const externalOpStates: readonly ExternalOpState[] = ['pending', 'inflight', 'confirmed', 'failed', 'unknown']
const invitationStates: readonly InvitationState[] = ['pending', 'accepted', 'declined', 'revoked']
const closeOutcomes: readonly IssueCloseOutcome[] = ['closed', 'conflict', 'failed', 'unknown']
const reopenOutcomes: readonly IssueReopenOutcome[] = ['reopened', 'conflict', 'failed', 'unknown']

function fail(message: string): never {
  throw new RelayProtocolError('INVALID_INPUT', message)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)
  return value
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return text(value, path)
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`)
  return value
}

function ordinal(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${path} must be a non-negative safe integer`)
  return value as number
}

function positiveOrdinal(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${path} must be a positive safe integer`)
  return value as number
}

function pick<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`${path} is not a supported value`)
  return value as T
}

function texts(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  const result = value.map((item, index) => text(item, `${path}[${index}]`))
  if (new Set(result).size !== result.length) fail(`${path} must not repeat an id`)
  return result
}

function optionalJson(value: unknown, path: string): JsonValue | undefined {
  if (value === undefined) return undefined
  assertJsonValue(value, path)
  return value
}

export function parseGroupAction(value: unknown): Action {
  const input = record(value, 'Action')
  const state = pick(input.state, actionStates, 'Action state')
  return {
    actionId: text(input.actionId, 'Action id'),
    commitId: text(input.commitId, 'Action commitId'),
    sessionId: text(input.sessionId, 'Action sessionId'),
    initiatorAgentId: text(input.initiatorAgentId, 'Action initiator'),
    assigneeAgentId: text(input.assigneeAgentId, 'Action assignee'),
    kind: pick(input.kind, actionKinds, 'Action kind'),
    reason: text(input.reason, 'Action reason'),
    expectedResult: text(input.expectedResult, 'Action expectedResult'),
    replyRequired: flag(input.replyRequired, 'Action replyRequired'),
    ...(optionalText(input.replyRequiredReason, 'Action replyRequiredReason') === undefined ? {} : { replyRequiredReason: text(input.replyRequiredReason, 'Action replyRequiredReason') }),
    ...(optionalText(input.inReplyToActionId, 'Action inReplyToActionId') === undefined ? {} : { inReplyToActionId: text(input.inReplyToActionId, 'Action inReplyToActionId') }),
    state,
    ...(optionalText(input.resultCommitId, 'Action resultCommitId') === undefined ? {} : { resultCommitId: text(input.resultCommitId, 'Action resultCommitId') }),
    ...(optionalText(input.resultRef, 'Action resultRef') === undefined ? {} : { resultRef: text(input.resultRef, 'Action resultRef') }),
    ...(input.executionStopped === undefined ? {} : { executionStopped: flag(input.executionStopped, 'Action executionStopped') }),
    createdAt: text(input.createdAt, 'Action createdAt'),
    ...(optionalText(input.completedAt, 'Action completedAt') === undefined ? {} : { completedAt: text(input.completedAt, 'Action completedAt') }),
  }
}

export function parseGroupMessage(value: unknown): Message {
  const input = record(value, 'Message')
  return {
    messageId: text(input.messageId, 'Message id'),
    commitId: text(input.commitId, 'Message commitId'),
    sequence: positiveOrdinal(input.sequence, 'Message sequence'),
    groupId: text(input.groupId, 'Message groupId'),
    ...(optionalText(input.sessionId, 'Message sessionId') === undefined ? {} : { sessionId: text(input.sessionId, 'Message sessionId') }),
    ...(optionalText(input.actionId, 'Message actionId') === undefined ? {} : { actionId: text(input.actionId, 'Message actionId') }),
    fromAgentId: text(input.fromAgentId, 'Message author'),
    targetAgentIds: texts(input.targetAgentIds, 'Message targets'),
    replyRequired: flag(input.replyRequired, 'Message replyRequired'),
    ...(optionalText(input.replyRequiredReason, 'Message replyRequiredReason') === undefined ? {} : { replyRequiredReason: text(input.replyRequiredReason, 'Message replyRequiredReason') }),
    body: text(input.body, 'Message body'),
    sentAt: text(input.sentAt, 'Message sentAt'),
    ...(optionalText(input.inReplyToMessageId, 'Message inReplyToMessageId') === undefined ? {} : { inReplyToMessageId: text(input.inReplyToMessageId, 'Message inReplyToMessageId') }),
  }
}

export function parseGroup(value: unknown): Group {
  const input = record(value, 'Group')
  if (!Array.isArray(input.members)) fail('Group members must be an array')
  const members = input.members.map((member, index) => {
    const item = record(member, `Group member ${index}`)
    if (!Array.isArray(item.intervals) || item.intervals.length === 0) fail('Group member intervals must be a non-empty array')
    return {
      agentId: text(item.agentId, 'Group member id'),
      role: pick(item.role, roles, 'Group member role'),
      mastersOf: texts(item.mastersOf, 'Group member mastersOf'),
      intervals: item.intervals.map((interval, intervalIndex) => {
        const entry = record(interval, `Group member interval ${intervalIndex}`)
        return {
          joinedAt: text(entry.joinedAt, 'Member interval joinedAt'),
          ...(optionalText(entry.leftAt, 'Member interval leftAt') === undefined ? {} : { leftAt: text(entry.leftAt, 'Member interval leftAt') }),
        }
      }),
    }
  })
  return {
    groupId: text(input.groupId, 'Group id'),
    name: text(input.name, 'Group name'),
    ownerAgentId: text(input.ownerAgentId, 'Group owner'),
    createdAt: text(input.createdAt, 'Group createdAt'),
    members,
  }
}

function parseIssueSession(value: unknown): IssueSession {
  const input = record(value, 'IssueSession')
  return {
    sessionId: text(input.sessionId, 'Issue session id'),
    groupId: text(input.groupId, 'Issue session groupId'),
    vikunjaProjectId: text(input.vikunjaProjectId, 'Issue session projectId'),
    vikunjaIssueId: text(input.vikunjaIssueId, 'Issue session issueId'),
    initiatorAgentId: text(input.initiatorAgentId, 'Issue session initiator'),
    state: pick(input.state, issueStates, 'Issue session state'),
    openedAt: text(input.openedAt, 'Issue session openedAt'),
    ...(optionalText(input.closedAt, 'Issue session closedAt') === undefined ? {} : { closedAt: text(input.closedAt, 'Issue session closedAt') }),
    lastOpSeq: ordinal(input.lastOpSeq, 'Issue session lastOpSeq'),
  }
}

const serviceErrorCodes: readonly ServiceError['code'][] = [
  'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATION', 'STALE_GENERATION', 'REVISION_CONFLICT', 'RESOURCE_EXHAUSTED',
  'CONFLICT', 'RESULT_UNKNOWN', 'UNAVAILABLE', 'UPSTREAM_ERROR',
]

function parseServiceErrorReply(value: unknown): ServiceError {
  const input = record(value, 'Service error')
  return {
    code: pick(input.code, serviceErrorCodes, 'Service error code'),
    message: text(input.message, 'Service error message'),
  }
}

export function parseGroupWireRequest(textValue: string): GroupWireRequest {
  const parsed: unknown = JSON.parse(textValue)
  const frame = record(parsed, 'Group request')
  const kind = text(frame.kind, 'Group request kind')
  const requestId = text(frame.requestId, 'Group request requestId')
  const keys = (...extra: string[]) => ['kind', 'requestId', ...extra]
  switch (kind) {
    case 'group.create': {
      assertEnvelopeKeys(frame, keys('name'), 'Group create request')
      return { kind, requestId, name: text(frame.name, 'Group name') }
    }
    case 'group.invite': {
      assertEnvelopeKeys(frame, keys('groupId', 'agentId', 'role', 'mastersOf'), 'Group invite request')
      return {
        kind, requestId,
        groupId: text(frame.groupId, 'Group id'),
        agentId: text(frame.agentId, 'Invitee id'),
        role: pick(frame.role, roles, 'Invite role'),
        ...(frame.mastersOf === undefined ? {} : { mastersOf: texts(frame.mastersOf, 'Invite mastersOf') }),
      }
    }
    case 'group.respond': {
      assertEnvelopeKeys(frame, keys('groupId', 'accept'), 'Group respond request')
      return { kind, requestId, groupId: text(frame.groupId, 'Group id'), accept: flag(frame.accept, 'Group respond accept') }
    }
    case 'group.leave': {
      assertEnvelopeKeys(frame, keys('groupId'), 'Group leave request')
      return { kind, requestId, groupId: text(frame.groupId, 'Group id') }
    }
    case 'group.list': {
      assertEnvelopeKeys(frame, keys(), 'Group list request')
      return { kind, requestId }
    }
    case 'message.send': {
      assertEnvelopeKeys(frame, keys('commitId', 'groupId', 'sessionId', 'actionId', 'targetAgentIds', 'replyRequired', 'replyRequiredReason', 'body', 'inReplyToMessageId'), 'Message send request')
      return {
        kind, requestId,
        commitId: text(frame.commitId, 'Message commitId'),
        groupId: text(frame.groupId, 'Message groupId'),
        ...(frame.sessionId === undefined ? {} : { sessionId: text(frame.sessionId, 'Message sessionId') }),
        ...(frame.actionId === undefined ? {} : { actionId: text(frame.actionId, 'Message actionId') }),
        targetAgentIds: texts(frame.targetAgentIds, 'Message targets'),
        replyRequired: flag(frame.replyRequired, 'Message replyRequired'),
        ...(frame.replyRequiredReason === undefined ? {} : { replyRequiredReason: text(frame.replyRequiredReason, 'Message replyRequiredReason') }),
        body: text(frame.body, 'Message body'),
        ...(frame.inReplyToMessageId === undefined ? {} : { inReplyToMessageId: text(frame.inReplyToMessageId, 'Message inReplyToMessageId') }),
      }
    }
    case 'message.ack': {
      assertEnvelopeKeys(frame, keys('groupId', 'upToSequence'), 'Message ack request')
      return { kind, requestId, groupId: text(frame.groupId, 'Group id'), upToSequence: positiveOrdinal(frame.upToSequence, 'Ack sequence') }
    }
    case 'message.page': {
      assertEnvelopeKeys(frame, keys('groupId', 'cursor'), 'Message page request')
      return {
        kind, requestId, groupId: text(frame.groupId, 'Group id'),
        ...(frame.cursor === undefined ? {} : { cursor: ordinal(frame.cursor, 'Page cursor') }),
      }
    }
    case 'issue.create': {
      assertEnvelopeKeys(frame, keys('commitId', 'groupId', 'vikunjaProjectId', 'title', 'body'), 'Issue create request')
      return {
        kind, requestId,
        commitId: text(frame.commitId, 'Issue commitId'),
        groupId: text(frame.groupId, 'Group id'),
        vikunjaProjectId: text(frame.vikunjaProjectId, 'Vikunja project id'),
        title: text(frame.title, 'Issue title'),
        body: text(frame.body, 'Issue body'),
      }
    }
    case 'issue.reference': {
      assertEnvelopeKeys(frame, keys('commitId', 'groupId', 'vikunjaIssueId'), 'Issue reference request')
      return {
        kind, requestId,
        commitId: text(frame.commitId, 'Issue commitId'),
        groupId: text(frame.groupId, 'Group id'),
        vikunjaIssueId: text(frame.vikunjaIssueId, 'Vikunja issue id'),
      }
    }
    case 'issue.query': {
      assertEnvelopeKeys(frame, keys('sessionId'), 'Issue query request')
      return { kind, requestId, sessionId: text(frame.sessionId, 'Session id') }
    }
    case 'issue.close': {
      assertEnvelopeKeys(frame, keys('commitId', 'sessionId', 'reason', 'conclusion', 'evidence'), 'Issue close request')
      return {
        kind, requestId,
        commitId: text(frame.commitId, 'Close commitId'),
        sessionId: text(frame.sessionId, 'Session id'),
        reason: text(frame.reason, 'Close reason'),
        conclusion: text(frame.conclusion, 'Close conclusion'),
        ...(frame.evidence === undefined ? {} : { evidence: optionalJson(frame.evidence, 'Close evidence') }),
      }
    }
    case 'issue.reopen': {
      assertEnvelopeKeys(frame, keys('commitId', 'sessionId', 'reason', 'remainingActions'), 'Issue reopen request')
      return {
        kind, requestId,
        commitId: text(frame.commitId, 'Reopen commitId'),
        sessionId: text(frame.sessionId, 'Session id'),
        reason: text(frame.reason, 'Reopen reason'),
        ...(frame.remainingActions === undefined ? {} : { remainingActions: texts(frame.remainingActions, 'Reopen remainingActions') }),
      }
    }
    case 'action.create': {
      assertEnvelopeKeys(frame, keys('commitId', 'sessionId', 'assigneeAgentId', 'actionKind', 'reason', 'expectedResult', 'replyRequired', 'replyRequiredReason', 'inReplyToActionId'), 'Action create request')
      return {
        kind, requestId,
        commitId: text(frame.commitId, 'Action commitId'),
        sessionId: text(frame.sessionId, 'Action sessionId'),
        assigneeAgentId: text(frame.assigneeAgentId, 'Action assignee'),
        actionKind: pick(frame.actionKind, actionKinds, 'Action kind'),
        reason: text(frame.reason, 'Action reason'),
        expectedResult: text(frame.expectedResult, 'Action expectedResult'),
        replyRequired: flag(frame.replyRequired, 'Action replyRequired'),
        ...(frame.replyRequiredReason === undefined ? {} : { replyRequiredReason: text(frame.replyRequiredReason, 'Action replyRequiredReason') }),
        ...(frame.inReplyToActionId === undefined ? {} : { inReplyToActionId: text(frame.inReplyToActionId, 'Action inReplyToActionId') }),
      }
    }
    case 'action.submit': {
      assertEnvelopeKeys(frame, keys('resultCommitId', 'actionId', 'resultBody', 'evidence'), 'Action submit request')
      return {
        kind, requestId,
        resultCommitId: text(frame.resultCommitId, 'Result commitId'),
        actionId: text(frame.actionId, 'Action id'),
        resultBody: text(frame.resultBody, 'Result body'),
        ...(frame.evidence === undefined ? {} : { evidence: optionalJson(frame.evidence, 'Result evidence') }),
      }
    }
    case 'action.report': {
      assertEnvelopeKeys(frame, keys('actionId', 'report', 'reason', 'evidence'), 'Action report request')
      const report = frame.report
      if (report !== 'blocked' && report !== 'failed') fail('Action report kind is invalid')
      return {
        kind, requestId,
        actionId: text(frame.actionId, 'Action id'),
        report,
        reason: text(frame.reason, 'Report reason'),
        ...(frame.evidence === undefined ? {} : { evidence: optionalJson(frame.evidence, 'Report evidence') }),
      }
    }
    case 'action.refuse': {
      assertEnvelopeKeys(frame, keys('actionId', 'reason'), 'Action refuse request')
      return { kind, requestId, actionId: text(frame.actionId, 'Action id'), reason: text(frame.reason, 'Refuse reason') }
    }
    case 'action.list': {
      assertEnvelopeKeys(frame, keys('sessionId'), 'Action list request')
      return { kind, requestId, ...(frame.sessionId === undefined ? {} : { sessionId: text(frame.sessionId, 'Session id') }) }
    }
    default: fail(`Unknown group request ${kind}`)
  }
}

export function parseGroupWireReply(textValue: string): GroupWireReply {
  const parsed: unknown = JSON.parse(textValue)
  const frame = record(parsed, 'Group reply')
  const kind = text(frame.kind, 'Group reply kind')
  switch (kind) {
    case 'group.created':
    case 'group.member':
    case 'group.changed': {
      const needsRequest = kind !== 'group.changed'
      assertEnvelopeKeys(frame, needsRequest ? ['kind', 'requestId', 'group'] : ['kind', 'group'], 'Group reply')
      const group = parseGroup(frame.group)
      return needsRequest
        ? { kind, requestId: text(frame.requestId, 'Group reply requestId'), group }
        : { kind, group }
    }
    case 'group.invited': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'invitation'], 'Group invited reply')
      const invitation = record(frame.invitation, 'Group invitation')
      return {
        kind, requestId: text(frame.requestId, 'Group reply requestId'),
        invitation: {
          groupId: text(invitation.groupId, 'Invitation groupId'),
          agentId: text(invitation.agentId, 'Invitation agentId'),
          role: pick(invitation.role, roles, 'Invitation role'),
          mastersOf: texts(invitation.mastersOf, 'Invitation mastersOf'),
          invitedByAgentId: text(invitation.invitedByAgentId, 'Invitation inviter'),
          state: pick(invitation.state, invitationStates, 'Invitation state'),
          createdAt: text(invitation.createdAt, 'Invitation createdAt'),
        },
      }
    }
    case 'group.list': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'groups'], 'Group list reply')
      if (!Array.isArray(frame.groups)) fail('Group list reply groups must be an array')
      return { kind, requestId: text(frame.requestId, 'Group list requestId'), groups: frame.groups.map(parseGroup) }
    }
    case 'message.sent': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'messageId', 'sequence'], 'Message sent reply')
      return {
        kind, requestId: text(frame.requestId, 'Message sent requestId'),
        messageId: text(frame.messageId, 'Message id'),
        sequence: positiveOrdinal(frame.sequence, 'Message sequence'),
      }
    }
    case 'message.received': {
      assertEnvelopeKeys(frame, ['kind', 'groupId', 'message'], 'Message received reply')
      return { kind, groupId: text(frame.groupId, 'Message groupId'), message: parseGroupMessage(frame.message) }
    }
    case 'message.acked': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'groupId', 'upToSequence'], 'Message acked reply')
      return {
        kind, requestId: text(frame.requestId, 'Message acked requestId'),
        groupId: text(frame.groupId, 'Message acked groupId'),
        upToSequence: positiveOrdinal(frame.upToSequence, 'Message acked upToSequence'),
      }
    }
    case 'message.page': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'messages', 'revision', 'hasMore', 'gapBeforeSequence'], 'Message page reply')
      if (!Array.isArray(frame.messages)) fail('Message page messages must be an array')
      return {
        kind, requestId: text(frame.requestId, 'Message page requestId'),
        messages: frame.messages.map(parseGroupMessage),
        revision: positiveOrdinal(frame.revision, 'Message page revision'),
        hasMore: flag(frame.hasMore, 'Message page hasMore'),
        ...(frame.gapBeforeSequence === undefined ? {} : { gapBeforeSequence: positiveOrdinal(frame.gapBeforeSequence, 'Gap sequence') }),
      }
    }
    case 'issue.changed': {
      assertEnvelopeKeys(frame, ['kind', 'sessionId', 'state'], 'Issue changed reply')
      return { kind, sessionId: text(frame.sessionId, 'Issue session id'), state: pick(frame.state, issueStates, 'Issue state') }
    }
    case 'issue.session': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'session'], 'Issue session reply')
      return { kind, requestId: text(frame.requestId, 'Issue session requestId'), session: parseIssueSession(frame.session) }
    }
    case 'issue.closed': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'session', 'outcome'], 'Issue closed reply')
      return {
        kind, requestId: text(frame.requestId, 'Issue closed requestId'),
        session: parseIssueSession(frame.session),
        outcome: pick(frame.outcome, closeOutcomes, 'Issue close outcome'),
      }
    }
    case 'issue.reopened': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'session', 'outcome'], 'Issue reopened reply')
      return {
        kind, requestId: text(frame.requestId, 'Issue reopened requestId'),
        session: parseIssueSession(frame.session),
        outcome: pick(frame.outcome, reopenOutcomes, 'Issue reopen outcome'),
      }
    }
    case 'action.updated': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'action'], 'Action updated reply')
      return { kind, requestId: text(frame.requestId, 'Action updated requestId'), action: parseGroupAction(frame.action) }
    }
    case 'action.created': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'action'], 'Action created reply')
      return { kind, requestId: text(frame.requestId, 'Action created requestId'), action: parseGroupAction(frame.action) }
    }
    case 'action.changed': {
      assertEnvelopeKeys(frame, ['kind', 'action'], 'Action changed reply')
      return { kind, action: parseGroupAction(frame.action) }
    }
    case 'action.list': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'actions'], 'Action list reply')
      if (!Array.isArray(frame.actions)) fail('Action list reply actions must be an array')
      return { kind, requestId: text(frame.requestId, 'Action list requestId'), actions: frame.actions.map(parseGroupAction) }
    }
    case 'op.execute': {
      assertEnvelopeKeys(frame, ['kind', 'opId', 'opKind', 'params'], 'Op execute reply')
      assertJsonValue(frame.params, 'Op params')
      return {
        kind,
        opId: text(frame.opId, 'Op id'),
        opKind: pick(frame.opKind, externalOpKinds, 'Op kind'),
        params: frame.params,
      }
    }
    case 'relay.error': {
      assertEnvelopeKeys(frame, ['kind', 'requestId', 'error'], 'Relay error reply')
      return {
        kind,
        ...(frame.requestId === undefined ? {} : { requestId: text(frame.requestId, 'Relay error requestId') }),
        error: parseServiceErrorReply(frame.error),
      }
    }
    default: fail(`Unknown group reply ${kind}`)
  }
}

/** External operation receipt returned by the daemon that executed the op. */
export function parseExternalOpReply(textValue: string): ExternalOpReply {
  const parsed: unknown = JSON.parse(textValue)
  const frame = record(parsed, 'External op reply')
  const kind = text(frame.kind, 'External op reply kind')
  switch (kind) {
    case 'op.confirmed': {
      assertEnvelopeKeys(frame, ['kind', 'opId', 'commitId', 'result'], 'Op confirmed reply')
      assertJsonValue(frame.result, 'Op confirmed result')
      return { kind, opId: text(frame.opId, 'Op id'), commitId: text(frame.commitId, 'Op commitId'), result: frame.result }
    }
    case 'op.failed': {
      assertEnvelopeKeys(frame, ['kind', 'opId', 'commitId', 'error'], 'Op failed reply')
      return { kind, opId: text(frame.opId, 'Op id'), commitId: text(frame.commitId, 'Op commitId'), error: parseServiceErrorReply(frame.error) }
    }
    case 'op.unknown': {
      assertEnvelopeKeys(frame, ['kind', 'opId', 'commitId', 'reason'], 'Op unknown reply')
      return { kind, opId: text(frame.opId, 'Op id'), commitId: text(frame.commitId, 'Op commitId'), reason: text(frame.reason, 'Op unknown reason') }
    }
    default: fail(`Unknown external op reply ${kind}`)
  }
}

export function isTerminalActionState(state: ActionState): boolean {
  return state === 'completed' || state === 'refused' || state === 'cancelled'
}

export function isPendingExecution(state: ActionState): boolean {
  return state === 'pending' || state === 'accepted'
}

export interface ActionTransition {
  readonly from: ActionState
  readonly to: ActionState
}

const transitions: readonly ActionTransition[] = [
  { from: 'pending', to: 'accepted' },
  { from: 'pending', to: 'refused' },
  { from: 'pending', to: 'cancelled' },
  { from: 'pending', to: 'in_progress' },
  { from: 'accepted', to: 'in_progress' },
  { from: 'accepted', to: 'cancel_requested' },
  { from: 'in_progress', to: 'completed' },
  { from: 'in_progress', to: 'blocked' },
  { from: 'in_progress', to: 'failed' },
  { from: 'in_progress', to: 'cancel_requested' },
  { from: 'in_progress', to: 'unknown' },
  { from: 'cancel_requested', to: 'cancelled' },
  { from: 'cancel_requested', to: 'unknown' },
  { from: 'cancel_requested', to: 'completed' },
  { from: 'cancel_requested', to: 'failed' },
  { from: 'unknown', to: 'completed' },
  { from: 'unknown', to: 'failed' },
]

/** Transition table owner. A refused, blocked or failed action needs a new action, not a revive. */
export function canTransitionAction(from: ActionState, to: ActionState): boolean {
  return transitions.some(entry => entry.from === from && entry.to === to)
}

/** Reply-required never gates execution; it only decides whether the initiator expects an answer. */
export function actionNeedsExecutionFor(action: Action, agentId: string): boolean {
  // Only work that has not run yet may start. A failed, blocked, unknown or
  // cancel_requested action needs a read-back or a new action, never a re-run.
  return action.assigneeAgentId === agentId && isPendingExecution(action.state)
}
