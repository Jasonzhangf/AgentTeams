import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'
import { assertEnvelopeKeys, assertJsonValue } from '../control-protocol/json-value.ts'
import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import { createRelayServer, type RelayServer } from './relay.ts'

const RELAY_CONFIG_VERSION = 1
const MAX_TIMER_MS = 2_147_483_647

export interface RelayProcessListenConfig {
  readonly host: string
  readonly port: number
}

export interface RelayProcessTlsConfig {
  readonly keyFile: string
  readonly certFile: string
}

export interface RelayProcessLimitsConfig {
  readonly maxPayload: number
  readonly maxConnections: number
  readonly maxGrants: number
  readonly maxBufferedAmount: number
  readonly maxPendingMessages: number
  readonly maxPendingBytes: number
  readonly grantTtlMs: number
}

export interface RelayCredentialBinding {
  readonly credentialEnv: string
  readonly identity: AuthenticatedAgent
}

export interface RelayProcessConfig {
  readonly version: 1
  readonly listen: RelayProcessListenConfig
  readonly tls: RelayProcessTlsConfig
  readonly limits: RelayProcessLimitsConfig
  readonly credentials: readonly RelayCredentialBinding[]
}

export interface RelayProcessHandle {
  readonly configPath: string
  readonly config: RelayProcessConfig
  readonly server: RelayServer
  close(): Promise<void>
}

export class RelayProcessConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RelayProcessConfigError'
  }
}

interface ResolvedRelayProcessConfig {
  readonly config: RelayProcessConfig
  readonly credentials: ReadonlyMap<string, AuthenticatedAgent>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RelayProcessConfigError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RelayProcessConfigError(`${label} must be a non-empty string`)
  }
  return value
}

function knownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  try {
    assertEnvelopeKeys(value, fields, label)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : `${label} has unsupported fields`
    throw new RelayProcessConfigError(message, cause)
  }
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RelayProcessConfigError(`${label} must be a safe integer`)
  }
  return value as number
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label)
  if (parsed < 1) throw new RelayProcessConfigError(`${label} must be positive`)
  return parsed
}

function port(value: unknown, label: string): number {
  const parsed = safeInteger(value, label)
  if (parsed < 0 || parsed > 65535) throw new RelayProcessConfigError(`${label} is invalid`)
  return parsed
}

function parseIdentity(value: unknown, label: string): AuthenticatedAgent {
  const input = record(value, label)
  knownFields(input, ['accountId', 'scopeId', 'agentId'], label)
  return {
    accountId: requiredString(input.accountId, `${label}.accountId`),
    scopeId: requiredString(input.scopeId, `${label}.scopeId`),
    agentId: requiredString(input.agentId, `${label}.agentId`),
  }
}

function parseCredentialBindings(value: unknown, env: NodeJS.ProcessEnv): {
  readonly bindings: readonly RelayCredentialBinding[]
  readonly credentials: ReadonlyMap<string, AuthenticatedAgent>
} {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RelayProcessConfigError('credentials must be a non-empty array')
  }
  const bindings: RelayCredentialBinding[] = []
  const credentials = new Map<string, AuthenticatedAgent>()
  const identityKeys = new Set<string>()
  const environmentNames = new Set<string>()
  for (const [index, item] of value.entries()) {
    const label = `credentials[${index}]`
    const input = record(item, label)
    knownFields(input, ['credentialEnv', 'identity'], label)
    const credentialEnv = requiredString(input.credentialEnv, `${label}.credentialEnv`)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)) {
      throw new RelayProcessConfigError(`${label}.credentialEnv is invalid`)
    }
    if (environmentNames.has(credentialEnv)) {
      throw new RelayProcessConfigError(`duplicate credential environment ${credentialEnv}`)
    }
    environmentNames.add(credentialEnv)
    const credential = env[credentialEnv]
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new RelayProcessConfigError(`credential environment ${credentialEnv} is missing or empty`)
    }
    if (/[\r\n]/.test(credential)) {
      throw new RelayProcessConfigError(`credential environment ${credentialEnv} contains invalid line breaks`)
    }
    if (credentials.has(credential)) {
      throw new RelayProcessConfigError(`duplicate credential for ${credentialEnv}`)
    }
    const identity = parseIdentity(input.identity, `${label}.identity`)
    const identityKey = JSON.stringify([identity.accountId, identity.scopeId, identity.agentId])
    if (identityKeys.has(identityKey)) {
      throw new RelayProcessConfigError(`duplicate identity for ${label}`)
    }
    identityKeys.add(identityKey)
    bindings.push({ credentialEnv, identity: { ...identity } })
    credentials.set(credential, { ...identity })
  }
  return { bindings, credentials }
}

function parseConfigObject(value: unknown, env: NodeJS.ProcessEnv): ResolvedRelayProcessConfig {
  const input = record(value, 'relay config')
  knownFields(input, ['version', 'listen', 'tls', 'limits', 'credentials'], 'relay config')
  if (input.version !== RELAY_CONFIG_VERSION) {
    throw new RelayProcessConfigError(`relay config version must be ${RELAY_CONFIG_VERSION}`)
  }

  const listenInput = record(input.listen, 'listen')
  knownFields(listenInput, ['host', 'port'], 'listen')
  const listen = {
    host: requiredString(listenInput.host, 'listen.host'),
    port: port(listenInput.port, 'listen.port'),
  }

  const tlsInput = record(input.tls, 'tls')
  knownFields(tlsInput, ['keyFile', 'certFile'], 'tls')
  const tls = {
    keyFile: requiredString(tlsInput.keyFile, 'tls.keyFile'),
    certFile: requiredString(tlsInput.certFile, 'tls.certFile'),
  }

  const limitsInput = record(input.limits, 'limits')
  const limitNames: readonly (keyof RelayProcessLimitsConfig)[] = [
    'maxPayload',
    'maxConnections',
    'maxGrants',
    'maxBufferedAmount',
    'maxPendingMessages',
    'maxPendingBytes',
    'grantTtlMs',
  ]
  knownFields(limitsInput, limitNames, 'limits')
  const limits = {
    maxPayload: positiveSafeInteger(limitsInput.maxPayload, 'limits.maxPayload'),
    maxConnections: positiveSafeInteger(limitsInput.maxConnections, 'limits.maxConnections'),
    maxGrants: positiveSafeInteger(limitsInput.maxGrants, 'limits.maxGrants'),
    maxBufferedAmount: positiveSafeInteger(limitsInput.maxBufferedAmount, 'limits.maxBufferedAmount'),
    maxPendingMessages: positiveSafeInteger(limitsInput.maxPendingMessages, 'limits.maxPendingMessages'),
    maxPendingBytes: positiveSafeInteger(limitsInput.maxPendingBytes, 'limits.maxPendingBytes'),
    grantTtlMs: positiveSafeInteger(limitsInput.grantTtlMs, 'limits.grantTtlMs'),
  }
  if (limits.grantTtlMs > MAX_TIMER_MS) {
    throw new RelayProcessConfigError(`limits.grantTtlMs must be at most ${MAX_TIMER_MS}`)
  }

  const { bindings, credentials } = parseCredentialBindings(input.credentials, env)
  return {
    config: { version: 1, listen, tls, limits, credentials: bindings },
    credentials,
  }
}

function parseJson(text: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new RelayProcessConfigError('relay config is not valid JSON', cause)
  }
  try {
    assertJsonValue(value, 'relay config')
  } catch (cause) {
    throw new RelayProcessConfigError('relay config contains an invalid JSON value', cause)
  }
  return value
}

function normalizeConfigPath(configPath: string): string {
  if (typeof configPath !== 'string' || configPath.length === 0) {
    throw new RelayProcessConfigError('relay config path is required')
  }
  return resolve(configPath)
}

export function parseRelayProcessConfig(text: string, env: NodeJS.ProcessEnv = process.env): RelayProcessConfig {
  return parseConfigObject(parseJson(text), env).config
}

async function readResolvedConfig(configPath: string, env: NodeJS.ProcessEnv): Promise<{
  readonly configPath: string
  readonly resolved: ResolvedRelayProcessConfig
}> {
  const absoluteConfigPath = normalizeConfigPath(configPath)
  let text: string
  try {
    text = await readFile(absoluteConfigPath, 'utf8')
  } catch (cause) {
    throw new RelayProcessConfigError(`relay config could not be read: ${absoluteConfigPath}`, cause)
  }
  return { configPath: absoluteConfigPath, resolved: parseConfigObject(parseJson(text), env) }
}

export async function startRelayProcess(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<RelayProcessHandle> {
  const loaded = await readResolvedConfig(configPath, env)
  const configDirectory = dirname(loaded.configPath)
  const keyPath = isAbsolute(loaded.resolved.config.tls.keyFile)
    ? loaded.resolved.config.tls.keyFile
    : resolve(configDirectory, loaded.resolved.config.tls.keyFile)
  const certPath = isAbsolute(loaded.resolved.config.tls.certFile)
    ? loaded.resolved.config.tls.certFile
    : resolve(configDirectory, loaded.resolved.config.tls.certFile)
  let key: Buffer
  let cert: Buffer
  try {
    [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)])
  } catch (cause) {
    throw new RelayProcessConfigError('relay TLS key or certificate could not be read', cause)
  }
  let server: RelayServer
  try {
    server = await createRelayServer({
      host: loaded.resolved.config.listen.host,
      port: loaded.resolved.config.listen.port,
      key,
      cert,
      ...loaded.resolved.config.limits,
      authenticate: credential => {
        if (credential === undefined) return null
        const identity = loaded.resolved.credentials.get(credential)
        return identity === undefined ? null : { ...identity }
      },
    })
  } catch (cause) {
    throw new RelayProcessConfigError('relay server could not start', cause)
  }
  return {
    configPath: loaded.configPath,
    config: structuredClone(loaded.resolved.config),
    server,
    close: () => server.close(),
  }
}

export function parseRelayProcessArgs(argv: readonly string[]): string {
  if (argv.length === 2 && argv[0] === '--config') return normalizeConfigPath(argv[1])
  if (argv.length === 1 && argv[0].startsWith('--config=')) {
    return normalizeConfigPath(argv[0].slice('--config='.length))
  }
  throw new RelayProcessConfigError('usage: relay-process --config <file>')
}

export async function runRelayProcess(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configPath = parseRelayProcessArgs(argv)
  const handle = await startRelayProcess(configPath, env)
  let stopping = false
  let resolveStopped!: () => void
  const stopped = new Promise<void>(resolvePromise => { resolveStopped = resolvePromise })
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    void handle.close()
      .catch(error => {
        process.exitCode = 1
        const message = error instanceof Error ? error.message : 'unknown shutdown error'
        console.error(`relay shutdown failed after ${signal}: ${message}`)
      })
      .finally(resolveStopped)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  console.log(`relay listening ${handle.server.url}`)
  try {
    await stopped
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runRelayProcess().catch(error => {
    const message = error instanceof Error ? error.message : 'unknown relay startup error'
    console.error(`relay startup failed: ${message}`)
    process.exitCode = 1
  })
}
