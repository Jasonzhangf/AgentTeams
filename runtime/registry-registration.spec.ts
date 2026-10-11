import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { parseDaemonConfigText, resolveDaemonIntent, type DaemonIntentV4 } from '../config/daemon-intent.ts'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createRelayClient, type RelayClient } from '../network/relay-client.ts'
import { processAlive } from './local-ownership.ts'
import {
  declarationForDaemon,
  declarationWithPublishedSurfaces,
  listenerRouteCandidates,
  loadRegistrationBootstrap,
  resolveRegistrationPlan,
  startDaemonRegistration,
  type AgentRegistration,
} from './registry-registration.ts'

const worktree = fileURLToPath(new URL('../', import.meta.url))
const entryPath = fileURLToPath(new URL('./registry-registration.ts', import.meta.url))
const transformFlags = entryPath.endsWith('.ts') ? ['--experimental-transform-types'] : []

let directory: string
let cert: string
let key: string
let relay: RelayServer | undefined
const registrations: AgentRegistration[] = []
const observers: RelayClient[] = []
const children: ChildProcess[] = []

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-registry-registration-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'ca.pem')], { stdio: 'ignore' })
  cert = readFileSync(join(directory, 'ca.pem'), 'utf8')
  key = readFileSync(join(directory, 'key.pem'), 'utf8')
  writeFileSync(join(directory, 'discovery.cred'), 'Bearer reasoner-a\n')
})
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && processAlive(child.pid)) {
      child.kill('SIGTERM')
      const deadline = Date.now() + 5_000
      while (processAlive(child.pid) && Date.now() < deadline) await delay(25)
      if (processAlive(child.pid)) child.kill('SIGKILL')
    }
  }
  for (const registration of registrations.splice(0)) {
    if (registration.state === 'enabled') await registration.client.stop()
  }
  await Promise.all(observers.splice(0).map(client => client.close()))
  await relay?.close()
  relay = undefined
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const delay = (ms: number): Promise<void> => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForStatus(statusFile: string, accept: (status: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    if (existsSync(statusFile)) {
      last = JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>
      if (accept(last)) return last
    }
    await delay(50)
  }
  throw new Error(`timed out waiting for registration status: last=${JSON.stringify(last)}`)
}

function relayServer(port: number): Promise<RelayServer> {
  return createRelayServer({
    host: '127.0.0.1', port, key, cert,
    maxPayload: 65_536, maxConnections: 8, maxGrants: 4, maxBufferedAmount: 65_536,
    maxPendingMessages: 16, maxPendingBytes: 131_072, grantTtlMs: 10_000,
    authenticate: credential => credential?.startsWith('Bearer ')
      ? { accountId: 'account', scopeId: 'scope', agentId: credential.slice(7) } : null,
  })
}

function agentConfig(endpoint: string, extra = ''): DaemonIntentV4 {
  return resolveDaemonIntent(parseDaemonConfigText(`version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
hostId = "host-a"
accountId = "account"
scopeId = "scope"
dataDirectory = "./state/reasoner-a"
${extra}

[discovery]
serverId = "lan-registry"
endpoint = "${endpoint}"
credentialRef = "env:TEAMS_DISCOVERY_CREDENTIAL"
tlsTrustRef = "file:./ca.pem"
`), { configDirectory: directory })
}

function localAgentConfig(): DaemonIntentV4 {
  return resolveDaemonIntent(parseDaemonConfigText(`version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
hostId = "host-a"
accountId = "account"
scopeId = "scope"
dataDirectory = "./state/reasoner-a"
`), { configDirectory: directory })
}

it('reports discovery as explicitly disabled when the config omits it', () => {
  expect(resolveRegistrationPlan(localAgentConfig())).toEqual({ state: 'disabled', reason: 'discovery-not-configured' })
})

it('rejects a registry daemon config as not registrable', () => {
  const registry = resolveDaemonIntent(parseDaemonConfigText(`version = 4

[daemon]
kind = "registry"
id = "lan-registry"
hostId = "registry-host"
accountId = "account"
scopeId = "scope"
dataDirectory = "./state/lan-registry"

[listen]
ip = "127.0.0.1"
port = 7444
tlsCertRef = "file:./ca.pem"
tlsKeyRef = "file:./key.pem"
`), { configDirectory: directory })
  expect(() => resolveRegistrationPlan(registry)).toThrowError(/registry daemon does not register/)
})

it('selects the configured discovery endpoint and publishes only the declared identity', () => {
  const intent = agentConfig('wss://127.0.0.1:7444')
  const plan = resolveRegistrationPlan(intent)
  expect(plan).toMatchObject({ state: 'enabled', discovery: { serverId: 'lan-registry', endpoint: 'wss://127.0.0.1:7444' } })
  if (plan.state !== 'enabled') throw new Error('plan was not enabled')
  expect(plan.heartbeatIntervalMs).toBeLessThan(90_000)
  // A v4 agent config without an engine serves no ACP yet.
  expect(declarationForDaemon(intent)).toMatchObject({ identity: { agentKind: 'custom' }, capabilities: [], routes: [] })
  // A declared engine is what makes the daemon carry the ACP increment.
  expect(declarationForDaemon(agentConfig('wss://127.0.0.1:7444', '\n[engine]\nkind = "opencode"'))).toEqual({
    identity: { hostId: 'host-a', machineId: 'host-a', agentId: 'reasoner-a', accountId: 'account', agentKind: 'acp', label: 'reasoner-a' },
    scopeId: 'scope',
    revision: 1,
    capabilities: [],
    routes: [],
  })
})

it('publishes the real listener route and the ACP capability as one advanced declaration', () => {
  const listener = '\n[engine]\nkind = "opencode"\n\n[listen]\nip = "127.0.0.1"\nport = 8443\ntlsCertRef = "file:./ca.pem"\ntlsKeyRef = "file:./key.pem"'
  const intent = agentConfig('wss://127.0.0.1:7444', listener)
  const routes = listenerRouteCandidates(intent, '2026-10-11T00:00:00.000Z')
  expect(routes).toEqual([{
    candidateId: 'reasoner-a-lan-8443',
    kind: 'lan',
    endpoint: 'wss://127.0.0.1:8443',
    port: 8443,
    authRequired: true,
    lastSeenAt: '2026-10-11T00:00:00.000Z',
  }])
  const base = declarationForDaemon(intent)
  const capabilities = [{
    capabilityId: 'acp',
    version: '1',
    operations: [{ operation: 'session/prompt', inputSchema: {}, outputSchema: {}, cancellation: 'cooperative' as const }],
    resources: [],
  }]
  const published = declarationWithPublishedSurfaces(base, { capabilities, routes })
  expect(published).toEqual({ ...base, revision: 2, capabilities, routes })
  // Identity, scope and agentKind are preserved; only the revision advances.
  expect(published.identity).toEqual(base.identity)
  expect(published.scopeId).toBe(base.scopeId)
  // A daemon that declares no listener publishes no route.
  expect(listenerRouteCandidates(agentConfig('wss://127.0.0.1:7444'), '2026-10-11T00:00:00.000Z')).toEqual([])
})

it('resolves env and file credentials plus the TLS trust anchor without leaking the secret', async () => {  const plan = resolveRegistrationPlan(agentConfig('wss://127.0.0.1:7444'))
  if (plan.state !== 'enabled') throw new Error('plan was not enabled')
  const bootstrap = await loadRegistrationBootstrap(plan.discovery, { env: { TEAMS_DISCOVERY_CREDENTIAL: 'Bearer from-env' } })
  expect(bootstrap.credential).toBe('Bearer from-env')
  expect(bootstrap.ca.toString('utf8')).toBe(cert)

  const filePlan = { ...plan.discovery, credentialRef: `file:${join(directory, 'discovery.cred')}` }
  const fromFile = await loadRegistrationBootstrap(filePlan, { env: {} })
  expect(fromFile.credential).toBe('Bearer reasoner-a')

  await expect(loadRegistrationBootstrap(plan.discovery, { env: {} })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
})

it('registers a config-selected daemon over a real socket and stops cleanly', async () => {
  relay = await relayServer(0)
  const intent = agentConfig(relay.url, '\n[engine]\nkind = "opencode"')
  const registration = await startDaemonRegistration(intent, { env: { TEAMS_DISCOVERY_CREDENTIAL: 'Bearer reasoner-a' }, heartbeatIntervalMs: 100 })
  registrations.push(registration)
  expect(registration).toMatchObject({ state: 'enabled', status: { state: 'online', endpoint: relay.url, generation: 1 } })

  const watcher = await createRelayClient({
    declaration: { identity: { hostId: 'watcher', machineId: 'watcher', agentId: 'watcher', accountId: 'account', agentKind: 'custom', label: 'watcher' },
      scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
    transport: { endpoint: relay.url, credential: 'Bearer watcher', ca: cert, connectTimeoutMs: 1_000,
      maxMessageBytes: 65_536, maxBufferedBytes: 65_536, maxPendingFrames: 16 },
    admissionTimeoutMs: 1_000, requestTimeoutMs: 1_000, maxPendingRequests: 8, maxDataConnections: 4,
  })
  observers.push(watcher)
  expect((await watcher.directory(false)).find(peer => peer.declaration.identity.agentId === 'reasoner-a'))
    .toMatchObject({ presence: 'online', declaration: { identity: { hostId: 'host-a', agentKind: 'acp' } } })

  if (registration.state !== 'enabled') throw new Error('registration was not enabled')
  await registration.client.stop()
  expect(registration.client.status()).toMatchObject({ state: 'stopped' })
})

it('keeps a standalone registration process alive through a registry outage and reconnects it', async () => {
  const port = await freePort()
  relay = await relayServer(port)
  const configPath = join(directory, `standalone-${port}.toml`)
  const statusFile = join(directory, `standalone-${port}-status.json`)
  writeFileSync(configPath, `version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
hostId = "host-a"
accountId = "account"
scopeId = "scope"
dataDirectory = ${JSON.stringify(join(directory, `standalone-${port}-state`))}

[discovery]
serverId = "lan-registry"
endpoint = "wss://127.0.0.1:${port}"
credentialRef = "file:${join(directory, 'discovery.cred')}"
tlsTrustRef = "file:${join(directory, 'ca.pem')}"
`)
  const child = spawn(process.execPath, [...transformFlags, entryPath, '--config', configPath, '--status-file', statusFile], {
    cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })
  expect(child.pid).toBeGreaterThan(0)
  const online = await waitForStatus(statusFile, status => status.state === 'online', 15_000)
  expect(online).toMatchObject({ state: 'online', endpoint: `wss://127.0.0.1:${port}` })

  await relay.close()
  relay = undefined
  const reconnecting = await waitForStatus(statusFile, status => status.state === 'reconnecting', 15_000)
  expect(reconnecting.lastError).toBeDefined()
  // The regression this process-level test exists for: with only unref'd retry
  // timers left, a standalone entry must not exit during the outage window.
  expect(processAlive(child.pid!)).toBe(true)

  relay = await relayServer(port)
  const reconnected = await waitForStatus(statusFile, status => status.state === 'online' && Number(status.reconnects) >= 1, 30_000)
  expect(reconnected).toMatchObject({ state: 'online', reconnects: 1, endpoint: `wss://127.0.0.1:${port}` })
  expect(stderr).not.toContain('registration process failed')
}, 60_000)
