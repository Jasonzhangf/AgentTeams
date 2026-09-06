import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createRelayClient, type RelayClient } from '../network/relay-client.ts'
import { createWorkChannel } from '../network/work-channel.ts'

let directory: string
let relay: RelayServer
let consumer: RelayClient
let cert: Buffer
const children: ChildProcess[] = []
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-agent-process-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  cert = readFileSync(join(directory, 'cert.pem'))
})
afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }
  await consumer?.close()
  await relay?.close()
  rmSync(directory, { recursive: true, force: true })
})
async function availablePort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('test port missing')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return address.port
}
function child(configPath: string) {
  const process = spawn(globalThis.process.execPath, ['--experimental-transform-types', resolve('runtime/agent-process.ts'), '--config', configPath],
    { env: { ...globalThis.process.env, TEAMS_AGENT_TEST_AUTH: 'Bearer provider' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(process)
  let output = ''
  process.stderr!.on('data', chunk => { output += chunk.toString() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once('exit', (code, signal) => resolve({ code, signal })))
  const ready = new Promise<{ agentId: string; generation: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Agent startup deadline: ${output}`)), 5000)
    process.once('message', message => {
      clearTimeout(timeout)
      if ((message as { kind?: string }).kind !== 'daemon.registered') reject(new Error('unexpected process control message'))
      else resolve(message as { agentId: string; generation: number })
    })
    process.once('exit', () => { clearTimeout(timeout); reject(new Error(`Agent exited before registration: ${output}`)) })
    process.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  return { process, ready, exited, output: () => output }
}

it('executes remote Work in an actual Agent process, rejects duplicate ownership and restarts from durable state', async () => {
  relay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key: readFileSync(join(directory, 'key.pem')),
    maxPayload: 65536, maxConnections: 16, maxGrants: 8, maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 10000,
    authenticate: credential => credential === 'Bearer provider' || credential === 'Bearer consumer'
      ? { accountId: 'account', scopeId: 'scope', agentId: credential.slice(7) } : null })
  const transport = { endpoint: relay.url, credential: 'Bearer consumer', ca: cert, connectTimeoutMs: 1000,
    maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 }
  consumer = await createRelayClient({ transport, declaration: { identity: { hostId: 'consumer', machineId: 'test', agentId: 'consumer', accountId: 'account', agentKind: 'custom', label: 'Consumer' }, scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
    admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxPendingRequests: 8, maxDataConnections: 8 })
  mkdirSync(join(directory, 'search'))
  writeFileSync(join(directory, 'search', 'sample.txt'), 'process work needle\n')
  const config = { version: 1, identity: { hostId: 'provider', machineId: 'test', agentId: 'provider', accountId: 'account', agentKind: 'custom', label: 'Provider' },
    scopeId: 'scope', dataDirectory: './data', leasePort: await availablePort(), presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: ['consumer'] },
    cli: { camoExecutable: '/opt/homebrew/bin/camo', searchExecutable: '/opt/homebrew/bin/rg', searchRoot: './search', profilePrefix: 'teams-process-test' },
    relay: { endpoint: relay.url, credentialEnv: 'TEAMS_AGENT_TEST_AUTH', caFile: './cert.pem', connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 } }
  const path = join(directory, 'agent.json')
  writeFileSync(path, JSON.stringify(config))
  const first = child(path)
  expect(await first.ready).toMatchObject({ agentId: 'provider', generation: 1 })
  const duplicate = child(path)
  await expect(duplicate.ready).rejects.toThrow(/EADDRINUSE/)
  expect((await duplicate.exited).code).toBe(1)
  const provider = (await consumer.directory(false)).find(peer => peer.declaration.identity.agentId === 'provider')!
  expect(provider.declaration.revision).toBe(2)
  expect(provider.declaration.capabilities.map(item => item.capabilityId)).toContain('file-search')
  expect(provider.declaration.capabilities.find(item => item.capabilityId === 'file-search')!.operations[0]).toMatchObject({
    operation: 'search', inputSchema: { type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 }, maxResults: { type: 'integer', minimum: 1 } } },
    outputSchema: { required: ['query', 'status', 'exitCode', 'matches', 'truncated', 'stdout', 'stderr'] },
  })
  const connect = async (generation: number) => {
    const grant = await consumer.connect('provider', generation)
    return createWorkChannel(await consumer.openData(grant), { timeoutMs: 2000, maxPending: 4, maxIncoming: 4 })
  }
  const channel = await connect(1)
  expect(await channel.request({ kind: 'work.propose', proposal: { workId: 'work', consumerAgentId: 'consumer', providerAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1 } })).toMatchObject({ work: { state: 'accepted' } })
  expect(await channel.request({ kind: 'work.request', control: { workId: 'work', requestId: 'request', operation: 'search', targetGeneration: 1, demands: [{ resourceId: 'search-slot', amount: 1 }] },
    payload: { query: 'process work needle' } })).toMatchObject({ control: { state: 'succeeded' }, payload: { matches: [expect.objectContaining({ text: 'process work needle\n' })] } })
  await channel.request({ kind: 'work.close', workId: 'work' })
  first.process.kill('SIGTERM')
  expect((await first.exited).code).toBe(0)
  const second = child(path)
  expect(await second.ready).toMatchObject({ generation: 2 })
  const query = await connect(2)
  expect(await query.request({ kind: 'work.get', workId: 'work', requestId: 'request' })).toMatchObject({ control: { state: 'succeeded' } })
  second.process.kill('SIGKILL')
  expect((await second.exited).signal).toBe('SIGKILL')
  const third = child(path)
  expect(await third.ready).toMatchObject({ generation: 3 })
  third.process.kill('SIGINT')
  expect((await third.exited).code).toBe(0)
  expect(first.output()).not.toContain('Bearer provider')
}, 15000)
