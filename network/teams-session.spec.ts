import { describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpChannelRef, AcpFrame, AcpIngress, HistoryRecord } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { AcpDuplex, EngineHandle } from '../control-protocol/engine.ts'
import type { TeamsConnectionFrame } from '../control-protocol/teams-connection.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from '../config/acp-policy.ts'
import { createAcpHost, type AcpHost } from '../agent-host/acp-host.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'
import {
  receiveTeamsNegotiationFrame,
  startTeamsNegotiation,
  type TeamsInitiatorOptions,
  type TeamsNegotiationState,
  type TeamsResponderOptions,
} from './teams-negotiation.ts'
import { createTeamsSession, type TeamsSession, type TeamsSessionTransport } from './teams-session.ts'

const A: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-a' }
const B: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-b' }

const ENGINE = 'engine-1'
const GENERATION = 22

const initializeResult: AcpFrame = {
  jsonrpc: '2.0',
  id: 'runtime-initialize',
  result: {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true, audio: false } },
    extension: { keep: true },
  },
}

class ScriptedDuplex implements AcpDuplex {
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

  send(frame: AcpFrame): Promise<void> {
    this.sent.push(frame)
    return Promise.resolve()
  }

  async close(): Promise<void> {
    this.resolveClosed({ kind: 'eof' })
  }

  push(frame: AcpFrame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else this.queue.push(frame)
  }
}

class MemoryHistory implements AcpHistoryPort {
  readonly records: HistoryRecord[] = []
  async append(record: Omit<HistoryRecord, 'recordId' | 'sequence'>): Promise<HistoryRecord> {
    const stored: HistoryRecord = { ...record, recordId: `r-${this.records.length + 1}`, sequence: this.records.length + 1 }
    this.records.push(stored)
    return stored
  }
}

class FakeTransport implements TeamsSessionTransport {
  readonly peer: AuthenticatedAgent
  readonly sent: TeamsConnectionFrame[] = []
  readonly closed: Promise<unknown>
  /** How many times the session released this transport by handle. */
  closeCount = 0
  private readonly queue: unknown[] = []
  private readonly waiters: Array<(value: unknown) => void> = []
  private readonly resolveClosed: (value: unknown) => void

  constructor(peer: AuthenticatedAgent) {
    this.peer = peer
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  read(): Promise<unknown> {
    const seeded = this.readOnce
    if (seeded !== undefined) {
      this.readOnce = undefined
      return seeded()
    }
    const next = this.queue.shift()
    if (next !== undefined) return Promise.resolve(next)
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  send(frame: TeamsConnectionFrame): Promise<void> {
    this.sent.push(frame)
    if (this.failSendWith !== undefined) {
      const error = this.failSendWith
      this.failSendWith = undefined
      return Promise.reject(error)
    }
    return Promise.resolve()
  }

  async close(): Promise<void> {
    this.closeCount += 1
    this.resolveClosed(undefined)
  }

  push(frame: unknown): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else this.queue.push(frame)
  }

  /** Make the next `read` reject, the way a real WSS socket does when it dies. */
  private readOnce: (() => Promise<unknown>) | undefined
  /** Make the next `send` reject. */
  failSendWith?: unknown

  failRead(error: unknown): void {
    this.readOnce = () => Promise.reject(error)
  }

  failSend(error: unknown): void {
    this.failSendWith = error
  }
}

/**
 * Drive the real negotiation on both sides to `agreed` and return both terminal
 * states. The responder side is what `agreedResponder` returns; the initiator side
 * is what the A3 channel-open tests need, because only the initiator opens.
 */
function negotiatePair(overrides: Partial<TeamsResponderOptions> = {}): {
  readonly initiator: TeamsNegotiationState
  readonly responder: TeamsNegotiationState
} {
  const initiator: TeamsInitiatorOptions = {
    side: 'initiator',
    connectionId: 'conn-a',
    self: A,
    peer: B,
    selfGeneration: 11,
    selfCapabilitiesRevision: 'cap-a',
    selfPolicyRevision: 3,
    allowedRoles: ['master', 'peer'],
    requestedRole: 'master',
    requestedPeerRole: 'peer',
    requestedCapabilities: ['method:session/new'],
    requestId: 'req-1',
    expectedTargetGeneration: GENERATION,
    expectedTargetCapabilitiesRevision: 'cap-b',
  }
  const responder: TeamsResponderOptions = {
    side: 'responder',
    connectionId: 'conn-b',
    self: B,
    peer: A,
    selfGeneration: GENERATION,
    selfCapabilitiesRevision: 'cap-b',
    selfPolicyRevision: 7,
    allowedRoles: ['master', 'peer'],
    admittedCapabilities: ['method:session/new'],
    // D00 amendment A3: the responder publishes the engine instance the peer must
    // name on acp.open, so the fixture must carry the same value the session checks.
    engineInstanceId: ENGINE,
    ...overrides,
  }
  const start = startTeamsNegotiation(responder)
  let responderState = start.state
  let initiatorState = startTeamsNegotiation(initiator).state
  const proposed = receiveTeamsNegotiationFrame(initiatorState, start.outbound!)
  initiatorState = proposed.state
  const accepted = receiveTeamsNegotiationFrame(responderState, proposed.outbound!)
  responderState = accepted.state
  const confirmed = receiveTeamsNegotiationFrame(initiatorState, accepted.outbound!)
  initiatorState = confirmed.state
  const ready = receiveTeamsNegotiationFrame(responderState, confirmed.outbound!)
  responderState = ready.state
  initiatorState = receiveTeamsNegotiationFrame(initiatorState, ready.outbound!).state
  if (initiatorState.state !== 'agreed' || responderState.state !== 'agreed') throw new Error('negotiation did not agree')
  return { initiator: initiatorState, responder: responderState }
}

function agreedResponder(overrides: Partial<TeamsResponderOptions> = {}): TeamsNegotiationState {
  return negotiatePair(overrides).responder
}

function agreedInitiator(overrides: Partial<TeamsResponderOptions> = {}): TeamsNegotiationState {
  return negotiatePair(overrides).initiator
}

function makePolicy(engineInstanceId = ENGINE) {
  const supported = extractAcpCapabilities(initializeResult, ['session/new', 'callback:session/request_permission'])
  return resolveAcpPolicy({
    intent: { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
    engineInstanceId,
    supported,
    enforceablePolicies: supported,
  })
}

/**
 * Cross-wire two session transports so a frame one side sends reaches the other,
 * the way a real transport would.
 */
function bridge(left: FakeTransport, right: FakeTransport): () => void {
  let leftCursor = 0
  let rightCursor = 0
  const timer = setInterval(() => {
    while (leftCursor < left.sent.length) right.push(left.sent[leftCursor++])
    while (rightCursor < right.sent.length) left.push(right.sent[rightCursor++])
  }, 1)
  timer.unref?.()
  return () => clearInterval(timer)
}

interface RecordingHost extends AcpHost {
  readonly opens: Array<{ readonly ref: AcpChannelRef; readonly principal: AuthenticatedAgent }>
  readonly ingresses: AcpIngress[]
  /** Every host channel this session released by handle. */
  readonly closes: AcpChannelRef[]
}

function makeHost(policy: ReturnType<typeof makePolicy>, generation = GENERATION): { readonly host: RecordingHost; readonly duplex: ScriptedDuplex } {
  const duplex = new ScriptedDuplex()
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
    history: new MemoryHistory(),
    assertAllowed: assertAcpAllowed,
  })
  const opens: RecordingHost['opens'] = []
  const ingresses: AcpIngress[] = []
  const closes: AcpChannelRef[] = []
  const host: RecordingHost = {
    opens,
    ingresses,
    closes,
    open: async input => { opens.push({ ref: input.ref, principal: input.principal }); await inner.open(input) },
    receive: async ingress => { ingresses.push(ingress); await inner.receive(ingress) },
    read: (ref, after, limit) => inner.read(ref, after, limit),
    close: async ref => { closes.push(ref); await inner.close(ref) },
  }
  return { host, duplex }
}

interface Fixture {
  readonly session: TeamsSession
  readonly transport: FakeTransport
  readonly host: RecordingHost
  readonly duplex: ScriptedDuplex
  readonly negotiation: TeamsNegotiationState
}

function fixture(connectionId = 'conn-b'): Fixture {
  const negotiation = agreedResponder()
  const transport = new FakeTransport(A)
  const { host, duplex } = makeHost(makePolicy())
  const session = createTeamsSession({
    negotiation,
    connectionId,
    transport,
    host,
    policy: makePolicy(),
    engineInstanceId: ENGINE,
  })
  return { session, transport, host, duplex, negotiation }
}

function peerRef(channelId: string, overrides: Partial<AcpChannelRef> = {}): AcpChannelRef {
  return { connectionId: 'conn-a', channelId, targetGeneration: GENERATION, engineInstanceId: ENGINE, ...overrides }
}

function openFrame(channelId: string, overrides: Partial<AcpChannelRef> = {}): TeamsConnectionFrame {
  return { version: 1, kind: 'acp.open', ref: peerRef(channelId, overrides) }
}

function frameFrame(channelId: string, frame: AcpFrame, ref = peerRef(channelId)): TeamsConnectionFrame {
  return { version: 1, kind: 'acp.frame', ref, frame }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Pumps host deliveries until the relayed wire frame satisfies `predicate`. */
async function flushUntil(session: TeamsSession, predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await session.flush()
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const initializeRequest: AcpFrame = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: {} } }

describe('Teams authenticated ACP session', () => {
  it('refuses to open any ACP channel before the negotiation is agreed', () => {
    const negotiation = startTeamsNegotiation({
      side: 'responder', connectionId: 'conn-b', self: B, peer: A,
      selfGeneration: GENERATION, selfCapabilitiesRevision: 'cap-b', selfPolicyRevision: 7,
      allowedRoles: ['peer'], admittedCapabilities: [], engineInstanceId: ENGINE,
    }).state
    const { host } = makeHost(makePolicy())
    expect(() => createTeamsSession({
      negotiation, connectionId: 'conn-b', transport: new FakeTransport(A), host,
      policy: makePolicy(), engineInstanceId: ENGINE,
    })).toThrow(/negotiat/i)
  })

  it('allocates local transport keys and rewrites generation and engine instance before host.open', async () => {
    const { session, transport, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    expect(host.opens).toHaveLength(1)
    const ref = host.opens[0].ref
    expect(host.opens[0].principal).toEqual(A)
    expect(ref.connectionId).toBe('conn-b')
    expect(ref.channelId).not.toBe('peer-ch-1')
    expect(ref.targetGeneration).toBe(GENERATION)
    expect(ref.engineInstanceId).toBe(ENGINE)
    expect(transport.sent[0]).toMatchObject({ kind: 'acp.open_ack', ref })
  })

  it('refuses a forged or stale targetGeneration and engineInstanceId without opening a channel', async () => {
    const stale = fixture()
    await stale.session.receive(openFrame('peer-ch-1', { targetGeneration: 21 }))
    expect(stale.host.opens).toHaveLength(0)
    expect(stale.transport.sent).toHaveLength(1)
    expect(stale.transport.sent[0]).toMatchObject({ kind: 'acp.error', error: { code: 'STALE_GENERATION' } })

    const forgedEngine = fixture()
    await forgedEngine.session.receive(openFrame('peer-ch-1', { engineInstanceId: 'engine-other' }))
    expect(forgedEngine.host.opens).toHaveLength(0)
    expect(forgedEngine.transport.sent[0]).toMatchObject({ kind: 'acp.error', error: { code: 'STALE_GENERATION' } })
  })

  it('re-checks generation and engine instance on every acp.frame and refuses a stale ref before host.receive', async () => {
    const { session, transport, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    expect(host.opens).toHaveLength(1)
    expect(host.ingresses).toHaveLength(0)

    // The channel is already open; the peer reuses its wire key but names a
    // stale target generation. The R2 re-check must refuse it before the host.
    await session.receive(frameFrame('peer-ch-1', initializeRequest, peerRef('peer-ch-1', { targetGeneration: GENERATION - 1 })))
    expect(host.ingresses).toHaveLength(0)
    expect(transport.sent.at(-1)).toMatchObject({ kind: 'acp.error', error: { code: 'STALE_GENERATION' } })

    // Same open channel, but the peer names a forged engine instance.
    await session.receive(frameFrame('peer-ch-1', initializeRequest, peerRef('peer-ch-1', { engineInstanceId: 'engine-forged' })))
    expect(host.ingresses).toHaveLength(0)
    expect(transport.sent.at(-1)).toMatchObject({ kind: 'acp.error', error: { code: 'STALE_GENERATION' } })

    // The genuine ref on the same open channel still reaches the host, and the
    // ingress carries only local generation/engine values.
    await session.receive(frameFrame('peer-ch-1', initializeRequest))
    expect(host.ingresses).toHaveLength(1)
    expect(host.ingresses[0].targetGeneration).toBe(GENERATION)
    expect(host.ingresses[0].engineInstanceId).toBe(ENGINE)
  })

  it('injects an inbound frame into host.receive with the payload preserved byte-for-byte', async () => {
    const { session, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    const frame: AcpFrame = {
      jsonrpc: '2.0',
      id: 7,
      method: 'session/new',
      params: { cwd: '/tmp', mcpServers: [] },
      _meta: { trace: 'keep-me' },
      extension: { vendor: { nested: [1, 2, 3] } },
    }
    await session.receive(frameFrame('peer-ch-1', frame))
    expect(host.ingresses).toHaveLength(1)
    const ingress = host.ingresses[0]
    expect(ingress.frame).toEqual(frame)
    expect(Object.keys(ingress.frame).sort()).toEqual(Object.keys(frame).sort())
    expect(typeof ingress.frame.id).toBe('number')
    expect(ingress.frame._meta).toEqual({ trace: 'keep-me' })
    // R2: the host sees this side's local ref, never the peer's wire key.
    expect({
      connectionId: ingress.connectionId,
      channelId: ingress.channelId,
      targetGeneration: ingress.targetGeneration,
      engineInstanceId: ingress.engineInstanceId,
    }).toEqual(host.opens[0].ref)
    expect(ingress.channelId).not.toBe('peer-ch-1')
  })

  it('relays a host delivery as acp.frame and keeps a bidirectional response round trip', async () => {
    const { session, transport, duplex, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    await session.receive(frameFrame('peer-ch-1', initializeRequest))
    await session.flush()
    expect(transport.sent.at(-1)).toMatchObject({ kind: 'acp.frame', ref: host.opens[0].ref, frame: { id: 1 } })

    const newRequest: AcpFrame = { jsonrpc: '2.0', id: 'client-2', method: 'session/new', params: { cwd: '/', mcpServers: [] } }
    await session.receive(frameFrame('peer-ch-1', newRequest))
    await until(() => duplex.sent.length === 1, 'engine request')
    const childId = duplex.sent[0].id
    const result = { sessionId: 's-1', _meta: { engine: true }, extension: { x: 1 } }
    duplex.push({ jsonrpc: '2.0', id: childId, result })
    await flushUntil(session, () => transport.sent.some(entry => entry.kind === 'acp.frame' && (entry.frame as AcpFrame).id === 'client-2'), 'session/new relay')
    const relayed = transport.sent.find(entry => entry.kind === 'acp.frame' && (entry.frame as AcpFrame).id === 'client-2')!
    expect(relayed).toMatchObject({ kind: 'acp.frame', ref: host.opens[0].ref })
    expect((relayed as { frame: AcpFrame }).frame).toEqual({ jsonrpc: '2.0', id: 'client-2', result })
    expect((relayed as { frame: AcpFrame }).frame).not.toHaveProperty('connectionId')
    expect((relayed as { frame: AcpFrame }).frame).not.toHaveProperty('role')
    expect((relayed as { frame: AcpFrame }).frame).not.toHaveProperty('permission')
  })

  it('relays an engine callback and injects the controller reply back to the engine', async () => {
    const { session, transport, duplex } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    await session.receive(frameFrame('peer-ch-1', initializeRequest))
    duplex.push({
      jsonrpc: '2.0',
      id: 'engine-callback-1',
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 't-1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    })
    await flushUntil(session, () => transport.sent.some(entry => entry.kind === 'acp.frame' && (entry.frame as AcpFrame).method === 'session/request_permission'), 'callback relay')
    const relayed = transport.sent.find(entry => entry.kind === 'acp.frame' && (entry.frame as AcpFrame).method === 'session/request_permission') as { ref: AcpChannelRef; frame: AcpFrame }
    expect(relayed.frame.id).not.toBe('engine-callback-1')
    const reply: AcpFrame = { jsonrpc: '2.0', id: relayed.frame.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }
    await session.receive(frameFrame('peer-ch-1', reply))
    await until(() => duplex.sent.some(frame => frame.id === 'engine-callback-1'), 'callback reply to engine')
    expect(duplex.sent.find(frame => frame.id === 'engine-callback-1')).toEqual({
      jsonrpc: '2.0',
      id: 'engine-callback-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    })
  })

  it('relays a host refusal as the single ACP JSON-RPC error envelope with the original id', async () => {
    const { session, transport, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    // The host refuses traffic before initialize; the peer must learn that on the
    // ACP channel, correlated by the original request id, not as a Teams fault.
    await session.receive(frameFrame('peer-ch-1', { jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 's-1', prompt: [] } }))
    const relayed = transport.sent.filter(entry => entry.kind === 'acp.frame')
    expect(relayed).toHaveLength(1)
    const error = relayed[0] as { ref: AcpChannelRef; frame: AcpFrame }
    expect(error.ref).toEqual(host.opens[0].ref)
    expect(error.frame.id).toBe(5)
    expect((error.frame.error as { data?: { code?: string } }).data?.code).toBe('CONFLICT')
    expect(transport.sent.some(entry => entry.kind === 'acp.error')).toBe(false)
  })

  it('isolates the same RPC id across two channels and two Sessions', async () => {
    const first = fixture('conn-b')
    const second = fixture('conn-b2')
    for (const item of [first, second]) {
      await item.session.receive(openFrame('peer-ch-1'))
      await item.session.receive(openFrame('peer-ch-2'))
      await item.session.receive(frameFrame('peer-ch-1', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
      await item.session.receive(frameFrame('peer-ch-2', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
      await item.session.flush()
    }
    expect(first.host.opens).toHaveLength(2)
    expect(first.host.opens[0].ref.channelId).not.toBe(first.host.opens[1].ref.channelId)
    expect(first.host.ingresses).toHaveLength(2)
    expect(first.host.ingresses[0].channelId).not.toBe(first.host.ingresses[1].channelId)
    const firstResponses = first.transport.sent.filter(entry => entry.kind === 'acp.frame')
    expect(firstResponses).toHaveLength(2)
    expect(firstResponses.every(entry => (entry.frame as AcpFrame).id === 1)).toBe(true)
    expect(second.transport.sent.filter(entry => entry.kind === 'acp.frame')).toHaveLength(2)
    expect(first.host.opens[0].ref.connectionId).toBe('conn-b')
    expect(second.host.opens[0].ref.connectionId).toBe('conn-b2')
  })

  it('closes the channel on acp.close and restores no callback or prompt afterwards', async () => {
    const { session, transport, duplex, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    await session.receive(frameFrame('peer-ch-1', initializeRequest))
    duplex.push({
      jsonrpc: '2.0',
      id: 'engine-callback-1',
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 't-1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    })
    await flushUntil(session, () => transport.sent.some(entry => entry.kind === 'acp.frame' && (entry.frame as AcpFrame).method === 'session/request_permission'), 'callback relay')
    const relayed = transport.sent.find(entry => entry.kind === 'acp.frame' && (entry.frame as AcpFrame).method === 'session/request_permission') as { frame: AcpFrame }
    await session.receive({ version: 1, kind: 'acp.close', ref: peerRef('peer-ch-1') })
    expect(session.channels).toHaveLength(0)
    // The late controller reply must not be restored into the closed channel.
    const ingressesBefore = host.ingresses.length
    await session.receive(frameFrame('peer-ch-1', { jsonrpc: '2.0', id: relayed.frame.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }))
    expect(host.ingresses).toHaveLength(ingressesBefore)
    expect(transport.sent.at(-1)).toMatchObject({ kind: 'acp.error', error: { code: 'STALE_GENERATION' } })
    // A new prompt on the closed channel is refused instead of opening a channel.
    await session.receive(frameFrame('peer-ch-1', { jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 's-1' } }))
    expect(host.ingresses).toHaveLength(ingressesBefore)
    expect(host.opens).toHaveLength(1)
  })

  it('closes every channel on transport close and refuses a replaced generation', async () => {
    const { session, transport, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    await session.close('transport closed')
    expect(session.channels).toHaveLength(0)
    expect(transport.sent.some(entry => entry.kind === 'acp.close')).toBe(true)

    const replaced = fixture()
    await replaced.session.receive(openFrame('peer-ch-1', { targetGeneration: GENERATION + 1 }))
    expect(replaced.host.opens).toHaveLength(0)
    expect(replaced.transport.sent.at(-1)).toMatchObject({ kind: 'acp.error', error: { code: 'STALE_GENERATION' } })
  })

  it('closes the host channel and the transport when an unexpected inbound frame aborts the read loop', async () => {
    const { session, transport, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    expect(host.opens).toHaveLength(1)
    // A well-formed Teams frame that is not one of the five ACP channel kinds:
    // `receive` throws out of the run loop instead of returning a value. The
    // context carries every required field so this case isolates the frame kind.
    transport.push({ version: 1, kind: 'teams.connection.context', connectionId: 'conn-a', targetGeneration: GENERATION, capabilitiesRevision: 'cap-b', policyRevision: 7, engineInstanceId: ENGINE })
    await expect(session.run()).rejects.toThrow(/unexpected teams\.connection\.context/)
    // The error propagates, but the release must still happen on that exit path.
    expect(session.channels).toHaveLength(0)
    expect(host.closes).toEqual([host.opens[0].ref])
    expect(transport.closeCount).toBe(1)
  })

  it('carries no network diagnostics or permission injection in a Session payload', async () => {
    const { session, transport, duplex, host } = fixture()
    await session.receive(openFrame('peer-ch-1'))
    const request: AcpFrame = { jsonrpc: '2.0', id: 'client-9', method: 'session/new', params: { cwd: '/', mcpServers: [] } }
    await session.receive(frameFrame('peer-ch-1', { ...initializeRequest }))
    await session.receive(frameFrame('peer-ch-1', request))
    await until(() => duplex.sent.length === 1, 'engine request')
    duplex.push({ jsonrpc: '2.0', id: duplex.sent[0].id, result: { sessionId: 's-9' } })
    await flushUntil(session, () => transport.sent.some(entry => entry.kind === 'acp.frame' && (entry.frame as AcpFrame).id === 'client-9'), 'session/new relay')
    const engineRequest = duplex.sent[0]
    expect(engineRequest).toEqual({ ...request, id: engineRequest.id })
    const delivered = transport.sent.filter(entry => entry.kind === 'acp.frame').at(-1) as { ref: AcpChannelRef; frame: AcpFrame }
    expect(Object.keys(delivered.ref).sort()).toEqual(['channelId', 'connectionId', 'engineInstanceId', 'targetGeneration'])
    expect(Object.keys(delivered.frame).sort()).toEqual(['id', 'jsonrpc', 'result'])
    expect(host.ingresses.every(ingress => Object.keys(ingress).sort().join(',') === 'channelId,connectionId,engineInstanceId,frame,targetGeneration')).toBe(true)
  })
})

/** The engine instance the responder publishes, kept distinct from this side's own. */
const TARGET_ENGINE = 'engine-b'

function initiatorFixture(overrides: Partial<TeamsResponderOptions> = {}): Fixture {
  const negotiation = agreedInitiator({ engineInstanceId: TARGET_ENGINE, ...overrides })
  const transport = new FakeTransport(B)
  const policy = makePolicy()
  // The initiator's own engine runs at its own generation (11), not the target's.
  const { host, duplex } = makeHost(policy, 11)
  const session = createTeamsSession({
    negotiation,
    connectionId: 'conn-a',
    transport,
    host,
    policy,
    engineInstanceId: ENGINE,
  })
  return { session, transport, host, duplex, negotiation }
}

function ackRefOf(engineInstanceId = TARGET_ENGINE): AcpChannelRef {
  return { connectionId: 'conn-b', channelId: 'teams-conn-b-1', targetGeneration: GENERATION, engineInstanceId }
}

/** The ref the initiator hands its own host: this side's own generation and engine instance. */
function hostRefOf(channelId: string): AcpChannelRef {
  return { connectionId: 'conn-a', channelId, targetGeneration: 11, engineInstanceId: ENGINE }
}

describe('initiator channel open (D00 amendment A3)', () => {
  it('names the responder engine instance on acp.open and keeps the host ref on this side', async () => {
    const { session, transport, host } = initiatorFixture()
    const opening = session.open()
    await until(() => transport.sent.length === 1, 'acp.open')
    const open = transport.sent[0] as { readonly kind: string; readonly ref: AcpChannelRef }
    expect(open.kind).toBe('acp.open')
    expect(Object.keys(open.ref).sort()).toEqual(['channelId', 'connectionId', 'engineInstanceId', 'targetGeneration'])
    // `connectionId`/`channelId` stay this side's own correlation keys (R2); only
    // the freshness pair names the RESPONDER, never this side's `ENGINE`.
    expect(open.ref.connectionId).toBe('conn-a')
    expect(open.ref.targetGeneration).toBe(GENERATION)
    expect(open.ref.engineInstanceId).toBe(TARGET_ENGINE)
    expect(open.ref.channelId.startsWith('teams-conn-a-')).toBe(true)

    transport.push({ version: 1, kind: 'acp.open_ack', ref: ackRefOf() })
    const channel = await opening
    // The host ref is this side's own; the host refuses a foreign engine instance.
    expect(channel.localRef).toEqual(hostRefOf(open.ref.channelId))
    expect(channel.peerConnectionId).toBe('conn-b')
    expect(channel.peerChannelId).toBe('teams-conn-b-1')
    expect(channel.open).toBe(true)
    expect(host.opens).toEqual([{ ref: channel.localRef, principal: B }])
  })

  it('maps an inbound acp.frame addressed to the ack ref onto the local ref before the host sees it', async () => {
    const { session, transport, host } = initiatorFixture()
    const opening = session.open()
    await until(() => transport.sent.length === 1, 'acp.open')
    transport.push({ version: 1, kind: 'acp.open_ack', ref: ackRefOf() })
    const channel = await opening

    await session.receive({ version: 1, kind: 'acp.frame', ref: ackRefOf(), frame: { ...initializeRequest } })
    expect(host.ingresses).toHaveLength(1)
    const ingress = host.ingresses[0]
    expect({ connectionId: ingress.connectionId, channelId: ingress.channelId, targetGeneration: ingress.targetGeneration, engineInstanceId: ingress.engineInstanceId })
      .toEqual(channel.localRef)
  })

  it('refuses an ack that names a different engine instance and releases the local host channel', async () => {
    const { session, transport, host } = initiatorFixture()
    const opening = session.open()
    await until(() => transport.sent.length === 1, 'acp.open')
    const channelId = (transport.sent[0] as { readonly ref: AcpChannelRef }).ref.channelId
    transport.push({ version: 1, kind: 'acp.open_ack', ref: ackRefOf('engine-other') })
    await expect(opening).rejects.toThrow(/engine instance/)
    expect(host.closes).toEqual([hostRefOf(channelId)])
    expect(session.channels).toEqual([])
  })

  it('refuses to open when the agreed context published no engine instance', async () => {
    const { targetEngineInstanceId: _omitted, ...withoutEngine } = agreedInitiator({ engineInstanceId: TARGET_ENGINE })
    const transport = new FakeTransport(B)
    const policy = makePolicy()
    const { host } = makeHost(policy)
    const session = createTeamsSession({ negotiation: withoutEngine, connectionId: 'conn-a', transport, host, policy, engineInstanceId: ENGINE })
    await expect(session.open()).rejects.toThrow(/engine instance/)
    expect(transport.sent).toEqual([])
    expect(host.opens).toEqual([])
  })

  it('fails the pending open on a matching acp.error and releases the local host channel', async () => {
    const { session, transport, host } = initiatorFixture()
    const opening = session.open()
    await until(() => transport.sent.length === 1, 'acp.open')
    const wireRef = (transport.sent[0] as { readonly ref: AcpChannelRef }).ref
    transport.push({ version: 1, kind: 'acp.error', ref: wireRef, error: { code: 'CONFLICT', message: 'peer refused the channel' } })
    await expect(opening).rejects.toThrow('peer refused the channel')
    expect(host.closes).toEqual([hostRefOf(wireRef.channelId)])
  })

  it('refuses an unexpected frame before the ack instead of skipping it', async () => {
    const { session, transport } = initiatorFixture()
    const opening = session.open()
    await until(() => transport.sent.length === 1, 'acp.open')
    transport.push({ version: 1, kind: 'acp.frame', ref: ackRefOf(), frame: { ...initializeRequest } })
    await expect(opening).rejects.toThrow(/unexpected acp\.frame/)
  })

  it('refuses to open on the responder side, which never initiates a channel', async () => {
    const { session } = fixture()
    await expect(session.open()).rejects.toThrow(/initiator/)
  })

  it('refuses an inbound acp.open on an initiator session', async () => {
    const { session } = initiatorFixture()
    await expect(session.receive({ version: 1, kind: 'acp.open', ref: ackRefOf() })).rejects.toThrow(/initiator/)
  })

  it('still refuses an unsolicited acp.open_ack on the responder read path', async () => {
    const { session } = fixture()
    await expect(session.receive({ version: 1, kind: 'acp.open_ack', ref: ackRefOf(ENGINE) })).rejects.toThrow(/unexpected acp\.open_ack/)
  })

  it('reports an unknown outcome when the peer never acknowledges and releases the local host channel', async () => {
    const { session, transport, host } = initiatorFixture()
    const opening = session.open({ timeoutMs: 40 })
    await until(() => transport.sent.length === 1, 'acp.open')
    const channelId = (transport.sent[0] as { readonly ref: AcpChannelRef }).ref.channelId
    await expect(opening).rejects.toThrow(/did not acknowledge acp\.open/)
    expect(host.closes).toEqual([hostRefOf(channelId)])
    expect(session.channels).toEqual([])
  })

  it('releases the local host channel when the read rejects before the ack', async () => {
    const { session, transport, host } = initiatorFixture()
    transport.failRead(new Error('the socket died before acp.open_ack'))
    const opening = session.open({ timeoutMs: 50 })
    await expect(opening).rejects.toThrow(/socket died/)
    await until(() => host.closes.length === 1, 'host release')
    const channelId = (transport.sent[0] as { readonly ref: AcpChannelRef }).ref.channelId
    expect(host.closes).toEqual([hostRefOf(channelId)])
    expect(session.channels).toEqual([])
  })

  it('releases the local host channel when the transport refuses to send acp.open', async () => {
    const { session, transport, host } = initiatorFixture()
    transport.failSend(new Error('the transport is closed'))
    const opening = session.open({ timeoutMs: 50 })
    await expect(opening).rejects.toThrow(/transport is closed/)
    await until(() => host.closes.length === 1, 'host release')
    expect(session.channels).toEqual([])
  })

  it('completes a real two-sided open against a responder session', async () => {
    const responderPolicy = makePolicy(TARGET_ENGINE)
    const responderTransport = new FakeTransport(A)
    const { host: responderHost } = makeHost(responderPolicy, GENERATION)
    const responderSession = createTeamsSession({
      negotiation: agreedResponder({ engineInstanceId: TARGET_ENGINE }),
      connectionId: 'conn-b',
      transport: responderTransport,
      host: responderHost,
      policy: responderPolicy,
      engineInstanceId: TARGET_ENGINE,
    })

    const initiatorPolicy = makePolicy(ENGINE)
    const initiatorTransport = new FakeTransport(B)
    const { host: initiatorHost } = makeHost(initiatorPolicy, 11)
    const initiatorSession = createTeamsSession({
      negotiation: agreedInitiator({ engineInstanceId: TARGET_ENGINE }),
      connectionId: 'conn-a',
      transport: initiatorTransport,
      host: initiatorHost,
      policy: initiatorPolicy,
      engineInstanceId: ENGINE,
    })

    const stop = bridge(initiatorTransport, responderTransport)
    const running = responderSession.run()
    try {
      const channel = await initiatorSession.open({ timeoutMs: 3_000 })
      // The real responder accepted the ref and acknowledged with its own local ref.
      expect(channel.peerConnectionId).toBe('conn-b')
      expect(channel.peerChannelId).toBe('teams-conn-b-1')
      expect(responderHost.opens).toHaveLength(1)
      expect(responderHost.opens[0].principal).toEqual(A)
      expect(initiatorHost.opens).toHaveLength(1)
      expect(initiatorHost.opens[0].principal).toEqual(B)
      // Each side's host saw only its own ref, never the peer's.
      expect(responderHost.opens[0].ref.connectionId).toBe('conn-b')
      expect(initiatorHost.opens[0].ref.connectionId).toBe('conn-a')
      expect(initiatorHost.opens[0].ref.engineInstanceId).toBe(ENGINE)
    } finally {
      stop()
      await initiatorSession.close()
      await responderSession.close()
      await running
    }
  })
})
