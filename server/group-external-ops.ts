import type { JsonValue, ServiceError } from '../packages/shared/src/agent-services.ts'
import type { Action, ActionState, ExternalOp, ExternalOpKind, ExternalOpState } from '../packages/shared/src/group-wire.ts'

/**
 * External operation ledger and action convergence.
 *
 * The ledger records an operation before the call, so a crash or a lost reply
 * leaves evidence instead of a guess. A mutation is never re-issued to a
 * different owner: recovery reads the external state first. Only a read may be
 * re-delegated. An owner receipt is accepted only from the owner the hub
 * delegated that operation to, and only with a matching op id and commit id.
 */

export interface ExternalOpLedger {
  readonly operations: ReadonlyMap<string, ExternalOp>
}

export function createExternalOpLedger(): ExternalOpLedger {
  return { operations: new Map() }
}

export interface BeginExternalOpInput {
  readonly opId: string
  readonly commitId: string
  readonly kind: ExternalOpKind
  readonly ownerAgentId: string
  readonly params: JsonValue
  /** Monotonic open/close ordinal, required for issue.close and issue.reopen. */
  readonly opSeq?: number
}

export interface ExternalOpOutcome {
  readonly op: ExternalOp
  /** True when this call created the operation. A repeat returns the stored record. */
  readonly created: boolean
}

export function beginExternalOp(ledger: ExternalOpLedger, input: BeginExternalOpInput, now = new Date().toISOString()): ExternalOpOutcome {
  const stored = ledger.operations.get(input.opId)
  if (stored) {
    if (stored.commitId !== input.commitId) {
      throw new Error(`external-op: op ${input.opId} is bound to a different commit id`)
    }
    return { op: stored, created: false }
  }
  const op: ExternalOp = {
    opId: input.opId,
    commitId: input.commitId,
    kind: input.kind,
    state: 'pending',
    ownerAgentId: input.ownerAgentId,
    ...(input.opSeq === undefined ? {} : { opSeq: input.opSeq }),
    params: input.params,
    updatedAt: now,
  }
  const operations = new Map(ledger.operations)
  operations.set(op.opId, op)
  return { op, created: true }
}

function replaceOp(ledger: ExternalOpLedger, op: ExternalOp, now: string): ExternalOpLedger {
  const operations = new Map(ledger.operations)
  operations.set(op.opId, { ...op, updatedAt: now })
  return { operations }
}

export function markExternalOpInflight(ledger: ExternalOpLedger, opId: string, now = new Date().toISOString()): ExternalOpLedger {
  const op = ledger.operations.get(opId)
  if (!op) throw new Error(`external-op: unknown op ${opId}`)
  if (op.state !== 'pending') return ledger
  return replaceOp(ledger, { ...op, state: 'inflight' }, now)
}

export interface ExternalOpReceipt {
  readonly opId: string
  readonly commitId: string
  readonly fromAgentId: string
  readonly state: 'confirmed' | 'failed' | 'unknown'
  readonly result?: JsonValue
  readonly error?: ServiceError
  readonly reason?: string
}

/**
 * Authenticate an owner receipt before it can move a projection.
 *
 * A member that learns an op id cannot change an issue or action projection:
 * the receipt must come from the owner this op was delegated to.
 */
export function authenticateExternalOpReceipt(ledger: ExternalOpLedger, receipt: ExternalOpReceipt, now = new Date().toISOString()): { readonly ledger: ExternalOpLedger; readonly op: ExternalOp } {
  const op = ledger.operations.get(receipt.opId)
  if (!op) throw new Error('external-op: receipt names an unknown operation')
  if (op.ownerAgentId !== receipt.fromAgentId) {
    throw new Error(`external-op: receipt for ${receipt.opId} came from ${receipt.fromAgentId}, owner is ${op.ownerAgentId}`)
  }
  if (op.commitId !== receipt.commitId) {
    throw new Error(`external-op: receipt for ${receipt.opId} names a different commit id`)
  }
  const state: ExternalOpState = receipt.state
  const next: ExternalOp = {
    ...op,
    state,
    ...(receipt.result === undefined ? {} : { result: receipt.result }),
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  }
  return { ledger: replaceOp(ledger, next, now), op: next }
}

/** A restart re-exposes every in-flight operation as unknown. Nothing is replayed. */
export function reconcileAfterRestart(ledger: ExternalOpLedger, now = new Date().toISOString()): ExternalOpLedger {
  let result = ledger
  for (const op of ledger.operations.values()) {
    if (op.state === 'pending' || op.state === 'inflight') {
      result = replaceOp(result, { ...op, state: 'unknown' }, now)
    }
  }
  return result
}

export function externalOpFor(ledger: ExternalOpLedger, opId: string): ExternalOp | undefined {
  return ledger.operations.get(opId)
}

/**
 * One commit id names one external effect. A retry finds the recorded operation
 * instead of issuing a second write, even when the first reply was lost.
 */
export function externalOpForCommit(ledger: ExternalOpLedger, commitId: string, kind: ExternalOpKind): ExternalOp | undefined {
  for (const op of ledger.operations.values()) {
    if (op.commitId === commitId && op.kind === kind) return op
  }
  return undefined
}

export type Convergence = 'applied' | 'conflict' | 'unknown'

export interface ConvergenceInput {
  /** Open/close ordinal of the operation being decided. */
  readonly opSeq: number
  /** Ordinal of the newest open or close operation recorded on the session. */
  readonly lastOpSeq: number
  /** State the external system reports now. */
  readonly observed: 'open' | 'closed'
  /** State this operation intended. */
  readonly intended: 'open' | 'closed'
}

/**
 * Decide whether an open/close operation still holds.
 *
 * A stale close must not write over a later reopen, and the current state alone
 * cannot tell which operation took effect. When the order is unknown the result
 * is conflict or unknown, never a rewrite toward the old target.
 */
export function decideExternalConvergence(input: ConvergenceInput): Convergence {
  if (input.opSeq > input.lastOpSeq) return 'unknown'
  if (input.opSeq < input.lastOpSeq) return 'conflict'
  return input.observed === input.intended ? 'applied' : 'conflict'
}

export interface CloseReportEntry {
  readonly actionId: string
  readonly state: ActionState
  readonly executionStopped: boolean
}

/** Actions that were never confirmed stopped stay visible in the close report. */
export function closeReportUnstopped(actions: readonly Action[]): readonly CloseReportEntry[] {
  return actions
    .filter((action) => action.state === 'cancel_requested' || (action.state === 'unknown' && action.executionStopped !== true))
    .map((action) => ({ actionId: action.actionId, state: action.state, executionStopped: action.executionStopped === true }))
}

/**
 * An action in cancel_requested is still running. A real result that arrives
 * before the stop confirmation is kept, and a stop confirmation closes it.
 */
export function applyCancelConfirmation(action: Action, stopped: boolean, now = new Date().toISOString()): Action {
  if (action.state !== 'cancel_requested') return action
  if (stopped) return { ...action, state: 'cancelled', executionStopped: true, completedAt: now }
  return { ...action, state: 'unknown', executionStopped: false }
}

/** A cancelled action must not keep an execution slot. */
export function releaseAfterCancellation(action: Action): boolean {
  return action.state === 'cancelled' && action.executionStopped === true
}
