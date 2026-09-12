import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createRelayClient, type RelayClient } from '../network/relay-client.ts'
import { connectDirectWssTarget } from '../network/direct-route.ts'
import { buildDirectWssRoutePlan } from '../network/route-plan.ts'
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
function child(configPath: string, credential = 'Bearer provider', extraEnv: NodeJS.ProcessEnv = {}) {
  const process = spawn(globalThis.process.execPath, ['--experimental-transform-types', resolve('runtime/agent-process.ts'), '--config', configPath],
    { env: { ...globalThis.process.env, TEAMS_AGENT_TEST_AUTH: credential, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
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
    const projected = await (await fetch(`${consoleUrl}/api/v1/projection`, { headers: { authorization: 'console-test' } })).json() as { agents: { agentId: string }[]; works: unknown[]; relations: unknown[] }
    expect(projected.agents[0].agentId).toBe('provider')
    expect(projected.works).toEqual([])
    expect(projected.relations).toEqual([])
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
  expect(await management.readProjection()).toMatchObject({
    works: [expect.objectContaining({ agentId: 'provider', workId: 'work', consumerAgentId: 'consumer', state: 'closed' })],
    relations: [expect.objectContaining({ agentId: 'provider', workId: 'work', consumerAgentId: 'consumer', relationPermission: 'granted' })],
  })
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
  const managedConfigPath = join(directory, 'managed-runtime.json')
  writeFileSync(managedConfigPath, JSON.stringify({ revision: 3, acceptedRevision: 3,
    providers: {
      probe: { id: 'probe', label: 'Probe', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } },
      catalog: { id: 'catalog', label: 'Catalog', protocol: 'openai-chat', apiBaseUrl: `http://127.0.0.1:${catalogPort}/v1`, enabled: true, auth: { kind: 'bearer', credentialRef: 'TEAMS_PROVIDER_TEST_CREDENTIAL' } },
    },
    catalogs: {
      probe: { state: 'ready', entries: [{ ref: { providerInstanceId: 'probe', modelId: 'probe-model' }, origin: 'manual', base: {}, overrides: {} }] },
      catalog: { state: 'stale', entries: [] },
    },
    agents: { managed: { primary: { providerInstanceId: 'probe', modelId: 'probe-model' } } } }))
  const managedAgentConfig = join(directory, 'managed-agent.json')
  writeFileSync(managedAgentConfig, JSON.stringify({ ...config, identity: { ...config.identity, hostId: 'managed-host', agentId: 'managed', label: 'Managed Agent' },
    dataDirectory: managedData, leasePort: await availablePort(), policy: { revision: 1, allowedConsumers: ['consumer'], allowedManagers: ['consumer'] },
    openCode: { executable: managedExecutable, directory: join(directory, 'managed-opencode-data'), configFile: managedConfigPath, port: await availablePort(), startupTimeoutMs: 5000, stopTimeoutMs: 2000 } }))
  const managedChild = child(managedAgentConfig, 'Bearer managed', { TEAMS_PROVIDER_TEST_CREDENTIAL: 'provider-catalog' })
  expect(await managedChild.ready).toMatchObject({ agentId: 'managed' })
  const managedConsole = createRelayConsoleClient(consumer, 'managed', 3000)
  expect(await managedConsole.command({ kind: 'config.refreshModels', agentId: 'managed', expectedRevision: 3, providerId: 'catalog' })).toEqual({ ok: true })
  expect((await managedConsole.readProjection()).configs[0]).toMatchObject({ acceptedRevision: 4,
    providers: expect.arrayContaining([expect.objectContaining({ id: 'catalog', catalogState: 'ready', models: [{ id: 'catalog-model' }] })]) })
  expect(catalogAuthSeen).toBe(true)
  expect(await managedConsole.command({ kind: 'config.apply', agentId: 'managed' })).toEqual({ ok: true })
  expect((await managedConsole.readProjection()).configs[0]).toMatchObject({ acceptedRevision: 4, effectiveRevision: 4 })
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
      await expect(channel.close('direct-work')).resolves.toMatchObject({ state: 'closed' })
    } finally { await channel.dispose() }
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
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: join(directory, 'cert.pem'), connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 } }))
  const process = child(configPath, 'Bearer stale-lock-agent')
  expect(await process.ready).toMatchObject({ agentId: 'stale-lock-agent' })
  expect(existsSync(join(dataDirectory, 'work.json.lock'))).toBe(false)
  process.process.kill('SIGTERM')
  expect((await process.exited).code).toBe(0)
  expect(existsSync(join(dataDirectory, 'runtime-owner.json'))).toBe(false)
}, 15000)
