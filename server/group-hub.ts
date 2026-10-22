import type { JsonValue, ServiceError } from '../control-protocol/agent-services.ts'
import type { Action, ExternalOp, Group, GroupInvitation, IssueSession, IssueState } from '../control-protocol/group-wire.ts'
import type { ExternalOpReceipt } from './group-external-ops.ts'
import type { GroupHub, GroupHubResult, GroupHubPush } from './relay.ts'
import { advanceWatermark, appendMessage, createMessageLog, pageMessages, type MessageLogState } from './message-log.ts'
import {
  activeMemberIds,
  canCloseIssue,
  canManageGroup,
  createGroupRegistry,
  groupOf,
  inviteMember,
  leaveGroup,
  listGroups,
  memberActiveAt,
  respondToInvitation,
  type GroupRegistryState,
} from './group-registry.ts'
import {
  closeIssueSession,
  confirmIssueOperation,
  createIssueSessionRegistry,
  openIssueSession,
  reopenIssueSession,
  sessionOfIssue,
  type IssueSessionRegistry,
} from './issue-session.ts'
import {
  actionOf,
  createAction,
  createActionRegistry,
  listActions,
  refuseAction,
  reportAction,
  submitActionResult,
  type ActionRegistryState,
} from './action-registry.ts'
import { routeGroupMessage } from './message-router.ts'
import {
  authenticateExternalOpReceipt,
  beginExternalOp,
  createExternalOpLedger,
  markExternalOpInflight,
  type ExternalOpLedger,
} from './group-external-ops.ts'

/**
 * The group hub owns group semantics behind the relay transport.
 *
 * The relay owns sockets and envelopes; the hub owns the truth modules, the
 * stable ids, the external op ledger and the persistence snapshot. Every
 * mutation is idempotent by commit id and reports an explicit outcome. An
 * external write that cannot be confirmed is reported unknown, never success.
 */

export interface GroupHubSnapshot {
  readonly groups: readonly Group[]
  readonly invitations: readonly GroupInvitation[]
  readonly sessions: readonly IssueSession[]
  readonly actions: readonly Action[]
  readonly logs: readonly MessageLogState[]
  readonly ops: readonly ExternalOp[]
}

export interface GroupHubStore {
  load(): GroupHubSnapshot | undefined
  save(snapshot: GroupHubSnapshot): void
}

export interface GroupHubDeps {
  readonly store?: GroupHubStore
  readonly now?: () => Date
  readonly idFactory?: () => string
  /** Online agents for push selection. The composition layer owns presence. */
  readonly onlineAgentIds?: () => readonly string[]
  /**
   * Delegates one external write to its execution owner and resolves with the
   * owner receipt. A plain ServiceError means the op never left the hub.
   */
  readonly executeExternalOp?: (op: ExternalOp) => Promise<ExternalOpReceipt | ServiceError>
}

type Actor = { readonly agentId: string; readonly accountId: string; readonly scopeId: string }

function ok(reply: unknown, pushes: readonly GroupHubPush[] = []): GroupHubResult {
  return { ok: true, reply, pushes }
}

function err(code: ServiceError['code'], message: string): GroupHubResult {
  return { ok: false, error: { code, message } }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class GroupHubImpl implements GroupHub {
  private registry: GroupRegistryState
  private sessions: IssueSessionRegistry
  private actions: ActionRegistryState
  private logs: ReadonlyMap<string, MessageLogState>
  private ledger: ExternalOpLedger
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly store?: GroupHubStore
  private readonly onlineAgentIds: () => readonly string[]
  private readonly executeExternalOp?: (op: ExternalOp) => Promise<ExternalOpReceipt | ServiceError>

  constructor(deps: GroupHubDeps = {}) {
    this.now = deps.now ?? (() => new Date())
    this.idFactory = deps.idFactory ?? (() => crypto.randomUUID())
    this.store = deps.store
    this.onlineAgentIds = deps.onlineAgentIds ?? (() => [])
    this.executeExternalOp = deps.executeExternalOp
    const snapshot = deps.store?.load()
    this.registry = snapshot
      ? { groups: new Map(snapshot.groups.map((group) => [group.groupId, group])), invitations: [...snapshot.invitations] }
      : createGroupRegistry()
    this.sessions = snapshot
      ? { sessions: new Map(snapshot.sessions.map((session) => [session.sessionId, session])), operations: [] }
      : createIssueSessionRegistry()
    this.actions = snapshot
      ? { actions: new Map(snapshot.actions.map((action) => [action.actionId, action])) }
      : createActionRegistry()
    this.logs = snapshot ? new Map(snapshot.logs.map((log) => [log.groupId, log])) : new Map()
    this.ledger = snapshot ? { operations: new Map(snapshot.ops.map((op) => [op.opId, op])) } : createExternalOpLedger()
  }

  snapshot(): GroupHubSnapshot {
    return {
      groups: [...this.registry.groups.values()],
      invitations: this.registry.invitations,
      sessions: [...this.sessions.sessions.values()],
      actions: [...this.actions.actions.values()],
      logs: [...this.logs.values()],
      ops: [...this.ledger.operations.values()],
    }
  }

  async handle(actor: Actor, frame: unknown): Promise<GroupHubResult> {
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return err('INVALID_INPUT', 'group frame must be an object')
    const input = frame as Record<string, unknown>
    try {
      switch (input.kind) {
        case 'group.list': return ok({ kind: 'group.list', requestId: text(input.requestId, 'requestId'), groups: listGroups(this.registry, actor.agentId) })
        case 'group.create': return this.createGroup(actor, input)
        case 'group.invite': return this.invite(actor, input)
        case 'group.respond': return this.respond(actor, input)
        case 'group.leave': return this.leave(actor, input)
        case 'message.send': return this.sendMessage(actor, input)
        case 'message.page': return this.page(actor, input)
        case 'message.ack': return this.ack(actor, input)
        case 'issue.create': return await this.createIssue(actor, input)
        case 'issue.reference': return this.referenceIssue(actor, input)
        case 'issue.query': return this.queryIssue(actor, input)
        case 'issue.close': return await this.closeOrReopen(actor, input, 'close')
        case 'issue.reopen': return await this.closeOrReopen(actor, input, 'reopen')
        case 'action.create': return this.createAction(actor, input)
        case 'action.submit': return await this.submitAction(actor, input)
        case 'action.report': return this.reportOrRefuse(actor, input, 'report')
        case 'action.refuse': return this.reportOrRefuse(actor, input, 'refuse')
        case 'action.list': return ok({ kind: 'action.list', requestId: text(input.requestId, 'requestId'), actions: listActions(this.actions, optionalText(input.sessionId)) })
        default: return err('UNSUPPORTED_OPERATION', `unsupported group frame ${String(input.kind)}`)
      }
    } catch (error) {
      return err('INVALID_INPUT', error instanceof Error ? error.message : String(error))
    }
  }

  private save(): void {
    this.store?.save(this.snapshot())
  }

  private logOf(groupId: string): MessageLogState {
    return this.logs.get(groupId) ?? createMessageLog(groupId)
  }

  private setLog(groupId: string, log: MessageLogState): void {
    this.logs = new Map(this.logs).set(groupId, log)
  }

  private createGroup(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const name = text(input.name, 'name')
    const now = this.now().toISOString()
    const groupId = this.idFactory()
    const group: Group = {
      groupId, name, ownerAgentId: actor.agentId, createdAt: now,
      members: [{ agentId: actor.agentId, role: 'master', mastersOf: [], intervals: [{ joinedAt: now }] }],
    }
    this.registry = { groups: new Map(this.registry.groups).set(groupId, group), invitations: this.registry.invitations }
    this.save()
    return ok({ kind: 'group.created', requestId: text(input.requestId, 'requestId'), group })
  }

  private invite(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    const agentId = text(input.agentId, 'agentId')
    const role = input.role === 'master' || input.role === 'peer' ? input.role : undefined
    if (!role) return err('INVALID_INPUT', 'role must be master or peer')
    const group = groupOf(this.registry, groupId)
    if (!canManageGroup(group, actor.agentId)) return err('FORBIDDEN', `${actor.agentId} cannot manage group ${groupId}`)
    this.registry = inviteMember(this.registry, {
      groupId, agentId, role,
      ...(Array.isArray(input.mastersOf) ? { mastersOf: input.mastersOf.filter((id): id is string => typeof id === 'string') } : {}),
      invitedByAgentId: actor.agentId,
    }, this.now().toISOString())
    this.save()
    const invitation = this.registry.invitations[this.registry.invitations.length - 1]
    return ok({ kind: 'group.invited', requestId: text(input.requestId, 'requestId'), invitation }, [
      { agentId, frame: { kind: 'group.invited', requestId: text(input.requestId, 'requestId'), invitation } },
    ])
  }

  private respond(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    if (typeof input.accept !== 'boolean') return err('INVALID_INPUT', 'accept must be a boolean')
    this.registry = respondToInvitation(this.registry, { groupId, agentId: actor.agentId, accept: input.accept }, this.now().toISOString())
    this.save()
    const group = groupOf(this.registry, groupId)
    return ok({ kind: 'group.member', requestId: text(input.requestId, 'requestId'), group }, [
      { agentId: group.ownerAgentId, frame: { kind: 'group.changed', group } },
    ])
  }

  private leave(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    this.registry = leaveGroup(this.registry, { groupId, agentId: actor.agentId }, this.now().toISOString())
    this.save()
    return ok({ kind: 'group.member', requestId: text(input.requestId, 'requestId'), group: groupOf(this.registry, groupId) })
  }

  private sendMessage(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    const commitId = text(input.commitId, 'commitId')
    const body = text(input.body, 'body')
    if (!Array.isArray(input.targetAgentIds) || input.targetAgentIds.some((id) => typeof id !== 'string')) return err('INVALID_INPUT', 'targetAgentIds must be a string array')
    if (typeof input.replyRequired !== 'boolean') return err('INVALID_INPUT', 'replyRequired must be a boolean')
    const now = this.now().toISOString()
    const group = groupOf(this.registry, groupId)
    if (!memberActiveAt(group, actor.agentId, now)) return err('FORBIDDEN', `${actor.agentId} is not an active member of ${groupId}`)
    const actionId = optionalText(input.actionId)
    const action: Action | undefined = actionId === undefined ? undefined : this.actions.actions.get(actionId)
    if (actionId !== undefined && !action) return err('NOT_FOUND', `unknown action ${actionId}`)
    const appended = appendMessage(this.logOf(groupId), {
      commitId, groupId,
      ...(optionalText(input.sessionId) === undefined ? {} : { sessionId: optionalText(input.sessionId) as string }),
      ...(actionId === undefined ? {} : { actionId }),
      fromAgentId: actor.agentId,
      targetAgentIds: input.targetAgentIds as readonly string[],
      replyRequired: input.replyRequired,
      ...(optionalText(input.replyRequiredReason) === undefined ? {} : { replyRequiredReason: optionalText(input.replyRequiredReason) as string }),
      body,
      sentAt: now,
      ...(optionalText(input.inReplyToMessageId) === undefined ? {} : { inReplyToMessageId: optionalText(input.inReplyToMessageId) as string }),
    })
    this.setLog(groupId, appended.state)
    const routed = routeGroupMessage({ group, message: appended.message, ...(action ? { action } : {}), onlineAgentIds: this.onlineAgentIds() })
    this.save()
    const pushes = routed.pushAgentIds.map((agentId) => ({ agentId, frame: { kind: 'message.received', groupId, message: appended.message } }))
    return ok({ kind: 'message.sent', requestId: text(input.requestId, 'requestId'), messageId: appended.message.messageId, sequence: appended.message.sequence }, pushes)
  }

  private page(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    const cursor = typeof input.cursor === 'number' && Number.isSafeInteger(input.cursor) ? input.cursor : undefined
    const page = pageMessages(this.logOf(groupId), cursor === undefined ? {} : { cursor })
    return ok({
      kind: 'message.page', requestId: text(input.requestId, 'requestId'), messages: page.messages,
      revision: page.revision, hasMore: page.hasMore,
      ...(page.gapBeforeSequence === undefined ? {} : { gapBeforeSequence: page.gapBeforeSequence }),
    })
  }

  private ack(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    if (typeof input.upToSequence !== 'number' || !Number.isSafeInteger(input.upToSequence)) return err('INVALID_INPUT', 'upToSequence must be a safe integer')
    this.setLog(groupId, advanceWatermark(this.logOf(groupId), { agentId: actor.agentId, upToSequence: input.upToSequence }, this.now().toISOString()))
    this.save()
    return ok({ kind: 'message.acked', requestId: text(input.requestId, 'requestId'), groupId, upToSequence: input.upToSequence })
  }

  private async createIssue(actor: Actor, input: Record<string, unknown>): Promise<GroupHubResult> {
    const groupId = text(input.groupId, 'groupId')
    const commitId = text(input.commitId, 'commitId')
    const projectId = text(input.vikunjaProjectId, 'vikunjaProjectId')
    const title = text(input.title, 'title')
    const delegated = await this.delegate('issue.create', commitId, actor.agentId, { groupId, commitId, vikunjaProjectId: projectId, title, body: optionalText(input.body) ?? '' })
    if (!delegated.ok) return delegated.result
    const issueId = optionalText((delegated.result as Record<string, unknown> | undefined)?.issueId)
    if (!issueId) return err('UPSTREAM_ERROR', 'issue.create returned no issue id')
    const sessionId = `${groupId}:${projectId}:${issueId}`
    this.sessions = openIssueSession(this.sessions, { sessionId, groupId, vikunjaProjectId: projectId, vikunjaIssueId: issueId, initiatorAgentId: actor.agentId }, this.now().toISOString())
    this.save()
    return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: sessionOfIssue(this.sessions, sessionId) })
  }

  private referenceIssue(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    const commitId = text(input.commitId, 'commitId')
    const issueId = text(input.vikunjaIssueId, 'vikunjaIssueId')
    const sessionId = `${groupId}:referenced:${issueId}`
    this.sessions = openIssueSession(this.sessions, { sessionId, groupId, vikunjaProjectId: 'referenced', vikunjaIssueId: issueId, initiatorAgentId: actor.agentId }, this.now().toISOString())
    this.save()
    return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: sessionOfIssue(this.sessions, sessionId) })
  }

  private queryIssue(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const sessionId = text(input.sessionId, 'sessionId')
    const session = this.sessions.sessions.get(sessionId)
    if (!session) return err('NOT_FOUND', `unknown session ${sessionId}`)
    return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session })
  }

  private async closeOrReopen(actor: Actor, input: Record<string, unknown>, direction: 'close' | 'reopen'): Promise<GroupHubResult> {
    const sessionId = text(input.sessionId, 'sessionId')
    const commitId = text(input.commitId, 'commitId')
    const reason = text(input.reason, 'reason')
    const session = this.sessions.sessions.get(sessionId)
    if (!session) return err('NOT_FOUND', `unknown session ${sessionId}`)
    const delegates = Array.isArray(input.delegates) ? input.delegates.filter((id): id is string => typeof id === 'string') : []
    if (!canCloseIssue(session, actor.agentId, delegates)) return err('FORBIDDEN', `${actor.agentId} cannot ${direction} session ${sessionId}`)
    const now = this.now().toISOString()
    this.sessions = direction === 'close'
      ? closeIssueSession(this.sessions, { sessionId, commitId, reason, conclusion: optionalText(input.conclusion) ?? '' }, now)
      : reopenIssueSession(this.sessions, { sessionId, commitId, reason }, now)
    const operation = this.sessions.operations.find((entry) => entry.commitId === commitId)
    if (!operation) return err('UPSTREAM_ERROR', `missing open/close operation for ${commitId}`)
    const targetState: IssueState = direction === 'close' ? 'closed' : 'open'
    const delegated = await this.delegate(direction === 'close' ? 'issue.close' : 'issue.reopen', commitId, actor.agentId, {
      sessionId, commitId, opSeq: operation.opSeq, targetState,
      vikunjaProjectId: session.vikunjaProjectId, vikunjaIssueId: session.vikunjaIssueId,
      reason, ...(direction === 'close' ? { conclusion: optionalText(input.conclusion) ?? '' } : {}),
    })
    if (!delegated.ok) return delegated.result
    const actual = readObservedState(delegated.result) ?? targetState
    const confirmed = confirmIssueOperation(this.sessions, { commitId, externalState: actual, externalOpSeq: operation.opSeq }, this.now().toISOString())
    this.sessions = confirmed.state
    this.save()
    const current = sessionOfIssue(this.sessions, sessionId)
    if (direction === 'close') {
      const outcome = confirmed.decision.outcome === 'applied' ? 'closed' : confirmed.decision.outcome
      return ok({ kind: 'issue.closed', requestId: text(input.requestId, 'requestId'), session: current, outcome })
    }
    const outcome = confirmed.decision.outcome === 'applied' ? 'reopened' : confirmed.decision.outcome
    return ok({ kind: 'issue.reopened', requestId: text(input.requestId, 'requestId'), session: current, outcome })
  }

  private createAction(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const sessionId = text(input.sessionId, 'sessionId')
    const commitId = text(input.commitId, 'commitId')
    const assigneeAgentId = text(input.assigneeAgentId, 'assigneeAgentId')
    const kind = input.actionKind
    if (kind !== 'reply' && kind !== 'review' && kind !== 'comment' && kind !== 'audit' && kind !== 'followup') return err('INVALID_INPUT', 'unknown action kind')
    const session = this.sessions.sessions.get(sessionId)
    if (!session) return err('NOT_FOUND', `unknown session ${sessionId}`)
    const group = groupOf(this.registry, session.groupId)
    if (!memberActiveAt(group, assigneeAgentId, this.now().toISOString())) return err('INVALID_INPUT', `${assigneeAgentId} is not an active member`)
    if (typeof input.replyRequired !== 'boolean') return err('INVALID_INPUT', 'replyRequired must be a boolean')
    const reason = text(input.reason, 'reason')
    const expectedResult = text(input.expectedResult, 'expectedResult')
    const created = createAction(this.actions, {
      commitId, sessionId, initiatorAgentId: actor.agentId, assigneeAgentId, kind,
      reason, expectedResult,
      replyRequired: input.replyRequired,
      ...(optionalText(input.replyRequiredReason) === undefined ? {} : { replyRequiredReason: optionalText(input.replyRequiredReason) as string }),
      ...(optionalText(input.inReplyToActionId) === undefined ? {} : { inReplyToActionId: optionalText(input.inReplyToActionId) as string }),
    }, this.now().toISOString())
    this.actions = created.state
    this.save()
    return ok({ kind: 'action.created', requestId: text(input.requestId, 'requestId'), action: created.action }, [
      { agentId: assigneeAgentId, frame: { kind: 'action.created', requestId: text(input.requestId, 'requestId'), action: created.action } },
    ])
  }

  private async submitAction(actor: Actor, input: Record<string, unknown>): Promise<GroupHubResult> {
    const actionId = text(input.actionId, 'actionId')
    const resultCommitId = text(input.resultCommitId, 'resultCommitId')
    const action = this.actions.actions.get(actionId)
    if (!action) return err('NOT_FOUND', `unknown action ${actionId}`)
    if (action.assigneeAgentId !== actor.agentId) return err('FORBIDDEN', `${actor.agentId} is not the assignee of ${actionId}`)
    const delegated = await this.delegate('action.result', resultCommitId, actor.agentId, {
      actionId, resultCommitId, sessionId: action.sessionId, resultBody: optionalText(input.resultBody) ?? '',
    })
    if (!delegated.ok) return delegated.result
    const resultRef = optionalText((delegated.result as Record<string, unknown> | undefined)?.resultRef) ?? `result:${resultCommitId}`
    this.actions = submitActionResult(this.actions, { actionId, resultCommitId, resultRef }, this.now().toISOString()).state
    this.save()
    const updated = actionOf(this.actions, actionId)
    return ok({ kind: 'action.updated', requestId: text(input.requestId, 'requestId'), action: updated }, [
      { agentId: updated.initiatorAgentId, frame: { kind: 'action.changed', action: updated } },
    ])
  }

  private reportOrRefuse(actor: Actor, input: Record<string, unknown>, direction: 'report' | 'refuse'): GroupHubResult {
    const actionId = text(input.actionId, 'actionId')
    const action = this.actions.actions.get(actionId)
    if (!action) return err('NOT_FOUND', `unknown action ${actionId}`)
    if (action.assigneeAgentId !== actor.agentId) return err('FORBIDDEN', `${actor.agentId} is not the assignee of ${actionId}`)
    if (direction === 'report') {
      if (input.report !== 'blocked' && input.report !== 'failed') return err('INVALID_INPUT', 'report must be blocked or failed')
      this.actions = reportAction(this.actions, actionId, input.report, this.now().toISOString())
    } else {
      this.actions = refuseAction(this.actions, actionId, this.now().toISOString())
    }
    this.save()
    const updated = actionOf(this.actions, actionId)
    return ok({ kind: 'action.updated', requestId: text(input.requestId, 'requestId'), action: updated }, [
      { agentId: updated.initiatorAgentId, frame: { kind: 'action.changed', action: updated } },
    ])
  }

  /**
   * One external write through the delegated owner, then the authenticated
   * receipt. A missing executor, a rejected receipt or an unconfirmed outcome is
   * reported explicitly; none of them becomes success.
   */
  private async delegate(
    kind: ExternalOp['kind'],
    commitId: string,
    ownerAgentId: string,
    params: Record<string, unknown>,
  ): Promise<{ readonly ok: true; readonly result: JsonValue | undefined } | { readonly ok: false; readonly result: GroupHubResult }> {
    if (!this.executeExternalOp) return { ok: false, result: err('UNAVAILABLE', `no external executor is configured for ${kind}`) }
    const begun = beginExternalOp(this.ledger, { opId: this.idFactory(), commitId, kind, ownerAgentId, params: params as JsonValue }, this.now().toISOString())
    const operations = new Map(this.ledger.operations).set(begun.op.opId, begun.op)
    this.ledger = markExternalOpInflight({ operations }, begun.op.opId, this.now().toISOString())
    const receipt = await this.executeExternalOp(begun.op)
    if ('code' in receipt) return { ok: false, result: err(receipt.code, receipt.message) }
    if (receipt.state === 'unknown') {
      this.save()
      return { ok: false, result: err('UPSTREAM_ERROR', `${kind} outcome is unknown; read back before retrying`) }
    }
    if (receipt.state === 'failed') {
      this.save()
      return { ok: false, result: err(receipt.error?.code ?? 'UPSTREAM_ERROR', receipt.error?.message ?? `${kind} failed`) }
    }
    try {
      this.ledger = authenticateExternalOpReceipt(this.ledger, receipt, this.now().toISOString()).ledger
    } catch (error) {
      return { ok: false, result: err('FORBIDDEN', error instanceof Error ? error.message : 'external receipt rejected') }
    }
    return { ok: true, result: receipt.result }
  }
}

function readObservedState(result: JsonValue | undefined): IssueState | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  const value = (result as Record<string, unknown>).actualState
  return value === 'open' || value === 'closed' ? value : undefined
}

export function createGroupHub(deps: GroupHubDeps = {}): GroupHubImpl {
  return new GroupHubImpl(deps)
}

