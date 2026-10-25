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
      if (frame.kind === 'issue.list') return { kind: 'reply', reply: { kind: 'issue.list', requestId: frame.requestId, sessions: [] } }
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

  it('grants a command edge as the owner and refuses to do it as anyone else', async () => {
    const group = {
      groupId: 'g1', name: 'Alpha', ownerAgentId: 'agent-a', createdAt: '2026-10-20T00:00:00.000Z',
      members: [
        { agentId: 'agent-a', role: 'master' as const, mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] },
        { agentId: 'agent-b', role: 'peer' as const, mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] },
      ],
    }
    const twoActors = {
      ...projection,
      agents: [
        ...projection.agents,
        { kind: 'runtime' as const, agentId: 'agent-b', label: 'Agent B', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const },
      ],
    }
    const sent: GroupWireRequest[] = []
    const sender: GroupRequestSender = {
      requestGroup: async (_agentId, frame) => {
        sent.push(frame)
        if (frame.kind === 'group.list') return { kind: 'reply', reply: { kind: 'group.list', requestId: frame.requestId, groups: [group] } }
        if (frame.kind === 'group.grant') {
          return { kind: 'reply', reply: { kind: 'group.member', requestId: frame.requestId, group: { ...group, members: group.members.map(member => member.agentId === frame.agentId ? { ...member, mastersOf: [...(frame.mastersOf ?? [])] } : member) } } }
        }
        if (frame.kind === 'message.page') return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
        return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
      },
    }
    const client = withGroupRequests({
      readProjection: async () => twoActors,
      command: async () => ({ ok: true as const, kind: 'connection.connect' as const }),
      sendSession: async () => ({ ok: true as const }),
    }, sender) as never

    const owner = new TeamsConsoleController(client, { initialPage: 'groups' })
    await owner.refresh()
    owner.setGroupActor('agent-a')
    await owner.loadGroups()
    expect(await owner.grantCommand('agent-b')).toBe(true)
    const grant = sent.filter(frame => frame.kind === 'group.grant').pop()
    expect(grant).toEqual({ kind: 'group.grant', requestId: grant?.requestId, groupId: 'g1', agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'] })
    expect(owner.getSnapshot().group.groups[0]?.members.find(member => member.agentId === 'agent-a')?.mastersOf).toEqual(['agent-b'])

    const peer = new TeamsConsoleController(client, { initialPage: 'groups' })
    await peer.refresh()
    peer.setGroupActor('agent-b')
    await peer.loadGroups()
    const before = sent.length
    expect(await peer.grantCommand('agent-a')).toBe(false)
    expect(sent.length).toBe(before)
    expect(peer.getSnapshot().group.error?.code).toBe('FORBIDDEN')
  })
})

describe('group request context isolation', () => {
  const twoGroups = {
    kind: 'group.list' as const,
    requestId: 'ignored',
    groups: [
      { groupId: 'g1', name: 'Alpha', ownerAgentId: 'agent-a', createdAt: '2026-10-19T00:00:00.000Z', members: [{ agentId: 'agent-a', role: 'master' as const, mastersOf: [], intervals: [{ joinedAt: '2026-10-19T00:00:00.000Z' }] }] },
      { groupId: 'g2', name: 'Beta', ownerAgentId: 'agent-a', createdAt: '2026-10-20T00:00:00.000Z', members: [{ agentId: 'agent-a', role: 'master' as const, mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] }] },
    ],
  }

  /** A transport whose answers the test releases by hand, so a reply can be made late. */
  function deferredClient(actors: typeof projection.agents = projection.agents) {
    const pending: Array<() => void> = []
    const sent: GroupWireRequest[] = []
    const agents: string[] = []
    const scripts = new Map<string, (frame: GroupWireRequest) => GroupRequestOutcome>()
    /** Frame kinds the test holds back, so their answers can be made late. */
    const defer = new Set<string>()
    const sender: GroupRequestSender = {
      requestGroup: async (agentId, frame) => {
        agents.push(agentId)
        sent.push(frame)
        const script = scripts.get(frame.kind)
        const outcome: GroupRequestOutcome = script === undefined
          ? { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
          : script(frame)
        // Only the kinds the test marks as slow wait for a hand release.
        if (!defer.has(frame.kind)) return outcome
        return await new Promise<GroupRequestOutcome>(resolve => { pending.push(() => resolve(outcome)) })
      },
    }
    const base = {
      readProjection: async () => ({ ...projection, agents: actors }),
      command: async () => ({ ok: true as const, kind: 'connection.connect' as const }),
      sendSession: async () => ({ ok: true as const }),
    }
    const release = async (): Promise<void> => {
      while (pending.length > 0) pending.shift()!()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    return { client: withGroupRequests(base, sender) as never, sent, agents, scripts, defer, release, pending }
  }

  it('drops a late group.list answer that arrives after the identity switched', async () => {
    const agentB = { kind: 'runtime' as const, agentId: 'agent-b', label: 'Agent B', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const, currentSessionId: 's2' }
    const harness = deferredClient([...projection.agents, agentB])
    harness.scripts.set('group.list', frame => ({ kind: 'reply', reply: { ...twoGroups, requestId: frame.requestId } }))
    harness.defer.add('group.list')
    const controller = new TeamsConsoleController(harness.client, { initialPage: 'groups' })
    await controller.refresh()
    controller.setGroupActor('agent-a')
    // Start the read but do not release it: the user switches identity while it is open.
    const slow = controller.loadGroups()
    await Promise.resolve()
    controller.setGroupActor('agent-b')
    await harness.release()
    await slow
    const state = controller.getSnapshot().group
    // The answer asked as agent-a must not populate the agent-b context.
    expect(state.actorId).toBe('agent-b')
    expect(harness.agents.filter(agentId => agentId === 'agent-a').length).toBeGreaterThan(0)
    expect(state.groups.some(group => group.groupId === 'g1')).toBe(false)
  })

  it('never replays an unknown write under a different identity or group', async () => {
    const agentB = { kind: 'runtime' as const, agentId: 'agent-b', label: 'Agent B', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const, currentSessionId: 's2' }
    const harness = deferredClient([...projection.agents, agentB])
    harness.scripts.set('group.list', frame => ({ kind: 'reply', reply: { ...twoGroups, requestId: frame.requestId } }))
    harness.scripts.set('message.send', () => ({ kind: 'transport', message: 'no answer' }))
    const controller = new TeamsConsoleController(harness.client, { initialPage: 'groups' })
    await controller.refresh()
    controller.setGroupActor('agent-a')
    await controller.loadGroups()
    controller.setGroupComposer('hello group')
    expect(await controller.sendGroupMessage()).toBe(false)
    expect(controller.getSnapshot().group.outcome.kind).toBe('unknown')
    const writesBefore = harness.sent.filter(frame => frame.kind === 'message.send').length
    controller.setGroupActor('agent-b')
    // A different identity may not replay the stored write, not even with its own commit.
    expect(await controller.retryGroupMutation()).toBe(false)
    expect(harness.sent.filter(frame => frame.kind === 'message.send')).toHaveLength(writesBefore)
  })

  it('lands a new group on an operable empty state instead of a loading screen', async () => {
    const created = { groupId: 'g9', name: 'Fresh', ownerAgentId: 'agent-a', createdAt: '2026-10-24T00:00:00.000Z', members: [{ agentId: 'agent-a', role: 'master' as const, mastersOf: [], intervals: [{ joinedAt: '2026-10-24T00:00:00.000Z' }] }] }
    const { client } = scriptedClient(frame => {
      if (frame.kind === 'group.list') return { kind: 'reply', reply: groupsReply }
      if (frame.kind === 'group.create') return { kind: 'reply', reply: { kind: 'group.created', requestId: frame.requestId, group: created } }
      if (frame.kind === 'message.page') return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
      return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
    })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    controller.setGroupActor('agent-a')
    expect(await controller.createGroup('Fresh')).toBe(true)
    const state = controller.getSnapshot().group
    expect(state.selectedGroupId).toBe('g9')
    expect(state.messageStatus).toBe('empty')
    // The empty group is a readable, operable workspace, never a spinner that cannot finish.
    expect(state.mutation).toBeNull()
    expect(state.outcome).toMatchObject({ kind: 'succeeded', frame: 'group.create' })
  })

  it('asks for actions of the loaded issue session only, never an actor-wide list', async () => {
    const issue = { sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1', initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1 }
    const { client, sent } = scriptedClient(frame => {
      if (frame.kind === 'group.list') return { kind: 'reply', reply: groupsReply }
      if (frame.kind === 'issue.create') return { kind: 'reply', reply: { kind: 'issue.session', requestId: frame.requestId, session: issue } }
      if (frame.kind === 'action.list') return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
      return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
    })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    controller.setGroupActor('agent-a')
    // No issue loaded yet: no action list is requested at all.
    expect(sent.filter(frame => frame.kind === 'action.list')).toHaveLength(0)
    await controller.createIssue('First', 'body', 'p1')
    await controller.loadGroups()
    const lists = sent.filter(frame => frame.kind === 'action.list')
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.every(frame => frame.kind === 'action.list' && frame.sessionId === 's1')).toBe(true)
  })

  it('reads the selected group issue list when a group is loaded', async () => {
    const { client, sent } = scriptedClient(frame => {
      if (frame.kind === 'group.list') return { kind: 'reply', reply: groupsReply }
      if (frame.kind === 'issue.list') return { kind: 'reply', reply: { kind: 'issue.list', requestId: frame.requestId, sessions: [] } }
      return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
    })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    const lists = sent.filter(frame => frame.kind === 'issue.list')
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({ groupId: 'g1' })
    expect(controller.getSnapshot().group.issueListStatus).toBe('empty')
  })

  it('opens one known issue and loads actions for that session only', async () => {
    const issue = { sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1', initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1 }
    const { client, sent } = scriptedClient(frame => {
      if (frame.kind === 'group.list') return { kind: 'reply', reply: groupsReply }
      if (frame.kind === 'issue.list') return { kind: 'reply', reply: { kind: 'issue.list', requestId: frame.requestId, sessions: [issue] } }
      if (frame.kind === 'issue.query') return { kind: 'reply', reply: { kind: 'issue.session', requestId: frame.requestId, session: issue } }
      if (frame.kind === 'action.list') return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
      return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
    })
    const controller = new TeamsConsoleController(client, { initialPage: 'groups' })
    await controller.refresh()
    await controller.loadGroups()
    // An id the group does not own is never sent.
    expect(await controller.openIssue('unknown-session')).toBe(false)
    expect(sent.some(frame => frame.kind === 'issue.query')).toBe(false)
    expect(await controller.openIssue('s1')).toBe(true)
    const queries = sent.filter(frame => frame.kind === 'issue.query')
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatchObject({ sessionId: 's1' })
    const lists = sent.filter(frame => frame.kind === 'action.list')
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({ sessionId: 's1' })
    expect(controller.getSnapshot().group.issue?.sessionId).toBe('s1')
  })
})
