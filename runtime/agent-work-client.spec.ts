import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentDeclaration, RelayPeer } from '../control-protocol/agent-services.ts'
import type { RelayClient } from '../network/relay-client.ts'
import { WssConnectionError, type WssConnection, type WssFrame } from '../network/wss-connection.ts'
import { createAgentWorkClient } from './agent-work-client.ts'

const identity = { accountId: 'account', scopeId: 'scope', agentId: 'consumer' }

function peer(agentId: string, presence: RelayPeer['presence'], version = '1', operations = ['search']): RelayPeer {
  const declaration: AgentDeclaration = {
    identity: { hostId: `${agentId}-host`, machineId: 'machine', agentId, accountId: 'account', agentKind: 'custom', label: agentId },
    scopeId: 'scope', revision: 1, routes: [], capabilities: [{ capabilityId: 'file-search', version,
      operations: operations.map(operation => ({ operation, inputSchema: {}, outputSchema: {}, cancellation: 'unsupported' as const })), resources: [] }],
  }
  return { declaration, connectionId: `${agentId}-connection`, generation: 3, lastSeenAt: new Date().toISOString(), presence }
}

let directory: RelayPeer[]
let client: ReturnType<typeof createAgentWorkClient>
beforeEach(() => {
  directory = []
  const relay = { directory: vi.fn(async () => directory) } as unknown as RelayClient
  client = createAgentWorkClient(relay, identity, { timeoutMs: 1000, maxPending: 2 })
})

it('matches an online provider by capability, version, and operation', async () => {
  directory.push(peer('offline', 'offline'), peer('provider', 'online'))
  await expect(client.findProvider({ capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' })).resolves.toMatchObject({
    providerAgentId: 'provider', generation: 3, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search',
  })
})

it('selects a visible Endpoint and carries its revision into the Work proposal', async () => {
  const endpointPeer = { ...peer('endpoint-provider', 'online'), endpoints: [{ endpointId: 'browser-endpoint', ownerAgentId: 'endpoint-provider', scopeId: 'scope', kind: 'browser' as const, revision: 4,
    lifecycle: 'active' as const, capabilities: [{ capabilityId: 'file-search', version: '1', operations: ['search'] }], resources: [] }] }
  directory.push(endpointPeer)
  const target = await client.findProvider({ capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' })
  expect(target.endpoint).toMatchObject({ providerAgentId: 'endpoint-provider', endpointId: 'browser-endpoint', revision: 4 })
})

it.each([
  ['missing capability', [], 'NOT_FOUND'],
  ['unsupported version', [peer('provider', 'online', '2')], 'UNSUPPORTED_VERSION'],
  ['unsupported operation', [peer('provider', 'online', '1', ['read'])], 'UNSUPPORTED_OPERATION'],
  ['offline provider', [peer('provider', 'offline')], 'UNAVAILABLE'],
] as const)('reports an explicit match failure for %s', async (_label, peers, code) => {
  directory.push(...peers)
  await expect(client.findProvider({ capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' })).rejects.toMatchObject({ code })
})

function fakeSocket(mode: 'normal' | 'error' | 'rejected' = 'normal'): { socket: WssConnection; sent: unknown[] } {
  const sent: unknown[] = []
  const queue: WssFrame[] = []
  const closedError = new WssConnectionError('UNAVAILABLE', 'fake socket closed')
  let reader: { resolve(frame: WssFrame): void; reject(error: Error): void } | undefined
  let resolveClosed!: (error: WssConnectionError) => void
  let stopped = false
  const closed = new Promise<WssConnectionError>(resolve => { resolveClosed = resolve })
  const push = (frame: WssFrame) => {
    if (reader) { const current = reader; reader = undefined; current.resolve(frame) }
    else queue.push(frame)
  }
  const socket: WssConnection = {
    closed,
    read: async () => {
      const frame = queue.shift()
      if (frame) return frame
      if (stopped) throw closedError
      return new Promise<WssFrame>((resolve, reject) => { reader = { resolve, reject } })
    },
    send: async frame => {
      const request = JSON.parse(frame.bytes.toString('utf8')) as { kind: string; correlationId: string; workId?: string; requestId?: string; control?: { workId: string; requestId: string } }
      sent.push(request)
      if (request.kind === 'work.propose') {
        push({ binary: false, bytes: Buffer.from(JSON.stringify(mode === 'rejected'
          ? { kind: 'work.state', correlationId: request.correlationId, work: { workId: 'work', consumerAgentId: 'consumer', providerAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'rejected' } }
          : { kind: 'work.state', correlationId: request.correlationId, work: { workId: 'work', consumerAgentId: 'consumer', providerAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'accepted' } })) })
      } else if (request.kind === 'work.request' && mode === 'error') {
        push({ binary: false, bytes: Buffer.from(JSON.stringify({ kind: 'work.error', correlationId: request.correlationId, error: { code: 'RESULT_UNKNOWN', message: 'unknown result' } })) })
      } else if (request.kind === 'work.request' || request.kind === 'work.get') {
        const control = request.control ?? { workId: request.workId!, requestId: request.requestId! }
        push({ binary: false, bytes: Buffer.from(JSON.stringify({ kind: 'work.result', correlationId: request.correlationId, control: { workId: control.workId, requestId: control.requestId, state: 'succeeded' }, payload: { ok: true } })) })
      } else if (request.kind === 'work.close') {
        push({ binary: false, bytes: Buffer.from(JSON.stringify({ kind: 'work.state', correlationId: request.correlationId, work: { workId: request.workId, consumerAgentId: 'consumer', providerAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'closed' } })) })
      }
    },
    close: async () => {
      if (stopped) return
      stopped = true
      reader?.reject(closedError)
      reader = undefined
      resolveClosed(closedError)
    },
  }
  return { socket, sent }
}

function relayForSocket(socket: WssConnection): RelayClient {
  const grant = { grantId: 'grant', accountId: 'account', scopeId: 'scope', sourceAgentId: 'consumer', targetAgentId: 'provider', sourceGeneration: 1, targetGeneration: 7, expiresAt: new Date(Date.now() + 10000).toISOString() }
  return { generation: 1, closed: Promise.resolve(new Error('closed')), directory: async () => [],
    connect: vi.fn(async (agentId, generation) => { expect(agentId).toBe('provider'); expect(generation).toBe(7); return grant }),
    openData: vi.fn(async () => socket), presence: async () => undefined, publish: async () => undefined, close: async () => undefined } as unknown as RelayClient
}

it('exposes the full consumer channel and carries target generation only in control', async () => {
  const { socket, sent } = fakeSocket()
  const channel = await createAgentWorkClient(relayForSocket(socket), identity, { timeoutMs: 1000, maxPending: 2 }).open({
    providerAgentId: 'provider', generation: 7, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search',
    endpoint: { providerAgentId: 'provider', endpointId: 'search-endpoint', revision: 2, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' },
  })
  await expect(channel.propose({ workId: 'work', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 })).resolves.toMatchObject({ state: 'accepted' })
  await expect(channel.request({ workId: 'work', requestId: 'request', operation: 'search', demands: [], payload: { query: 'x' } })).resolves.toMatchObject({ control: { state: 'succeeded' } })
  await expect(channel.get('work', 'request')).resolves.toMatchObject({ control: { state: 'succeeded' } })
  await expect(channel.close('work')).resolves.toMatchObject({ state: 'closed' })
  expect(sent.find(item => (item as { kind: string }).kind === 'work.request')).toMatchObject({ control: { targetGeneration: 7 } })
  expect(sent.find(item => (item as { kind: string }).kind === 'work.propose')).toMatchObject({ proposal: {
    endpoint: { workId: 'work', providerAgentId: 'provider', endpointId: 'search-endpoint', revision: 2, operation: 'search' },
  } })
  await channel.dispose()
  await expect(channel.closed).resolves.toBeInstanceOf(Error)
})

it('maps provider work errors and rejected proposals to explicit protocol errors', async () => {
  const rejected = await createAgentWorkClient(relayForSocket(fakeSocket('rejected').socket), identity, { timeoutMs: 1000, maxPending: 2 })
    .open({ providerAgentId: 'provider', generation: 7, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' })
  await expect(rejected.propose({ workId: 'work', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const failed = await createAgentWorkClient(relayForSocket(fakeSocket('error').socket), identity, { timeoutMs: 1000, maxPending: 2 })
    .open({ providerAgentId: 'provider', generation: 7, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' })
  await expect(failed.request({ workId: 'work', requestId: 'request', operation: 'search', demands: [], payload: null })).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
  await rejected.dispose()
  await failed.dispose()
})
