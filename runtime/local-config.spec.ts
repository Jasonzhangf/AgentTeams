import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { configSourceHash, createTomlRuntimeConfigPersistence, defaultLocalConfigPath, initializeLocalConfig, loadLocalConfig, parseConfigUserSections, projectLocalChildConfigs, readLocalInternalConfig, readLocalInternalWorkControl, resumePendingMigration, writeLocalConfig, writeLocalInternalConsoleRuntime, writeLocalInternalLauncherState, writeLocalInternalState, writeLocalInternalWorkControl } from './local-config.ts'
import { parse as parseToml } from 'toml'
import { loadConsoleProcessConfig } from './console-process.ts'
import { providerIntentFingerprint } from '../config/runtime-config.ts'

it('loads a persisted TOML launcher config and resolves paths relative to the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-local-config-'))
  const path = join(directory, '.agentteams', 'config.toml')
  try {
    await writeLocalConfig(path, `version = 1

[relay]
config = "relay.json"
enabled = true

[daemons.browser]
config = "daemons/browser.json"
enabled = true

[daemons.worker]
config = "daemons/worker.json"
enabled = false
`)
    const loaded = await loadLocalConfig(path)
    expect(loaded).toEqual({
      version: 1,
      configPath: path,
      relay: { enabled: true, configPath: join(directory, '.agentteams', 'relay.json') },
      daemons: [
        { id: 'browser', enabled: true, configPath: join(directory, '.agentteams', 'daemons/browser.json') },
        { id: 'worker', enabled: false, configPath: join(directory, '.agentteams', 'daemons/worker.json') },
      ],
    })
    expect(await readFile(path, 'utf8')).toContain('[daemons.browser]')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('atomically rejects an exclusive config write without replacing an existing file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-local-config-exclusive-'))
  const path = join(directory, 'config.toml')
  const first = 'version = 1\n[relay]\nconfig = "relay.json"\n[daemons.one]\nconfig = "one.json"\n'
  try {
    await writeLocalConfig(path, first, { exclusive: true })
    await expect(writeLocalConfig(path, 'version = 1\nreplaced = true\n', { exclusive: true })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(path, 'utf8')).toBe(first)
    await writeLocalConfig(path, 'version = 1\nreplaced = true\n')
    expect(await readFile(path, 'utf8')).toBe('version = 1\nreplaced = true\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('uses ~/.agentteams/config.toml as the stable default without creating it during read', () => {
  expect(defaultLocalConfigPath('/tmp/teams-home')).toBe('/tmp/teams-home/.agentteams/config.toml')
})

it('rejects a launcher config with no enabled daemon or unknown fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-local-config-invalid-'))
  const path = join(directory, 'config.toml')
  try {
    await writeLocalConfig(path, 'version = 1\nunknown = true\n[relay]\nconfig = "relay.json"\n[daemons.one]\nconfig = "one.json"\nenabled = false\n')
    await expect(loadLocalConfig(path)).rejects.toThrow(/unknown|enabled daemon/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects the reserved relay daemon id before process planning can overwrite ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-local-config-reserved-'))
  const path = join(directory, 'config.toml')
  try {
    await writeLocalConfig(path, 'version = 1\n[relay]\nconfig = "relay.json"\n[daemons.relay]\nconfig = "relay-agent.json"\n')
    await expect(loadLocalConfig(path)).rejects.toThrow(/reserved.*Relay/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('loads v2 endpoint intent into internal.toml without materializing editable child JSON at load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-endpoint-config-'))
  const path = join(directory, '.agentteams', 'config.toml')
  try {
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.provider]
enabled = true
role = "provider"
identity = { hostId = "provider-host", machineId = "machine", agentId = "provider", accountId = "account", agentKind = "custom", label = "Provider" }
scopeId = "scope"
dataDirectory = "data/provider"
leasePort = 48011
presenceIntervalMs = 500
policy = { revision = 1, allowedConsumers = ["consumer"], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "PROVIDER_AUTH", caFile = "relay.pem", connectTimeoutMs = 1000, admissionTimeoutMs = 1000, requestTimeoutMs = 1000, maxMessageBytes = 65536, maxBufferedBytes = 65536, maxPendingFrames = 8, maxPendingRequests = 4, maxDataConnections = 4 }

[endpoints.consumer]
enabled = true
role = "receiver"
identity = { hostId = "consumer-host", machineId = "machine", agentId = "consumer", accountId = "account", agentKind = "custom", label = "Consumer" }
scopeId = "scope"
dataDirectory = "data/consumer"
leasePort = 48012
presenceIntervalMs = 500
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-consumer" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "CONSUMER_AUTH", caFile = "relay.pem", connectTimeoutMs = 1000, admissionTimeoutMs = 1000, requestTimeoutMs = 1000, maxMessageBytes = 65536, maxBufferedBytes = 65536, maxPendingFrames = 8, maxPendingRequests = 4, maxDataConnections = 4 }

[endpoints.consumer.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
demands = [{ resourceId = "search-slot", amount = 1 }]
`)
    await writeFile(join(directory, '.agentteams', 'relay.json'), JSON.stringify({
      version: 1,
      listen: { host: '127.0.0.1', port: 48010 },
      tls: { keyFile: 'relay-key.pem', certFile: 'relay-cert.pem' },
      limits: { maxPayload: 65536, maxConnections: 8, maxGrants: 8, maxBufferedAmount: 65536, maxPendingMessages: 8, maxPendingBytes: 131072, grantTtlMs: 5000 },
      credentials: [{ credentialEnv: 'PROVIDER_AUTH', identity: { accountId: 'account', scopeId: 'scope', agentId: 'provider' } }],
    }))
    const loaded = await loadLocalConfig(path)
    expect(loaded.internalPath).toBe(join(directory, '.agentteams', 'internal.toml'))
    expect(loaded.relay.configPath).toBe(join(directory, '.agentteams', '.internal', 'projections', 'relay.json'))
    expect(loaded.daemons.map(item => item.id)).toEqual(['provider', 'consumer'])
    expect(loaded.daemons[0]?.role).toBe('provider')
    expect(loaded.daemons[1]?.role).toBe('receiver')
    expect(loaded.daemons[1]?.connection).toMatchObject({ targetAgentId: 'provider', capabilityId: 'file-search', operation: 'search' })
    expect(loaded.daemons[0]!.configPath).toBe(join(directory, '.agentteams', '.internal', 'projections', 'provider.json'))
    expect(existsSync(loaded.relay.configPath)).toBe(false)
    expect(existsSync(loaded.daemons[0]!.configPath)).toBe(false)
    const internal = parseToml(await readFile(loaded.internalPath, 'utf8')) as {
      relay: { config: string; projectionPath: string }
      daemon: Record<string, { config: string }>
    }
    expect(internal.relay.projectionPath).toBe(loaded.relay.configPath)
    expect(internal.relay.config).toContain('48010')
    expect(JSON.parse(internal.daemon.provider!.config)).toMatchObject({ version: 1, endpoint: { role: 'provider' } })
    expect(internal.daemon.provider!.config).toContain('provider-host')
    expect(internal.relay.config).not.toContain('internal')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects a v2 disabled relay instead of silently launching it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-endpoint-relay-disabled-'))
  const path = join(directory, 'config.toml')
  try {
    await writeLocalConfig(path, 'version = 2\n[relay]\nenabled = false\nconfig = "relay.json"\n[endpoints.provider]\nrole = "provider"\nidentity = { hostId = "host", machineId = "machine", agentId = "provider", accountId = "account", agentKind = "custom", label = "Provider" }\nscopeId = "scope"\ndataDirectory = "data"\nleasePort = 48021\npresenceIntervalMs = 100\npolicy = { revision = 1, allowedConsumers = [], allowedManagers = [] }\ncli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-provider" }\nrelay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }\n')
    await expect(loadLocalConfig(path)).rejects.toThrow(/relay.enabled/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects a v2 endpoint named relay before process planning creates duplicate identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-endpoint-reserved-'))
  const path = join(directory, 'config.toml')
  try {
    await writeLocalConfig(path, 'version = 2\n[relay]\nconfig = "relay.json"\n[endpoints.relay]\nrole = "provider"\n')
    await expect(loadLocalConfig(path)).rejects.toThrow(/endpoints\.relay.*reserved/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps child JSON as an ephemeral projection from internal.toml instead of a second config source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-internal-owner-'))
  const agentteams = join(directory, '.agentteams')
  const path = join(agentteams, 'config.toml')
  const relayConfig = join(agentteams, 'relay.json')
  try {
    await mkdir(agentteams, { recursive: true })
    await writeFile(join(agentteams, 'relay-cert.pem'), 'cert\n', { mode: 0o600 })
    await writeFile(join(agentteams, 'relay-key.pem'), 'key\n', { mode: 0o600 })
    await writeFile(relayConfig, JSON.stringify({
      version: 1,
      listen: { host: '127.0.0.1', port: 49001 },
      tls: { keyFile: './relay-key.pem', certFile: './relay-cert.pem' },
      limits: { maxPayload: 65536, maxConnections: 8, maxGrants: 8, maxBufferedAmount: 65536, maxPendingMessages: 8, maxPendingBytes: 131072, grantTtlMs: 5000 },
      credentials: [{ credentialEnv: 'TEAMS_RELAY_AUTH', identity: { accountId: 'account', scopeId: 'scope', agentId: 'provider' } }],
    }))
    await writeFile(path, `version = 2
[relay]
config = ${JSON.stringify(relayConfig)}

[endpoints.provider]
enabled = true
role = "provider"
identity = { hostId = "provider-host", machineId = "machine", agentId = "provider", accountId = "account", agentKind = "custom", label = "Provider" }
scopeId = "scope"
dataDirectory = "data/provider"
leasePort = 49011
presenceIntervalMs = 500
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }
relay = { endpoint = "wss://127.0.0.1:49001", credentialEnv = "TEAMS_RELAY_AUTH", caFile = "relay-cert.pem", connectTimeoutMs = 1000, admissionTimeoutMs = 1000, requestTimeoutMs = 1000, maxMessageBytes = 65536, maxBufferedBytes = 65536, maxPendingFrames = 8, maxPendingRequests = 4, maxDataConnections = 4 }
`)
    const loaded = await loadLocalConfig(path)
    expect(loaded.internalPath).toBe(join(agentteams, 'internal.toml'))
    expect(loaded.relay.configPath).toBe(join(agentteams, '.internal', 'projections', 'relay.json'))
    expect(loaded.daemons[0]!.configPath).toBe(join(agentteams, '.internal', 'projections', 'provider.json'))
    expect(existsSync(loaded.relay.configPath)).toBe(false)
    expect(existsSync(loaded.daemons[0]!.configPath)).toBe(false)

    const internal = parseToml(await readFile(loaded.internalPath, 'utf8')) as {
      configRevision: string
      relay: { config: string; projectionPath: string }
      daemon: Record<string, { config: string; projectionPath: string; enabled: boolean; role: string }>
    }
    expect(internal.configRevision).toMatch(/^sha256:/)
    expect(internal.relay.projectionPath).toBe(loaded.relay.configPath)
    expect(internal.relay.config).toContain('relay-key.pem')
    const internalRelay = JSON.parse(internal.relay.config) as { tls: { keyFile: string; certFile: string } }
    expect(internalRelay.tls.keyFile).toBe(join(agentteams, 'relay-key.pem'))
    expect(internalRelay.tls.certFile).toBe(join(agentteams, 'relay-cert.pem'))
    expect(internal.daemon.provider.enabled).toBe(true)
    expect(internal.daemon.provider.role).toBe('provider')
    expect(internal.daemon.provider.config).toContain('provider-host')

    const mutatedInternal = (await readFile(loaded.internalPath, 'utf8')).replace('provider-host', 'provider-from-internal')
    await writeFile(loaded.internalPath, mutatedInternal)
    await projectLocalChildConfigs(loaded.internalPath)
    const projected = JSON.parse(await readFile(loaded.daemons[0]!.configPath, 'utf8')) as { identity: { hostId: string } }
    expect(projected.identity.hostId).toBe('provider-from-internal')
    const projectedRelay = JSON.parse(await readFile(loaded.relay.configPath, 'utf8')) as { tls: { keyFile: string; certFile: string } }
    expect(projectedRelay.tls.keyFile).toBe(join(agentteams, 'relay-key.pem'))
    expect(projectedRelay.tls.certFile).toBe(join(agentteams, 'relay-cert.pem'))

    await rm(loaded.daemons[0]!.configPath)
    await projectLocalChildConfigs(loaded.internalPath)
    expect(JSON.parse(await readFile(loaded.daemons[0]!.configPath, 'utf8'))).toMatchObject({ identity: { hostId: 'provider-from-internal' } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('reuses internal.toml for the same config revision and preserves lifecycle state when legacy relay JSON disappears', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-internal-reuse-'))
  const agentteams = join(directory, '.agentteams')
  const path = join(agentteams, 'config.toml')
  const relayConfig = join(agentteams, 'relay.json')
  try {
    await mkdir(agentteams, { recursive: true })
    await writeFile(relayConfig, JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 49101 } }))
    await writeFile(path, `version = 2
[relay]
config = "relay.json"
[endpoints.provider]
role = "provider"
identity = { hostId = "provider-host", machineId = "machine", agentId = "provider", accountId = "account", agentKind = "custom", label = "Provider" }
scopeId = "scope"
dataDirectory = "data/provider"
leasePort = 49111
presenceIntervalMs = 500
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }
relay = { endpoint = "wss://127.0.0.1:49101", credentialEnv = "AUTH", connectTimeoutMs = 1000, admissionTimeoutMs = 1000, requestTimeoutMs = 1000, maxMessageBytes = 65536, maxBufferedBytes = 65536, maxPendingFrames = 8, maxPendingRequests = 4, maxDataConnections = 4 }
`)
    const first = await loadLocalConfig(path)
    await writeLocalInternalState(first.internalPath!, { provider: { pid: 49123, generation: 9, state: 'stopped' } })
    await rm(relayConfig)
    const second = await loadLocalConfig(path)
    const internal = await readLocalInternalConfig(second.internalPath!)
    expect(internal.daemons?.provider).toMatchObject({ pid: 49123, generation: 9, state: 'stopped' })
    expect(second.relay.configPath).toBe(join(agentteams, '.internal', 'projections', 'relay.json'))
    await projectLocalChildConfigs(second.internalPath!)
    expect(JSON.parse(await readFile(second.relay.configPath, 'utf8'))).toMatchObject({ listen: { port: 49101 } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects internal projection paths outside the runtime projection directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-internal-projection-path-'))
  const internalPath = join(directory, 'internal.toml')
  const outsidePath = join(directory, 'outside.json')
  try {
    await writeFile(internalPath, `version = 1
[relay]
projectionPath = ${JSON.stringify(outsidePath)}
config = ${JSON.stringify(JSON.stringify({ version: 1 }))}
`)
    await expect(projectLocalChildConfigs(internalPath)).rejects.toThrow(/projectionPath must be/)
    expect(existsSync(outsidePath)).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('quotes dotted daemon ids in internal.toml so the persisted key remains exact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-internal-state-'))
  const path = join(directory, 'internal.toml')
  try {
    await writeLocalInternalState(path, { 'a.b': { pid: 42, generation: 3, state: 'online' } })
    const parsed = parseToml(await readFile(path, 'utf8')) as { daemon?: Record<string, { pid?: number }> }
    expect(parsed.daemon?.['a.b']?.pid).toBe(42)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('serializes concurrent internal state and Work control updates without dropping either field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-internal-write-lock-'))
  const path = join(directory, 'internal.toml')
  try {
    const socketPath = join(directory, '.internal', 'work-control.sock')
    await writeLocalInternalLauncherState(path, { pid: 101, generation: 1, startToken: 'start-token-1', state: 'running' })
    for (let iteration = 0; iteration < 20; iteration += 1) {
      await Promise.all([
        writeLocalInternalState(path, { provider: { pid: 4200 + iteration, generation: iteration + 1, state: 'online' } }),
        writeLocalInternalWorkControl(path, { socketPath, launcherGeneration: 1, launcherStartToken: 'start-token-1' }),
      ])
      const internal = await readLocalInternalConfig(path)
      expect(internal.daemons?.provider?.generation).toBe(iteration + 1)
      expect(internal.workControl).toEqual({ socketPath, launcherGeneration: 1, launcherStartToken: 'start-token-1' })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

const V3_PRIMARY_CONFIG = `version = 3

[bridge]
enabled = true

[agents.provider]
enabled = true
role = "provider"
label = "Local provider"

[agents.provider.identity]
hostId = "local"
machineId = "local"
accountId = "local"
agentKind = "custom"
label = "Local provider"

[agents.provider.runtime]
scopeId = "local"
dataDirectory = "data/provider"
policy = { revision = 1, allowedConsumers = ["receiver"], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }

[agents.provider.services.file-search]
version = "1"
operations = ["search"]
resources = [{ resourceId = "search-slot", capacity = 2, unit = "slot" }]

[agents.receiver]
enabled = true
role = "receiver"
label = "Local receiver"

[agents.receiver.identity]
hostId = "local"
machineId = "local"
accountId = "local"
agentKind = "custom"
label = "Local receiver"

[agents.receiver.runtime]
scopeId = "local"
dataDirectory = "data/receiver"
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-receiver" }

[agents.receiver.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
demands = [{ resourceId = "search-slot", amount = 1 }]

[providers.rcc]
protocol = "openai-responses"
apiBaseUrl = "http://127.0.0.1:4444/v1"
label = "RCC"
enabled = true

[[models]]
provider = "rcc"
id = "gpt-5.5"
label = "RCC configured model"

[agents.provider.model]
primary = { provider = "rcc", model = "gpt-5.5" }
`

it('parses v3 user intent without reading relay or provider JSON and records internal v2 relocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-config-'))
  const agentteams = join(directory, '.agentteams')
  const path = join(agentteams, 'config.toml')
  try {
    await writeLocalConfig(path, V3_PRIMARY_CONFIG)
    const loaded = await loadLocalConfig(path)
    expect(loaded.version).toBe(3)
    expect(loaded.internalPath).toBe(join(agentteams, 'internal.toml'))
    expect(loaded.relay.configPath).toBe(join(agentteams, '.internal', 'projections', 'relay.json'))
    expect(loaded.daemons.map(daemon => daemon.id).sort()).toEqual(['provider', 'receiver'])
    expect(loaded.daemons.map(daemon => daemon.role).sort()).toEqual(['provider', 'receiver'])
    expect(existsSync(loaded.relay.configPath)).toBe(false)
    const internal = parseToml(await readFile(loaded.internalPath!, 'utf8')) as {
      version: number
      sourceRevision: number
      sourceHash: string
      sourcePath: string
      relay: { config: string; projectionPath: string }
      daemon: Record<string, { config: string; projectionPath: string; role: string }>
    }
    expect(internal.version).toBe(2)
    expect(internal.sourceRevision).toBe(1)
    expect(internal.sourceHash).toBe(configSourceHash(V3_PRIMARY_CONFIG))
    expect(internal.sourcePath).toBe(path)
    expect(internal.relay.projectionPath).toBe(loaded.relay.configPath)
    const relay = JSON.parse(internal.relay.config) as { listen: { port: number } }
    expect(relay.listen.port).toBeGreaterThan(0)
    const provider = JSON.parse(internal.daemon.provider!.config) as { identity: { agentId: string }; leasePort: number }
    expect(provider.identity.agentId).toBe('provider')
    expect(provider.leasePort).toBeGreaterThan(0)

    const second = await loadLocalConfig(path)
    const reused = parseToml(await readFile(second.internalPath!, 'utf8')) as { sourceRevision: number; relay: { config: string } }
    expect(reused.sourceRevision).toBe(1)
    expect(JSON.parse(reused.relay.config)).toMatchObject({ listen: { port: relay.listen.port } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves a payload-free service-only receiver connection in the returned spec and internal/child projections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-receiver-connection-'))
  const agentteams = join(directory, '.agentteams')
  const path = join(agentteams, 'config.toml')
  try {
    await writeLocalConfig(path, V3_PRIMARY_CONFIG)
    await writeFile(join(agentteams, 'internal.toml'), `version = 2

[relay]
config = ${JSON.stringify(JSON.stringify({ listen: { port: 49101 } }))}

[daemon.provider]
enabled = true
role = "provider"
config = ${JSON.stringify(JSON.stringify({ leasePort: 49102 }))}

[daemon.receiver]
enabled = true
role = "receiver"
config = ${JSON.stringify(JSON.stringify({ leasePort: 49103 }))}
`)
    const loaded = await loadLocalConfig(path)
    const expectedConnection = {
      targetAgentId: 'provider',
      capabilityId: 'file-search',
      capabilityVersion: '1',
      operation: 'search',
      demands: [{ resourceId: 'search-slot', amount: 1 }],
    }
    const receiver = loaded.daemons.find(daemon => daemon.id === 'receiver')!
    expect(receiver).toMatchObject({ role: 'receiver', connection: expectedConnection })
    expect(receiver.services).toBeUndefined()

    const internal = await readLocalInternalConfig(loaded.internalPath!)
    const internalReceiver = JSON.parse(internal.daemons!.receiver!.config!) as { endpoint: unknown }
    expect(internalReceiver.endpoint).toEqual({ role: 'receiver', connect: expectedConnection })

    await projectLocalChildConfigs(loaded.internalPath!)
    const childReceiver = JSON.parse(await readFile(receiver.configPath, 'utf8')) as { endpoint: unknown }
    expect(childReceiver.endpoint).toEqual({ role: 'receiver', connect: expectedConnection })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('initializes v3 through the runtime owner with owned TLS, credential references and no editable relay JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-initialize-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  try {
    await initializeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    const internal = await readLocalInternalConfig(join(agentteams, 'internal.toml'))
    const relay = JSON.parse(internal.relay!.config!) as {
      credentials: Array<{ credentialEnv: string; identity: { agentId: string } }>
      listen: { port: number }
      tls: { keyFile: string; certFile: string }
    }
    expect(relay.listen.port).toBeGreaterThan(0)
    expect(relay.tls).toEqual({
      keyFile: join(agentteams, '.internal', 'tls', 'relay-key.pem'),
      certFile: join(agentteams, '.internal', 'tls', 'relay-cert.pem'),
    })
    expect(relay.credentials.map(credential => credential.credentialEnv).sort()).toEqual(['AGENTTEAMS_PROVIDER_AUTH', 'AGENTTEAMS_RECEIVER_AUTH'])
    expect(relay.credentials.map(credential => credential.identity.agentId).sort()).toEqual(['provider', 'receiver'])
    expect((await stat(relay.tls.keyFile)).mode & 0o777).toBe(0o600)
    expect((await stat(relay.tls.certFile)).mode & 0o777).toBe(0o600)
    expect(existsSync(join(agentteams, 'relay.json'))).toBe(false)
    const loaded = await loadLocalConfig(configPath)
    expect(loaded.version).toBe(3)
    await expect(initializeLocalConfig(configPath, V3_PRIMARY_CONFIG)).rejects.toThrow(/already exists/)
    const after = await readLocalInternalConfig(join(agentteams, 'internal.toml'))
    expect(after.sourceRevision).toBe(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('refuses partial existing TLS before creating config and never overwrites a complete pair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-initialize-tls-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const tls = join(agentteams, '.internal', 'tls')
  try {
    await mkdir(tls, { recursive: true, mode: 0o700 })
    await writeFile(join(tls, 'relay-key.pem'), 'sentinel\n', { mode: 0o600 })
    await expect(initializeLocalConfig(configPath, V3_PRIMARY_CONFIG)).rejects.toThrow(/TLS material is incomplete/)
    expect(existsSync(configPath)).toBe(false)
    expect(await readFile(join(tls, 'relay-key.pem'), 'utf8')).toBe('sentinel\n')

    await rm(join(tls, 'relay-key.pem'))
    await initializeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    expect(existsSync(configPath)).toBe(true)
    expect((await stat(join(tls, 'relay-key.pem'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(tls, 'relay-cert.pem'))).mode & 0o777).toBe(0o600)

    const second = await mkdtemp(join(tmpdir(), 'teams-v3-initialize-tls-pair-'))
    const config = join(second, '.agentteams', 'config.toml')
    try {
      await initializeLocalConfig(config, V3_PRIMARY_CONFIG)
      const keyPath = join(second, '.agentteams', '.internal', 'tls', 'relay-key.pem')
      const certPath = join(second, '.agentteams', '.internal', 'tls', 'relay-cert.pem')
      const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')])
      await rm(join(second, '.agentteams', 'config.toml'))
      await initializeLocalConfig(config, V3_PRIMARY_CONFIG)
      expect(await readFile(keyPath, 'utf8')).toBe(key)
      expect(await readFile(certPath, 'utf8')).toBe(cert)
    } finally { await rm(second, { recursive: true, force: true }) }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('validates the complete v3 model before creating config or runtime directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-initialize-invalid-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  try {
    await expect(initializeLocalConfig(configPath, V3_PRIMARY_CONFIG.replace('role = "provider"', 'role = "invalid"'))).rejects.toThrow(/role must be one of/)
    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(join(agentteams, 'files'))).toBe(false)
    expect(existsSync(join(agentteams, '.internal', 'tls'))).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('injects the agent table key as HostIdentity.agentId and rejects a repeated identity.agentId', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-identity-'))
  const agentteams = join(directory, '.agentteams')
  const path = join(agentteams, 'config.toml')
  try {
    await writeLocalConfig(path, V3_PRIMARY_CONFIG.replace(
      '[agents.provider.identity]\nhostId = "local"',
      '[agents.provider.identity]\nagentId = "other"\nhostId = "local"'))
    await expect(loadLocalConfig(path)).rejects.toThrow(/identity.*agentId|agentId is derived/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects v3 receiver/hybrid without connect and model bindings with unknown references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-reject-'))
  const agentteams = join(directory, '.agentteams')
  const path = join(agentteams, 'config.toml')
  try {
    await writeLocalConfig(path, V3_PRIMARY_CONFIG.replace(/\[agents\.receiver\.connect\][\s\S]*$/, ''))
    await expect(loadLocalConfig(path)).rejects.toThrow(/connect is required/)

    await writeLocalConfig(path, V3_PRIMARY_CONFIG.replace('model = "gpt-5.5"', 'model = "missing-model"'))
    await expect(loadLocalConfig(path)).rejects.toThrow(/references model missing-model/)

    await writeLocalConfig(path, V3_PRIMARY_CONFIG.replace('provider = "rcc"\nid = "gpt-5.5"', 'provider = "missing-provider"\nid = "gpt-5.5"'))
    await expect(loadLocalConfig(path)).rejects.toThrow(/references unknown provider missing-provider|not declared by provider/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves system-owned internal relay/daemon material and lifecycle fields across a v3 reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-preserve-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  try {
    await writeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    await loadLocalConfig(configPath)
    await writeLocalInternalState(internalPath, { provider: { pid: 4242, generation: 7, state: 'stopped' } })
    const internal = parseToml(await readFile(internalPath, 'utf8')) as {
      relay: { config: string }
      daemon: Record<string, { config: string }>
    }
    const relay = JSON.parse(internal.relay.config) as Record<string, unknown>
    relay.tls = { keyFile: '/tmp/relay-key.pem', certFile: '/tmp/relay-cert.pem' }
    relay.credentials = [{ credentialEnv: 'TEAMS_PROVIDER_AUTH', identity: { accountId: 'a', scopeId: 's', agentId: 'provider' } }]
    const provider = JSON.parse(internal.daemon.provider!.config) as Record<string, unknown>
    provider.leasePort = 54321
    await writeFile(internalPath, (await readFile(internalPath, 'utf8'))
      .replace(JSON.stringify(internal.relay.config).slice(1, -1), JSON.stringify(JSON.stringify(relay)).slice(1, -1))
      .replace(JSON.stringify(internal.daemon.provider!.config).slice(1, -1), JSON.stringify(JSON.stringify(provider)).slice(1, -1)))

    const reloaded = await loadLocalConfig(configPath)
    const after = parseToml(await readFile(reloaded.internalPath!, 'utf8')) as {
      relay: { config: string }
      daemon: Record<string, { config: string; pid?: number; generation?: number; state?: string }>
    }
    expect((JSON.parse(after.relay.config) as { tls?: unknown }).tls).toEqual({
      keyFile: join(agentteams, '.internal', 'tls', 'relay-key.pem'),
      certFile: join(agentteams, '.internal', 'tls', 'relay-cert.pem'),
    })
    expect((JSON.parse(after.relay.config) as { credentials?: unknown }).credentials).toHaveLength(2)
    expect((JSON.parse(after.daemon.provider!.config) as { leasePort?: number }).leasePort).toBe(54321)
    expect(after.daemon.provider).toMatchObject({ pid: 4242, generation: 7, state: 'stopped' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps the configured bridge Relay non-orphaned while removed agent projections stay orphaned across v3 reloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-relay-orphan-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  const providerOnlyConfig = V3_PRIMARY_CONFIG.replace(/\n\[agents\.receiver\][\s\S]*?(?=\n\[providers\.rcc\])/, '')
  try {
    await initializeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    await writeLocalInternalState(internalPath, {
      relay: { pid: 61001, generation: 4, entryPath: '/installed/runtime/relay-process.js', startToken: 'relay-token-4', state: 'online' },
      provider: { pid: 61002, generation: 4, entryPath: '/installed/runtime/agent-process.js', startToken: 'provider-token-4', state: 'online' },
      receiver: { pid: 61003, generation: 4, entryPath: '/installed/runtime/agent-process.js', startToken: 'receiver-token-4', state: 'online' },
    })
    await writeLocalConfig(configPath, providerOnlyConfig)

    const first = await loadLocalConfig(configPath)
    const second = await loadLocalConfig(configPath)
    const internal = await readLocalInternalConfig(second.internalPath!)
    expect(await readFile(configPath, 'utf8')).toBe(providerOnlyConfig)
    expect(first.daemons.map(daemon => daemon.id)).toEqual(['provider'])
    expect(internal.sourceRevision).toBe(2)
    expect(internal.sourceHash).toBe(configSourceHash(providerOnlyConfig))
    expect(internal.daemons?.relay).toMatchObject({
      orphaned: false,
      pid: 61001,
      generation: 4,
      entryPath: '/installed/runtime/relay-process.js',
      startToken: 'relay-token-4',
      state: 'online',
    })
    expect(internal.daemons?.provider).toMatchObject({
      orphaned: false,
      pid: 61002,
      generation: 4,
      entryPath: '/installed/runtime/agent-process.js',
      startToken: 'provider-token-4',
      state: 'online',
    })
    expect(internal.daemons?.receiver).toMatchObject({
      orphaned: true,
      pid: 61003,
      generation: 4,
      entryPath: '/installed/runtime/agent-process.js',
      startToken: 'receiver-token-4',
      state: 'online',
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('does not advance machine source when a v3 compile fails after parse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-invalid-compile-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  try {
    await writeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    await loadLocalConfig(configPath)
    const before = await readLocalInternalConfig(internalPath)
    expect(before.sourceRevision).toBe(1)

    await writeLocalConfig(configPath, V3_PRIMARY_CONFIG.replace('operations = ["search"]', 'operations = []'))
    await expect(loadLocalConfig(configPath)).rejects.toThrow(/operations must be a non-empty/)
    const after = await readLocalInternalConfig(internalPath)
    expect(after.sourceRevision).toBe(1)
    expect(after.sourceHash).toBe(configSourceHash(V3_PRIMARY_CONFIG))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('projects enabled v3 service intent into daemon child config without treating it as a wire declaration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-services-projection-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  try {
    await initializeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    const loaded = await loadLocalConfig(configPath)
    const providerPath = loaded.daemons.find(daemon => daemon.id === 'provider')!.configPath
    await projectLocalChildConfigs(loaded.internalPath!)
    const provider = JSON.parse(await readFile(providerPath, 'utf8')) as {
      endpoint: { role: string; services?: readonly unknown[]; capabilities?: unknown }
    }
    expect(provider.endpoint).toEqual({
      role: 'provider',
      services: [{
        capabilityId: 'file-search',
        version: '1',
        operations: ['search'],
        resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }],
      }],
    })
    expect(provider.endpoint).not.toHaveProperty('capabilities')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('compiles an enabled [console] intent into a system-owned projection and removes it when disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-console-projection-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  try {
    const enabledText = `${V3_PRIMARY_CONFIG}
[console]
enabled = true
username = "admin"
passwordEnv = "AGENTTEAMS_CONSOLE_PASSWORD"
agentIds = ["provider", "receiver"]
`
    await writeLocalConfig(configPath, enabledText)
    const loaded = await loadLocalConfig(configPath)
    expect(loaded.console).toEqual({ enabled: true, configPath: join(agentteams, '.internal', 'projections', 'console.json') })
    const internal = await readLocalInternalConfig(loaded.internalPath!)
    expect(internal.console?.projectionPath).toBe(loaded.console!.configPath)
    const projection = JSON.parse(internal.console!.config!) as {
      version: number; enabled: boolean; identity: { agentId: string }; listen: { host: string; port: number; origin: string }
      auth: { username: string; passwordEnv: string }; staticRoot: string; uiRoot: string; relay: { endpoint: string }
    }
    expect(projection.version).toBe(1)
    expect(projection.enabled).toBe(true)
    expect(projection.identity.agentId).toBe('__console')
    expect(projection.listen.host).toBe('127.0.0.1')
    expect(projection.listen.port).toBeGreaterThan(0)
    expect(projection.listen.origin).toBe(`http://127.0.0.1:${projection.listen.port}`)
    expect(projection.auth).toEqual({ username: 'admin', passwordEnv: 'AGENTTEAMS_CONSOLE_PASSWORD' })
    expect(projection.staticRoot).toMatch(/console-host\/static$/)
    expect(projection.uiRoot).toMatch(/ui\/teams-console$/)
    expect(projection.relay.endpoint).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/)
    // The materialized projection is the Console child's only config source and
    // the launcher status owner's enablement evidence, so it must satisfy the
    // child loader contract. An empty environment fails on the missing
    // credential, never on an unsupported projection field.
    await projectLocalChildConfigs(loaded.internalPath!)
    await expect(loadConsoleProcessConfig(loaded.console!.configPath, {})).rejects.toThrow(/credential/)
    const persistedPort = projection.listen.port

    const reloaded = await loadLocalConfig(configPath)
    const reused = JSON.parse((await readLocalInternalConfig(reloaded.internalPath!)).console!.config!) as { listen: { port: number } }
    expect(reused.listen.port).toBe(persistedPort)

    const disabledText = `${V3_PRIMARY_CONFIG}
[console]
enabled = false
`
    await writeLocalConfig(configPath, disabledText)
    const disabled = await loadLocalConfig(configPath)
    expect(disabled.console).toBeUndefined()
    expect((await readLocalInternalConfig(disabled.internalPath!)).console).toBeUndefined()
    expect(await readFile(disabled.internalPath!, 'utf8')).not.toContain('[console]')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('round-trips [consoleRuntime] through the typed patch port without touching U2 or launcher fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-console-runtime-'))
  const internalPath = join(directory, '.agentteams', 'internal.toml')
  try {
    await mkdir(join(directory, '.agentteams'), { recursive: true })
    await writeFile(internalPath, `version = 2
sourceRevision = 4
sourceHash = "sha256:source"
sourcePath = ${JSON.stringify(join(directory, '.agentteams', 'config.toml'))}

[launcher]
pid = 101
generation = 9
startToken = "launcher-9"
state = "running"

[console]
projectionPath = ${JSON.stringify(join(directory, '.agentteams', '.internal', 'projections', 'console.json'))}
config = "{\\"version\\":1}"
`)
    await writeLocalInternalConsoleRuntime(internalPath, {
      enabled: true,
      pid: 202,
      generation: 1,
      startToken: 'console-1',
      state: 'starting',
    })
    await writeLocalInternalConsoleRuntime(internalPath, {
      enabled: true,
      pid: 202,
      generation: 1,
      startToken: 'console-1',
      state: 'online',
      url: 'http://127.0.0.1:51123',
      origin: 'http://127.0.0.1:51123',
      identityRef: 'console:local',
      error: null,
    })
    const online = await readLocalInternalConfig(internalPath)
    expect(online.consoleRuntime).toEqual({
      enabled: true,
      pid: 202,
      generation: 1,
      startToken: 'console-1',
      state: 'online',
      url: 'http://127.0.0.1:51123',
      origin: 'http://127.0.0.1:51123',
      identityRef: 'console:local',
    })
    expect(online.console).toMatchObject({ projectionPath: join(directory, '.agentteams', '.internal', 'projections', 'console.json') })
    expect(online.launcher).toMatchObject({ pid: 101, generation: 9, startToken: 'launcher-9', state: 'running' })

    await writeLocalInternalConsoleRuntime(internalPath, { enabled: true, state: 'stopped', pid: null, startToken: null, url: null, origin: null, error: null })
    const stopped = await readLocalInternalConfig(internalPath)
    expect(stopped.consoleRuntime).toMatchObject({ enabled: true, generation: 1, state: 'stopped', identityRef: 'console:local' })
    expect(stopped.console).toBeDefined()
    expect(stopped.launcher).toMatchObject({ pid: 101, generation: 9, state: 'running' })

    await expect(writeLocalInternalConsoleRuntime(internalPath, { generation: 1, state: 'online' } as never)).rejects.toThrow(/requires/)
    await expect(writeLocalInternalConsoleRuntime(internalPath, { generation: 0 })).rejects.toThrow(/generation must not move backwards/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('round-trips work control through the public internal adapter and removes only that table', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-work-control-public-'))
  const internalPath = join(directory, '.agentteams', 'internal.toml')
  try {
    await mkdir(join(directory, '.agentteams'), { recursive: true })
    await writeFile(internalPath, `version = 2
sourceRevision = 4
sourceHash = "sha256:source"
sourcePath = ${JSON.stringify(join(directory, '.agentteams', 'config.toml'))}

[launcher]
pid = 101
generation = 9
startToken = "launcher-9"
state = "running"

[daemon.provider]
enabled = true
role = "provider"
config = "{\\"version\\":1}"

[configRuntime.accepted]
[configRuntime.effective]
[configRuntime.catalogs]
`)
    const socketPath = join(directory, '.agentteams', '.internal', 'work-control.sock')
    const written = await writeLocalInternalWorkControl(internalPath, {
      socketPath,
      launcherGeneration: 9,
      launcherStartToken: 'launcher-9',
    })
    expect(written).toBe(internalPath)
    expect(await readLocalInternalWorkControl(internalPath)).toEqual({
      socketPath,
      launcherGeneration: 9,
      launcherStartToken: 'launcher-9',
    })
    const afterWrite = await readLocalInternalConfig(internalPath)
    expect(afterWrite).toMatchObject({
      sourceRevision: 4,
      sourceHash: 'sha256:source',
      launcher: { pid: 101, generation: 9, startToken: 'launcher-9', state: 'running' },
      daemons: { provider: { enabled: true, role: 'provider', config: '{"version":1}' } },
    })

    const afterRemove = await writeLocalInternalWorkControl(internalPath, undefined)
    expect(afterRemove).toBe(internalPath)
    expect(await readLocalInternalWorkControl(internalPath)).toBeUndefined()
    expect((await readFile(internalPath, 'utf8'))).not.toContain('[workControl]')
    expect(await readLocalInternalConfig(internalPath)).toMatchObject({
      sourceRevision: 4,
      launcher: { pid: 101, generation: 9, startToken: 'launcher-9', state: 'running' },
      daemons: { provider: { enabled: true, role: 'provider', config: '{"version":1}' } },
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves work control across an accepted lifecycle writer and rejects malformed or stale refs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-work-control-preserve-'))
  const internalPath = join(directory, '.agentteams', 'internal.toml')
  try {
    await mkdir(join(directory, '.agentteams'), { recursive: true })
    await writeFile(internalPath, `version = 2
sourceRevision = 4
sourceHash = "sha256:source"
sourcePath = ${JSON.stringify(join(directory, '.agentteams', 'config.toml'))}

[launcher]
pid = 101
generation = 9
startToken = "launcher-9"
state = "running"

[daemon.provider]
enabled = true
pid = 202
generation = 9
startToken = "daemon-9"
state = "online"

[configRuntime.accepted]
[configRuntime.effective]
[configRuntime.catalogs]
`)
    const socketPath = join(directory, '.agentteams', '.internal', 'work-control.sock')
    await writeLocalInternalWorkControl(internalPath, { socketPath, launcherGeneration: 9, launcherStartToken: 'launcher-9' })
    await writeLocalInternalState(internalPath, { provider: { pid: 203, generation: 10, startToken: 'daemon-10', state: 'online' } })
    expect(await readLocalInternalWorkControl(internalPath)).toEqual({ socketPath, launcherGeneration: 9, launcherStartToken: 'launcher-9' })
    expect((await readLocalInternalConfig(internalPath)).daemons?.provider).toMatchObject({ pid: 203, generation: 10 })

    await expect(writeLocalInternalWorkControl(internalPath, {
      socketPath,
      launcherGeneration: 10,
      launcherStartToken: 'launcher-9',
    })).rejects.toThrow(/exactly match launcher.generation/)
    await expect(writeLocalInternalWorkControl(internalPath, {
      socketPath,
      launcherGeneration: 9,
      launcherStartToken: 'other-token',
    })).rejects.toThrow(/exactly match launcher.startToken/)
    expect(await readLocalInternalWorkControl(internalPath)).toEqual({ socketPath, launcherGeneration: 9, launcherStartToken: 'launcher-9' })

    const malformed = await readFile(internalPath, 'utf8')
    await writeFile(internalPath, malformed.replace(socketPath, 'relative.sock'))
    await expect(readLocalInternalWorkControl(internalPath)).rejects.toThrow(/socketPath must be the fixed absolute path/)
    await expect(readLocalInternalConfig(internalPath)).rejects.toThrow(/workControl/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('resumes a pending migration to verified without rewriting legacy inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-migration-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  const legacyRelay = join(agentteams, 'relay.json')
  const sourceBefore = 'version = 2\n[relay]\nconfig = "relay.json"\n'
  const legacyRelayText = JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 49501 } })
  try {
    await mkdir(agentteams, { recursive: true })
    await writeFile(configPath, sourceBefore)
    await writeFile(legacyRelay, legacyRelayText)
    const recovery = JSON.stringify({ accepted: {}, effective: {}, catalogs: {}, bindings: {} })
    await writeFile(internalPath, `version = 2
sourceRevision = 0
sourceHash = "sha256:stale"
[migration]
formatVersion = 1
phase = "prepared"
preparedAt = "2026-10-02T00:00:00.000Z"
fromConfigVersion = 2
fromInternalVersion = 1
sourcePath = ${JSON.stringify(configPath)}
sourceBeforeHash = ${JSON.stringify(configSourceHash(sourceBefore))}
intendedSourceHash = ${JSON.stringify(configSourceHash(V3_PRIMARY_CONFIG))}
candidateConfigText = ${JSON.stringify(V3_PRIMARY_CONFIG)}
legacyInputs = [{ kind = "relay", path = ${JSON.stringify(legacyRelay)}, sha256 = ${JSON.stringify(configSourceHash(legacyRelayText))} }]
recovery = ${JSON.stringify(recovery)}
`)
    await resumePendingMigration(internalPath)
    const internal = parseToml(await readFile(internalPath, 'utf8')) as { migration: { phase: string; committedAt?: string; verifiedAt?: string } }
    expect(internal.migration.phase).toBe('verified')
    expect(internal.migration.committedAt).toBeDefined()
    expect(internal.migration.verifiedAt).toBeDefined()
    expect(await readFile(configPath, 'utf8')).toBe(V3_PRIMARY_CONFIG)
    expect(await readFile(legacyRelay, 'utf8')).toBe(legacyRelayText)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps machine source and per-daemon accepted facts separate in internal v2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-accepted-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  try {
    await writeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    await loadLocalConfig(configPath)
    const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId: 'provider' })
    const before = await persistence.loadDaemonUnlocked('provider')
    const parsedSections = parseConfigUserSections(parseToml(V3_PRIMARY_CONFIG) as Record<string, unknown>)
    const sections = { ...parsedSections, providers: { ...parsedSections.providers, rcc: { ...parsedSections.providers.rcc!, label: 'RCC updated' } } }
    const saved = await persistence.withLock(() => persistence.saveMachineSourceUnlocked({
      expectedSourceRevision: before.sourceRevision,
      expectedSourceHash: configSourceHash(V3_PRIMARY_CONFIG),
      sections,
    }))
    const afterSource = await persistence.loadDaemonUnlocked('provider')
    expect(saved.sourceRevision).toBe(before.sourceRevision + 1)
    expect(afterSource.acceptedRevision).toBe(before.acceptedRevision)
    expect(afterSource.acceptedSourceHash).not.toBe(saved.sourceHash)
    const receiver = await persistence.loadDaemonUnlocked('receiver')
    expect(receiver.acceptedRevision).toBe(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps a durable owner-fence uncertain through accepted advancement in the production TOML store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-owner-fence-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  try {
    await writeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    await loadLocalConfig(configPath)
    const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId: 'provider' })
    const before = await persistence.loadDaemonUnlocked('provider')
    const target = {
      agentId: 'provider',
      targetGeneration: before.targetGeneration,
      acceptedRevision: before.acceptedRevision,
      acceptedSourceRevision: before.acceptedSourceRevision,
      acceptedSourceHash: before.acceptedSourceHash,
      endpointFingerprint: providerIntentFingerprint(before.providers.rcc!),
    }
    const fence = {
      target,
      operation: { operationId: 'op-1', kind: 'use-session' as const },
      error: { code: 'RESULT_UNKNOWN' as const, message: 'use outcome unknown' },
      substrate: { pid: 999, effectiveRevision: before.effectiveRevision ?? 0, effectiveHandleFingerprint: 'handle-1' },
    }
    await persistence.withLock(() => persistence.saveObservationUnlocked('provider', { kind: 'owner-fence', uncertain: fence }))
    const fenced = await persistence.loadDaemonUnlocked('provider')
    expect(fenced.applyState).toBe('uncertain')

    const sections = parseConfigUserSections(parseToml(V3_PRIMARY_CONFIG) as Record<string, unknown>)
    const advanced = { ...sections, providers: { ...sections.providers, rcc: { ...sections.providers.rcc!, label: 'RCC advanced' } } }
    await persistence.withLock(async () => {
      const saved = await persistence.saveMachineSourceUnlocked({
        expectedSourceRevision: fenced.sourceRevision,
        expectedSourceHash: fenced.sourceHash,
        sections: advanced,
      })
      await persistence.acceptMachineSourceUnlocked('provider', {
        sourceRevision: saved.sourceRevision,
        sourceHash: saved.sourceHash,
        expectedAcceptedRevision: fenced.acceptedRevision,
        expectedAcceptedSourceHash: fenced.acceptedSourceHash,
      })
    })
    const afterAdvance = await persistence.loadDaemonUnlocked('provider')
    expect(afterAdvance.acceptedRevision).toBe(fenced.acceptedRevision + 1)
    expect(afterAdvance.applyState).toBe('uncertain')
    const durable = await readLocalInternalConfig(internalPath)
    expect(durable.configRuntime?.effective.provider?.uncertain).toContain('op-1')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects owner-fence overwrite and removal when the same operation id has different identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-owner-fence-cas-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  try {
    await writeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    await loadLocalConfig(configPath)
    const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId: 'provider' })
    const before = await persistence.loadDaemonUnlocked('provider')
    const target = {
      agentId: 'provider',
      targetGeneration: before.targetGeneration,
      acceptedRevision: before.acceptedRevision,
      acceptedSourceRevision: before.acceptedSourceRevision,
      acceptedSourceHash: before.acceptedSourceHash,
      endpointFingerprint: providerIntentFingerprint(before.providers.rcc!),
    }
    const fence = {
      target,
      operation: { operationId: 'op-cas', kind: 'use-session' as const },
      error: { code: 'RESULT_UNKNOWN' as const, message: 'use outcome unknown' },
      substrate: { pid: 999, effectiveRevision: before.effectiveRevision ?? 0, effectiveHandleFingerprint: 'handle-original' },
    }
    await persistence.withLock(() => persistence.saveObservationUnlocked('provider', { kind: 'owner-fence', uncertain: fence }))
    const mismatched = {
      ...fence,
      operation: { ...fence.operation, kind: 'apply' as const },
      substrate: { ...fence.substrate, effectiveHandleFingerprint: 'handle-different' },
    }
    await expect(persistence.withLock(() => persistence.saveObservationUnlocked('provider', {
      kind: 'owner-fence', uncertain: mismatched, expectedUncertain: fence,
    }))).rejects.toMatchObject({ code: 'CONFLICT' })
    const afterOverwrite = await persistence.loadDaemonUnlocked('provider') as { readonly uncertain?: readonly { readonly operation: { readonly operationId: string; readonly kind: string } }[] }
    expect(afterOverwrite.uncertain ?? []).toHaveLength(1)
    expect(afterOverwrite.uncertain?.[0]).toMatchObject({ operation: { operationId: 'op-cas', kind: 'use-session' } })

    const removal = persistence.withLock(() => persistence.saveObservationUnlocked('provider', {
      kind: 'target-observation',
      target,
      removeUncertainOperationId: 'op-cas',
      expectedUncertain: mismatched,
    }))
    await expect(removal).rejects.toMatchObject({ message: expect.stringContaining('identity does not match') })
    const durable = await readLocalInternalConfig(internalPath)
    const records = JSON.parse(durable.configRuntime?.effective.provider?.uncertain ?? '[]') as readonly { readonly operation: { readonly operationId: string } }[]
    expect(records.map(record => record.operation.operationId)).toEqual(['op-cas'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('resolves a target observation by full provider identity across multi-provider auth-none and shared-credential layouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-target-provider-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  const config = `version = 3

[bridge]
enabled = true

[agents.provider]
enabled = true
role = "provider"
label = "Provider"

[agents.provider.identity]
hostId = "local"
machineId = "local"
accountId = "local"
agentKind = "custom"
label = "Provider"

[agents.provider.runtime]
scopeId = "local"
dataDirectory = "data/provider"
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }

[providers.first]
protocol = "openai-chat"
apiBaseUrl = "https://first.example/v1"
label = "First"
enabled = true
credentialEnv = "SHARED_CREDENTIAL"

[providers.second]
protocol = "openai-chat"
apiBaseUrl = "https://second.example/v1"
label = "Second"
enabled = true
credentialEnv = "SHARED_CREDENTIAL"

[providers.none]
protocol = "openai-chat"
apiBaseUrl = "https://none.example/v1"
label = "None"
enabled = true

[[models]]
provider = "none"
id = "none-model"
label = "None model"

[agents.provider.model]
primary = { provider = "none", model = "none-model" }
`
  try {
    await writeLocalConfig(configPath, config)
    await loadLocalConfig(configPath)
    const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId: 'provider' })
    const view = await persistence.loadDaemonUnlocked('provider')
    const targetFor = (providerId: string) => {
      const provider = view.providers[providerId]
      expect(provider).toBeDefined()
      return {
        agentId: 'provider',
        targetGeneration: view.targetGeneration,
        acceptedRevision: view.acceptedRevision,
        acceptedSourceRevision: view.acceptedSourceRevision,
        acceptedSourceHash: view.acceptedSourceHash,
        endpointFingerprint: providerIntentFingerprint(provider!),
        ...(provider!.auth.kind === 'bearer' ? { credentialRef: provider!.auth.credentialRef } : {}),
      }
    }

    await persistence.withLock(() => persistence.saveObservationUnlocked('provider', {
      kind: 'target-observation', target: targetFor('none'), effectiveRevision: view.acceptedRevision, applyState: 'clean',
    }))
    const afterAuthNone = await persistence.loadDaemonUnlocked('provider')
    expect(afterAuthNone.effectiveRevision).toBe(view.acceptedRevision)

    await persistence.withLock(() => persistence.saveObservationUnlocked('provider', {
      kind: 'target-observation', target: targetFor('second'), effectiveRevision: view.acceptedRevision, applyState: 'clean',
    }))
    const afterShared = await persistence.loadDaemonUnlocked('provider')
    expect(afterShared.effectiveRevision).toBe(view.acceptedRevision)

    const beforeMismatch = await readFile(internalPath)
    await expect(persistence.withLock(() => persistence.saveObservationUnlocked('provider', {
      kind: 'target-observation',
      target: { ...targetFor('none'), endpointFingerprint: 'sha256:missing-provider' },
    }))).rejects.toMatchObject({ message: expect.stringContaining('APPLY_TARGET_MISMATCH') })
    expect(await readFile(internalPath)).toEqual(beforeMismatch)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects corrupt or unsafe persisted internal projection ports without rewriting internal.toml', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-v3-invalid-internal-port-'))
  const agentteams = join(directory, '.agentteams')
  const configPath = join(agentteams, 'config.toml')
  const internalPath = join(agentteams, 'internal.toml')
  const relayProjection = join(agentteams, '.internal', 'projections', 'relay.json')
  const writeInternal = async (relayConfig: string) => writeFile(internalPath, `version = 2
sourceRevision = 0
sourceHash = "sha256:stale"
sourcePath = ${JSON.stringify(configPath)}

[relay]
projectionPath = ${JSON.stringify(relayProjection)}
config = ${JSON.stringify(relayConfig)}
`)
  try {
    await writeLocalConfig(configPath, V3_PRIMARY_CONFIG)
    for (const relayConfig of [
      '{not-json',
      JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 70000 } }),
      JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 1.5 } }),
      JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 0 } }),
    ]) {
      await writeInternal(relayConfig)
      const before = await readFile(internalPath)
      await expect(loadLocalConfig(configPath)).rejects.toBeInstanceOf(Error)
      expect(await readFile(internalPath)).toEqual(before)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
