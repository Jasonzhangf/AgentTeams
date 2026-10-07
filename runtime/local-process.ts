import { spawn, type ChildProcess } from 'node:child_process'
import { open, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { classifyLocalConsoleStatus, createLocalSupervisor, readLocalDaemonStatusProjection, type LocalDaemonEndpointProjection, type LocalSupervisor } from './local-supervisor.ts'
import { defaultLocalConfigPath, loadLocalConfig, readLocalInternalConfig, writeLocalInternalConsoleRuntime, writeLocalInternalLauncherState, writeLocalInternalRecoveryState, type LocalInternalLauncherConfig } from './local-config.ts'
import { processAlive, processCommand, processOwnsConfigCommand } from './local-ownership.ts'
import { sendLocalConsoleControlRequest, type LocalConsoleControlKind, type LocalConsolePublicStatus } from './local-work-control.ts'

export interface LocalLauncherStatus {
  readonly configPath: string
  readonly internalPath: string
  readonly pid?: number
  readonly generation: number
  readonly state: 'stopped' | 'starting' | 'running' | 'failed'
  readonly error?: string
  readonly endpoints?: readonly LocalDaemonEndpointProjection[]
  readonly console?: LocalConsolePublicStatus
}

export class LocalProcessError extends Error {
  constructor(readonly code: 'NOT_RUNNING' | 'STALE_GENERATION' | 'STALE_OWNER' | 'START_TIMEOUT' | 'ALREADY_RUNNING' | 'STARTING' | 'INVALID_STATUS' | 'CONSOLE_NOT_RUNNING' | 'CONSOLE_DISABLED' | 'CONSOLE_CREDENTIAL_MISSING' | 'CONSOLE_PORT_OCCUPIED' | 'CONSOLE_ASSET_MISSING' | 'CONSOLE_RETAINED' | 'CONSOLE_START_FAILED' | 'CONSOLE_STATUS_UNAVAILABLE' | 'CONSOLE_PROCESS_EXITED', message: string) {
    super(message)
    this.name = 'LocalProcessError'
  }
}

export interface LocalProcessStartOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly nodeExecutable?: string
  readonly nodeArguments?: readonly string[]
  readonly relayEntry?: string
  readonly agentEntry?: string
  readonly consoleEntry?: string
  readonly startupTimeoutMs?: number
}

export interface LocalConsoleLifecycleOptions {
  /** Launcher generation guard; a mismatch returns STALE_GENERATION. */
  readonly expectedLauncherGeneration?: number
  readonly timeoutMs?: number
}

export function parseLocalProcessArgs(argv: readonly string[]): string {
  if (argv.length === 0) return defaultLocalConfigPath()
  if (argv.length === 2 && argv[0] === '--config' && argv[1].trim() !== '') return resolve(argv[1])
  if (argv.length === 4 && argv[0] === '--config' && argv[1].trim() !== '' && argv[2] === '--start-token' && argv[3].trim() !== '') return resolve(argv[1])
  if (argv.length === 1 && argv[0].startsWith('--config=') && argv[0].slice('--config='.length).trim() !== '') {
    return resolve(argv[0].slice('--config='.length))
  }
  throw new Error('usage: local-process [--config <file>]')
}

function launcherGenerationFromEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

export type LocalSupervisorFactory = (config: Awaited<ReturnType<typeof loadLocalConfig>>) => LocalSupervisor

export async function runLocalProcess(
  argv: readonly string[] = process.argv.slice(2),
  createSupervisor: LocalSupervisorFactory = config => createLocalSupervisor(config, {
    ...(process.env.TEAMS_LOCAL_RELAY_ENTRY === undefined ? {} : { relayEntry: process.env.TEAMS_LOCAL_RELAY_ENTRY }),
    ...(process.env.TEAMS_LOCAL_AGENT_ENTRY === undefined ? {} : { agentEntry: process.env.TEAMS_LOCAL_AGENT_ENTRY }),
    ...(process.env.TEAMS_LOCAL_CONSOLE_ENTRY === undefined ? {} : { consoleEntry: process.env.TEAMS_LOCAL_CONSOLE_ENTRY }),
    ...(process.env.TEAMS_LOCAL_NODE_ARGUMENTS === undefined ? {} : { nodeArguments: process.env.TEAMS_LOCAL_NODE_ARGUMENTS.split('\0').filter(Boolean) }),
    ...(process.env.TEAMS_LOCAL_START_TOKEN === undefined ? {} : { startToken: process.env.TEAMS_LOCAL_START_TOKEN }),
    ...(launcherGenerationFromEnv(process.env.TEAMS_LOCAL_LAUNCHER_GENERATION) === undefined ? {} : { launcherGeneration: launcherGenerationFromEnv(process.env.TEAMS_LOCAL_LAUNCHER_GENERATION)! }),
  }),
): Promise<void> {
  const config = await loadLocalConfig(parseLocalProcessArgs(argv))
  const supervisor = createSupervisor(config)
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (stopping) return
    stopping = supervisor.stop().catch(error => {
      process.exitCode = 1
      console.error(error instanceof Error ? error.message : String(error))
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await supervisor.start()
  console.log(`local supervisor ready config=${config.configPath} daemons=${config.daemons.filter(daemon => daemon.enabled).map(daemon => daemon.id).join(',')}`)
  let runtimeFailure: Error | undefined
  await new Promise<void>(resolveStopped => {
    const poll = () => {
      if (stopping) void stopping.finally(resolveStopped)
      else if (supervisor.state() === 'failed') {
        runtimeFailure = supervisor.failure() ?? new Error('local supervisor failed')
        stopping = supervisor.stop().catch(error => {
          process.exitCode = 1
          console.error(error instanceof Error ? error.message : String(error))
        })
        void stopping.finally(resolveStopped)
      }
      else setTimeout(poll, 50)
    }
    poll()
  })
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  if (supervisor.state() !== 'stopped') throw new Error('local supervisor did not stop')
  if (runtimeFailure) {
    process.exitCode = 1
    throw runtimeFailure
  }
}

async function processOwnsStartToken(pid: number, startToken: string | undefined, configPath: string): Promise<boolean> {
  if (startToken === undefined) return false
  const command = await processCommand(pid)
  if (command === undefined) return false
  const entryPath = fileURLToPath(import.meta.url)
  return processOwnsConfigCommand(command, configPath, entryPath, startToken, '--start-token')
}

async function waitForProcessExit(pid: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new LocalProcessError('STALE_OWNER', `owned child pid=${pid} did not exit after SIGTERM`)
}

async function stopOwnedLauncher(configPath: string, launcher: LocalInternalLauncherConfig): Promise<void> {
  const pid = launcher.pid
  if (pid === undefined || pid <= 0 || !processAlive(pid)) return
  if (!(await processOwnsStartToken(pid, launcher.startToken, configPath))) {
    throw new LocalProcessError('STALE_OWNER', `local supervisor pid=${pid} does not match its persisted start token`)
  }
  process.kill(pid, 'SIGTERM')
  await waitForProcessExit(pid, 2_000)
}

async function stopOwnedDescendants(internal: Awaited<ReturnType<typeof readLocalInternalConfig>>, consoleConfigPath?: string): Promise<void> {
  const candidates: Array<{ readonly id: string; readonly pid: number; readonly configPath: string; readonly entryPath?: string; readonly startToken?: string }> = []
  const relay = internal.daemons?.relay
  const relayPid = relay?.pid
  if (relayPid !== undefined && relayPid > 0 && internal.relay?.projectionPath !== undefined) {
    candidates.push({ id: 'relay', pid: relayPid, configPath: internal.relay.projectionPath, entryPath: relay?.entryPath, startToken: relay?.startToken })
  }
  for (const [id, daemon] of Object.entries(internal.daemons ?? {})) {
    if (id === 'relay' || daemon.pid === undefined || daemon.pid <= 0 || daemon.projectionPath === undefined) continue
    candidates.push({ id, pid: daemon.pid, configPath: daemon.projectionPath, entryPath: daemon.entryPath, startToken: daemon.startToken })
  }
  // The Console child is the only child type persisted outside `daemons`. Recovery
  // owns it too: the persisted Console port is always reused, so an orphan left
  // holding it would make every later start fail with CONSOLE_PORT_OCCUPIED while
  // no owned path is left to stop it.
  const consoleRuntime = internal.consoleRuntime
  const consolePid = consoleRuntime?.pid
  if (consolePid !== undefined && consolePid > 0) {
    // The recorded child is owned even when its projection is gone, for example after
    // the user disables Console while the child is still live. The candidate is built
    // from the runtime row and falls back to the configured projection path; when the
    // path or the ownership facts are missing the check below reports STALE_OWNER and
    // recovery keeps the child explicitly retained.
    candidates.push({ id: 'console', pid: consolePid, configPath: internal.console?.projectionPath ?? consoleConfigPath ?? '', entryPath: consoleRuntime?.entryPath, startToken: consoleRuntime?.startToken })
  }
  for (const candidate of candidates) {
    if (!processAlive(candidate.pid)) continue
    const command = await processCommand(candidate.pid)
    if (command === undefined || candidate.entryPath === undefined || !processOwnsConfigCommand(command, candidate.configPath, candidate.entryPath, candidate.startToken)) {
      throw new LocalProcessError('STALE_OWNER', `owned child pid=${candidate.pid} cannot be validated for ${candidate.id}`)
    }
    process.kill(candidate.pid, 'SIGTERM')
    await waitForProcessExit(candidate.pid, 2_000)
  }
}

async function stopRetainedConsoleRuntime(
  config: Awaited<ReturnType<typeof loadLocalConfig>>,
  internal: Awaited<ReturnType<typeof readLocalInternalConfig>>,
): Promise<void> {
  const runtime = internal.consoleRuntime
  if (runtime === undefined || runtime.state === undefined) return
  if (runtime.state === 'stopped' || runtime.state === 'disabled' || runtime.state === 'failed') return
  if (config.internalPath === undefined) return
  const projectionPath = internal.console?.projectionPath ?? config.console?.configPath
  if (runtime.pid !== undefined && processAlive(runtime.pid)) {
    if (runtime.entryPath === undefined || runtime.startToken === undefined || projectionPath === undefined) {
      const message = `retained Console pid=${runtime.pid} has incomplete ownership facts`
      await writeLocalInternalConsoleRuntime(config.internalPath, { enabled: runtime.enabled, state: 'retained', pid: runtime.pid, startToken: runtime.startToken ?? null, entryPath: runtime.entryPath ?? null, error: { code: 'CONSOLE_RETAINED', message } })
      throw new LocalProcessError('CONSOLE_RETAINED', message)
    }
    const command = await processCommand(runtime.pid)
    if (command === undefined || !processOwnsConfigCommand(command, projectionPath, runtime.entryPath, runtime.startToken)) {
      const message = `retained Console pid=${runtime.pid} does not match its persisted ownership`
      await writeLocalInternalConsoleRuntime(config.internalPath, { enabled: runtime.enabled, state: 'retained', pid: runtime.pid, startToken: runtime.startToken, entryPath: runtime.entryPath, error: { code: 'CONSOLE_RETAINED', message } })
      throw new LocalProcessError('CONSOLE_RETAINED', message)
    }
    process.kill(runtime.pid, 'SIGTERM')
    try {
      await waitForProcessExit(runtime.pid, 2_000)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await writeLocalInternalConsoleRuntime(config.internalPath, { enabled: runtime.enabled, state: 'retained', pid: runtime.pid, startToken: runtime.startToken, entryPath: runtime.entryPath, error: { code: 'CONSOLE_RETAINED', message } })
      throw new LocalProcessError('CONSOLE_RETAINED', message)
    }
  }
  await writeLocalInternalConsoleRuntime(config.internalPath, {
    enabled: runtime.enabled,
    state: 'stopped',
    pid: null,
    startToken: null,
    url: null,
    origin: null,
    error: null,
  })
}

async function recoverDeadLauncher(internalPath: string, configPath: string, internal: Awaited<ReturnType<typeof readLocalInternalConfig>>, launcher: LocalInternalLauncherConfig, state: 'stopped' | 'failed' = launcher.state === 'failed' ? 'failed' : 'stopped', consoleConfigPath?: string): Promise<void> {
  // Recovery covers the Console child as well: a recorded Console pid is stopped with
  // the launcher, and when its exit cannot be confirmed it stays explicitly retained
  // instead of being left recorded as a live child.
  const consoleRuntime = internal.consoleRuntime
  const consoleRecovery = consoleRuntime?.pid !== undefined && consoleRuntime.pid > 0
    ? { enabled: consoleRuntime.enabled ?? true, state: 'stopped' as const }
    : undefined
  try {
    await stopOwnedLauncher(configPath, launcher)
    await stopOwnedDescendants(internal, consoleConfigPath)
    const recoveredDaemons = Object.fromEntries(Object.entries(internal.daemons ?? {}).map(([id, daemon]) => [id, {
      pid: daemon.pid ?? 0,
      ...(daemon.generation === undefined ? {} : { generation: daemon.generation }),
      ...(daemon.entryPath === undefined ? {} : { entryPath: daemon.entryPath }),
      ...(daemon.startToken === undefined ? {} : { startToken: daemon.startToken }),
      state: 'stopped' as const,
    }]))
    await writeLocalInternalRecoveryState(internalPath, recoveredDaemons, {
      pid: launcher.pid ?? 0,
      generation: launcher.generation,
      ...(launcher.startToken === undefined ? {} : { startToken: launcher.startToken }),
      state,
      ...(launcher.error === undefined ? {} : { error: launcher.error }),
    }, { ...(consoleRecovery === undefined ? {} : { consoleRuntime: consoleRecovery }), clearWorkControl: true })
  } catch (error) {
    const failedDaemons = Object.fromEntries(Object.entries(internal.daemons ?? {}).map(([id, daemon]) => [id, {
      pid: daemon.pid ?? 0,
      ...(daemon.generation === undefined ? {} : { generation: daemon.generation }),
      ...(daemon.entryPath === undefined ? {} : { entryPath: daemon.entryPath }),
      ...(daemon.startToken === undefined ? {} : { startToken: daemon.startToken }),
      state: 'failed' as const,
    }]))
    await writeLocalInternalRecoveryState(internalPath, failedDaemons, {
      pid: launcher.pid ?? 0,
      generation: launcher.generation,
      ...(launcher.startToken === undefined ? {} : { startToken: launcher.startToken }),
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }, {
      ...(consoleRecovery === undefined ? {} : { consoleRuntime: {
        enabled: consoleRecovery.enabled,
        state: 'retained' as const,
        error: { code: 'CONSOLE_RETAINED', message: 'dead-launcher recovery could not confirm the Console child stopped' },
      } }),
      clearWorkControl: true,
    })
    throw error
  }
}

async function withLauncherStartLock<T>(internalPath: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${internalPath}.launcher.lock`
  let handle: Awaited<ReturnType<typeof open>>
  while (true) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ownerPid: number | undefined
      try {
        const value = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
        if (Number.isSafeInteger(value) && value > 0) ownerPid = value
      } catch { /* preserve the lock when its owner cannot be read */ }
      if (ownerPid !== undefined && !processAlive(ownerPid)) {
        await rm(lockPath, { force: true })
        continue
      }
      throw new LocalProcessError('ALREADY_RUNNING', 'local supervisor start is already in progress')
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`)
    return await task()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

async function waitForLauncherState(internalPath: string, configPath: string, expected: 'running' | 'stopped' | 'failed', deadlineMs = 10_000): Promise<LocalLauncherStatus> {
  const deadline = Date.now() + deadlineMs
  let last: LocalInternalLauncherConfig | undefined
  while (Date.now() < deadline) {
    const internal = await readLocalInternalConfig(internalPath)
    last = internal.launcher
    const terminalProcessExited = last !== undefined && last.pid > 0 && !processAlive(last.pid)
    if (last?.state === expected && (
      (expected === 'stopped' || expected === 'failed')
        ? terminalProcessExited
        : processAlive(last.pid) && await processOwnsStartToken(last.pid, last.startToken, configPath)
    )) {
      return statusFromInternal(internalPath, last)
    }
    if (last?.state === 'failed' && expected !== 'failed') throw new LocalProcessError('NOT_RUNNING', last.error ?? 'local supervisor failed')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new LocalProcessError('START_TIMEOUT', `local supervisor did not reach ${expected}: ${JSON.stringify(last ?? null)}`)
}

function statusFromInternal(internalPath: string, launcher: LocalInternalLauncherConfig | undefined): LocalLauncherStatus {
  if (launcher === undefined) return { configPath: resolve(internalPath, '..', 'config.toml'), internalPath, generation: 0, state: 'stopped' }
  return {
    configPath: resolve(internalPath, '..', 'config.toml'),
    internalPath,
    pid: launcher.pid,
    generation: launcher.generation,
    state: launcher.state,
    ...(launcher.error === undefined ? {} : { error: launcher.error }),
  }
}

function sourceNodeArguments(): readonly string[] {
  return fileURLToPath(import.meta.url).endsWith('.ts') ? ['--experimental-transform-types'] : []
}

export async function startLocalProcess(configPath = defaultLocalConfigPath(), options: LocalProcessStartOptions = {}): Promise<LocalLauncherStatus> {
  const config = await loadLocalConfig(configPath)
  if (config.internalPath === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no runtime internal state')
  return await withLauncherStartLock(config.internalPath, async () => {
    const current = await readLocalInternalConfig(config.internalPath!)
    if (current.launcher?.state === 'starting') {
      throw new LocalProcessError('ALREADY_RUNNING', `local supervisor is already starting generation=${current.launcher.generation}`)
    }
    if (current.launcher?.state === 'running' && current.launcher.pid !== undefined && current.launcher.pid > 0 && processAlive(current.launcher.pid)) {
      if (!(await processOwnsStartToken(current.launcher.pid, current.launcher.startToken, config.configPath))) {
        throw new LocalProcessError('STALE_OWNER', `local supervisor pid=${current.launcher.pid} does not match its persisted start token`)
      }
      throw new LocalProcessError('ALREADY_RUNNING', `local supervisor is already running pid=${current.launcher.pid} generation=${current.launcher.generation}`)
    }
    if (current.launcher !== undefined && current.launcher.state !== 'stopped') {
      await recoverDeadLauncher(config.internalPath!, config.configPath, current, current.launcher, 'stopped', config.console?.configPath)
    }
    const latest = await readLocalInternalConfig(config.internalPath!)
    const nextGeneration = (latest.launcher?.generation ?? 0) + 1
    const startToken = randomUUID()
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: nextGeneration, startToken, state: 'starting' })
    const childEnv = { ...process.env, ...options.env }
    if (options.relayEntry !== undefined) childEnv.TEAMS_LOCAL_RELAY_ENTRY = options.relayEntry
    if (options.agentEntry !== undefined) childEnv.TEAMS_LOCAL_AGENT_ENTRY = options.agentEntry
    if (options.consoleEntry !== undefined) childEnv.TEAMS_LOCAL_CONSOLE_ENTRY = options.consoleEntry
    const childNodeArguments = options.nodeArguments ?? sourceNodeArguments()
    if (childNodeArguments.length > 0) childEnv.TEAMS_LOCAL_NODE_ARGUMENTS = childNodeArguments.join('\0')
    childEnv.TEAMS_LOCAL_START_TOKEN = startToken
    childEnv.TEAMS_LOCAL_LAUNCHER_GENERATION = String(nextGeneration)
    childEnv.TEAMS_LOCAL_CONFIG_PATH = config.configPath
    childEnv.TEAMS_LOCAL_INTERNAL_PATH = config.internalPath!
    let child: ChildProcess | undefined
    try {
      child = spawn(options.nodeExecutable ?? process.execPath, [...childNodeArguments, fileURLToPath(import.meta.url), '--config', config.configPath, '--start-token', startToken], {
        detached: true,
        env: childEnv,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      child.unref()
    } catch (error) {
      await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: nextGeneration, startToken, state: 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    if (child.pid === undefined) {
      await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: nextGeneration, startToken, state: 'failed', error: 'detached local supervisor did not return a pid' })
      throw new LocalProcessError('NOT_RUNNING', 'detached local supervisor did not return a pid')
    }
    try {
      await writeLocalInternalLauncherState(config.internalPath!, { pid: child.pid, generation: nextGeneration, startToken, state: 'starting' })
    } catch (error) {
      try { if (processAlive(child.pid)) process.kill(child.pid, 'SIGTERM') } catch { /* preserve the persistence failure */ }
      throw error
    }
    try {
      return await waitForLauncherState(config.internalPath!, config.configPath, 'running', options.startupTimeoutMs)
    } catch (error) {
      const latest = await readLocalInternalConfig(config.internalPath!)
      if (latest.launcher?.generation === nextGeneration && latest.launcher.startToken === startToken && (latest.launcher.state === 'starting' || latest.launcher.state === 'running')) {
        await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: nextGeneration, startToken, state: 'failed', error: error instanceof Error ? error.message : String(error) })
        const childPid = child.pid
        if (childPid !== undefined && processAlive(childPid)) {
          try { process.kill(childPid, 'SIGTERM') } catch { /* preserve the original startup failure */ }
          try { await waitForProcessExit(childPid, Math.max(500, Math.min(options.startupTimeoutMs ?? 10_000, 2_000))) } catch { /* preserve the original startup failure */ }
        }
        const afterCleanup = await readLocalInternalConfig(config.internalPath!)
        if (afterCleanup.launcher?.generation === nextGeneration && afterCleanup.launcher.startToken === startToken && afterCleanup.launcher.state !== 'failed') {
          await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: nextGeneration, startToken, state: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
      }
      throw error
    }
  })
}

export async function statusLocalProcess(configPath = defaultLocalConfigPath()): Promise<LocalLauncherStatus> {
  // A launcher config or internal read failure is a general launcher error, not a Console
  // observation failure: CONSOLE_STATUS_UNAVAILABLE belongs to the Console status command.
  const config = await loadLocalConfig(configPath)
  if (config.internalPath === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no runtime internal state')
  const internal = await readLocalInternalConfig(config.internalPath)
  const launcher = internal.launcher
  // The Console classification is derived from the final launcher status, so the embedded
  // launcherState can never contradict the top-level state. An unreadable Console
  // projection is the typed observation failure, never a fabricated state or credential.
  const withConsole = async (status: LocalLauncherStatus): Promise<LocalLauncherStatus> => ({
    ...status,
    console: await consoleStatusObservation(async () =>
      await classifyLocalConsoleStatus(config, internal, process.env, { state: status.state, generation: status.generation })),
  })
  if (launcher === undefined) {
    return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, generation: 0, state: 'stopped' })
  }
  if (launcher.state === 'running' && launcher.pid !== undefined && !processAlive(launcher.pid)) {
    return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: 'local supervisor pid is not alive' })
  }
  if (launcher.state === 'running' && launcher.pid !== undefined && !(await processOwnsStartToken(launcher.pid, launcher.startToken, config.configPath))) {
    return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: 'local supervisor start token does not match persisted ownership' })
  }
  if (launcher.state === 'running') {
    const expectedChildren = ['relay', ...config.daemons.filter(daemon => daemon.enabled).map(daemon => daemon.id)]
    for (const id of expectedChildren) {
      const child = internal.daemons?.[id]
      if (child === undefined || child.state !== 'online' || child.pid === undefined || child.pid <= 0 || !processAlive(child.pid)) {
        return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: `local child ${id} is not alive` })
      }
      if (child.generation !== launcher.generation) {
        return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: `local child ${id} generation does not match launcher generation` })
      }
      const entryPath = child.entryPath
      const childConfigPath = id === 'relay' ? internal.relay?.projectionPath : child.projectionPath
      if (entryPath === undefined || childConfigPath === undefined || child.startToken === undefined) {
        return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: `local child ${id} ownership record is incomplete` })
      }
      if (child.startToken !== launcher.startToken) {
        return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: `local child ${id} start token does not match launcher ownership` })
      }
      const command = await processCommand(child.pid)
      if (command === undefined || !processOwnsConfigCommand(command, childConfigPath, entryPath, child.startToken)) {
        return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: `local child ${id} does not match persisted ownership` })
      }
    }
  }
  // The launcher remains authoritative while a new generation is starting or a
  // failure is being persisted; an older projection must not mask that state.
  // Every exit carries the classified Console fields: the frozen status keys must
  // not disappear exactly when Console observability is required.
  if (launcher.state === 'starting' || launcher.state === 'failed') {
    return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: launcher.state,
      ...(launcher.error === undefined ? {} : { error: launcher.error }) })
  }
  const projection = await readLocalDaemonStatusProjection(config.internalPath).catch(error => {
    throw new LocalProcessError('INVALID_STATUS', error instanceof Error ? error.message : String(error))
  })
  if (projection !== undefined && projection.generation !== launcher.generation) {
    throw new LocalProcessError('INVALID_STATUS', `runtime daemon status projection generation=${projection.generation} does not match launcher generation=${launcher.generation}`)
  }
  if (projection !== undefined && projection.startToken !== launcher.startToken) {
    throw new LocalProcessError('INVALID_STATUS', 'runtime daemon status projection start token does not match launcher ownership')
  }
  const endpoints = projection === undefined ? undefined : (() => {
    const enabled = config.daemons.filter(daemon => daemon.enabled)
    const enabledIds = new Set(enabled.map(daemon => daemon.id))
    for (const id of Object.keys(projection.daemons)) {
      if (!enabledIds.has(id)) throw new LocalProcessError('INVALID_STATUS', `runtime daemon status projection contains unknown daemon ${id}`)
    }
    return enabled.map(daemon => {
      const endpoint = projection.daemons[daemon.id]
      if (endpoint === undefined) throw new LocalProcessError('INVALID_STATUS', `runtime daemon status projection is missing daemon ${daemon.id}`)
      return endpoint
    })
  })()
  if (launcher.state === 'running' && endpoints === undefined) {
    throw new LocalProcessError('INVALID_STATUS', 'runtime daemon status projection is missing')
  }
  if (launcher.state === 'running' && endpoints?.some(endpoint => endpoint.state !== 'online' || endpoint.presence !== 'online')) {
    throw new LocalProcessError('INVALID_STATUS', 'runtime daemon status projection is not online')
  }
  return await withConsole({ configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: launcher.state,
    ...(launcher.error === undefined ? {} : { error: launcher.error }),
    ...(endpoints === undefined ? {} : { endpoints }) })
}

export async function stopLocalProcess(configPath = defaultLocalConfigPath(), expectedGeneration?: number): Promise<LocalLauncherStatus> {
  const config = await loadLocalConfig(configPath)
  if (config.internalPath === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no runtime internal state')
  return await withLauncherStartLock(config.internalPath, async () => {
    const internal = await readLocalInternalConfig(config.internalPath!)
    const launcher = internal.launcher
    if (launcher === undefined || launcher.state === 'stopped') {
      try {
        await stopRetainedConsoleRuntime(config, internal)
      } catch (error) {
        if (error instanceof LocalProcessError) throw error
        throw new LocalProcessError('CONSOLE_RETAINED', error instanceof Error ? error.message : String(error))
      }
      return { configPath: config.configPath, internalPath: config.internalPath!, generation: launcher?.generation ?? 0, state: 'stopped' as const }
    }
    if (launcher.state === 'starting' && launcher.pid === 0) {
      throw new LocalProcessError('STARTING', `local supervisor generation=${launcher.generation} has not published a PID`)
    }
    if (expectedGeneration !== undefined && expectedGeneration !== launcher.generation) {
      throw new LocalProcessError('STALE_GENERATION', `stale local supervisor generation expected=${expectedGeneration} current=${launcher.generation}`)
    }
    if (launcher.pid === undefined || launcher.pid <= 0 || !processAlive(launcher.pid)) {
      await recoverDeadLauncher(config.internalPath!, config.configPath, internal, launcher, undefined, config.console?.configPath)
      return { configPath: config.configPath, internalPath: config.internalPath!, generation: launcher.generation, state: launcher.state === 'failed' ? 'failed' : 'stopped' as const, ...(launcher.error === undefined ? {} : { error: launcher.error }) }
    }
    if (!(await processOwnsStartToken(launcher.pid, launcher.startToken, config.configPath))) {
      throw new LocalProcessError('STALE_OWNER', `local supervisor pid=${launcher.pid} does not match its persisted start token`)
    }
    process.kill(launcher.pid, 'SIGTERM')
    return await waitForLauncherState(config.internalPath!, config.configPath, launcher.state === 'failed' ? 'failed' : 'stopped')
  })
}

/**
 * A Console status observation that cannot read the launcher, its control socket or the
 * Console child is a typed observation failure. It never reports a silent healthy state,
 * and it never leaks an unrelated control code such as the Work socket being unavailable.
 */
async function consoleStatusObservation<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (cause) {
    throw new LocalProcessError('CONSOLE_STATUS_UNAVAILABLE', cause instanceof Error ? cause.message : String(cause))
  }
}

async function consoleControl(
  kind: LocalConsoleControlKind,
  configPath: string,
  options: LocalConsoleLifecycleOptions,
): Promise<LocalConsolePublicStatus> {
  // A status request observes; every read it needs is part of that observation.
  const config = kind === 'console.status'
    ? await consoleStatusObservation(async () => await loadLocalConfig(configPath))
    : await loadLocalConfig(configPath)
  if (config.internalPath === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no runtime internal state')
  const internalPath = config.internalPath
  // An unreadable internal file is the typed observation failure for a status request.
  const internal = kind === 'console.status'
    ? await consoleStatusObservation(async () => await readLocalInternalConfig(internalPath))
    : await readLocalInternalConfig(internalPath)
  const launcher = internal.launcher
  const launcherOwned = launcher !== undefined
    && launcher.state === 'running'
    && launcher.pid !== undefined
    && launcher.pid > 0
    && processAlive(launcher.pid)
    && await processOwnsStartToken(launcher.pid, launcher.startToken, config.configPath)
  const effectiveLauncherState: LocalLauncherStatus['state'] = launcher === undefined
    ? 'stopped'
    : launcher.state === 'running' && !launcherOwned
      ? 'failed'
      : launcher.state
  const running = effectiveLauncherState === 'running'
  if (!running) {
    if (kind === 'console.status') {
      // The generation check belongs to the status request too, so a stopped or failed
      // launcher still rejects a stale --generation instead of answering with the
      // persisted generation.
      const persistedGeneration = launcher?.generation ?? 0
      if (options.expectedLauncherGeneration !== undefined && options.expectedLauncherGeneration !== persistedGeneration) {
        throw new LocalProcessError('STALE_GENERATION', `stale local supervisor generation expected=${options.expectedLauncherGeneration} current=${persistedGeneration}`)
      }
      return await consoleStatusObservation(async () =>
        await classifyLocalConsoleStatus(config, internal, process.env, { state: effectiveLauncherState, generation: persistedGeneration }))
    }
    const reason = effectiveLauncherState === 'failed'
      ? 'launcher ownership cannot be verified'
      : 'launcher is not running'
    throw new LocalProcessError('CONSOLE_NOT_RUNNING', `${reason}; cannot ${kind === 'console.start' ? 'start' : 'stop'} Console`)
  }
  if (launcher === undefined) throw new LocalProcessError('CONSOLE_NOT_RUNNING', 'launcher is not running; cannot control Console')
  if (options.expectedLauncherGeneration !== undefined && options.expectedLauncherGeneration !== launcher.generation) {
    throw new LocalProcessError('STALE_GENERATION', `stale local supervisor generation expected=${options.expectedLauncherGeneration} current=${launcher.generation}`)
  }
  // The refs rule has one owner: reading the internal state already rejects a workControl
  // row that does not match the launcher, and the status path maps that failure to the
  // typed observation terminal above. Only presence is left to check here.
  const workControl = internal.workControl
  if (workControl === undefined) {
    const message = 'local Work control is unavailable: no running launcher published a control socket'
    if (kind === 'console.status') throw new LocalProcessError('CONSOLE_STATUS_UNAVAILABLE', message)
    throw new LocalProcessError('CONSOLE_NOT_RUNNING', message)
  }
  const send = () => sendLocalConsoleControlRequest({
    socketPath: workControl.socketPath,
    frame: {
      kind,
      correlationId: randomUUID(),
      expectedLauncherGeneration: launcher.generation,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const reply = kind === 'console.status' ? await consoleStatusObservation(send) : await send()
  if (reply.ok !== true) {
    const consoleCodes = new Set(['CONSOLE_DISABLED', 'CONSOLE_CREDENTIAL_MISSING', 'CONSOLE_PORT_OCCUPIED', 'CONSOLE_ASSET_MISSING', 'CONSOLE_RETAINED', 'CONSOLE_START_FAILED', 'CONSOLE_STATUS_UNAVAILABLE', 'CONSOLE_PROCESS_EXITED', 'STALE_GENERATION'])
    const code = consoleCodes.has(reply.error.code) ? reply.error.code as LocalProcessError['code'] : 'CONSOLE_START_FAILED'
    throw new LocalProcessError(code, reply.error.message)
  }
  return reply.status
}

export async function consoleStatusLocalProcess(configPath = defaultLocalConfigPath(), options: LocalConsoleLifecycleOptions = {}): Promise<LocalConsolePublicStatus> {
  return await consoleControl('console.status', configPath, options)
}

export async function consoleStartLocalProcess(configPath = defaultLocalConfigPath(), options: LocalConsoleLifecycleOptions = {}): Promise<LocalConsolePublicStatus> {
  return await consoleControl('console.start', configPath, options)
}

export async function consoleStopLocalProcess(configPath = defaultLocalConfigPath(), options: LocalConsoleLifecycleOptions = {}): Promise<LocalConsolePublicStatus> {
  return await consoleControl('console.stop', configPath, options)
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runLocalProcess().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
