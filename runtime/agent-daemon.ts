import { createRelayClient, type RelayClient, type RelayClientOptions } from '../network/relay-client.ts'
import { connectDirectWssTarget, type DirectWssTarget, type DirectWssTargetOptions } from '../network/direct-route.ts'
import { assembleDirectWssTargetOptions, type DirectPeerRouteInput } from '../network/peer-route.ts'
import { RelayProtocolError } from '../control-protocol/relay-admission.ts'

export type DirectPeerConnector = (options: DirectWssTargetOptions) => Promise<DirectWssTarget>

class PeerCleanupError extends Error {
  constructor(readonly cause: Error) {
    super(cause.message)
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('daemon: peer cleanup failed')
}

export interface AgentDaemonOptions {
  readonly relay: RelayClientOptions
  readonly presenceIntervalMs: number
  readonly signal?: AbortSignal
  readonly directPeerConnector?: DirectPeerConnector
}
export interface AgentDaemonStatus {
  readonly state: 'online' | 'stopping' | 'stopped' | 'failed'
  readonly agentId: string
  readonly generation: number
  readonly error?: Error
}
export interface AgentDaemon {
  /** Network control resource for Agent Host composition, never business payload. */
  readonly network: RelayClient
  readonly closed: Promise<AgentDaemonStatus>
  status(): AgentDaemonStatus
  connectPeer(options: DirectWssTargetOptions): Promise<DirectWssTarget>
  connectPeerRoute(input: DirectPeerRouteInput): Promise<DirectWssTarget>
  stop(): Promise<void>
}

/** Owns one Agent's live registration. Executor readiness is a separate concern. */
export async function startAgentDaemon(options: AgentDaemonOptions): Promise<AgentDaemon> {
  const { presenceIntervalMs, signal } = options
  const agentId = options.relay.declaration.identity.agentId
  if (!Number.isSafeInteger(presenceIntervalMs) || presenceIntervalMs < 1 || presenceIntervalMs > 2_147_483_647) {
    throw new RelayProtocolError('INVALID_INPUT', 'daemon: invalid presence interval')
  }
  const cancelled = () => new RelayProtocolError('UNAVAILABLE', 'daemon: startup was cancelled')
  if (signal?.aborted) throw cancelled()
  const network = await createRelayClient(options.relay)
  try {
    if (signal?.aborted) throw cancelled()
    // The initial query proves the directory path after admission. Network owns the response.
    await network.directory(true)
    if (signal?.aborted) throw cancelled()
  } catch (error) {
    await network.close()
    throw error
  }
  let state: AgentDaemonStatus['state'] = 'online'
  let error: Error | undefined
  let stopping: Promise<void> | undefined
  let presencePending = false
  const directPeerConnector = options.directPeerConnector ?? connectDirectWssTarget
  const targets = new Set<DirectWssTarget>()
  const connecting = new Set<Promise<DirectWssTarget>>()
  const reconnecting = new WeakMap<DirectWssTarget, Promise<DirectWssTarget>>()
  const registeredSources = new WeakMap<DirectWssTarget, DirectWssTarget>()
  const status = (): AgentDaemonStatus => ({ state, agentId, generation: network.generation, ...(error ? { error } : {}) })
  const unavailable = () => new RelayProtocolError('UNAVAILABLE', 'daemon: peer connections are unavailable')
  const registerTarget = (target: DirectWssTarget): DirectWssTarget => {
    const existing = registeredSources.get(target)
    if (existing) return existing
    let registered!: DirectWssTarget
    registered = {
      ...target,
      get state() { return target.state },
      close: async reason => {
        await target.close(reason)
        targets.delete(registered)
        if (registeredSources.get(target) === registered) registeredSources.delete(target)
      },
      reconnect: () => {
        const inFlight = reconnecting.get(target)
        if (inFlight) return inFlight
        let shared!: Promise<DirectWssTarget>
        shared = connectTarget(() => target.reconnect(), target).finally(() => {
          if (reconnecting.get(target) === shared) reconnecting.delete(target)
        })
        reconnecting.set(target, shared)
        return shared
      },
    }
    registeredSources.set(target, registered)
    targets.add(registered)
    void target.closed.then(() => {
      if (registered.state.state === 'closed' || registered.state.state === 'failed') targets.delete(registered)
    })
    return registered
  }
  const connectTarget = async (factory: () => Promise<DirectWssTarget>, source?: DirectWssTarget): Promise<DirectWssTarget> => {
    if (source) {
      const existing = reconnecting.get(source)
      if (existing) return existing
    }
    if (state !== 'online') throw unavailable()
    const attempt = (async () => {
      const target = await factory()
      if (state !== 'online') {
        try { await target.close('daemon: peer connection cancelled during shutdown') } catch (cause) {
          throw new PeerCleanupError(asError(cause))
        }
        throw unavailable()
      }
      return registerTarget(target)
    })()
    connecting.add(attempt)
    try { return await attempt } finally { connecting.delete(attempt) }
  }
  const connectPeer = (peerOptions: DirectWssTargetOptions): Promise<DirectWssTarget> =>
    connectTarget(() => directPeerConnector(peerOptions))
  const connectPeerRoute = (input: DirectPeerRouteInput): Promise<DirectWssTarget> =>
    connectTarget(() => directPeerConnector(assembleDirectWssTargetOptions(input)))
  const closeTargets = async (reason: string): Promise<Error | undefined> => {
    let cleanupError: Error | undefined
    const record = (cause: unknown) => {
      if (!cleanupError) cleanupError = cause instanceof PeerCleanupError ? cause.cause : asError(cause)
    }
    await Promise.all([...connecting].map(attempt => attempt.then(target => {
      if (!targets.has(target)) return target.close(reason)
    }, cause => { if (cause instanceof PeerCleanupError) record(cause) }).catch(record)))
    await Promise.all([...targets].map(target => target.close(reason).catch(record)))
    return cleanupError
  }
  const presence = setInterval(() => {
    if (state !== 'online' || presencePending) return
    presencePending = true
    void network.presence().catch(async cause => {
      if (state !== 'online') return
      error = cause instanceof Error ? cause : new Error('daemon: presence write failed')
      state = 'failed'
      const cleanupError = await closeTargets(error.message)
      if (cleanupError) error = new Error(`${error.message}; direct peer cleanup failed: ${cleanupError.message}`)
      await network.close()
    }).finally(() => { presencePending = false })
  }, presenceIntervalMs)
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    if (state === 'online') state = 'stopping'
    clearInterval(presence)
    signal?.removeEventListener('abort', abort)
    stopping = (async () => {
      const cleanupError = await closeTargets('daemon: stopped')
      if (cleanupError) { state = 'failed'; error = cleanupError }
      await network.close()
      if (state !== 'failed') state = 'stopped'
    })()
    return stopping
  }
  const abort = () => { void stop() }
  signal?.addEventListener('abort', abort, { once: true })
  const closed = network.closed.then(async reason => {
    clearInterval(presence)
    signal?.removeEventListener('abort', abort)
    if (state === 'online') { state = 'failed'; error = reason }
    if (state === 'stopping') state = 'stopped'
    const cleanupError = await closeTargets(reason.message)
    if (cleanupError) {
      state = 'failed'
      error = error ? new Error(`${error.message}; direct peer cleanup failed: ${cleanupError.message}`) : cleanupError
    }
    return status()
  })
  if (signal?.aborted) await stop()
  return { network, closed, status, connectPeer, connectPeerRoute, stop }
}
