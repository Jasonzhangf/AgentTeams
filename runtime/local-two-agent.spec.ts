import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { initializeLocalConfig, loadLocalConfig, readLocalInternalConfig } from './local-config.ts'
const { startLocalProcess, statusLocalProcess, stopLocalProcess } = await import(
  process.env.TEAMS_LOCAL_REPLAY === 'compiled'
    ? '../generated/runtime-lib/runtime/local-process.js'
    : './local-process.ts'
)

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

it('starts two independent daemons from v3 config.toml, publishes enabled services and restarts cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'at-'))
  let started = false
  try {
    const agentteams = join(root, '.agentteams')
    const searchRoot = join(root, 'provider-files')
    const providerData = join(root, 'provider-data')
    const consumerData = join(root, 'consumer-data')
    mkdirSync(searchRoot, { recursive: true })
    writeFileSync(join(searchRoot, 'needle.txt'), 'two daemon bridge\n')
    mkdirSync(agentteams, { recursive: true })
    const configPath = join(agentteams, 'config.toml')
    await initializeLocalConfig(configPath, `version = 3

[bridge]
enabled = true

[agents.provider]
enabled = true
role = "provider"
label = "provider"

[agents.provider.identity]
hostId = "provider-host"
machineId = "local-machine"
accountId = "local-account"
agentKind = "custom"
label = "provider"

[agents.provider.runtime]
scopeId = "local-scope"
dataDirectory = ${JSON.stringify(providerData)}
policy = { revision = 1, allowedConsumers = ["consumer"], allowedManagers = [] }
cli = { camoExecutable = "/opt/homebrew/bin/camo", searchExecutable = "/opt/homebrew/bin/rg", searchRoot = ${JSON.stringify(searchRoot)}, profilePrefix = "teams-provider" }

[agents.provider.services.file-search]
version = "1"
operations = ["search"]
resources = [{ resourceId = "search-slot", capacity = 2, unit = "slot" }]

[agents.provider.services.browser]
version = "1"
operations = ["context.create", "navigate", "snapshot", "context.destroy"]
resources = [
  { resourceId = "browser-context", capacity = 1, unit = "context" },
  { resourceId = "browser-slot", capacity = 1, unit = "slot" },
]

[agents.consumer]
enabled = true
role = "receiver"
label = "consumer"

[agents.consumer.identity]
hostId = "consumer-host"
machineId = "local-machine"
accountId = "local-account"
agentKind = "custom"
label = "consumer"

[agents.consumer.runtime]
scopeId = "local-scope"
dataDirectory = ${JSON.stringify(consumerData)}
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/opt/homebrew/bin/rg", searchRoot = ${JSON.stringify(searchRoot)}, profilePrefix = "teams-consumer" }

[agents.consumer.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
demands = [{ resourceId = "search-slot", amount = 1 }]
`)
    const compiled = process.env.TEAMS_LOCAL_REPLAY === 'compiled'
    const first = await startLocalProcess(configPath, { relayEntry: compiled ? resolve('generated/runtime-lib/server/relay-process.js') : resolve('server/relay-process.ts'),
      agentEntry: compiled ? resolve('generated/runtime-lib/runtime/agent-process.js') : resolve('runtime/agent-process.ts'),
      nodeArguments: compiled ? [] : ['--experimental-transform-types'], env: { AGENTTEAMS_PROVIDER_AUTH: 'provider-secret', AGENTTEAMS_CONSUMER_AUTH: 'consumer-secret' }, startupTimeoutMs: 15000 })
    started = true
    expect(first).toMatchObject({ state: 'running', generation: 1 })
    expect(first.pid).toBeGreaterThan(0)
    expect(await statusLocalProcess(configPath)).toMatchObject({ state: 'running', generation: 1 })
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
        { capabilityId: 'file-search', version: '1', operations: ['search'],
          resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }] },
        { capabilityId: 'browser', version: '1', operations: ['context.create', 'navigate', 'snapshot', 'context.destroy'],
          resources: [
            { resourceId: 'browser-context', capacity: 1, unit: 'context' },
            { resourceId: 'browser-slot', capacity: 1, unit: 'slot' },
          ] },
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
    expect(processAlive(first.pid!)).toBe(false)
    expect(JSON.parse(readFileSync(join(agentteams, '.internal', 'daemon-status.json'), 'utf8'))).toMatchObject({
      generation: first.generation,
      daemons: {
        provider: { presence: 'offline', state: 'stopped' },
        consumer: { presence: 'offline', state: 'stopped' },
      },
    })
    const second = await startLocalProcess(configPath, { relayEntry: compiled ? resolve('generated/runtime-lib/server/relay-process.js') : resolve('server/relay-process.ts'),
      agentEntry: compiled ? resolve('generated/runtime-lib/runtime/agent-process.js') : resolve('runtime/agent-process.ts'),
      nodeArguments: compiled ? [] : ['--experimental-transform-types'], env: { AGENTTEAMS_PROVIDER_AUTH: 'provider-secret', AGENTTEAMS_CONSUMER_AUTH: 'consumer-secret' }, startupTimeoutMs: 15000 })
    started = true
    expect(second).toMatchObject({ state: 'running', generation: 2 })
    expect(second.pid).toBeGreaterThan(0)
    const restartedInternal = await readLocalInternalConfig(config.internalPath!)
    expect.soft(restartedInternal.daemons?.relay?.orphaned).toBe(false)
    await stopLocalProcess(configPath, second.generation)
    started = false
    const secondStopped = await readLocalInternalConfig(config.internalPath!)
    expect.soft(Object.values(secondStopped.daemons ?? {}).map(daemon => daemon.state)).toEqual(['stopped', 'stopped', 'stopped'])
    expect(processAlive(second.pid!)).toBe(false)
    expect(JSON.parse(readFileSync(join(agentteams, '.internal', 'daemon-status.json'), 'utf8'))).toMatchObject({
      generation: second.generation,
      daemons: {
        provider: { presence: 'offline', state: 'stopped' },
        consumer: { presence: 'offline', state: 'stopped' },
      },
    })
  } finally {
    try { if (started) await stopLocalProcess(join(root, '.agentteams', 'config.toml')) } finally { rmSync(root, { recursive: true, force: true }) }
  }
}, 30000)
