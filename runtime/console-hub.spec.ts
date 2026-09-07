import { expect, it, vi } from 'vitest'
import { createConsoleHub } from './console-hub.ts'

it('merges only owner projections and routes actions to exactly one Agent', async () => {
  const binding = (agentId: string) => ({
    readProjection: async () => ({ version: 1 as const, agents: [{ agentId, machineId: agentId, label: agentId, presence: 'online' as const, capabilities: [] }], sessions: [], configs: [], notifications: [], works: [], relations: [] }),
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

it('merges owner Work and relation observations and rejects a missing observation', async () => {
  const work = {
    agentId: 'a', workId: 'w', consumerAgentId: 'c', providerAgentId: 'a',
    capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'closed' as const,
  }
  const client = createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1 as const, agents: [{ agentId: 'a', machineId: 'a', label: 'a', presence: 'online' as const, capabilities: [] }],
      sessions: [], configs: [], notifications: [], works: [work],
      relations: [{ agentId: 'a', consumerAgentId: 'c', providerAgentId: 'a', capabilityId: 'file-search', capabilityVersion: '1', relationPermission: 'granted' as const, workId: 'w' }] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  } }])
  expect(await client.readProjection()).toMatchObject({ works: [work], relations: [{ workId: 'w', relationPermission: 'granted' }] })
  const incomplete = createConsoleHub([{ agentId: 'a', client: {
    readProjection: async () => ({ version: 1 as const, agents: [{ agentId: 'a', machineId: 'a', label: 'a', presence: 'online' as const, capabilities: [] }],
      sessions: [], configs: [], notifications: [] }),
    command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }),
  } }])
  await expect(incomplete.readProjection()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
