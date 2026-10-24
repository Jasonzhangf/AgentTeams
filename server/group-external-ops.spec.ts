import { describe, expect, it } from 'vitest'
import type { Action } from '../packages/shared/src/group-wire.ts'
import {
  applyCancelConfirmation,
  authenticateExternalOpReceipt,
  beginExternalOp,
  closeReportUnstopped,
  createExternalOpLedger,
  decideExternalConvergence,
  markExternalOpInflight,
  reconcileAfterRestart,
  releaseAfterCancellation,
} from './group-external-ops.ts'

const now = '2026-10-22T00:00:00.000Z'

function action(overrides: Partial<Action> = {}): Action {
  return {
    actionId: 'a1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-a',
    assigneeAgentId: 'agent-b', kind: 'review', reason: 'r', expectedResult: 'e',
    replyRequired: true, state: 'in_progress', createdAt: now, ...overrides,
  }
}

describe('external op ledger', () => {
  it('records an operation before the call and returns the stored record on repeat', () => {
    const ledger = createExternalOpLedger()
    const first = beginExternalOp(ledger, { opId: 'op1', commitId: 'c1', kind: 'issue.close', ownerAgentId: 'agent-a', params: { sessionId: 's1' }, opSeq: 2 }, now)
    expect(first.created).toBe(true)
    expect(first.op.state).toBe('pending')
    const second = beginExternalOp(first.created ? { operations: new Map([[first.op.opId, first.op]]) } : ledger, { opId: 'op1', commitId: 'c1', kind: 'issue.close', ownerAgentId: 'agent-a', params: { sessionId: 's1' }, opSeq: 2 }, now)
    expect(second.created).toBe(false)
    expect(second.op).toEqual(first.op)
  })

  it('rejects the same op id with a different commit id', () => {
    const ledger = beginExternalOp(createExternalOpLedger(), { opId: 'op1', commitId: 'c1', kind: 'issue.close', ownerAgentId: 'agent-a', params: {} }, now).op
    expect(() => beginExternalOp({ operations: new Map([[ledger.opId, ledger]]) }, { opId: 'op1', commitId: 'c2', kind: 'issue.close', ownerAgentId: 'agent-a', params: {} }, now))
      .toThrow(/different commit id/)
  })

  it('marks an operation inflight once', () => {
    const started = beginExternalOp(createExternalOpLedger(), { opId: 'op1', commitId: 'c1', kind: 'issue.create', ownerAgentId: 'agent-a', params: {} }, now).op
    const inflight = markExternalOpInflight({ operations: new Map([[started.opId, started]]) }, 'op1', now)
    expect(inflight.operations.get('op1')?.state).toBe('inflight')
    expect(markExternalOpInflight(inflight, 'op1', now)).toBe(inflight)
  })

  it('rejects an unknown op id', () => {
    expect(() => markExternalOpInflight(createExternalOpLedger(), 'missing', now)).toThrow(/unknown op/)
  })
})

describe('owner receipt authentication', () => {
  function ledgerWithOp() {
    return beginExternalOp(createExternalOpLedger(), { opId: 'op1', commitId: 'c1', kind: 'issue.close', ownerAgentId: 'agent-a', params: {} }, now).op
  }

  it('accepts a receipt from the delegated owner', () => {
    const op = ledgerWithOp()
    const result = authenticateExternalOpReceipt({ operations: new Map([[op.opId, op]]) }, { opId: 'op1', commitId: 'c1', fromAgentId: 'agent-a', state: 'confirmed', result: { done: true } }, now)
    expect(result.op.state).toBe('confirmed')
    expect(result.op.result).toEqual({ done: true })
  })

  it('rejects a receipt from a member that is not the delegated owner', () => {
    const op = ledgerWithOp()
    expect(() => authenticateExternalOpReceipt({ operations: new Map([[op.opId, op]]) }, { opId: 'op1', commitId: 'c1', fromAgentId: 'agent-b', state: 'confirmed', result: {} }, now))
      .toThrow(/owner is agent-a/)
  })

  it('rejects a receipt naming a different commit id', () => {
    const op = ledgerWithOp()
    expect(() => authenticateExternalOpReceipt({ operations: new Map([[op.opId, op]]) }, { opId: 'op1', commitId: 'other', fromAgentId: 'agent-a', state: 'confirmed', result: {} }, now))
      .toThrow(/different commit id/)
  })

  it('keeps a typed failure distinct from unknown', () => {
    const op = ledgerWithOp()
    const failed = authenticateExternalOpReceipt({ operations: new Map([[op.opId, op]]) }, { opId: 'op1', commitId: 'c1', fromAgentId: 'agent-a', state: 'failed', error: { code: 'FORBIDDEN', message: 'no token' } }, now)
    expect(failed.op.state).toBe('failed')
    expect(failed.op.error?.code).toBe('FORBIDDEN')
    expect(failed.op.state).not.toBe('unknown')
  })
})

describe('restart reconciliation', () => {
  it('exposes pending and inflight as unknown and leaves confirmed alone', () => {
    let ledger = createExternalOpLedger()
    ledger = { operations: new Map([[beginExternalOp(ledger, { opId: 'op1', commitId: 'c1', kind: 'issue.close', ownerAgentId: 'agent-a', params: {} }, now).op.opId, beginExternalOp(ledger, { opId: 'op1', commitId: 'c1', kind: 'issue.close', ownerAgentId: 'agent-a', params: {} }, now).op]]) }
    const confirmed = { ...ledger.operations.get('op1')!, opId: 'op2', state: 'confirmed' as const }
    ledger = { operations: new Map([...ledger.operations, ['op2', confirmed]]) }
    const reconciled = reconcileAfterRestart(ledger, now)
    expect(reconciled.operations.get('op1')?.state).toBe('unknown')
    expect(reconciled.operations.get('op2')?.state).toBe('confirmed')
  })
})

describe('open and close convergence', () => {
  it('applies when the newest operation is the one being decided and state matches', () => {
    expect(decideExternalConvergence({ opSeq: 3, lastOpSeq: 3, observed: 'closed', intended: 'closed' })).toBe('applied')
  })

  it('reports conflict for a stale close after a newer reopen', () => {
    expect(decideExternalConvergence({ opSeq: 2, lastOpSeq: 3, observed: 'open', intended: 'closed' })).toBe('conflict')
  })

  it('reports unknown when the operation is newer than the recorded order', () => {
    expect(decideExternalConvergence({ opSeq: 4, lastOpSeq: 3, observed: 'closed', intended: 'closed' })).toBe('unknown')
  })

  it('reports conflict when the observed state contradicts the newest operation', () => {
    expect(decideExternalConvergence({ opSeq: 3, lastOpSeq: 3, observed: 'open', intended: 'closed' })).toBe('conflict')
  })
})

describe('close report and cancellation', () => {
  it('lists actions whose stop was not confirmed', () => {
    const report = closeReportUnstopped([
      action({ actionId: 'a1', state: 'cancel_requested' }),
      action({ actionId: 'a2', state: 'unknown', executionStopped: false }),
      action({ actionId: 'a3', state: 'cancelled', executionStopped: true }),
      action({ actionId: 'a4', state: 'completed' }),
    ])
    expect(report.map((entry) => entry.actionId)).toEqual(['a1', 'a2'])
  })

  it('moves cancel_requested to cancelled only with a stop confirmation', () => {
    const stopped = applyCancelConfirmation(action({ state: 'cancel_requested' }), true, now)
    expect(stopped.state).toBe('cancelled')
    expect(stopped.executionStopped).toBe(true)
    expect(releaseAfterCancellation(stopped)).toBe(true)
  })

  it('keeps an unconfirmed stop as unknown instead of cancelled', () => {
    const unknown = applyCancelConfirmation(action({ state: 'cancel_requested' }), false, now)
    expect(unknown.state).toBe('unknown')
    expect(unknown.executionStopped).toBe(false)
    expect(releaseAfterCancellation(unknown)).toBe(false)
  })

  it('leaves an action outside cancel_requested unchanged', () => {
    const running = action({ state: 'in_progress' })
    expect(applyCancelConfirmation(running, true, now)).toBe(running)
  })
})
