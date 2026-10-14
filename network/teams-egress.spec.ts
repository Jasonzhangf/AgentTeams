import { describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpChannelRef, AcpFault, AcpFrame, AcpIngress, HistoryRecord } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { AcpDuplex, EngineHandle } from '../control-protocol/engine.ts'
import type { RelationRole } from '../control-protocol/teams-connection.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from '../config/acp-policy.ts'
import { createAcpHost, type AcpHost } from '../agent-host/acp-host.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'
import { openTeamsEgress } from './teams-egress.ts'
import { createTeamsConnectionLedger, openTeamsIngress, type TeamsConnectionLedger } from './teams-ingress.ts'
import type { TeamsConnectionHistory, TeamsConnectionHistoryEntry } from './teams-connection-history.ts'

/**
 * The initiator egress is proven against the REAL production responder
 * (`openTeamsIngress`), the REAL `createTeamsSession` on both ends and the REAL
 * `createAcpHost` on both ends. Nothing here mocks the handshake, the host ref
 * rule or the wire frames, so a defect a mock would hide fails these cases.
 */

const A: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-a' }
const B: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-b' }

const ENGINE_A = 'engine-a'
const ENGINE_B = 'engine-b'
const GENERATION_A = 11
const GENERATION_B = 22

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

  /** Deliver one engine frame to the daemon that reads this duplex. */
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

interface RecordingHost extends AcpHost {
  readonly opens: Array<{ readonly ref: AcpChannelRef; readonly principal: AuthenticatedAgent }>
  readonly ingresses: AcpIngress[]
  readonly closes: AcpChannelRef[]
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
  const opens: RecordingHost['opens'] = []
  const ingresses: AcpIngress[] = []
  const closes: AcpChannelRef[] = []
  return {
    opens,
    ingresses,
    closes,
    open: async input => { opens.push({ ref: input.ref, principal: input.principal }); await inner.open(input) },
    receive: async ingress => { ingresses.push(ingress); await inner.receive(ingress) },
    read: (ref, after, limit) => inner.read(ref, after, limit),
    close: async ref => { closes.push(ref); await inner.close(ref) },
  }
}

interface WireFrame {
  readonly bytes: Buffer
  readonly binary: boolean
}

/**
 * One end of a socket pair. `send` resolves the pending `read` on the other end,
 * or is queued until that side reads, so the real negotiation and the real ACP
 * handshake run over these bytes without a network.
 */
class SocketEnd {
  private readonly queue: WireFrame[] = []
  private readonly readers: Array<(frame: WireFrame) => void> = []
  private readonly onRead: Array<(frame: unknown) => void> = []
  readonly closed: Promise<void>
  readonly closeCalls: number[] = []
  private readonly resolveClosed: () => void
  private peer: SocketEnd | undefined

  constructor() {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  link(peer: SocketEnd): void {
    this.peer = peer
  }

  /** The peer hands its own outbound frame to this end's next reader. */
  deliver(frame: unknown): void {
    const wire: WireFrame = { bytes: Buffer.from(JSON.stringify(frame)), binary: false }
    const reader = this.readers.shift()
    if (reader !== undefined) {
      reader(wire)
      return
    }
    this.queue.push(wire)
  }

  /** Observe every frame this end sends, without consuming it. */
  observe(listener: (frame: unknown) => void): void {
    this.onRead.push(listener)
  }

  read(): Promise<WireFrame> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise(resolve => { this.readers.push(resolve) })
  }

  async send(frame: WireFrame): Promise<void> {
    if (frame.binary) throw new Error('a Teams frame must be a JSON text frame')
    const parsed: unknown = JSON.parse(frame.bytes.toString('utf8'))
    for (const listener of this.onRead) listener(parsed)
    if (this.peer === undefined) throw new Error('the socket has no peer')
    this.peer.deliver(parsed)
  }

  close(): Promise<void> {
    this.closeCalls.push(this.closeCalls.length)
    this.resolveClosed()
    return Promise.resolve()
  }
}

class RecordingHistory implements TeamsConnectionHistory {
  readonly entries: TeamsConnectionHistoryEntry[] = []

  async record(entry: TeamsConnectionHistoryEntry): Promise<HistoryRecord> {
    this.entries.push(entry)
    return { recordId: `c-${this.entries.length}`, sequence: this.entries.length, occurredAt: entry.occurredAt, agentId: entry.agentId, kind: 'connection', event: entry.event }
  }

  query(): Promise<never> {
    throw new AcpError('UNSUPPORTED_OPERATION', 'teams-egress.spec: this case never reads the connection history back')
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

const requestPermissionCallback: AcpFrame = {
  jsonrpc: '2.0',
  id: 'engine-callback-1',
  method: 'session/request_permission',
  params: { toolCall: { toolCallId: 't-1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
}

interface TwoSides {
  readonly dialerHistory: RecordingHistory
  readonly listenerHistory: RecordingHistory
  readonly dialerHost: RecordingHost
  readonly listenerHost: RecordingHost
  readonly dialerLedger: TeamsConnectionLedger
  readonly listenerLedger: TeamsConnectionLedger
  readonly dialerEngine: EngineDuplex
  readonly listenerEngine: EngineDuplex
  readonly dialerSocket: SocketEnd
  readonly listenerSocket: SocketEnd
  readonly dialerWire: unknown[]
  readonly historyFaults: AcpFault[]
  dial(overrides?: { readonly connectionId?: string; readonly engineInstanceId?: string; readonly history?: TeamsConnectionHistory }): Promise<Awaited<ReturnType<typeof openTeamsEgress>>>
  listen(): Promise<Awaited<ReturnType<typeof openTeamsIngress>>>
}

/**
 * A history that refuses every write. `onHistoryFault` must report the failure
 * without blocking the live connection: the durable record is best-effort after
 * the effect, never a precondition for it.
 */
class FailingHistory implements TeamsConnectionHistory {
  async record(): Promise<never> {
    throw new AcpError('HISTORY_UNAVAILABLE', 'the test refused this history write')
  }

  async query(): Promise<never> {
    throw new AcpError('UNSUPPORTED_OPERATION', 'teams-egress.spec: this case never reads the connection history back')
  }
}

/**
 * Two daemons on one socket pair: A dials as the initiator and B listens as the
 * responder. Each side gets its own engine instance, generation, policy, host,
 * ledger and `kind=connection` history.
 */
function twoSides(options: {
  readonly dialerAllowedRoles?: readonly RelationRole[]
  readonly listenerAllowedRoles?: readonly RelationRole[]
  readonly listenerAdmittedCapabilities?: readonly string[]
} = {}): TwoSides {
  const dialerSocket = new SocketEnd()
  const listenerSocket = new SocketEnd()
  dialerSocket.link(listenerSocket)
  listenerSocket.link(dialerSocket)
  const dialerWire: unknown[] = []
  const listenerWire: unknown[] = []
  dialerSocket.observe(frame => { dialerWire.push(frame) })
  listenerSocket.observe(frame => { listenerWire.push(frame) })

  const dialerPolicy = makePolicy(ENGINE_A)
  const listenerPolicy = makePolicy(ENGINE_B)
  const dialerEngine = new EngineDuplex()
  const listenerEngine = new EngineDuplex()
  const dialerHost = makeHost(dialerPolicy, GENERATION_A, dialerEngine)
  const listenerHost = makeHost(listenerPolicy, GENERATION_B, listenerEngine)
  const dialerHistory = new RecordingHistory()
  const listenerHistory = new RecordingHistory()
  const dialerLedger = createTeamsConnectionLedger()
  const listenerLedger = createTeamsConnectionLedger()
  const historyFaults: AcpFault[] = []

  const sides: TwoSides = {
    dialerHistory,
    listenerHistory,
    dialerHost,
    listenerHost,
    dialerLedger,
    listenerLedger,
    dialerEngine,
    listenerEngine,
    dialerSocket,
    listenerSocket,
    dialerWire,
    listenerWire,
    historyFaults,
    dial: (overrides = {}) => openTeamsEgress({
      endpoint: { peer: B, connection: dialerSocket },
      self: A,
      selfGeneration: GENERATION_A,
      selfCapabilitiesRevision: 'caps-a',
      selfPolicyRevision: 7,
      allowedRoles: options.dialerAllowedRoles ?? ['master', 'peer'],
      requestedRole: 'master',
      requestedPeerRole: 'peer',
      requestedCapabilities: ['session/new'],
      requestId: 'request-1',
      expectedTargetGeneration: GENERATION_B,
      expectedTargetCapabilitiesRevision: 'caps-b',
      connectionId: overrides.connectionId ?? 'conn-a',
      host: dialerHost,
      policy: dialerPolicy,
      engineInstanceId: overrides.engineInstanceId ?? ENGINE_A,
      history: overrides.history ?? dialerHistory,
      ledger: dialerLedger,
      timeoutMs: 2_000,
      openTimeoutMs: 2_000,
      pollIntervalMs: 5,
      onHistoryFault: fault => { historyFaults.push(fault) },
    }),
    listen: () => openTeamsIngress({
      connection: { connectionId: 'conn-b', peer: A, connection: listenerSocket },
      self: B,
      selfGeneration: GENERATION_B,
      selfCapabilitiesRevision: 'caps-b',
      selfPolicyRevision: 9,
      allowedRoles: options.listenerAllowedRoles ?? ['master', 'peer'],
      admittedCapabilities: options.listenerAdmittedCapabilities ?? ['session/new'],
      host: listenerHost,
      policy: listenerPolicy,
      engineInstanceId: ENGINE_B,
      history: listenerHistory,
      ledger: listenerLedger,
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      onHistoryFault: fault => { historyFaults.push(fault) },
    }),
  }
  return sides
}

/** Start both sides and wait until the initiator channel is open on each. */
async function connect(sides: TwoSides): Promise<{ readonly handle: Awaited<ReturnType<typeof openTeamsEgress>> }> {
  const listening = sides.listen().catch(() => undefined)
  const handle = await sides.dial()
  await listening
  await until(() => sides.dialerHost.ingresses.length >= 0 && sides.listenerHost.opens.length === 1, 'the responder opened its channel')
  return { handle }
}

describe('initiator egress composition (D00 amendment A3)', () => {
  it('negotiates, opens the one channel and hands the host only its own ref', async () => {
    const sides = twoSides()
    const { handle } = await connect(sides)
    expect(handle.negotiation.state).toBe('agreed')
    expect(handle.session.channels).toHaveLength(1)
    const channel = handle.session.channels[0]
    expect(channel.open).toBe(true)

    // The host-facing ref carries THIS side's own connection key and pair.
    expect(channel.localRef.connectionId).toBe('conn-a')
    expect(channel.localRef.targetGeneration).toBe(GENERATION_A)
    expect(channel.localRef.engineInstanceId).toBe(ENGINE_A)
    // The adopted peer ref is the responder's own ack ref.
    expect(channel.peerConnectionId).toBe('conn-b')

    // The initiator's host saw its own local ref and the peer's identity only.
    expect(sides.dialerHost.opens).toHaveLength(1)
    expect(sides.dialerHost.opens[0].ref).toEqual(channel.localRef)
    expect(sides.dialerHost.opens[0].principal).toEqual(B)

    // `acp.open` named the TARGET pair, and the responder answered with its own.
    const open = sides.dialerWire.find(frame => (frame as { kind?: string }).kind === 'acp.open') as { ref: AcpChannelRef }
    expect(open.ref).toEqual({
      connectionId: 'conn-a',
      channelId: channel.localRef.channelId,
      targetGeneration: GENERATION_B,
      engineInstanceId: ENGINE_B,
    })
    const ack = sides.listenerWire.find(frame => (frame as { kind?: string }).kind === 'acp.open_ack') as { ref: AcpChannelRef }
    expect(ack.ref).toEqual({
      connectionId: 'conn-b',
      channelId: channel.peerChannelId,
      targetGeneration: GENERATION_B,
      engineInstanceId: ENGINE_B,
    })
    // The egress never answers an open; it only starts one.
    expect(sides.dialerWire.filter(frame => (frame as { kind?: string }).kind === 'acp.open_ack')).toEqual([])
  })

  it('relays a real engine callback to the initiator host with its own ref and a fresh outward id', async () => {
    const sides = twoSides()
    await connect(sides)

    // The responder engine raises a permission callback; the responder session
    // must relay it to the initiator host as an ingress.
    sides.listenerEngine.push(requestPermissionCallback)
    await until(
      () => sides.dialerHost.ingresses.filter(ingress => ingress.frame.method === 'session/request_permission').length === 1,
      'the relayed permission callback',
    )
    const relayed = sides.dialerHost.ingresses.find(ingress => ingress.frame.method === 'session/request_permission') as AcpIngress
    // The initiator's host was addressed with its own ref, never the peer ref.
    expect(relayed.connectionId).toBe('conn-a')
    expect(relayed.engineInstanceId).toBe(ENGINE_A)
    expect(relayed.targetGeneration).toBe(GENERATION_A)
    // The id on the wire is a fresh outward id, never the engine's own id; the
    // engine's calling id is what the responder host later matches on return.
    expect(relayed.frame.id).not.toBe('engine-callback-1')
    expect(sides.dialerHost.ingresses.length).toBe(1)
  })

  it('fails the dial with the peer capability refusal, marks the ledger failed and closes the transport', async () => {
    // The responder admits the roles but not the requested capability, so the
    // negotiation ends in a typed CAPABILITY_DENIED refusal; the initiator must
    // surface that fault, not a timeout, and must release its side.
    const sides = twoSides({ listenerAdmittedCapabilities: [] })
    const listening = sides.listen().catch((error: unknown) => error)
    const dialed = sides.dial().catch((error: unknown) => error)
    const [refusal] = await Promise.all([dialed, listening])
    expect(refusal).toBeInstanceOf(AcpError)
    expect((refusal as AcpError).code).toBe('CAPABILITY_DENIED')

    const failed = sides.dialerHistory.entries.filter(entry => entry.event === 'connection.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].error?.code).toBe('CAPABILITY_DENIED')
    expect(sides.dialerLedger.list()).toEqual([
      expect.objectContaining({ connectionId: 'conn-a', state: 'failed' }),
    ])
    // The failed ledger names THIS side's generation as its own, never the peer's:
    // the peer's generation belongs on the wire ref only.
    expect(sides.dialerLedger.list()[0].targetGeneration).toBe(GENERATION_A)
    expect(sides.dialerSocket.closeCalls).toHaveLength(1)
    expect(sides.dialerHistory.entries.some(entry => entry.event === 'connection.negotiated')).toBe(false)
    expect(sides.dialerHost.opens).toEqual([])
  })

  it('records connection.failed and a failed ledger when an unexpected frame aborts the read loop', async () => {
    const sides = twoSides()
    const { handle } = await connect(sides)

    // Sent from the responder end so it arrives at the dialer's read loop. It is
    // a well-formed Teams frame that is not one of the five ACP channel kinds,
    // so the initiator session rejects it typed and the read loop ends; the
    // egress must mark the ledger failed and record the durable failure, not
    // leave a ready record and silence.
    await sides.listenerSocket.send({
      bytes: Buffer.from(JSON.stringify({
        version: 1,
        kind: 'teams.connection.context',
        connectionId: 'conn-a',
        targetGeneration: GENERATION_A,
        capabilitiesRevision: 'caps-a',
        policyRevision: 7,
      })),
      binary: false,
    })
    await handle.done

    expect(sides.dialerLedger.list()).toEqual([
      expect.objectContaining({ connectionId: 'conn-a', state: 'failed' }),
    ])
    expect(sides.dialerLedger.list()[0].targetGeneration).toBe(GENERATION_A)
    const failed = sides.dialerHistory.entries.filter(entry => entry.event === 'connection.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].error?.code).toBe('INVALID_ACP_FRAME')
  })

  it('records the negotiation and the channel, then closes the ledger when the session ends', async () => {
    const sides = twoSides()
    const { handle } = await connect(sides)
    expect(sides.dialerHistory.entries.map(entry => entry.event)).toEqual(['connection.negotiated', 'channel.opened'])
    expect(sides.dialerHistory.entries[1].engineInstanceId).toBe(ENGINE_A)
    expect(sides.dialerHistory.entries[1].channelId).toBe(handle.session.channels[0].localRef.channelId)
    // The durable channel record carries this side's own connection key, never the
    // peer's: only the channel/engine pair on the wire ref names the target.
    expect(sides.dialerHistory.entries[1].connectionId).toBe('conn-a')
    expect(sides.dialerLedger.list()).toEqual([
      expect.objectContaining({ connectionId: 'conn-a', state: 'ready', remoteAgentId: 'agent-b' }),
    ])

    await handle.session.close('the test closed it')
    await handle.done
    expect(sides.dialerLedger.list()).toEqual([
      expect.objectContaining({ connectionId: 'conn-a', state: 'closed' }),
    ])
    expect(sides.dialerHistory.entries.map(entry => entry.event)).toContain('channel.closed')
  })

  it('refuses a dial whose policy belongs to another engine instance before it touches the socket', async () => {
    const sides = twoSides()
    await expect(sides.dial({ engineInstanceId: 'engine-other' })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    expect(sides.dialerWire).toEqual([])
    expect(sides.dialerLedger.list()).toEqual([])
  })

  it('refuses a reused connection id instead of replacing the live ledger record', async () => {
    const sides = twoSides()
    await connect(sides)
    // The second dial goes through the egress itself, so the guard under test is
    // the one the egress runs before it writes anything: the live `conn-a` record
    // must survive and the refused dial must not reach the wire.
    await expect(sides.dial()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(sides.dialerLedger.list()).toEqual([
      expect.objectContaining({ connectionId: 'conn-a', state: 'ready' }),
    ])
    expect(sides.dialerLedger.list()).toHaveLength(1)
  })

  it('reports a history write failure through onHistoryFault and never blocks the live connection', async () => {
    const sides = twoSides()
    const listening = sides.listen().catch(() => undefined)
    // A durable-history refusal is an isolated failure: the connection, the
    // negotiation and the channel must not change because the history store did.
    const handle = await sides.dial({ history: new FailingHistory() })
    await listening
    await until(() => sides.listenerHost.opens.length === 1, 'the responder opened its channel')

    expect(handle.negotiation.state).toBe('agreed')
    expect(handle.session.channels).toHaveLength(1)
    expect(sides.dialerLedger.list()).toEqual([
      expect.objectContaining({ connectionId: 'conn-a', state: 'ready' }),
    ])
    const faults = sides.historyFaults.map(fault => fault.code)
    expect(faults).toContain('HISTORY_UNAVAILABLE')
    expect(faults.length).toBeGreaterThan(0)
    expect(sides.listenerHost.opens).toHaveLength(1)
  })
})
