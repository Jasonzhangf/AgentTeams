import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createRelayClient, type RelayClient } from '../network/relay-client.ts'
import { createWorkChannel } from '../network/work-channel.ts'
import { createRelayConsoleClient } from './relay-console-client.ts'
import { createConsoleServer } from '../console-host/src/server.ts'
import { createConsoleHttpClient } from '../ui/teams-console/src/client/api.ts'
import { startAgentProcess } from './agent-process.ts'
import { createFileWorkStore, createWorkLedger, proposeWork, requestWork } from '../agent/work-resource.ts'
import { createCliWorkExecutor } from '../agent-host/cli-executor.ts'

let directory: string
let relay: RelayServer
let consumer: RelayClient
let cert: Buffer
const children: ChildProcess[] = []
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-agent-process-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  cert = readFileSync(join(directory, 'cert.pem'))
})
afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }
  await consumer?.close()
  await relay?.close()
  rmSync(directory, { recursive: true, force: true })
})
async function availablePort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('test port missing')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return address.port
}
function child(configPath: string, credential = 'Bearer provider') {
  const process = spawn(globalThis.process.execPath, ['--experimental-transform-types', resolve('runtime/agent-process.ts'), '--config', configPath],
    { env: { ...globalThis.process.env, TEAMS_AGENT_TEST_AUTH: credential }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(process)
  let output = ''
  process.stderr!.on('data', chunk => { output += chunk.toString() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once('exit', (code, signal) => resolve({ code, signal })))
  const ready = new Promise<{ agentId: string; generation: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Agent startup deadline: ${output}`)), 5000)
    process.once('message', message => {
      clearTimeout(timeout)
      if ((message as { kind?: string }).kind !== 'daemon.registered') reject(new Error('unexpected process control message'))
      else resolve(message as { agentId: string; generation: number })
    })
    process.once('exit', () => { clearTimeout(timeout); reject(new Error(`Agent exited before registration: ${output}`)) })
    process.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  return { process, ready, exited, output: () => output }
}

it('executes remote Work in an actual Agent process, rejects duplicate ownership and restarts from durable state', async () => {
  relay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key: readFileSync(join(directory, 'key.pem')),
    maxPayload: 65536, maxConnections: 16, maxGrants: 8, maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 10000,
    authenticate: credential => ['provider', 'consumer', 'managed', 'provider2', 'consumer2'].includes(credential.slice(7)) && credential.startsWith('Bearer ')
      ? { accountId: 'account', scopeId: 'scope', agentId: credential.slice(7) } : null })
  const transport = { endpoint: relay.url, credential: 'Bearer consumer', ca: cert, connectTimeoutMs: 1000,
    maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 }
  consumer = await createRelayClient({ transport, declaration: { identity: { hostId: 'consumer', machineId: 'test', agentId: 'consumer', accountId: 'account', agentKind: 'custom', label: 'Consumer' }, scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
    admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxPendingRequests: 8, maxDataConnections: 8 })
  mkdirSync(join(directory, 'search'))
  writeFileSync(join(directory, 'search', 'sample.txt'), 'process work needle\n')
  const config = { version: 1, identity: { hostId: 'provider', machineId: 'test', agentId: 'provider', accountId: 'account', agentKind: 'custom', label: 'Provider' },
    scopeId: 'scope', dataDirectory: './data', leasePort: await availablePort(), presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: ['consumer', 'initiator'], allowedManagers: ['consumer'] },
    cli: { camoExecutable: '/opt/homebrew/bin/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: './search', profilePrefix: 'teams-process-test' },
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: './cert.pem', connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 } }
  const path = join(directory, 'agent.json')
  writeFileSync(path, JSON.stringify(config))
  const first = child(path)
  expect(await first.ready).toMatchObject({ agentId: 'provider', generation: 1 })
  const duplicate = child(path)
  await expect(duplicate.ready).rejects.toThrow(/EADDRINUSE/)
  expect((await duplicate.exited).code).toBe(1)
  const provider = (await consumer.directory(false)).find(peer => peer.declaration.identity.agentId === 'provider')!
  expect(provider.declaration.revision).toBe(2)
  expect(provider.declaration.capabilities.map(item => item.capabilityId)).toContain('file-search')
  expect(provider.declaration.capabilities.find(item => item.capabilityId === 'file-search')!.operations[0]).toMatchObject({
    operation: 'search', inputSchema: { type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 }, maxResults: { type: 'integer', minimum: 1 } } },
    outputSchema: { required: ['query', 'status', 'exitCode', 'matches', 'truncated', 'stdout', 'stderr'] },
  })
  const management = createRelayConsoleClient(consumer, 'provider', 2000)
  expect((await management.readProjection()).agents[0]).toMatchObject({ agentId: 'provider', presence: 'online', capabilities: ['browser', 'file-search'] })
  expect(await management.command({ kind: 'config.apply', agentId: 'provider' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
  const consoleServer = createConsoleServer({ staticRoot: resolve('console-host/static'), uiRoot: resolve('ui/teams-console/lib'),
    authorize: async request => request.headers.authorization === 'console-test' ? management : undefined })
  await new Promise<void>(resolve => consoleServer.listen(0, '127.0.0.1', resolve))
  const consoleUrl = `http://127.0.0.1:${(consoleServer.address() as { port: number }).port}`
  try {
    const httpClient = createConsoleHttpClient({ baseUrl: consoleUrl,
      fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, authorization: 'console-test' } }) })
    expect((await httpClient.readProjection()).agents[0].agentId).toBe('provider')
    expect(await httpClient.command({ kind: 'config.apply', agentId: 'provider' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
    expect((await fetch(consoleUrl, { headers: { authorization: 'console-test' } })).status).toBe(200)
  } finally { await new Promise<void>(resolve => consoleServer.close(() => resolve())) }
  const malformedGrant = await consumer.connect('provider', 1)
  const malformed = await consumer.openData(malformedGrant)
  await malformed.send({ bytes: Buffer.from('{"kind":"unrecognized"}'), binary: false })
  await malformed.closed
  expect((await management.readProjection()).agents[0].presence).toBe('online')
  const connect = async (generation: number) => {
    const grant = await consumer.connect('provider', generation)
    return createWorkChannel(await consumer.openData(grant), { timeoutMs: 2000, maxPending: 4, maxIncoming: 4 })
  }
  const channel = await connect(1)
  expect(await channel.request({ kind: 'work.propose', proposal: { workId: 'work', consumerAgentId: 'consumer', providerAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 } })).toMatchObject({ work: { state: 'accepted' } })
  expect(await channel.request({ kind: 'work.request', control: { workId: 'work', requestId: 'request', operation: 'search', targetGeneration: 1, demands: [{ resourceId: 'search-slot', amount: 1 }] },
    payload: { query: 'process work needle' } })).toMatchObject({ control: { state: 'succeeded' }, payload: { matches: [expect.objectContaining({ text: 'process work needle\n' })] } })
  await channel.request({ kind: 'work.close', workId: 'work' })
  first.process.kill('SIGTERM')
  expect((await first.exited).code).toBe(0)

  const managedExecutable = join(directory, 'managed-opencode.mjs')
  writeFileSync(managedExecutable, `#!/usr/bin/env node
import { createServer } from 'node:http'
const args = process.argv
const port = Number(args[args.indexOf('--port') + 1])
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
const server = createServer((request, response) => {
  if (request.url === '/global/health') { response.writeHead(200, {'content-type': 'application/json'}); response.end('{}'); return }
  if (request.url === '/config') { response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify(config)); return }
  response.writeHead(404); response.end()
})
server.listen(port, '127.0.0.1')
process.once('SIGTERM', () => server.close(() => process.exit(0)))
process.once('SIGINT', () => server.close(() => process.exit(0)))
`, { mode: 0o700 })
  chmodSync(managedExecutable, 0o700)
  const managedData = join(directory, 'managed-data')
  const managedConfigPath = join(directory, 'managed-runtime.json')
  writeFileSync(managedConfigPath, JSON.stringify({ revision: 3, acceptedRevision: 3,
    providers: { probe: { id: 'probe', label: 'Probe', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } } },
    catalogs: { probe: { state: 'ready', entries: [{ ref: { providerInstanceId: 'probe', modelId: 'probe-model' }, origin: 'manual', base: {}, overrides: {} }] } },
    agents: { managed: { primary: { providerInstanceId: 'probe', modelId: 'probe-model' } } } }))
  const managedAgentConfig = join(directory, 'managed-agent.json')
  writeFileSync(managedAgentConfig, JSON.stringify({ ...config, identity: { ...config.identity, hostId: 'managed-host', agentId: 'managed', label: 'Managed Agent' },
    dataDirectory: managedData, leasePort: await availablePort(), policy: { revision: 1, allowedConsumers: ['consumer'], allowedManagers: ['consumer'] },
    openCode: { executable: managedExecutable, directory: join(directory, 'managed-opencode-data'), configFile: managedConfigPath, port: await availablePort(), startupTimeoutMs: 5000, stopTimeoutMs: 2000 } }))
  const managedChild = child(managedAgentConfig, 'Bearer managed')
  expect(await managedChild.ready).toMatchObject({ agentId: 'managed' })
  const managedConsole = createRelayConsoleClient(consumer, 'managed', 3000)
  expect(await managedConsole.command({ kind: 'config.apply', agentId: 'managed' })).toEqual({ ok: true })
  expect((await managedConsole.readProjection()).configs[0]).toMatchObject({ acceptedRevision: 3, effectiveRevision: 3 })
  managedChild.process.kill('SIGTERM')
  expect((await managedChild.exited).code).toBe(0)

  writeFileSync(path, JSON.stringify({ ...config, policy: { ...config.policy, allowedManagers: [] } }))
  const second = child(path)
  expect(await second.ready).toMatchObject({ generation: 2 })
  await expect(management.readProjection()).rejects.toMatchObject({ error: { code: 'FORBIDDEN' } })
  const query = await connect(2)
  expect(await query.request({ kind: 'work.get', workId: 'work', requestId: 'request' })).toMatchObject({ control: { state: 'succeeded' } })
  second.process.kill('SIGKILL')
  expect((await second.exited).signal).toBe('SIGKILL')
  const third = child(path)
  expect(await third.ready).toMatchObject({ generation: 3 })
  third.process.kill('SIGINT')
  expect((await third.exited).code).toBe(0)
  expect(first.output()).not.toContain('Bearer provider')
}, 15000)

it('completes Agent-to-Agent Work between two independently started daemons without Console', async () => {
  const root = join(directory, 'cross-daemon')
  mkdirSync(join(root, 'provider-files'), { recursive: true })
  writeFileSync(join(root, 'provider-files', 'agent.txt'), 'direct daemon work needle\n')
  const providerConfig = join(root, 'provider.json')
  const consumerConfig = join(root, 'consumer.json')
  const base = {
    version: 1,
    scopeId: 'scope',
    presenceIntervalMs: 1000,
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: './provider-files', profilePrefix: 'teams-cross-daemon' },
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 3000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
  }
  writeFileSync(providerConfig, JSON.stringify({ ...base,
    identity: { hostId: 'provider-host-2', machineId: 'test', agentId: 'provider2', accountId: 'account', agentKind: 'custom', label: 'Provider 2' },
    dataDirectory: './provider-data', leasePort: await availablePort(), policy: { revision: 1, allowedConsumers: ['consumer2'], allowedManagers: [] } }))
  writeFileSync(consumerConfig, JSON.stringify({ ...base,
    identity: { hostId: 'consumer-host-2', machineId: 'test', agentId: 'consumer2', accountId: 'account', agentKind: 'custom', label: 'Consumer 2' },
    dataDirectory: './consumer-data', leasePort: await availablePort(),
    cli: { ...base.cli, searchRoot: './consumer-files', profilePrefix: 'teams-cross-consumer' },
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] } }))
  mkdirSync(join(root, 'consumer-files'), { recursive: true })
  let provider: Awaited<ReturnType<typeof startAgentProcess>> | undefined
  let consumerAgent: Awaited<ReturnType<typeof startAgentProcess>> | undefined
  try {
    provider = await startAgentProcess(providerConfig, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer provider2' })
    consumerAgent = await startAgentProcess(consumerConfig, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer consumer2' })
    const providerPeer = (await consumerAgent.daemon.network.directory(false)).find(peer => peer.declaration.identity.agentId === 'provider2')
    expect(providerPeer).toBeDefined()
    const channel = createWorkChannel(await consumerAgent.daemon.network.openData(
      await consumerAgent.daemon.network.connect('provider2', provider!.daemon.network.generation)),
      { timeoutMs: 3000, maxPending: 4, maxIncoming: 4 })
    try {
      await expect(channel.request({ kind: 'work.propose', proposal: { workId: 'direct-work', consumerAgentId: 'consumer2', providerAgentId: 'provider2',
        capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 } })).resolves.toMatchObject({ work: { state: 'accepted' } })
      await expect(channel.request({ kind: 'work.request', control: { workId: 'direct-work', requestId: 'direct-request', operation: 'search',
        targetGeneration: provider!.daemon.network.generation, demands: [{ resourceId: 'search-slot', amount: 1 }] }, payload: { query: 'direct daemon work needle' } }))
        .resolves.toMatchObject({ control: { state: 'succeeded' }, payload: { matches: [expect.objectContaining({ text: 'direct daemon work needle\n' })] } })
      await expect(channel.request({ kind: 'work.close', workId: 'direct-work' })).resolves.toMatchObject({ work: { state: 'closed' } })
    } finally { await channel.close() }
  } finally {
    await consumerAgent?.stop()
    await provider?.stop()
  }
}, 15000)

it('persists unknown state before refusing a restart with active Work', async () => {
  const root = join(directory, 'recovery')
  mkdirSync(join(root, 'files'), { recursive: true })
  writeFileSync(join(root, 'files', 'active.txt'), 'active work\n')
  const dataDirectory = join(root, 'data')
  const workFile = join(dataDirectory, 'work.json')
  const executor = createCliWorkExecutor({ camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg',
    searchRoot: join(root, 'files'), profilePrefix: 'teams-recovery' })
  const provider = { accountId: 'account', scopeId: 'scope', agentId: 'provider2' }
  const consumer = { accountId: 'account', scopeId: 'scope', agentId: 'consumer2' }
  const ledger = createWorkLedger({ provider, generation: 1, capabilities: executor.capabilities, store: createFileWorkStore(workFile) })
  const policy = { revision: 1, authorizeWork: (candidate: typeof consumer) => candidate.agentId === consumer.agentId,
    authorizeRequest: (candidate: typeof consumer) => candidate.agentId === consumer.agentId }
  proposeWork(ledger, consumer, { workId: 'active-work', consumerAgentId: consumer.agentId, providerAgentId: provider.agentId,
    capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 }, policy)
  const admitted = requestWork(ledger, { authenticatedConsumer: consumer, policy, request: {
    control: { workId: 'active-work', requestId: 'active-request', operation: 'search', targetGeneration: 1,
      demands: [{ resourceId: 'search-slot', amount: 1 }] }, payload: { query: 'active work' },
  } })
  expect(admitted.executionAllowed).toBe(true)
  const configPath = join(root, 'agent.json')
  writeFileSync(configPath, JSON.stringify({ version: 1,
    identity: { hostId: 'recovery-host', machineId: 'test', agentId: provider.agentId, accountId: provider.accountId, agentKind: 'custom', label: 'Recovery Provider' },
    scopeId: provider.scopeId, dataDirectory, leasePort: await availablePort(), presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [consumer.agentId], allowedManagers: [] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: join(root, 'files'), profilePrefix: 'teams-recovery' },
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 } }))
  const restarted = child(configPath, 'Bearer provider2')
  await expect(restarted.ready).rejects.toThrow(/persisted resources require trusted reconciliation/)
  expect((await restarted.exited).code).toBe(1)
  const recovered = JSON.parse(readFileSync(workFile, 'utf8')) as { requests: Array<{ state: string }>; allocations: Array<{ state: string }> }
  expect(recovered.requests[0]?.state).toBe('unknown')
  expect(recovered.allocations[0]?.state).toBe('unknown')
}, 15000)
