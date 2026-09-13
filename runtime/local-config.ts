import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
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
  const internalDirectory = resolve(dirname(configPath), '.internal', 'endpoints')
  const generatedPath = resolve(internalDirectory, `${id}.json`)
  return { spec: { id, enabled, configPath: generatedPath, role, ...(connect === undefined ? {} : { connection: connect }) }, json }
}

async function materializeEndpoint(configPath: string, json: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporary = `${configPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, configPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
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
    const generated: Array<{ readonly path: string; readonly json: Record<string, unknown> }> = []
    for (const [id, value] of Object.entries(endpointTable)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new LocalConfigError(`endpoints.${id} is not a valid endpoint id`)
      if (id === 'relay') throw new LocalConfigError('endpoints.relay is reserved for the local Relay process')
      const parsed = endpointConfig(object(value, `endpoints.${id}`), id, configPath)
      daemons.push(parsed.spec); generated.push({ path: parsed.spec.configPath, json: parsed.json })
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
  const parsed = parseLocalConfigText(text, configPath) as LocalConfig & { readonly generated?: readonly { readonly path: string; readonly json: Record<string, unknown> }[] }
  for (const item of parsed.generated ?? []) await materializeEndpoint(item.path, item.json)
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
  const lines = ['version = 1', `updatedAt = ${JSON.stringify(new Date().toISOString())}`]
  for (const [id, state] of Object.entries(daemons).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push('', `[daemon.${JSON.stringify(id)}]`, `pid = ${state.pid}`, `state = ${JSON.stringify(state.state)}`)
    if (state.generation !== undefined) lines.push(`generation = ${state.generation}`)
  }
  await mkdir(dirname(internalPath), { recursive: true, mode: 0o700 })
  const temporary = `${internalPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, internalPath) }
  catch (error) { try { await unlink(temporary) } catch { /* preserve original failure */ } throw error }
  return internalPath
}
