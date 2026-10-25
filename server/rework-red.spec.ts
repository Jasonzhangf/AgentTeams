import { describe, expect, it } from 'vitest'
import type { ExternalOp } from '../packages/shared/src/group-wire.ts'
import type { ExternalOpReceipt } from './group-external-ops.ts'
import { createGroupHub, type GroupHubSnapshot, type GroupHubStore } from './group-hub.ts'

const OWNER = { agentId: 'agent-a', accountId: 'acct', scopeId: 'scope' }
const PEER = { agentId: 'agent-b', accountId: 'acct', scopeId: 'scope' }
const MASTER = { agentId: 'agent-c', accountId: 'acct', scopeId: 'scope' }
const OUTSIDER = { agentId: 'agent-z', accountId: 'acct', scopeId: 'scope' }

function memoryStore(): GroupHubStore & { readonly snapshots: GroupHubSnapshot[] } {
  const snapshots: GroupHubSnapshot[] = []
  let current: GroupHubSnapshot | undefined
  return { snapshots, load: () => current, save: (snapshot) => { current = snapshot; snapshots.push(snapshot) } }
}

function confirmed(op: ExternalOp, result: unknown, fromAgentId = op.ownerAgentId): ExternalOpReceipt {
  return { opId: op.opId, commitId: op.commitId, fromAgentId, state: 'confirmed', result: result as never }
}

type Executor = (op: ExternalOp) => Promise<ExternalOpReceipt | { code: 'UNAVAILABLE'; message: string }>

function scripted(script: Executor) {
  const calls: ExternalOp[] = []
  const store = memoryStore()
  const hub = createGroupHub({
    store,
    isOnline: () => true,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
    executeExternalOp: async (op) => { calls.push(op); return script(op) },
  })
  return { hub, calls, store }
}

/** Same seam as `scripted`, but with explicit presence so a read owner can be elected. */
function scriptedOnline(isOnline: (agentId: string) => boolean, script: Executor) {
  const calls: ExternalOp[] = []
  const store = memoryStore()
  const hub = createGroupHub({
    store,
    isOnline,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
    executeExternalOp: async (op) => { calls.push(op); return script(op) },
  })
  return { hub, calls, store }
}

async function groupWithEdge(hub: ReturnType<typeof createGroupHub>): Promise<string> {
  const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'r0', name: 'release' })
  if (!created.ok) throw new Error('group create failed')
  const groupId = (created.reply as { group: { groupId: string } }).group.groupId
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'r0i', groupId, agentId: 'agent-b', role: 'peer' })
  await hub.handle(PEER, { kind: 'group.respond', requestId: 'r0r', groupId, accept: true })
  const granted = await hub.handle(OWNER, { kind: 'group.grant', requestId: 'r-edge', groupId, agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'] })
  if (!granted.ok) throw new Error('grant failed')
  return groupId
}

async function sessionWithEdge(hub: ReturnType<typeof createGroupHub>): Promise<{ sessionId: string; groupId: string }> {
  const groupId = await groupWithEdge(hub)
  const issue = await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })
  if (!issue.ok) throw new Error('issue create failed')
  return { sessionId: (issue.reply as { session: { sessionId: string } }).session.sessionId, groupId }
}

async function actionFor(hub: ReturnType<typeof createGroupHub>, sessionId: string, commitId = 'ac1'): Promise<string> {
  const action = await hub.handle(OWNER, {
    kind: 'action.create', requestId: 'a1', commitId, sessionId,
    assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
  })
  if (!action.ok) throw new Error('action create failed')
  return (action.reply as { action: { actionId: string } }).action.actionId
}

function snapshotOf(store: ReturnType<typeof memoryStore>): GroupHubSnapshot {
  const snapshot = store.snapshots[store.snapshots.length - 1]
  if (!snapshot) throw new Error('no snapshot')
  return snapshot
}

describe('rework red findings', () => {
  it('R2 red: a blocked action accepts a new result commit and writes a comment', async () => {
    const { hub, calls } = scripted((op) => op.kind === 'action.result' ? confirmed(op, { resultRef: 'comment:1' }) : confirmed(op, { issueId: '42' }))
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    await hub.handle(PEER, { kind: 'action.report', requestId: 'p1', actionId, report: 'blocked', reason: 'upstream down' })
    const result = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done anyway' })
    expect(result.ok).toBe(false)
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(0)
  })

  it('R2 red: an unknown action accepts a different result commit and writes a second comment', async () => {
    let writes = 0
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'action.result') {
        writes += 1
        return writes === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { resultRef: 'comment:2' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, resultRef: 'comment:1' })
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    const first = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(first.ok).toBe(false)
    const second = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc2', actionId, resultBody: 'different' })
    expect(second.ok).toBe(false)
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
    // The rejected second commit did not steal the action: the original commit
    // still recovers through the read-only path.
    const recovered = await hub.handle(PEER, { kind: 'action.submit', requestId: 's3', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(recovered.ok).toBe(true)
    expect((recovered.reply as { action: { state: string } }).action.state).toBe('completed')
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
  })

  it('R2 red: the same result commit with different content while unknown conflicts', async () => {
    let writes = 0
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'action.result') {
        writes += 1
        return writes === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { resultRef: 'comment:2' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, resultRef: 'comment:1' })
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    const first = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'original' })
    expect(first.ok).toBe(false)
    const changed = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc1', actionId, resultBody: 'changed' })
    expect(changed.ok).toBe(false)
    expect(changed.ok ? '' : changed.error.code).toBe('CONFLICT')
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
  })

  it('R2 red: a failed action cannot submit a result', async () => {
    const { hub, calls } = scripted((op) => op.kind === 'action.result' ? confirmed(op, { resultRef: 'comment:1' }) : confirmed(op, { issueId: '42' }))
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    await hub.handle(PEER, { kind: 'action.report', requestId: 'p1', actionId, report: 'failed', reason: 'upstream rejected' })
    const result = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done anyway' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('INVALID_INPUT')
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(0)
  })

  it('R2 green: the same result commit with different content conflicts instead of writing again', async () => {
    const { hub, calls } = scripted((op) => op.kind === 'action.result' ? confirmed(op, { resultRef: 'comment:1' }) : confirmed(op, { issueId: '42' }))
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    const first = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done', evidence: { build: 'x' } })
    expect(first.ok).toBe(true)
    const same = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc1', actionId, resultBody: 'done', evidence: { build: 'x' } })
    expect(same.ok).toBe(true)
    const conflict = await hub.handle(PEER, { kind: 'action.submit', requestId: 's3', resultCommitId: 'rc1', actionId, resultBody: 'different', evidence: { build: 'x' } })
    expect(conflict.ok).toBe(false)
    expect(conflict.ok ? '' : conflict.error.code).toBe('CONFLICT')
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
  })

  it('R2 green: a concurrent different result commit cannot start a second write', async () => {
    let release: () => void = () => {}
    const firstDone = new Promise<void>((resolve) => { release = resolve })
    const { hub, calls } = scripted((op) => {
      if (op.kind !== 'action.result') return Promise.resolve(confirmed(op, { issueId: '42' }))
      return new Promise((resolve) => { setTimeout(() => { release(); resolve(confirmed(op, { resultRef: 'comment:1' })) }, 5) })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    const first = hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    await firstDone
    const second = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc2', actionId, resultBody: 'other' })
    expect(second.ok).toBe(false)
    expect(second.ok ? '' : second.error.code).toBe('CONFLICT')
    await first
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
  })

  it('R3 red: an unauthorized action.create still issues an external read', async () => {
    const { hub, calls, store } = scripted((op) => confirmed(op, { issueId: '42', actualState: 'open' }))
    const { sessionId } = await sessionWithEdge(hub)
    const before = store.snapshots.length
    const result = await hub.handle(OUTSIDER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(result.ok).toBe(false)
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(0)
    expect(store.snapshots.length).toBe(before)
  })

  it('R3 green: a member without a command or request edge changes nothing', async () => {
    const { hub, calls, store } = scripted((op) => confirmed(op, { issueId: '42', actualState: 'open' }))
    const { sessionId, groupId } = await sessionWithEdge(hub)
    await hub.handle(OWNER, { kind: 'group.invite', requestId: 'r-no-edge', groupId, agentId: 'agent-d', role: 'peer' })
    await hub.handle({ agentId: 'agent-d', accountId: 'acct', scopeId: 'scope' }, { kind: 'group.respond', requestId: 'r-no-edge-ok', groupId, accept: true })
    const before = store.snapshots.length
    const result = await hub.handle({ agentId: 'agent-d', accountId: 'acct', scopeId: 'scope' }, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('FORBIDDEN')
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(0)
    expect(store.snapshots.length).toBe(before)
  })

  it('R3 green: an authorized create refreshes the external state before admission', async () => {
    const { hub, calls } = scripted((op) => op.kind === 'issue.query'
      ? confirmed(op, { issueId: '42', actualState: 'open' })
      : confirmed(op, { issueId: '42' }))
    const { sessionId } = await sessionWithEdge(hub)
    const result = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(result.ok).toBe(true)
    expect((result.reply as { action: { state: string } }).action.state).toBe('pending')
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(1)
  })

  it('R4 red: a stale close recovery cancels a new action created after reopen', async () => {
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'issue.close') {
        return op.commitId === 'cc1'
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      }
      if (op.kind === 'issue.reopen') return confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, actualState: 'open' })
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId, groupId } = await sessionWithEdge(hub)
    const stale = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(stale.ok).toBe(false)
    // Settle the projection closed through a fresh close intent, then reopen it
    // so the newer action is created while the stale cc1 receipt is still unknown.
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c2', commitId: 'cc2', sessionId, reason: 'close again', conclusion: 'ok' })
    expect(closed.ok).toBe(true)
    const reopened = await hub.handle(OWNER, { kind: 'issue.reopen', requestId: 'o1', commitId: 'oc1', sessionId, reason: 'more work' })
    expect(reopened.ok).toBe(true)
    const newAction = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'acN', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'new', expectedResult: 'new', replyRequired: true,
    })
    expect(newAction.ok).toBe(true)
    const newActionId = (newAction.reply as { action: { actionId: string } }).action.actionId
    const retried = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c3', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(retried.ok).toBe(true)
    expect((retried.reply as { outcome: string }).outcome).toBe('conflict')
    const listed = await hub.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    const stored = (listed.reply as { actions: readonly { actionId: string; state: string }[] }).actions.find((entry) => entry.actionId === newActionId)
    expect(stored?.state).toBe('pending')
    const sessionList = await hub.handle(OWNER, { kind: 'issue.list', requestId: 'l2', groupId })
    const session = (sessionList.reply as { sessions: readonly { sessionId: string; state: string }[] }).sessions.find((entry) => entry.sessionId === sessionId)
    expect(session?.state).toBe('open')
    // Only the two setup closes were issued; recovering cc1 added a read, not a write.
    expect(calls.filter((op) => op.kind === 'issue.close')).toHaveLength(2)
    expect(calls.filter((op) => op.kind === 'issue.recover').length).toBeGreaterThanOrEqual(1)
  })

  it('R4 red: replaying a confirmed stale close cancels a new action created after reopen', async () => {
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'issue.close') return confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      if (op.kind === 'issue.reopen') return confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
      if (op.kind === 'issue.query') return confirmed(op, { issueId: '42', actualState: 'open' })
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId, groupId } = await sessionWithEdge(hub)
    // The close succeeds and is persisted in the ledger, but the client never
    // receives that receipt. The replay below is therefore a confirmed op.
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(true)
    const reopened = await hub.handle(OWNER, { kind: 'issue.reopen', requestId: 'o1', commitId: 'oc1', sessionId, reason: 'more work' })
    expect(reopened.ok).toBe(true)
    const newAction = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'acN', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'new', expectedResult: 'new', replyRequired: true,
    })
    expect(newAction.ok).toBe(true)
    const newActionId = (newAction.reply as { action: { actionId: string } }).action.actionId
    const closeWrites = calls.filter((op) => op.kind === 'issue.close').length

    const retried = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c2', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(retried.ok).toBe(true)
    expect((retried.reply as { outcome: string }).outcome).toBe('conflict')

    // The stale confirmed replay must not cancel work created after the reopen
    // and must not call the external close owner again.
    const listed = await hub.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    const stored = (listed.reply as { actions: readonly { actionId: string; state: string }[] }).actions.find((entry) => entry.actionId === newActionId)
    expect(stored?.state).toBe('pending')
    const sessionList = await hub.handle(OWNER, { kind: 'issue.list', requestId: 'l2', groupId })
    const session = (sessionList.reply as { sessions: readonly { sessionId: string; state: string }[] }).sessions.find((entry) => entry.sessionId === sessionId)
    expect(session?.state).toBe('open')
    expect(calls.filter((op) => op.kind === 'issue.close')).toHaveLength(closeWrites)
  })

  it('R4 red: a valid close refuses a pending action result while the external write is held', async () => {
    let releaseClose: () => void = () => undefined
    const closeWrite = new Promise<void>((resolve) => { releaseClose = resolve })
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'issue.close') {
        return closeWrite.then(() => confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' }))
      }
      if (op.kind === 'action.result') return confirmed(op, { resultRef: 'comment:late' })
      return confirmed(op, { issueId: '42', actualState: 'open' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    const closing = hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    // The close intent is durable and the queue is already disposed; the external
    // write has not settled yet.
    const submit = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'late result' })
    expect(submit.ok).toBe(false)
    expect(submit.ok ? '' : submit.error.code).toBe('INVALID_INPUT')
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(0)
    releaseClose()
    await closing
  })

  it('R4 red: a valid close refuses new action admission while the external write is held', async () => {
    let releaseClose: () => void = () => undefined
    const closeWrite = new Promise<void>((resolve) => { releaseClose = resolve })
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'issue.close') {
        return closeWrite.then(() => confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' }))
      }
      return confirmed(op, { issueId: '42', actualState: 'open' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const closing = hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    const created = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac2', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(created.ok).toBe(false)
    expect(created.ok ? '' : created.error.code).toBe('CONFLICT')
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(0)
    releaseClose()
    await closing
  })

  it('R4 red: an unknown close keeps admission sealed until the same close is recovered', async () => {
    let closeAttempts = 0
    const { hub, calls, store } = scripted((op) => {
      if (op.kind === 'issue.close') {
        closeAttempts += 1
        return closeAttempts === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, actualState: 'closed' })
      if (op.kind === 'issue.query') return confirmed(op, { issueId: '42', actualState: 'open' })
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(false)
    const queriesBefore = calls.filter((op) => op.kind === 'issue.query').length
    const snapshotsBefore = store.snapshots.length
    const created = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'acN', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(created.ok).toBe(false)
    expect(created.ok ? '' : created.error.code).toBe('CONFLICT')
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(queriesBefore)
    expect(store.snapshots.length).toBe(snapshotsBefore)
    const recovered = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c2', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(recovered.ok).toBe(true)
    expect((recovered.reply as { outcome: string }).outcome).toBe('closed')
    expect(calls.filter((op) => op.kind === 'issue.close')).toHaveLength(1)
    const after = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a2', commitId: 'acN2', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(after.ok).toBe(false)
    expect(after.ok ? '' : after.error.code).toBe('CONFLICT')
  })

  it('R4 red: an unknown close is unsealed only by a newer reopen generation', async () => {
    let closeAttempts = 0
    const { hub, calls, store } = scripted((op) => {
      if (op.kind === 'issue.close') {
        closeAttempts += 1
        return closeAttempts === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      }
      if (op.kind === 'issue.reopen') return confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
      if (op.kind === 'issue.query') return confirmed(op, { issueId: '42', actualState: 'open' })
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(false)
    const snapshotsBefore = store.snapshots.length
    const created = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'acN', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(created.ok).toBe(false)
    expect(created.ok ? '' : created.error.code).toBe('CONFLICT')
    expect(store.snapshots.length).toBe(snapshotsBefore)
    const reopened = await hub.handle(OWNER, { kind: 'issue.reopen', requestId: 'o1', commitId: 'oc1', sessionId, reason: 'more work' })
    expect(reopened.ok).toBe(true)
    const admitted = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a2', commitId: 'acN2', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(admitted.ok).toBe(true)
    expect(calls.filter((op) => op.kind === 'issue.close')).toHaveLength(1)
  })

  it('R4 red: an unknown close unseals after the same close recovery confirms it was not applied', async () => {
    let closeAttempts = 0
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'issue.close') {
        closeAttempts += 1
        return closeAttempts === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: false, actualState: 'open' })
      if (op.kind === 'issue.query') return confirmed(op, { issueId: '42', actualState: 'open' })
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(false)
    const sealed = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a0', commitId: 'ac0', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(sealed.ok).toBe(false)
    expect(sealed.ok ? '' : sealed.error.code).toBe('CONFLICT')
    const recovered = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c2', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(recovered.ok).toBe(true)
    expect((recovered.reply as { outcome: string }).outcome).toBe('conflict')
    expect(calls.filter((op) => op.kind === 'issue.close')).toHaveLength(1)
    const admitted = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(admitted.ok).toBe(true)
  })

  it('R4 red: an unknown close refuses a pending action result with no external write', async () => {
    let closeAttempts = 0
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'issue.close') {
        closeAttempts += 1
        return closeAttempts === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      }
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(false)
    // Restore the durable state as a restart would: an unknown close intent and
    // a pending action that has not been disposed yet.
    const base = hub.snapshot()
    const session = base.sessions.find((entry) => entry.sessionId === sessionId)
    const action = base.actions.find((entry) => entry.actionId === actionId)
    if (!session || !action) throw new Error('missing seeded records')
    const opSeq = session.lastOpSeq + 1
    const crafted: GroupHubSnapshot = {
      ...base,
      sessions: base.sessions.map((entry) => entry.sessionId === sessionId ? { ...entry, lastOpSeq: opSeq } : entry),
      operations: [...base.operations, {
        opId: `issue-op:${sessionId}:cc1`, commitId: 'cc1', sessionId, kind: 'issue.close',
        state: 'unknown', targetState: 'closed', opSeq, reason: 'done',
        createdAt: session.openedAt, updatedAt: session.openedAt,
      }],
      actions: base.actions.map((entry) => entry.actionId === actionId ? { ...entry, state: 'pending' } : entry),
    }
    const writes: ExternalOp[] = []
    const restored = createGroupHub({
      store: { load: () => crafted, save: () => undefined },
      isOnline: () => true,
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `r-${++n}` })(),
      executeExternalOp: async (op) => { writes.push(op); return confirmed(op, { resultRef: 'comment:late' }) },
    })
    const submit = await restored.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'late result' })
    expect(submit.ok).toBe(false)
    expect(writes.filter((op) => op.kind === 'action.result')).toHaveLength(0)
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(0)
  })

  it('R5 red: an offline initiator delegates a state read to an active online member', async () => {
    const online = new Set(['agent-a', 'agent-b', 'agent-z'])
    const { hub, calls } = scriptedOnline((agentId) => online.has(agentId), (op) => {
      if (op.kind === 'issue.query') {
        return op.ownerAgentId === 'agent-b'
          ? confirmed(op, { issueId: '42', actualState: 'closed' })
          : { code: 'UNAVAILABLE', message: 'initiator is offline' }
      }
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    online.delete('agent-a')
    const sweep = await hub.sweepIssueStates()
    expect(sweep.unconfirmed).not.toContain(sessionId)
    const session = hub.snapshot().sessions.find((entry) => entry.sessionId === sessionId)
    expect(session?.state).toBe('closed')
    const read = calls.filter((op) => op.kind === 'issue.query').at(-1)
    expect(read?.ownerAgentId).toBe('agent-b')
  })

  it('R5 red: a reader receipt from another owner cannot settle the state read', async () => {
    const online = new Set(['agent-a', 'agent-b'])
    const { hub } = scriptedOnline((agentId) => online.has(agentId), (op) => {
      if (op.kind === 'issue.query') return confirmed(op, { issueId: '42', actualState: 'closed' }, 'agent-z')
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    online.delete('agent-a')
    const sweep = await hub.sweepIssueStates()
    expect(sweep.unconfirmed).toContain(sessionId)
    const session = hub.snapshot().sessions.find((entry) => entry.sessionId === sessionId)
    expect(session?.state).toBe('open')
  })

  it('R5 red: no online reader keeps the read unknown and refuses new admission', async () => {
    const online = new Set(['agent-a'])
    const { hub, calls, store } = scriptedOnline((agentId) => online.has(agentId), (op) => {
      if (op.kind === 'issue.query') {
        return online.has(op.ownerAgentId)
          ? confirmed(op, { issueId: '42', actualState: 'closed' })
          : { code: 'UNAVAILABLE', message: 'read owner is offline' }
      }
      return confirmed(op, { issueId: '42' })
    })
    const { sessionId } = await sessionWithEdge(hub)
    online.clear()
    const sweep = await hub.sweepIssueStates()
    expect(sweep.unconfirmed).toContain(sessionId)
    expect(hub.snapshot().sessions.find((entry) => entry.sessionId === sessionId)?.state).toBe('open')
    const queriesBefore = calls.filter((op) => op.kind === 'issue.query').length
    const snapshotsBefore = store.snapshots.length
    const created = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac-no-reader', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(created.ok).toBe(false)
    expect(created.ok ? '' : created.error.code).toBe('UNAVAILABLE')
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(queriesBefore)
    expect(store.snapshots.length).toBe(snapshotsBefore)
  })

  it('R7 red: a refusal with no reason is accepted and the reason is not persisted', async () => {
    const { hub, store } = scripted((op) => confirmed(op, { issueId: '42' }))
    const { sessionId, groupId } = await sessionWithEdge(hub)
    await hub.handle(OWNER, { kind: 'group.invite', requestId: 'ri', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b'] })
    await hub.handle(MASTER, { kind: 'group.respond', requestId: 'rr', groupId, accept: true })
    const request = await hub.handle(PEER, {
      kind: 'action.create', requestId: 'rq', commitId: 'acR', sessionId,
      assigneeAgentId: 'agent-c', actionKind: 'reply', reason: 'need a decision', expectedResult: 'an answer', replyRequired: true,
    })
    expect(request.ok).toBe(true)
    const requestId = (request.reply as { action: { actionId: string } }).action.actionId
    const refused = await hub.handle(MASTER, { kind: 'action.refuse', requestId: 'r1', actionId: requestId, reason: '' })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error.code).toBe('INVALID_INPUT')
    const after = snapshotOf(store)
    const restored = after.actions.find((entry) => entry.actionId === requestId)
    expect(restored?.state).toBe('pending')
  })

  it('R7 green: a master refusal persists its reason without replacing the initiator reason', async () => {
    const { hub, store } = scripted((op) => confirmed(op, { issueId: '42' }))
    const { sessionId, groupId } = await sessionWithEdge(hub)
    await hub.handle(OWNER, { kind: 'group.invite', requestId: 'ri', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b'] })
    await hub.handle(MASTER, { kind: 'group.respond', requestId: 'rr', groupId, accept: true })
    const request = await hub.handle(PEER, {
      kind: 'action.create', requestId: 'rq', commitId: 'acR', sessionId,
      assigneeAgentId: 'agent-c', actionKind: 'reply', reason: 'need a decision', expectedResult: 'an answer', replyRequired: true,
    })
    const requestId = (request.reply as { action: { actionId: string } }).action.actionId
    const refused = await hub.handle(MASTER, { kind: 'action.refuse', requestId: 'r1', actionId: requestId, reason: 'out of scope' })
    expect(refused.ok).toBe(true)
    expect((refused.reply as { action: { state: string; reason: string; refusal?: { reason: string } } }).action).toMatchObject({
      state: 'refused',
      reason: 'need a decision',
      refusal: { reason: 'out of scope' },
    })
    const restored = snapshotOf(store).actions.find((entry) => entry.actionId === requestId)
    expect(restored?.reason).toBe('need a decision')
    expect(restored?.refusal?.reason).toBe('out of scope')
    const relisted = await hub.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    const listedAction = (relisted.reply as { actions: readonly { actionId: string; refusal?: { reason: string } }[] }).actions.find((entry) => entry.actionId === requestId)
    expect(listedAction?.refusal?.reason).toBe('out of scope')
  })

  it('R7 green: the initiator sees the refusal after the hub is rebuilt from the store', async () => {
    const { hub, store } = scripted((op) => confirmed(op, { issueId: '42' }))
    const { sessionId, groupId } = await sessionWithEdge(hub)
    await hub.handle(OWNER, { kind: 'group.invite', requestId: 'ri', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b'] })
    await hub.handle(MASTER, { kind: 'group.respond', requestId: 'rr', groupId, accept: true })
    const request = await hub.handle(PEER, {
      kind: 'action.create', requestId: 'rq', commitId: 'acR', sessionId,
      assigneeAgentId: 'agent-c', actionKind: 'reply', reason: 'need a decision', expectedResult: 'an answer', replyRequired: true,
    })
    const requestId = (request.reply as { action: { actionId: string } }).action.actionId
    await hub.handle(MASTER, { kind: 'action.refuse', requestId: 'r1', actionId: requestId, reason: 'out of scope' })
    const rebuilt = createGroupHub({ store, isOnline: () => true, now: () => new Date('2026-10-22T00:00:00.000Z') })
    const relisted = await rebuilt.handle(PEER, { kind: 'action.list', requestId: 'l2', sessionId })
    const listedAction = (relisted.reply as { actions: readonly { actionId: string; state: string; reason: string; refusal?: { reason: string } }[] }).actions.find((entry) => entry.actionId === requestId)
    expect(listedAction).toMatchObject({ state: 'refused', reason: 'need a decision', refusal: { reason: 'out of scope' } })
  })

  it('R7 green: the assignee peer cannot refuse a master assignment', async () => {
    const { hub, store } = scripted((op) => confirmed(op, { issueId: '42' }))
    const { sessionId } = await sessionWithEdge(hub)
    const actionId = await actionFor(hub, sessionId)
    const before = store.snapshots.length
    const refused = await hub.handle(PEER, { kind: 'action.refuse', requestId: 'r1', actionId, reason: 'not my job' })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error.code).toBe('FORBIDDEN')
    expect(store.snapshots.length).toBe(before)
    const restored = snapshotOf(store).actions.find((entry) => entry.actionId === actionId)
    expect(restored?.state).toBe('pending')
    expect(restored?.refusal).toBeUndefined()
  })
})
