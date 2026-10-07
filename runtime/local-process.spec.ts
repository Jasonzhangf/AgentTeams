import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn as spawnProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { loadLocalConfig, projectLocalChildConfigs, readLocalInternalConfig, writeLocalConfig, writeLocalInternalConsoleRuntime, writeLocalInternalLauncherState, writeLocalInternalWorkControl, writeLocalLauncherOwnership, writeLocalInternalState } from './local-config.ts'
import { consoleStatusLocalProcess, runLocalProcess, startLocalProcess, statusLocalProcess, stopLocalProcess } from './local-process.ts'
import type { LocalSupervisor } from './local-supervisor.ts'

const persistedAgentReadySource = `
const generation = Number(process.env.TEAMS_LOCAL_LAUNCHER_GENERATION ?? 1)
process.send?.({ kind: 'daemon.registered', agentId: 'browser', generation })
process.send?.({ kind: 'daemon.status', agentId: 'browser', generation,
  endpoint: { agentId: 'browser', identity: { hostId: 'browser-host', machineId: 'machine', agentId: 'browser', accountId: 'account', agentKind: 'custom', label: 'Browser' },
    role: 'provider', presence: 'online', state: 'online', generation, capabilities: [] } })
`

it('reports launcher=stopped for console status without inventing online state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-console-status-stopped-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, `version = 3

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
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }

[console]
enabled = true
username = "admin"
passwordEnv = "AGENTTEAMS_CONSOLE_PASSWORD"
`)
    const status = await consoleStatusLocalProcess(path)
    expect(status).toMatchObject({
      enabled: true,
      state: 'stopped',
      launcherState: 'stopped',
      launcherGeneration: 0,
    })
    expect(status).not.toHaveProperty('url')
    expect(status).not.toHaveProperty('pid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('classifies the Console fields in every launcher status state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-console-status-fields-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const internalPath = (await loadLocalConfig(path)).internalPath!
    await projectLocalChildConfigs(internalPath)
    // A reservation that has not published a pid: the frozen console keys must not
    // disappear exactly when Console observability is required.
    await writeLocalInternalLauncherState(internalPath, { pid: 0, generation: 1, startToken: 'reserved-token', state: 'starting' })
    const starting = await statusLocalProcess(path)
    expect(starting).toMatchObject({ state: 'starting' })
    expect(starting.console).toMatchObject({ enabled: true, launcherState: 'starting', launcherGeneration: 1 })
    await writeLocalInternalLauncherState(internalPath, { pid: 0, generation: 2, startToken: 'failed-token', state: 'failed', error: 'supervisor start failed' })
    const failed = await statusLocalProcess(path)
    expect(failed).toMatchObject({ state: 'failed', error: 'supervisor start failed' })
    expect(failed.console).toMatchObject({ enabled: true, launcherState: 'failed', launcherGeneration: 2 })
    // A live supervisor whose ownership token no longer matches keeps them too.
    await writeLocalInternalLauncherState(internalPath, { pid: process.pid, generation: 3, startToken: 'stale-token', state: 'running' })
    const stale = await statusLocalProcess(path)
    expect(stale).toMatchObject({ state: 'failed' })
    expect(stale.console).toMatchObject({ enabled: true, launcherGeneration: 3 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('turns a post-ready supervisor failure into cleanup and a nonzero launcher result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-'))
  const path = join(root, 'config.toml')
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await writeLocalConfig(path, `version = 1

[relay]
config = "relay.json"

[daemons.browser]
config = "browser.json"
`)
    let state: LocalSupervisor['state'] extends () => infer S ? S : never = 'stopped'
    let stopped = false
    const failure = new Error('child exited unexpectedly')
    const supervisor: LocalSupervisor = {
      state: () => state,
      failure: () => state === 'failed' ? failure : undefined,
      processes: () => [],
      generation: () => 0,
      start: async () => { state = 'running'; setTimeout(() => { state = 'failed' }, 10) },
      stop: async () => { stopped = true; state = 'stopped' },
    }
    await expect(runLocalProcess(['--config', path], () => supervisor)).rejects.toThrow(failure.message)
    expect(stopped).toBe(true)
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = previousExitCode
    await rm(root, { recursive: true, force: true })
  }
})

it('starts detached, reports persisted status, rejects stale stop, and survives caller return', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-detached-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `
process.send?.({ kind: 'daemon.status', agentId: 'browser', generation: 1,
  endpoint: { agentId: 'browser', identity: { hostId: 'browser-host', machineId: 'machine', agentId: 'browser', accountId: 'account', agentKind: 'custom', label: 'Browser' },
    role: 'provider', presence: 'online', state: 'online', generation: 1,
    capabilities: [{ capabilityId: 'file-search', version: '1', operations: ['search'], resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }] }] } })
process.send?.({kind:'daemon.registered', agentId: 'browser', generation: 1})
setInterval(() => {}, 1000)
process.once('SIGTERM', () => process.exit(0))
`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48010 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48101
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const first = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    expect(first).toMatchObject({ state: 'running', generation: 1 })
    expect(await statusLocalProcess(path)).toMatchObject({ state: 'running', generation: 1 })
    await expect(stopLocalProcess(path, 99)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    const firstInternal = await readLocalInternalConfig(first.internalPath)
    const firstLauncher = firstInternal.launcher
    expect(firstLauncher?.pid).toBeGreaterThan(0)
    expect(firstLauncher?.startToken).toBeTypeOf('string')
    await writeLocalInternalLauncherState(first.internalPath, {
      pid: firstLauncher!.pid!, generation: first.generation, startToken: firstLauncher!.startToken!, state: 'failed', error: 'cleanup remains unconfirmed',
    })
    const second = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    expect(second).toMatchObject({ state: 'running', generation: 2 })
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(() => process.kill(firstLauncher!.pid!, 0)).toThrow()
    await stopLocalProcess(path, second.generation)
  } finally {
    try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('keeps daemon state on the launcher generation and rejects stale writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-gen-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `${persistedAgentReadySource}setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48017 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48107
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const first = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    const firstInternal = await readLocalInternalConfig(first.internalPath)
    expect(firstInternal.daemons?.browser?.generation).toBe(first.generation)
    await stopLocalProcess(path, first.generation)

    const second = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    const secondInternal = await readLocalInternalConfig(second.internalPath)
    expect(secondInternal.daemons?.browser?.generation).toBe(second.generation)
    await writeLocalInternalState(second.internalPath, {
      browser: { pid: secondInternal.daemons?.browser?.pid ?? 0, generation: first.generation, state: 'online' },
    })
    const guarded = await readLocalInternalConfig(second.internalPath)
    expect(guarded.daemons?.browser).toMatchObject({ generation: second.generation, state: 'online' })
    await stopLocalProcess(path, second.generation)
  } finally {
    try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('cancels a timed-out detached startup instead of allowing a late supervisor to publish running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-timeout-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'slow-relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "setTimeout(() => { console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000) }, 500); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `${persistedAgentReadySource}setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48012 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48102
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    await expect(startLocalProcess(path, { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 50 })).rejects.toMatchObject({ code: 'START_TIMEOUT' })
    await expect(statusLocalProcess(path)).resolves.toMatchObject({ state: 'failed' })
  } finally {
    try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

it('persists the detached supervisor PID during the startup window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-pid-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'slow-relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "setTimeout(() => { console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000) }, 500); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `${persistedAgentReadySource}setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48016 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48106
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const config = await loadLocalConfig(path)
    expect(config.internalPath).toBeTypeOf('string')
    const starting = startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    let observedPid: number | undefined
    for (let attempt = 0; attempt < 50 && observedPid === undefined; attempt += 1) {
      try {
        const internal = await readLocalInternalConfig(config.internalPath!)
        if (internal.launcher?.state === 'starting' && internal.launcher.pid !== undefined && internal.launcher.pid > 0) observedPid = internal.launcher.pid
      } catch { /* reservation may not have been written yet */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    }
    const resolved = await starting
    const internal = await readLocalInternalConfig(resolved.internalPath)
    expect(internal.launcher?.pid).toBeGreaterThan(0)
    expect(observedPid).toBeGreaterThan(0)
    await stopLocalProcess(path, resolved.generation)
  } finally {
    try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('fails status explicitly when a persisted endpoint projection is missing or malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-status-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `
    process.send?.({ kind: 'daemon.status', agentId: 'browser', generation: 1,
  endpoint: { agentId: 'browser', identity: { hostId: 'browser-host', machineId: 'machine', agentId: 'browser', accountId: 'account', agentKind: 'custom', label: 'Browser' },
    role: 'provider', presence: 'online', state: 'online', generation: 1,
    capabilities: [{ capabilityId: 'file-search', version: '1', operations: ['search'],
      resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }] }] } })
process.send?.({ kind: 'daemon.registered', agentId: 'browser', generation: 1 })
setInterval(() => {}, 1000)
process.once('SIGTERM', () => process.exit(0))
`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48018 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48108
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const started = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    const projected = await statusLocalProcess(path)
    expect(projected.endpoints).toEqual([{
      agentId: 'browser',
      identity: { hostId: 'browser-host', machineId: 'machine', agentId: 'browser', accountId: 'account', agentKind: 'custom', label: 'Browser' },
      role: 'provider',
      presence: 'online',
      state: 'online',
      generation: 1,
      capabilities: [{ capabilityId: 'file-search', version: '1', operations: ['search'],
        resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }] }],
    }])
    const internal = await readLocalInternalConfig(started.internalPath)
    expect(internal.daemons?.browser?.state).toBe('online')
    const projectionPath = join(root, '.internal', 'daemon-status.json')
    expect(JSON.parse(await readFile(projectionPath, 'utf8'))).toMatchObject({
      version: 1, generation: 1, daemons: { browser: { agentId: 'browser', role: 'provider', presence: 'online' } },
    })
    await rm(projectionPath)
    await expect(statusLocalProcess(path)).rejects.toMatchObject({ code: 'INVALID_STATUS' })
    await stopLocalProcess(path, started.generation)

    await writeFile(projectionPath, JSON.stringify({
      version: 1, generation: 1, daemons: { browser: { agentId: 'browser', capabilities: 'not-an-array' } },
    }))
    await expect(statusLocalProcess(path)).rejects.toMatchObject({ code: 'INVALID_STATUS' })
  } finally {
    try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('recovers a dead launcher before restarting and stops only exact owned descendants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-recovery-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  let generation: number | undefined
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `${persistedAgentReadySource}setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48013 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48103
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const options = { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 }
    const first = await startLocalProcess(path, options)
    internalPath = first.internalPath
    generation = first.generation
    const internal = await readLocalInternalConfig(internalPath)
    const launcherPid = internal.launcher?.pid
    const childPids = Object.values(internal.daemons ?? {}).map(state => state.pid).filter((pid): pid is number => pid !== undefined && pid > 0)
    expect(launcherPid).toBeGreaterThan(0)
    expect(childPids.length).toBeGreaterThanOrEqual(2)
    process.kill(launcherPid!, 'SIGKILL')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    const restarted = await startLocalProcess(path, options)
    expect(restarted.generation).toBe(generation! + 1)
    for (const pid of childPids) expect(() => process.kill(pid, 0)).toThrow()
    await expect(stopLocalProcess(path, restarted.generation)).resolves.toMatchObject({ state: 'stopped', generation: restarted.generation })
    const recovered = await readLocalInternalConfig(internalPath)
    expect(recovered.launcher?.state).toBe('stopped')
    for (const state of Object.values(recovered.daemons ?? {})) expect(state.state).toBe('stopped')
  } finally {
    if (internalPath !== undefined) {
      try { await stopLocalProcess(path, generation) } catch { /* cleanup is best effort for test-only paths */ }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

const V3_CONSOLE_RECOVERY_CONFIG = `version = 3

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
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }

[console]
enabled = true
username = "admin"
passwordEnv = "AGENTTEAMS_CONSOLE_PASSWORD"
`

it('recovers the orphaned Console child when the launcher dies abnormally', async () => {
  const root = await mkdtemp(join('/tmp', 'at-recovery-console-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  let generation: number | undefined
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    const consoleChild = join(root, 'console.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `
process.send?.({ kind: 'daemon.registered', agentId: 'provider', generation: 1 })
process.send?.({ kind: 'daemon.status', agentId: 'provider', generation: 1,
  endpoint: { agentId: 'provider', identity: { hostId: 'local', machineId: 'local', agentId: 'provider', accountId: 'local', agentKind: 'custom', label: 'Local provider' },
    role: 'provider', presence: 'online', state: 'online', generation: 1, capabilities: [] } })
setInterval(() => {}, 1000)
process.once('SIGTERM', () => process.exit(0))
`)
    await writeFile(consoleChild, "process.send?.({ kind: 'console.listening', url: 'http://127.0.0.1:51234' }); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const options = {
      relayEntry: relay,
      agentEntry: agent,
      consoleEntry: consoleChild,
      nodeArguments: ['--experimental-transform-types'],
      startupTimeoutMs: 5000,
      env: { AGENTTEAMS_CONSOLE_PASSWORD: 'correct horse battery staple', AGENTTEAMS_PROVIDER_AUTH: 'provider-auth' },
    }
    const first = await startLocalProcess(path, options)
    internalPath = first.internalPath
    generation = first.generation
    const internal = await readLocalInternalConfig(internalPath)
    const launcherPid = internal.launcher?.pid
    const consolePid = internal.consoleRuntime?.pid
    expect(launcherPid).toBeGreaterThan(0)
    expect(internal.consoleRuntime).toMatchObject({ enabled: true, state: 'online', entryPath: consoleChild })
    expect(consolePid).toBeGreaterThan(0)

    process.kill(launcherPid!, 'SIGKILL')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    const restarted = await startLocalProcess(path, options)
    expect(restarted.generation).toBe(generation! + 1)
    // Recovery owns the Console child too: the persisted Console port is always
    // reused, so an orphan left holding it would fail every later start with
    // CONSOLE_PORT_OCCUPIED while no owned path remains to stop it.
    expect(() => process.kill(consolePid!, 0)).toThrow()
    await expect(stopLocalProcess(path, restarted.generation)).resolves.toMatchObject({ state: 'stopped', generation: restarted.generation })
    const recovered = await readLocalInternalConfig(internalPath)
    expect(recovered.consoleRuntime).toMatchObject({ state: 'stopped', entryPath: consoleChild })
    expect(recovered.consoleRuntime?.pid).toBeUndefined()
    expect(recovered.launcher?.state).toBe('stopped')
    for (const state of Object.values(recovered.daemons ?? {})) expect(state.state).toBe('stopped')
  } finally {
    if (internalPath !== undefined) {
      try { await stopLocalProcess(path, generation) } catch { /* cleanup is best effort for test-only paths */ }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('rejects a live PID reuse even when the persisted launcher owner record matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-reuse-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  let fake: ReturnType<typeof spawnProcess> | undefined
  let originalLauncher: Awaited<ReturnType<typeof readLocalInternalConfig>>['launcher']
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `${persistedAgentReadySource}setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48015 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48105
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const first = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    internalPath = first.internalPath
    const internal = await readLocalInternalConfig(internalPath)
    originalLauncher = internal.launcher
    const token = internal.launcher?.startToken
    fake = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise(resolveReady => fake?.once('spawn', resolveReady))
    expect(fake.pid).toBeGreaterThan(0)
    await writeLocalLauncherOwnership(internalPath, { version: 1, pid: fake.pid!, startToken: token! })
    await writeLocalInternalLauncherState(internalPath, { pid: fake.pid!, generation: first.generation, startToken: token!, state: 'running' })
    const reused = await statusLocalProcess(path)
    expect(reused).toMatchObject({ state: 'failed', generation: first.generation })
    // The embedded Console view is classified from the final launcher state, so it can
    // never contradict the top-level ownership verdict.
    expect(reused.console.launcherState).toBe('failed')
  } finally {
    if (fake !== undefined && fake.exitCode === null && fake.signalCode === null) {
      const fakeProcess = fake
      const fakeExited = new Promise<void>(resolveExit => fakeProcess.once('exit', () => resolveExit()))
      fakeProcess.kill('SIGTERM')
      await fakeExited
    }
    if (internalPath !== undefined && originalLauncher?.pid !== undefined) {
      await writeLocalLauncherOwnership(internalPath, { version: 1, pid: originalLauncher.pid, startToken: originalLauncher.startToken! })
      await writeLocalInternalLauncherState(internalPath, originalLauncher)
      await stopLocalProcess(path, originalLauncher.generation)
      let exited = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try { process.kill(originalLauncher.pid, 0) } catch { exited = true; break }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
      }
      expect(exited).toBe(true)
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('rejects a live child persisted under a different launcher generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-gen-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `${persistedAgentReadySource}setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48019 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48109
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const started = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    internalPath = started.internalPath
    const internal = await readLocalInternalConfig(internalPath)
    const child = internal.daemons?.browser
    if (child?.pid === undefined || child.entryPath === undefined || child.startToken === undefined) throw new Error('browser child ownership was not persisted')
    await writeLocalInternalState(internalPath, {
      browser: { pid: child.pid, entryPath: child.entryPath, startToken: child.startToken, state: 'online', generation: started.generation + 1 },
    })
    await expect(statusLocalProcess(path)).resolves.toMatchObject({ state: 'failed', error: expect.stringContaining('generation') })
  } finally {
    if (internalPath !== undefined) {
      try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('rejects dead-launcher recovery when a persisted child start token does not match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-owner-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  let generation: number | undefined
  let agentId: string | undefined
  let agentState: Awaited<ReturnType<typeof readLocalInternalConfig>>['daemons'][string] | undefined
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `${persistedAgentReadySource}setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48014 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48104
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const first = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    internalPath = first.internalPath
    generation = first.generation
    const internal = await readLocalInternalConfig(internalPath)
    const launcherPid = internal.launcher?.pid
    const agentEntry = Object.entries(internal.daemons ?? {}).find(([id]) => id !== 'relay')
    expect(agentEntry).toBeDefined()
    agentId = agentEntry?.[0]
    agentState = agentEntry?.[1]
    expect(launcherPid).toBeGreaterThan(0)
    expect(agentState?.pid).toBeGreaterThan(0)
    process.kill(launcherPid!, 'SIGKILL')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    await writeLocalInternalState(internalPath, {
      [agentId!]: { pid: agentState!.pid!, state: 'online', ...(agentState!.generation === undefined ? {} : { generation: agentState!.generation }), entryPath: agentState!.entryPath!, startToken: 'wrong-token' },
    })
    await expect(stopLocalProcess(path, generation)).rejects.toMatchObject({ code: 'STALE_OWNER' })
    const failed = await readLocalInternalConfig(internalPath)
    expect(failed.launcher?.state).toBe('failed')
    expect(() => process.kill(agentState!.pid!, 0)).not.toThrow()
    await writeLocalInternalState(internalPath, {
      [agentId!]: { pid: agentState!.pid!, state: 'online', ...(agentState!.generation === undefined ? {} : { generation: agentState!.generation }), ...(agentState!.entryPath === undefined ? {} : { entryPath: agentState!.entryPath }), ...(agentState!.startToken === undefined ? {} : { startToken: agentState!.startToken }) },
    })
    await expect(stopLocalProcess(path, generation)).resolves.toMatchObject({ state: 'failed', generation })
    expect(() => process.kill(agentState!.pid!, 0)).toThrow()
  } finally {
    if (internalPath !== undefined) {
      try { await stopLocalProcess(path, generation) } catch { /* cleanup is best effort for test-only paths */ }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('stops a retained Console child when the launcher is already stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-retained-console-'))
  const path = join(root, 'config.toml')
  const childPath = join(root, 'retained-console.mjs')
  let child: ReturnType<typeof spawnProcess> | undefined
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const config = await loadLocalConfig(path)
    const startToken = 'retained-console-token'
    await writeFile(childPath, 'setInterval(() => {}, 1000)\nprocess.once("SIGTERM", () => process.exit(0))\n')
    child = spawnProcess(process.execPath, [
      childPath,
      '--config',
      config.console!.configPath,
      '--launcher-start-token',
      startToken,
    ], { stdio: 'ignore' })
    await new Promise<void>(resolveSpawn => child?.once('spawn', resolveSpawn))
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: 1, startToken: 'stopped-launcher', state: 'stopped' })
    await writeLocalInternalConsoleRuntime(config.internalPath!, {
      enabled: true,
      pid: child.pid,
      generation: 1,
      startToken,
      entryPath: childPath,
      state: 'retained',
      error: { code: 'CONSOLE_RETAINED', message: 'Console exit was unconfirmed' },
    })

    await expect(stopLocalProcess(path)).resolves.toMatchObject({ state: 'stopped' })
    expect(() => process.kill(child!.pid!, 0)).toThrow()
    const recovered = await readLocalInternalConfig(config.internalPath!)
    expect(recovered.consoleRuntime).toMatchObject({ enabled: true, state: 'stopped' })
    expect(recovered.consoleRuntime?.pid).toBeUndefined()
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>(resolveExit => child?.once('exit', resolveExit))
    }
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('keeps Console status read-only and independent from daemon projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-console-independent-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const config = await loadLocalConfig(path)
    const consoleProjection = config.console!.configPath
    const daemonProjection = config.daemons[0]!.configPath
    await mkdir(daemonProjection, { recursive: true })

    await expect(consoleStatusLocalProcess(path)).resolves.toMatchObject({
      enabled: true,
      state: 'stopped',
      launcherState: 'stopped',
    })
    expect(existsSync(consoleProjection)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not report a dead launcher as running in Console status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-console-dead-launcher-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const config = await loadLocalConfig(path)
    const dead = spawnProcess(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    await new Promise<void>(resolveExit => dead.once('exit', resolveExit))
    await writeLocalInternalLauncherState(config.internalPath!, {
      pid: dead.pid!,
      generation: 1,
      startToken: 'dead-launcher-token',
      state: 'running',
    })

    await expect(consoleStatusLocalProcess(path)).resolves.toMatchObject({
      launcherState: 'failed',
      launcherGeneration: 1,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('reports an unobservable Console status as CONSOLE_STATUS_UNAVAILABLE', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-console-status-unavailable-'))
  const path = join(root, 'config.toml')
  let owner: ReturnType<typeof spawnProcess> | undefined
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const config = await loadLocalConfig(path)
    const startToken = 'console-status-token'
    // The launcher is genuinely owned by this pid, but no server ever listened on the
    // control socket it published, so the Console state cannot be observed at all.
    owner = spawnProcess(process.execPath, [
      '-e',
      'setInterval(()=>{},1e3)',
      new URL('./local-process.ts', import.meta.url).pathname,
      '--config',
      config.configPath,
      '--start-token',
      startToken,
    ], { stdio: 'ignore' })
    await new Promise<void>(resolveSpawn => owner?.once('spawn', resolveSpawn))
    await writeLocalInternalLauncherState(config.internalPath!, { pid: owner.pid!, generation: 1, startToken, state: 'running' })
    // A missing control row is an unreadable observation too, not a stopped launcher.
    await expect(consoleStatusLocalProcess(path, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'CONSOLE_STATUS_UNAVAILABLE' })
    await writeLocalInternalWorkControl(config.internalPath!, {
      socketPath: join(dirname(config.internalPath!), '.internal', 'work-control.sock'),
      launcherGeneration: 1,
      launcherStartToken: startToken,
    })

    // An unreadable observation is a typed CONSOLE_STATUS_UNAVAILABLE, never the
    // unrelated Work control code and never a silent healthy state.
    await expect(consoleStatusLocalProcess(path, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'CONSOLE_STATUS_UNAVAILABLE' })
  } finally {
    if (owner !== undefined && owner.exitCode === null && owner.signalCode === null) {
      owner.kill('SIGTERM')
      await new Promise<void>(resolveExit => owner?.once('exit', resolveExit))
    }
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('rejects a stale Console generation while the launcher is stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-console-status-stale-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const config = await loadLocalConfig(path)
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: 4, startToken: 'stopped-launcher', state: 'stopped' })

    // The generation check belongs to the status request in every launcher state, so a
    // stopped launcher still rejects a stale --generation instead of answering.
    await expect(consoleStatusLocalProcess(path, { expectedLauncherGeneration: 9 })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    await expect(consoleStatusLocalProcess(path, { expectedLauncherGeneration: 4 })).resolves.toMatchObject({ launcherGeneration: 4 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('never records a stopped Console when recovery cannot confirm its exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-console-recovery-unconfirmed-'))
  const path = join(root, 'config.toml')
  let child: ReturnType<typeof spawnProcess> | undefined
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const enabled = await loadLocalConfig(path)
    const startToken = 'recovery-console-token'
    const entryPath = join(root, 'console-entry.mjs')
    await writeFile(entryPath, 'setInterval(()=>{},1e3)\nprocess.once("SIGTERM", () => process.exit(0))\n')
    child = spawnProcess(process.execPath, [entryPath, '--config', enabled.console!.configPath, '--launcher-start-token', startToken], { stdio: 'ignore' })
    await new Promise<void>(resolveSpawn => child?.once('spawn', resolveSpawn))
    await writeLocalInternalConsoleRuntime(enabled.internalPath!, {
      enabled: true,
      pid: child.pid,
      generation: 1,
      startToken,
      entryPath,
      state: 'online',
      url: 'http://127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      identityRef: 'console:local',
    })
    // The user disables Console while the child is still live. Reloading drops the
    // internal projection and carries the runtime row forward, so recovery sees a
    // recorded child with no projection path and cannot confirm its exit.
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG.replace('[console]\nenabled = true', '[console]\nenabled = false'))
    const disabled = await loadLocalConfig(path)
    await writeLocalInternalLauncherState(disabled.internalPath!, { pid: 0, generation: 1, startToken: 'dead-launcher-token', state: 'running' })

    // The unconfirmed child is reported and kept, never silently recorded as stopped.
    await expect(stopLocalProcess(path)).rejects.toMatchObject({ code: 'STALE_OWNER' })
    const recovered = await readLocalInternalConfig(disabled.internalPath!)
    expect(recovered.consoleRuntime).toMatchObject({ state: 'retained', error: { code: 'CONSOLE_RETAINED' } })
    expect(() => process.kill(child!.pid!, 0)).not.toThrow()
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>(resolveExit => child?.once('exit', resolveExit))
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('keeps a general launcher state read failure out of the Console terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-status-console-general-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const config = await loadLocalConfig(path)
    await writeFile(config.internalPath!, 'not = = toml')
    // The typed Console terminal belongs to the Console status command. A general launcher
    // state read failure must stay a launcher error instead of masquerading as it.
    await expect(statusLocalProcess(path)).rejects.not.toMatchObject({ code: 'CONSOLE_STATUS_UNAVAILABLE' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('surfaces a retained Console child while [console] is disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-console-retained-disabled-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG.replace('[console]\nenabled = true', '[console]\nenabled = false'))
    const config = await loadLocalConfig(path)
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: 1, startToken: 'dead-launcher-token', state: 'running' })
    // The user disabled Console while its child was still live, so a recorded child still
    // holds the port. `disabled` would claim there is no child responsibility left.
    await writeLocalInternalConsoleRuntime(config.internalPath!, {
      state: 'retained',
      pid: process.pid,
      generation: 1,
      error: { code: 'CONSOLE_RETAINED', message: 'Console child exit is unconfirmed' },
    })
    await expect(consoleStatusLocalProcess(path)).resolves.toMatchObject({ enabled: false, state: 'retained' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('maps a mismatched work control row and a malformed internal state to CONSOLE_STATUS_UNAVAILABLE for Console status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-console-work-control-stale-'))
  const path = join(root, 'config.toml')
  try {
    await writeLocalConfig(path, V3_CONSOLE_RECOVERY_CONFIG)
    const config = await loadLocalConfig(path)
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: 1, startToken: 'console-stale-owner-token', state: 'running' })
    await writeLocalInternalWorkControl(config.internalPath!, {
      socketPath: join(dirname(config.internalPath!), '.internal', 'work-control.sock'),
      launcherGeneration: 1,
      launcherStartToken: 'console-stale-owner-token',
    })
    // The published control row keeps an older launcher generation than the persisted
    // launcher. The status request must return the typed observation terminal instead of
    // leaking a raw config error out of the control reader.
    const internalText = await readFile(config.internalPath!, 'utf8')
    await writeFile(config.internalPath!, internalText.replace('launcherGeneration = 1', 'launcherGeneration = 2'))
    await expect(consoleStatusLocalProcess(path)).rejects.toMatchObject({ code: 'CONSOLE_STATUS_UNAVAILABLE' })
    // A malformed internal state is the same typed terminal.
    await writeFile(config.internalPath!, 'not = = toml')
    await expect(consoleStatusLocalProcess(path)).rejects.toMatchObject({ code: 'CONSOLE_STATUS_UNAVAILABLE' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
