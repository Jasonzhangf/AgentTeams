import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  parseDaemonConfigText,
  readDaemonEffectiveConfig,
  resolveDaemonIntent,
  type ControlDaemonIntent,
  type DaemonEffectiveConfig,
  type DaemonIntentV4,
  type PeerIntent,
} from '../config/daemon-intent.ts'
import {
  readRelationsIntentRecord,
  relationsIntentScopePath,
  writeRelationsIntentRecord,
  type RelationsIntentChange,
} from '../config/relations-intent-store.ts'
import {
  readSessionIntentRecord,
  sessionIntentScopePath,
  writeSessionIntentRecord,
  type SessionIntentChange,
} from '../config/session-intent-store.ts'
import { readSessionObservationRecord, sessionObservationScopePath } from '../config/session-observation-store.ts'
import { localGroupEndpointScopePath, readLocalGroupEndpointRecord } from '../config/local-group-endpoint-store.ts'
import { LocalMessageSocketError, sendLocalMessageRequest } from './local-message-socket.ts'
import { RuntimeConfigError, type ConfigApplyResult } from '../config/runtime-config.ts'
import { createConsoleAuthorization } from '../console-host/src/auth.ts'
import { createConsoleServer } from '../console-host/src/server.ts'
import type { ConsoleGroupForwardOutcome, ConsoleGroupForwardPort } from '../console-host/src/http-api.ts'
import type { RelayPeer } from '../packages/shared/src/agent-services.ts'
import type { RelationRole } from '../packages/shared/src/teams-connection.ts'
import {
  parseConsoleProjection,
  type ConsoleAgentObservationV1,
  type ConsoleCommandResultV1,
  type ConsoleCommandV1,
  type ConsoleClientV1,
  type ConsoleProjectionV1,
  type JsonValue,
} from '../packages/shared/src/console-api.ts'
import {
  historyQueryFromSearchParams,
  parseConsoleProjectionSnapshot,
  parseHistoryQuery,
  type ConsoleProjectionSink,
  type ConsoleProjectionSnapshot,
  type ConsoleProjectionSubscriber,
  type ConsoleProjectionUnsubscribe,
  type HistoryPage,
  type HistoryQuery,
  type HistoryReadPort,
} from '../packages/shared/src/teams-state.ts'
import { refreshRelayDirectory, type AccountDirectorySnapshot } from '../network/account-directory.ts'
import type { RegistrationStatus } from '../network/registration-client.ts'
import type { RelayDirectorySnapshot } from '../network/relay-client.ts'
import { createTeamsConnectionHistory } from '../network/teams-connection-history.ts'
import { createTeamsConnectionLedger } from '../network/teams-ingress.ts'
import { membershipHistoryEvents, projectTeamsMembership, type TeamsMembershipView } from '../network/teams-membership.ts'
import { createTeamsStatusPort, type TeamsStatusPort } from '../network/teams-status.ts'
import { createAcpHistoryStore } from './acp-history-store.ts'
import { directoryAgentObservation } from './console-hub.ts'
import { processAlive, processCommand, processOwnsConfigCommand, terminateProcess } from './local-ownership.ts'
import { RegistrationProcessError, startDaemonRegistration, type AgentRegistration } from './registry-registration.ts'

/**
 * Runtime single writer for the control-kind daemon. It composes the frozen v4 control
 * intent with the frozen Console wire surface and owns exactly one process: one PID, one
 * state file, one WebUI listener. It never starts an engine child, a registry, an implicit
 * master, or a second daemon.
 *
 * The Teams connection projection is a structural read of the real network status port
 * (`network/teams-status.ts`, D05). The child entry binds that owner from the daemon's own
 * real network facts; the port stays structurally optional so a daemon without the
 * dependency fails with a typed error instead of fabricating connection state. It never
 * infers online or execution state from history.
 *
 * The three frozen relation commands (A2.4) are written into the one durable
 * desired-relations record that the agent daemon observes later
 * (`config/relations-intent-store.ts`, one record per daemon data directory). This daemon
 * is that record's single writer: it writes desired intent and the accepted revision
 * only, and never reports a connection state, because the connection outcome belongs to
 * the reacting daemon.
 *
 * This file is both the parent lifecycle entry and the detached child entry, exactly like
 * `runtime/registry-process.ts`.
 */
const STATE_VERSION = 1
const STATE_FILE_NAME = 'control-state.json'
const TOKEN_FLAG = '--start-token'
const AUTHENTICATION_CHALLENGE = 'Basic realm="AgentTeams", charset="UTF-8"'

/**
 * The network status port is the real D05 owner type. The control runtime consumes it
 * structurally and declares no synonymous port of its own.
 */

/** One bound Console owner: projection read plus the two mutation ingresses. */
export interface ControlOwnerBinding {
  readProjection(): Promise<ConsoleProjectionV1>
  command(command: ConsoleCommandV1): Promise<ConsoleCommandResultV1>
  sendSession(target: { readonly agentId: string; readonly sessionId: string }, payload: JsonValue): Promise<ConsoleCommandResultV1>
}

/** Owner projection feed. `watch` is absent when the owner cannot stream yet. */
export interface ControlProjectionSource {
  read(): Promise<ConsoleProjectionV1>
  watch?: ConsoleProjectionSubscriber
}

export type ControlDaemonLifecycleState = 'starting' | 'running' | 'failed' | 'stopped'

export interface ControlDaemonState {
  readonly version: typeof STATE_VERSION
  readonly configPath: string
  readonly entryPath: string
  readonly daemonId: string
  readonly startToken: string
  readonly generation: number
  readonly pid: number
  readonly state: ControlDaemonLifecycleState
  readonly url?: string
  /** The typed failure the child published, so the parent re-throws the real code. */
  readonly errorCode?: ControlProcessErrorCode
  readonly error?: string
  readonly updatedAt: string
}

export interface ControlDaemonStatus {
  readonly configPath: string
  readonly statePath: string
  readonly daemonId: string
  readonly state: ControlDaemonLifecycleState
  readonly generation: number
  readonly pid?: number
  readonly url?: string
  readonly error?: string
  /** Effective listener and owned paths; never a credential value. */
  readonly listener?: { readonly ip: string; readonly port: number }
  readonly dataDirectory?: string
}

export type ControlProcessErrorCode =
  | 'INVALID_CONFIG'
  | 'UNSUPPORTED_CONFIGURATION'
  | 'ALREADY_RUNNING'
  | 'START_TIMEOUT'
  | 'STOP_TIMEOUT'
  | 'STALE_GENERATION'
  | 'STALE_OWNER'
  | 'INVALID_STATUS'
  | 'PORT_OCCUPIED'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'HISTORY_UNAVAILABLE'
  | 'STREAM_UNAVAILABLE'
  | 'UNSUPPORTED_OPERATION'

const CONTROL_PROCESS_ERROR_CODES: readonly ControlProcessErrorCode[] = [
  'INVALID_CONFIG', 'UNSUPPORTED_CONFIGURATION', 'ALREADY_RUNNING', 'START_TIMEOUT', 'STOP_TIMEOUT',
  'STALE_GENERATION', 'STALE_OWNER', 'INVALID_STATUS', 'PORT_OCCUPIED', 'CREDENTIAL_UNAVAILABLE',
  'HISTORY_UNAVAILABLE', 'STREAM_UNAVAILABLE', 'UNSUPPORTED_OPERATION',
]

export class ControlProcessError extends Error {
  constructor(readonly code: ControlProcessErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'ControlProcessError'
  }
}

export interface ControlDaemonStartOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly nodeExecutable?: string
  readonly nodeArguments?: readonly string[]
  readonly startupTimeoutMs?: number
}

export interface ControlProcessArgs {
  readonly configPath: string
  readonly startToken?: string
}

export function parseControlArgs(argv: readonly string[]): ControlProcessArgs {
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
      throw new ControlProcessError('INVALID_CONFIG', `usage: control-process --config <file> [${TOKEN_FLAG} <token>]`)
    }
  }
  if (configPath === undefined || configPath.trim() === '') {
    throw new ControlProcessError('INVALID_CONFIG', `usage: control-process --config <file> [${TOKEN_FLAG} <token>]`)
  }
  if (startToken !== undefined && startToken.trim() === '') {
    throw new ControlProcessError('INVALID_CONFIG', `${TOKEN_FLAG} requires a non-empty token`)
  }
  return { configPath: resolve(configPath), ...(startToken === undefined ? {} : { startToken }) }
}

/**
 * Loads one v4 control config through the frozen config owner. A non-control config is a
 * typed unsupported-configuration failure, never a silent reuse of another daemon kind.
 */
export async function loadControlIntent(configPath: string): Promise<ControlDaemonIntent> {
  const absolute = resolve(configPath)
  let text: string
  try {
    text = await readFile(absolute, 'utf8')
  } catch (cause) {
    throw new ControlProcessError('INVALID_CONFIG', `control config could not be read: ${absolute}`, cause)
  }
  let intent: DaemonIntentV4
  try {
    intent = parseDaemonConfigText(text)
  } catch (cause) {
    throw new ControlProcessError('INVALID_CONFIG', cause instanceof Error ? cause.message : String(cause), cause)
  }
  if (intent.daemon.kind !== 'control') {
    throw new ControlProcessError('UNSUPPORTED_CONFIGURATION',
      'control daemon config is required; start agent, registry, or console daemons with their own entry')
  }
  return resolveDaemonIntent(intent, { configDirectory: dirname(absolute) }) as ControlDaemonIntent
}

/** The effective listener the control daemon binds; one readback for status and start. */
export function readControlEffectiveConfig(intent: ControlDaemonIntent): DaemonEffectiveConfig & { readonly listener: { readonly ip: string; readonly port: number } } {
  const effective = readDaemonEffectiveConfig(intent)
  if (effective.listener === undefined) throw new ControlProcessError('INVALID_CONFIG', 'control daemon requires a webui listener')
  return { ...effective, listener: effective.listener }
}

export function controlStatePath(intent: ControlDaemonIntent): string {
  return join(intent.daemon.dataDirectory, STATE_FILE_NAME)
}

export async function readControlState(statePath: string): Promise<ControlDaemonState | undefined> {
  let text: string
  try {
    text = await readFile(statePath, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ControlProcessError('INVALID_STATUS', `control state could not be read: ${statePath}`, cause)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new ControlProcessError('INVALID_STATUS', `control state is not valid JSON: ${statePath}`, cause)
  }
  const state = value as ControlDaemonState
  if (state === null || typeof state !== 'object' || state.version !== STATE_VERSION
    || typeof state.configPath !== 'string' || typeof state.entryPath !== 'string'
    || typeof state.startToken !== 'string' || !Number.isSafeInteger(state.generation)
    || !Number.isSafeInteger(state.pid) || !['starting', 'running', 'failed', 'stopped'].includes(state.state)
    || (state.errorCode !== undefined && !CONTROL_PROCESS_ERROR_CODES.includes(state.errorCode))) {
    throw new ControlProcessError('INVALID_STATUS', `control state is malformed: ${statePath}`)
  }
  return state
}

async function writeControlState(statePath: string, state: ControlDaemonState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
  await rename(temporary, statePath)
}

function sourceNodeArguments(): readonly string[] {
  return fileURLToPath(import.meta.url).endsWith('.ts') ? ['--experimental-transform-types'] : []
}

function statusFrom(intent: ControlDaemonIntent, statePath: string, configPath: string, state: ControlDaemonState | undefined): ControlDaemonStatus {
  const effective = readControlEffectiveConfig(intent)
  const base = {
    configPath,
    statePath,
    daemonId: intent.daemon.id,
    listener: effective.listener,
    dataDirectory: intent.daemon.dataDirectory,
  }
  if (state === undefined) return { ...base, state: 'stopped', generation: 0 }
  return {
    ...base,
    state: state.state,
    generation: state.generation,
    pid: state.pid,
    ...(state.url === undefined ? {} : { url: state.url }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

async function ownsPersistedProcess(state: ControlDaemonState): Promise<boolean> {
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
  throw new ControlProcessError('STOP_TIMEOUT', `control pid=${pid} did not exit after SIGTERM`)
}

async function waitForState(statePath: string, expected: readonly ControlDaemonLifecycleState[], timeoutMs: number): Promise<ControlDaemonState> {
  const deadline = Date.now() + timeoutMs
  let last: ControlDaemonState | undefined
  while (Date.now() < deadline) {
    last = await readControlState(statePath)
    if (last !== undefined && expected.includes(last.state)) return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  if (last?.state === 'failed' && last.error !== undefined) {
    // The child published its typed code, so the parent re-throws the real failure.
    throw new ControlProcessError(last.errorCode ?? 'START_TIMEOUT', `control process failed to start: ${last.error}`)
  }
  throw new ControlProcessError('START_TIMEOUT', `control did not report ${expected.join('/')} within ${timeoutMs}ms`)
}

/**
 * Stop removes the daemon's runtime ownership record, not its data directory. The directory
 * is durable: the control daemon keeps its `kind: 'connection'` history there, so deleting
 * the whole directory would destroy history that must survive an owner restart. The agent
 * daemon likewise keeps its data directory across a stop. The recorded state is the only
 * runtime artifact the control daemon writes, so removing it is the whole cleanup.
 */
async function removeOwnedState(statePath: string): Promise<void> {
  try { await rm(statePath, { force: true }) } catch { /* keep the recorded state */ }
}

export async function startControlDaemon(configPath: string, options: ControlDaemonStartOptions = {}): Promise<ControlDaemonStatus> {
  const intent = await loadControlIntent(configPath)
  // The parent validates the declared listener before spawning, like the registry plan.
  readControlEffectiveConfig(intent)
  const childEnv = { ...process.env, ...options.env }
  const declaredPasswordEnv = intent.webui.auth?.passwordEnv
  if (declaredPasswordEnv !== undefined && (childEnv[declaredPasswordEnv] ?? '') === '') {
    // Resolve the declared credential reference before spawning, like the registry plan:
    // a listener that cannot authenticate never starts and never leaves a pid record.
    throw new ControlProcessError('CREDENTIAL_UNAVAILABLE',
      `webui.auth.passwordEnv ${declaredPasswordEnv} is not set in the operator environment`)
  }
  const statePath = controlStatePath(intent)
  const resolvedConfigPath = resolve(configPath)
  const entryPath = fileURLToPath(import.meta.url)
  const previous = await readControlState(statePath)
  if (previous !== undefined && previous.configPath !== resolvedConfigPath) {
    throw new ControlProcessError('STALE_OWNER', `control state belongs to another config: ${previous.configPath}`)
  }
  if (previous !== undefined && previous.state !== 'stopped' && previous.pid > 0 && processAlive(previous.pid)) {
    if (!(await ownsPersistedProcess(previous))) {
      throw new ControlProcessError('STALE_OWNER', `control pid=${previous.pid} does not match its persisted start token`)
    }
    // A start replaces the previous generation for this config. SIGTERM is the
    // graceful path; a process that ignores it is killed by explicit PID.
    const termination = await terminateProcess(previous.pid, { gracefulMs: 5_000, hardMs: 2_000 })
    if (termination === 'unresponsive') {
      throw new ControlProcessError('STOP_TIMEOUT', `control pid=${previous.pid} did not exit after SIGTERM and SIGKILL`)
    }
  }
  const generation = (previous?.generation ?? 0) + 1
  const startToken = randomUUID()
  await writeControlState(statePath, {
    version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
    startToken, generation, pid: 0, state: 'starting', updatedAt: new Date().toISOString(),
  })
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
    await writeControlState(statePath, {
      version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
      startToken, generation, pid: 0, state: 'failed', error: message, updatedAt: new Date().toISOString(),
    })
    throw new ControlProcessError('INVALID_CONFIG', `control process could not be spawned: ${message}`, cause)
  }
  if (child.pid === undefined) {
    const message = 'detached control process did not return a pid'
    await writeControlState(statePath, {
      version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
      startToken, generation, pid: 0, state: 'failed', error: message, updatedAt: new Date().toISOString(),
    })
    throw new ControlProcessError('INVALID_CONFIG', message)
  }
  const pid = child.pid
  await writeControlState(statePath, {
    version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
    startToken, generation, pid, state: 'starting', updatedAt: new Date().toISOString(),
  })
  try {
    const running = await waitForState(statePath, ['running'], options.startupTimeoutMs ?? 10_000)
    return statusFrom(intent, statePath, resolvedConfigPath, running)
  } catch (error) {
    // A failed child leaves its own error in the state file; keep it and only reclaim the
    // process this parent started. A failed start removes its owned directory and pid record.
    const latest = await readControlState(statePath)
    const failure = latest?.error ?? (error instanceof Error ? error.message : String(error))
    const failureCode = latest?.errorCode ?? (error instanceof ControlProcessError ? error.code : undefined)
    if (latest === undefined || (latest.generation === generation && latest.startToken === startToken)) {
      await writeControlState(statePath, {
        version: STATE_VERSION, configPath: resolvedConfigPath, entryPath, daemonId: intent.daemon.id,
        startToken, generation, pid, state: 'failed',
        ...(failureCode === undefined ? {} : { errorCode: failureCode }), error: failure, updatedAt: new Date().toISOString(),
      })
    }
    if (processAlive(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch { /* preserve the startup failure */ }
      try { await waitForProcessExit(pid, 2_000) } catch { /* preserve the startup failure */ }
    }
    await removeOwnedState(statePath)
    throw error
  }
}

export async function statusControlDaemon(configPath: string): Promise<ControlDaemonStatus> {
  const intent = await loadControlIntent(configPath)
  const statePath = controlStatePath(intent)
  const resolvedConfigPath = resolve(configPath)
  const state = await readControlState(statePath)
  if (state === undefined) return statusFrom(intent, statePath, resolvedConfigPath, undefined)
  if (state.state === 'running' || state.state === 'starting') {
    if (state.pid <= 0 || !processAlive(state.pid)) {
      return statusFrom(intent, statePath, resolvedConfigPath, { ...state, state: 'failed', error: 'control process pid is not alive' })
    }
    if (!(await ownsPersistedProcess(state))) {
      return statusFrom(intent, statePath, resolvedConfigPath, { ...state, state: 'failed', error: 'control process does not match persisted ownership' })
    }
  }
  return statusFrom(intent, statePath, resolvedConfigPath, state)
}

export async function stopControlDaemon(configPath: string, expectedGeneration?: number): Promise<ControlDaemonStatus> {
  const intent = await loadControlIntent(configPath)
  const statePath = controlStatePath(intent)
  const resolvedConfigPath = resolve(configPath)
  const state = await readControlState(statePath)
  if (state === undefined || state.state === 'stopped') {
    await removeOwnedState(statePath)
    return statusFrom(intent, statePath, resolvedConfigPath, undefined)
  }
  if (expectedGeneration !== undefined && expectedGeneration !== state.generation) {
    throw new ControlProcessError('STALE_GENERATION', `stale control generation expected=${expectedGeneration} current=${state.generation}`)
  }
  if (state.pid <= 0 || !processAlive(state.pid)) {
    await removeOwnedState(statePath)
    return statusFrom(intent, statePath, resolvedConfigPath, undefined)
  }
  if (!(await ownsPersistedProcess(state))) {
    throw new ControlProcessError('STALE_OWNER', `control pid=${state.pid} does not match its persisted start token`)
  }
  const termination = await terminateProcess(state.pid, { gracefulMs: 5_000, hardMs: 2_000 })
  if (termination === 'unresponsive') {
    throw new ControlProcessError('STOP_TIMEOUT', `control pid=${state.pid} did not exit after SIGTERM and SIGKILL`)
  }
  await removeOwnedState(statePath)
  return statusFrom(intent, statePath, resolvedConfigPath, undefined)
}

/* ---------------------------------------------------------------------------------------
 * Owner projection, commands and the SSE source.
 * ------------------------------------------------------------------------------------- */

function unavailable(message: string, code: ControlProcessErrorCode): never {
  throw new ControlProcessError(code, message)
}

/** Closed validation of an owner projection; a malformed owner view never reaches the wire. */
function validatedProjection(value: unknown): ConsoleProjectionV1 {
  return parseConsoleProjection(value)
}

/** Structural history read: the frozen port or a typed absence, never a fabricated page. */
export function createControlHistoryReader(port: TeamsStatusPort | undefined): HistoryReadPort {
  return {
    async query(query: HistoryQuery): Promise<HistoryPage> {
      // Re-validate through the frozen parser so the runtime never forwards a widened query.
      const closed = parseHistoryQuery(query)
      if (port === undefined) unavailable('network status port is not bound to this control daemon; history is unavailable', 'HISTORY_UNAVAILABLE')
      return await port.history(closed)
    },
  }
}

function projectionWithConnections(projection: ConsoleProjectionV1, port: TeamsStatusPort | undefined): ConsoleProjectionV1 {
  if (port === undefined) return projection
  // The additive connection rows reuse the frozen status verbatim. `halfOpen` is true while
  // the transport/negotiation lifecycle has not reached a terminal state.
  const connections = port.connections().map(status => ({
    status,
    halfOpen: !['ready', 'closed', 'failed', 'disconnected'].includes(status.state),
  }))
  return { ...projection, connections }
}

/**
 * The accepted control intent facts that own the durable desired-relations record: the
 * daemon's own accepted `peers` (the only legal connect targets), its accepted
 * `relations.allowed` (the one role derivation) and the data directory that owns the file.
 * They are threaded from the daemon's own `loadControlIntent` value; the owner never opens
 * the config file again and never reads the environment.
 */
export interface ControlRelationsIntentFacts {
  readonly peers: Readonly<Record<string, PeerIntent>>
  readonly allowedRoles: readonly RelationRole[]
  /**
   * The account and scope of the target agent, and the home root the shared record path
   * resolves from. This daemon's own configured `daemon.dataDirectory` is deliberately
   * NOT used: an agent daemon must be able to derive the same path from its own facts,
   * and the frozen v4 `PeerIntent` (`config/daemon-intent.ts`: `agentId`, `hostId`,
   * `accountId`, `scopeId`, `endpoint?`, `admissionRef?`, `credentialRef`, `tlsTrustRef?`)
   * carries no peer `dataDirectory`. Adding a key is out of scope, so the one path both
   * sides derive independently is the shared account and scope layout that
   * `config/relations-intent-store.ts` exports:
   * `<home>/.agentteams/relations/<accountId>/<scopeId>/relations-intent.json`.
   *
   * Honest limitation: the record is one desired membership set per account and scope,
   * not one file per agent. A `disconnect` for an agentId this daemon no longer declares
   * is refused, because its account and scope — and therefore its record — cannot be resolved.
   */
  readonly home: string
}

export interface CreateControlOwnerOptions {
  readonly network?: TeamsStatusPort
  readonly owner?: ControlOwnerBinding
  /**
   * The real projection owner. When bound it owns the complete read, including the
   * connection rows it already merged; `network` stays the read port for the connection
   * projection.
   */
  readonly source?: ControlProjectionSource
  /**
   * The accepted control intent facts for the frozen relation commands (A2.4). Without
   * them those commands fail with the typed absence instead of writing a guessed record.
   */
  readonly relations?: ControlRelationsIntentFacts
}

/** The three frozen relation commands the control daemon writes, and nothing else. */
type ControlRelationsCommand = Extract<ConsoleCommandV1,
  { readonly kind: 'connection.connect' | 'connection.disconnect' | 'network.membership.apply' }>

/**
 * The two frozen Session write commands the control daemon writes as intent, and nothing
 * else. `session.create` and `session.open` are deliberately absent: both must return real
 * engine data (a new `sessionId`, a transcript), and a one-way intent record cannot carry a
 * response, so they stay typed unsupported instead of pretending to answer.
 */
type ControlSessionCommand = Extract<ConsoleCommandV1,
  { readonly kind: 'permission.reply' | 'session.cancel' }>

/**
 * One typed command result from one durable CAS write. The result reports the accepted
 * record revision only.
 *
 * It never reports a connection state: the record is the desired intent, and the agent
 * daemon observes it later and owns the real connection outcome. A `failed` or `uncertain`
 * store result keeps its real typed error, so an ambiguous rename is never reported as
 * applied.
 */
function relationsWriteResult(result: ConfigApplyResult): ConsoleCommandResultV1 {
  if (result.status === 'applied') return { ok: true, result: { acceptedRevision: result.effectiveRevision } }
  return { ok: false, error: { code: result.error.code, message: result.error.message } }
}

/**
 * The control owner client. Without a network status port the connection projection stays
 * absent, and without the daemon's accepted intent facts the relation commands fail with
 * the typed absence; nothing is faked. With those facts the relation commands write the
 * one durable desired-relations record through the delivered CAS store.
 */
export function createControlOwner(options: CreateControlOwnerOptions): ConsoleClientV1 {
  const { network, owner, source, relations } = options
  const read = async (): Promise<ConsoleProjectionV1> => {
    if (source !== undefined) return validatedProjection(await source.read())
    const base = owner === undefined
      ? { version: 1 as const, agents: [], sessions: [], notifications: [], configs: [] }
      : validatedProjection(await owner.readProjection())
    return projectionWithConnections(base, network)
  }
  /**
   * The two frozen Session write commands plus the Session body ingress. They write the
   * durable pending-Session-write record and never touch an engine, a transcript, or a
   * Session state; the agent daemon that owns the Session reacts to the record later on its
   * own. The record path is resolved from the target agent's declared identity, account and
   * scope, never guessed and never this daemon's own data directory.
   */
  /**
   * The two frozen Session write commands. `permission.reply` carries the operator's `decision`
   * and, when the Console chose one, the engine `optionId` it clicked. This daemon carries both
   * into the record verbatim; it never invents an optionId. The agent daemon that owns the
   * Session answers the engine with exactly the named option, and it falls back to the projected
   * kind only for a command that named no option.
   */
  const sessionCommand = async (command: ControlSessionCommand): Promise<ConsoleCommandResultV1> => {
    // This daemon is the record's single writer, and the store's CAS is read-then-rename. Two
    // Console commands that interleave there can both read the same revision and then both
    // rename, which loses one intent while reporting success for both. Serializing this
    // daemon's own writes removes that interleaving.
    return await serializeSessionWrite(async () => {
      if (command.kind === 'permission.reply') {
        return await sessionWrite(command.agentId, command.sessionId, target => ({
          op: 'permission.reply',
          agentId: target.agentId,
          sessionId: target.sessionId,
          permissionId: command.permissionId,
          decision: command.decision,
          // The frozen command may carry the engine option the Console chose. It is carried
          // verbatim so the owning daemon answers with that option, not a same-kind guess.
          ...(command.optionId === undefined ? {} : { optionId: command.optionId }),
        }))
      }
      return await sessionWrite(command.agentId, command.sessionId, target => ({ op: 'session.cancel', agentId: target.agentId, sessionId: target.sessionId }))
    })
  }

  /** Serialize this daemon's own writes to the Session write record it solely owns. */
  let sessionWriteChain: Promise<unknown> = Promise.resolve()
  const serializeSessionWrite = <T>(work: () => Promise<T>): Promise<T> => {
    const next = sessionWriteChain.then(work, work)
    sessionWriteChain = next.then(() => undefined, () => undefined)
    return next
  }

  const sessionWrite = async (
    agentId: string,
    sessionId: string,
    change: (target: { readonly agentId: string; readonly sessionId: string }) => SessionIntentChange,
  ): Promise<ConsoleCommandResultV1> => {
    if (relations === undefined) {
      return { ok: false, error: { code: 'UNAVAILABLE', message: 'the accepted control intent is not bound to this control daemon; the pending Session write record is unavailable' } }
    }
    const target = Object.values(relations.peers).find(peer => peer.agentId === agentId)
    if (target === undefined) {
      // No guessed record path: an agentId this daemon does not declare has no resolvable
      // account and scope, and the Session it names is not this daemon's to write.
      return { ok: false, error: { code: 'FORBIDDEN', message: `agentId ${agentId} is not declared by this control daemon's accepted peers` } }
    }
    const path = sessionIntentScopePath({ home: relations.home, accountId: target.accountId, scopeId: target.scopeId, agentId: target.agentId })
    try {
      // These commands carry no expectedRevision, so the accepted revision of the one
      // durable record is the CAS base. This daemon is that record's single writer, and the
      // store still applies the CAS.
      const current = await readSessionIntentRecord(path)
      return relationsWriteResult(await writeSessionIntentRecord(path, current?.revision ?? 0, change({ agentId, sessionId })))
    } catch (error) {
      // A broken stored record is the store's own typed throw: refuse it here and leave the
      // durable bytes untouched instead of overwriting them.
      if (error instanceof RuntimeConfigError) return { ok: false, error: { code: error.code, message: error.message } }
      throw error
    }
  }

  /**
   * The three frozen relation commands. They write the durable desired relations record
   * and never dial, negotiate, or report connection state; the agent daemon reacts to the
   * record later. The record path is resolved from the target agent's declared account and
   * scope, never guessed and never this daemon's own data directory.
   */
  const relationsCommand = async (command: ControlRelationsCommand): Promise<ConsoleCommandResultV1> => {
    if (relations === undefined) {
      return { ok: false, error: { code: 'UNAVAILABLE', message: 'the accepted control intent is not bound to this control daemon; the desired relations record is unavailable' } }
    }
    // One desired membership set per account and scope. The target's own account and scope
    // come from this daemon's accepted `peers`, which is the only place that carries them.
    const target = Object.values(relations.peers).find(peer => peer.agentId === command.agentId)
    if (target === undefined) {
      // No guessed relation and no guessed record path: an agentId this daemon does not
      // declare has no resolvable account and scope.
      return { ok: false, error: { code: 'FORBIDDEN', message: `agentId ${command.agentId} is not declared by this control daemon's accepted peers` } }
    }
    const path = relationsIntentScopePath({ home: relations.home, accountId: target.accountId, scopeId: target.scopeId })
    try {
      if (command.kind === 'network.membership.apply') {
        // One record means one CAS fence: every member must belong to the same account and
        // scope as the record, or the set could be written where its own agent never reads.
        const foreign = command.members.find(member => {
          const peer = Object.values(relations.peers).find(candidate => candidate.agentId === member.agentId)
          return peer === undefined || peer.accountId !== target.accountId || peer.scopeId !== target.scopeId
        })
        if (foreign !== undefined) {
          return { ok: false, error: { code: 'FORBIDDEN', message: `member ${foreign.agentId} is not a declared peer of the record's account and scope` } }
        }
        // The caller's own expectation is the CAS base, unchanged: a stale client must
        // conflict instead of overwriting a newer desired set.
        return relationsWriteResult(await writeRelationsIntentRecord(path, command.expectedRevision, { op: 'replace', peers: command.members }))
      }
      // `connect` and `disconnect` carry no expectedRevision, so the accepted revision of
      // the one durable record is the CAS base. The store still applies the CAS; this
      // daemon is that record's single writer. A disconnect of an absent relation stays
      // the store's accepted no-op revision bump.
      const current = await readRelationsIntentRecord(path)
      const change: RelationsIntentChange = command.kind === 'connection.connect'
        // The one role rule: the same derivation `runtime/serve-egress.ts` applies to its
        // `requestedPeerRole` from the daemon's own accepted `relations.allowed`.
        ? { op: 'connect', agentId: command.agentId, role: relations.allowedRoles.includes('master') ? 'master' : 'peer' }
        : { op: 'disconnect', agentId: command.agentId }
      return relationsWriteResult(await writeRelationsIntentRecord(path, current?.revision ?? 0, change))
    } catch (error) {
      // A broken stored record is the store's own typed throw: refuse it here and leave
      // the durable bytes untouched instead of overwriting them.
      if (error instanceof RuntimeConfigError) return { ok: false, error: { code: error.code, message: error.message } }
      throw error
    }
  }
  return {
    readProjection: read,
    async command(command: ConsoleCommandV1): Promise<ConsoleCommandResultV1> {
      if (command.kind === 'connection.connect' || command.kind === 'connection.disconnect' || command.kind === 'network.membership.apply') {
        return await relationsCommand(command)
      }
      if (command.kind === 'permission.reply' || command.kind === 'session.cancel') {
        return await sessionCommand(command)
      }
      if (owner === undefined) {
        return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: `no owner is bound for ${command.kind}` } }
      }
      return await owner.command(command)
    },
    async sendSession(target, payload) {
      if (owner !== undefined) return await owner.sendSession(target, payload)
      // The dedicated Session body ingress. The body is carried verbatim; this daemon never
      // parses, strips, or inspects it, and it never becomes a control frame. It writes the
      // same record as the Session commands, so it goes through the same serialization.
      return await serializeSessionWrite(async () => await sessionWrite(target.agentId, target.sessionId, resolved => ({
        op: 'session.message',
        agentId: resolved.agentId,
        sessionId: resolved.sessionId,
        payload,
      })))
    },
  }
}

/**
 * The accepted control intent facts the Console group forwarder needs: this daemon's
 * declared peers (the only legal targets) and the home root the shared endpoint record path
 * resolves from.
 *
 * The frozen v4 `PeerIntent` carries no peer `dataDirectory`, so this daemon cannot derive a
 * peer's local group socket from its own facts. It instead reads the one durable endpoint
 * record the peer's agent daemon publishes (`config/local-group-endpoint-store.ts`), at the
 * same shared account-and-scope path both sides derive. No environment read and no second
 * config source.
 */
export interface ControlGroupForwardFacts {
  readonly peers: Readonly<Record<string, PeerIntent>>
  readonly home: string
  /** One local socket round trip; the socket client's own default applies when absent. */
  readonly timeoutMs?: number
}

/**
 * Message prefix the local group socket client owns for failures it raises *before* any group
 * owner answered (`runtime/local-message-socket.ts`). A `relay.error` reply carries the group
 * owner's own code and message and never this prefix, which is what lets the forwarder keep
 * the two facts apart instead of flattening an owner refusal into a transport failure.
 */
const LOCAL_MESSAGE_TRANSPORT_PREFIX = 'local group message '

/**
 * Classify one local socket failure.
 *
 * A transport failure means no group owner answered: a refused connection, a timeout and a
 * close before the reply are all the same fact for the Console, so each becomes the typed
 * `GROUP_ENDPOINT_UNREACHABLE`. A `relay.error` reply is the owner's answer, so its code
 * travels verbatim and the frame is never retried here.
 */
function groupForwardFailure(error: unknown): ConsoleGroupForwardOutcome {
  if (error instanceof LocalMessageSocketError) {
    if (!error.serviceError.message.startsWith(LOCAL_MESSAGE_TRANSPORT_PREFIX)) {
      return { outcome: 'owner-error', error: error.serviceError }
    }
    if (error.serviceError.code === 'UNAVAILABLE' || error.serviceError.code === 'RESULT_UNKNOWN') {
      // A timeout keeps its own `do not replay` message: the frame may have been applied.
      return { outcome: 'unreachable', error: { code: 'GROUP_ENDPOINT_UNREACHABLE', message: error.serviceError.message } }
    }
    // A malformed reply or a mismatched request id is an upstream protocol failure, not an
    // absent endpoint.
    return { outcome: 'unreachable', error: { code: 'UPSTREAM_ERROR', message: error.serviceError.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { outcome: 'unreachable', error: { code: 'UPSTREAM_ERROR', message } }
}

/**
 * The Console group forwarder: the control daemon's one hop to a declared peer's local group
 * socket.
 *
 * The Console is an operator entry, not a group member. Group truth, membership and authority
 * stay in the hub behind the agent daemon: this daemon only resolves the peer's published
 * endpoint, forwards the closed frame over the real local socket and reports what came back.
 * It never parses a business field, never keeps a group state, never joins a group and never
 * retries, so an unknown outcome stays unknown. A peer this daemon does not declare has no
 * resolvable record, and it is a bad Console input rather than a missing endpoint.
 */
export function createControlGroupForwarder(facts: ControlGroupForwardFacts): ConsoleGroupForwardPort {
  return {
    async forward({ agentId, request }): Promise<ConsoleGroupForwardOutcome> {
      const peer = Object.values(facts.peers).find(candidate => candidate.agentId === agentId)
      if (peer === undefined) {
        return { outcome: 'invalid-target', message: `agentId ${agentId} is not declared by this control daemon's accepted peers` }
      }
      const path = localGroupEndpointScopePath({ home: facts.home, accountId: peer.accountId, scopeId: peer.scopeId, agentId: peer.agentId })
      let record
      try {
        record = await readLocalGroupEndpointRecord(path)
      } catch (error) {
        // A broken stored endpoint is the store's own typed throw: the endpoint is unusable
        // and the durable bytes stay exactly as they were.
        if (error instanceof RuntimeConfigError) {
          return { outcome: 'unreachable', error: { code: 'GROUP_ENDPOINT_UNREACHABLE', message: `local group endpoint record is not usable: ${error.message}` } }
        }
        throw error
      }
      if (record === undefined) {
        return {
          outcome: 'not-configured',
          message: `agent ${agentId} has published no local group endpoint, so its group surface is not reachable from this control daemon`,
        }
      }
      try {
        const reply = await sendLocalMessageRequest({
          socketPath: record.groupEndpoint.socketPath,
          request,
          ...(facts.timeoutMs === undefined ? {} : { timeoutMs: facts.timeoutMs }),
        })
        return { outcome: 'reply', reply }
      } catch (error) {
        return groupForwardFailure(error)
      }
    },
  }
}

/** One bound real network read chain: the D05 status port, its projection owner and its stop path. */
export interface ControlNetworkStatusBinding {
  readonly port: TeamsStatusPort
  /**
   * The real Console projection owner. `read` is the D04 directory readback projected into
   * the frozen Console rows plus the D05 connection rows; `watch` streams a frame whenever
   * that real read changes. `watch` is absent only when the owner cannot stream.
   */
  readonly projection: ControlProjectionSource
  readonly stop: () => Promise<void>
}

/** The directory projection poll interval: one real D04 directory read per tick. */
const DIRECTORY_PROJECTION_INTERVAL_MS = 1_000

/** Maps the D04 registration failure vocabulary onto the closed control error vocabulary. */
function controlCodeForRegistration(error: RegistrationProcessError): ControlProcessErrorCode {
  switch (error.code) {
    case 'INVALID_CONFIG': return 'INVALID_CONFIG'
    case 'UNSUPPORTED_CONFIGURATION': return 'UNSUPPORTED_CONFIGURATION'
    case 'UNAUTHENTICATED': return 'CREDENTIAL_UNAVAILABLE'
    case 'NOT_FOUND': return 'INVALID_CONFIG'
  }
}

/**
 * The control daemon's real network read chain (A2.7).
 *
 * It composes only D05 owners: the live connection ledger, the durable connection history
 * over the runtime's own store, the D04 registration client and the membership projector.
 * The control daemon declares no Teams listener (A2.1), so the ledger stays empty and
 * `connections()` reports exactly the real membership of a daemon with no established
 * channel; nothing is fabricated. Real registration transitions are recorded through the
 * owner's own `membershipHistoryEvents`, so the durable `kind: 'connection'` history is a
 * record of observed transitions and never a source for online or execution state.
 *
 * The Console projection is the real D04 directory readback: every refresh reads the scoped
 * directory through the registration client and projects the admitted peers into frozen
 * Console agent rows. A config without `[discovery]` keeps the typed empty snapshot, so the
 * projection stays an honest absence instead of a fabricated row.
 */
/**
 * The Console row title for a pending engine permission callback.
 *
 * The agent daemon does not read the callback's own title out of the engine frame: the ACP
 * callback carries options, not a subject, and inventing one from the Session id would be a
 * guess. The Console shows this fixed label until a real subject is published.
 */
const PENDING_PERMISSION_TITLE = 'Permission request'

/**
 * The Sessions and pending permissions the Console projection reports, read from the
 * observation records the declared agent daemons publish.
 *
 * The agent daemon owns each record because it owns the Sessions and permission callbacks it
 * carries. This reader resolves one path per declared peer from the same account and scope
 * layout the writer used, and it adds no channel of its own. Three rules keep the projection
 * honest:
 *
 *  - A declared peer whose record does not exist or is empty contributes no rows, so the
 *    Console never invents a Session.
 *  - A peer the current directory readback reports as not online contributes nothing, so a
 *    directory that knows the daemon is down never keeps projecting its last observation.
 *    A peer the directory does not report at all is not treated as offline: a deployment
 *    with no registry has no liveness truth, and the agent daemon itself publishes the empty
 *    observation when it stops, which is the owner's own answer to the same question.
 *  - A record that names another agent is skipped rather than projected under this one, which
 *    keeps the `agentId` on every row the agent that really owns it.
 */
export async function readObservedSessionProjection(input: {
  readonly home: string
  readonly peers: readonly { readonly agentId: string; readonly accountId: string; readonly scopeId: string }[]
  /** The presence the directory readback reports, by agent. A missing agent has no report. */
  readonly presence: ReadonlyMap<string, string>
}): Promise<Pick<ConsoleProjectionV1, 'sessions' | 'notifications'>> {
  const sessions: { readonly agentId: string; readonly sessionId: string }[] = []
  const notifications: ConsoleProjectionV1['notifications'][number][] = []
  for (const peer of input.peers) {
    const reported = input.presence.get(peer.agentId)
    if (reported !== undefined && reported !== 'online') continue
    const path = sessionObservationScopePath({ home: input.home, accountId: peer.accountId, scopeId: peer.scopeId, agentId: peer.agentId })
    let record: Awaited<ReturnType<typeof readSessionObservationRecord>>
    try {
      record = await readSessionObservationRecord(path)
    } catch (error) {
      // The record's own owner reports its broken record; a projection read must still serve
      // the rest of the directory, so this peer's rows stay absent instead of guessed.
      console.error(`control Session observation read failed for ${peer.agentId}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (record === undefined) continue
    if (record.agentId !== peer.agentId) {
      console.error(`control Session observation at ${path} names agent ${record.agentId}, not ${peer.agentId}; its rows are not projected`)
      continue
    }
    for (const row of record.sessions) sessions.push({ agentId: peer.agentId, sessionId: row.sessionId })
    for (const row of record.permissions) {
      notifications.push({
        agentId: peer.agentId,
        notificationId: row.notificationId,
        sessionId: row.sessionId,
        kind: 'permission',
        state: 'pending',
        title: PENDING_PERMISSION_TITLE,
        permissionId: row.permissionId,
      })
    }
  }
  return { sessions, notifications }
}

export async function createControlNetworkStatus(intent: ControlDaemonIntent, env: NodeJS.ProcessEnv): Promise<ControlNetworkStatusBinding> {
  const localAgentId = intent.daemon.id
  let history: ReturnType<typeof createTeamsConnectionHistory>
  try {
    history = createTeamsConnectionHistory(await createAcpHistoryStore({ directory: intent.daemon.dataDirectory }))
  } catch (cause) {
    throw new ControlProcessError('HISTORY_UNAVAILABLE',
      `control connection history store could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
  }
  const ledger = createTeamsConnectionLedger()
  // The honest unconfirmed local state until the first real directory readback replaces it.
  let directory: AccountDirectorySnapshot = { accountId: intent.daemon.accountId, scopeId: intent.daemon.scopeId, generation: 0, hosts: [], peerStates: [] }
  let peers: readonly RelayPeer[] = []
  let registration: AgentRegistration | undefined
  let previous: TeamsMembershipView | undefined
  const currentRegistration = (): RegistrationStatus => registration === undefined
    ? { state: 'disabled', attempts: 0, reconnects: 0 }
    : registration.state === 'enabled' ? registration.client.status() : registration.status
  const refreshDirectory = async (): Promise<void> => {
    if (registration === undefined || registration.state !== 'enabled') return
    if (registration.client.status().state !== 'online') return
    let snapshot: RelayDirectorySnapshot
    try {
      snapshot = await registration.client.directorySnapshot(true)
    } catch (error) {
      // The registration status already carries the degraded registry; a failed read keeps the
      // last real readback instead of turning the projection read into a failure.
      console.error(`control directory read failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (snapshot.revision < 1) return
    // The local daemon's own registration is not a remote peer row, the same convention
    // `runtime/console-runtime.ts` applies to its discovered peers. Dropping it here keeps
    // the agent rows and the connection rows one consistent remote-only projection.
    const remotes = snapshot.peers.filter(peer => peer.declaration.identity.agentId !== localAgentId)
    try {
      directory = refreshRelayDirectory(directory, snapshot.revision, remotes)
      peers = remotes
    } catch (error) {
      // A concurrent refresh can observe an older revision; the monotonic owner refuses it.
      console.error(`control directory projection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const observe = async (status?: RegistrationStatus): Promise<void> => {
    if (registration === undefined) return
    const observed = status ?? currentRegistration()
    await refreshDirectory()
    const view = projectTeamsMembership({ localAgentId, directory, registration: observed, channels: ledger.list(), observedAt: new Date().toISOString() })
    for (const event of membershipHistoryEvents(previous, view)) await history.record(event)
    previous = view
  }
  try {
    registration = await startDaemonRegistration(intent, {
      env,
      // A registration transition is the one real membership event this daemon observes.
      // A failed history write is diagnostic only: it must never break registration.
      onStatus: status => {
        void observe(status).catch((error: unknown) => {
          console.error(`control connection history write failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      },
    })
  } catch (cause) {
    if (cause instanceof RegistrationProcessError) throw new ControlProcessError(controlCodeForRegistration(cause), cause.message, cause)
    throw cause
  }
  // Seed the previous view so the next real registration transition is recorded once.
  await observe()
  // One live D05 port per read: the directory readback stays current without copying the
  // owner's membership projection into this runtime.
  const port = (): TeamsStatusPort => createTeamsStatusPort({ ledger, localAgentId, directory, registration: currentRegistration(), history })
  const readProjection = async (): Promise<ConsoleProjectionV1> => {
    await refreshDirectory()
    const agents: readonly ConsoleAgentObservationV1[] = peers.map(directoryAgentObservation)
    const observed = await readObservedSessionProjection({
      home: homedir(),
      peers: Object.values(intent.peers),
      presence: new Map(peers.map(peer => [peer.declaration.identity.agentId, peer.presence])),
    })
    return projectionWithConnections({ version: 1, agents, sessions: observed.sessions, notifications: observed.notifications, configs: [] }, port())
  }
  return {
    port: { connections: () => port().connections(), history: query => port().history(query) },
    projection: { read: readProjection, watch: createPollingProjectionSubscriber(readProjection, DIRECTORY_PROJECTION_INTERVAL_MS) },
    stop: async () => {
      if (registration !== undefined && registration.state === 'enabled') await registration.client.stop().catch(() => undefined)
    },
  }
}

/** Polling owner feed. It emits a full snapshot only when the owner projection changes. */
export function createPollingProjectionSubscriber(read: () => Promise<ConsoleProjectionV1>, intervalMs = 250): ConsoleProjectionSubscriber {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new ControlProcessError('INVALID_CONFIG', 'projection poll interval is invalid')
  return sink => {
    let seq = 0
    let last: string | undefined
    let stopped = false
    let running = false
    const tick = async () => {
      if (stopped || running) return
      running = true
      try {
        const projection = await read()
        // Sampling time is not a business change. Keep it in delivered snapshots;
        // omit only this field from comparison, leaving all other facts intact.
        const encoded = JSON.stringify({
          ...projection,
          ...(projection.connections === undefined ? {} : {
            connections: projection.connections.map(({ status, ...connection }) => {
              const { observedAt: _observedAt, ...facts } = status
              return { ...connection, status: facts }
            }),
          }),
        })
        if (encoded !== last) {
          last = encoded
          seq += 1
          sink.onSnapshot({ seq, projection })
        }
      } catch (error) {
        if (!stopped) {
          stopped = true
          sink.onHealth({ state: 'lost', reason: 'stream-ended', detail: error instanceof Error ? error.message : 'owner projection read failed' })
        }
      } finally {
        running = false
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, intervalMs)
    timer.unref?.()
    return () => { stopped = true; clearInterval(timer) }
  }
}

interface ControlProjectionFixture {
  readonly snapshots: readonly { readonly delayMs: number; readonly seq: number; readonly projection: ConsoleProjectionV1 }[]
  readonly closeAfter?: { readonly delayMs: number; readonly reason: 'stream-ended' | 'retry-exhausted'; readonly detail: string }
}

/**
 * Deterministic projection feed for the black-box entry. It is reachable only through an
 * explicit environment variable and never participates in a normal daemon start.
 */
export function createFixtureProjectionSubscriber(fixture: ControlProjectionFixture): ConsoleProjectionSubscriber {
  return sink => {
    const timers: NodeJS.Timeout[] = []
    let closed = false
    for (const snapshot of fixture.snapshots) {
      timers.push(setTimeout(() => {
        if (closed) return
        const validated = parseConsoleProjectionSnapshot({ seq: snapshot.seq, projection: snapshot.projection })
        sink.onSnapshot(validated)
      }, snapshot.delayMs))
    }
    if (fixture.closeAfter !== undefined) {
      timers.push(setTimeout(() => {
        if (closed) return
        closed = true
        sink.onHealth({ state: 'lost', reason: fixture.closeAfter!.reason, detail: fixture.closeAfter!.detail })
      }, fixture.closeAfter.delayMs))
    }
    for (const timer of timers) timer.unref?.()
    return () => { closed = true; for (const timer of timers) clearTimeout(timer) }
  }
}

async function readProjectionFixture(path: string): Promise<ControlProjectionFixture> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (cause) {
    throw new ControlProcessError('INVALID_CONFIG', `control projection fixture could not be read: ${path}`, cause)
  }
  const fixture = value as ControlProjectionFixture
  if (fixture === null || typeof fixture !== 'object' || !Array.isArray(fixture.snapshots)) {
    throw new ControlProcessError('INVALID_CONFIG', `control projection fixture is malformed: ${path}`)
  }
  for (const snapshot of fixture.snapshots) {
    if (!Number.isSafeInteger(snapshot.delayMs) || snapshot.delayMs < 0) {
      throw new ControlProcessError('INVALID_CONFIG', `control projection fixture delay is invalid: ${path}`)
    }
    parseConsoleProjectionSnapshot({ seq: snapshot.seq, projection: snapshot.projection })
  }
  return fixture
}

/* ---------------------------------------------------------------------------------------
 * Child entry.
 * ------------------------------------------------------------------------------------- */

/**
 * Resolves the frozen presentation roots that ship beside the runtime entry. The entry
 * lives at `<root>/runtime/` from source and at `<root>/generated/runtime-lib/runtime/`
 * after `build:runtime`, so the owning package root is found by its real static entry.
 * The UI package serves `/ui/browser.js`, which is `ui/teams-console/lib/browser.js` from
 * source and `ui/teams-console/browser.js` in the staged package.
 */
function presentationRoots(entryPath: string): { readonly staticRoot: string; readonly uiRoot: string } {
  let candidate = dirname(entryPath)
  for (let depth = 0; depth < 6; depth += 1) {
    const staticRoot = join(candidate, 'console-host', 'static')
    const uiBase = join(candidate, 'ui', 'teams-console')
    const uiRoot = existsSync(join(uiBase, 'browser.js')) ? uiBase
      : existsSync(join(uiBase, 'lib', 'browser.js')) ? join(uiBase, 'lib') : undefined
    if (uiRoot !== undefined && existsSync(join(staticRoot, 'console.html'))) return { staticRoot, uiRoot }
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  throw new ControlProcessError('INVALID_CONFIG',
    `console-host static assets and the compiled UI are missing beside the control entry: ${entryPath}; run pnpm build first`)
}

async function loadCredentials(intent: ControlDaemonIntent, env: NodeJS.ProcessEnv): Promise<{ readonly username: string; readonly password: string; readonly origin: string }> {
  const auth = intent.webui.auth
  if (auth === undefined) {
    throw new ControlProcessError('CREDENTIAL_UNAVAILABLE', 'control webui requires webui.auth before it can bind a listener')
  }
  const password = env[auth.passwordEnv]
  if (password === undefined || password.length === 0) {
    throw new ControlProcessError('CREDENTIAL_UNAVAILABLE', `webui.auth.passwordEnv ${auth.passwordEnv} is not set in the operator environment`)
  }
  const host = intent.webui.ip.includes(':') ? `[${intent.webui.ip}]` : intent.webui.ip
  const origin = intent.webui.allowedOrigin ?? `http://${host}:${intent.webui.port}`
  return { username: auth.username, password, origin }
}

/**
 * Detached child entry. It publishes its own readiness into the one state file after the
 * WebUI listener is bound, so `control status` never reports a fabricated `running` state.
 */
export async function runControlProcess(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = parseControlArgs(argv)
  const intent = await loadControlIntent(args.configPath)
  const effective = readControlEffectiveConfig(intent)
  const statePath = controlStatePath(intent)
  const previous = await readControlState(statePath)
  const base = {
    version: STATE_VERSION,
    configPath: resolve(args.configPath),
    entryPath: fileURLToPath(import.meta.url),
    daemonId: intent.daemon.id,
    startToken: args.startToken ?? previous?.startToken ?? randomUUID(),
    generation: previous?.generation ?? 1,
  } as const
  const { staticRoot, uiRoot } = presentationRoots(base.entryPath)
  let server: ReturnType<typeof createConsoleServer> | undefined
  let network: ControlNetworkStatusBinding | undefined
  try {
    const { username, password, origin } = await loadCredentials(intent, env)
    // The one injection point for the real network status port (D05 owner) and its real
    // projection owner (the D04 directory readback). The daemon binds both from its own real
    // network facts; `createControlOwner` and `createControlHistoryReader` keep the
    // structurally unbound path as a typed absence.
    network = await createControlNetworkStatus(intent, env)
    // The one desired-relations writer reads the same accepted intent this daemon loaded:
    // its declared peers and its accepted role set. The record path resolves from the home
    // root, through the shared convention the agent daemon uses for its own data directory,
    // because the frozen v4 `PeerIntent` carries no peer `dataDirectory` and no config key
    // may be added. No environment read and no second config source.
    const client = createControlOwner({
      network: network.port,
      source: network.projection,
      relations: {
        peers: intent.peers,
        allowedRoles: intent.relations.allowed,
        home: homedir(),
      },
    })
    const authorize = createConsoleAuthorization({ username, password, origin, client })
    const history = createControlHistoryReader(network.port)
    // The Console group surface rides the real local group socket each declared peer
    // publishes. This daemon reads the peer's endpoint record per request — never a cached
    // or guessed path — and forwards the closed frame verbatim, so group truth never leaves
    // its hub and the Console never becomes an Agent-to-Agent relay.
    const group = createControlGroupForwarder({ peers: intent.peers, home: homedir() })
    const projectionRead = async () => await client.readProjection()
    const fixturePath = env.AGENTTEAMS_CONTROL_PROJECTION_FIXTURE
    // The real owner feed: the directory projection source streams a frame whenever the
    // readback changes. A source that cannot stream falls back to the same read on a poll.
    const events: ConsoleProjectionSubscriber = fixturePath === undefined
      ? network.projection.watch ?? createPollingProjectionSubscriber(projectionRead)
      : createFixtureProjectionSubscriber(await readProjectionFixture(fixturePath))
    server = createConsoleServer({
      staticRoot,
      uiRoot,
      authorize,
      history,
      events,
      group,
      authenticationChallenge: AUTHENTICATION_CHALLENGE,
      ...(intent.webui.tlsCertRef === undefined || intent.webui.tlsKeyRef === undefined ? {} : {
        tls: { cert: await readFile(intent.webui.tlsCertRef), key: await readFile(intent.webui.tlsKeyRef) },
      }),
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => { server?.off('listening', onListening); rejectListen(error) }
      const onListening = () => { server?.off('error', onError); resolveListen() }
      server!.once('error', onError)
      server!.once('listening', onListening)
      server!.listen(effective.listener.port, effective.listener.ip)
    })
  } catch (error) {
    // The typed code travels in `errorCode`; `error` stays the plain message so a caller
    // that prefixes the code never prints it twice.
    const errorCode = error instanceof ControlProcessError ? error.code
      : (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'PORT_OCCUPIED' as const : undefined
    const failure = error instanceof ControlProcessError
      ? error.message
      : errorCode === 'PORT_OCCUPIED'
        ? `control webui port ${effective.listener.port} is already in use`
        : error instanceof Error ? error.message : String(error)
    await writeControlState(statePath, { ...base, pid: process.pid, state: 'failed',
      ...(errorCode === undefined ? {} : { errorCode }), error: failure, updatedAt: new Date().toISOString() })
    // A failed start releases the registration client it opened; it never leaves a socket.
    await network?.stop().catch(() => undefined)
    throw error
  }
  const scheme = intent.webui.tlsCertRef === undefined ? 'http' : 'https'
  const host = effective.listener.ip.includes(':') ? `[${effective.listener.ip}]` : effective.listener.ip
  const url = `${scheme}://${host}:${effective.listener.port}`
  await writeControlState(statePath, { ...base, pid: process.pid, state: 'running', url, updatedAt: new Date().toISOString() })
  console.log(`control listening ${url} config=${base.configPath} pid=${process.pid}`)
  let stopping: Promise<void> | undefined
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return
    stopping = new Promise<void>(resolveClose => {
      server.close(() => resolveClose())
      // `server.close()` only stops accepting new work and then waits for the sockets that
      // are already open. A WebUI keep-alive or event-stream client would hold the daemon
      // past the caller's bounded stop wait, so a correct shutdown reports STOP_TIMEOUT and
      // looks like a failure. Closing the listener's own connections is what the stop
      // actually means: the stream ends, the UI degrades to a lost owner, and the pid exits.
      server.closeIdleConnections()
      server.closeAllConnections()
    })
      .then(async () => {
        // Order: the WebUI listener first, then the owned registration client, then the
        // durable state record. The control daemon never stops a registry or an engine.
        await network?.stop()
        await writeControlState(statePath, { ...base, pid: process.pid, state: 'stopped', url, updatedAt: new Date().toISOString() })
      })
      .catch((error: unknown) => {
        process.exitCode = 1
        console.error(`control shutdown failed after ${signal}: ${error instanceof Error ? error.message : String(error)}`)
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
  void runControlProcess().catch(error => {
    const code = error instanceof ControlProcessError ? error.code : 'UNAVAILABLE'
    console.error('control process failed:', code, error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
