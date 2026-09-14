import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectLocalChildConfigs, readLocalInternalConfig, writeLocalInternalLauncherState, writeLocalInternalState, writeLocalLauncherOwnership, type LocalConfig, type LocalInternalDaemonState } from './local-config.ts'

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

async function waitForReady(child: ChildProcess, kind: LocalProcessSpec['kind'], deadlineMs: number): Promise<Record<string, unknown> | undefined> {
  const output = { stdout: '', stderr: '' }
  return await new Promise<Record<string, unknown> | undefined>((resolveReady, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (timer !== undefined) clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('message', onMessage)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      if (error) reject(error); else resolveReady(value)
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`local ${kind} exited before readiness code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${output.stderr}`))
    const onStdout = (chunk: Buffer | string) => {
      output.stdout += chunk.toString()
      if (kind === 'relay' && output.stdout.includes('relay listening ')) finish()
    }
    const onStderr = (chunk: Buffer | string) => { output.stderr += chunk.toString() }
    const onMessage = (message: unknown) => {
      if (kind === 'agent' && typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'daemon.registered') {
        finish(undefined, message as Record<string, unknown>)
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
          const ready = await waitForReady(child, spec.kind, startupTimeoutMs)
          if (spec.kind === 'agent') {
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
