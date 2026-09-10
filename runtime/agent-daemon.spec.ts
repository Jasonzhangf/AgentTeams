import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { buildDirectWssRoutePlan } from '../network/route-plan.ts'
import type { DirectPeerRouteInput } from '../network/peer-route.ts'
import type { DirectWssTarget, DirectWssTargetOptions } from '../network/direct-route.ts'
import type { TargetTransportState } from '../network/target-transport.ts'
import type { WssConnection } from '../network/wss-connection.ts'
import { startAgentDaemon } from './agent-daemon.ts'

let directory: string
let cert: Buffer
let key: Buffer
let relay: RelayServer | undefined

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-daemon-peer-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' })
  cert = readFileSync(join(directory, 'cert'))
  key = readFileSync(join(directory, 'key'))
})

afterAll(async () => {
  await relay?.close()
  rmSync(directory, { recursive: true, force: true })
})

function targetOptions(): DirectWssTargetOptions {
  return {
    transport: {
      endpoint: 'wss://peer.test', credential: 'opaque', connectTimeoutMs: 1000,
      maxMessageBytes: 4096, maxBufferedBytes: 4096, maxPendingFrames: 4,
    },
    hello: { hostId: 'peer-host', agentId: 'peer-agent', targetGeneration: 3, protocolVersion: 1, capabilitiesRevision: '7' },
    plan: buildDirectWssRoutePlan({ hostId: 'peer-host', directoryGeneration: 4, policy: 'manual', targetCandidateId: 'direct', candidates: [{
      candidateId: 'direct', kind: 'ipv4', endpoint: 'wss://peer.test', authRequired: true, lastSeenAt: new Date(0).toISOString(),
    }] }),
    helloTimeoutMs: 1000,
  }
}

function peerRouteInput(overrides: Partial<DirectPeerRouteInput> = {}): DirectPeerRouteInput {
  return {
    directory: {
      accountId: 'account', generation: 4, confirmedGeneration: 4,
      hosts: [{ hostId: 'peer-host', machineId: 'machine', agentId: 'peer-agent', agentKind: 'custom', accountId: 'account',
        capabilitiesRevision: '7', health: 'ready', updatedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(),
        routeCandidates: [{ candidateId: 'direct', kind: 'ipv4', endpoint: 'wss://peer.test', authRequired: true, lastSeenAt: new Date(0).toISOString() }] }],
    },
    hostId: 'peer-host', targetCandidateId: 'direct', targetGeneration: 3, protocolVersion: 1,
    binding: { connectionId: 'connection-1', connectionGeneration: 2 },
    transport: { credential: 'opaque', connectTimeoutMs: 1000, maxMessageBytes: 4096, maxBufferedBytes: 4096, maxPendingFrames: 4 },
    helloTimeoutMs: 1000,
    ...overrides,
  }
}

function fakeTarget(closeCalls: { value: number }, closeError?: Error, reconnect?: () => Promise<DirectWssTarget>): DirectWssTarget {
  let state: TargetTransportState = {
    state: 'ready', hostId: 'peer-host', agentId: 'peer-agent', targetGeneration: 3,
    protocolVersion: 1, capabilitiesRevision: '7',
  }
  const ownReconnect = (() => {
    let calling = false
    return async () => {
      if (calling) throw new Error('ONLY_ONE_RECONNECT')
      calling = true
      return reconnect ? reconnect() : fakeTarget(closeCalls)
    }
  })()
  const target: DirectWssTarget = {
    connection: {} as WssConnection,
    plan: targetOptions().plan,
    get state() { return state },
    closed: Promise.resolve(new Error('fake target closed')),
    assertGeneration: generation => {
      if (generation !== state.targetGeneration) throw new Error('STALE_GENERATION')
    },
    close: async () => {
      closeCalls.value += 1
      state = { ...state, state: 'closed' }
      if (closeError) throw closeError
    },
    reconnect: ownReconnect,
  }
  return target
}

async function daemon(connector: (options: DirectWssTargetOptions) => Promise<DirectWssTarget>) {
  await relay?.close()
  relay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key, maxPayload: 4096,
    maxConnections: 4, maxGrants: 4, maxBufferedAmount: 4096, maxPendingMessages: 4,
    maxPendingBytes: 8192, grantTtlMs: 5000,
    authenticate: credential => credential === 'Bearer daemon' ? { agentId: 'daemon', accountId: 'account', scopeId: 'scope' } : null })
  return startAgentDaemon({
    relay: {
      transport: { endpoint: relay.url, credential: 'Bearer daemon', ca: cert, connectTimeoutMs: 1000,
        maxMessageBytes: 4096, maxBufferedBytes: 4096, maxPendingFrames: 4 },
      admissionTimeoutMs: 1000, requestTimeoutMs: 1000, maxPendingRequests: 4, maxDataConnections: 4,
      declaration: { identity: { hostId: 'daemon-host', machineId: 'machine', agentId: 'daemon', accountId: 'account', agentKind: 'custom', label: 'Daemon' },
        scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
    },
    presenceIntervalMs: 1000,
    directPeerConnector: connector,
  })
}

describe('Agent daemon peer route lifecycle', () => {
  it('assembles a typed peer route before registering its direct target lifecycle', async () => {
    const closeCalls = { value: 0 }
    let received!: DirectWssTargetOptions
    const daemonInstance = await daemon(async options => { received = options; return fakeTarget(closeCalls) })
    const peer = await daemonInstance.connectPeerRoute(peerRouteInput())
    expect(received).toMatchObject({
      transport: { endpoint: 'wss://peer.test' },
      hello: { hostId: 'peer-host', agentId: 'peer-agent', targetGeneration: 3, capabilitiesRevision: '7' },
      peerRoute: { kind: 'direct-wss', connectionId: 'connection-1', connectionGeneration: 2, directoryGeneration: 4, targetGeneration: 3, candidateId: 'direct' },
    })
    expect(peer.state.state).toBe('ready')
    await daemonInstance.stop()
    expect(closeCalls.value).toBe(1)
  })

  it('rejects a stale typed directory before creating a target', async () => {
    let connectorCalls = 0
    const daemonInstance = await daemon(async () => { connectorCalls += 1; return fakeTarget({ value: 0 }) })
    await expect(daemonInstance.connectPeerRoute(peerRouteInput({ directory: { ...peerRouteInput().directory, confirmedGeneration: 3 } })))
      .rejects.toMatchObject({ code: 'STALE_GENERATION' })
    expect(connectorCalls).toBe(0)
    await daemonInstance.stop()
  })

  it('does not send a relay candidate through the direct lifecycle entry', async () => {
    let connectorCalls = 0
    const daemonInstance = await daemon(async () => { connectorCalls += 1; return fakeTarget({ value: 0 }) })
    const input = peerRouteInput({ targetCandidateId: 'relay', directory: {
      ...peerRouteInput().directory,
      hosts: [{ ...peerRouteInput().directory.hosts[0], routeCandidates: [{ candidateId: 'relay', kind: 'relay-ws', authRequired: true, lastSeenAt: new Date(0).toISOString() }] }],
    } })
    await expect(daemonInstance.connectPeerRoute(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(connectorCalls).toBe(0)
    await daemonInstance.stop()
  })

  it('connects a typed direct peer and closes it before daemon shutdown', async () => {
    const closeCalls = { value: 0 }
    let received!: DirectWssTargetOptions
    const daemonInstance = await daemon(async options => { received = options; return fakeTarget(closeCalls) })
    const peer = await daemonInstance.connectPeer(targetOptions())
    expect(received.hello).toEqual(targetOptions().hello)
    expect(peer.state.state).toBe('ready')
    await daemonInstance.stop()
    expect(closeCalls.value).toBe(1)
    expect(peer.state.state).toBe('closed')
    expect((await daemonInstance.closed).state).toBe('stopped')
  })

  it('tracks a reconnected target and rejects new peers after stop', async () => {
    const closeCalls = { value: 0 }
    const daemonInstance = await daemon(async () => fakeTarget(closeCalls))
    const first = await daemonInstance.connectPeer(targetOptions())
    await first.close()
    const second = await first.reconnect()
    expect(second.state.state).toBe('ready')
    await daemonInstance.stop()
    expect(closeCalls.value).toBe(2)
    await expect(daemonInstance.connectPeer(targetOptions())).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('deduplicates concurrent reconnect registration for one source target', async () => {
    const closeCalls = { value: 0 }
    let resolveSuccessor!: (target: DirectWssTarget) => void
    const successor = new Promise<DirectWssTarget>(resolve => { resolveSuccessor = resolve })
    const daemonInstance = await daemon(async () => fakeTarget(closeCalls, undefined, () => successor))
    const first = await daemonInstance.connectPeer(targetOptions())
    await first.close()

    const reconnects = Promise.all([first.reconnect(), first.reconnect()])
    resolveSuccessor(fakeTarget(closeCalls))
    const [left, right] = await reconnects

    expect(left).toBe(right)
    await daemonInstance.stop()
    expect(closeCalls.value).toBe(2)
  })

  it('closes direct peers when the relay control connection terminates', async () => {
    const closeCalls = { value: 0 }
    const daemonInstance = await daemon(async () => fakeTarget(closeCalls))
    await daemonInstance.connectPeer(targetOptions())
    await daemonInstance.network.close()
    await expect(daemonInstance.closed).resolves.toMatchObject({ state: 'failed' })
    expect(closeCalls.value).toBe(1)
  })

  it('preserves a direct peer cleanup failure when relay terminates', async () => {
    const closeCalls = { value: 0 }
    const daemonInstance = await daemon(async () => fakeTarget(closeCalls, new Error('PEER_CLOSE_FAILED')))
    await daemonInstance.connectPeer(targetOptions())
    await daemonInstance.network.close()
    await expect(daemonInstance.closed).resolves.toMatchObject({
      state: 'failed', error: expect.objectContaining({ message: expect.stringContaining('PEER_CLOSE_FAILED') }),
    })
    expect(closeCalls.value).toBe(1)
  })

  it('finishes shutdown when an in-flight peer rejects cleanup', async () => {
    const closeCalls = { value: 0 }
    let resolveTarget!: (target: DirectWssTarget) => void
    const pending = new Promise<DirectWssTarget>(resolve => { resolveTarget = resolve })
    const daemonInstance = await daemon(async () => pending)
    const connecting = daemonInstance.connectPeer(targetOptions())
    const stopping = daemonInstance.stop()
    resolveTarget(fakeTarget(closeCalls, new Error('PEER_CLOSE_FAILED')))
    await expect(connecting).rejects.toThrow('PEER_CLOSE_FAILED')
    await expect(stopping).resolves.toBeUndefined()
    await expect(daemonInstance.closed).resolves.toMatchObject({ state: 'failed', error: expect.objectContaining({ message: 'PEER_CLOSE_FAILED' }) })
    expect(closeCalls.value).toBe(1)
  })

  it('does not fail shutdown when a pending connector is cancelled', async () => {
    let rejectConnector!: (cause: Error) => void
    const pending = new Promise<DirectWssTarget>((_, reject) => { rejectConnector = reject })
    const daemonInstance = await daemon(async () => pending)
    const connecting = daemonInstance.connectPeer(targetOptions())
    const stopping = daemonInstance.stop()
    rejectConnector(new Error('CONNECTOR_CANCELLED'))
    await expect(connecting).rejects.toThrow('CONNECTOR_CANCELLED')
    await expect(stopping).resolves.toBeUndefined()
    await expect(daemonInstance.closed).resolves.toMatchObject({ state: 'stopped' })
  })
})
