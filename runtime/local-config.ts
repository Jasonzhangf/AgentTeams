import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseToml } from 'toml'

const LOCAL_CONFIG_VERSION = 1

export interface LocalRelaySpec {
  readonly enabled: boolean
  readonly configPath: string
}

export interface LocalDaemonSpec {
  readonly id: string
  readonly enabled: boolean
  readonly configPath: string
}

export interface LocalConfig {
  readonly version: 1
  readonly configPath: string
  readonly relay: LocalRelaySpec
  readonly daemons: readonly LocalDaemonSpec[]
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

function parseLocalConfigText(text: string, configPath: string): LocalConfig {
  let parsed: unknown
  try { parsed = parseToml(text) } catch (cause) { throw new LocalConfigError('local config is not valid TOML', cause) }
  const root = object(parsed, 'local config')
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
  return parseLocalConfigText(text, configPath)
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
