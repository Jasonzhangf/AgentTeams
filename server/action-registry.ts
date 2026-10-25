import type { JsonValue } from '../packages/shared/src/agent-services.ts'
import type { Action, ActionKind, ActionState } from '../packages/shared/src/group-wire.ts'
import {
  actionNeedsExecutionFor,
  canTransitionAction,
  parseGroupAction,
} from '../packages/shared/src/group-wire.ts'

/**
 * Action truth for the group messaging increment.
 *
 * `assigneeAgentId` is the only source of responsibility. `replyRequired` only
 * decides whether the initiator expects an answer; it never gates execution.
 * Creation is idempotent by `commitId`, result submission by `resultCommitId`,
 * and state changes are limited to the edges declared by `group-wire.ts`.
 */

export interface ActionRegistryState {
  readonly actions: ReadonlyMap<string, Action>
}

export interface CreateActionInput {
  readonly commitId: string
  readonly sessionId: string
  readonly initiatorAgentId: string
  readonly assigneeAgentId: string
  readonly kind: ActionKind
  readonly reason: string
  readonly expectedResult: string
  readonly replyRequired: boolean
  readonly replyRequiredReason?: string
  readonly inReplyToActionId?: string
}

export interface SubmitActionResultInput {
  readonly actionId: string
  readonly resultCommitId: string
  readonly resultRef: string
}

export interface TransitionOptions {
  readonly resultCommitId?: string
  readonly resultRef?: string
}

function fail(message: string): never {
  throw new Error(`action-registry: ${message}`)
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

function actionIdFor(commitId: string): string {
  return `action:${commitId}`
}

function getAction(state: ActionRegistryState, actionId: string): Action {
  const action = state.actions.get(requireText(actionId, 'actionId'))
  if (!action) fail(`unknown action ${actionId}`)
  return action
}

function replaceAction(state: ActionRegistryState, action: Action): ActionRegistryState {
  return { actions: new Map(state.actions).set(action.actionId, action) }
}

function sameCreation(action: Action, input: CreateActionInput): boolean {
  return action.sessionId === input.sessionId
    && action.initiatorAgentId === input.initiatorAgentId
    && action.assigneeAgentId === input.assigneeAgentId
    && action.kind === input.kind
    && action.reason === input.reason
    && action.expectedResult === input.expectedResult
    && action.replyRequired === input.replyRequired
    && action.replyRequiredReason === input.replyRequiredReason
    && action.inReplyToActionId === input.inReplyToActionId
}

function transition(
  state: ActionRegistryState,
  actionId: string,
  to: ActionState,
  now: string,
  options: TransitionOptions = {},
): { readonly state: ActionRegistryState; readonly action: Action } {
  timestampOf(now, 'now')
  const action = getAction(state, actionId)
  if (action.state === to) fail(`action ${action.actionId} is already ${to}`)
  if (!canTransitionAction(action.state, to)) {
    fail(`cannot transition action ${action.actionId} from ${action.state} to ${to}`)
  }
  let resultCommitId: string | undefined
  let resultRef: string | undefined
  if (to === 'completed') {
    resultCommitId = requireText(options.resultCommitId ?? '', 'resultCommitId')
    resultRef = requireText(options.resultRef ?? '', 'resultRef')
  }
  const next: Action = {
    ...action,
    state: to,
    ...(to === 'completed' ? { resultCommitId, resultRef, completedAt: now } : {}),
    ...(to === 'cancelled' && action.state === 'cancel_requested' ? { executionStopped: true } : {}),
  }
  return { state: replaceAction(state, next), action: next }
}

export function createActionRegistry(): ActionRegistryState {
  return { actions: new Map() }
}

/**
 * Creates a pending action or returns the original record for the same commit.
 * Same commit with different content is a conflict, never a second record.
 */
export function createAction(
  state: ActionRegistryState,
  input: CreateActionInput,
  now: string,
): { readonly state: ActionRegistryState; readonly action: Action } {
  const commitId = requireText(input.commitId, 'commitId')
  requireText(input.sessionId, 'sessionId')
  requireText(input.initiatorAgentId, 'initiatorAgentId')
  requireText(input.assigneeAgentId, 'assigneeAgentId')
  requireText(input.reason, 'reason')
  requireText(input.expectedResult, 'expectedResult')
  timestampOf(now, 'now')
  const existing = [...state.actions.values()].find(action => action.commitId === commitId)
  if (existing) {
    if (sameCreation(existing, input)) return { state, action: existing }
    fail(`commitId ${commitId} conflicts with an existing action`)
  }
  if (input.inReplyToActionId !== undefined) {
    const target = getAction(state, input.inReplyToActionId)
    if (target.sessionId !== input.sessionId) fail('inReplyToActionId must belong to the same session')
  }
  const action: Action = {
    actionId: actionIdFor(commitId),
    commitId,
    sessionId: input.sessionId,
    initiatorAgentId: input.initiatorAgentId,
    assigneeAgentId: input.assigneeAgentId,
    kind: input.kind,
    reason: input.reason,
    expectedResult: input.expectedResult,
    replyRequired: input.replyRequired,
    ...(input.replyRequiredReason === undefined ? {} : { replyRequiredReason: input.replyRequiredReason }),
    ...(input.inReplyToActionId === undefined ? {} : { inReplyToActionId: input.inReplyToActionId }),
    state: 'pending',
    createdAt: now,
  }
  return { state: replaceAction(state, action), action }
}

export function actionOf(state: ActionRegistryState, actionId: string): Action {
  return getAction(state, actionId)
}

/** Action list for one session, or every action when the session is omitted. */
export function listActions(state: ActionRegistryState, sessionId?: string): readonly Action[] {
  return [...state.actions.values()]
    .filter(action => sessionId === undefined || action.sessionId === sessionId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.actionId.localeCompare(right.actionId))
}

/**
 * Execution eligibility. Reuses the wire owner so `replyRequired` can never
 * become a second gate: only assignee and terminal state decide.
 */
export function actionExecutableBy(state: ActionRegistryState, actionId: string, agentId: string): boolean {
  return actionNeedsExecutionFor(getAction(state, actionId), agentId)
}

export function executableActionsFor(
  state: ActionRegistryState,
  agentId: string,
  sessionId?: string,
): readonly Action[] {
  return listActions(state, sessionId).filter(action => actionNeedsExecutionFor(action, agentId))
}

/**
 * Generic state edge. Completion is special: it requires a stable result commit
 * and a result reference, so a bare transition cannot fake a completed action.
 */
export function transitionAction(
  state: ActionRegistryState,
  actionId: string,
  to: ActionState,
  now: string,
  options: TransitionOptions = {},
): ActionRegistryState {
  return transition(state, actionId, to, now, options).state
}

export function acceptAction(state: ActionRegistryState, actionId: string, now: string): ActionRegistryState {
  return transitionAction(state, actionId, 'accepted', now)
}

export function startAction(state: ActionRegistryState, actionId: string, now: string): ActionRegistryState {
  return transitionAction(state, actionId, 'in_progress', now)
}

export function refuseAction(state: ActionRegistryState, actionId: string, now: string): ActionRegistryState {
  return transitionAction(state, actionId, 'refused', now)
}

export function reportAction(
  state: ActionRegistryState,
  actionId: string,
  report: 'blocked' | 'failed',
  now: string,
  detail: { readonly reason: string; readonly evidence?: JsonValue } = { reason: '' },
): ActionRegistryState {
  const transitioned = transition(state, actionId, report, now).state
  // The report is the record of why the assignee stopped: keep its reason and
  // evidence on the action itself, so a refresh shows the same facts.
  const actions = new Map(transitioned.actions)
  const action = getAction(transitioned, actionId)
  actions.set(actionId, {
    ...action,
    report: {
      report,
      reason: detail.reason,
      ...(detail.evidence === undefined ? {} : { evidence: detail.evidence }),
      reportedAt: now,
    },
  })
  return { actions }
}

/**
 * Pending work is cancelled immediately. Accepted or in-flight work only enters
 * `cancel_requested`; `in_progress -> cancelled` is not an allowed edge.
 */
export function requestActionCancel(state: ActionRegistryState, actionId: string, now: string): ActionRegistryState {
  const action = getAction(state, actionId)
  if (action.state === 'pending') return transitionAction(state, actionId, 'cancelled', now)
  if (action.state === 'accepted' || action.state === 'in_progress') {
    return transitionAction(state, actionId, 'cancel_requested', now)
  }
  fail(`action ${action.actionId} cannot be cancelled from ${action.state}`)
}

/** Only a stop confirmation moves cancel_requested to the terminal cancelled state. */
export function confirmActionStopped(state: ActionRegistryState, actionId: string, now: string): ActionRegistryState {
  return transitionAction(state, actionId, 'cancelled', now)
}

/**
 * No stop confirmation arrived. Keep the action non-terminal and record that the
 * physical stop is unconfirmed (`executionStopped: false`).
 */
export function markActionStopUnknown(state: ActionRegistryState, actionId: string, now: string): ActionRegistryState {
  const action = getAction(state, actionId)
  if (action.state !== 'cancel_requested') {
    fail(`action ${action.actionId} is not waiting for a stop confirmation`)
  }
  if (!canTransitionAction(action.state, 'unknown')) {
    fail(`cannot transition action ${action.actionId} from ${action.state} to unknown`)
  }
  const next: Action = { ...action, state: 'unknown', executionStopped: false }
  return replaceAction(state, next)
}

/**
 * Commits the single result for an action. Repeating the same result commit is
 * idempotent; a different result commit after completion is refused because
 * completed is terminal. A completed action always carries a result reference.
 */
export function submitActionResult(
  state: ActionRegistryState,
  input: SubmitActionResultInput,
  now: string,
): { readonly state: ActionRegistryState; readonly action: Action } {
  const actionId = requireText(input.actionId, 'actionId')
  const resultCommitId = requireText(input.resultCommitId, 'resultCommitId')
  const resultRef = requireText(input.resultRef, 'resultRef')
  timestampOf(now, 'now')
  const action = getAction(state, actionId)
  if (action.resultCommitId === resultCommitId) {
    if (action.resultRef === resultRef) return { state, action }
    fail(`resultCommitId ${resultCommitId} conflicts with the recorded result reference`)
  }
  for (const other of state.actions.values()) {
    if (other.actionId !== action.actionId && other.resultCommitId === resultCommitId) {
      fail(`resultCommitId ${resultCommitId} already belongs to action ${other.actionId}`)
    }
  }
  return transition(state, action.actionId, 'completed', now, { resultCommitId, resultRef })
}

/**
 * Restores action truth from persisted records. Every record is decoded by the
 * wire owner; duplicate identity keys and a completed action without a result
 * reference are rejected rather than repaired silently.
 */
export function restoreActionRegistry(records: unknown): ActionRegistryState {
  if (!Array.isArray(records)) fail('records must be an array')
  const actions = new Map<string, Action>()
  const commitIds = new Set<string>()
  const resultCommitIds = new Set<string>()
  for (const record of records) {
    let action: Action
    try {
      action = parseGroupAction(record)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'unknown decode failure'
      fail(`invalid action record: ${reason}`)
    }
    if (actions.has(action.actionId)) fail(`duplicate actionId ${action.actionId}`)
    if (commitIds.has(action.commitId)) fail(`duplicate action commitId ${action.commitId}`)
    if (action.resultCommitId !== undefined) {
      if (resultCommitIds.has(action.resultCommitId)) fail(`duplicate resultCommitId ${action.resultCommitId}`)
      resultCommitIds.add(action.resultCommitId)
    }
    if (action.state === 'completed' && (action.resultRef === undefined || action.resultCommitId === undefined)) {
      fail(`completed action ${action.actionId} is missing its result reference`)
    }
    actions.set(action.actionId, action)
    commitIds.add(action.commitId)
  }
  return { actions }
}
