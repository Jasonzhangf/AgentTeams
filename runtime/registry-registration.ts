import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseDaemonConfigText,
  resolveDaemonIntent,
  type AgentDaemonIntent,
  type ControlDaemonIntent,
  type DaemonIntentV4,
  type DiscoveryServerConfig,
} from '../config/daemon-intent.ts'
import type { AgentDeclaration, CapabilityDeclaration } from '../control-protocol/agent-services.ts'
import type { RouteCandidate } from '../server/directory.ts'
import { RelayProtocolError } from '../control-protocol/relay-admission.ts'
import {
  createRegistrationClient,
  type RegistrationClient,
  type RegistrationReconnectPolicy,
  type RegistrationStatus,
} from '../network/registration-client.ts'

/**
 * Runtime single writer that selects the registration endpoint from one v4
 * daemon config and composes the network registration client.
 *
 * Config selection is explicit: a config without `[discovery]` reports
 * `discovery-not-configured` and opens no socket. The client never switches to
 * another server, and a registry outage only changes the registration status;
 * it never stops the engine that hosts the daemon.
 */
export interface RegistrationDisabledPlan {
  readonly state: 'disabled'
  readonly reason: 'discovery-not-configured'
}

export interface RegistrationEnabledPlan {
  readonly state: 'enabled'
  readonly discovery: DiscoveryServerConfig
  readonly heartbeatIntervalMs: number
  readonly reconnect: RegistrationReconnectPolicy
}

export type RegistrationPlan = RegistrationDisabledPlan | RegistrationEnabledPlan

/**
 * Client-owned operational defaults. The frozen v4 schema has no heartbeat or
 * backoff field, so the client owns these values; they are not a second config
 * source. The heartbeat stays well inside the server-owned 90s presence lease.
 */
export const DEFAULT_REGISTRATION_HEARTBEAT_INTERVAL_MS = 15_000
export const DEFAULT_REGISTRATION_RECONNECT: RegistrationReconnectPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 5,
}

export type RegistrationProcessErrorCode = 'INVALID_CONFIG' | 'UNAUTHENTICATED' | 'UNSUPPORTED_CONFIGURATION' | 'NOT_FOUND'

export class RegistrationProcessError extends Error {
  constructor(readonly code: RegistrationProcessErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RegistrationProcessError'
  }
}

// `DaemonIdentity.kind` is a generic instantiation, so TypeScript cannot narrow
// the v4 union through `intent.daemon.kind`; these predicates keep the narrowing
// explicit instead of casting.
function isAgentIntent(intent: DaemonIntentV4): intent is AgentDaemonIntent {
  return intent.daemon.kind === 'agent'
}

function isControlIntent(intent: DaemonIntentV4): intent is ControlDaemonIntent {
  return intent.daemon.kind === 'control'
}

function registrableIntent(intent: DaemonIntentV4): AgentDaemonIntent | ControlDaemonIntent {
  if (isAgentIntent(intent)) return intent
  if (isControlIntent(intent)) return intent
  throw new RegistrationProcessError('UNSUPPORTED_CONFIGURATION', 'a registry daemon does not register with a discovery server')
}

/** Pure selection: the config either declares one discovery server or disables discovery. */
export function resolveRegistrationPlan(intent: DaemonIntentV4): RegistrationPlan {
  const registrable = registrableIntent(intent)
  if (registrable.discovery === undefined) {
    return { state: 'disabled', reason: 'discovery-not-configured' }
  }
  return {
    state: 'enabled',
    discovery: registrable.discovery,
    heartbeatIntervalMs: DEFAULT_REGISTRATION_HEARTBEAT_INTERVAL_MS,
    reconnect: DEFAULT_REGISTRATION_RECONNECT,
  }
}

export interface RegistrationBootstrap {
  readonly credential: string
  readonly ca: Buffer
}

export interface RegistrationBootstrapOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly readFile?: (path: string) => Promise<string>
}

function absoluteFileRef(ref: string, label: string): string {
  if (!ref.startsWith('file:')) throw new RegistrationProcessError('INVALID_CONFIG', `${label} must be a file: reference`)
  const path = ref.slice('file:'.length)
  if (!isAbsolute(path)) throw new RegistrationProcessError('INVALID_CONFIG', `${label} must be an absolute path after resolveDaemonIntent`)
  return path
}

/**
 * Reads the discovery credential and the TLS trust anchor exactly once. The
 * credential value never enters a declaration, a directory entry or a log line.
 */
export async function loadRegistrationBootstrap(
  discovery: DiscoveryServerConfig,
  options: RegistrationBootstrapOptions = {},
): Promise<RegistrationBootstrap> {
  const readText = options.readFile ?? (async (path: string) => await readFile(path, 'utf8'))
  let raw: string
  if (discovery.credentialRef.startsWith('env:')) {
    const name = discovery.credentialRef.slice('env:'.length)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new RegistrationProcessError('INVALID_CONFIG', `discovery.credentialRef ${discovery.credentialRef} is not a valid environment-variable name`)
    }
    const value = (options.env ?? process.env)[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new RegistrationProcessError('UNAUTHENTICATED', `discovery credential environment ${name} is missing or empty`)
    }
    raw = value
  } else {
    const path = absoluteFileRef(discovery.credentialRef, 'discovery.credentialRef')
    raw = await readText(path).catch(cause => {
      throw new RegistrationProcessError('NOT_FOUND', `discovery credential file could not be read: ${path}`, cause)
    })
  }
  const credential = raw.replace(/\r?\n$/, '')
  if (credential.length === 0 || /[\r\n]/.test(credential)) {
    throw new RegistrationProcessError('UNAUTHENTICATED', 'discovery credential is empty or contains a line break')
  }
  const trustPath = absoluteFileRef(discovery.tlsTrustRef, 'discovery.tlsTrustRef')
  const ca = await readFile(trustPath).catch(cause => {
    throw new RegistrationProcessError('NOT_FOUND', `discovery TLS trust anchor could not be read: ${trustPath}`, cause)
  })
  return { credential, ca }
}

/**
 * Publishes the declared daemon identity. The frozen v4 schema has no separate
 * machineId, agentKind or label, so the declared `hostId` is the machine
 * identity and `id` is the label. `agentKind` reports what this daemon actually
 * serves: a v4 agent daemon with a declared engine carries the ACP increment and
 * declares `acp`; a daemon without an engine, and a control daemon, declare
 * `custom`. Nothing is guessed about authority: capabilities and routes start
 * empty and are published by the owning daemon.
 */
export function declarationForDaemon(intent: DaemonIntentV4): AgentDeclaration {
  const registrable = registrableIntent(intent)
  const daemon = registrable.daemon
  const servesAcp = isAgentIntent(registrable) && registrable.engine !== undefined
  return {
    identity: {
      hostId: daemon.hostId,
      machineId: daemon.hostId,
      agentId: daemon.id,
      accountId: daemon.accountId,
      agentKind: servesAcp ? 'acp' : 'custom',
      label: daemon.id,
    },
    scopeId: daemon.scopeId,
    revision: 1,
    capabilities: [],
    routes: [],
  }
}

export type AgentRegistration =
  | { readonly state: 'disabled'; readonly reason: 'discovery-not-configured'; readonly status: RegistrationStatus }
  | { readonly state: 'enabled'; readonly client: RegistrationClient; readonly status: RegistrationStatus }

export interface PublishedDaemonSurfaces {
  readonly capabilities: readonly CapabilityDeclaration[]
  readonly routes: readonly RouteCandidate[]
}

/**
 * R4: the daemon's real listener route, projected from the declared listener.
 * A daemon that declares no listener publishes no route. This is a projection of
 * the one declared listener, not a second endpoint or directory source.
 */
export function listenerRouteCandidates(intent: DaemonIntentV4, observedAt: string): readonly RouteCandidate[] {
  const registrable = registrableIntent(intent)
  // Only an agent daemon declares an ACP listener; a control daemon's WebUI
  // listener is not a peer route and is not published here.
  if (!isAgentIntent(registrable)) return []
  const listen = registrable.listen
  if (listen === undefined) return []
  return [{
    candidateId: `${registrable.daemon.id}-lan-${listen.port}`,
    kind: 'lan',
    endpoint: `wss://${listen.ip}:${listen.port}`,
    port: listen.port,
    authRequired: true,
    lastSeenAt: observedAt,
  }]
}

/**
 * R4: one additive publication of the daemon's real surfaces (listener route
 * plus ACP capability) over the existing D04 registration path. Identity, scope
 * and agentKind are preserved and the declaration revision advances by one, so
 * the directory observes a new `capabilitiesRevision`. It adds no second
 * registry, directory or publication path.
 */
export function declarationWithPublishedSurfaces(
  declaration: AgentDeclaration,
  surfaces: PublishedDaemonSurfaces,
): AgentDeclaration {
  return {
    ...declaration,
    revision: declaration.revision + 1,
    capabilities: [...surfaces.capabilities],
    routes: [...surfaces.routes],
  }
}

/**
 * Composes one config-selected registration for a consumer such as D05/D06. A
 * disabled plan reports `disabled` and opens no socket; a failed first attempt
 * returns the typed reconnecting status with the original error while retries
 * continue in the background.
 */
export async function startDaemonRegistration(
  intent: DaemonIntentV4,
  options: RegistrationBootstrapOptions & {
    readonly heartbeatIntervalMs?: number
    readonly reconnect?: RegistrationReconnectPolicy
    readonly onStatus?: (status: RegistrationStatus) => void
  } = {},
): Promise<AgentRegistration> {
  const plan = resolveRegistrationPlan(intent)
  if (plan.state === 'disabled') {
    return { state: 'disabled', reason: plan.reason, status: { state: 'disabled', attempts: 0, reconnects: 0 } }
  }
  const registrable = registrableIntent(intent)
  const bootstrap = await loadRegistrationBootstrap(plan.discovery, options)
  const client = createRegistrationClient({
    declaration: declarationForDaemon(registrable),
    endpoint: plan.discovery.endpoint,
    credential: bootstrap.credential,
    ca: bootstrap.ca,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? plan.heartbeatIntervalMs,
    admissionTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    maxPendingRequests: 16,
    maxDataConnections: 8,
    connectTimeoutMs: 5_000,
    maxMessageBytes: 262_144,
    maxBufferedBytes: 262_144,
    maxPendingFrames: 64,
    reconnect: options.reconnect ?? plan.reconnect,
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  })
  return { state: 'enabled', client, status: await client.start() }
}

export interface RegistrationProcessArgs {
  readonly configPath: string
  readonly statusFile?: string
  readonly query: boolean
  readonly heartbeatIntervalMs?: number
}

export function parseRegistrationProcessArgs(argv: readonly string[]): RegistrationProcessArgs {
  let configPath: string | undefined
  let statusFile: string | undefined
  let heartbeatIntervalMs: number | undefined
  let query = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equals = argument.indexOf('=')
    const name = equals > 0 ? argument.slice(0, equals) : argument
    const inline = equals > 0 ? argument.slice(equals + 1) : undefined
    const take = (flag: string): string => {
      if (inline !== undefined) {
        if (inline.length === 0) throw new RegistrationProcessError('INVALID_CONFIG', `${flag} requires a value`)
        return inline
      }
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new RegistrationProcessError('INVALID_CONFIG', `${flag} requires a value`)
      index += 1
      return value
    }
    if (name === '--config') configPath = take(argument)
    else if (name === '--status-file') statusFile = take(argument)
    else if (name === '--heartbeat-interval-ms') {
      const value = Number(take(argument))
      if (!Number.isSafeInteger(value) || value < 1) throw new RegistrationProcessError('INVALID_CONFIG', '--heartbeat-interval-ms must be a positive integer')
      heartbeatIntervalMs = value
    } else if (name === '--query') query = true
    else throw new RegistrationProcessError('INVALID_CONFIG', `unknown argument: ${argument}`)
  }
  if (configPath === undefined) {
    throw new RegistrationProcessError('INVALID_CONFIG', 'usage: registry-registration --config <file> [--status-file <path>] [--query] [--heartbeat-interval-ms <n>]')
  }
  return {
    configPath: resolve(configPath),
    ...(statusFile === undefined ? {} : { statusFile: resolve(statusFile) }),
    query,
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
  }
}

async function loadRegistrationIntent(configPath: string): Promise<DaemonIntentV4> {
  const absolute = resolve(configPath)
  let text: string
  try {
    text = await readFile(absolute, 'utf8')
  } catch (cause) {
    throw new RegistrationProcessError('INVALID_CONFIG', `registration config could not be read: ${absolute}`, cause)
  }
  let intent: DaemonIntentV4
  try {
    intent = parseDaemonConfigText(text)
  } catch (cause) {
    throw new RegistrationProcessError('INVALID_CONFIG', cause instanceof Error ? cause.message : String(cause), cause)
  }
  return resolveDaemonIntent(intent, { configDirectory: dirname(absolute) })
}

async function writeStatusFile(path: string, status: RegistrationStatus): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Process entry for one registration client. `--query` registers, reads the
 * scoped directory once and exits with the first attempt's outcome (no retry);
 * without it the client keeps its heartbeat until SIGTERM/SIGINT. A config
 * without `[discovery]` reports disabled and exits without a socket.
 */
export async function runRegistrationProcess(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseRegistrationProcessArgs(argv)
  const intent = await loadRegistrationIntent(args.configPath)
  const plan = resolveRegistrationPlan(intent)
  if (plan.state === 'disabled') {
    if (args.statusFile !== undefined) await writeStatusFile(args.statusFile, { state: 'disabled', attempts: 0, reconnects: 0 })
    console.log('discovery disabled: config declares no [discovery] server')
    return 0
  }
  const registrable = registrableIntent(intent)
  const bootstrap = await loadRegistrationBootstrap(plan.discovery, { env })
  const client = createRegistrationClient({
    declaration: declarationForDaemon(registrable),
    endpoint: plan.discovery.endpoint,
    credential: bootstrap.credential,
    ca: bootstrap.ca,
    heartbeatIntervalMs: args.heartbeatIntervalMs ?? plan.heartbeatIntervalMs,
    admissionTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    maxPendingRequests: 16,
    maxDataConnections: 8,
    connectTimeoutMs: 5_000,
    maxMessageBytes: 262_144,
    maxBufferedBytes: 262_144,
    maxPendingFrames: 64,
    // A one-shot query reports the first attempt; a long-running client keeps
    // the configured bounded reconnect policy.
    reconnect: args.query ? { ...plan.reconnect, maxAttempts: 1 } : plan.reconnect,
    ...(args.statusFile === undefined ? {} : {
      onStatus: (status: RegistrationStatus) => {
        void writeStatusFile(args.statusFile!, status).catch((error: unknown) => {
          console.error(`registration status file write failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      },
    }),
  })
  const first = await client.start()
  if (args.query) {
    try {
      const peers = first.state === 'online' ? await client.directory(false) : []
      console.log(JSON.stringify({ status: client.status(), peers }, null, 2))
      return first.state === 'online' ? 0 : 1
    } finally {
      await client.stop()
    }
  }
  console.log(`registration ${first.state} endpoint=${first.endpoint ?? 'none'}${first.lastError === undefined ? '' : ` error=${first.lastError.code}:${first.lastError.message}`}`)
  let stopping: Promise<void> | undefined
  const stop = () => { if (!stopping) stopping = client.stop() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // The client library never pins its host process, so a retry window with no
  // open socket would let this standalone entry exit silently. Hold one
  // referenced handle until the client reaches a terminal state.
  const keepAlive = setInterval(() => undefined, 60_000)
  try {
    await client.closed
  } finally {
    clearInterval(keepAlive)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await client.stop()
  }
  return client.status().state === 'failed' ? 1 : 0
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runRegistrationProcess().then(code => { process.exitCode = code }).catch(error => {
    const code = error instanceof RegistrationProcessError || error instanceof RelayProtocolError ? error.code : 'UNAVAILABLE'
    console.error('registration process failed:', code, error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
