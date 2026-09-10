import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { connectDirectWssTarget } from './direct-route.ts'
import { buildRoutePlan, type RoutePlan } from './route-plan.ts'
import { connectWss } from './wss-connection.ts'
import { createDirectWssListener, type DirectWssAcceptedConnection } from './direct-listener.ts'

let directory: string
let key: Buffer
let cert: Buffer
const cleanup: Array<() => Promise<void>> = []

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-direct-listener-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  key = readFileSync(join(directory, 'key.pem'))
  cert = readFileSync(join(directory, 'cert.pem'))
})

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const hello = {
  hostId: 'host-a',
  agentId: 'agent-a',
  targetGeneration: 7,
  protocolVersion: 1,
  capabilitiesRevision: 'cap-1',
}

function clientOptions(endpoint: string, credential = 'Bearer direct-test') {
  return { endpoint, credential, ca: cert, connectTimeoutMs: 1000,
    maxMessageBytes: 1024, maxBufferedBytes: 2048, maxPendingFrames: 4 }
}

function directRoutePlan(endpoint: string): RoutePlan {
  return buildRoutePlan({
    hostId: hello.hostId,
    directoryGeneration: 1,
    policy: 'manual',
    candidates: [{ candidateId: 'direct-1', kind: 'lan', endpoint, port: 8443,
      authRequired: true, lastSeenAt: '2026-09-10T00:00:00.000Z' }],
    targetCandidateId: 'direct-1',
  })
}

async function listener(onConnection?: (connection: DirectWssAcceptedConnection) => void, limits: { maxPayload?: number; maxMessageBytes?: number } = {}) {
  const value = await createDirectWssListener({
    host: '127.0.0.1', port: 0, key, cert, credential: 'Bearer direct-test',
    target: hello, maxPayload: limits.maxPayload ?? 1024, maxConnections: 4, maxMessageBytes: limits.maxMessageBytes ?? 1024,
    maxBufferedBytes: 2048, maxPendingFrames: 4, helloTimeoutMs: 500,
    onConnection,
  })
  cleanup.push(() => value.close())
  return value
}

describe('Agent-owned direct WSS listener', () => {
  it('accepts authenticated typed hello and acknowledges the configured generation', async () => {
    let accepted!: DirectWssAcceptedConnection
    const host = await listener(connection => { accepted = connection })
    const target = await connectDirectWssTarget({ transport: clientOptions(host.url), hello,
      plan: directRoutePlan(host.url), helloTimeoutMs: 1000 })
    cleanup.push(() => target.close())
    expect(accepted.state).toMatchObject({ state: 'ready', targetGeneration: hello.targetGeneration })
    expect(target.state).toMatchObject({ state: 'ready', targetGeneration: hello.targetGeneration })
    const serverFrame = Buffer.from('{"kind":"direct.test","value":1}')
    await accepted.connection.send({ bytes: serverFrame, binary: false })
    await expect(target.connection.read()).resolves.toEqual({ bytes: serverFrame, binary: false })
    const clientFrame = Buffer.from('{"kind":"direct.test","value":2}')
    await target.connection.send({ bytes: clientFrame, binary: false })
    await expect(accepted.connection.read()).resolves.toEqual({ bytes: clientFrame, binary: false })
    await target.close()
    await expect(accepted.closed).resolves.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('rejects stale target generations and closes only that connection', async () => {
    const host = await listener()
    const staleHello = { ...hello, targetGeneration: hello.targetGeneration + 1 }
    const target = connectDirectWssTarget({ transport: clientOptions(host.url), hello: staleHello,
      plan: buildRoutePlan({ hostId: hello.hostId, directoryGeneration: 1, policy: 'manual',
        candidates: [{ candidateId: 'direct-1', kind: 'lan', endpoint: host.url, port: 8443,
          authRequired: true, lastSeenAt: '2026-09-10T00:00:00.000Z' }], targetCandidateId: 'direct-1' }), helloTimeoutMs: 1000 })
    await expect(target).rejects.toMatchObject({ code: 'STALE_GENERATION' })
  })

  it('rejects unauthorized clients before the target handshake', async () => {
    const host = await listener()
    await expect(connectWss(clientOptions(host.url, 'Bearer wrong'))).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('returns a typed error for an invalid hello and closes the connection', async () => {
    const host = await listener()
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const value = new WebSocket(host.url, { ca: cert, headers: { authorization: 'Bearer direct-test' } })
      value.once('open', () => resolve(value))
      value.once('error', reject)
    })
    cleanup.push(async () => { socket.terminate() })
    const error = new Promise<unknown>(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()))))
    socket.send(JSON.stringify({ kind: 'transport.hello', targetGeneration: hello.targetGeneration }))
    await expect(error).resolves.toMatchObject({ kind: 'transport.error', targetGeneration: hello.targetGeneration, code: 'INVALID_INPUT' })
    await once(socket, 'close')
  })

  it('rejects an oversized hello before parsing when maxPayload exceeds maxMessageBytes', async () => {
    const host = await listener(undefined, { maxPayload: 1024, maxMessageBytes: 64 })
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const value = new WebSocket(host.url, { ca: cert, headers: { authorization: 'Bearer direct-test' } })
      value.once('open', () => resolve(value))
      value.once('error', reject)
    })
    cleanup.push(async () => { socket.terminate() })
    const error = new Promise<unknown>(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()))))
    socket.send(JSON.stringify(hello))
    await expect(error).resolves.toMatchObject({ kind: 'transport.error', code: 'RESOURCE_EXHAUSTED' })
    await once(socket, 'close')
  })

  it('rejects oversized post-handshake frames before queueing', async () => {
    let accepted!: DirectWssAcceptedConnection
    const host = await listener(connection => { accepted = connection }, { maxPayload: 1024, maxMessageBytes: 256 })
    const target = await connectDirectWssTarget({ transport: clientOptions(host.url), hello,
      plan: directRoutePlan(host.url), helloTimeoutMs: 1000 })
    cleanup.push(() => target.close())
    const oversized = Buffer.alloc(257, 'x')
    await target.connection.send({ bytes: oversized, binary: false })
    const errorFrame = await target.connection.read()
    expect(errorFrame.binary).toBe(false)
    expect(JSON.parse(errorFrame.bytes.toString())).toMatchObject({ kind: 'transport.error', code: 'RESOURCE_EXHAUSTED' })
    await expect(accepted.closed).resolves.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  })

  it('isolates accepted connections and closes all explicitly', async () => {
    const accepted: DirectWssAcceptedConnection[] = []
    const host = await listener(connection => { accepted.push(connection) })
    const first = await connectDirectWssTarget({ transport: clientOptions(host.url), hello,
      plan: directRoutePlan(host.url), helloTimeoutMs: 1000 })
    const second = await connectDirectWssTarget({ transport: clientOptions(host.url), hello: { ...hello, targetGeneration: 7 },
      plan: directRoutePlan(host.url), helloTimeoutMs: 1000 })
    cleanup.push(() => first.close(), () => second.close())
    expect(accepted).toHaveLength(2)
    await first.close()
    await expect(accepted[0].closed).resolves.toBeDefined()
    expect(second.state.state).toBe('ready')
    await host.close()
    await expect(second.closed).resolves.toBeDefined()
  })
})
