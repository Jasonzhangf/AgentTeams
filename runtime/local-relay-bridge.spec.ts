import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { createRelayClient, type RelayClient } from '../network/relay-client.ts'
import { createWorkChannel } from '../network/work-channel.ts'
import { createLocalSupervisor } from './local-supervisor.ts'
import { loadLocalConfig } from './local-config.ts'

async function availablePort(): Promise<number> {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('test port missing')
  await new Promise<void>(resolveClose => listener.close(() => resolveClose()))
  return address.port
}

const active: Array<{ readonly supervisor: ReturnType<typeof createLocalSupervisor>; readonly driver?: RelayClient; readonly root: string }> = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const item of active.splice(0)) {
    try { await item.driver?.close() } catch (error) { failures.push(error) }
    try { await item.supervisor.stop() } catch (error) { failures.push(error) }
    try { rmSync(item.root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'local Relay bridge test cleanup failed')
})

it('replays a config-driven local Relay bridge across independent daemon processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'teams-local-bridge-'))
  const keyFile = join(root, 'relay-key.pem')
  const certFile = join(root, 'relay-cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' })
  const relayPort = await availablePort()
  const providerLeasePort = await availablePort()
  const consumerLeasePort = await availablePort()
  const searchRoot = join(root, 'provider-files')
  const providerData = join(root, 'provider-data')
  const consumerData = join(root, 'consumer-data')
  const relayConfig = join(root, 'relay.json')
  const providerConfig = join(root, 'provider.json')
  const consumerConfig = join(root, 'consumer.json')
  const localConfigPath = join(root, 'config.toml')
  const relayEndpoint = `wss://127.0.0.1:${relayPort}`
  writeFileSync(relayConfig, JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: relayPort },
    tls: { keyFile, certFile }, limits: { maxPayload: 65536, maxConnections: 16, maxGrants: 8,
      maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 5000 },
    credentials: [
      { credentialEnv: 'TEAMS_PROVIDER_AUTH', identity: { accountId: 'local-account', scopeId: 'local-scope', agentId: 'provider' } },
      { credentialEnv: 'TEAMS_CONSUMER_AUTH', identity: { accountId: 'local-account', scopeId: 'local-scope', agentId: 'consumer' } },
      { credentialEnv: 'TEAMS_DRIVER_AUTH', identity: { accountId: 'local-account', scopeId: 'local-scope', agentId: 'driver' } },
    ] }))
  mkdirSync(searchRoot, { recursive: true })
  writeFileSync(join(searchRoot, 'needle.txt'), 'relay bridge process work\n')
  const base = {
    version: 1, scopeId: 'local-scope', presenceIntervalMs: 500,
    relay: { endpoint: relayEndpoint, credentialEnv: '', caFile: certFile, connectTimeoutMs: 1000,
      admissionTimeoutMs: 1000, requestTimeoutMs: 3000, maxMessageBytes: 65536, maxBufferedBytes: 65536,
      maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
    cli: { camoExecutable: '/missing/camo', searchExecutable: execFileSync('which', ['rg'], { encoding: 'utf8' }).trim(),
      searchRoot, profilePrefix: 'teams-local-bridge' },
  }
  writeFileSync(providerConfig, JSON.stringify({ ...base,
    identity: { hostId: 'provider-host', machineId: 'local-machine', agentId: 'provider', accountId: 'local-account', agentKind: 'custom', label: 'Provider' },
    dataDirectory: providerData, leasePort: providerLeasePort, policy: { revision: 1, allowedConsumers: ['driver'], allowedManagers: [] },
    relay: { ...base.relay, credentialEnv: 'TEAMS_PROVIDER_AUTH' } }))
  writeFileSync(consumerConfig, JSON.stringify({ ...base,
    identity: { hostId: 'consumer-host', machineId: 'local-machine', agentId: 'consumer', accountId: 'local-account', agentKind: 'custom', label: 'Consumer' },
    dataDirectory: consumerData, leasePort: consumerLeasePort, policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    relay: { ...base.relay, credentialEnv: 'TEAMS_CONSUMER_AUTH' } }))
  writeFileSync(localConfigPath, `version = 1\n\n[relay]\nconfig = ${JSON.stringify(relayConfig)}\n\n[daemons.provider]\nconfig = ${JSON.stringify(providerConfig)}\n\n[daemons.consumer]\nconfig = ${JSON.stringify(consumerConfig)}\n`)

  const config = await loadLocalConfig(localConfigPath)
  const supervisor = createLocalSupervisor(config, {
    relayEntry: resolve('server/relay-process.ts'),
    agentEntry: resolve('runtime/agent-process.ts'),
    nodeArguments: ['--experimental-transform-types'],
    env: { TEAMS_PROVIDER_AUTH: 'Bearer provider', TEAMS_CONSUMER_AUTH: 'Bearer consumer', TEAMS_DRIVER_AUTH: 'Bearer driver' },
  })
  const lease: { readonly supervisor: ReturnType<typeof createLocalSupervisor>; driver?: RelayClient; readonly root: string } = { supervisor, root }
  active.push(lease)
  await supervisor.start()
  const createDriver = () => createRelayClient({
    transport: { endpoint: relayEndpoint, credential: 'Bearer driver', ca: readFileSync(certFile), connectTimeoutMs: 1000,
      maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 },
    declaration: { identity: { hostId: 'driver-host', machineId: 'local-machine', agentId: 'driver', accountId: 'local-account', agentKind: 'custom', label: 'Driver' },
      scopeId: 'local-scope', revision: 1, capabilities: [], routes: [] },
    admissionTimeoutMs: 1000, requestTimeoutMs: 3000, maxPendingRequests: 8, maxDataConnections: 8,
  })
  let driver = await createDriver()
  lease.driver = driver
  const first = await driver.directorySnapshot(false)
  const provider = first.peers.find(peer => peer.declaration.identity.agentId === 'provider')
  const consumer = first.peers.find(peer => peer.declaration.identity.agentId === 'consumer')
  expect(provider?.presence).toBe('online')
  expect(consumer?.presence).toBe('online')
  expect(provider?.declaration.capabilities.find(capability => capability.capabilityId === 'file-search')?.operations).toContainEqual(expect.objectContaining({ operation: 'search' }))
  expect(first.revision).toBeGreaterThan(0)
  const firstGeneration = provider!.generation
  const channel = await createWorkChannel(await driver.openData(await driver.connect('provider', firstGeneration)), { timeoutMs: 3000, maxPending: 4, maxIncoming: 2 })
  try {
    await expect(channel.request({ kind: 'work.propose', proposal: { workId: 'bridge-work', consumerAgentId: 'driver', providerAgentId: 'provider',
      capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 } })).resolves.toMatchObject({ work: { state: 'accepted' } })
    await expect(channel.request({ kind: 'work.request', control: { workId: 'bridge-work', requestId: 'bridge-request', operation: 'search', targetGeneration: firstGeneration,
      demands: [{ resourceId: 'search-slot', amount: 1 }] }, payload: { query: 'relay bridge process work' } })).resolves.toMatchObject({ control: { state: 'succeeded' }, payload: { matches: [expect.objectContaining({ text: 'relay bridge process work\n' })] } })
    await expect(channel.request({ kind: 'work.close', workId: 'bridge-work' })).resolves.toMatchObject({ work: { state: 'closed' } })
  } finally { await channel.close() }

  await driver.close()
  lease.driver = undefined
  await supervisor.stop()
  await supervisor.start()
  driver = await createDriver()
  lease.driver = driver
  const second = await driver.directorySnapshot(false)
  const restarted = second.peers.find(peer => peer.declaration.identity.agentId === 'provider')
  expect(restarted?.generation).toBe(1)
  const secondChannel = await createWorkChannel(await driver.openData(await driver.connect('provider', restarted!.generation)), { timeoutMs: 3000, maxPending: 4, maxIncoming: 2 })
  await secondChannel.close()
})
