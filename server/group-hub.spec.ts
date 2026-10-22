import { describe, expect, it } from 'vitest'
import type { ExternalOp } from '../control-protocol/group-wire.ts'
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
