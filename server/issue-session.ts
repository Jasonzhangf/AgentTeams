import type { JsonValue } from '../control-protocol/agent-services.ts'
import type { ExternalOpState, IssueSession, IssueState } from '../control-protocol/group-wire.ts'

/**
 * Issue session truth for the group messaging increment.
 *
 * One issue owns exactly one session, bound to groupId + vikunjaProjectId +
 * vikunjaIssueId. Vikunja remains the owner of the open/closed state; this
 * module stores a projection that changes only after a readback. Open and close
 * operations carry a monotonic `opSeq`, so recovery can tell which intent is
 * newer instead of writing an old target state back over a newer change.
 */

export type IssueOperationKind = 'issue.close' | 'issue.reopen'

export interface IssueSessionOperation {
  readonly opId: string
  readonly commitId: string
  readonly sessionId: string
  readonly kind: IssueOperationKind
  readonly state: ExternalOpState
  readonly targetState: IssueState
  readonly opSeq: number
  readonly reason: string
  readonly conclusion?: string
  readonly evidence?: JsonValue
  readonly remainingActions?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface IssueSessionRegistry {
  readonly sessions: ReadonlyMap<string, IssueSession>
  readonly operations: readonly IssueSessionOperation[]
}

export interface OpenIssueSessionInput {
  readonly sessionId: string
  readonly groupId: string
  readonly vikunjaProjectId: string
  readonly vikunjaIssueId: string
  readonly initiatorAgentId: string
}

export interface CloseIssueSessionInput {
  readonly sessionId: string
  readonly commitId: string
  readonly reason: string
  readonly conclusion: string
  readonly evidence?: JsonValue
}

export interface ReopenIssueSessionInput {
  readonly sessionId: string
  readonly commitId: string
  readonly reason: string
  readonly remainingActions?: readonly string[]
}

export interface ExternalStateDecisionInput {
  readonly session: IssueSession
  readonly operations: readonly IssueSessionOperation[]
  readonly operation: IssueSessionOperation
  readonly externalState: IssueState
  readonly externalOpSeq?: number
  readonly now: string
}

export type ExternalStateDecision =
  | { readonly outcome: 'applied'; readonly session: IssueSession }
  | { readonly outcome: 'conflict'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string }

export interface ConfirmIssueOperationInput {
  readonly commitId: string
  readonly externalState: IssueState
  readonly externalOpSeq?: number
}

function fail(message: string): never {
  throw new Error(`issue-session: ${message}`)
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return value
}

function requireOrdinal(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`)
  return value
}

function timestampOf(value: string, label: string): number {
  requireText(value, label)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) fail(`${label} must be an ISO timestamp`)
  return parsed
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameJson(value, right[index]))
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  const leftObject = left as { readonly [key: string]: JsonValue }
  const rightObject = right as { readonly [key: string]: JsonValue }
  return leftKeys.every(key => sameJson(leftObject[key], rightObject[key]))
}

function sameTexts(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sessionOf(state: IssueSessionRegistry, sessionId: string): IssueSession {
  const session = state.sessions.get(requireText(sessionId, 'sessionId'))
  if (!session) fail(`unknown session ${sessionId}`)
  return session
}

function replaceSession(state: IssueSessionRegistry, session: IssueSession): IssueSessionRegistry {
  const sessions = new Map(state.sessions)
  sessions.set(session.sessionId, session)
  return { sessions, operations: state.operations }
}

function replaceOperation(state: IssueSessionRegistry, operation: IssueSessionOperation): IssueSessionRegistry {
  return {
    sessions: state.sessions,
    operations: state.operations.map(entry => (entry.opId === operation.opId ? operation : entry)),
  }
}

function operationOf(state: IssueSessionRegistry, commitId: string): IssueSessionOperation | undefined {
  return state.operations.find(entry => entry.commitId === commitId)
}

export function createIssueSessionRegistry(): IssueSessionRegistry {
  return { sessions: new Map(), operations: [] }
}

export function openIssueSession(
  state: IssueSessionRegistry,
  input: OpenIssueSessionInput,
  now: string,
): IssueSessionRegistry {
  const sessionId = requireText(input.sessionId, 'sessionId')
  const groupId = requireText(input.groupId, 'groupId')
  const vikunjaProjectId = requireText(input.vikunjaProjectId, 'vikunjaProjectId')
  const vikunjaIssueId = requireText(input.vikunjaIssueId, 'vikunjaIssueId')
  const initiatorAgentId = requireText(input.initiatorAgentId, 'initiatorAgentId')
  timestampOf(now, 'now')
  if (state.sessions.has(sessionId)) fail(`session ${sessionId} already exists`)
  for (const session of state.sessions.values()) {
    if (session.groupId === groupId
      && session.vikunjaProjectId === vikunjaProjectId
      && session.vikunjaIssueId === vikunjaIssueId) {
      fail(`issue ${vikunjaProjectId}/${vikunjaIssueId} is already bound to session ${session.sessionId}`)
    }
  }
  const session: IssueSession = {
    sessionId,
    groupId,
    vikunjaProjectId,
    vikunjaIssueId,
    initiatorAgentId,
    state: 'open',
    openedAt: now,
    lastOpSeq: 0,
  }
  return replaceSession(state, session)
}

export function sessionOfIssue(state: IssueSessionRegistry, sessionId: string): IssueSession {
  return sessionOf(state, sessionId)
}

export function sessionForIssue(
  state: IssueSessionRegistry,
  groupId: string,
  vikunjaProjectId: string,
  vikunjaIssueId: string,
): IssueSession {
  const session = [...state.sessions.values()].find(entry =>
    entry.groupId === groupId
    && entry.vikunjaProjectId === vikunjaProjectId
    && entry.vikunjaIssueId === vikunjaIssueId)
  if (!session) fail(`no session is bound to issue ${groupId}/${vikunjaProjectId}/${vikunjaIssueId}`)
  return session
}

export function listIssueSessions(state: IssueSessionRegistry, groupId?: string): readonly IssueSession[] {
  return [...state.sessions.values()]
    .filter(session => groupId === undefined || session.groupId === groupId)
    .sort((left, right) => left.openedAt.localeCompare(right.openedAt) || left.sessionId.localeCompare(right.sessionId))
}

export function operationsForSession(state: IssueSessionRegistry, sessionId: string): readonly IssueSessionOperation[] {
  return state.operations
    .filter(operation => operation.sessionId === sessionId)
    .sort((left, right) => left.opSeq - right.opSeq)
}

/** Records a close intent. The projection stays open until a readback confirms it. */
export function closeIssueSession(
  state: IssueSessionRegistry,
  input: CloseIssueSessionInput,
  now: string,
): IssueSessionRegistry {
  return recordOperation(state, {
    ...input,
    kind: 'issue.close',
    targetState: 'closed',
  }, now)
}

/** Records a reopen intent. It never revives an old action. */
export function reopenIssueSession(
  state: IssueSessionRegistry,
  input: ReopenIssueSessionInput,
  now: string,
): IssueSessionRegistry {
  return recordOperation(state, {
    ...input,
    kind: 'issue.reopen',
    targetState: 'open',
  }, now)
}

interface RecordOperationInput {
  readonly sessionId: string
  readonly commitId: string
  readonly reason: string
  readonly kind: IssueOperationKind
  readonly targetState: IssueState
  readonly conclusion?: string
  readonly evidence?: JsonValue
  readonly remainingActions?: readonly string[]
}

function recordOperation(state: IssueSessionRegistry, input: RecordOperationInput, now: string): IssueSessionRegistry {
  const commitId = requireText(input.commitId, 'commitId')
  const reason = requireText(input.reason, 'reason')
  timestampOf(now, 'now')
  const session = sessionOf(state, input.sessionId)
  const existing = operationOf(state, commitId)
  if (existing) {
    if (existing.sessionId === session.sessionId
      && existing.kind === input.kind
      && existing.reason === reason
      && existing.conclusion === input.conclusion
      && sameJson(existing.evidence, input.evidence)
      && sameTexts(existing.remainingActions, input.remainingActions)) {
      return state
    }
    fail(`commitId ${commitId} conflicts with an existing open/close operation`)
  }
  if (input.kind === 'issue.close' && session.state !== 'open') fail(`session ${session.sessionId} is not open`)
  if (input.kind === 'issue.reopen' && session.state !== 'closed') fail(`session ${session.sessionId} is not closed`)
  const opSeq = Math.max(
    session.lastOpSeq,
    ...state.operations.filter(operation => operation.sessionId === session.sessionId).map(operation => operation.opSeq),
  ) + 1
  const operation: IssueSessionOperation = {
    opId: `issue-op:${session.sessionId}:${commitId}`,
    commitId,
    sessionId: session.sessionId,
    kind: input.kind,
    state: 'pending',
    targetState: input.targetState,
    opSeq,
    reason,
    ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    ...(input.remainingActions === undefined ? {} : { remainingActions: [...input.remainingActions] }),
    createdAt: now,
    updatedAt: now,
  }
  return {
    sessions: new Map(state.sessions).set(session.sessionId, { ...session, lastOpSeq: opSeq }),
    operations: [...state.operations, operation],
  }
}

/**
 * Compares an external readback with one local open/close intent.
 *
 * Applied needs the observed state to match the intent and no newer operation to
 * exist. A newer local or external op, or a state that contradicts the recorded
 * ordinal, is a conflict. A differing state whose order cannot be established is
 * unknown. The function never returns an instruction to write the old target
 * back; recovery is readback only.
 */
export function decideExternalState(input: ExternalStateDecisionInput): ExternalStateDecision {
  timestampOf(input.now, 'now')
  if (input.operation.sessionId !== input.session.sessionId) {
    return { outcome: 'conflict', reason: 'operation does not belong to the session' }
  }
  if (input.externalOpSeq !== undefined) requireOrdinal(input.externalOpSeq, 'externalOpSeq')
  const newerLocal = input.operations.some(operation =>
    operation.sessionId === input.session.sessionId
    && operation.opSeq > input.operation.opSeq
    && operation.state !== 'failed')
  if (newerLocal) {
    return { outcome: 'conflict', reason: 'a newer local open/close operation exists' }
  }
  if (input.externalOpSeq !== undefined && input.externalOpSeq > input.operation.opSeq) {
    return { outcome: 'conflict', reason: 'a newer external open/close operation exists' }
  }
  if (input.externalState !== input.operation.targetState) {
    if (input.externalOpSeq === input.operation.opSeq) {
      return { outcome: 'conflict', reason: 'external state contradicts the recorded operation ordinal' }
    }
    if (input.externalOpSeq !== undefined && input.externalOpSeq < input.operation.opSeq) {
      return { outcome: 'unknown', reason: 'the external observation predates the intent' }
    }
    return { outcome: 'unknown', reason: 'external state differs and the operation order is unknown' }
  }
  if (input.externalOpSeq !== undefined && input.externalOpSeq < input.operation.opSeq) {
    return { outcome: 'unknown', reason: 'the external observation predates the intent' }
  }
  const closedAt = input.externalState === 'closed'
    ? (input.session.state === 'closed' && input.session.closedAt !== undefined ? input.session.closedAt : input.now)
    : undefined
  return {
    outcome: 'applied',
    session: {
      sessionId: input.session.sessionId,
      groupId: input.session.groupId,
      vikunjaProjectId: input.session.vikunjaProjectId,
      vikunjaIssueId: input.session.vikunjaIssueId,
      initiatorAgentId: input.session.initiatorAgentId,
      state: input.externalState,
      openedAt: input.session.openedAt,
      ...(closedAt === undefined ? {} : { closedAt }),
      lastOpSeq: Math.max(input.session.lastOpSeq, input.operation.opSeq),
    },
  }
}

/** Marks one recorded intent unknown without touching the projection. */
export function markIssueOperationUnknown(
  state: IssueSessionRegistry,
  commitId: string,
  now: string,
): IssueSessionRegistry {
  timestampOf(now, 'now')
  const operation = operationOf(state, requireText(commitId, 'commitId'))
  if (!operation) fail(`unknown operation commitId ${commitId}`)
  if (operation.state === 'confirmed' || operation.state === 'failed') return state
  return replaceOperation(state, { ...operation, state: 'unknown', updatedAt: now })
}

/** Settles one intent that the external write did not confirm. */
export function settleIssueOperation(
  state: IssueSessionRegistry,
  commitId: string,
  outcome: 'failed' | 'unknown',
  now: string,
): IssueSessionRegistry {
  timestampOf(now, 'now')
  const operation = operationOf(state, requireText(commitId, 'commitId'))
  if (!operation) fail(`unknown operation commitId ${commitId}`)
  if (operation.state === 'confirmed') return state
  return replaceOperation(state, { ...operation, state: outcome, updatedAt: now })
}

/** A restart re-exposes every recorded but unconfirmed intent as unknown. */
export function reconcileIssueSessions(state: IssueSessionRegistry, now: string): IssueSessionRegistry {
  timestampOf(now, 'now')
  let operations = state.operations
  for (const operation of state.operations) {
    if (operation.state === 'pending' || operation.state === 'inflight') {
      operations = operations.map(entry => (entry.opId === operation.opId ? { ...entry, state: 'unknown', updatedAt: now } : entry))
    }
  }
  return operations === state.operations ? state : { sessions: state.sessions, operations }
}

/**
 * Applies an observed external state from a read. Vikunja owns open/closed, so a
 * confirmed read converges the projection without writing anything back.
 */
export function reconcileIssueSession(
  state: IssueSessionRegistry,
  input: { readonly sessionId: string; readonly state: IssueState; readonly now: string },
): IssueSessionRegistry {
  timestampOf(input.now, 'now')
  const session = sessionOf(state, input.sessionId)
  if (session.state === input.state) return state
  const closedAt = input.state === 'closed' ? (session.closedAt ?? input.now) : undefined
  return replaceSession(state, {
    sessionId: session.sessionId,
    groupId: session.groupId,
    vikunjaProjectId: session.vikunjaProjectId,
    vikunjaIssueId: session.vikunjaIssueId,
    initiatorAgentId: session.initiatorAgentId,
    state: input.state,
    openedAt: session.openedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
    lastOpSeq: session.lastOpSeq,
  })
}

/**
 * Applies a confirmed readback. Only an applied decision changes the projection;
 * conflict and unknown mark the operation unknown and leave the projection alone.
 */
export function confirmIssueOperation(
  state: IssueSessionRegistry,
  input: ConfirmIssueOperationInput,
  now: string,
): { readonly state: IssueSessionRegistry; readonly decision: ExternalStateDecision } {
  timestampOf(now, 'now')
  const operation = operationOf(state, requireText(input.commitId, 'commitId'))
  if (!operation) fail(`unknown operation commitId ${input.commitId}`)
  const session = sessionOf(state, operation.sessionId)
  const decision = decideExternalState({
    session,
    operations: state.operations,
    operation,
    externalState: input.externalState,
    ...(input.externalOpSeq === undefined ? {} : { externalOpSeq: input.externalOpSeq }),
    now,
  })
  const nextOperation: IssueSessionOperation = {
    ...operation,
    state: decision.outcome === 'applied' ? 'confirmed' : 'unknown',
    updatedAt: now,
  }
  const withOperation = replaceOperation(state, nextOperation)
  return {
    state: decision.outcome === 'applied' ? replaceSession(withOperation, decision.session) : withOperation,
    decision,
  }
}
