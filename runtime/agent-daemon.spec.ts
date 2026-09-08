import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { buildDirectWssRoutePlan } from '../network/route-plan.ts'
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

function fakeTarget(closeCalls: { value: number }): DirectWssTarget {
  let state: TargetTransportState = {
    state: 'ready', hostId: 'peer-host', agentId: 'peer-agent', targetGeneration: 3,
    protocolVersion: 1, capabilitiesRevision: '7',
  }
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
    },
    reconnect: async () => fakeTarget(closeCalls),
  }
  return target
}

async function daemon(connector: (options: DirectWssTargetOptions) => Promise<DirectWssTarget>) {
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
  it('connects a typed direct peer and closes it before daemon shutdown', async () => {
    const closeCalls = { value: 0 }
    let received!: DirectWssTargetOptions
    const daemonInstance = await daemon(async options => { received = options; return fakeTarget(closeCalls) })
    const peer = await daemonInstance.connectPeer(targetOptions())
    expect(received.hello).toEqual(targetOptions().hello)
    expect(peer.state.state).toBe('ready')
    await daemonInstance.stop()
    expect(closeCalls.value).toBe(1)
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
})
