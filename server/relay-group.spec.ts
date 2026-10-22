import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { AuthenticatedAgent, AgentDeclaration, RelayServerControl } from '../control-protocol/agent-services.ts'
import type { GroupWireReply } from '../control-protocol/group-wire.ts'
import { createGroupHub } from './group-hub.ts'
import { createRelayServer, type RelayServer } from './relay.ts'

/**
 * Black-box proof that group frames ride the existing relay control connection:
 * a real TLS relay, real WebSocket clients, the real hub and the real wire
 * envelope. Nothing here calls the hub directly.
 */

let key: Buffer
let cert: Buffer
let directory: string
let relay: RelayServer | undefined
const sockets: WebSocket[] = []

function declaration(agentId: string): AgentDeclaration {
  return {
    identity: { hostId: `host-${agentId}`, machineId: `machine-${agentId}`, agentId, accountId: 'account-a', agentKind: 'custom', label: agentId },
    scopeId: 'scope-a',
    revision: 1,
    capabilities: [],
    routes: [],
  }
}

function open(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relay!.url, { rejectUnauthorized: false, headers: { authorization: token } })
    sockets.push(socket)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function nextFrame(socket: WebSocket, requestId: string): Promise<{ kind: string; requestId?: string; frame?: GroupWireReply }> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
      if (binary) return
      const message = JSON.parse(data.toString()) as RelayServerControl
      if (message.kind !== 'relay.group.reply' || message.requestId !== requestId) return
      socket.off('message', onMessage)
      resolve(message as never)
    }
    socket.on('message', onMessage)
    socket.on('error', reject)
  })
}

function nextPush(socket: WebSocket): Promise<GroupWireReply> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
      if (binary) return
      const message = JSON.parse(data.toString()) as RelayServerControl
      if (message.kind !== 'relay.group.push') return
      socket.off('message', onMessage)
      resolve(message.frame as GroupWireReply)
    }
    socket.on('message', onMessage)
    socket.on('error', reject)
  })
}

function admitted(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as RelayServerControl
      if (message.kind !== 'relay.admitted') return
      socket.off('message', onMessage)
      resolve()
    }
    socket.on('error', reject)
    socket.on('message', onMessage)
  })
}

async function login(socket: WebSocket, agentId: string): Promise<void> {
  const ready = admitted(socket)
  socket.send(JSON.stringify({ kind: 'relay.login', protocolVersion: 2, declaration: declaration(agentId) }))
  await ready
}

async function call(socket: WebSocket, requestId: string, frame: unknown): Promise<GroupWireReply> {
  const pending = nextFrame(socket, requestId)
  socket.send(JSON.stringify({ kind: 'relay.group', requestId, frame }))
  return (await pending).frame as GroupWireReply
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'agentteams-relay-group-'))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath, '-days', '1'], { stdio: 'ignore' })
  key = readFileSync(keyPath)
  cert = readFileSync(certPath)
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await relay?.close()
  relay = undefined
})

async function startRelay() {
  const hub = createGroupHub({
    isOnline: (id) => ['agent-a', 'agent-b'].includes(id),
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
  })
  const agents = new Map<string, AuthenticatedAgent>()
  for (const id of ['agent-a', 'agent-b']) agents.set(`Bearer ${id}`, { accountId: 'account-a', scopeId: 'scope-a', agentId: id })
  relay = await createRelayServer({
    host: '127.0.0.1', port: 0, key, cert,
    maxPayload: 1024 * 1024, maxConnections: 16, maxGrants: 2,
    maxBufferedAmount: 4 * 1024, maxPendingMessages: 8, maxPendingBytes: 16 * 1024,
    grantTtlMs: 60_000,
    authenticate: (credential) => (credential === undefined ? null : agents.get(credential) ?? null),
    groupHub: () => hub,
  })
}

describe('group frames over the real relay', () => {
  it('creates a group, invites a peer and delivers a message push', async () => {
    await startRelay()
    const a = await open('Bearer agent-a')
    const b = await open('Bearer agent-b')
    await login(a, 'agent-a')
    await login(b, 'agent-b')

    const created = await call(a, 'r1', { kind: 'group.create', requestId: 'r1', name: 'release' })
    expect(created.kind).toBe('group.created')
    const groupId = (created as { group: { groupId: string } }).group.groupId

    const invited = await call(a, 'r2', { kind: 'group.invite', requestId: 'r2', groupId, agentId: 'agent-b', role: 'peer' })
    expect(invited.kind).toBe('group.invited')

    const responded = await call(b, 'r3', { kind: 'group.respond', requestId: 'r3', groupId, accept: true })
    expect(responded.kind).toBe('group.member')

    const pushed = nextPush(b)
    const sent = await call(a, 'r4', {
      kind: 'message.send', requestId: 'r4', commitId: 'c1', groupId,
      targetAgentIds: ['agent-b'], replyRequired: true, body: 'please review',
    })
    expect(sent.kind).toBe('message.sent')
    const push = await pushed
    expect(push.kind).toBe('message.received')
  })

  it('answers an invalid group frame with a typed relay error', async () => {
    await startRelay()
    const a = await open('Bearer agent-a')
    await login(a, 'agent-a')
    const failed = new Promise<RelayServerControl>((resolve) => {
      a.on('message', (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as RelayServerControl
        if (message.kind === 'relay.error') resolve(message)
      })
    })
    a.send(JSON.stringify({ kind: 'relay.group', requestId: 'r9', frame: { kind: 'message.send', requestId: 'r9' } }))
    const reply = await failed
    expect(reply.kind === 'relay.error' && reply.requestId).toBe('r9')
    expect(reply.kind === 'relay.error' && reply.error.code).toBe('INVALID_INPUT')
  })
})
