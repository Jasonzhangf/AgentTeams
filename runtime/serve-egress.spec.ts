import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpFrame, HistoryRecord } from '../control-protocol/acp.ts'
import type { AcpDuplex, EngineHandle } from '../control-protocol/engine.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from '../config/acp-policy.ts'
import { createAcpHost, type AcpHost } from '../agent-host/acp-host.ts'
import type { PeerIntent } from '../config/daemon-intent.ts'
import { createDirectWssListener, type DirectWssListener } from '../network/direct-listener.ts'
import type { TeamsConnectionHistory, TeamsConnectionHistoryEntry } from '../network/teams-connection-history.ts'
import { createTeamsConnectionLedger, openTeamsIngress, type TeamsConnectionLedger } from '../network/teams-ingress.ts'
import { createServeEgressOwner, type ServeEgressOwner } from './serve-egress.ts'

/**
 * The serve-entry egress owner is proven against a REAL loopback direct-WSS
 * listener whose responder runs the REAL `openTeamsIngress`, the REAL
 * `createTeamsSession` on both ends and the REAL `createAcpHost` on both ends.
 * The dial goes over a real TLS socket with real HTTP admission, a real
 * `transport.hello` handshake and real Teams frames, so a defect a socket-pair
 * double would hide fails these cases.
 */

const ACCOUNT = 'local'
const SCOPE = 'local'
const DIALER: AuthenticatedAgent = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'dialer-a' }
const RESPONDER: AuthenticatedAgent = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'responder-b' }
const RESPONDER_HOST_ID = 'host-b'
const RESPONDER_GENERATION = 22
const RESPONDER_CAPS = 'caps-responder'
const DIALER_GENERATION = 11
const DIALER_CAPS = 'caps-dialer'
const DIALER_ENGINE = 'engine-dialer'
const RESPONDER_ENGINE = 'engine-responder'
const DIALER_CREDENTIAL = 'Bearer serve-egress-dialer-admission'
const WRONG_CREDENTIAL = 'Bearer serve-egress-wrong-admission'

const initializeResult: AcpFrame = {
  jsonrpc: '2.0',
  id: 'runtime-initialize',
  result: {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true, audio: false } },
    authMethods: [],
  },
}

function makePolicy(engineInstanceId: string): ReturnType<typeof resolveAcpPolicy> {
  const supported = extractAcpCapabilities(initializeResult, ['session/new', 'callback:session/request_permission'])
  return resolveAcpPolicy({
    intent: { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
    engineInstanceId,
    supported,
    enforceablePolicies: supported,
  })
}

/** An engine duplex whose frames this daemon reads on demand. */
class EngineDuplex implements AcpDuplex {
  readonly sent: AcpFrame[] = []
  readonly closed: Promise<{ readonly kind: 'eof' }>
  private readonly queue: AcpFrame[] = []
  private readonly waiters: Array<(frame: AcpFrame) => void> = []
  private readonly resolveClosed: (value: { readonly kind: 'eof' }) => void

  constructor() {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  read(): Promise<AcpFrame> {
    const next = this.queue.shift()
    if (next !== undefined) return Promise.resolve(next)
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  async send(frame: AcpFrame): Promise<void> {
    this.sent.push(frame)
  }

  async close(): Promise<void> {
    this.resolveClosed({ kind: 'eof' })
  }

  push(frame: AcpFrame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter(frame)
      return
    }
    this.queue.push(frame)
  }
}

class MemoryAcpHistory implements AcpHistoryPort {
  counter = 0

  async append(entry: Omit<HistoryRecord, 'recordId' | 'sequence'>): Promise<HistoryRecord> {
    this.counter += 1
    return { ...entry, recordId: `r-${this.counter}`, sequence: this.counter }
  }
}

class RecordingHistory implements TeamsConnectionHistory {
  readonly entries: TeamsConnectionHistoryEntry[] = []

  async record(entry: TeamsConnectionHistoryEntry): Promise<HistoryRecord> {
    this.entries.push(entry)
    return { recordId: `c-${this.entries.length}`, sequence: this.entries.length, occurredAt: entry.occurredAt, agentId: entry.agentId, kind: 'connection', event: entry.event }
  }

  async query(): Promise<never> {
    throw new Error('serve-egress.spec: this case never reads the connection history back')
  }
}

interface RecordingHost extends AcpHost {
  readonly opens: unknown[]
  readonly closes: unknown[]
}

function makeHost(policy: ReturnType<typeof resolveAcpPolicy>, generation: number, duplex: EngineDuplex): RecordingHost {
  const engine: EngineHandle = {
    engineInstanceId: policy.engineInstanceId,
    pid: 4242,
    targetGeneration: generation,
    acp: duplex,
    exited: new Promise(() => undefined),
  }
  const inner = createAcpHost({
    handle: engine,
    initializeResult,
    policy,
    history: new MemoryAcpHistory(),
    assertAllowed: assertAcpAllowed,
  })
  const opens: unknown[] = []
  const closes: unknown[] = []
  return {
    opens,
    closes,
    open: async input => { opens.push(input.ref); await inner.open(input) },
    receive: ingress => inner.receive(ingress),
    read: (ref, after, limit) => inner.read(ref, after, limit),
    close: async ref => { closes.push(ref); await inner.close(ref) },
  }
}

function generateTls(directory: string): { readonly key: string; readonly cert: string; readonly certPath: string } {
  const keyPath = join(directory, 'egress-key.pem')
  const certPath = join(directory, 'egress-cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=serve-egress-loopback', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), certPath }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error(`serve-egress.spec: timed out waiting for ${label}`)
}

interface Harness {
  readonly directory: string
  readonly listener: DirectWssListener
  readonly owner: ServeEgressOwner
  readonly dialerHost: RecordingHost
  readonly responderHost: RecordingHost
  readonly dialerLedger: TeamsConnectionLedger
  readonly responderLedger: TeamsConnectionLedger
  readonly dialerHistory: RecordingHistory
  readonly responderHistory: RecordingHistory
  readonly peers: Readonly<Record<string, PeerIntent>>
  close(): Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * One real TLS loopback listener whose responder is the production ingress, plus
 * one egress owner that dials it with the production route plan and dialer.
 */
async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'serve-egress-'))
  const tls = generateTls(directory)
  const dialerPolicy = makePolicy(DIALER_ENGINE)
  const responderPolicy = makePolicy(RESPONDER_ENGINE)
  const dialerEngine = new EngineDuplex()
  const responderEngine = new EngineDuplex()
  const dialerHost = makeHost(dialerPolicy, DIALER_GENERATION, dialerEngine)
  const responderHost = makeHost(responderPolicy, RESPONDER_GENERATION, responderEngine)
  const dialerLedger = createTeamsConnectionLedger()
  const responderLedger = createTeamsConnectionLedger()
  const dialerHistory = new RecordingHistory()
  const responderHistory = new RecordingHistory()

  const listener = await createDirectWssListener({
    host: '127.0.0.1',
    port: 0,
    key: tls.key,
    cert: tls.cert,
    admissions: [{ admissionRef: 'adm-dialer', peer: DIALER, credential: DIALER_CREDENTIAL }],
    target: {
      hostId: RESPONDER_HOST_ID,
      agentId: RESPONDER.agentId,
      targetGeneration: RESPONDER_GENERATION,
      protocolVersion: 1,
      capabilitiesRevision: RESPONDER_CAPS,
    },
    maxPayload: 262_144,
    maxConnections: 8,
    maxMessageBytes: 262_144,
    maxBufferedBytes: 262_144,
    maxPendingFrames: 64,
    helloTimeoutMs: 5_000,
    onConnection: async connection => {
      await openTeamsIngress({
        connection: { connectionId: connection.connectionId, peer: connection.peer, connection: connection.connection },
        self: RESPONDER,
        selfGeneration: RESPONDER_GENERATION,
        selfCapabilitiesRevision: RESPONDER_CAPS,
        selfPolicyRevision: 9,
        allowedRoles: ['master', 'peer'],
        admittedCapabilities: responderPolicy.effective,
        host: responderHost,
        policy: responderPolicy,
        engineInstanceId: RESPONDER_ENGINE,
        history: responderHistory,
        ledger: responderLedger,
        timeoutMs: 5_000,
        pollIntervalMs: 5,
      })
    },
  })

  const peers: Readonly<Record<string, PeerIntent>> = {
    responder: {
      agentId: RESPONDER.agentId,
      hostId: RESPONDER_HOST_ID,
      accountId: ACCOUNT,
      scopeId: SCOPE,
      endpoint: listener.url,
      admissionRef: 'adm-dialer',
      credentialRef: 'env:SERVE_EGRESS_DIALER_CREDENTIAL',
      tlsTrustRef: `file:${tls.certPath}`,
    },
    // A declared peer with no explicit endpoint is never dialed.
    'no-endpoint': {
      agentId: 'peer-c',
      hostId: 'host-c',
      accountId: ACCOUNT,
      scopeId: SCOPE,
      credentialRef: 'env:SERVE_EGRESS_DIALER_CREDENTIAL',
    },
    // A declared peer whose credential the real admission refuses.
    wrong: {
      agentId: 'peer-d',
      hostId: 'host-d',
      accountId: ACCOUNT,
      scopeId: SCOPE,
      endpoint: listener.url,
      admissionRef: 'adm-dialer',
      credentialRef: 'env:SERVE_EGRESS_WRONG_CREDENTIAL',
      tlsTrustRef: `file:${tls.certPath}`,
    },
  }

  const owner = createServeEgressOwner({
    peers,
    self: DIALER,
    selfGeneration: DIALER_GENERATION,
    selfCapabilitiesRevision: DIALER_CAPS,
    selfPolicyRevision: 7,
    allowedRoles: ['master', 'peer'],
    requestedCapabilities: dialerPolicy.effective,
    host: dialerHost,
    policy: dialerPolicy,
    engineInstanceId: DIALER_ENGINE,
    history: dialerHistory,
    ledger: dialerLedger,
    env: {
      ...process.env,
      SERVE_EGRESS_DIALER_CREDENTIAL: DIALER_CREDENTIAL,
      SERVE_EGRESS_WRONG_CREDENTIAL: WRONG_CREDENTIAL,
    },
    // The real responder's own published facts: the listener target generation
    // and the capability revision the directory declaration carries. The unit
    // harness supplies them from the responder it just started, exactly as the
    // serve entry reads them from the scoped directory.
    readTargetFacts: async () => ({
      directoryGeneration: 1,
      targetGeneration: RESPONDER_GENERATION,
      targetCapabilitiesRevision: RESPONDER_CAPS,
    }),
    connectTimeoutMs: 4_000,
    helloTimeoutMs: 4_000,
    negotiationTimeoutMs: 4_000,
    openTimeoutMs: 4_000,
  })

  const close = async (): Promise<void> => {
    await owner.close().catch(() => undefined)
    await listener.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
  cleanups.push(close)
  return {
    directory,
    listener,
    owner,
    dialerHost,
    responderHost,
    dialerLedger,
    responderLedger,
    dialerHistory,
    responderHistory,
    peers,
    close,
  }
}

describe('serve egress owner (the daemon dials its declared peers)', () => {
  it('dials a declared peer over a real TLS socket, negotiates as initiator and opens the one channel', async () => {
    const h = await harness()
    const row = await h.owner.connect('responder')

    expect(row.agentId).toBe(RESPONDER.agentId)
    expect(row.peer).toEqual(RESPONDER)
    expect(row.state).toBe('agreed')
    expect(row.connectionId.startsWith('serve-egress-')).toBe(true)

    // The responder's real ingress negotiated and opened its own host channel.
    await until(() => h.responderHost.opens.length === 1, 'the responder host channel')
    expect(h.responderHost.opens).toHaveLength(1)
    expect(h.dialerHost.opens).toHaveLength(1)

    // Both sides' live ledgers reach ready from the real negotiation.
    await until(() => h.dialerLedger.list()[0]?.state === 'ready', 'the initiator ledger ready')
    await until(() => h.responderLedger.list()[0]?.state === 'ready', 'the responder ledger ready')
    expect(h.dialerLedger.list()[0]).toMatchObject({ remoteAgentId: RESPONDER.agentId, state: 'ready' })
    expect(h.responderLedger.list()[0]).toMatchObject({ remoteAgentId: DIALER.agentId, state: 'ready' })

    // The one ACP channel is open on the initiator session.
    const live = h.owner.list()
    expect(live).toHaveLength(1)
    expect(live[0]).toEqual(row)
    expect(h.dialerHistory.entries.some(entry => entry.event === 'connection.negotiated')).toBe(true)
    expect(h.responderHistory.entries.some(entry => entry.event === 'connection.negotiated')).toBe(true)
  })

  it('disconnect closes the live channel and the transport, and removes the row', async () => {
    const h = await harness()
    await h.owner.connect('responder')
    await until(() => h.responderHost.opens.length === 1, 'the responder host channel')
    expect(h.owner.list()).toHaveLength(1)

    await h.owner.disconnect(RESPONDER.agentId)

    // The live row is gone and the responder host channel was released.
    expect(h.owner.list()).toEqual([])
    await until(() => h.responderHost.closes.length === 1, 'the responder host channel close')
    // The real transport is gone: the listener reports no live connection.
    await until(() => h.listener.connections.length === 0, 'the listener transport close')
    // The initiator ledger moved to a terminal state; no fabricated live row
    // survives. The delivered egress records the local teardown through its own
    // `done` handler, so the terminal state is `closed` or `failed`.
    await until(() => ['closed', 'failed'].includes(h.dialerLedger.list()[0]?.state ?? ''), 'the initiator ledger terminal')
    expect(['closed', 'failed']).toContain(h.dialerLedger.list()[0]?.state)

    // A second disconnect of the same peer is a typed refusal.
    await expect(h.owner.disconnect(RESPONDER.agentId)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a duplicate connect while the peer is live with CONFLICT', async () => {
    const h = await harness()
    await h.owner.connect('responder')
    await expect(h.owner.connect('responder')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.owner.list()).toHaveLength(1)
    // The refused duplicate is recorded; the live row is untouched.
    expect(h.owner.failures().some(failure => failure.code === 'CONFLICT' && failure.agentId === RESPONDER.agentId)).toBe(true)
  })

  it('refuses an unknown peer and a peer without an explicit endpoint with typed codes', async () => {
    const h = await harness()
    await expect(h.owner.connect('missing')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.owner.connect('no-endpoint')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
    expect(h.owner.list()).toEqual([])
    const codes = h.owner.failures().map(failure => failure.code).sort()
    expect(codes).toEqual(['FORBIDDEN', 'UNSUPPORTED_CONFIGURATION'])
    // No transport was opened for either refusal.
    expect(h.listener.connections).toEqual([])
  })

  it('records a typed failure for a refused dial and never fabricates a live row', async () => {
    const h = await harness()
    await expect(h.owner.connect('wrong')).rejects.toBeDefined()
    expect(h.owner.list()).toEqual([])
    const failure = h.owner.failures().find(candidate => candidate.peerName === 'wrong')
    expect(failure).toBeDefined()
    expect(failure?.agentId).toBe('peer-d')
    expect(failure?.message.length).toBeGreaterThan(0)
    // The refused dial never reached the responder's application layer.
    expect(h.responderHistory.entries).toEqual([])
    expect(h.responderLedger.list()).toEqual([])
  })
})
