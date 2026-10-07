import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { classifyLocalConsoleStatus, createLocalSupervisor, localDaemonStatusProjectionPath, localWorkControlSocketPath } from './local-supervisor.ts'
import { planLocalProcesses } from './local-supervisor.ts'
import { loadLocalConfig, readLocalInternalConfig, writeLocalConfig, writeLocalInternalConsoleRuntime, writeLocalInternalLauncherState } from './local-config.ts'
import { sendLocalWorkControlRequest } from './local-work-control.ts'
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

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
  }
}

it('stops without waiting for a receiver that never answers an in-flight Work request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-stop-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    const forwarded = join(root, 'forwarded-work-frame')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    // The receiver publishes a live status projection and accepts the forwarded
    // Work frame, records that it arrived and then never answers it. This is the
    // real public boundary of the local Work ingress: the launcher owns the
    // socket and forwards to the receiver child over IPC.
    await writeFile(agent, `import { writeFileSync } from 'node:fs'
const generation = 1
process.send?.({ kind: 'daemon.status', endpoint: { agentId: 'receiver',
  identity: { hostId: 'receiver-host', machineId: 'machine', agentId: 'receiver', accountId: 'account', agentKind: 'custom', label: 'Receiver' },
  role: 'receiver', presence: 'online', state: 'online', generation, capabilities: [] } })
process.send?.({ kind: 'daemon.registered', agentId: 'receiver', generation })
process.on('message', message => { if (message?.kind === 'work.control') writeFileSync(${JSON.stringify(forwarded)}, 'forwarded') })
setInterval(() => {}, 1000)
process.once('SIGTERM', () => process.exit(0))
`)
    await writeFile(join(root, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48021 } }))
    await writeLocalConfig(join(root, 'config.toml'), `version = 2

[relay]
config = "relay.json"

[endpoints.receiver]
role = "receiver"
identity = { hostId = "receiver-host", machineId = "machine", agentId = "receiver", accountId = "account", agentKind = "custom", label = "Receiver" }
scopeId = "scope"
dataDirectory = "data/receiver"
leasePort = 48121
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
connect = { targetAgentId = "provider", capabilityId = "file-search", capabilityVersion = "1", operation = "search", demands = [{ resourceId = "slot", amount = 1 }] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = ".", profilePrefix = "teams-receiver" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
    const config = await loadLocalConfig(join(root, 'config.toml'))
    const startToken = 'stop-with-inflight-work'
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: 1, startToken, state: 'starting' })
    const supervisor = createLocalSupervisor(config, { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 4000, stopTimeoutMs: 3000, startToken })
    await supervisor.start()
    expect(supervisor.state()).toBe('running')

    const inFlight = sendLocalWorkControlRequest({
      socketPath: localWorkControlSocketPath(config.internalPath!),
      frame: {
        kind: 'work.submit',
        requestId: 'corr-inflight',
        control: {
          receiverAgentId: 'receiver',
          expectedLauncherGeneration: supervisor.generation(),
          startToken,
          executionId: 'execution-inflight',
          attemptId: 'attempt-inflight',
          workId: 'work-inflight',
          requestId: 'request-inflight',
        },
        business: { text: 'never answered' },
      },
      timeoutMs: 120_000,
    })
    // The forward is only in flight once the receiver child has the frame. The
    // receiver never replies, so the launcher is waiting on the 120s forwarding
    // timeout when stop arrives.
    await expect(waitForFile(forwarded)).resolves.toBe('forwarded')

    const startedAt = Date.now()
    await supervisor.stop()
    const elapsedMs = Date.now() - startedAt

    expect(supervisor.state()).toBe('stopped')
    // Releasing the in-flight forward must not wait for the receiver reply, so
    // stop stays far below the forwarding timeout and still terminates children.
    expect(elapsedMs).toBeLessThan(5000)
    await expect(inFlight).resolves.toMatchObject({ kind: 'work.error', error: { code: 'LOCAL_CONTROL_UNAVAILABLE' } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not report online for a non-owned process or a closed Console listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-console-ownership-'))
  const childPath = join(root, 'console.mjs')
  let child: ReturnType<typeof spawn> | undefined
  try {
    await writeFile(childPath, 'setInterval(() => {}, 1000)\nprocess.once("SIGTERM", () => process.exit(0))\n')
    const startToken = 'console-owned-token'
    const projectionPath = join(root, 'console.json')
    await writeFile(projectionPath, JSON.stringify({ enabled: true }))
    child = spawn(process.execPath, [childPath, '--config', projectionPath, '--launcher-start-token', startToken], { stdio: 'ignore' })
    await once(child, 'spawn')
    const baseConfig = {
      version: 3 as const,
      configPath: join(root, 'config.toml'),
      internalPath: join(root, 'internal.toml'),
      relay: { enabled: true, configPath: join(root, 'relay.json') },
      daemons: [],
      console: { enabled: true as const, configPath: projectionPath },
      bridge: { enabled: true },
    }
    const internal = {
      version: 2 as const,
      daemons: {},
      console: { projectionPath, config: JSON.stringify({ enabled: true }) },
      consoleRuntime: {
        enabled: true,
        pid: child.pid,
        generation: 1,
        startToken,
        entryPath: childPath,
        state: 'online' as const,
        url: 'http://127.0.0.1:1',
        origin: 'http://127.0.0.1:1',
        identityRef: 'console:local',
      },
    }
    await expect(classifyLocalConsoleStatus(baseConfig, internal)).resolves.toMatchObject({ state: 'failed' })
    expect((await classifyLocalConsoleStatus(baseConfig, internal)).pid).toBeUndefined()
    const reusedPid = {
      ...internal,
      consoleRuntime: {
        ...internal.consoleRuntime,
        pid: process.pid,
        entryPath: childPath,
        startToken,
      },
    }
    await expect(classifyLocalConsoleStatus(baseConfig, reusedPid)).resolves.toMatchObject({ state: 'failed' })
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
