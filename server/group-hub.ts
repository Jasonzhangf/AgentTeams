import type { JsonValue, ServiceError } from '../packages/shared/src/agent-services.ts'
import type { Action, ExternalOp, Group, GroupInvitation, IssueSession, IssueState, Message, MessageWatermark } from '../packages/shared/src/group-wire.ts'
import { isTerminalActionState } from '../packages/shared/src/group-wire.ts'
import type { ExternalOpReceipt } from './group-external-ops.ts'
import type { GroupHub, GroupHubResult, GroupHubPush } from './relay.ts'
import { advanceWatermark, appendMessage, createMessageLog, pageMessages, restoreMessageLog, type MessageLogState } from './message-log.ts'
import {
  activeMemberIds,
  canCloseIssue,
  canCommand,
  canManageGroup,
  canRequest,
  createGroupRegistry,
  grantRole,
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
  listIssueSessions,
  openIssueSession,
  reconcileIssueSession,
  reconcileIssueSessions,
  reopenIssueSession,
  sessionForIssue,
  sessionOfIssue,
  settleIssueOperation,
  type IssueSessionOperation,
  type IssueSessionRegistry,
} from './issue-session.ts'
import {
  actionOf,
  createAction,
  createActionRegistry,
  listActions,
  refuseAction,
  reportAction,
  requestActionCancel,
  startAction,
  submitActionResult,
  transitionAction,
  type ActionRegistryState,
} from './action-registry.ts'
import { routeGroupMessage } from './message-router.ts'
import {
  authenticateExternalOpReceipt,
  beginExternalOp,
  closeReportUnstopped,
  confirmExternalOpFromRead,
  createExternalOpLedger,
  externalOpForCommit,
  markExternalOpInflight,
  reconcileAfterRestart,
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

/** A JSON-safe message log: a Map cannot survive `JSON.stringify`. */
export interface MessageLogSnapshot {
  readonly groupId: string
  readonly messages: readonly Message[]
  readonly revision: number
  readonly retentionStartSequence: number
  readonly watermarks: readonly MessageWatermark[]
}

export interface GroupHubSnapshot {
  readonly groups: readonly Group[]
  readonly invitations: readonly GroupInvitation[]
  readonly sessions: readonly IssueSession[]
  /** Open and close intents, so a stale close still loses after a restart. */
  readonly operations: readonly IssueSessionOperation[]
  readonly actions: readonly Action[]
  readonly logs: readonly MessageLogSnapshot[]
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
  /** Pushes one frame to a named agent; the relay bridge or a test double. */
  readonly sendToAgent?: (agentId: string, frame: unknown) => void
  /** Presence for push selection and delegation refusal. */
  readonly isOnline?: (agentId: string) => boolean
  /** A delegation that never returns a receipt becomes unknown after this delay. */
  readonly externalOpTimeoutMs?: number
  /**
   * Direct delegation seam for tests and for a single-process composition.
   * Without it the hub delegates over the bridge and waits for the receipt frame.
   */
  readonly executeExternalOp?: (op: ExternalOp) => Promise<ExternalOpReceipt | ServiceError>
}

type Actor = { readonly agentId: string; readonly accountId: string; readonly scopeId: string }

/**
 * One external read. `unconfirmed` is not a state: a read that failed says the
 * projection is unconfirmed, so no caller can pass the old state off as fresh.
 */
type StateRead =
  | { readonly status: 'confirmed'; readonly facts: Record<string, unknown>; readonly observed?: IssueState }
  | { readonly status: 'unconfirmed'; readonly error: ServiceError }

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
  private readonly sendToAgent?: (agentId: string, frame: unknown) => void
  private readonly isOnline: (agentId: string) => boolean
  private readonly externalOpTimeoutMs: number
  private readonly executeExternalOp?: (op: ExternalOp) => Promise<ExternalOpReceipt | ServiceError>
  private readonly waiting = new Map<string, (receipt: ExternalOpReceipt) => void>()

  constructor(deps: GroupHubDeps = {}) {
    this.now = deps.now ?? (() => new Date())
    this.idFactory = deps.idFactory ?? (() => crypto.randomUUID())
    this.store = deps.store
    this.sendToAgent = deps.sendToAgent
    this.isOnline = deps.isOnline ?? (() => false)
    this.externalOpTimeoutMs = deps.externalOpTimeoutMs ?? 10_000
    this.executeExternalOp = deps.executeExternalOp
    const snapshot = deps.store?.load()
    this.registry = snapshot
      ? { groups: new Map(snapshot.groups.map((group) => [group.groupId, group])), invitations: [...snapshot.invitations] }
      : createGroupRegistry()
    const restoredAt = this.now().toISOString()
    this.sessions = snapshot
      ? reconcileIssueSessions(
          { sessions: new Map(snapshot.sessions.map((session) => [session.sessionId, session])), operations: [...(snapshot.operations ?? [])] },
          restoredAt,
        )
      : createIssueSessionRegistry()
    this.actions = snapshot
      ? { actions: new Map(snapshot.actions.map((action) => [action.actionId, action])) }
      : createActionRegistry()
    this.logs = snapshot
      ? new Map(snapshot.logs.map((log) => [log.groupId, restoreMessageLog({
          groupId: log.groupId,
          messages: log.messages,
          retentionStartSequence: log.retentionStartSequence,
          watermarks: log.watermarks,
        })]))
      : new Map()
    // Nothing in flight survives a restart as a live write: it is unknown and read back.
    this.ledger = snapshot
      ? reconcileAfterRestart({ operations: new Map(snapshot.ops.map((op) => [op.opId, op])) }, restoredAt)
      : createExternalOpLedger()
  }

  snapshot(): GroupHubSnapshot {
    return {
      groups: [...this.registry.groups.values()],
      invitations: this.registry.invitations,
      sessions: [...this.sessions.sessions.values()],
      operations: this.sessions.operations,
      actions: [...this.actions.actions.values()],
      logs: [...this.logs.values()].map((log) => ({
        groupId: log.groupId,
        messages: log.messages,
        revision: log.revision,
        retentionStartSequence: log.retentionStartSequence,
        watermarks: [...log.watermarks.values()],
      })),
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
        case 'group.grant': return this.grant(actor, input)
        case 'group.respond': return this.respond(actor, input)
        case 'group.leave': return this.leave(actor, input)
        case 'message.send': return this.sendMessage(actor, input)
        case 'message.page': return this.page(actor, input)
        case 'message.ack': return this.ack(actor, input)
        case 'issue.create': return await this.createIssue(actor, input)
        case 'issue.reference': return await this.referenceIssue(actor, input)
        case 'issue.query': return await this.queryIssue(actor, input)
        case 'issue.list': return this.listIssues(actor, input)
        case 'issue.close': return await this.closeOrReopen(actor, input, 'close')
        case 'issue.reopen': return await this.closeOrReopen(actor, input, 'reopen')
        case 'action.create': return await this.createAction(actor, input)
        case 'action.submit': return await this.submitAction(actor, input)
        case 'action.report': return this.reportOrRefuse(actor, input, 'report')
        case 'action.refuse': return this.reportOrRefuse(actor, input, 'refuse')
        case 'action.list': return this.listActionsFor(actor, input)
        case 'op.confirmed':
        case 'op.failed':
        case 'op.unknown': return this.receipt(actor, input)
        default: return err('UNSUPPORTED_OPERATION', `unsupported group frame ${String(input.kind)}`)
      }
    } catch (error) {
      return err('INVALID_INPUT', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * A delegated owner returns one receipt. Only the owner of that operation may
   * move the projection; a late or foreign receipt changes nothing.
   */
  private receipt(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const opId = text(input.opId, 'opId')
    const commitId = text(input.commitId, 'commitId')
    const kind = String(input.kind)
    const failure = kind === 'op.failed'
      ? readServiceError(input.error)
      : undefined
    if (kind === 'op.failed' && !failure) return err('INVALID_INPUT', 'op.failed requires a typed error')
    const receipt: ExternalOpReceipt = {
      opId, commitId, fromAgentId: actor.agentId,
      state: kind === 'op.confirmed' ? 'confirmed' : kind === 'op.failed' ? 'failed' : 'unknown',
      ...(kind === 'op.confirmed' ? { result: (input.result ?? null) as JsonValue } : {}),
      ...(failure === undefined ? {} : { error: failure }),
      ...(kind === 'op.unknown' ? { reason: optionalText(input.reason) ?? 'unknown' } : {}),
    }
    // Authenticate before touching the waiter: a forged receipt must not consume
    // the slot and drop the receipt the real owner is about to send.
    const operation = this.ledger.operations.get(opId)
    if (!operation) return err('FORBIDDEN', `receipt names an unknown operation ${opId}`)
    if (operation.ownerAgentId !== actor.agentId) return err('FORBIDDEN', `receipt for ${opId} did not come from its owner`)
    if (operation.commitId !== commitId) return err('FORBIDDEN', `receipt for ${opId} names a different commit id`)
    const resolve = this.waiting.get(opId)
    if (resolve) {
      this.waiting.delete(opId)
      resolve(receipt)
    }
    return { ok: true }
  }

  private save(): void {
    this.store?.save(this.snapshot())
  }

  private isActiveMember(actor: Actor, groupId: string): boolean {
    const group = this.registry.groups.get(groupId)
    return group !== undefined && memberActiveAt(group, actor.agentId, this.now().toISOString())
  }

  /** Actions are readable only inside the groups the actor belongs to. */
  private listActionsFor(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const sessionId = optionalText(input.sessionId)
    if (sessionId !== undefined && !this.sessions.sessions.has(sessionId)) return err('NOT_FOUND', `unknown session ${sessionId}`)
    const now = this.now().toISOString()
    const visible = listActions(this.actions, sessionId).filter((action) => {
      const session = this.sessions.sessions.get(action.sessionId)
      if (!session) return false
      const group = this.registry.groups.get(session.groupId)
      return group !== undefined && memberActiveAt(group, actor.agentId, now)
    })
    return ok({ kind: 'action.list', requestId: text(input.requestId, 'requestId'), actions: visible })
  }

  /**
   * A group's own sessions, so a page that reopens a group restores the work it
   * already owns instead of rebuilding it from message history. The ledger is
   * the source; this only reads it back scoped to the group the actor is in.
   */
  private listIssues(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    if (!this.isActiveMember(actor, groupId)) return err('FORBIDDEN', `${actor.agentId} is not an active member of ${groupId}`)
    const sessions = listIssueSessions(this.sessions, groupId).map((session) => sessionOfIssue(this.sessions, session.sessionId))
    return ok({ kind: 'issue.list', requestId: text(input.requestId, 'requestId'), sessions })
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

  /**
   * The owner retargets one member's role and command edges. This is the only
   * frame that changes `mastersOf`, and those edges are the sole authority for a
   * master's assignment and a peer's request, so a group a user creates is
   * actually usable. Ownership itself never creates an edge.
   */
  private grant(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    const agentId = text(input.agentId, 'agentId')
    const role = input.role === 'master' || input.role === 'peer' ? input.role : undefined
    if (!role) return err('INVALID_INPUT', 'role must be master or peer')
    const group = groupOf(this.registry, groupId)
    if (!canManageGroup(group, actor.agentId)) return err('FORBIDDEN', `${actor.agentId} cannot manage group ${groupId}`)
    this.registry = grantRole(this.registry, {
      groupId, agentId, role,
      ...(Array.isArray(input.mastersOf) ? { mastersOf: input.mastersOf.filter((id): id is string => typeof id === 'string') } : {}),
      grantedByAgentId: actor.agentId,
    }, this.now().toISOString())
    this.save()
    const updated = groupOf(this.registry, groupId)
    // The changed member holds the new edges and the owner holds the group view.
    const recipients = [...new Set([updated.ownerAgentId, agentId])]
    return ok({ kind: 'group.member', requestId: text(input.requestId, 'requestId'), group: updated },
      recipients.map((recipient) => ({ agentId: recipient, frame: { kind: 'group.changed', group: updated } })))
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
    const targetAgentIds: readonly string[] = action ? [action.assigneeAgentId] : (input.targetAgentIds as readonly string[])
    const sessionId = action ? action.sessionId : optionalText(input.sessionId)
    const appended = appendMessage(this.logOf(groupId), {
      commitId, groupId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(actionId === undefined ? {} : { actionId }),
      fromAgentId: actor.agentId,
      targetAgentIds,
      replyRequired: input.replyRequired,
      ...(optionalText(input.replyRequiredReason) === undefined ? {} : { replyRequiredReason: optionalText(input.replyRequiredReason) as string }),
      body,
      sentAt: now,
      ...(optionalText(input.inReplyToMessageId) === undefined ? {} : { inReplyToMessageId: optionalText(input.inReplyToMessageId) as string }),
    })
    this.setLog(groupId, appended.state)
    const routed = routeGroupMessage({ group, message: appended.message, ...(action ? { action } : {}), onlineAgentIds: activeMemberIds(group).filter((agentId) => this.isOnline(agentId)) })
    this.save()
    const pushes = routed.pushAgentIds.map((agentId) => ({ agentId, frame: { kind: 'message.received', groupId, message: appended.message } }))
    return ok({ kind: 'message.sent', requestId: text(input.requestId, 'requestId'), messageId: appended.message.messageId, sequence: appended.message.sequence }, pushes)
  }

  private page(actor: Actor, input: Record<string, unknown>): GroupHubResult {
    const groupId = text(input.groupId, 'groupId')
    if (!this.isActiveMember(actor, groupId)) return err('FORBIDDEN', `${actor.agentId} is not an active member of ${groupId}`)
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
    if (!this.isActiveMember(actor, groupId)) return err('FORBIDDEN', `${actor.agentId} is not an active member of ${groupId}`)
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
    if (!this.isActiveMember(actor, groupId)) return err('FORBIDDEN', `${actor.agentId} is not an active member of ${groupId}`)
    // One commit id names one issue. A confirmed retry returns it, an unclear one
    // must be read back instead of issuing a second create.
    const recorded = externalOpForCommit(this.ledger, commitId, 'issue.create')
    if (recorded) {
      if (recorded.state === 'confirmed') {
        const issueId = optionalText((recorded.result as Record<string, unknown> | undefined)?.issueId)
        if (issueId === undefined) return err('UPSTREAM_ERROR', 'the recorded create has no issue id')
        const existing = sessionForIssue(this.sessions, groupId, projectId, issueId)
        return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: existing })
      }
      if (recorded.state === 'failed') {
        const error = recorded.error ?? { code: 'UPSTREAM_ERROR', message: 'the recorded create failed' }
        return err(error.code, `${error.message}; issue.create for ${commitId} previously failed`)
      }
      // unknown/inflight: recover by the stable reference before retrying, so a
      // retry never writes a second issue.
      const recovered = await this.recoverByRef(actor, text(input.requestId, 'requestId'), groupId, commitId, { projectId, title })
      if (recovered.ok) return recovered
      return err('RESULT_UNKNOWN', `issue.create for ${commitId} is ${recorded.state}; recovery could not confirm it`)
    }
    const delegated = await this.delegate('issue.create', commitId, actor.agentId, { groupId, commitId, vikunjaProjectId: projectId, title, body: optionalText(input.body) ?? '' })
    if (!delegated.ok) return delegated.result
    const issueId = optionalText((delegated.result as Record<string, unknown> | undefined)?.issueId)
    if (!issueId) return err('UPSTREAM_ERROR', 'issue.create returned no issue id')
    const sessionId = `${groupId}:${projectId}:${issueId}`
    this.sessions = openIssueSession(this.sessions, { sessionId, groupId, vikunjaProjectId: projectId, vikunjaIssueId: issueId, initiatorAgentId: actor.agentId }, this.now().toISOString())
    this.save()
    return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: sessionOfIssue(this.sessions, sessionId) })
  }

  /**
   * A read-back runs as the operation's recorded owner. A member that learns the
   * commit id cannot recover someone else's uncertain write as its own.
   */
  private recoveryRefusal(op: ExternalOp, actor: Actor): GroupHubResult | undefined {
    return op.ownerAgentId === actor.agentId
      ? undefined
      : err('FORBIDDEN', `${actor.agentId} is not the owner of ${op.kind} ${op.commitId}`)
  }

  /**
   * Read a create back by its stable reference before any retry. The read goes to
   * the same owner and never writes a second issue; a hit persists the confirmed
   * outcome, a miss leaves the op unknown.
   */
  private async recoverByRef(
    actor: Actor,
    requestId: string,
    groupId: string,
    commitId: string,
    params: { readonly projectId: string; readonly title: string },
  ): Promise<GroupHubResult> {
    const recorded = externalOpForCommit(this.ledger, commitId, 'issue.create')
    if (!recorded) return err('NOT_FOUND', `no recorded create for ${commitId}`)
    const refusal = this.recoveryRefusal(recorded, actor)
    if (refusal) return refusal
    const delegated = await this.delegate('issue.recover', commitId, actor.agentId, {
      recoverKind: 'issue.create', groupId, commitId,
      vikunjaProjectId: params.projectId, title: params.title,
    })
    if (!delegated.ok) return delegated.result
    const facts = delegated.result
    const issueId = facts !== null && typeof facts === 'object' && !Array.isArray(facts)
      ? optionalText((facts as Record<string, unknown>).issueId)
      : undefined
    if (issueId === undefined) return err('RESULT_UNKNOWN', `create ${commitId} was not found by reference; the outcome stays unknown`)
    const now = this.now().toISOString()
    this.ledger = confirmExternalOpFromRead(this.ledger, recorded.opId, { issueId } as JsonValue, now)
    const bound = listIssueSessions(this.sessions, groupId)
      .find((session) => session.vikunjaProjectId === params.projectId && session.vikunjaIssueId === issueId)
    if (bound) {
      this.save()
      return ok({ kind: 'issue.session', requestId, session: bound })
    }
    const sessionId = `${groupId}:${params.projectId}:${issueId}`
    this.sessions = openIssueSession(this.sessions, { sessionId, groupId, vikunjaProjectId: params.projectId, vikunjaIssueId: issueId, initiatorAgentId: actor.agentId }, now)
    this.save()
    return ok({ kind: 'issue.session', requestId, session: sessionOfIssue(this.sessions, sessionId) })
  }

  /**
   * Binds an existing issue to a session. The project and the state come from a
   * confirmed read; a reference the read cannot confirm stays unbound.
   */
  private async referenceIssue(actor: Actor, input: Record<string, unknown>): Promise<GroupHubResult> {
    const groupId = text(input.groupId, 'groupId')
    const commitId = text(input.commitId, 'commitId')
    const issueId = text(input.vikunjaIssueId, 'vikunjaIssueId')
    const now = this.now().toISOString()
    // A reference into a group the actor does not belong to is a cross-group write.
    if (!memberActiveAt(groupOf(this.registry, groupId), actor.agentId, now)) {
      return err('FORBIDDEN', `${actor.agentId} is not an active member of ${groupId}`)
    }
    const sessionId = `${groupId}:referenced:${issueId}`
    const existing = this.sessions.sessions.get(sessionId)
    if (existing) {
      return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: existing })
    }
    const recorded = externalOpForCommit(this.ledger, commitId, 'issue.create')
    if (recorded?.state === 'confirmed') {
      return err('CONFLICT', `commit ${commitId} already opened another session`)
    }
    const read = await this.confirmRead(`issue.reference:${commitId}`, actor.agentId, { groupId, commitId, vikunjaIssueId: issueId })
    if (read.status === 'unconfirmed') {
      return err(read.error.code === 'UNAVAILABLE' ? 'RESULT_UNKNOWN' : read.error.code === 'UPSTREAM_ERROR' ? 'RESULT_UNKNOWN' : read.error.code,
        `issue ${issueId} was not read back; the reference is not confirmed`)
    }
    const facts = read.facts
    const projectId = optionalText(facts.projectId)
    if (projectId === undefined) {
      return err('UPSTREAM_ERROR', `issue ${issueId} was read without its project; the reference is not confirmed`)
    }
    const observed = readObservedState(facts as JsonValue)
    // An issue this group already bound keeps its session: a reference is a bind,
    // not a second session for the same issue.
    const bound = [...this.sessions.sessions.values()].find(entry =>
      entry.groupId === groupId && entry.vikunjaProjectId === projectId && entry.vikunjaIssueId === issueId)
    if (bound !== undefined) {
      // The just-read state still converges the projection; the reference must
      // not return a stale open for an issue Vikunja already closed.
      if (observed !== undefined && observed !== bound.state) {
        this.sessions = reconcileIssueSession(this.sessions, { sessionId: bound.sessionId, state: observed, now })
        this.save()
      }
      return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: sessionOfIssue(this.sessions, bound.sessionId) })
    }
    this.sessions = openIssueSession(this.sessions, { sessionId, groupId, vikunjaProjectId: projectId, vikunjaIssueId: issueId, initiatorAgentId: actor.agentId }, now)
    // Vikunja owns the open/closed truth, so a closed issue opens a closed session.
    if (observed === 'closed') {
      this.sessions = reconcileIssueSession(this.sessions, { sessionId, state: 'closed', now })
    }
    this.save()
    return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: sessionOfIssue(this.sessions, sessionId) })
  }

  /**
   * A read of the external state. Vikunja owns open/closed, so a confirmed read
   * converges the projection within one poll. A failed read changes nothing.
   */
  private async queryIssue(actor: Actor, input: Record<string, unknown>): Promise<GroupHubResult> {
    const sessionId = text(input.sessionId, 'sessionId')
    const session = this.sessions.sessions.get(sessionId)
    if (!session) return err('NOT_FOUND', `unknown session ${sessionId}`)
    // Off-group history is not readable just because the session id is known.
    const now = this.now().toISOString()
    if (!memberActiveAt(groupOf(this.registry, session.groupId), actor.agentId, now)) {
      return err('FORBIDDEN', `${actor.agentId} is not an active member of ${session.groupId}`)
    }
    const read = await this.readExternal(session)
    // A failed read is not evidence of the old projection: say unconfirmed.
    if (read.status === 'unconfirmed') {
      return err(read.error.code, `${read.error.message}; session ${sessionId} state is unconfirmed`)
    }
    const observed = read.observed
    const current = this.sessions.sessions.get(sessionId)
    // A slow read must not restore a state that a later open/close replaced.
    if (observed !== undefined && current !== undefined && current.state === session.state && observed !== current.state) {
      this.convergeSessionClosed(session.groupId, sessionId, observed === 'closed' ? true : false, now)
      this.save()
    }
    return ok({ kind: 'issue.session', requestId: text(input.requestId, 'requestId'), session: sessionOfIssue(this.sessions, sessionId) })
  }

  /**
   * Stops new admission and cancels queued work for one closed session. Local close
   * and an externally observed close both pass here, so there is one convergence
   * action instead of two drifting ones.
   */
  private convergeSessionClosed(groupId: string, sessionId: string, closed: boolean, now: string): void {
    if (!closed) {
      this.sessions = reconcileIssueSession(this.sessions, { sessionId, state: 'open', now })
      return
    }
    this.sessions = reconcileIssueSession(this.sessions, { sessionId, state: 'closed', now })
    for (const action of listActions(this.actions, sessionId)) {
      if (isTerminalActionState(action.state)) continue
      try {
        this.actions = requestActionCancel(this.actions, action.actionId, now)
      } catch {
        // An action already past the cancel edge keeps its recorded state.
      }
    }
    void groupId
  }

  /**
   * One read-only external query, kept out of the durable ledger because it may
   * be re-issued at any time. Returns the confirmed result, never an intent.
   */
  private async confirmRead(    commitId: string,
    ownerAgentId: string,
    params: Record<string, unknown>,
  ): Promise<StateRead> {
    const now = this.now().toISOString()
    const op: ExternalOp = {
      opId: this.idFactory(),
      commitId,
      kind: 'issue.query',
      state: 'inflight',
      ownerAgentId,
      // The owner echoes the commit id back; a receipt without it is refused.
      params: { ...params, commitId } as JsonValue,
      updatedAt: now,
    }
    // Present for receipt authentication only; never saved.
    this.ledger = { operations: new Map(this.ledger.operations).set(op.opId, op) }
    try {
      const receipt = this.executeExternalOp ? await this.executeExternalOp(op) : await this.delegatedReceipt(op)
      if ('code' in receipt) return { status: 'unconfirmed', error: receipt }
      if (receipt.state !== 'confirmed') {
        return { status: 'unconfirmed', error: { code: 'UPSTREAM_ERROR', message: `${receipt.reason ?? 'state read'}; session state is unconfirmed` } }
      }
      const result = receipt.result
      return typeof result === 'object' && result !== null && !Array.isArray(result)
        ? { status: 'confirmed', facts: result as Record<string, unknown> }
        : { status: 'unconfirmed', error: { code: 'UPSTREAM_ERROR', message: 'state read returned no facts; session state is unconfirmed' } }
    } finally {
      const operations = new Map(this.ledger.operations)
      operations.delete(op.opId)
      this.ledger = { operations }
    }
  }

  private async readExternal(session: IssueSession): Promise<StateRead> {
    const read = await this.confirmRead(`issue.query:${session.sessionId}`, session.initiatorAgentId, {
      sessionId: session.sessionId,
      vikunjaProjectId: session.vikunjaProjectId,
      vikunjaIssueId: session.vikunjaIssueId,
    })
    if (read.status === 'unconfirmed') return read
    return { status: 'confirmed', facts: read.facts, observed: readObservedState(read.facts as JsonValue) }
  }

  /** Queued work is cancelled by the close, per the close graph: cancel-queued first. */
  private cancelSessionActions(sessionId: string, now: string): void {
    for (const action of listActions(this.actions, sessionId)) {
      if (isTerminalActionState(action.state)) continue
      try {
        this.actions = requestActionCancel(this.actions, action.actionId, now)
      } catch {
        // An action past the cancel edge keeps its recorded state.
      }
    }
  }

  private async closeOrReopen(actor: Actor, input: Record<string, unknown>, direction: 'close' | 'reopen'): Promise<GroupHubResult> {
    const sessionId = text(input.sessionId, 'sessionId')
    const commitId = text(input.commitId, 'commitId')
    const reason = text(input.reason, 'reason')
    const session = this.sessions.sessions.get(sessionId)
    if (!session) return err('NOT_FOUND', `unknown session ${sessionId}`)
    const now = this.now().toISOString()
    if (!this.isActiveMember(actor, session.groupId)) return err('FORBIDDEN', `${actor.agentId} is not an active member of ${session.groupId}`)
    // Close and reopen belong to the recorded initiator. A client-supplied
    // delegate list never widens that.
    if (!canCloseIssue(session, actor.agentId)) return err('FORBIDDEN', `${actor.agentId} cannot ${direction} session ${sessionId}`)
    this.sessions = direction === 'close'
      ? closeIssueSession(this.sessions, { sessionId, commitId, reason, conclusion: optionalText(input.conclusion) ?? '' }, now)
      : reopenIssueSession(this.sessions, { sessionId, commitId, reason }, now)
    const operation = this.sessions.operations.find((entry) => entry.commitId === commitId)
    if (!operation) return err('UPSTREAM_ERROR', `missing open/close operation for ${commitId}`)
    // The intent is durable before the write, so recovery can read it back.
    this.save()
    const opKind = direction === 'close' ? 'issue.close' : 'issue.reopen'
    const targetState: IssueState = direction === 'close' ? 'closed' : 'open'
    // A lost receipt leaves an unknown write. A retry reads the actual state
    // back and converges from it; it never re-issues the close or reopen.
    const recorded = externalOpForCommit(this.ledger, commitId, opKind)
    if (recorded && (recorded.state === 'unknown' || recorded.state === 'inflight')) {
      const refusal = this.recoveryRefusal(recorded, actor)
      if (refusal) return refusal
      const recovered = await this.delegate('issue.recover', commitId, actor.agentId, {
        recoverKind: opKind, sessionId, commitId, targetState,
        vikunjaProjectId: session.vikunjaProjectId, vikunjaIssueId: session.vikunjaIssueId,
      })
      if (!recovered.ok) {
        this.sessions = settleIssueOperation(this.sessions, commitId, 'unknown', now)
        this.save()
        return err('RESULT_UNKNOWN', `${direction} for ${commitId} is ${recorded.state}; recovery could not confirm it`)
      }
      const recoveredState = readObservedState(recovered.result)
      if (recoveredState === undefined) {
        this.sessions = settleIssueOperation(this.sessions, commitId, 'unknown', now)
        this.save()
        return err('RESULT_UNKNOWN', `${direction} for ${commitId} was not read back; the outcome stays unknown`)
      }
      this.ledger = confirmExternalOpFromRead(this.ledger, recorded.opId, recovered.result as JsonValue, this.now().toISOString())
      return this.settleIssueRead(direction, input, sessionId, commitId, operation, recoveredState)
    }
    // A close cancels queued work before the external write; an in-flight action
    // keeps its responsibility and its stop fact.
    if (direction === 'close') this.cancelSessionActions(sessionId, this.now().toISOString())
    const delegated = await this.delegate(opKind, commitId, actor.agentId, {
      sessionId, commitId, opSeq: operation.opSeq, targetState,
      vikunjaProjectId: session.vikunjaProjectId, vikunjaIssueId: session.vikunjaIssueId,
      reason, ...(direction === 'close' ? { conclusion: optionalText(input.conclusion) ?? '' } : {}),
    }, operation.opSeq)
    if (!delegated.ok) {
      this.sessions = settleIssueOperation(this.sessions, commitId, 'unknown', now)
      this.save()
      return delegated.result
    }
    // Only the read-back state may move the projection. An owner receipt that
    // names no observed state is unknown, never the intended state.
    const actual = readObservedState(delegated.result)
    if (actual === undefined) {
      this.sessions = settleIssueOperation(this.sessions, commitId, 'unknown', now)
      this.save()
      return err('UPSTREAM_ERROR', `${direction} was not confirmed by a read-back; outcome is unknown`)
    }
    return this.settleIssueRead(direction, input, sessionId, commitId, operation, actual)
  }

  /**
   * Applies one confirmed read to the session projection. Only an applied
   * decision changes the state; a conflict or unknown is reported as such and
   * never rewrites the newer state. A close report is taken after cancellation,
   * so it names the final facts of this settlement.
   */
  private settleIssueRead(
    direction: 'close' | 'reopen',
    input: Record<string, unknown>,
    sessionId: string,
    commitId: string,
    operation: IssueSessionOperation,
    actual: IssueState,
  ): GroupHubResult {
    const confirmed = confirmIssueOperation(this.sessions, { commitId, externalState: actual, externalOpSeq: operation.opSeq }, this.now().toISOString())
    this.sessions = confirmed.state
    this.save()
    const current = sessionOfIssue(this.sessions, sessionId)
    if (direction === 'close') {
      // A confirmed close is the single convergence: the projection is closed and
      // any work not yet cancelled is taken out of the executable set.
      this.cancelSessionActions(sessionId, this.now().toISOString())
      this.save()
      const outcome = confirmed.decision.outcome === 'applied' ? 'closed' : confirmed.decision.outcome
      const unstopped = closeReportUnstopped(listActions(this.actions, sessionId))
      return ok({ kind: 'issue.closed', requestId: text(input.requestId, 'requestId'), session: current, outcome, unstopped })
    }
    const outcome = confirmed.decision.outcome === 'applied' ? 'reopened' : confirmed.decision.outcome
    return ok({ kind: 'issue.reopened', requestId: text(input.requestId, 'requestId'), session: current, outcome })
  }

  private async createAction(actor: Actor, input: Record<string, unknown>): Promise<GroupHubResult> {
    const sessionId = text(input.sessionId, 'sessionId')
    const commitId = text(input.commitId, 'commitId')
    const assigneeAgentId = text(input.assigneeAgentId, 'assigneeAgentId')
    const kind = input.actionKind
    if (kind !== 'reply' && kind !== 'review' && kind !== 'comment' && kind !== 'audit' && kind !== 'followup') return err('INVALID_INPUT', 'unknown action kind')
    const session = this.sessions.sessions.get(sessionId)
    if (!session) return err('NOT_FOUND', `unknown session ${sessionId}`)
    if (session.state === 'closed') return err('CONFLICT', `session ${sessionId} is closed; reopen it before creating an action`)
    // Command-before-refresh (§13.1): admission is decided on the current external
    // state, never on a stale local projection. A read that fails is a refusal,
    // not permission to admit on the old open.
    const read = await this.readExternal(session)
    if (read.status === 'unconfirmed') {
      return err(read.error.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UPSTREAM_ERROR',
        `${read.error.message}; new action ${commitId} is refused until the session state is confirmed`)
    }
    const current = this.sessions.sessions.get(sessionId)
    if (read.observed !== undefined && current !== undefined && read.observed !== current.state) {
      this.convergeSessionClosed(session.groupId, sessionId, read.observed === 'closed', this.now().toISOString())
      this.save()
      if (read.observed === 'closed') return err('CONFLICT', `session ${sessionId} is closed; reopen it before creating an action`)
    }
    const group = groupOf(this.registry, session.groupId)
    if (!memberActiveAt(group, assigneeAgentId, this.now().toISOString())) return err('INVALID_INPUT', `${assigneeAgentId} is not an active member`)
    // One `mastersOf` edge serves both directions: a master commands its peer, a
    // peer requests its master. No edge means no authority in either direction.
    if (!canCommand(group, actor.agentId, assigneeAgentId) && !canRequest(group, actor.agentId, assigneeAgentId)) {
      return err('FORBIDDEN', `${actor.agentId} has no command or request edge to ${assigneeAgentId}`)
    }
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
    // The state and the result identity are checked before any external write:
    // a finished action never appends a second comment, and a repeated result
    // commit returns the recorded result instead of writing again.
    if (isTerminalActionState(action.state)) {
      if (action.state === 'completed' && action.resultCommitId === resultCommitId) {
        return ok({ kind: 'action.updated', requestId: text(input.requestId, 'requestId'), action: actionOf(this.actions, actionId) },
          [{ agentId: action.initiatorAgentId, frame: { kind: 'action.changed', action: actionOf(this.actions, actionId) } }])
      }
      return err(action.state === 'completed' ? 'CONFLICT' : 'INVALID_INPUT',
        `action ${actionId} is ${action.state}; a new result cannot be written`)
    }
    const session = this.sessions.sessions.get(action.sessionId)
    // A lost receipt leaves an unknown write. The same result commit retries by
    // reading its comment back, never by writing a second one.
    const recorded = externalOpForCommit(this.ledger, resultCommitId, 'action.result')
    if (recorded && (recorded.state === 'unknown' || recorded.state === 'inflight')) {
      return await this.recoverActionResult(actor, text(input.requestId, 'requestId'), action, recorded, session)
    }
    const delegated = await this.delegate('action.result', resultCommitId, actor.agentId, {
      actionId, resultCommitId, sessionId: action.sessionId,
      resultBody: optionalText(input.resultBody) ?? '',
      ...(session === undefined ? {} : { vikunjaIssueId: session.vikunjaIssueId }),
    })
    const now = this.now().toISOString()
    if (!delegated.ok) {
      if (this.actions.actions.get(actionId)?.state === 'pending') this.actions = startAction(this.actions, actionId, now)
      this.actions = transitionAction(this.actions, actionId, 'unknown', now)
      this.save()
      return delegated.result
    }
    // The comment id is the only proof the result reached Vikunja. Without it the
    // action is unknown, never complete.
    const resultRef = optionalText((delegated.result as Record<string, unknown> | undefined)?.resultRef)
    if (resultRef === undefined) {
      if (this.actions.actions.get(actionId)?.state === 'pending') this.actions = startAction(this.actions, actionId, now)
      this.actions = transitionAction(this.actions, actionId, 'unknown', now)
      this.save()
      return err('UPSTREAM_ERROR', 'action result was not confirmed by a read-back; outcome is unknown')
    }
    // A master assignment cannot be refused, so a result from `pending` starts
    // the action instead of failing the transition.
    if (this.actions.actions.get(actionId)?.state === 'pending') this.actions = startAction(this.actions, actionId, now)
    this.actions = submitActionResult(this.actions, { actionId, resultCommitId, resultRef }, now).state
    this.save()
    const updated = actionOf(this.actions, actionId)
    return ok({ kind: 'action.updated', requestId: text(input.requestId, 'requestId'), action: updated }, [
      { agentId: updated.initiatorAgentId, frame: { kind: 'action.changed', action: updated } },
    ])
  }

  /**
   * Reads one submitted result back by its stable commit reference. A hit is the
   * owner's own comment, so it completes the action; a miss keeps the action
   * unknown. This path never issues a second result write.
   */
  private async recoverActionResult(
    actor: Actor,
    requestId: string,
    action: Action,
    recorded: ExternalOp,
    session: IssueSession | undefined,
  ): Promise<GroupHubResult> {
    const refusal = this.recoveryRefusal(recorded, actor)
    if (refusal) return refusal
    const delegated = await this.delegate('issue.recover', recorded.commitId, actor.agentId, {
      recoverKind: 'action.result', actionId: action.actionId, resultCommitId: recorded.commitId,
      sessionId: action.sessionId,
      ...(session === undefined ? {} : { vikunjaIssueId: session.vikunjaIssueId }),
    })
    if (!delegated.ok) {
      return err('RESULT_UNKNOWN', `action.result for ${recorded.commitId} is ${recorded.state}; recovery could not confirm it`)
    }
    const facts = delegated.result
    const resultRef = facts !== null && typeof facts === 'object' && !Array.isArray(facts)
      ? optionalText((facts as Record<string, unknown>).resultRef)
      : undefined
    if (resultRef === undefined) {
      return err('RESULT_UNKNOWN', `action.result for ${recorded.commitId} was not found by its result reference; the outcome stays unknown`)
    }
    const now = this.now().toISOString()
    this.ledger = confirmExternalOpFromRead(this.ledger, recorded.opId, { resultRef } as JsonValue, now)
    if (this.actions.actions.get(action.actionId)?.state === 'pending') this.actions = startAction(this.actions, action.actionId, now)
    this.actions = submitActionResult(this.actions, { actionId: action.actionId, resultCommitId: recorded.commitId, resultRef }, now).state
    this.save()
    const updated = actionOf(this.actions, action.actionId)
    return ok({ kind: 'action.updated', requestId, action: updated }, [
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
      const reason = text(input.reason, 'reason')
      this.actions = reportAction(this.actions, actionId, input.report, this.now().toISOString(), {
        reason,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence as JsonValue }),
      })
    } else {
      // A master assignment cannot be refused; only a peer request can be.
      const group = groupOf(this.registry, this.sessions.sessions.get(action.sessionId)?.groupId ?? '')
      if (!canRequest(group, action.initiatorAgentId, actor.agentId)) {
        return err('FORBIDDEN', `${actor.agentId} cannot refuse ${actionId}; only a master may refuse a peer request`)
      }
      this.actions = refuseAction(this.actions, actionId, this.now().toISOString())
    }
    this.save()
    const updated = actionOf(this.actions, actionId)
    return ok({ kind: 'action.updated', requestId: text(input.requestId, 'requestId'), action: updated }, [
      { agentId: updated.initiatorAgentId, frame: { kind: 'action.changed', action: updated } },
    ])
  }

  /**
   * Sends `op.execute` to the owner over the bridge and waits for that owner's
   * receipt. A timeout is unknown, not success.
   */
  private delegatedReceipt(op: ExternalOp): Promise<ExternalOpReceipt | ServiceError> {
    if (!this.sendToAgent) return Promise.resolve({ code: 'UNAVAILABLE', message: 'no group bridge is configured' })
    if (!this.isOnline(op.ownerAgentId)) return Promise.resolve({ code: 'UNAVAILABLE', message: `execution owner ${op.ownerAgentId} is offline` })
    return new Promise<ExternalOpReceipt | ServiceError>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(op.opId)
        resolve({ code: 'UNAVAILABLE', message: `no receipt for ${op.opId} within ${this.externalOpTimeoutMs}ms` })
      }, this.externalOpTimeoutMs)
      this.waiting.set(op.opId, (receipt) => {
        clearTimeout(timer)
        resolve(receipt)
      })
      this.sendToAgent?.(op.ownerAgentId, { kind: 'op.execute', opId: op.opId, opKind: op.kind, params: op.params })
    })
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
    opSeq?: number,
  ): Promise<{ readonly ok: true; readonly result: JsonValue | undefined } | { readonly ok: false; readonly result: GroupHubResult }> {
    const now = this.now().toISOString()
    // One commit id names one external effect. A retry reads the record instead
    // of writing a second issue or comment.
    const existing = externalOpForCommit(this.ledger, commitId, kind)
    if (existing) {
      if (existing.state === 'confirmed') return { ok: true, result: existing.result }
      if (existing.state !== 'failed') return { ok: false, result: err('UPSTREAM_ERROR', `${kind} for ${commitId} is ${existing.state}; read back before retrying`) }
    }
    const begun = beginExternalOp(this.ledger, {
      opId: this.idFactory(), commitId, kind, ownerAgentId,
      ...(opSeq === undefined ? {} : { opSeq }),
      params: params as JsonValue,
    }, now)
    const operations = new Map(this.ledger.operations).set(begun.op.opId, begun.op)
    this.ledger = markExternalOpInflight({ operations }, begun.op.opId, now)
    // Persist before the awaited write: a crash leaves a recorded unknown op.
    this.save()
    const receipt = this.executeExternalOp
      ? await this.executeExternalOp(begun.op)
      : await this.delegatedReceipt(begun.op)
    if ('code' in receipt) {
      this.ledger = { operations: new Map(this.ledger.operations).set(begun.op.opId, { ...begun.op, state: 'unknown', error: { code: receipt.code, message: receipt.message }, updatedAt: now }) }
      this.save()
      return { ok: false, result: err(receipt.code, receipt.message) }
    }
    if (receipt.state === 'unknown') {
      // The outcome is a fact even without a confirmed result: persist it so a
      // restart keeps the unknown instead of relabeling the op inflight.
      this.ledger = { operations: new Map(this.ledger.operations).set(begun.op.opId, { ...begun.op, state: 'unknown', updatedAt: now }) }
      this.save()
      return { ok: false, result: err('UPSTREAM_ERROR', `${kind} outcome is unknown; read back before retrying`) }
    }
    if (receipt.state === 'failed') {
      // A definite refusal is persisted with its own code: recovery must see it
      // as failed, never as a second attempt at an unknown.
      this.ledger = authenticateExternalOpReceipt(this.ledger, receipt, this.now().toISOString()).ledger
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

function readServiceError(value: unknown): ServiceError | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return typeof record.code === 'string' && typeof record.message === 'string'
    ? { code: record.code as ServiceError['code'], message: record.message }
    : undefined
}

function readObservedState(result: JsonValue | undefined): IssueState | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  const value = (result as Record<string, unknown>).actualState
  return value === 'open' || value === 'closed' ? value : undefined
}

export function createGroupHub(deps: GroupHubDeps = {}): GroupHubImpl {
  return new GroupHubImpl(deps)
}

