import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { AuthenticatedAgent, AgentDeclaration, RelayClientControl, RelayPeer, RelayServerControl } from '../control-protocol/agent-services.ts'
import { createRelayServer, type RelayServer, type RelayServerOptions } from './relay.ts'

interface TestCertificate {
  readonly key: Buffer
  readonly cert: Buffer
  readonly directory: string
}

interface TestPeer {
  readonly token: string
  readonly auth: AuthenticatedAgent
  readonly declaration: AgentDeclaration
}

type Authenticate = (credential: string | undefined) => AuthenticatedAgent | null | Promise<AuthenticatedAgent | null>

let certificate: TestCertificate
const peers: readonly TestPeer[] = [
  {
    token: 'Bearer agent-a',
    auth: { accountId: 'account-a', scopeId: 'scope-a', agentId: 'agent-a' },
    declaration: declaration('agent-a', 'scope-a', 1),
  },
  {
    token: 'Bearer agent-b',
    auth: { accountId: 'account-a', scopeId: 'scope-a', agentId: 'agent-b' },
    declaration: declaration('agent-b', 'scope-a', 1),
  },
  {
    token: 'Bearer agent-c',
    auth: { accountId: 'account-a', scopeId: 'scope-b', agentId: 'agent-c' },
    declaration: declaration('agent-c', 'scope-b', 1),
  },
]

let relay: RelayServer
let clockMs: number
/** `true` runs the server on the real clock so a lease timer can actually fire. */
let useRealClock: boolean
let peerTtlMs: number
let authenticateOverride: Authenticate | undefined
const clients: WebSocket[] = []

function declaration(agentId: string, scopeId: string, revision: number, accountId = 'account-a'): AgentDeclaration {
  return {
    identity: {
      hostId: `host-${agentId}`,
      machineId: `machine-${agentId}`,
      agentId,
      accountId,
      agentKind: 'custom',
      label: agentId,
    },
    scopeId,
    revision,
    capabilities: [],
    routes: [],
  }
}

function peer(agentId: string): TestPeer {
  const result = peers.find((candidate) => candidate.auth.agentId === agentId)
  if (!result) throw new Error(`unknown test peer ${agentId}`)
  return result
}

function authenticateCredential(credential: string | undefined): AuthenticatedAgent | null {
  return peers.find((candidate) => candidate.token === credential)?.auth ?? null
}

function openSocket(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relay.url, {
      rejectUnauthorized: false,
      headers: { authorization: token },
    })
    clients.push(socket)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function send(socket: WebSocket, message: RelayClientControl): void {
  socket.send(JSON.stringify(message))
}

function nextJson(socket: WebSocket): Promise<RelayServerControl> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      cleanup()
      if (isBinary) {
        reject(new Error('expected a control message'))
        return
      }
      try {
        resolve(JSON.parse(data.toString()) as RelayServerControl)
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function nextMatching(socket: WebSocket, predicate: (message: RelayServerControl) => boolean): Promise<RelayServerControl> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return
      try {
        const message = JSON.parse(data.toString()) as RelayServerControl
        if (!predicate(message)) return
        cleanup()
        resolve(message)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function nextBinary(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      cleanup()
      if (!isBinary) {
        reject(new Error('expected an opaque binary frame'))
        return
      }
      resolve(Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

function waitForCloseWithin(socket: WebSocket, timeoutMs = 500): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('close', onClose)
      reject(new Error(`socket did not close within ${timeoutMs}ms`))
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.once('close', onClose)
  })
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function settleServerClose(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

async function expectNoMessage(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = () => {
      cleanup()
      reject(new Error('unexpected message'))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, 100)
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function login(socket: WebSocket, testPeer: TestPeer): Promise<RelayServerControl> {
  send(socket, { kind: 'relay.login', protocolVersion: 2, declaration: testPeer.declaration })
  return nextJson(socket)
}

function makeCertificate(): TestCertificate {
  const directory = mkdtempSync(join(tmpdir(), 'agentteams-relay-'))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
  ], { stdio: 'ignore' })
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), directory }
}

beforeAll(() => {
  certificate = makeCertificate()
})

afterAll(() => rmSync(certificate.directory, { recursive: true, force: true }))

function relayOptions(ttlMs: number): RelayServerOptions {
  return {
    host: '127.0.0.1',
    port: 0,
    key: certificate.key,
    cert: certificate.cert,
    maxPayload: 1024 * 1024,
    maxConnections: 32,
    maxGrants: 1,
    maxBufferedAmount: 4 * 1024,
    maxPendingMessages: 8,
    maxPendingBytes: 16 * 1024,
    grantTtlMs: 60_000,
    peerTtlMs: ttlMs,
    now: () => new Date(useRealClock ? Date.now() : clockMs),
    authenticate: (credential) => authenticateOverride?.(credential) ?? authenticateCredential(credential),
  }
}

beforeEach(async () => {
  clockMs = Date.now()
  useRealClock = false
  peerTtlMs = 90_000
  relay = await createRelayServer(relayOptions(peerTtlMs))
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.terminate()
  }
  await relay.close()
  authenticateOverride = undefined
})

describe('N1 relay server', () => {
  it('rejects unauthenticated login before publishing presence', async () => {
    const denied = await openSocket('Bearer unknown')
    send(denied, { kind: 'relay.login', protocolVersion: 2, declaration: peer('agent-a').declaration })
    await expect(nextJson(denied)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'UNAUTHENTICATED' } })
    await waitForClose(denied)

    const admitted = await openSocket(peer('agent-a').token)
    await expect(login(admitted, peer('agent-a'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 1 })
    send(admitted, { kind: 'relay.directory', requestId: 'directory-1', subscribe: false })
    const directory = await nextJson(admitted)
    expect(directory).toMatchObject({ kind: 'relay.directory', requestId: 'directory-1', revision: 1 })
    if (directory.kind === 'relay.directory') expect(directory.peers).toHaveLength(1)
  })

  it('acknowledges logout only after publishing the peer offline', async () => {
    const stopped = await openSocket(peer('agent-a').token)
    await expect(login(stopped, peer('agent-a'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 1 })
    const observer = await openSocket(peer('agent-b').token)
    await login(observer, peer('agent-b'))
    send(stopped, { kind: 'relay.logout', requestId: 'logout-1', generation: 1 })
    await expect(nextJson(stopped)).resolves.toEqual({ kind: 'relay.logged-out', requestId: 'logout-1' })
    send(observer, { kind: 'relay.directory', requestId: 'logout-directory', subscribe: false })
    const directory = await nextJson(observer)
    if (directory.kind !== 'relay.directory') throw new Error('logout directory snapshot was not returned')
    expect(directory.peers.find(item => item.declaration.identity.agentId === 'agent-a')).toMatchObject({ presence: 'offline' })
  })

  it('closes malformed control connections with an explicit input error', async () => {
    const socket = await openSocket(peer('agent-a').token)
    socket.send('{')
    await expect(nextJson(socket)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'INVALID_INPUT' } })
    await waitForClose(socket)
  })

  it('preserves schema __proto__ fields and rejects unknown control/declaration fields', async () => {
    const inputSchema = JSON.parse('{"__proto__":{"type":"string"}}') as AgentDeclaration['capabilities'][number]['operations'][number]['inputSchema']
    const schemaDeclaration: AgentDeclaration = {
      ...peer('agent-a').declaration,
      capabilities: [{
        capabilityId: 'capability-a',
        version: '1',
        operations: [{ operation: 'operation-a', inputSchema, outputSchema: {}, cancellation: 'unsupported' }],
        resources: [],
      }],
    }
    const admitted = await openSocket(peer('agent-a').token)
    send(admitted, { kind: 'relay.login', protocolVersion: 2, declaration: schemaDeclaration })
    await expect(nextJson(admitted)).resolves.toMatchObject({ kind: 'relay.admitted' })
    send(admitted, { kind: 'relay.directory', requestId: 'schema-directory', subscribe: false })
    const directory = await nextJson(admitted)
    if (directory.kind !== 'relay.directory') throw new Error('directory snapshot was not returned')
    const returnedSchema = directory.peers[0]?.declaration.capabilities[0]?.operations[0]?.inputSchema
    expect(returnedSchema).toBeDefined()
    expect(Object.keys(returnedSchema ?? {})).toContain('__proto__')
    expect(Object.prototype.hasOwnProperty.call(returnedSchema, '__proto__')).toBe(true)

    admitted.send(JSON.stringify({ kind: 'relay.directory', requestId: 'unknown-control', subscribe: false, extra: true }))
    await expect(nextJson(admitted)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'INVALID_INPUT' } })

    const invalid = await openSocket(peer('agent-a').token)
    send(invalid, { kind: 'relay.login', protocolVersion: 2, declaration: { ...schemaDeclaration, extra: true } })
    await expect(nextJson(invalid)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'INVALID_INPUT' } })
    await waitForClose(invalid)
  })

  it('does not admit a control identity when authentication resolves after close', async () => {
    let release: ((value: AuthenticatedAgent | null) => void) | undefined
    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((resolve) => { startedResolve = resolve })
    let waiting = true
    authenticateOverride = (credential) => {
      if (waiting && credential === peer('agent-a').token) {
        waiting = false
        startedResolve?.()
        return new Promise<AuthenticatedAgent | null>((resolve) => { release = resolve })
      }
      return authenticateCredential(credential)
    }
    const closing = await openSocket(peer('agent-a').token)
    send(closing, { kind: 'relay.login', protocolVersion: 2, declaration: peer('agent-a').declaration })
    await started
    closing.terminate()
    await waitForClose(closing)
    await settleServerClose()
    release?.(peer('agent-a').auth)
    await tick()

    const observer = await openSocket(peer('agent-b').token)
    await login(observer, peer('agent-b'))
    send(observer, { kind: 'relay.directory', requestId: 'no-ghost', subscribe: false })
    const directory = await nextJson(observer)
    if (directory.kind === 'relay.directory') expect(directory.peers.map((item) => item.declaration.identity.agentId)).toEqual(['agent-b'])
  })

  it('replaces a same-identity control connection without letting the old close remove the new peer', async () => {
    const first = await openSocket(peer('agent-a').token)
    await expect(login(first, peer('agent-a'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 1 })
    const second = await openSocket(peer('agent-a').token)
    await expect(login(second, peer('agent-a'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 2 })
    await waitForClose(first)

    send(second, { kind: 'relay.directory', requestId: 'directory-2', subscribe: true })
    const directory = await nextJson(second)
    expect(directory).toMatchObject({ kind: 'relay.directory', requestId: 'directory-2' })
    if (directory.kind === 'relay.directory') {
      expect(directory.peers).toHaveLength(1)
      expect(directory.peers[0]).toMatchObject({ generation: 2, presence: 'online' })
    }
  })

  it('keeps identity keys distinct when account and scope contain delimiters', async () => {
    const firstPeer: TestPeer = {
      token: 'Bearer collision-first',
      auth: { accountId: 'a', scopeId: 'b\u0000c', agentId: 'same-agent' },
      declaration: declaration('same-agent', 'b\u0000c', 1, 'a'),
    }
    const secondPeer: TestPeer = {
      token: 'Bearer collision-second',
      auth: { accountId: 'a\u0000b', scopeId: 'c', agentId: 'same-agent' },
      declaration: declaration('same-agent', 'c', 1, 'a\u0000b'),
    }
    authenticateOverride = (credential) => [firstPeer, secondPeer].find((candidate) => candidate.token === credential)?.auth ?? null

    const first = await openSocket(firstPeer.token)
    await expect(login(first, firstPeer)).resolves.toMatchObject({ kind: 'relay.admitted', generation: 1 })
    const second = await openSocket(secondPeer.token)
    await expect(login(second, secondPeer)).resolves.toMatchObject({ kind: 'relay.admitted', generation: 1 })
    await tick()
    expect(first.readyState).toBe(WebSocket.OPEN)

    send(first, { kind: 'relay.directory', requestId: 'collision-first', subscribe: false })
    send(second, { kind: 'relay.directory', requestId: 'collision-second', subscribe: false })
    const [firstDirectory, secondDirectory] = await Promise.all([nextJson(first), nextJson(second)])
    expect(firstDirectory).toMatchObject({ kind: 'relay.directory', requestId: 'collision-first' })
    expect(secondDirectory).toMatchObject({ kind: 'relay.directory', requestId: 'collision-second' })
    if (firstDirectory.kind === 'relay.directory') expect(firstDirectory.peers).toHaveLength(1)
    if (secondDirectory.kind === 'relay.directory') expect(secondDirectory.peers).toHaveLength(1)
  })

  it('bounds messages queued while authentication is pending', async () => {
    let release: ((value: AuthenticatedAgent | null) => void) | undefined
    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((resolve) => { startedResolve = resolve })
    authenticateOverride = (credential) => {
      if (credential === peer('agent-a').token) {
        startedResolve?.()
        return new Promise<AuthenticatedAgent | null>((resolve) => { release = resolve })
      }
      return authenticateCredential(credential)
    }

    const socket = await openSocket(peer('agent-a').token)
    send(socket, { kind: 'relay.login', protocolVersion: 2, declaration: peer('agent-a').declaration })
    await started
    for (let index = 0; index < 8; index += 1) {
      send(socket, { kind: 'relay.directory', requestId: `pending-${index}`, subscribe: false })
    }
    await expect(nextJson(socket)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'RESOURCE_EXHAUSTED' } })
    await waitForClose(socket)
    release?.(peer('agent-a').auth)
    await tick()
  })

  it('rejects one inbound frame over the pending byte ceiling', async () => {
    const socket = await openSocket(peer('agent-a').token)
    socket.send(Buffer.alloc(16 * 1024 + 1, 7))
    await expect(nextJson(socket)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'RESOURCE_EXHAUSTED' } })
    await waitForClose(socket)
  })

  it('isolates directory snapshots and broadcasts by authenticated scope', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    const c = await openSocket(peer('agent-c').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))
    await login(c, peer('agent-c'))

    send(a, { kind: 'relay.directory', requestId: 'a-directory', subscribe: true })
    send(b, { kind: 'relay.directory', requestId: 'b-directory', subscribe: true })
    send(c, { kind: 'relay.directory', requestId: 'c-directory', subscribe: true })
    const [aDirectory, bDirectory, cDirectory] = await Promise.all([nextJson(a), nextJson(b), nextJson(c)])
    expect(aDirectory).toMatchObject({ kind: 'relay.directory', requestId: 'a-directory' })
    expect(bDirectory).toMatchObject({ kind: 'relay.directory', requestId: 'b-directory' })
    expect(cDirectory).toMatchObject({ kind: 'relay.directory', requestId: 'c-directory' })
    if (aDirectory.kind === 'relay.directory') expect(aDirectory.peers.map((item) => item.declaration.scopeId)).toEqual(['scope-a', 'scope-a'])
    if (cDirectory.kind === 'relay.directory') expect(cDirectory.peers.map((item) => item.declaration.scopeId)).toEqual(['scope-b'])

    send(b, {
      kind: 'relay.publish',
      generation: 1,
      declaration: {
        ...declaration('agent-b', 'scope-a', 2),
        capabilities: [{
          capabilityId: 'published-capability',
          version: 'v2',
          operations: [{ operation: 'invoke', inputSchema: {}, outputSchema: {}, cancellation: 'unsupported' }],
          resources: [{ resourceId: 'published-slot', capacity: 1, unit: 'slot', sharing: 'exclusive', allocationScope: 'work' }],
        }],
      },
    })
    await expect(nextJson(a)).resolves.toMatchObject({
      kind: 'relay.changed',
      peer: {
        declaration: { revision: 2 },
        endpoints: [{
          revision: 2,
          capabilities: [{ capabilityId: 'published-capability' }],
          resources: [{ resourceId: 'published-slot' }],
        }],
      },
    })
    await expectNoMessage(c)
  })

  it('scopes the directory to the authenticated identity and refuses a cross-scope query', async () => {
    const a = await openSocket(peer('agent-a').token)
    const c = await openSocket(peer('agent-c').token)
    await login(a, peer('agent-a'))
    await login(c, peer('agent-c'))
    // The directory is scoped by the authenticated identity; naming another
    // scope is not an accepted request field, so it is refused, not filtered.
    a.send(JSON.stringify({ kind: 'relay.directory', requestId: 'cross-scope-directory', subscribe: false, scopeId: 'scope-b' }))
    // The refused frame never echoes a requestId, so assert on the code and on
    // the absence of any directory answer for the foreign scope.
    const refused = await nextJson(a)
    expect(refused).toMatchObject({ kind: 'relay.error', error: { code: 'INVALID_INPUT' } })
    expect(refused).not.toHaveProperty('peers')
    send(a, { kind: 'relay.directory', requestId: 'own-scope-directory', subscribe: false })
    const own = await nextJson(a)
    if (own.kind !== 'relay.directory') throw new Error('own-scope directory snapshot was not returned')
    expect(own.peers.map((item) => item.declaration.identity.agentId)).toEqual(['agent-a'])
    // agent-c is online in scope-b, so the isolation is a real scope boundary
    // and not an empty directory.
    send(c, { kind: 'relay.directory', requestId: 'scope-b-directory', subscribe: false })
    const other = await nextJson(c)
    if (other.kind !== 'relay.directory') throw new Error('scope-b directory snapshot was not returned')
    expect(other.peers.map((item) => item.declaration.identity.agentId)).toEqual(['agent-c'])
  })

  it('rejects cross-scope and stale-generation relay grants, including expired grants', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    const c = await openSocket(peer('agent-c').token)
    const aAdmission = await login(a, peer('agent-a'))
    const bAdmission = await login(b, peer('agent-b'))
    const cAdmission = await login(c, peer('agent-c'))
    expect(aAdmission).toMatchObject({ kind: 'relay.admitted', generation: 1 })
    expect(bAdmission).toMatchObject({ kind: 'relay.admitted', generation: 1 })
    expect(cAdmission).toMatchObject({ kind: 'relay.admitted', generation: 1 })

    send(a, { kind: 'relay.connect', requestId: 'cross-scope', generation: 1, targetAgentId: 'agent-c', targetGeneration: 1 })
    await expect(nextJson(a)).resolves.toMatchObject({ kind: 'relay.error', requestId: 'cross-scope', error: { code: 'FORBIDDEN' } })

    for (const [requestId, targetAgentId] of [
      ['url-target', 'https://agent-b.example'],
      ['wss-target', 'wss://agent-b.example'],
    ] as const) {
      send(a, { kind: 'relay.connect', requestId, generation: 1, targetAgentId, targetGeneration: 1 })
      await expect(nextJson(a)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'INVALID_INPUT' } })
    }

    send(a, { kind: 'relay.connect', requestId: 'grant-1', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    const grantMessage = await nextJson(a)
    await expect(nextJson(b)).resolves.toMatchObject({ kind: 'relay.offer' })
    expect(grantMessage.kind).toBe('relay.grant')
    if (grantMessage.kind !== 'relay.grant') return

    const crossScopeData = await openSocket(peer('agent-c').token)
    send(crossScopeData, { kind: 'relay.open', requestId: 'open-cross-scope', grantId: grantMessage.grant.grantId, generation: 1 })
    await expect(nextJson(crossScopeData)).resolves.toMatchObject({
      kind: 'relay.error',
      requestId: 'open-cross-scope',
      error: { code: 'FORBIDDEN' },
    })
    await waitForClose(crossScopeData)

    const staleData = await openSocket(peer('agent-a').token)
    send(staleData, { kind: 'relay.open', requestId: 'open-stale-generation', grantId: grantMessage.grant.grantId, generation: 2 })
    await expect(nextJson(staleData)).resolves.toMatchObject({
      kind: 'relay.error',
      requestId: 'open-stale-generation',
      error: { code: 'STALE_GENERATION' },
    })
    await waitForClose(staleData)

    clockMs += 60_001
    const data = await openSocket(peer('agent-a').token)
    send(data, { kind: 'relay.open', requestId: 'open-expired', grantId: grantMessage.grant.grantId, generation: 1 })
    await expect(nextJson(data)).resolves.toMatchObject({ kind: 'relay.error', requestId: 'open-expired', error: { code: 'UNAVAILABLE' } })
  })

  it('bounds active grants and purges expired grants before admitting a new one', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))

    send(a, { kind: 'relay.connect', requestId: 'grant-capacity-1', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    await expect(nextJson(a)).resolves.toMatchObject({ kind: 'relay.grant', requestId: 'grant-capacity-1' })
    await expect(nextJson(b)).resolves.toMatchObject({ kind: 'relay.offer' })

    send(a, { kind: 'relay.connect', requestId: 'grant-capacity-2', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    await expect(nextJson(a)).resolves.toMatchObject({ kind: 'relay.error', requestId: 'grant-capacity-2', error: { code: 'RESOURCE_EXHAUSTED' } })

    clockMs += 60_001
    const expiredSource = nextMatching(a, (message) => message.kind === 'relay.closed')
    const expiredTarget = nextMatching(b, (message) => message.kind === 'relay.closed')
    const nextGrant = nextMatching(a, (message) => message.kind === 'relay.grant')
    const nextOffer = nextMatching(b, (message) => message.kind === 'relay.offer')
    send(a, { kind: 'relay.connect', requestId: 'grant-capacity-3', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    await expect(expiredSource).resolves.toMatchObject({ kind: 'relay.closed', error: { code: 'UNAVAILABLE' } })
    await expect(expiredTarget).resolves.toMatchObject({ kind: 'relay.closed', error: { code: 'UNAVAILABLE' } })
    await expect(nextGrant).resolves.toMatchObject({ kind: 'relay.grant', requestId: 'grant-capacity-3' })
    await expect(nextOffer).resolves.toMatchObject({ kind: 'relay.offer' })
  })

  it('rejects and reclaims a half-open grant at the admission deadline', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))

    send(a, { kind: 'relay.connect', requestId: 'half-open-grant', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    const grantMessage = await nextJson(a)
    await nextJson(b)
    if (grantMessage.kind !== 'relay.grant') throw new Error('grant was not issued')

    const dataA = await openSocket(peer('agent-a').token)
    send(dataA, { kind: 'relay.open', requestId: 'half-open-source', grantId: grantMessage.grant.grantId, generation: 1 })
    await expectNoMessage(dataA)

    const duplicate = await openSocket(peer('agent-a').token)
    send(duplicate, { kind: 'relay.open', requestId: 'half-open-duplicate', grantId: grantMessage.grant.grantId, generation: 1 })
    await expect(nextJson(duplicate)).resolves.toMatchObject({
      kind: 'relay.error',
      requestId: 'half-open-duplicate',
      error: { code: 'CONFLICT' },
    })
    await waitForClose(duplicate)

    const sourceDataClosed = waitForClose(dataA)
    clockMs += 60_001
    const dataB = await openSocket(peer('agent-b').token)
    send(dataB, { kind: 'relay.open', requestId: 'half-open-target', grantId: grantMessage.grant.grantId, generation: 1 })
    await expect(nextJson(dataB)).resolves.toMatchObject({
      kind: 'relay.error',
      requestId: 'half-open-target',
      error: { code: 'UNAVAILABLE' },
    })
    await sourceDataClosed

    const nextGrant = nextMatching(a, (message) => message.kind === 'relay.grant')
    const nextOffer = nextMatching(b, (message) => message.kind === 'relay.offer')
    send(a, { kind: 'relay.connect', requestId: 'half-open-reclaimed', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    await expect(nextGrant).resolves.toMatchObject({ kind: 'relay.grant', requestId: 'half-open-reclaimed' })
    await expect(nextOffer).resolves.toMatchObject({ kind: 'relay.offer' })
  })

  it('revokes a grant when either control identity reconnects', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))
    send(a, { kind: 'relay.connect', requestId: 'grant-reconnect', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    const grantMessage = await nextJson(a)
    await nextJson(b)
    if (grantMessage.kind !== 'relay.grant') throw new Error('grant was not issued')

    const dataA = await openSocket(peer('agent-a').token)
    const dataB = await openSocket(peer('agent-b').token)
    send(dataA, { kind: 'relay.open', requestId: 'open-reconnect-a', grantId: grantMessage.grant.grantId, generation: 1 })
    send(dataB, { kind: 'relay.open', requestId: 'open-reconnect-b', grantId: grantMessage.grant.grantId, generation: 1 })
    await Promise.all([nextJson(dataA), nextJson(dataB)])

    const sourceClosed = nextJson(a)
    const sourceDataClosed = waitForClose(dataA)
    const targetDataClosed = waitForClose(dataB)
    const replacement = await openSocket(peer('agent-b').token)
    await expect(login(replacement, peer('agent-b'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 2 })
    await waitForClose(b)
    await expect(sourceClosed).resolves.toMatchObject({ kind: 'relay.closed', grantId: grantMessage.grant.grantId, error: { code: 'UNAVAILABLE' } })
    await Promise.all([sourceDataClosed, targetDataClosed])

    const nextGrant = nextMatching(a, (message) => message.kind === 'relay.grant')
    const nextOffer = nextMatching(replacement, (message) => message.kind === 'relay.offer')
    send(a, { kind: 'relay.connect', requestId: 'grant-reconnect-reclaimed', generation: 1, targetAgentId: 'agent-b', targetGeneration: 2 })
    await expect(nextGrant).resolves.toMatchObject({ kind: 'relay.grant', requestId: 'grant-reconnect-reclaimed' })
    await expect(nextOffer).resolves.toMatchObject({ kind: 'relay.offer' })
  })

  it('does not attach a data socket when authentication resolves after close', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))
    send(a, { kind: 'relay.connect', requestId: 'grant-data-auth', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    const grantMessage = await nextJson(a)
    await nextJson(b)
    if (grantMessage.kind !== 'relay.grant') throw new Error('grant was not issued')

    let release: ((value: AuthenticatedAgent | null) => void) | undefined
    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((resolve) => { startedResolve = resolve })
    let waiting = true
    authenticateOverride = (credential) => {
      if (waiting && credential === peer('agent-a').token) {
        waiting = false
        startedResolve?.()
        return new Promise<AuthenticatedAgent | null>((resolve) => { release = resolve })
      }
      return authenticateCredential(credential)
    }
    const staleData = await openSocket(peer('agent-a').token)
    send(staleData, { kind: 'relay.open', requestId: 'open-stale-data', grantId: grantMessage.grant.grantId, generation: 1 })
    await started
    staleData.terminate()
    await waitForClose(staleData)
    await settleServerClose()
    release?.(peer('agent-a').auth)
    await tick()

    const dataB = await openSocket(peer('agent-b').token)
    send(dataB, { kind: 'relay.open', requestId: 'open-target-first', grantId: grantMessage.grant.grantId, generation: 1 })
    await expectNoMessage(dataB)

    const replacementData = await openSocket(peer('agent-a').token)
    send(replacementData, { kind: 'relay.open', requestId: 'open-source-retry', grantId: grantMessage.grant.grantId, generation: 1 })
    await Promise.all([nextJson(replacementData), nextJson(dataB)])
  })

  it('forwards opaque bytes in both directions and closes the paired data socket', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))
    send(a, { kind: 'relay.connect', requestId: 'grant-2', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    const grantMessage = await nextJson(a)
    await nextJson(b)
    if (grantMessage.kind !== 'relay.grant') throw new Error('grant was not issued')

    const dataA = await openSocket(peer('agent-a').token)
    const dataB = await openSocket(peer('agent-b').token)
    send(dataA, { kind: 'relay.open', requestId: 'open-a', grantId: grantMessage.grant.grantId, generation: 1 })
    send(dataB, { kind: 'relay.open', requestId: 'open-b', grantId: grantMessage.grant.grantId, generation: 1 })
    await Promise.all([nextJson(dataA), nextJson(dataB)])

    const outbound = Buffer.from('{"kind":"session.message","metadata":{"token":"opaque"}}')
    dataA.send(outbound)
    await expect(nextBinary(dataB)).resolves.toEqual(outbound)
    const reverse = Buffer.from([0, 1, 2, 255])
    dataB.send(reverse)
    await expect(nextBinary(dataA)).resolves.toEqual(reverse)

    dataA.close()
    await waitForClose(dataB)
  })

  it('closes an overloaded control subscriber and releases its grant without data JSON', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))

    send(a, { kind: 'relay.directory', requestId: 'subscribe-large', subscribe: true })
    await expect(nextJson(a)).resolves.toMatchObject({ kind: 'relay.directory', requestId: 'subscribe-large' })
    send(b, { kind: 'relay.connect', requestId: 'grant-large', generation: 1, targetAgentId: 'agent-a', targetGeneration: 1 })
    const grantMessage = await nextJson(b)
    await expect(nextJson(a)).resolves.toMatchObject({ kind: 'relay.offer' })
    if (grantMessage.kind !== 'relay.grant') throw new Error('grant was not issued')

    const dataA = await openSocket(peer('agent-a').token)
    const dataB = await openSocket(peer('agent-b').token)
    send(dataA, { kind: 'relay.open', requestId: 'open-large-a', grantId: grantMessage.grant.grantId, generation: 1 })
    send(dataB, { kind: 'relay.open', requestId: 'open-large-b', grantId: grantMessage.grant.grantId, generation: 1 })
    await Promise.all([nextJson(dataA), nextJson(dataB)])

    const dataANoMessage = expectNoMessage(dataA)
    const dataBNoMessage = expectNoMessage(dataB)
    const dataAClosed = waitForCloseWithin(dataA)
    const dataBClosed = waitForCloseWithin(dataB)
    const controlClosed = waitForCloseWithin(a)
    const grantClosed = nextJson(b)
    const largeDeclaration: AgentDeclaration = {
      ...declaration('agent-b', 'scope-a', 2),
      identity: { ...declaration('agent-b', 'scope-a', 2).identity, label: '界'.repeat(1500) },
    }
    send(b, { kind: 'relay.publish', generation: 1, declaration: largeDeclaration })

    await controlClosed
    await expect(grantClosed).resolves.toMatchObject({ kind: 'relay.closed', grantId: grantMessage.grant.grantId, error: { code: 'UNAVAILABLE' } })
    await Promise.all([dataAClosed, dataBClosed, dataANoMessage, dataBNoMessage])
  })

  it('keeps an opened pair after the admission deadline despite duplicate and invalid participant opens', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))
    send(a, { kind: 'relay.connect', requestId: 'grant-expiring', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    const grantMessage = await nextJson(a)
    await nextJson(b)
    if (grantMessage.kind !== 'relay.grant') throw new Error('grant was not issued')

    const dataA = await openSocket(peer('agent-a').token)
    const dataB = await openSocket(peer('agent-b').token)
    send(dataA, { kind: 'relay.open', requestId: 'open-expiring-a', grantId: grantMessage.grant.grantId, generation: 1 })
    send(dataB, { kind: 'relay.open', requestId: 'open-expiring-b', grantId: grantMessage.grant.grantId, generation: 1 })
    await Promise.all([nextJson(dataA), nextJson(dataB)])

    clockMs += 60_001

    const duplicate = await openSocket(peer('agent-a').token)
    send(duplicate, { kind: 'relay.open', requestId: 'duplicate-after-deadline', grantId: grantMessage.grant.grantId, generation: 1 })
    const duplicateResponse = await nextJson(duplicate)
    expect(dataA.readyState).toBe(WebSocket.OPEN)
    expect(dataB.readyState).toBe(WebSocket.OPEN)
    expect(duplicateResponse).toMatchObject({
      kind: 'relay.error',
      requestId: 'duplicate-after-deadline',
      error: { code: 'CONFLICT' },
    })
    await waitForClose(duplicate)

    const invalidParticipant = await openSocket(peer('agent-c').token)
    send(invalidParticipant, { kind: 'relay.open', requestId: 'invalid-participant-after-deadline', grantId: grantMessage.grant.grantId, generation: 1 })
    const invalidParticipantResponse = await nextJson(invalidParticipant)
    expect(dataA.readyState).toBe(WebSocket.OPEN)
    expect(dataB.readyState).toBe(WebSocket.OPEN)
    expect(invalidParticipantResponse).toMatchObject({
      kind: 'relay.error',
      requestId: 'invalid-participant-after-deadline',
      error: { code: 'FORBIDDEN' },
    })
    await waitForClose(invalidParticipant)

    const sourceToTarget = Buffer.from('{"kind":"session.message","body":"after-deadline"}')
    dataA.send(sourceToTarget)
    await expect(nextBinary(dataB)).resolves.toEqual(sourceToTarget)
    const targetToSource = Buffer.from([0, 255, 1, 254])
    dataB.send(targetToSource)
    await expect(nextBinary(dataA)).resolves.toEqual(targetToSource)

    expect(dataA.readyState).toBe(WebSocket.OPEN)
    expect(dataB.readyState).toBe(WebSocket.OPEN)
    expect(a.readyState).toBe(WebSocket.OPEN)
    expect(b.readyState).toBe(WebSocket.OPEN)

    send(a, { kind: 'relay.connect', requestId: 'opened-capacity', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    await expect(nextJson(a)).resolves.toMatchObject({
      kind: 'relay.error',
      requestId: 'opened-capacity',
      error: { code: 'RESOURCE_EXHAUSTED' },
    })

    const targetDataClosed = waitForClose(dataB)
    dataA.close()
    await targetDataClosed
    const nextGrant = nextMatching(a, (message) => message.kind === 'relay.grant')
    const nextOffer = nextMatching(b, (message) => message.kind === 'relay.offer')
    send(a, { kind: 'relay.connect', requestId: 'opened-capacity-reclaimed', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    await expect(nextGrant).resolves.toMatchObject({ kind: 'relay.grant', requestId: 'opened-capacity-reclaimed' })
    await expect(nextOffer).resolves.toMatchObject({ kind: 'relay.offer' })
  })

  it('fails on a full relay send buffer without injecting control JSON into data', async () => {
    const a = await openSocket(peer('agent-a').token)
    const b = await openSocket(peer('agent-b').token)
    await login(a, peer('agent-a'))
    await login(b, peer('agent-b'))
    send(a, { kind: 'relay.connect', requestId: 'grant-buffer', generation: 1, targetAgentId: 'agent-b', targetGeneration: 1 })
    const grantMessage = await nextJson(a)
    await nextJson(b)
    if (grantMessage.kind !== 'relay.grant') throw new Error('grant was not issued')

    const dataA = await openSocket(peer('agent-a').token)
    const dataB = await openSocket(peer('agent-b').token)
    send(dataA, { kind: 'relay.open', requestId: 'open-buffer-a', grantId: grantMessage.grant.grantId, generation: 1 })
    send(dataB, { kind: 'relay.open', requestId: 'open-buffer-b', grantId: grantMessage.grant.grantId, generation: 1 })
    await Promise.all([nextJson(dataA), nextJson(dataB)])

    const sourceClosed = nextJson(a)
    const targetClosed = nextJson(b)
    const targetDataClosed = waitForClose(dataB)
    const targetDataNoMessage = expectNoMessage(dataB)
    dataA.send(Buffer.alloc(4 * 1024 + 1, 7))
    await expect(sourceClosed).resolves.toMatchObject({ kind: 'relay.closed', grantId: grantMessage.grant.grantId, error: { code: 'RESOURCE_EXHAUSTED' } })
    await expect(targetClosed).resolves.toMatchObject({ kind: 'relay.closed', grantId: grantMessage.grant.grantId, error: { code: 'RESOURCE_EXHAUSTED' } })
    await targetDataClosed
    await targetDataNoMessage
  })

  it('uses a byte-safe close reason for long multibyte input errors', async () => {
    const socket = await openSocket(peer('agent-a').token)
    const longField = '界'.repeat(100)
    socket.send(JSON.stringify({ kind: 'relay.directory', requestId: 'utf8-error', subscribe: false, [longField]: true }))
    await expect(nextJson(socket)).resolves.toMatchObject({ kind: 'relay.error', error: { code: 'INVALID_INPUT' } })
    await waitForCloseWithin(socket)

    const observer = await openSocket(peer('agent-b').token)
    await expect(login(observer, peer('agent-b'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 1 })
  })
})

describe('N1 relay peer lease', () => {
  // A lease shorter than the grant deadline keeps the two expiries independent.
  const leaseTtlMs = 10_000
  beforeEach(async () => {
    await relay.close()
    peerTtlMs = leaseTtlMs
    relay = await createRelayServer(relayOptions(peerTtlMs))
  })

  const directoryOf = async (socket: WebSocket, requestId: string): Promise<readonly RelayPeer[]> => {
    send(socket, { kind: 'relay.directory', requestId, subscribe: false })
    const message = await nextJson(socket)
    if (message.kind !== 'relay.directory') throw new Error(`expected a directory snapshot, received ${message.kind}`)
    return message.peers
  }
  const entryOf = (peers: readonly RelayPeer[], agentId: string): RelayPeer | undefined =>
    peers.find(candidate => candidate.declaration.identity.agentId === agentId)

  it('expires a silent peer lease, keeps its offline history, and refuses a connection to it', async () => {
    const silent = await openSocket(peer('agent-a').token)
    await login(silent, peer('agent-a'))
    const observer = await openSocket(peer('agent-b').token)
    await login(observer, peer('agent-b'))
    expect(entryOf(await directoryOf(observer, 'lease-online'), 'agent-a')).toMatchObject({ presence: 'online', generation: 1 })

    // A silently dead socket sends no close frame and no heartbeat. Only the
    // elapsed lease can distinguish it from a live peer.
    clockMs += leaseTtlMs + 1
    const expired = await directoryOf(observer, 'lease-expired')
    expect(entryOf(expired, 'agent-a')).toMatchObject({ presence: 'offline', generation: 1 })
    expect(entryOf(expired, 'agent-a')?.declaration.identity.hostId).toBe('host-agent-a')

    send(observer, { kind: 'relay.connect', requestId: 'lease-connect', generation: 1, targetAgentId: 'agent-a', targetGeneration: 1 })
    await expect(nextJson(observer)).resolves.toMatchObject({
      kind: 'relay.error',
      requestId: 'lease-connect',
      error: { code: 'UNAVAILABLE' },
    })
  })

  it('renews the lease on a heartbeat and keeps the peer online', async () => {
    const peerA = await openSocket(peer('agent-a').token)
    await login(peerA, peer('agent-a'))
    const observer = await openSocket(peer('agent-b').token)
    await login(observer, peer('agent-b'))

    clockMs += leaseTtlMs - 1_000
    send(peerA, { kind: 'relay.presence', generation: 1 })
    // A same-socket directory readback proves the heartbeat was processed
    // before the clock moves again; `relay.presence` itself has no reply.
    send(peerA, { kind: 'relay.directory', requestId: 'lease-heartbeat', subscribe: false })
    await nextJson(peerA)
    clockMs += leaseTtlMs - 1_000
    expect(entryOf(await directoryOf(observer, 'lease-renewed'), 'agent-a')).toMatchObject({ presence: 'online' })

    clockMs += 2_000
    expect(entryOf(await directoryOf(observer, 'lease-lapsed'), 'agent-a')).toMatchObject({ presence: 'offline' })
  })

  it('rejects an old-generation heartbeat with STALE_GENERATION without renewing the current lease', async () => {
    const stale = await openSocket(peer('agent-a').token)
    await login(stale, peer('agent-a'))
    const current = await openSocket(peer('agent-a').token)
    await expect(login(current, peer('agent-a'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 2 })
    await waitForClose(stale)
    const observer = await openSocket(peer('agent-b').token)
    await login(observer, peer('agent-b'))

    clockMs += leaseTtlMs - 1_000
    send(current, { kind: 'relay.presence', generation: 1 })
    await expect(nextJson(current)).resolves.toMatchObject({
      kind: 'relay.error',
      error: { code: 'STALE_GENERATION' },
    })

    // The rejected heartbeat must not have refreshed the lease.
    clockMs += 2_000
    expect(entryOf(await directoryOf(observer, 'stale-heartbeat'), 'agent-a')).toMatchObject({ presence: 'offline', generation: 2 })
  })

  it('replaces an expired same-identity lease with the new generation and keeps one history entry', async () => {
    const first = await openSocket(peer('agent-a').token)
    await expect(login(first, peer('agent-a'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 1 })
    const observer = await openSocket(peer('agent-b').token)
    await login(observer, peer('agent-b'))

    clockMs += leaseTtlMs + 1
    expect(entryOf(await directoryOf(observer, 'generation-expired'), 'agent-a')).toMatchObject({ presence: 'offline', generation: 1 })

    const second = await openSocket(peer('agent-a').token)
    await expect(login(second, peer('agent-a'))).resolves.toMatchObject({ kind: 'relay.admitted', generation: 2 })
    const replaced = await directoryOf(observer, 'generation-replaced')
    expect(replaced.filter(candidate => candidate.declaration.identity.agentId === 'agent-a')).toHaveLength(1)
    expect(entryOf(replaced, 'agent-a')).toMatchObject({ presence: 'online', generation: 2 })
  })

  it('publishes the lease expiry to subscribers without a directory read', async () => {
    useRealClock = true
    await relay.close()
    peerTtlMs = 150
    relay = await createRelayServer(relayOptions(peerTtlMs))

    const silent = await openSocket(peer('agent-a').token)
    await login(silent, peer('agent-a'))
    const observer = await openSocket(peer('agent-b').token)
    await login(observer, peer('agent-b'))
    send(observer, { kind: 'relay.directory', requestId: 'lease-subscribe', subscribe: true })
    await expect(nextJson(observer)).resolves.toMatchObject({ kind: 'relay.directory', requestId: 'lease-subscribe' })

    await expect(nextMatching(observer, message => message.kind === 'relay.changed' && message.peer.declaration.identity.agentId === 'agent-a'))
      .resolves.toMatchObject({ kind: 'relay.changed', peer: { presence: 'offline', generation: 1 } })
  }, 20_000)
})

describe('N1 relay shutdown determinism', () => {
  // A TLS connection can reach the HTTPS listener and never complete the
  // WebSocket upgrade. The listener holds that connection, but the relay's own
  // socket set only tracks completed upgrades, so its disconnect loop cannot end
  // it. Before the fix, `httpsServer.close()` waited forever for such a
  // connection to end on its own, the relay process never exited after SIGTERM,
  // and installed lifecycle teardown reported `local daemon exit remains
  // unconfirmed`.
  const stalledTls = async (send?: string): Promise<{ ended: Promise<unknown> }> => {
    const socket = tlsConnect({ host: '127.0.0.1', port: relay.port, rejectUnauthorized: false })
    const ended = once(socket, 'close')
    await once(socket, 'secureConnect')
    if (send !== undefined) socket.write(send)
    await new Promise(resolve => setTimeout(resolve, 200))
    return { ended }
  }

  // Complete the WebSocket upgrade by hand, then stay silent forever. A real
  // client answers a close frame; this one never does.
  const silentUpgrade = async (port: number): Promise<TLSSocket> => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    await once(socket, 'secureConnect')
    const key = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
    socket.write([
      'GET / HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'))
    await new Promise<void>((resolve) => {
      let buffered = ''
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('latin1')
        if (buffered.includes('\r\n\r\n')) {
          socket.off('data', onData)
          resolve()
        }
      }
      socket.on('data', onData)
    })
    return socket
  }

  it('closes while a TLS connection that never upgraded stays open without sending a request', async () => {
    const { ended } = await stalledTls()
    await relay.close()
    await ended
  }, 20_000)

  it('closes while a TLS connection that sent only part of an upgrade request stays open', async () => {
    const { ended } = await stalledTls('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
    await relay.close()
    await ended
  }, 20_000)

  it('closes while a capacity-rejected socket never answers the close frame', async () => {
    const limited = await createRelayServer({
      host: '127.0.0.1',
      port: 0,
      key: certificate.key,
      cert: certificate.cert,
      maxPayload: 1024 * 1024,
      maxConnections: 1,
      maxGrants: 1,
      maxBufferedAmount: 4 * 1024,
      maxPendingMessages: 8,
      maxPendingBytes: 16 * 1024,
      grantTtlMs: 60_000,
      authenticate: () => null,
    })
    await silentUpgrade(limited.port)
    const rejected = await silentUpgrade(limited.port)
    const ended = once(rejected, 'close')
    await new Promise(resolve => setTimeout(resolve, 200))
    await limited.close()
    await ended
  }, 20_000)
})
