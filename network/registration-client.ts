import type { AgentDeclaration, RelayPeer, ServiceError } from '../control-protocol/agent-services.ts'
import { RelayProtocolError } from '../control-protocol/relay-admission.ts'
import { createRelayClient, type RelayClient, type RelayClientOptions, type RelayDirectorySnapshot } from './relay-client.ts'

/**
 * Network owns the registration client transport and its health. It consumes an
 * explicit WSS endpoint plus credential; the config-selected endpoint is chosen
 * by `runtime/registry-registration.ts`.
 *
 * Vocabulary: the relay boundary keeps `RelayPeer.presence` as `online|offline`.
 * This client reports its own health as `RegistrationClientState`; it never
 * renames peer presence and never adds a third presence value. The single
 * presence -> `HostHealthState` bridge stays in `network/account-directory.ts`.
 *
 * Policy: a disconnect or a failed heartbeat is a typed state plus an explicit
 * bounded reconnect with backoff on the same configured endpoint. The client
 * never switches servers and never throws out of a timer, so a registry outage
 * cannot terminate the engine that hosts it.
 */
/**
 * Client health vocabulary. `disabled` is produced only by the runtime config
 * selector (`runtime/registry-registration.ts`) when a config declares no
 * `[discovery]` server; this client itself never enters it.
 */
export type RegistrationClientState = 'disabled' | 'connecting' | 'online' | 'reconnecting' | 'failed' | 'stopped'

export interface RegistrationStatus {
  readonly state: RegistrationClientState
  /** The configured endpoint; absent only for the `disabled` plan. Never silently changed. */
  readonly endpoint?: string
  readonly generation?: number
  /** Consecutive failed attempts since the last successful connection. */
  readonly attempts: number
  /** Successful connections after the first one. */
  readonly reconnects: number
  /** Most recent failure, retained after recovery so the original error stays visible. */
  readonly lastError?: ServiceError
  readonly lastSeenAt?: string
  readonly nextAttemptAt?: string
}

export interface RegistrationReconnectPolicy {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  /** Connect attempts allowed per outage, including the first one. */
  readonly maxAttempts: number
}

export interface RegistrationClientOptions {
  readonly declaration: AgentDeclaration
  readonly endpoint: string
  readonly credential: string
  readonly ca?: string | Buffer
  readonly heartbeatIntervalMs: number
  readonly admissionTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly maxPendingRequests: number
  readonly maxDataConnections: number
  readonly connectTimeoutMs: number
  readonly maxMessageBytes: number
  readonly maxBufferedBytes: number
  readonly maxPendingFrames: number
  readonly reconnect: RegistrationReconnectPolicy
  readonly onStatus?: (status: RegistrationStatus) => void
  readonly now?: () => Date
}

export interface RegistrationClient {
  /** Resolves on a terminal state (`failed` or `stopped`); never rejects. */
  readonly closed: Promise<RegistrationStatus>
  status(): RegistrationStatus
  /** Runs the first attempt and returns the resulting status; retries continue in the background. */
  start(): Promise<RegistrationStatus>
  directory(subscribe: boolean): Promise<readonly RelayPeer[]>
  /**
   * The same real scoped directory read, carrying the server's directory revision.
   * The account-directory projection needs the revision to confirm a route
   * generation, so this is the one seam the D06 control daemon consumes.
   */
  directorySnapshot(subscribe: boolean): Promise<RelayDirectorySnapshot>
  /**
   * R4: publishes an advanced declaration (the daemon's real listener route plus
   * its accepted ACP capability) over the same registration connection. It
   * requires the online state, never switches servers, and refuses a declaration
   * that does not preserve identity/scope or advance the revision.
   */
  publish(declaration: AgentDeclaration): Promise<void>
  stop(): Promise<void>
}

function describeFailure(error: unknown): ServiceError {
  const code = error instanceof RelayProtocolError ? error.code : 'UNAVAILABLE'
  return { code, message: describeMessage(error) }
}

function describeMessage(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { readonly cause?: unknown }).cause
  if (cause === undefined || depth >= 4) return error.message
  return `${error.message}: ${describeMessage(cause, depth + 1)}`
}

function positiveInteger(value: number, label: string, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RelayProtocolError('INVALID_INPUT', `registration: ${label} must be a positive safe integer`)
  }
  return value
}

function validate(options: RegistrationClientOptions): void {
  if (typeof options.endpoint !== 'string' || !options.endpoint.startsWith('wss:')) {
    throw new RelayProtocolError('INVALID_INPUT', 'registration: endpoint must be a wss URL')
  }
  if (typeof options.credential !== 'string' || options.credential.length === 0 || /[\r\n]/.test(options.credential)) {
    throw new RelayProtocolError('INVALID_INPUT', 'registration: a valid credential is required')
  }
  positiveInteger(options.heartbeatIntervalMs, 'heartbeatIntervalMs')
  positiveInteger(options.admissionTimeoutMs, 'admissionTimeoutMs')
  positiveInteger(options.requestTimeoutMs, 'requestTimeoutMs')
  positiveInteger(options.maxPendingRequests, 'maxPendingRequests')
  positiveInteger(options.maxDataConnections, 'maxDataConnections')
  positiveInteger(options.connectTimeoutMs, 'connectTimeoutMs')
  positiveInteger(options.maxMessageBytes, 'maxMessageBytes')
  positiveInteger(options.maxBufferedBytes, 'maxBufferedBytes')
  positiveInteger(options.maxPendingFrames, 'maxPendingFrames')
  positiveInteger(options.reconnect.initialDelayMs, 'reconnect.initialDelayMs')
  positiveInteger(options.reconnect.maxDelayMs, 'reconnect.maxDelayMs')
  positiveInteger(options.reconnect.maxAttempts, 'reconnect.maxAttempts')
  if (options.reconnect.maxDelayMs < options.reconnect.initialDelayMs) {
    throw new RelayProtocolError('INVALID_INPUT', 'registration: reconnect.maxDelayMs must not be below reconnect.initialDelayMs')
  }
}

export function createRegistrationClient(options: RegistrationClientOptions): RegistrationClient {
  validate(options)
  const now = options.now ?? (() => new Date())
  const maxAttempts = options.reconnect.maxAttempts
  let state: RegistrationClientState = 'connecting'
  let relay: RelayClient | undefined
  let generation: number | undefined
  let attempts = 0
  let reconnects = 0
  let everConnected = false
  let lastError: ServiceError | undefined
  let lastSeenAt: string | undefined
  let nextAttemptAt: string | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let heartbeatPending = false
  let stopping = false
  let closedResolved = false
  let resolveClosed!: (status: RegistrationStatus) => void
  const closed = new Promise<RegistrationStatus>(resolve => { resolveClosed = resolve })

  const status = (): RegistrationStatus => ({
    state,
    endpoint: options.endpoint,
    ...(generation === undefined ? {} : { generation }),
    attempts,
    reconnects,
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
  })
  const publish = (): void => { options.onStatus?.(status()) }
  const clearHeartbeat = (): void => {
    if (heartbeat !== undefined) { clearInterval(heartbeat); heartbeat = undefined }
  }
  const clearRetry = (): void => {
    if (retry !== undefined) { clearTimeout(retry); retry = undefined }
  }
  const finish = (terminal: RegistrationClientState): void => {
    state = terminal
    nextAttemptAt = undefined
    clearHeartbeat()
    clearRetry()
    publish()
    if (!closedResolved) { closedResolved = true; resolveClosed(status()) }
  }

  const relayOptions = (): RelayClientOptions => ({
    declaration: options.declaration,
    transport: {
      endpoint: options.endpoint,
      credential: options.credential,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      connectTimeoutMs: options.connectTimeoutMs,
      maxMessageBytes: options.maxMessageBytes,
      maxBufferedBytes: options.maxBufferedBytes,
      maxPendingFrames: options.maxPendingFrames,
    },
    admissionTimeoutMs: options.admissionTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    maxPendingRequests: options.maxPendingRequests,
    maxDataConnections: options.maxDataConnections,
  })

  const scheduleRetry = (): void => {
    const delayMs = Math.min(options.reconnect.initialDelayMs * 2 ** (attempts - 1), options.reconnect.maxDelayMs)
    nextAttemptAt = new Date(now().getTime() + delayMs).toISOString()
    state = 'reconnecting'
    publish()
    retry = setTimeout(() => { retry = undefined; void connect() }, delayMs)
    ;(retry as NodeJS.Timeout).unref?.()
  }

  const recordFailure = (error: unknown): void => {
    if (stopping) return
    lastError = describeFailure(error)
    attempts += 1
    if (attempts >= maxAttempts) { finish('failed'); return }
    scheduleRetry()
  }

  const onDisconnect = (reason: Error): void => {
    if (stopping) return
    const client = relay
    relay = undefined
    clearHeartbeat()
    if (client !== undefined) void client.close().catch(() => undefined)
    recordFailure(reason)
  }

  const startHeartbeat = (client: RelayClient): void => {
    clearHeartbeat()
    heartbeat = setInterval(() => {
      if (stopping || state !== 'online' || relay !== client || heartbeatPending) return
      heartbeatPending = true
      void client.presence()
        .then(() => { lastSeenAt = now().toISOString(); publish() })
        .catch((cause: unknown) => onDisconnect(cause instanceof Error ? cause : new Error('registration: heartbeat failed')))
        .finally(() => { heartbeatPending = false })
    }, options.heartbeatIntervalMs)
    ;(heartbeat as NodeJS.Timeout).unref?.()
  }

  const connect = async (): Promise<void> => {
    if (stopping) return
    if (attempts === 0) { state = 'connecting'; publish() }
    let client: RelayClient
    try {
      client = await createRelayClient(relayOptions())
    } catch (error) {
      recordFailure(error)
      return
    }
    if (stopping) {
      await client.close().catch(() => undefined)
      return
    }
    try {
      // The initial scoped directory query proves the directory path after admission.
      await client.directory(true)
    } catch (error) {
      await client.close().catch(() => undefined)
      recordFailure(error)
      return
    }
    relay = client
    generation = client.generation
    if (everConnected) reconnects += 1
    everConnected = true
    attempts = 0
    nextAttemptAt = undefined
    lastSeenAt = now().toISOString()
    state = 'online'
    publish()
    startHeartbeat(client)
    void client.closed.then(reason => { if (relay === client) onDisconnect(reason) })
  }

  /** The one online-state guard: every directory/publish read needs the same live relay. */
  const onlineRelay = (): RelayClient => {
    const client = relay
    if (state !== 'online' || client === undefined) {
      throw new RelayProtocolError(lastError?.code ?? 'UNAVAILABLE', lastError?.message ?? 'registration: client is not online')
    }
    return client
  }

  return {
    closed,
    status,
    start: async () => { await connect(); return status() },
    directory: async subscribe => await onlineRelay().directory(subscribe),
    directorySnapshot: async subscribe => await onlineRelay().directorySnapshot(subscribe),
    publish: async declaration => { await onlineRelay().publish(declaration) },
    stop: async () => {
      if (stopping) { await closed; return }
      stopping = true
      clearHeartbeat()
      clearRetry()
      const client = relay
      relay = undefined
      if (client !== undefined) await client.close().catch(() => undefined)
      if (state !== 'failed') state = 'stopped'
      publish()
      if (!closedResolved) { closedResolved = true; resolveClosed(status()) }
    },
  }
}
