import { describe, expect, it } from 'vitest'
import type { ExternalOp } from '../packages/shared/src/group-wire.ts'
import type { ExternalOpReceipt } from '../server/group-external-ops.ts'
import { createGroupHub, type GroupHubSnapshot, type GroupHubStore } from '../server/group-hub.ts'
import type { GroupHub, GroupIssueSweepResult } from '../server/relay.ts'
import { startGroupIssueSweepScheduler } from './registry-process.ts'

const OWNER = { agentId: 'agent-a', accountId: 'acct', scopeId: 'scope' }
const PEER = { agentId: 'agent-b', accountId: 'acct', scopeId: 'scope' }

function memoryStore(): GroupHubStore & { readonly snapshots: GroupHubSnapshot[] } {
  const snapshots: GroupHubSnapshot[] = []
  let current: GroupHubSnapshot | undefined
  return { snapshots, load: () => current, save: (snapshot) => { current = snapshot; snapshots.push(snapshot) } }
}

function confirmed(op: ExternalOp, result: unknown): ExternalOpReceipt {
  return { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'confirmed', result: result as never }
}

interface ExternalReadState {
  state: 'open' | 'closed'
  fail: boolean
  hold?: Promise<void>
}

async function seededHub(): Promise<{
  readonly hub: ReturnType<typeof createGroupHub>
  readonly store: ReturnType<typeof memoryStore>
  readonly calls: readonly ExternalOp[]
  readonly external: ExternalReadState
  readonly groupId: string
  readonly sessionId: string
  readonly actionId: string
}> {
  const store = memoryStore()
  const calls: ExternalOp[] = []
  const external: ExternalReadState = { state: 'open', fail: false }
  let nextId = 0
  const hub = createGroupHub({
    store,
    isOnline: () => true,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: () => `id-${++nextId}`,
    executeExternalOp: async (op) => {
      calls.push(op)
      if (op.kind === 'issue.query') {
        if (external.hold !== undefined) await external.hold
        if (external.fail) return { code: 'UNAVAILABLE', message: 'vikunja is unavailable' }
        return confirmed(op, { issueId: '42', actualState: external.state })
      }
      return confirmed(op, { issueId: '42' })
    },
  })
  const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'g0', name: 'release' })
  if (!created.ok) throw new Error('group create failed')
  const groupId = (created.reply as { group: { groupId: string } }).group.groupId
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'g1', groupId, agentId: PEER.agentId, role: 'peer' })
  await hub.handle(PEER, { kind: 'group.respond', requestId: 'g2', groupId, accept: true })
  await hub.handle(OWNER, { kind: 'group.grant', requestId: 'g3', groupId, agentId: OWNER.agentId, role: 'master', mastersOf: [PEER.agentId] })
  const issue = await hub.handle(OWNER, {
    kind: 'issue.create', requestId: 'i0', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 'release', body: 'body',
  })
  if (!issue.ok) throw new Error('issue create failed')
  const sessionId = (issue.reply as { session: { sessionId: string } }).session.sessionId
  const action = await hub.handle(OWNER, {
    kind: 'action.create', requestId: 'a0', commitId: 'ac1', sessionId,
    assigneeAgentId: PEER.agentId, actionKind: 'comment', reason: 'check', expectedResult: 'result', replyRequired: true,
  })
  if (!action.ok) throw new Error('action create failed')
  return { hub, store, calls, external, groupId, sessionId, actionId: (action.reply as { action: { actionId: string } }).action.actionId }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
  }
  throw new Error('timed out waiting for the sweep')
}

function countingHub(counter: { readonly runs: number }): GroupHub {
  return {
    handle: async () => ({ ok: true }),
    sweepIssueStates: async (): Promise<GroupIssueSweepResult> => {
      ;(counter as { runs: number }).runs += 1
      return { checked: 0, changed: 0, unconfirmed: [] }
    },
  }
}

describe('registry-owned issue sweep', () => {
  it('R5 red: settles an external close on the timer without a console query', async () => {
    const { hub, calls, external, sessionId, actionId } = await seededHub()
    external.state = 'closed'
    const results: GroupIssueSweepResult[] = []
    const scheduler = startGroupIssueSweepScheduler(hub, { intervalMs: 5, onResult: (result) => results.push(result) })
    await waitFor(() => {
      const snapshot = hub.snapshot()
      const session = snapshot.sessions.find((entry) => entry.sessionId === sessionId)
      const action = snapshot.actions.find((entry) => entry.actionId === actionId)
      return session?.state === 'closed' && action?.state === 'cancelled'
    })
    await scheduler.stop()
    expect(results.some((result) => result.changed > 0)).toBe(true)
    const readsAtStop = calls.filter((op) => op.kind === 'issue.query').length
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(readsAtStop)
  })

  it('R5 red: a failed read keeps the projection and responsibility and blocks admission', async () => {
    const { hub, store, external, sessionId, actionId } = await seededHub()
    external.fail = true
    const results: GroupIssueSweepResult[] = []
    const scheduler = startGroupIssueSweepScheduler(hub, {
      intervalMs: 5,
      onResult: (result) => results.push(result),
      onError: () => undefined,
    })
    await waitFor(() => results.some((result) => result.unconfirmed.includes(sessionId)))
    await scheduler.stop()
    const snapshot = hub.snapshot()
    expect(snapshot.sessions.find((entry) => entry.sessionId === sessionId)?.state).toBe('open')
    const action = snapshot.actions.find((entry) => entry.actionId === actionId)
    expect(action?.state).toBe('pending')
    expect(action?.assigneeAgentId).toBe(PEER.agentId)
    const snapshotsBefore = store.snapshots.length
    const refused = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a2', commitId: 'ac2', sessionId,
      assigneeAgentId: PEER.agentId, actionKind: 'comment', reason: 'more', expectedResult: 'result', replyRequired: true,
    })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error.code).toBe('UNAVAILABLE')
    expect(hub.snapshot().actions).toHaveLength(snapshot.actions.length)
    expect(store.snapshots.length).toBe(snapshotsBefore)
  })

  it('R5 red: an external reopen does not revive the cancelled action', async () => {
    const { hub, external, sessionId, actionId } = await seededHub()
    external.state = 'closed'
    const scheduler = startGroupIssueSweepScheduler(hub, { intervalMs: 5 })
    await waitFor(() => hub.snapshot().sessions.find((entry) => entry.sessionId === sessionId)?.state === 'closed')
    external.state = 'open'
    await waitFor(() => hub.snapshot().sessions.find((entry) => entry.sessionId === sessionId)?.state === 'open')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    const action = hub.snapshot().actions.find((entry) => entry.actionId === actionId)
    expect(action?.state).toBe('cancelled')
    await scheduler.stop()
  })

  it('R5 red: one scheduler keeps at most one sweep in flight', async () => {
    const { hub, calls, external } = await seededHub()
    const readsBefore = calls.filter((op) => op.kind === 'issue.query').length
    let release: () => void = () => undefined
    external.hold = new Promise<void>((resolve) => { release = resolve })
    const scheduler = startGroupIssueSweepScheduler(hub, { intervalMs: 60_000 })
    const first = scheduler.runOnce()
    const second = scheduler.runOnce()
    await waitFor(() => calls.filter((op) => op.kind === 'issue.query').length === readsBefore + 1)
    release()
    await Promise.all([first, second])
    expect(calls.filter((op) => op.kind === 'issue.query')).toHaveLength(readsBefore + 1)
    await scheduler.stop()
  })

  it('R5 red: stopping one scheduler leaves the other test-owned timer running', async () => {
    const left = { runs: 0 }
    const right = { runs: 0 }
    const first = startGroupIssueSweepScheduler(countingHub(left), { intervalMs: 5 })
    const second = startGroupIssueSweepScheduler(countingHub(right), { intervalMs: 5 })
    await waitFor(() => left.runs > 0 && right.runs > 0)
    await first.stop()
    const leftAtStop = left.runs
    const rightAtStop = right.runs
    await waitFor(() => right.runs > rightAtStop)
    expect(left.runs).toBe(leftAtStop)
    await second.stop()
  })
})
