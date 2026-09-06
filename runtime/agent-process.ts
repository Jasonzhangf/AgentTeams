import { createServer, type Server } from 'node:net'
import { readFile, mkdir, open, link, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { object, text, number, loadRelayConfig } from './process-config.ts'
import { parseAgentDeclaration, RelayProtocolError } from '../control-protocol/relay-codec.ts'
import type { AgentDeclaration } from '../control-protocol/agent-services.ts'
import { createCliWorkExecutor } from '../agent-host/cli-executor.ts'
import { createWorkHost } from '../agent-host/work-host.ts'
import { createWorkIngress } from '../agent-host/work-ingress.ts'
import { createFileWorkStore, createTrustedWorkAuthority, createWorkLedger, recover } from '../agent/work-resource.ts'
import { createConsoleIngress } from '../agent-host/console-ingress.ts'
import { acceptAgentData } from './agent-data.ts'
import type { ConsoleClientV1 } from '../control-protocol/console-api.ts'
import type { RelayClientOptions } from '../network/relay-client.ts'
import { startAgentDaemon, type AgentDaemon } from './agent-daemon.ts'
import { createJsonFileConfigPersistence, createRuntimeConfigStore, RuntimeConfigError } from '../config/runtime-config.ts'
import { createOpenAIModelCatalogClient } from '../config/provider-model-client.ts'
import { createConsoleConfigBinding } from './console-config.ts'
import { createManagedConfigOwner } from './managed-config-owner.ts'

export interface AgentProcessConfig {
  readonly declaration: AgentDeclaration
  readonly dataDirectory: string
  readonly leasePort: number
  readonly relay: RelayClientOptions
  readonly presenceIntervalMs: number
  readonly policyRevision: number
  readonly allowedConsumers: readonly string[]
  readonly allowedManagers: readonly string[]
  readonly cli: { readonly camoExecutable: string; readonly searchExecutable: string; readonly searchRoot: string; readonly profilePrefix: string }
  readonly openCode?: { readonly executable: string; readonly directory: string; readonly configFile: string; readonly port: number; readonly startupTimeoutMs: number; readonly stopTimeoutMs: number }
}

export async function loadAgentProcessConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentProcessConfig> {
  const configPath = resolve(path)
  const input = object(JSON.parse(await readFile(configPath, 'utf8')),
    ['version', 'identity', 'scopeId', 'dataDirectory', 'leasePort', 'relay', 'presenceIntervalMs', 'policy', 'cli', 'openCode'], 'Agent config')
  if (input.version !== 1) throw new RelayProtocolError('UNSUPPORTED_VERSION', 'Agent config version must be 1')
  const location = (value: unknown, label: string) => resolve(dirname(configPath), text(value, label))
  const cli = object(input.cli, ['camoExecutable', 'searchExecutable', 'searchRoot', 'profilePrefix'], 'cli')
  const policy = object(input.policy, ['revision', 'allowedConsumers', 'allowedManagers'], 'policy')
  if (!Array.isArray(policy.allowedConsumers) || policy.allowedConsumers.some(item => typeof item !== 'string' || !item) ||
    new Set(policy.allowedConsumers).size !== policy.allowedConsumers.length) throw new RelayProtocolError('INVALID_INPUT', 'allowedConsumers must be unique Agent IDs')
  const allowedManagers = policy.allowedManagers === undefined ? [] : policy.allowedManagers
  if (!Array.isArray(allowedManagers) || allowedManagers.some(item => typeof item !== 'string' || !item) || new Set(allowedManagers).size !== allowedManagers.length) {
    throw new RelayProtocolError('INVALID_INPUT', 'allowedManagers must be unique Agent IDs')
  }
  const declaration = parseAgentDeclaration({ identity: input.identity, scopeId: input.scopeId, revision: 1, capabilities: [], routes: [] })
  let openCode: AgentProcessConfig['openCode']
  if (input.openCode !== undefined) {
    const value = object(input.openCode, ['executable', 'directory', 'configFile', 'port', 'startupTimeoutMs', 'stopTimeoutMs'], 'openCode')
    openCode = { executable: location(value.executable, 'openCode.executable'), directory: location(value.directory, 'openCode.directory'),
      configFile: location(value.configFile, 'openCode.configFile'), port: number(value.port, 'openCode.port', 65535),
      startupTimeoutMs: number(value.startupTimeoutMs, 'openCode.startupTimeoutMs'), stopTimeoutMs: number(value.stopTimeoutMs, 'openCode.stopTimeoutMs') }
  }
  return {
    declaration, dataDirectory: location(input.dataDirectory, 'dataDirectory'), leasePort: number(input.leasePort, 'leasePort', 65535),
    presenceIntervalMs: number(input.presenceIntervalMs, 'presenceIntervalMs'), policyRevision: number(policy.revision, 'policy.revision'),
    allowedConsumers: [...policy.allowedConsumers] as string[],
    allowedManagers: [...allowedManagers] as string[],
    cli: { camoExecutable: location(cli.camoExecutable, 'camoExecutable'), searchExecutable: location(cli.searchExecutable, 'searchExecutable'),
      searchRoot: location(cli.searchRoot, 'searchRoot'), profilePrefix: text(cli.profilePrefix, 'profilePrefix') },
    ...(openCode === undefined ? {} : { openCode }),
    relay: await loadRelayConfig(input.relay, declaration, configPath, env),
  }
}

async function closeLease(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
async function ownDataDirectory(config: AgentProcessConfig): Promise<Server> {
  const lease = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { lease.off('listening', ready); reject(error) }
    const ready = () => { lease.off('error', failed); resolve() }
    lease.once('error', failed); lease.once('listening', ready)
    lease.listen({ host: '127.0.0.1', port: config.leasePort, exclusive: true })
  })
  try {
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 })
    const { label: _label, ...stableIdentity } = config.declaration.identity
    const identity = JSON.stringify({ version: 1, identity: stableIdentity, scopeId: config.declaration.scopeId, leasePort: config.leasePort })
    const target = resolve(config.dataDirectory, 'identity.json')
    const temporary = resolve(config.dataDirectory, `.identity-${randomUUID()}`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(identity); await file.sync() } finally { await file.close() }
    try {
      try { await link(temporary, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if ((await readFile(target, 'utf8')) !== identity) throw new RelayProtocolError('CONFLICT', 'data directory belongs to another identity or lease port')
      const directory = await open(config.dataDirectory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { await unlink(temporary) }
    return lease
  } catch (error) { await closeLease(lease); throw error }
}

export interface AgentProcess {
  readonly daemon: AgentDaemon
  readonly closed: Promise<void>
  stop(): Promise<void>
}
export async function startAgentProcess(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentProcess> {
  const config = await loadAgentProcessConfig(configPath, env)
  const lease = await ownDataDirectory(config)
  let daemon: AgentDaemon | undefined
  let configBinding: { binding: ReturnType<typeof createConsoleConfigBinding>; owner: ReturnType<typeof createManagedConfigOwner> } | undefined
  let readyResolve!: () => void
  let readyReject!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  void ready.catch(() => undefined) // Startup failure is also returned to the caller.
  try {
    const executor = createCliWorkExecutor(config.cli)
    let host!: ReturnType<typeof createWorkHost>
    configBinding = config.openCode === undefined ? undefined : (() => {
      const store = createRuntimeConfigStore(createJsonFileConfigPersistence(config.openCode.configFile))
      const owner = createManagedConfigOwner({ agentId: config.declaration.identity.agentId, executable: config.openCode.executable,
        directory: config.openCode.directory, port: config.openCode.port, startupTimeoutMs: config.openCode.startupTimeoutMs,
        stopTimeoutMs: config.openCode.stopTimeoutMs, resolveCredential: async reference => {
          const value = env[reference]
          if (typeof value !== 'string' || value.length === 0) throw new RuntimeConfigError({ code: 'CREDENTIAL_UNAVAILABLE', message: `credential ${reference} is unavailable` })
          return value
        } })
      return { binding: createConsoleConfigBinding({ agentId: config.declaration.identity.agentId, store,
        models: createOpenAIModelCatalogClient(), applier: owner }), owner }
    })()
    const allowed = (consumer: { agentId: string }) => config.allowedConsumers.includes(consumer.agentId)
    const policy = { revision: config.policyRevision, authorizeWork: allowed, authorizeRequest: allowed }
    const consoleClient: ConsoleClientV1 = {
      readProjection: async () => ({ version: 1, agents: [{ agentId: config.declaration.identity.agentId,
        machineId: config.declaration.identity.machineId, label: config.declaration.identity.label,
        presence: daemon?.status().state === 'online' ? 'online' : 'offline', capabilities: executor.capabilities.map(item => item.capabilityId) }],
        sessions: [], notifications: [], configs: configBinding === undefined ? [] : [configBinding.binding.readProjection()] }),
      command: async command => command.kind.startsWith('config.') && configBinding !== undefined
        ? configBinding.binding.command(command as Extract<typeof command, { kind: `config.${string}` }>)
        : ({ ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: configBinding === undefined ? 'Agent has no Session or model configuration owner' : 'Agent has no Session execution capability' } }),
      sendSession: async () => ({ ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'Passive CLI Agent has no Session execution capability' } }),
    }
    daemon = await startAgentDaemon({ presenceIntervalMs: config.presenceIntervalMs, relay: { ...config.relay,
      declaration: config.declaration,
      onEvent: async event => {
        if (event.kind !== 'relay.offer') return
        await ready
        if (event.grant.targetAgentId !== config.declaration.identity.agentId) throw new RelayProtocolError('FORBIDDEN', 'offer is not directed to this provider')
        void (async () => {
          const socket = await daemon!.network.openData(event.grant)
          const peer = { accountId: event.grant.accountId, scopeId: event.grant.scopeId, agentId: event.grant.sourceAgentId }
          await acceptAgentData(socket, {
          work: { timeoutMs: config.relay.requestTimeoutMs, maxPending: config.relay.maxPendingRequests,
            maxIncoming: config.relay.maxPendingRequests, onRequest: createWorkIngress(host, peer) },
          console: createConsoleIngress({ agentId: config.declaration.identity.agentId, generation: () => daemon!.network.generation,
            client: consoleClient, authorize: principal => principal.accountId === config.declaration.identity.accountId &&
              principal.scopeId === config.declaration.scopeId && config.allowedManagers.includes(principal.agentId) }, peer),
          })
        })().catch(error => {
          // A scoped data failure must not kill registration or imply an owning operation completed.
          console.error('Agent data connection closed:', error instanceof RelayProtocolError ? error.code : 'UNAVAILABLE')
        })
      },
    } })
    const ledger = createWorkLedger({ provider: { accountId: config.declaration.identity.accountId, scopeId: config.declaration.scopeId,
      agentId: config.declaration.identity.agentId }, generation: daemon.network.generation, capabilities: executor.capabilities,
      store: createFileWorkStore(resolve(config.dataDirectory, 'work.json')) })
    const hasUnreconciledState = ledger.snapshot.allocations.some(allocation => allocation.state !== 'released') ||
      ledger.snapshot.requests.some(request => ['running', 'cancel_requested', 'unknown'].includes(request.state))
    if (hasUnreconciledState) {
      // A restarted daemon has no trusted external completion observation. Persist
      // RESULT_UNKNOWN through the ledger owner before refusing new Work; never
      // replay an operation or release a resource on process absence alone.
      recover(ledger, createTrustedWorkAuthority(), [])
      throw new RelayProtocolError('RESULT_UNKNOWN', 'persisted resources require trusted reconciliation before serving Work')
    }
    host = createWorkHost({ ledger, policy: () => policy, executor })
    await daemon.network.publish({ ...config.declaration, revision: 2, capabilities: executor.capabilities })
    readyResolve()
    const live = daemon
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => {
      if (stopping) return stopping
      stopping = (async () => {
        try {
          await live.stop()
          await configBinding?.owner.stop()
          const results = await Promise.allSettled(ledger.snapshot.works.filter(work => work.state !== 'closed' && work.state !== 'rejected').map(work =>
            host.close({ accountId: ledger.provider.accountId, scopeId: ledger.provider.scopeId, agentId: work.consumerAgentId }, work.workId)))
          const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Agent resource cleanup remains unconfirmed')
        } finally { await closeLease(lease) }
      })()
      return stopping
    }
    const closed = live.closed.then(async state => { await stop(); if (state.state === 'failed') throw state.error ?? new Error('Agent network failed') })
    return { daemon: live, stop, closed }
  } catch (error) {
    readyReject(error)
    try { await daemon?.stop(); await configBinding?.owner.stop() } finally { await closeLease(lease) }
    throw error
  }
}

export async function runAgentProcess(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || argv[0] !== '--config') throw new RelayProtocolError('INVALID_INPUT', 'usage: agent-process --config <file>')
  const handle = await startAgentProcess(argv[1])
  const stop = () => { void handle.stop().catch(error => { process.exitCode = 1; console.error(error.message) }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  process.send?.({ kind: 'daemon.registered', agentId: handle.daemon.status().agentId, generation: handle.daemon.network.generation })
  try { await handle.closed } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runAgentProcess().catch(error => { console.error(error instanceof Error ? error.message : 'Agent startup failed'); process.exitCode = 1 })
}
