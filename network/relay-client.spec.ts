import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import type { RelayGrant } from '../control-protocol/agent-services.ts'
import { createRelayClient, type RelayClient, type RelayClientOptions } from './relay-client.ts'
import { startAgentDaemon } from '../runtime/agent-daemon.ts'
import { createWorkChannel } from './work-channel.ts'
import { createWorkIngress } from '../agent-host/work-ingress.ts'
import { createWorkHost } from '../agent-host/work-host.ts'
import { createCliWorkExecutor } from '../agent-host/cli-executor.ts'
import { createFileWorkStore, createWorkLedger } from '../agent/work-resource.ts'
import { requestConsole, serveConsole } from './console-channel.ts'
import { createRelayConsoleClient } from '../runtime/relay-console-client.ts'

let directory: string
let cert: Buffer
let key: Buffer
let relay: RelayServer
const clients: RelayClient[] = []
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-relay-client-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' })
  cert = readFileSync(join(directory, 'cert')); key = readFileSync(join(directory, 'key'))
})
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); await relay?.close() })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function start() {
  relay = await createRelayServer({ host: '127.0.0.1', port: 0, key, cert,
    maxPayload: 65536, maxConnections: 16, maxGrants: 8, maxBufferedAmount: 65536,
    maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 10000,
    authenticate: credential => credential?.startsWith('Bearer ')
      ? { agentId: credential.slice(7), accountId: 'account', scopeId: 'scope' } : null,
  })
}
function clientOptions(id: string, onEvent?: RelayClientOptions['onEvent']): RelayClientOptions {
  return { transport: { endpoint: relay.url, credential: `Bearer ${id}`, ca: cert,
    connectTimeoutMs: 1000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 },
    admissionTimeoutMs: 1000, requestTimeoutMs: 1000, maxPendingRequests: 8, maxDataConnections: 8, onEvent,
    declaration: { identity: { hostId: id, machineId: id, agentId: id, accountId: 'account', agentKind: 'custom', label: id },
      scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
  }
}
async function peer(id: string, onEvent?: RelayClientOptions['onEvent']) {
  const client = await createRelayClient(clientOptions(id, onEvent))
  clients.push(client)
  return client
}

it('exchanges a correlated Console command through actual TLS Relay and closes the one-request sockets', async () => {
  await start()
  let offer!: (grant: RelayGrant) => void
  const offered = new Promise<RelayGrant>(resolve => { offer = resolve })
  const a = await peer('console')
  const b = await peer('daemon', event => { if (event.kind === 'relay.offer') offer(event.grant) })
  const grant = await a.connect('daemon', b.generation)
  await offered
  const [left, right] = await Promise.all([a.openData(grant), b.openData(grant)])
  const serving = serveConsole(right, async request => ({ kind: 'console.result', correlationId: request.correlationId,
    result: { ok: false, error: { code: 'REVISION_CONFLICT', message: 'stale config' } } }), 1000)
  const response = await requestConsole(left, { kind: 'console.command', correlationId: 'r', targetGeneration: b.generation,
    command: { kind: 'config.apply', agentId: 'daemon' } }, 1000)
  expect(response).toMatchObject({ kind: 'console.result', result: { ok: false, error: { code: 'REVISION_CONFLICT' } } })
  await serving
  await Promise.all([left.closed, right.closed])
})

it('reports Console timeout without replaying or cancelling the owning operation', async () => {
  await start()
  let offer!: (grant: RelayGrant) => void
  const offered = new Promise<RelayGrant>(resolve => { offer = resolve })
  const a = await peer('console')
  const b = await peer('daemon', event => { if (event.kind === 'relay.offer') offer(event.grant) })
  const grant = await a.connect('daemon', b.generation)
  await offered
  const [left, right] = await Promise.all([a.openData(grant), b.openData(grant)])
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  let completed = false
  const serving = serveConsole(right, async request => {
    calls += 1
    await pending
    completed = true
    return { kind: 'console.result', correlationId: request.correlationId, result: { ok: true } }
  }, 1000).catch(error => error)
  try {
    await expect(requestConsole(left, { kind: 'console.command', correlationId: 'r', targetGeneration: b.generation,
      command: { kind: 'config.apply', agentId: 'daemon' } }, 50)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
    expect(calls).toBe(1)
    expect(completed).toBe(false)
    release()
    await pending
    await serving
    expect(completed).toBe(true)
  } finally { release() }
})

it('binds the Console client API to directory generation and real Relay connections', async () => {
  await start()
  const a = await peer('console')
  const received: unknown[] = []
  const jobs: Promise<void>[] = []
  const b = await peer('daemon', async event => {
    if (event.kind !== 'relay.offer') return
    const socket = await b.openData(event.grant)
    jobs.push(serveConsole(socket, async request => {
      received.push(request)
      if (request.kind === 'console.projection') return { kind: 'console.projection.result', correlationId: request.correlationId,
        projection: { version: 1, agents: [{ agentId: 'daemon', machineId: 'm', label: 'D', presence: 'online', capabilities: ['browser'] }], sessions: [], notifications: [], configs: [] } }
      return { kind: 'console.result', correlationId: request.correlationId, result: { ok: true } }
    }, 1000))
  })
  const client = createRelayConsoleClient(a, 'daemon', 1000)
  expect((await client.readProjection()).agents[0].agentId).toBe('daemon')
  expect(await client.command({ kind: 'config.apply', agentId: 'daemon' })).toEqual({ ok: true })
  expect(await client.sendSession({ agentId: 'daemon', sessionId: 's' }, ['business'])).toEqual({ ok: true })
  await expect(client.command({ kind: 'config.apply', agentId: 'other' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(received).toHaveLength(3)
  expect(received[2]).toMatchObject({ kind: 'console.session', targetGeneration: b.generation, payload: ['business'] })
  await Promise.all(jobs)
})

it('correlates concurrent directory requests and preserves scoped broadcasts', async () => {
  await start()
  const events: string[] = []
  const a = await peer('a', event => { if (event.kind === 'relay.changed') events.push(event.peer.declaration.identity.agentId) })
  expect((await a.directory(true)).map(peer => peer.declaration.identity.agentId)).toEqual(['a'])
  await peer('b')
  const results = await Promise.all([a.directory(true), a.directory(true)])
  expect(results.every(peers => peers.length === 2)).toBe(true)
  expect(events).toContain('b')
})

it('retains the relay directory revision in the typed snapshot API', async () => {
  await start()
  const a = await peer('a')
  const snapshot = await a.directorySnapshot(false)
  expect(snapshot.revision).toBe(1)
  expect(snapshot.peers.map(peer => peer.declaration.identity.agentId)).toEqual(['a'])
  expect((await a.directory(false)).map(peer => peer.declaration.identity.agentId)).toEqual(['a'])
})

it('publishes a snapshot with advancing revision and rejects identity changes and concurrent publication', async () => {
  await start()
  const a = await peer('a')
  const declaration = { ...clientOptions('a').declaration, revision: 2 }
  const publishing = a.publish(declaration)
  declaration.identity.label = 'mutated by caller'
  await expect(a.publish({ ...declaration, revision: 3 })).rejects.toMatchObject({ code: 'CONFLICT' })
  await publishing
  expect((await a.directory(false))[0].declaration).toMatchObject({ revision: 2, identity: { label: 'a' } })
  await expect(a.publish(declaration)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(a.publish({ ...declaration, revision: 3, identity: { ...declaration.identity, agentId: 'other' } }))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await a.publish({ ...declaration, revision: 3 })
  expect((await a.directory(false))[0].declaration).toMatchObject({ revision: 3, identity: { label: 'mutated by caller' } })
})

it('rejects publication before mutation when reply capacity is already full', async () => {
  await start()
  const a = await createRelayClient({ ...clientOptions('a'), maxPendingRequests: 1 })
  clients.push(a)
  const occupied = a.directory(false)
  await expect(a.publish({ ...clientOptions('a').declaration, revision: 2 })).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await occupied
  expect((await a.directory(false))[0].declaration.revision).toBe(1)
})

it('opens a granted channel and exchanges opaque bytes through the real relay', async () => {
  await start()
  let offer!: (grant: RelayGrant) => void
  const offered = new Promise<RelayGrant>(resolve => { offer = resolve })
  const a = await peer('a')
  const b = await peer('b', event => { if (event.kind === 'relay.offer') offer(event.grant) })
  const grant = await a.connect('b', b.generation)
  expect(await offered).toEqual(grant)
  const [left, right] = await Promise.all([a.openData(grant), b.openData(grant)])
  await left.send({ bytes: Buffer.from([0, 255, 3]), binary: true })
  expect(await right.read()).toEqual({ bytes: Buffer.from([0, 255, 3]), binary: true })
  await expect(a.openData(grant)).rejects.toMatchObject({ code: 'CONFLICT' })
  await a.close()
  await right.closed
})

it('keeps request rejection explicit and invalidates the client after server shutdown', async () => {
  await start()
  const a = await peer('a')
  await expect(a.connect('missing', 1)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect((await a.directory(false)).length).toBe(1)
  await relay.close()
  await a.closed
  await expect(a.directory(false)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
})

it('owns daemon stop and re-registration with a fresh server generation', async () => {
  await start()
  const abort = new AbortController()
  const first = await startAgentDaemon({ relay: clientOptions('daemon'), presenceIntervalMs: 25, signal: abort.signal })
  clients.push(first.network)
  expect(first.status()).toMatchObject({ state: 'online', agentId: 'daemon', generation: 1 })
  abort.abort()
  expect(await first.closed).toMatchObject({ state: 'stopped' })
  const second = await startAgentDaemon({ relay: clientOptions('daemon'), presenceIntervalMs: 25 })
  clients.push(second.network)
  expect(second.status().generation).toBe(2)
  await relay.close()
  expect(await second.closed).toMatchObject({ state: 'failed' })
})

it('does not publish a daemon when startup was cancelled', async () => {
  await start()
  const abort = new AbortController()
  abort.abort()
  await expect(startAgentDaemon({ relay: clientOptions('cancelled'), presenceIntervalMs: 25, signal: abort.signal }))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  const observer = await peer('observer')
  expect((await observer.directory(false)).map(peer => peer.declaration.identity.agentId)).toEqual(['observer'])
})

it('bounds concurrent requests without closing an otherwise usable client', async () => {
  await start()
  const a = await createRelayClient({ ...clientOptions('a'), maxPendingRequests: 1 })
  clients.push(a)
  const first = a.directory(false)
  await expect(a.directory(false)).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  expect(await first).toHaveLength(1)
  expect(await a.directory(false)).toHaveLength(1)
})

it('counts connecting data sockets against capacity and closes them during stop', async () => {
  await start()
  const a = await createRelayClient({ ...clientOptions('a'), maxDataConnections: 1 })
  clients.push(a)
  const b = await peer('b')
  const first = await a.connect('b', b.generation)
  const second = await a.connect('b', b.generation)
  const opening = a.openData(first)
  const rejected = expect(opening).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await expect(a.openData(second)).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await a.close()
  await rejected
  await expect(a.openData(second)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
})

it('observes async event failure while allowing handlers to request directory replies', async () => {
  await start()
  let handled!: () => void
  const delivered = new Promise<void>(resolve => { handled = resolve })
  let a!: RelayClient
  a = await peer('a', async event => {
    if (event.kind !== 'relay.changed') return
    await a.directory(false)
    handled()
    throw new Error('consumer event processing failed')
  })
  await a.directory(true)
  await peer('b')
  await delivered
  await expect(a.closed).resolves.toMatchObject({ message: 'consumer event processing failed' })
})

it('executes a real CLI Work between registered daemons over Relay without a Console', async () => {
  await start()
  const searchRoot = join(directory, 'work-input')
  mkdirSync(searchRoot)
  writeFileSync(join(searchRoot, 'sample.txt'), 'remote work needle\n')
  const executor = createCliWorkExecutor({ searchRoot, profilePrefix: 'teams-network-work-test',
    camoExecutable: '/opt/homebrew/bin/camo', searchExecutable: '/opt/homebrew/bin/rg' })
  const providerOptions = clientOptions('provider')
  let host!: ReturnType<typeof createWorkHost>
  const provider = await startAgentDaemon({ presenceIntervalMs: 1000, relay: {
    ...providerOptions, declaration: { ...providerOptions.declaration, capabilities: executor.capabilities },
    onEvent: async event => {
      if (event.kind !== 'relay.offer') return
      const socket = await provider.network.openData(event.grant)
      createWorkChannel(socket, { timeoutMs: 1000, maxPending: 4, maxIncoming: 4,
        onRequest: createWorkIngress(host, { accountId: event.grant.accountId, scopeId: event.grant.scopeId, agentId: event.grant.sourceAgentId }) })
    },
  } })
  clients.push(provider.network)
  const ledger = createWorkLedger({ provider: { accountId: 'account', scopeId: 'scope', agentId: 'provider' },
    generation: provider.network.generation, capabilities: executor.capabilities, store: createFileWorkStore(join(directory, 'network-work.json')) })
  host = createWorkHost({ ledger, executor, policy: () => ({ revision: 1, authorizeWork: consumer => consumer.agentId === 'consumer' }) })
  const consumer = await startAgentDaemon({ presenceIntervalMs: 1000, relay: clientOptions('consumer') })
  clients.push(consumer.network)
  const grant = await consumer.network.connect('provider', provider.network.generation)
  const channel = createWorkChannel(await consumer.network.openData(grant), { timeoutMs: 2000, maxPending: 4, maxIncoming: 4 })
  const proposal = { workId: 'remote-work', consumerAgentId: 'consumer', providerAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 }
  expect(await channel.request({ kind: 'work.propose', proposal })).toMatchObject({ kind: 'work.state', work: { state: 'accepted' } })
  const command = { kind: 'work.request' as const, control: { workId: proposal.workId, requestId: 'remote-request', operation: 'search',
    targetGeneration: provider.network.generation, demands: [{ resourceId: 'search-slot', amount: 1 }] }, payload: { query: 'remote work needle' } }
  expect(await channel.request(command)).toMatchObject({ kind: 'work.result', control: { state: 'succeeded' },
    payload: { matches: [expect.objectContaining({ path: './sample.txt', text: 'remote work needle\n' })] } })
  const revision = ledger.snapshot.revision
  expect(await channel.request(command)).toMatchObject({ kind: 'work.result', control: { state: 'succeeded' } })
  expect(ledger.snapshot.revision).toBe(revision)
  expect(await channel.request({ kind: 'work.close', workId: proposal.workId })).toMatchObject({ kind: 'work.state', work: { state: 'closed' } })
  expect(ledger.snapshot.allocations.every(item => item.state === 'released')).toBe(true)
  await channel.close()
  await consumer.stop()
  await provider.stop()
})

it('bounds Work requests and times out a silent peer without replay', async () => {
  await start()
  const a = await peer('a')
  const b = await peer('b')
  const grant = await a.connect('b', b.generation)
  const [left, right] = await Promise.all([a.openData(grant), b.openData(grant)])
  const channel = createWorkChannel(left, { timeoutMs: 40, maxPending: 1, maxIncoming: 1 })
  const response = expect(channel.request({ kind: 'work.close', workId: 'w' })).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
  await expect(channel.request({ kind: 'work.close', workId: 'other' })).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  expect(JSON.parse((await right.read()).bytes.toString())).toMatchObject({ kind: 'work.close', workId: 'w' })
  await response
  await channel.closed
  await right.closed
})

it('rejects invalid local Work input before allocating a deadline or closing the connection', async () => {
  await start()
  const a = await peer('a')
  const b = await peer('b')
  const grant = await a.connect('b', b.generation)
  const [left, right] = await Promise.all([a.openData(grant), b.openData(grant)])
  const channel = createWorkChannel(left, { timeoutMs: 40, maxPending: 1, maxIncoming: 1 })
  await expect(channel.request({ kind: 'work.close', workId: () => 'invalid' } as never)).rejects.toThrow()
  await new Promise(resolve => setTimeout(resolve, 80))
  const response = channel.request({ kind: 'work.get', workId: 'w', requestId: 'r' })
  const received = JSON.parse((await right.read()).bytes.toString())
  await right.send({ binary: false, bytes: Buffer.from(JSON.stringify({ kind: 'work.result', correlationId: received.correlationId,
    control: { workId: 'w', requestId: 'r', state: 'succeeded' }, payload: 'still usable' })) })
  expect(await response).toMatchObject({ payload: 'still usable' })
  await channel.close()
})

it('rejects a correlated Work reply that belongs to a different Work', async () => {
  await start()
  const a = await peer('a')
  const b = await peer('b')
  const grant = await a.connect('b', b.generation)
  const [left, right] = await Promise.all([a.openData(grant), b.openData(grant)])
  const channel = createWorkChannel(left, { timeoutMs: 1000, maxPending: 1, maxIncoming: 1 })
  const response = expect(channel.request({ kind: 'work.get', workId: 'w', requestId: 'r' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  const received = JSON.parse((await right.read()).bytes.toString())
  await right.send({ binary: false, bytes: Buffer.from(JSON.stringify({ kind: 'work.result', correlationId: received.correlationId,
    control: { workId: 'wrong-work', requestId: 'r', state: 'succeeded' }, payload: 'wrong result' })) })
  await response
  await channel.closed
})
