import { describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../packages/shared/src/agent-services.ts'
import type { AcpChannelRef, AcpDelivery, AcpIngress, HistoryQuery, HistoryRecord } from '../packages/shared/src/acp.ts'
import { AcpError } from '../packages/shared/src/acp.ts'
import type { AcpPolicySnapshot } from '../config/acp-policy.ts'
import type { AcpHost } from '../agent-host/acp-host.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'
import type { HistoryPage, HistoryReadPort } from '../packages/shared/src/teams-state.ts'
import type { WssFrame } from './wss-connection.ts'
import { createTeamsConnectionHistory } from './teams-connection-history.ts'
import {
  createTeamsConnectionLedger,
  createTeamsFrameTransport,
  openTeamsIngress,
  type TeamsFrameSocket,
} from './teams-ingress.ts'
import { runTeamsNegotiation, type TeamsInitiatorOptions } from './teams-negotiation.ts'

const A: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-a' }
const B: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-b' }

const GENERATION = 22
const ENGINE = 'engine-1'
const PEER_REF: AcpChannelRef = { connectionId: 'peer-conn', channelId: 'peer-ch-1', targetGeneration: GENERATION, engineInstanceId: ENGINE }

const policy: AcpPolicySnapshot = {
  revision: 'sha256-policy-snapshot',
  engineInstanceId: ENGINE,
  supported: ['method:session/new'],
  effective: ['method:session/new'],
  denied: [],
}

class MemorySocket implements TeamsFrameSocket {
  readonly closed: Promise<unknown>
  readonly sent: WssFrame[] = []
  closeCount = 0
  peer?: MemorySocket
  private readonly queue: WssFrame[] = []
  private readonly waiters: Array<(frame: WssFrame) => void> = []
  private resolveClosed!: (value: unknown) => void

  constructor() {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  read(): Promise<WssFrame> {
    const next = this.queue.shift()
    if (next !== undefined) return Promise.resolve(next)
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  async send(frame: WssFrame): Promise<void> {
    this.sent.push(frame)
    this.deliver(frame)
  }

  /** Inject a frame as if the peer wrote it. */
  deliver(frame: WssFrame): void {
    const target = this.peer
    if (target === undefined) return
    const waiter = target.waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else target.queue.push(frame)
  }

  async close(): Promise<void> {
    this.closeCount += 1
    this.resolveClosed(undefined)
    this.peer?.resolveClosed(undefined)
  }
}

function socketPair(): { listener: MemorySocket; initiator: MemorySocket } {
  const listener = new MemorySocket()
  const initiator = new MemorySocket()
  listener.peer = initiator
  initiator.peer = listener
  return { listener, initiator }
}

class FakeHost implements AcpHost {
  readonly opens: Array<{ readonly ref: AcpChannelRef; readonly principal: AuthenticatedAgent; readonly policy: AcpPolicySnapshot }> = []
  readonly ingresses: AcpIngress[] = []
  readonly closes: AcpChannelRef[] = []

  async open(input: { readonly ref: AcpChannelRef; readonly principal: AuthenticatedAgent; readonly policy: AcpPolicySnapshot }): Promise<void> {
    this.opens.push(input)
  }

  async receive(ingress: AcpIngress): Promise<void> {
    this.ingresses.push(ingress)
  }

  async read(): Promise<{ readonly frames: readonly AcpDelivery[]; readonly nextSequence: number }> {
    return { frames: [], nextSequence: 0 }
  }

  async close(ref: AcpChannelRef): Promise<void> {
    this.closes.push(ref)
  }
}

function memoryHistory(): AcpHistoryPort & HistoryReadPort & { readonly records: HistoryRecord[] } {
  const records: HistoryRecord[] = []
  return {
    records,
    async append(record) {
      const stored: HistoryRecord = { ...record, recordId: `h-${records.length + 1}`, sequence: records.length + 1 }
      records.push(stored)
      return stored
    },
    async query(query: HistoryQuery): Promise<HistoryPage> {
      return { records: records.filter(record => record.kind === 'connection').slice(0, query.limit) }
    },
  }
}

function initiatorOptions(overrides: Partial<TeamsInitiatorOptions> = {}): TeamsInitiatorOptions {
  return {
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
    ...overrides,
  }
}

function ingressInput(listener: MemorySocket, history: ReturnType<typeof createTeamsConnectionHistory>, host: AcpHost) {
  return {
    connection: { connectionId: 'conn-b', peer: A, connection: listener },
    self: B,
    selfGeneration: GENERATION,
    selfCapabilitiesRevision: 'cap-b',
    selfPolicyRevision: 7,
    allowedRoles: ['master', 'peer'] as const,
    admittedCapabilities: ['method:session/new'],
    host,
    policy,
    engineInstanceId: ENGINE,
    history,
    ledger: createTeamsConnectionLedger(),
    timeoutMs: 2_000,
    pollIntervalMs: 5,
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('Teams production ingress', () => {
  it('codec: carries a Teams frame as a JSON text frame and refuses binary or non-JSON bytes', async () => {
    const { listener, initiator } = socketPair()
    const transport = createTeamsFrameTransport(listener, A)
    expect(transport.peer).toEqual(A)

    await transport.send({ version: 1, kind: 'teams.connection.ready', requestId: 'r', agreement: {} as never })
    expect(listener.sent).toHaveLength(1)
    expect(listener.sent[0].binary).toBe(false)
    expect(JSON.parse(listener.sent[0].bytes.toString('utf8'))).toMatchObject({ kind: 'teams.connection.ready' })

    initiator.deliver({ bytes: Buffer.from('{"ok":true}'), binary: false })
    await expect(transport.read()).resolves.toEqual({ ok: true })

    initiator.deliver({ bytes: Buffer.from('{"ok":true}'), binary: true })
    await expect(transport.read()).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })

    initiator.deliver({ bytes: Buffer.from('not-json'), binary: false })
    await expect(transport.read()).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
  })

  it('ledger: keeps live per-connection truth and refuses a duplicate, unknown or keyless entry', () => {
    const ledger = createTeamsConnectionLedger()
    const base = { remoteAgentId: A.agentId, connectionId: 'c-1', state: 'negotiating' as const, targetGeneration: GENERATION, observedAt: 't0' }
    ledger.open(base)
    expect(ledger.list()).toEqual([base])

    ledger.update({ ...base, state: 'ready', observedAt: 't1', role: 'peer' })
    expect(ledger.list()[0]).toMatchObject({ state: 'ready', role: 'peer', observedAt: 't1' })

    expect(() => ledger.open(base)).toThrow(/already in the ledger/)
    expect(() => ledger.update({ ...base, connectionId: 'c-2' })).toThrow(/not in the ledger/)
    expect(() => ledger.close('c-2', 't2')).toThrow(/not in the ledger/)
    expect(() => ledger.open({ ...base, connectionId: undefined })).toThrow(/requires a connectionId/)

    ledger.close('c-1', 't3')
    expect(ledger.list()[0]).toMatchObject({ connectionId: 'c-1', state: 'closed', observedAt: 't3' })
    expect(ledger.list()[0].error).toBeUndefined()
  })

  it('opens the responder chain, records history, and never sends acp.open or exposes the peer wire ref', async () => {
    const { listener, initiator } = socketPair()
    const host = new FakeHost()
    const store = memoryHistory()
    const history = createTeamsConnectionHistory(store)
    const input = ingressInput(listener, history, host)

    const ingress = openTeamsIngress(input)
    const initiatorTransport = createTeamsFrameTransport(initiator, B)
    const agreed = await runTeamsNegotiation({ options: initiatorOptions(), port: initiatorTransport, timeoutMs: 2_000 })
    const handle = await ingress

    expect(agreed.state).toBe('agreed')
    expect(handle.negotiation.state).toBe('agreed')
    expect(input.ledger.list()[0]).toMatchObject({ state: 'ready', role: 'peer', connectionId: 'conn-b' })

    // D00 amendment A3: the production composer publishes the same engine instance
    // that createTeamsSession later validates, so a remote initiator can name it on
    // acp.open. Without this the initiator has no legal value for the required ref.
    const contextFrame = listener.sent
      .map(frame => JSON.parse(frame.bytes.toString('utf8')) as { kind: string; engineInstanceId?: string })
      .find(frame => frame.kind === 'teams.connection.context')
    expect(contextFrame?.engineInstanceId).toBe(ENGINE)
    expect(agreed.targetEngineInstanceId).toBe(ENGINE)

    // The ingress never opens a channel; the remote initiator does.
    expect(initiator.sent.every(frame => JSON.parse(frame.bytes.toString('utf8')).kind !== 'acp.open')).toBe(true)

    await initiatorTransport.send({ version: 1, kind: 'acp.open', ref: PEER_REF })
    const ack = await initiatorTransport.read()
    expect(ack).toMatchObject({ kind: 'acp.open_ack' })
    const ackRef = (ack as { ref: AcpChannelRef }).ref
    expect(ackRef.channelId).not.toBe(PEER_REF.channelId)
    expect(ackRef.connectionId).toBe('conn-b')
    // R2: the host only ever saw the locally allocated ref.
    expect(host.opens).toHaveLength(1)
    expect(host.opens[0].principal).toEqual(A)
    expect(host.opens[0].ref).toEqual(ackRef)
    await until(() => store.records.some(record => record.event === 'channel.opened'), 'channel.opened history')

    await initiatorTransport.send({ version: 1, kind: 'acp.close', ref: PEER_REF })
    await until(() => store.records.some(record => record.event === 'channel.closed'), 'channel.closed history')
    expect(host.closes).toEqual([ackRef])

    const events = store.records.map(record => record.event)
    expect(events).toContain('connection.negotiated')
    expect(store.records.find(record => record.event === 'connection.negotiated')?.agreement).toMatchObject({
      sourcePolicyRevision: 3,
      targetPolicyRevision: 7,
    })

    await initiator.close()
    await handle.done
    expect(input.ledger.list()[0]).toMatchObject({ state: 'closed' })
  })

  it('records connection.failed, marks the ledger failed and throws when the negotiation is refused', async () => {
    const { listener, initiator } = socketPair()
    const host = new FakeHost()
    const store = memoryHistory()
    const history = createTeamsConnectionHistory(store)
    const input = ingressInput(listener, history, host)

    const ingress = openTeamsIngress(input)
    const initiatorTransport = createTeamsFrameTransport(initiator, B)
    const refused = await runTeamsNegotiation({
      options: initiatorOptions({ requestedCapabilities: ['method:fs/write'] }),
      port: initiatorTransport,
      timeoutMs: 2_000,
    })

    expect(refused.state).toBe('rejected')
    await expect(ingress).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(input.ledger.list()[0]).toMatchObject({ state: 'failed', error: { code: 'CAPABILITY_DENIED' } })
    expect(store.records.map(record => record.event)).toContain('connection.failed')
    expect(host.opens).toHaveLength(0)
  })

  it('records connection.failed when an unexpected inbound frame aborts the read loop', async () => {
    const { listener, initiator } = socketPair()
    const host = new FakeHost()
    const store = memoryHistory()
    const history = createTeamsConnectionHistory(store)
    const input = ingressInput(listener, history, host)

    const ingress = openTeamsIngress(input)
    const initiatorTransport = createTeamsFrameTransport(initiator, B)
    await runTeamsNegotiation({ options: initiatorOptions(), port: initiatorTransport, timeoutMs: 2_000 })
    const handle = await ingress

    // A well-formed Teams frame that is not one of the five ACP channel kinds.
    await initiatorTransport.send({
      version: 1,
      kind: 'teams.connection.context',
      connectionId: 'conn-b',
      targetGeneration: GENERATION,
      capabilitiesRevision: 'cap-b',
      policyRevision: 7,
    })
    await handle.done

    expect(input.ledger.list()[0]).toMatchObject({ state: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
    expect(store.records.filter(record => record.event === 'connection.failed')).toHaveLength(1)
    expect(host.closes).toHaveLength(0)
  })

  it('reports a history write failure through onHistoryFault and never blocks the live chain', async () => {
    const { listener, initiator } = socketPair()
    const host = new FakeHost()
    const faults: string[] = []
    const failing = {
      async record(): Promise<HistoryRecord> {
        throw new AcpError('HISTORY_UNAVAILABLE', 'injected history failure')
      },
      async query(): Promise<HistoryPage> {
        return { records: [] }
      },
    }
    const input = { ...ingressInput(listener, createTeamsConnectionHistory(memoryHistory()), host), history: failing, onHistoryFault: fault => { faults.push(fault.code) } }

    const ingress = openTeamsIngress(input)
    const initiatorTransport = createTeamsFrameTransport(initiator, B)
    const agreed = await runTeamsNegotiation({ options: initiatorOptions(), port: initiatorTransport, timeoutMs: 2_000 })
    const handle = await ingress
    expect(agreed.state).toBe('agreed')
    expect(input.ledger.list()[0]).toMatchObject({ state: 'ready' })
    expect(faults).toContain('HISTORY_UNAVAILABLE')

    await initiator.close()
    await handle.done
  })
})
