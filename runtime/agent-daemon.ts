import { createRelayClient, type RelayClient, type RelayClientOptions } from '../network/relay-client.ts'
import { RelayProtocolError } from '../control-protocol/relay-admission.ts'

export interface AgentDaemonOptions {
  readonly relay: RelayClientOptions
  readonly presenceIntervalMs: number
  readonly signal?: AbortSignal
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
  const status = (): AgentDaemonStatus => ({ state, agentId, generation: network.generation, ...(error ? { error } : {}) })
  const presence = setInterval(() => {
    if (state !== 'online' || presencePending) return
    presencePending = true
    void network.presence().catch(async cause => {
      if (state !== 'online') return
      error = cause instanceof Error ? cause : new Error('daemon: presence write failed')
      state = 'failed'
      await network.close()
    }).finally(() => { presencePending = false })
  }, presenceIntervalMs)
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    if (state === 'online') state = 'stopping'
    clearInterval(presence)
    signal?.removeEventListener('abort', abort)
    stopping = network.close().then(() => { if (state !== 'failed') state = 'stopped' })
    return stopping
  }
  const abort = () => { void stop() }
  signal?.addEventListener('abort', abort, { once: true })
  const closed = network.closed.then(reason => {
    clearInterval(presence)
    signal?.removeEventListener('abort', abort)
    if (state === 'online') { state = 'failed'; error = reason }
    if (state === 'stopping') state = 'stopped'
    return status()
  })
  if (signal?.aborted) await stop()
  return { network, closed, status, stop }
}
