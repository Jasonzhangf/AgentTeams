import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parse as parseToml } from 'toml'
import { assertJsonValue } from '../control-protocol/json-value.ts'
import type { JsonValue } from '../control-protocol/agent-services.ts'

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
}

export interface LocalConnectionIntent {
  readonly targetAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly workId: string
  readonly requestId: string
  readonly demands: readonly { readonly resourceId: string; readonly amount: number }[]
  readonly payload: JsonValue
}

export interface LocalConfig {
  readonly version: 1 | 2
  readonly configPath: string
  readonly relay: LocalRelaySpec
  readonly daemons: readonly LocalDaemonSpec[]
  readonly internalPath?: string
}

export interface LocalInternalConfig {
  readonly version: 1
  readonly configRevision?: string
  readonly sourcePath?: string
  readonly generatedAt?: string
  readonly updatedAt?: string
  readonly relay?: {
    readonly projectionPath?: string
    readonly config?: string
  }
  readonly daemons?: Readonly<Record<string, LocalInternalDaemonConfig>>
}

export interface LocalInternalDaemonConfig {
  readonly projectionPath?: string
  readonly enabled?: boolean
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
  fields(input, ['targetAgentId', 'capabilityId', 'capabilityVersion', 'operation', 'workId', 'requestId', 'demands', 'payload'], label)
  const textField = (key: string): string => requiredString(input[key], `${label}.${key}`)
  if (!Array.isArray(input.demands) || input.demands.length === 0) throw new LocalConfigError(`${label}.demands must be a non-empty array`)
  const demands = input.demands.map((value, index) => {
    const item = object(value, `${label}.demands[${index}]`)
    fields(item, ['resourceId', 'amount'], `${label}.demands[${index}]`)
    const resourceId = requiredString(item.resourceId, `${label}.demands[${index}].resourceId`)
    if (!Number.isSafeInteger(item.amount) || (item.amount as number) < 1) throw new LocalConfigError(`${label}.demands[${index}].amount must be positive`)
    return { resourceId, amount: item.amount as number }
  })
  if (!Object.hasOwn(input, 'payload')) throw new LocalConfigError(`${label}.payload is required`)
  try { assertJsonValue(input.payload, `${label}.payload`) }
  catch (cause) { throw new LocalConfigError(cause instanceof Error ? cause.message : `${label}.payload must contain only JSON values`, cause) }
  return { targetAgentId: textField('targetAgentId'), capabilityId: textField('capabilityId'), capabilityVersion: textField('capabilityVersion'),
    operation: textField('operation'), workId: textField('workId'), requestId: textField('requestId'), demands, payload: input.payload }
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

function tomlScalar(value: unknown): string {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(tomlScalar).join(', ')}]`
  throw new LocalConfigError(`internal.toml value cannot be serialized: ${String(value)}`)
}

function serializeLocalInternalConfig(internal: LocalInternalConfig): string {
  const lines = ['version = 1']
  for (const key of ['configRevision', 'sourcePath', 'generatedAt', 'updatedAt'] as const) {
    const value = internal[key]
    if (value !== undefined) lines.push(`${key} = ${tomlString(value)}`)
  }
  const relay = internal.relay
  if (relay !== undefined) {
    lines.push('', '[relay]')
    if (relay.projectionPath !== undefined) lines.push(`projectionPath = ${tomlString(relay.projectionPath)}`)
    if (relay.config !== undefined) lines.push(`config = ${tomlString(relay.config)}`)
  }
  const daemons = internal.daemons
  if (daemons !== undefined) {
    for (const [id, daemon] of Object.entries(daemons).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push('', `[daemon.${tomlString(id)}]`)
      for (const key of ['projectionPath', 'role', 'state'] as readonly ['projectionPath', 'role', 'state']) {
        const value = daemon[key]
        if (value !== undefined) lines.push(`${key} = ${tomlString(value)}`)
      }
      if (daemon.enabled !== undefined) lines.push(`enabled = ${daemon.enabled ? 'true' : 'false'}`)
      if (daemon.pid !== undefined) lines.push(`pid = ${daemon.pid}`)
      if (daemon.generation !== undefined) lines.push(`generation = ${daemon.generation}`)
      if (daemon.config !== undefined) lines.push(`config = ${tomlString(daemon.config)}`)
    }
  }
  return `${lines.join('\n')}\n`
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

export async function readLocalInternalConfig(path: string): Promise<LocalInternalConfig> {
  const internalPath = localPath(path, process.cwd())
  let text: string
  try { text = await readFile(internalPath, 'utf8') }
  catch (cause) { throw new LocalConfigError(`internal config cannot be read: ${internalPath}`, cause) }
  let parsed: unknown
  try { parsed = parseToml(text) } catch (cause) { throw new LocalConfigError(`internal config is not valid TOML: ${internalPath}`, cause) }
  const root = object(parsed, 'internal config')
  if (root.version !== 1) throw new LocalConfigError(`internal config version must be 1: ${internalPath}`)
  const textOrUndefined = (value: unknown, label: string): string | undefined => {
    if (value === undefined) return undefined
    return requiredString(value, label)
  }
  const daemons: Record<string, LocalInternalDaemonConfig> = {}
  if (root.daemon !== undefined) {
    const daemonTable = object(root.daemon, 'daemon')
    for (const [id, value] of Object.entries(daemonTable)) {
      const input = object(value, `daemon.${id}`)
      daemons[id] = {
        ...(input.projectionPath === undefined ? {} : { projectionPath: requiredString(input.projectionPath, `daemon.${id}.projectionPath`) }),
        ...(input.enabled === undefined ? {} : { enabled: boolean(input.enabled, true, `daemon.${id}.enabled`) }),
        ...(input.role === undefined ? {} : { role: oneOf(input.role, ['provider', 'receiver', 'hybrid'] as const, `daemon.${id}.role`) }),
        ...(input.config === undefined ? {} : { config: requiredString(input.config, `daemon.${id}.config`) }),
        ...(input.pid === undefined ? {} : { pid: optionalNumber(input.pid, `daemon.${id}.pid`) }),
        ...(input.generation === undefined ? {} : { generation: optionalNumber(input.generation, `daemon.${id}.generation`) }),
        ...(input.state === undefined ? {} : { state: oneOf(input.state, ['online', 'stopped', 'failed'] as const, `daemon.${id}.state`) }),
      }
    }
  }
  return {
    version: 1,
    ...(root.configRevision === undefined ? {} : { configRevision: textOrUndefined(root.configRevision, 'configRevision') }),
    ...(root.sourcePath === undefined ? {} : { sourcePath: textOrUndefined(root.sourcePath, 'sourcePath') }),
    ...(root.generatedAt === undefined ? {} : { generatedAt: textOrUndefined(root.generatedAt, 'generatedAt') }),
    ...(root.updatedAt === undefined ? {} : { updatedAt: textOrUndefined(root.updatedAt, 'updatedAt') }),
    ...(root.relay === undefined ? {} : (() => {
      const relay = object(root.relay, 'relay')
      return { relay: {
        ...(relay.projectionPath === undefined ? {} : { projectionPath: requiredString(relay.projectionPath, 'relay.projectionPath') }),
        ...(relay.config === undefined ? {} : { config: requiredString(relay.config, 'relay.config') }),
      } }
    })()),
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

function parseLocalConfigText(text: string, configPath: string): LocalConfig {
  let parsed: unknown
  try { parsed = parseToml(text) } catch (cause) { throw new LocalConfigError('local config is not valid TOML', cause) }
  const root = object(parsed, 'local config')
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

export async function loadLocalConfig(path = defaultLocalConfigPath()): Promise<LocalConfig> {
  const configPath = localPath(path, process.cwd())
  let text: string
  try { text = await readFile(configPath, 'utf8') }
  catch (cause) { throw new LocalConfigError(`local config cannot be read: ${configPath}`, cause) }
  const parsed = parseLocalConfigText(text, configPath) as LocalConfig & {
    readonly generated?: readonly { readonly id: string; readonly path: string; readonly json: Record<string, unknown> }[]
  }
  if (parsed.version === 2) {
    const internalPath = resolve(dirname(configPath), 'internal.toml')
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
      relay: { ...(reusable ? existing!.relay : {}), projectionPath: relayProjectionPath, config: reusable ? existing!.relay!.config : JSON.stringify(relayConfig) },
      daemons: daemonProjections,
    }
    await writeLocalInternalConfig(internalPath, internal)
    return { ...parsed, relay: { enabled: parsed.relay.enabled, configPath: relayProjectionPath }, daemons, internalPath }
  }
  return parsed
}

/** Persist operator-authored TOML atomically; validation remains the startup gate. */
export async function writeLocalConfig(path: string, text: string): Promise<string> {
  const configPath = localPath(path, process.cwd())
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporary = `${configPath}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, configPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
  return configPath
}

export interface LocalInternalDaemonState {
  readonly pid: number
  readonly generation?: number
  readonly state: 'online' | 'stopped' | 'failed'
}

export async function writeLocalInternalState(path: string, daemons: Readonly<Record<string, LocalInternalDaemonState>>): Promise<string> {
  const internalPath = localPath(path, process.cwd())
  let existing: LocalInternalConfig
  try { existing = await readLocalInternalConfig(internalPath) }
  catch (error) {
    const cause = (error as { cause?: NodeJS.ErrnoException })?.cause
    if (cause?.code === 'ENOENT') existing = { version: 1 }
    else throw error
  }
  const mergedDaemons = { ...(existing.daemons ?? {}) }
  for (const [id, state] of Object.entries(daemons)) {
    mergedDaemons[id] = {
      ...(mergedDaemons[id] ?? {}),
      pid: state.pid,
      state: state.state,
      ...(state.generation === undefined ? {} : { generation: state.generation }),
    }
  }
  return writeLocalInternalConfig(internalPath, { ...existing, updatedAt: new Date().toISOString(), daemons: mergedDaemons })
}
