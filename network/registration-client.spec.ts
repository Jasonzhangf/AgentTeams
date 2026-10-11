import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { AgentDeclaration } from '../control-protocol/agent-services.ts'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { declarationWithPublishedSurfaces } from '../runtime/registry-registration.ts'
import { createRelayClient, type RelayClient } from './relay-client.ts'
import {
  createRegistrationClient,
  type RegistrationClient,
  type RegistrationClientOptions,
} from './registration-client.ts'

let directory: string
let cert: Buffer
let key: Buffer
let relay: RelayServer | undefined
const clients: RegistrationClient[] = []
const observers: RelayClient[] = []

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-registration-client-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' })
  cert = readFileSync(join(directory, 'cert'))
  key = readFileSync(join(directory, 'key'))
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.stop()))
  await Promise.all(observers.splice(0).map(client => client.close()))
  await relay?.close()
  relay = undefined
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function startRelay(options: { readonly port?: number; readonly peerTtlMs?: number; readonly authenticate?: (credential: string | undefined) => { accountId: string; scopeId: string; agentId: string } | null } = {}) {
  relay = await createRelayServer({
    host: '127.0.0.1',
    port: options.port ?? 0,
    key,
    cert,
    maxPayload: 65_536,
    maxConnections: 16,
    maxGrants: 8,
    maxBufferedAmount: 65_536,
    maxPendingMessages: 16,
    maxPendingBytes: 131_072,
    grantTtlMs: 10_000,
    ...(options.peerTtlMs === undefined ? {} : { peerTtlMs: options.peerTtlMs }),
    authenticate: options.authenticate ?? (credential => credential?.startsWith('Bearer ')
      ? { accountId: 'account', scopeId: credential.slice(7).startsWith('b-') ? 'scope-b' : 'scope', agentId: credential.slice(7) }
      : null),
  })
  return relay
}

function declaration(agentId: string, scopeId = 'scope'): AgentDeclaration {
  return {
    identity: { hostId: agentId, machineId: agentId, agentId, accountId: 'account', agentKind: 'custom', label: agentId },
    scopeId,
    revision: 1,
    capabilities: [],
    routes: [],
  }
}

function clientOptions(overrides: Partial<RegistrationClientOptions> = {}): RegistrationClientOptions {
  const agentId = overrides.declaration?.identity.agentId ?? 'daemon'
  return {
    declaration: declaration(agentId),
    endpoint: relay?.url ?? 'wss://127.0.0.1:1',
    credential: `Bearer ${agentId}`,
    ca: cert,
    heartbeatIntervalMs: 100,
    admissionTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    maxPendingRequests: 8,
    maxDataConnections: 4,
    connectTimeoutMs: 1_000,
    maxMessageBytes: 65_536,
    maxBufferedBytes: 65_536,
    maxPendingFrames: 16,
    reconnect: { initialDelayMs: 25, maxDelayMs: 100, maxAttempts: 3 },
    ...overrides,
  }
}

function observerOptions(agentId: string) {
  return {
    transport: { endpoint: relay!.url, credential: `Bearer ${agentId}`, ca: cert, connectTimeoutMs: 1_000,
      maxMessageBytes: 65_536, maxBufferedBytes: 65_536, maxPendingFrames: 16 },
    admissionTimeoutMs: 1_000, requestTimeoutMs: 1_000, maxPendingRequests: 8, maxDataConnections: 4,
    declaration: declaration(agentId),
  }
}

async function observer(agentId: string): Promise<RelayClient> {
  const client = await createRelayClient(observerOptions(agentId))
  observers.push(client)
  return client
}

async function registration(overrides: Partial<RegistrationClientOptions> = {}): Promise<RegistrationClient> {
  const client = createRegistrationClient(clientOptions(overrides))
  clients.push(client)
  return client
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForState(client: RegistrationClient, state: string, timeoutMs = 4_000): Promise<void> {
  await waitForStatus(client, status => status.state === state, timeoutMs)
}

async function waitForStatus(client: RegistrationClient, predicate: (status: ReturnType<RegistrationClient['status']>) => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(client.status())) return
    await delay(10)
  }
  throw new Error(`registration client did not reach the expected status: ${JSON.stringify(client.status())}`)
}

it('registers automatically, heartbeats its lease, and reports typed online health', async () => {
  await startRelay({ peerTtlMs: 400 })
  const client = await registration({ heartbeatIntervalMs: 100 })
  const first = await client.start()
  expect(first).toMatchObject({ state: 'online', endpoint: relay!.url, generation: 1, attempts: 0, reconnects: 0 })
  expect(first.lastError).toBeUndefined()
  expect(typeof first.lastSeenAt).toBe('string')

  const watcher = await observer('watcher')
  expect((await watcher.directory(false)).find(peer => peer.declaration.identity.agentId === 'daemon'))
    .toMatchObject({ presence: 'online' })

  // Two lease windows pass with only heartbeats keeping the peer online.
  await delay(900)
  expect(client.status()).toMatchObject({ state: 'online', generation: 1 })
  expect((await watcher.directory(false)).find(peer => peer.declaration.identity.agentId === 'daemon'))
    .toMatchObject({ presence: 'online' })

  await client.stop()
  expect(client.status()).toMatchObject({ state: 'stopped' })
  expect(await client.closed).toMatchObject({ state: 'stopped' })
})

it('keeps the original unreachable-endpoint error and never switches servers', async () => {
  const unreachable = `wss://127.0.0.1:${await freePort()}`
  const client = createRegistrationClient(clientOptions({ endpoint: unreachable, connectTimeoutMs: 500,
    reconnect: { initialDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 2 } }))
  clients.push(client)
  const status = await client.start()
  expect(status.state).toBe('reconnecting')
  expect(status.endpoint).toBe(unreachable)
  expect(status.lastError?.code).toBe('UNAVAILABLE')
  expect(status.lastError?.message).toMatch(/WSS connection failed|connection failed/)
  expect(status.attempts).toBe(1)
  expect(typeof status.nextAttemptAt).toBe('string')

  await expect(client.directory(false)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  // R4: publication uses the same online guard and never opens a second endpoint.
  await expect(client.publish(declarationWithPublishedSurfaces(declaration('daemon'), { capabilities: [], routes: [] })))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  expect(client.status().endpoint).toBe(unreachable)
  await client.stop()
})

it('publishes the daemon listener route and ACP capability over the same registration path', async () => {
  await startRelay()
  const client = await registration({ heartbeatIntervalMs: 1_000 })
  expect(await client.start()).toMatchObject({ state: 'online' })
  const watcher = await observer('watcher')

  const routes = [{
    candidateId: 'daemon-lan-8443',
    kind: 'lan' as const,
    endpoint: 'wss://127.0.0.1:8443',
    port: 8443,
    authRequired: true,
    lastSeenAt: '2026-10-11T00:00:00.000Z',
  }]
  const capabilities = [{
    capabilityId: 'acp',
    version: '1',
    operations: [{ operation: 'session/prompt', inputSchema: {}, outputSchema: {}, cancellation: 'cooperative' as const }],
    resources: [],
  }]
  const published = declarationWithPublishedSurfaces(declaration('daemon'), { capabilities, routes })
  expect(published.revision).toBe(2)
  await client.publish(published)

  const peer = (await watcher.directory(false)).find(candidate => candidate.declaration.identity.agentId === 'daemon')
  expect(peer?.declaration).toMatchObject({
    revision: 2,
    capabilities: [{ capabilityId: 'acp', version: '1', operations: [{ operation: 'session/prompt', cancellation: 'cooperative' }] }],
    routes: [{ candidateId: 'daemon-lan-8443', kind: 'lan', port: 8443, authRequired: true }],
  })
  // The same relay boundary refuses a revision that does not advance.
  await expect(client.publish(published)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await client.stop()
})

it('reconnects explicitly after a same-identity replacement and reports the new generation', async () => {
  await startRelay()
  const client = await registration({ heartbeatIntervalMs: 50 })
  expect(await client.start()).toMatchObject({ state: 'online', generation: 1 })

  // A second control connection with the same identity replaces the lease and
  // closes the first socket; the registration client must reconnect, not die.
  const replacement = await observer('daemon')
  expect(replacement.generation).toBe(2)
  await waitForStatus(client, status => status.generation === 3)
  const reconnected = client.status()
  expect(reconnected).toMatchObject({ state: 'online', generation: 3, reconnects: 1, attempts: 0 })
  expect(reconnected.lastError?.code).toBe('UNAVAILABLE')
})

it('reconnects to the same configured server after a registry restart', async () => {
  const port = await freePort()
  await startRelay({ port })
  const client = await registration({ heartbeatIntervalMs: 50, reconnect: { initialDelayMs: 400, maxDelayMs: 400, maxAttempts: 10 } })
  expect(await client.start()).toMatchObject({ state: 'online', generation: 1 })

  await relay!.close()
  await waitForState(client, 'reconnecting')
  expect(client.status().lastError?.code).toBe('UNAVAILABLE')

  await startRelay({ port })
  await waitForStatus(client, status => status.state === 'online')
  expect(client.status()).toMatchObject({ state: 'online', endpoint: `wss://127.0.0.1:${port}`, generation: 1 })
  expect(client.status().reconnects).toBe(1)
})

it('isolates a registry outage from the engine loop and rejects an unauthorized credential', async () => {
  await startRelay({ authenticate: () => null })
  const client = await registration({ reconnect: { initialDelayMs: 25, maxDelayMs: 50, maxAttempts: 2 } })
  let engineTicks = 0
  const engine = setInterval(() => { engineTicks += 1 }, 20)
  const first = await client.start()
  expect(first.lastError?.code).toBe('UNAUTHENTICATED')
  await expect(client.closed).resolves.toMatchObject({ state: 'failed', lastError: { code: 'UNAUTHENTICATED' } })
  expect(client.status().attempts).toBe(2)
  const ticks = engineTicks
  await delay(80)
  expect(engineTicks).toBeGreaterThan(ticks)
  clearInterval(engine)
  await client.stop()
  // A terminal failure is not rewritten as a local stop.
  expect(client.status()).toMatchObject({ state: 'failed' })
})

it('never returns an out-of-scope peer to a scoped client', async () => {
  await startRelay()
  const scoped = await registration({ declaration: declaration('b-observer', 'scope-b'), credential: 'Bearer b-observer', heartbeatIntervalMs: 100 })
  await scoped.start()
  const other = await registration({ declaration: declaration('a-observer', 'scope'), credential: 'Bearer a-observer', heartbeatIntervalMs: 100 })
  await other.start()
  const peers = await scoped.directory(false)
  expect(peers.map(peer => peer.declaration.identity.agentId)).toEqual(['b-observer'])
  expect(peers.every(peer => peer.declaration.scopeId === 'scope-b')).toBe(true)
})

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('no port')); return }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}
