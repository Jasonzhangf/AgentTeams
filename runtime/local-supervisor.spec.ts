import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalSupervisor, localDaemonStatusProjectionPath } from './local-supervisor.ts'
import { planLocalProcesses } from './local-supervisor.ts'
import { loadLocalConfig, readLocalInternalConfig, writeLocalConfig, writeLocalInternalLauncherState } from './local-config.ts'
import type { LocalConfig } from './local-config.ts'

it('plans relay first, then only enabled independent daemons', () => {
  const config: LocalConfig = {
    version: 1,
    configPath: '/tmp/.agentteams/config.toml',
    relay: { enabled: true, configPath: '/tmp/.agentteams/relay.json' },
    daemons: [
      { id: 'browser', enabled: true, configPath: '/tmp/.agentteams/browser.json' },
      { id: 'disabled', enabled: false, configPath: '/tmp/.agentteams/disabled.json' },
      { id: 'worker', enabled: true, configPath: '/tmp/.agentteams/worker.json' },
    ],
  }
  expect(planLocalProcesses(config, { relayEntry: '/runtime/relay-process.js', agentEntry: '/runtime/agent-process.js', nodeExecutable: '/node' })).toEqual([
    { id: 'relay', kind: 'relay', entry: '/runtime/relay-process.js', args: ['--config', '/tmp/.agentteams/relay.json'] },
    { id: 'browser', kind: 'agent', entry: '/runtime/agent-process.js', args: ['--config', '/tmp/.agentteams/browser.json'] },
    { id: 'worker', kind: 'agent', entry: '/runtime/agent-process.js', args: ['--config', '/tmp/.agentteams/worker.json'] },
  ])
})

function config(root: string): LocalConfig {
  return {
    version: 1,
    configPath: join(root, 'config.toml'),
    relay: { enabled: true, configPath: join(root, 'relay.json') },
    daemons: [
      { id: 'browser', enabled: true, configPath: join(root, 'browser.json') },
      { id: 'disabled', enabled: false, configPath: join(root, 'disabled.json') },
      { id: 'worker', enabled: true, configPath: join(root, 'worker.json') },
    ],
  }
}

it('keeps the daemon status projection beside internal.toml in the canonical .internal directory', () => {
  expect(localDaemonStatusProjectionPath('/tmp/.agentteams/internal.toml')).toBe('/tmp/.agentteams/.internal/daemon-status.json')
})

it('starts relay before enabled daemons and stops the owned children reentrantly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 2000, stopTimeoutMs: 2000 })
    await supervisor.start()
    expect(supervisor.state()).toBe('running')
    await Promise.all([supervisor.start(), supervisor.start()])
    await Promise.all([supervisor.stop(), supervisor.stop()])
    expect(supervisor.state()).toBe('stopped')
    await supervisor.start()
    expect(supervisor.state()).toBe('running')
    await supervisor.stop()
    expect(supervisor.state()).toBe('stopped')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports startup failure after cleaning only children it started', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-fail-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.stderr.write('agent failed\\n'); process.exit(3)\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 2000, stopTimeoutMs: 2000 })
    await expect(supervisor.start()).rejects.toThrow(/exited before readiness/)
    expect(supervisor.state()).toBe('stopped')
    await supervisor.stop()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not report running when a child exits immediately after readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-exit-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setTimeout(() => process.exit(3), 50)\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 2000, stopTimeoutMs: 2000 })
    await expect(supervisor.start()).rejects.toThrow(/exited unexpectedly|exited during startup/)
    expect(supervisor.state()).toBe('stopped')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects startup when an earlier ready child exits during a later child startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-startup-exit-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setTimeout(() => process.exit(3), 20)\n")
    await writeFile(agent, "setTimeout(() => process.send?.({kind:'daemon.registered'}), 100); process.once('SIGTERM', () => process.exit(0))\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 1000, stopTimeoutMs: 1000 })
    await expect(supervisor.start()).rejects.toThrow(/exited unexpectedly|failed during startup/)
    expect(supervisor.state()).toBe('stopped')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not publish stopped when the final status projection cannot be written', async () => {
  // Keep the temporary root short: the launcher publishes its Work control socket
  // at <root>/.internal/work-control.sock, and macOS rejects unix socket paths
  // longer than 104 bytes with a misleading EADDRINUSE.
  const root = await mkdtemp(join(tmpdir(), 'at-projection-fail-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `
const generation = Number(process.env.TEAMS_LOCAL_LAUNCHER_GENERATION ?? 1)
process.send?.({ kind: 'daemon.status', agentId: 'browser', generation,
  endpoint: { agentId: 'browser', identity: { hostId: 'browser-host', machineId: 'machine', agentId: 'browser', accountId: 'account', agentKind: 'custom', label: 'Browser' },
    role: 'provider', presence: 'online', state: 'online', generation, capabilities: [] } })
process.send?.({ kind: 'daemon.registered', agentId: 'browser', generation })
setInterval(() => {}, 1000)
process.once('SIGTERM', () => process.exit(0))
`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48020 } }))
    await writeLocalConfig(join(root, 'config.toml'), `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48120
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const config = await loadLocalConfig(join(root, 'config.toml'))
    // The public start path reserves the launcher before the supervisor runs and
    // publishes the Work control refs only while that exact reservation is live.
    const startToken = 'projection-fail-start-token'
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: 1, startToken, state: 'starting' })
    const supervisor = createLocalSupervisor(config, { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 2000, stopTimeoutMs: 2000, startToken })
    await supervisor.start()
    const projectionPath = localDaemonStatusProjectionPath(config.internalPath!)
    await rm(projectionPath)
    await mkdir(projectionPath)

    await expect(supervisor.stop()).rejects.toThrow(/cleanup remains unconfirmed/)
    const internal = await readLocalInternalConfig(config.internalPath!)
    expect(internal.launcher).toMatchObject({ state: 'failed', error: expect.stringContaining('cleanup remains unconfirmed') })
    expect(supervisor.state()).toBe('failed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
