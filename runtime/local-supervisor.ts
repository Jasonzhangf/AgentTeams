import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectLocalChildConfigs, readLocalInternalConfig, writeLocalInternalConsoleRuntime, writeLocalInternalLauncherState, writeLocalInternalRecoveryState, writeLocalInternalState, writeLocalInternalWorkControl, writeLocalLauncherOwnership, type ConsoleRuntimeState, type LocalConfig, type LocalInternalConfig, type LocalInternalDaemonState } from './local-config.ts'
import { startLocalWorkControlListener, type LocalConsoleControlReply, type LocalConsolePublicStatus, type LocalWorkControlHandlerInput, type LocalWorkControlReply, type LocalWorkControlRequest, type LocalWorkControlServer } from './local-work-control.ts'
import type { ProjectExecutionReceipt } from './dagpipe/host.ts'

/** Launcher -> receiver child typed Work frame; business payload stays in `frame`. */
export interface LocalWorkChildRequest {
  readonly kind: 'work.control'
  readonly localCorrelation: string
  readonly receiverAgentId: string
  readonly expectedLauncherGeneration: number
  readonly expectedAgentGeneration: number
  readonly frame: LocalWorkControlRequest
}

/** Receiver child -> launcher typed Work reply keyed by the local correlation. */
export interface LocalWorkChildReply {
  readonly kind: 'work.reply'
  readonly localCorrelation: string
  readonly reply: LocalWorkControlReply
}

export function localWorkControlSocketPath(internalPath: string): string {
  return resolve(dirname(internalPath), '.internal', 'work-control.sock')
}

export interface LocalDaemonIdentityProjection {
  readonly hostId: string
  readonly machineId: string
  readonly agentId: string
  readonly accountId: string
  readonly agentKind: 'opencode' | 'acp' | 'custom'
  readonly label: string
}

export interface LocalDaemonResourceProjection {
  readonly resourceId: string
  readonly capacity: number
  readonly unit: 'slot' | 'context'
}

export interface LocalDaemonCapabilityProjection {
  readonly capabilityId: string
  readonly version: string
  readonly operations: readonly string[]
  readonly resources: readonly LocalDaemonResourceProjection[]
}

export interface LocalDaemonEndpointProjection {
  readonly agentId: string
  readonly identity: LocalDaemonIdentityProjection
  readonly role: 'provider' | 'receiver' | 'hybrid'
  readonly presence: 'online' | 'offline' | 'unknown'
  readonly state: 'online' | 'stopped' | 'failed'
  readonly generation: number
  readonly capabilities: readonly LocalDaemonCapabilityProjection[]
}

export interface LocalDaemonStatusProjection {
  readonly version: 1
  readonly generation: number
  readonly startToken: string
  readonly daemons: Readonly<Record<string, LocalDaemonEndpointProjection>>
}

export interface LocalProcessSpec {
  readonly id: string
  readonly kind: 'relay' | 'agent' | 'console'
  readonly entry: string
  readonly args: readonly string[]
}

export interface LocalSupervisorOptions {
  readonly nodeExecutable?: string
  /** Runtime flags are explicit so source and packaged entrypoints share the same child contract. */
  readonly nodeArguments?: readonly string[]
  readonly relayEntry?: string
  readonly agentEntry?: string
  readonly consoleEntry?: string
  readonly env?: NodeJS.ProcessEnv
  readonly startToken?: string
  readonly launcherGeneration?: number
  readonly startupTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly spawn?: typeof nodeSpawn
}

export type LocalSupervisorState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export class LocalConsoleLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'LocalConsoleLifecycleError'
  }
}

function projectionRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function projectionText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function projectionPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`)
  return value as number
}

function projectionFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(', ')}`)
}

/** Validate the Agent-owned status snapshot before it becomes runtime projection truth. */
export function parseLocalDaemonEndpointProjection(value: unknown, label = 'local daemon endpoint'): LocalDaemonEndpointProjection {
  const input = projectionRecord(value, label)
  projectionFields(input, ['agentId', 'identity', 'role', 'presence', 'state', 'generation', 'capabilities'], label)
  const identityInput = projectionRecord(input.identity, `${label}.identity`)
  projectionFields(identityInput, ['hostId', 'machineId', 'agentId', 'accountId', 'agentKind', 'label'], `${label}.identity`)
  const identity: LocalDaemonIdentityProjection = {
    hostId: projectionText(identityInput.hostId, `${label}.identity.hostId`),
    machineId: projectionText(identityInput.machineId, `${label}.identity.machineId`),
    agentId: projectionText(identityInput.agentId, `${label}.identity.agentId`),
    accountId: projectionText(identityInput.accountId, `${label}.identity.accountId`),
    agentKind: (() => {
      const value = identityInput.agentKind
      if (value !== 'opencode' && value !== 'acp' && value !== 'custom') throw new Error(`${label}.identity.agentKind is invalid`)
      return value
    })(),
    label: projectionText(identityInput.label, `${label}.identity.label`),
  }
  const role = input.role
  if (role !== 'provider' && role !== 'receiver' && role !== 'hybrid') throw new Error(`${label}.role is invalid`)
  const presence = input.presence
  if (presence !== 'online' && presence !== 'offline' && presence !== 'unknown') throw new Error(`${label}.presence is invalid`)
  const state = input.state
  if (state !== 'online' && state !== 'stopped' && state !== 'failed') throw new Error(`${label}.state is invalid`)
  const agentId = projectionText(input.agentId, `${label}.agentId`)
  if (agentId !== identity.agentId) throw new Error(`${label}.agentId must match identity.agentId`)
  if (!Array.isArray(input.capabilities)) throw new Error(`${label}.capabilities must be an array`)
  const capabilities = input.capabilities.map((capability, index) => {
    const capabilityInput = projectionRecord(capability, `${label}.capabilities[${index}]`)
    projectionFields(capabilityInput, ['capabilityId', 'version', 'operations', 'resources'], `${label}.capabilities[${index}]`)
    if (!Array.isArray(capabilityInput.operations) || capabilityInput.operations.length === 0) {
      throw new Error(`${label}.capabilities[${index}].operations must be a non-empty array`)
    }
    const operations = capabilityInput.operations.map((operation, operationIndex) =>
      projectionText(operation, `${label}.capabilities[${index}].operations[${operationIndex}]`))
    if (!Array.isArray(capabilityInput.resources)) throw new Error(`${label}.capabilities[${index}].resources must be an array`)
    const resources = capabilityInput.resources.map((resource, resourceIndex) => {
      const resourceInput = projectionRecord(resource, `${label}.capabilities[${index}].resources[${resourceIndex}]`)
      projectionFields(resourceInput, ['resourceId', 'capacity', 'unit'], `${label}.capabilities[${index}].resources[${resourceIndex}]`)
      const unit = resourceInput.unit
      if (unit !== 'slot' && unit !== 'context') throw new Error(`${label}.capabilities[${index}].resources[${resourceIndex}].unit is invalid`)
      const parsed: LocalDaemonResourceProjection = {
        resourceId: projectionText(resourceInput.resourceId, `${label}.capabilities[${index}].resources[${resourceIndex}].resourceId`),
        capacity: projectionPositiveInteger(resourceInput.capacity, `${label}.capabilities[${index}].resources[${resourceIndex}].capacity`),
        unit,
      }
      return parsed
    })
    return {
      capabilityId: projectionText(capabilityInput.capabilityId, `${label}.capabilities[${index}].capabilityId`),
      version: projectionText(capabilityInput.version, `${label}.capabilities[${index}].version`),
      operations,
      resources,
    }
  })
  return {
    agentId,
    identity,
    role,
    presence,
    state,
    generation: projectionPositiveInteger(input.generation, `${label}.generation`),
    capabilities,
  }
}

export function parseLocalDaemonStatusProjection(value: unknown, label = 'local daemon status projection'): LocalDaemonStatusProjection {
  const input = projectionRecord(value, label)
  projectionFields(input, ['version', 'generation', 'startToken', 'daemons'], label)
  if (input.version !== 1) throw new Error(`${label}.version must be 1`)
  const daemonsInput = projectionRecord(input.daemons, `${label}.daemons`)
  const daemons: Record<string, LocalDaemonEndpointProjection> = {}
  for (const [id, endpoint] of Object.entries(daemonsInput)) {
    daemons[id] = parseLocalDaemonEndpointProjection(endpoint, `${label}.daemons.${id}`)
  }
  return {
    version: 1,
    generation: (() => {
      if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) throw new Error(`${label}.generation must be a non-negative safe integer`)
      return input.generation as number
    })(),
    startToken: projectionText(input.startToken, `${label}.startToken`),
    daemons,
  }
}

export function localDaemonStatusProjectionPath(internalPath: string): string {
  return resolve(dirname(internalPath), '.internal', 'daemon-status.json')
}

export async function writeLocalDaemonStatusProjection(internalPath: string, projection: LocalDaemonStatusProjection): Promise<string> {
  const path = localDaemonStatusProjectionPath(internalPath)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(projection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, path) }
  catch (error) { try { await rm(temporary, { force: true }) } catch { /* preserve original failure */ } throw error }
  return path
}

export async function readLocalDaemonStatusProjection(internalPath: string): Promise<LocalDaemonStatusProjection | undefined> {
  const path = localDaemonStatusProjectionPath(internalPath)
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`local daemon status projection cannot be read: ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (error) {
    throw new Error(`local daemon status projection is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseLocalDaemonStatusProjection(parsed)
}

function defaultEntry(name: 'relay-process' | 'agent-process' | 'console-process'): string {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = name === 'relay-process' ? 'server' : 'runtime'
  return resolve(runtimeDirectory, `../${directory}/${name}.js`)
}

export function planLocalProcesses(config: LocalConfig, options: Pick<LocalSupervisorOptions, 'nodeExecutable' | 'relayEntry' | 'agentEntry' | 'consoleEntry'> = {}): readonly LocalProcessSpec[] {
  const relayEntry = options.relayEntry ?? defaultEntry('relay-process')
  const agentEntry = options.agentEntry ?? defaultEntry('agent-process')
  const consoleEntry = options.consoleEntry ?? defaultEntry('console-process')
  const specs: LocalProcessSpec[] = [{ id: 'relay', kind: 'relay', entry: relayEntry, args: ['--config', config.relay.configPath] }]
  for (const daemon of config.daemons) {
    if (daemon.enabled) specs.push({ id: daemon.id, kind: 'agent', entry: agentEntry, args: ['--config', daemon.configPath] })
  }
  if (config.console?.enabled === true) {
    specs.push({ id: 'console', kind: 'console', entry: consoleEntry, args: ['--config', config.console.configPath] })
  }
  return specs
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function readConsoleProjectionFile(path: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (path === undefined) return undefined
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LocalConsoleLifecycleError('CONSOLE_STATUS_UNAVAILABLE', 'Console projection is not an object')
  }
  return parsed as Record<string, unknown>
}

function consoleCredentialFromProjection(projection: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv): 'configured' | 'missing' {
  const auth = projection?.auth
  const passwordEnv = typeof auth === 'object' && auth !== null && !Array.isArray(auth)
    ? (auth as Record<string, unknown>).passwordEnv
    : undefined
  if (typeof passwordEnv !== 'string' || passwordEnv.length === 0) return 'missing'
  const value = env[passwordEnv]
  return typeof value === 'string' && value.length > 0 ? 'configured' : 'missing'
}

/**
 * Read-only Console classification shared by the supervisor socket handler and
 * the public CLI status path. It never writes runtime facts and never invents
 * online availability from a stale durable record.
 */
export async function classifyLocalConsoleStatus(
  config: LocalConfig,
  internal: LocalInternalConfig,
  env: NodeJS.ProcessEnv = process.env,
  fallback: { readonly state: LocalSupervisorState; readonly generation: number } = {
    state: internal.launcher?.state ?? 'stopped',
    generation: internal.launcher?.generation ?? 0,
  },
): Promise<LocalConsolePublicStatus> {
  const projection = await readConsoleProjectionFile(config.console?.configPath)
  const runtime = internal.consoleRuntime
  const enabled = config.console?.enabled === true && projection?.enabled === true
  const credential = consoleCredentialFromProjection(projection, env)
  if (!enabled) {
    return {
      enabled: false,
      state: 'disabled',
      generation: runtime?.generation ?? 0,
      launcherState: fallback.state,
      launcherGeneration: fallback.generation,
      credential,
    }
  }
  let state: ConsoleRuntimeState = runtime?.state ?? 'stopped'
  let error = runtime?.error
  if ((state === 'online' || state === 'starting') && (runtime?.pid === undefined || !processAlive(runtime.pid))) {
    state = 'failed'
    error = { code: 'CONSOLE_PROCESS_EXITED', message: `Console pid=${runtime?.pid ?? 'missing'} is not alive` }
  }
  return {
    enabled: true,
    state,
    generation: runtime?.generation ?? 0,
    launcherState: fallback.state,
    launcherGeneration: fallback.generation,
    credential,
    ...(state === 'online' && runtime?.url !== undefined ? { url: runtime.url, origin: runtime.origin } : {}),
    ...(state === 'online' && runtime?.pid !== undefined ? { pid: runtime.pid } : {}),
    ...(state === 'starting' && runtime?.pid !== undefined ? { pid: runtime.pid } : {}),
    ...(runtime?.identityRef === undefined ? {} : { identityRef: runtime.identityRef }),
    ...(error === undefined ? {} : { error }),
  }
}

function timeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) throw new Error(`${label} must be a positive safe integer`)
  return result
}

function waitForExit(child: ChildProcess, deadlineMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => finish(new Error('local daemon exit remains unconfirmed')), deadlineMs)
    const onExit = () => finish()
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      if (error) reject(error); else resolveExit()
    }
    child.once('exit', onExit)
  })
}

async function waitForReady(child: ChildProcess, kind: LocalProcessSpec['kind'], deadlineMs: number, requireEndpointProjection = false): Promise<Record<string, unknown> | undefined> {
  const output = { stdout: '', stderr: '' }
  return await new Promise<Record<string, unknown> | undefined>((resolveReady, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let registrationFallback: ReturnType<typeof setTimeout> | undefined
    let endpoint: unknown
    let registration: Record<string, unknown> | undefined
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (timer !== undefined) clearTimeout(timer)
      if (registrationFallback !== undefined) clearTimeout(registrationFallback)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('message', onMessage)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      if (error) reject(error); else resolveReady(value)
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      // A legacy Agent may exit in the same turn as its registration frame.
      // Preserve that frame as readiness so the supervisor's existing
      // post-readiness liveness check reports the precise immediate-exit error.
      if (kind === 'agent' && registration !== undefined && (!requireEndpointProjection || endpoint !== undefined)) finish(undefined, { ...registration, ...(endpoint === undefined ? {} : { endpoint }) })
      else if (kind === 'agent' && registration !== undefined && requireEndpointProjection) finish(new Error('local agent exited after registration without status projection'))
      else finish(new Error(`local ${kind} exited before readiness code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${output.stderr}`))
    }
    const onStdout = (chunk: Buffer | string) => {
      output.stdout += chunk.toString()
      if (kind === 'relay' && output.stdout.includes('relay listening ')) finish()
    }
    const onStderr = (chunk: Buffer | string) => { output.stderr += chunk.toString() }
    const onMessage = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return
      const control = message as { kind?: unknown; endpoint?: unknown }
      if (kind === 'console') {
        if (control.kind === 'console.listening') finish(undefined, control as Record<string, unknown>)
        return
      }
      if (kind !== 'agent') return
      // The registration frame remains the established readiness signal. The
      // status projection follows on the same IPC queue when supported.
      if (control.kind === 'daemon.status') {
        endpoint = control.endpoint
        if (registration !== undefined) finish(undefined, { ...registration, endpoint })
        return
      }
      if (control.kind === 'daemon.registered') {
        registration = control as Record<string, unknown>
        if (endpoint !== undefined) finish(undefined, { ...registration, endpoint })
        else if (!requireEndpointProjection) registrationFallback = setTimeout(() => finish(undefined, registration), 25)
      }
    }
    child.once('error', onError)
    child.once('exit', onExit)
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    if (kind === 'agent' || kind === 'console') child.on('message', onMessage)
    timer = setTimeout(() => finish(new Error(`local ${kind} startup deadline stderr=${output.stderr}`)), deadlineMs)
  })
}

export interface LocalSupervisor {
  readonly state: () => LocalSupervisorState
  readonly failure: () => Error | undefined
  readonly processes: () => readonly LocalProcessSpec[]
  /** Runtime-owned lifecycle generation; increments per successful start and persists through the launcher. */
  readonly generation: () => number
  start(): Promise<void>
  stop(): Promise<void>
  consoleStatus(): Promise<LocalConsolePublicStatus>
  consoleStart(expectedConsoleGeneration?: number): Promise<LocalConsolePublicStatus>
  consoleStop(expectedConsoleGeneration?: number): Promise<LocalConsolePublicStatus>
}

export function createLocalSupervisor(config: LocalConfig, options: LocalSupervisorOptions = {}): LocalSupervisor {
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const startupTimeoutMs = timeout(options.startupTimeoutMs, 10_000, 'startupTimeoutMs')
  const stopTimeoutMs = timeout(options.stopTimeoutMs, 5_000, 'stopTimeoutMs')
  const spawnProcess = options.spawn ?? nodeSpawn
  const specs = planLocalProcesses(config, options)
  const children = new Map<string, ChildProcess>()
  const states = new Map<string, LocalInternalDaemonState>()
  const endpoints = new Map<string, LocalDaemonEndpointProjection>()
  const unwatch = new Map<string, () => void>()
  const receivers = Object.fromEntries(config.daemons
    .filter(daemon => daemon.enabled && (daemon.role === 'receiver' || daemon.role === 'hybrid') && daemon.connection !== undefined)
    .map(daemon => [daemon.id, true]))
  const socketPath = config.internalPath === undefined ? undefined : localWorkControlSocketPath(config.internalPath)
  const pendingWork = new Map<string, (reply: LocalWorkControlReply) => void>()
  let workControl: LocalWorkControlServer | undefined
  let lifecycle: LocalSupervisorState = 'stopped'
  let lastFailure: Error | undefined
  let lifecycleGeneration = 0
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  const startToken = options.startToken ?? randomUUID()
  let reservedLauncherGeneration: number | undefined
  let activeChildEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env }
  let consoleStarting: Promise<LocalConsolePublicStatus> | undefined
  let consoleStopping: Promise<LocalConsolePublicStatus> | undefined

  const readConsoleProjection = (): Promise<Record<string, unknown> | undefined> => readConsoleProjectionFile(config.console?.configPath)
  const consoleCredentialState = (projection: Record<string, unknown> | undefined): 'configured' | 'missing' => consoleCredentialFromProjection(projection, activeChildEnv)

  async function consoleAssetsAvailable(projection: Record<string, unknown>): Promise<boolean> {
    for (const key of ['staticRoot', 'uiRoot'] as const) {
      const value = projection[key]
      if (typeof value !== 'string' || value.length === 0) return false
      try { await access(value) } catch { return false }
    }
    return true
  }

  async function patchConsole(patch: Parameters<typeof writeLocalInternalConsoleRuntime>[1]): Promise<void> {
    if (config.internalPath === undefined) return
    await writeLocalInternalConsoleRuntime(config.internalPath, patch)
  }

  function consoleErrorCode(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause)
    for (const code of ['CONSOLE_DISABLED', 'CONSOLE_CREDENTIAL_MISSING', 'CONSOLE_PORT_OCCUPIED', 'CONSOLE_ASSET_MISSING', 'CONSOLE_RETAINED']) {
      if (message.includes(code)) return code
    }
    const errno = (cause as NodeJS.ErrnoException | undefined)?.code
    if (errno === 'EADDRINUSE') return 'CONSOLE_PORT_OCCUPIED'
    if (message.includes('EADDRINUSE')) return 'CONSOLE_PORT_OCCUPIED'
    return 'CONSOLE_START_FAILED'
  }

  async function consoleStatusRead(): Promise<LocalConsolePublicStatus> {
    const projection = await readConsoleProjection()
    const internal = config.internalPath === undefined ? undefined : await readLocalInternalConfig(config.internalPath)
    const runtime = internal?.consoleRuntime
    const launcher = internal?.launcher
    const enabled = config.console?.enabled === true && projection?.enabled === true
    const credential = consoleCredentialState(projection)
    const launcherState = launcher?.state ?? (lifecycle === 'running' ? 'running' : 'stopped')
    const launcherGeneration = launcher?.generation ?? lifecycleGeneration
    if (!enabled) {
      return {
        enabled: false,
        state: 'disabled',
        generation: runtime?.generation ?? 0,
        launcherState,
        launcherGeneration,
        credential,
      }
    }
    let state: ConsoleRuntimeState = runtime?.state ?? 'stopped'
    let error = runtime?.error
    if ((state === 'online' || state === 'starting') && (runtime?.pid === undefined || !processAlive(runtime.pid))) {
      state = 'failed'
      error = { code: 'CONSOLE_PROCESS_EXITED', message: `Console pid=${runtime?.pid ?? 'missing'} is not alive` }
    }
    return {
      enabled: true,
      state,
      generation: runtime?.generation ?? 0,
      launcherState,
      launcherGeneration,
      credential,
      ...(state === 'online' && runtime?.url !== undefined ? { url: runtime.url, origin: runtime.origin } : {}),
      ...(state === 'online' && runtime?.pid !== undefined ? { pid: runtime.pid } : {}),
      ...(state === 'starting' && runtime?.pid !== undefined ? { pid: runtime.pid } : {}),
      ...(runtime?.identityRef === undefined ? {} : { identityRef: runtime.identityRef }),
      ...(error === undefined ? {} : { error }),
    }
  }

  const statusFromRuntime = async (): Promise<LocalConsolePublicStatus> => {
    const internal = config.internalPath === undefined ? undefined : await readLocalInternalConfig(config.internalPath)
    const fallback = { state: lifecycle, generation: lifecycleGeneration }
    if (internal === undefined) {
      return {
        enabled: config.console?.enabled === true,
        state: config.console?.enabled === true ? 'stopped' : 'disabled',
        generation: 0,
        launcherState: lifecycle,
        launcherGeneration: lifecycleGeneration,
        credential: consoleCredentialState(await readConsoleProjection()),
      }
    }
    const classified = await classifyLocalConsoleStatus(config, internal, activeChildEnv, fallback)
    if (classified.state === 'online' || classified.state === 'starting') {
      const child = children.get('console')
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
        return classifyLocalConsoleStatus(config, {
          ...internal,
          consoleRuntime: internal.consoleRuntime === undefined
            ? undefined
            : { ...internal.consoleRuntime, state: 'failed', error: { code: 'CONSOLE_PROCESS_EXITED', message: 'Console child is not running' } },
        }, activeChildEnv, fallback)
      }
    }
    return classified
  }

  async function startConsoleChild(): Promise<LocalConsolePublicStatus> {
    const projection = await readConsoleProjection()
    if (config.console?.enabled !== true || projection?.enabled !== true) {
      await patchConsole({ enabled: false, state: 'disabled', pid: null, startToken: null, url: null, origin: null, error: null })
      throw new LocalConsoleLifecycleError('CONSOLE_DISABLED', 'Console is disabled; set [console].enabled=true in config.toml')
    }
    if (consoleCredentialState(projection) !== 'configured') {
      await patchConsole({ enabled: true, state: 'failed', pid: null, startToken: null, error: { code: 'CONSOLE_CREDENTIAL_MISSING', message: 'Console password environment variable is not configured' } })
      throw new LocalConsoleLifecycleError('CONSOLE_CREDENTIAL_MISSING', 'Console password environment variable is not configured')
    }
    if (!(await consoleAssetsAvailable(projection))) {
      await patchConsole({ enabled: true, state: 'failed', pid: null, startToken: null, error: { code: 'CONSOLE_ASSET_MISSING', message: 'Console static or UI asset root is missing' } })
      throw new LocalConsoleLifecycleError('CONSOLE_ASSET_MISSING', 'Console static or UI asset root is missing')
    }
    const spec = specs.find(candidate => candidate.kind === 'console')
    if (spec === undefined || config.internalPath === undefined) {
      throw new LocalConsoleLifecycleError('CONSOLE_STATUS_UNAVAILABLE', 'Console child plan is not available')
    }
    const internal = await readLocalInternalConfig(config.internalPath)
    const generation = (internal.consoleRuntime?.generation ?? 0) + 1
    const childStartToken = randomUUID()
    const child = spawnProcess(nodeExecutable, [...(options.nodeArguments ?? []), spec.entry, ...spec.args, '--launcher-start-token', childStartToken], {
      env: activeChildEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    children.set('console', child)
    if (child.pid === undefined) {
      children.delete('console')
      await patchConsole({ enabled: true, state: 'failed', pid: null, startToken: null, error: { code: 'CONSOLE_START_FAILED', message: 'Console child did not return a pid' } })
      throw new LocalConsoleLifecycleError('CONSOLE_START_FAILED', 'Console child did not return a pid')
    }
    try {
      await patchConsole({ enabled: true, pid: child.pid, generation, startToken: childStartToken, state: 'starting' })
      const ready = await waitForReady(child, 'console', startupTimeoutMs)
      const url = typeof ready?.url === 'string' ? ready.url : undefined
      if (url === undefined) throw new LocalConsoleLifecycleError('CONSOLE_START_FAILED', 'Console readiness did not publish its bound URL')
      const parsed = new URL(url)
      await patchConsole({
        enabled: true,
        pid: child.pid,
        generation,
        startToken: childStartToken,
        state: 'online',
        url,
        origin: parsed.origin,
        identityRef: 'console:local',
        error: null,
      })
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (children.get('console') !== child) return
        children.delete('console')
        unwatch.delete('console')
        if (lifecycle === 'stopping' || lifecycle === 'stopped') return
        void patchConsole({
          state: 'failed',
          pid: null,
          startToken: null,
          error: { code: 'CONSOLE_PROCESS_EXITED', message: `Console exited unexpectedly code=${code ?? 'null'} signal=${signal ?? 'null'}` },
        }).catch(() => undefined)
      }
      const onError = (cause: Error) => {
        if (children.get('console') !== child) return
        children.delete('console')
        unwatch.delete('console')
        if (lifecycle === 'stopping' || lifecycle === 'stopped') return
        void patchConsole({
          state: 'failed',
          pid: null,
          startToken: null,
          error: { code: 'CONSOLE_PROCESS_EXITED', message: cause.message },
        }).catch(() => undefined)
      }
      child.once('exit', onExit)
      child.once('error', onError)
      unwatch.set('console', () => { child.off('exit', onExit); child.off('error', onError) })
      return await statusFromRuntime()
    } catch (cause) {
      let cleaned = true
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        try { await waitForExit(child, stopTimeoutMs) }
        catch { cleaned = false }
      }
      unwatch.get('console')?.()
      unwatch.delete('console')
      children.delete('console')
      const code = consoleErrorCode(cause)
      const message = cause instanceof Error ? cause.message : String(cause)
      if (cleaned) {
        await patchConsole({ enabled: true, state: 'failed', pid: null, startToken: null, error: { code, message } })
      } else {
        await patchConsole({ enabled: true, state: 'retained', error: { code: 'CONSOLE_RETAINED', message } })
      }
      throw new LocalConsoleLifecycleError(code, message)
    }
  }

  async function stopConsoleChild(expectedConsoleGeneration?: number): Promise<LocalConsolePublicStatus> {
    const status = await consoleStatusRead()
    if (!status.enabled) return status
    if (expectedConsoleGeneration !== undefined && expectedConsoleGeneration !== status.generation) {
      throw new LocalConsoleLifecycleError('STALE_GENERATION', `stale Console generation expected=${expectedConsoleGeneration} current=${status.generation}`)
    }
    const child = children.get('console')
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      await patchConsole({ enabled: true, state: 'stopped', pid: null, startToken: null, url: null, origin: null, error: null })
      return await statusFromRuntime()
    }
    await patchConsole({ enabled: true, state: 'stopping' })
    child.kill('SIGTERM')
    try {
      await waitForExit(child, stopTimeoutMs)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await patchConsole({ enabled: true, state: 'retained', error: { code: 'CONSOLE_RETAINED', message } })
      throw new LocalConsoleLifecycleError('CONSOLE_RETAINED', message)
    }
    unwatch.get('console')?.()
    unwatch.delete('console')
    children.delete('console')
    await patchConsole({ enabled: true, state: 'stopped', pid: null, startToken: null, url: null, origin: null, error: null })
    return await statusFromRuntime()
  }

  async function shutdownConsole(): Promise<void> {
    const child = children.get('console')
    if (child === undefined) {
      if (config.internalPath !== undefined) {
        try {
          const internal = await readLocalInternalConfig(config.internalPath)
          if (internal.consoleRuntime?.state === 'online' || internal.consoleRuntime?.state === 'starting') {
            await patchConsole({ enabled: true, state: 'stopped', pid: null, startToken: null, url: null, origin: null, error: null })
          }
        } catch { /* console cleanup must not mask launcher cleanup */ }
      }
      return
    }
    try {
      await patchConsole({ enabled: true, state: 'stopping' })
    } catch { /* preserve the child cleanup result */ }
    child.kill('SIGTERM')
    try {
      await waitForExit(child, stopTimeoutMs)
      unwatch.get('console')?.()
      unwatch.delete('console')
      children.delete('console')
      await patchConsole({ enabled: true, state: 'stopped', pid: null, startToken: null, url: null, origin: null, error: null })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      try { await patchConsole({ enabled: true, state: 'retained', error: { code: 'CONSOLE_RETAINED', message } }) } catch { /* retained responsibility stays explicit in the report */ }
    }
  }

  const consoleStart = (expectedConsoleGeneration?: number): Promise<LocalConsolePublicStatus> => {
    if (lifecycle !== 'running') return Promise.reject(new LocalConsoleLifecycleError('NOT_RUNNING', 'launcher is not running'))
    if (consoleStarting !== undefined) return consoleStarting
    let operation!: Promise<LocalConsolePublicStatus>
    operation = (async () => {
      const status = await consoleStatusRead()
      if (!status.enabled) {
        await patchConsole({ enabled: false, state: 'disabled', pid: null, startToken: null, url: null, origin: null, error: null })
        throw new LocalConsoleLifecycleError('CONSOLE_DISABLED', 'Console is disabled; set [console].enabled=true in config.toml')
      }
      if (expectedConsoleGeneration !== undefined && expectedConsoleGeneration !== status.generation) {
        throw new LocalConsoleLifecycleError('STALE_GENERATION', `stale Console generation expected=${expectedConsoleGeneration} current=${status.generation}`)
      }
      const child = children.get('console')
      if (status.state === 'online' && child !== undefined && child.exitCode === null && child.signalCode === null) return status
      return await startConsoleChild()
    })().finally(() => {
      if (consoleStarting === operation) consoleStarting = undefined
    })
    consoleStarting = operation
    return operation
  }

  const consoleStop = (expectedConsoleGeneration?: number): Promise<LocalConsolePublicStatus> => {
    if (consoleStopping !== undefined) return consoleStopping
    let operation!: Promise<LocalConsolePublicStatus>
    operation = stopConsoleChild(expectedConsoleGeneration).finally(() => {
      if (consoleStopping === operation) consoleStopping = undefined
    })
    consoleStopping = operation
    return operation
  }

  const forwardWork = async (input: LocalWorkControlHandlerInput): Promise<ProjectExecutionReceipt | { readonly code: string; readonly message: string }> => {
    const receiverId = input.frame.control.receiverAgentId
    const child = children.get(receiverId)
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return { code: 'RECEIVER_NOT_FOUND', message: `Work receiver ${receiverId} is not available` }
    }
    const endpoint = endpoints.get(receiverId)
    if (endpoint === undefined) return { code: 'RECEIVER_NOT_FOUND', message: `Work receiver ${receiverId} has no live status projection` }
    const localCorrelation = randomUUID()
    const request: LocalWorkChildRequest = {
      kind: 'work.control',
      localCorrelation,
      receiverAgentId: receiverId,
      expectedLauncherGeneration: lifecycleGeneration,
      expectedAgentGeneration: endpoint.generation,
      frame: input.frame,
    }
    let reply: LocalWorkControlReply
    try {
      reply = await new Promise<LocalWorkControlReply>((resolveReply, rejectReply) => {
        const timer = setTimeout(() => { pendingWork.delete(localCorrelation); rejectReply(new Error('receiver did not answer the local Work request')) }, 120_000)
        pendingWork.set(localCorrelation, value => { clearTimeout(timer); resolveReply(value) })
        if (typeof child.send !== 'function') {
          clearTimeout(timer)
          pendingWork.delete(localCorrelation)
          rejectReply(new Error('receiver child has no IPC channel'))
          return
        }
        child.send(request, error => {
          if (error === null || error === undefined) return
          clearTimeout(timer)
          pendingWork.delete(localCorrelation)
          rejectReply(error)
        })
      })
    } catch (cause) {
      return { code: 'LOCAL_CONTROL_UNAVAILABLE', message: cause instanceof Error ? cause.message : 'local Work forwarding failed' }
    }
    return reply.kind === 'work.result' ? reply.receipt : reply.error
  }

  const stop = (): Promise<void> => {
    if (stopping) return stopping
    let operation!: Promise<void>
    operation = (async () => {
      const hadFailure = lifecycle === 'failed' || lastFailure !== undefined
      lifecycle = 'stopping'
      const failures: unknown[] = []
      // Stop must not depend on a receiver reply. Closing the listener stops new
      // admissions synchronously, but its drain also waits for every accepted
      // handler, and an accepted handler waits for the receiver child reply up
      // to the forwarding timeout. Release the in-flight forwards first, so a
      // hung or exited receiver cannot hold stop and child cleanup open.
      const closingControl = workControl?.close()
      for (const resolvePending of pendingWork.values()) resolvePending({ kind: 'work.error', requestId: 'unknown', error: { code: 'LOCAL_CONTROL_UNAVAILABLE', message: 'local Work listener is stopping' } })
      pendingWork.clear()
      try { await closingControl } catch (error) { failures.push(error) }
      workControl = undefined
      await shutdownConsole()
      if (config.internalPath !== undefined) {
        try { await writeLocalInternalWorkControl(config.internalPath, undefined) } catch (error) { failures.push(error) }
      }
      for (const spec of [...specs].reverse()) {
        if (spec.kind === 'console') continue
        const child = children.get(spec.id)
        if (!child) continue
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          await waitForExit(child, stopTimeoutMs)
          unwatch.get(spec.id)?.()
          unwatch.delete(spec.id)
        } catch (error) {
          failures.push(error)
          lastFailure = error instanceof Error ? error : new Error('local daemon cleanup remains unconfirmed')
          lifecycle = 'failed'
        }
      }
      if (config.internalPath !== undefined) {
        let failed = hadFailure || lifecycle === 'failed' || failures.length > 0
        const persisted: Record<string, LocalInternalDaemonState> = Object.fromEntries([...states.entries()].map(([id, state]) => [id, { ...state, state: failed ? 'failed' : 'stopped' as const }]))
        // Daemon terminal records and the launcher terminal record share one
        // transactional write. A partial publication could otherwise leave a
        // durable successful launcher state behind a failed daemon set.
        let terminalWriteSucceeded = true
        try {
          await writeLocalInternalRecoveryState(config.internalPath, persisted, {
            pid: process.pid,
            generation: lifecycleGeneration,
            startToken,
            state: failed ? 'failed' : 'stopped',
            ...(failed && lastFailure !== undefined ? { error: lastFailure.message } : {}),
          })
        } catch (error) {
          terminalWriteSucceeded = false
          failures.push(error)
        }
        if (failures.length > 0) lastFailure = new AggregateError(failures, 'local daemon cleanup remains unconfirmed')
        try {
          await writeLocalDaemonStatusProjection(config.internalPath, {
            version: 1,
            generation: lifecycleGeneration,
            startToken,
            daemons: Object.fromEntries([...endpoints.entries()].map(([id, endpoint]) => [id, {
              ...endpoint,
              presence: failed ? 'unknown' as const : 'offline' as const,
              state: failed ? 'failed' as const : 'stopped' as const,
            }])),
          })
        } catch (error) {
          terminalWriteSucceeded = false
          failures.push(error)
          lastFailure = new AggregateError(failures, 'local daemon cleanup remains unconfirmed')
        }
        if (!terminalWriteSucceeded) {
          // The terminal publication is unconfirmed, so the durable launcher
          // state must not keep claiming a clean stop.
          const forced = lastFailure ?? new AggregateError(failures, 'local daemon cleanup remains unconfirmed')
          lastFailure = forced
          try {
            await writeLocalInternalRecoveryState(config.internalPath, persisted, {
              pid: process.pid,
              generation: lifecycleGeneration,
              startToken,
              state: 'failed',
              error: forced.message,
            })
          } catch { /* The unconfirmed terminal publication stays the public failure. */ }
        }
      }
      if (failures.length > 0) throw lastFailure instanceof Error ? lastFailure : new AggregateError(failures, 'local daemon cleanup remains unconfirmed')
      children.clear()
      states.clear()
      lifecycle = 'stopped'
      lastFailure = undefined
    })()
    let completion!: Promise<void>
    completion = operation.catch(error => {
      if (lifecycle === 'stopping') lifecycle = lastFailure ? 'failed' : 'running'
      throw error
    }).finally(() => {
      if (stopping === completion) stopping = undefined
    })
    stopping = completion
    return completion
  }

  const start = (): Promise<void> => {
    if (stopping) return Promise.reject(new Error('local daemon cannot start while cleanup is in progress'))
    if (lifecycle === 'failed') return Promise.reject(lastFailure ?? new Error('local daemon requires cleanup before restart'))
    if (lifecycle === 'running') return Promise.resolve()
    if (starting) return starting
    starting = (async () => {
      lifecycle = 'starting'
      endpoints.clear()
      try {
        if (config.internalPath !== undefined) await projectLocalChildConfigs(config.internalPath)
        if (config.internalPath !== undefined) {
          const internal = await readLocalInternalConfig(config.internalPath)
          if (internal.launcher?.state === 'starting' && internal.launcher.startToken === startToken && internal.launcher.generation !== undefined) {
            reservedLauncherGeneration = internal.launcher.generation
            lifecycleGeneration = reservedLauncherGeneration
          }
        }
        const launcherGeneration = options.launcherGeneration ?? reservedLauncherGeneration
        const childEnv = { ...process.env, ...options.env }
        if (config.internalPath !== undefined && launcherGeneration !== undefined) {
          childEnv.TEAMS_LOCAL_CONFIG_PATH = config.configPath
          childEnv.TEAMS_LOCAL_INTERNAL_PATH = config.internalPath
          childEnv.TEAMS_LOCAL_LAUNCHER_GENERATION = String(launcherGeneration)
        } else {
          delete childEnv.TEAMS_LOCAL_CONFIG_PATH
          delete childEnv.TEAMS_LOCAL_INTERNAL_PATH
          delete childEnv.TEAMS_LOCAL_LAUNCHER_GENERATION
        }
        childEnv.TEAMS_LOCAL_START_TOKEN = startToken
        activeChildEnv = childEnv
        for (const spec of specs) {
          if (spec.kind === 'console') continue
          if (lifecycle !== 'starting') {
            if (lifecycle === 'failed') throw lastFailure ?? new Error('local daemon failed during startup')
            throw new Error('local daemon startup was cancelled')
          }
          const child = spawnProcess(nodeExecutable, [...(options.nodeArguments ?? []), spec.entry, ...spec.args, '--launcher-start-token', startToken], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
          children.set(spec.id, child)
          // daemon.generation is the launcher ownership generation used by the
          // stale-writer guard. Child network generation is owned by the child
          // readiness message and is not persisted into internal.toml.
          states.set(spec.id, { pid: child.pid ?? 0, entryPath: spec.entry, startToken, state: 'online', ...(launcherGeneration === undefined ? {} : { generation: launcherGeneration }) })
          if (config.internalPath !== undefined) {
            await writeLocalInternalState(config.internalPath, { [spec.id]: { pid: child.pid ?? 0, entryPath: spec.entry, startToken, state: 'online', ...(launcherGeneration === undefined ? {} : { generation: launcherGeneration }) } })
          }
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            if (lifecycle === 'stopping' || lifecycle === 'stopped') return
            lastFailure = new Error(`local ${spec.kind} exited unexpectedly code=${code ?? 'null'} signal=${signal ?? 'null'}`)
            lifecycle = 'failed'
          }
          const onError = (error: Error) => {
            if (lifecycle === 'stopping' || lifecycle === 'stopped') return
            lastFailure = error
            lifecycle = 'failed'
          }
          child.once('exit', onExit)
          child.once('error', onError)
          unwatch.set(spec.id, () => { child.off('exit', onExit); child.off('error', onError) })
          const ready = await waitForReady(child, spec.kind, startupTimeoutMs, config.internalPath !== undefined)
          if (spec.kind === 'agent') {
            if (config.internalPath !== undefined && ready?.endpoint === undefined) {
              throw new Error(`local agent ${spec.id} readiness did not provide status projection`)
            }
            if (ready?.endpoint !== undefined) {
              const endpoint = parseLocalDaemonEndpointProjection(ready.endpoint, `local agent ${spec.id} status`)
              if (ready.agentId !== endpoint.agentId) throw new Error(`local agent ${spec.id} registration identity does not match its status projection`)
              if (ready.generation !== endpoint.generation) throw new Error(`local agent ${spec.id} registration generation does not match its status projection`)
              endpoints.set(spec.id, endpoint)
            }
            states.set(spec.id, { pid: child.pid ?? 0, entryPath: spec.entry, startToken, state: 'online', ...(launcherGeneration === undefined ? {} : { generation: launcherGeneration }) })
            child.on('message', (message: unknown) => {
              if (typeof message !== 'object' || message === null) return
              const reply = message as { readonly kind?: unknown; readonly localCorrelation?: unknown; readonly reply?: unknown }
              if (reply.kind !== 'work.reply' || typeof reply.localCorrelation !== 'string') return
              const resolvePending = pendingWork.get(reply.localCorrelation)
              if (resolvePending === undefined) return
              pendingWork.delete(reply.localCorrelation)
              resolvePending(reply.reply as LocalWorkControlReply)
            })
          } else states.set(spec.id, { pid: child.pid ?? 0, entryPath: spec.entry, startToken, state: 'online', ...(launcherGeneration === undefined ? {} : { generation: launcherGeneration }) })
          if (lifecycle !== 'starting') throw lastFailure ?? new Error(`local ${spec.kind} failed during startup`)
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`local ${spec.kind} exited immediately after readiness code=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'}`)
          }
        }
        // A readiness IPC frame is not proof that the child stayed alive. Keep the
        // startup gate open for one bounded stability window so an immediate post-ready
        // exit is reported before the supervisor claims running.
        await new Promise<void>(resolveReady => { setTimeout(resolveReady, 75) })
        if (lifecycle !== 'starting') throw lastFailure ?? new Error('local daemon failed during startup')
        for (const child of children.values()) {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('local daemon exited during startup')
        }
        if (config.console?.enabled === true) {
          try { await startConsoleChild() }
          catch { /* Console is optional; its typed failure is durable and never fails daemon collaboration. */ }
        }
        if (config.internalPath !== undefined) {
          const internal = await readLocalInternalConfig(config.internalPath)
          const expectedReservation = options.launcherGeneration ?? reservedLauncherGeneration
          if (expectedReservation !== undefined) {
            if (internal.launcher?.state !== 'starting' || internal.launcher.startToken !== startToken || internal.launcher.generation !== expectedReservation) {
              throw new Error(`local supervisor start reservation was cancelled generation=${expectedReservation}`)
            }
            lifecycleGeneration = expectedReservation
          } else if (internal.launcher?.state === 'starting' && (internal.launcher.pid === 0 || internal.launcher.pid === process.pid)) {
            if (internal.launcher.startToken !== startToken) throw new Error('local supervisor start token does not match launcher reservation')
            lifecycleGeneration = internal.launcher.generation
          } else lifecycleGeneration += 1
        } else lifecycleGeneration += 1
        // Open the local Work control socket and publish its exact refs before the
        // launcher advertises running; admission stays closed until listen succeeds.
        if (socketPath !== undefined && config.internalPath !== undefined) {
          try {
            const stale = await lstat(socketPath)
            if (stale.isSocket()) await rm(socketPath, { force: true })
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
          }
          workControl = await startLocalWorkControlListener({
            socketPath,
            launcherGeneration: lifecycleGeneration,
            startToken,
            receivers,
            handler: async input => {
              const result = await forwardWork(input)
              await input.respond(result)
              return result
            },
            consoleHandler: async input => {
              try {
                const status = input.frame.kind === 'console.start'
                  ? await consoleStart(input.frame.expectedConsoleGeneration)
                  : input.frame.kind === 'console.stop'
                    ? await consoleStop(input.frame.expectedConsoleGeneration)
                    : await consoleStatusRead()
                await input.respond({ kind: 'console.result', correlationId: input.frame.correlationId, ok: true, status })
              } catch (error) {
                const code = error instanceof LocalConsoleLifecycleError ? error.code : 'CONSOLE_STATUS_UNAVAILABLE'
                await input.respond({
                  kind: 'console.result',
                  correlationId: input.frame.correlationId,
                  ok: false,
                  error: { code, message: error instanceof Error ? error.message : String(error) },
                })
              }
            },
          })
          await writeLocalInternalWorkControl(config.internalPath, {
            socketPath,
            launcherGeneration: lifecycleGeneration,
            launcherStartToken: startToken,
          })
        }
        if (config.internalPath !== undefined) {
          await writeLocalInternalState(config.internalPath, Object.fromEntries(states.entries()))
          await writeLocalLauncherOwnership(config.internalPath, { version: 1, pid: process.pid, startToken })
          await writeLocalDaemonStatusProjection(config.internalPath, {
            version: 1,
            generation: lifecycleGeneration,
            startToken,
            daemons: Object.fromEntries([...endpoints.entries()].map(([id, endpoint]) => [id, {
              ...endpoint,
              presence: 'online' as const,
              state: 'online' as const,
            }])),
          })
          await writeLocalInternalLauncherState(config.internalPath, { pid: process.pid, generation: lifecycleGeneration, startToken, state: 'running' })
        }
        lifecycle = 'running'
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error(String(error))
        lifecycle = 'failed'
        try { await stop() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'local daemon startup and cleanup failed') }
        throw error
      } finally { starting = undefined }
    })()
    return starting
  }

  return {
    state: () => lifecycle,
    failure: () => lastFailure,
    processes: () => specs,
    generation: () => lifecycleGeneration,
    start,
    stop,
    consoleStatus: consoleStatusRead,
    consoleStart,
    consoleStop,
  }
}
