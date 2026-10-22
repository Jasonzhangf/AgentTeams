import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDaemonConfigText, resolveDaemonIntent, type DaemonIntentV4, type RegistryDaemonIntent } from '../config/daemon-intent.ts'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createGroupHub } from '../server/group-hub.ts'
import { groupPaths, readJsonFile, writeJsonFile } from '../server/group-store.ts'
import type { GroupHubSnapshot } from '../server/group-hub.ts'
import {
  RegistryIntentFault,
  createRegistryRelayOptions,
  loadRegistryCredentials,
  resolveRegistryServerPlan,
} from '../server/registry-intent.ts'
import { processAlive, processCommand, processOwnsConfigCommand } from './local-ownership.ts'

/**
 * Runtime single writer for the local registry companion. It composes the
 * server-owned Relay directory (`server/Relay`) from one v4 registry config and
 * owns that daemon's lifecycle: one process, one PID, one state file, explicit
 * stop. It never starts a second daemon, never rewrites the config, and never
 * reuses the control daemon's lifecycle.
 *
 * This file is both the parent lifecycle entry and the detached child entry,
 * exactly like `runtime/local-process.ts`.
 */
const STATE_VERSION = 1
const STATE_FILE_NAME = 'registry-state.json'
const TOKEN_FLAG = '--launcher-start-token'

export type RegistryDaemonLifecycleState = 'starting' | 'running' | 'failed' | 'stopped'

export interface RegistryDaemonState {
  readonly version: typeof STATE_VERSION
  readonly configPath: string
  readonly entryPath: string
  readonly daemonId: string
  readonly startToken: string
  readonly generation: number
  readonly pid: number
  readonly state: RegistryDaemonLifecycleState
  readonly url?: string
  readonly error?: string
  readonly updatedAt: string
}

export interface RegistryDaemonStatus {
  readonly configPath: string
  readonly statePath: string
  readonly daemonId: string
  readonly state: RegistryDaemonLifecycleState
  readonly generation: number
  readonly pid?: number
  readonly url?: string
  readonly error?: string
}

export type RegistryProcessErrorCode =
  | 'INVALID_CONFIG'
  | 'ALREADY_RUNNING'
  | 'START_TIMEOUT'
  | 'STOP_TIMEOUT'
  | 'STALE_GENERATION'
  | 'STALE_OWNER'
  | 'INVALID_STATUS'

export class RegistryProcessError extends Error {
  constructor(readonly code: RegistryProcessErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RegistryProcessError'
  }
}

export interface RegistryDaemonStartOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly nodeExecutable?: string
  readonly nodeArguments?: readonly string[]
  readonly startupTimeoutMs?: number
}

export interface RegistryProcessArgs {
  readonly configPath: string
  readonly startToken?: string
}

export function parseRegistryArgs(argv: readonly string[]): RegistryProcessArgs {
  let configPath: string | undefined
  let startToken: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--config') {
      configPath = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length)
    } else if (argument === TOKEN_FLAG) {
      startToken = argv[index + 1]
      index += 1
    } else if (argument.startsWith(`${TOKEN_FLAG}=`)) {
      startToken = argument.slice(TOKEN_FLAG.length + 1)
    } else {
      throw new RegistryProcessError('INVALID_CONFIG', `usage: registry-process --config <file> [${TOKEN_FLAG} <token>]`)
    }
  }
  if (configPath === undefined || configPath.trim() === '') {
    throw new RegistryProcessError('INVALID_CONFIG', `usage: registry-process --config <file> [${TOKEN_FLAG} <token>]`)
  }
  if (startToken !== undefined && startToken.trim() === '') {
    throw new RegistryProcessError('INVALID_CONFIG', `${TOKEN_FLAG} requires a non-empty token`)
  }
  return { configPath: resolve(configPath), ...(startToken === undefined ? {} : { startToken }) }
}

/** Loads one v4 registry config through the frozen config owner. */
export async function loadRegistryIntent(configPath: string): Promise<RegistryDaemonIntent> {
  const absolute = resolve(configPath)
  let text: string
  try {
    text = await readFile(absolute, 'utf8')
  } catch (cause) {
    throw new RegistryProcessError('INVALID_CONFIG', `registry config could not be read: ${absolute}`, cause)
  }
  let intent: DaemonIntentV4
  try {
    intent = parseDaemonConfigText(text)
  } catch (cause) {
    throw new RegistryProcessError('INVALID_CONFIG', cause instanceof Error ? cause.message : String(cause), cause)
  }
  if (intent.daemon.kind !== 'registry') {
    throw new RegistryProcessError('INVALID_CONFIG', 'registry daemon config is required; start agent or control daemons with their own entry')
  }
  return resolveDaemonIntent(intent, { configDirectory: dirname(absolute) }) as RegistryDaemonIntent
}

export function registryStatePath(intent: RegistryDaemonIntent): string {
  return join(intent.daemon.dataDirectory, STATE_FILE_NAME)
}

export async function readRegistryState(statePath: string): Promise<RegistryDaemonState | undefined> {
  let text: string
  try {
    text = await readFile(statePath, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new RegistryProcessError('INVALID_STATUS', `registry state could not be read: ${statePath}`, cause)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new RegistryProcessError('INVALID_STATUS', `registry state is not valid JSON: ${statePath}`, cause)
  }
  const state = value as RegistryDaemonState
  if (state === null || typeof state !== 'object' || state.version !== STATE_VERSION
    || typeof state.configPath !== 'string' || typeof state.entryPath !== 'string'
    || typeof state.startToken !== 'string' || !Number.isSafeInteger(state.generation)
    || !Number.isSafeInteger(state.pid) || !['starting', 'running', 'failed', 'stopped'].includes(state.state)) {
    throw new RegistryProcessError('INVALID_STATUS', `registry state is malformed: ${statePath}`)
  }
  return state
}

async function writeRegistryState(statePath: string, state: RegistryDaemonState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
  await rename(temporary, statePath)
}

function sourceNodeArguments(): readonly string[] {
  return fileURLToPath(import.meta.url).endsWith('.ts') ? ['--experimental-transform-types'] : []
}

function statusFrom(statePath: string, configPath: string, daemonId: string, state: RegistryDaemonState | undefined): RegistryDaemonStatus {
  if (state === undefined) {
    return { configPath, statePath, daemonId, state: 'stopped', generation: 0 }
  }
  return {
    configPath,
    statePath,
    daemonId,
    state: state.state,
    generation: state.generation,
    pid: state.pid,
    ...(state.url === undefined ? {} : { url: state.url }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

async function ownsPersistedProcess(state: RegistryDaemonState): Promise<boolean> {
  if (state.pid <= 0 || !processAlive(state.pid)) return false
  const command = await processCommand(state.pid)
  return command !== undefined && processOwnsConfigCommand(command, state.configPath, state.entryPath, state.startToken, TOKEN_FLAG)
}

async function waitForProcessExit(pid: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new RegistryProcessError('STOP_TIMEOUT', `registry pid=${pid} did not exit after SIGTERM`)
}

async function waitForState(statePath: string, expected: readonly RegistryDaemonLifecycleState[], timeoutMs: number): Promise<RegistryDaemonState> {
  const deadline = Date.now() + timeoutMs
  let last: RegistryDaemonState | undefined
  while (Date.now() < deadline) {
    last = await readRegistryState(statePath)
    if (last !== undefined && expected.includes(last.state)) return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  if (last?.state === 'failed' && last.error !== undefined) {
    throw new RegistryProcessError('START_TIMEOUT', `registry process failed to start: ${last.error}`)
  }
  throw new RegistryProcessError('START_TIMEOUT', `registry did not report ${expected.join('/')} within ${timeoutMs}ms`)
}

export async function startRegistryDaemon(configPath: string, options: RegistryDaemonStartOptions = {}): Promise<RegistryDaemonStatus> {
  const intent = await loadRegistryIntent(configPath)
  // Resolve the plan before spawning so a missing TLS reference fails here with
  // the typed fault and the documented openssl command.
  resolveRegistryServerPlan(intent)
  const statePath = registryStatePath(intent)
  const resolvedConfigPath = resolve(configPath)
  const entryPath = fileURLToPath(import.meta.url)
  const previous = await readRegistryState(statePath)
  if (previous !== undefined && previous.configPath !== resolvedConfigPath) {
    throw new RegistryProcessError('STALE_OWNER', `registry state belongs to another config: ${previous.configPath}`)
  }
  if (previous !== undefined && previous.state !== 'stopped' && previous.pid > 0 && processAlive(previous.pid)) {
    if (!(await ownsPersistedProcess(previous))) {
      throw new RegistryProcessError('STALE_OWNER', `registry pid=${previous.pid} does not match its persisted start token`)
    }
    throw new RegistryProcessError('ALREADY_RUNNING', `registry is already running pid=${previous.pid} generation=${previous.generation}`)
  }
  const generation = (previous?.generation ?? 0) + 1
  const startToken = randomUUID()
  await writeRegistryState(statePath, {
    version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
    startToken, generation, pid: 0, state: 'starting', updatedAt: new Date().toISOString(),
  })
  const childEnv = { ...process.env, ...options.env }
  let child: ChildProcess | undefined
  try {
    child = spawn(options.nodeExecutable ?? process.execPath, [...(options.nodeArguments ?? sourceNodeArguments()), entryPath, '--config', resolvedConfigPath, TOKEN_FLAG, startToken], {
      detached: true,
      env: childEnv,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.unref()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await writeRegistryState(statePath, {
      version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
      startToken, generation, pid: 0, state: 'failed', error: message, updatedAt: new Date().toISOString(),
    })
    throw new RegistryProcessError('INVALID_CONFIG', `registry process could not be spawned: ${message}`, cause)
  }
  if (child.pid === undefined) {
    const message = 'detached registry process did not return a pid'
    await writeRegistryState(statePath, {
      version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
      startToken, generation, pid: 0, state: 'failed', error: message, updatedAt: new Date().toISOString(),
    })
    throw new RegistryProcessError('INVALID_CONFIG', message)
  }
  const pid = child.pid
  await writeRegistryState(statePath, {
    version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
    startToken, generation, pid, state: 'starting', updatedAt: new Date().toISOString(),
  })
  try {
    const running = await waitForState(statePath, ['running'], options.startupTimeoutMs ?? 10_000)
    return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, running)
  } catch (error) {
    // A failed child leaves its own error in the state file; keep it and only
    // reclaim the process this parent started.
    const latest = await readRegistryState(statePath)
    if (latest === undefined || (latest.generation === generation && latest.startToken === startToken)) {
      await writeRegistryState(statePath, {
        version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
        startToken, generation, pid, state: 'failed',
        error: latest?.error ?? (error instanceof Error ? error.message : String(error)),
        updatedAt: new Date().toISOString(),
      })
    }
    if (processAlive(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch { /* preserve the startup failure */ }
      try { await waitForProcessExit(pid, 2_000) } catch { /* preserve the startup failure */ }
    }
    throw error
  }
}

export async function statusRegistryDaemon(configPath: string): Promise<RegistryDaemonStatus> {
  const intent = await loadRegistryIntent(configPath)
  const statePath = registryStatePath(intent)
  const resolvedConfigPath = resolve(configPath)
  const state = await readRegistryState(statePath)
  if (state === undefined) return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, undefined)
  if (state.state === 'running' || state.state === 'starting') {
    if (state.pid <= 0 || !processAlive(state.pid)) {
      return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, { ...state, state: 'failed', error: 'registry process pid is not alive' })
    }
    if (!(await ownsPersistedProcess(state))) {
      return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, { ...state, state: 'failed', error: 'registry process does not match persisted ownership' })
    }
  }
  return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, state)
}

export async function stopRegistryDaemon(configPath: string, expectedGeneration?: number): Promise<RegistryDaemonStatus> {
  const intent = await loadRegistryIntent(configPath)
  const statePath = registryStatePath(intent)
  const resolvedConfigPath = resolve(configPath)
  const state = await readRegistryState(statePath)
  if (state === undefined || state.state === 'stopped') {
    return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, state)
  }
  if (expectedGeneration !== undefined && expectedGeneration !== state.generation) {
    throw new RegistryProcessError('STALE_GENERATION', `stale registry generation expected=${expectedGeneration} current=${state.generation}`)
  }
  if (state.pid <= 0 || !processAlive(state.pid)) {
    await writeRegistryState(statePath, { ...state, state: 'stopped', updatedAt: new Date().toISOString() })
    return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, { ...state, state: 'stopped' })
  }
  if (!(await ownsPersistedProcess(state))) {
    throw new RegistryProcessError('STALE_OWNER', `registry pid=${state.pid} does not match its persisted start token`)
  }
  process.kill(state.pid, 'SIGTERM')
  await waitForProcessExit(state.pid, 5_000)
  const stopped: RegistryDaemonState = { ...state, state: 'stopped', updatedAt: new Date().toISOString() }
  await writeRegistryState(statePath, stopped)
  return statusFrom(statePath, resolvedConfigPath, intent.daemon.id, stopped)
}

/**
 * Detached child entry. It publishes its own readiness into the one state file
 * after the Relay listener is bound, so `registry status` never reports a
 * fabricated `running` state.
 */
export async function runRegistryProcess(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = parseRegistryArgs(argv)
  const intent = await loadRegistryIntent(args.configPath)
  const plan = resolveRegistryServerPlan(intent)
  const statePath = registryStatePath(intent)
  const previous = await readRegistryState(statePath)
  const base = {
    version: STATE_VERSION,
    configPath: resolve(args.configPath),
    entryPath: fileURLToPath(import.meta.url),
    daemonId: intent.daemon.id,
    startToken: args.startToken ?? previous?.startToken ?? randomUUID(),
    generation: previous?.generation ?? 1,
  } as const
  let server: RelayServer
  try {
    const credentials = await loadRegistryCredentials(plan, { env })
    const [key, cert] = await Promise.all([readFile(plan.tls.keyFile), readFile(plan.tls.certFile)])
    const options = createRegistryRelayOptions(plan, { credentials, tls: { key, cert } })
    const groupData = join(intent.daemon.dataDirectory, 'group-state')
    const store = {
      load: () => readJsonFile<GroupHubSnapshot>(join(groupData, 'group-hub.json')),
      save: (snapshot: GroupHubSnapshot) => writeJsonFile(join(groupData, 'group-hub.json'), snapshot),
    }
    server = await createRelayServer({
      ...options,
      groupHub: (bridge) => createGroupHub({
        store,
        sendToAgent: bridge.send,
        isOnline: bridge.isOnline,
        externalOpTimeoutMs: 10_000,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeRegistryState(statePath, { ...base, pid: process.pid, state: 'failed', error: message, updatedAt: new Date().toISOString() })
    throw error
  }
  await writeRegistryState(statePath, { ...base, pid: process.pid, state: 'running', url: server.url, updatedAt: new Date().toISOString() })
  console.log(`registry listening ${server.url} config=${base.configPath} pid=${process.pid}`)
  let stopping: Promise<void> | undefined
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return
    stopping = server.close()
      .then(async () => {
        await writeRegistryState(statePath, { ...base, pid: process.pid, state: 'stopped', updatedAt: new Date().toISOString() })
      })
      .catch(error => {
        process.exitCode = 1
        console.error(`registry shutdown failed after ${signal}: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await new Promise<void>(resolveStopped => {
      const poll = () => { if (stopping) void stopping.finally(resolveStopped); else setTimeout(poll, 50) }
      poll()
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runRegistryProcess().catch(error => {
    const code = error instanceof RegistryIntentFault || error instanceof RegistryProcessError ? error.code : 'UNAVAILABLE'
    console.error('registry process failed:', code, error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
