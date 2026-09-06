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
