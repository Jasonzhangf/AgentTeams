import { describe, expect, it } from 'vitest'
import { TeamsConsoleController } from '../src/state/controller.ts'
import { createGroupRequestClient, withGroupRequests } from '../src/client/group-client.ts'
import type { GroupRequestOutcome, GroupRequestSender } from '../src/client/group-client.ts'
import type { GroupWireRequest } from '../../../packages/shared/src/group-wire.ts'

/**
 * The controller drives the real group port. A fake transport is used only to script the
 * owner answers a unit test cannot obtain from a live daemon; the client envelope and
 * every state transition are the shipped ones.
 */

const projection = {
  version: 1 as const,
  agents: [
    { kind: 'runtime' as const, agentId: 'control', label: 'Control', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: false as const, sessionAvailability: 'not-applicable' as const },
    { kind: 'runtime' as const, agentId: 'agent-a', label: 'Agent A', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const, currentSessionId: 's1' },
  ],
  sessions: [],
  notifications: [],
  configs: [],
}

const groupsReply = {
  kind: 'group.list' as const,
  requestId: 'ignored',
  groups: [
    { groupId: 'g1', name: 'Alpha', ownerAgentId: 'agent-a', createdAt: '2026-10-20T00:00:00.000Z', members: [{ agentId: 'agent-a', role: 'master' as const, mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] }] },
  ],
}

function scriptedClient(script: (frame: GroupWireRequest) => GroupRequestOutcome): { client: never; sent: GroupWireRequest[]; agents: string[] } {
  const sent: GroupWireRequest[] = []
  const agents: string[] = []
  const sender: GroupRequestSender = {
    requestGroup: async (agentId, frame) => {
      agents.push(agentId)
      sent.push(frame)
      return script(frame)
    },
  }
  const base = {
    readProjection: async () => projection,
    command: async () => ({ ok: true as const, kind: 'connection.connect' as const }),
    sendSession: async () => ({ ok: true as const }),
  }
  return { client: withGroupRequests(base, sender) as never, sent, agents }
}

describe('group workspace controller', () => {
  it('loads the recent group on the groups page and never acts as the control owner', async () => {
    const { client, agents } = scriptedClient(frame => frame.kind === 'group.list'
      ? { kind: 'reply', reply: groupsReply }
      : { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    const state = controller.getSnapshot()
    expect(state.group.listStatus).toBe('ready')
    expect(state.group.selectedGroupId).toBe('g1')
    expect(state.group.actorId).toBe('agent-a')
    expect(agents.every(agentId => agentId !== 'control')).toBe(true)
    expect(agents[0]).toBe('agent-a')
  })

  it('sends the envelope request id and matches the frame request id', async () => {
    const { client, sent } = scriptedClient(frame => frame.kind === 'group.list'
      ? { kind: 'reply', reply: groupsReply }
      : { kind: 'reply', reply: { kind: 'message.sent', requestId: frame.requestId, messageId: 'm1', sequence: 1 } })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    controller.setGroupComposer('hello group')
    const sentOk = await controller.sendGroupMessage()
    expect(sentOk).toBe(true)
    const send = sent.find(frame => frame.kind === 'message.send')
    expect(send).toBeDefined()
    expect(send!.requestId.length).toBeGreaterThan(0)
    expect(send!.commitId.length).toBeGreaterThan(0)
    expect(controller.getSnapshot().group.composer).toBe('')
  })

  it('reuses the same request and commit id when a retry follows an unknown outcome', async () => {
    let attempt = 0
    const { client, sent } = scriptedClient(frame => {
      if (frame.kind === 'group.list') return { kind: 'reply', reply: groupsReply }
      if (frame.kind === 'message.page') return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
      if (frame.kind === 'action.list') return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
      attempt += 1
      if (attempt === 1) return { kind: 'transport', message: 'no answer' }
      return { kind: 'reply', reply: { kind: 'message.sent', requestId: frame.requestId, messageId: 'm1', sequence: 1 } }
    })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    controller.setGroupComposer('hello group')
    expect(await controller.sendGroupMessage()).toBe(false)
    const first = controller.getSnapshot().group
    expect(first.outcome.kind).toBe('unknown')
    const firstSend = sent.find(frame => frame.kind === 'message.send')!
    expect(await controller.retryGroupMutation()).toBe(true)
    const sends = sent.filter(frame => frame.kind === 'message.send')
    expect(sends).toHaveLength(2)
    expect(sends[1]!.requestId).toBe(firstSend.requestId)
    expect(sends[1]!.commitId).toBe(firstSend.commitId)
  })

  it('renders not-configured and stops sending when the client has no group port', async () => {
    const base = {
      readProjection: async () => projection,
      command: async () => ({ ok: true as const, kind: 'connection.connect' as const }),
      sendSession: async () => ({ ok: true as const }),
    }
    const controller = new TeamsConsoleController(base, { initialPage: 'groups' })
    await controller.refresh()
    expect(await controller.loadGroups()).toBe(false)
    const state = controller.getSnapshot()
    expect(state.groupCapable).toBe(false)
    expect(state.group.access.kind).toBe('not-configured')
  })

  it('parks a critical action for confirmation before it leaves the UI', async () => {
    const issue = { sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1', initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1 }
    const { client, sent } = scriptedClient(frame => {
      if (frame.kind === 'group.list') return { kind: 'reply', reply: groupsReply }
      if (frame.kind === 'message.page') return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
      if (frame.kind === 'action.list') return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
      if (frame.kind === 'issue.query') return { kind: 'reply', reply: { kind: 'issue.session', requestId: frame.requestId, session: issue } }
      if (frame.kind === 'issue.create') return { kind: 'reply', reply: { kind: 'issue.session', requestId: frame.requestId, session: issue } }
      return { kind: 'refused', code: 'FORBIDDEN', message: 'not permitted' }
    })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    controller.setGroupActor('agent-a')
    await controller.createIssue('Close me', 'body', 'p1')
    await controller.closeIssue('done', 'closed')
    expect(controller.getSnapshot().group.confirm).not.toBeNull()
    expect(sent.some(frame => frame.kind === 'issue.close')).toBe(false)
    expect(await controller.confirmPendingGroupAction()).toBe(false)
    expect(controller.getSnapshot().group.outcome).toMatchObject({ kind: 'refused', code: 'FORBIDDEN' })
  })

  it('sends nothing until one of several actors is chosen, then loads the real group list', async () => {
    const twoActorProjection = {
      ...projection,
      agents: [
        projection.agents[0],
        projection.agents[1],
        { kind: 'runtime' as const, agentId: 'agent-b', label: 'Agent B', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const },
      ],
    }
    const sent: Array<{ agentId: string; kind: string }> = []
    const sender: GroupRequestSender = {
      requestGroup: async (agentId, frame) => {
        sent.push({ agentId, kind: frame.kind })
        return frame.kind === 'group.list'
          ? { kind: 'reply', reply: groupsReply }
          : { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
      },
    }
    const base = {
      readProjection: async () => twoActorProjection,
      command: async () => ({ ok: true as const, kind: 'connection.connect' as const }),
      sendSession: async () => ({ ok: true as const }),
    }
    const controller = new TeamsConsoleController(withGroupRequests(base, sender) as never, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    const pending = controller.getSnapshot().group
    // Two candidates and no choice: nothing may be sent and no agent may be guessed.
    expect(pending.actors).toEqual(['agent-a', 'agent-b'])
    expect(pending.actorId).toBeUndefined()
    expect(sent).toHaveLength(0)
    expect(pending.access.kind).toBe('ready')
    controller.setGroupActor('agent-b')
    await controller.loadGroups()
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every(entry => entry.agentId === 'agent-b')).toBe(true)
    expect(sent[0]!.kind).toBe('group.list')
    expect(controller.getSnapshot().group.listStatus).toBe('ready')
  })

  it('keeps the shipped envelope client injectable for a live host', () => {
    const sender = createGroupRequestClient({ fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch })
    expect(typeof sender.requestGroup).toBe('function')
  })
})
