import { describe, expect, it } from 'vitest'
import type { Action, ExternalOp } from '../control-protocol/group-wire.ts'
import { actionNeedsExecutionFor } from '../control-protocol/group-wire.ts'
import type { ExternalOpReceipt } from './group-external-ops.ts'
import { createGroupHub, type GroupHubSnapshot, type GroupHubStore } from './group-hub.ts'

/**
 * Hardening evidence for the review findings: durable external ops, read-back
 * confirmation, membership on reads, initiator-only close and JSON-safe state.
 */

const OWNER = { agentId: 'agent-a', accountId: 'acct', scopeId: 'scope' }
const PEER = { agentId: 'agent-b', accountId: 'acct', scopeId: 'scope' }
const MASTER = { agentId: 'agent-c', accountId: 'acct', scopeId: 'scope' }
const STRANGER = { agentId: 'agent-x', accountId: 'acct', scopeId: 'scope' }

type Executor = (op: ExternalOp) => Promise<ExternalOpReceipt | { code: 'UNAVAILABLE'; message: string }>

function jsonStore(): GroupHubStore & { readonly state: { current?: GroupHubSnapshot } } {
  const state: { current?: GroupHubSnapshot } = {}
  return {
    state,
    load: () => state.current,
    save: (snapshot) => { state.current = JSON.parse(JSON.stringify(snapshot)) as GroupHubSnapshot },
  }
}

function hubWith(store: GroupHubStore, executor: Executor) {
  return createGroupHub({
    store,
    isOnline: () => true,
    executeExternalOp: executor,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
  })
}

function confirmed(op: ExternalOp, result: unknown, fromAgentId = op.ownerAgentId): ExternalOpReceipt {
  return { opId: op.opId, commitId: op.commitId, fromAgentId, state: 'confirmed', result: result as never }
}

function issueOk(op: ExternalOp): ExternalOpReceipt {
  if (op.kind === 'issue.create') return confirmed(op, { issueId: '42' })
  if (op.kind === 'issue.close') return confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
  if (op.kind === 'issue.reopen') return confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
  return confirmed(op, { resultRef: 'comment:1' })
}

async function groupAndSession(hub: ReturnType<typeof createGroupHub>) {
  const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'g0', name: 'release' })
  if (!created.ok) throw new Error('create failed')
  const groupId = (created.reply as { group: { groupId: string } }).group.groupId
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'g1', groupId, agentId: 'agent-b', role: 'peer' })
  await hub.handle(PEER, { kind: 'group.respond', requestId: 'g2', groupId, accept: true })
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'g3', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b'] })
  await hub.handle(MASTER, { kind: 'group.respond', requestId: 'g4', groupId, accept: true })
  const session = await hub.handle(MASTER, {
    kind: 'issue.create', requestId: 'i0', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 'ship', body: 'b',
  })
  if (!session.ok) throw new Error(`issue create failed: ${session.error.message}`)
  return { groupId, sessionId: (session.reply as { session: { sessionId: string } }).session.sessionId }
}

describe('review finding 2: one commit id names one external write', () => {
  it('does not repeat the write when the first outcome was unknown', async () => {
    const store = jsonStore()
    const calls: ExternalOp[] = []
    const hub = hubWith(store, async (op) => {
      calls.push(op)
      return op.kind === 'issue.create' ? { code: 'UNAVAILABLE', message: 'no receipt' } : issueOk(op)
    })
    const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'g0', name: 'release' })
    const groupId = (created.reply as { group: { groupId: string } }).group.groupId
    const first = await hub.handle(OWNER, {
      kind: 'issue.create', requestId: 'i0', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 'ship', body: 'b',
    })
    expect(first.ok).toBe(false)
    const second = await hub.handle(OWNER, {
      kind: 'issue.create', requestId: 'i1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 'ship', body: 'b',
    })
    expect(second.ok).toBe(false)
    expect(second.ok ? '' : second.error.message).toContain('unknown')
    // The retry must ask for a read-back, not write a second issue.
    expect(calls).toHaveLength(1)
  })

  it('keeps the recorded operation across a restart', async () => {
    const store = jsonStore()
    const hub = hubWith(store, async () => ({ code: 'UNAVAILABLE', message: 'owner offline' }))
    const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'g0', name: 'release' })
    const groupId = (created.reply as { group: { groupId: string } }).group.groupId
    await hub.handle(OWNER, {
      kind: 'issue.create', requestId: 'i0', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 'ship', body: 'b',
    })
    const restored = JSON.parse(JSON.stringify(store.state.current)) as GroupHubSnapshot
    expect(restored.ops.length).toBe(1)
    expect(restored.ops[0]?.state).toBe('unknown')
  })
})

describe('review findings 1 and 3: only a read-back moves a projection', () => {
  it('refuses to close when the receipt names no observed state', async () => {
    const hub = hubWith(jsonStore(), async (op) => (op.kind === 'issue.create'
      ? confirmed(op, { issueId: '42' })
      : confirmed(op, { issueId: '42' })))
    const { sessionId } = await groupAndSession(hub)
    const closed = await hub.handle(MASTER, {
      kind: 'issue.close', requestId: 'c0', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'shipped',
    })
    expect(closed.ok).toBe(false)
    const queried = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q0', sessionId })
    expect((queried.reply as { session: { state: string } }).session.state).toBe('open')
  })

  it('refuses to complete an action whose result has no read-back', async () => {
    const hub = hubWith(jsonStore(), async (op) => (op.kind === 'issue.create'
      ? confirmed(op, { issueId: '42' })
      : confirmed(op, {})))
    const { sessionId } = await groupAndSession(hub)
    const created = await hub.handle(MASTER, {
      kind: 'action.create', requestId: 'a0', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'review', reason: 'r', expectedResult: 'e', replyRequired: false,
    })
    const actionId = (created.reply as { action: { actionId: string } }).action.actionId
    const submitted = await hub.handle(PEER, { kind: 'action.submit', requestId: 'a1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(submitted.ok).toBe(false)
    const listed = await hub.handle(MASTER, { kind: 'action.list', requestId: 'a2', sessionId })
    const state = (listed.reply as { actions: readonly { actionId: string; state: string }[] }).actions.find((a) => a.actionId === actionId)?.state
    expect(state).toBe('unknown')
  })

  it('keeps the projection open when a close is unconfirmable across a restart', async () => {
    const store = jsonStore()
    const hub = hubWith(store, async (op) => (op.kind === 'issue.close'
      ? { code: 'UNAVAILABLE', message: 'no receipt' }
      : issueOk(op)))
    const { sessionId } = await groupAndSession(hub)
    await hub.handle(MASTER, {
      kind: 'issue.close', requestId: 'c0', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'shipped',
    })
    const restoredState = JSON.parse(JSON.stringify(store.state.current)) as GroupHubSnapshot
    // The close took effect in Vikunja but its receipt was lost, and Vikunja was
    // reopened afterwards. Recovery reads back and must not write closed again.
    const restored = hubWith({ load: () => restoredState, save: () => undefined }, async (op) => (op.kind === 'issue.query'
      ? confirmed(op, { issueId: '42', actualState: 'open' })
      : issueOk(op)))
    const queried = await restored.handle(MASTER, { kind: 'issue.query', requestId: 'q0', sessionId })
    expect((queried.reply as { session: { state: string } }).session.state).toBe('open')
    // The stale close stays recorded as unknown; it is never replayed as a write.
    expect(restoredState.operations.at(-1)?.state).toBe('unknown')
  })
})

describe('review findings 4 and 5: membership and initiator-only close', () => {
  it('denies history, ack, action list and issue creation to a non-member', async () => {
    const hub = hubWith(jsonStore(), async (op) => issueOk(op))
    const { groupId, sessionId } = await groupAndSession(hub)
    const page = await hub.handle(STRANGER, { kind: 'message.page', requestId: 'p0', groupId })
    expect(page.ok).toBe(false)
    const ack = await hub.handle(STRANGER, { kind: 'message.ack', requestId: 'a0', groupId, upToSequence: 1 })
    expect(ack.ok).toBe(false)
    const create = await hub.handle(STRANGER, {
      kind: 'issue.create', requestId: 'i9', commitId: 'ic9', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b',
    })
    expect(create.ok).toBe(false)
    const listed = await hub.handle(STRANGER, { kind: 'action.list', requestId: 'l0', sessionId })
    expect((listed.reply as { actions: readonly Action[] }).actions).toHaveLength(0)
  })

  it('ignores a client-supplied close delegate list', async () => {
    const hub = hubWith(jsonStore(), async (op) => issueOk(op))
    const { sessionId } = await groupAndSession(hub)
    const closed = await hub.handle(PEER, {
      kind: 'issue.close', requestId: 'c0', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'x', delegates: ['agent-b'],
    })
    expect(closed.ok).toBe(false)
    expect(closed.ok ? '' : closed.error.code).toBe('FORBIDDEN')
  })
})

describe('review finding 9: storage is JSON-safe', () => {
  it('keeps watermarks across a snapshot round-trip', async () => {
    const store = jsonStore()
    const hub = hubWith(store, async (op) => issueOk(op))
    const { groupId } = await groupAndSession(hub)
    const sent = await hub.handle(MASTER, {
      kind: 'message.send', requestId: 'm0', commitId: 'mc1', groupId, body: 'hello', targetAgentIds: ['agent-a'], replyRequired: false,
    })
    const sequence = (sent.reply as { sequence: number }).sequence
    const ack = await hub.handle(PEER, { kind: 'message.ack', requestId: 'a0', groupId, upToSequence: sequence })
    expect(ack.ok).toBe(true)
    const restoredState = JSON.parse(JSON.stringify(store.state.current)) as GroupHubSnapshot
    expect(restoredState.logs[0]?.watermarks).toHaveLength(1)
    const restored = hubWith({ load: () => restoredState, save: () => undefined }, async (op) => issueOk(op))
    // A second ack with the same value must not throw on a plain-object watermark.
    const again = await restored.handle(PEER, { kind: 'message.ack', requestId: 'a1', groupId, upToSequence: sequence })
    expect(again.ok).toBe(true)
    const page = await restored.handle(PEER, { kind: 'message.page', requestId: 'p0', groupId })
    expect(page.ok).toBe(true)
  })
})

describe('acceptance 8: a read converges the projection to the external state', () => {
  it('closes and reopens the session from an observed Vikunja state', async () => {
    let external: 'open' | 'closed' = 'open'
    const hub = hubWith(jsonStore(), async (op) => {
      if (op.kind === 'issue.create') return confirmed(op, { issueId: '42' })
      if (op.kind === 'issue.query') return confirmed(op, { issueId: '42', actualState: external })
      return issueOk(op)
    })
    const { sessionId } = await groupAndSession(hub)
    // The initiator closes in Vikunja; Teams sees it on the next read.
    external = 'closed'
    const closed = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q1', sessionId })
    expect((closed.reply as { session: { state: string } }).session.state).toBe('closed')
    external = 'open'
    const reopened = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q2', sessionId })
    expect((reopened.reply as { session: { state: string } }).session.state).toBe('open')
  })

  it('keeps the projection when the read fails', async () => {
    const hub = hubWith(jsonStore(), async (op) => (op.kind === 'issue.query'
      ? { code: 'UNAVAILABLE', message: 'no read owner' }
      : issueOk(op)))
    const { sessionId } = await groupAndSession(hub)
    const queried = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q1', sessionId })
    expect(queried.ok).toBe(true)
    expect((queried.reply as { session: { state: string } }).session.state).toBe('open')
  })
})

describe('acceptance 8 over the bridge: the read receipt is accepted', () => {
  it('converges from a read delegated to the owner', async () => {
    let external: 'open' | 'closed' = 'open'
    const store = jsonStore()
    const responder = (agentId: string, frame: Record<string, unknown>) => {
      const params = (frame.params ?? {}) as Record<string, unknown>
      const commitId = typeof params.commitId === 'string' ? params.commitId : String(frame.opId)
      const result = frame.opKind === 'issue.query' ? { issueId: '42', actualState: external }
        : frame.opKind === 'issue.create' ? { issueId: '42' }
          : frame.opKind === 'issue.close' ? { issueId: '42', expectedState: 'closed', actualState: 'closed' }
            : frame.opKind === 'issue.reopen' ? { issueId: '42', expectedState: 'open', actualState: 'open' }
              : { resultRef: 'comment:1' }
      const actor = { agentId, accountId: 'acct', scopeId: 'scope' }
      queueMicrotask(() => { void hub.handle(actor, { kind: 'op.confirmed', opId: String(frame.opId), commitId, result }) })
    }
    const hub = createGroupHub({
      store,
      isOnline: () => true,
      externalOpTimeoutMs: 1_000,
      sendToAgent: (agentId, frame) => responder(agentId, frame as Record<string, unknown>),
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
    })
    const { sessionId } = await groupAndSession(hub)
    // The initiator closes in Vikunja. The owner echoes the query commit id, so
    // the hub accepts the receipt and converges.
    external = 'closed'
    const queried = await hub.handle(MASTER, { kind: 'issue.query', requestId: 'q1', sessionId })
    expect(queried.ok).toBe(true)
    expect((queried.reply as { session: { state: string } }).session.state).toBe('closed')
  })
})

describe('review finding 10: only unstarted work is executable', () => {
  const base: Action = {
    actionId: 'a1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-c', assigneeAgentId: 'agent-b',
    kind: 'review', state: 'pending', reason: 'r', expectedResult: 'e', replyRequired: false,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
  }
  it('executes pending only', () => {
    expect(actionNeedsExecutionFor(base, 'agent-b')).toBe(true)
    for (const state of ['failed', 'blocked', 'unknown', 'cancel_requested', 'in_progress', 'completed', 'cancelled', 'refused'] as const) {
      expect(actionNeedsExecutionFor({ ...base, state }, 'agent-b')).toBe(false)
    }
  })
})

describe('issue.reference needs a confirmed read of the target issue', () => {
  async function groupFor(hub: ReturnType<typeof createGroupHub>): Promise<string> {
    const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'g0', name: 'release' })
    if (!created.ok) throw new Error('create failed')
    return (created.reply as { group: { groupId: string } }).group.groupId
  }

  it('binds the real project and state from a confirmed read', async () => {
    const hub = hubWith(jsonStore(), async (op) => (op.kind === 'issue.query'
      ? confirmed(op, { issueId: '99', projectId: 'p9', actualState: 'closed' })
      : issueOk(op)))
    const groupId = await groupFor(hub)
    const referenced = await hub.handle(OWNER, { kind: 'issue.reference', requestId: 'r0', commitId: 'rc1', groupId, vikunjaIssueId: '99' })
    expect(referenced.ok).toBe(true)
    const session = (referenced.reply as { session: { vikunjaProjectId: string; state: string } }).session
    expect(session.vikunjaProjectId).toBe('p9')
    expect(session.state).toBe('closed')
  })

  it('keeps an unconfirmed reference unbound instead of inventing a session', async () => {
    const hub = hubWith(jsonStore(), async (op) => (op.kind === 'issue.query'
      ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' } as ExternalOpReceipt
      : issueOk(op)))
    const groupId = await groupFor(hub)
    const referenced = await hub.handle(OWNER, { kind: 'issue.reference', requestId: 'r0', commitId: 'rc1', groupId, vikunjaIssueId: '99' })
    expect(referenced.ok).toBe(false)
    if (!referenced.ok) expect(referenced.error.code).toBe('RESULT_UNKNOWN')
  })

  it('refuses a reference the read confirms without a project', async () => {
    const hub = hubWith(jsonStore(), async (op) => (op.kind === 'issue.query'
      ? confirmed(op, { issueId: '99', actualState: 'open' })
      : issueOk(op)))
    const groupId = await groupFor(hub)
    const referenced = await hub.handle(OWNER, { kind: 'issue.reference', requestId: 'r0', commitId: 'rc1', groupId, vikunjaIssueId: '99' })
    expect(referenced.ok).toBe(false)
    if (!referenced.ok) expect(referenced.error.code).toBe('UPSTREAM_ERROR')
  })

  it('returns the same session for a repeated reference without a second read', async () => {
    let reads = 0
    const hub = hubWith(jsonStore(), async (op) => {
      if (op.kind === 'issue.query') { reads += 1; return confirmed(op, { issueId: '99', projectId: 'p9', actualState: 'open' }) }
      return issueOk(op)
    })
    const groupId = await groupFor(hub)
    const first = await hub.handle(OWNER, { kind: 'issue.reference', requestId: 'r0', commitId: 'rc1', groupId, vikunjaIssueId: '99' })
    const second = await hub.handle(OWNER, { kind: 'issue.reference', requestId: 'r1', commitId: 'rc1', groupId, vikunjaIssueId: '99' })
    expect(first.ok && second.ok).toBe(true)
    const one = (first.reply as { session: { sessionId: string } }).session.sessionId
    const two = (second.reply as { session: { sessionId: string } }).session.sessionId
    expect(two).toBe(one)
    expect(reads).toBe(1)
  })
})
