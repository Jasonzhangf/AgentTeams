#!/usr/bin/env -S node --experimental-transform-types

import { execFile } from 'node:child_process'
import { access, chmod } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { writeLocalConfig } from '../runtime/local-config.ts'
import {
  runLocalConfiguredWork,
  startLocalProcess,
  statusLocalProcess,
  stopLocalProcess,
} from '../runtime/local-process.ts'

export const CLI_NAME = 'agentteams'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const runtimeDirectory = resolve(sourceDirectory, '..')
const execFileAsync = promisify(execFile)

// The facade runs from source in this delivery unit, so it binds the runtime
// child entrypoints explicitly instead of relying on the packaged .js default.
const SOURCE_ENTRIES = {
  relayEntry: resolve(runtimeDirectory, 'server', 'relay-process.ts'),
  agentEntry: resolve(runtimeDirectory, 'runtime', 'agent-process.ts'),
}

export const DEFAULT_CONFIG_TEXT = `# AgentTeams user config. This is the only file you normally edit.
# relay.json, internal.toml and child projections are generated; they are never a
# second editable source.
version = 2

[relay]
config = "relay.json"

[endpoints.provider]
enabled = true
role = "provider"
identity = { hostId = "local", machineId = "agentteams", agentId = "provider", accountId = "local", agentKind = "custom", label = "Provider" }
scopeId = "local"
dataDirectory = "data/provider"
leasePort = 48011
presenceIntervalMs = 500
policy = { revision = 1, allowedConsumers = ["receiver"], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-provider" }
relay = { endpoint = "wss://127.0.0.1:48010", credentialEnv = "AGENTTEAMS_PROVIDER_AUTH", caFile = "relay-cert.pem", connectTimeoutMs = 2000, admissionTimeoutMs = 2000, requestTimeoutMs = 5000, maxMessageBytes = 65536, maxBufferedBytes = 65536, maxPendingFrames = 8, maxPendingRequests = 4, maxDataConnections = 4 }

[endpoints.receiver]
enabled = true
role = "receiver"
identity = { hostId = "local", machineId = "agentteams", agentId = "receiver", accountId = "local", agentKind = "custom", label = "Receiver" }
scopeId = "local"
dataDirectory = "data/receiver"
leasePort = 48012
presenceIntervalMs = 500
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-receiver" }
relay = { endpoint = "wss://127.0.0.1:48010", credentialEnv = "AGENTTEAMS_RECEIVER_AUTH", caFile = "relay-cert.pem", connectTimeoutMs = 2000, admissionTimeoutMs = 2000, requestTimeoutMs = 5000, maxMessageBytes = 65536, maxBufferedBytes = 65536, maxPendingFrames = 8, maxPendingRequests = 4, maxDataConnections = 4 }

[endpoints.receiver.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
workId = "configured-search"
requestId = "configured-search-1"
demands = [{ resourceId = "search-slot", amount = 1 }]
payload = { query = "needle" }
`

export const DEFAULT_RELAY_CONFIG_TEXT = `${JSON.stringify({
  version: 1,
  listen: { host: '127.0.0.1', port: 48010 },
  tls: { keyFile: 'relay-key.pem', certFile: 'relay-cert.pem' },
  limits: {
    maxPayload: 65536,
    maxConnections: 8,
    maxGrants: 8,
    maxBufferedAmount: 65536,
    maxPendingMessages: 8,
    maxPendingBytes: 131072,
    grantTtlMs: 5000,
  },
  credentials: [
    { credentialEnv: 'AGENTTEAMS_PROVIDER_AUTH', identity: { accountId: 'local', scopeId: 'local', agentId: 'provider' } },
    { credentialEnv: 'AGENTTEAMS_RECEIVER_AUTH', identity: { accountId: 'local', scopeId: 'local', agentId: 'receiver' } },
  ],
}, null, 2)}\n`

const RUNTIME_FUNCTIONS = {
  startLocalProcess,
  statusLocalProcess,
  stopLocalProcess,
  runLocalConfiguredWork,
}

export class AgentTeamsCliError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AgentTeamsCliError'
  }
}

function usage() {
  return `usage: ${CLI_NAME} init|start|status|work|stop [--config <path>] [--generation <n>]`
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new AgentTeamsCliError(`${flag} requires a value`)
  return value
}

function parseArgs(argv, options) {
  const command = argv[0]
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    throw new AgentTeamsCliError(usage())
  }
  if (!['init', 'start', 'status', 'work', 'stop'].includes(command)) {
    throw new AgentTeamsCliError(`unknown command: ${command}\n${usage()}`)
  }
  const parsed = {
    command,
    configPath: options.config === undefined ? undefined : resolve(options.config),
    generation: undefined,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--config') {
      parsed.configPath = resolve(valueAfter(argv, index, argument))
      index += 1
    } else if (argument.startsWith('--config=')) {
      const value = argument.slice('--config='.length)
      if (value.length === 0) throw new AgentTeamsCliError('--config requires a value')
      parsed.configPath = resolve(value)
    } else if (argument === '--generation') {
      const raw = valueAfter(argv, index, argument)
      const generation = Number(raw)
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new AgentTeamsCliError('--generation must be a non-negative integer')
      }
      parsed.generation = generation
      index += 1
    } else if (argument.startsWith('--generation=')) {
      const raw = argument.slice('--generation='.length)
      const generation = Number(raw)
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new AgentTeamsCliError('--generation must be a non-negative integer')
      }
      parsed.generation = generation
    } else {
      throw new AgentTeamsCliError(`unknown argument: ${argument}\n${usage()}`)
    }
  }
  return parsed
}

function defaultConfigPath(home) {
  return resolve(home ?? homedir(), '.agentteams', 'config.toml')
}

function localEnv(env) {
  const result = { ...(env ?? process.env) }
  if (result.AGENTTEAMS_PROVIDER_AUTH === undefined) result.AGENTTEAMS_PROVIDER_AUTH = 'local-provider'
  if (result.AGENTTEAMS_RECEIVER_AUTH === undefined) result.AGENTTEAMS_RECEIVER_AUTH = 'local-receiver'
  return result
}

function formatStatus(prefix, status) {
  const pieces = [
    prefix,
    `state=${status.state}`,
    `generation=${status.generation}`,
    `config=${status.configPath}`,
    `internal=${status.internalPath}`,
  ]
  if (status.pid !== undefined) pieces.push(`pid=${status.pid}`)
  if (status.error !== undefined) pieces.push(`error=${status.error}`)
  return pieces.join(' ')
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// The relay is a `wss://` endpoint, so a usable default init must produce the
// self-signed local TLS material that relay.json references. The runtime owner
// exposes no TLS bootstrap API, so this facade generates it with the same
// openssl invocation the repository's local smoke scripts already use. Missing
// openssl or a partial existing pair fails explicitly; it never silently
// substitutes or overwrites material.
async function generateLocalRelayTls(directory) {
  const keyPath = resolve(directory, 'relay-key.pem')
  const certPath = resolve(directory, 'relay-cert.pem')
  const [keyExists, certExists] = await Promise.all([pathExists(keyPath), pathExists(certPath)])
  if (keyExists && certExists) return
  if (keyExists || certExists) {
    throw new AgentTeamsCliError(`relay TLS material is incomplete in ${directory}: relay-key.pem and relay-cert.pem must both exist`)
  }
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', keyPath, '-out', certPath,
    ])
  } catch (error) {
    const detail = typeof error?.stderr === 'string' && error.stderr.trim() !== '' ? error.stderr.trim() : error.message
    throw new AgentTeamsCliError(`cannot generate relay TLS material in ${directory}: ${detail}`)
  }
  await Promise.all([chmod(keyPath, 0o600), chmod(certPath, 0o600)])
}

async function initCommand(configPath, configText) {
  try {
    await writeLocalConfig(configPath, configText, { exclusive: true })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new AgentTeamsCliError(`config already exists: ${configPath}`)
    throw new AgentTeamsCliError(`cannot create config: ${configPath}: ${error.message}`)
  }
  const directory = dirname(configPath)
  const relayPath = resolve(directory, 'relay.json')
  try {
    await writeLocalConfig(relayPath, DEFAULT_RELAY_CONFIG_TEXT, { exclusive: true })
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new AgentTeamsCliError(`cannot create relay config: ${relayPath}: ${error.message}`)
    }
  }
  await generateLocalRelayTls(directory)
  return `initialized ${configPath}
Edit config.toml, then run ${CLI_NAME} start, ${CLI_NAME} status, ${CLI_NAME} work, or ${CLI_NAME} stop.`
}

export async function agentteamsCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv, options)
  const configPath = parsed.configPath ?? defaultConfigPath(options.home)
  const env = localEnv(options.env)
  const runtime = options.runtime ?? RUNTIME_FUNCTIONS

  if (parsed.command === 'init') {
    return await initCommand(configPath, options.configText ?? DEFAULT_CONFIG_TEXT)
  }
  if (parsed.command === 'start') {
    const status = await runtime.startLocalProcess(configPath, { env, ...SOURCE_ENTRIES })
    return formatStatus('started', status)
  }
  if (parsed.command === 'status') {
    const status = await runtime.statusLocalProcess(configPath)
    return formatStatus('status', status)
  }
  if (parsed.command === 'work') {
    const result = await runtime.runLocalConfiguredWork(configPath, env, SOURCE_ENTRIES)
    return `succeeded agent=${result.agentId} work=${result.workId} request=${result.requestId} state=${result.state}`
  }
  if (parsed.command === 'stop') {
    const status = await runtime.stopLocalProcess(configPath, parsed.generation)
    return formatStatus('stopped', status)
  }
  throw new AgentTeamsCliError(`unsupported command: ${parsed.command}`)
}

export async function main(argv = process.argv.slice(2), options = {}) {
  try {
    const output = await agentteamsCommand(argv, options)
    if (output !== undefined) console.log(output)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
}
