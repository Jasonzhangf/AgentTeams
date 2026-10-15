import { accessSync, statSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, isIP, type Server, type Socket } from 'node:net'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AgentDeclaration, AuthenticatedAgent, CapabilityDeclaration, JsonValue } from '../control-protocol/agent-services.ts'
import type { AcpChannelRef, AcpDelivery, AcpFault, AcpFaultCode, AcpFrame, AcpRpcId } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { AcpDuplex, EngineAdapter, EngineLaunchInput, EngineStopResult } from '../control-protocol/engine.ts'
import type { RelationRole } from '../control-protocol/teams-connection.ts'
import type { AdmissionIntent, AgentDaemonIntent, DaemonEffectiveConfig, EngineKind, ListenIntent, PeerIntent } from '../config/daemon-intent.ts'
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
import type { AcpPolicySnapshot } from '../config/acp-policy.ts'
import type { AgentModelBinding, ConfigTargetIdentity, ModelRef, VersionedRuntimeConfig } from '../config/runtime-config.ts'
import { providerIntentFingerprint } from '../config/runtime-config.ts'
import {
  readRelationsIntentRecord,
  relationsIntentScopePath,
  type RelationsIntentRecord,
} from '../config/relations-intent-store.ts'
import {
  pendingSessionIntents,
  readSessionIntentRecord,
  readSessionIntentWatermark,
  sessionIntentScopePath,
  sessionIntentWatermarkPath,
  writeSessionIntentWatermark,
  type SessionIntent,
} from '../config/session-intent-store.ts'
import { createStdioAcpDuplex } from '../acp-adapter/stdio.ts'
import { rpcErrorFrame, type AcpHost } from '../agent-host/acp-host.ts'
import { openCodeAcpAdapter } from '../opencode-adapter/src/acp-engine.ts'
import { createDshEngineAdapter } from '../dsh-adapter/index.ts'
import { createDirectWssListener, type DirectWssAdmission, type DirectWssListener } from '../network/direct-listener.ts'
import type { AccountDirectorySnapshot } from '../network/account-directory.ts'
import type { RegistrationStatus } from '../network/registration-client.ts'
import { createTeamsConnectionHistory, type TeamsConnectionHistory } from '../network/teams-connection-history.ts'
import { createTeamsConnectionLedger, openTeamsIngress, type TeamsConnectionLedger } from '../network/teams-ingress.ts'
import { createTeamsStatusPort, type TeamsStatusPort } from '../network/teams-status.ts'
import { createAcpHistoryStore } from './acp-history-store.ts'
import { startAcpAgentDaemon, type AcpAgentDaemon } from './acp-daemon.ts'
import {
  declarationForDaemon,
  declarationWithPublishedSurfaces,
  listenerRouteCandidates,
  startDaemonRegistration,
  type AgentRegistration,
  type PublishedDaemonSurfaces,
} from './registry-registration.ts'
import {
  createServeEgressOwner,
  type ServeEgressFailure,
  type ServeEgressOwner,
  type ServeEgressTargetFacts,
} from './serve-egress.ts'

/**
 * `agentteams --serve <engine>` user entry (owner: runtime).
 *
 * One invocation reads one v4 agent config, compiles the accepted config with
 * the config-owned compiler, starts exactly one agent daemon through the D01
 * runtime (`startAcpAgentDaemon` + the acp-adapter stdio duplex + `createAcpHost`)
 * with the engine's own adapter as the only config compiler, proves the
 * effective model from the engine's own `session/new` result, then serves local
 * ACP channels on the daemon's configured listener.
 *
 * This module declares no second Session path, no second ACP frame transport and
 * no second engine config compiler: the local channel reuses the one
 * `createStdioAcpDuplex` codec over its socket, the LAN channel reuses the one
 * `createDirectWssListener` + `openTeamsIngress` chain, the initiator leg reuses
 * the one `runtime/serve-egress.ts` owner over `network/teams-egress.ts`, the
 * host owns Session/RPC semantics, `engineAdapterFor` is the one dispatch point
 * from the configured engine kind to its adapter, and `runtime/agent-process.ts`
 * stays the legacy Work entry.
 *
 * The daemon also dials its own declared peers: after the listener and
 * registration are ready it composes the egress owner and connects every peer
 * the accepted config declares. The agent daemon reacts on its own; the control
 * daemon is never a relay and there is no control -> agent channel.
 *
 * `classifyServeListener` splits the configured listener by address, not by a
 * second config key:
 *   - `local` (a loopback address): the existing loopback plain newline-JSON ACP
 *     channel, byte-compatible with D02, bound on `listen.ip`.
 *   - `lan` (any other address): the authenticated direct-WSS Teams channel bound
 *     on `listen.ip` with the configured TLS refs and resolved admissions; every
 *     accepted connection runs the frozen Teams negotiation and one ACP session
 *     into the same `daemon.host`.
 * A non-loopback listener without `[discovery]` is refused with a typed
 * `UNSUPPORTED_CONFIGURATION`: a manual peer carries no authenticated capability
 * revision for the hello, and the entry never guesses one. A non-loopback
 * listener with `[discovery]` publishes its real route and effective ACP
 * capability through the existing D04 path once the listener is bound and the
 * registration client is online.
 */

const DEFAULT_INITIALIZE_TIMEOUT_MS = 20_000
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const CHANNEL_POLL_INTERVAL_MS = 5
const DELIVERY_PAGE_LIMIT = 200
const QUICK_START_AGENT_ID = 'agent'
/** Local channel bind address when the configured listener is a LAN address. */
const LOCAL_CHANNEL_BIND_IP = '127.0.0.1'
/**
 * The direct listener reuses the network owner's operational limits; the frozen
 * v4 schema declares none of them, so this entry owns the values it passes.
 */
const LAN_LISTENER_LIMITS = {
  maxPayload: 262_144,
  maxConnections: 64,
  maxMessageBytes: 262_144,
  maxBufferedBytes: 262_144,
  maxPendingFrames: 64,
  helloTimeoutMs: 5_000,
} as const
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 10_000
/** The published ACP capability id; the version is the capability's own, not the frame version. */
const ACP_CAPABILITY_ID = 'acp'
const ACP_CAPABILITY_VERSION = '1'

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
  /** Live registration status transitions; the readiness line reports the start state. */
  readonly onRegistrationStatus?: (status: RegistrationStatus) => void
}

/** Which inbound channel the configured listener address selects. */
export type ServeListenerClass = 'local' | 'lan'

/** The real bound local ACP channel address. */
export interface AcpServeLocalChannel {
  readonly ip: string
  readonly port: number
}

/** The real bound authenticated LAN channel, with the revision its hello advertises. */
export interface AcpServeLanChannel {
  readonly endpoint: string
  readonly port: number
  readonly capabilitiesRevision: string
}

export interface AcpServeReadiness {
  readonly agentId: string
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
  /** The engine kind this handle really started, from the compiled intent. */
  readonly engineKind: EngineKind
  readonly engineInstanceId: string
  readonly enginePid: number
  readonly configPath: string | null
  readonly dataDirectory: string
  readonly listener: { readonly ip: string; readonly port: number }
  /** The real bound local (plain newline-JSON) channel. */
  readonly localChannel: AcpServeLocalChannel
  /** The real bound authenticated LAN channel; null for a loopback-only listener. */
  readonly lanChannel: AcpServeLanChannel | null
  /** `String(declaration.revision)` of the declaration the LAN hello advertises. */
  readonly capabilitiesRevision: string
  /** Live registration status; `disabled` when the config declares no `[discovery]`. */
  readonly registration: RegistrationStatus
  /** Read-only D06 handoff over the live ledger and the durable history. */
  readonly teamsStatus: TeamsStatusPort
  /**
   * The daemon's own egress owner: it dialed every declared dialable peer at
   * start and owns the live initiator connections. `list()` is the live rows and
   * `disconnect(agentId)` tears one down; `stop()` closes them all before the host.
   */
  readonly egress: ServeEgressOwner
  /** Every declared peer whose connect attempt failed, with its typed code. */
  readonly egressFailures: readonly ServeEgressFailure[]
  /**
   * The desired-relations record this daemon observes. The control daemon owns the
   * file; this daemon polls it and reacts, and `failures()` is every typed refusal
   * the watch recorded (an undeclared desired agent, or a broken record).
   */
  readonly relationsIntent: {
    readonly path: string
    failures(): readonly RelationsIntentWatchFailure[]
  }
  /**
   * The pending-Session-write record this daemon observes. The control daemon owns the
   * file; this daemon polls it and applies each write to its own host. `failures()` is
   * every typed refusal the watch recorded, so a write this daemon could not apply stays
   * visible instead of disappearing.
   */
  readonly sessionIntent: {
    readonly path: string
    readonly watermarkPath: string
    failures(): readonly SessionIntentWatchFailure[]
  }
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
 * Pure listener classification: the address, not a second config key, selects
 * the channel. A loopback address is the local plain ACP channel; every other
 * address is the authenticated LAN channel.
 */
export function classifyServeListener(listen: { readonly ip: string }): ServeListenerClass {
  return isLoopbackAddress(listen.ip) ? 'local' : 'lan'
}

/**
 * Pure projection of the effective ACP policy into the one published capability.
 * Only the effective `method:` keys become operations, and cancellation is
 * cooperative only when `method:session/cancel` is effective; the projection
 * never declares a method the accepted policy denied.
 */
export function acpCapabilityDeclarations(policy: AcpPolicySnapshot): readonly CapabilityDeclaration[] {
  const methods = policy.effective
    .filter(key => key.startsWith('method:'))
    .map(key => key.slice('method:'.length))
    .sort()
  const cooperative = methods.includes('session/cancel')
  return [{
    capabilityId: ACP_CAPABILITY_ID,
    version: ACP_CAPABILITY_VERSION,
    operations: methods.map(operation => ({
      operation,
      inputSchema: {},
      outputSchema: {},
      cancellation: cooperative ? 'cooperative' as const : 'unsupported' as const,
    })),
    resources: [],
  }]
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
 * ACP policy, a served listener (a non-loopback listener requires `[discovery]`),
 * a delivered engine adapter and a real provider/model binding. It starts
 * nothing.
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
  if (!intent.acp.enabled) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `agent ${intent.daemon.id} has acp disabled; --serve requires an enabled ACP policy`)
  }
  if (intent.listen === undefined) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', `agent ${intent.daemon.id} declares no listener; --serve requires [listen] or --ip/--port`)
  }
  if (classifyServeListener(intent.listen) === 'lan' && intent.discovery === undefined) {
    throw new AcpError(
      'UNSUPPORTED_CONFIGURATION',
      `the --serve entry serves the LAN listener ${intent.listen.ip}:${intent.listen.port} only with a [discovery] server: `
      + `a manual peer carries no authenticated capability revision for the hello, and ${source} declares none`,
      { source: 'config', code: 'NOT_FOUND', listener: `${intent.listen.ip}:${intent.listen.port}`, missing: 'discovery' },
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

interface EngineExecutableResolution {
  /** Engine name as it appears in a fault message. */
  readonly label: string
  /** Executable file name looked up on PATH. */
  readonly executableName: string
  /** Project environment overrides, in precedence order. */
  readonly environmentOverrides: readonly string[]
  /** The config key a configured path came from, e.g. `[engine].executable`. */
  readonly configKey: string
}

/**
 * Resolve the installed engine executable: the explicit config path, then a
 * project environment override, then PATH. The returned path is always an
 * absolute executable file, so the runtime never spawns a bare name.
 */
function resolveEngineExecutable(resolution: EngineExecutableResolution, configured: string | undefined, env: NodeJS.ProcessEnv): string {
  const { label, executableName, environmentOverrides, configKey } = resolution
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `${configKey} must be an absolute installed path, got ${configured}`)
    }
    if (!isExecutableFile(configured)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `${configKey} is not an executable file: ${configured}`)
    }
    return configured
  }
  for (const name of environmentOverrides) {
    const override = env[name]
    if (override === undefined || override.length === 0) continue
    if (!isAbsolute(override)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `the ${label} executable override ${name} must be an absolute path, got ${override}`)
    }
    if (!isExecutableFile(override)) {
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `the ${label} executable override ${name} is not an executable file: ${override}`)
    }
    return override
  }
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = resolve(directory, executableName)
    if (isExecutableFile(candidate)) return candidate
  }
  throw new AcpError(
    'UNSUPPORTED_CONFIGURATION',
    `no ${label} executable is configured: set ${configKey}, ${environmentOverrides.join(' or ')}, or install ${executableName} on PATH`,
  )
}

/** The installed OpenCode executable: config path, then project env, then PATH. */
export function resolveOpenCodeExecutable(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolveEngineExecutable({
    label: 'OpenCode',
    executableName: 'opencode',
    environmentOverrides: ['AGENTTEAMS_OPENCODE_EXECUTABLE', 'OPENCODE_EXECUTABLE'],
    configKey: 'engine.executable',
  }, configured, env)
}

/** The installed DSH executable: config path, then project env, then PATH. */
export function resolveDshExecutable(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolveEngineExecutable({
    label: 'DSH',
    executableName: 'dsh',
    environmentOverrides: ['AGENTTEAMS_DSH_EXECUTABLE', 'DSH_EXECUTABLE'],
    configKey: 'engine.executable',
  }, configured, env)
}

/**
 * The entry's dispatcher view of an engine adapter: the frozen
 * `control-protocol/engine.ts` port plus the two policy sets the adapter
 * declares and the entry passes through to the host. It is a type-only view,
 * not a third adapter implementation: `OpenCodeEngineAdapter` and
 * `DshEngineAdapter` each already extend `EngineAdapter`, so this adds only the
 * members the one dispatch point needs and declares no `compileLaunch` or
 * `verifyEffective` shape of its own.
 *
 * `enforceablePolicies` stays optional here so an adapter that omits it fails
 * with an explicit typed fault instead of being silently repaired.
 */
export type ServeEngineAdapter = EngineAdapter & {
  readonly declaredMethods: readonly string[]
  readonly enforceablePolicies?: readonly string[]
}

/**
 * The one dispatch point from a configured engine kind to its adapter. D00
 * freezes the kinds as opencode|dsh and both adapters are delivered, so the
 * `never` binding makes the mapping exhaustive at compile time; the default
 * clause is unreachable for every value the config parser can produce.
 */
export function engineAdapterFor(kind: EngineKind): ServeEngineAdapter {
  switch (kind) {
    case 'opencode':
      return openCodeAcpAdapter
    case 'dsh':
      return createDshEngineAdapter()
    default: {
      const unhandled: never = kind
      throw new AcpError('UNSUPPORTED_CONFIGURATION', `--serve has no engine adapter for kind ${String(unhandled)}`)
    }
  }
}

/**
 * The adapter owns which policies it can enforce. An adapter that declares no
 * enforceable set is a wiring fault, not a reason to fall back to a different
 * set; the fault names the adapter that owes the declaration.
 */
export function requireEnforceablePolicies(adapter: ServeEngineAdapter): readonly string[] {
  if (adapter.enforceablePolicies === undefined) {
    throw new AcpError(
      'UNSUPPORTED_CONFIGURATION',
      `engine adapter ${adapter.kind} declares no enforceable ACP policy set; --serve does not substitute another set`,
    )
  }
  return adapter.enforceablePolicies
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
  // The local channel is the daemon's own local endpoint; the LAN channel's
  // principal is the transport-authenticated peer, never a payload value.
  return { accountId: intent.daemon.accountId, scopeId: intent.daemon.scopeId, agentId: intent.daemon.id }
}

/** The absolute path behind a resolved `file:` reference. */
function fileRefPath(reference: string): string {
  return resolve(reference.startsWith('file:') ? reference.slice('file:'.length) : reference)
}

/**
 * Resolve every declared admission through the same credential reader the entry
 * uses for engine credentials. The credential never enters a declaration or a
 * log line; only the admission ref and the peer identity do.
 */async function resolveAdmissions(admissions: readonly AdmissionIntent[], env: NodeJS.ProcessEnv): Promise<readonly DirectWssAdmission[]> {
  const resolved: DirectWssAdmission[] = []
  for (const admission of admissions) {
    resolved.push({
      admissionRef: admission.admissionRef,
      peer: { accountId: admission.accountId, scopeId: admission.scopeId, agentId: admission.agentId },
      credential: await resolveCredentialReference(admission.credentialRef, env),
    })
  }
  return resolved
}

/**
 * Publish the daemon's real surfaces through the existing D04 path. It publishes
 * only when the config selected registration and the client is online; a
 * disabled plan or a registry outage changes the registration status and never
 * stops the engine. The caller owns `declarationForDaemon` +
 * `declarationWithPublishedSurfaces`, so the published revision is the one the
 * LAN target already advertised.
 */
export async function publishServeRegistration(input: {
  readonly registration: AgentRegistration
  readonly declaration: AgentDeclaration
}): Promise<RegistrationStatus | null> {
  if (input.registration.state !== 'enabled') return null
  if (input.registration.client.status().state !== 'online') return null
  await input.registration.client.publish(input.declaration)
  return input.registration.client.status()
}

interface ServeLocalChannel {
  readonly ip: string
  readonly port: number
  /** Destroy every live channel, then stop accepting; returns the destroyed count. */
  close(): Promise<number>
}

/**
 * Bind the plain newline-JSON ACP channel. A loopback listener binds the
 * configured address and port (byte-compatible with D02); a LAN listener keeps
 * the same local channel on `127.0.0.1:0` and reports the real port.
 */
async function buildLocalChannel(input: {
  readonly daemon: AcpAgentDaemon
  readonly principal: AuthenticatedAgent
  readonly targetGeneration: number
  readonly engineInstanceId: string
  readonly listen: ListenIntent
  readonly listenerClass: ServeListenerClass
}): Promise<ServeLocalChannel> {
  const { daemon, principal, targetGeneration, engineInstanceId } = input
  const bindIp = input.listenerClass === 'local' ? input.listen.ip : LOCAL_CHANNEL_BIND_IP
  const bindPort = input.listenerClass === 'local' ? input.listen.port : 0
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
    server.listen({ host: bindIp, port: bindPort, exclusive: true })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    throw new AcpError('ENGINE_UNAVAILABLE', 'the ACP listener did not report a bound address')
  }
  return {
    ip: bindIp,
    port: address.port,
    close: async () => {
      const open = [...channels.values()]
      const closing = new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
      // Close every live channel through the host as well as the transport: the
      // host owns the channel record, and an open record would keep the delivery
      // loop polling a channel nobody serves.
      for (const entry of open) {
        entry.socket.destroy()
        await entry.duplex.close().catch(() => undefined)
        await daemon.host.close(entry.ref).catch(() => undefined)
      }
      channels.clear()
      await closing
      return open.length
    },
  }
}

interface ServeLanChannel {
  readonly endpoint: string
  readonly port: number
  readonly capabilitiesRevision: string
  close(): Promise<void>
}

/**
 * Bind the authenticated LAN channel and route every accepted connection
 * through `openTeamsIngress` into the same `daemon.host`. The peer wire ref never
 * reaches the host: the ingress allocates local refs before any host call.
 */
async function buildLanChannel(input: {
  readonly daemon: AcpAgentDaemon
  readonly intent: AgentDaemonIntent
  readonly listen: ListenIntent
  readonly env: NodeJS.ProcessEnv
  readonly capabilitiesRevision: string
  readonly targetGeneration: number
  readonly selfPolicyRevision: number
  readonly engineInstanceId: string
  readonly admittedCapabilities: readonly string[]
  readonly history: TeamsConnectionHistory
  readonly ledger: TeamsConnectionLedger
}): Promise<ServeLanChannel> {
  const keyRef = input.listen.tlsKeyRef
  const certRef = input.listen.tlsCertRef
  if (keyRef === undefined || certRef === undefined) {
    throw new AcpError(
      'UNSUPPORTED_CONFIGURATION',
      `the LAN listener ${input.listen.ip}:${input.listen.port} requires tlsCertRef and tlsKeyRef; the entry never serves a non-loopback address in plaintext`,
    )
  }
  const [key, cert, admissions] = await Promise.all([
    readFile(fileRefPath(keyRef)),
    readFile(fileRefPath(certRef)),
    resolveAdmissions(input.intent.admissions, input.env),
  ])
  const self = principalOf(input.intent)
  const listener: DirectWssListener = await createDirectWssListener({
    host: input.listen.ip,
    port: input.listen.port,
    key,
    cert,
    admissions,
    target: {
      hostId: input.intent.daemon.hostId,
      agentId: input.intent.daemon.id,
      targetGeneration: input.targetGeneration,
      protocolVersion: 1,
      capabilitiesRevision: input.capabilitiesRevision,
    },
    ...LAN_LISTENER_LIMITS,
    onConnection: async connection => {
      await openTeamsIngress({
        connection: {
          connectionId: connection.connectionId,
          peer: connection.peer,
          connection: connection.connection,
        },
        self,
        selfGeneration: input.targetGeneration,
        selfCapabilitiesRevision: input.capabilitiesRevision,
        selfPolicyRevision: input.selfPolicyRevision,
        allowedRoles: input.intent.relations.allowed,
        admittedCapabilities: input.admittedCapabilities,
        host: input.daemon.host,
        policy: input.daemon.policy,
        engineInstanceId: input.engineInstanceId,
        history: input.history,
        ledger: input.ledger,
        timeoutMs: DEFAULT_NEGOTIATION_TIMEOUT_MS,
      })
    },
  })
  return {
    endpoint: listener.url,
    port: listener.port,
    capabilitiesRevision: input.capabilitiesRevision,
    close: () => listener.close(),
  }
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
  readonly adapter: ServeEngineAdapter
  readonly readinessRef: AcpChannelRef
  readonly principal: AuthenticatedAgent
  readonly launch: EngineLaunchInput
  readonly workspace: string
  readonly initializeTimeoutMs: number
}): Promise<{ readonly modelTarget: ModelRef | null; readonly modelVerification: string; readonly effectiveRevision: number; readonly evidence: JsonValue }> {
  const { daemon, adapter, readinessRef, principal, launch, workspace, initializeTimeoutMs } = input
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
  const verified = await adapter.verifyEffective({
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
 * The named poll interval of the agent daemon's desired-relations watch and of its
 * pending-Session-write watch. One control daemon writes one durable record and this
 * daemon reads it, so the Console stays out of the data path and no control-to-agent
 * channel is added.
 */
export const RELATIONS_INTENT_POLL_INTERVAL_MS = 500

/** One typed refusal the watch recorded instead of dialing or crashing. */
export interface RelationsIntentWatchFailure {
  readonly agentId: string
  readonly code: AcpFaultCode
  readonly message: string
}

/** The live-relation surface the watch drives; the real owner is `ServeEgressOwner`. */
export interface RelationsIntentWatchInput {
  /** The already-built egress owner. The watch never builds a second one. */
  readonly owner: Pick<ServeEgressOwner, 'connect' | 'disconnect' | 'list'>
  /** The one shared record path. `config/relations-intent-store.ts` owns its derivation. */
  readonly recordPath: string
  /** The accepted intent's declared peers. An agentId outside this set is never dialed. */
  readonly peers: Readonly<Record<string, PeerIntent>>
}

export interface RelationsIntentWatch {
  /** One reconcile pass: make the live rows match the record's desired set. */
  reconcile(): Promise<void>
  /** The one shared record path this watch observes. */
  readonly recordPath: string
  /** Every typed refusal this watch recorded in its lifetime. */
  failures(): readonly RelationsIntentWatchFailure[]
}

/**
 * React to the durable desired-relations record that the control daemon owns. One
 * reconcile pass dials each newly desired declared peer and disconnects each live
 * peer the record no longer desires.
 *
 * The record carries the control daemon's desired role, but it never overrides this
 * daemon's own accepted policy: the role pair still comes from `relations.allowed`
 * (`runtime/serve-egress.ts`), so a desired role this daemon does not accept stays a
 * typed dial refusal instead of an escalated grant.
 *
 * A missing record is a plain no-op, and a broken record is a typed refusal that
 * leaves the live rows untouched. Neither one crashes the daemon.
 */
export function createRelationsIntentWatch(input: RelationsIntentWatchInput): RelationsIntentWatch {
  const declaredPeerName = new Map<string, string>()
  for (const [peerName, peer] of Object.entries(input.peers)) declaredPeerName.set(peer.agentId, peerName)
  const failures: RelationsIntentWatchFailure[] = []
  const recorded = new Set<string>()
  // A poll repeats the same refusal every tick, so the list keeps each distinct
  // refusal once instead of growing without bound.
  const refuse = (agentId: string, code: AcpFaultCode, message: string): void => {
    const key = `${agentId}\u0000${code}\u0000${message}`
    if (recorded.has(key)) return
    recorded.add(key)
    failures.push({ agentId, code, message })
  }
  const refuseError = (agentId: string, error: unknown, fallback: string): void => {
    refuse(agentId, error instanceof AcpError ? error.code : 'ENGINE_UNAVAILABLE', messageOf(error, fallback))
  }
  const reconcile = async (): Promise<void> => {
    let desired: RelationsIntentRecord | undefined
    try {
      desired = await readRelationsIntentRecord(input.recordPath)
    } catch (error) {
      // The store's typed throw for a broken record. Keep every live row as it is,
      // and keep the store's own fault family through the one config translation.
      refuse('', configFault(error).code, messageOf(error, 'the desired relations record could not be read'))
      return
    }
    if (desired === undefined) return
    const wanted = new Map<string, string>()
    for (const relation of desired.peers) {
      const peerName = declaredPeerName.get(relation.agentId)
      if (peerName === undefined) {
        // Never dial an agent this daemon's accepted intent does not declare.
        refuse(
          relation.agentId,
          'FORBIDDEN',
          `relations intent desires agent ${relation.agentId}, which this daemon's accepted intent does not declare`,
        )
        continue
      }
      wanted.set(relation.agentId, peerName)
    }
    for (const row of input.owner.list()) {
      if (wanted.has(row.agentId)) continue
      await input.owner.disconnect(row.agentId).catch(error => refuseError(row.agentId, error, `peer ${row.peerName} could not be disconnected`))
    }
    const live = new Set(input.owner.list().map(row => row.agentId))
    for (const [agentId, peerName] of wanted) {
      if (live.has(agentId)) continue
      await input.owner.connect(peerName).catch(error => refuseError(agentId, error, `peer ${peerName} could not be dialed`))
    }
  }
  return { reconcile, recordPath: input.recordPath, failures: () => [...failures] }
}

/**
 * The one shared record path this daemon reads. It is derived from the daemon's own
 * accepted account and scope plus the established `~/.agentteams` local root, so the
 * control daemon resolves the same file without a new config key.
 */
export function agentRelationsIntentPath(home: string, daemon: AgentDaemonIntent['daemon']): string {
  return relationsIntentScopePath({ home, accountId: daemon.accountId, scopeId: daemon.scopeId })
}

/** One typed refusal to apply a pending Session write, with the write it belongs to. */
export interface SessionIntentWatchFailure {
  readonly intentId: string
  readonly code: AcpFaultCode
  readonly message: string
}

/**
 * The Session surface the watch drives. The real owner is the agent daemon's own
 * `AcpHost`, which is the A2.6 permission owner and the only place that knows which
 * Session each open channel owns.
 */
export interface SessionIntentWatchInput {
  readonly host: Pick<AcpHost, 'receive' | 'pendingPermissions' | 'channelForSession'>
  /** The one record path for this daemon. `config/session-intent-store.ts` owns it. */
  readonly recordPath: string
  /** This daemon's own consumed watermark, in its own data directory. */
  readonly watermarkPath: string
  /** This daemon's own accepted identity. A record that names another agent is refused. */
  readonly agentId: string
}

export interface SessionIntentWatch {
  /** One pass: apply every pending write addressed to this daemon, in revision order. */
  reconcile(): Promise<void>
  readonly recordPath: string
  readonly watermarkPath: string
  /** Every typed refusal this watch recorded in its lifetime. */
  failures(): readonly SessionIntentWatchFailure[]
}

/**
 * React to the durable pending-Session-write record that the control daemon owns.
 *
 * This daemon applies a write to its own `AcpHost` and reports nothing back: no
 * control-to-agent channel exists, and the Console stays out of the data path. The three
 * frozen writes map to the engine exactly as ACP defines them.
 *
 *  - `permission.reply` becomes a JSON-RPC response to the engine's own pending
 *    `session/request_permission` callback. The write names the permission by the id the
 *    controller received with that request. The decision is the Console vocabulary, so the
 *    watch selects the engine option whose `kind` equals it. When the engine offered no
 *    such option, or when no callback matches, the watch refuses: a stale or missing
 *    callback never becomes an approval.
 *  - `session.cancel` becomes the `session/cancel` notification for that Session.
 *  - `session.message` becomes `session/prompt` with the body carried verbatim.
 *
 * Ordering and retry: the pass stops at the first write it cannot apply and does not
 * advance the watermark, so the next tick retries that write and every later one. Order is
 * therefore preserved per daemon, and a write is never silently skipped. A write this
 * daemon can never apply keeps its typed refusal and eventually pushes the reader past the
 * retained window, where the store reports the honest `behind` refusal instead of a gap.
 */
export function createSessionIntentWatch(input: SessionIntentWatchInput): SessionIntentWatch {
  const failures: SessionIntentWatchFailure[] = []
  const recorded = new Set<string>()
  // A poll repeats the same refusal every tick, so the list keeps each distinct refusal once.
  const refuse = (intentId: string, code: AcpFaultCode, message: string): void => {
    const key = `${intentId}\u0000${code}\u0000${message}`
    if (recorded.has(key)) return
    recorded.add(key)
    failures.push({ intentId, code, message })
  }
  const refuseError = (intentId: string, error: unknown, fallback: string): void => {
    refuse(intentId, error instanceof AcpError ? error.code : 'ENGINE_UNAVAILABLE', messageOf(error, fallback))
  }

  /** Apply one write. `true` means the write really reached the engine. */
  const apply = async (intent: SessionIntent): Promise<boolean> => {
    if (intent.agentId !== input.agentId) {
      // The record path is derived from the target, so a record naming another agent was
      // written where it does not belong. Refuse it instead of applying another's write.
      refuse(intent.intentId, 'FORBIDDEN', `pending Session write names agent ${intent.agentId}, but this daemon is ${input.agentId}`)
      return false
    }
    try {
      if (intent.kind === 'permission.reply') {
        const rows = input.host.pendingPermissions()
          .filter(row => row.sessionId === intent.sessionId && row.permissionId === intent.permissionId)
        if (rows.length !== 1) {
          refuse(intent.intentId, 'CONFLICT', `pending Session write names permission ${intent.permissionId} on session ${intent.sessionId}, but ${rows.length} engine callbacks match`)
          return false
        }
        const row = rows[0]
        const option = row.options.find(candidate => candidate.kind === intent.decision)
        if (option === undefined) {
          // Never invent an optionId: only the engine's own offered set is selectable.
          refuse(intent.intentId, 'INVALID_ACP_FRAME', `the engine offered no ${intent.decision} option for permission ${intent.permissionId}; offered kinds: ${row.options.map(candidate => candidate.kind).join(', ') || 'none'}`)
          return false
        }
        await input.host.receive({
          ...row.ref,
          frame: { jsonrpc: '2.0', id: row.permissionId, result: { outcome: { outcome: 'selected', optionId: option.optionId } } },
        })
        return true
      }
      const ref = input.host.channelForSession(intent.sessionId)
      if (ref === undefined) {
        // No open channel owns the Session, so no engine can receive this write.
        refuse(intent.intentId, 'CONFLICT', `no open channel owns session ${intent.sessionId}`)
        return false
      }
      if (intent.kind === 'session.cancel') {
        await input.host.receive({ ...ref, frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: intent.sessionId } } })
        return true
      }
      // The body stays verbatim: the watch never parses, rewrites, or strips it.
      await input.host.receive({
        ...ref,
        frame: { jsonrpc: '2.0', id: `session-intent-${intent.intentId}`, method: 'session/prompt', params: { sessionId: intent.sessionId, prompt: intent.payload } },
      })
      return true
    } catch (error) {
      refuseError(intent.intentId, error, `pending Session write ${intent.intentId} could not be applied`)
      return false
    }
  }

  /**
   * The highest revision this watch really applied, counting only the contiguous run from the
   * durable watermark. A `session.message` re-applied is a second prompt to the engine, so the
   * watch must never re-apply a write it already applied in this process, even when the durable
   * watermark could not be saved. A restart still re-applies the writes after the last saved
   * watermark, which is the at-least-once boundary this record can offer.
   */
  let appliedThrough: number | undefined

  const reconcile = async (): Promise<void> => {
    let record
    let watermark
    try {
      record = await readSessionIntentRecord(input.recordPath)
      watermark = await readSessionIntentWatermark(input.watermarkPath)
    } catch (error) {
      // The store's typed throw for a broken record. Nothing is applied and the watermark
      // stays where it was, so a repaired record resumes from the same point.
      refuse('', configFault(error).code, messageOf(error, 'the pending Session write record could not be read'))
      return
    }
    // The durable watermark is the floor, and this process's own progress may be ahead of it.
    const base = Math.max(watermark.appliedRevision, appliedThrough ?? 0)
    const view = pendingSessionIntents(record, base)
    if (view.state === 'behind') {
      // The writer's window already dropped writes this daemon never saw. Refuse instead of
      // skipping them, and keep the watermark so the gap stays visible.
      refuse('', 'CONFLICT', `pending Session writes start at revision ${view.oldestRevision}, but this daemon applied only through ${view.appliedRevision}`)
      return
    }
    for (const [index, intent] of view.intents.entries()) {
      // The loop stops at the first write it cannot apply, so the applied revisions stay a
      // contiguous run and one revision advances per successful write. The intent at index
      // `index` carries revision `base + index + 1`.
      if (!await apply(intent)) break
      appliedThrough = base + index + 1
    }
    // Save exactly what was applied, including a partial pass, so the durable watermark
    // never lags a write that already reached the engine. With nothing applied this is
    // simply the floor, and a pass that applied nothing saves nothing.
    const durable = appliedThrough ?? base
    if (durable === watermark.appliedRevision) return
    try {
      await writeSessionIntentWatermark(input.watermarkPath, durable)
    } catch (error) {
      // The writes above already reached the engine and `appliedThrough` already covers them,
      // so this pass does not repeat them; only a restart can, and only after this point.
      // The store's own typed code is kept: the engine is fine, the watermark is not.
      refuse('', configFault(error).code, messageOf(error, 'the pending Session write watermark could not be saved'))
    }
  }

  return { reconcile, recordPath: input.recordPath, watermarkPath: input.watermarkPath, failures: () => [...failures] }
}

/**
 * The one record path this daemon reads. It is derived from the daemon's own accepted
 * identity, account and scope plus the established `~/.agentteams` local root, so the
 * control daemon resolves the same file without a new config key.
 */
export function agentSessionIntentPath(home: string, daemon: AgentDaemonIntent['daemon']): string {
  return sessionIntentScopePath({ home, accountId: daemon.accountId, scopeId: daemon.scopeId, agentId: daemon.id })
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
  // The one dispatch point: the configured engine kind selects the adapter, and
  // every step below (executable resolution, compileLaunch, the daemon, the
  // stdio duplex, readiness and stop) is engine-independent.
  const adapter = engineAdapterFor(engine.kind)
  // The adapter owns its enforceable-policy set. Resolve it before any
  // directory, file write or spawn; the entry never substitutes a different set.
  const enforceablePolicies = requireEnforceablePolicies(adapter)
  const executable = engine.kind === 'opencode'
    ? resolveOpenCodeExecutable(engine.executable, env)
    : resolveDshExecutable(engine.executable, env)
  const dataDirectory = resolve(agent.daemon.dataDirectory)
  const ownedDirectory = join(dataDirectory, 'engine')
  const workspace = engine.workspace ?? join(dataDirectory, 'workspace')
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  // The workspace is created before the owned engine directory: it may outlive
  // this entry, so a failure here must not leave an owned engine home behind.
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await mkdir(ownedDirectory, { recursive: true, mode: 0o700 })

  // The owned engine directory is created by this entry and holds only derived
  // engine state (the DSH profile patch and, with DSH_HOME, the engine's own
  // session store). It is removed on every exit path, so a failed start or a
  // stop leaves no engine home behind; the daemon data directory, the durable
  // history and the workspace stay.
  const removeOwnedDirectory = async (): Promise<void> => {
    await rm(ownedDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  // The launch compilation and the history store are the throwing steps that run
  // after the owned directory exists, so their failure releases it exactly like
  // a failed start does.
  const guardOwnedDirectory = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (cause) {
      await removeOwnedDirectory().catch(() => undefined)
      throw cause
    }
  }

  // The daemon's own published listener generation. The direct listener target,
  // the ingress responder context and the egress initiator's
  // `expectedTargetGeneration` all read this one constant, so both ends of a
  // declared peer dial agree on the target generation without a second config key.
  const targetGeneration = 1
  const engineInstanceId = `${engine.kind}-${agent.daemon.id}-${randomUUID()}`
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
    kind: engine.kind,
    executable,
    workspace,
    ownedDirectory,
    target,
    accepted: intent.accepted,
    policy: agent.acp,
  }
  const launch = await guardOwnedDirectory(() => adapter.compileLaunch(launchInput))
  const historyStore = await guardOwnedDirectory(() => createAcpHistoryStore({ directory: dataDirectory }))
  const initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  const outcome = await startAcpAgentDaemon({
    launch,
    engineInstanceId,
    targetGeneration,
    policy: {
      intent: agent.acp,
      adapterMethods: adapter.declaredMethods,
      enforceablePolicies,
    },
    history: historyStore,
    initialize: { params: { protocolVersion: 1, clientCapabilities: {} }, timeoutMs: initializeTimeoutMs },
    stopTimeoutMs,
    agentId: agent.daemon.id,
    resolveCredential: reference => resolveCredentialReference(reference, env),
  })
  if (outcome.kind === 'failed') {
    // No child survives a failed start (`startAcpAgentDaemon` reaps it), so the
    // owned engine home is removed here too.
    await removeOwnedDirectory().catch(() => undefined)
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
    const verified = await verifyReadiness({ daemon, adapter, readinessRef, principal, launch: launchInput, workspace, initializeTimeoutMs })

    // The published revision is known before the LAN listener binds: the D04
    // helper advances the declaration by exactly one, and the real bound port
    // changes only the route, never the revision. The LAN target, the ingress
    // responder and the published declaration therefore carry one revision.
    const listenerClass = classifyServeListener(listen)
    const declaration = declarationForDaemon(agent)
    const surfacesFor = (port: number): PublishedDaemonSurfaces => ({
      capabilities: acpCapabilityDeclarations(daemon.policy),
      routes: listenerRouteCandidates({ ...agent, listen: { ...listen, port } }, new Date().toISOString()),
    })
    const capabilitiesRevision = String(declarationWithPublishedSurfaces(declaration, surfacesFor(listen.port)).revision)

    const local = await buildLocalChannel({ daemon, principal, targetGeneration, engineInstanceId, listen, listenerClass })

    // Live connection truth and the durable connection history are one pair for
    // both channels: the LAN ingress writes them, the status port reads them.
    const ledger = createTeamsConnectionLedger()
    const teamsHistory = createTeamsConnectionHistory(historyStore)

    let lan: ServeLanChannel | undefined
    let registration: AgentRegistration | undefined
    let egress: ServeEgressOwner | undefined
    try {
      if (listenerClass === 'lan') {
        lan = await buildLanChannel({
          daemon,
          intent: agent,
          listen,
          env,
          capabilitiesRevision,
          targetGeneration,
          selfPolicyRevision: intent.accepted.acceptedRevision,
          engineInstanceId,
          admittedCapabilities: daemon.policy.effective,
          history: teamsHistory,
          ledger,
        })
      }

      // The registration client is composed from the same config-selected
      // discovery plan D04 owns. A disabled plan opens no socket; a failed first
      // attempt reports the typed reconnecting status and retries in the
      // background, so a registry outage never stops the engine.
      registration = await startDaemonRegistration(agent, {
        env,
        ...(options.onRegistrationStatus === undefined ? {} : { onStatus: options.onRegistrationStatus }),
      })
      if (registration.state === 'enabled' && registration.status.state === 'online') {
        // Publish only after the listener is bound and the client is online. The
        // real bound LAN port (port 0 binds an ephemeral one) is the route.
        const published = declarationWithPublishedSurfaces(declaration, surfacesFor(lan?.port ?? local.port))
        await publishServeRegistration({ registration, declaration: published })
      }

      // The agent daemon dials the peers its own accepted config declares. This
      // is the one production composition of the initiator egress: the owner
      // resolves each declared peer from the accepted intent, reads the
      // responder's published capability revision through the same scoped
      // directory readback the D04 registration client already owns, and dials
      // with the D05-proven `buildDirectWssRoutePlan` + `connectDirectWssTarget`
      // pair. A peer that cannot be dialed records a typed failure here instead
      // of crashing the daemon or being skipped silently.
      const readServeEgressTargetFacts = async (input: {
        readonly peerName: string
        readonly peer: PeerIntent
      }): Promise<ServeEgressTargetFacts> => {
        const registrationForDirectory = registration
        if (registrationForDirectory === undefined || registrationForDirectory.state !== 'enabled') {
          throw new AcpError('UNSUPPORTED_CONFIGURATION',
            `serve-egress: peer ${input.peerName} cannot be dialed because this config declares no [discovery] directory readback`)
        }
        const directoryStatus = registrationForDirectory.client.status()
        if (directoryStatus.state !== 'online') {
          throw new AcpError('ENGINE_UNAVAILABLE',
            `serve-egress: the directory readback for peer ${input.peerName} is unavailable while registration is ${directoryStatus.state}`)
        }
        const snapshot = await registrationForDirectory.client.directorySnapshot(false)
        const entry = snapshot.peers.find(candidate => candidate.declaration.identity.agentId === input.peer.agentId)
        if (entry === undefined) {
          throw new AcpError('FORBIDDEN',
            `serve-egress: the scoped directory has no confirmed declaration for peer ${input.peerName} (${input.peer.agentId})`)
        }
        return {
          directoryGeneration: snapshot.revision,
          // The responder's own published listener generation. The serve entry
          // binds its listener target with this same constant, and the directory
          // carries only the relay login generation (a different value), so the
          // dialer uses the one constant the responder itself publishes.
          targetGeneration,
          targetCapabilitiesRevision: String(entry.declaration.revision),
        }
      }
      const egressOwner = createServeEgressOwner({
        peers: agent.peers,
        self: principal,
        selfGeneration: targetGeneration,
        selfCapabilitiesRevision: capabilitiesRevision,
        selfPolicyRevision: intent.accepted.acceptedRevision,
        allowedRoles: agent.relations.allowed,
        requestedCapabilities: daemon.policy.effective,
        host: daemon.host,
        policy: daemon.policy,
        engineInstanceId,
        history: teamsHistory,
        ledger,
        env,
        readTargetFacts: readServeEgressTargetFacts,
      })
      egress = egressOwner
      for (const peerName of Object.keys(agent.peers)) {
        // `connect` records its own typed failure and throws; the start path
        // collects the recorded failure and continues with the next peer.
        await egressOwner.connect(peerName).catch(() => undefined)
      }
      const egressFailures = egressOwner.failures()

      // The desired-relations watch. The control daemon owns the record; this daemon
      // reads it on a named interval and makes its live egress rows match, so the
      // Console stays out of the data path and no control-to-agent channel is added.
      // `runtime/serve-egress.ts` owns the role derivation the record never overrides.
      const relationsWatch = createRelationsIntentWatch({
        owner: egressOwner,
        recordPath: agentRelationsIntentPath(homedir(), agent.daemon),
        peers: agent.peers,
      })
      const relationsTimer = setInterval(() => { void relationsWatch.reconcile() }, RELATIONS_INTENT_POLL_INTERVAL_MS)
      // The watch must never keep a stopped daemon's event loop alive.
      relationsTimer.unref()

      // The pending-Session-write watch. The control daemon writes what the Console
      // submitted; this daemon applies it to its own host on a named interval, so the
      // Console stays out of the data path and no control-to-agent channel is added. The
      // host is the A2.6 permission owner and the only place that knows which Session each
      // open channel owns, so the watch never tracks either fact a second time.
      const sessionWatch = createSessionIntentWatch({
        host: daemon.host,
        recordPath: agentSessionIntentPath(homedir(), agent.daemon),
        watermarkPath: sessionIntentWatermarkPath(agent.daemon.dataDirectory),
        agentId: agent.daemon.id,
      })
      const sessionTimer = setInterval(() => { void sessionWatch.reconcile() }, RELATIONS_INTENT_POLL_INTERVAL_MS)
      sessionTimer.unref()

      const teamsStatus = createTeamsStatusPort({
        ledger,
        localAgentId: agent.daemon.id,
        // The ACP serve entry owns no directory projection. The snapshot is the
        // unconfirmed local state (`generation: 0`, no hosts), so `connections()`
        // reports the live ledger. No delivery wires a live directory readback
        // here: the control daemon composes this same honest snapshot.
        directory: { accountId: agent.daemon.accountId, scopeId: agent.daemon.scopeId, generation: 0, hosts: [], peerStates: [] },
        registration: registration.status,
        history: teamsHistory,
      })

      const listenerReadback = lan === undefined
        ? { ip: local.ip, port: local.port }
        : { ip: listen.ip, port: lan.port }

      let stopping: Promise<AcpServeStopReceipt> | undefined
      const stop = (): Promise<AcpServeStopReceipt> => {
        if (stopping !== undefined) return stopping
        stopping = (async (): Promise<AcpServeStopReceipt> => {
          // The watch stops before the egress it drives, so no reconcile can dial a
          // peer while the channels it needs are closing.
          clearInterval(relationsTimer)
          // The Session watch stops before the host it drives, so no write is applied to a
          // channel that is closing.
          clearInterval(sessionTimer)
          // Order: the daemon's own egress rows, the LAN listener, the local
          // server (which destroys its channels), the registration client, then
          // the daemon and the owned directory. The egress closes BEFORE the host
          // it serves, so no live initiator channel outlives its host.
          await egressOwner.close().catch(() => undefined)
          if (lan !== undefined) await lan.close().catch(() => undefined)
          const channels = await local.close()
          await daemon.host.close(readinessRef).catch(() => undefined)
          if (registration !== undefined && registration.state === 'enabled') {
            await registration.client.stop().catch(() => undefined)
          }
          const engineStop = await daemon.stop()
          // The engine is gone, so its owned home (DSH_HOME and the derived patch
          // file, or the OpenCode home) is released on this stop path too.
          await removeOwnedDirectory().catch(() => undefined)
          return { engine: engineStop, channels }
        })()
        return stopping
      }

      return {
        agentId: agent.daemon.id,
        engineKind: engine.kind,
        engineInstanceId,
        enginePid: daemon.handle.pid,
        configPath: intent.configPath,
        dataDirectory,
        listener: listenerReadback,
        localChannel: { ip: local.ip, port: local.port },
        lanChannel: lan === undefined
          ? null
          : { endpoint: lan.endpoint, port: lan.port, capabilitiesRevision: lan.capabilitiesRevision },
        capabilitiesRevision,
        get registration(): RegistrationStatus {
          return registration?.state === 'enabled' ? registration.client.status() : registration!.status
        },
        teamsStatus,
        egress: egressOwner,
        egressFailures,
        relationsIntent: {
          path: relationsWatch.recordPath,
          failures: () => relationsWatch.failures(),
        },
        sessionIntent: {
          path: sessionWatch.recordPath,
          watermarkPath: sessionWatch.watermarkPath,
          failures: () => sessionWatch.failures(),
        },
        readiness: {
          agentId: agent.daemon.id,
          engineInstanceId,
          enginePid: daemon.handle.pid,
          listener: listenerReadback,
          modelTarget: verified.modelTarget,
          modelVerification: verified.modelVerification,
          effectiveRevision: verified.effectiveRevision,
          evidence: verified.evidence,
        },
        daemon,
        stop,
      }
    } catch (cause) {
      if (egress !== undefined) await egress.close().catch(() => undefined)
      if (registration !== undefined && registration.state === 'enabled') {
        await registration.client.stop().catch(() => undefined)
      }
      if (lan !== undefined) await lan.close().catch(() => undefined)
      await local.close().catch(() => undefined)
      throw cause
    }
  } catch (cause) {
    await daemon.stop().catch(() => undefined)
    await removeOwnedDirectory().catch(() => undefined)
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
    `engine=${handle.engineKind}`,
    `engineInstance=${handle.engineInstanceId}`,
    `enginePid=${handle.enginePid}`,
    `daemonPid=${process.pid}`,
    `listener=${handle.listener.ip}:${handle.listener.port}`,
    `localChannel=${handle.localChannel.ip}:${handle.localChannel.port}`,
    `lanChannel=${handle.lanChannel === null ? 'none' : handle.lanChannel.endpoint}`,
    `capabilitiesRevision=${handle.capabilitiesRevision}`,
    `registration=${handle.registration.state}`,
    `dataDirectory=${handle.dataDirectory}`,
    `config=${handle.configPath ?? 'quick-start'}`,
    `model=${modelText(handle.readiness)}`,
    `modelVerification=${handle.readiness.modelVerification}`,
    `effectiveRevision=${handle.readiness.effectiveRevision}`,
  ].join(' ')
}

/**
 * The registration status line the entry prints on a live transition. The
 * readiness line reports the start state; later lines report degradation and
 * recovery while the engine keeps serving.
 */
export function formatAcpServeRegistration(status: RegistrationStatus): string {
  return [
    'registration',
    `state=${status.state}`,
    `attempts=${status.attempts}`,
    `reconnects=${status.reconnects}`,
    `endpoint=${status.endpoint ?? 'none'}`,
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
  // The readiness line reports the registration state at start; later live
  // transitions are reported as their own line, so a registry outage is
  // observable while the engine and its established channels keep working.
  let ready = false
  const handle = await startAcpServe(intent, {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: input.initializeTimeoutMs }),
    ...(input.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: input.stopTimeoutMs }),
    onRegistrationStatus: status => { if (ready) report(formatAcpServeRegistration(status)) },
  })
  report(formatAcpServeReady(handle))
  ready = true
  try {
    await waitForStopSignal(input.signal)
  } finally {
    const receipt = await handle.stop()
    report(formatAcpServeStopped(handle, receipt))
  }
}
