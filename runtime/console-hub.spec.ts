import { expect, it, vi } from 'vitest'
import { createConsoleHub } from './console-hub.ts'
import type { RelayPeer } from '../control-protocol/agent-services.ts'

function directoryPeer(agentId: string, presence: RelayPeer['presence'], generation: number, capabilities: readonly string[]): RelayPeer {
  return {
    declaration: { identity: { hostId: `${agentId}-host`, machineId: `${agentId}-machine`, agentId, accountId: 'account', agentKind: 'custom', label: agentId },
      scopeId: 'scope', revision: 1, capabilities: capabilities.map(capabilityId => ({ capabilityId, version: '1', operations: [], resources: [] })), routes: [] },
    connectionId: `${agentId}-connection`, generation, lastSeenAt: new Date(0).toISOString(), presence,
  }
}

it('merges only owner projections and routes actions to exactly one Agent', async () => {
  const binding = (agentId: string) => ({
    readProjection: async () => ({ version: 1 as const, agents: [{ kind: 'runtime' as const, agentId, machineId: agentId, label: agentId, presence: 'online' as const, capabilities: [] }], sessions: [], configs: [], notifications: [], works: [], relations: [] }),
    command: vi.fn(async () => ({ ok: true as const })), sendSession: vi.fn(async () => ({ ok: true as const })),
  })
  const a = binding('a'); const b = binding('b')
  const client = createConsoleHub([{ agentId: 'a', client: a }, { agentId: 'b', client: b }])
  expect((await client.readProjection()).agents.map(agent => agent.agentId)).toEqual(['a', 'b'])
  await client.command({ kind: 'config.apply', agentId: 'b' })
  await client.sendSession({ agentId: 'a', sessionId: 's' }, [{ command: 'business' }])
  expect(a.command).not.toHaveBeenCalled()
  expect(b.command).toHaveBeenCalledTimes(1)
  expect(a.sendSession).toHaveBeenCalledWith({ agentId: 'a', sessionId: 's' }, [{ command: 'business' }])
  expect(b.sendSession).not.toHaveBeenCalled()
  await expect(client.command({ kind: 'config.apply', agentId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(() => createConsoleHub([{ agentId: 'a', client: a }, { agentId: 'a', client: b }])).toThrow()
})

it('rejects a cross-Agent projection instead of merging it into another owner', async () => {
  const client = createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1, agents: [], sessions: [{ agentId: 'other', sessionId: 's' }], configs: [], notifications: [], works: [], relations: [] }),
    command: async () => ({ ok: true }), sendSession: async () => ({ ok: true }),
  } }])
  await expect(client.readProjection()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

it('carries the accepted binding through owner aggregation and rejects a crossed config row', async () => {
  const configRow = (agentId: string) => ({
    agentId, acceptedRevision: 2, effectiveRevision: 2, applyState: 'clean' as const,
    acceptedBinding: { primary: { providerInstanceId: 'provider-a', modelId: 'model-a' } },
    providers: [],
  })
  const owned = createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1 as const, agents: [], sessions: [], configs: [configRow('a')],
      notifications: [], works: [], relations: [] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  } }])
  expect((await owned.readProjection()).configs).toEqual([configRow('a')])

  const crossed = createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1 as const, agents: [], sessions: [], configs: [configRow('b')],
      notifications: [], works: [], relations: [] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  } }])
  await expect(crossed.readProjection()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

it('rejects a cross-Agent Session event and accepts the owned event', async () => {
  const event = (agentId: string) => ({ eventId: 'e', agentId, sessionId: 's', kind: 'message' as const, state: 'completed' as const,
    messageId: 'm', role: 'assistant' as const })
  const projection = (agentId: string) => ({ version: 1 as const, agents: [], sessions: [], configs: [], notifications: [],
    works: [], relations: [], sessionEvents: [event(agentId)] })
  const binding = (agentId: string) => ({
    readProjection: async () => projection(agentId),
    command: async () => ({ ok: true as const }),
    sendSession: async () => ({ ok: true as const }),
  })

  await expect(createConsoleHub([{ agentId: 'a', client: binding('other') }]).readProjection())
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(createConsoleHub([{ agentId: 'a', client: binding('a') }]).readProjection())
    .resolves.toMatchObject({ sessionEvents: [event('a')] })
})

it('merges owner Work and relation observations and rejects a missing observation', async () => {
  const work = {
    agentId: 'a', workId: 'w', consumerAgentId: 'c', providerAgentId: 'a',
    capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'closed' as const,
  }
  const client = createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1 as const, agents: [{ kind: 'runtime' as const, agentId: 'a', machineId: 'a', label: 'a', presence: 'online' as const, capabilities: [] }],
      sessions: [], configs: [], notifications: [], works: [work],
      relations: [{ agentId: 'a', consumerAgentId: 'c', providerAgentId: 'a', capabilityId: 'file-search', capabilityVersion: '1', relationPermission: 'granted' as const, workId: 'w' }] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  } }])
  expect(await client.readProjection()).toMatchObject({ works: [work], relations: [{ workId: 'w', relationPermission: 'granted' }] })
  const incomplete = createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1 as const, agents: [{ kind: 'runtime' as const, agentId: 'a', machineId: 'a', label: 'a', presence: 'online' as const, capabilities: [] }],
      sessions: [], configs: [], notifications: [] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  } }])
  await expect(incomplete.readProjection()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

it('discovers admitted directory peers on every read and keeps offline rows observation-only', async () => {
  const online = directoryPeer('browser', 'online', 3, ['browser'])
  const offline = directoryPeer('worker', 'offline', 8, ['file-search'])
  const command = vi.fn(async () => ({ ok: true as const }))
  const browser = {
    readProjection: async () => ({ version: 1 as const, agents: [{ kind: 'runtime' as const, agentId: 'browser', machineId: 'stale', label: 'stale', presence: 'unknown' as const, capabilities: [] }], sessions: [], configs: [], notifications: [], works: [], relations: [] }),
    command, sendSession: async () => ({ ok: true as const }),
  }
  let peers: readonly RelayPeer[] = [online, offline]
  const client = createConsoleHub([], async () => ({ peers, client: peer => {
    if (peer.declaration.identity.agentId !== 'browser') throw new Error('unexpected offline client')
    return browser
  } }))
  expect(await client.readProjection()).toMatchObject({ agents: [
    { agentId: 'browser', presence: 'online', generation: 3, capabilities: ['browser'] },
    { agentId: 'worker', presence: 'offline', generation: 8, capabilities: ['file-search'] },
  ] })
  await expect(client.command({ kind: 'config.apply', agentId: 'worker' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  peers = [{ ...online, generation: 4 }]
  expect((await client.readProjection()).agents[0]).toMatchObject({ agentId: 'browser', generation: 4, presence: 'online' })
  expect(command).not.toHaveBeenCalled()
})

it('rejects mixed static and discovery bindings', () => {
  expect(() => createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1, agents: [], sessions: [], configs: [], notifications: [], works: [], relations: [] }),
    command: async () => ({ ok: true }), sendSession: async () => ({ ok: true }),
  } }], async () => ({ peers: [], client: () => { throw new Error('unused') } }))).toThrow(/combine static bindings/)
})

it('routes discovery commands and Session ingress only through online peers', async () => {
  const online = directoryPeer('browser', 'online', 9, ['browser'])
  const command = vi.fn(async () => ({ ok: true as const }))
  const sendSession = vi.fn(async () => ({ ok: true as const }))
  const client = createConsoleHub([], async () => ({ peers: [online, directoryPeer('worker', 'offline', 2, ['file-search'])],
    client: peer => {
      if (peer.declaration.identity.agentId !== 'browser') throw new Error('unexpected offline client')
      return { readProjection: async () => ({ version: 1 as const, agents: [], sessions: [], configs: [], notifications: [], works: [], relations: [] }),
        command, sendSession }
    } }))
  await expect(client.command({ kind: 'config.apply', agentId: 'browser' })).resolves.toEqual({ ok: true })
  await expect(client.sendSession({ agentId: 'browser', sessionId: 's' }, [{ text: 'business' }])).resolves.toEqual({ ok: true })
  expect(command).toHaveBeenCalledTimes(1)
  expect(sendSession).toHaveBeenCalledWith({ agentId: 'browser', sessionId: 's' }, [{ text: 'business' }])
  await expect(client.command({ kind: 'config.apply', agentId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it('propagates stale generation failures from the relay binding', async () => {
  const online = directoryPeer('browser', 'online', 3, ['browser'])
  const client = createConsoleHub([], async () => ({ peers: [online],
    client: () => ({
      readProjection: async () => ({ version: 1 as const, agents: [], sessions: [], configs: [], notifications: [], works: [], relations: [] }),
      command: async () => { throw Object.assign(new Error('stale'), { code: 'STALE_GENERATION' }) },
      sendSession: async () => { throw Object.assign(new Error('stale'), { code: 'STALE_GENERATION' }) },
    }) }))
  await expect(client.command({ kind: 'config.apply', agentId: 'browser' })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
  await expect(client.sendSession({ agentId: 'browser', sessionId: 's' }, { text: 'x' })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
})

it('emits directory rows for offline peers and preserves owner runtime Session fields', async () => {
  const offline = directoryPeer('worker', 'offline', 8, ['file-search'])
  const online = directoryPeer('browser', 'online', 3, ['browser'])
  const runtimeRow = { kind: 'runtime' as const, agentId: 'browser', machineId: 'm', label: 'Browser', presence: 'online' as const, capabilities: ['browser'],
    sessionCapable: true as const, sessionAvailability: 'current' as const, sessionEffectiveRevision: 4, currentSessionId: 's1' }
  const client = createConsoleHub([], async () => ({ peers: [online, offline], client: () => ({
    readProjection: async () => ({ version: 1 as const, agents: [runtimeRow], sessions: [], configs: [], notifications: [], works: [], relations: [] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  }) }))
  const projection = await client.readProjection()
  expect(projection.agents.find(agent => agent.agentId === 'browser')).toMatchObject({ kind: 'runtime', sessionCapable: true, sessionAvailability: 'current', sessionEffectiveRevision: 4, currentSessionId: 's1' })
  const worker = projection.agents.find(agent => agent.agentId === 'worker')
  expect(worker).toMatchObject({ kind: 'directory', presence: 'offline' })
  expect(worker).not.toHaveProperty('sessionCapable')
})

it('projects directory declaration detail and takes the ID list and detail from the same source', async () => {
  const directoryCapability = { capabilityId: 'file-search', version: '2',
    operations: [{ operation: 'search', inputSchema: {}, outputSchema: {}, cancellation: 'unsupported' as const }],
    resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'slot' as const, sharing: 'exclusive' as const, allocationScope: 'request' as const }] }
  const online: RelayPeer = {
    declaration: { identity: { hostId: 'browser-host', machineId: 'browser-machine', agentId: 'browser', accountId: 'account', agentKind: 'custom', label: 'Browser' },
      scopeId: 'scope', revision: 1, capabilities: [directoryCapability], routes: [] },
    connectionId: 'browser-connection', generation: 3, lastSeenAt: new Date(0).toISOString(), presence: 'online',
  }
  const staleRuntimeDetail = [{ capabilityId: 'stale', version: '1', operations: [], resources: [] }]
  const client = createConsoleHub([], async () => ({ peers: [online], client: () => ({
    readProjection: async () => ({ version: 1 as const, agents: [{ kind: 'runtime' as const, agentId: 'browser', machineId: 'stale', label: 'stale',
      presence: 'unknown' as const, capabilities: ['stale'], capabilityDetails: staleRuntimeDetail, sessionCapable: false as const, sessionAvailability: 'not-applicable' as const }],
      sessions: [], configs: [], notifications: [], works: [], relations: [] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  }) }))
  const agent = (await client.readProjection()).agents[0]
  // The online directory row owns both the ID list and its detail; the stale runtime
  // fixture must not leave a detail that disagrees with the merged capability IDs.
  expect(agent.capabilities).toEqual(['file-search'])
  expect(agent.capabilityDetails).toEqual([{ capabilityId: 'file-search', version: '2', operations: ['search'],
    resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'slot' }] }])
})
