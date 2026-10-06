import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { projectLocalChildConfigs, readLocalInternalConfig, writeLocalConfig, writeLocalInternalConsoleRuntime, writeLocalInternalLauncherState } from './local-config.ts'
import { createLocalSupervisor, planLocalProcesses, type LocalSupervisor } from './local-supervisor.ts'

const V3_CONSOLE_CONFIG = `version = 3

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

const CONSOLE_CHILD_SOURCE = `
const { createServer } = await import('node:net')
const listener = createServer()
listener.listen(0, '127.0.0.1', () => {
  const address = listener.address()
  if (typeof address !== 'object' || address === null) throw new Error('Console listener has no TCP address')
  process.send?.({ kind: 'console.listening', url: 'http://127.0.0.1:' + address.port })
})
process.once('SIGTERM', () => listener.close(() => process.exit(0)))
setInterval(() => {}, 1000)
`

async function harness(prefix: string, options: { readonly consoleEnabled?: boolean; readonly consoleChildSource?: string } = {}) {
  // Keep the root short: the launcher publishes work-control.sock at
  // <root>/.internal/work-control.sock, and macOS rejects Unix socket paths
  // longer than 104 bytes with a misleading EADDRINUSE.
  const root = await mkdtemp(join('/tmp', prefix))
  const path = join(root, 'config.toml')
  const relay = join(root, 'relay.mjs')
  const agent = join(root, 'agent.mjs')
  const consoleChild = join(root, 'console.mjs')
  await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
  await writeFile(agent, `
process.send?.({ kind: 'daemon.status', agentId: 'provider', generation: 1,
  endpoint: { agentId: 'provider', identity: { hostId: 'local', machineId: 'local', agentId: 'provider', accountId: 'local', agentKind: 'custom', label: 'Local provider' },
    role: 'provider', presence: 'online', state: 'online', generation: 1, capabilities: [] } })
process.send?.({ kind: 'daemon.registered', agentId: 'provider', generation: 1 })
setInterval(() => {}, 1000)
process.once('SIGTERM', () => process.exit(0))
`)
  await writeFile(consoleChild, options.consoleChildSource ?? CONSOLE_CHILD_SOURCE)
  const text = options.consoleEnabled === false ? V3_CONSOLE_CONFIG.replace('enabled = true\nusername', 'enabled = false\nusername') : V3_CONSOLE_CONFIG
  await writeLocalConfig(path, text)
  const config = await (await import('./local-config.ts')).loadLocalConfig(path)
  await projectLocalChildConfigs(config.internalPath!)
  return { root, path, relay, agent, consoleChild, config }
}

function supervisorFor(harnessResult: Awaited<ReturnType<typeof harness>>, startToken = 'console-lifecycle-token'): LocalSupervisor {
  return createLocalSupervisor(harnessResult.config, {
    relayEntry: harnessResult.relay,
    agentEntry: harnessResult.agent,
    consoleEntry: harnessResult.consoleChild,
    startToken,
    startupTimeoutMs: 2_000,
    stopTimeoutMs: 2_000,
    env: { AGENTTEAMS_CONSOLE_PASSWORD: 'correct horse battery staple', AGENTTEAMS_PROVIDER_AUTH: 'provider-auth', CONSOLE_CHILD_URL: 'http://127.0.0.1:51234' },
  })
}

async function reserve(harnessResult: Awaited<ReturnType<typeof harness>>, startToken = 'console-lifecycle-token', generation = 1): Promise<void> {
  await writeLocalInternalLauncherState(harnessResult.config.internalPath!, { pid: 0, generation, startToken, state: 'starting' })
}

it('plans no Console child when [console] is missing or disabled', async () => {
  const harnessResult = await harness('teams-console-plan-disabled-', { consoleEnabled: false })
  try {
    expect(planLocalProcesses(harnessResult.config, { relayEntry: harnessResult.relay, agentEntry: harnessResult.agent, consoleEntry: harnessResult.consoleChild })
      .map(spec => spec.kind)).toEqual(['relay', 'agent'])
    expect(harnessResult.config.console).toBeUndefined()
  } finally { await rm(harnessResult.root, { recursive: true, force: true }) }
})

it('starts an enabled Console child, persists real lifecycle facts, and stops only Console', async () => {
  const harnessResult = await harness('teams-console-lifecycle-')
  const supervisor = supervisorFor(harnessResult)
  try {
    expect(planLocalProcesses(harnessResult.config, { relayEntry: harnessResult.relay, agentEntry: harnessResult.agent, consoleEntry: harnessResult.consoleChild })
      .map(spec => spec.kind)).toEqual(['relay', 'agent', 'console'])
    await reserve(harnessResult)
    await supervisor.start()
    const started = await supervisor.consoleStart()
    expect(started).toMatchObject({ enabled: true, state: 'online', generation: 1, credential: 'configured', identityRef: 'console:local' })
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(started.origin).toBe(started.url)
    const internal = await readLocalInternalConfig(harnessResult.config.internalPath!)
    expect(internal.consoleRuntime).toMatchObject({ enabled: true, state: 'online', generation: 1, url: started.url, origin: started.origin, identityRef: 'console:local' })
    expect(internal.consoleRuntime?.pid).toBeGreaterThan(0)
    const consolePid = internal.consoleRuntime!.pid!
    const daemonPid = internal.daemons?.provider?.pid
    expect(daemonPid).toBeGreaterThan(0)

    const stopped = await supervisor.consoleStop()
    expect(stopped).toMatchObject({ enabled: true, state: 'stopped', credential: 'configured' })
    expect(supervisor.state()).toBe('running')
    expect(() => process.kill(consolePid, 0)).toThrow()
    expect(() => process.kill(daemonPid!, 0)).not.toThrow()
    const afterStop = await readLocalInternalConfig(harnessResult.config.internalPath!)
    expect(afterStop.launcher).toMatchObject({ state: 'running' })
    expect(afterStop.daemons?.provider?.state).toBe('online')
    expect(afterStop.daemons?.provider?.pid).toBe(daemonPid)
  } finally {
    try { await supervisor.stop() } catch { /* best-effort cleanup for test-owned paths */ }
    await rm(harnessResult.root, { recursive: true, force: true })
  }
})

it('persists a typed failure and starts no child when the credential env is missing', async () => {
  const harnessResult = await harness('teams-console-credential-')
  const supervisor = createLocalSupervisor(harnessResult.config, {
    relayEntry: harnessResult.relay,
    agentEntry: harnessResult.agent,
    consoleEntry: harnessResult.consoleChild,
    startToken: 'console-lifecycle-token',
    startupTimeoutMs: 2_000,
    stopTimeoutMs: 2_000,
    env: { AGENTTEAMS_PROVIDER_AUTH: 'provider-auth' },
  })
  try {
    await reserve(harnessResult)
    await supervisor.start()
    await expect(supervisor.consoleStart()).rejects.toMatchObject({ code: 'CONSOLE_CREDENTIAL_MISSING' })
    const internal = await readLocalInternalConfig(harnessResult.config.internalPath!)
    expect(internal.consoleRuntime).toMatchObject({ enabled: true, state: 'failed', error: { code: 'CONSOLE_CREDENTIAL_MISSING' } })
    expect(internal.consoleRuntime?.pid).toBeUndefined()
  } finally {
    try { await supervisor.stop() } catch { /* best-effort cleanup for test-owned paths */ }
    await rm(harnessResult.root, { recursive: true, force: true })
  }
})

it('reports a typed failure and preserves the persisted port when the Console port is occupied', async () => {
  const harnessResult = await harness('teams-console-occupied-')
  const { createServer } = await import('node:net')
  const occupied = createServer()
  const supervisor = supervisorFor(harnessResult)
  try {
    await reserve(harnessResult)
    await supervisor.start()
    const before = await readLocalInternalConfig(harnessResult.config.internalPath!)
    const projection = JSON.parse(before.console!.config!) as { listen: { port: number } }
    const persistedPort = projection.listen.port
    await new Promise<void>(resolve => occupied.listen(persistedPort, '127.0.0.1', resolve))
    const childWithOccupiedPort = await harness('teams-console-occupied-child-')
    try {
      const failing = harnessResult.consoleChild.replace('51234', String(persistedPort))
      await writeFile(harnessResult.consoleChild, `
const { createServer } = await import('node:net')
const server = createServer()
server.listen(${persistedPort}, '127.0.0.1', () => {})
server.once('error', error => { console.error('EADDRINUSE', error.message); process.exit(1) })
setInterval(() => {}, 1000)
`)
      const replacement = createLocalSupervisor(harnessResult.config, {
        relayEntry: harnessResult.relay,
        agentEntry: harnessResult.agent,
        consoleEntry: harnessResult.consoleChild,
        startToken: 'console-lifecycle-token',
        startupTimeoutMs: 5_000,
        stopTimeoutMs: 2_000,
        env: { AGENTTEAMS_CONSOLE_PASSWORD: 'secret', AGENTTEAMS_PROVIDER_AUTH: 'provider-auth' },
      })
      await replacement.start()
      await expect(replacement.consoleStart()).rejects.toMatchObject({ code: 'CONSOLE_PORT_OCCUPIED' })
      const after = await readLocalInternalConfig(harnessResult.config.internalPath!)
      expect((JSON.parse(after.console!.config!) as { listen: { port: number } }).listen.port).toBe(persistedPort)
      expect(after.consoleRuntime).toMatchObject({ state: 'failed' })
      await replacement.stop()
    } finally { await rm(childWithOccupiedPort.root, { recursive: true, force: true }) }
  } finally {
    await new Promise<void>(resolve => occupied.close(() => resolve()))
    try { await supervisor.stop() } catch { /* best-effort cleanup for test-owned paths */ }
    await rm(harnessResult.root, { recursive: true, force: true })
  }
}, 15_000)

it('rejects a stale Console generation without rewriting durable facts', async () => {
  const harnessResult = await harness('teams-console-stale-')
  const supervisor = supervisorFor(harnessResult)
  try {
    await reserve(harnessResult)
    await supervisor.start()
    await supervisor.consoleStart()
    await expect(supervisor.consoleStop(99)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    const internal = await readLocalInternalConfig(harnessResult.config.internalPath!)
    expect(internal.consoleRuntime).toMatchObject({ state: 'online', generation: 1 })
  } finally {
    try { await supervisor.stop() } catch { /* best-effort cleanup for test-owned paths */ }
    await rm(harnessResult.root, { recursive: true, force: true })
  }
}, 15_000)

it('serializes Console start and stop so a queued stop cannot be overtaken by a late start', async () => {
  const harnessResult = await harness('teams-console-serialize-')
  const supervisor = supervisorFor(harnessResult)
  try {
    await reserve(harnessResult)
    await supervisor.start()
    // Start and stop are issued together. The single lifecycle owner must run
    // them in order, so the stop observes and terminates the started child
    // instead of racing ahead of the spawn and leaving an orphaned Console.
    const starting = supervisor.consoleStart()
    const stopping = supervisor.consoleStop()
    await Promise.allSettled([starting, stopping])
    const internal = await readLocalInternalConfig(harnessResult.config.internalPath!)
    expect(internal.consoleRuntime).toMatchObject({ state: 'stopped' })
    expect(internal.consoleRuntime?.pid).toBeUndefined()
    expect(supervisor.state()).toBe('running')
  } finally {
    try { await supervisor.stop() } catch { /* best-effort cleanup for test-owned paths */ }
    await rm(harnessResult.root, { recursive: true, force: true })
  }
}, 20_000)

it('never spawns a second Console child while it still owns a live one', async () => {
  const harnessResult = await harness('teams-console-single-owner-')
  const supervisor = supervisorFor(harnessResult)
  try {
    await reserve(harnessResult)
    await supervisor.start()
    const started = await supervisor.consoleStart()
    const ownedPid = (await readLocalInternalConfig(harnessResult.config.internalPath!)).consoleRuntime!.pid!
    // The child is still alive and owned by this launcher, but its durable state
    // is no longer online. A second start must not replace it: the persisted
    // identity would move to the new child while the first one keeps the reused
    // Console port with no owner left to stop it.
    await writeLocalInternalConsoleRuntime(harnessResult.config.internalPath!, {
      enabled: true,
      state: 'retained',
      error: { code: 'CONSOLE_RETAINED', message: 'Console exit was unconfirmed' },
    })
    await expect(supervisor.consoleStart()).rejects.toMatchObject({ code: 'CONSOLE_RETAINED' })
    const internal = await readLocalInternalConfig(harnessResult.config.internalPath!)
    expect(internal.consoleRuntime).toMatchObject({ state: 'retained', pid: ownedPid, url: started.url })
    expect(() => process.kill(ownedPid, 0)).not.toThrow()
  } finally {
    try { await supervisor.stop() } catch { /* best-effort cleanup for test-owned paths */ }
    await rm(harnessResult.root, { recursive: true, force: true })
  }
}, 15_000)
