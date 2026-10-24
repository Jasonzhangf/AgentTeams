import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { JsonValue } from '../packages/shared/src/agent-services.ts'
import type { AcpFault, AcpFrame, AcpRpcId } from '../packages/shared/src/acp.ts'
import { AcpError, parseAcpFrame } from '../packages/shared/src/acp.ts'
import type { AcpDuplex, EngineHandle, EngineLaunchSpec, EngineStopResult } from '../packages/shared/src/engine.ts'
import type { AcpPolicyIntent, AcpPolicySnapshot } from '../config/acp-policy.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from '../config/acp-policy.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'
import { createAcpHost, rpcIdKey, type AcpHost, type AcpPolicyAssert } from '../agent-host/acp-host.ts'
import { createStdioAcpDuplex } from '../acp-adapter/stdio.ts'

/**
 * Runtime child / stdio / Session owner for one ACP agent daemon.
 *
 * Owner: runtime. It launches the engine from the adapter's compiled
 * `EngineLaunchSpec`, owns the one stdio `AcpDuplex`, performs the single
 * bootstrap `initialize` as the sole reader before ownership transfer, and
 * composes the agent-host ACP host. It interprets no Session business.
 *
 * The legacy OpenCode SDK Session path (`runtime/agent-process.ts`
 * `createSessionHost` over the HTTP SDK client) stays untouched: it is the
 * D02 switch point, and this module does not add a second execution entry.
 *
 * Minimal call example (an adapter supplies `launch`; nothing else is
 * engine-specific):
 *
 * ```ts
 * const store = await createAcpHistoryStore({ directory: daemonDataDirectory })
 * const outcome = await startAcpAgentDaemon({
 *   launch: await adapter.compileLaunch(launchInput),
 *   engineInstanceId,
 *   targetGeneration,
 *   policy: { intent: acceptedConfig.acp, adapterMethods: adapter.declaredMethods },
 *   history: store,
 *   initialize: { params: { clientCapabilities: {} }, timeoutMs: 10_000 },
 *   stopTimeoutMs: 3_000,
 * })
 * if (outcome.kind === 'failed') throw new AcpError(outcome.fault.code, outcome.fault.message)
 * await outcome.daemon.host.open({ ref, principal, policy: outcome.daemon.policy })
 * ```
 */

export interface StartAcpEngineInput {
  readonly launch: EngineLaunchSpec
  readonly engineInstanceId: string
  readonly targetGeneration: number
  readonly stopTimeoutMs: number
  readonly resolveCredential?: (reference: string) => Promise<string>
  readonly readTimeoutMs?: number
  readonly maxFrameBytes?: number
}

export type StartAcpEngineOutcome =
  | { readonly kind: 'started'; readonly handle: EngineHandle }
  /**
   * `cleanup` is the real stop result of the spawned child. It is null only
   * when no OS process was created (pre-spawn validation, spawn error, or a
   * pid-less child), so a failed start can never hide a running engine.
   */
  | { readonly kind: 'failed'; readonly fault: AcpFault; readonly cleanup: EngineStopResult | null }

export interface BootstrapAcpInitializeInput {
  readonly params?: JsonValue
  readonly timeoutMs: number
  readonly requestId?: AcpRpcId
}

export type BootstrapAcpInitializeOutcome =
  | { readonly kind: 'initialized'; readonly result: AcpFrame }
  | { readonly kind: 'failed'; readonly fault: AcpFault }

export interface AcpDaemonPolicyInput {
  readonly intent: AcpPolicyIntent
  /** Adapter-verified extension methods merged into the capability set. */
  readonly adapterMethods?: readonly string[]
  /** Policy keys the adapter can actually enforce. Defaults to `supported`. */
  readonly enforceablePolicies?: readonly string[]
}

export interface StartAcpDaemonInput {
  readonly launch: EngineLaunchSpec
  readonly engineInstanceId: string
  readonly targetGeneration: number
  /**
   * Resolved after the bootstrap initialize, because the supported capability
   * set is the real initialize declaration plus the adapter declaration. The
   * caller never re-initializes the child per client.
   */
  readonly policy: AcpDaemonPolicyInput
  readonly history: AcpHistoryPort
  readonly initialize: BootstrapAcpInitializeInput
  readonly stopTimeoutMs: number
  readonly resolveCredential?: (reference: string) => Promise<string>
  readonly readTimeoutMs?: number
  readonly maxFrameBytes?: number
  readonly agentId?: string
  readonly maxDeliveryBacklog?: number
  readonly onHistoryFault?: (fault: AcpFault) => void
  /** Defaults to the config-owned `assertAcpAllowed`. */
  readonly assertAllowed?: AcpPolicyAssert
}

export interface AcpAgentDaemon {
  readonly handle: EngineHandle
  readonly host: AcpHost
  /** The genuine bootstrap initialize response the host serves to channels. */
  readonly initializeResult: AcpFrame
  /** The resolved policy snapshot for this engine instance. */
  readonly policy: AcpPolicySnapshot
  stop(): Promise<EngineStopResult>
}

export type StartAcpDaemonOutcome =
  | { readonly kind: 'started'; readonly daemon: AcpAgentDaemon }
  | { readonly kind: 'failed'; readonly fault: AcpFault; readonly cleanup: EngineStopResult | null }

function faultFrom(cause: unknown, fallback: AcpFault['code']): AcpFault {
  if (cause instanceof AcpError) return cause.toFault()
  return { code: fallback, message: cause instanceof Error ? cause.message : 'ACP operation failed' }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `${label} must be a positive safe integer`)
  }
}

async function withDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new AcpError('ENGINE_UNAVAILABLE', message)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AcpError('ENGINE_UNAVAILABLE', message)), remaining)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Write the adapter's compiled files and resolve its credential env refs, then
 * spawn exactly one child over the stdio ACP duplex.
 */
export async function startAcpEngineHandle(input: StartAcpEngineInput): Promise<StartAcpEngineOutcome> {
  let launch: EngineLaunchSpec
  let env: Record<string, string>
  try {
    if (input === null || typeof input !== 'object') throw new AcpError('UNSUPPORTED_CONFIGURATION', 'engine start input is required')
    launch = input.launch
    if (launch === null || typeof launch !== 'object') throw new AcpError('UNSUPPORTED_CONFIGURATION', 'engine launch spec is required')
    if (!isAbsolute(launch.executable)) throw new AcpError('UNSUPPORTED_CONFIGURATION', 'engine executable must be an absolute path')
    if (!isAbsolute(launch.cwd)) throw new AcpError('UNSUPPORTED_CONFIGURATION', 'engine cwd must be an absolute path')
    assertPositiveInteger(input.stopTimeoutMs, 'stopTimeoutMs')
    if (typeof input.engineInstanceId !== 'string' || input.engineInstanceId.length === 0) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', 'engineInstanceId is required')
    }
    assertPositiveInteger(input.targetGeneration, 'targetGeneration')

    env = { ...launch.env }
    for (const [key, reference] of Object.entries(launch.credentialEnvRefs)) {
      if (input.resolveCredential === undefined) {
        throw new AcpError('UNSUPPORTED_CONFIGURATION', `engine launch needs credential ${reference} but no resolver is configured`)
      }
      const value = await input.resolveCredential(reference)
      if (typeof value !== 'string' || value.length === 0) {
        throw new AcpError('UNSUPPORTED_CONFIGURATION', `engine credential ${reference} is unavailable`)
      }
      env[key] = value
    }
    for (const file of launch.files) {
      if (!isAbsolute(file.path)) throw new AcpError('UNSUPPORTED_CONFIGURATION', 'engine launch file path must be absolute')
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 })
      await writeFile(file.path, file.content, { encoding: 'utf8', mode: file.mode })
    }
  } catch (cause) {
    // Nothing has been spawned yet, so there is no child to clean up.
    return { kind: 'failed', fault: faultFrom(cause, 'ENGINE_UNAVAILABLE'), cleanup: null }
  }

  let child: ChildProcess
  try {
    child = spawn(launch.executable, [...launch.args], {
      cwd: launch.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (cause) {
    return { kind: 'failed', fault: faultFrom(cause, 'ENGINE_UNAVAILABLE'), cleanup: null }
  }

  let ended = false
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(resolve => {
    child.once('error', () => { ended = true; resolve({ code: null, signal: null }) })
    child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }) })
  })
  const spawnFailure = await new Promise<Error | null>(resolve => {
    child.once('spawn', () => resolve(null))
    child.once('error', error => resolve(error))
  })
  if (spawnFailure !== null) {
    // The spawn failed before exec, so no OS process exists to reap.
    return { kind: 'failed', fault: { code: 'ENGINE_UNAVAILABLE', message: `engine failed to start: ${spawnFailure.message}` }, cleanup: null }
  }
  const pid = child.pid
  if (pid === undefined) {
    child.kill('SIGKILL')
    return { kind: 'failed', fault: { code: 'ENGINE_UNAVAILABLE', message: 'engine started without a pid' }, cleanup: null }
  }

  let stopping: Promise<EngineStopResult> | undefined
  const confirmExit = async (deadlineMs: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('exit window elapsed')), deadlineMs) }),
      ])
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
  const stop = (): Promise<EngineStopResult> => {
    if (stopping !== undefined) return stopping
    stopping = (async (): Promise<EngineStopResult> => {
      if (ended) return { kind: 'exited', code: child.exitCode, signal: child.signalCode }
      const deadline = Date.now() + input.stopTimeoutMs
      child.kill('SIGTERM')
      if (await confirmExit(Math.max(1, Math.floor(input.stopTimeoutMs / 2)))) {
        return { kind: 'exited', code: child.exitCode, signal: child.signalCode }
      }
      child.kill('SIGKILL')
      if (await confirmExit(Math.max(1, deadline - Date.now()))) {
        return { kind: 'exited', code: child.exitCode, signal: child.signalCode }
      }
      return {
        kind: 'retained',
        pid,
        error: { code: 'ENGINE_UNAVAILABLE', message: 'engine exit remains unconfirmed after SIGKILL' },
      }
    })()
    return stopping
  }

  if (child.stdout === null || child.stdin === null) {
    return {
      kind: 'failed',
      fault: { code: 'ENGINE_UNAVAILABLE', message: 'engine child did not expose stdio pipes' },
      cleanup: await stop(),
    }
  }

  let acp: AcpDuplex
  try {
    acp = createStdioAcpDuplex({
      readable: child.stdout,
      writable: child.stdin,
      ...(input.maxFrameBytes === undefined ? {} : { maxFrameBytes: input.maxFrameBytes }),
      ...(input.readTimeoutMs === undefined ? {} : { readTimeoutMs: input.readTimeoutMs }),
    })
  } catch (cause) {
    // The child is already running: reap it before reporting the failure.
    return { kind: 'failed', fault: faultFrom(cause, 'UNSUPPORTED_CONFIGURATION'), cleanup: await stop() }
  }

  return {
    kind: 'started',
    handle: {
      engineInstanceId: input.engineInstanceId,
      pid,
      targetGeneration: input.targetGeneration,
      acp,
      exited,
      stop,
    },
  }
}

/**
 * Perform the single real `initialize` exchange as the sole reader of the
 * duplex. The captured response is the only initialize result the agent-host
 * will ever serve; no per-client re-initialization exists.
 */
export async function bootstrapAcpInitialize(
  handle: EngineHandle,
  input: BootstrapAcpInitializeInput,
): Promise<BootstrapAcpInitializeOutcome> {
  try {
    assertPositiveInteger(input?.timeoutMs, 'initialize timeoutMs')
    const id = input.requestId ?? `acp-initialize-${handle.engineInstanceId}`
    const deadline = Date.now() + input.timeoutMs
    const frame: AcpFrame = {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: input.params ?? {},
    }
    await withDeadline(handle.acp.send(frame), deadline, `ACP initialize write timed out after ${input.timeoutMs}ms`)
    for (;;) {
      const received = await withDeadline(handle.acp.read(), deadline, `ACP initialize timed out after ${input.timeoutMs}ms`)
      const parsed = parseAcpFrame(received)
      if (typeof parsed.method === 'string') {
        return { kind: 'failed', fault: { code: 'ENGINE_UNAVAILABLE', message: 'engine sent ACP traffic before initialize completed' } }
      }
      if (rpcIdKey(parsed.id as AcpRpcId) !== rpcIdKey(id)) {
        return { kind: 'failed', fault: { code: 'ENGINE_UNAVAILABLE', message: 'engine answered an unknown request during initialize' } }
      }
      if (Object.hasOwn(parsed, 'error')) {
        return {
          kind: 'failed',
          fault: { code: 'ENGINE_UNAVAILABLE', message: `engine initialize failed: ${JSON.stringify(parsed.error)}`, detail: parsed.error },
        }
      }
      return { kind: 'initialized', result: parsed }
    }
  } catch (cause) {
    return { kind: 'failed', fault: faultFrom(cause, 'ENGINE_UNAVAILABLE') }
  }
}

/** Start one ACP agent daemon: child, stdio duplex, bootstrap initialize, host. */
export async function startAcpAgentDaemon(input: StartAcpDaemonInput): Promise<StartAcpDaemonOutcome> {
  const started = await startAcpEngineHandle(input)
  if (started.kind === 'failed') return { kind: 'failed', fault: started.fault, cleanup: started.cleanup }
  const handle = started.handle
  const initialized = await bootstrapAcpInitialize(handle, input.initialize)
  if (initialized.kind === 'failed') {
    return { kind: 'failed', fault: initialized.fault, cleanup: await handle.stop() }
  }
  try {
    const supported = extractAcpCapabilities(initialized.result, input.policy.adapterMethods ?? [])
    const policy: AcpPolicySnapshot = resolveAcpPolicy({
      intent: input.policy.intent,
      engineInstanceId: input.engineInstanceId,
      supported,
      enforceablePolicies: input.policy.enforceablePolicies ?? supported,
    })
    const host = createAcpHost({
      handle,
      initializeResult: initialized.result,
      policy,
      history: input.history,
      assertAllowed: input.assertAllowed ?? assertAcpAllowed,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.maxDeliveryBacklog === undefined ? {} : { maxDeliveryBacklog: input.maxDeliveryBacklog }),
      ...(input.onHistoryFault === undefined ? {} : { onHistoryFault: input.onHistoryFault }),
    })
    return {
      kind: 'started',
      daemon: { handle, host, initializeResult: initialized.result, policy, stop: () => handle.stop() },
    }
  } catch (cause) {
    return { kind: 'failed', fault: faultFrom(cause, 'ENGINE_UNAVAILABLE'), cleanup: await handle.stop() }
  }
}
