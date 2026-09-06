import { createConsoleServer } from '../console-host/src/server.ts'
import { createConsoleAuthorization } from '../console-host/src/auth.ts'
import { startAgentDaemon, type AgentDaemonOptions } from './agent-daemon.ts'
import { createConsoleHub } from './console-hub.ts'
import { createRelayConsoleClient } from './relay-console-client.ts'

export interface ConsoleRuntimeOptions {
  readonly daemon: AgentDaemonOptions
  readonly agentIds: readonly string[]
  readonly host: string
  readonly port: number
  readonly origin: string
  readonly username: string
  readonly password: string
  readonly staticRoot: string
  readonly uiRoot: string
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer }
}

/** Console owns its listener and registration only; Agent execution lives elsewhere. */
export async function startConsoleRuntime(options: ConsoleRuntimeOptions) {
  const { host, port, origin, username, password, staticRoot, uiRoot } = options
  const agentIds = [...options.agentIds]
  if (!host || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Console listen address')
  if (agentIds.some(id => typeof id !== 'string' || !id) || new Set(agentIds).size !== agentIds.length) throw new Error('Console Agent IDs must be unique')
  if (!options.tls && !['127.0.0.1', '::1'].includes(host)) throw new Error('Non-loopback Console requires TLS')
  if (new URL(origin).protocol !== (options.tls ? 'https:' : 'http:')) throw new Error('Console origin must match its TLS mode')
  const daemon = await startAgentDaemon(options.daemon)
  let server: ReturnType<typeof createConsoleServer> | undefined
  try {
    const client = createConsoleHub(agentIds.map(agentId => ({ agentId, client: createRelayConsoleClient(daemon.network, agentId, options.daemon.relay.requestTimeoutMs) })))
    server = createConsoleServer({ staticRoot, uiRoot, tls: options.tls,
      authenticationChallenge: 'Basic realm="AgentTeams", charset="UTF-8"',
      authorize: createConsoleAuthorization({ username, password, origin, client }) })
    const listener = server
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { listener.off('listening', ready); reject(error) }
      const ready = () => { listener.off('error', failed); resolve() }
      listener.once('error', failed); listener.once('listening', ready)
      listener.listen({ host, port, exclusive: true })
    })
    let stopping: Promise<void> | undefined
    let failure: Error | undefined
    const stop = (): Promise<void> => {
      if (stopping) return stopping
      stopping = (async () => {
        const stopped = new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        // Close existing browser connections; no disconnected command is replayed or marked complete.
        listener.closeAllConnections()
        await Promise.all([stopped, daemon.stop()])
      })()
      return stopping
    }
    listener.on('error', error => { failure = error; void stop().catch(() => undefined) })
    const closed = daemon.closed.then(async state => {
      await stop()
      if (failure) throw failure
      if (state.state === 'failed') throw state.error ?? new Error('Console relay failed')
    })
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Console listen address unavailable')
    const url = `${options.tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${address.port}`
    return { url, stop, closed }
  } catch (error) {
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server!.close(() => resolve()))
    }
    await daemon.stop()
    throw error
  }
}
