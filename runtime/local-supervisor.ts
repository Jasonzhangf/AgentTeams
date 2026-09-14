import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectLocalChildConfigs, readLocalInternalConfig, writeLocalInternalLauncherState, writeLocalInternalState, writeLocalLauncherOwnership, type LocalConfig, type LocalInternalDaemonState } from './local-config.ts'

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
  readonly kind: 'relay' | 'agent'
  readonly entry: string
  readonly args: readonly string[]
}

export interface LocalSupervisorOptions {
  readonly nodeExecutable?: string
  /** Runtime flags are explicit so source and packaged entrypoints share the same child contract. */
  readonly nodeArguments?: readonly string[]
  readonly relayEntry?: string
  readonly agentEntry?: string
  readonly env?: NodeJS.ProcessEnv
  readonly startToken?: string
  readonly launcherGeneration?: number
  readonly startupTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly spawn?: typeof nodeSpawn
}

export type LocalSupervisorState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

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

function defaultEntry(name: 'relay-process' | 'agent-process'): string {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url))
  return resolve(runtimeDirectory, `../${name === 'relay-process' ? 'server' : 'runtime'}/${name}.js`)
}

export function planLocalProcesses(config: LocalConfig, options: Pick<LocalSupervisorOptions, 'nodeExecutable' | 'relayEntry' | 'agentEntry'> = {}): readonly LocalProcessSpec[] {
  const relayEntry = options.relayEntry ?? defaultEntry('relay-process')
  const agentEntry = options.agentEntry ?? defaultEntry('agent-process')
  const specs: LocalProcessSpec[] = [{ id: 'relay', kind: 'relay', entry: relayEntry, args: ['--config', config.relay.configPath] }]
  for (const daemon of config.daemons) {
    if (daemon.enabled) specs.push({ id: daemon.id, kind: 'agent', entry: agentEntry, args: ['--config', daemon.configPath] })
  }
  return specs
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
      if (kind !== 'agent' || typeof message !== 'object' || message === null) return
      const control = message as { kind?: unknown; endpoint?: unknown }
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
    if (kind === 'agent') child.on('message', onMessage)
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
  let lifecycle: LocalSupervisorState = 'stopped'
  let lastFailure: Error | undefined
  let lifecycleGeneration = 0
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  const startToken = options.startToken ?? randomUUID()
  let reservedLauncherGeneration: number | undefined

  const stop = (): Promise<void> => {
    if (stopping) return stopping
    let operation!: Promise<void>
    operation = (async () => {
      const hadFailure = lifecycle === 'failed' || lastFailure !== undefined
      lifecycle = 'stopping'
      const failures: unknown[] = []
      for (const spec of [...specs].reverse()) {
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
        const failed = hadFailure || lifecycle === 'failed' || failures.length > 0
        const persisted: Record<string, LocalInternalDaemonState> = Object.fromEntries([...states.entries()].map(([id, state]) => [id, { ...state, state: failed ? 'failed' : 'stopped' as const }]))
        try { await writeLocalInternalState(config.internalPath, persisted) } catch (error) { failures.push(error) }
        try {
          await writeLocalInternalLauncherState(config.internalPath, {
            pid: process.pid,
            generation: lifecycleGeneration,
            startToken,
            state: failed ? 'failed' : 'stopped',
            ...(failed && lastFailure !== undefined ? { error: lastFailure.message } : {}),
          })
        } catch (error) { failures.push(error) }
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
        } catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'local daemon cleanup remains unconfirmed')
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
          childEnv.TEAMS_LOCAL_INTERNAL_PATH = config.internalPath
          childEnv.TEAMS_LOCAL_LAUNCHER_GENERATION = String(launcherGeneration)
        } else {
          delete childEnv.TEAMS_LOCAL_INTERNAL_PATH
          delete childEnv.TEAMS_LOCAL_LAUNCHER_GENERATION
        }
        childEnv.TEAMS_LOCAL_START_TOKEN = startToken
        for (const spec of specs) {
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

  return { state: () => lifecycle, failure: () => lastFailure, processes: () => specs, generation: () => lifecycleGeneration, start, stop }
}
