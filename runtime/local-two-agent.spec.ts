import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { expect, it } from 'vitest'
import { loadLocalConfig, readLocalInternalConfig } from './local-config.ts'
import { runLocalConfiguredWork, startLocalProcess, statusLocalProcess, stopLocalProcess } from './local-process.ts'

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test port missing')
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  return address.port
}

it('starts two independent daemons from config.toml and completes receiver Work over the local bridge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'teams-two-agent-'))
  let started = false
  try {
    const agentteams = join(root, '.agentteams')
    const relayPort = await availablePort()
    const providerLeasePort = await availablePort()
    const consumerLeasePort = await availablePort()
    const relayKey = join(root, 'relay-key.pem')
    const relayCert = join(root, 'relay-cert.pem')
    const relayConfig = join(root, 'relay.json')
    const searchRoot = join(root, 'provider-files')
    const providerData = join(root, 'provider-data')
    const consumerData = join(root, 'consumer-data')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', relayKey, '-out', relayCert], { stdio: 'ignore' })
    mkdirSync(searchRoot, { recursive: true })
    writeFileSync(join(searchRoot, 'needle.txt'), 'two daemon bridge\n')
    writeFileSync(relayConfig, JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: relayPort }, tls: { keyFile: relayKey, certFile: relayCert },
      limits: { maxPayload: 65536, maxConnections: 8, maxGrants: 8, maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 5000 },
      credentials: [
        { credentialEnv: 'TEAMS_PROVIDER_AUTH', identity: { accountId: 'local-account', scopeId: 'local-scope', agentId: 'provider' } },
        { credentialEnv: 'TEAMS_CONSUMER_AUTH', identity: { accountId: 'local-account', scopeId: 'local-scope', agentId: 'consumer' } },
      ] }))
    const relay = `wss://127.0.0.1:${relayPort}`
    mkdirSync(agentteams, { recursive: true })
    const common = (agentId: string, hostId: string, leasePort: number, dataDirectory: string, credentialEnv: string, allowedConsumers: string[]) => `
enabled = true
role = "${agentId === 'provider' ? 'provider' : 'receiver'}"
identity = { hostId = "${hostId}", machineId = "local-machine", agentId = "${agentId}", accountId = "local-account", agentKind = "custom", label = "${agentId}" }
scopeId = "local-scope"
dataDirectory = ${JSON.stringify(dataDirectory)}
leasePort = ${leasePort}
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [${allowedConsumers.map(item => JSON.stringify(item)).join(', ')}], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/opt/homebrew/bin/rg", searchRoot = ${JSON.stringify(searchRoot)}, profilePrefix = "teams-${agentId}" }
relay = { endpoint = ${JSON.stringify(relay)}, credentialEnv = "${credentialEnv}", caFile = ${JSON.stringify(relayCert)}, connectTimeoutMs = 1000, admissionTimeoutMs = 1000, requestTimeoutMs = 3000, maxMessageBytes = 65536, maxBufferedBytes = 65536, maxPendingFrames = 16, maxPendingRequests = 8, maxDataConnections = 8 }
`
    writeFileSync(join(agentteams, 'config.toml'), `version = 2

[relay]
config = ${JSON.stringify(relayConfig)}

[endpoints.provider]
${common('provider', 'provider-host', providerLeasePort, providerData, 'TEAMS_PROVIDER_AUTH', ['consumer'])}

[endpoints.consumer]
${common('consumer', 'consumer-host', consumerLeasePort, consumerData, 'TEAMS_CONSUMER_AUTH', [])}

[endpoints.consumer.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
workId = "configured-search"
requestId = "configured-search-1"
demands = [{ resourceId = "search-slot", amount = 1 }]
payload = { query = "two daemon bridge" }
`)
    const configPath = join(agentteams, 'config.toml')
    const compiled = process.env.TEAMS_LOCAL_REPLAY === 'compiled'
    const first = await startLocalProcess(configPath, { relayEntry: compiled ? resolve('generated/runtime-lib/server/relay-process.js') : resolve('server/relay-process.ts'),
      agentEntry: compiled ? resolve('generated/runtime-lib/runtime/agent-process.js') : resolve('runtime/agent-process.ts'),
      nodeArguments: compiled ? [] : ['--experimental-transform-types'], env: { TEAMS_PROVIDER_AUTH: 'provider-secret', TEAMS_CONSUMER_AUTH: 'consumer-secret' }, startupTimeoutMs: 15000 })
    started = true
    expect(first).toMatchObject({ state: 'running', generation: 1 })
    expect(await statusLocalProcess(configPath)).toMatchObject({ state: 'running', generation: 1 })
    await expect(runLocalConfiguredWork(configPath, { TEAMS_PROVIDER_AUTH: 'provider-secret', TEAMS_CONSUMER_AUTH: 'consumer-secret' })).resolves.toMatchObject({
      state: 'succeeded',
      workId: 'configured-search',
      requestId: 'configured-search-1',
    })
    const config = await loadLocalConfig(configPath)
    const internal = readFileSync(config.internalPath!, 'utf8')
    expect(internal).toMatch(/\[daemon\."provider"\][\s\S]*state = "online"/)
    expect(internal).toMatch(/\[daemon\."consumer"\][\s\S]*state = "online"/)
    const projected = await statusLocalProcess(configPath)
    expect(projected.endpoints?.map(endpoint => endpoint.agentId)).toEqual(['provider', 'consumer'])
    expect(projected.endpoints?.find(endpoint => endpoint.agentId === 'provider')).toMatchObject({
      role: 'provider',
      presence: 'online',
      generation: 1,
      capabilities: [
        { capabilityId: 'browser', version: '1', operations: ['context.create', 'navigate', 'snapshot', 'context.destroy'],
          resources: [
            { resourceId: 'browser-context', capacity: 2, unit: 'context' },
            { resourceId: 'browser-slot', capacity: 2, unit: 'slot' },
          ] },
        { capabilityId: 'file-search', version: '1', operations: ['search'],
          resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }] },
      ],
    })
    expect(projected.endpoints?.find(endpoint => endpoint.agentId === 'consumer')).toMatchObject({
      role: 'receiver', presence: 'online', generation: 1, capabilities: [],
    })
    await stopLocalProcess(configPath, first.generation)
    started = false
    const stoppedStatus = await statusLocalProcess(configPath)
    expect(stoppedStatus.endpoints?.map(endpoint => [endpoint.agentId, endpoint.presence, endpoint.state])).toEqual([
      ['provider', 'offline', 'stopped'],
      ['consumer', 'offline', 'stopped'],
    ])
    const stopped = await readLocalInternalConfig(config.internalPath!)
    expect.soft(Object.values(stopped.daemons ?? {}).map(daemon => daemon.state)).toEqual(['stopped', 'stopped', 'stopped'])
    const second = await startLocalProcess(configPath, { relayEntry: compiled ? resolve('generated/runtime-lib/server/relay-process.js') : resolve('server/relay-process.ts'),
      agentEntry: compiled ? resolve('generated/runtime-lib/runtime/agent-process.js') : resolve('runtime/agent-process.ts'),
      nodeArguments: compiled ? [] : ['--experimental-transform-types'], env: { TEAMS_PROVIDER_AUTH: 'provider-secret', TEAMS_CONSUMER_AUTH: 'consumer-secret' }, startupTimeoutMs: 15000 })
    started = true
    expect(second).toMatchObject({ state: 'running', generation: 2 })
    const restartedInternal = await readLocalInternalConfig(config.internalPath!)
    expect.soft(restartedInternal.daemons?.relay?.orphaned).toBe(false)
    await expect(runLocalConfiguredWork(configPath, { TEAMS_PROVIDER_AUTH: 'provider-secret', TEAMS_CONSUMER_AUTH: 'consumer-secret' })).resolves.toMatchObject({
      state: 'succeeded',
      workId: 'configured-search',
      requestId: 'configured-search-1',
    })
    const restarted = readFileSync(config.internalPath!, 'utf8')
    expect(restarted).toMatch(/\[configuredWork\][\s\S]*generation = 2/)
    await stopLocalProcess(configPath, second.generation)
    started = false
    const secondStopped = await readLocalInternalConfig(config.internalPath!)
    expect.soft(Object.values(secondStopped.daemons ?? {}).map(daemon => daemon.state)).toEqual(['stopped', 'stopped', 'stopped'])
  } finally {
    try { if (started) await stopLocalProcess(join(root, '.agentteams', 'config.toml')) } finally { rmSync(root, { recursive: true, force: true }) }
  }
}, 30000)
