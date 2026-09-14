import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn as spawnProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { loadLocalConfig, readLocalInternalConfig, writeLocalConfig, writeLocalInternalLauncherState, writeLocalLauncherOwnership, writeLocalInternalState } from './local-config.ts'
import { runLocalConfiguredWork, runLocalProcess, startLocalProcess, statusLocalProcess, stopLocalProcess } from './local-process.ts'
import type { LocalSupervisor } from './local-supervisor.ts'

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
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
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

it('cancels a timed-out detached startup instead of allowing a late supervisor to publish running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-timeout-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'slow-relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "setTimeout(() => { console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000) }, 500); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
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
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-starting-pid-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'slow-relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "setTimeout(() => { console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000) }, 500); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
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

it('recovers a dead launcher before restarting and stops only exact owned descendants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-recovery-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  let generation: number | undefined
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
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

it('rejects a live PID reuse even when the persisted launcher owner record matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-pid-reuse-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  let fake: ReturnType<typeof spawnProcess> | undefined
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
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
    const token = internal.launcher?.startToken
    fake = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise(resolveReady => fake?.once('spawn', resolveReady))
    expect(fake.pid).toBeGreaterThan(0)
    await writeLocalLauncherOwnership(internalPath, { version: 1, pid: fake.pid!, startToken: token! })
    await writeLocalInternalLauncherState(internalPath, { pid: fake.pid!, generation: first.generation, startToken: token!, state: 'running' })
    await expect(statusLocalProcess(path)).resolves.toMatchObject({ state: 'failed', generation: first.generation })
    fake.kill('SIGTERM')
    fake = undefined
  } finally {
    if (fake !== undefined && fake.pid !== undefined) fake.kill('SIGTERM')
    if (internalPath !== undefined) {
      try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('rejects dead-launcher recovery when a persisted child start token does not match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-identity-'))
  const path = join(root, 'config.toml')
  let internalPath: string | undefined
  let generation: number | undefined
  let agentId: string | undefined
  let agentState: Awaited<ReturnType<typeof readLocalInternalConfig>>['daemons'][string] | undefined
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
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

it('persists configured Work receipts across detached restart generations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-work-'))
  const path = join(root, 'config.toml')
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.ts')
    await writeFile(relay, "process.stdout.write('relay listening wss://127.0.0.1:1\\n'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, `
import { readFile } from 'node:fs/promises'
import { readLocalInternalConfig, writeLocalInternalConfiguredWork } from ${JSON.stringify(resolve('runtime/local-config.ts'))}
process.send?.({ kind: 'daemon.registered' })
setInterval(() => {}, 1000)
setTimeout(async () => {
  const internalPath = process.env.TEAMS_LOCAL_INTERNAL_PATH
  if (!internalPath) return
  const internal = await readLocalInternalConfig(internalPath)
  const index = process.argv.indexOf('--config')
  const configPath = process.argv[index + 1]
  const config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) as { endpoint?: { connect?: { workId?: string; requestId?: string } } } : undefined
  await writeLocalInternalConfiguredWork(internalPath, {
    agentId: 'browser',
    workId: config?.endpoint?.connect?.workId ?? 'configured-work',
    requestId: config?.endpoint?.connect?.requestId ?? 'configured-request',
    generation: internal.launcher?.generation ?? 0,
    state: 'succeeded',
  })
}, 100)
`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48011 } }))
    await writeLocalConfig(path, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "receiver"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = 48131
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }

[endpoints.browser.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
workId = "configured-work"
requestId = "configured-request"
demands = [{ resourceId = "search-slot", amount = 1 }]
payload = { query = "needle" }
`)
    const options = { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 }
    const first = await startLocalProcess(path, options)
    expect(first).toMatchObject({ state: 'running', generation: 1 })
    await expect(runLocalConfiguredWork(path)).resolves.toMatchObject({ workId: 'configured-work', requestId: 'configured-request', state: 'succeeded' })
    await stopLocalProcess(path, first.generation)
    const second = await startLocalProcess(path, options)
    expect(second).toMatchObject({ state: 'running', generation: 2 })
    await expect(runLocalConfiguredWork(path)).resolves.toMatchObject({ workId: 'configured-work', requestId: 'configured-request', state: 'succeeded' })
    await expect(stopLocalProcess(path, first.generation)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    await stopLocalProcess(path, second.generation)
  } finally {
    try { await stopLocalProcess(path) } catch { /* cleanup is best effort for test-only paths */ }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
