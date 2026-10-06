import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, randomUUID, X509Certificate } from 'node:crypto'
import { parse as parseToml } from 'toml'
import { createServer as createNetServer } from 'node:net'
import { promisify } from 'node:util'
import { providerIntentFingerprint, RuntimeConfigError } from '../config/runtime-config.ts'
import { processAlive } from './local-ownership.ts'
import type {
  AgentModelBinding,
  ConfigApplyError,
  ConfigTargetIdentity,
  DaemonRuntimeConfigView,
  ManagedConfigUncertainty,
  ModelEntry,
  ModelMetadata,
  ProviderCatalogObservation,
  ProviderInstance,
  RuntimeConfigObservationPatch,
  RuntimeConfigPersistence,
  RuntimeConfigStoreSections,
  VersionedRuntimeConfig,
} from '../config/runtime-config.ts'

const LOCAL_CONFIG_VERSION = 1

export interface LocalRelaySpec {
  readonly enabled: boolean
  readonly configPath: string
}

export interface LocalDaemonSpec {
  readonly id: string
  readonly enabled: boolean
  readonly configPath: string
  readonly role?: 'provider' | 'receiver' | 'hybrid'
  readonly connection?: LocalConnectionIntent
  readonly services?: readonly LocalServiceIntent[]
}

/** Simplified v3 user service intent; U3 owns adapter schemas and execution. */
export interface LocalServiceIntent {
  readonly capabilityId: string
  readonly version: string
  readonly operations: readonly string[]
  readonly resources: readonly {
    readonly resourceId: string
    readonly capacity: number
    readonly unit: 'slot' | 'context'
  }[]
}

export interface LocalConnectionIntent {
  readonly targetAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly demands: readonly { readonly resourceId: string; readonly amount: number }[]
}

export interface LocalConfig {
  readonly version: 1 | 2 | 3
  readonly configPath: string
  readonly relay: LocalRelaySpec
  readonly daemons: readonly LocalDaemonSpec[]
  /** U2 projection ref for the optional Console child; absent when console is disabled. */
  readonly console?: LocalConsoleSpec
  readonly internalPath?: string
  readonly bridge?: { readonly enabled: boolean }
  readonly v3Input?: { readonly agents: Readonly<Record<string, unknown>>; readonly console?: Readonly<Record<string, unknown>> }
}

export interface LocalConsoleSpec {
  readonly enabled: true
  readonly configPath: string
}

export interface LocalInternalConfig {
  readonly version: 1 | 2
  readonly sourceRevision?: number
  readonly sourceHash?: string
  readonly configRevision?: string
  readonly sourcePath?: string
  readonly generatedAt?: string
  readonly updatedAt?: string
  readonly launcher?: LocalInternalLauncherConfig
  readonly workControl?: LocalInternalWorkControl
  readonly relay?: {
    readonly projectionPath?: string
    readonly config?: string
  }
  readonly console?: {
    readonly projectionPath?: string
    readonly config?: string
  }
  readonly consoleRuntime?: LocalInternalConsoleRuntime
  readonly configRuntime?: LocalInternalConfigRuntime
  readonly migration?: LocalInternalMigration
  readonly daemons?: Readonly<Record<string, LocalInternalDaemonConfig>>
}

/** Per-daemon accepted user-intent slice; `snapshot` is the JSON serialized VersionedRuntimeConfig subset. */
export interface LocalInternalConfigRuntimeAccepted {
  readonly acceptedRevision: number
  readonly acceptedSourceRevision: number
  readonly acceptedSourceHash: string
  readonly snapshot?: string
}

/** Per-daemon effective/apply fact slice; `uncertain` is the JSON serialized uncertainty fence record set. */
export interface LocalInternalConfigRuntimeEffective {
  readonly effectiveRevision?: number
  readonly applyState?: 'clean' | 'uncertain'
  readonly lastApplyError?: string
  readonly uncertain?: string
}

/** Per-daemon discovered catalog observation; `entries` is the JSON serialized discovered-only model list. */
export interface LocalInternalConfigRuntimeCatalog {
  readonly state: 'ready' | 'empty' | 'stale' | 'error'
  readonly refreshedAt?: string
  readonly error?: string
  readonly providerFingerprint?: string
  readonly observedAcceptedRevision?: number
  readonly observedAcceptedSourceRevision?: number
  readonly observedAcceptedSourceHash?: string
  readonly observedEndpoint?: string
  readonly observedCredentialRef?: string
  readonly entries?: string
}

export interface LocalInternalConfigRuntime {
  readonly accepted: Readonly<Record<string, LocalInternalConfigRuntimeAccepted>>
  readonly effective: Readonly<Record<string, LocalInternalConfigRuntimeEffective>>
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, LocalInternalConfigRuntimeCatalog>>>>
}

export type ConsoleRuntimeState = 'disabled' | 'stopped' | 'starting' | 'online' | 'stopping' | 'failed' | 'retained'

export interface ConsoleRuntimeError {
  readonly code: string
  readonly message: string
}

/** U5-owned lifecycle fields; U2 only reloads, merges and atomically rewrites this closed table. */
export interface LocalInternalConsoleRuntime {
  readonly enabled?: boolean
  readonly pid?: number
  readonly generation?: number
  readonly startToken?: string
  readonly entryPath?: string
  readonly state?: ConsoleRuntimeState
  readonly url?: string
  readonly origin?: string
  readonly identityRef?: string
  readonly error?: ConsoleRuntimeError
}

export interface LocalInternalMigrationInput {
  readonly kind: string
  readonly path: string
  readonly sha256: string
}

export interface LocalInternalMigration {
  readonly formatVersion: number
  readonly phase: 'prepared' | 'config-committed' | 'verified'
  readonly preparedAt: string
  readonly committedAt?: string
  readonly verifiedAt?: string
  readonly fromConfigVersion: number
  readonly fromInternalVersion: number
  readonly sourcePath: string
  readonly sourceBeforeHash: string
  readonly intendedSourceHash: string
  readonly candidateConfigText: string
  readonly legacyInputs: readonly LocalInternalMigrationInput[]
  readonly consoleMigrationInput?: { readonly path: string; readonly sha256: string }
  readonly recovery: string
}

export interface LocalInternalLauncherConfig {
  readonly pid: number
  readonly generation: number
  readonly startToken?: string
  readonly state: 'starting' | 'running' | 'stopped' | 'failed'
  readonly error?: string
}

export interface LocalInternalWorkControl {
  readonly socketPath: string
  readonly launcherGeneration: number
  readonly launcherStartToken: string
}

export interface LocalLauncherControl {
  readonly generation: number
  readonly startToken: string
}

export interface LocalLauncherOwnerRecord {
  readonly version: 1
  readonly pid: number
  readonly startToken: string
}

export interface LocalInternalDaemonConfig {
  readonly projectionPath?: string
  readonly enabled?: boolean
  readonly orphaned?: boolean
  readonly entryPath?: string
  readonly startToken?: string
  readonly role?: 'provider' | 'receiver' | 'hybrid'
  readonly config?: string
  readonly pid?: number
  readonly generation?: number
  readonly state?: 'online' | 'stopped' | 'failed'
}

export class LocalConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'LocalConfigError'
  }
}

const execFileAsync = promisify(execFile)

interface LocalBridgeTlsPaths {
  readonly directory: string
  readonly keyFile: string
  readonly certFile: string
}

function localBridgeTlsPaths(agentteamsDirectory: string): LocalBridgeTlsPaths {
  const directory = resolve(agentteamsDirectory, '.internal', 'tls')
  return {
    directory,
    keyFile: resolve(directory, 'relay-key.pem'),
    certFile: resolve(directory, 'relay-cert.pem'),
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function assertOwnedPrivatePath(stats: Awaited<ReturnType<typeof lstat>>, path: string, kind: 'directory' | 'file'): void {
  if (stats.isSymbolicLink()) throw new LocalConfigError(`local bridge TLS ${kind} must not be a symbolic link: ${path}`)
  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) throw new LocalConfigError(`local bridge TLS ${kind} is not owned by the current user: ${path}`)
  if ((Number(stats.mode) & 0o077) !== 0) throw new LocalConfigError(`local bridge TLS ${kind} permissions must not grant group or other access: ${path}`)
}

function assertLocalBridgeTlsMaterial(keyText: string, certText: string, paths: LocalBridgeTlsPaths): void {
  let key
  let certificate
  try {
    key = createPrivateKey(keyText)
    certificate = new X509Certificate(certText)
  } catch (cause) {
    throw new LocalConfigError(`local bridge TLS material is invalid: ${paths.directory}`, cause)
  }
  const keyPublic = createPublicKey(key).export({ type: 'spki', format: 'pem' })
  const certPublic = certificate.publicKey.export({ type: 'spki', format: 'pem' })
  if (keyPublic !== certPublic) throw new LocalConfigError(`local bridge TLS private key does not match its certificate: ${paths.directory}`)
  const now = Date.now()
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new LocalConfigError(`local bridge TLS certificate is not currently valid: ${paths.certFile}`)
  }
}

async function existingLocalBridgeTls(paths: LocalBridgeTlsPaths): Promise<'absent' | 'valid'> {
  let directoryStats
  try {
    directoryStats = await lstat(paths.directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw new LocalConfigError(`local bridge TLS directory cannot be read: ${paths.directory}`, cause)
  }
  if (!directoryStats.isDirectory()) throw new LocalConfigError(`local bridge TLS path is not a directory: ${paths.directory}`)
  assertOwnedPrivatePath(directoryStats, paths.directory, 'directory')
  let keyStats
  try {
    keyStats = await lstat(paths.keyFile)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LocalConfigError(`local bridge TLS material cannot be read: ${paths.directory}`, cause)
    }
    try {
      await lstat(paths.certFile)
    } catch (certificateCause) {
      if ((certificateCause as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      throw new LocalConfigError(`local bridge TLS material cannot be read: ${paths.directory}`, certificateCause)
    }
    throw new LocalConfigError(`local bridge TLS material is incomplete in ${paths.directory}: relay-key.pem and relay-cert.pem must both exist`)
  }
  let certStats
  try {
    certStats = await lstat(paths.certFile)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LocalConfigError(`local bridge TLS material is incomplete in ${paths.directory}: relay-key.pem and relay-cert.pem must both exist`)
    }
    throw new LocalConfigError(`local bridge TLS material cannot be read: ${paths.directory}`, cause)
  }
  if (!keyStats.isFile() || !certStats.isFile()) throw new LocalConfigError(`local bridge TLS key and certificate must be regular files: ${paths.directory}`)
  assertOwnedPrivatePath(keyStats, paths.keyFile, 'file')
  assertOwnedPrivatePath(certStats, paths.certFile, 'file')
  assertLocalBridgeTlsMaterial(await readFile(paths.keyFile, 'utf8'), await readFile(paths.certFile, 'utf8'), paths)
  return 'valid'
}

/**
 * Runtime-owned local bridge TLS bootstrap. The caller holds the same
 * internal.toml short lock used by config admission; existing material is
 * validated and never overwritten.
 */
async function ensureLocalBridgeTls(agentteamsDirectory: string): Promise<LocalBridgeTlsPaths> {
  const paths = localBridgeTlsPaths(agentteamsDirectory)
  if (await existingLocalBridgeTls(paths) === 'valid') return paths

  const parent = dirname(paths.directory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporaryDirectory = resolve(parent, `.tls-${randomUUID()}`)
  const temporaryKey = resolve(temporaryDirectory, 'relay-key.pem')
  const temporaryCert = resolve(temporaryDirectory, 'relay-cert.pem')
  await mkdir(temporaryDirectory, { recursive: false, mode: 0o700 })
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', temporaryKey, '-out', temporaryCert,
    ])
    await Promise.all([chmod(temporaryKey, 0o600), chmod(temporaryCert, 0o600)])
    await assertLocalBridgeTlsMaterial(await readFile(temporaryKey, 'utf8'), await readFile(temporaryCert, 'utf8'), {
      directory: temporaryDirectory,
      keyFile: temporaryKey,
      certFile: temporaryCert,
    })
    await rename(temporaryDirectory, paths.directory)
  } catch (cause) {
    try { await rm(temporaryDirectory, { recursive: true, force: true }) } catch { /* preserve the original failure */ }
    if (cause instanceof LocalConfigError) throw cause
    const detail = (cause as { stderr?: string }).stderr?.trim()
    throw new LocalConfigError(`cannot generate local bridge TLS material in ${paths.directory}${detail === undefined ? '' : `: ${detail}`}`, cause)
  }
  return paths
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalConfigError(`${label} must be a TOML table`)
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new LocalConfigError(`${label} has unsupported fields: ${unknown.join(', ')}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new LocalConfigError(`${label} must be a non-empty string`)
  return value
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new LocalConfigError(`${label} must be boolean`)
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new LocalConfigError(`${label} must be one of: ${allowed.join(', ')}`)
  return value as T
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) throw new LocalConfigError(`${label} must be a safe integer`)
  return value as number
}

function localPath(value: string, baseDirectory: string): string {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDirectory, expanded)
}

function connection(value: unknown, label: string): LocalConnectionIntent {
  const input = object(value, label)
  fields(input, ['targetAgentId', 'capabilityId', 'capabilityVersion', 'operation', 'demands'], label)
  const textField = (key: string): string => requiredString(input[key], `${label}.${key}`)
  if (!Array.isArray(input.demands) || input.demands.length === 0) throw new LocalConfigError(`${label}.demands must be a non-empty array`)
  const demands = input.demands.map((value, index) => {
    const item = object(value, `${label}.demands[${index}]`)
    fields(item, ['resourceId', 'amount'], `${label}.demands[${index}]`)
    const resourceId = requiredString(item.resourceId, `${label}.demands[${index}].resourceId`)
    if (!Number.isSafeInteger(item.amount) || (item.amount as number) < 1) throw new LocalConfigError(`${label}.demands[${index}].amount must be positive`)
    return { resourceId, amount: item.amount as number }
  })
  return { targetAgentId: textField('targetAgentId'), capabilityId: textField('capabilityId'), capabilityVersion: textField('capabilityVersion'),
    operation: textField('operation'), demands }
}

function endpointConfig(input: Record<string, unknown>, id: string, configPath: string): { readonly spec: LocalDaemonSpec; readonly json: Record<string, unknown> } {
  fields(input, ['enabled', 'role', 'connect', 'identity', 'scopeId', 'dataDirectory', 'leasePort', 'presenceIntervalMs', 'policy', 'cli', 'relay', 'openCode', 'directListener'], `endpoints.${id}`)
  const enabled = boolean(input.enabled, true, `endpoints.${id}.enabled`)
  const role = input.role
  if (role !== 'provider' && role !== 'receiver' && role !== 'hybrid') throw new LocalConfigError(`endpoints.${id}.role must be provider, receiver, or hybrid`)
  const connect = input.connect === undefined ? undefined : connection(input.connect, `endpoints.${id}.connect`)
  if ((role === 'receiver' || role === 'hybrid') && connect === undefined) throw new LocalConfigError(`endpoints.${id}.connect is required for ${role} endpoint`)
  const pathValue = (value: unknown): unknown => typeof value === 'string' ? localPath(value, dirname(configPath)) : value
  const json: Record<string, unknown> = { version: 1 }
  for (const key of ['identity', 'scopeId', 'dataDirectory', 'leasePort', 'presenceIntervalMs', 'policy', 'cli', 'relay', 'openCode', 'directListener']) {
    if (input[key] !== undefined) json[key] = input[key]
  }
  if (typeof input.dataDirectory === 'string') json.dataDirectory = pathValue(input.dataDirectory)
  if (input.cli !== undefined) {
    const cli = object(input.cli, `endpoints.${id}.cli`)
    json.cli = { ...cli, camoExecutable: pathValue(cli.camoExecutable), searchExecutable: pathValue(cli.searchExecutable), searchRoot: pathValue(cli.searchRoot) }
  }
  if (input.relay !== undefined) {
    const relay = object(input.relay, `endpoints.${id}.relay`)
    json.relay = { ...relay, ...(relay.caFile === undefined ? {} : { caFile: pathValue(relay.caFile) }) }
  }
  if (input.openCode !== undefined) {
    const openCode = object(input.openCode, `endpoints.${id}.openCode`)
    json.openCode = { ...openCode, executable: pathValue(openCode.executable), directory: pathValue(openCode.directory), configFile: pathValue(openCode.configFile) }
  }
  if (input.directListener !== undefined) {
    const direct = object(input.directListener, `endpoints.${id}.directListener`)
    json.directListener = { ...direct, keyFile: pathValue(direct.keyFile), certFile: pathValue(direct.certFile) }
  }
  json.endpoint = { role, ...(connect === undefined ? {} : { connect }) }
  const generatedPath = resolve(dirname(configPath), '.internal', 'endpoints', `${id}.json`)
  return { spec: { id, enabled, configPath: generatedPath, role, ...(connect === undefined ? {} : { connection: connect }) }, json }
}

async function materializeEndpoint(configPath: string, json: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporary = `${configPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, configPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

type TomlRecord = Record<string, unknown>

function isTomlRecord(value: unknown): value is TomlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function isTomlTableArray(value: unknown): value is TomlRecord[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => isTomlRecord(item))
}

function tomlScalar(value: unknown, label: string): string {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LocalConfigError(`${label} cannot be serialized to TOML`)
    return Number.isInteger(value) ? String(value) : JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return `[${value.map((item, index) => tomlScalar(item, `${label}[${index}]`)).join(', ')}]`
  throw new LocalConfigError(`${label} cannot be serialized to TOML`)
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

function tomlPath(path: readonly string[]): string {
  return path.map(tomlKey).join('.')
}

function emitTomlTable(lines: string[], table: TomlRecord, path: readonly string[], label: string): void {
  const entries = Object.entries(table).filter(([, value]) => value !== undefined)
  for (const [key, value] of entries) {
    if (isTomlRecord(value) || isTomlTableArray(value)) continue
    lines.push(`${tomlKey(key)} = ${tomlScalar(value, `${label}.${key}`)}`)
  }
  for (const [key, value] of entries) {
    if (!isTomlRecord(value)) continue
    const nextPath = [...path, key]
    const header = path.length === 1 && path[0] === 'daemon' ? `daemon.${tomlString(key)}` : tomlPath(nextPath)
    lines.push('', `[${header}]`)
    emitTomlTable(lines, value, [...path, key], `${label}.${key}`)
  }
  for (const [key, value] of entries) {
    if (!isTomlTableArray(value)) continue
    for (const [index, item] of value.entries()) {
      lines.push('', `[[${tomlPath([...path, key])}]]`)
      emitTomlTable(lines, item, [...path, key], `${label}.${key}[${index}]`)
    }
  }
}

/** Deterministic TOML serializer used by the internal state and store-owned config rewrite. */
export function serializeTomlDocument(root: TomlRecord): string {
  const lines: string[] = []
  emitTomlTable(lines, root, [], 'toml')
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

function serializeLocalInternalConfig(internal: LocalInternalConfig): string {
  const root: TomlRecord = { version: internal.version }
  for (const key of ['sourceRevision', 'sourceHash', 'configRevision', 'sourcePath', 'generatedAt', 'updatedAt'] as const) {
    const value = internal[key]
    if (value !== undefined) root[key] = value
  }
  if (internal.relay !== undefined) {
    root.relay = {
      ...(internal.relay.projectionPath === undefined ? {} : { projectionPath: internal.relay.projectionPath }),
      ...(internal.relay.config === undefined ? {} : { config: internal.relay.config }),
    }
  }
  if (internal.console !== undefined) {
    root.console = {
      ...(internal.console.projectionPath === undefined ? {} : { projectionPath: internal.console.projectionPath }),
      ...(internal.console.config === undefined ? {} : { config: internal.console.config }),
    }
  }
  if (internal.consoleRuntime !== undefined) {
    const runtime = internal.consoleRuntime
    root.consoleRuntime = {
      ...(runtime.enabled === undefined ? {} : { enabled: runtime.enabled }),
      ...(runtime.pid === undefined ? {} : { pid: runtime.pid }),
      ...(runtime.generation === undefined ? {} : { generation: runtime.generation }),
      ...(runtime.startToken === undefined ? {} : { startToken: runtime.startToken }),
      ...(runtime.entryPath === undefined ? {} : { entryPath: runtime.entryPath }),
      ...(runtime.state === undefined ? {} : { state: runtime.state }),
      ...(runtime.url === undefined ? {} : { url: runtime.url }),
      ...(runtime.origin === undefined ? {} : { origin: runtime.origin }),
      ...(runtime.identityRef === undefined ? {} : { identityRef: runtime.identityRef }),
      ...(runtime.error === undefined ? {} : { error: { code: runtime.error.code, message: runtime.error.message } }),
    }
  }
  if (internal.launcher !== undefined) {
    const launcher = internal.launcher
    root.launcher = {
      pid: launcher.pid,
      generation: launcher.generation,
      ...(launcher.startToken === undefined ? {} : { startToken: launcher.startToken }),
      state: launcher.state,
      ...(launcher.error === undefined ? {} : { error: launcher.error }),
    }
  }
  if (internal.workControl !== undefined) {
    const workControl = internal.workControl
    root.workControl = {
      socketPath: workControl.socketPath,
      launcherGeneration: workControl.launcherGeneration,
      launcherStartToken: workControl.launcherStartToken,
    }
  }
  if (internal.daemons !== undefined) {
    root.daemon = Object.fromEntries(Object.entries(internal.daemons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, daemon]) => [id, {
        ...(daemon.projectionPath === undefined ? {} : { projectionPath: daemon.projectionPath }),
        ...(daemon.enabled === undefined ? {} : { enabled: daemon.enabled }),
        ...(daemon.orphaned === undefined ? {} : { orphaned: daemon.orphaned }),
        ...(daemon.entryPath === undefined ? {} : { entryPath: daemon.entryPath }),
        ...(daemon.startToken === undefined ? {} : { startToken: daemon.startToken }),
        ...(daemon.role === undefined ? {} : { role: daemon.role }),
        ...(daemon.config === undefined ? {} : { config: daemon.config }),
        ...(daemon.pid === undefined ? {} : { pid: daemon.pid }),
        ...(daemon.generation === undefined ? {} : { generation: daemon.generation }),
        ...(daemon.state === undefined ? {} : { state: daemon.state }),
      }]))
  }
  if (internal.configRuntime !== undefined) {
    const runtime = internal.configRuntime
    const accepted = Object.fromEntries(Object.entries(runtime.accepted)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentId, slice]) => [agentId, {
        acceptedRevision: slice.acceptedRevision,
        acceptedSourceRevision: slice.acceptedSourceRevision,
        acceptedSourceHash: slice.acceptedSourceHash,
        ...(slice.snapshot === undefined ? {} : { snapshot: slice.snapshot }),
      }]))
    const effective = Object.fromEntries(Object.entries(runtime.effective)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentId, slice]) => [agentId, {
        ...(slice.effectiveRevision === undefined ? {} : { effectiveRevision: slice.effectiveRevision }),
        ...(slice.applyState === undefined ? {} : { applyState: slice.applyState }),
        ...(slice.lastApplyError === undefined ? {} : { lastApplyError: slice.lastApplyError }),
        ...(slice.uncertain === undefined ? {} : { uncertain: slice.uncertain }),
      }]))
    const catalogs = Object.fromEntries(Object.entries(runtime.catalogs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentId, providers]) => [agentId, Object.fromEntries(Object.entries(providers)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([providerId, observation]) => [providerId, {
          state: observation.state,
          ...(observation.refreshedAt === undefined ? {} : { refreshedAt: observation.refreshedAt }),
          ...(observation.error === undefined ? {} : { error: observation.error }),
          ...(observation.providerFingerprint === undefined ? {} : { providerFingerprint: observation.providerFingerprint }),
          ...(observation.observedAcceptedRevision === undefined ? {} : { observedAcceptedRevision: observation.observedAcceptedRevision }),
          ...(observation.observedAcceptedSourceRevision === undefined ? {} : { observedAcceptedSourceRevision: observation.observedAcceptedSourceRevision }),
          ...(observation.observedAcceptedSourceHash === undefined ? {} : { observedAcceptedSourceHash: observation.observedAcceptedSourceHash }),
          ...(observation.observedEndpoint === undefined ? {} : { observedEndpoint: observation.observedEndpoint }),
          ...(observation.observedCredentialRef === undefined ? {} : { observedCredentialRef: observation.observedCredentialRef }),
          ...(observation.entries === undefined ? {} : { entries: observation.entries }),
        }]))]))
    root.configRuntime = { accepted, effective, catalogs }
  }
  if (internal.migration !== undefined) {
    const migration = internal.migration
    root.migration = {
      formatVersion: migration.formatVersion,
      phase: migration.phase,
      preparedAt: migration.preparedAt,
      ...(migration.committedAt === undefined ? {} : { committedAt: migration.committedAt }),
      ...(migration.verifiedAt === undefined ? {} : { verifiedAt: migration.verifiedAt }),
      fromConfigVersion: migration.fromConfigVersion,
      fromInternalVersion: migration.fromInternalVersion,
      sourcePath: migration.sourcePath,
      sourceBeforeHash: migration.sourceBeforeHash,
      intendedSourceHash: migration.intendedSourceHash,
      candidateConfigText: migration.candidateConfigText,
      legacyInputs: migration.legacyInputs.map(input => ({ kind: input.kind, path: input.path, sha256: input.sha256 })),
      ...(migration.consoleMigrationInput === undefined ? {} : { consoleMigrationInput: { path: migration.consoleMigrationInput.path, sha256: migration.consoleMigrationInput.sha256 } }),
      recovery: migration.recovery,
    }
  }
  return serializeTomlDocument(root)
}

async function writeLocalInternalConfig(path: string, internal: LocalInternalConfig): Promise<string> {
  const internalPath = localPath(path, process.cwd())
  await mkdir(dirname(internalPath), { recursive: true, mode: 0o700 })
  const temporary = `${internalPath}.${randomUUID()}.tmp`
  await writeFile(temporary, serializeLocalInternalConfig(internal), { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, internalPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
  return internalPath
}

export function configSourceHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/**
 * Unique machine-source revision allocator. Caller must already hold
 * `withLocalInternalConfigLock`; this never acquires the lock itself.
 */
export async function admitMachineSourceUnlocked(
  internalPath: string,
  configText: string,
  existing?: LocalInternalConfig,
): Promise<{ readonly sourceRevision: number; readonly sourceHash: string }> {
  const sourceHash = configSourceHash(configText)
  if (existing?.sourceHash === sourceHash) return { sourceRevision: existing.sourceRevision ?? 0, sourceHash }
  const sourceRevision = (existing?.sourceRevision ?? 0) + 1
  await writeLocalInternalConfig(internalPath, {
    ...(existing ?? { version: 2 as const }),
    version: 2,
    sourceRevision,
    sourceHash,
    updatedAt: new Date().toISOString(),
  })
  return { sourceRevision, sourceHash }
}

/** Public machine-source admission used by `loadLocalConfig`; acquires the internal lock. */
export async function admitMachineSource(
  internalPath: string,
  configText: string,
): Promise<{ readonly sourceRevision: number; readonly sourceHash: string }> {
  const path = localPath(internalPath, process.cwd())
  return withLocalInternalConfigLock(path, async () => {
    let existing: LocalInternalConfig | undefined
    try { existing = await readLocalInternalConfig(path) }
    catch (cause) {
      const errorCause = (cause as { cause?: NodeJS.ErrnoException })?.cause
      if (errorCause?.code !== 'ENOENT') throw cause
    }
    return admitMachineSourceUnlocked(path, configText, existing)
  })
}

export interface ConsoleRuntimePatch {
  readonly enabled?: boolean
  readonly pid?: number | null
  readonly generation?: number
  readonly startToken?: string | null
  readonly entryPath?: string | null
  readonly state?: ConsoleRuntimeState
  readonly url?: string | null
  readonly origin?: string | null
  readonly identityRef?: string | null
  readonly error?: ConsoleRuntimeError | null
}

function validateConsoleRuntime(value: LocalInternalConsoleRuntime, label = 'consoleRuntime'): void {
  if (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || value.generation < 0)) throw new LocalConfigError(`${label}.generation must be a non-negative safe integer`)
  if (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || value.pid <= 0)) throw new LocalConfigError(`${label}.pid must be a positive safe integer`)
  if (value.error !== undefined && (typeof value.error.code !== 'string' || value.error.code.length === 0 || typeof value.error.message !== 'string' || value.error.message.length === 0)) {
    throw new LocalConfigError(`${label}.error requires a typed code and non-empty message`)
  }
  for (const key of ['url', 'origin'] as const) {
    const candidate = value[key]
    if (candidate === undefined) continue
    let parsed: URL
    try { parsed = new URL(candidate) } catch { throw new LocalConfigError(`${label}.${key} must be an absolute URL`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new LocalConfigError(`${label}.${key} must be http(s)`)
  }
  switch (value.state) {
    case 'starting':
      if (value.pid === undefined || value.startToken === undefined) throw new LocalConfigError(`${label} state=starting requires pid and startToken`)
      break
    case 'online':
      for (const key of ['pid', 'startToken', 'generation', 'url', 'origin', 'identityRef'] as const) {
        if (value[key] === undefined) throw new LocalConfigError(`${label} state=online requires ${key}`)
      }
      if (value.error !== undefined) throw new LocalConfigError(`${label} state=online must clear error`)
      break
    case 'stopped':
    case 'disabled':
      for (const key of ['pid', 'startToken', 'url', 'origin', 'error'] as const) {
        if (value[key] !== undefined) throw new LocalConfigError(`${label} state=${value.state} must clear ${key}`)
      }
      break
    case 'failed':
      if (value.error === undefined) throw new LocalConfigError(`${label} state=failed requires a typed error`)
      if (value.url !== undefined || value.origin !== undefined) throw new LocalConfigError(`${label} state=failed must clear url and origin`)
      break
    case 'stopping':
    case 'retained':
    case undefined:
      break
    default:
      throw new LocalConfigError(`${label}.state is invalid`)
  }
}

function applyConsoleRuntimePatch(current: LocalInternalConsoleRuntime, patch: ConsoleRuntimePatch): LocalInternalConsoleRuntime {
  const value = <T>(patched: T | null | undefined, existing: T | undefined): T | undefined =>
    patched === undefined ? existing : patched === null ? undefined : patched
  const next: LocalInternalConsoleRuntime = {
    enabled: patch.enabled ?? current.enabled,
    pid: value(patch.pid, current.pid),
    generation: patch.generation ?? current.generation,
    startToken: value(patch.startToken, current.startToken),
    entryPath: value(patch.entryPath, current.entryPath),
    state: patch.state ?? current.state,
    url: value(patch.url, current.url),
    origin: value(patch.origin, current.origin),
    identityRef: value(patch.identityRef, current.identityRef),
    error: value(patch.error, current.error),
  }
  if (next.state === 'stopped' || next.state === 'disabled') {
    const terminal = { ...next, pid: undefined, startToken: undefined, url: undefined, origin: undefined, error: undefined }
    validateConsoleRuntime(terminal)
    return terminal
  }
  if (next.state === 'failed') {
    const failed = { ...next, url: undefined, origin: undefined }
    validateConsoleRuntime(failed)
    return failed
  }
  validateConsoleRuntime(next)
  return next
}

/**
 * U5 Console lifecycle typed patch port. Same internal short lock as every other
 * internal writer; U5 is the only caller and owns the lifecycle field semantics.
 */
export async function writeLocalInternalConsoleRuntime(path: string, patch: Readonly<ConsoleRuntimePatch>): Promise<string> {
  const internalPath = localPath(path, process.cwd())
  return withLocalInternalConfigLock(internalPath, async () => {
    const existing = await readLocalInternalConfig(internalPath)
    const current = existing.consoleRuntime ?? {}
    if (patch.generation !== undefined && current.generation !== undefined && patch.generation < current.generation) {
      throw new LocalConfigError('consoleRuntime.generation must not move backwards')
    }
    const next = applyConsoleRuntimePatch(current, patch)
    return writeLocalInternalConfig(internalPath, { ...existing, version: existing.version, consoleRuntime: next, updatedAt: new Date().toISOString() })
  })
}

function launcherOwnershipPath(path: string): string {
  const internalPath = localPath(path, process.cwd())
  return resolve(dirname(internalPath), '.internal', 'launcher-owner.json')
}

export async function readLocalLauncherOwnership(path: string): Promise<LocalLauncherOwnerRecord | undefined> {
  const ownerPath = launcherOwnershipPath(path)
  let text: string
  try { text = await readFile(ownerPath, 'utf8') }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new LocalConfigError(`launcher ownership cannot be read: ${ownerPath}`, cause)
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (cause) {
    throw new LocalConfigError(`launcher ownership is not valid JSON: ${ownerPath}`, cause)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LocalConfigError(`launcher ownership must be an object: ${ownerPath}`)
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
    typeof record.startToken !== 'string' || record.startToken.length === 0) {
    throw new LocalConfigError(`launcher ownership record is invalid: ${ownerPath}`)
  }
  return { version: 1, pid: record.pid, startToken: record.startToken }
}

export async function writeLocalLauncherOwnership(path: string, owner: LocalLauncherOwnerRecord): Promise<string> {
  const ownerPath = launcherOwnershipPath(path)
  await mkdir(dirname(ownerPath), { recursive: true, mode: 0o700 })
  const temporary = `${ownerPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, ownerPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
  return ownerPath
}

/** Serialize internal.toml read-modify-write transactions across launcher and daemon writers. */
export async function withLocalInternalConfigLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const internalPath = localPath(path, process.cwd())
  const lockPath = `${internalPath}.internal.lock`
  const deadline = Date.now() + 5_000
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (handle === undefined) {
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ownerPid: number | undefined
      try {
        const value = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
        if (Number.isSafeInteger(value) && value > 0) ownerPid = value
      } catch { /* preserve the lock when its owner cannot be read */ }
      if (ownerPid !== undefined && !processAlive(ownerPid)) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) throw new LocalConfigError(`internal config update is already in progress: ${internalPath}`)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`)
    return await task()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

const CONSOLE_RUNTIME_STATES = ['disabled', 'stopped', 'starting', 'online', 'stopping', 'failed', 'retained'] as const

function parseConsoleRuntimeTable(input: Record<string, unknown>): LocalInternalConsoleRuntime {
  fields(input, ['enabled', 'pid', 'generation', 'startToken', 'entryPath', 'state', 'url', 'origin', 'identityRef', 'error'], 'consoleRuntime')
  const parsed: LocalInternalConsoleRuntime = {
    ...(input.enabled === undefined ? {} : { enabled: boolean(input.enabled, true, 'consoleRuntime.enabled') }),
    ...(input.pid === undefined ? {} : { pid: optionalNumber(input.pid, 'consoleRuntime.pid') }),
    ...(input.generation === undefined ? {} : { generation: optionalNumber(input.generation, 'consoleRuntime.generation') }),
    ...(input.startToken === undefined ? {} : { startToken: requiredString(input.startToken, 'consoleRuntime.startToken') }),
    ...(input.entryPath === undefined ? {} : { entryPath: requiredString(input.entryPath, 'consoleRuntime.entryPath') }),
    ...(input.state === undefined ? {} : { state: oneOf(input.state, CONSOLE_RUNTIME_STATES, 'consoleRuntime.state') }),
    ...(input.url === undefined ? {} : { url: requiredString(input.url, 'consoleRuntime.url') }),
    ...(input.origin === undefined ? {} : { origin: requiredString(input.origin, 'consoleRuntime.origin') }),
    ...(input.identityRef === undefined ? {} : { identityRef: requiredString(input.identityRef, 'consoleRuntime.identityRef') }),
    ...(input.error === undefined ? {} : (() => {
      const errorInput = object(input.error, 'consoleRuntime.error')
      fields(errorInput, ['code', 'message'], 'consoleRuntime.error')
      return { error: { code: requiredString(errorInput.code, 'consoleRuntime.error.code'), message: requiredString(errorInput.message, 'consoleRuntime.error.message') } }
    })()),
  }
  validateConsoleRuntime(parsed)
  return parsed
}

function parseConfigRuntimeTable(input: Record<string, unknown>): LocalInternalConfigRuntime {
  const accepted: Record<string, LocalInternalConfigRuntimeAccepted> = {}
  if (input.accepted !== undefined) {
    for (const [agentId, value] of Object.entries(object(input.accepted, 'configRuntime.accepted'))) {
      const slice = object(value, `configRuntime.accepted.${agentId}`)
      const acceptedRevision = optionalNumber(slice.acceptedRevision, `configRuntime.accepted.${agentId}.acceptedRevision`)
      const acceptedSourceRevision = optionalNumber(slice.acceptedSourceRevision, `configRuntime.accepted.${agentId}.acceptedSourceRevision`)
      if (acceptedRevision === undefined || acceptedSourceRevision === undefined) throw new LocalConfigError(`configRuntime.accepted.${agentId} requires acceptedRevision and acceptedSourceRevision`)
      accepted[agentId] = {
        acceptedRevision,
        acceptedSourceRevision,
        acceptedSourceHash: requiredString(slice.acceptedSourceHash, `configRuntime.accepted.${agentId}.acceptedSourceHash`),
        ...(slice.snapshot === undefined ? {} : { snapshot: requiredString(slice.snapshot, `configRuntime.accepted.${agentId}.snapshot`) }),
      }
    }
  }
  const effective: Record<string, LocalInternalConfigRuntimeEffective> = {}
  if (input.effective !== undefined) {
    for (const [agentId, value] of Object.entries(object(input.effective, 'configRuntime.effective'))) {
      const slice = object(value, `configRuntime.effective.${agentId}`)
      effective[agentId] = {
        ...(slice.effectiveRevision === undefined ? {} : { effectiveRevision: optionalNumber(slice.effectiveRevision, `configRuntime.effective.${agentId}.effectiveRevision`) }),
        ...(slice.applyState === undefined ? {} : { applyState: oneOf(slice.applyState, ['clean', 'uncertain'] as const, `configRuntime.effective.${agentId}.applyState`) }),
        ...(slice.lastApplyError === undefined ? {} : { lastApplyError: requiredString(slice.lastApplyError, `configRuntime.effective.${agentId}.lastApplyError`) }),
        ...(slice.uncertain === undefined ? {} : { uncertain: requiredString(slice.uncertain, `configRuntime.effective.${agentId}.uncertain`) }),
      }
    }
  }
  const catalogs: Record<string, Record<string, LocalInternalConfigRuntimeCatalog>> = {}
  if (input.catalogs !== undefined) {
    for (const [agentId, value] of Object.entries(object(input.catalogs, 'configRuntime.catalogs'))) {
      const providers: Record<string, LocalInternalConfigRuntimeCatalog> = {}
      for (const [providerId, providerValue] of Object.entries(object(value, `configRuntime.catalogs.${agentId}`))) {
        const observation = object(providerValue, `configRuntime.catalogs.${agentId}.${providerId}`)
        providers[providerId] = {
          state: oneOf(observation.state, ['ready', 'empty', 'stale', 'error'] as const, `configRuntime.catalogs.${agentId}.${providerId}.state`),
          ...(observation.refreshedAt === undefined ? {} : { refreshedAt: requiredString(observation.refreshedAt, `configRuntime.catalogs.${agentId}.${providerId}.refreshedAt`) }),
          ...(observation.error === undefined ? {} : { error: requiredString(observation.error, `configRuntime.catalogs.${agentId}.${providerId}.error`) }),
          ...(observation.providerFingerprint === undefined ? {} : { providerFingerprint: requiredString(observation.providerFingerprint, `configRuntime.catalogs.${agentId}.${providerId}.providerFingerprint`) }),
          ...(observation.observedAcceptedRevision === undefined ? {} : { observedAcceptedRevision: optionalNumber(observation.observedAcceptedRevision, `configRuntime.catalogs.${agentId}.${providerId}.observedAcceptedRevision`) }),
          ...(observation.observedAcceptedSourceRevision === undefined ? {} : { observedAcceptedSourceRevision: optionalNumber(observation.observedAcceptedSourceRevision, `configRuntime.catalogs.${agentId}.${providerId}.observedAcceptedSourceRevision`) }),
          ...(observation.observedAcceptedSourceHash === undefined ? {} : { observedAcceptedSourceHash: requiredString(observation.observedAcceptedSourceHash, `configRuntime.catalogs.${agentId}.${providerId}.observedAcceptedSourceHash`) }),
          ...(observation.observedEndpoint === undefined ? {} : { observedEndpoint: requiredString(observation.observedEndpoint, `configRuntime.catalogs.${agentId}.${providerId}.observedEndpoint`) }),
          ...(observation.observedCredentialRef === undefined ? {} : { observedCredentialRef: requiredString(observation.observedCredentialRef, `configRuntime.catalogs.${agentId}.${providerId}.observedCredentialRef`) }),
          ...(observation.entries === undefined ? {} : { entries: requiredString(observation.entries, `configRuntime.catalogs.${agentId}.${providerId}.entries`) }),
        }
      }
      catalogs[agentId] = providers
    }
  }
  return { accepted, effective, catalogs }
}

function parseMigrationTable(input: Record<string, unknown>): LocalInternalMigration {
  const formatVersion = optionalNumber(input.formatVersion, 'migration.formatVersion')
  const fromConfigVersion = optionalNumber(input.fromConfigVersion, 'migration.fromConfigVersion')
  const fromInternalVersion = optionalNumber(input.fromInternalVersion, 'migration.fromInternalVersion')
  if (formatVersion === undefined || fromConfigVersion === undefined || fromInternalVersion === undefined) {
    throw new LocalConfigError('migration formatVersion/fromConfigVersion/fromInternalVersion are required')
  }
  const legacyInputs = input.legacyInputs === undefined ? [] : (() => {
    if (!Array.isArray(input.legacyInputs)) throw new LocalConfigError('migration.legacyInputs must be an array')
    return input.legacyInputs.map((value, index) => {
      const item = object(value, `migration.legacyInputs[${index}]`)
      return {
        kind: requiredString(item.kind, `migration.legacyInputs[${index}].kind`),
        path: requiredString(item.path, `migration.legacyInputs[${index}].path`),
        sha256: requiredString(item.sha256, `migration.legacyInputs[${index}].sha256`),
      }
    })
  })()
  return {
    formatVersion,
    phase: oneOf(input.phase, ['prepared', 'config-committed', 'verified'] as const, 'migration.phase'),
    preparedAt: requiredString(input.preparedAt, 'migration.preparedAt'),
    ...(input.committedAt === undefined ? {} : { committedAt: requiredString(input.committedAt, 'migration.committedAt') }),
    ...(input.verifiedAt === undefined ? {} : { verifiedAt: requiredString(input.verifiedAt, 'migration.verifiedAt') }),
    fromConfigVersion,
    fromInternalVersion,
    sourcePath: requiredString(input.sourcePath, 'migration.sourcePath'),
    sourceBeforeHash: requiredString(input.sourceBeforeHash, 'migration.sourceBeforeHash'),
    intendedSourceHash: requiredString(input.intendedSourceHash, 'migration.intendedSourceHash'),
    candidateConfigText: requiredString(input.candidateConfigText, 'migration.candidateConfigText'),
    legacyInputs,
    ...(input.consoleMigrationInput === undefined ? {} : (() => {
      const item = object(input.consoleMigrationInput, 'migration.consoleMigrationInput')
      return { consoleMigrationInput: { path: requiredString(item.path, 'migration.consoleMigrationInput.path'), sha256: requiredString(item.sha256, 'migration.consoleMigrationInput.sha256') } }
    })()),
    recovery: requiredString(input.recovery, 'migration.recovery'),
  }
}

function parseWorkControlTable(input: Record<string, unknown>, internalPath: string): LocalInternalWorkControl {
  fields(input, ['socketPath', 'launcherGeneration', 'launcherStartToken'], 'workControl')
  const socketPath = requiredString(input.socketPath, 'workControl.socketPath')
  const expectedSocketPath = resolve(dirname(internalPath), '.internal', 'work-control.sock')
  if (socketPath !== expectedSocketPath) throw new LocalConfigError(`workControl.socketPath must be the fixed absolute path ${expectedSocketPath}`)
  const launcherGeneration = optionalNumber(input.launcherGeneration, 'workControl.launcherGeneration')
  if (launcherGeneration === undefined || launcherGeneration < 0) throw new LocalConfigError('workControl.launcherGeneration must be a non-negative safe integer')
  return {
    socketPath,
    launcherGeneration,
    launcherStartToken: requiredString(input.launcherStartToken, 'workControl.launcherStartToken'),
  }
}

function exactWorkControlRefs(workControl: LocalInternalWorkControl, launcher: LocalInternalLauncherConfig | undefined): void {
  if (launcher === undefined || launcher.startToken === undefined) throw new LocalConfigError('workControl requires launcher generation and startToken')
  if (workControl.launcherGeneration !== launcher.generation) throw new LocalConfigError('workControl.launcherGeneration must exactly match launcher.generation')
  if (workControl.launcherStartToken !== launcher.startToken) throw new LocalConfigError('workControl.launcherStartToken must exactly match launcher.startToken')
}

export async function readLocalInternalConfig(path: string): Promise<LocalInternalConfig> {
  const internalPath = localPath(path, process.cwd())
  let text: string
  try { text = await readFile(internalPath, 'utf8') }
  catch (cause) { throw new LocalConfigError(`internal config cannot be read: ${internalPath}`, cause) }
  let parsed: unknown
  try { parsed = parseToml(text) } catch (cause) { throw new LocalConfigError(`internal config is not valid TOML: ${internalPath}`, cause) }
  const root = object(parsed, 'internal config')
  if (root.version !== 1 && root.version !== 2) throw new LocalConfigError(`internal config version must be 1 or 2: ${internalPath}`)
  const textOrUndefined = (value: unknown, label: string): string | undefined => {
    if (value === undefined) return undefined
    return requiredString(value, label)
  }
  const optionalSourceRevision = root.sourceRevision === undefined ? undefined : optionalNumber(root.sourceRevision, 'sourceRevision')
  if (root.sourceRevision !== undefined && (optionalSourceRevision === undefined || optionalSourceRevision < 0)) throw new LocalConfigError('sourceRevision must be a non-negative safe integer')
  const daemons: Record<string, LocalInternalDaemonConfig> = {}
  if (root.daemon !== undefined) {
    const daemonTable = object(root.daemon, 'daemon')
    for (const [id, value] of Object.entries(daemonTable)) {
      const input = object(value, `daemon.${id}`)
      daemons[id] = {
        ...(input.projectionPath === undefined ? {} : { projectionPath: requiredString(input.projectionPath, `daemon.${id}.projectionPath`) }),
        ...(input.enabled === undefined ? {} : { enabled: boolean(input.enabled, true, `daemon.${id}.enabled`) }),
        ...(input.orphaned === undefined ? {} : { orphaned: boolean(input.orphaned, true, `daemon.${id}.orphaned`) }),
        ...(input.entryPath === undefined ? {} : { entryPath: requiredString(input.entryPath, `daemon.${id}.entryPath`) }),
        ...(input.startToken === undefined ? {} : { startToken: requiredString(input.startToken, `daemon.${id}.startToken`) }),
        ...(input.role === undefined ? {} : { role: oneOf(input.role, ['provider', 'receiver', 'hybrid'] as const, `daemon.${id}.role`) }),
        ...(input.config === undefined ? {} : { config: requiredString(input.config, `daemon.${id}.config`) }),
        ...(input.pid === undefined ? {} : { pid: optionalNumber(input.pid, `daemon.${id}.pid`) }),
        ...(input.generation === undefined ? {} : { generation: optionalNumber(input.generation, `daemon.${id}.generation`) }),
        ...(input.state === undefined ? {} : { state: oneOf(input.state, ['online', 'stopped', 'failed'] as const, `daemon.${id}.state`) }),
      }
    }
  }
  const launcher = root.launcher === undefined ? undefined : (() => {
    const input = object(root.launcher, 'launcher')
    const pid = optionalNumber(input.pid, 'launcher.pid')
    const generation = optionalNumber(input.generation, 'launcher.generation')
    if (pid === undefined || generation === undefined) throw new LocalConfigError('launcher pid and generation are required')
    return {
      pid,
      generation,
      ...(input.startToken === undefined ? {} : { startToken: requiredString(input.startToken, 'launcher.startToken') }),
      state: oneOf(input.state, ['starting', 'running', 'stopped', 'failed'] as const, 'launcher.state'),
      ...(input.error === undefined ? {} : { error: requiredString(input.error, 'launcher.error') }),
    }
  })()
  const workControl = root.workControl === undefined ? undefined : parseWorkControlTable(object(root.workControl, 'workControl'), internalPath)
  if (workControl !== undefined) exactWorkControlRefs(workControl, launcher)
  const consoleRuntime = root.consoleRuntime === undefined ? undefined : parseConsoleRuntimeTable(object(root.consoleRuntime, 'consoleRuntime'))
  const configRuntime = root.configRuntime === undefined ? undefined : parseConfigRuntimeTable(object(root.configRuntime, 'configRuntime'))
  const migration = root.migration === undefined ? undefined : parseMigrationTable(object(root.migration, 'migration'))
  return {
    version: root.version === 2 ? 2 : 1,
    ...(optionalSourceRevision === undefined ? {} : { sourceRevision: optionalSourceRevision }),
    ...(root.sourceHash === undefined ? {} : { sourceHash: textOrUndefined(root.sourceHash, 'sourceHash') }),
    ...(root.configRevision === undefined ? {} : { configRevision: textOrUndefined(root.configRevision, 'configRevision') }),
    ...(root.sourcePath === undefined ? {} : { sourcePath: textOrUndefined(root.sourcePath, 'sourcePath') }),
    ...(root.generatedAt === undefined ? {} : { generatedAt: textOrUndefined(root.generatedAt, 'generatedAt') }),
    ...(root.updatedAt === undefined ? {} : { updatedAt: textOrUndefined(root.updatedAt, 'updatedAt') }),
    ...(launcher === undefined ? {} : { launcher }),
    ...(workControl === undefined ? {} : { workControl }),
    ...(root.relay === undefined ? {} : (() => {
      const relay = object(root.relay, 'relay')
      return { relay: {
        ...(relay.projectionPath === undefined ? {} : { projectionPath: requiredString(relay.projectionPath, 'relay.projectionPath') }),
        ...(relay.config === undefined ? {} : { config: requiredString(relay.config, 'relay.config') }),
      } }
    })()),
    ...(root.console === undefined ? {} : (() => {
      const consoleProjection = object(root.console, 'console')
      return { console: {
        ...(consoleProjection.projectionPath === undefined ? {} : { projectionPath: requiredString(consoleProjection.projectionPath, 'console.projectionPath') }),
        ...(consoleProjection.config === undefined ? {} : { config: requiredString(consoleProjection.config, 'console.config') }),
      } }
    })()),
    ...(consoleRuntime === undefined ? {} : { consoleRuntime }),
    ...(configRuntime === undefined ? {} : { configRuntime }),
    ...(migration === undefined ? {} : { migration }),
    daemons,
  }
}

export async function projectLocalChildConfigs(internalPath: string): Promise<void> {
  const internal = await readLocalInternalConfig(internalPath)
  const relay = internal.relay
  if (relay?.config !== undefined) {
    if (relay.projectionPath === undefined) throw new LocalConfigError('internal relay projectionPath is missing')
    assertProjectionPath(relay.projectionPath, resolve(dirname(internalPath), '.internal', 'projections', 'relay.json'), 'internal relay')
    await materializeEndpoint(relay.projectionPath, parseProjectionConfig(relay.config, relay.projectionPath))
  }
  const consoleProjection = internal.console
  if (consoleProjection?.config !== undefined) {
    if (consoleProjection.projectionPath === undefined) throw new LocalConfigError('internal console projectionPath is missing')
    assertProjectionPath(consoleProjection.projectionPath, resolve(dirname(internalPath), '.internal', 'projections', 'console.json'), 'internal console')
    await materializeEndpoint(consoleProjection.projectionPath, parseProjectionConfig(consoleProjection.config, consoleProjection.projectionPath))
  }
  for (const [id, daemon] of Object.entries(internal.daemons ?? {})) {
    if (daemon.enabled === false) continue
    if (daemon.config === undefined) continue
    if (daemon.projectionPath === undefined) throw new LocalConfigError(`internal daemon ${id} projectionPath is missing`)
    assertProjectionPath(daemon.projectionPath, expectedProjectionPath(internalPath, id), `internal daemon ${id}`)
    await materializeEndpoint(daemon.projectionPath, parseProjectionConfig(daemon.config, daemon.projectionPath))
  }
}

function parseProjectionConfig(config: string, projectionPath: string): Record<string, unknown> {
  try {
    const value = JSON.parse(config)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalConfigError(`${projectionPath} projection must be an object`)
    return value as Record<string, unknown>
  } catch (cause) {
    if (cause instanceof LocalConfigError) throw cause
    throw new LocalConfigError(`projection config is not valid JSON: ${projectionPath}`, cause)
  }
}

export function parseLocalConsoleProjectionConfig(config: string | undefined): Record<string, unknown> | undefined {
  if (config === undefined) return undefined
  return parseProjectionConfig(config, 'internal console')
}

function readExistingProjection(config: string | undefined): TomlRecord | undefined {
  if (config === undefined) return undefined
  return parseProjectionConfig(config, 'internal projection')
}

function expectedProjectionPath(internalPath: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === 'relay') throw new LocalConfigError(`internal projection id is invalid: ${id}`)
  return resolve(dirname(internalPath), '.internal', 'projections', `${id}.json`)
}

function assertProjectionPath(actual: string, expected: string, label: string): void {
  if (resolve(actual) !== expected) throw new LocalConfigError(`${label} projectionPath must be ${expected}`)
}

function resolveRelayTlsPaths(config: Record<string, unknown>, relayDirectory: string): Record<string, unknown> {
  const tls = config.tls
  if (typeof tls !== 'object' || tls === null || Array.isArray(tls)) return config
  const resolved = { ...(tls as Record<string, unknown>) }
  for (const key of ['keyFile', 'certFile'] as const) {
    const value = resolved[key]
    if (typeof value === 'string' && !isAbsolute(value)) resolved[key] = resolve(relayDirectory, value)
  }
  return { ...config, tls: resolved }
}

function assertAgentId(id: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === 'relay') throw new LocalConfigError(`${label} is not a valid Agent ID`)
}

async function availableTcpPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolvePort, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePort))
  const address = server.address() as { port: number }
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  return address.port
}

function parseV3Identity(id: string, value: unknown): TomlRecord {
  const input = object(value, `agents.${id}.identity`)
  fields(input, ['hostId', 'machineId', 'accountId', 'agentKind', 'label'], `agents.${id}.identity`)
  if (Object.hasOwn(input, 'agentId')) throw new LocalConfigError(`agents.${id}.identity.agentId is derived from the table key and must not be repeated`)
  return {
    hostId: requiredString(input.hostId, `agents.${id}.identity.hostId`),
    machineId: requiredString(input.machineId, `agents.${id}.identity.machineId`),
    agentId: id,
    accountId: requiredString(input.accountId, `agents.${id}.identity.accountId`),
    agentKind: oneOf(input.agentKind, ['opencode', 'acp', 'custom'] as const, `agents.${id}.identity.agentKind`),
    label: requiredString(input.label, `agents.${id}.identity.label`),
  }
}

function parseV3Runtime(id: string, value: unknown, baseDirectory: string, systemDataDirectory: string): {
  readonly json: TomlRecord
  readonly scopeId: string
  readonly dataDirectory: string
  readonly policy: TomlRecord
  readonly cli: TomlRecord
} {
  const input = object(value, `agents.${id}.runtime`)
  fields(input, ['scopeId', 'dataDirectory', 'policy', 'cli'], `agents.${id}.runtime`)
  const policy = object(input.policy, `agents.${id}.runtime.policy`)
  fields(policy, ['revision', 'allowedConsumers', 'allowedManagers'], `agents.${id}.runtime.policy`)
  const cliInput = object(input.cli, `agents.${id}.runtime.cli`)
  fields(cliInput, ['camoExecutable', 'searchExecutable', 'searchRoot', 'profilePrefix'], `agents.${id}.runtime.cli`)
  const pathValue = (value: unknown, label: string): string => localPath(requiredString(value, label), baseDirectory)
  const cli: TomlRecord = {
    camoExecutable: pathValue(cliInput.camoExecutable, `agents.${id}.runtime.cli.camoExecutable`),
    searchExecutable: pathValue(cliInput.searchExecutable, `agents.${id}.runtime.cli.searchExecutable`),
    searchRoot: pathValue(cliInput.searchRoot, `agents.${id}.runtime.cli.searchRoot`),
    profilePrefix: requiredString(cliInput.profilePrefix, `agents.${id}.runtime.cli.profilePrefix`),
  }
  const scopeId = requiredString(input.scopeId, `agents.${id}.runtime.scopeId`)
  const dataDirectory = input.dataDirectory === undefined
    ? resolve(systemDataDirectory, id)
    : localPath(requiredString(input.dataDirectory, `agents.${id}.runtime.dataDirectory`), baseDirectory)
  return { json: { scopeId, dataDirectory, policy, cli }, scopeId, dataDirectory, policy, cli }
}

function parseV3Services(id: string, value: unknown): readonly TomlRecord[] {
  const table = object(value, `agents.${id}.services`)
  const services: TomlRecord[] = []
  for (const [serviceId, raw] of Object.entries(table)) {
    assertAgentId(serviceId, `agents.${id}.services.${serviceId}`)
    const service = object(raw, `agents.${id}.services.${serviceId}`)
    fields(service, ['version', 'operations', 'resources'], `agents.${id}.services.${serviceId}`)
    if (!Array.isArray(service.operations) || service.operations.length === 0 || service.operations.some(item => typeof item !== 'string' || item.trim() === '')) {
      throw new LocalConfigError(`agents.${id}.services.${serviceId}.operations must be a non-empty array of strings`)
    }
    const resources = service.resources === undefined ? [] : (() => {
      if (!Array.isArray(service.resources)) throw new LocalConfigError(`agents.${id}.services.${serviceId}.resources must be an array`)
      return service.resources.map((resourceValue, index) => {
        const label = `agents.${id}.services.${serviceId}.resources[${index}]`
        const resource = object(resourceValue, label)
        fields(resource, ['resourceId', 'capacity', 'unit'], label)
        const capacity = optionalNumber(resource.capacity, `${label}.capacity`)
        if (capacity === undefined || capacity < 1) throw new LocalConfigError(`${label}.capacity must be positive`)
        return {
          resourceId: requiredString(resource.resourceId, `${label}.resourceId`),
          capacity,
          unit: oneOf(resource.unit, ['slot', 'context'] as const, `${label}.unit`),
        }
      })
    })()
    services.push({
      capabilityId: serviceId,
      version: requiredString(service.version, `agents.${id}.services.${serviceId}.version`),
      operations: [...service.operations] as string[],
      resources,
    })
  }
  return services
}

function localServiceIntent(service: TomlRecord): LocalServiceIntent {
  return {
    capabilityId: service.capabilityId as string,
    version: service.version as string,
    operations: [...(service.operations as string[])],
    resources: (service.resources as readonly { readonly resourceId: string; readonly capacity: number; readonly unit: 'slot' | 'context' }[])
      .map(resource => ({ ...resource })),
  }
}

function parseV3Connect(id: string, value: unknown): LocalConnectionIntent {
  const input = object(value, `agents.${id}.connect`)
  fields(input, ['targetAgentId', 'capabilityId', 'capabilityVersion', 'operation', 'demands'], `agents.${id}.connect`)
  const demands = input.demands === undefined ? [] : (() => {
    if (!Array.isArray(input.demands)) throw new LocalConfigError(`agents.${id}.connect.demands must be an array`)
    return input.demands.map((demandValue, index) => {
      const label = `agents.${id}.connect.demands[${index}]`
      const demand = object(demandValue, label)
      fields(demand, ['resourceId', 'amount'], label)
      const amount = optionalNumber(demand.amount, `${label}.amount`)
      if (amount === undefined || amount < 1) throw new LocalConfigError(`${label}.amount must be positive`)
      return { resourceId: requiredString(demand.resourceId, `${label}.resourceId`), amount }
    })
  })()
  return {
    targetAgentId: requiredString(input.targetAgentId, `agents.${id}.connect.targetAgentId`),
    capabilityId: requiredString(input.capabilityId, `agents.${id}.connect.capabilityId`),
    capabilityVersion: requiredString(input.capabilityVersion, `agents.${id}.connect.capabilityVersion`),
    operation: requiredString(input.operation, `agents.${id}.connect.operation`),
    demands,
  }
}

function relayCredentialEnv(agentId: string): string {
  return `AGENTTEAMS_${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_AUTH`
}

async function pickOrReusePort(internal: LocalInternalConfig | undefined, key: 'relay' | string, fallback: () => Promise<number>): Promise<number> {
  const persisted = key === 'relay'
    ? internal?.relay?.config
    : key === 'console'
      ? internal?.console?.config
      : internal?.daemons?.[key]?.config
  if (persisted !== undefined) {
    const value = parseProjectionConfig(persisted, `internal ${key} projection`) as { listen?: { port?: unknown }; leasePort?: unknown }
    const port = value.listen?.port ?? value.leasePort
    if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      throw new LocalConfigError(`internal ${key} projection port must be a safe integer in 1..65535`)
    }
    return port as number
  }
  return fallback()
}

const CONSOLE_IDENTITY = {
  hostId: 'local',
  machineId: 'local',
  agentId: '__console',
  accountId: 'local',
  agentKind: 'custom' as const,
  label: 'AgentTeams Console',
}

const CONSOLE_CREDENTIAL_ENV = 'AGENTTEAMS_CONSOLE_AUTH'

/**
 * Asset roots are derived from the installed package, never from user intent.
 * Source runs resolve to the repository root; compiled runtime-lib runs resolve
 * to the package root three directories above the emitted runtime directory.
 */
function consoleAssetRoots(): { readonly staticRoot: string; readonly uiRoot: string } {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url))
  const tail = runtimeDirectory.split(/[\\/]/).slice(-3).join('/')
  const packageRoot = tail === 'generated/runtime-lib/runtime' ? resolve(runtimeDirectory, '..', '..', '..') : resolve(runtimeDirectory, '..')
  return {
    staticRoot: resolve(packageRoot, 'console-host', 'static'),
    uiRoot: resolve(packageRoot, 'ui', 'teams-console'),
  }
}

interface CompiledV3Agent {
  readonly id: string
  readonly enabled: boolean
  readonly role: 'provider' | 'receiver' | 'hybrid'
  readonly identity: TomlRecord
  readonly runtime: ReturnType<typeof parseV3Runtime>
  readonly services: readonly TomlRecord[]
  readonly connect?: LocalConnectionIntent
}

interface CompiledV3Config {
  readonly relay: LocalRelaySpec
  readonly relayProjectionPath: string
  readonly relayConfig: TomlRecord
  readonly daemons: readonly LocalDaemonSpec[]
  readonly daemonProjections: Readonly<Record<string, LocalInternalDaemonConfig>>
  readonly consoleProjection?: { readonly projectionPath: string; readonly config: string }
  readonly consoleIntent?: TomlRecord
}

/**
 * Compile v3 user intent into daemon specs and internal child projections.
 * System-owned fields (ports, projection paths, TLS) are generated here; user
 * intent only declares identity/runtime/services/connect/bridge/console.
 */
async function compileV3Config(
  root: TomlRecord,
  configPath: string,
  existing: LocalInternalConfig | undefined,
): Promise<CompiledV3Config> {
  const baseDirectory = dirname(configPath)
  const agentteamsDirectory = baseDirectory
  const projectionDirectory = resolve(agentteamsDirectory, '.internal', 'projections')
  const systemDataDirectory = resolve(agentteamsDirectory, '.internal', 'data')

  const bridgeInput = object(root.bridge, 'bridge')
  fields(bridgeInput, ['enabled'], 'bridge')
  const bridgeEnabled = boolean(bridgeInput.enabled, true, 'bridge.enabled')
  if (!bridgeEnabled) throw new LocalConfigError('bridge.enabled must be true for a local bridge')

  const agentsTable = object(root.agents, 'agents')
  const compiledAgents: CompiledV3Agent[] = []
  for (const [id, raw] of Object.entries(agentsTable)) {
    assertAgentId(id, `agents.${id}`)
    const agent = object(raw, `agents.${id}`)
    fields(agent, ['enabled', 'role', 'label', 'identity', 'runtime', 'services', 'connect', 'model'], `agents.${id}`)
    const role = oneOf(agent.role, ['provider', 'receiver', 'hybrid'] as const, `agents.${id}.role`)
    const connect = agent.connect === undefined ? undefined : parseV3Connect(id, agent.connect)
    if ((role === 'receiver' || role === 'hybrid') && connect === undefined) {
      throw new LocalConfigError(`agents.${id}.connect is required for ${role} agents`)
    }
    if (role === 'provider' && connect !== undefined) {
      throw new LocalConfigError(`agents.${id}.connect is not allowed for provider agents`)
    }
    compiledAgents.push({
      id,
      enabled: boolean(agent.enabled, true, `agents.${id}.enabled`),
      role,
      identity: parseV3Identity(id, agent.identity),
      runtime: parseV3Runtime(id, agent.runtime, baseDirectory, systemDataDirectory),
      services: agent.services === undefined ? [] : parseV3Services(id, agent.services),
      ...(connect === undefined ? {} : { connect }),
    })
  }
  if (compiledAgents.length === 0 || !compiledAgents.some(agent => agent.enabled)) {
    throw new LocalConfigError('at least one enabled agent is required')
  }
  for (const agent of compiledAgents) {
    if (agent.connect === undefined) continue
    const target = compiledAgents.find(candidate => candidate.id === agent.connect!.targetAgentId)
    if (target === undefined) throw new LocalConfigError(`agents.${agent.id}.connect references unknown agent ${agent.connect.targetAgentId}`)
    const service = target.services.find(candidate => candidate.capabilityId === agent.connect!.capabilityId)
    if (service === undefined
      || service.version !== agent.connect.capabilityVersion
      || !(service.operations as string[]).includes(agent.connect.operation as string)) {
      throw new LocalConfigError(`agents.${agent.id}.connect references a service not declared by ${target.id}`)
    }
  }

  await mkdir(resolve(agentteamsDirectory, 'files'), { recursive: true, mode: 0o700 })
  const relayProjectionPath = resolve(projectionDirectory, 'relay.json')
  const relayPort = await pickOrReusePort(existing, 'relay', availableTcpPort)
  const existingRelay = readExistingProjection(existing?.relay?.config)
  const tlsPaths = localBridgeTlsPaths(agentteamsDirectory)
  const relayCredentialEnvs = new Map<string, string>()
  for (const agent of compiledAgents) {
    const existingDaemon = readExistingProjection(existing?.daemons?.[agent.id]?.config)
    const existingRelay = isTomlRecord(existingDaemon?.relay) ? existingDaemon.relay : {}
    const persisted = existingRelay.credentialEnv
    relayCredentialEnvs.set(
      agent.id,
      typeof persisted === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(persisted) ? persisted : relayCredentialEnv(agent.id),
    )
  }
  const relayConfig: TomlRecord = {
    version: 1,
    listen: { host: '127.0.0.1', port: relayPort },
    tls: { keyFile: tlsPaths.keyFile, certFile: tlsPaths.certFile },
    limits: isTomlRecord(existingRelay?.limits) ? existingRelay.limits : {
      maxPayload: 65536,
      maxConnections: 8,
      maxGrants: 8,
      maxBufferedAmount: 65536,
      maxPendingMessages: 8,
      maxPendingBytes: 131072,
      grantTtlMs: 5000,
    },
    credentials: compiledAgents.filter(agent => agent.enabled).map(agent => ({
      credentialEnv: relayCredentialEnvs.get(agent.id),
      identity: {
        accountId: agent.identity.accountId,
        scopeId: agent.runtime.scopeId,
        agentId: agent.id,
      },
    })),
  }
  const relay: LocalRelaySpec = { enabled: true, configPath: relayProjectionPath }

  const daemons: LocalDaemonSpec[] = []
  const daemonProjections: Record<string, LocalInternalDaemonConfig> = {}
  for (const agent of compiledAgents) {
    const projectionPath = resolve(projectionDirectory, `${agent.id}.json`)
    const leasePort = await pickOrReusePort(existing, agent.id, availableTcpPort)
    const endpoint: TomlRecord = {
      role: agent.role,
      ...(agent.services.length === 0 ? {} : { services: agent.services.map(localServiceIntent) }),
      ...(agent.connect === undefined ? {} : { connect: agent.connect }),
    }
    const existingDaemon = readExistingProjection(existing?.daemons?.[agent.id]?.config)
    const relayBase = isTomlRecord(existingDaemon?.relay) ? existingDaemon.relay : {}
    const json: TomlRecord = {
      ...existingDaemon,
      version: 1,
      identity: agent.identity,
      ...agent.runtime.json,
      leasePort,
      presenceIntervalMs: typeof existingDaemon?.presenceIntervalMs === 'number' ? existingDaemon.presenceIntervalMs : 500,
      relay: {
        ...relayBase,
        endpoint: `wss://127.0.0.1:${relayPort}`,
        credentialEnv: relayCredentialEnvs.get(agent.id),
        caFile: tlsPaths.certFile,
        connectTimeoutMs: typeof relayBase.connectTimeoutMs === 'number' ? relayBase.connectTimeoutMs : 1000,
        admissionTimeoutMs: typeof relayBase.admissionTimeoutMs === 'number' ? relayBase.admissionTimeoutMs : 1000,
        requestTimeoutMs: typeof relayBase.requestTimeoutMs === 'number' ? relayBase.requestTimeoutMs : 1000,
        maxMessageBytes: typeof relayBase.maxMessageBytes === 'number' ? relayBase.maxMessageBytes : 65536,
        maxBufferedBytes: typeof relayBase.maxBufferedBytes === 'number' ? relayBase.maxBufferedBytes : 65536,
        maxPendingFrames: typeof relayBase.maxPendingFrames === 'number' ? relayBase.maxPendingFrames : 8,
        maxPendingRequests: typeof relayBase.maxPendingRequests === 'number' ? relayBase.maxPendingRequests : 4,
        maxDataConnections: typeof relayBase.maxDataConnections === 'number' ? relayBase.maxDataConnections : 4,
      },
      endpoint,
    }
    daemons.push({
      id: agent.id,
      enabled: agent.enabled,
      configPath: projectionPath,
      role: agent.role,
      ...(agent.connect === undefined ? {} : { connection: agent.connect }),
      ...(agent.services.length === 0 ? {} : { services: agent.services.map(localServiceIntent) }),
    })
    daemonProjections[agent.id] = { projectionPath, enabled: agent.enabled, role: agent.role, config: JSON.stringify(json) }
  }

  let consoleProjection: { readonly projectionPath: string; readonly config: string } | undefined
  let consoleIntent: TomlRecord | undefined
  if (root.console !== undefined) {
    const consoleInput = object(root.console, 'console')
    fields(consoleInput, ['enabled', 'username', 'passwordEnv', 'agentIds'], 'console')
    consoleIntent = { ...consoleInput }
    const consoleEnabled = boolean(consoleInput.enabled, false, 'console.enabled')
    if (consoleEnabled) {
      const consolePath = resolve(projectionDirectory, 'console.json')
      const consolePort = await pickOrReusePort(existing, 'console', availableTcpPort)
      const existingConsole = readExistingProjection(existing?.console?.config)
      const assets = consoleAssetRoots()
      const agentIds = consoleInput.agentIds === undefined ? [] : (() => {
        if (!Array.isArray(consoleInput.agentIds) || consoleInput.agentIds.some(id => typeof id !== 'string' || id.length === 0)
          || new Set(consoleInput.agentIds).size !== consoleInput.agentIds.length) {
          throw new LocalConfigError('console.agentIds must be an array of unique non-empty strings')
        }
        return [...consoleInput.agentIds] as string[]
      })()
      const consoleConfig: TomlRecord = {
        ...existingConsole,
        version: 1,
        enabled: true,
        identity: { ...CONSOLE_IDENTITY },
        scopeId: 'local',
        presenceIntervalMs: 500,
        agentIds,
        listen: {
          ...(isTomlRecord(existingConsole?.listen) ? existingConsole.listen : {}),
          host: '127.0.0.1',
          port: consolePort,
          origin: `http://127.0.0.1:${consolePort}`,
        },
        auth: { username: requiredString(consoleInput.username, 'console.username'), passwordEnv: requiredString(consoleInput.passwordEnv, 'console.passwordEnv') },
        staticRoot: assets.staticRoot,
        uiRoot: assets.uiRoot,
        relay: {
          endpoint: `wss://127.0.0.1:${relayPort}`,
          credentialEnv: CONSOLE_CREDENTIAL_ENV,
          caFile: tlsPaths.certFile,
          connectTimeoutMs: 1000,
          admissionTimeoutMs: 1000,
          requestTimeoutMs: 1000,
          maxMessageBytes: 65536,
          maxBufferedBytes: 65536,
          maxPendingFrames: 8,
          maxPendingRequests: 4,
          maxDataConnections: 4,
        },
      }
      consoleProjection = { projectionPath: consolePath, config: JSON.stringify(consoleConfig) }
      ;(relayConfig.credentials as TomlRecord[]).push({
        credentialEnv: CONSOLE_CREDENTIAL_ENV,
        identity: { accountId: CONSOLE_IDENTITY.accountId, scopeId: 'local', agentId: CONSOLE_IDENTITY.agentId },
      })
    }
  }

  return { relay, relayProjectionPath, relayConfig, daemons, daemonProjections, ...(consoleProjection === undefined ? {} : { consoleProjection }), ...(consoleIntent === undefined ? {} : { consoleIntent }) }
}

function parseV3Config(root: TomlRecord, configPath: string): {
  readonly bridge: { readonly enabled: boolean }
  readonly agents: Readonly<Record<string, unknown>>
  readonly console?: Readonly<Record<string, unknown>>
} {
  fields(root, ['version', 'bridge', 'agents', 'console', 'providers', 'models'], 'local config')
  const bridgeInput = object(root.bridge, 'bridge')
  fields(bridgeInput, ['enabled'], 'bridge')
  const agentsTable = object(root.agents, 'agents')
  for (const id of Object.keys(agentsTable)) assertAgentId(id, `agents.${id}`)
  const consoleInput = root.console === undefined ? undefined : object(root.console, 'console')
  if (consoleInput !== undefined) fields(consoleInput, ['enabled', 'username', 'passwordEnv', 'agentIds'], 'console')
  validateV3ModelReferences(root)
  void configPath
  return {
    bridge: { enabled: boolean(bridgeInput.enabled, true, 'bridge.enabled') },
    agents: agentsTable,
    ...(consoleInput === undefined ? {} : { console: consoleInput }),
  }
}

function validateV3ModelReferences(root: TomlRecord): void {
  const sections = parseConfigUserSections(root)
  for (const [providerId, provider] of Object.entries(sections.providers)) {
    if (provider.auth.kind === 'bearer' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.auth.credentialRef)) {
      throw new LocalConfigError(`providers.${providerId}.credentialEnv must be an environment variable name`)
    }
  }
  const manual = new Set(sections.models.map(entry => `${entry.ref.providerInstanceId}\u0000${entry.ref.modelId}`))
  for (const [agentId, binding] of Object.entries(sections.bindings)) {
    for (const [slot, ref] of [['primary', binding.primary], ['backup', binding.backup]] as const) {
      if (ref === undefined) continue
      if (sections.providers[ref.providerInstanceId] === undefined) {
        throw new LocalConfigError(`agents.${agentId}.model.${slot} references unknown provider ${ref.providerInstanceId}`)
      }
      if (!manual.has(`${ref.providerInstanceId}\u0000${ref.modelId}`)) {
        throw new LocalConfigError(`agents.${agentId}.model.${slot} references model ${ref.modelId} that is not declared by provider ${ref.providerInstanceId}`)
      }
    }
  }
}


function parseLocalConfigText(text: string, configPath: string): LocalConfig {
  let parsed: unknown
  try { parsed = parseToml(text) } catch (cause) { throw new LocalConfigError('local config is not valid TOML', cause) }
  const root = object(parsed, 'local config')
  if (root.version === 3) {
    const v3 = parseV3Config(root, configPath)
    return {
      version: 3,
      configPath,
      relay: { enabled: v3.bridge.enabled, configPath: resolve(dirname(configPath), '.internal', 'projections', 'relay.json') },
      daemons: [],
      internalPath: resolve(dirname(configPath), 'internal.toml'),
      bridge: v3.bridge,
      v3Input: { agents: v3.agents, ...(v3.console === undefined ? {} : { console: v3.console }) },
    }
  }
  if (root.version === 2) {
    fields(root, ['version', 'relay', 'endpoints'], 'local config')
    const relayInput = object(root.relay, 'relay')
    fields(relayInput, ['enabled', 'config'], 'relay')
    const relay = { enabled: boolean(relayInput.enabled, true, 'relay.enabled'), configPath: localPath(requiredString(relayInput.config, 'relay.config'), dirname(configPath)) }
    if (!relay.enabled) throw new LocalConfigError('relay.enabled must be true for a local bridge')
    const endpointTable = object(root.endpoints, 'endpoints')
    const daemons: LocalDaemonSpec[] = []
    const generated: Array<{ readonly id: string; readonly path: string; readonly json: Record<string, unknown> }> = []
    for (const [id, value] of Object.entries(endpointTable)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new LocalConfigError(`endpoints.${id} is not a valid endpoint id`)
      if (id === 'relay') throw new LocalConfigError('endpoints.relay is reserved for the local Relay process')
      const parsed = endpointConfig(object(value, `endpoints.${id}`), id, configPath)
      daemons.push(parsed.spec); generated.push({ id, path: parsed.spec.configPath, json: parsed.json })
    }
    if (daemons.length === 0 || !daemons.some(daemon => daemon.enabled)) throw new LocalConfigError('at least one enabled endpoint is required')
    const result = Object.assign({ version: 2 as const, configPath, relay, daemons,
      internalPath: resolve(dirname(configPath), 'internal.toml') }, { generated })
    return result
  }
  fields(root, ['version', 'relay', 'daemons'], 'local config')
  if (root.version !== LOCAL_CONFIG_VERSION) throw new LocalConfigError(`local config version must be ${LOCAL_CONFIG_VERSION}`)
  const baseDirectory = dirname(configPath)

  const relayInput = object(root.relay, 'relay')
  fields(relayInput, ['enabled', 'config'], 'relay')
  const relay = { enabled: boolean(relayInput.enabled, true, 'relay.enabled'), configPath: localPath(requiredString(relayInput.config, 'relay.config'), baseDirectory) }

  const daemonTable = object(root.daemons, 'daemons')
  const daemons: LocalDaemonSpec[] = []
  for (const [id, value] of Object.entries(daemonTable)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new LocalConfigError(`daemons.${id} is not a valid daemon id`)
    if (id === 'relay') throw new LocalConfigError('daemons.relay is reserved for the local Relay process')
    const input = object(value, `daemons.${id}`)
    fields(input, ['enabled', 'config'], `daemons.${id}`)
    daemons.push({ id, enabled: boolean(input.enabled, true, `daemons.${id}.enabled`), configPath: localPath(requiredString(input.config, `daemons.${id}.config`), baseDirectory) })
  }
  if (!relay.enabled) throw new LocalConfigError('relay.enabled must be true for a local bridge')
  if (daemons.length === 0 || !daemons.some(daemon => daemon.enabled)) throw new LocalConfigError('at least one enabled daemon is required')
  return { version: 1, configPath, relay, daemons }
}

export function defaultLocalConfigPath(home = homedir()): string {
  return resolve(home, '.agentteams', 'config.toml')
}

async function readInternalOrUndefined(internalPath: string): Promise<LocalInternalConfig | undefined> {
  try { return await readLocalInternalConfig(internalPath) }
  catch (cause) {
    const errorCause = (cause as { cause?: NodeJS.ErrnoException })?.cause
    if (errorCause?.code === 'ENOENT') return undefined
    throw cause
  }
}

function validateMigrationRecovery(migration: LocalInternalMigration): void {
  if (configSourceHash(migration.candidateConfigText) !== migration.intendedSourceHash) {
    throw new LocalConfigError('pending migration candidate text does not match intendedSourceHash')
  }
  let recovery: unknown
  try { recovery = JSON.parse(migration.recovery) }
  catch (cause) { throw new LocalConfigError('pending migration recovery record is not valid JSON', cause) }
  if (typeof recovery !== 'object' || recovery === null || Array.isArray(recovery)) {
    throw new LocalConfigError('pending migration recovery record must be an object')
  }
  const record = recovery as Record<string, unknown>
  for (const key of ['accepted', 'effective', 'catalogs', 'bindings'] as const) {
    if (record[key] !== undefined && (typeof record[key] !== 'object' || record[key] === null || Array.isArray(record[key]))) {
      throw new LocalConfigError(`pending migration recovery.${key} must be a table`)
    }
  }
}

/**
 * Unique pending-migration recovery entry point. Caller must already hold the
 * internal lock. Uses only the durable `[migration]` snapshot; never re-scans or
 * rewrites legacy inputs. Returns after `[migration].phase` reaches `verified`.
 */
export async function resumePendingMigration(internalPath: string): Promise<void> {
  const path = localPath(internalPath, process.cwd())
  const existing = await readInternalOrUndefined(path)
  const migration = existing?.migration
  if (existing === undefined || migration === undefined || migration.phase === 'verified') return
  validateMigrationRecovery(migration)
  const configPath = localPath(migration.sourcePath, process.cwd())
  const targetText = await readConfigTextOrEmpty(configPath)
  const targetHash = configSourceHash(targetText)
  let committed = migration.phase === 'config-committed'
  if (targetHash === migration.intendedSourceHash) {
    committed = true
  } else if (targetHash === migration.sourceBeforeHash) {
    await writeConfigAtomically(configPath, migration.candidateConfigText)
    const written = configSourceHash(await readConfigTextOrEmpty(configPath))
    if (written !== migration.intendedSourceHash) throw new LocalConfigError('pending migration could not commit the candidate config source')
    committed = true
  } else {
    throw new LocalConfigError('pending migration target config.toml was edited by the user; migration source conflict')
  }
  const admitted = await admitMachineSourceUnlocked(path, migration.candidateConfigText, existing)
  let current = await readInternalOrUndefined(path) ?? existing
  if (committed && current.migration?.phase === 'prepared') {
    current = { ...current, migration: { ...migration, phase: 'config-committed', committedAt: current.migration.committedAt ?? new Date().toISOString() } }
    await writeLocalInternalConfig(path, { ...current, sourceRevision: admitted.sourceRevision, sourceHash: admitted.sourceHash, updatedAt: new Date().toISOString() })
  }
  const latest = await readInternalOrUndefined(path) ?? current
  if (latest.migration?.phase === 'config-committed') {
    await writeLocalInternalConfig(path, {
      ...latest,
      migration: { ...latest.migration, phase: 'verified', verifiedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    })
  }
}

async function persistLocalV3ConfigLocked(
  configPath: string,
  text: string,
  internalPath: string,
  parsed: LocalConfig,
  result: CompiledV3Config,
): Promise<LocalConfig> {
  const existing = await readInternalOrUndefined(internalPath)
  const admitted = await admitMachineSourceUnlocked(internalPath, text, existing)
  const latest = await readInternalOrUndefined(internalPath)
  const daemons: Record<string, LocalInternalDaemonConfig> = { ...(latest?.daemons ?? {}) }
  for (const [id, daemon] of Object.entries(daemons)) daemons[id] = { ...daemon, orphaned: true }
  if (daemons.relay !== undefined) daemons.relay = { ...daemons.relay, orphaned: false }
  for (const [id, projection] of Object.entries(result.daemonProjections)) {
    const runtime = latest?.daemons?.[id]
    daemons[id] = {
      ...projection,
      orphaned: false,
      ...(runtime?.pid === undefined ? {} : { pid: runtime.pid }),
      ...(runtime?.generation === undefined ? {} : { generation: runtime.generation }),
      ...(runtime?.state === undefined ? {} : { state: runtime.state }),
      ...(runtime?.entryPath === undefined ? {} : { entryPath: runtime.entryPath }),
      ...(runtime?.startToken === undefined ? {} : { startToken: runtime.startToken }),
    }
  }
  await writeLocalInternalConfig(internalPath, {
    ...(latest ?? { version: 2 as const }),
    version: 2,
    sourceRevision: admitted.sourceRevision,
    sourceHash: admitted.sourceHash,
    sourcePath: configPath,
    generatedAt: latest?.generatedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    relay: { projectionPath: result.relayProjectionPath, config: JSON.stringify(result.relayConfig) },
    console: result.consoleProjection,
    daemons,
    configRuntime: latest?.configRuntime ?? { accepted: {}, effective: {}, catalogs: {} },
  })
  return {
    version: 3,
    configPath,
    relay: result.relay,
    daemons: result.daemons,
    ...(result.consoleProjection === undefined ? {} : { console: { enabled: true as const, configPath: result.consoleProjection.projectionPath } }),
    internalPath,
    bridge: parsed.bridge ?? { enabled: true },
    ...(parsed.v3Input === undefined ? {} : { v3Input: parsed.v3Input }),
  }
}

async function loadLocalV3ConfigLocked(
  configPath: string,
  text: string,
  internalPath: string,
  parsed: LocalConfig,
): Promise<LocalConfig> {
  const existing = await readInternalOrUndefined(internalPath)
  // Validate/compile the full v3 intent before any machine-source write, so an
  // invalid hand-edit cannot advance sourceRevision or daemon accepted facts.
  const result = await compileV3Config(configRoot(text, configPath), configPath, existing)
  return await persistLocalV3ConfigLocked(configPath, text, internalPath, parsed, result)
}

export async function loadLocalConfig(path = defaultLocalConfigPath()): Promise<LocalConfig> {
  const configPath = localPath(path, process.cwd())
  let text: string
  try { text = await readFile(configPath, 'utf8') }
  catch (cause) { throw new LocalConfigError(`local config cannot be read: ${configPath}`, cause) }
  const internalPath = resolve(dirname(configPath), 'internal.toml')
  const pendingInternal = await readInternalOrUndefined(internalPath)
  if (pendingInternal?.migration !== undefined && pendingInternal.migration.phase !== 'verified') {
    await withLocalInternalConfigLock(internalPath, async () => { await resumePendingMigration(internalPath) })
    text = await readFile(configPath, 'utf8')
  }
  const parsed = parseLocalConfigText(text, configPath) as LocalConfig & {
    readonly generated?: readonly { readonly id: string; readonly path: string; readonly json: Record<string, unknown> }[]
  }
  if (parsed.version === 3) {
    return await withLocalInternalConfigLock(internalPath, async () => await loadLocalV3ConfigLocked(configPath, text, internalPath, parsed))
  }
  if (parsed.version === 2) {
    const projectionDirectory = resolve(dirname(configPath), '.internal', 'projections')
    const relayProjectionPath = resolve(projectionDirectory, 'relay.json')
    const configRevision = `sha256:${createHash('sha256').update(text).digest('hex')}`
    let existing: LocalInternalConfig | undefined
    try { existing = await readLocalInternalConfig(internalPath) }
    catch (cause) {
      const errorCause = (cause as { cause?: NodeJS.ErrnoException })?.cause
      if (errorCause?.code !== 'ENOENT') throw cause
    }
    const reusable = existing?.configRevision === configRevision
      && existing.relay?.config !== undefined
      && parsed.daemons.every(daemon => existing.daemons?.[daemon.id]?.config !== undefined)
    let relayConfig: Record<string, unknown>
    if (reusable) {
      try {
        const value = JSON.parse(existing!.relay!.config!) as unknown
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalConfigError('internal relay config must be an object')
        relayConfig = value as Record<string, unknown>
      } catch (cause) {
        if (cause instanceof LocalConfigError) throw cause
        throw new LocalConfigError(`internal relay config is not valid JSON: ${internalPath}`, cause)
      }
    } else {
      let relayText: string
      try { relayText = await readFile(parsed.relay.configPath, 'utf8') }
      catch (cause) { throw new LocalConfigError(`relay config cannot be read: ${parsed.relay.configPath}`, cause) }
      try {
        const value = JSON.parse(relayText) as unknown
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalConfigError('relay config must be an object')
        relayConfig = value as Record<string, unknown>
      } catch (cause) {
        if (cause instanceof LocalConfigError) throw cause
        throw new LocalConfigError(`relay config is not valid JSON: ${parsed.relay.configPath}`, cause)
      }
    }
    relayConfig = resolveRelayTlsPaths(relayConfig, dirname(parsed.relay.configPath))
    const daemonProjections: Record<string, LocalInternalDaemonConfig> = {}
    const daemons = parsed.daemons.map(daemon => {
      const source = parsed.generated?.find(item => item.id === daemon.id)
      if (source === undefined) throw new LocalConfigError(`endpoint ${daemon.id} projection is missing`)
      const projectionPath = resolve(projectionDirectory, `${daemon.id}.json`)
      daemonProjections[daemon.id] = reusable
        ? { ...existing!.daemons![daemon.id], projectionPath, enabled: daemon.enabled, ...(daemon.role === undefined ? {} : { role: daemon.role }) }
        : { projectionPath, enabled: daemon.enabled, ...(daemon.role === undefined ? {} : { role: daemon.role }), config: JSON.stringify(source.json) }
      return { ...daemon, configPath: projectionPath }
    })
    const internal: LocalInternalConfig = {
      version: 1,
      configRevision,
      sourcePath: configPath,
      generatedAt: existing?.generatedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(existing?.launcher === undefined ? {} : { launcher: existing.launcher }),
      relay: { ...(reusable ? existing!.relay : {}), projectionPath: relayProjectionPath, config: reusable ? existing!.relay!.config : JSON.stringify(relayConfig) },
      daemons: daemonProjections,
    }
    await withLocalInternalConfigLock(internalPath, async () => {
      let latest: LocalInternalConfig | undefined
      try { latest = await readLocalInternalConfig(internalPath) }
      catch (cause) {
        const errorCause = (cause as { cause?: NodeJS.ErrnoException })?.cause
        if (errorCause?.code !== 'ENOENT') throw cause
      }
      const latestDaemons = latest?.daemons ?? {}
      const mergedDaemons: Record<string, LocalInternalDaemonConfig> = Object.fromEntries(Object.entries(latestDaemons).map(([id, daemon]) => [id, { ...daemon, orphaned: true }]))
      if (latestDaemons.relay !== undefined) mergedDaemons.relay = { ...latestDaemons.relay, orphaned: false }
      for (const [id, projection] of Object.entries(internal.daemons ?? {})) {
        const runtime = latestDaemons[id]
        mergedDaemons[id] = {
          ...projection,
          orphaned: false,
          ...(runtime?.pid === undefined ? {} : { pid: runtime.pid }),
          ...(runtime?.generation === undefined ? {} : { generation: runtime.generation }),
          ...(runtime?.state === undefined ? {} : { state: runtime.state }),
          ...(runtime?.entryPath === undefined ? {} : { entryPath: runtime.entryPath }),
          ...(runtime?.startToken === undefined ? {} : { startToken: runtime.startToken }),
        }
      }
      await writeLocalInternalConfig(internalPath, {
        ...internal,
        ...(latest?.launcher === undefined ? {} : { launcher: latest.launcher }),
        daemons: mergedDaemons,
      })
    })
    return { ...parsed, relay: { enabled: parsed.relay.enabled, configPath: relayProjectionPath }, daemons, internalPath }
  }
  return parsed
}

export interface WriteLocalConfigOptions {
  /** Create the config only when it does not already exist; never replace an existing file. */
  readonly exclusive?: boolean
}

/** Persist operator-authored TOML atomically; validation remains the startup gate. */
export async function writeLocalConfig(path: string, text: string, options: WriteLocalConfigOptions = {}): Promise<string> {
  const configPath = localPath(path, process.cwd())
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  if (options.exclusive === true) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(configPath, 'wx', 0o600)
      await handle.writeFile(text, { encoding: 'utf8' })
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close() } catch { /* preserve original failure */ }
        try { await unlink(configPath) } catch { /* preserve original failure */ }
      }
      throw error
    }
    await handle.close()
    return configPath
  }
  const temporary = `${configPath}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, configPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
  return configPath
}

export interface InitializeLocalConfigResult {
  readonly configPath: string
  readonly internalPath: string
}

/**
 * Unique v3 init/bootstrap caller. Creates user intent and runtime-owned TLS
 * under the same internal short lock, then compiles internal.toml v2 through
 * the same v3 producer used by loadLocalConfig.
 */
export async function initializeLocalConfig(path: string, text: string): Promise<InitializeLocalConfigResult> {
  const configPath = localPath(path, process.cwd())
  const internalPath = resolve(dirname(configPath), 'internal.toml')
  const parsed = parseLocalConfigText(text, configPath)
  if (parsed.version !== 3) throw new LocalConfigError('initializeLocalConfig requires version = 3 user intent')
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  return await withLocalInternalConfigLock(internalPath, async () => {
    try {
      await lstat(configPath)
      throw new LocalConfigError(`config already exists: ${configPath}`)
    } catch (cause) {
      if (cause instanceof LocalConfigError) throw cause
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalConfigError(`config path cannot be inspected: ${configPath}`, cause)
      }
    }
    const existing = await readInternalOrUndefined(internalPath)
    const result = await compileV3Config(configRoot(text, configPath), configPath, existing)
    await ensureLocalBridgeTls(dirname(configPath))
    try {
      await writeLocalConfig(configPath, text, { exclusive: true })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new LocalConfigError(`config already exists: ${configPath}`, cause)
      throw new LocalConfigError(`cannot create config: ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
    }
    await persistLocalV3ConfigLocked(configPath, text, internalPath, parsed, result)
    return { configPath, internalPath }
  })
}

export interface LocalInternalDaemonState {
  readonly pid: number
  readonly generation?: number
  readonly entryPath?: string
  readonly startToken?: string
  readonly state: 'online' | 'stopped' | 'failed'
}

export async function writeLocalInternalState(path: string, daemons: Readonly<Record<string, LocalInternalDaemonState>>): Promise<string> {
  const internalPath = localPath(path, process.cwd())
  return withLocalInternalConfigLock(internalPath, async () => {
    let existing: LocalInternalConfig
    try { existing = await readLocalInternalConfig(internalPath) }
    catch (error) {
      const cause = (error as { cause?: NodeJS.ErrnoException })?.cause
      if (cause?.code === 'ENOENT') existing = { version: 1 }
      else throw error
    }
    const mergedDaemons = { ...(existing.daemons ?? {}) }
    for (const [id, state] of Object.entries(daemons)) {
      const previous = mergedDaemons[id]
      if (previous?.generation !== undefined && state.generation !== undefined && previous.generation > state.generation) continue
      mergedDaemons[id] = {
        ...(previous ?? {}),
        pid: state.pid,
        state: state.state,
        ...(state.generation === undefined ? {} : { generation: state.generation }),
        ...(state.entryPath === undefined ? {} : { entryPath: state.entryPath }),
        ...(state.startToken === undefined ? {} : { startToken: state.startToken }),
      }
    }
    return writeLocalInternalConfig(internalPath, { ...existing, updatedAt: new Date().toISOString(), daemons: mergedDaemons })
  })
}

export interface LocalInternalRecoveryOptions {
  /** Console classification to persist with the recovered launcher. */
  readonly consoleRuntime?: Readonly<ConsoleRuntimePatch>
  /**
   * Drop the previous launcher's `[workControl]` refs. Dead-launcher recovery
   * replaces the launcher that published them, so keeping them would contradict
   * the recovered generation and make every later internal read fail the exact
   * work-control refs check.
   */
  readonly clearWorkControl?: boolean
}

export async function writeLocalInternalRecoveryState(path: string, daemons: Readonly<Record<string, LocalInternalDaemonState>>, launcher: LocalInternalLauncherConfig, options: Readonly<LocalInternalRecoveryOptions> = {}): Promise<string> {
  const internalPath = localPath(path, process.cwd())
  return withLocalInternalConfigLock(internalPath, async () => {
    let existing: LocalInternalConfig
    try { existing = await readLocalInternalConfig(internalPath) }
    catch (error) {
      const cause = (error as { cause?: NodeJS.ErrnoException })?.cause
      if (cause?.code === 'ENOENT') existing = { version: 1 }
      else throw error
    }
    const mergedDaemons = { ...(existing.daemons ?? {}) }
    for (const [id, state] of Object.entries(daemons)) {
      const previous = mergedDaemons[id]
      if (previous?.generation !== undefined && state.generation !== undefined && previous.generation > state.generation) continue
      mergedDaemons[id] = { ...(previous ?? {}), pid: state.pid, state: state.state, ...(state.generation === undefined ? {} : { generation: state.generation }), ...(state.entryPath === undefined ? {} : { entryPath: state.entryPath }), ...(state.startToken === undefined ? {} : { startToken: state.startToken }) }
    }
    if (existing.launcher?.generation !== undefined && existing.launcher.generation > launcher.generation) return internalPath
    // Recovery owns every child the launcher started, including the Console child,
    // so its classification is written in the same short-lock write that records
    // the recovered launcher and daemons.
    const recoveredConsole = options.consoleRuntime === undefined ? existing.consoleRuntime : applyConsoleRuntimePatch(existing.consoleRuntime ?? {}, options.consoleRuntime)
    const carried = options.clearWorkControl === true ? { ...existing, workControl: undefined } : existing
    return writeLocalInternalConfig(internalPath, { ...carried, updatedAt: new Date().toISOString(), daemons: mergedDaemons, launcher, ...(recoveredConsole === undefined ? {} : { consoleRuntime: recoveredConsole }) })
  })
}

export async function writeLocalInternalLauncherState(path: string, launcher: LocalInternalLauncherConfig): Promise<string> {
  const internalPath = localPath(path, process.cwd())
  return withLocalInternalConfigLock(internalPath, async () => {
    let existing: LocalInternalConfig
    try { existing = await readLocalInternalConfig(internalPath) }
    catch (error) {
      const cause = (error as { cause?: NodeJS.ErrnoException })?.cause
      if (cause?.code === 'ENOENT') existing = { version: 1 }
      else throw error
    }
    if (existing.launcher?.generation !== undefined && existing.launcher.generation > launcher.generation) return internalPath
    return writeLocalInternalConfig(internalPath, { ...existing, updatedAt: new Date().toISOString(), launcher })
  })
}

/** Read the U4-owned socket lifecycle reference without adding another lock or store. */
export async function readLocalInternalWorkControl(path: string): Promise<LocalInternalWorkControl | undefined> {
  const internalPath = localPath(path, process.cwd())
  const internal = await readLocalInternalConfig(internalPath)
  if (internal.workControl === undefined) return undefined
  exactWorkControlRefs(internal.workControl, internal.launcher)
  return internal.workControl
}

/**
 * U4-owned socket lifecycle primitive. The caller supplies the exact launcher
 * refs; `undefined` deletes only `[workControl]` under the existing internal lock.
 */
export async function writeLocalInternalWorkControl(
  path: string,
  value: LocalInternalWorkControl | undefined,
): Promise<string> {
  const internalPath = localPath(path, process.cwd())
  return withLocalInternalConfigLock(internalPath, async () => {
    const existing = await readLocalInternalConfig(internalPath)
    if (value !== undefined) {
      const expectedSocketPath = resolve(dirname(internalPath), '.internal', 'work-control.sock')
      if (value.socketPath !== expectedSocketPath) throw new LocalConfigError(`workControl.socketPath must be the fixed absolute path ${expectedSocketPath}`)
      const launcherGeneration = optionalNumber(value.launcherGeneration, 'workControl.launcherGeneration')
      if (launcherGeneration === undefined || launcherGeneration < 0) throw new LocalConfigError('workControl.launcherGeneration must be a non-negative safe integer')
      exactWorkControlRefs({ ...value, launcherGeneration }, existing.launcher)
      return writeLocalInternalConfig(internalPath, {
        ...existing,
        updatedAt: new Date().toISOString(),
        workControl: { ...value, launcherGeneration, launcherStartToken: requiredString(value.launcherStartToken, 'workControl.launcherStartToken') },
      })
    }
    const next = { ...existing, updatedAt: new Date().toISOString() }
    delete next.workControl
    return writeLocalInternalConfig(internalPath, next)
  })
}

// ---------------------------------------------------------------------------
// U2 v3 config.toml store-owned sections and the production TOML persistence.
// ---------------------------------------------------------------------------

const MODEL_METADATA_KEYS = ['label', 'contextWindow', 'maxOutputTokens', 'tools', 'streaming', 'reasoning', 'inputModalities', 'outputModalities'] as const

function modelRefFromToml(value: unknown, label: string): { readonly providerInstanceId: string; readonly modelId: string } {
  const input = object(value, label)
  fields(input, ['provider', 'model'], label)
  return { providerInstanceId: requiredString(input.provider, `${label}.provider`), modelId: requiredString(input.model, `${label}.model`) }
}

function modelMetadataFromToml(input: Record<string, unknown>, label: string): ModelMetadata {
  const metadata: Record<string, unknown> = {}
  for (const key of MODEL_METADATA_KEYS) if (input[key] !== undefined) metadata[key] = input[key]
  return metadata as ModelMetadata
}

function providerFromToml(id: string, value: unknown): ProviderInstance {
  const input = object(value, `providers.${id}`)
  fields(input, ['protocol', 'apiBaseUrl', 'label', 'enabled', 'credentialEnv'], `providers.${id}`)
  const protocol = oneOf(input.protocol, ['openai-chat', 'openai-responses'] as const, `providers.${id}.protocol`)
  const credentialRef = input.credentialEnv === undefined ? undefined : requiredString(input.credentialEnv, `providers.${id}.credentialEnv`)
  return {
    id,
    label: requiredString(input.label, `providers.${id}.label`),
    protocol,
    apiBaseUrl: requiredString(input.apiBaseUrl, `providers.${id}.apiBaseUrl`),
    enabled: boolean(input.enabled, true, `providers.${id}.enabled`),
    auth: credentialRef === undefined ? { kind: 'none' } : { kind: 'bearer', credentialRef },
  }
}

/** Parse the store-owned provider/model/binding user intent from a v3 config root. */
export function parseConfigUserSections(root: Record<string, unknown>): RuntimeConfigStoreSections {
  const providers: Record<string, ProviderInstance> = {}
  if (root.providers !== undefined) {
    for (const [id, value] of Object.entries(object(root.providers, 'providers'))) providers[id] = providerFromToml(id, value)
  }
  const models: ModelEntry[] = []
  if (root.models !== undefined) {
    if (!Array.isArray(root.models)) throw new LocalConfigError('models must be an array of tables')
    for (const [index, value] of root.models.entries()) {
      const input = object(value, `models[${index}]`)
      fields(input, ['provider', 'id', ...MODEL_METADATA_KEYS], `models[${index}]`)
      const providerInstanceId = requiredString(input.provider, `models[${index}].provider`)
      const modelId = requiredString(input.id, `models[${index}].id`)
      models.push({ ref: { providerInstanceId, modelId }, origin: 'manual', base: modelMetadataFromToml(input, `models[${index}]`), overrides: {} })
    }
  }
  const bindings: Record<string, AgentModelBinding> = {}
  if (root.agents !== undefined) {
    for (const [agentId, value] of Object.entries(object(root.agents, 'agents'))) {
      const agent = object(value, `agents.${agentId}`)
      if (agent.model === undefined) continue
      const model = object(agent.model, `agents.${agentId}.model`)
      fields(model, ['primary', 'backup'], `agents.${agentId}.model`)
      bindings[agentId] = {
        primary: modelRefFromToml(model.primary, `agents.${agentId}.model.primary`),
        ...(model.backup === undefined ? {} : { backup: modelRefFromToml(model.backup, `agents.${agentId}.model.backup`) }),
      }
    }
  }
  return { providers, models, bindings }
}

function providerToToml(provider: ProviderInstance): TomlRecord {
  return {
    protocol: provider.protocol,
    apiBaseUrl: provider.apiBaseUrl,
    label: provider.label,
    enabled: provider.enabled,
    ...(provider.auth.kind === 'bearer' ? { credentialEnv: provider.auth.credentialRef } : {}),
  }
}

function modelToToml(entry: ModelEntry): TomlRecord {
  return {
    provider: entry.ref.providerInstanceId,
    id: entry.ref.modelId,
    ...entry.base,
    ...entry.overrides,
  }
}

function bindingToToml(binding: AgentModelBinding): TomlRecord {
  return {
    primary: { provider: binding.primary.providerInstanceId, model: binding.primary.modelId },
    ...(binding.backup === undefined ? {} : { backup: { provider: binding.backup.providerInstanceId, model: binding.backup.modelId } }),
  }
}

/**
 * Replace only store-owned provider/model/binding user sections, preserving
 * bridge/agents identity/services/connect/console and unknown-but-declared tables.
 */
export function writeConfigUserSections(root: Record<string, unknown>, sections: RuntimeConfigStoreSections): TomlRecord {
  const next: TomlRecord = { ...root }
  if (Object.keys(sections.providers).length === 0) delete next.providers
  else next.providers = Object.fromEntries(Object.entries(sections.providers).map(([id, provider]) => [id, providerToToml(provider)]))
  if (sections.models.length === 0) delete next.models
  else next.models = sections.models.map(modelToToml)
  const agents = Object.fromEntries(Object.entries(isTomlRecord(root.agents) ? root.agents : {}).map(([id, value]) => [id, { ...(isTomlRecord(value) ? value : {}) }]))
  for (const agent of Object.keys(agents)) delete (agents[agent] as TomlRecord).model
  for (const [agentId, binding] of Object.entries(sections.bindings)) {
    agents[agentId] = { ...(agents[agentId] ?? {}), model: bindingToToml(binding) }
  }
  if (Object.keys(agents).length === 0) delete next.agents
  else next.agents = agents
  return next
}

function snapshotFromSections(sections: RuntimeConfigStoreSections): VersionedRuntimeConfig {
  const catalogs: Record<string, { state: 'ready' | 'empty'; entries: ModelEntry[] }> = {}
  for (const provider of Object.values(sections.providers)) {
    const entries = sections.models.filter(entry => entry.ref.providerInstanceId === provider.id).map(entry => structuredClone(entry))
    catalogs[provider.id] = { state: entries.length === 0 ? 'empty' : 'ready', entries }
  }
  return { revision: 0, acceptedRevision: 0, providers: structuredClone(sections.providers), catalogs, agents: structuredClone(sections.bindings) }
}

function parseJson<T>(text: string, label: string): T {
  try { return JSON.parse(text) as T }
  catch (cause) { throw new LocalConfigError(`${label} is not valid JSON`, cause) }
}

function effectiveApplyError(slice: LocalInternalConfigRuntimeEffective): ConfigApplyError | undefined {
  return slice.lastApplyError === undefined ? undefined : parseJson<ConfigApplyError>(slice.lastApplyError, 'configRuntime.effective.lastApplyError')
}

function effectiveUncertainty(slice: LocalInternalConfigRuntimeEffective): readonly ManagedConfigUncertainty[] {
  return slice.uncertain === undefined ? [] : parseJson<readonly ManagedConfigUncertainty[]>(slice.uncertain, 'configRuntime.effective.uncertain')
}

function sameUncertaintyIdentity(left: ManagedConfigUncertainty, right: ManagedConfigUncertainty): boolean {
  return left.operation.operationId === right.operation.operationId &&
    left.operation.kind === right.operation.kind &&
    left.target.agentId === right.target.agentId &&
    left.target.targetGeneration === right.target.targetGeneration &&
    left.target.acceptedRevision === right.target.acceptedRevision &&
    left.target.acceptedSourceRevision === right.target.acceptedSourceRevision &&
    left.target.acceptedSourceHash === right.target.acceptedSourceHash &&
    left.target.endpointFingerprint === right.target.endpointFingerprint &&
    left.target.credentialRef === right.target.credentialRef &&
    left.substrate.pid === right.substrate.pid &&
    left.substrate.effectiveRevision === right.substrate.effectiveRevision &&
    left.substrate.effectiveHandleFingerprint === right.substrate.effectiveHandleFingerprint
}

async function readConfigTextOrEmpty(configPath: string): Promise<string> {
  try { return await readFile(configPath, 'utf8') }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new LocalConfigError(`local config cannot be read: ${configPath}`, cause)
  }
}

async function readInternalOrEmpty(internalPath: string): Promise<LocalInternalConfig> {
  try { return await readLocalInternalConfig(internalPath) }
  catch (cause) {
    const errorCause = (cause as { cause?: NodeJS.ErrnoException })?.cause
    if (errorCause?.code === 'ENOENT') return { version: 2, configRuntime: { accepted: {}, effective: {}, catalogs: {} } }
    throw cause
  }
}

function configRoot(text: string, configPath: string): TomlRecord {
  if (text.trim() === '') return { version: 3 }
  let parsed: unknown
  try { parsed = parseToml(text) } catch (cause) { throw new LocalConfigError(`local config is not valid TOML: ${configPath}`, cause) }
  return object(parsed, 'local config')
}

async function writeConfigAtomically(configPath: string, text: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporary = `${configPath}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, configPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
}

function acceptedSlice(internal: LocalInternalConfig, agentId: string): LocalInternalConfigRuntimeAccepted | undefined {
  return internal.configRuntime?.accepted[agentId]
}

function effectiveSlice(internal: LocalInternalConfig, agentId: string): LocalInternalConfigRuntimeEffective {
  return internal.configRuntime?.effective[agentId] ?? {}
}

function observationsFor(internal: LocalInternalConfig, agentId: string): Readonly<Record<string, LocalInternalConfigRuntimeCatalog>> {
  return internal.configRuntime?.catalogs[agentId] ?? {}
}

function manualEntriesOf(snapshot: VersionedRuntimeConfig, providerInstanceId: string): ModelEntry[] {
  return (snapshot.catalogs[providerInstanceId]?.entries ?? []).filter(entry => entry.origin === 'manual').map(entry => structuredClone(entry))
}

/** Production daemon persistence bound to one Agent; the only writable TOML config owner. */
export function createTomlRuntimeConfigPersistence(options: {
  readonly configPath: string
  readonly internalPath: string
  readonly agentId: string
}): RuntimeConfigPersistence {
  const configPath = localPath(options.configPath, process.cwd())
  const internalPath = localPath(options.internalPath, process.cwd())
  const agentId = options.agentId

  const buildView = async (targetAgentId: string): Promise<DaemonRuntimeConfigView> => {
    const text = await readConfigTextOrEmpty(configPath)
    const internal = await readInternalOrEmpty(internalPath)
    const sections = text.trim() === '' ? { providers: {}, models: [], bindings: {} } : parseConfigUserSections(configRoot(text, configPath))
    const accepted = acceptedSlice(internal, targetAgentId)
    const snapshot = accepted?.snapshot === undefined ? snapshotFromSections(sections) : parseJson<VersionedRuntimeConfig>(accepted.snapshot, `configRuntime.accepted.${targetAgentId}.snapshot`)
    const effective = effectiveSlice(internal, targetAgentId)
    const observations = observationsFor(internal, targetAgentId)
    const catalogs: Record<string, { state: VersionedRuntimeConfig['catalogs'][string]['state']; entries: ModelEntry[]; refreshedAt?: string; error?: ConfigApplyError }> = {}
    for (const provider of Object.values(snapshot.providers)) {
      const manual = manualEntriesOf(snapshot, provider.id)
      const observation = observations[provider.id]
      if (observation === undefined) {
        catalogs[provider.id] = { state: manual.length === 0 ? 'empty' : 'ready', entries: manual }
        continue
      }
      const discovered = observation.entries === undefined ? [] : parseJson<ModelEntry[]>(observation.entries, `configRuntime.catalogs.${targetAgentId}.${provider.id}.entries`)
      const current = observation.providerFingerprint === providerIntentFingerprint(provider)
      catalogs[provider.id] = current
        ? {
            state: observation.state, entries: [...manual, ...discovered],
            ...(observation.refreshedAt === undefined ? {} : { refreshedAt: observation.refreshedAt }),
            ...(observation.error === undefined ? {} : { error: parseJson<ConfigApplyError>(observation.error, 'catalog error') }),
          }
        : { state: 'stale', entries: [...manual, ...discovered.map(entry => ({ ...entry, availability: 'unavailable' as const }))] }
    }
    const lastApplyError = effectiveApplyError(effective)
    return {
      agentId: targetAgentId,
      revision: accepted?.acceptedRevision ?? 0,
      acceptedRevision: accepted?.acceptedRevision ?? 0,
      ...(effective.effectiveRevision === undefined ? {} : { effectiveRevision: effective.effectiveRevision }),
      providers: structuredClone(snapshot.providers),
      catalogs,
      agents: structuredClone(snapshot.agents),
      ...(lastApplyError === undefined ? {} : { lastApplyError }),
      sourceRevision: internal.sourceRevision ?? 0,
      sourceHash: configSourceHash(text),
      acceptedSourceRevision: accepted?.acceptedSourceRevision ?? 0,
      acceptedSourceHash: accepted?.acceptedSourceHash ?? '',
      applyState: effective.applyState ?? ((effectiveUncertainty(effective).length > 0) ? 'uncertain' : 'clean'),
      targetGeneration: internal.daemons?.[targetAgentId]?.generation ?? 1,
      ...(effectiveUncertainty(effective).length === 0 ? {} : { uncertain: effectiveUncertainty(effective) }),
    } as DaemonRuntimeConfigView & { readonly uncertain?: readonly ManagedConfigUncertainty[] }
  }

  const targetMatchesView = (view: DaemonRuntimeConfigView, target: ConfigTargetIdentity, provider?: ProviderInstance): boolean => {
    if (target.agentId !== view.agentId) return false
    if (target.targetGeneration !== view.targetGeneration) return false
    if (target.acceptedRevision !== view.acceptedRevision) return false
    if (target.acceptedSourceRevision !== view.acceptedSourceRevision) return false
    if (target.acceptedSourceHash !== view.acceptedSourceHash) return false
    if (target.endpointFingerprint !== '') {
      if (provider === undefined || providerIntentFingerprint(provider) !== target.endpointFingerprint) return false
      const credentialRef = provider.auth.kind === 'bearer' ? provider.auth.credentialRef : undefined
      if (credentialRef !== target.credentialRef) return false
    }
    return true
  }

  const persistInternal = async (internal: LocalInternalConfig, patch: (current: LocalInternalConfigRuntime) => LocalInternalConfigRuntime): Promise<void> => {
    const current: LocalInternalConfigRuntime = internal.configRuntime ?? { accepted: {}, effective: {}, catalogs: {} }
    await writeLocalInternalConfig(internalPath, { ...internal, version: 2, configRuntime: patch(current), updatedAt: new Date().toISOString() })
  }

  return {
    agentId,
    withLock: task => withLocalInternalConfigLock(internalPath, task),
    loadDaemonUnlocked: buildView,
    saveMachineSourceUnlocked: async input => {
      const text = await readConfigTextOrEmpty(configPath)
      const currentHash = configSourceHash(text)
      const internal = await readInternalOrEmpty(internalPath)
      if (internal.sourceRevision !== undefined && internal.sourceRevision !== input.expectedSourceRevision) {
        throw new LocalConfigError('config: machine source revision changed during mutation')
      }
      if (currentHash !== input.expectedSourceHash && text.trim() !== '') {
        throw new LocalConfigError('config: config.toml changed during mutation')
      }
      const root = configRoot(text, configPath)
      const nextText = serializeTomlDocument(writeConfigUserSections(root, input.sections))
      const admitted = await admitMachineSourceUnlocked(internalPath, nextText, internal)
      await writeConfigAtomically(configPath, nextText)
      return { sourceRevision: admitted.sourceRevision, sourceHash: admitted.sourceHash }
    },
    acceptMachineSourceUnlocked: async (targetAgentId, input) => {
      const text = await readConfigTextOrEmpty(configPath)
      if (configSourceHash(text) !== input.sourceHash) throw new LocalConfigError('config: accepted source hash does not match config.toml')
      const sections = parseConfigUserSections(configRoot(text, configPath))
      const internal = await readInternalOrEmpty(internalPath)
      const current = acceptedSlice(internal, targetAgentId)
      if ((current?.acceptedRevision ?? 0) !== input.expectedAcceptedRevision) throw new LocalConfigError('config: accepted revision changed during mutation')
      if ((current?.acceptedSourceHash ?? '') !== (input.expectedAcceptedSourceHash ?? '')) throw new LocalConfigError('config: accepted source changed during mutation')
      const acceptedRevision = (current?.acceptedRevision ?? 0) + 1
      const snapshot = snapshotFromSections(sections)
      await persistInternal(internal, runtime => ({
        ...runtime,
        accepted: { ...runtime.accepted, [targetAgentId]: {
          acceptedRevision,
          acceptedSourceRevision: input.sourceRevision,
          acceptedSourceHash: input.sourceHash,
          snapshot: JSON.stringify(snapshot),
        } },
      }))
      return { acceptedRevision, acceptedSourceRevision: input.sourceRevision, acceptedSourceHash: input.sourceHash }
    },
    saveObservationUnlocked: async (targetAgentId, patch: RuntimeConfigObservationPatch) => {
      const internal = await readInternalOrEmpty(internalPath)
      const view = await buildView(targetAgentId)
      if (patch.kind === 'owner-fence') {
        const fence = patch.uncertain
        if (fence.target.agentId !== targetAgentId || fence.target.targetGeneration !== view.targetGeneration) {
          throw new LocalConfigError('config: owner fence does not belong to this daemon generation')
        }
        const effective = effectiveSlice(internal, targetAgentId)
        const existing = effectiveUncertainty(effective)
        const index = existing.findIndex(record => record.operation.operationId === fence.operation.operationId)
        if (index >= 0 && patch.expectedUncertain === undefined) throw new LocalConfigError('config: owner fence record already exists')
        if (index >= 0 && (patch.expectedUncertain === undefined ||
          !sameUncertaintyIdentity(existing[index]!, patch.expectedUncertain) ||
          !sameUncertaintyIdentity(existing[index]!, fence))) {
          throw new RuntimeConfigError({ code: 'CONFLICT', message: 'config: owner fence identity does not match the existing record' })
        }
        const operations = index < 0 ? [...existing, fence] : existing.map((record, i) => i === index ? fence : record)
        await persistInternal(internal, runtime => ({
          ...runtime,
          effective: { ...runtime.effective, [targetAgentId]: {
            ...effective,
            applyState: 'uncertain',
            uncertain: JSON.stringify(operations),
          } },
        }))
        return
      }
      if (patch.target.agentId !== targetAgentId) throw new LocalConfigError('config: observation target does not belong to this daemon')
      const provider = Object.values(view.providers).find(candidate =>
        providerIntentFingerprint(candidate) === patch.target.endpointFingerprint)
      if (!targetMatchesView(view, patch.target, provider)) {
        const code = patch.target.acceptedRevision !== view.acceptedRevision ? 'REVISION_CONFLICT' : 'APPLY_TARGET_MISMATCH'
        throw new LocalConfigError(`config: observation target mismatch (${code})`)
      }
      const effective = effectiveSlice(internal, targetAgentId)
      const operations = [...effectiveUncertainty(effective)]
      if (patch.uncertain !== undefined) {
        const index = operations.findIndex(record => record.operation.operationId === patch.uncertain!.operation.operationId)
        if (index < 0) operations.push(patch.uncertain)
        else operations[index] = patch.uncertain
      }
      if (patch.removeUncertainOperationId !== undefined) {
        if (patch.expectedUncertain === undefined || patch.expectedUncertain.operation.operationId !== patch.removeUncertainOperationId) {
          throw new LocalConfigError('config: uncertainty removal does not match the expected record')
        }
        const index = operations.findIndex(record => record.operation.operationId === patch.removeUncertainOperationId)
        if (index < 0) throw new LocalConfigError('config: uncertainty record to remove does not exist')
        if (!sameUncertaintyIdentity(operations[index]!, patch.expectedUncertain)) {
          throw new RuntimeConfigError({ code: 'CONFLICT', message: 'config: uncertainty removal identity does not match the existing record' })
        }
        operations.splice(index, 1)
      }
      const nextEffective: {
        effectiveRevision?: number
        applyState?: 'clean' | 'uncertain'
        lastApplyError?: string
        uncertain?: string
      } = { ...effective }
      if (patch.effectiveRevision !== undefined) nextEffective.effectiveRevision = patch.effectiveRevision
      if (patch.lastApplyError === null) delete nextEffective.lastApplyError
      else if (patch.lastApplyError !== undefined) nextEffective.lastApplyError = JSON.stringify(patch.lastApplyError)
      if (operations.length > 0) { nextEffective.uncertain = JSON.stringify(operations); nextEffective.applyState = 'uncertain' }
      else {
        delete nextEffective.uncertain
        if (patch.applyState !== undefined) nextEffective.applyState = patch.applyState
        else if (patch.removeUncertainOperationId !== undefined) nextEffective.applyState = 'clean'
      }
      const catalogs = { ...(internal.configRuntime?.catalogs ?? {}) }
      if (patch.catalogObservations !== undefined) {
        const current = catalogs[targetAgentId] ?? {}
        catalogs[targetAgentId] = { ...current, ...Object.fromEntries(Object.entries(patch.catalogObservations).map(([providerId, observation]) => [providerId, observationToToml(observation)])) }
      }
      await persistInternal(internal, runtime => ({
        ...runtime,
        effective: { ...runtime.effective, [targetAgentId]: nextEffective },
        catalogs,
      }))
    },
  }
}

function observationToToml(observation: ProviderCatalogObservation): LocalInternalConfigRuntimeCatalog {
  return {
    state: observation.state,
    ...(observation.refreshedAt === undefined ? {} : { refreshedAt: observation.refreshedAt }),
    ...(observation.error === undefined ? {} : { error: JSON.stringify(observation.error) }),
    providerFingerprint: observation.providerFingerprint,
    observedAcceptedRevision: observation.observedAcceptedRevision,
    observedAcceptedSourceRevision: observation.observedAcceptedSourceRevision,
    observedAcceptedSourceHash: observation.observedAcceptedSourceHash,
    observedEndpoint: observation.observedEndpoint,
    ...(observation.observedCredentialRef === undefined ? {} : { observedCredentialRef: observation.observedCredentialRef }),
    entries: JSON.stringify(observation.discoveredEntries),
  }
}
