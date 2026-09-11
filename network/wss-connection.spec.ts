import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { connectDirectWssTarget } from './direct-route.ts'
import { buildRoutePlan, type RoutePlan } from './route-plan.ts'
import { connectWss, type WssConnection } from './wss-connection.ts'
import { loginRelay } from './relay-login.ts'
import { createRelayClient } from './relay-client.ts'
import { createRelayServer } from '../server/relay.ts'

let directory: string
let key: Buffer
let cert: Buffer
const cleanup: Array<() => Promise<void>> = []
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-wss-client-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  key = readFileSync(join(directory, 'key.pem'))
  cert = readFileSync(join(directory, 'cert.pem'))
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function server() {
  const https = createServer({ key, cert })
  const wss = new WebSocketServer({ server: https })
  https.listen(0, '127.0.0.1')
  await once(https, 'listening')
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>(resolve => https.close(() => resolve()))
  })
  const address = https.address()
  if (!address || typeof address === 'string') throw new Error('test listener missing')
  return { wss, endpoint: `wss://localhost:${address.port}` }
}

function options(endpoint: string) {
  return { endpoint, credential: 'Bearer test-only', ca: cert, connectTimeoutMs: 1000,
    maxMessageBytes: 1024, maxBufferedBytes: 2048, maxPendingFrames: 4 }
}

async function client(endpoint: string, limits = {}) {
  const connection = await connectWss({ ...options(endpoint), ...limits })
  cleanup.push(() => connection.close())
  return connection
}

function directRoutePlan(endpoint: string): RoutePlan {
  return buildRoutePlan({
    hostId: 'host-a',
    directoryGeneration: 1,
    policy: 'manual',
    candidates: [{
      candidateId: 'direct-1',
      kind: 'lan',
      endpoint,
      port: 8443,
      authRequired: true,
      lastSeenAt: '2026-09-04T00:00:00.000Z',
    }],
    targetCandidateId: 'direct-1',
  })
}

const directHello = {
  hostId: 'host-a',
  agentId: 'agent-a',
  targetGeneration: 7,
  protocolVersion: 1,
  capabilitiesRevision: 'cap-1',
  source: { accountId: 'account', scopeId: 'scope', agentId: 'consumer-a' },
  admissionRef: 'direct:consumer-a',
}

it('dials a direct WSS target through hello ack and keeps generation isolated', async () => {
  const host = await server()
  host.wss.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      expect(message).toMatchObject({ kind: 'transport.hello', targetGeneration: 7 })
      socket.send(JSON.stringify({ kind: 'transport.hello_ack', targetGeneration: message.targetGeneration }))
    })
  })
  const target = await connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: directHello,
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 1000,
  })
  cleanup.push(() => target.close())
  expect(target.plan.state).toBe('succeeded')
  expect(target.state.state).toBe('ready')
  expect(target.state.targetGeneration).toBe(7)
  expect(() => target.assertGeneration(7)).not.toThrow()
  expect(() => target.assertGeneration(8)).toThrow(/STALE_GENERATION/)
  await target.close()
  await target.closed
})

it('closes the direct socket and retires the route on hello error', async () => {
  const host = await server()
  let peerClosed!: Promise<unknown>
  host.wss.on('connection', socket => {
    peerClosed = once(socket, 'close')
    socket.on('message', () => socket.send(JSON.stringify({ kind: 'transport.error', targetGeneration: 7, code: 'FORBIDDEN', message: 'peer denied' })))
  })
  await expect(connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: directHello,
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 1000,
  })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'peer denied', plan: { state: 'failed', lastError: 'peer denied' } })
  await peerClosed
})

it('never claims direct readiness when hello times out', async () => {
  const host = await server()
  let peerClosed!: Promise<unknown>
  host.wss.on('connection', socket => {
    peerClosed = once(socket, 'close')
    socket.on('message', () => { /* withhold hello ack */ })
  })
  await expect(connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: directHello,
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 25,
  })).rejects.toMatchObject({ code: 'RESULT_UNKNOWN', plan: { state: 'failed' } })
  await peerClosed
})

it('rejects a stale hello ack generation explicitly', async () => {
  const host = await server()
  let peerClosed!: Promise<unknown>
  host.wss.on('connection', socket => {
    peerClosed = once(socket, 'close')
    socket.on('message', () => socket.send(JSON.stringify({ kind: 'transport.hello_ack', targetGeneration: 8 })))
  })
  await expect(connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: directHello,
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 1000,
  })).rejects.toMatchObject({ code: 'STALE_GENERATION', plan: { state: 'failed' } })
  await peerClosed
})

it('isolates direct WSS target connections per route plan', async () => {
  const host = await server()
  let connections = 0
  host.wss.on('connection', socket => {
    connections++
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      socket.send(JSON.stringify({ kind: 'transport.hello_ack', targetGeneration: message.targetGeneration }))
    })
  })
  const first = await connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: { ...directHello, targetGeneration: 1 },
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 1000,
  })
  cleanup.push(() => first.close())
  const second = await connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: { ...directHello, targetGeneration: 2 },
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 1000,
  })
  cleanup.push(() => second.close())
  expect(connections).toBe(2)
  expect(second.state.state).toBe('ready')
  await first.close()
  expect(second.state.state).toBe('ready')
})

it('reconnects an explicitly closed direct target without reusing its socket', async () => {
  const host = await server()
  const sockets: Array<{ close(): void }> = []
  host.wss.on('connection', socket => {
    sockets.push(socket)
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      socket.send(JSON.stringify({ kind: 'transport.hello_ack', targetGeneration: message.targetGeneration }))
    })
  })
  const first = await connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: directHello,
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 1000,
  })
  await expect(first.reconnect()).rejects.toMatchObject({ code: 'CONFLICT' })
  sockets[0].close()
  await first.closed
  expect(first.state.state).toBe('closed')
  const second = await first.reconnect()
  cleanup.push(() => second.close())
  expect(second).not.toBe(first)
  expect(second.connection).not.toBe(first.connection)
  expect(second.plan.state).toBe('succeeded')
  expect(second.state).toMatchObject({ state: 'ready', targetGeneration: directHello.targetGeneration })
})

it('bounds concurrent reconnect calls to one observable connection attempt', async () => {
  const host = await server()
  let connections = 0
  host.wss.on('connection', socket => {
    connections++
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      socket.send(JSON.stringify({ kind: 'transport.hello_ack', targetGeneration: message.targetGeneration }))
    })
  })
  const first = await connectDirectWssTarget({
    transport: options(host.endpoint),
    hello: directHello,
    plan: directRoutePlan(host.endpoint),
    helloTimeoutMs: 1000,
  })
  const peer = [...host.wss.clients][0]
  peer.close()
  await first.closed

  const [second, third] = await Promise.all([first.reconnect(), first.reconnect()])
  cleanup.push(() => second.close())
  expect(second).toBe(third)
  expect(await first.reconnect()).toBe(second)
  expect(connections).toBe(2)

  const successorPeer = [...host.wss.clients][0]
  successorPeer.close()
  await second.closed
  const fourth = await first.reconnect()
  cleanup.push(() => fourth.close())
  expect(fourth).not.toBe(second)
  expect(fourth.connection).not.toBe(second.connection)
  expect(connections).toBe(3)
})

it('uses a verified TLS socket, sends credential only as a header, and preserves frame bytes/type', async () => {
  const host = await server()
  let credential: string | undefined
  host.wss.on('connection', (socket, request) => {
    credential = request.headers.authorization
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
  })
  const connection = await client(host.endpoint)
  const text = Buffer.from('{"metadata":{"route":"business"},"payload":[1,2]}')
  await connection.send({ bytes: text, binary: false })
  expect(await connection.read()).toEqual({ bytes: text, binary: false })
  const binary = Buffer.from([0, 255, 1, 128])
  await connection.send({ bytes: binary, binary: true })
  expect(await connection.read()).toEqual({ bytes: binary, binary: true })
  expect(credential).toBe('Bearer test-only')
})

it('rejects untrusted TLS certificates and insecure endpoints', async () => {
  const host = await server()
  await expect(connectWss({ ...options(host.endpoint), ca: undefined })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await expect(connectWss(options('ws://localhost:4444'))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

it('rejects pre-cancelled connections and closes established sockets on cancellation', async () => {
  const host = await server()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(connectWss(options(host.endpoint), cancelled.signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  expect(host.wss.clients.size).toBe(0)
  const lifetime = new AbortController()
  const accepted = once(host.wss, 'connection')
  const connection = await connectWss(options(host.endpoint), lifetime.signal)
  cleanup.push(() => connection.close())
  const [peer] = await accepted
  const peerClosed = once(peer, 'close')
  const read = expect(connection.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  lifetime.abort()
  await read
  await connection.closed
  await peerClosed
})

it('fails pending reads and future writes when the real peer disconnects', async () => {
  const host = await server()
  const accepted = once(host.wss, 'connection')
  const connection = await client(host.endpoint)
  const [socket] = await accepted
  const read = expect(connection.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  socket.terminate()
  await read
  await expect(connection.send({ bytes: Buffer.from('x'), binary: false })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
})

it('bounds unread frames even when each individual frame is small', async () => {
  const host = await server()
  host.wss.on('connection', socket => {
    socket.send('a')
    socket.send('b')
    socket.send('c')
  })
  const connection = await client(host.endpoint, { maxPendingFrames: 2 })
  await expect(connection.closed).resolves.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await expect(connection.read()).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
})

it('rejects concurrent readers and oversized sends without an implicit retry', async () => {
  const host = await server()
  const connection: WssConnection = await client(host.endpoint)
  const pending = expect(connection.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await expect(connection.read()).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(connection.send({ bytes: Buffer.alloc(1025), binary: true })).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await connection.close()
  await pending
})

it('bounds queued bytes independently of the frame count', async () => {
  const host = await server()
  host.wss.on('connection', socket => { socket.send('abcd'); socket.send('efgh') })
  const connection = await client(host.endpoint, { maxBufferedBytes: 6 })
  await expect(connection.closed).resolves.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
})

it('rejects a single oversized inbound frame before delivery', async () => {
  const host = await server()
  host.wss.on('connection', socket => socket.send(Buffer.alloc(1025)))
  const connection = await client(host.endpoint)
  await expect(connection.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await connection.closed
})

const declaration = {
  identity: { hostId: 'host-a', machineId: 'machine-a', agentId: 'agent-a', accountId: 'account-a', agentKind: 'custom' as const, label: 'A' },
  scopeId: 'scope-a', revision: 1, capabilities: [], routes: [],
}

it('returns relay admission only after a valid server acknowledgement', async () => {
  const host = await server()
  let login: unknown
  host.wss.on('connection', socket => socket.on('message', data => {
    login = JSON.parse(data.toString())
    socket.send(JSON.stringify({ kind: 'relay.admitted', connectionId: 'connection-a', generation: 3 }))
  }))
  const admitted = await loginRelay({ transport: options(host.endpoint), declaration, admissionTimeoutMs: 1000 })
  cleanup.push(() => admitted.transport.close())
  expect(admitted.receipt).toEqual({ connectionId: 'connection-a', generation: 3 })
  expect(login).toEqual({ kind: 'relay.login', protocolVersion: 2, declaration })
})

it('preserves an explicit relay denial and closes the rejected socket', async () => {
  const host = await server()
  let peerClosed!: Promise<unknown>
  host.wss.on('connection', socket => {
    peerClosed = once(socket, 'close')
    socket.on('message', () => socket.send(JSON.stringify({ kind: 'relay.error', error: { code: 'FORBIDDEN', message: 'scope denied' } })))
  })
  await expect(loginRelay({ transport: options(host.endpoint), declaration, admissionTimeoutMs: 1000 }))
    .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'scope denied' })
  await peerClosed
})

it('times out admission without claiming readiness or leaving the socket open', async () => {
  const host = await server()
  let peerClosed!: Promise<unknown>
  host.wss.on('connection', socket => { peerClosed = once(socket, 'close') })
  await expect(loginRelay({ transport: options(host.endpoint), declaration, admissionTimeoutMs: 25 }))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await peerClosed
})

it('closes an admitted client on request timeout without replaying an unknown result', async () => {
  const host = await server()
  let requests = 0
  let peerClosed!: Promise<unknown>
  host.wss.on('connection', socket => {
    peerClosed = once(socket, 'close')
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.kind === 'relay.login') {
        socket.send(JSON.stringify({ kind: 'relay.admitted', connectionId: 'c', generation: 1 }))
      } else requests++ // Accept the bytes, deliberately withhold the result.
    })
  })
  const connection = await createRelayClient({ transport: options(host.endpoint), declaration,
    admissionTimeoutMs: 1000, requestTimeoutMs: 25, maxPendingRequests: 1, maxDataConnections: 1 })
  cleanup.push(() => connection.close())
  await expect(connection.connect('other', 1)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
  await expect(connection.closed).resolves.toMatchObject({ code: 'RESULT_UNKNOWN' })
  await peerClosed
  await expect(connection.directory(false)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
  expect(requests).toBe(1)
})

it('stops an in-flight data handshake without waiting for its configured connection timeout', async () => {
  const https = createServer({ key, cert })
  const wss = new WebSocketServer({ noServer: true })
  let upgradeCount = 0
  let releaseStalled!: () => void
  let stalledReady!: () => void
  const stalled = new Promise<void>(resolve => { stalledReady = resolve })
  https.on('upgrade', (request, socket, head) => {
    if (++upgradeCount === 1) wss.handleUpgrade(request, socket, head, connection => {
      connection.on('message', () => connection.send(JSON.stringify({ kind: 'relay.admitted', connectionId: 'c', generation: 1 })))
    })
    else { releaseStalled = () => socket.destroy(); stalledReady() }
  })
  https.listen(0, '127.0.0.1')
  await once(https, 'listening')
  cleanup.push(async () => {
    releaseStalled?.()
    for (const socket of wss.clients) socket.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>(resolve => https.close(() => resolve()))
  })
  const address = https.address()
  if (!address || typeof address === 'string') throw new Error('test listener missing')
  const connection = await createRelayClient({ transport: { ...options(`wss://127.0.0.1:${address.port}`), connectTimeoutMs: 5000 },
    declaration, admissionTimeoutMs: 1000, requestTimeoutMs: 1000, maxPendingRequests: 1, maxDataConnections: 1 })
  const opening = expect(connection.openData({ grantId: 'g', accountId: 'account-a', scopeId: 'scope-a',
    sourceAgentId: 'agent-a', targetAgentId: 'other', sourceGeneration: 1, targetGeneration: 1,
    expiresAt: new Date(Date.now() + 10000).toISOString() })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await stalled
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    expect(await Promise.race([connection.close().then(() => 'closed'),
      new Promise<string>(resolve => { timeout = setTimeout(() => resolve('deadline'), 200) })])).toBe('closed')
    await opening
  } finally {
    clearTimeout(timeout)
    releaseStalled()
    await connection.close()
    await opening
  }
})

it.each([
  { kind: 'relay.admitted', connectionId: 'c', generation: 0 },
  { kind: 'relay.admitted', connectionId: 'c', generation: 1, payload: { ready: true } },
  { kind: 'relay.error', error: { code: 'invented', message: 'bad' } },
  { kind: 'relay.directory', peers: [] },
])('rejects malformed or out-of-order admission: %j', async response => {
  const host = await server()
  host.wss.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify(response))))
  await expect(loginRelay({ transport: options(host.endpoint), declaration, admissionTimeoutMs: 1000 }))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

it('logs two peers into the actual Relay and carries opaque data without a Console', async () => {
  const relay = await createRelayServer({
    host: '127.0.0.1', port: 0, key, cert, maxPayload: 65536, maxConnections: 8,
    maxGrants: 4, maxBufferedAmount: 65536, maxPendingMessages: 8, maxPendingBytes: 65536,
    grantTtlMs: 10000,
    authenticate: credential => credential === 'Bearer a' || credential === 'Bearer b'
      ? { accountId: 'account-a', scopeId: 'scope-a', agentId: credential.slice(-1) }
      : null,
  })
  cleanup.push(() => relay.close())
  const limits = { ...options(relay.url), maxMessageBytes: 65536, maxBufferedBytes: 65536 }
  const a = await loginRelay({ transport: { ...limits, credential: 'Bearer a' },
    declaration: { ...declaration, identity: { ...declaration.identity, agentId: 'a' } }, admissionTimeoutMs: 1000 })
  cleanup.push(() => a.transport.close())
  const b = await loginRelay({ transport: { ...limits, credential: 'Bearer b' },
    declaration: { ...declaration, identity: { ...declaration.identity, agentId: 'b' } }, admissionTimeoutMs: 1000 })
  cleanup.push(() => b.transport.close())
  const send = (connection: WssConnection, control: unknown) => connection.send({ bytes: Buffer.from(JSON.stringify(control)), binary: false })
  await send(a.transport, { kind: 'relay.directory', requestId: 'directory-1', subscribe: false })
  const directory = JSON.parse((await a.transport.read()).bytes.toString())
  expect(directory.kind).toBe('relay.directory')
  expect(directory.peers.map((peer: { declaration: { identity: { agentId: string } } }) => peer.declaration.identity.agentId).sort()).toEqual(['a', 'b'])
  await send(a.transport, { kind: 'relay.connect', requestId: 'connect-1', generation: a.receipt.generation,
    targetAgentId: 'b', targetGeneration: b.receipt.generation })
  const grant = JSON.parse((await a.transport.read()).bytes.toString())
  expect(grant.kind).toBe('relay.grant')
  expect(JSON.parse((await b.transport.read()).bytes.toString())).toEqual({ kind: 'relay.offer', grant: grant.grant })
  const aData = await connectWss({ ...limits, credential: 'Bearer a' })
  cleanup.push(() => aData.close())
  const bData = await connectWss({ ...limits, credential: 'Bearer b' })
  cleanup.push(() => bData.close())
  await send(aData, { kind: 'relay.open', requestId: 'open-a', grantId: grant.grant.grantId, generation: a.receipt.generation })
  await send(bData, { kind: 'relay.open', requestId: 'open-b', grantId: grant.grant.grantId, generation: b.receipt.generation })
  expect(JSON.parse((await aData.read()).bytes.toString()).kind).toBe('relay.opened')
  expect(JSON.parse((await bData.read()).bytes.toString()).kind).toBe('relay.opened')
  const payload = Buffer.from('{"kind":"relay.error","metadata":{"generation":"business"},"payload":[1,2]}')
  await aData.send({ bytes: payload, binary: false })
  expect(await bData.read()).toEqual({ bytes: payload, binary: false })
  await bData.send({ bytes: Buffer.from([0, 255]), binary: true })
  expect(await aData.read()).toEqual({ bytes: Buffer.from([0, 255]), binary: true })
})
