import { accessSync, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, isIP, type Server, type Socket } from 'node:net'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AuthenticatedAgent, JsonValue } from '../control-protocol/agent-services.ts'
import type { AcpChannelRef, AcpDelivery, AcpFrame, AcpRpcId } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { AcpDuplex, EngineLaunchInput, EngineStopResult } from '../control-protocol/engine.ts'
import type { AgentDaemonIntent, DaemonEffectiveConfig, EngineKind } from '../config/daemon-intent.ts'
import {
  DaemonIntentError,
  applyDaemonCliOverrides,
  compileDaemonIntent,
  createDaemonIntentContext,
  isAgentIntent,
  parseDaemonConfigText,
  parseDaemonIntent,
  readDaemonEffectiveConfig,
  resolveDaemonIntent,
  type DaemonIntentV4,
} from '../config/daemon-intent.ts'
import type { AgentModelBinding, ConfigTargetIdentity, ModelRef, VersionedRuntimeConfig } from '../config/runtime-config.ts'
import { providerIntentFingerprint } from '../config/runtime-config.ts'
import { createStdioAcpDuplex } from '../acp-adapter/stdio.ts'
import { rpcErrorFrame, type AcpHost } from '../agent-host/acp-host.ts'
import { openCodeAcpAdapter } from '../opencode-adapter/src/acp-engine.ts'
import { createAcpHistoryStore } from './acp-history-store.ts'
import { startAcpAgentDaemon, type AcpAgentDaemon } from './acp-daemon.ts'

/**
 * `agentteams --serve <engine>` user entry (owner: runtime).
 *
 * One invocation reads one v4 agent config, compiles the accepted config with
 * the config-owned compiler, starts exactly one agent daemon through the D01
 * runtime (`startAcpAgentDaemon` + the acp-adapter stdio duplex + `createAcpHost`)
 * with the D02 OpenCode adapter as the only OpenCode config compiler, proves the
 * effective model from the engine's own `session/new` result, then serves local
 * ACP channels on the daemon's configured listener.
 *
 * This module declares no second Session path, no second ACP frame transport and
 * no second OpenCode config compiler: the listener reuses the one
 * `createStdioAcpDuplex` codec over its socket, the host owns Session/RPC
 * semantics, and `runtime/agent-process.ts` stays the legacy Work entry.
 *
 * The listener is a loopback ACP channel endpoint. Cross-agent admission and
 * negotiation (the frozen Teams connection frames) belong to the
 * network/registration increment; a non-loopback listener is refused here
 * instead of being served without the TLS/admission transport.
 */

const DEFAULT_INITIALIZE_TIMEOUT_MS = 20_000
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const CHANNEL_POLL_INTERVAL_MS = 5
const DELIVERY_PAGE_LIMIT = 200
const QUICK_START_AGENT_ID = 'agent'

export interface AcpServeIntentInput {
  /** Omitted means the CLI quick-start base intent (no provider/model binding). */
  readonly configPath?: string
  readonly engine: EngineKind
  readonly ip?: string
  readonly port?: number
  readonly home?: string
}

export interface AcpServeIntent {
  /** Null when the quick-start base intent was built instead of a config file. */
  readonly configPath: string | null
  readonly intent: AgentDaemonIntent
  readonly accepted: VersionedRuntimeConfig
  /** The one binding the entry proved present before it may start an engine. */
  readonly binding: AgentModelBinding
  readonly effective: DaemonEffectiveConfig
  /** sha256 of the exact config text the accepted snapshot was compiled from. */
  readonly sourceHash: string
}

export interface AcpServeRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly initializeTimeoutMs?: number
  readonly stopTimeoutMs?: number
}

export interface AcpServeReadiness {
  readonly agentId: string
  readonly engineKind: 'opencode'
  readonly engineInstanceId: string
  readonly enginePid: number
  readonly listener: { readonly ip: string; readonly port: number }
  /** Non-null only when the engine's own session/new result proves this model. */
  readonly modelTarget: ModelRef | null
  readonly modelVerification: string
  readonly effectiveRevision: number
  readonly evidence: JsonValue
}

export interface AcpServeStopReceipt {
  readonly engine: EngineStopResult
  /** Live ACP channels that were destroyed by the stop. */
  readonly channels: number
}

export interface AcpServeHandle {
  readonly agentId: string
  readonly engineInstanceId: string
  readonly enginePid: number
  readonly configPath: string | null
  readonly dataDirectory: string
  readonly listener: { readonly ip: string; readonly port: number }
  readonly readiness: AcpServeReadiness
  readonly daemon: AcpAgentDaemon
  stop(): Promise<AcpServeStopReceipt>
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/**
 * Translate a config rejection into the one ACP fault family. The original
 * config code and message stay in `detail`, so a caller never loses which config
 * rule failed.
 */
function configFault(cause: unknown): AcpError {
  if (cause instanceof AcpError) return cause
  if (cause instanceof DaemonIntentError) {
    return new AcpError('UNSUPPORTED_CONFIGURATION', cause.message, { source: 'config', code: cause.code })
  }
  return new AcpError('UNSUPPORTED_CONFIGURATION', messageOf(cause, 'daemon config is invalid'))
}

function isLoopbackAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith('127.')
  return ip === '::1'
}

/**
 * The CLI quick-start base intent (D00 §5.7 single writer). It carries no
 * provider, catalog or model, so the entry refuses it with an explicit missing
 * binding instead of letting the engine pick a default model.
 */
export function buildQuickStartAgentIntent(input: {
  readonly engine: EngineKind
  readonly ip: string
  readonly port: number
  readonly home?: string
}): AgentDaemonIntent {
  const home = input.home ?? homedir()
  return {
    version: 4,
    daemon: {
      kind: 'agent',
      id: QUICK_START_AGENT_ID,
      hostId: 'local',
      accountId: 'local',
      scopeId: 'local',
      dataDirectory: join(home, '.agentteams', 'agents', QUICK_START_AGENT_ID),
    },
    engine: { kind: input.engine },
    listen: { ip: input.ip, port: input.port },
    acp: { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
    relations: { allowed: ['peer'] },
    admissions: [],
    peers: {},
    providers: {},
    models: [],
  }
}

/**
 * Read one v4 agent config (or build the quick-start base intent), apply the
 * explicit `--serve/--ip/--port` overrides, resolve paths, compile the accepted
 * snapshot and enforce the entry's preconditions: an agent daemon, an enabled
 * ACP policy, a loopback listener, a delivered engine adapter and a real
 * provider/model binding. It starts nothing.
 */
export async function readAcpServeIntent(input: AcpServeIntentInput): Promise<AcpServeIntent> {
  if (input === null || typeof input !== 'object') {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'serve input is required')
  }
  const engine = input.engine
  if (engine !== 'opencode' && engine !== 'dsh') {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `--serve requires opencode or dsh, got ${String(engine)}`)
  }
  if ((input.ip === undefined) !== (input.port === undefined)) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', '--ip and --port must be given together')
  }

  let text: string
  let configPath: string | null
  let configDirectory: string
  let parsed: DaemonIntentV4
  if (input.configPath === undefined) {
    if (input.ip === undefined || input.port === undefined) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', 'the quick-start entry requires --ip and --port; without them pass --config <agent.toml>')
    }
    configPath = null
    configDirectory = resolve(input.home ?? homedir(), '.agentteams')
    const base = buildQuickStartAgentIntent({
      engine,
      ip: input.ip,
      port: input.port,
      ...(input.home === undefined ? {} : { home: input.home }),
    })
    text = JSON.stringify(base)
    try {
      parsed = parseDaemonIntent(base, createDaemonIntentContext())
    } catch (cause) {
      throw configFault(cause)
    }
  } else {
    configPath = resolve(input.configPath)
    configDirectory = dirname(configPath)
    try {
      text = await readFile(configPath, 'utf8')
    } catch (cause) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `serve config cannot be read (${configPath}): ${messageOf(cause, 'read failed')}`)
    }
    try {
      parsed = parseDaemonConfigText(text, createDaemonIntentContext())
    } catch (cause) {
      throw configFault(cause)
    }
  }

  let intent: DaemonIntentV4
  try {
    const overridden = applyDaemonCliOverrides(parsed, {
      engine,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      ...(input.port === undefined ? {} : { port: input.port }),
    })
    intent = resolveDaemonIntent(overridden, { configDirectory })
  } catch (cause) {
    throw configFault(cause)
  }
  const source = configPath ?? 'the quick-start config'
  if (!isAgentIntent(intent)) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `--serve requires an agent daemon config; ${source} declares a ${intent.daemon.kind} daemon`)
  }
  if (intent.engine === undefined) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `agent ${intent.daemon.id} declares no engine`)
  }
  if (intent.engine.kind !== 'opencode') {
    throw new AcpError(
      'UNSUPPORTED_CONFIGURATION',
      `--serve ${intent.engine.kind} is not delivered in this increment: the DSH engine adapter exists at source level (dsh-adapter/**), but the serve wiring that composes it is not delivered; a follow-up increment wires --serve dsh. Only --serve opencode is wired.`,
    )
  }
  if (!intent.acp.enabled) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `agent ${intent.daemon.id} has acp disabled; --serve requires an enabled ACP policy`)
  }
  if (intent.listen === undefined) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `agent ${intent.daemon.id} declares no listener; --serve requires [listen] or --ip/--port`)
  }
  if (!isLoopbackAddress(intent.listen.ip)) {
    throw new AcpError(
      'UNSUPPORTED_CONFIGURATION',
      `the --serve entry serves only a loopback ACP channel endpoint; ${intent.listen.ip} needs the TLS/admission transport owned by the network increment`,
    )
  }
  const accepted = compileDaemonIntent(intent, { configDirectory })
  const binding = accepted.agents[intent.daemon.id]
  if (binding === undefined) {
    throw new AcpError(
      'UNSUPPORTED_CONFIGURATION',
      `agent ${intent.daemon.id} has no provider/model binding: ${source} declares no [model.primary]; `
      + 'the --serve entry refuses to start an engine on an unbound agent and never relies on the engine default model',
      { source: 'config', code: 'NOT_FOUND', agentId: intent.daemon.id, binding: 'model.primary' },
    )
  }
  return {
    configPath,
    intent,
    accepted,
    binding,
    effective: readDaemonEffectiveConfig(intent),
    sourceHash: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, 0o1)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The installed OpenCode executable: config path, then project env, then PATH. */
export function resolveOpenCodeExecutable(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `engine.executable must be an absolute installed path, got ${configured}`)
    }
    if (!isExecutableFile(configured)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `engine.executable is not an executable file: ${configured}`)
    }
    return configured
  }
  const override = env.AGENTTEAMS_OPENCODE_EXECUTABLE ?? env.OPENCODE_EXECUTABLE
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `the OpenCode executable override must be an absolute path, got ${override}`)
    }
    if (!isExecutableFile(override)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `the OpenCode executable override is not an executable file: ${override}`)
    }
    return override
  }
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = resolve(directory, 'opencode')
    if (isExecutableFile(candidate)) return candidate
  }
  throw new AcpError(
    'UNSUPPORTED_CONFIGURATION',
    'no OpenCode executable is configured: set [engine].executable, AGENTTEAMS_OPENCODE_EXECUTABLE or OPENCODE_EXECUTABLE, or install opencode on PATH',
  )
}

/**
 * Resolve one opaque credential reference into the child environment. The
 * accepted config stores only a reference, so a plaintext secret is refused.
 */
async function resolveCredentialReference(reference: string, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnvironment = (name: string): string => {
    const value = env[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new AcpError('AUTHENTICATION_REQUIRED', `credential environment variable ${name} is not set`)
    }
    return value
  }
  if (reference.startsWith('env:')) return fromEnvironment(reference.slice('env:'.length))
  if (reference.startsWith('file:')) {
    const path = resolve(reference.slice('file:'.length))
    try {
      const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '')
      if (value.length === 0) throw new AcpError('AUTHENTICATION_REQUIRED', `credential file ${path} is empty`)
      return value
    } catch (cause) {
      if (cause instanceof AcpError) throw cause
      throw new AcpError('AUTHENTICATION_REQUIRED', `credential file ${path} cannot be read: ${messageOf(cause, 'read failed')}`)
    }
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) return fromEnvironment(reference)
  throw new AcpError('UNSUPPORTED_CONFIGURATION', `credential reference ${reference} is not env:NAME, file:<path> or an environment-variable name`)
}

function principalOf(intent: AgentDaemonIntent): AuthenticatedAgent {
  // The loopback listener is the daemon's own local channel endpoint; the
  // principal is the daemon's configured identity because cross-agent channel
  // admission and negotiation are owned by the network/registration increment.
  return { accountId: intent.daemon.accountId, scopeId: intent.daemon.scopeId, agentId: intent.daemon.id }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => { setTimeout(resolveDelay, ms) })
}

/**
 * Read every delivery up to and including the first match. The host's `read`
 * consumes deliveries, so the returned frames are exactly what the host served.
 */
async function awaitDelivery(host: AcpHost, ref: AcpChannelRef, match: (frame: AcpFrame) => boolean, timeoutMs: number): Promise<AcpFrame> {
  const deadline = Date.now() + timeoutMs
  let cursor = 0
  for (;;) {
    const page = await host.read(ref, cursor, DELIVERY_PAGE_LIMIT)
    cursor = page.nextSequence
    for (const delivery of page.frames) {
      if (match(delivery.frame)) return delivery.frame
    }
    if (Date.now() >= deadline) throw new AcpError('ENGINE_UNAVAILABLE', `engine did not answer within ${timeoutMs}ms`)
    await delay(CHANNEL_POLL_INTERVAL_MS)
  }
}

function evidenceText(evidence: JsonValue, key: string): string {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return 'unavailable'
  const value = (evidence as Record<string, JsonValue>)[key]
  return typeof value === 'string' ? value : 'unavailable'
}

/**
 * Prove the effective model from the engine's own `session/new` result. The
 * runtime performs only the bootstrap `initialize`; this caller opens the one
 * readiness channel, runs the one real `session/new` through the host and hands
 * that exact response to the adapter. `modelTarget` stays null when the engine
 * did not report the accepted binding.
 */
async function verifyReadiness(input: {
  readonly daemon: AcpAgentDaemon
  readonly readinessRef: AcpChannelRef
  readonly principal: AuthenticatedAgent
  readonly launch: EngineLaunchInput
  readonly workspace: string
  readonly initializeTimeoutMs: number
}): Promise<{ readonly modelTarget: ModelRef | null; readonly modelVerification: string; readonly effectiveRevision: number; readonly evidence: JsonValue }> {
  const { daemon, readinessRef, principal, launch, workspace, initializeTimeoutMs } = input
  await daemon.host.open({ ref: readinessRef, principal, policy: daemon.policy })
  await daemon.host.receive({
    ...readinessRef,
    frame: {
      jsonrpc: '2.0',
      id: 'serve-initialize',
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    },
  })
  const initializeResult = await awaitDelivery(daemon.host, readinessRef, frame => frame.id === 'serve-initialize', initializeTimeoutMs)
  await daemon.host.receive({
    ...readinessRef,
    frame: {
      jsonrpc: '2.0',
      id: 'serve-session-new',
      method: 'session/new',
      params: { cwd: workspace, mcpServers: [] },
    },
  })
  const sessionConfigResult = await awaitDelivery(daemon.host, readinessRef, frame => frame.id === 'serve-session-new', initializeTimeoutMs)
  const verified = await openCodeAcpAdapter.verifyEffective({
    handle: daemon.handle,
    launch,
    initializeResult,
    sessionConfigResult,
  })
  return {
    modelTarget: verified.modelTarget,
    modelVerification: evidenceText(verified.evidence, 'modelVerification'),
    effectiveRevision: verified.effectiveRevision,
    evidence: verified.evidence,
  }
}

/**
 * Start exactly one agent daemon and serve local ACP channels on its configured
 * listener. Every failure before the listener is bound stops the spawned engine
 * and rethrows the typed fault, so a failed start never leaves a child behind.
 */
export async function startAcpServe(intent: AcpServeIntent, options: AcpServeRuntimeOptions = {}): Promise<AcpServeHandle> {
  const env = options.env ?? process.env
  const agent = intent.intent
  const engine = agent.engine
  const listen = agent.listen
  if (engine === undefined || listen === undefined) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `agent ${agent.daemon.id} is not a startable serve intent`)
  }
  const executable = resolveOpenCodeExecutable(engine.executable, env)
  const dataDirectory = resolve(agent.daemon.dataDirectory)
  const ownedDirectory = join(dataDirectory, 'engine')
  const workspace = engine.workspace ?? join(dataDirectory, 'workspace')
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  await mkdir(ownedDirectory, { recursive: true, mode: 0o700 })
  await mkdir(workspace, { recursive: true, mode: 0o700 })

  const targetGeneration = 1
  const engineInstanceId = `opencode-${agent.daemon.id}-${randomUUID()}`
  const provider = intent.accepted.providers[intent.binding.primary.providerInstanceId]
  const target: ConfigTargetIdentity = {
    agentId: agent.daemon.id,
    targetGeneration,
    acceptedRevision: intent.accepted.acceptedRevision,
    acceptedSourceRevision: intent.accepted.acceptedRevision,
    acceptedSourceHash: intent.sourceHash,
    endpointFingerprint: provider === undefined ? '' : providerIntentFingerprint(provider),
  }
  const launchInput: EngineLaunchInput = {
    kind: 'opencode',
    executable,
    workspace,
    ownedDirectory,
    target,
    accepted: intent.accepted,
    policy: agent.acp,
  }
  const launch = await openCodeAcpAdapter.compileLaunch(launchInput)
  const history = await createAcpHistoryStore({ directory: dataDirectory })
  const initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  const outcome = await startAcpAgentDaemon({
    launch,
    engineInstanceId,
    targetGeneration,
    policy: {
      intent: agent.acp,
      adapterMethods: openCodeAcpAdapter.declaredMethods,
      enforceablePolicies: openCodeAcpAdapter.enforceablePolicies,
    },
    history,
    initialize: { params: { protocolVersion: 1, clientCapabilities: {} }, timeoutMs: initializeTimeoutMs },
    stopTimeoutMs,
    agentId: agent.daemon.id,
    resolveCredential: reference => resolveCredentialReference(reference, env),
  })
  if (outcome.kind === 'failed') {
    throw new AcpError(outcome.fault.code, `engine start failed: ${outcome.fault.message}`, outcome.fault.detail)
  }
  const daemon = outcome.daemon

  try {
    const readinessRef: AcpChannelRef = {
      connectionId: `serve-readiness-${engineInstanceId}`,
      channelId: 'readiness',
      targetGeneration,
      engineInstanceId,
    }
    const principal = principalOf(agent)
    const verified = await verifyReadiness({ daemon, readinessRef, principal, launch: launchInput, workspace, initializeTimeoutMs })

    const channels = new Map<string, { readonly ref: AcpChannelRef; readonly duplex: AcpDuplex; readonly socket: Socket }>()

    const closeChannel = async (ref: AcpChannelRef): Promise<void> => {
      const entry = channels.get(ref.connectionId)
      if (entry === undefined) return
      channels.delete(ref.connectionId)
      await entry.duplex.close().catch(() => undefined)
      await daemon.host.close(ref).catch(() => undefined)
    }

    const serveChannel = async (socket: Socket): Promise<void> => {
      socket.setNoDelay(true)
      const ref: AcpChannelRef = {
        connectionId: `serve-${randomUUID()}`,
        channelId: 'local-1',
        targetGeneration,
        engineInstanceId,
      }
      const duplex = createStdioAcpDuplex({ readable: socket, writable: socket })
      try {
        await daemon.host.open({ ref, principal, policy: daemon.policy })
      } catch (cause) {
        socket.destroy()
        throw cause
      }
      channels.set(ref.connectionId, { ref, duplex, socket })
      void (async () => {
        for (;;) {
          let frame: AcpFrame
          try {
            frame = await duplex.read()
          } catch {
            break
          }
          try {
            await daemon.host.receive({ ...ref, frame })
          } catch (cause) {
            // The host owns ACP semantics and rejects a frame it cannot serve.
            // The transport answers that request with the host's own error
            // envelope and keeps the channel open for the next frame.
            const fault = cause instanceof AcpError
              ? cause.toFault()
              : { code: 'INVALID_ACP_FRAME' as const, message: messageOf(cause, 'ACP frame was rejected') }
            if (typeof frame.method === 'string' && Object.hasOwn(frame, 'id')) {
              await duplex.send(rpcErrorFrame(frame.id as AcpRpcId, fault)).catch(() => undefined)
            }
          }
        }
        await closeChannel(ref)
      })()
      void (async () => {
        let cursor = 0
        for (;;) {
          // The channel map is this entry's liveness record: the reader loop,
          // the stop, and a transport failure all remove the channel here. The
          // host keeps a closed channel record readable, so the loop must end
          // on its own record instead of waiting for `read` to reject.
          if (!channels.has(ref.connectionId)) return
          let page: { readonly frames: readonly AcpDelivery[]; readonly nextSequence: number }
          try {
            page = await daemon.host.read(ref, cursor, DELIVERY_PAGE_LIMIT)
          } catch {
            await closeChannel(ref)
            return
          }
          cursor = page.nextSequence
          for (const delivery of page.frames) {
            try {
              await duplex.send(delivery.frame)
            } catch {
              await closeChannel(ref)
              return
            }
          }
          if (page.frames.length === 0) await delay(CHANNEL_POLL_INTERVAL_MS)
        }
      })()
      void duplex.closed.then(() => closeChannel(ref), () => closeChannel(ref))
      socket.on('error', () => { void closeChannel(ref) })
    }

    const server: Server = createServer(socket => { void serveChannel(socket) })
    await new Promise<void>((resolveBind, reject) => {
      const failed = (error: Error): void => { server.off('listening', ready); reject(error) }
      const ready = (): void => { server.off('error', failed); resolveBind() }
      server.once('error', failed)
      server.once('listening', ready)
      server.listen({ host: listen.ip, port: listen.port, exclusive: true })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      throw new AcpError('ENGINE_UNAVAILABLE', 'the ACP listener did not report a bound address')
    }

    let stopping: Promise<AcpServeStopReceipt> | undefined
    const stop = (): Promise<AcpServeStopReceipt> => {
      if (stopping !== undefined) return stopping
      stopping = (async (): Promise<AcpServeStopReceipt> => {
        const open = [...channels.values()]
        const closing = new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
        // Close every live channel through the host as well as the transport:
        // the host owns the channel record, and an open record would keep the
        // delivery loop polling a channel nobody serves.
        for (const entry of open) {
          entry.socket.destroy()
          await entry.duplex.close().catch(() => undefined)
          await daemon.host.close(entry.ref).catch(() => undefined)
        }
        channels.clear()
        await closing
        await daemon.host.close(readinessRef).catch(() => undefined)
        const engineStop = await daemon.stop()
        return { engine: engineStop, channels: open.length }
      })()
      return stopping
    }

    return {
      agentId: agent.daemon.id,
      engineInstanceId,
      enginePid: daemon.handle.pid,
      configPath: intent.configPath,
      dataDirectory,
      listener: { ip: listen.ip, port: address.port },
      readiness: {
        agentId: agent.daemon.id,
        engineKind: 'opencode',
        engineInstanceId,
        enginePid: daemon.handle.pid,
        listener: { ip: listen.ip, port: address.port },
        modelTarget: verified.modelTarget,
        modelVerification: verified.modelVerification,
        effectiveRevision: verified.effectiveRevision,
        evidence: verified.evidence,
      },
      daemon,
      stop,
    }
  } catch (cause) {
    await daemon.stop().catch(() => undefined)
    throw cause instanceof AcpError ? cause : new AcpError('ENGINE_UNAVAILABLE', messageOf(cause, 'ACP serve start failed'))
  }
}

function modelText(readiness: AcpServeReadiness): string {
  return readiness.modelTarget === null
    ? 'unverified'
    : `${readiness.modelTarget.providerInstanceId}/${readiness.modelTarget.modelId}`
}

/** The one readiness line the entry prints before it starts serving. */
export function formatAcpServeReady(handle: AcpServeHandle): string {
  return [
    'serving',
    `agent=${handle.agentId}`,
    'engine=opencode',
    `engineInstance=${handle.engineInstanceId}`,
    `enginePid=${handle.enginePid}`,
    `daemonPid=${process.pid}`,
    `listener=${handle.listener.ip}:${handle.listener.port}`,
    `dataDirectory=${handle.dataDirectory}`,
    `config=${handle.configPath ?? 'quick-start'}`,
    `model=${modelText(handle.readiness)}`,
    `modelVerification=${handle.readiness.modelVerification}`,
    `effectiveRevision=${handle.readiness.effectiveRevision}`,
  ].join(' ')
}

/** The one stop line, carrying the real EngineStopResult. */
export function formatAcpServeStopped(handle: AcpServeHandle, receipt: AcpServeStopReceipt): string {
  const engine = receipt.engine
  return [
    'stopped',
    `agent=${handle.agentId}`,
    `enginePid=${handle.enginePid}`,
    `engine=${engine.kind}`,
    ...(engine.kind === 'exited'
      ? [`code=${engine.code === null ? 'null' : String(engine.code)}`, `signal=${engine.signal ?? 'null'}`]
      : [`retainedPid=${engine.pid}`]),
    `channels=${receipt.channels}`,
  ].join(' ')
}

export interface RunAcpServeInput extends AcpServeIntentInput {
  readonly env?: NodeJS.ProcessEnv
  readonly report?: (line: string) => void
  readonly signal?: AbortSignal
  readonly initializeTimeoutMs?: number
  readonly stopTimeoutMs?: number
}

function waitForStopSignal(signal: AbortSignal | undefined): Promise<void> {
  if (signal !== undefined) {
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>(resolveStop => { signal.addEventListener('abort', () => resolveStop(), { once: true }) })
  }
  return new Promise<void>(resolveStop => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolveStop()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

/**
 * The process-level serve entry: read the intent, start one daemon, print the
 * honest readiness line, run until SIGINT/SIGTERM (or the injected abort), then
 * stop the engine and print the real stop receipt.
 */
export async function runAcpServe(input: RunAcpServeInput): Promise<void> {
  const report = input.report ?? ((line: string) => { console.log(line) })
  const intent = await readAcpServeIntent(input)
  const handle = await startAcpServe(intent, {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: input.initializeTimeoutMs }),
    ...(input.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: input.stopTimeoutMs }),
  })
  report(formatAcpServeReady(handle))
  try {
    await waitForStopSignal(input.signal)
  } finally {
    const receipt = await handle.stop()
    report(formatAcpServeStopped(handle, receipt))
  }
}
