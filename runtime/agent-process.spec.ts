import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createRelayClient, type RelayClient } from '../network/relay-client.ts'
import { connectDirectWssTarget } from '../network/direct-route.ts'
import { buildDirectWssRoutePlan } from '../network/route-plan.ts'
import { createWorkChannel } from '../network/work-channel.ts'
import { createRelayConsoleClient } from './relay-console-client.ts'
import { createConsoleHub } from './console-hub.ts'
import { createConsoleServer } from '../console-host/src/server.ts'
import { createConsoleHttpClient } from '../ui/teams-console/src/client/api.ts'
import { createSessionHost, loadAgentProcessConfig, projectRuntimeAgentRow, resolveWorkChildReply, startAgentProcess } from './agent-process.ts'
import type { ManagedEffectiveHandle, ManagedRuntimeReadiness } from './managed-config-owner.ts'
import { OpenCodeAdapterError, type OpenCodeEventClient, type OpenCodeSdkEvent, type OpenCodeSessionClient } from '../opencode-adapter/src/index.ts'
import { RuntimeConfigError } from '../config/runtime-config.ts'
import type { LocalWorkControlRequest } from './local-work-control.ts'
import { createFileWorkStore, createWorkLedger, proposeWork, requestWork } from '../agent/work-resource.ts'
import { createCliWorkExecutor } from '../agent-host/cli-executor.ts'
import type { LocalServiceIntent } from './local-config.ts'
import { buildRunner } from './dagpipe/build.mjs'
import { runWorkExecution, type WorkCloseIntentControl, type WorkOpenIntentControl, type WorkRequestIntentControl } from './dagpipe/host.ts'

const workOpenGraph = join(resolve(import.meta.dirname), '..', 'docs', 'design', 'dagpipe', 'graphs', 'work-open.graph.json')
const workRequestGraph = join(resolve(import.meta.dirname), '..', 'docs', 'design', 'dagpipe', 'graphs', 'work-request.graph.json')
const workCloseGraph = join(resolve(import.meta.dirname), '..', 'docs', 'design', 'dagpipe', 'graphs', 'work-close.graph.json')

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
function child(configPath: string, credential = 'Bearer provider', extraEnv: NodeJS.ProcessEnv = {}) {
  const process = spawn(globalThis.process.execPath, ['--experimental-transform-types', resolve('runtime/agent-process.ts'), '--config', configPath],
    { env: { ...globalThis.process.env, TEAMS_AGENT_TEST_AUTH: credential, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(process)
  let output = ''
  process.stderr!.on('data', chunk => { output += chunk.toString() })
  process.stdout!.on('data', chunk => { output += chunk.toString() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once('exit', (code, signal) => resolve({ code, signal })))
  const ready = new Promise<{ agentId: string; generation: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Agent startup deadline: ${output}`)), 5000)
    process.once('message', message => {
      clearTimeout(timeout)
      if ((message as { kind?: string }).kind !== 'daemon.registered') reject(new Error('unexpected process control message'))
      else resolve(message as { agentId: string; generation: number })
    })
    process.once('close', code => { clearTimeout(timeout); reject(new Error(`Agent exited before registration (${configPath}, code=${code}): ${output}`)) })
    process.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  return { process, ready, exited, output: () => output }
}

const searchService: LocalServiceIntent = {
  capabilityId: 'file-search',
  version: '1',
  operations: ['search'],
  resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }],
}

const browserService: LocalServiceIntent = {
  capabilityId: 'browser',
  version: '1',
  operations: ['context.create', 'navigate', 'snapshot', 'context.destroy'],
  resources: [
    { resourceId: 'browser-context', capacity: 2, unit: 'context' },
    { resourceId: 'browser-slot', capacity: 2, unit: 'slot' },
  ],
}

const browserDemands = [
  { resourceId: 'browser-context', amount: 1 },
  { resourceId: 'browser-slot', amount: 1 },
]

it('accepts service-only connect intent and rejects retired startup Work fields before publication', async () => {
  const root = join(directory, 'connect-contract')
  mkdirSync(join(root, 'files'), { recursive: true })
  const base = {
    version: 1, scopeId: 'scope', presenceIntervalMs: 1000,
    identity: { hostId: 'consumer-host', machineId: 'test', agentId: 'consumer', accountId: 'account', agentKind: 'custom', label: 'Consumer' },
    dataDirectory: './consumer-data', leasePort: await availablePort(),
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: './files', profilePrefix: 'teams-connect' },
    relay: { endpoint: 'wss://127.0.0.1:1', credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000,
      admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
  }
  const selection = { targetAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', operation: 'search', demands: [{ resourceId: 'search-slot', amount: 1 }] }
  const write = (name: string, connect: unknown) => {
    const path = join(root, name)
    writeFileSync(path, JSON.stringify({ ...base, endpoint: { role: 'receiver', connect, services: [] } }))
    return path
  }
  const env = { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer consumer' }
  const selectionOnly = await loadAgentProcessConfig(write('selection.json', selection), env)
  expect(selectionOnly.endpoint?.connect).toEqual(selection)
  await expect(loadAgentProcessConfig(write('work.json', { ...selection, workId: 'legacy-work' }), env)).rejects.toThrow(/endpoint\.connect has unsupported field workId/)
  await expect(loadAgentProcessConfig(write('request.json', { ...selection, requestId: 'legacy-request' }), env)).rejects.toThrow(/endpoint\.connect has unsupported field requestId/)
  await expect(loadAgentProcessConfig(write('payload.json', { ...selection, payload: { query: 'needle' } }), env)).rejects.toThrow(/endpoint\.connect has unsupported field payload/)
})

it('loads control-protocol frames through a raw Node transform-types child', () => {
  const output = execFileSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import { parseTargetControlFrame } from './control-protocol/frames.ts'
    const frame = parseTargetControlFrame({ kind: 'transport.ping', targetGeneration: 1, nonce: 'raw-child' })
    if (frame.kind !== 'transport.ping' || frame.nonce !== 'raw-child') throw new Error('raw frame import failed')
    process.stdout.write(frame.nonce)
  `], { cwd: resolve('.'), encoding: 'utf8' })
  expect(output).toBe('raw-child')
})

it('executes remote Work in an actual Agent process, rejects duplicate ownership and restarts from durable state', async () => {
  relay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key: readFileSync(join(directory, 'key.pem')),
    maxPayload: 65536, maxConnections: 16, maxGrants: 8, maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 10000,
    authenticate: credential => ['provider', 'consumer', 'managed', 'provider2', 'consumer2', 'stale-lock-agent'].includes(credential.slice(7)) && credential.startsWith('Bearer ')
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
    endpoint: { role: 'provider', services: [searchService] },
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: './cert.pem', connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 } }
  const path = join(directory, 'agent.json')
  writeFileSync(path, JSON.stringify(config))
  const first = child(path)
  expect(await first.ready).toMatchObject({ agentId: 'provider', generation: 1 })
  const duplicate = child(path)
  await expect(duplicate.ready).rejects.toThrow(/EADDRINUSE/)
  expect((await duplicate.exited).code).toBe(1)
  const secondConfigPath = join(directory, 'agent-two.json')
  writeFileSync(secondConfigPath, JSON.stringify({ ...config,
    identity: { ...config.identity, hostId: 'provider-two', agentId: 'provider2', label: 'Provider Two' },
    dataDirectory: './data-provider-two', leasePort: await availablePort() }))
  const secondProvider = child(secondConfigPath, 'Bearer provider2')
  expect(await secondProvider.ready).toMatchObject({ agentId: 'provider2', generation: 1 })
  const provider = (await consumer.directory(false)).find(peer => peer.declaration.identity.agentId === 'provider')!
  expect(provider.declaration.revision).toBe(2)
  expect(provider.declaration.capabilities.map(item => item.capabilityId)).toEqual(['file-search'])
  expect(provider.declaration.capabilities.find(item => item.capabilityId === 'file-search')!.operations[0]).toMatchObject({
    operation: 'search', inputSchema: { type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 }, maxResults: { type: 'integer', minimum: 1 } } },
    outputSchema: { required: ['query', 'status', 'exitCode', 'matches', 'truncated', 'stdout', 'stderr'] },
  })
  const management = createRelayConsoleClient(consumer, 'provider', 2000)
  expect((await management.readProjection()).agents[0]).toMatchObject({ agentId: 'provider', presence: 'online', capabilities: ['file-search'] })
  expect(await management.command({ kind: 'config.apply', agentId: 'provider' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
  const directoryPeers = await consumer.directory(false)
  expect(directoryPeers.some(peer => peer.declaration.identity.agentId === 'consumer')).toBe(true)
  const dynamicHub = createConsoleHub([], async () => ({
    peers: (await consumer.directory(false)).filter(peer => peer.declaration.identity.agentId !== 'consumer'),
    client: peer => {
      const remote = createRelayConsoleClient(consumer, peer.declaration.identity.agentId, 2000)
      return { ...remote, readProjection: async () => {
        const projection = await remote.readProjection()
        return { ...projection, agents: projection.agents.map(agent => ({ ...agent, capabilities: [] })) }
      } }
    },
  }))
  const consoleServer = createConsoleServer({ staticRoot: resolve('console-host/static'), uiRoot: resolve('ui/teams-console/lib'),
    authorize: async request => request.headers.authorization === 'console-test' ? dynamicHub : undefined })
  await new Promise<void>(resolve => consoleServer.listen(0, '127.0.0.1', resolve))
  const consoleUrl = `http://127.0.0.1:${(consoleServer.address() as { port: number }).port}`
  const connect = async (generation: number) => {
    const grant = await consumer.connect('provider', generation)
    return createWorkChannel(await consumer.openData(grant), { timeoutMs: 2000, maxPending: 4, maxIncoming: 4 })
  }
  try {
    const httpClient = createConsoleHttpClient({ baseUrl: consoleUrl,
      fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, authorization: 'console-test' } }) })
    const projected = await (await fetch(`${consoleUrl}/api/v1/projection`, { headers: { authorization: 'console-test' } })).json() as {
      agents: { agentId: string; generation: number; presence: string; capabilities: string[] }[]; works: unknown[]; relations: unknown[]
    }
    expect(projected.agents).toHaveLength(2)
    expect(projected.agents.map(agent => agent.agentId)).toEqual(expect.arrayContaining(['provider', 'provider2']))
    expect(projected.agents.every(agent => agent.agentId !== 'consumer')).toBe(true)
    expect(projected.agents.find(agent => agent.agentId === 'provider')).toMatchObject({ generation: 1, presence: 'online', capabilities: ['file-search'] })
    expect(projected.agents.find(agent => agent.agentId === 'provider2')).toMatchObject({ generation: 1, presence: 'online', capabilities: ['file-search'] })
    expect(projected.works).toEqual([])
    expect(projected.relations).toEqual([])
    expect(await httpClient.command({ kind: 'config.apply', agentId: 'provider' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
    expect((await fetch(consoleUrl, { headers: { authorization: 'console-test' } })).status).toBe(200)
  const malformedGrant = await consumer.connect('provider', 1)
  const malformed = await consumer.openData(malformedGrant)
  await malformed.send({ bytes: Buffer.from('{"kind":"unrecognized"}'), binary: false })
  await malformed.closed
  expect((await management.readProjection()).agents[0].presence).toBe('online')
  const channel = await connect(1)
  expect(await channel.request({ kind: 'work.propose', proposal: { workId: 'work', consumerAgentId: 'consumer', providerAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 } })).toMatchObject({ work: { state: 'accepted' } })
  expect(await channel.request({ kind: 'work.request', control: { workId: 'work', requestId: 'request', operation: 'search', targetGeneration: 1, demands: [{ resourceId: 'search-slot', amount: 1 }] },
    payload: { query: 'process work needle' } })).toMatchObject({ control: { state: 'succeeded' }, payload: { matches: [expect.objectContaining({ text: 'process work needle\n' })] } })
  await channel.request({ kind: 'work.close', workId: 'work' })
  expect(await management.readProjection()).toMatchObject({
    works: [expect.objectContaining({ agentId: 'provider', workId: 'work', consumerAgentId: 'consumer', state: 'closed' })],
    relations: [expect.objectContaining({ agentId: 'provider', workId: 'work', consumerAgentId: 'consumer', relationPermission: 'granted' })],
  })
  const projectedAfterWork = await (await fetch(`${consoleUrl}/api/v1/projection`, { headers: { authorization: 'console-test' } })).json() as {
    agents: { agentId: string }[]; works: Record<string, unknown>[]; relations: Record<string, unknown>[]
  }
  expect(projectedAfterWork.works).toEqual([expect.objectContaining({ agentId: 'provider', workId: 'work', state: 'closed' })])
  expect(projectedAfterWork.relations).toEqual([expect.objectContaining({ agentId: 'provider', workId: 'work', relationPermission: 'granted' })])
  expect(JSON.stringify(projectedAfterWork)).not.toContain('process work needle')
  } finally { await new Promise<void>(resolve => consoleServer.close(() => resolve())) }
  secondProvider.process.kill('SIGTERM')
  expect((await secondProvider.exited).code).toBe(0)
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
  let catalogAuthSeen = false
  const catalogServer: HttpServer = createHttpServer((request, response) => {
    catalogAuthSeen = request.headers.authorization === 'Bearer provider-catalog'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'catalog-model' }] }))
  })
  await new Promise<void>(resolve => catalogServer.listen(0, '127.0.0.1', resolve))
  const catalogPort = (catalogServer.address() as { port: number }).port
  const managedData = join(directory, 'managed-data')
  const managedConfigPath = join(directory, 'managed-config.toml')
  const managedInternalPath = join(directory, 'managed-internal.toml')
  const managedConfigText = [
    'version = 3',
    '',
    '[providers.probe]',
    'protocol = "openai-chat"',
    'apiBaseUrl = "http://127.0.0.1:1/v1"',
    'label = "Probe"',
    'enabled = true',
    '',
    '[providers.catalog]',
    'protocol = "openai-chat"',
    `apiBaseUrl = "http://127.0.0.1:${catalogPort}/v1"`,
    'label = "Catalog"',
    'enabled = true',
    'credentialEnv = "TEAMS_PROVIDER_TEST_CREDENTIAL"',
    '',
    '[[models]]',
    'provider = "probe"',
    'id = "probe-model"',
    '',
    '[agents.managed.model]',
    'primary = { provider = "probe", model = "probe-model" }',
    '',
  ].join('\n')
  writeFileSync(managedConfigPath, managedConfigText)
  const managedSourceHash = `sha256:${createHash('sha256').update(managedConfigText).digest('hex')}`
  const managedSnapshot = JSON.stringify({
    revision: 3, acceptedRevision: 3,
    providers: {
      probe: { id: 'probe', label: 'Probe', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } },
      catalog: { id: 'catalog', label: 'Catalog', protocol: 'openai-chat', apiBaseUrl: `http://127.0.0.1:${catalogPort}/v1`, enabled: true, auth: { kind: 'bearer', credentialRef: 'TEAMS_PROVIDER_TEST_CREDENTIAL' } },
    },
    catalogs: { probe: { state: 'ready', entries: [{ ref: { providerInstanceId: 'probe', modelId: 'probe-model' }, origin: 'manual', base: {}, overrides: {} }] }, catalog: { state: 'stale', entries: [] } },
    agents: { managed: { primary: { providerInstanceId: 'probe', modelId: 'probe-model' } } },
  })
  writeFileSync(managedInternalPath, [
    'version = 2',
    `sourcePath = "${managedConfigPath}"`,
    'sourceRevision = 3',
    `sourceHash = "${managedSourceHash}"`,
    '',
    '[configRuntime.accepted.managed]',
    'acceptedRevision = 3',
    'acceptedSourceRevision = 3',
    `acceptedSourceHash = "${managedSourceHash}"`,
    `snapshot = '''${managedSnapshot}'''`,
    '',
  ].join('\n'))
  const managedAgentConfig = join(directory, 'managed-agent.json')
  writeFileSync(managedAgentConfig, JSON.stringify({ ...config, identity: { ...config.identity, hostId: 'managed-host', agentId: 'managed', label: 'Managed Agent' },
    dataDirectory: managedData, leasePort: await availablePort(), policy: { revision: 1, allowedConsumers: ['consumer'], allowedManagers: ['consumer'] },
    openCode: { executable: managedExecutable, directory: join(directory, 'managed-opencode-data'), configFile: managedConfigPath, port: await availablePort(), startupTimeoutMs: 5000, stopTimeoutMs: 2000 } }))
  const managedChild = child(managedAgentConfig, 'Bearer managed', { TEAMS_PROVIDER_TEST_CREDENTIAL: 'provider-catalog',
    TEAMS_LOCAL_CONFIG_PATH: managedConfigPath, TEAMS_LOCAL_INTERNAL_PATH: managedInternalPath,
    TEAMS_LOCAL_LAUNCHER_GENERATION: '1', TEAMS_LOCAL_START_TOKEN: 'managed-test' })
  expect(await managedChild.ready).toMatchObject({ agentId: 'managed' })
  const managedConsole = createRelayConsoleClient(consumer, 'managed', 8000)
  expect(await managedConsole.command({ kind: 'config.refreshModels', agentId: 'managed', expectedRevision: 3, providerId: 'catalog' })).toEqual({ ok: true })
  expect((await managedConsole.readProjection()).configs[0]).toMatchObject({ acceptedRevision: 3,
    providers: expect.arrayContaining([expect.objectContaining({ id: 'catalog', catalogState: 'ready', models: [{ id: 'catalog-model' }] })]) })
  expect(catalogAuthSeen).toBe(true)
  expect(await managedConsole.command({ kind: 'config.apply', agentId: 'managed' })).toEqual({ ok: true })
  expect((await managedConsole.readProjection()).configs[0]).toMatchObject({ acceptedRevision: 3, effectiveRevision: 3 })
  managedChild.process.kill('SIGTERM')
  expect((await managedChild.exited).code).toBe(0)
  await new Promise<void>(resolve => catalogServer.close(() => resolve()))

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

it('projects an Agent with an accepted model binding but no openCode launch block as session capable', async () => {
  const localRelay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key: readFileSync(join(directory, 'key.pem')),
    maxPayload: 65536, maxConnections: 8, maxGrants: 4, maxBufferedAmount: 65536, maxPendingMessages: 8, maxPendingBytes: 131072, grantTtlMs: 5000,
    authenticate: credential => (credential === 'Bearer binding-consumer' || credential === 'Bearer binding-only')
      ? { accountId: 'account', scopeId: 'scope', agentId: credential.slice(7) } : null })
  const bindingConsumer = await createRelayClient({ transport: { endpoint: localRelay.url, credential: 'Bearer binding-consumer', ca: cert, connectTimeoutMs: 1000,
    maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 8 },
    declaration: { identity: { hostId: 'binding-consumer', machineId: 'test', agentId: 'binding-consumer', accountId: 'account', agentKind: 'custom', label: 'Consumer' },
      scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
    admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxPendingRequests: 8, maxDataConnections: 8 })
  const root = join(directory, 'binding-only')
  mkdirSync(root, { recursive: true })
  const bindingConfigPath = join(root, 'config.toml')
  writeFileSync(bindingConfigPath, [
    'version = 3',
    '',
    '[providers.probe]',
    'protocol = "openai-chat"',
    'apiBaseUrl = "http://127.0.0.1:1/v1"',
    'label = "Probe"',
    'enabled = true',
    '',
    '[[models]]',
    'provider = "probe"',
    'id = "probe-model"',
    '',
    '[agents.binding-only.model]',
    'primary = { provider = "probe", model = "probe-model" }',
    '',
  ].join('\n'))
  const bindingInternalPath = join(root, 'internal.toml')
  writeFileSync(bindingInternalPath, 'version = 2\n')
  const bindingAgentConfig = join(root, 'agent.json')
  writeFileSync(bindingAgentConfig, JSON.stringify({
    version: 1,
    identity: { hostId: 'binding-only-host', machineId: 'test', agentId: 'binding-only', accountId: 'account', agentKind: 'custom', label: 'Binding Only' },
    scopeId: 'scope', dataDirectory: join(root, 'data'), leasePort: await availablePort(), presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: ['binding-consumer'], allowedManagers: ['binding-consumer'] },
    cli: { camoExecutable: '/opt/homebrew/bin/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: root, profilePrefix: 'teams-binding-test' },
    relay: { endpoint: localRelay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000,
      admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
  }))
  try {
    const bindingChild = child(bindingAgentConfig, 'Bearer binding-only', { TEAMS_LOCAL_CONFIG_PATH: bindingConfigPath, TEAMS_LOCAL_INTERNAL_PATH: bindingInternalPath })
    expect(await bindingChild.ready).toMatchObject({ agentId: 'binding-only' })
    const projection = await createRelayConsoleClient(bindingConsumer, 'binding-only', 8000).readProjection()
    expect(projection.agents[0]).toMatchObject({ sessionCapable: true, sessionAvailability: 'no-current' })
    bindingChild.process.kill('SIGTERM')
    expect((await bindingChild.exited).code).toBe(0)
  } finally {
    await bindingConsumer.close()
    await localRelay.close()
  }
}, 15000)

it('creates and closes an explicitly configured direct listener with the Agent process', async () => {
  const localRelay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key: readFileSync(join(directory, 'key.pem')),
    maxPayload: 65536, maxConnections: 4, maxGrants: 4, maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072,
    grantTtlMs: 5000, authenticate: credential => credential === 'Bearer direct-process'
      ? { accountId: 'account', scopeId: 'scope', agentId: 'direct-process' } : null })
  const directPort = await availablePort()
  const configPath = join(directory, 'direct-process.json')
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    identity: { hostId: 'direct-process-host', machineId: 'test', agentId: 'direct-process', accountId: 'account', agentKind: 'custom', label: 'Direct Process' },
    scopeId: 'scope', dataDirectory: './direct-process-data', leasePort: await availablePort(), presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: ['consumer-a'], allowedManagers: [] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: './search', profilePrefix: 'teams-direct-process' },
    endpoint: { role: 'provider', services: [searchService] },
    relay: { endpoint: localRelay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: './cert.pem', connectTimeoutMs: 1000,
      admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536,
      maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
    directListener: { host: '127.0.0.1', port: directPort, keyFile: './key.pem', certFile: './cert.pem', credentialEnv: 'TEAMS_DIRECT_AUTH',
      target: { hostId: 'direct-process-host', agentId: 'direct-process', protocolVersion: 1, capabilitiesRevision: 'direct-cap-1' },
      maxPayload: 65536, maxConnections: 4, maxMessageBytes: 4096, maxBufferedBytes: 8192, maxPendingFrames: 4, helloTimeoutMs: 1000 },
  }))
  let firstProcess: Awaited<ReturnType<typeof startAgentProcess>> | undefined
  let secondProcess: Awaited<ReturnType<typeof startAgentProcess>> | undefined
  let firstTarget: Awaited<ReturnType<typeof connectDirectWssTarget>> | undefined
  let secondTarget: Awaited<ReturnType<typeof connectDirectWssTarget>> | undefined
  const connect = (generation: number) => {
    const endpoint = `wss://127.0.0.1:${directPort}`
    const hello = { hostId: 'direct-process-host', agentId: 'direct-process', targetGeneration: generation, protocolVersion: 1, capabilitiesRevision: 'direct-cap-1', source: { accountId: 'account', scopeId: 'scope', agentId: 'consumer-a' }, admissionRef: 'direct:consumer-a' }
    return connectDirectWssTarget({
      transport: { endpoint, credential: 'Bearer direct-listener', ca: cert, connectTimeoutMs: 1000, maxMessageBytes: 4096, maxBufferedBytes: 8192, maxPendingFrames: 4 },
      hello, helloTimeoutMs: 1000,
      plan: buildDirectWssRoutePlan({ hostId: hello.hostId, directoryGeneration: 1, policy: 'manual', targetCandidateId: 'direct', candidates: [
        { candidateId: 'direct', kind: 'lan', endpoint, port: directPort, authRequired: true, lastSeenAt: new Date().toISOString() },
      ] }),
    })
  }
  try {
    firstProcess = await startAgentProcess(configPath, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer direct-process', TEAMS_DIRECT_AUTH: 'Bearer direct-listener' })
    expect(firstProcess.daemon.network.generation).toBe(1)
    const firstProvider = (await firstProcess.daemon.network.directory(false)).find(peer => peer.declaration.identity.agentId === 'direct-process')
    expect(firstProvider?.declaration.revision).toBe(2)
    expect(firstProvider?.declaration.routes).toHaveLength(1)
    expect(firstProvider?.declaration.routes[0]).toMatchObject({
      candidateId: 'direct',
      kind: 'lan',
      endpoint: `wss://127.0.0.1:${directPort}`,
      port: directPort,
      authRequired: true,
      lastSeenAt: expect.any(String),
    })
    expect(JSON.stringify(firstProvider?.declaration)).not.toContain('Bearer direct-listener')
    firstTarget = await connect(1)
    await firstProcess.stop()
    await expect(firstTarget.closed).resolves.toMatchObject({ code: 'UNAVAILABLE' })

    secondProcess = await startAgentProcess(configPath, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer direct-process', TEAMS_DIRECT_AUTH: 'Bearer direct-listener' })
    expect(secondProcess.daemon.network.generation).toBe(2)
    const secondProvider = (await secondProcess.daemon.network.directory(false)).find(peer => peer.declaration.identity.agentId === 'direct-process')
    expect(secondProvider?.declaration.revision).toBe(2)
    expect(secondProvider?.declaration.routes).toHaveLength(1)
    expect(secondProvider?.declaration.routes[0]).toMatchObject({
      candidateId: 'direct',
      kind: 'lan',
      endpoint: `wss://127.0.0.1:${directPort}`,
      port: directPort,
      authRequired: true,
      lastSeenAt: expect.any(String),
    })
    secondTarget = await connect(2)
    await expect(connect(1)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    await secondProcess.stop()
    await expect(secondTarget.closed).resolves.toMatchObject({ code: 'UNAVAILABLE' })
  } finally {
    await firstTarget?.close().catch(() => undefined)
    await secondTarget?.close().catch(() => undefined)
    await firstProcess?.stop().catch(() => undefined)
    await secondProcess?.stop().catch(() => undefined)
    await localRelay.close()
  }
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
    dataDirectory: './provider-data', leasePort: await availablePort(), policy: { revision: 1, allowedConsumers: ['consumer2'], allowedManagers: [] },
    endpoint: { role: 'provider', services: [searchService] } }))
  writeFileSync(consumerConfig, JSON.stringify({ ...base,
    identity: { hostId: 'consumer-host-2', machineId: 'test', agentId: 'consumer2', accountId: 'account', agentKind: 'custom', label: 'Consumer 2' },
    dataDirectory: './consumer-data', leasePort: await availablePort(),
    cli: { ...base.cli, searchRoot: './consumer-files', profilePrefix: 'teams-cross-consumer' },
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    endpoint: { role: 'provider', services: [] } }))
  mkdirSync(join(root, 'consumer-files'), { recursive: true })
  let provider: Awaited<ReturnType<typeof startAgentProcess>> | undefined
  let consumerAgent: Awaited<ReturnType<typeof startAgentProcess>> | undefined
  try {
    provider = await startAgentProcess(providerConfig, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer provider2' })
    consumerAgent = await startAgentProcess(consumerConfig, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer consumer2' })
    const target = await consumerAgent.consumerWork.findProvider({ capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' })
    expect(target.providerAgentId).toBe('provider2')
    const channel = await consumerAgent.consumerWork.open(target)
    try {
      await expect(channel.propose({ workId: 'direct-work', capabilityId: target.capabilityId, capabilityVersion: target.capabilityVersion,
        policyRevision: 1 })).resolves.toMatchObject({ state: 'accepted' })
      const request = { workId: 'direct-work', requestId: 'direct-request', operation: 'search',
        demands: [{ resourceId: 'search-slot', amount: 1 }], payload: { query: 'direct daemon work needle' } } as const
      await expect(channel.request(request)).resolves.toMatchObject({ control: { state: 'succeeded' }, payload: { matches: [expect.objectContaining({ text: 'direct daemon work needle\n' })] } })
      await expect(channel.request(request)).resolves.toMatchObject({ control: { state: 'succeeded' } })
      await expect(channel.request({ ...request, requestId: 'direct-no-match', payload: { query: 'absent needle' } })).resolves.toMatchObject({
        control: { state: 'succeeded' }, payload: { status: 'no_match', matches: [] } })
      await expect(channel.request({ ...request, requestId: 'direct-invalid', payload: {} })).resolves.toMatchObject({
        control: { state: 'failed', error: { code: 'INVALID_INPUT' } } })
      await expect(channel.close('direct-work')).resolves.toMatchObject({ state: 'closed' })
    } finally { await channel.dispose() }
  } finally {
    await consumerAgent?.stop()
    await provider?.stop()
  }
}, 15000)

it('boots a receiver-only Agent with declared services without local CLI initialization', async () => {
  const root = join(directory, 'receiver-declared-services')
  mkdirSync(root, { recursive: true })
  const localRelay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key: readFileSync(join(directory, 'key.pem')),
    maxPayload: 65536, maxConnections: 4, maxGrants: 4, maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072,
    grantTtlMs: 5000, authenticate: credential => credential === 'Bearer receiver-only'
      ? { accountId: 'account', scopeId: 'scope', agentId: 'receiver-only' } : null })
  const configPath = join(root, 'receiver.json')
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    identity: { hostId: 'receiver-only-host', machineId: 'test', agentId: 'receiver-only', accountId: 'account', agentKind: 'custom', label: 'Receiver Only' },
    scopeId: 'scope', dataDirectory: './receiver-data', leasePort: await availablePort(), presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/missing/rg', searchRoot: join(root, 'missing-root'), profilePrefix: 'teams-receiver-only' },
    endpoint: {
      role: 'receiver',
      connect: { targetAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', operation: 'search', demands: [{ resourceId: 'search-slot', amount: 1 }] },
      services: [searchService],
    },
    relay: { endpoint: localRelay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
  }))
  let receiver: Awaited<ReturnType<typeof startAgentProcess>> | undefined
  try {
    receiver = await startAgentProcess(configPath, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer receiver-only' })
    const published = (await receiver.daemon.network.directory(false)).find(peer => peer.declaration.identity.agentId === 'receiver-only')
    expect(published?.declaration.capabilities).toEqual([])
    expect(receiver.statusProjection().capabilities).toEqual([])
  } finally {
    await receiver?.stop()
    await localRelay.close()
  }
}, 15000)

it('keeps Work identity and the fixed binding when receiver execution throws', async () => {
  const frame = {
    kind: 'work.open',
    requestId: 'req-throw',
    control: {
      receiverAgentId: 'receiver', expectedLauncherGeneration: 3, startToken: 'token',
      executionId: 'exec-throw', attemptId: 'attempt-throw', workId: 'work-throw', requestId: 'req-throw',
      targetAgentId: 'provider', targetGeneration: 9, capabilityId: 'browser', capabilityVersion: '1',
      operation: 'context.create', demands: browserDemands, policyRevision: 1,
    },
    business: {},
  } as unknown as LocalWorkControlRequest
  const request = {
    kind: 'work.control', localCorrelation: 'corr-throw', receiverAgentId: 'receiver',
    expectedLauncherGeneration: 3, expectedAgentGeneration: 9, frame,
  } as unknown as Parameters<typeof resolveWorkChildReply>[1]
  const handle = {
    daemon: { status: () => ({ agentId: 'receiver' }), network: { generation: 9 } },
    executeWork: async () => { throw Object.assign(new Error('runner result lacks output ARC'), { code: 'HOST_PROTOCOL' }) },
  } as unknown as Parameters<typeof resolveWorkChildReply>[0]
  const reply = await resolveWorkChildReply(handle, request)
  expect(reply.kind).toBe('work.result')
  if (reply.kind !== 'work.result') throw new Error('expected a typed Work result receipt')
  expect(reply.receipt.status).toBe('failed')
  // The caller keeps everything it needs to query or close the Work with the
  // original identity after a post-dispatch failure.
  expect(reply.receipt.control).toMatchObject({
    executionId: 'exec-throw', attemptId: 'attempt-throw', workId: 'work-throw', requestId: 'req-throw',
    providerAgentId: 'provider', targetGeneration: 9, capabilityId: 'browser', capabilityVersion: '1',
    operation: 'context.create', deliveryState: 'unconfirmed',
    error: { code: 'HOST_PROTOCOL', message: 'runner result lacks output ARC' },
  })
})

it('refuses a Work frame for another receiver identity before dispatch', async () => {
  const frame = { kind: 'work.open', requestId: 'req-other', control: {}, business: {} } as unknown as LocalWorkControlRequest
  const request = {
    kind: 'work.control', localCorrelation: 'corr-other', receiverAgentId: 'someone-else',
    expectedLauncherGeneration: 3, expectedAgentGeneration: 9, frame,
  } as unknown as Parameters<typeof resolveWorkChildReply>[1]
  const handle = {
    daemon: { status: () => ({ agentId: 'receiver' }), network: { generation: 9 } },
    executeWork: async () => { throw new Error('execution must not run for another receiver identity') },
  } as unknown as Parameters<typeof resolveWorkChildReply>[0]
  const reply = await resolveWorkChildReply(handle, request)
  expect(reply).toEqual({ kind: 'work.error', requestId: 'req-other', error: { code: 'RECEIVER_NOT_FOUND', message: 'Work request reached a different receiver identity' } })
})

it('persists unknown state before refusing a restart with active Work', async () => {
  const root = join(directory, 'recovery')
  mkdirSync(join(root, 'files'), { recursive: true })
  writeFileSync(join(root, 'files', 'active.txt'), 'active work\n')
  const dataDirectory = join(root, 'data')
  const workFile = join(dataDirectory, 'work.json')
  const executor = createCliWorkExecutor({ camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg',
    searchRoot: join(root, 'files'), profilePrefix: 'teams-recovery', services: [searchService] })
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
    endpoint: { role: 'provider', services: [searchService] },
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 } }))
  const restarted = child(configPath, 'Bearer provider2')
  await expect(restarted.ready).rejects.toThrow(/persisted resources require trusted reconciliation/)
  expect((await restarted.exited).code).toBe(1)
  const recovered = JSON.parse(readFileSync(workFile, 'utf8')) as { requests: Array<{ state: string }>; allocations: Array<{ state: string }> }
  expect(recovered.requests[0]?.state).toBe('unknown')
  expect(recovered.allocations[0]?.state).toBe('unknown')
}, 15000)

it('recovers a stale work lock only after the previous daemon lease is reacquired', async () => {
  const root = join(directory, 'stale-lock')
  const dataDirectory = join(root, 'data')
  mkdirSync(dataDirectory, { recursive: true })
  const leasePort = await availablePort()
  const previousOwner = { version: 1, pid: 987654, startToken: 'previous-daemon-token', leasePort }
  writeFileSync(join(dataDirectory, 'runtime-owner.json'), `${JSON.stringify(previousOwner)}\n`)
  writeFileSync(join(dataDirectory, 'work.json.lock'), `${JSON.stringify({ version: 1, ownerPid: previousOwner.pid, ownerStartToken: previousOwner.startToken, lockToken: 'stale-lock-token' })}\n`)
  const configPath = join(root, 'agent.json')
  writeFileSync(configPath, JSON.stringify({ version: 1,
    identity: { hostId: 'stale-lock-host', machineId: 'test', agentId: 'stale-lock-agent', accountId: 'account', agentKind: 'custom', label: 'Stale Lock Agent' },
    scopeId: 'scope', dataDirectory, leasePort, presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: root, profilePrefix: 'teams-stale-lock' },
    endpoint: { role: 'provider', services: [searchService] },
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 } }))
  const process = child(configPath, 'Bearer stale-lock-agent')
  expect(await process.ready).toMatchObject({ agentId: 'stale-lock-agent' })
  expect(existsSync(join(dataDirectory, 'work.json.lock'))).toBe(false)
  process.process.kill('SIGTERM')
  expect((await process.exited).code).toBe(0)
  expect(existsSync(join(dataDirectory, 'runtime-owner.json'))).toBe(false)
}, 15000)

it('runs real persistent Camo browser Work through current SDK graphs and restores capacity', async () => {
  const root = join(directory, 'camo-dagpipe')
  mkdirSync(join(root, 'files'), { recursive: true })
  const page = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html><body><h1>camo-needle-dagpipe</h1></body></html>')
  })
  await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve))
  const pageAddress = page.address()
  if (!pageAddress || typeof pageAddress === 'string') throw new Error('page port missing')
  const url = `http://127.0.0.1:${pageAddress.port}/`
  const profilePrefix = `teams-camo-u3-dagpipe-${Date.now().toString(36)}`
  const ids = ['camo-provider', 'camo-consumer-1', 'camo-consumer-2', 'camo-consumer-3']
  const localRelay = await createRelayServer({
    host: '127.0.0.1',
    port: 0,
    key: readFileSync(join(directory, 'key.pem')),
    cert,
    maxPayload: 65536,
    maxConnections: 16,
    maxGrants: 8,
    maxBufferedAmount: 65536,
    maxPendingMessages: 16,
    maxPendingBytes: 131072,
    grantTtlMs: 5000,
    authenticate: credential => credential?.startsWith('Bearer ') && ids.includes(credential.slice(7))
      ? { accountId: 'account', scopeId: 'scope', agentId: credential.slice(7) }
      : null,
  })
  const relayBlock = {
    endpoint: localRelay.url,
    credentialEnv: 'TEAMS_AGENT_TEST_AUTH',
    caFile: join(directory, 'cert.pem'),
    connectTimeoutMs: 1000,
    admissionTimeoutMs: 1000,
    requestTimeoutMs: 60000,
    maxMessageBytes: 65536,
    maxBufferedBytes: 65536,
    maxPendingFrames: 16,
    maxPendingRequests: 8,
    maxDataConnections: 8,
  }
  const providerConfig = join(root, 'provider.json')
  writeFileSync(providerConfig, JSON.stringify({
    version: 1,
    scopeId: 'scope',
    presenceIntervalMs: 1000,
    identity: { hostId: 'camo-provider-host', machineId: 'test', agentId: 'camo-provider', accountId: 'account', agentKind: 'custom', label: 'Camo Provider' },
    dataDirectory: './provider-data',
    leasePort: await availablePort(),
    policy: { revision: 1, allowedConsumers: ['camo-consumer-1', 'camo-consumer-2', 'camo-consumer-3'], allowedManagers: [] },
    cli: { camoExecutable: '/opt/homebrew/bin/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: './files', profilePrefix },
    endpoint: { role: 'provider', services: [browserService] },
    relay: relayBlock,
  }))
  const consumerConfig = async (id: string) => {
    const path = join(root, `${id}.json`)
    writeFileSync(path, JSON.stringify({
      version: 1,
      scopeId: 'scope',
      presenceIntervalMs: 1000,
      identity: { hostId: `${id}-host`, machineId: 'test', agentId: id, accountId: 'account', agentKind: 'custom', label: id },
      dataDirectory: `./${id}-data`,
      leasePort: await availablePort(),
      policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
      cli: { camoExecutable: '/missing/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: './files', profilePrefix: `teams-${id}` },
      endpoint: { role: 'provider', services: [] },
      relay: relayBlock,
    }))
    return path
  }
  const built = await buildRunner()
  const runnerPath = built.runnerPath
  const projectId = 'agentteams-u3-browser-dagpipe'
  const generationPromise = (agent: Awaited<ReturnType<typeof startAgentProcess>>) => agent.daemon.network.generation
  const openIntent = (agentId: string, targetGeneration: number, workId: string, requestId: string, business: unknown): WorkOpenIntentControl => ({
    receiverAgentId: agentId,
    targetAgentId: 'camo-provider',
    targetGeneration,
    serviceSelection: 'capability',
    capabilityId: 'browser',
    capabilityVersion: '1',
    operation: 'context.create',
    workId,
    requestId,
    policyRevision: 1,
    demands: browserDemands,
  })
  const requestIntent = (agentId: string, targetGeneration: number, workId: string, requestId: string, operation: string, business: unknown): WorkRequestIntentControl => ({
    receiverAgentId: agentId,
    targetAgentId: 'camo-provider',
    targetGeneration,
    serviceSelection: 'capability',
    capabilityId: 'browser',
    capabilityVersion: '1',
    operation,
    workId,
    requestId,
    policyRevision: 1,
    demands: browserDemands,
  })
  const closeIntent = (agentId: string, targetGeneration: number, workId: string): WorkCloseIntentControl => ({
    receiverAgentId: agentId,
    targetAgentId: 'camo-provider',
    targetGeneration,
    serviceSelection: 'capability',
    capabilityId: 'browser',
    capabilityVersion: '1',
    operation: 'context.create',
    workId,
  })
  const agents: Awaited<ReturnType<typeof startAgentProcess>>[] = []
  const camoReceipts: Record<string, unknown> = {}
  try {
    const provider = await startAgentProcess(providerConfig, { ...process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer camo-provider' })
    agents.push(provider)
    const targetGeneration = generationPromise(provider)
    const consumerIds = ['camo-consumer-1', 'camo-consumer-2', 'camo-consumer-3']
    const consumers: Awaited<ReturnType<typeof startAgentProcess>>[] = []
    for (const id of consumerIds) consumers.push(await startAgentProcess(await consumerConfig(id), { ...process.env, TEAMS_AGENT_TEST_AUTH: `Bearer ${id}` }))
    agents.push(...consumers)

    const openWork = async (consumer: Awaited<ReturnType<typeof startAgentProcess>>, id: string, workId: string, requestId: string, business: unknown) => {
      return runWorkExecution(consumer.consumerWork, {
        runnerPath,
        graphPath: workOpenGraph,
        projectId,
        executionId: `${id}-open`,
        attemptId: '1',
        intent: { control: openIntent(id, targetGeneration, workId, requestId, business), business },
      })
    }
    const firstOpenStart = Date.now()
    const first = await openWork(consumers[0], consumerIds[0], 'browser-work-1', 'browser-open-1', { initialUrl: url })
    const firstContextId = (first.business as { contextId?: string } | undefined)?.contextId
    expect(firstContextId).toMatch(/^browser-context-/)
    expect(first.control).toMatchObject({ workClosure: 'retained', requestState: 'succeeded', providerAgentId: 'camo-provider', targetGeneration })
    expect(first.cleanup).toEqual({ channelsOpened: 1, channelsDisposed: 1 })
    const firstContextFingerprint = createHash('sha256').update(JSON.stringify(['camo-provider', 'browser-work-1'])).digest('hex')
    const firstProfile = `${profilePrefix}-${firstContextFingerprint}`
    camoReceipts['first-context'] = { contextId: firstContextId, profile: firstProfile }
    const firstCreateMs = Date.now() - firstOpenStart
    camoReceipts['first-open-ms'] = firstCreateMs

    const second = await openWork(consumers[1], consumerIds[1], 'browser-work-2', 'browser-open-2', { initialUrl: url })
    const secondContextId = (second.business as { contextId?: string } | undefined)?.contextId
    expect(secondContextId).toMatch(/^browser-context-/)
    expect(secondContextId).not.toBe(firstContextId)
    expect(second.control).toMatchObject({ workClosure: 'retained', requestState: 'succeeded' })
    camoReceipts['second-context'] = secondContextId

    const third = await openWork(consumers[2], consumerIds[2], 'browser-work-3', 'browser-open-3', { initialUrl: url })
    expect(third.control).toMatchObject({ requestState: 'failed', workClosure: 'retained' })
    expect(third.business).toBeUndefined()
    camoReceipts['third-denial'] = third.control

    // The real create can exceed the default 5000 ms Relay admission deadline.
    // If it did not, hold the admitted Work past that deadline before the next request.
    if (firstCreateMs < 5200) await new Promise(resolveDelay => setTimeout(resolveDelay, 5200 - firstCreateMs))
    camoReceipts['held-beyond-grant-deadline-ms'] = Math.max(firstCreateMs, 5200)

    const navigate = async (consumer: Awaited<ReturnType<typeof startAgentProcess>>, id: string, workId: string, requestId: string, business: unknown) => {
      return runWorkExecution(consumer.consumerWork, {
        runnerPath,
        graphPath: workRequestGraph,
        projectId,
        executionId: `${id}-${requestId}`,
        attemptId: '1',
        intent: { control: requestIntent(id, targetGeneration, workId, requestId, 'navigate', business), business },
      })
    }
    const navigated = await navigate(consumers[0], consumerIds[0], 'browser-work-1', 'browser-nav-1', { contextId: firstContextId, url })
    expect(navigated.control).toMatchObject({ requestState: 'succeeded', workClosure: 'retained' })
    expect(navigated.business).toMatchObject({ contextId: firstContextId, navigated: true })

    const snapshotted = await runWorkExecution(consumers[0].consumerWork, {
      runnerPath,
      graphPath: workRequestGraph,
      projectId,
      executionId: 'camo-consumer-1-snapshot',
      attemptId: '1',
      intent: { control: requestIntent(consumerIds[0], targetGeneration, 'browser-work-1', 'browser-snapshot-1', 'snapshot', { contextId: firstContextId }), business: { contextId: firstContextId } },
    })
    expect(snapshotted.control).toMatchObject({ requestState: 'succeeded', workClosure: 'retained' })
    expect(snapshotted.business).toMatchObject({
      contextId: firstContextId,
      url,
      html: '<html><head></head><body><h1>camo-needle-dagpipe</h1></body></html>',
    })
    expect(snapshotted.business.html).toEqual('<html><head></head><body><h1>camo-needle-dagpipe</h1></body></html>')
    camoReceipts['snapshot'] = snapshotted.business

    const destroyed = await runWorkExecution(consumers[0].consumerWork, {
      runnerPath,
      graphPath: workRequestGraph,
      projectId,
      executionId: 'camo-consumer-1-destroy',
      attemptId: '1',
      intent: { control: requestIntent(consumerIds[0], targetGeneration, 'browser-work-1', 'browser-destroy-1', 'context.destroy', { contextId: firstContextId }), business: { contextId: firstContextId } },
    })
    expect(destroyed.control).toMatchObject({ requestState: 'succeeded', workClosure: 'retained' })
    expect(destroyed.business).toMatchObject({ contextId: firstContextId, profile: firstProfile, state: 'stopped' })
    camoReceipts['destroy'] = destroyed.business

    const closedFirst = await runWorkExecution(consumers[0].consumerWork, {
      runnerPath,
      graphPath: workCloseGraph,
      projectId,
      executionId: 'camo-consumer-1-close',
      attemptId: '1',
      intent: { control: closeIntent(consumerIds[0], targetGeneration, 'browser-work-1') },
    })
    expect(closedFirst.control).toMatchObject({ workClosure: 'closed' })
    expect(closedFirst.control.requestState).toBeUndefined()
    camoReceipts['first-close'] = closedFirst.control

    const retriedThird = await runWorkExecution(consumers[2].consumerWork, {
      runnerPath,
      graphPath: workRequestGraph,
      projectId,
      executionId: 'camo-consumer-3-retry',
      attemptId: '1',
      intent: { control: requestIntent(consumerIds[2], targetGeneration, 'browser-work-3', 'browser-create-3-retry', 'context.create', { initialUrl: url }), business: { initialUrl: url } },
    })
    expect(retriedThird.control).toMatchObject({ requestState: 'succeeded', workClosure: 'retained' })
    const retriedThirdContextId = (retriedThird.business as { contextId?: string } | undefined)?.contextId
    expect(retriedThirdContextId).toMatch(/^browser-context-/)
    expect(retriedThirdContextId).not.toBe(firstContextId)
    expect(retriedThirdContextId).not.toBe(secondContextId)
    camoReceipts['retried-third'] = retriedThird.control

    const closedSecond = await runWorkExecution(consumers[1].consumerWork, {
      runnerPath,
      graphPath: workCloseGraph,
      projectId,
      executionId: 'camo-consumer-2-close',
      attemptId: '1',
      intent: { control: closeIntent(consumerIds[1], targetGeneration, 'browser-work-2') },
    })
    const closedThird = await runWorkExecution(consumers[2].consumerWork, {
      runnerPath,
      graphPath: workCloseGraph,
      projectId,
      executionId: 'camo-consumer-3-close',
      attemptId: '1',
      intent: { control: closeIntent(consumerIds[2], targetGeneration, 'browser-work-3') },
    })
    expect(closedSecond.control).toMatchObject({ workClosure: 'closed' })
    expect(closedThird.control).toMatchObject({ workClosure: 'closed' })
  } finally {
    for (const agent of agents.reverse()) await agent.stop().catch(() => undefined)
    await new Promise<void>(resolveClose => page.close(() => resolveClose()))
    await localRelay.close()
  }
}, 300000)

// Pure Session-owner tests: no socket, no second child. They exercise the same
// `createSessionHost` the daemon wires, through a fake owner port and fake adapter.
function sessionEventChannel() {
  const queue: OpenCodeSdkEvent[] = []
  let pending: ((result: IteratorResult<OpenCodeSdkEvent>) => void) | undefined
  let ended = false
  const stream: AsyncGenerator<OpenCodeSdkEvent> = {
    [Symbol.asyncIterator]() { return this },
    next: () => {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
      if (ended) return Promise.resolve({ value: undefined, done: true })
      return new Promise(resolve => { pending = resolve })
    },
    return: () => { ended = true; pending?.({ value: undefined, done: true }); return Promise.resolve({ value: undefined, done: true }) },
    throw: () => Promise.resolve({ value: undefined, done: true }),
  }
  return {
    stream,
    push(event: OpenCodeSdkEvent) {
      if (pending) { const resolve = pending; pending = undefined; resolve({ value: event, done: false }) }
      else queue.push(event)
    },
    end() { ended = true; pending?.({ value: undefined, done: true }) },
  }
}

function sessionHarness(options: { holdPrompt?: boolean; abortAccepted?: boolean | undefined; abortResponse?: 'absent'; getError?: OpenCodeAdapterError; promptError?: OpenCodeAdapterError; bindPrompt?: boolean; abortHold?: boolean; readiness?: ManagedRuntimeReadiness; useError?: RuntimeConfigError } = {}) {
  let channel = sessionEventChannel()
  let subscriptions = 0
  const prompts: { sessionId: string; text: string; messageId?: string }[] = []
  const pendingPrompts: (() => void)[] = []
  let abortCalls = 0
  const client: OpenCodeSessionClient & OpenCodeEventClient = {
    session: {
      list: async () => ({ data: [] }),
      get: async ({ path }) => {
        if (options.getError) throw options.getError
        return { data: { id: path.id, title: 'Existing' } }
      },
      create: async () => ({ data: { id: 'created-1', title: 'New' } }),
      prompt: async ({ path, body }) => {
        prompts.push({ sessionId: path.id, text: body.parts[0].text, messageId: body.messageID })
        if (options.promptError) throw options.promptError
        if (options.holdPrompt) await new Promise<void>(resolve => { pendingPrompts.push(resolve) })
        if (options.bindPrompt) return { data: { info: { id: 'assistant-sync', sessionID: path.id, parentID: body.messageID }, parts: [] } }
        return { data: {} }
      },
      abort: async () => {
        abortCalls += 1
        if (options.abortHold) await new Promise<void>(resolve => { pendingPrompts.push(resolve) })
        return options.abortResponse === 'absent' ? { data: undefined } : { data: options.abortAccepted ?? true }
      },
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: {} }),
    event: { subscribe: async () => {
      subscriptions += 1
      if (subscriptions > 1) channel = sessionEventChannel()
      return { data: { stream: channel.stream } }
    } },
  }
  let handle: ManagedEffectiveHandle = { url: 'http://127.0.0.1:1', authorization: 'Bearer x', effectiveRevision: 3, modelTarget: { providerID: 'p', modelID: 'm' } }
  let uncertain = false
  const currentReadiness = (): ManagedRuntimeReadiness => options.readiness
    ?? (uncertain ? { state: 'uncertain', effectiveRevision: handle.effectiveRevision } : { state: 'current', effectiveRevision: handle.effectiveRevision, modelTarget: handle.modelTarget, activeOperations: 0 })
  const owner = {
    readiness: currentReadiness,
    currentHandle: () => handle,
    use: async <T>(operation: (handle: ManagedEffectiveHandle) => Promise<T>): Promise<T> => {
      if (currentReadiness().state !== 'current') throw new RuntimeConfigError({ code: 'UNAVAILABLE', message: 'Managed runtime is not available' })
      if (options.useError) throw options.useError
      try { return await operation(handle) } catch (error) { uncertain = true; throw error }
    },
  }
  const host = createSessionHost({ agentId: 'agent', generation: () => 7, owner, createClient: () => client })
  return {
    host,
    get channel() { return channel },
    prompts,
    abortCalls: () => abortCalls,
    subscriptions: () => subscriptions,
    replaceHandle: (next: ManagedEffectiveHandle) => { handle = next },
    isUncertain: () => uncertain,
    releasePrompt: () => { for (const resolve of pendingPrompts.splice(0)) resolve() },
  }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('Session host admission, cancel causality and observation', () => {
  it('maps capability and readiness without an openCode field', () => {
    const base = { agentId: 'a', machineId: 'm', label: 'A', presence: 'online' as const, capabilities: ['x'] }
    expect(projectRuntimeAgentRow({ ...base, sessionCapable: false })).toEqual({ ...base, kind: 'runtime', sessionCapable: false, sessionAvailability: 'not-applicable' })
    expect(projectRuntimeAgentRow({ ...base, sessionCapable: true, readiness: { state: 'no-current' } }))
      .toEqual({ ...base, kind: 'runtime', sessionCapable: true, sessionAvailability: 'no-current' })
    const current = projectRuntimeAgentRow({ ...base, sessionCapable: true,
      readiness: { state: 'current', effectiveRevision: 4, modelTarget: { providerID: 'p', modelID: 'm' }, activeOperations: 0 },
      observation: { state: 'degraded', reason: 'projection-loss', detail: 'dropped', droppedEvents: 1 } })
    expect(current).toMatchObject({ sessionAvailability: 'current', sessionEffectiveRevision: 4, providerId: 'p', modelId: 'm', sessionObservation: { state: 'degraded' } })
    // Observation degradation never rewrites availability.
    expect(current).toMatchObject({ sessionAvailability: 'current' })
  })

  it('projects the current owner session into Console projection rows', async () => {
    const h = sessionHarness()
    expect(h.host.projectionSessions()).toEqual([])
    expect(await h.host.createSession('New')).toMatchObject({ ok: true })
    expect(h.host.projectionSessions()).toEqual([{ agentId: 'agent', sessionId: 'created-1', title: 'New' }])
    expect(await h.host.openSession('existing-1')).toEqual({ ok: true })
    expect(h.host.projectionSessions()).toEqual([{ agentId: 'agent', sessionId: 'existing-1', title: 'Existing' }])
    await h.host.dispose()
  })

  it('claims the first prompt before dispatch and conflicts the second for one session', async () => {
    const h = sessionHarness({ holdPrompt: true })
    const first = h.host.sendSession('s1', { text: 'hi' })
    expect(h.prompts).toHaveLength(1)
    const second = await h.host.sendSession('s1', { text: 'again' })
    expect(second).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(h.prompts).toHaveLength(1)
    const other = h.host.sendSession('s2', { text: 'parallel' })
    expect(h.prompts.map(prompt => prompt.sessionId)).toEqual(['s1', 's2'])
    h.releasePrompt()
    await first
    await other
    expect(h.isUncertain()).toBe(false)
  })

  it('keeps the record when a prompt resolves without a trusted assistant binding', async () => {
    const h = sessionHarness()
    expect(await h.host.sendSession('s1', { text: 'hi' })).toMatchObject({ ok: true })
    // The prompt transport returned without proving an assistant identity, so the record
    // stays owned: a second prompt still conflicts and cancel stays unknown instead of
    // aborting a prompt whose assistant message was never bound.
    expect(await h.host.sendSession('s1', { text: 'again' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(h.prompts).toHaveLength(1)
    expect(await h.host.cancelSession('s1')).toMatchObject({ ok: false, error: { code: 'RESULT_UNKNOWN', detail: { reason: 'ambiguous-owner' } } })
    expect(h.abortCalls()).toBe(0)
  })

  it('binds the assistant identity the synchronous prompt response proves', async () => {
    const h = sessionHarness({ bindPrompt: true, abortAccepted: true })
    expect(await h.host.sendSession('s1', { text: 'hi' })).toMatchObject({ ok: true })
    const cancel = h.host.cancelSession('s1')
    await tick()
    expect(h.abortCalls()).toBe(1)
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-sync', role: 'assistant', sessionID: 's1', parentID: h.prompts[0].messageId!, error: { name: 'MessageAbortedError', data: {} } } } })
    expect(await cancel).toMatchObject({ ok: true, result: { reconciliation: 'confirmed', finalState: 'cancelled', messageId: 'assistant-sync' } })
  })

  it('keeps the record when the SDK prompt is reached even for an expected HTTP rejection', async () => {
    const rejected = sessionHarness({ promptError: new OpenCodeAdapterError('session.prompt', 'NOT_FOUND', 'missing session', 404) })
    expect(await rejected.host.sendSession('s1', { text: 'hi' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(rejected.isUncertain()).toBe(false)
    // The SDK prompt call was reached, so the record stays owned even though the server rejected it.
    expect(await rejected.host.sendSession('s1', { text: 'retry' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(rejected.prompts).toHaveLength(1)

    // A failed exchange is not proof that nothing was dispatched, so it propagates and the
    // runtime goes uncertain instead of reopening admission.
    const upstream = sessionHarness({ promptError: new OpenCodeAdapterError('session.prompt', 'UPSTREAM_ERROR', 'boom', 503) })
    await expect(upstream.host.sendSession('s1', { text: 'hi' })).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(upstream.isUncertain()).toBe(true)
    expect(upstream.prompts).toHaveLength(1)
  })

  it('releases the record when prompt validation rejects before the SDK call', async () => {
    const h = sessionHarness()
    expect(await h.host.sendSession('s1', { text: '   ' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(h.prompts).toHaveLength(0)
    expect(await h.host.sendSession('s1', { text: 'retry' })).toMatchObject({ ok: true })
    expect(h.prompts).toHaveLength(1)
  })

  it('returns typed owner refusal for create, open and permission reply', async () => {
    const unavailable = sessionHarness({ readiness: { state: 'no-current' } })
    expect(await unavailable.host.createSession()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(await unavailable.host.openSession('s1')).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(await unavailable.host.replyPermission('s1', 'p1', 'once')).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })

    const changing = sessionHarness({ readiness: { state: 'changing' } })
    expect(await changing.host.createSession()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })

  it('converts a concurrent owner use refusal into a typed result', async () => {
    const h = sessionHarness({ useError: new RuntimeConfigError({ code: 'CONFLICT', message: 'Managed runtime has active operations' }) })
    expect(await h.host.createSession()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await h.host.openSession('s1')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await h.host.replyPermission('s1', 'p1', 'once')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })

  it('keeps cancel unknown without abort until the owned message id is bound', async () => {
    const h = sessionHarness({ holdPrompt: true })
    const prompt = h.host.sendSession('s1', { text: 'hi' })
    const unbound = await h.host.cancelSession('s1')
    expect(unbound).toMatchObject({ ok: false, error: { code: 'RESULT_UNKNOWN', detail: { reason: 'ambiguous-owner' } } })
    expect(unbound).not.toMatchObject({ error: { detail: { baseAccepted: expect.anything() } } })
    expect(h.abortCalls()).toBe(0)
    h.releasePrompt()
    await prompt
  })

  it('confirms cancel only on the unique owned MessageAbortedError and keeps abort=false unknown', async () => {
    const h = sessionHarness({ holdPrompt: true, abortAccepted: true })
    const prompt = h.host.sendSession('s1', { text: 'hi' })
    await tick()
    const requestMessageId = h.prompts[0].messageId!
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: requestMessageId } } })
    await tick()
    const cancel = h.host.cancelSession('s1')
    await tick()
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: requestMessageId, error: { name: 'MessageAbortedError', data: {} } } } })
    expect(await cancel).toMatchObject({ ok: true, result: { reconciliation: 'confirmed', finalState: 'cancelled', messageId: 'assistant-1', errorName: 'MessageAbortedError' } })
    h.releasePrompt()
    await prompt

    const rejected = sessionHarness({ holdPrompt: true, abortAccepted: false })
    const rejectedPrompt = rejected.host.sendSession('s1', { text: 'hi' })
    await tick()
    rejected.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-2', role: 'assistant', sessionID: 's1', parentID: rejected.prompts[0].messageId! } } })
    await tick()
    expect(await rejected.host.cancelSession('s1')).toMatchObject({ ok: false, error: { code: 'RESULT_UNKNOWN', detail: { reason: 'abort-rejected', baseAccepted: false } } })
    rejected.releasePrompt()
    await rejectedPrompt
  })

  it('reconciles a final abort observed before session.abort returns', async () => {
    const h = sessionHarness({ holdPrompt: true, abortHold: true })
    const prompt = h.host.sendSession('s1', { text: 'hi' })
    await tick()
    const requestMessageId = h.prompts[0].messageId!
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: requestMessageId } } })
    await tick()
    const cancel = h.host.cancelSession('s1')
    await tick()
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: requestMessageId, error: { name: 'MessageAbortedError', data: {} } } } })
    await tick()
    h.releasePrompt()
    expect(await cancel).toMatchObject({ ok: true, result: { reconciliation: 'confirmed', finalState: 'cancelled', messageId: 'assistant-1' } })
    h.releasePrompt()
    await prompt
  })

  it('keeps an absent abort response unknown without fabricating baseAccepted=false', async () => {
    const h = sessionHarness({ holdPrompt: true, abortResponse: 'absent' })
    const prompt = h.host.sendSession('s1', { text: 'hi' })
    await tick()
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: h.prompts[0].messageId! } } })
    await tick()
    const cancelled = await h.host.cancelSession('s1')
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'RESULT_UNKNOWN', detail: { reason: 'link-lost' } } })
    expect(cancelled).not.toMatchObject({ error: { detail: { baseAccepted: expect.anything() } } })
    h.releasePrompt()
    await prompt
  })

  it('projects every typed cancel variant into the owning session buffer', async () => {
    const h = sessionHarness({ holdPrompt: true, abortAccepted: true })
    const prompt = h.host.sendSession('s1', { text: 'hi' })
    await tick()
    const requestMessageId = h.prompts[0].messageId!
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: requestMessageId } } })
    await tick()
    const cancel = h.host.cancelSession('s1')
    await tick()
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: requestMessageId, error: { name: 'MessageAbortedError', data: {} } } } })
    await cancel
    expect(h.host.sessionEvents().filter(event => event.kind === 'cancel').map(event => event.state)).toEqual(['accepted', 'reconciled'])
    h.releasePrompt()
    await prompt

    const rejected = sessionHarness({ holdPrompt: true, abortAccepted: false })
    const rejectedPrompt = rejected.host.sendSession('s1', { text: 'hi' })
    await tick()
    rejected.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-2', role: 'assistant', sessionID: 's1', parentID: rejected.prompts[0].messageId! } } })
    await tick()
    await rejected.host.cancelSession('s1')
    expect(rejected.host.sessionEvents().filter(event => event.kind === 'cancel').map(event => event.state)).toEqual(['rejected'])
    rejected.releasePrompt()
    await rejectedPrompt

    const unbound = sessionHarness({ holdPrompt: true })
    const unboundPrompt = unbound.host.sendSession('s1', { text: 'hi' })
    await tick()
    await unbound.host.cancelSession('s1')
    expect(unbound.host.sessionEvents().filter(event => event.kind === 'cancel').map(event => event.state)).toEqual(['unknown'])
    unbound.releasePrompt()
    await unboundPrompt
  })

  it('conflicts a duplicate cancel before a second SDK abort', async () => {
    const h = sessionHarness({ holdPrompt: true, abortAccepted: true })
    const prompt = h.host.sendSession('s1', { text: 'hi' })
    await tick()
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: h.prompts[0].messageId! } } })
    await tick()
    const cancel = h.host.cancelSession('s1')
    await tick()
    expect(await h.host.cancelSession('s1')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(h.abortCalls()).toBe(1)
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: h.prompts[0].messageId!, error: { name: 'MessageAbortedError', data: {} } } } })
    await cancel
    h.releasePrompt()
    await prompt
  })

  it('separates observation degradation from owner readiness and contains expected errors', async () => {
    const h = sessionHarness()
    await h.host.ensureStream()
    await tick()
    h.channel.push({ type: 'message.part.updated', properties: {} })
    await tick()
    expect(h.host.observation()).toMatchObject({ state: 'degraded', reason: 'projection-loss' })
    expect(h.host.sendSession('s1', { text: 'still works' })).resolves.toMatchObject({ ok: true })
    expect(h.isUncertain()).toBe(false)

    const failing = sessionHarness({ getError: new OpenCodeAdapterError('session.get', 'NOT_FOUND', 'missing', 404) })
    expect(await failing.host.openSession('missing')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(failing.isUncertain()).toBe(false)
  })

  it('keeps observation live for recognized non-outcome events and degrades only on genuine loss', async () => {
    const h = sessionHarness()
    await h.host.ensureStream()
    await tick()
    for (const type of ['session.created', 'session.status', 'session.idle']) {
      h.channel.push({ type, properties: { sessionID: 's' } })
      await tick()
    }
    expect(h.host.observation()).toEqual({ state: 'live' })
    expect(h.host.sessionEvents()).toEqual([])
    // A genuinely unparseable/foreign tag is still a projection loss.
    h.channel.push({ type: 'mystery.event', properties: {} })
    await tick()
    expect(h.host.observation()).toMatchObject({ state: 'degraded', reason: 'projection-loss', droppedEvents: 1 })
  })

  it('fences a stale operation record on child replacement and rejects cancel typed before abort', async () => {
    const h = sessionHarness({ holdPrompt: true })
    const prompt = h.host.sendSession('s1', { text: 'hi' })
    await tick()
    h.channel.push({ type: 'message.updated', properties: { info: { id: 'assistant-1', role: 'assistant', sessionID: 's1', parentID: h.prompts[0].messageId! } } })
    await tick()
    // The child is replaced with a new effective revision while the prompt record is bound.
    h.replaceHandle({ url: 'http://127.0.0.1:9', authorization: 'Bearer replacement', effectiveRevision: 4, pid: 2, modelTarget: { providerID: 'p4', modelID: 'm4' } })
    // Before re-pointing the stream, a cancel must refuse the mismatched snapshot and never abort
    // through the replacement child.
    const rejected = await h.host.cancelSession('s1')
    expect(rejected).toMatchObject({ ok: false, error: { code: 'RESULT_UNKNOWN', detail: { reason: 'stale-generation', runtimeGeneration: 7, effectiveRevision: 3 } } })
    expect(h.abortCalls()).toBe(0)
    // Re-pointing the stream fences the stale record, so a fresh prompt is admitted and reaches
    // the replacement child instead of conflicting with a dead operation.
    await h.host.ensureStream()
    const fresh = h.host.sendSession('s1', { text: 'fresh' })
    await tick()
    expect(h.prompts.map(item => item.sessionId)).toEqual(['s1', 's1'])
    h.releasePrompt()
    expect(await fresh).toMatchObject({ ok: true })
    await prompt
  })

  it('restarts one event consumer after an SSE end on the next explicit Session action', async () => {
    const h = sessionHarness()
    await h.host.ensureStream()
    await tick()
    expect(h.subscriptions()).toBe(1)
    h.channel.end()
    await tick()
    expect(h.host.observation()).toMatchObject({ state: 'lost', reason: 'stream-ended' })

    expect(await h.host.openSession('existing-1')).toEqual({ ok: true })
    expect(h.subscriptions()).toBe(2)
    expect(h.host.observation()).toEqual({ state: 'live' })
    await h.host.dispose()
  })

  it('fails typed when the owner handle changes during the ensureStream await', async () => {
    const h = sessionHarness()
    h.replaceHandle({
      url: 'http://127.0.0.1:0',
      authorization: 'Bearer old',
      effectiveRevision: 2,
      modelTarget: { providerID: 'p2', modelID: 'm2' },
    })
    await h.host.ensureStream()
    h.replaceHandle({
      url: 'http://127.0.0.1:1',
      authorization: 'Bearer x',
      effectiveRevision: 3,
      modelTarget: { providerID: 'p3', modelID: 'm3' },
    })
    const replacement: ManagedEffectiveHandle = {
      url: 'http://127.0.0.1:2',
      authorization: 'Bearer y',
      effectiveRevision: 4,
      modelTarget: { providerID: 'p4', modelID: 'm4' },
    }
    queueMicrotask(() => { h.replaceHandle(replacement) })

    expect(await h.host.sendSession('s1', { text: 'must not reach the replacement child' })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    })
    expect(h.prompts).toEqual([])
  })

  it('restarts the one event stream for a new child pid and awaits the previous consumer', async () => {
    const order: string[] = []
    let subscriptions = 0
    const makeStream = (label: string): AsyncGenerator<OpenCodeSdkEvent> => {
      let pending: ((result: IteratorResult<OpenCodeSdkEvent>) => void) | undefined
      return {
        [Symbol.asyncIterator]() { return this },
        next: () => new Promise(resolve => { pending = resolve }),
        return: async () => {
          order.push(`${label}:return`)
          pending?.({ value: undefined, done: true })
          pending = undefined
          return { value: undefined, done: true }
        },
        throw: async () => ({ value: undefined, done: true }),
      }
    }
    const client = {
      session: {
        list: async () => ({ data: [] }),
        get: async () => ({ data: { id: 's' } }),
        create: async () => ({ data: { id: 's' } }),
        prompt: async () => ({ data: {} }),
        abort: async () => ({ data: true }),
      },
      postSessionIdPermissionsPermissionId: async () => ({ data: {} }),
      event: {
        subscribe: async () => {
          const label = `subscribe-${++subscriptions}`
          order.push(label)
          return { data: { stream: makeStream(label) } }
        },
      },
    } as unknown as OpenCodeSessionClient & OpenCodeEventClient
    let handle: ManagedEffectiveHandle = {
      url: 'http://127.0.0.1:1',
      authorization: 'Bearer x',
      effectiveRevision: 3,
      pid: 1,
      modelTarget: { providerID: 'p', modelID: 'm' },
    }
    const owner = {
      readiness: (): ManagedRuntimeReadiness => ({ state: 'current', effectiveRevision: 3, modelTarget: handle.modelTarget, activeOperations: 0 }),
      currentHandle: () => handle,
      use: async <T>(operation: (value: ManagedEffectiveHandle) => Promise<T>): Promise<T> => await operation(handle),
    }
    const host = createSessionHost({ agentId: 'agent', generation: () => 7, owner, createClient: () => client })
    await host.ensureStream()
    expect(order).toEqual(['subscribe-1'])
    handle = { ...handle, pid: 2 }
    await host.ensureStream()
    expect(order).toEqual(['subscribe-1', 'subscribe-1:return', 'subscribe-2'])
    await host.dispose()
  })
})

describe('Session feature graph product', () => {
  it('binds the delivered claim-before-dispatch Session topology', () => {
    const graphPath = join(resolve(import.meta.dirname), '..', 'docs', 'design', 'dagpipe', 'graphs', 'session-request.graph.json')
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as {
      readonly nodes: readonly { readonly id: string; readonly operator: string; readonly output: { readonly id: string } }[]
      readonly edges: readonly { readonly from: string; readonly to: string; readonly arc_id: string }[]
    }
    expect(graph.nodes.find(node => node.id === 'claim-session')).toMatchObject({
      operator: 'teams.claim-session-operation', output: { id: 'session.operation-claimed' },
    })
    const arcs = graph.edges.map(edge => `${edge.from}->${edge.to}:${edge.arc_id}`)
    expect(arcs).toContain('resolve-runtime->claim-session:runtime.resolved')
    expect(arcs).toContain('claim-session->dispatch-session:session.operation-claimed')
  })
})
