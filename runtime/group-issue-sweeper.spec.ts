import { describe, expect, it, vi } from 'vitest'
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
        // Capture the observed state when the read starts, so a held read stays
        // stale even after the external state changes while it is in flight.
        const observed = external.state
        if (external.hold !== undefined) await external.hold
        if (external.fail) return { code: 'UNAVAILABLE', message: 'vikunja is unavailable' }
        return confirmed(op, { issueId: '42', actualState: observed })
      }
      if (op.kind === 'issue.close') return confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      if (op.kind === 'issue.reopen') return confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
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

interface MultiIssueState {
  state: 'open' | 'closed'
  hold?: Promise<void>
  holdUsed?: boolean
  fail?: boolean
}

async function multiIssueHub(count: number): Promise<{
  readonly hub: ReturnType<typeof createGroupHub>
  readonly calls: ExternalOp[]
  readonly external: Map<string, MultiIssueState>
  readonly groupId: string
  readonly sessions: readonly string[]
}> {
  const store = memoryStore()
  const calls: ExternalOp[] = []
  const external = new Map<string, MultiIssueState>()
  let nextId = 0
  const hub = createGroupHub({
    store,
    isOnline: () => true,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: () => `id-${++nextId}`,
    sweepReadTimeoutMs: 200,
    executeExternalOp: async (op) => {
      calls.push(op)
      if (op.kind === 'issue.create') return confirmed(op, { issueId: op.commitId })
      if (op.kind === 'issue.query') {
        const params = op.params as Record<string, unknown>
        const issueId = String(params.vikunjaIssueId ?? '')
        const state = external.get(issueId)
        // Capture the state the external system reports when this read starts.
        const observed = state?.state ?? 'open'
        if (state?.hold !== undefined && state.holdUsed !== true) {
          state.holdUsed = true
          await state.hold
        }
        if (state?.fail === true) return { code: 'UNAVAILABLE', message: 'vikunja is unavailable' }
        return confirmed(op, { issueId, actualState: observed })
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
  const sessions: string[] = []
  for (let index = 0; index < count; index += 1) {
    const commitId = `ic-${index + 1}`
    const issue = await hub.handle(OWNER, { kind: 'issue.create', requestId: `i-${index}`, commitId, groupId, vikunjaProjectId: 'p1', title: `issue ${index}`, body: 'body' })
    if (!issue.ok) throw new Error('issue create failed')
    const sessionId = (issue.reply as { session: { sessionId: string } }).session.sessionId
    sessions.push(sessionId)
    external.set(commitId, { state: 'open' })
  }
  return { hub, calls, external, groupId, sessions }
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

  it('R5 red: a full window that falls due during a short pass waits and then runs as a full pass', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'))
      const allSessions = ['session:live', 'session:ordinary']
      const passes: Array<readonly string[] | undefined> = []
      const reads: string[][] = []
      let inflight: readonly string[] = []
      let releaseShort: () => void = () => undefined
      let shortHeld = false
      let active = 0
      let maxActive = 0
      const hub: GroupHub = {
        handle: async () => ({ ok: true }),
        inflightIssueSessionIds: () => inflight,
        sweepIssueStates: async (sessionIds?: readonly string[]) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          passes.push(sessionIds)
          reads.push(sessionIds === undefined ? [...allSessions] : [...sessionIds])
          try {
            if (sessionIds !== undefined && shortHeld) {
              await new Promise<void>((resolveHold) => { releaseShort = resolveHold })
            }
            return { checked: 0, changed: 0, unconfirmed: [] }
          } finally {
            active -= 1
          }
        },
      }
      const scheduler = startGroupIssueSweepScheduler(hub, { intervalMs: 30_000, inflightIntervalMs: 5_000 })
      await vi.advanceTimersByTimeAsync(0)
      // The boot pass is a real full pass over every session.
      expect(passes).toEqual([undefined])
      expect(reads[0]).toEqual(allSessions)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(20_000)
      inflight = ['session:live']
      shortHeld = true
      // 25s: the short targeted pass starts and stays in flight.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(passes).toEqual([undefined, ['session:live']])
      // 30s: the full window is due, but only the short pass is in flight.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(passes).toEqual([undefined, ['session:live']])
      // 35s: release the short pass; the full window is still due.
      await vi.advanceTimersByTimeAsync(5_000)
      releaseShort()
      await vi.advanceTimersByTimeAsync(5_000)
      // 40s: the real full pass runs over the ordinary session as well.
      expect(passes).toEqual([undefined, ['session:live'], undefined])
      expect(reads[2]).toEqual(allSessions)
      expect(maxActive).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      console.log(`R5 full after short pass: boot=0ms short=25s due=30s release=35s full=${Date.now() - Date.parse('2026-10-22T00:00:00.000Z')}ms`)
      await scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('R5 red: a due full pass with nothing in flight runs at once and moves the full window', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'))
      const starts: number[] = []
      const hub: GroupHub = {
        handle: async () => ({ ok: true }),
        inflightIssueSessionIds: () => [],
        sweepIssueStates: async () => {
          starts.push(Date.now())
          return { checked: 0, changed: 0, unconfirmed: [] }
        },
      }
      const scheduler = startGroupIssueSweepScheduler(hub, { intervalMs: 30_000, inflightIntervalMs: 5_000 })
      await vi.advanceTimersByTimeAsync(0)
      expect(starts).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(starts).toHaveLength(2)
      expect(starts[1]! - starts[0]!).toBe(30_000)
      // The window moved: no extra full pass before another 30 seconds elapse.
      await vi.advanceTimersByTimeAsync(25_000)
      expect(starts).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(starts).toHaveLength(3)
      expect(starts[2]! - starts[1]!).toBe(30_000)
      await scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('R5 red: a stale closed read cannot overwrite a newer close+reopen generation', async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => { release = resolve })
    const { hub, calls, external, sessionId } = await seededHub()
    const readsBefore = calls.filter((op) => op.kind === 'issue.query').length
    // The read captures the closed observation and then stays in flight while a
    // local close and reopen advance the same issue back to open.
    external.state = 'closed'
    external.hold = hold
    const sweep = hub.sweepIssueStates()
    await waitFor(() => calls.filter((op) => op.kind === 'issue.query').length === readsBefore + 1)
    // Only the sweep read is held. Later command reads must observe the state
    // left by the close/reopen instead of waiting on the stale read's gate.
    external.hold = undefined
    external.state = 'open'
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(true)
    const reopened = await hub.handle(OWNER, { kind: 'issue.reopen', requestId: 'o1', commitId: 'oc1', sessionId, reason: 'more work' })
    expect(reopened.ok).toBe(true)
    const created = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'acN', sessionId,
      assigneeAgentId: PEER.agentId, actionKind: 'comment', reason: 'new', expectedResult: 'new', replyRequired: true,
    })
    expect(created.ok).toBe(true)
    const newActionId = (created.reply as { action: { actionId: string } }).action.actionId
    release()
    await sweep
    const snapshot = hub.snapshot()
    expect(snapshot.sessions.find((entry) => entry.sessionId === sessionId)?.state).toBe('open')
    const stored = snapshot.actions.find((entry) => entry.actionId === newActionId)
    expect(stored?.state).toBe('pending')
  })

  it('R5 red: a slow first issue cannot starve a healthy issue behind the sweep window', async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => { release = resolve })
    const { hub, calls, external, sessions } = await multiIssueHub(2)
    const [slowSession, healthySession] = sessions
    external.get('ic-1')!.hold = hold
    external.get('ic-2')!.state = 'closed'
    const startedAt = Date.now()
    let pass
    try {
      pass = hub.sweepIssueStates()
      await waitFor(() => calls.some((op) => op.kind === 'issue.query' && (op.params as Record<string, unknown>).vikunjaIssueId === 'ic-1'))
      const result = await Promise.race([
        pass,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('the sweep did not settle within the bounded window')), 1_200)
        }),
      ])
      const elapsedMs = Date.now() - startedAt
      // The first read is bounded by its own timeout; the healthy issue still
      // converges inside the acceptance window and never waits for the slow one.
      expect(elapsedMs).toBeLessThan(900)
      expect(result.unconfirmed).toContain(slowSession)
      const snapshot = hub.snapshot()
      expect(snapshot.sessions.find((entry) => entry.sessionId === healthySession)?.state).toBe('closed')
      console.log(`R5 bounded pass: ${elapsedMs}ms, unconfirmed=${result.unconfirmed.length}, healthy=closed`)
    } finally {
      release()
    }
  })

  it('R5 red: an in-flight action shortens only its own session poll interval', async () => {
    const { hub, calls, external, sessions } = await multiIssueHub(2)
    const [inflightSession, ordinarySession] = sessions
    const created = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a-inflight', commitId: 'ac-inflight', sessionId: inflightSession,
      assigneeAgentId: PEER.agentId, actionKind: 'comment', reason: 'wait', expectedResult: 'result', replyRequired: true,
    })
    expect(created.ok).toBe(true)
    const scheduler = startGroupIssueSweepScheduler(hub, { intervalMs: 400, inflightIntervalMs: 25 })
    try {
      await scheduler.runOnce()
      calls.length = 0
      external.get('ic-1')!.state = 'closed'
      external.get('ic-2')!.state = 'closed'
      const startedAt = Date.now()
      await waitFor(() => hub.snapshot().sessions.find((entry) => entry.sessionId === inflightSession)?.state === 'closed', 250)
      const elapsedMs = Date.now() - startedAt
      const reads = calls.filter((op) => op.kind === 'issue.query')
      const issueIds = reads.map((op) => (op.params as Record<string, unknown>).vikunjaIssueId)
      expect(elapsedMs).toBeLessThan(250)
      expect(issueIds).toContain('ic-1')
      expect(issueIds).not.toContain('ic-2')
      expect(hub.snapshot().sessions.find((entry) => entry.sessionId === ordinarySession)?.state).toBe('open')
      console.log(`R5 in-flight interval: ${elapsedMs}ms, reads=${issueIds.join(',')}`)
    } finally {
      await scheduler.stop()
    }
  })

  it('R5 green: stop waits only for the bounded pass and never for a held read', async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => { release = resolve })
    const { hub, calls, external } = await multiIssueHub(2)
    external.get('ic-1')!.hold = hold
    const scheduler = startGroupIssueSweepScheduler(hub, { intervalMs: 60_000 })
    try {
      await waitFor(() => calls.some((op) => op.kind === 'issue.query' && (op.params as Record<string, unknown>).vikunjaIssueId === 'ic-1'))
      const stopAt = Date.now()
      await scheduler.stop()
      const stopMs = Date.now() - stopAt
      expect(stopMs).toBeLessThan(900)
      console.log(`R5 bounded stop: ${stopMs}ms`)
    } finally {
      release()
    }
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
