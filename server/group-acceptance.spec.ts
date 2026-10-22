import { describe, expect, it } from 'vitest'
import type { ExternalOp } from '../control-protocol/group-wire.ts'
import {
  applyCancelConfirmation,
  authenticateExternalOpReceipt,
  decideExternalConvergence,
  type ExternalOpReceipt,
} from './group-external-ops.ts'
import { createAction, createActionRegistry, startAction, submitActionResult } from './action-registry.ts'
import { createGroupHub, type GroupHubSnapshot, type GroupHubStore } from './group-hub.ts'
import { canTransitionAction } from '../control-protocol/group-wire.ts'

/**
 * Batch-1 acceptance evidence. Each test names the design item it proves. The
 * three counter-examples are required by section 18 and are grouped last.
 */

const OWNER = { agentId: 'agent-a', accountId: 'acct', scopeId: 'scope' }
const PEER = { agentId: 'agent-b', accountId: 'acct', scopeId: 'scope' }
const MASTER = { agentId: 'agent-c', accountId: 'acct', scopeId: 'scope' }

function store(): GroupHubStore {
  let current: GroupHubSnapshot | undefined
  return { load: () => current, save: (snapshot) => { current = snapshot } }
}

type Executor = (op: ExternalOp) => Promise<ExternalOpReceipt | { code: 'UNAVAILABLE'; message: string }>

function build(executor: Executor) {
  return createGroupHub({
    store: store(),
    isOnline: (id) => ['agent-a', 'agent-b', 'agent-c'].includes(id),
    executeExternalOp: executor,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
  })
}

function confirmed(op: ExternalOp, result: unknown): ExternalOpReceipt {
  return { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'confirmed', result: result as never }
}

function issueOk(op: ExternalOp): ExternalOpReceipt {
  if (op.kind === 'issue.create') return confirmed(op, { issueId: '42' })
  if (op.kind === 'issue.close') return confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
  if (op.kind === 'issue.reopen') return confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
  return confirmed(op, { resultRef: 'comment:1' })
}

async function group(hub: ReturnType<typeof createGroupHub>) {
  const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'g0', name: 'release' })
  if (!created.ok) throw new Error('create failed')
  const groupId = (created.reply as { group: { groupId: string } }).group.groupId
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'g1', groupId, agentId: 'agent-b', role: 'peer' })
  await hub.handle(PEER, { kind: 'group.respond', requestId: 'g2', groupId, accept: true })
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'g3', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b'] })
  await hub.handle(MASTER, { kind: 'group.respond', requestId: 'g4', groupId, accept: true })
  return groupId
}

async function session(hub: ReturnType<typeof createGroupHub>, groupId: string) {
  const created = await hub.handle(MASTER, { kind: 'issue.create', requestId: 'i0', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 'ship', body: 'b' })
  if (!created.ok) throw new Error(`issue create failed: ${created.error.message}`)
  return (created.reply as { session: { sessionId: string } }).session.sessionId
}

describe('section 18 acceptance items', () => {
  it('item 9 denies a cross-group reference and an unauthorised assignment', async () => {
    const hub = build(async (op) => issueOk(op))
    const groupId = await group(hub)
    const sessionId = await session(hub, groupId)
    const other = await hub.handle(OWNER, { kind: 'group.create', requestId: 'o0', name: 'other' })
    const otherGroupId = (other.reply as { group: { groupId: string } }).group.groupId
    const foreign = await hub.handle(MASTER, { kind: 'issue.reference', requestId: 'x0', commitId: 'xc1', groupId: otherGroupId, vikunjaIssueId: '42' })
    expect(foreign.ok).toBe(false)
    const noEdge = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'x1', commitId: 'xa1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'review', reason: 'r', expectedResult: 'e', replyRequired: false,
    })
    expect(noEdge.ok).toBe(false)
    expect(noEdge.ok ? '' : noEdge.error.code).toBe('FORBIDDEN')
  })

  it('item 11 executes an action whose replyRequired is false', async () => {
    const hub = build(async (op) => issueOk(op))
    const groupId = await group(hub)
    const sessionId = await session(hub, groupId)
    const created = await hub.handle(MASTER, {
      kind: 'action.create', requestId: 'a0', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: false,
    })
    expect(created.ok).toBe(true)
    const actionId = (created.reply as { action: { actionId: string } }).action.actionId
    const submitted = await hub.handle(PEER, { kind: 'action.submit', requestId: 'a1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(submitted.ok).toBe(true)
    expect((submitted.reply as { action: { state: string } }).action.state).toBe('completed')
  })

  it('item 6 does not report completion when the result write fails', async () => {
    const hub = build(async (op) => op.kind === 'action.result'
      ? { code: 'UNAVAILABLE', message: 'vikunja down' }
      : issueOk(op))
    const groupId = await group(hub)
    const sessionId = await session(hub, groupId)
    const created = await hub.handle(MASTER, {
      kind: 'action.create', requestId: 'a0', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (created.reply as { action: { actionId: string } }).action.actionId
    const submitted = await hub.handle(PEER, { kind: 'action.submit', requestId: 'a1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(submitted.ok).toBe(false)
    const listed = await hub.handle(MASTER, { kind: 'action.list', requestId: 'a2', sessionId })
    const state = (listed.reply as { actions: readonly { actionId: string; state: string }[] }).actions.find((a) => a.actionId === actionId)?.state
    expect(state).not.toBe('completed')
  })

  it('item 7 does not confirm a close whose external write failed', async () => {
    const hub = build(async (op) => op.kind === 'issue.close'
      ? { code: 'FORBIDDEN', message: 'permission denied' }
      : issueOk(op))
    const groupId = await group(hub)
    const sessionId = await session(hub, groupId)
    const closed = await hub.handle(MASTER, { kind: 'issue.close', requestId: 'c0', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'x' })
    expect(closed.ok).toBe(false)
    const queried = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q0', sessionId })
    expect((queried.reply as { session: { state: string } }).session.state).toBe('open')
  })

  it('item 15 covers both directions with one edge and rejects an unrelated pair', async () => {
    const hub = build(async (op) => issueOk(op))
    const groupId = await group(hub)
    const sessionId = await session(hub, groupId)
    const assign = await hub.handle(MASTER, {
      kind: 'action.create', requestId: 'e0', commitId: 'ec1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'review', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(assign.ok).toBe(true)
    const request = await hub.handle(PEER, {
      kind: 'action.create', requestId: 'e1', commitId: 'ec2', sessionId,
      assigneeAgentId: 'agent-c', actionKind: 'reply', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(request.ok).toBe(true)
    const unrelated = await hub.handle(PEER, {
      kind: 'action.create', requestId: 'e2', commitId: 'ec3', sessionId,
      assigneeAgentId: 'agent-a', actionKind: 'reply', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(unrelated.ok).toBe(false)
    expect(unrelated.ok ? '' : unrelated.error.code).toBe('FORBIDDEN')
  })
})

describe('the three required counter-examples', () => {
  it('counter-example 16: a stale close never overwrites a newer reopen', () => {
    // The close is ordinal 1, the reopen already reached ordinal 2.
    const staleAfterReopen = decideExternalConvergence({ opSeq: 1, lastOpSeq: 2, observed: 'open', intended: 'closed' })
    expect(staleAfterReopen).toBe('conflict')
    const newestOpen = decideExternalConvergence({ opSeq: 2, lastOpSeq: 2, observed: 'open', intended: 'open' })
    expect(newestOpen).toBe('applied')
  })

  it('counter-example 16 at the hub: an unconfirmable close is unknown, not closed', async () => {
    const hub = build(async (op) => op.kind === 'issue.close'
      ? { code: 'UNAVAILABLE', message: 'read back failed' }
      : issueOk(op))
    const groupId = await group(hub)
    const sessionId = await session(hub, groupId)
    const closed = await hub.handle(MASTER, { kind: 'issue.close', requestId: 'c0', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'x' })
    expect(closed.ok).toBe(false)
    const queried = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q0', sessionId })
    expect((queried.reply as { session: { state: string } }).session.state).toBe('open')
  })

  it('counter-example 17: cancel is observable in three steps and a real result is kept', () => {
    const now = '2026-10-22T00:00:00.000Z'
    expect(canTransitionAction('in_progress', 'cancel_requested')).toBe(true)
    expect(canTransitionAction('cancel_requested', 'cancelled')).toBe(true)
    expect(canTransitionAction('cancel_requested', 'completed')).toBe(true)
    const requested = {
      actionId: 'a1', sessionId: 's1', initiatorAgentId: 'agent-c', assigneeAgentId: 'agent-b',
      kind: 'review' as const, state: 'cancel_requested' as const, reason: 'r', expectedResult: 'e',
      replyRequired: false, createdAt: now, updatedAt: now,
    }
    // Step two: without a stop confirmation the action is unknown, never cancelled.
    const unconfirmed = applyCancelConfirmation(requested, false, now)
    expect(unconfirmed.state).toBe('unknown')
    const stopped = applyCancelConfirmation(requested, true, now)
    expect(stopped.state).toBe('cancelled')
    // A real result that lands while the action runs is kept, not discarded.
    let registry = createActionRegistry()
    registry = createAction(registry, {
      commitId: 'ac1', sessionId: 's1', initiatorAgentId: 'agent-c', assigneeAgentId: 'agent-b',
      kind: 'review', reason: 'r', expectedResult: 'e', replyRequired: false,
    }, now).state
    const actionId = [...registry.actions.values()][0].actionId
    registry = startAction(registry, actionId, now)
    const submitted = submitActionResult(registry, { actionId, resultCommitId: 'rc1', resultRef: 'comment:1' }, now)
    expect(submitted.action.state).toBe('completed')
    expect(submitted.action.resultRef).toBe('comment:1')
  })

  it('counter-example 18: a forged receipt cannot move the projection', async () => {
    const hub = build(async (op) => issueOk(op))
    const groupId = await group(hub)
    const sessionId = await session(hub, groupId)
    // A member that is not the delegated owner sends a matching op receipt.
    const forged = await hub.handle(OWNER, {
      kind: 'op.confirmed', opId: 'id-1', commitId: 'ic1', result: { issueId: 'evil' },
    })
    expect(forged.ok).toBe(true)
    const queried = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q0', sessionId })
    expect((queried.reply as { session: { vikunjaIssueId: string } }).session.vikunjaIssueId).toBe('42')
    // The pure authenticator agrees.
    const ledger = {
      operations: new Map([['op-1', {
        opId: 'op-1', commitId: 'c', kind: 'issue.create' as const, state: 'inflight' as const,
        ownerAgentId: 'agent-a', params: {}, updatedAt: '2026-10-22T00:00:00.000Z',
      }]]),
    }
    expect(() => authenticateExternalOpReceipt(ledger, { opId: 'op-1', commitId: 'c', fromAgentId: 'agent-b', state: 'confirmed' }))
      .toThrow(/came from agent-b/u)
  })
})
