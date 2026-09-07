import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { connectWss, type WssConnection } from '../network/wss-connection.ts'
import { loginRelay } from '../network/relay-login.ts'
import { createRelayClient, type RelayClient, type RelayClientOptions } from '../network/relay-client.ts'
import type { RelayGrant } from '../control-protocol/agent-services.ts'
import { RelayProcessConfigError, parseRelayProcessArgs, parseRelayProcessConfig, startRelayProcess } from './relay-process.ts'

const entryPath = resolve(import.meta.dirname, 'relay-process.ts')
const repoRoot = resolve(import.meta.dirname, '..')
const credentialA = 'Bearer relay-process-a'
const credentialB = 'Bearer relay-process-b'

let tempDirectory: string
let cert: Buffer
const children: ChildProcessWithoutNullStreams[] = []
const connections: WssConnection[] = []
const relayClients: RelayClient[] = []

beforeAll(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'agentteams-relay-process-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(tempDirectory, 'key.pem'), '-out', join(tempDirectory, 'cert.pem'),
  ], { stdio: 'ignore' })
  cert = readFileSync(join(tempDirectory, 'cert.pem'))
})

afterEach(async () => {
  for (const client of relayClients.splice(0).reverse()) {
    await client.close().catch(() => undefined)
  }
  for (const connection of connections.splice(0).reverse()) {
    await connection.close().catch(() => undefined)
  }
  for (const child of children.splice(0).reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
  }
})

afterAll(() => rmSync(tempDirectory, { recursive: true, force: true }))

function identity(agentId: string) {
  return {
    accountId: 'account-process',
    scopeId: 'scope-process',
    agentId,
  }
}

function declaration(agentId: string) {
  return {
    identity: {
      hostId: `host-${agentId}`,
      machineId: `machine-${agentId}`,
      agentId,
      accountId: 'account-process',
      agentKind: 'custom' as const,
      label: `Relay process ${agentId}`,
    },
    scopeId: 'scope-process',
    revision: 1,
    capabilities: [],
    routes: [],
  }
}

function config() {
  return {
    version: 1,
    listen: { host: '127.0.0.1', port: 0 },
    tls: { keyFile: 'key.pem', certFile: 'cert.pem' },
    limits: {
      maxPayload: 65536,
      maxConnections: 8,
      maxGrants: 4,
      maxBufferedAmount: 65536,
      maxPendingMessages: 8,
      maxPendingBytes: 65536,
      grantTtlMs: 10000,
    },
    credentials: [
      { credentialEnv: 'RELAY_PROCESS_A', identity: identity('a') },
      { credentialEnv: 'RELAY_PROCESS_B', identity: identity('b') },
    ],
  }
}

function writeConfig(): string {
  const path = join(tempDirectory, 'relay.json')
  writeFileSync(path, `${JSON.stringify(config())}\n`, { encoding: 'utf8', mode: 0o600 })
  return path
}

function spawnRelay(configPath: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--experimental-transform-types', entryPath, '--config', configPath], {
    cwd: repoRoot,
    env: { ...process.env, RELAY_PROCESS_A: credentialA, RELAY_PROCESS_B: credentialB },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

async function waitForListening(child: ChildProcessWithoutNullStreams): Promise<string> {
  let output = ''
  let errorOutput = ''
  const onStdout = (chunk: Buffer | string) => { output += chunk.toString() }
  const onStderr = (chunk: Buffer | string) => { errorOutput += chunk.toString() }
  child.stdout.on('data', onStdout)
  child.stderr.on('data', onStderr)
  try {
    return await new Promise<string>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start: ${errorOutput}`)), 5000)
      const check = () => {
        const match = output.match(/relay listening (wss:\/\/[^\s]+)\s*/)
        if (!match) return
        clearTimeout(timer)
        expect(output).not.toContain(credentialA)
        expect(output).not.toContain(credentialB)
        expect(errorOutput).not.toContain(credentialA)
        expect(errorOutput).not.toContain(credentialB)
        resolvePromise(match[1])
      }
      child.stdout.on('data', check)
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) return
        clearTimeout(timer)
        reject(new Error(`relay exited before listening: code=${code}, signal=${signal}, stderr=${errorOutput}`))
      })
      check()
    })
  } finally {
    child.stdout.off('data', onStdout)
    child.stderr.off('data', onStderr)
  }
}

async function login(endpoint: string, agentId: string, credential: string): Promise<WssConnection> {
  const admitted = await loginRelay({
    transport: {
      endpoint,
      credential,
      ca: cert,
      connectTimeoutMs: 1000,
      maxMessageBytes: 65536,
      maxBufferedBytes: 65536,
      maxPendingFrames: 8,
    },
    declaration: declaration(agentId),
    admissionTimeoutMs: 2000,
  })
  connections.push(admitted.transport)
  return admitted.transport
}

async function relayClient(
  endpoint: string,
  agentId: string,
  credential: string,
  onEvent?: RelayClientOptions['onEvent'],
): Promise<RelayClient> {
  const client = await createRelayClient({
    transport: {
      endpoint,
      credential,
      ca: cert,
      connectTimeoutMs: 1000,
      maxMessageBytes: 65536,
      maxBufferedBytes: 65536,
      maxPendingFrames: 8,
    },
    declaration: declaration(agentId),
    admissionTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    maxPendingRequests: 8,
    maxDataConnections: 4,
    onEvent,
  })
  relayClients.push(client)
  return client
}

async function directory(connection: WssConnection): Promise<readonly string[]> {
  await connection.send({
    bytes: Buffer.from(JSON.stringify({ kind: 'relay.directory', requestId: 'directory-process', subscribe: false })),
    binary: false,
  })
  const frame = await connection.read()
  expect(frame.binary).toBe(false)
  const parsed = JSON.parse(frame.bytes.toString('utf8')) as { kind: string; peers: readonly { declaration: { identity: { agentId: string } } }[] }
  expect(parsed.kind).toBe('relay.directory')
  return parsed.peers.map(peer => peer.declaration.identity.agentId).sort()
}

it('requires an explicit config path and rejects unexpected arguments', () => {
  expect(() => parseRelayProcessArgs([])).toThrow(/usage/)
  expect(() => parseRelayProcessArgs(['--config', join(tempDirectory, 'relay.json'), '--extra'])).toThrow(/usage/)
  expect(parseRelayProcessArgs(['--config', './relay.json'])).toBe(resolve('./relay.json'))
})

it('rejects missing, duplicate, and plaintext credential or identity bindings', () => {
  const valid = config()
  const env = { RELAY_PROCESS_A: credentialA, RELAY_PROCESS_B: credentialB }
  expect(() => parseRelayProcessConfig(JSON.stringify(valid), {})).toThrow(/missing or empty/)

  const duplicateCredential = {
    ...valid,
    credentials: [
      valid.credentials[0],
      { ...valid.credentials[1], credentialEnv: 'RELAY_PROCESS_C' },
    ],
  }
  expect(() => parseRelayProcessConfig(JSON.stringify(duplicateCredential), {
    ...env,
    RELAY_PROCESS_C: credentialA,
  })).toThrow(/duplicate credential/)

  const duplicateIdentity = {
    ...valid,
    credentials: [valid.credentials[0], { ...valid.credentials[1], credentialEnv: 'RELAY_PROCESS_C', identity: valid.credentials[0].identity }],
  }
  expect(() => parseRelayProcessConfig(JSON.stringify(duplicateIdentity), { ...env, RELAY_PROCESS_C: 'Bearer relay-process-c' }))
    .toThrow(/duplicate identity/)

  const plaintext = {
    ...valid,
    credentials: [{ ...valid.credentials[0], credential: credentialA }, valid.credentials[1]],
  }
  try {
    parseRelayProcessConfig(JSON.stringify(plaintext), env)
    throw new Error('expected relay process config validation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(RelayProcessConfigError)
    expect(error).toHaveProperty('message', expect.stringMatching(/unsupported field credential/))
    expect((error as Error).cause).toBeInstanceOf(Error)
  }
})

it('reports invalid TLS material as an owned process startup error with its cause', async () => {
  const invalidKey = join(tempDirectory, 'invalid-key.pem')
  const invalidCert = join(tempDirectory, 'invalid-cert.pem')
  const invalidConfig = join(tempDirectory, 'invalid-relay.json')
  writeFileSync(invalidKey, 'not a private key')
  writeFileSync(invalidCert, 'not a certificate')
  writeFileSync(invalidConfig, JSON.stringify({
    ...config(),
    tls: { keyFile: invalidKey, certFile: invalidCert },
  }))

  const error = await startRelayProcess(invalidConfig, {
    ...process.env,
    RELAY_PROCESS_A: credentialA,
    RELAY_PROCESS_B: credentialB,
  }).then(() => undefined, failure => failure as unknown)
  expect(error).toBeInstanceOf(RelayProcessConfigError)
  expect(error).toHaveProperty('message', 'relay server could not start')
  expect((error as Error).cause).toBeInstanceOf(Error)
})

it('isolates the public config snapshot from the live authentication identity map', async () => {
  const handle = await startRelayProcess(writeConfig(), {
    ...process.env,
    RELAY_PROCESS_A: credentialA,
    RELAY_PROCESS_B: credentialB,
  })
  try {
    const publicConfig = handle.config as unknown as { credentials: Array<{ identity: { agentId: string } }> }
    publicConfig.credentials[0].identity.agentId = 'forged-agent'
    const admitted = await login(handle.server.url, 'a', credentialA)
    expect(await directory(admitted)).toEqual(['a'])
  } finally {
    await handle.close()
  }
})

it('uses the shared admission codec and relays opaque data through the process server', async () => {
  const handle = await startRelayProcess(writeConfig(), {
    ...process.env,
    RELAY_PROCESS_A: credentialA,
    RELAY_PROCESS_B: credentialB,
  })
  try {
    let resolveOffer!: (grant: RelayGrant) => void
    const offered = new Promise<RelayGrant>(resolvePromise => { resolveOffer = resolvePromise })
    const a = await relayClient(handle.server.url, 'a', credentialA)
    const b = await relayClient(handle.server.url, 'b', credentialB, event => {
      if (event.kind === 'relay.offer') resolveOffer(event.grant)
    })
    const grant = await a.connect('b', b.generation)
    await expect(offered).resolves.toEqual(grant)

    const [source, target] = await Promise.all([a.openData(grant), b.openData(grant)])
    const payload = Buffer.from([0, 1, 2, 255])
    await source.send({ bytes: payload, binary: true })
    const received = await target.read()
    expect(received).toEqual({ bytes: payload, binary: true })
  } finally {
    for (const client of relayClients.splice(0).reverse()) {
      await client.close().catch(() => undefined)
    }
    await handle.close()
  }
})

it('starts, admits, lists, exits, and restarts through the real Node entrypoint', async () => {
  const configPath = writeConfig()
  const configText = readFileSync(configPath, 'utf8')
  expect(configText).not.toContain(credentialA)
  expect(configText).not.toContain(credentialB)

  const first = spawnRelay(configPath)
  const firstEndpoint = await waitForListening(first)
  const firstA = await login(firstEndpoint, 'a', credentialA)
  await expect(loginRelay({
    transport: {
      endpoint: firstEndpoint,
      credential: credentialA,
      ca: cert,
      connectTimeoutMs: 1000,
      maxMessageBytes: 65536,
      maxBufferedBytes: 65536,
      maxPendingFrames: 8,
    },
    declaration: declaration('b'),
    admissionTimeoutMs: 2000,
  })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const firstB = await login(firstEndpoint, 'b', credentialB)
  expect(await directory(firstA)).toEqual(['a', 'b'])
  await firstB.close()
  await firstA.close()
  first.kill('SIGTERM')
  const [firstCode, firstSignal] = await once(first, 'exit') as [number | null, NodeJS.Signals | null]
  expect(firstCode).toBe(0)
  expect(firstSignal).toBeNull()

  const second = spawnRelay(configPath)
  const secondEndpoint = await waitForListening(second)
  const secondA = await login(secondEndpoint, 'a', credentialA)
  expect(await directory(secondA)).toEqual(['a'])
  await secondA.close()
  second.kill('SIGINT')
  const [secondCode, secondSignal] = await once(second, 'exit') as [number | null, NodeJS.Signals | null]
  expect(secondCode).toBe(0)
  expect(secondSignal).toBeNull()
})
