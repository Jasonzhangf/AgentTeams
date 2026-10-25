import { describe, expect, it } from 'vitest'
import type { ExternalOp } from '../packages/shared/src/group-wire.ts'
import type { ExternalOpReceipt } from './group-external-ops.ts'
import { createGroupHub, type GroupHubSnapshot, type GroupHubStore } from './group-hub.ts'

const OWNER = { agentId: 'agent-a', accountId: 'acct', scopeId: 'scope' }
const PEER = { agentId: 'agent-b', accountId: 'acct', scopeId: 'scope' }
const MASTER = { agentId: 'agent-c', accountId: 'acct', scopeId: 'scope' }

function memoryStore(): GroupHubStore & { readonly snapshots: GroupHubSnapshot[] } {
  const snapshots: GroupHubSnapshot[] = []
  let current: GroupHubSnapshot | undefined
  return {
    snapshots,
    load: () => current,
    save: (snapshot) => { current = snapshot; snapshots.push(snapshot) },
  }
}

function hubWith(executor?: (op: ExternalOp) => Promise<ExternalOpReceipt | { code: 'UNAVAILABLE'; message: string }>, online: readonly string[] = ['agent-a', 'agent-b']) {
  const store = memoryStore()
  const hub = createGroupHub({
    store,
    isOnline: (id) => online.includes(id),
    ...(executor === undefined ? {} : { executeExternalOp: executor }),
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
  })
  return { hub, store }
}

function confirmed(op: ExternalOp, result: unknown, fromAgentId = op.ownerAgentId): ExternalOpReceipt {
  return { opId: op.opId, commitId: op.commitId, fromAgentId, state: 'confirmed', result: result as never }
}

async function withPeer(hub: ReturnType<typeof createGroupHub>) {
  const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'r0', name: 'release' })
  if (!created.ok) throw new Error('group create failed')
  const groupId = (created.reply as { group: { groupId: string } }).group.groupId
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'r0i', groupId, agentId: 'agent-b', role: 'peer' })
  await hub.handle(PEER, { kind: 'group.respond', requestId: 'r0r', groupId, accept: true })
  return groupId
}

async function groupWithPeer() {
  const { hub, store } = hubWith()
  const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'r-create', name: 'release' })
  if (!created.ok) throw new Error('group create failed')
  const groupId = (created.reply as { group: { groupId: string } }).group.groupId
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'r-invite', groupId, agentId: 'agent-b', role: 'peer' })
  await hub.handle(PEER, { kind: 'group.respond', requestId: 'r-respond', groupId, accept: true })
  return { hub, store, groupId }
}

/**
 * Adds a master that explicitly commands the peer. One `mastersOf` edge serves
 * both directions, so this group also lets the peer request that master.
 */
async function addMaster(hub: ReturnType<typeof createGroupHub>, groupId: string, online: readonly string[] = ['agent-a', 'agent-b', 'agent-c']) {
  await hub.handle(OWNER, { kind: 'group.invite', requestId: 'r-master', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b'] })
  await hub.handle(MASTER, { kind: 'group.respond', requestId: 'r-master-ok', groupId, accept: true })
  return online
}

describe('group lifecycle', () => {
  it('creates a group with the caller as owner and lists it for members only', async () => {
    const { hub } = hubWith()
    const created = await hub.handle(OWNER, { kind: 'group.create', requestId: 'r1', name: 'release' })
    expect(created.ok).toBe(true)
    const group = (created.reply as { group: { ownerAgentId: string } }).group
    expect(group.ownerAgentId).toBe('agent-a')
    const outsider = await hub.handle({ agentId: 'agent-z', accountId: 'acct', scopeId: 'scope' }, { kind: 'group.list', requestId: 'r2' })
    expect(outsider.ok && (outsider.reply as { groups: unknown[] }).groups).toHaveLength(0)
  })

  it('rejects an invitation from a member that is not the owner', async () => {
    const { hub, groupId } = await groupWithPeer()
    const result = await hub.handle(PEER, { kind: 'group.invite', requestId: 'r3', groupId, agentId: 'agent-c', role: 'peer' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('FORBIDDEN')
  })

  it('closes the member interval on leave and refuses a later invite while still absent', async () => {
    const { hub, groupId } = await groupWithPeer()
    const left = await hub.handle(PEER, { kind: 'group.leave', requestId: 'r4', groupId })
    expect(left.ok).toBe(true)
    const groups = await hub.handle(PEER, { kind: 'group.list', requestId: 'r5' })
    expect(groups.ok && (groups.reply as { groups: unknown[] }).groups).toHaveLength(0)
  })
})

describe('messages', () => {
  it('appends a message, pushes to the other online member and dedupes the same commit', async () => {
    const { hub, groupId } = await groupWithPeer()
    const first = await hub.handle(OWNER, {
      kind: 'message.send', requestId: 'r1', commitId: 'c1', groupId,
      targetAgentIds: ['agent-b'], replyRequired: true, body: 'please review',
    })
    expect(first.ok).toBe(true)
    expect(first.ok && first.pushes?.map((push) => push.agentId)).toEqual(['agent-b'])
    const retry = await hub.handle(OWNER, {
      kind: 'message.send', requestId: 'r2', commitId: 'c1', groupId,
      targetAgentIds: ['agent-b'], replyRequired: true, body: 'please review',
    })
    expect(retry.ok && (retry.reply as { sequence: number }).sequence).toBe(1)
  })

  it('rejects a target set that is not the action assignee', async () => {
    const { hub, groupId } = await groupWithPeer()
    const created = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'r1', commitId: 'ac1', sessionId: 's1',
      assigneeAgentId: 'agent-b', actionKind: 'review', reason: 'check the plan', expectedResult: 'a verdict', replyRequired: true,
    })
    // The session does not exist yet, so the action creation is rejected first.
    expect(created.ok).toBe(false)
    const sent = await hub.handle(OWNER, {
      kind: 'message.send', requestId: 'r2', commitId: 'c1', groupId,
      targetAgentIds: ['agent-a'], replyRequired: true, body: 'x',
    })
    expect(sent.ok).toBe(true)
  })

  it('advances a watermark forward and rejects a backward move', async () => {
    const { hub, groupId } = await groupWithPeer()
    await hub.handle(OWNER, { kind: 'message.send', requestId: 'r1', commitId: 'c1', groupId, targetAgentIds: ['agent-b'], replyRequired: false, body: 'one' })
    const acked = await hub.handle(PEER, { kind: 'message.ack', requestId: 'r2', groupId, upToSequence: 1 })
    expect(acked.ok).toBe(true)
    const backward = await hub.handle(PEER, { kind: 'message.ack', requestId: 'r3', groupId, upToSequence: 0 })
    expect(backward.ok).toBe(false)
  })
})

describe('issue and action through the delegated owner', () => {
  it('projects a session only after the delegated create is confirmed', async () => {
    const withExecutor = createGroupHub({
      isOnline: (id) => ['agent-a', 'agent-b'].includes(id),
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
      executeExternalOp: async (op) => confirmed(op, { issueId: '42' }),
    })
    const createdGroup = await withExecutor.handle(OWNER, { kind: 'group.create', requestId: 'r0', name: 'release' })
    const groupId = (createdGroup.reply as { group: { groupId: string } }).group.groupId
    const created = await withExecutor.handle(OWNER, {
      kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId,
      vikunjaProjectId: 'p1', title: 'ship', body: 'body',
    })
    expect(created.ok).toBe(true)
    const session = (created.reply as { session: { vikunjaIssueId: string; state: string } }).session
    expect(session.vikunjaIssueId).toBe('42')
    expect(session.state).toBe('open')
  })

  it('does not project closed when the external state still reports open', async () => {
    const withExecutor = createGroupHub({
      isOnline: (id) => ['agent-a', 'agent-b'].includes(id),
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
      executeExternalOp: async (op) => confirmed(op, op.kind === 'issue.close'
        ? { issueId: '42', expectedState: 'closed', actualState: 'open' }
        : { issueId: '42' }),
    })
    const createdGroup = await withExecutor.handle(OWNER, { kind: 'group.create', requestId: 'r0', name: 'release' })
    const groupId = (createdGroup.reply as { group: { groupId: string } }).group.groupId
    const created = await withExecutor.handle(OWNER, {
      kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId,
      vikunjaProjectId: 'p1', title: 'ship', body: 'body',
    })
    const sessionId = (created.reply as { session: { sessionId: string } }).session.sessionId
    const closed = await withExecutor.handle(OWNER, {
      kind: 'issue.close', requestId: 'r2', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'shipped',
    })
    expect(closed.ok).toBe(true)
    const reply = closed.reply as { outcome: string; session: { state: string } }
    expect(reply.outcome).toBe('conflict')
    expect(reply.session.state).toBe('open')
  })

  it('rejects a receipt that does not come from the delegated owner', async () => {
    const wrongOwner = createGroupHub({
      isOnline: (id) => ['agent-a', 'agent-b'].includes(id),
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
      executeExternalOp: async (op) => confirmed(op, { issueId: '42' }, 'agent-mallory'),
    })
    const created = await wrongOwner.handle(OWNER, { kind: 'group.create', requestId: 'r0', name: 'release' })
    const groupId = (created.reply as { group: { groupId: string } }).group.groupId
    const issue = await wrongOwner.handle(OWNER, {
      kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId,
      vikunjaProjectId: 'p1', title: 'ship', body: 'body',
    })
    expect(issue.ok).toBe(false)
    expect(issue.ok ? '' : issue.error.code).toBe('FORBIDDEN')
  })

  it('refuses an action change from a member that is not the assignee', async () => {
    const { hub, groupId } = await groupWithPeer()
    const withExecutor = createGroupHub({
      isOnline: (id) => ['agent-a', 'agent-b'].includes(id),
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
      executeExternalOp: async (op) => confirmed(op, { issueId: '42' }),
    })
    const groupId2 = await withPeer(withExecutor)
    await addMaster(withExecutor, groupId2)
    const issue = await withExecutor.handle(OWNER, {
      kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId: groupId2,
      vikunjaProjectId: 'p1', title: 'ship', body: 'body',
    })
    const sessionId = (issue.reply as { session: { sessionId: string } }).session.sessionId
    const action = await withExecutor.handle(MASTER, {
      kind: 'action.create', requestId: 'r2', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'review', reason: 'check the plan', expectedResult: 'a verdict', replyRequired: true,
    })
    expect(action.ok).toBe(true)
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    // A peer cannot refuse a master assignment; it can only report.
    const wrong = await withExecutor.handle(PEER, { kind: 'action.refuse', requestId: 'r3', actionId, reason: 'no' })
    expect(wrong.ok).toBe(false)
    expect(wrong.ok ? '' : wrong.error.code).toBe('FORBIDDEN')
    // The same edge lets the peer request the master, and the master may refuse.
    const request = await withExecutor.handle(PEER, {
      kind: 'action.create', requestId: 'r4', commitId: 'ac2', sessionId,
      assigneeAgentId: 'agent-c', actionKind: 'reply', reason: 'need a decision', expectedResult: 'an answer', replyRequired: true,
    })
    expect(request.ok).toBe(true)
    const requestId = (request.reply as { action: { actionId: string } }).action.actionId
    const refused = await withExecutor.handle(MASTER, { kind: 'action.refuse', requestId: 'r5', actionId: requestId, reason: 'out of scope' })
    expect(refused.ok).toBe(true)
    expect((refused.reply as { action: { state: string } }).action.state).toBe('refused')
  })
})

describe('issue list', () => {
  function sessionsOf(reply: unknown): readonly { sessionId: string; groupId: string }[] {
    return (reply as { sessions: readonly { sessionId: string; groupId: string }[] }).sessions
  }

  it('lists the sessions of one group so a page restores them without history', async () => {
    const { hub } = hubWith(async (op) => confirmed(op, { issueId: `issue-${op.commitId}` }))
    const first = await hub.handle(OWNER, { kind: 'group.create', requestId: 'r1', name: 'one' })
    const second = await hub.handle(OWNER, { kind: 'group.create', requestId: 'r2', name: 'two' })
    const firstId = (first.reply as { group: { groupId: string } }).group.groupId
    const secondId = (second.reply as { group: { groupId: string } }).group.groupId
    await hub.handle(OWNER, {
      kind: 'issue.create', requestId: 'r3', commitId: 'ic1', groupId: firstId,
      vikunjaProjectId: 'p1', title: 'ship', body: 'body',
    })
    await hub.handle(OWNER, {
      kind: 'issue.create', requestId: 'r4', commitId: 'ic2', groupId: secondId,
      vikunjaProjectId: 'p1', title: 'other', body: 'body',
    })

    const listed = await hub.handle(OWNER, { kind: 'issue.list', requestId: 'r5', groupId: firstId })
    expect(listed.ok).toBe(true)
    expect(sessionsOf(listed.reply)).toHaveLength(1)
    expect(sessionsOf(listed.reply)[0]?.groupId).toBe(firstId)
    expect(sessionsOf(listed.reply).every((session) => session.groupId === firstId)).toBe(true)

    // The list is the real ledger read: a replayed frame names the same session.
    const again = await hub.handle(OWNER, { kind: 'issue.list', requestId: 'r6', groupId: firstId })
    expect(sessionsOf(again.reply)).toEqual(sessionsOf(listed.reply))
  })

  it('refuses a group the actor does not belong to', async () => {
    const { hub, groupId } = await groupWithPeer()
    const stranger = await hub.handle({ agentId: 'agent-z', accountId: 'acct', scopeId: 'scope' }, {
      kind: 'issue.list', requestId: 'r1', groupId,
    })
    expect(stranger.ok).toBe(false)
    expect(stranger.ok ? '' : stranger.error.code).toBe('FORBIDDEN')
  })
})

describe('group grant', () => {
  function memberEdges(reply: unknown, agentId: string): readonly string[] | undefined {
    const group = (reply as { group: { members: { agentId: string; mastersOf: readonly string[] }[] } }).group
    return group.members.find((member) => member.agentId === agentId)?.mastersOf
  }

  it('lets the owner open the command edge a real action then uses', async () => {
    const withExecutor = createGroupHub({
      isOnline: (id) => ['agent-a', 'agent-b', 'agent-c'].includes(id),
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
      executeExternalOp: async (op) => confirmed(op, op.kind === 'action.result' ? { resultRef: 'comment-1' } : { issueId: '42' }),
    })
    const groupId = await withPeer(withExecutor)
    const issue = await withExecutor.handle(OWNER, {
      kind: 'issue.create', requestId: 'r-issue', commitId: 'ic1', groupId,
      vikunjaProjectId: 'p1', title: 'ship', body: 'body',
    })
    const sessionId = (issue.reply as { session: { sessionId: string } }).session.sessionId
    // The owner runs the group but owns no edge, so assignment to its peer is refused.
    const before = await withExecutor.handle(OWNER, {
      kind: 'action.create', requestId: 'r-before', commitId: 'ac0', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'review', reason: 'check the plan', expectedResult: 'a verdict', replyRequired: true,
    })
    expect(before.ok).toBe(false)
    expect(before.ok ? '' : before.error.code).toBe('FORBIDDEN')

    const granted = await withExecutor.handle(OWNER, {
      kind: 'group.grant', requestId: 'r-grant', groupId, agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'],
    })
    expect(granted.ok).toBe(true)
    expect(memberEdges(granted.reply, 'agent-a')).toEqual(['agent-b'])
    expect(granted.ok && granted.pushes?.map((push) => push.agentId)).toEqual(['agent-a'])

    const action = await withExecutor.handle(OWNER, {
      kind: 'action.create', requestId: 'r-after', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'review', reason: 'check the plan', expectedResult: 'a verdict', replyRequired: true,
    })
    expect(action.ok).toBe(true)
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    const submitted = await withExecutor.handle(PEER, {
      kind: 'action.submit', requestId: 'r-submit', resultCommitId: 'rc1', actionId, resultBody: 'reviewed',
    })
    expect(submitted.ok).toBe(true)
    expect((submitted.reply as { action: { state: string } }).action.state).toBe('completed')

    const intruder = await withExecutor.handle(PEER, {
      kind: 'group.grant', requestId: 'r-intruder', groupId, agentId: 'agent-b', role: 'master', mastersOf: ['agent-a'],
    })
    expect(intruder.ok).toBe(false)
    expect(intruder.ok ? '' : intruder.error.code).toBe('FORBIDDEN')
  })

  it('replaces the command edges of a member instead of appending to them', async () => {
    const { hub, store, groupId } = await groupWithPeer()
    await addMaster(hub, groupId)
    // The invite already gave agent-c the edge to agent-b; the grant replaces it.
    const first = await hub.handle(OWNER, {
      kind: 'group.grant', requestId: 'r1', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b', 'agent-a'],
    })
    expect(first.ok).toBe(true)
    expect(memberEdges(first.reply, 'agent-c')).toEqual(['agent-b', 'agent-a'])
    const narrower = await hub.handle(OWNER, {
      kind: 'group.grant', requestId: 'r2', groupId, agentId: 'agent-c', role: 'master', mastersOf: ['agent-b'],
    })
    expect(memberEdges(narrower.reply, 'agent-c')).toEqual(['agent-b'])
    // The accepted snapshot carries the replaced edges, not a union of every grant.
    expect(store.snapshots[store.snapshots.length - 1]?.groups?.[0]?.members.find((member) => member.agentId === 'agent-c')?.mastersOf)
      .toEqual(['agent-b'])
    // An omitted list keeps a master's edges; an explicit empty list clears them.
    const kept = await hub.handle(OWNER, { kind: 'group.grant', requestId: 'r3', groupId, agentId: 'agent-c', role: 'master' })
    expect(memberEdges(kept.reply, 'agent-c')).toEqual(['agent-b'])
    const cleared = await hub.handle(OWNER, {
      kind: 'group.grant', requestId: 'r4', groupId, agentId: 'agent-c', role: 'master', mastersOf: [],
    })
    expect(memberEdges(cleared.reply, 'agent-c')).toEqual([])
  })

  it('keeps the registry refusals typed: peer edges and absent members are bad input', async () => {
    const { hub, groupId } = await groupWithPeer()
    const peerWithEdges = await hub.handle(OWNER, {
      kind: 'group.grant', requestId: 'r1', groupId, agentId: 'agent-b', role: 'peer', mastersOf: ['agent-a'],
    })
    expect(peerWithEdges.ok).toBe(false)
    expect(peerWithEdges.ok ? '' : peerWithEdges.error.code).toBe('INVALID_INPUT')
    const absent = await hub.handle(OWNER, {
      kind: 'group.grant', requestId: 'r2', groupId, agentId: 'agent-z', role: 'master', mastersOf: [],
    })
    expect(absent.ok).toBe(false)
    expect(absent.ok ? '' : absent.error.code).toBe('INVALID_INPUT')
    const unknownGroup = await hub.handle(OWNER, {
      kind: 'group.grant', requestId: 'r3', groupId: 'nope', agentId: 'agent-b', role: 'peer',
    })
    expect(unknownGroup.ok).toBe(false)
    expect(unknownGroup.ok ? '' : unknownGroup.error.code).toBe('INVALID_INPUT')
  })
})

describe('external op convergence and admission', () => {
  function scripted(script: (op: ExternalOp) => ExternalOpReceipt | { code: 'UNAVAILABLE'; message: string }) {
    const calls: ExternalOp[] = []
    const store = memoryStore()
    let at = Date.parse('2026-10-22T00:00:00.000Z')
    const hub = createGroupHub({
      store,
      isOnline: () => true,
      now: () => new Date(at),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
      executeExternalOp: async (op) => { calls.push(op); return script(op) },
    })
    const advance = (ms: number): void => { at += ms }
    return { hub, calls, store, advance }
  }
  /** One group, one peer, and the owner's own command edge, so it can assign work. */
  async function groupWithEdge(hub: ReturnType<typeof createGroupHub>) {
    const groupId = await withPeer(hub)
    const granted = await hub.handle(OWNER, {
      kind: 'group.grant', requestId: 'r-edge', groupId, agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'],
    })
    if (!granted.ok) throw new Error('grant failed')
    return groupId
  }
  function lastOps(store: ReturnType<typeof memoryStore>) {
    return store.snapshots[store.snapshots.length - 1]?.ops ?? []
  }
  function sessionIdOf(reply: unknown): string {
    return (reply as { session: { sessionId: string } }).session.sessionId
  }
  function stateOf(reply: unknown): string {
    return (reply as { session: { state: string } }).session.state
  }

  it('persists a definite external failure with its own code instead of unknown', async () => {
    const { hub, store } = scripted((op) => op.kind === 'issue.create'
      ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'failed', error: { code: 'FORBIDDEN', message: 'token lacks project scope' } }
      : confirmed(op, { issueId: '42' }))
    const groupId = await withPeer(hub)
    const refused = await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error.code).toBe('FORBIDDEN')
    const recorded = lastOps(store).find((op) => op.commitId === 'ic1')
    expect(recorded?.state).toBe('failed')
    expect(recorded?.error?.code).toBe('FORBIDDEN')
    // A restart must not turn a definite refusal into an unknown one.
    const restarted = createGroupHub({
      store, isOnline: () => true,
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
      executeExternalOp: async (op) => confirmed(op, { issueId: '42' }),
    })
    const retried = await restarted.handle(OWNER, { kind: 'issue.create', requestId: 'r2', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })
    expect(retried.ok).toBe(false)
    expect(retried.ok ? '' : retried.error.code).toBe('FORBIDDEN')
  })

  it('keeps an unconfirmable write unknown and never reports success', async () => {
    const { hub, store } = scripted((op) => op.kind === 'issue.create'
      ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
      : confirmed(op, { issueId: '42' }))
    const groupId = await withPeer(hub)
    const wrote = await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })
    expect(wrote.ok).toBe(false)
    expect(lastOps(store).find((op) => op.commitId === 'ic1')?.state).toBe('unknown')
  })

  it('recovers an unknown create by reading its stable reference back', async () => {
    let creates = 0
    const { hub } = scripted((op) => {
      if (op.kind === 'issue.create') {
        creates += 1
        return creates === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, issueId: '42' })
      return confirmed(op, { issueId: '42' })
    })
    const groupId = await withPeer(hub)
    const first = await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })
    expect(first.ok).toBe(false)
    const recovered = await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r2', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })
    expect(recovered.ok).toBe(true)
    expect(sessionIdOf(recovered.reply)).toContain('42')
    // The recovery is a read: no second create was issued.
    expect(creates).toBe(1)
  })

  it('recovers an unknown result by reading its comment back', async () => {
    let writes = 0
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'action.result') {
        writes += 1
        return writes === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { resultRef: 'comment:unexpected' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, resultRef: 'comment:1' })
      return confirmed(op, { issueId: '42' })
    })
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const action = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    const first = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(first.ok).toBe(false)
    const second = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(second.ok).toBe(true)
    const recovered = (second.reply as { action: { state: string; resultRef?: string; resultCommitId?: string } }).action
    expect(recovered.state).toBe('completed')
    expect(recovered.resultCommitId).toBe('rc1')
    expect(recovered.resultRef).toBe('comment:1')
    // The recovery read is the only extra call; the comment was written once.
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
    expect(calls.filter((op) => op.kind === 'issue.recover')).toHaveLength(1)
  })

  it('keeps an unknown result unknown when recovery finds nothing', async () => {
    let writes = 0
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'action.result') {
        writes += 1
        return writes === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { resultRef: 'comment:unexpected' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: false })
      return confirmed(op, { issueId: '42' })
    })
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const action = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    const first = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(first.ok).toBe(false)
    const second = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(second.ok).toBe(false)
    expect(second.ok ? '' : second.error.code).toBe('RESULT_UNKNOWN')
    const listed = await hub.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    const stored = (listed.reply as { actions: readonly { actionId: string; state: string; resultRef?: string }[] })
      .actions.find((entry) => entry.actionId === actionId)
    expect(stored?.state).toBe('unknown')
    expect(stored?.resultRef).toBeUndefined()
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
  })

  it('answers a state read that failed as unconfirmed, not as a fresh open session', async () => {
    let down = false
    const { hub } = scripted((op) => {
      if (op.kind === 'issue.query') {
        return down ? { code: 'UNAVAILABLE', message: 'vikunja unreachable' } : confirmed(op, { issueId: '42', actualState: 'open' })
      }
      return confirmed(op, { issueId: '42' })
    })
    const groupId = await withPeer(hub)
    const created = await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })
    const sessionId = sessionIdOf(created.reply)
    down = true
    const queried = await hub.handle(OWNER, { kind: 'issue.query', requestId: 'q1', sessionId })
    expect(queried.ok).toBe(false)
    expect(queried.ok ? '' : queried.error.code).toBe('UNAVAILABLE')
    expect(queried.ok ? '' : queried.error.message).toMatch(/unconfirmed|read/i)
  })

  it('refuses a new result commit on a finished action before writing another comment', async () => {
    const { hub, calls } = scripted((op) => op.kind === 'action.result'
      ? confirmed(op, { resultRef: 'comment:1' })
      : confirmed(op, { issueId: '42' }))
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const action = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    const first = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(first.ok).toBe(true)
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
    const late = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc2', actionId, resultBody: 'late' })
    expect(late.ok).toBe(false)
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
  })

  it('returns the original result for a repeated result commit without a second write', async () => {
    const { hub, calls } = scripted((op) => op.kind === 'action.result'
      ? confirmed(op, { resultRef: 'comment:1' })
      : confirmed(op, { issueId: '42' }))
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const action = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    const first = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    const again = await hub.handle(PEER, { kind: 'action.submit', requestId: 's2', resultCommitId: 'rc1', actionId, resultBody: 'done' })
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(true)
    const a = (first.reply as { action: { resultRef?: string } }).action
    const b = (again.reply as { action: { resultRef?: string } }).action
    expect(b.resultRef).toBe(a.resultRef)
    expect(calls.filter((op) => op.kind === 'action.result')).toHaveLength(1)
  })

  it('lets the assignee report a pending action and keeps the reason and evidence', async () => {
    const { hub, store } = scripted((op) => confirmed(op, { issueId: '42' }))
    const groupId = await groupWithEdge(hub)
    // A member that is not the assignee may hold an unrelated role and still
    // cannot report this action.
    await hub.handle(OWNER, { kind: 'group.invite', requestId: 'r-nonassignee', groupId, agentId: 'agent-c', role: 'peer' })
    await hub.handle(MASTER, { kind: 'group.respond', requestId: 'r-nonassignee-ok', groupId, accept: true })
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const action = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    const reported = await hub.handle(PEER, {
      kind: 'action.report', requestId: 'p1', actionId, report: 'blocked', reason: 'upstream is closed today', evidence: { ticket: 'T-1' },
    })
    expect(reported.ok).toBe(true)
    const hijacked = await hub.handle(MASTER, {
      kind: 'action.report', requestId: 'p2', actionId, report: 'failed', reason: 'not mine to report',
    })
    expect(hijacked.ok).toBe(false)
    expect(hijacked.ok ? '' : hijacked.error.code).toBe('FORBIDDEN')

    const deps = {
      store,
      isOnline: () => true,
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `restart-${++n}` })(),
      executeExternalOp: async (op: ExternalOp) => confirmed(op, { issueId: '42' }),
    }
    // A real restart: the second hub loads the same store and reads the record back.
    const restarted = createGroupHub(deps)
    const listed = await restarted.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    const restored = (listed.reply as { actions: readonly { actionId: string; state: string; report?: { report: string; reason: string; evidence?: unknown } }[] })
      .actions.find((entry) => entry.actionId === actionId)
    expect(restored).toMatchObject({
      actionId,
      state: 'blocked',
      report: { report: 'blocked', reason: 'upstream is closed today', evidence: { ticket: 'T-1' } },
    })

    // The same durable path keeps a failed report and its reason.
    const failedAction = await restarted.handle(OWNER, {
      kind: 'action.create', requestId: 'a2', commitId: 'ac2', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r2', expectedResult: 'e2', replyRequired: false,
    })
    const failedId = (failedAction.reply as { action: { actionId: string } }).action.actionId
    const failedReport = await restarted.handle(PEER, {
      kind: 'action.report', requestId: 'p3', actionId: failedId, report: 'failed', reason: 'builder rejected the change',
    })
    expect(failedReport.ok).toBe(true)
    const second = createGroupHub(deps)
    const relisted = await second.handle(OWNER, { kind: 'action.list', requestId: 'l2', sessionId })
    const actions = (relisted.reply as { actions: readonly { actionId: string; state: string; report?: { report: string; reason: string } }[] }).actions
    expect(actions.find((entry) => entry.actionId === failedId))
      .toMatchObject({ state: 'failed', report: { report: 'failed', reason: 'builder rejected the change' } })
    // The foreign report changed nothing: the blocked record still reads the same.
    expect(actions.find((entry) => entry.actionId === actionId))
      .toMatchObject({ actionId, state: 'blocked', report: { report: 'blocked', reason: 'upstream is closed today' } })
  })

  it('takes pending work out of the executable set when the issue closes', async () => {
    const { hub } = scripted((op) => (op.kind === 'issue.close'
      ? confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      : confirmed(op, { issueId: '42' })))
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const action = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(true)
    const listed = await hub.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    const stored = (listed.reply as { actions: readonly { actionId: string; state: string }[] }).actions.find((entry) => entry.actionId === actionId)
    expect(stored?.state).not.toBe('pending')
    expect(['cancelled', 'cancel_requested']).toContain(stored?.state)
  })

  it('refuses a new action when the external state has closed the issue', async () => {
    let externalState: 'open' | 'closed' = 'open'
    const { hub } = scripted((op) => (op.kind === 'issue.query'
      ? confirmed(op, { issueId: '42', actualState: externalState })
      : confirmed(op, { issueId: '42' })))
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    externalState = 'closed'
    const refused = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error.code).toBe('CONFLICT')
    const projected = await hub.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    expect((projected.reply as { actions: readonly unknown[] }).actions).toHaveLength(0)
  })

  it('does not revive a cancelled action when the issue reopens', async () => {
    const { hub } = scripted((op) => (op.kind === 'issue.close'
      ? confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      : op.kind === 'issue.reopen'
        ? confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
        : confirmed(op, { issueId: '42' })))
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const action = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const actionId = (action.reply as { action: { actionId: string } }).action.actionId
    await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    const reopened = await hub.handle(OWNER, { kind: 'issue.reopen', requestId: 'o1', commitId: 'oc1', sessionId, reason: 'more work' })
    expect(reopened.ok).toBe(true)
    expect(stateOf(reopened.reply)).toBe('open')
    const listed = await hub.handle(OWNER, { kind: 'action.list', requestId: 'l1', sessionId })
    const stored = (listed.reply as { actions: readonly { actionId: string; state: string }[] }).actions.find((entry) => entry.actionId === actionId)
    expect(stored?.state).toBe('cancelled')
    const resubmitted = await hub.handle(PEER, { kind: 'action.submit', requestId: 's1', resultCommitId: 'rc1', actionId, resultBody: 'late' })
    expect(resubmitted.ok).toBe(false)
  })

  it('recovers an unknown close by reading the actual state back', async () => {
    let closes = 0
    const { hub, calls } = scripted((op) => {
      if (op.kind === 'issue.close') {
        closes += 1
        return closes === 1
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      }
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, actualState: 'closed' })
      return confirmed(op, { issueId: '42' })
    })
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const first = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(first.ok).toBe(false)
    const second = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c2', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(second.ok).toBe(true)
    expect((second.reply as { outcome: string }).outcome).toBe('closed')
    expect(stateOf(second.reply)).toBe('closed')
    // Recovery is a read: the close was written once.
    expect(calls.filter((op) => op.kind === 'issue.close')).toHaveLength(1)
    expect(calls.filter((op) => op.kind === 'issue.recover')).toHaveLength(1)
  })

  it('keeps a conflicting close reading as conflict instead of rewriting', async () => {
    const { hub } = scripted((op) => {
      if (op.kind === 'issue.close') {
        return op.commitId === 'cc1'
          ? { opId: op.opId, commitId: op.commitId, fromAgentId: op.ownerAgentId, state: 'unknown' }
          : confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      }
      if (op.kind === 'issue.reopen') return confirmed(op, { issueId: '42', expectedState: 'open', actualState: 'open' })
      if (op.kind === 'issue.recover') return confirmed(op, { found: true, actualState: 'open' })
      return confirmed(op, { issueId: '42' })
    })
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const stale = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(stale.ok).toBe(false)
    const closed = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c2', commitId: 'cc2', sessionId, reason: 'close again', conclusion: 'ok' })
    expect(closed.ok).toBe(true)
    expect(stateOf(closed.reply)).toBe('closed')
    const reopened = await hub.handle(OWNER, { kind: 'issue.reopen', requestId: 'o1', commitId: 'oc1', sessionId, reason: 'more work' })
    expect(reopened.ok).toBe(true)
    expect(stateOf(reopened.reply)).toBe('open')
    // The stale close is older than the newer close/reopen pair. Its recovery
    // reading must not project the session back to closed.
    const retried = await hub.handle(OWNER, { kind: 'issue.close', requestId: 'c3', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(retried.ok).toBe(true)
    expect((retried.reply as { outcome: string }).outcome).toBe('conflict')
    expect(stateOf(retried.reply)).toBe('open')
  })

  it('reports the actions not confirmed stopped when the issue closes', async () => {
    const { hub, store } = scripted((op) => op.kind === 'issue.close'
      ? confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
      : confirmed(op, { issueId: '42' }))
    const groupId = await groupWithEdge(hub)
    const sessionId = sessionIdOf((await hub.handle(OWNER, { kind: 'issue.create', requestId: 'r1', commitId: 'ic1', groupId, vikunjaProjectId: 'p1', title: 't', body: 'b' })).reply)
    const running = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a1', commitId: 'ac1', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r', expectedResult: 'e', replyRequired: true,
    })
    const runningId = (running.reply as { action: { actionId: string } }).action.actionId
    const queued = await hub.handle(OWNER, {
      kind: 'action.create', requestId: 'a2', commitId: 'ac2', sessionId,
      assigneeAgentId: 'agent-b', actionKind: 'comment', reason: 'r2', expectedResult: 'e2', replyRequired: true,
    })
    const queuedId = (queued.reply as { action: { actionId: string } }).action.actionId
    // Execution start has no public frame in this increment; seed the durable
    // action state and load it back through the real restore path.
    const base = store.snapshots[store.snapshots.length - 1]
    if (!base) throw new Error('missing snapshot')
    const seeded = memoryStore()
    seeded.save({
      ...base,
      actions: base.actions.map((entry) => entry.actionId === runningId ? { ...entry, state: 'in_progress' as const } : entry),
    })
    const restored = createGroupHub({
      store: seeded,
      isOnline: () => true,
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `close-${++n}` })(),
      executeExternalOp: async (op: ExternalOp) => op.kind === 'issue.close'
        ? confirmed(op, { issueId: '42', expectedState: 'closed', actualState: 'closed' })
        : confirmed(op, { issueId: '42' }),
    })
    const closed = await restored.handle(OWNER, { kind: 'issue.close', requestId: 'c1', commitId: 'cc1', sessionId, reason: 'done', conclusion: 'ok' })
    expect(closed.ok).toBe(true)
    const report = (closed.reply as { unstopped: readonly { actionId: string; assigneeAgentId: string; state: string }[] }).unstopped
    expect(report).toContainEqual({ actionId: runningId, assigneeAgentId: 'agent-b', state: 'cancel_requested' })
    // A queued action is cancelled outright, so it is not an unconfirmed stop.
    expect(report.some((entry) => entry.actionId === queuedId)).toBe(false)
  })
})

describe('persistence and restart', () => {
  it('reloads the last snapshot so a restart keeps groups and messages', async () => {
    const store = memoryStore()
    const deps = {
      store,
      isOnline: (id) => ['agent-a', 'agent-b'].includes(id),
      now: () => new Date('2026-10-22T00:00:00.000Z'),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
    }
    const first = createGroupHub(deps)
    const groupId = await withPeer(first)
    await first.handle(OWNER, { kind: 'message.send', requestId: 'r2', commitId: 'c1', groupId, targetAgentIds: ['agent-b'], replyRequired: false, body: 'one' })
    const second = createGroupHub(deps)
    const page = await second.handle(PEER, { kind: 'message.page', requestId: 'r3', groupId })
    expect(page.ok && (page.reply as { messages: unknown[] }).messages).toHaveLength(1)
  })
})
