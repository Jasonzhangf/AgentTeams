import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultLocalConfigPath, loadLocalConfig, projectLocalChildConfigs, readLocalInternalConfig, writeLocalConfig, writeLocalInternalConfiguredWork, writeLocalInternalConfiguredWorkIfCurrent, writeLocalInternalLauncherState, writeLocalInternalState } from './local-config.ts'
import { parse as parseToml } from 'toml'

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
workId = "configured-search"
requestId = "configured-search-1"
demands = [{ resourceId = "search-slot", amount = 1 }]
payload = { query = "needle" }
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

it('rejects non-JSON TOML payload values instead of coercing them during materialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-endpoint-config-json-'))
  const path = join(directory, 'config.toml')
  try {
    await writeLocalConfig(path, `version = 2
[relay]
config = "relay.json"
[endpoints.consumer]
role = "receiver"
identity = { hostId = "host", machineId = "machine", agentId = "consumer", accountId = "account", agentKind = "custom", label = "Consumer" }
scopeId = "scope"
dataDirectory = "data"
leasePort = 48031
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-consumer" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", caFile = "relay.pem", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
[endpoints.consumer.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
workId = "configured-search"
requestId = "configured-search-1"
demands = [{ resourceId = "search-slot", amount = 1 }]
payload = 1970-01-01T00:00:00Z
`)
    await expect(loadLocalConfig(path)).rejects.toThrow(/payload.*plain JSON object|payload.*JSON/i)
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

it('serializes concurrent internal state and configured-work updates without dropping either field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-internal-write-lock-'))
  const path = join(directory, 'internal.toml')
  try {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      await Promise.all([
        writeLocalInternalState(path, { provider: { pid: 4200 + iteration, generation: iteration + 1, state: 'online' } }),
        writeLocalInternalConfiguredWork(path, { agentId: 'consumer', workId: `work-${iteration}`, requestId: `request-${iteration}`, generation: iteration + 1, state: 'succeeded' }),
      ])
      const internal = await readLocalInternalConfig(path)
      expect(internal.daemons?.provider?.generation).toBe(iteration + 1)
      expect(internal.configuredWork?.workId).toBe(`work-${iteration}`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects configured Work receipts when the launcher start control changed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-internal-stale-work-'))
  const path = join(directory, 'internal.toml')
  try {
    await writeLocalInternalLauncherState(path, { pid: 101, generation: 1, startToken: 'start-token-1', state: 'running' })
    await expect(writeLocalInternalConfiguredWorkIfCurrent(path,
      { agentId: 'consumer', workId: 'work-1', requestId: 'request-1', generation: 1, state: 'succeeded' },
      { generation: 1, startToken: 'start-token-1' })).resolves.toBe(path)
    const first = await readLocalInternalConfig(path)
    expect(first.configuredWork).toMatchObject({ workId: 'work-1', generation: 1 })

    await writeLocalInternalLauncherState(path, { pid: 102, generation: 2, startToken: 'start-token-2', state: 'running' })
    await expect(writeLocalInternalConfiguredWorkIfCurrent(path,
      { agentId: 'consumer', workId: 'work-2', requestId: 'request-2', generation: 1, state: 'succeeded' },
      { generation: 1, startToken: 'start-token-1' })).rejects.toThrow(/stale/)
    const second = await readLocalInternalConfig(path)
    expect(second.configuredWork).toMatchObject({ workId: 'work-1', generation: 1 })
    expect(second.configuredWork?.workId).not.toBe('work-2')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
