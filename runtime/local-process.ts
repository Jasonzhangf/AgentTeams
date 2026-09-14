import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { open, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createLocalSupervisor, type LocalSupervisor } from './local-supervisor.ts'
import { defaultLocalConfigPath, loadLocalConfig, readLocalInternalConfig, writeLocalInternalLauncherState, writeLocalInternalRecoveryState, type LocalConfig, type LocalInternalLauncherConfig } from './local-config.ts'

const execFile = promisify(execFileCallback)

export interface LocalLauncherStatus {
  readonly configPath: string
  readonly internalPath: string
  readonly pid?: number
  readonly generation: number
  readonly state: 'stopped' | 'starting' | 'running' | 'failed'
  readonly error?: string
}

export class LocalProcessError extends Error {
  constructor(readonly code: 'NOT_RUNNING' | 'STALE_GENERATION' | 'STALE_OWNER' | 'START_TIMEOUT' | 'ALREADY_RUNNING' | 'STARTING', message: string) {
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
  readonly startupTimeoutMs?: number
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

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function processCommand(pid: number): Promise<string | undefined> {
  try { return (await execFile('ps', ['-p', String(pid), '-o', 'command='])).stdout }
  catch { return undefined }
}

function splitProcessCommand(command: string): readonly string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\' && quote !== "'") { escaped = true; continue }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) {
      if (current.length > 0) { args.push(current); current = '' }
    } else current += character
  }
  if (escaped) current += '\\'
  if (current.length > 0) args.push(current)
  return args
}

function processOwnsConfigCommand(command: string, configPath: string, entryPath: string, startToken: string | undefined): boolean {
  if (startToken === undefined) return false
  const args = splitProcessCommand(command)
  const entryIndex = args.findIndex(argument => resolve(argument) === resolve(entryPath))
  return entryIndex >= 0 && args[entryIndex + 1] === '--config' && args[entryIndex + 2] === resolve(configPath) && args[entryIndex + 3] === '--launcher-start-token' && args[entryIndex + 4] === startToken
}

async function processOwnsStartToken(pid: number, startToken: string | undefined, configPath: string): Promise<boolean> {
  if (startToken === undefined) return false
  const command = await processCommand(pid)
  if (command === undefined) return false
  const args = splitProcessCommand(command)
  const entryPath = fileURLToPath(import.meta.url)
  const entryIndex = args.findIndex(argument => resolve(argument) === resolve(entryPath))
  return entryIndex >= 0 && args[entryIndex + 1] === '--config' && args[entryIndex + 2] === resolve(configPath) && args[entryIndex + 3] === '--start-token' && args[entryIndex + 4] === startToken
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

async function stopOwnedDescendants(internal: Awaited<ReturnType<typeof readLocalInternalConfig>>): Promise<void> {
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

async function recoverDeadLauncher(internalPath: string, configPath: string, internal: Awaited<ReturnType<typeof readLocalInternalConfig>>, launcher: LocalInternalLauncherConfig, state: 'stopped' | 'failed' = launcher.state === 'failed' ? 'failed' : 'stopped'): Promise<void> {
  try {
    await stopOwnedLauncher(configPath, launcher)
    await stopOwnedDescendants(internal)
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
    })
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
    if (last?.state === expected && (expected === 'stopped' || (expected === 'failed' ? !processAlive(last.pid) : processAlive(last.pid) && await processOwnsStartToken(last.pid, last.startToken, configPath)))) {
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
      await recoverDeadLauncher(config.internalPath!, config.configPath, current, current.launcher, 'stopped')
    }
    const latest = await readLocalInternalConfig(config.internalPath!)
    const nextGeneration = (latest.launcher?.generation ?? 0) + 1
    const startToken = randomUUID()
    await writeLocalInternalLauncherState(config.internalPath!, { pid: 0, generation: nextGeneration, startToken, state: 'starting' })
    const childEnv = { ...process.env, ...options.env }
    if (options.relayEntry !== undefined) childEnv.TEAMS_LOCAL_RELAY_ENTRY = options.relayEntry
    if (options.agentEntry !== undefined) childEnv.TEAMS_LOCAL_AGENT_ENTRY = options.agentEntry
    const childNodeArguments = options.nodeArguments ?? sourceNodeArguments()
    if (childNodeArguments.length > 0) childEnv.TEAMS_LOCAL_NODE_ARGUMENTS = childNodeArguments.join('\0')
    childEnv.TEAMS_LOCAL_START_TOKEN = startToken
    childEnv.TEAMS_LOCAL_LAUNCHER_GENERATION = String(nextGeneration)
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
  const config = await loadLocalConfig(configPath)
  if (config.internalPath === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no runtime internal state')
  const internal = await readLocalInternalConfig(config.internalPath)
  const launcher = internal.launcher
  if (launcher === undefined) return { configPath: config.configPath, internalPath: config.internalPath, generation: 0, state: 'stopped' }
  if (launcher.state === 'running' && launcher.pid !== undefined && !processAlive(launcher.pid)) {
    return { configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: 'local supervisor pid is not alive' }
  }
  if (launcher.state === 'running' && launcher.pid !== undefined && !(await processOwnsStartToken(launcher.pid, launcher.startToken, config.configPath))) {
    return { configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: 'failed', error: 'local supervisor start token does not match persisted ownership' }
  }
  return { configPath: config.configPath, internalPath: config.internalPath, pid: launcher.pid, generation: launcher.generation, state: launcher.state, ...(launcher.error === undefined ? {} : { error: launcher.error }) }
}

export async function stopLocalProcess(configPath = defaultLocalConfigPath(), expectedGeneration?: number): Promise<LocalLauncherStatus> {
  const config = await loadLocalConfig(configPath)
  if (config.internalPath === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no runtime internal state')
  return await withLauncherStartLock(config.internalPath, async () => {
    const internal = await readLocalInternalConfig(config.internalPath!)
    const launcher = internal.launcher
    if (launcher === undefined || launcher.state === 'stopped') return { configPath: config.configPath, internalPath: config.internalPath!, generation: launcher?.generation ?? 0, state: 'stopped' as const }
    if (launcher.state === 'starting' && launcher.pid === 0) {
      throw new LocalProcessError('STARTING', `local supervisor generation=${launcher.generation} has not published a PID`)
    }
    if (expectedGeneration !== undefined && expectedGeneration !== launcher.generation) {
      throw new LocalProcessError('STALE_GENERATION', `stale local supervisor generation expected=${expectedGeneration} current=${launcher.generation}`)
    }
    if (launcher.pid === undefined || launcher.pid <= 0 || !processAlive(launcher.pid)) {
      await recoverDeadLauncher(config.internalPath!, config.configPath, internal, launcher)
      return { configPath: config.configPath, internalPath: config.internalPath!, generation: launcher.generation, state: launcher.state === 'failed' ? 'failed' : 'stopped' as const, ...(launcher.error === undefined ? {} : { error: launcher.error }) }
    }
    if (!(await processOwnsStartToken(launcher.pid, launcher.startToken, config.configPath))) {
      throw new LocalProcessError('STALE_OWNER', `local supervisor pid=${launcher.pid} does not match its persisted start token`)
    }
    process.kill(launcher.pid, 'SIGTERM')
    return await waitForLauncherState(config.internalPath!, config.configPath, launcher.state === 'failed' ? 'failed' : 'stopped')
  })
}

export interface LocalConfiguredWorkResult {
  readonly configPath: string
  readonly agentId: string
  readonly workId: string
  readonly requestId: string
  readonly state: 'succeeded'
}

export async function runLocalConfiguredWork(configPath = defaultLocalConfigPath(), env: NodeJS.ProcessEnv = process.env): Promise<LocalConfiguredWorkResult> {
  const config: LocalConfig = await loadLocalConfig(configPath)
  const receiver = config.daemons.find(daemon => daemon.enabled && daemon.connection !== undefined)
  if (receiver?.connection === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no enabled receiver connection intent')
  if (config.internalPath === undefined) throw new LocalProcessError('NOT_RUNNING', 'local config has no runtime internal state')
  const before = await statusLocalProcess(configPath)
  const running = before.state === 'running' ? before : await startLocalProcess(configPath, { env })
  const expectedGeneration = running.generation
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const internal = await readLocalInternalConfig(config.internalPath)
    const record = internal.configuredWork
    if (record?.generation === expectedGeneration && record.workId === receiver.connection.workId && record.requestId === receiver.connection.requestId) {
      return { configPath: config.configPath, agentId: record.agentId, workId: record.workId, requestId: record.requestId, state: record.state }
    }
    const launcher = await statusLocalProcess(configPath)
    if (launcher.state === 'failed') throw new LocalProcessError('NOT_RUNNING', launcher.error ?? 'local configured Work failed')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new LocalProcessError('START_TIMEOUT', 'local configured Work did not complete')
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runLocalProcess().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
