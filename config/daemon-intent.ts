import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type {
  AgentModelBinding,
  ModelEntry,
  ModelMetadata,
  ProviderInstance,
  VersionedRuntimeConfig,
} from './runtime-config.ts'
import type { AcpPolicyIntent } from './acp-policy.ts'

export type DaemonKind = 'agent' | 'control' | 'registry'
export type DaemonIntentVersion = 4
export type EngineKind = 'opencode' | 'dsh'
export type RelationRole = 'master' | 'peer'

/** Registry is the canonical public kind; the implementation reuses server/Relay. */
export type RegistryImplementation = 'server/Relay'

export type DaemonIntentErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_CONFIGURATION'
  | 'AUTHENTICATION_REQUIRED'

export class DaemonIntentError extends Error {
  readonly code: DaemonIntentErrorCode

  constructor(code: DaemonIntentErrorCode, message: string) {
    super(message)
    this.name = 'DaemonIntentError'
    this.code = code
  }
}

export interface DaemonIdentity<K extends DaemonKind = DaemonKind> {
  readonly kind: K
  readonly id: string
  readonly hostId: string
  readonly accountId: string
  readonly scopeId: string
  readonly dataDirectory: string
}

export interface EngineIntent {
  readonly kind: EngineKind
  /** Absolute installed executable. Resolution stays outside Config. */
  readonly executable?: string
  /** Relative paths resolve against the config file directory in compile. */
  readonly workspace?: string
}

export interface ListenIntent {
  readonly ip: string
  readonly port: number
  readonly tlsCertRef?: string
  readonly tlsKeyRef?: string
}

export interface WebUiAuthIntent {
  readonly username: string
  /** Existing Console auth uses a bare environment-variable name here. */
  readonly passwordEnv: string
}

export interface WebUiIntent {
  readonly ip: string
  readonly port: number
  readonly auth?: WebUiAuthIntent
  readonly allowedOrigin?: string
  readonly tlsCertRef?: string
  readonly tlsKeyRef?: string
}

export interface RelationsIntent {
  readonly allowed: readonly RelationRole[]
}

export interface DiscoveryServerConfig {
  readonly serverId: string
  readonly endpoint: string
  readonly credentialRef: string
  readonly tlsTrustRef: string
}

export interface PeerIntent {
  readonly agentId: string
  readonly hostId: string
  readonly accountId: string
  readonly scopeId: string
  readonly endpoint?: string
  readonly admissionRef?: string
  readonly credentialRef: string
  readonly tlsTrustRef?: string
}

export interface AdmissionIntent {
  readonly admissionRef: string
  readonly agentId: string
  readonly accountId: string
  readonly scopeId: string
  readonly credentialRef: string
}

export interface AgentDaemonIntent {
  readonly version: DaemonIntentVersion
  readonly daemon: DaemonIdentity<'agent'>
  readonly engine?: EngineIntent
  readonly listen?: ListenIntent
  readonly acp: AcpPolicyIntent
  readonly relations: RelationsIntent
  readonly admissions: readonly AdmissionIntent[]
  readonly discovery?: DiscoveryServerConfig
  readonly peers: Readonly<Record<string, PeerIntent>>
  readonly providers: Readonly<Record<string, ProviderInstance>>
  readonly models: readonly ModelEntry[]
  readonly model?: AgentModelBinding
}

export interface ControlDaemonIntent {
  readonly version: DaemonIntentVersion
  readonly daemon: DaemonIdentity<'control'>
  readonly webui: WebUiIntent
  readonly relations: RelationsIntent
  readonly admissions: readonly AdmissionIntent[]
  readonly discovery?: DiscoveryServerConfig
  readonly peers: Readonly<Record<string, PeerIntent>>
}

export interface RegistryDaemonIntent {
  readonly version: DaemonIntentVersion
  readonly daemon: DaemonIdentity<'registry'>
  readonly listen: ListenIntent
  readonly admissions: readonly AdmissionIntent[]
}

export type DaemonIntentV4 = AgentDaemonIntent | ControlDaemonIntent | RegistryDaemonIntent

const MODEL_METADATA_KEYS = [
  'label',
  'contextWindow',
  'maxOutputTokens',
  'tools',
  'streaming',
  'reasoning',
  'inputModalities',
  'outputModalities',
] as const

const DAEMON_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function fail(code: DaemonIntentErrorCode, message: string): never {
  throw new DaemonIntentError(code, message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_INPUT', `${label} must be a table`)
  }
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) fail('INVALID_INPUT', `${label} has unsupported fields: ${unknown.join(', ')}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_INPUT', `${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label)
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail('INVALID_INPUT', `${label} must be boolean`)
  return value
}

function stringArray(value: unknown, fallback: readonly string[], label: string): readonly string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail('INVALID_INPUT', `${label} must be an array of non-empty strings`)
  }
  return [...value] as string[]
}

function relationRoles(value: unknown, fallback: readonly RelationRole[], label: string): readonly RelationRole[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some(item => item !== 'master' && item !== 'peer')) {
    fail('INVALID_INPUT', `${label} must contain only master or peer`)
  }
  const roles = [...value] as RelationRole[]
  if (new Set(roles).size !== roles.length) fail('INVALID_INPUT', `${label} must not contain duplicates`)
  return roles
}

function numericPort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    fail('INVALID_INPUT', `${label} must be an integer from 1 to 65535`)
  }
  return value as number
}

function isLoopback(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith('127.')
  return ip === '::1'
}

function numericIp(value: unknown, label: string): string {
  const ip = requiredString(value, label)
  const version = isIP(ip)
  if (version !== 4 && version !== 6) fail('INVALID_INPUT', `${label} must be a numeric IPv4 or IPv6 address`)
  if (ip === '0.0.0.0' || ip === '::') fail('INVALID_INPUT', `${label} must not be a wildcard address`)
  return ip
}

function fileRef(value: unknown, label: string): string {
  const ref = requiredString(value, label)
  if (!ref.startsWith('file:')) fail('INVALID_INPUT', `${label} must use the file: reference form`)
  if (ref.length === 'file:'.length) fail('INVALID_INPUT', `${label} must name a file`)
  return ref
}

function credentialRef(value: unknown, label: string): string {
  const ref = requiredString(value, label)
  if (ref.startsWith('env:')) {
    if (!ENV_NAME.test(ref.slice('env:'.length))) {
      fail('INVALID_INPUT', `${label} must use env:NAME with a valid environment-variable name`)
    }
    return ref
  }
  if (ref.startsWith('file:')) return fileRef(ref, label)
  fail('INVALID_INPUT', `${label} must use env:NAME or file:relative-path`)
}

function parseTlsRefs(input: Record<string, unknown>, label: string): Pick<ListenIntent, 'tlsCertRef' | 'tlsKeyRef'> {
  const tlsCertRef = input.tlsCertRef === undefined ? undefined : fileRef(input.tlsCertRef, `${label}.tlsCertRef`)
  const tlsKeyRef = input.tlsKeyRef === undefined ? undefined : fileRef(input.tlsKeyRef, `${label}.tlsKeyRef`)
  if ((tlsCertRef === undefined) !== (tlsKeyRef === undefined)) {
    fail('INVALID_INPUT', `${label} TLS requires both tlsCertRef and tlsKeyRef`)
  }
  return {
    ...(tlsCertRef === undefined ? {} : { tlsCertRef }),
    ...(tlsKeyRef === undefined ? {} : { tlsKeyRef }),
  }
}

function parseIdentity<K extends DaemonKind>(value: unknown, kind: K): DaemonIdentity<K> {
  const input = record(value, 'daemon')
  fields(input, ['kind', 'id', 'hostId', 'accountId', 'scopeId', 'dataDirectory'], 'daemon')
  if (input.kind !== kind) fail('INVALID_INPUT', `daemon.kind must be ${kind}`)
  const id = requiredString(input.id, 'daemon.id')
  if (!DAEMON_ID.test(id)) fail('INVALID_INPUT', 'daemon.id is not valid')
  return {
    kind,
    id,
    hostId: requiredString(input.hostId, 'daemon.hostId'),
    accountId: requiredString(input.accountId, 'daemon.accountId'),
    scopeId: requiredString(input.scopeId, 'daemon.scopeId'),
    dataDirectory: requiredString(input.dataDirectory, 'daemon.dataDirectory'),
  }
}

function parseEngine(value: unknown): EngineIntent {
  const input = record(value, 'engine')
  fields(input, ['kind', 'executable', 'workspace'], 'engine')
  const kind = input.kind
  if (kind !== 'opencode' && kind !== 'dsh') fail('INVALID_INPUT', 'engine.kind must be opencode or dsh')
  const executable = optionalString(input.executable, 'engine.executable')
  if (executable !== undefined && !isAbsolute(executable)) {
    fail('INVALID_INPUT', 'engine.executable must be an absolute installed path')
  }
  const workspace = optionalString(input.workspace, 'engine.workspace')
  return {
    kind,
    ...(executable === undefined ? {} : { executable }),
    ...(workspace === undefined ? {} : { workspace }),
  }
}

function parseListen(value: unknown, label: string): ListenIntent {
  const input = record(value, label)
  fields(input, ['ip', 'port', 'tlsCertRef', 'tlsKeyRef'], label)
  return {
    ip: numericIp(input.ip, `${label}.ip`),
    port: numericPort(input.port, `${label}.port`),
    ...parseTlsRefs(input, label),
  }
}

function parseWebUiAuth(value: unknown): WebUiAuthIntent {
  const input = record(value, 'webui.auth')
  fields(input, ['username', 'passwordEnv'], 'webui.auth')
  const passwordEnv = requiredString(input.passwordEnv, 'webui.auth.passwordEnv')
  if (!ENV_NAME.test(passwordEnv)) {
    fail('INVALID_INPUT', 'webui.auth.passwordEnv must be an environment-variable name')
  }
  return { username: requiredString(input.username, 'webui.auth.username'), passwordEnv }
}

function parseWebUi(value: unknown): WebUiIntent {
  const input = record(value, 'webui')
  fields(input, ['ip', 'port', 'auth', 'allowedOrigin', 'tlsCertRef', 'tlsKeyRef'], 'webui')
  const ip = numericIp(input.ip, 'webui.ip')
  const auth = input.auth === undefined ? undefined : parseWebUiAuth(input.auth)
  const allowedOrigin = optionalString(input.allowedOrigin, 'webui.allowedOrigin')
  if (allowedOrigin !== undefined) {
    let origin: URL
    try {
      origin = new URL(allowedOrigin)
    } catch {
      fail('INVALID_INPUT', 'webui.allowedOrigin must be an http(s) URL')
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      fail('INVALID_INPUT', 'webui.allowedOrigin must be an http(s) URL')
    }
  }
  const tls = parseTlsRefs(input, 'webui')
  if (!isLoopback(ip)) {
    if (auth === undefined) fail('AUTHENTICATION_REQUIRED', 'non-loopback webui requires webui.auth')
    if (tls.tlsCertRef === undefined || tls.tlsKeyRef === undefined) {
      fail('INVALID_INPUT', 'non-loopback webui requires TLS certificate and key references')
    }
  }
  return {
    ip,
    port: numericPort(input.port, 'webui.port'),
    ...(auth === undefined ? {} : { auth }),
    ...(allowedOrigin === undefined ? {} : { allowedOrigin }),
    ...tls,
  }
}

function parseAcp(value: unknown): AcpPolicyIntent {
  if (value === undefined) {
    return { enabled: false, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' }
  }
  const input = record(value, 'acp')
  fields(input, ['enabled', 'required', 'blacklist', 'clientCapabilities', 'callbackExecutor'], 'acp')
  const callbackExecutor = input.callbackExecutor === undefined
    ? 'controller'
    : input.callbackExecutor
  if (callbackExecutor !== 'controller') fail('INVALID_INPUT', 'acp.callbackExecutor must be controller')
  return {
    enabled: boolean(input.enabled, false, 'acp.enabled'),
    required: stringArray(input.required, [], 'acp.required'),
    blacklist: stringArray(input.blacklist, [], 'acp.blacklist'),
    clientCapabilities: stringArray(input.clientCapabilities, [], 'acp.clientCapabilities'),
    callbackExecutor,
  }
}

function parseRelations(value: unknown): RelationsIntent {
  if (value === undefined) return { allowed: ['peer'] }
  const input = record(value, 'relations')
  fields(input, ['allowed'], 'relations')
  return { allowed: relationRoles(input.allowed, ['peer'], 'relations.allowed') }
}

function parseDiscovery(value: unknown): DiscoveryServerConfig {
  const input = record(value, 'discovery')
  fields(input, ['serverId', 'endpoint', 'credentialRef', 'tlsTrustRef'], 'discovery')
  const endpoint = requiredString(input.endpoint, 'discovery.endpoint')
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    fail('INVALID_INPUT', 'discovery.endpoint must be a valid wss URL')
  }
  if (url.protocol !== 'wss:') fail('INVALID_INPUT', 'discovery.endpoint must use wss')
  return {
    serverId: requiredString(input.serverId, 'discovery.serverId'),
    endpoint,
    credentialRef: credentialRef(input.credentialRef, 'discovery.credentialRef'),
    tlsTrustRef: fileRef(input.tlsTrustRef, 'discovery.tlsTrustRef'),
  }
}

function parsePeer(name: string, value: unknown): PeerIntent {
  const label = `peers.${name}`
  const input = record(value, label)
  fields(input, ['agentId', 'hostId', 'accountId', 'scopeId', 'endpoint', 'admissionRef', 'credentialRef', 'tlsTrustRef'], label)
  const endpoint = optionalString(input.endpoint, `${label}.endpoint`)
  if (endpoint !== undefined) {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      fail('INVALID_INPUT', `${label}.endpoint must be a valid wss URL`)
    }
    if (url.protocol !== 'wss:') fail('INVALID_INPUT', `${label}.endpoint must use wss`)
  }
  const tlsTrustRef = input.tlsTrustRef === undefined ? undefined : fileRef(input.tlsTrustRef, `${label}.tlsTrustRef`)
  if (endpoint !== undefined && tlsTrustRef === undefined) {
    fail('INVALID_INPUT', `${label}.tlsTrustRef is required when an endpoint is explicit`)
  }
  return {
    agentId: requiredString(input.agentId, `${label}.agentId`),
    hostId: requiredString(input.hostId, `${label}.hostId`),
    accountId: requiredString(input.accountId, `${label}.accountId`),
    scopeId: requiredString(input.scopeId, `${label}.scopeId`),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(input.admissionRef === undefined ? {} : { admissionRef: requiredString(input.admissionRef, `${label}.admissionRef`) }),
    credentialRef: credentialRef(input.credentialRef, `${label}.credentialRef`),
    ...(tlsTrustRef === undefined ? {} : { tlsTrustRef }),
  }
}

function parsePeers(value: unknown): Readonly<Record<string, PeerIntent>> {
  if (value === undefined) return {}
  const input = record(value, 'peers')
  return Object.fromEntries(Object.entries(input).map(([name, peer]) => [name, parsePeer(name, peer)]))
}

function parseAdmissions(value: unknown): readonly AdmissionIntent[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('INVALID_INPUT', 'admissions must be an array of tables')
  const admissions = value.map((entry, index) => {
    const label = `admissions[${index}]`
    const input = record(entry, label)
    fields(input, ['admissionRef', 'agentId', 'accountId', 'scopeId', 'credentialRef'], label)
    return {
      admissionRef: requiredString(input.admissionRef, `${label}.admissionRef`),
      agentId: requiredString(input.agentId, `${label}.agentId`),
      accountId: requiredString(input.accountId, `${label}.accountId`),
      scopeId: requiredString(input.scopeId, `${label}.scopeId`),
      credentialRef: credentialRef(input.credentialRef, `${label}.credentialRef`),
    }
  })
  const refs = admissions.map(entry => entry.admissionRef)
  if (new Set(refs).size !== refs.length) fail('INVALID_INPUT', 'admissions must not contain duplicate admissionRef values')
  return admissions
}

function parseProvider(id: string, value: unknown): ProviderInstance {
  const label = `providers.${id}`
  const input = record(value, label)
  fields(input, ['protocol', 'apiBaseUrl', 'label', 'enabled', 'credentialEnv'], label)
  const protocol = input.protocol
  if (protocol !== 'openai-chat' && protocol !== 'openai-responses') {
    fail('INVALID_INPUT', `${label}.protocol must be openai-chat or openai-responses`)
  }
  const apiBaseUrl = requiredString(input.apiBaseUrl, `${label}.apiBaseUrl`)
  let url: URL
  try {
    url = new URL(apiBaseUrl)
  } catch {
    fail('INVALID_INPUT', `${label}.apiBaseUrl must be a valid URL`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username.length > 0 || url.password.length > 0) {
    fail('INVALID_INPUT', `${label}.apiBaseUrl must be an http(s) URL without embedded credentials`)
  }
  const credentialEnv = optionalString(input.credentialEnv, `${label}.credentialEnv`)
  if (credentialEnv !== undefined && !ENV_NAME.test(credentialEnv)) {
    fail('INVALID_INPUT', `${label}.credentialEnv must be an environment-variable name`)
  }
  return {
    id,
    label: requiredString(input.label, `${label}.label`),
    protocol,
    apiBaseUrl,
    enabled: boolean(input.enabled, true, `${label}.enabled`),
    auth: credentialEnv === undefined ? { kind: 'none' } : { kind: 'bearer', credentialRef: credentialEnv },
  }
}

function parseModelMetadata(input: Record<string, unknown>, label: string): ModelMetadata {
  const metadata: Record<string, unknown> = {}
  for (const key of MODEL_METADATA_KEYS) {
    if (input[key] !== undefined) metadata[key] = input[key]
  }
  if (metadata.contextWindow !== undefined && (!Number.isInteger(metadata.contextWindow) || (metadata.contextWindow as number) < 1)) {
    fail('INVALID_INPUT', `${label}.contextWindow must be a positive integer`)
  }
  if (metadata.maxOutputTokens !== undefined && (!Number.isInteger(metadata.maxOutputTokens) || (metadata.maxOutputTokens as number) < 1)) {
    fail('INVALID_INPUT', `${label}.maxOutputTokens must be a positive integer`)
  }
  for (const key of ['inputModalities', 'outputModalities'] as const) {
    const value = metadata[key]
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0))) {
      fail('INVALID_INPUT', `${label}.${key} must be an array of non-empty strings`)
    }
  }
  for (const key of ['tools', 'streaming', 'reasoning'] as const) {
    if (metadata[key] !== undefined && typeof metadata[key] !== 'boolean') {
      fail('INVALID_INPUT', `${label}.${key} must be boolean`)
    }
  }
  if (metadata.label !== undefined && (typeof metadata.label !== 'string' || metadata.label.length === 0)) {
    fail('INVALID_INPUT', `${label}.label must be a non-empty string`)
  }
  return metadata as ModelMetadata
}

function parseModels(value: unknown): readonly ModelEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('INVALID_INPUT', 'models must be an array of tables')
  const models = value.map((entry, index) => {
    const label = `models[${index}]`
    const input = record(entry, label)
    fields(input, ['provider', 'id', ...MODEL_METADATA_KEYS], label)
    return {
      ref: {
        providerInstanceId: requiredString(input.provider, `${label}.provider`),
        modelId: requiredString(input.id, `${label}.id`),
      },
      origin: 'manual' as const,
      base: parseModelMetadata(input, label),
      overrides: {},
    }
  })
  const refs = models.map(entry => `${entry.ref.providerInstanceId}\u0000${entry.ref.modelId}`)
  if (new Set(refs).size !== refs.length) fail('INVALID_INPUT', 'models must not contain duplicate provider/model references')
  return models
}

function parseModelRef(value: unknown, label: string): { readonly providerInstanceId: string; readonly modelId: string } {
  const input = record(value, label)
  fields(input, ['provider', 'model'], label)
  return {
    providerInstanceId: requiredString(input.provider, `${label}.provider`),
    modelId: requiredString(input.model, `${label}.model`),
  }
}

function parseModel(value: unknown): AgentModelBinding {
  const input = record(value, 'model')
  fields(input, ['primary', 'backup'], 'model')
  const primary = parseModelRef(input.primary, 'model.primary')
  const backup = input.backup === undefined ? undefined : parseModelRef(input.backup, 'model.backup')
  if (backup !== undefined
    && backup.providerInstanceId === primary.providerInstanceId
    && backup.modelId === primary.modelId) {
    fail('INVALID_INPUT', 'model.backup must differ from model.primary')
  }
  return { primary, ...(backup === undefined ? {} : { backup }) }
}

function validateModelReferences(
  providers: Readonly<Record<string, ProviderInstance>>,
  models: readonly ModelEntry[],
  model: AgentModelBinding | undefined,
): void {
  const manual = new Set(models.map(entry => `${entry.ref.providerInstanceId}\u0000${entry.ref.modelId}`))
  for (const entry of models) {
    if (providers[entry.ref.providerInstanceId] === undefined) {
      fail('INVALID_INPUT', `models references unknown provider ${entry.ref.providerInstanceId}`)
    }
  }
  if (model === undefined) return
  for (const [slot, ref] of [['primary', model.primary], ['backup', model.backup]] as const) {
    if (ref === undefined) continue
    if (providers[ref.providerInstanceId] === undefined) {
      fail('INVALID_INPUT', `model.${slot} references unknown provider ${ref.providerInstanceId}`)
    }
    if (!manual.has(`${ref.providerInstanceId}\u0000${ref.modelId}`)) {
      fail('INVALID_INPUT', `model.${slot} references a model that is not declared by ${ref.providerInstanceId}`)
    }
  }
}

function parseAgent(root: Record<string, unknown>, daemon: DaemonIdentity<'agent'>): AgentDaemonIntent {
  fields(root, ['version', 'daemon', 'engine', 'listen', 'acp', 'relations', 'admissions', 'discovery', 'peers', 'providers', 'models', 'model'], 'agent daemon')
  const engine = root.engine === undefined ? undefined : parseEngine(root.engine)
  const listen = root.listen === undefined ? undefined : parseListen(root.listen, 'listen')
  const acp = parseAcp(root.acp)
  const admissions = parseAdmissions(root.admissions)
  if (acp.enabled && engine === undefined) fail('INVALID_INPUT', 'enabled acp requires engine')
  if (acp.enabled && listen === undefined) fail('INVALID_INPUT', 'enabled acp requires listen')
  if (listen !== undefined && !isLoopback(listen.ip)) {
    if (listen.tlsCertRef === undefined || listen.tlsKeyRef === undefined) {
      fail('INVALID_INPUT', 'non-loopback listen requires TLS certificate and key references')
    }
    if (admissions.length === 0) fail('INVALID_INPUT', 'non-loopback listen requires explicit admissions')
  }
  const providersInput = root.providers === undefined ? {} : record(root.providers, 'providers')
  const providers = Object.fromEntries(Object.entries(providersInput).map(([id, value]) => [id, parseProvider(id, value)]))
  const models = parseModels(root.models)
  const model = root.model === undefined ? undefined : parseModel(root.model)
  validateModelReferences(providers, models, model)
  return {
    version: 4,
    daemon,
    ...(engine === undefined ? {} : { engine }),
    ...(listen === undefined ? {} : { listen }),
    acp,
    relations: parseRelations(root.relations),
    admissions,
    ...(root.discovery === undefined ? {} : { discovery: parseDiscovery(root.discovery) }),
    peers: parsePeers(root.peers),
    providers,
    models,
    ...(model === undefined ? {} : { model }),
  }
}

function parseControl(root: Record<string, unknown>, daemon: DaemonIdentity<'control'>): ControlDaemonIntent {
  fields(root, ['version', 'daemon', 'webui', 'relations', 'admissions', 'discovery', 'peers'], 'control daemon')
  if (root.webui === undefined) fail('INVALID_INPUT', 'control daemon requires webui')
  return {
    version: 4,
    daemon,
    webui: parseWebUi(root.webui),
    relations: parseRelations(root.relations),
    admissions: parseAdmissions(root.admissions),
    ...(root.discovery === undefined ? {} : { discovery: parseDiscovery(root.discovery) }),
    peers: parsePeers(root.peers),
  }
}

function parseRegistry(root: Record<string, unknown>, daemon: DaemonIdentity<'registry'>): RegistryDaemonIntent {
  fields(root, ['version', 'daemon', 'listen', 'admissions'], 'registry daemon')
  if (root.listen === undefined) fail('INVALID_INPUT', 'relay daemon requires listen')
  const listen = parseListen(root.listen, 'listen')
  const admissions = parseAdmissions(root.admissions)
  if (!isLoopback(listen.ip)) {
    if (listen.tlsCertRef === undefined || listen.tlsKeyRef === undefined) {
      fail('INVALID_INPUT', 'non-loopback listen requires TLS certificate and key references')
    }
    if (admissions.length === 0) fail('INVALID_INPUT', 'non-loopback listen requires explicit admissions')
  }
  return { version: 4, daemon, listen, admissions }
}

export function parseDaemonIntent(value: unknown): DaemonIntentV4 {
  const root = record(value, 'daemon config')
  if (root.version !== 4) {
    fail('UNSUPPORTED_CONFIGURATION', 'daemon config version must be 4')
  }
  const daemonInput = record(root.daemon, 'daemon')
  const kind = daemonInput.kind
  if (kind !== 'agent' && kind !== 'control' && kind !== 'registry') {
    fail('INVALID_INPUT', 'daemon.kind must be agent, control, or registry')
  }
  if (kind === 'agent') return parseAgent(root, parseIdentity(root.daemon, 'agent'))
  if (kind === 'control') return parseControl(root, parseIdentity(root.daemon, 'control'))
  return parseRegistry(root, parseIdentity(root.daemon, 'registry'))
}

function resolvePath(value: string, configDirectory: string): string {
  const expanded = value === '~'
    ? homedir()
    : value.startsWith('~/')
      ? resolve(homedir(), value.slice(2))
      : value
  return isAbsolute(expanded) ? resolve(expanded) : resolve(configDirectory, expanded)
}

function resolveFileRef(ref: string, configDirectory: string): string {
  const path = ref.slice('file:'.length)
  return `file:${resolvePath(path, configDirectory)}`
}

function resolveCredentialRef(ref: string, configDirectory: string): string {
  return ref.startsWith('env:') ? ref : resolveFileRef(ref, configDirectory)
}

function resolveDiscovery(discovery: DiscoveryServerConfig, configDirectory: string): DiscoveryServerConfig {
  return {
    ...discovery,
    credentialRef: resolveCredentialRef(discovery.credentialRef, configDirectory),
    tlsTrustRef: resolveFileRef(discovery.tlsTrustRef, configDirectory),
  }
}

function resolvePeer(peer: PeerIntent, configDirectory: string): PeerIntent {
  return {
    ...peer,
    credentialRef: resolveCredentialRef(peer.credentialRef, configDirectory),
    ...(peer.tlsTrustRef === undefined ? {} : { tlsTrustRef: resolveFileRef(peer.tlsTrustRef, configDirectory) }),
  }
}

function resolveAdmission(admission: AdmissionIntent, configDirectory: string): AdmissionIntent {
  return { ...admission, credentialRef: resolveCredentialRef(admission.credentialRef, configDirectory) }
}

function resolveListen<T extends ListenIntent>(listen: T, configDirectory: string): T {
  return {
    ...listen,
    ...(listen.tlsCertRef === undefined ? {} : { tlsCertRef: resolveFileRef(listen.tlsCertRef, configDirectory) }),
    ...(listen.tlsKeyRef === undefined ? {} : { tlsKeyRef: resolveFileRef(listen.tlsKeyRef, configDirectory) }),
  }
}

/**
 * Resolve every filesystem-bearing field without reading a secret or changing
 * the source file. Runtime consumes this resolved value for launch wiring.
 */
export function resolveDaemonIntent(
  intent: DaemonIntentV4,
  context: { readonly configDirectory: string },
): DaemonIntentV4 {
  const configDirectory = resolve(context.configDirectory)
  if (intent.daemon.kind === 'agent') {
    const agent = intent as AgentDaemonIntent
    return {
      ...agent,
      daemon: { ...agent.daemon, dataDirectory: resolvePath(agent.daemon.dataDirectory, configDirectory) },
      ...(agent.engine === undefined ? {} : {
        engine: {
          ...agent.engine,
          ...(agent.engine.workspace === undefined ? {} : { workspace: resolvePath(agent.engine.workspace, configDirectory) }),
        },
      }),
      ...(agent.listen === undefined ? {} : { listen: resolveListen(agent.listen, configDirectory) }),
      ...(agent.discovery === undefined ? {} : { discovery: resolveDiscovery(agent.discovery, configDirectory) }),
      admissions: agent.admissions.map(admission => resolveAdmission(admission, configDirectory)),
      peers: Object.fromEntries(Object.entries(agent.peers).map(([name, peer]) => [name, resolvePeer(peer, configDirectory)])),
    }
  }
  if (intent.daemon.kind === 'control') {
    const control = intent as ControlDaemonIntent
    return {
      ...control,
      daemon: { ...control.daemon, dataDirectory: resolvePath(control.daemon.dataDirectory, configDirectory) },
      webui: {
        ...control.webui,
        ...(control.webui.tlsCertRef === undefined ? {} : { tlsCertRef: resolveFileRef(control.webui.tlsCertRef, configDirectory) }),
        ...(control.webui.tlsKeyRef === undefined ? {} : { tlsKeyRef: resolveFileRef(control.webui.tlsKeyRef, configDirectory) }),
      },
      ...(control.discovery === undefined ? {} : { discovery: resolveDiscovery(control.discovery, configDirectory) }),
      admissions: control.admissions.map(admission => resolveAdmission(admission, configDirectory)),
      peers: Object.fromEntries(Object.entries(control.peers).map(([name, peer]) => [name, resolvePeer(peer, configDirectory)])),
    }
  }
  const registry = intent as RegistryDaemonIntent
  return {
    ...registry,
    daemon: { ...registry.daemon, dataDirectory: resolvePath(registry.daemon.dataDirectory, configDirectory) },
    listen: resolveListen(registry.listen, configDirectory),
    admissions: registry.admissions.map(admission => resolveAdmission(admission, configDirectory)),
  }
}

function compileAgentConfig(intent: AgentDaemonIntent): VersionedRuntimeConfig {
  const catalogs: Record<string, { state: 'ready' | 'empty'; entries: readonly ModelEntry[] }> = {}
  for (const provider of Object.values(intent.providers)) {
    const entries = intent.models.filter(entry => entry.ref.providerInstanceId === provider.id)
    catalogs[provider.id] = { state: entries.length === 0 ? 'empty' : 'ready', entries }
  }
  return {
    revision: 1,
    acceptedRevision: 1,
    providers: intent.providers,
    catalogs,
    agents: intent.model === undefined ? {} : { [intent.daemon.id]: intent.model },
  }
}

/**
 * Compile one v4 intent into the existing accepted runtime config shape.
 * The versioned config intentionally has no effectiveRevision.
 */
export function compileDaemonIntent(
  intent: DaemonIntentV4,
  context: { readonly configDirectory: string },
): VersionedRuntimeConfig {
  // Resolve launch paths before returning the accepted snapshot. The resolved
  // value stays available through resolveDaemonIntent for runtime launch wiring.
  resolveDaemonIntent(intent, context)
  if (intent.daemon.kind === 'agent') return compileAgentConfig(intent as AgentDaemonIntent)
  return { revision: 1, acceptedRevision: 1, providers: {}, catalogs: {}, agents: {} }
}
