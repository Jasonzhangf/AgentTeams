import { createServer, type Server } from 'node:net'
import { readFile, mkdir, open, link, unlink, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { object, text, number, loadDirectListenerConfig, loadRelayConfig, type DirectListenerConfig } from './process-config.ts'
import { parseAgentDeclaration, RelayProtocolError } from '../control-protocol/relay-codec.ts'
import type { AgentDeclaration } from '../control-protocol/agent-services.ts'
import { createCliWorkExecutor } from '../agent-host/cli-executor.ts'
import { createWorkHost } from '../agent-host/work-host.ts'
import { createWorkIngress } from '../agent-host/work-ingress.ts'
import { createFileWorkStore, createTrustedWorkAuthority, createWorkLedger, currentWorkProcessStartToken, readFileWorkStoreLockProof, recover, recoverFileWorkStoreLock, type WorkLedger } from '../agent/work-resource.ts'
import { createConsoleIngress } from '../agent-host/console-ingress.ts'
import { acceptAgentData } from './agent-data.ts'
import type { ConsoleClientV1 } from '../control-protocol/console-api.ts'
import { projectConsoleWorkObservations } from './console-work-projection.ts'
import type { RelayClientOptions } from '../network/relay-client.ts'
import { startAgentDaemon, type AgentDaemon } from './agent-daemon.ts'
import { createJsonFileConfigPersistence, createRuntimeConfigStore, RuntimeConfigError } from '../config/runtime-config.ts'
import { createOpenAIModelCatalogClient } from '../config/provider-model-client.ts'
import { createConsoleConfigBinding } from './console-config.ts'
import { createManagedConfigOwner } from './managed-config-owner.ts'
import { createAgentWorkClient, type AgentWorkClient } from './agent-work-client.ts'
import { compileDeclarationEndpoints } from '../server/endpoint-discovery.ts'
import { createDirectWssListener, type DirectWssListener } from '../network/direct-listener.ts'
import { assertJsonValue } from '../control-protocol/json-value.ts'
import type { JsonValue, ResourceDemand } from '../control-protocol/agent-services.ts'
import { writeLocalInternalConfiguredWorkIfCurrent, type LocalLauncherControl } from './local-config.ts'
import type { LocalDaemonEndpointProjection } from './local-supervisor.ts'

export interface AgentConnectionIntent {
  readonly targetAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly workId: string
  readonly requestId: string
  readonly demands: readonly ResourceDemand[]
  readonly payload: JsonValue
}

export interface AgentEndpointConfig {
  readonly role: 'provider' | 'receiver' | 'hybrid'
  readonly connect?: AgentConnectionIntent
}

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
  readonly directListener?: DirectListenerConfig
  readonly endpoint?: AgentEndpointConfig
}

interface RuntimeOwnerRecord {
  readonly version: 1
  readonly pid: number
  readonly startToken: string
  readonly leasePort: number
}

function parseRuntimeOwner(value: unknown): RuntimeOwnerRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RelayProtocolError('INVALID_INPUT', 'runtime owner record must be an object')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
    typeof record.startToken !== 'string' || record.startToken.length === 0 || typeof record.leasePort !== 'number' ||
    !Number.isSafeInteger(record.leasePort) || record.leasePort <= 0 || record.leasePort > 65535) {
    throw new RelayProtocolError('INVALID_INPUT', 'runtime owner record is invalid')
  }
  return { version: 1, pid: record.pid, startToken: record.startToken, leasePort: record.leasePort }
}

async function readRuntimeOwner(path: string): Promise<RuntimeOwnerRecord | undefined> {
  try { return parseRuntimeOwner(JSON.parse(await readFile(path, 'utf8'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof RelayProtocolError) throw error
    throw new RelayProtocolError('INVALID_INPUT', `runtime owner record is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function loadAgentProcessConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentProcessConfig> {
  const configPath = resolve(path)
  const input = object(JSON.parse(await readFile(configPath, 'utf8')),
    ['version', 'identity', 'scopeId', 'dataDirectory', 'leasePort', 'relay', 'presenceIntervalMs', 'policy', 'cli', 'openCode', 'directListener', 'endpoint'], 'Agent config')
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
  const directListener = input.directListener === undefined ? undefined : loadDirectListenerConfig(input.directListener, declaration, configPath, env)
  let endpoint: AgentEndpointConfig | undefined
  if (input.endpoint !== undefined) {
    const endpointInput = object(input.endpoint, ['role', 'connect'], 'endpoint')
    if (endpointInput.role !== 'provider' && endpointInput.role !== 'receiver' && endpointInput.role !== 'hybrid') throw new RelayProtocolError('INVALID_INPUT', 'endpoint.role is invalid')
    let connect: AgentConnectionIntent | undefined
    if (endpointInput.connect !== undefined) {
      const connection = object(endpointInput.connect, ['targetAgentId', 'capabilityId', 'capabilityVersion', 'operation', 'workId', 'requestId', 'demands', 'payload'], 'endpoint.connect')
      const field = (key: string) => text(connection[key], `endpoint.connect.${key}`)
      if (!Array.isArray(connection.demands) || connection.demands.length === 0) throw new RelayProtocolError('INVALID_INPUT', 'endpoint.connect.demands must be non-empty')
      const demands = connection.demands.map((item, index) => {
        const demand = object(item, ['resourceId', 'amount'], `endpoint.connect.demands[${index}]`)
        return { resourceId: text(demand.resourceId, `endpoint.connect.demands[${index}].resourceId`), amount: number(demand.amount, `endpoint.connect.demands[${index}].amount`) }
      })
      if (!Object.hasOwn(connection, 'payload')) throw new RelayProtocolError('INVALID_INPUT', 'endpoint.connect.payload is required')
      try { assertJsonValue(connection.payload, 'endpoint.connect.payload') }
      catch (error) { throw new RelayProtocolError('INVALID_INPUT', error instanceof Error ? error.message : 'endpoint.connect.payload must contain only JSON values') }
      connect = { targetAgentId: field('targetAgentId'), capabilityId: field('capabilityId'), capabilityVersion: field('capabilityVersion'), operation: field('operation'),
        workId: field('workId'), requestId: field('requestId'), demands, payload: connection.payload as JsonValue }
    }
    if ((endpointInput.role === 'receiver' || endpointInput.role === 'hybrid') && connect === undefined) throw new RelayProtocolError('INVALID_INPUT', 'receiver endpoint requires endpoint.connect')
    endpoint = { role: endpointInput.role, ...(connect === undefined ? {} : { connect }) }
  }
  return {
    declaration, dataDirectory: location(input.dataDirectory, 'dataDirectory'), leasePort: number(input.leasePort, 'leasePort', 65535),
    presenceIntervalMs: number(input.presenceIntervalMs, 'presenceIntervalMs'), policyRevision: number(policy.revision, 'policy.revision'),
    allowedConsumers: [...policy.allowedConsumers] as string[],
    allowedManagers: [...allowedManagers] as string[],
    cli: { camoExecutable: location(cli.camoExecutable, 'camoExecutable'), searchExecutable: location(cli.searchExecutable, 'searchExecutable'),
      searchRoot: location(cli.searchRoot, 'searchRoot'), profilePrefix: text(cli.profilePrefix, 'profilePrefix') },
    ...(openCode === undefined ? {} : { openCode }),
    ...(directListener === undefined ? {} : { directListener }),
    ...(endpoint === undefined ? {} : { endpoint }),
    relay: await loadRelayConfig(input.relay, declaration, configPath, env),
  }
}

async function closeLease(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
async function ownDataDirectory(config: AgentProcessConfig): Promise<{ readonly server: Server; readonly previousOwner?: RuntimeOwnerRecord }> {
  const lease = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { lease.off('listening', ready); reject(error) }
    const ready = () => { lease.off('error', failed); resolve() }
    lease.once('error', failed); lease.once('listening', ready)
    lease.listen({ host: '127.0.0.1', port: config.leasePort, exclusive: true })
  })
  try {
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 })
    const ownerPath = resolve(config.dataDirectory, 'runtime-owner.json')
    const previousOwner = await readRuntimeOwner(ownerPath)
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
    const ownerTemporary = resolve(config.dataDirectory, `.runtime-owner-${randomUUID()}`)
    const ownerFile = await open(ownerTemporary, 'wx', 0o600)
    try {
      await ownerFile.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, startToken: currentWorkProcessStartToken(), leasePort: config.leasePort })}\n`)
      await ownerFile.sync()
    } finally { await ownerFile.close() }
    try { await rename(ownerTemporary, ownerPath) } finally {
      try { await unlink(ownerTemporary) } catch { /* already renamed */ }
    }
    return { server: lease, ...(previousOwner === undefined ? {} : { previousOwner }) }
  } catch (error) { await closeLease(lease); throw error }
}

export interface AgentProcess {
  readonly daemon: AgentDaemon
  readonly consumerWork: AgentWorkClient
  readonly configuredWork?: Promise<ConfiguredWorkReceipt>
  readonly closed: Promise<void>
  readonly statusProjection: () => LocalDaemonEndpointProjection
  stop(): Promise<void>
}

export interface ConfiguredWorkReceipt {
  readonly workId: string
  readonly requestId: string
}

export async function runConfiguredWork(client: AgentWorkClient, intent: AgentConnectionIntent, policyRevision: number): Promise<ConfiguredWorkReceipt> {
  const target = await client.findProvider({ providerAgentId: intent.targetAgentId, capabilityId: intent.capabilityId, capabilityVersion: intent.capabilityVersion, operation: intent.operation })
  const channel = await client.open(target)
  try {
    const work = await channel.propose({ workId: intent.workId, capabilityId: intent.capabilityId, capabilityVersion: intent.capabilityVersion, policyRevision })
    const workId = work.workId
    const result = await channel.request({ workId, requestId: intent.requestId, operation: intent.operation, demands: intent.demands, payload: intent.payload })
    if (result.control.state !== 'succeeded') {
      if (result.control.state === 'failed' || result.control.state === 'cancelled') await channel.close(workId)
      throw new RelayProtocolError(result.control.error?.code ?? 'RESULT_UNKNOWN', result.control.error?.message ?? 'configured Work did not succeed')
    }
    await channel.close(workId)
    return { workId, requestId: intent.requestId }
  } finally { await channel.dispose() }
}
export async function startAgentProcess(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentProcess> {
  const config = await loadAgentProcessConfig(configPath, env)
  const ownership = await ownDataDirectory(config)
  const lease = ownership.server
  let daemon: AgentDaemon | undefined
  let directListener: DirectWssListener | undefined
  let consumerWork: AgentWorkClient | undefined
  let configBinding: { binding: ReturnType<typeof createConsoleConfigBinding>; owner: ReturnType<typeof createManagedConfigOwner> } | undefined
  let readyResolve!: () => void
  let readyReject!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  void ready.catch(() => undefined) // Startup failure is also returned to the caller.
  try {
    const executor = createCliWorkExecutor(config.cli)
    const advertisedCapabilities = config.endpoint?.role === 'receiver' ? [] : executor.capabilities
    let host!: ReturnType<typeof createWorkHost>
    let ledger: WorkLedger | undefined
    const resolveCredentialValue = async (reference: string) => {
      const value = env[reference]
      if (typeof value !== 'string' || value.length === 0) throw new RuntimeConfigError({ code: 'CREDENTIAL_UNAVAILABLE', message: `credential ${reference} is unavailable` })
      return value
    }
    configBinding = config.openCode === undefined ? undefined : (() => {
      const store = createRuntimeConfigStore(createJsonFileConfigPersistence(config.openCode.configFile))
      const owner = createManagedConfigOwner({ agentId: config.declaration.identity.agentId, executable: config.openCode.executable,
        directory: config.openCode.directory, port: config.openCode.port, startupTimeoutMs: config.openCode.startupTimeoutMs,
        stopTimeoutMs: config.openCode.stopTimeoutMs, resolveCredential: resolveCredentialValue })
      return { binding: createConsoleConfigBinding({ agentId: config.declaration.identity.agentId, store,
        models: createOpenAIModelCatalogClient(), credentials: { resolve: async reference => ({ kind: 'bearer', value: await resolveCredentialValue(reference) }) }, applier: owner }), owner }
    })()
    const allowed = (consumer: { agentId: string }) => config.allowedConsumers.includes(consumer.agentId)
    const policy = { revision: config.policyRevision, authorizeWork: allowed, authorizeRequest: allowed }
    const consoleClient: ConsoleClientV1 = {
      readProjection: async () => ({ version: 1, agents: [{ agentId: config.declaration.identity.agentId,
        machineId: config.declaration.identity.machineId, label: config.declaration.identity.label,
        presence: daemon?.status().state === 'online' ? 'online' : 'offline', capabilities: advertisedCapabilities.map(item => item.capabilityId) }],
        sessions: [], notifications: [], configs: configBinding === undefined ? [] : [configBinding.binding.readProjection()],
        ...projectConsoleWorkObservations(config.declaration.identity.agentId, ledger?.snapshot.works ?? []) }),
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
    if (config.directListener !== undefined) {
      const admissions = config.directListener.admissions.length > 0
        ? config.directListener.admissions
        : config.allowedConsumers.length === 1
          ? [{ admissionRef: `direct:${config.allowedConsumers[0]}`, agentId: config.allowedConsumers[0], credential: config.directListener.credential }]
          : (() => { throw new RelayProtocolError('INVALID_INPUT', 'directListener requires peer-specific admissions when multiple consumers are allowed') })()
      if (admissions.some(admission => !config.allowedConsumers.includes(admission.agentId))) {
        throw new RelayProtocolError('FORBIDDEN', 'directListener admission is not present in allowedConsumers')
      }
      directListener = await createDirectWssListener({
        host: config.directListener.host,
        port: config.directListener.port,
        key: await readFile(config.directListener.keyFile),
        cert: await readFile(config.directListener.certFile),
        admissions: admissions.map(admission => ({
          admissionRef: admission.admissionRef,
          peer: { accountId: config.declaration.identity.accountId, scopeId: config.declaration.scopeId, agentId: admission.agentId },
          credential: admission.credential,
        })),
        target: { ...config.directListener.target, targetGeneration: daemon.network.generation },
        maxPayload: config.directListener.maxPayload,
        maxConnections: config.directListener.maxConnections,
        maxMessageBytes: config.directListener.maxMessageBytes,
        maxBufferedBytes: config.directListener.maxBufferedBytes,
        maxPendingFrames: config.directListener.maxPendingFrames,
        helloTimeoutMs: config.directListener.helloTimeoutMs,
      })
    }
    const workFile = resolve(config.dataDirectory, 'work.json')
    const workLock = readFileWorkStoreLockProof(workFile)
    if (workLock !== undefined) {
      const previousOwner = ownership.previousOwner
      if (previousOwner === undefined || previousOwner.pid !== workLock.ownerPid || previousOwner.startToken !== workLock.ownerStartToken || previousOwner.leasePort !== config.leasePort) {
        throw new RelayProtocolError('UNAVAILABLE', 'stale work store lock has no matching previous daemon owner')
      }
      recoverFileWorkStoreLock(workFile, createTrustedWorkAuthority(), workLock, owner =>
        owner.pid === previousOwner.pid && owner.startToken === previousOwner.startToken)
    }
    const directRoute = directListener === undefined ? undefined : {
      candidateId: 'direct',
      kind: 'lan' as const,
      endpoint: directListener.url,
      port: directListener.port,
      authRequired: true,
      lastSeenAt: new Date().toISOString(),
    }
    const publishedDeclaration = {
      ...config.declaration,
      revision: 2,
      capabilities: advertisedCapabilities,
      ...(directRoute === undefined ? {} : { routes: [directRoute] }),
    }
    ledger = createWorkLedger({ provider: { accountId: config.declaration.identity.accountId, scopeId: config.declaration.scopeId,
      agentId: config.declaration.identity.agentId }, generation: daemon.network.generation, capabilities: advertisedCapabilities,
      endpointCatalog: compileDeclarationEndpoints(publishedDeclaration), store: createFileWorkStore(workFile) })
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
    await daemon.network.publish(publishedDeclaration)
    consumerWork = createAgentWorkClient(daemon.network, {
      accountId: config.declaration.identity.accountId,
      scopeId: config.declaration.scopeId,
      agentId: config.declaration.identity.agentId,
    }, { timeoutMs: config.relay.requestTimeoutMs, maxPending: config.relay.maxPendingRequests })
    const configuredWork = config.endpoint?.connect === undefined ? undefined : runConfiguredWork(consumerWork, config.endpoint.connect, config.policyRevision)
    readyResolve()
    const live = daemon
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => {
      if (stopping) return stopping
      stopping = (async () => {
        try {
          await consumerWork?.dispose()
          await directListener?.close()
          await live.stop()
          await configBinding?.owner.stop()
          const results = await Promise.allSettled(ledger.snapshot.works.filter(work => work.state !== 'closed' && work.state !== 'rejected').map(work =>
            host.close({ accountId: ledger.provider.accountId, scopeId: ledger.provider.scopeId, agentId: work.consumerAgentId }, work.workId)))
          const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Agent resource cleanup remains unconfirmed')
        } finally {
          try { await unlink(resolve(config.dataDirectory, 'runtime-owner.json')) } catch { /* owner record may already be absent */ }
          await closeLease(lease)
        }
      })()
      return stopping
    }
    const closed = live.closed.then(async state => { await stop(); if (state.state === 'failed') throw state.error ?? new Error('Agent network failed') })
    const statusProjection = (): LocalDaemonEndpointProjection => ({
      agentId: publishedDeclaration.identity.agentId,
      identity: publishedDeclaration.identity,
      role: config.endpoint?.role ?? 'provider',
      presence: 'online',
      state: 'online',
      generation: live.network.generation,
      capabilities: publishedDeclaration.capabilities.map(capability => ({
        capabilityId: capability.capabilityId,
        version: capability.version,
        operations: capability.operations.map(operation => operation.operation),
        resources: capability.resources.map(resource => ({ resourceId: resource.resourceId, capacity: resource.capacity, unit: resource.unit })),
      })),
    })
    return { daemon: live, consumerWork: consumerWork!, ...(configuredWork === undefined ? {} : { configuredWork }), statusProjection, stop, closed }
  } catch (error) {
    readyReject(error)
    try { await directListener?.close(); await daemon?.stop(); await configBinding?.owner.stop() } finally { await closeLease(lease) }
    throw error
  }
}

export async function runAgentProcess(argv = process.argv.slice(2)): Promise<void> {
  if (!((argv.length === 2 || argv.length === 4) && argv[0] === '--config' && (argv.length === 2 || (argv[2] === '--launcher-start-token' && argv[3].trim() !== '')))) throw new RelayProtocolError('INVALID_INPUT', 'usage: agent-process --config <file>')
  const launcherControl = captureLocalLauncherControl(process.env)
  const handle = await startAgentProcess(argv[1])
  const stop = () => { void handle.stop().catch(error => { process.exitCode = 1; console.error(error.message) }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  if (handle.configuredWork !== undefined) {
    try {
      const configuredWork = await handle.configuredWork
      if (launcherControl !== undefined) {
        await writeLocalInternalConfiguredWorkIfCurrent(launcherControl.internalPath, {
          agentId: handle.daemon.status().agentId,
          workId: configuredWork.workId,
          requestId: configuredWork.requestId,
          generation: launcherControl.generation,
          state: 'succeeded',
        }, { generation: launcherControl.generation, startToken: launcherControl.startToken })
      }
    } catch (error) { await handle.stop(); throw error }
  }
  const status = handle.daemon.status()
  // Preserve the established first readiness frame for external child readers;
  // the typed status projection follows on the same IPC channel.
  process.send?.({ kind: 'daemon.registered', agentId: status.agentId, generation: status.generation })
  process.send?.({ kind: 'daemon.status', agentId: status.agentId, generation: status.generation, endpoint: handle.statusProjection() })
  try { await handle.closed } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}

function captureLocalLauncherControl(env: NodeJS.ProcessEnv): (LocalLauncherControl & { readonly internalPath: string }) | undefined {
  const internalPath = env.TEAMS_LOCAL_INTERNAL_PATH
  if (internalPath === undefined) return undefined
  const generation = Number(env.TEAMS_LOCAL_LAUNCHER_GENERATION)
  const startToken = env.TEAMS_LOCAL_START_TOKEN
  if (!Number.isSafeInteger(generation) || generation < 0 || startToken === undefined || startToken.length === 0) {
    throw new RelayProtocolError('INVALID_INPUT', 'local launcher control values are required for configured Work')
  }
  return { internalPath, generation, startToken }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runAgentProcess().catch(error => { console.error(error instanceof Error ? error.message : 'Agent startup failed'); process.exitCode = 1 })
}
