import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import type { RelayGrant } from '../control-protocol/agent-services.ts'
import { createRelayClient, type RelayClient, type RelayClientOptions } from './relay-client.ts'
import { startAgentDaemon } from '../runtime/agent-daemon.ts'

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
