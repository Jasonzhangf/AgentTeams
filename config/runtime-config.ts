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

export type ConfigErrorCode = ServiceErrorCode | 'CREDENTIAL_UNAVAILABLE' | 'SOURCE_CHANGED' | 'MIGRATION_CONFLICT' | 'APPLY_TARGET_MISMATCH'

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

/** Accepted user-intent snapshot for one daemon; also the machine-agnostic view shape. */
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

/** Exact identity of one configuration target at the moment an operation starts. */
export interface ConfigTargetIdentity {
  readonly agentId: string
  readonly targetGeneration: number
  readonly acceptedRevision: number
  readonly acceptedSourceRevision: number
  readonly acceptedSourceHash: string
  readonly endpointFingerprint: string
  readonly credentialRef?: string
}

/** Merged machine-source + target-daemon accepted/effective/catalog observation. */
export interface DaemonRuntimeConfigView extends VersionedRuntimeConfig {
  readonly agentId: string
  readonly sourceRevision: number
  readonly sourceHash: string
  readonly acceptedSourceRevision: number
  readonly acceptedSourceHash: string
  readonly applyState: 'clean' | 'uncertain'
  readonly targetGeneration: number
}

/** Per-daemon discovered catalog observation; never contains manual entries. */
export interface ProviderCatalogObservation {
  readonly state: ModelCatalogState
  readonly discoveredEntries: readonly ModelEntry[]
  readonly refreshedAt?: string
  readonly error?: ConfigApplyError
  readonly providerFingerprint: string
  readonly observedAcceptedRevision: number
  readonly observedAcceptedSourceRevision: number
  readonly observedAcceptedSourceHash: string
  readonly observedEndpoint: string
  readonly observedCredentialRef?: string
}

export interface ManagedOperationIdentity {
  readonly operationId: string
  readonly kind: 'apply' | 'use-session'
  readonly target: ConfigTargetIdentity
  readonly substrate: {
    readonly pid?: number
    readonly effectiveRevision: number
    readonly effectiveHandleFingerprint: string
  }
}

export interface ManagedConfigUncertainty {
  readonly target: ConfigTargetIdentity
  readonly operation: {
    readonly operationId: string
    readonly kind: 'apply' | 'use-session'
  }
  readonly error: ConfigApplyError
  readonly substrate: {
    readonly pid?: number
    readonly effectiveRevision: number
    readonly effectiveHandleFingerprint: string
  }
}

export interface ManagedConfigUncertaintyFence {
  /** One record per ambiguous exchange/replacement; upsert by operationId, never a single overwrite. */
  readonly operations: readonly ManagedConfigUncertainty[]
}

export interface RuntimeConfigApplyRequest {
  readonly target: ConfigTargetIdentity
  readonly config: DaemonRuntimeConfigView
}

export type ConfigApplyResult =
  | { readonly status: 'applied'; readonly effectiveRevision: number }
  | { readonly status: 'unsupported' | 'failed'; readonly error: ConfigApplyError }
  | { readonly status: 'uncertain'; readonly error: ConfigApplyError; readonly fence: ManagedConfigUncertainty }

export interface RuntimeConfigApplier {
  apply(request: RuntimeConfigApplyRequest): Promise<ConfigApplyResult>
}

export interface RefreshResult {
  readonly status: 'ready' | 'empty' | 'error'
  readonly config: DaemonRuntimeConfigView
  readonly error?: ConfigApplyError
}

/** Store-owned user-intent sections that map to `config.toml` providers/models/bindings. */
export interface RuntimeConfigStoreSections {
  readonly providers: Readonly<Record<string, ProviderInstance>>
  readonly models: readonly ModelEntry[]
  readonly bindings: Readonly<Record<string, AgentModelBinding>>
}

export interface RuntimeConfigTargetObservationPatch {
  readonly kind: 'target-observation'
  readonly catalogObservations?: Readonly<Record<string, ProviderCatalogObservation>>
  readonly effectiveRevision?: number
  readonly lastApplyError?: ConfigApplyError | null
  readonly applyState?: 'clean' | 'uncertain'
  readonly uncertain?: ManagedConfigUncertainty
  readonly expectedUncertain?: ManagedConfigUncertainty
  readonly removeUncertainOperationId?: string
  readonly target: ConfigTargetIdentity
}

export interface RuntimeConfigOwnerFencePatch {
  readonly kind: 'owner-fence'
  readonly uncertain: ManagedConfigUncertainty
  readonly expectedUncertain?: ManagedConfigUncertainty
}

export type RuntimeConfigObservationPatch = RuntimeConfigTargetObservationPatch | RuntimeConfigOwnerFencePatch

/**
 * Async persistence port. Every `*Unlocked` method assumes the caller already holds
 * `withLock`; it never re-enters the lock or performs external provider/OpenCode work.
 */
export interface RuntimeConfigPersistence {
  readonly agentId?: string
  withLock<T>(task: () => Promise<T>): Promise<T>
  loadDaemonUnlocked(agentId: string): Promise<DaemonRuntimeConfigView>
  saveMachineSourceUnlocked(input: {
    readonly expectedSourceRevision: number
    readonly expectedSourceHash: string
    readonly sections: RuntimeConfigStoreSections
  }): Promise<{ readonly sourceRevision: number; readonly sourceHash: string }>
  acceptMachineSourceUnlocked(agentId: string, input: {
    readonly sourceRevision: number
    readonly sourceHash: string
    readonly expectedAcceptedRevision: number
    readonly expectedAcceptedSourceHash: string | undefined
  }): Promise<{ readonly acceptedRevision: number; readonly acceptedSourceRevision: number; readonly acceptedSourceHash: string }>
  saveObservationUnlocked(agentId: string, patch: RuntimeConfigObservationPatch): Promise<void>
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

export interface RuntimeConfigStore {
  read(): Promise<DaemonRuntimeConfigView>
  readEffective(): Promise<{
    readonly acceptedRevision: number
    readonly acceptedSourceRevision: number
    readonly acceptedSourceHash: string
    readonly effectiveRevision?: number
    readonly applyState: 'clean' | 'uncertain'
    readonly lastApplyError?: ConfigApplyError
  }>
  listProviderInstances(): Promise<readonly ProviderInstance[]>
  putProviderInstance(expectedRevision: number, provider: ProviderInstance): Promise<DaemonRuntimeConfigView>
  removeProviderInstance(expectedRevision: number, providerInstanceId: string): Promise<DaemonRuntimeConfigView>
  putModelEntry(expectedRevision: number, entry: ModelEntry): Promise<DaemonRuntimeConfigView>
  bindAgentModel(expectedRevision: number, agentId: string, binding: AgentModelBinding): Promise<DaemonRuntimeConfigView>
  selectAgentBackup(expectedRevision: number, agentId: string, backup?: ModelRef): Promise<DaemonRuntimeConfigView>
  refreshProviderModels(
    expectedRevision: number,
    providerInstanceId: string,
    client: ProviderModelClient,
    credentials?: CredentialResolver,
  ): Promise<RefreshResult>
  applyAcceptedConfig(applier: RuntimeConfigApplier): Promise<ConfigApplyResult>
}

export interface RuntimeConfigStoreOptions {
  readonly agentId?: string
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

function providerChanged(previous: ProviderInstance | undefined, next: ProviderInstance): boolean {
  if (previous === undefined) return false
  return previous.label !== next.label
    || previous.protocol !== next.protocol
    || previous.apiBaseUrl !== next.apiBaseUrl
    || previous.enabled !== next.enabled
    || previous.auth.kind !== next.auth.kind
    || (previous.auth.kind === 'bearer' && next.auth.kind === 'bearer' && previous.auth.credentialRef !== next.auth.credentialRef)
}

function replaceEntry(catalog: ProviderModelCatalog, next: ModelEntry): ProviderModelCatalog {
  const key = modelKey(next.ref)
  const index = catalog.entries.findIndex(entry => modelKey(entry.ref) === key)
  const entries = index < 0
    ? [...catalog.entries, next]
    : catalog.entries.map((entry, entryIndex) => entryIndex === index ? next : entry)
  return { state: 'ready', entries, refreshedAt: catalog.refreshedAt }
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
  existing: ProviderModelCatalog | undefined,
  manualEntries: readonly ModelEntry[],
  providerInstanceId: string,
  descriptors: readonly ProviderModelDescriptor[],
): ProviderModelCatalog {
  const discovered = new Map(descriptors.map(descriptor => [descriptor.modelId, descriptor] as const))
  const manualKeys = new Set(manualEntries.map(entry => entry.ref.modelId))
  for (const modelId of manualKeys) discovered.delete(modelId)
  const manual = new Map(manualEntries.map(entry => [entry.ref.modelId, entry] as const))
  const entries: ModelEntry[] = []
  const seen = new Set<string>()
  for (const entry of existing?.entries ?? []) {
    if (entry.ref.providerInstanceId !== providerInstanceId) continue
    if (entry.origin === 'manual') {
      const current = manual.get(entry.ref.modelId)
      if (current !== undefined && !seen.has(entry.ref.modelId)) {
        seen.add(entry.ref.modelId)
        entries.push(current)
      }
      continue
    }
    const current = discovered.get(entry.ref.modelId)
    if (current === undefined) {
      entries.push({ ...entry, availability: 'unavailable' as const })
      continue
    }
    discovered.delete(entry.ref.modelId)
    entries.push({ ...entry, base: current.metadata, availability: 'available' as const })
  }
  for (const entry of manualEntries) {
    if (seen.has(entry.ref.modelId)) continue
    seen.add(entry.ref.modelId)
    entries.push(entry)
  }
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
    state: descriptors.length === 0 && entries.length === 0 ? 'empty' : 'ready',
    entries,
    refreshedAt: new Date().toISOString(),
  }
}

function manualModels(config: VersionedRuntimeConfig): readonly ModelEntry[] {
  return Object.values(config.catalogs).flatMap(catalog => catalog.entries.filter(entry => entry.origin === 'manual'))
}

function sectionsOf(config: VersionedRuntimeConfig): RuntimeConfigStoreSections {
  return {
    providers: config.providers,
    models: manualModels(config).map(entry => clone(entry)),
    bindings: config.agents,
  }
}

export function providerIntentFingerprint(provider: ProviderInstance): string {
  return JSON.stringify({
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    apiBaseUrl: provider.apiBaseUrl,
    enabled: provider.enabled,
    auth: provider.auth,
  })
}

export function targetIdentityFor(view: DaemonRuntimeConfigView, provider?: ProviderInstance): ConfigTargetIdentity {
  return {
    agentId: view.agentId,
    targetGeneration: view.targetGeneration,
    acceptedRevision: view.acceptedRevision,
    acceptedSourceRevision: view.acceptedSourceRevision,
    acceptedSourceHash: view.acceptedSourceHash,
    endpointFingerprint: provider === undefined ? '' : providerIntentFingerprint(provider),
    ...(provider?.auth.kind === 'bearer' ? { credentialRef: provider.auth.credentialRef } : {}),
  }
}

function targetMatches(view: DaemonRuntimeConfigView, target: ConfigTargetIdentity, provider?: ProviderInstance): boolean {
  if (view.acceptedRevision !== target.acceptedRevision) return false
  if (view.acceptedSourceRevision !== target.acceptedSourceRevision) return false
  if (view.acceptedSourceHash !== target.acceptedSourceHash) return false
  if (view.targetGeneration !== target.targetGeneration) return false
  if (provider !== undefined) {
    if (providerIntentFingerprint(provider) !== target.endpointFingerprint) return false
    const credentialRef = provider.auth.kind === 'bearer' ? provider.auth.credentialRef : undefined
    if (credentialRef !== target.credentialRef) return false
  }
  return true
}

function fenceKey(fence: ManagedConfigUncertainty): string {
  return fence.operation.operationId
}

export function readUncertaintyFence(view: DaemonRuntimeConfigView): ManagedConfigUncertaintyFence {
  const raw = (view as DaemonRuntimeConfigView & { readonly uncertain?: readonly ManagedConfigUncertainty[] }).uncertain ?? []
  return { operations: raw }
}

/** Legacy JSON adapter retained only for migration fixtures and unit tests, never as a daemon entry. */
export function createJsonFileConfigPersistence(filePath: string): RuntimeConfigPersistence {
  interface FileState {
    sourceRevision: number
    sourceHash: string
    machineText: string
    accepted: Record<string, { acceptedRevision: number; acceptedSourceRevision: number; acceptedSourceHash: string; snapshot: VersionedRuntimeConfig }>
    effective: Record<string, { effectiveRevision?: number; applyState?: 'clean' | 'uncertain'; lastApplyError?: ConfigApplyError; uncertain?: readonly ManagedConfigUncertainty[] }>
    catalogs: Record<string, Record<string, ProviderCatalogObservation>>
  }
  const hash = (text: string): string => `sha256:${Buffer.from(text, 'utf8').toString('hex')}`
  const empty = (): FileState => ({ sourceRevision: 0, sourceHash: hash(''), machineText: '{}', accepted: {}, effective: {}, catalogs: {} })
  let queue: Promise<unknown> = Promise.resolve()
  const readState = (): FileState => {
    if (!existsSync(filePath)) return empty()
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<FileState>
      return {
        sourceRevision: parsed.sourceRevision ?? 0,
        sourceHash: parsed.sourceHash ?? hash(parsed.machineText ?? '{}'),
        machineText: parsed.machineText ?? '{}',
        accepted: parsed.accepted ?? {},
        effective: parsed.effective ?? {},
        catalogs: parsed.catalogs ?? {},
      }
    } catch (cause) {
      if (cause instanceof RuntimeConfigError) throw cause
      throw error('INVALID_INPUT', 'config: durable state is not valid JSON')
    }
  }
  const writeState = (state: FileState): void => {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, filePath)
    } catch (cause) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      throw error('UNAVAILABLE', 'config: durable state could not be saved')
    }
  }
  const parseMachine = (state: FileState): RuntimeConfigStoreSections => {
    try {
      const parsed = JSON.parse(state.machineText) as RuntimeConfigStoreSections
      return { providers: parsed.providers ?? {}, models: parsed.models ?? [], bindings: parsed.bindings ?? {} }
    } catch {
      throw error('INVALID_INPUT', 'config: durable machine source is not valid JSON')
    }
  }
  const buildView = (state: FileState, agentId: string): DaemonRuntimeConfigView => {
    const sections = parseMachine(state)
    const accepted = state.accepted[agentId]
    const snapshot = accepted?.snapshot ?? {
      revision: 0, acceptedRevision: 0, providers: sections.providers, catalogs: {}, agents: sections.bindings,
    }
    const effective = state.effective[agentId] ?? {}
    const observations = state.catalogs[agentId] ?? {}
    const catalogs: Record<string, ProviderModelCatalog> = {}
    const manual = manualModels(snapshot)
    for (const provider of Object.values(snapshot.providers)) {
      const observation = observations[provider.id]
      const manualEntries = manual.filter(entry => entry.ref.providerInstanceId === provider.id)
      if (observation !== undefined && observation.providerFingerprint === providerIntentFingerprint(provider)) {
        catalogs[provider.id] = {
          state: observation.state,
          entries: [...manualEntries, ...observation.discoveredEntries],
          ...(observation.refreshedAt === undefined ? {} : { refreshedAt: observation.refreshedAt }),
          ...(observation.error === undefined ? {} : { error: observation.error }),
        }
      } else if (observation !== undefined) {
        catalogs[provider.id] = { state: 'stale', entries: manualEntries.map(entry => ({ ...entry, availability: 'unavailable' })) }
      } else {
        catalogs[provider.id] = { state: manualEntries.length > 0 ? 'ready' : 'empty', entries: manualEntries }
      }
    }
    const view = normalizeRuntimeConfig({
      revision: accepted?.acceptedRevision ?? 0,
      acceptedRevision: accepted?.acceptedRevision ?? 0,
      ...(effective.effectiveRevision === undefined ? {} : { effectiveRevision: effective.effectiveRevision }),
      providers: snapshot.providers,
      catalogs,
      agents: snapshot.agents,
      ...(effective.lastApplyError === undefined ? {} : { lastApplyError: effective.lastApplyError }),
    }) as DaemonRuntimeConfigView
    return {
      ...view,
      agentId,
      sourceRevision: state.sourceRevision,
      sourceHash: state.sourceHash,
      acceptedSourceRevision: accepted?.acceptedSourceRevision ?? 0,
      acceptedSourceHash: accepted?.acceptedSourceHash ?? '',
      applyState: effective.applyState ?? 'clean',
      targetGeneration: 1,
      ...(effective.uncertain === undefined ? {} : { uncertain: effective.uncertain }),
    } as DaemonRuntimeConfigView & { uncertain?: readonly ManagedConfigUncertainty[] }
  }
  return {
    withLock: async <T>(task: () => Promise<T>): Promise<T> => {
      const run = queue.then(task, task)
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    loadDaemonUnlocked: async (agentId: string) => buildView(readState(), agentId),
    saveMachineSourceUnlocked: async input => {
      const state = readState()
      if (state.sourceRevision !== input.expectedSourceRevision || state.sourceHash !== input.expectedSourceHash) {
        throw error('SOURCE_CHANGED', 'config: machine source changed during mutation')
      }
      const machineText = JSON.stringify(input.sections)
      const next: FileState = { ...state, sourceRevision: state.sourceRevision + 1, sourceHash: hash(machineText), machineText }
      writeState(next)
      return { sourceRevision: next.sourceRevision, sourceHash: next.sourceHash }
    },
    acceptMachineSourceUnlocked: async (agentId, input) => {
      const state = readState()
      const current = state.accepted[agentId]
      if ((current?.acceptedRevision ?? 0) !== input.expectedAcceptedRevision) {
        throw error('REVISION_CONFLICT', 'config: accepted revision changed during mutation')
      }
      if ((current?.acceptedSourceHash ?? '') !== (input.expectedAcceptedSourceHash ?? '')) {
        throw error('SOURCE_CHANGED', 'config: accepted source changed during mutation')
      }
      const sections = parseMachine(state)
      const acceptedRevision = (current?.acceptedRevision ?? 0) + 1
      const catalogs: Record<string, ProviderModelCatalog> = {}
      const previous = current?.snapshot.catalogs ?? {}
      for (const provider of Object.values(sections.providers)) {
        const manual = sections.models.filter(entry => entry.ref.providerInstanceId === provider.id).map(entry => clone(entry))
        const discovered = (previous[provider.id]?.entries ?? []).filter(entry => entry.origin === 'discovered').map(entry => clone(entry))
        const entries = [...manual, ...discovered]
        catalogs[provider.id] = {
          state: entries.length > 0 ? 'ready' : 'empty',
          entries,
          ...(previous[provider.id]?.refreshedAt === undefined ? {} : { refreshedAt: previous[provider.id]!.refreshedAt }),
        }
      }
      const snapshot = normalizeRuntimeConfig({
        revision: acceptedRevision, acceptedRevision,
        providers: sections.providers, catalogs, agents: sections.bindings,
      })
      const next: FileState = {
        ...state,
        accepted: { ...state.accepted, [agentId]: {
          acceptedRevision, acceptedSourceRevision: input.sourceRevision, acceptedSourceHash: input.sourceHash, snapshot,
        } },
      }
      writeState(next)
      return { acceptedRevision, acceptedSourceRevision: input.sourceRevision, acceptedSourceHash: input.sourceHash }
    },
    saveObservationUnlocked: async (agentId, patch) => {
      const state = readState()
      if (patch.kind === 'owner-fence') {
        const effective = state.effective[agentId] ?? {}
        const existing = effective.uncertain ?? []
        const key = fenceKey(patch.uncertain)
        const index = existing.findIndex(record => fenceKey(record) === key)
        if (index >= 0 && patch.expectedUncertain === undefined) throw error('CONFLICT', 'config: uncertainty record already exists')
        const uncertain = index < 0 ? [...existing, patch.uncertain] : existing.map((record, i) => i === index ? patch.uncertain : record)
        const next: FileState = { ...state, effective: { ...state.effective, [agentId]: { ...effective, applyState: 'uncertain', uncertain } } }
        writeState(next)
        return
      }
      const current = buildView(state, agentId)
      if (!targetMatches(current, patch.target)) {
        throw error(patch.target.acceptedRevision !== current.acceptedRevision ? 'REVISION_CONFLICT' : 'APPLY_TARGET_MISMATCH', 'config: observation target no longer matches')
      }
      const effective = { ...(state.effective[agentId] ?? {}) }
      if (patch.effectiveRevision !== undefined) effective.effectiveRevision = patch.effectiveRevision
      if (patch.lastApplyError === null) delete effective.lastApplyError
      else if (patch.lastApplyError !== undefined) effective.lastApplyError = patch.lastApplyError
      if (patch.uncertain !== undefined) {
        const existing = effective.uncertain ?? []
        const key = fenceKey(patch.uncertain)
        const index = existing.findIndex(record => fenceKey(record) === key)
        effective.uncertain = index < 0
          ? [...existing, patch.uncertain]
          : existing.map((record, i) => (i === index ? patch.uncertain! : record))
      }
      if (patch.removeUncertainOperationId !== undefined) {
        const existing = effective.uncertain ?? []
        const target = existing.find(record => record.operation.operationId === patch.removeUncertainOperationId)
        if (target === undefined || patch.expectedUncertain === undefined || fenceKey(patch.expectedUncertain) !== patch.removeUncertainOperationId) {
          throw error('CONFLICT', 'config: uncertainty removal does not match an existing record')
        }
        effective.uncertain = existing.filter(record => record.operation.operationId !== patch.removeUncertainOperationId)
      }
      if ((effective.uncertain ?? []).length > 0) effective.applyState = 'uncertain'
      else if (patch.applyState !== undefined) effective.applyState = patch.applyState
      else if (effective.applyState === 'uncertain' && patch.removeUncertainOperationId !== undefined) effective.applyState = 'clean'
      const catalogs = { ...state.catalogs }
      if (patch.catalogObservations !== undefined) {
        catalogs[agentId] = { ...(catalogs[agentId] ?? {}), ...patch.catalogObservations }
      }
      const next: FileState = { ...state, effective: { ...state.effective, [agentId]: effective }, catalogs }
      writeState(next)
    },
  }
}

export function createRuntimeConfigStore(
  persistence: RuntimeConfigPersistence,
  options: RuntimeConfigStoreOptions = {},
): RuntimeConfigStore {
  const agentId = options.agentId ?? persistence.agentId ?? 'default'
  let applyInFlight = false
  const load = () => persistence.loadDaemonUnlocked(agentId)
  const assertAcceptedSource = (view: DaemonRuntimeConfigView): void => {
    if (view.acceptedSourceHash !== '' && view.sourceHash !== view.acceptedSourceHash) {
      throw error('SOURCE_CHANGED', 'config: config.toml has unaccepted changes; explicit accept required')
    }
  }
  const mutate = async (
    expectedRevision: number,
    change: (current: DaemonRuntimeConfigView) => VersionedRuntimeConfig,
  ): Promise<DaemonRuntimeConfigView> => persistence.withLock(async () => {
    const current = await load()
    assertExpectedRevision(current, expectedRevision)
    assertAcceptedSource(current)
    const next = change(current)
    const saved = await persistence.saveMachineSourceUnlocked({
      expectedSourceRevision: current.sourceRevision,
      expectedSourceHash: current.sourceHash,
      sections: sectionsOf(next),
    })
    await persistence.acceptMachineSourceUnlocked(agentId, {
      sourceRevision: saved.sourceRevision,
      sourceHash: saved.sourceHash,
      expectedAcceptedRevision: current.acceptedRevision,
      expectedAcceptedSourceHash: current.acceptedSourceHash,
    })
    return load()
  })
  return {
    read: () => persistence.withLock(load),
    readEffective: async () => {
      const view = await persistence.withLock(load)
      return {
        acceptedRevision: view.acceptedRevision,
        acceptedSourceRevision: view.acceptedSourceRevision,
        acceptedSourceHash: view.acceptedSourceHash,
        ...(view.effectiveRevision === undefined ? {} : { effectiveRevision: view.effectiveRevision }),
        applyState: view.applyState,
        ...(view.lastApplyError === undefined ? {} : { lastApplyError: view.lastApplyError }),
      }
    },
    listProviderInstances: async () => clone(Object.values((await persistence.withLock(load)).providers)),
    putProviderInstance: (expectedRevision, provider) => {
      validateProvider(provider)
      return mutate(expectedRevision, current => ({
        ...current,
        providers: { ...current.providers, [provider.id]: provider },
        catalogs: { ...current.catalogs, [provider.id]: catalogFor(current, provider.id) },
      }))
    },
    removeProviderInstance: (expectedRevision, providerInstanceId) => mutate(expectedRevision, current => {
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
      if (entry.origin === 'discovered') {
        return persistence.withLock(async () => {
          const current = await load()
          assertExpectedRevision(current, expectedRevision)
          assertAcceptedSource(current)
          const provider = current.providers[entry.ref.providerInstanceId]
          if (provider === undefined) throw error('NOT_FOUND', `config: provider ${entry.ref.providerInstanceId} not found`, { providerInstanceId: entry.ref.providerInstanceId })
          const catalog = replaceEntry(catalogFor(current, entry.ref.providerInstanceId), entry)
          await persistence.saveObservationUnlocked(agentId, {
            kind: 'target-observation',
            catalogObservations: {
              [entry.ref.providerInstanceId]: {
                state: catalog.state,
                discoveredEntries: catalog.entries.filter(candidate => candidate.origin === 'discovered'),
                ...(catalog.refreshedAt === undefined ? {} : { refreshedAt: catalog.refreshedAt }),
                providerFingerprint: providerIntentFingerprint(provider),
                observedAcceptedRevision: current.acceptedRevision,
                observedAcceptedSourceRevision: current.acceptedSourceRevision,
                observedAcceptedSourceHash: current.acceptedSourceHash,
                observedEndpoint: provider.apiBaseUrl,
                ...(provider.auth.kind === 'bearer' ? { observedCredentialRef: provider.auth.credentialRef } : {}),
              },
            },
            target: targetIdentityFor(current, provider),
          })
          return load()
        })
      }
      return mutate(expectedRevision, current => {
        if (current.providers[entry.ref.providerInstanceId] === undefined) throw error('NOT_FOUND', `config: provider ${entry.ref.providerInstanceId} not found`, { providerInstanceId: entry.ref.providerInstanceId })
        const catalog = replaceEntry(catalogFor(current, entry.ref.providerInstanceId), entry)
        return { ...current, catalogs: { ...current.catalogs, [entry.ref.providerInstanceId]: catalog } }
      })
    },
    bindAgentModel: (expectedRevision, boundAgentId, binding) => mutate(expectedRevision, current => {
      requireNonEmpty(boundAgentId, 'agent id')
      assertBindingTargets(current, binding)
      return { ...current, agents: { ...current.agents, [boundAgentId]: binding } }
    }),
    selectAgentBackup: (expectedRevision, boundAgentId, backup) => mutate(expectedRevision, current => {
      const existing = current.agents[boundAgentId]
      if (existing === undefined) throw error('NOT_FOUND', `config: Agent ${boundAgentId} binding not found`)
      const next = backup === undefined ? { primary: existing.primary } : { primary: existing.primary, backup }
      assertBindingTargets(current, next)
      return { ...current, agents: { ...current.agents, [boundAgentId]: next } }
    }),
    refreshProviderModels: async (expectedRevision, providerInstanceId, client, credentials) => {
      const captured = await persistence.withLock(async () => {
        const current = await load()
        assertExpectedRevision(current, expectedRevision)
        assertAcceptedSource(current)
        const provider = current.providers[providerInstanceId]
        if (provider === undefined) throw error('NOT_FOUND', `config: provider ${providerInstanceId} not found`, { providerInstanceId })
        return { provider, target: targetIdentityFor(current, provider) }
      })
      const reconcile = async (observation: ProviderCatalogObservation | { readonly refreshError: ConfigApplyError }): Promise<RefreshResult> => persistence.withLock(async () => {
        const current = await load()
        if (!targetMatches(current, captured.target, current.providers[providerInstanceId])) {
          throw error('REVISION_CONFLICT', `config: refresh completed against stale revision ${expectedRevision}`)
        }
        const provider = current.providers[providerInstanceId]!
        const catalogObservations = 'refreshError' in observation
          ? { [providerInstanceId]: {
              state: 'error' as const,
              discoveredEntries: current.catalogs[providerInstanceId]?.entries.filter(entry => entry.origin === 'discovered') ?? [],
              error: observation.refreshError,
              providerFingerprint: providerIntentFingerprint(provider),
              observedAcceptedRevision: captured.target.acceptedRevision,
              observedAcceptedSourceRevision: captured.target.acceptedSourceRevision,
              observedAcceptedSourceHash: captured.target.acceptedSourceHash,
              observedEndpoint: provider.apiBaseUrl,
              ...(captured.target.credentialRef === undefined ? {} : { observedCredentialRef: captured.target.credentialRef }),
            } }
          : { [providerInstanceId]: observation }
        await persistence.saveObservationUnlocked(agentId, { kind: 'target-observation', catalogObservations, target: captured.target })
        const next = await load()
        return 'refreshError' in observation
          ? { status: 'error' as const, config: next, error: observation.refreshError }
          : { status: observation.state === 'empty' ? 'empty' as const : 'ready' as const, config: next }
      })
      let descriptors: readonly ProviderModelDescriptor[]
      try {
        const credential = captured.provider.auth.kind === 'bearer'
          ? await (credentials === undefined
            ? Promise.reject(error('CREDENTIAL_UNAVAILABLE', `config: credential resolver is required for ${providerInstanceId}`, { providerInstanceId }))
            : credentials.resolve(captured.provider.auth.credentialRef))
          : undefined
        descriptors = await client.listModels({ provider: clone(captured.provider), credential })
        validateDescriptors(descriptors, providerInstanceId)
      } catch (cause) {
        return reconcile({ refreshError: publicError(cause, providerInstanceId) })
      }
      const merged = await persistence.withLock(async () => {
        const current = await load()
        const manual = manualModels(current).filter(entry => entry.ref.providerInstanceId === providerInstanceId)
        return mergeCatalog(current.catalogs[providerInstanceId], manual, providerInstanceId, descriptors)
      })
      return reconcile({
        state: merged.state,
        discoveredEntries: merged.entries.filter(entry => entry.origin === 'discovered'),
        ...(merged.refreshedAt === undefined ? {} : { refreshedAt: merged.refreshedAt }),
        providerFingerprint: providerIntentFingerprint(captured.provider),
        observedAcceptedRevision: captured.target.acceptedRevision,
        observedAcceptedSourceRevision: captured.target.acceptedSourceRevision,
        observedAcceptedSourceHash: captured.target.acceptedSourceHash,
        observedEndpoint: captured.provider.apiBaseUrl,
        ...(captured.target.credentialRef === undefined ? {} : { observedCredentialRef: captured.target.credentialRef }),
      })
    },
    applyAcceptedConfig: async applier => {
      if (applyInFlight) throw error('CONFLICT', 'config: apply already in progress')
      applyInFlight = true
      try {
        const captured = await persistence.withLock(async () => {
          const current = await load()
          assertAcceptedSource(current)
          const binding = current.agents[agentId]
          const provider = binding === undefined ? undefined : current.providers[binding.primary.providerInstanceId]
          return { target: targetIdentityFor(current, provider), config: current }
        })
        let result: ConfigApplyResult
        try {
          result = await applier.apply({ target: captured.target, config: captured.config })
        } catch (cause) {
          result = { status: 'failed', error: publicError(cause) }
        }
        return await persistence.withLock(async () => {
          const current = await load()
          if (current.acceptedRevision !== captured.target.acceptedRevision) {
            throw error('REVISION_CONFLICT', 'config: apply completed against a stale accepted revision')
          }
          if (result.status === 'applied') {
            if (result.effectiveRevision !== current.acceptedRevision) {
              const invalid = error('INVALID_INPUT', 'config: applier returned a mismatched effective revision')
              await persistence.saveObservationUnlocked(agentId, { kind: 'target-observation', lastApplyError: invalid.toJSON(), target: captured.target })
              return { status: 'failed' as const, error: invalid.toJSON() }
            }
            await persistence.saveObservationUnlocked(agentId, {
              kind: 'target-observation', effectiveRevision: result.effectiveRevision, applyState: 'clean', lastApplyError: null, target: captured.target,
            })
            return result
          }
          if (result.status === 'uncertain') {
            await persistence.saveObservationUnlocked(agentId, { kind: 'owner-fence', uncertain: result.fence })
            return result
          }
          await persistence.saveObservationUnlocked(agentId, { kind: 'target-observation', lastApplyError: result.error, target: captured.target })
          return result
        })
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
