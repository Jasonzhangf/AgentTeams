import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { LocalConfig } from './local-config.ts'

export interface LocalProcessSpec {
  readonly id: string
  readonly kind: 'relay' | 'agent'
  readonly entry: string
  readonly args: readonly string[]
}

export interface LocalSupervisorOptions {
  readonly nodeExecutable?: string
  readonly relayEntry?: string
  readonly agentEntry?: string
  readonly env?: NodeJS.ProcessEnv
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

async function waitForReady(child: ChildProcess, kind: LocalProcessSpec['kind'], deadlineMs: number): Promise<void> {
  const output = { stdout: '', stderr: '' }
  await new Promise<void>((resolveReady, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (timer !== undefined) clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('message', onMessage)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      if (error) reject(error); else resolveReady()
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`local ${kind} exited before readiness code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${output.stderr}`))
    const onStdout = (chunk: Buffer | string) => {
      output.stdout += chunk.toString()
      if (kind === 'relay' && output.stdout.includes('relay listening ')) finish()
    }
    const onStderr = (chunk: Buffer | string) => { output.stderr += chunk.toString() }
    const onMessage = (message: unknown) => {
      if (kind === 'agent' && typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'daemon.registered') finish()
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
  const unwatch = new Map<string, () => void>()
  let lifecycle: LocalSupervisorState = 'stopped'
  let lastFailure: Error | undefined
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined

  const stop = (): Promise<void> => {
    if (stopping) return stopping
    let operation!: Promise<void>
    operation = (async () => {
      lifecycle = 'stopping'
      const failures: unknown[] = []
      for (const spec of [...specs].reverse()) {
        const child = children.get(spec.id)
        if (!child) continue
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          await waitForExit(child, stopTimeoutMs)
        } catch (error) { failures.push(error) }
        unwatch.get(spec.id)?.()
        unwatch.delete(spec.id)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'local daemon cleanup remains unconfirmed')
      children.clear()
      lifecycle = 'stopped'
      lastFailure = undefined
    })()
    stopping = operation
    void operation.catch(() => { if (lifecycle === 'stopping') lifecycle = lastFailure ? 'failed' : 'running' }).finally(() => {
      if (stopping === operation) stopping = undefined
    })
    return operation
  }

  const start = (): Promise<void> => {
    if (lifecycle === 'running') return Promise.resolve()
    if (starting) return starting
    starting = (async () => {
      lifecycle = 'starting'
      try {
        for (const spec of specs) {
          if (lifecycle !== 'starting') {
            if (lifecycle === 'failed') throw lastFailure ?? new Error('local daemon failed during startup')
            throw new Error('local daemon startup was cancelled')
          }
          const child = spawnProcess(nodeExecutable, [spec.entry, ...spec.args], { env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
          children.set(spec.id, child)
          await waitForReady(child, spec.kind, startupTimeoutMs)
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`local ${spec.kind} exited immediately after readiness code=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'}`)
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
        }
        lifecycle = 'running'
      } catch (error) {
        try { await stop() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'local daemon startup and cleanup failed') }
        throw error
      } finally { starting = undefined }
    })()
    return starting
  }

  return { state: () => lifecycle, failure: () => lastFailure, processes: () => specs, start, stop }
}
