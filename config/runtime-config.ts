import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { ServiceErrorCode } from '../control-protocol/agent-services.ts'

export type ProviderProtocol = 'openai-chat' | 'openai-responses'

export interface ModelRef {
  readonly providerInstanceId: string
  readonly modelId: string
}

export interface ProviderInstance {
  readonly id: string
  readonly label: string
  readonly protocol: ProviderProtocol
  readonly apiBaseUrl: string
  readonly enabled: boolean
  readonly auth: { readonly kind: 'none' } | { readonly kind: 'bearer'; readonly credentialRef: string }
}

export interface ModelMetadata {
  readonly label?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly tools?: boolean
  readonly streaming?: boolean
  readonly reasoning?: boolean
  readonly inputModalities?: readonly string[]
  readonly outputModalities?: readonly string[]
}

export interface ModelEntry {
  readonly ref: ModelRef
  readonly origin: 'discovered' | 'manual'
  readonly base: ModelMetadata
  readonly overrides: Partial<ModelMetadata>
  readonly availability?: 'available' | 'unavailable'
}

export interface AgentModelBinding {
  readonly primary: ModelRef
  readonly backup?: ModelRef
}

export type AgentRuntimeConfig = AgentModelBinding

export type ConfigErrorCode = ServiceErrorCode | 'CREDENTIAL_UNAVAILABLE'

export interface ConfigApplyError {
  readonly code: ConfigErrorCode
  readonly message: string
  readonly status?: number
  readonly providerInstanceId?: string
}

export type ModelCatalogState = 'ready' | 'empty' | 'stale' | 'error'

export interface ProviderModelCatalog {
  readonly state: ModelCatalogState
  readonly entries: readonly ModelEntry[]
  readonly refreshedAt?: string
  readonly error?: ConfigApplyError
}

export interface VersionedRuntimeConfig {
  /** Compatibility alias used by the runtime lifecycle; always equals acceptedRevision. */
  readonly revision: number
  readonly acceptedRevision: number
  readonly effectiveRevision?: number
  readonly providers: Readonly<Record<string, ProviderInstance>>
  readonly catalogs: Readonly<Record<string, ProviderModelCatalog>>
  readonly agents: Readonly<Record<string, AgentModelBinding>>
  readonly lastApplyError?: ConfigApplyError
}

export interface RuntimeConfigPersistence {
  load(): VersionedRuntimeConfig | undefined
  save(config: VersionedRuntimeConfig): void
}

export interface ResolvedCredential {
  readonly kind: 'bearer'
  readonly value: string
}

export interface CredentialResolver {
  resolve(credentialRef: string): Promise<ResolvedCredential>
}

export interface ProviderModelDescriptor {
  readonly modelId: string
  readonly metadata: ModelMetadata
}

export interface ProviderModelClient {
  listModels(input: {
    readonly provider: ProviderInstance
    readonly credential?: ResolvedCredential
  }): Promise<readonly ProviderModelDescriptor[]>
}

export type ConfigApplyResult =
  | { readonly status: 'applied'; readonly effectiveRevision: number }
  | { readonly status: 'unsupported' | 'failed'; readonly error: ConfigApplyError }

export interface RuntimeConfigApplier {
  apply(config: VersionedRuntimeConfig): Promise<ConfigApplyResult>
}

export interface RefreshResult {
  readonly status: 'ready' | 'empty' | 'error'
  readonly config: VersionedRuntimeConfig
  readonly error?: ConfigApplyError
}

export interface RuntimeConfigStore {
  read(): VersionedRuntimeConfig
  readEffective(): Pick<VersionedRuntimeConfig, 'acceptedRevision' | 'effectiveRevision' | 'lastApplyError'>
  listProviderInstances(): readonly ProviderInstance[]
  putProviderInstance(expectedRevision: number, provider: ProviderInstance): VersionedRuntimeConfig
  removeProviderInstance(expectedRevision: number, providerInstanceId: string): VersionedRuntimeConfig
  putModelEntry(expectedRevision: number, entry: ModelEntry): VersionedRuntimeConfig
  bindAgentModel(expectedRevision: number, agentId: string, binding: AgentModelBinding): VersionedRuntimeConfig
  selectAgentBackup(expectedRevision: number, agentId: string, backup?: ModelRef): VersionedRuntimeConfig
  refreshProviderModels(
    expectedRevision: number,
    providerInstanceId: string,
    client: ProviderModelClient,
    credentials?: CredentialResolver,
  ): Promise<RefreshResult>
  applyAcceptedConfig(applier: RuntimeConfigApplier): Promise<ConfigApplyResult>
}

export class RuntimeConfigError extends Error {
  readonly code: ConfigErrorCode
  readonly status?: number
  readonly providerInstanceId?: string

  constructor(error: ConfigApplyError) {
    super(error.message)
    this.name = 'RuntimeConfigError'
    this.code = error.code
    this.status = error.status
    this.providerInstanceId = error.providerInstanceId
  }

  toJSON(): ConfigApplyError {
    return {
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.providerInstanceId === undefined ? {} : { providerInstanceId: this.providerInstanceId }),
    }
  }
}

function error(
  code: ConfigErrorCode,
  message: string,
  details: Omit<ConfigApplyError, 'code' | 'message'> = {},
): RuntimeConfigError {
  return new RuntimeConfigError({ code, message, ...details })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function asRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw error('INVALID_INPUT', `config: ${label} must be a non-negative integer`)
  }
  return value
}

function normalizeRuntimeConfig(input: Partial<VersionedRuntimeConfig> | VersionedRuntimeConfig): VersionedRuntimeConfig {
  const raw = input as Partial<VersionedRuntimeConfig> & { readonly revision?: unknown; readonly acceptedRevision?: unknown }
  const acceptedRevision = asRevision(raw.acceptedRevision ?? raw.revision ?? 0, 'acceptedRevision')
  const effectiveRevision = raw.effectiveRevision === undefined
    ? undefined
    : asRevision(raw.effectiveRevision, 'effectiveRevision')
  if (effectiveRevision !== undefined && effectiveRevision > acceptedRevision) {
    throw error('INVALID_INPUT', 'config: effectiveRevision cannot exceed acceptedRevision')
  }
  return clone({
    revision: acceptedRevision,
    acceptedRevision,
    ...(effectiveRevision === undefined ? {} : { effectiveRevision }),
    providers: raw.providers ?? {},
    catalogs: raw.catalogs ?? {},
    agents: raw.agents ?? {},
    ...(raw.lastApplyError === undefined ? {} : { lastApplyError: raw.lastApplyError }),
  })
}

export function createEmptyRuntimeConfig(): VersionedRuntimeConfig {
  return { revision: 0, acceptedRevision: 0, providers: {}, catalogs: {}, agents: {} }
}

export function readConfigVersion(config: VersionedRuntimeConfig): number {
  return normalizeRuntimeConfig(config).acceptedRevision
}

export function syncSharedRuntimeConfig(config: VersionedRuntimeConfig, admitted: boolean): VersionedRuntimeConfig {
  if (!admitted) throw error('FORBIDDEN', 'config: cannot sync before server admission')
  return normalizeRuntimeConfig(config)
}

function assertExpectedRevision(config: VersionedRuntimeConfig, expectedRevision: number): void {
  if (expectedRevision !== config.acceptedRevision) {
    throw error('REVISION_CONFLICT', `config: revision conflict expected=${expectedRevision} current=${config.acceptedRevision}`)
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw error('INVALID_INPUT', `config: ${label} is required`)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function validateProvider(provider: ProviderInstance): void {
  requireNonEmpty(provider.id, 'provider id')
  requireNonEmpty(provider.label, 'provider label')
  if (provider.protocol !== 'openai-chat' && provider.protocol !== 'openai-responses') {
    throw error('UNSUPPORTED_OPERATION', `config: unsupported provider protocol ${provider.protocol}`, { providerInstanceId: provider.id })
  }
  let url: URL
  try {
    url = new URL(provider.apiBaseUrl)
  } catch {
    throw error('INVALID_INPUT', 'config: provider apiBaseUrl must be a valid URL', { providerInstanceId: provider.id })
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username.length > 0 || url.password.length > 0) {
    throw error('INVALID_INPUT', 'config: provider apiBaseUrl must be an http(s) URL without embedded credentials', { providerInstanceId: provider.id })
  }
  if (provider.auth.kind === 'bearer') requireNonEmpty(provider.auth.credentialRef, 'credentialRef')
  else if (provider.auth.kind !== 'none') throw error('INVALID_INPUT', 'config: unsupported provider auth kind', { providerInstanceId: provider.id })
  if (typeof provider.enabled !== 'boolean') throw error('INVALID_INPUT', 'config: provider enabled must be boolean', { providerInstanceId: provider.id })
}

function validateMetadata(metadata: ModelMetadata, label: string): void {
  const numericFields: readonly (readonly [string, number | undefined])[] = [
    ['contextWindow', metadata.contextWindow],
    ['maxOutputTokens', metadata.maxOutputTokens],
  ]
  for (const [key, value] of numericFields) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw error('INVALID_INPUT', `config: ${label}.${key} must be a positive integer`)
    }
  }
  for (const [key, value] of [['inputModalities', metadata.inputModalities], ['outputModalities', metadata.outputModalities] as const]) {
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw error('INVALID_INPUT', `config: ${label}.${key} must contain strings`)
    }
  }
}

function validateModelEntry(entry: ModelEntry): void {
  requireNonEmpty(entry.ref.providerInstanceId, 'model providerInstanceId')
  requireNonEmpty(entry.ref.modelId, 'model modelId')
  if (entry.origin !== 'discovered' && entry.origin !== 'manual') throw error('INVALID_INPUT', 'config: invalid model origin')
  validateMetadata(entry.base, 'model base')
  validateMetadata(entry.overrides, 'model overrides')
  if (entry.availability !== undefined && entry.availability !== 'available' && entry.availability !== 'unavailable') {
    throw error('INVALID_INPUT', 'config: invalid model availability')
  }
}

function validateBinding(binding: AgentModelBinding, label = 'binding'): void {
  requireNonEmpty(binding.primary.providerInstanceId, `${label}.primary.providerInstanceId`)
  requireNonEmpty(binding.primary.modelId, `${label}.primary.modelId`)
  if (binding.backup !== undefined) {
    requireNonEmpty(binding.backup.providerInstanceId, `${label}.backup.providerInstanceId`)
    requireNonEmpty(binding.backup.modelId, `${label}.backup.modelId`)
  }
  if (binding.backup !== undefined
    && binding.backup.providerInstanceId === binding.primary.providerInstanceId
    && binding.backup.modelId === binding.primary.modelId) {
    throw error('CONFLICT', 'config: backup must differ from primary')
  }
}

function modelKey(ref: ModelRef): string {
  return `${ref.providerInstanceId}\u0000${ref.modelId}`
}

function emptyCatalog(): ProviderModelCatalog {
  return { state: 'empty', entries: [] }
}

function catalogFor(config: VersionedRuntimeConfig, providerInstanceId: string): ProviderModelCatalog {
  return config.catalogs[providerInstanceId] ?? emptyCatalog()
}

function entryFor(config: VersionedRuntimeConfig, ref: ModelRef): ModelEntry | undefined {
  return catalogFor(config, ref.providerInstanceId).entries.find(entry => modelKey(entry.ref) === modelKey(ref))
}

function assertBindingTargets(config: VersionedRuntimeConfig, binding: AgentModelBinding): void {
  validateBinding(binding)
  for (const ref of [binding.primary, ...(binding.backup === undefined ? [] : [binding.backup])]) {
    const provider = config.providers[ref.providerInstanceId]
    if (provider === undefined) throw error('NOT_FOUND', `config: provider ${ref.providerInstanceId} not found`, { providerInstanceId: ref.providerInstanceId })
    if (!provider.enabled) throw error('UNAVAILABLE', `config: provider ${ref.providerInstanceId} is disabled`, { providerInstanceId: ref.providerInstanceId })
    const entry = entryFor(config, ref)
    if (entry === undefined) throw error('NOT_FOUND', `config: model ${ref.modelId} not found`, { providerInstanceId: ref.providerInstanceId })
    if (entry.availability === 'unavailable') throw error('UNAVAILABLE', `config: model ${ref.modelId} is unavailable`, { providerInstanceId: ref.providerInstanceId })
  }
}

function withAcceptedRevision(config: VersionedRuntimeConfig, acceptedRevision: number): VersionedRuntimeConfig {
  const { lastApplyError: _lastApplyError, ...withoutApplyError } = config
  return normalizeRuntimeConfig({ ...withoutApplyError, revision: acceptedRevision, acceptedRevision })
}

function withObservation(config: VersionedRuntimeConfig, update: Partial<VersionedRuntimeConfig>): VersionedRuntimeConfig {
  return normalizeRuntimeConfig({ ...config, ...update })
}

function providerChanged(previous: ProviderInstance | undefined, next: ProviderInstance): boolean {
  if (previous === undefined) return false
  return previous.label !== next.label
    || previous.protocol !== next.protocol
    || previous.apiBaseUrl !== next.apiBaseUrl
    || previous.enabled !== next.enabled
    || previous.auth.kind !== next.auth.kind
    || (previous.auth.kind === 'bearer' && next.auth.kind === 'bearer' && previous.auth.credentialRef !== next.auth.credentialRef)
}

function invalidateCatalog(catalog: ProviderModelCatalog): ProviderModelCatalog {
  const entries = catalog.entries.map(entry => entry.origin === 'discovered'
    ? { ...entry, availability: 'unavailable' as const }
    : entry)
  return { state: entries.length === 0 ? 'empty' : 'stale', entries }
}

function replaceEntry(catalog: ProviderModelCatalog, next: ModelEntry): ProviderModelCatalog {
  const key = modelKey(next.ref)
  const index = catalog.entries.findIndex(entry => modelKey(entry.ref) === key)
  const entries = index < 0
    ? [...catalog.entries, next]
    : catalog.entries.map((entry, entryIndex) => entryIndex === index ? next : entry)
  return { state: 'ready', entries, refreshedAt: catalog.refreshedAt }
}

function commitAccepted(
  current: VersionedRuntimeConfig,
  persistence: RuntimeConfigPersistence,
  mutate: (config: VersionedRuntimeConfig) => VersionedRuntimeConfig,
): VersionedRuntimeConfig {
  const next = withAcceptedRevision(mutate(current), current.acceptedRevision + 1)
  persistence.save(clone(next))
  return next
}

function statusFromUnknown(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.status === 'number' ? value.status : undefined
}

function codeForStatus(status: number | undefined): ConfigErrorCode {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status !== undefined && status >= 500) return 'UPSTREAM_ERROR'
  return 'UNAVAILABLE'
}

function publicError(value: unknown, providerInstanceId?: string): ConfigApplyError {
  if (value instanceof RuntimeConfigError) return value.toJSON()
  const status = statusFromUnknown(value)
  return {
    code: codeForStatus(status),
    message: value instanceof Error ? value.message : 'config: provider operation failed',
    ...(status === undefined ? {} : { status }),
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
  }
}

function validateDescriptors(descriptors: readonly ProviderModelDescriptor[], providerInstanceId: string): void {
  if (!Array.isArray(descriptors)) throw error('UPSTREAM_ERROR', 'config: provider model response must be an array', { providerInstanceId })
  const ids = new Set<string>()
  for (const descriptor of descriptors) {
    requireNonEmpty(descriptor.modelId, 'discovered modelId')
    if (ids.has(descriptor.modelId)) throw error('CONFLICT', `config: duplicate discovered model ${descriptor.modelId}`, { providerInstanceId })
    ids.add(descriptor.modelId)
    validateMetadata(descriptor.metadata, `discovered model ${descriptor.modelId}`)
  }
}

function mergeCatalog(
  existing: ProviderModelCatalog,
  providerInstanceId: string,
  descriptors: readonly ProviderModelDescriptor[],
): ProviderModelCatalog {
  const discovered = new Map(descriptors.map(descriptor => [descriptor.modelId, descriptor] as const))
  const entries = existing.entries.map(entry => {
    if (entry.origin === 'manual') {
      discovered.delete(entry.ref.modelId)
      return entry
    }
    const current = discovered.get(entry.ref.modelId)
    if (current === undefined) return { ...entry, availability: 'unavailable' as const }
    discovered.delete(entry.ref.modelId)
    return { ...entry, base: current.metadata, availability: 'available' as const }
  })
  for (const descriptor of discovered.values()) {
    entries.push({
      ref: { providerInstanceId, modelId: descriptor.modelId },
      origin: 'discovered',
      base: descriptor.metadata,
      overrides: {},
      availability: 'available',
    })
  }
  return {
    state: descriptors.length === 0 && !entries.some(entry => entry.origin === 'manual') ? 'empty' : 'ready',
    entries,
    refreshedAt: new Date().toISOString(),
  }
}

export function createJsonFileConfigPersistence(filePath: string): RuntimeConfigPersistence {
  return {
    load: () => {
      if (!existsSync(filePath)) return undefined
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<VersionedRuntimeConfig>
        return normalizeRuntimeConfig(parsed)
      } catch (cause) {
        if (cause instanceof RuntimeConfigError) throw cause
        throw error('INVALID_INPUT', 'config: durable state is not valid JSON')
      }
    },
    save: config => {
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporaryPath, `${JSON.stringify(normalizeRuntimeConfig(config))}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporaryPath, filePath)
      } catch (cause) {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
        if (cause instanceof RuntimeConfigError) throw cause
        throw error('UNAVAILABLE', 'config: durable state could not be saved')
      }
    },
  }
}

export function createRuntimeConfigStore(
  persistence: RuntimeConfigPersistence,
  initial: VersionedRuntimeConfig = createEmptyRuntimeConfig(),
): RuntimeConfigStore {
  const persisted = persistence.load()
  let state = normalizeRuntimeConfig(persisted ?? initial)
  if (persisted === undefined) persistence.save(clone(state))
  let applyInFlight = false

  const commit = (expectedRevision: number, mutate: (config: VersionedRuntimeConfig) => VersionedRuntimeConfig): VersionedRuntimeConfig => {
    assertExpectedRevision(state, expectedRevision)
    const next = commitAccepted(state, persistence, mutate)
    state = next
    return clone(state)
  }

  return {
    read: () => clone(state),
    readEffective: () => clone({
      acceptedRevision: state.acceptedRevision,
      ...(state.effectiveRevision === undefined ? {} : { effectiveRevision: state.effectiveRevision }),
      ...(state.lastApplyError === undefined ? {} : { lastApplyError: state.lastApplyError }),
    }),
    listProviderInstances: () => clone(Object.values(state.providers)),
    putProviderInstance: (expectedRevision, provider) => {
      validateProvider(provider)
      return commit(expectedRevision, current => {
        const previous = current.providers[provider.id]
        const catalogs = providerChanged(previous, provider)
          ? { ...current.catalogs, [provider.id]: invalidateCatalog(catalogFor(current, provider.id)) }
          : current.catalogs
        return { ...current, providers: { ...current.providers, [provider.id]: provider }, catalogs }
      })
    },
    removeProviderInstance: (expectedRevision, providerInstanceId) => commit(expectedRevision, current => {
      requireNonEmpty(providerInstanceId, 'provider id')
      const binding = Object.entries(current.agents).find(([, candidate]) => candidate.primary.providerInstanceId === providerInstanceId || candidate.backup?.providerInstanceId === providerInstanceId)
      if (binding !== undefined) throw error('CONFLICT', `config: provider ${providerInstanceId} is referenced by Agent binding ${binding[0]}`, { providerInstanceId })
      if (current.providers[providerInstanceId] === undefined) throw error('NOT_FOUND', `config: provider ${providerInstanceId} not found`, { providerInstanceId })
      const { [providerInstanceId]: _removedProvider, ...providers } = current.providers
      const { [providerInstanceId]: _removedCatalog, ...catalogs } = current.catalogs
      return { ...current, providers, catalogs }
    }),
    putModelEntry: (expectedRevision, entry) => {
      validateModelEntry(entry)
      return commit(expectedRevision, current => {
        if (current.providers[entry.ref.providerInstanceId] === undefined) throw error('NOT_FOUND', `config: provider ${entry.ref.providerInstanceId} not found`, { providerInstanceId: entry.ref.providerInstanceId })
        const catalog = replaceEntry(catalogFor(current, entry.ref.providerInstanceId), entry)
        return { ...current, catalogs: { ...current.catalogs, [entry.ref.providerInstanceId]: catalog } }
      })
    },
    bindAgentModel: (expectedRevision, agentId, binding) => commit(expectedRevision, current => {
      requireNonEmpty(agentId, 'agent id')
      assertBindingTargets(current, binding)
      return { ...current, agents: { ...current.agents, [agentId]: binding } }
    }),
    selectAgentBackup: (expectedRevision, agentId, backup) => commit(expectedRevision, current => {
      const existing = current.agents[agentId]
      if (existing === undefined) throw error('NOT_FOUND', `config: Agent ${agentId} binding not found`)
      const next = backup === undefined ? { primary: existing.primary } : { primary: existing.primary, backup }
      assertBindingTargets(current, next)
      return { ...current, agents: { ...current.agents, [agentId]: next } }
    }),
    refreshProviderModels: async (expectedRevision, providerInstanceId, client, credentials) => {
      assertExpectedRevision(state, expectedRevision)
      const provider = state.providers[providerInstanceId]
      if (provider === undefined) throw error('NOT_FOUND', `config: provider ${providerInstanceId} not found`, { providerInstanceId })
      let descriptors: readonly ProviderModelDescriptor[]
      try {
        const credential = provider.auth.kind === 'bearer'
          ? await (credentials === undefined
            ? Promise.reject(error('CREDENTIAL_UNAVAILABLE', `config: credential resolver is required for ${providerInstanceId}`, { providerInstanceId }))
            : credentials.resolve(provider.auth.credentialRef))
          : undefined
        descriptors = await client.listModels({ provider: clone(provider), credential })
        validateDescriptors(descriptors, providerInstanceId)
      } catch (cause) {
        if (state.acceptedRevision !== expectedRevision) throw error('REVISION_CONFLICT', `config: refresh completed against stale revision ${expectedRevision}`)
        const refreshError = publicError(cause, providerInstanceId)
        const failedCatalog: ProviderModelCatalog = {
          ...catalogFor(state, providerInstanceId),
          state: 'error',
          error: refreshError,
        }
        const observed = commitAccepted(state, persistence, current => ({
          ...current,
          catalogs: { ...current.catalogs, [providerInstanceId]: failedCatalog },
        }))
        state = observed
        return { status: 'error' as const, config: clone(observed), error: clone(refreshError) }
      }
      if (state.acceptedRevision !== expectedRevision) throw error('REVISION_CONFLICT', `config: refresh completed against stale revision ${expectedRevision}`)
      const merged = mergeCatalog(catalogFor(state, providerInstanceId), providerInstanceId, descriptors)
      const committed = commitAccepted(state, persistence, current => ({
        ...current,
        catalogs: { ...current.catalogs, [providerInstanceId]: merged },
      }))
      state = committed
      return { status: merged.state === 'empty' ? 'empty' as const : 'ready' as const, config: clone(committed) }
    },
    applyAcceptedConfig: async applier => {
      if (applyInFlight) throw error('CONFLICT', 'config: apply already in progress')
      applyInFlight = true
      try {
        const accepted = clone(state)
        let result: ConfigApplyResult
        try {
          result = await applier.apply(accepted)
        } catch (cause) {
          result = { status: 'failed', error: publicError(cause) }
        }
        if (result.status === 'applied') {
          if (result.effectiveRevision !== accepted.acceptedRevision) {
            const invalid = error('INVALID_INPUT', 'config: applier returned a mismatched effective revision')
            const observed = withObservation(state, { lastApplyError: invalid.toJSON() })
            persistence.save(clone(observed))
            state = observed
            return { status: 'failed', error: invalid.toJSON() }
          }
          const observed = withObservation(state, { effectiveRevision: result.effectiveRevision })
          persistence.save(clone(observed))
          state = observed
          return result
        }
        const observed = withObservation(state, { lastApplyError: result.error })
        persistence.save(clone(observed))
        state = observed
        return result
      } finally {
        applyInFlight = false
      }
    },
  }
}

export function readAgentRuntimeConfig(config: VersionedRuntimeConfig, agentId: string): AgentRuntimeConfig {
  const binding = normalizeRuntimeConfig(config).agents[agentId]
  if (binding === undefined) throw error('NOT_FOUND', `config: Agent ${agentId} binding not found`)
  return binding
}

export function saveAgentRuntimeConfig(
  config: VersionedRuntimeConfig,
  agentId: string,
  next: AgentRuntimeConfig,
  expectedRevision: number,
): VersionedRuntimeConfig {
  const current = normalizeRuntimeConfig(config)
  assertExpectedRevision(current, expectedRevision)
  requireNonEmpty(agentId, 'agent id')
  assertBindingTargets(current, next)
  return withAcceptedRevision({ ...current, agents: { ...current.agents, [agentId]: next } }, current.acceptedRevision + 1)
}

export async function applyAgentRuntimeConfig(store: RuntimeConfigStore, applier: RuntimeConfigApplier): Promise<ConfigApplyResult> {
  return store.applyAcceptedConfig(applier)
}
