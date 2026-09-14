import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { writeLocalConfig } from './local-config.ts'
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
    const stopped = await stopLocalProcess(path, first.generation)
    expect(stopped).toMatchObject({ state: 'stopped', generation: 1 })
    const second = await startLocalProcess(path, { relayEntry: relay, agentEntry: agent, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000 })
    expect(second).toMatchObject({ state: 'running', generation: 2 })
    expect(second.generation).toBeGreaterThan(first.generation)
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
