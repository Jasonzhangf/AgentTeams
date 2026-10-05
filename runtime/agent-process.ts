import { createServer, type Server } from 'node:net'
import { readFile, mkdir, open, link, unlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
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
import { createRuntimeConfigStore, RuntimeConfigError, targetIdentityFor } from '../config/runtime-config.ts'
import { createOpenAIModelCatalogClient } from '../config/provider-model-client.ts'
import { createConsoleConfigBinding } from './console-config.ts'
import { createManagedConfigOwner, createManagedConfigOwnerPersistence } from './managed-config-owner.ts'
import { createTomlRuntimeConfigPersistence, defaultLocalConfigPath } from './local-config.ts'
import { createAgentWorkClient, type AgentWorkClient } from './agent-work-client.ts'
import { compileDeclarationEndpoints } from '../server/endpoint-discovery.ts'
import { createDirectWssListener, type DirectWssListener } from '../network/direct-listener.ts'
import type { ResourceDemand } from '../control-protocol/agent-services.ts'
import { type LocalServiceIntent } from './local-config.ts'
import type { LocalDaemonEndpointProjection, LocalWorkChildReply, LocalWorkChildRequest } from './local-supervisor.ts'
import type { LocalWorkControlRequest } from './local-work-control.ts'
import { runWorkExecution, type ProjectExecutionReceipt, type WorkExecutionRequest } from './dagpipe/host.ts'

export interface AgentConnectionIntent {
  readonly targetAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly demands: readonly ResourceDemand[]
}

export interface AgentEndpointConfig {
  readonly role: 'provider' | 'receiver' | 'hybrid'
  readonly connect?: AgentConnectionIntent
  readonly services: readonly LocalServiceIntent[]
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
    const endpointInput = object(input.endpoint, ['role', 'connect', 'services'], 'endpoint')
    if (endpointInput.role !== 'provider' && endpointInput.role !== 'receiver' && endpointInput.role !== 'hybrid') throw new RelayProtocolError('INVALID_INPUT', 'endpoint.role is invalid')
    let connect: AgentConnectionIntent | undefined
    if (endpointInput.connect !== undefined) {
      const connection = object(endpointInput.connect, ['targetAgentId', 'capabilityId', 'capabilityVersion', 'operation', 'demands'], 'endpoint.connect')
      const field = (key: string) => text(connection[key], `endpoint.connect.${key}`)
      if (!Array.isArray(connection.demands) || connection.demands.length === 0) throw new RelayProtocolError('INVALID_INPUT', 'endpoint.connect.demands must be non-empty')
      const demands = connection.demands.map((item, index) => {
        const demand = object(item, ['resourceId', 'amount'], `endpoint.connect.demands[${index}]`)
        return { resourceId: text(demand.resourceId, `endpoint.connect.demands[${index}].resourceId`), amount: number(demand.amount, `endpoint.connect.demands[${index}].amount`) }
      })
      connect = {
        targetAgentId: field('targetAgentId'),
        capabilityId: field('capabilityId'),
        capabilityVersion: field('capabilityVersion'),
        operation: field('operation'),
        demands,
      }
    }
    if ((endpointInput.role === 'receiver' || endpointInput.role === 'hybrid') && connect === undefined) throw new RelayProtocolError('INVALID_INPUT', 'receiver endpoint requires endpoint.connect')
    const services = endpointInput.services === undefined ? [] : (() => {
      if (!Array.isArray(endpointInput.services)) throw new RelayProtocolError('INVALID_INPUT', 'endpoint.services must be an array')
      return endpointInput.services.map((value, index) => {
        const service = object(value, ['capabilityId', 'version', 'operations', 'resources'], `endpoint.services[${index}]`)
        const operations = service.operations
        if (!Array.isArray(operations) || operations.some(operation => typeof operation !== 'string' || operation.length === 0)) {
          throw new RelayProtocolError('INVALID_INPUT', `endpoint.services[${index}].operations must be a string array`)
        }
        const resources = service.resources
        if (!Array.isArray(resources) || resources.length === 0) throw new RelayProtocolError('INVALID_INPUT', `endpoint.services[${index}].resources must be a non-empty array`)
        return {
          capabilityId: text(service.capabilityId, `endpoint.services[${index}].capabilityId`),
          version: text(service.version, `endpoint.services[${index}].version`),
          operations: operations.map((operation, operationIndex) => text(operation, `endpoint.services[${index}].operations[${operationIndex}]`)),
          resources: resources.map((resourceValue, resourceIndex) => {
            const resource = object(resourceValue, ['resourceId', 'capacity', 'unit'], `endpoint.services[${index}].resources[${resourceIndex}]`)
            const unit = resource.unit
            if (unit !== 'slot' && unit !== 'context') throw new RelayProtocolError('INVALID_INPUT', `endpoint.services[${index}].resources[${resourceIndex}].unit is invalid`)
            return {
              resourceId: text(resource.resourceId, `endpoint.services[${index}].resources[${resourceIndex}].resourceId`),
              capacity: number(resource.capacity, `endpoint.services[${index}].resources[${resourceIndex}].capacity`),
              unit: unit as 'slot' | 'context',
            }
          }),
        }
      })
    })()
    endpoint = { role: endpointInput.role, ...(connect === undefined ? {} : { connect }), services }
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
  readonly executeWork: (frame: LocalWorkControlRequest) => Promise<ProjectExecutionReceipt>
  readonly closed: Promise<void>
  readonly statusProjection: () => LocalDaemonEndpointProjection
  stop(): Promise<void>
}

const WORK_GRAPH: Readonly<Record<LocalWorkControlRequest['kind'], { readonly file: string; readonly id: string }>> = {
  'work.submit': { file: 'agent-work.graph.json', id: 'agent-work' },
  'work.query': { file: 'work-query.graph.json', id: 'work-query' },
  'work.open': { file: 'work-open.graph.json', id: 'work-open' },
  'work.request': { file: 'work-request.graph.json', id: 'work-request' },
  'work.close': { file: 'work-close.graph.json', id: 'work-close' },
}

/** Nearest ancestor directory holding the package.json; the installed pack root in every layout. */
function packageRootOf(start: string): string {
  let directory = resolve(start)
  while (true) {
    if (existsSync(resolve(directory, 'package.json'))) return directory
    const parent = resolve(directory, '..')
    if (parent === directory) throw new Error('agentteams package root cannot be resolved from the runtime module')
    directory = parent
  }
}

function dagpipeRoot(): string {
  return resolve(packageRootOf(dirname(fileURLToPath(import.meta.url))), 'runtime', 'dagpipe')
}

interface DagpipeManifest {
  readonly runner: { readonly path: string; readonly sha256: string }
  readonly graphs: readonly { readonly id: string; readonly path: string; readonly sha256: string }[]
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

interface DagpipeArtifacts { readonly runnerPath: string; readonly graphPath: string }

/**
 * Resolve the installed runner and graph from the pack root and verify their
 * manifest hashes before any provider side effect.
 */
async function resolveDagpipeArtifacts(kind: LocalWorkControlRequest['kind']): Promise<DagpipeArtifacts | { readonly code: string; readonly message: string }> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return { code: 'UNSUPPORTED_PLATFORM', message: `local Work requires darwin-arm64, received ${process.platform}-${process.arch}` }
  }
  const root = dagpipeRoot()
  const manifestPath = resolve(root, 'manifest.json')
  let manifest: DagpipeManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DagpipeManifest
  } catch (cause) {
    return { code: 'DAGPIPE_RUNNER_MISSING', message: `dagpipe manifest is unavailable: ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  const graph = WORK_GRAPH[kind]
  const runnerPath = resolve(root, manifest.runner.path)
  let runnerBytes: Buffer
  try { runnerBytes = await readFile(runnerPath) }
  catch (cause) { return { code: 'DAGPIPE_RUNNER_MISSING', message: `dagpipe runner is unavailable: ${runnerPath}: ${cause instanceof Error ? cause.message : String(cause)}` } }
  if (sha256(runnerBytes) !== manifest.runner.sha256) return { code: 'RUNNER_HASH_MISMATCH', message: `dagpipe runner hash does not match the manifest: ${runnerPath}` }
  const graphEntry = manifest.graphs.find(entry => entry.id === graph.id || entry.path === `graphs/${graph.file}`)
  if (graphEntry === undefined) return { code: 'DAGPIPE_RUNNER_MISSING', message: `dagpipe manifest does not declare graph ${graph.id}` }
  const graphPath = resolve(root, graphEntry.path)
  let graphBytes: Buffer
  try { graphBytes = await readFile(graphPath) }
  catch (cause) { return { code: 'DAGPIPE_RUNNER_MISSING', message: `dagpipe graph is unavailable: ${graphPath}: ${cause instanceof Error ? cause.message : String(cause)}` } }
  if (sha256(graphBytes) !== graphEntry.sha256) return { code: 'GRAPH_HASH_MISMATCH', message: `dagpipe graph hash does not match the manifest: ${graphPath}` }
  return { runnerPath, graphPath }
}

function failedProjectReceipt(frame: LocalWorkControlRequest, error: { readonly code: string; readonly message: string }): ProjectExecutionReceipt {
  return {
    status: 'failed',
    control: {
      projectId: 'agentteams-local-work',
      graphId: '',
      graphVersion: '',
      executionId: frame.control.executionId,
      attemptId: frame.control.attemptId,
      workId: frame.control.workId,
      requestId: frame.control.requestId,
      error,
    },
    cleanup: { channelsOpened: 0, channelsDisposed: 0 },
    evidence: { execution: 'failed', graphId: '', graphVersion: '', nodeSchedule: [], nodeCompletion: [], hostOperations: [] },
  }
}

function workIntent(
  frame: LocalWorkControlRequest,
  receiverAgentId: string,
  connect: AgentConnectionIntent | undefined,
  policyRevision: number,
): WorkExecutionRequest['intent'] | { readonly code: string; readonly message: string } {
  const base = { receiverAgentId, workId: frame.control.workId, requestId: frame.control.requestId }
  if (frame.kind === 'work.submit') {
    if (connect === undefined) return { code: 'INVALID_INPUT', message: 'receiver has no endpoint.connect service intent for submit' }
    return {
      control: {
        ...base,
        targetAgentId: connect.targetAgentId,
        capabilityId: connect.capabilityId,
        capabilityVersion: connect.capabilityVersion,
        operation: connect.operation,
        policyRevision,
        demands: connect.demands,
      },
      business: frame.business,
    }
  }
  if (frame.kind === 'work.query') {
    if (frame.control.serviceSelection === 'capability') {
      return {
        control: {
          ...base,
          targetAgentId: frame.control.targetAgentId,
          targetGeneration: frame.control.targetGeneration,
          ...(frame.control.linkGeneration === undefined ? {} : { linkGeneration: frame.control.linkGeneration }),
          serviceSelection: 'capability',
          capabilityId: frame.control.capabilityId,
          capabilityVersion: frame.control.capabilityVersion,
          operation: frame.control.operation,
        },
      }
    }
    if (connect === undefined) return { code: 'INVALID_INPUT', message: 'receiver has no endpoint.connect service intent for endpoint query' }
    return {
      control: {
        ...base,
        targetAgentId: connect.targetAgentId,
        serviceSelection: 'endpoint',
        capabilityId: connect.capabilityId,
        capabilityVersion: connect.capabilityVersion,
        operation: connect.operation,
      },
    }
  }
  const control = {
    ...base,
    targetAgentId: frame.control.targetAgentId,
    targetGeneration: frame.control.targetGeneration,
    serviceSelection: 'capability' as const,
    capabilityId: frame.control.capabilityId,
    capabilityVersion: frame.control.capabilityVersion,
    operation: frame.control.operation,
  }
  if (frame.kind === 'work.close') return { control }
  const persistent = { ...control, demands: frame.control.demands }
  if (frame.kind === 'work.open') {
    return { control: { ...persistent, policyRevision: frame.control.policyRevision ?? policyRevision }, business: frame.business }
  }
  return { control: persistent, business: frame.business }
}

async function executeProjectWork(input: {
  readonly frame: LocalWorkControlRequest
  readonly client: AgentWorkClient
  readonly connect: AgentConnectionIntent | undefined
  readonly policyRevision: number
  readonly receiverAgentId: string
}): Promise<ProjectExecutionReceipt> {
  const artifacts = await resolveDagpipeArtifacts(input.frame.kind)
  if ('code' in artifacts) return failedProjectReceipt(input.frame, artifacts)
  const intent = workIntent(input.frame, input.receiverAgentId, input.connect, input.policyRevision)
  if ('code' in intent) return failedProjectReceipt(input.frame, intent)
  return await runWorkExecution(input.client, {
    runnerPath: artifacts.runnerPath,
    graphPath: artifacts.graphPath,
    projectId: 'agentteams-local-work',
    executionId: input.frame.control.executionId,
    attemptId: input.frame.control.attemptId,
    intent,
  })
}

export async function startAgentProcess(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentProcess> {
  const config = await loadAgentProcessConfig(configPath, env)
  const services = config.endpoint?.role === 'receiver' ? [] : config.endpoint?.services ?? []
  const executor = createCliWorkExecutor({ services, ...config.cli })
  const advertisedCapabilities = config.endpoint?.role === 'receiver' ? [] : executor.capabilities
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
    let host!: ReturnType<typeof createWorkHost>
    let ledger: WorkLedger | undefined
    const resolveCredentialValue = async (reference: string) => {
      const value = env[reference]
      if (typeof value !== 'string' || value.length === 0) throw new RuntimeConfigError({ code: 'CREDENTIAL_UNAVAILABLE', message: `credential ${reference} is unavailable` })
      return value
    }
    const openCode = config.openCode
    configBinding = openCode === undefined ? undefined : await (async () => {
      const agentId = config.declaration.identity.agentId
      const configPath = env.TEAMS_LOCAL_CONFIG_PATH ?? defaultLocalConfigPath(env.HOME)
      const internalPath = env.TEAMS_LOCAL_INTERNAL_PATH ?? resolve(configPath, '..', 'internal.toml')
      const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId })
      const store = createRuntimeConfigStore(persistence, { agentId })
      const owner = createManagedConfigOwner({ agentId, executable: openCode.executable,
        directory: openCode.directory, port: openCode.port, startupTimeoutMs: openCode.startupTimeoutMs,
        stopTimeoutMs: openCode.stopTimeoutMs, resolveCredential: resolveCredentialValue,
        persistence: createManagedConfigOwnerPersistence({ agentId, internalPath, persistence }) })
      const binding = createConsoleConfigBinding({ agentId, store,
        models: createOpenAIModelCatalogClient(), credentials: { resolve: async reference => ({ kind: 'bearer', value: await resolveCredentialValue(reference) }) }, applier: owner })
      const created = { binding, owner }
      configBinding = created
      // Reconcile the exact current target before Session/command ingress opens.
      await owner.recover(async () => {
        const current = await store.read()
        const modelBinding = current.agents[agentId]
        const provider = modelBinding === undefined ? undefined : current.providers[modelBinding.primary.providerInstanceId]
        return provider === undefined ? undefined : { target: targetIdentityFor(current, provider), config: current }
      })
      return created
    })()
    const allowed = (consumer: { agentId: string }) => config.allowedConsumers.includes(consumer.agentId)
    const policy = { revision: config.policyRevision, authorizeWork: allowed, authorizeRequest: allowed }
    const consoleClient: ConsoleClientV1 = {
      readProjection: async () => ({
        version: 1,
        agents: [{ agentId: config.declaration.identity.agentId,
          machineId: config.declaration.identity.machineId, label: config.declaration.identity.label,
          presence: daemon?.status().state === 'online' ? 'online' : 'offline', capabilities: advertisedCapabilities.map(item => item.capabilityId) }],
        sessions: [], notifications: [],
        configs: configBinding === undefined ? [] : [await configBinding.binding.readProjection()],
        ...projectConsoleWorkObservations(config.declaration.identity.agentId, ledger?.snapshot.works ?? []),
      }),
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
    const connect = config.endpoint?.connect
    const executeWork = (frame: LocalWorkControlRequest): Promise<ProjectExecutionReceipt> =>
      executeProjectWork({ frame, client: consumerWork!, connect, policyRevision: config.policyRevision, receiverAgentId: config.declaration.identity.agentId })
    return { daemon: live, consumerWork: consumerWork!, executeWork, statusProjection, stop, closed }
  } catch (error) {
    readyReject(error)
    try { await directListener?.close(); await daemon?.stop(); await configBinding?.owner.stop() } finally { await closeLease(lease) }
    throw error
  }
}

export async function runAgentProcess(argv = process.argv.slice(2)): Promise<void> {
  if (!((argv.length === 2 || argv.length === 4) && argv[0] === '--config' && (argv.length === 2 || (argv[2] === '--launcher-start-token' && argv[3].trim() !== '')))) throw new RelayProtocolError('INVALID_INPUT', 'usage: agent-process --config <file>')
  const handle = await startAgentProcess(argv[1])
  const stop = () => { void handle.stop().catch(error => { process.exitCode = 1; console.error(error.message) }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  // The launcher forwards typed Work frames over this child's IPC channel. The
  // receiver binds its own registered identity and executes through the sole
  // AgentWorkClient + runWorkExecution path; it never rebuilds control state.
  const onMessage = (message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const request = message as Partial<LocalWorkChildRequest>
    if (request.kind !== 'work.control' || typeof request.localCorrelation !== 'string' || request.frame === undefined) return
    const localCorrelation = request.localCorrelation
    const frame = request.frame
    void (async () => {
      const reply: LocalWorkChildReply = await (async () => {
        if (request.receiverAgentId !== handle.daemon.status().agentId) {
          return { kind: 'work.reply', localCorrelation, reply: { kind: 'work.error', requestId: frame.requestId, error: { code: 'RECEIVER_NOT_FOUND', message: 'Work request reached a different receiver identity' } } }
        }
        if (request.expectedAgentGeneration !== handle.daemon.network.generation) {
          return { kind: 'work.reply', localCorrelation, reply: { kind: 'work.error', requestId: frame.requestId, error: { code: 'STALE_GENERATION', message: 'Work request targets a stale receiver generation' } } }
        }
        try {
          const receipt = await handle.executeWork(frame)
          return { kind: 'work.reply', localCorrelation, reply: { kind: 'work.result', requestId: frame.requestId, receipt } }
        } catch (error) {
          const code = (error as { readonly code?: unknown }).code
          return { kind: 'work.reply', localCorrelation, reply: { kind: 'work.error', requestId: frame.requestId, error: { code: typeof code === 'string' && code.length > 0 ? code : 'EXECUTION_FAILED', message: error instanceof Error ? error.message : 'receiver Work execution failed' } } }
        }
      })()
      process.send?.(reply)
    })()
  }
  process.on('message', onMessage)
  const status = handle.daemon.status()
  // Preserve the established first readiness frame for external child readers;
  // the typed status projection follows on the same IPC channel.
  process.send?.({ kind: 'daemon.registered', agentId: status.agentId, generation: status.generation })
  process.send?.({ kind: 'daemon.status', agentId: status.agentId, generation: status.generation, endpoint: handle.statusProjection() })
  try { await handle.closed } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('message', onMessage) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runAgentProcess().catch(error => { console.error(error instanceof Error ? error.message : 'Agent startup failed'); process.exitCode = 1 })
}
