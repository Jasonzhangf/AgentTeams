import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadAgentProcessConfig } from './agent-process.ts'

it('loads an optional managed OpenCode owner without putting credentials in the config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-agent-config-'))
  const configPath = join(directory, 'agent.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    identity: { hostId: 'host', machineId: 'machine', agentId: 'agent', accountId: 'account', agentKind: 'custom', label: 'Agent' },
    scopeId: 'scope', dataDirectory: './data', leasePort: 48001, presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [], allowedManagers: ['manager'] },
    cli: { camoExecutable: '/bin/camo', searchExecutable: '/usr/bin/rg', searchRoot: './files', profilePrefix: 'teams' },
    openCode: { executable: '/opt/opencode', directory: './opencode', configFile: './config.json', port: 48002, startupTimeoutMs: 5000, stopTimeoutMs: 2000 },
    relay: { endpoint: 'wss://relay.example.test', credentialEnv: 'TEAMS_RELAY', connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 1000, maxMessageBytes: 1000, maxBufferedBytes: 1000, maxPendingFrames: 4, maxPendingRequests: 4, maxDataConnections: 2 },
  }))
  try {
    const loaded = await loadAgentProcessConfig(configPath, { TEAMS_RELAY: 'relay-secret' })
    expect(loaded.openCode).toEqual({ executable: '/opt/opencode', directory: join(directory, 'opencode'), configFile: join(directory, 'config.json'), port: 48002, startupTimeoutMs: 5000, stopTimeoutMs: 2000 })
  } finally { await rm(directory, { recursive: true }) }
})

it('loads an explicit Agent-owned direct listener without mixing relay configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-agent-direct-config-'))
  const configPath = join(directory, 'agent.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    identity: { hostId: 'host', machineId: 'machine', agentId: 'agent', accountId: 'account', agentKind: 'custom', label: 'Agent' },
    scopeId: 'scope', dataDirectory: './data', leasePort: 48001, presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    cli: { camoExecutable: '/opt/camo', searchExecutable: '/opt/rg', searchRoot: './search', profilePrefix: 'teams' },
    relay: { endpoint: 'wss://relay.example', credentialEnv: 'RELAY_AUTH', connectTimeoutMs: 1000,
      admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536,
      maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
    directListener: {
      host: '127.0.0.1', port: 8443, keyFile: './direct-key.pem', certFile: './direct-cert.pem', credentialEnv: 'DIRECT_AUTH',
      target: { hostId: 'host', agentId: 'agent', protocolVersion: 1, capabilitiesRevision: 'cap-3' },
      maxPayload: 65536, maxConnections: 8, maxMessageBytes: 32768, maxBufferedBytes: 65536,
      maxPendingFrames: 16, helloTimeoutMs: 1000,
    },
  }))
  try {
    const loaded = await loadAgentProcessConfig(configPath, { RELAY_AUTH: 'Bearer relay', DIRECT_AUTH: 'Bearer direct' })
    expect(loaded.directListener).toEqual({
      host: '127.0.0.1', port: 8443, keyFile: join(directory, 'direct-key.pem'), certFile: join(directory, 'direct-cert.pem'),
      credential: 'Bearer direct',
      admissions: [],
      target: { hostId: 'host', agentId: 'agent', protocolVersion: 1, capabilitiesRevision: 'cap-3' },
      maxPayload: 65536, maxConnections: 8, maxMessageBytes: 32768, maxBufferedBytes: 65536,
      maxPendingFrames: 16, helloTimeoutMs: 1000,
    })
  } finally { await rm(directory, { recursive: true }) }
})

it('rejects a direct listener target identity that differs from the Agent declaration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-agent-direct-identity-'))
  const configPath = join(directory, 'agent.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    identity: { hostId: 'host', machineId: 'machine', agentId: 'agent', accountId: 'account', agentKind: 'custom', label: 'Agent' },
    scopeId: 'scope', dataDirectory: './data', leasePort: 48001, presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    cli: { camoExecutable: '/opt/camo', searchExecutable: '/opt/rg', searchRoot: './search', profilePrefix: 'teams' },
    relay: { endpoint: 'wss://relay.example', credentialEnv: 'RELAY_AUTH', connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
    directListener: { host: '127.0.0.1', port: 8443, keyFile: './key.pem', certFile: './cert.pem', credentialEnv: 'DIRECT_AUTH',
      target: { hostId: 'other-host', agentId: 'agent', protocolVersion: 1, capabilitiesRevision: 'cap-1' },
      maxPayload: 1024, maxConnections: 1, maxMessageBytes: 1024, maxBufferedBytes: 1024, maxPendingFrames: 1, helloTimeoutMs: 1000 },
  }))
  try {
    await expect(loadAgentProcessConfig(configPath, { RELAY_AUTH: 'relay', DIRECT_AUTH: 'direct' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  } finally { await rm(directory, { recursive: true }) }
})

it('loads peer-specific admissions without requiring the legacy shared credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-agent-direct-admissions-'))
  const configPath = join(directory, 'agent.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    identity: { hostId: 'host', machineId: 'machine', agentId: 'agent', accountId: 'account', agentKind: 'custom', label: 'Agent' },
    scopeId: 'scope', dataDirectory: './data', leasePort: 48001, presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: ['consumer-a', 'consumer-b'], allowedManagers: [] },
    cli: { camoExecutable: '/opt/camo', searchExecutable: '/opt/rg', searchRoot: './search', profilePrefix: 'teams' },
    relay: { endpoint: 'wss://relay.example', credentialEnv: 'RELAY_AUTH', connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
    directListener: {
      host: '127.0.0.1', port: 8443, keyFile: './direct-key.pem', certFile: './direct-cert.pem',
      admissions: [
        { admissionRef: 'direct-a', agentId: 'consumer-a', credentialEnv: 'DIRECT_A' },
        { admissionRef: 'direct-b', agentId: 'consumer-b', credentialEnv: 'DIRECT_B' },
      ],
      target: { hostId: 'host', agentId: 'agent', protocolVersion: 1, capabilitiesRevision: 'cap-3' },
      maxPayload: 65536, maxConnections: 8, maxMessageBytes: 32768, maxBufferedBytes: 65536,
      maxPendingFrames: 16, helloTimeoutMs: 1000,
    },
  }))
  try {
    const loaded = await loadAgentProcessConfig(configPath, { RELAY_AUTH: 'Bearer relay', DIRECT_A: 'Bearer a', DIRECT_B: 'Bearer b' })
    expect(loaded.directListener).toMatchObject({ credential: '', admissions: [
      { admissionRef: 'direct-a', agentId: 'consumer-a', credential: 'Bearer a' },
      { admissionRef: 'direct-b', agentId: 'consumer-b', credential: 'Bearer b' },
    ] })
  } finally { await rm(directory, { recursive: true }) }
})
