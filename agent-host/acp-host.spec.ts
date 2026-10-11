import { describe, expect, it } from 'vitest'
import type { AcpFault, AcpFrame, HistoryRecord } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { AcpDuplex, EngineHandle } from '../control-protocol/engine.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from '../config/acp-policy.ts'
import type { AcpHistoryPort } from './acp-history.ts'
import type { AcpPolicyAssert } from './acp-host.ts'
import { createAcpHost } from './acp-host.ts'

type ClosedResult = { readonly kind: 'eof' } | { readonly kind: 'failed'; readonly error: AcpFault }

class FakeDuplex implements AcpDuplex {
  readonly sent: AcpFrame[] = []
  readonly closed: Promise<ClosedResult>
  private readonly queue: AcpFrame[] = []
  private readonly waiters: { resolve: (frame: AcpFrame) => void; reject: (error: Error) => void }[] = []
  private closedResult: ClosedResult | null = null
  private resolveClosed!: (result: ClosedResult) => void

  constructor() {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  read(): Promise<AcpFrame> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closedResult !== null) return Promise.reject(this.closedError())
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }) })
  }

  send(frame: AcpFrame): Promise<void> {
    this.sent.push(frame)
    return Promise.resolve()
  }

  async close(): Promise<void> { this.end() }

  push(frame: AcpFrame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve(frame)
    else this.queue.push(frame)
  }

  end(): void { this.settle({ kind: 'eof' }) }

  private settle(result: ClosedResult): void {
    if (this.closedResult !== null) return
    this.closedResult = result
    this.resolveClosed(result)
    while (this.waiters.length > 0) this.waiters.shift()!.reject(this.closedError())
  }

  private closedError(): Error {
    return this.closedResult?.kind === 'failed'
      ? new AcpError(this.closedResult.error.code, this.closedResult.error.message)
      : new AcpError('ENGINE_UNAVAILABLE', 'ACP duplex is closed')
  }
}

class FakeHistory implements AcpHistoryPort {
  readonly records: HistoryRecord[] = []
  failOnEvent?: string
  failures: AcpFault[] = []

  async append(record: Omit<HistoryRecord, 'recordId' | 'sequence'>): Promise<HistoryRecord> {
    if (this.failOnEvent !== undefined && record.event === this.failOnEvent) {
      throw new Error(`history append failed for ${record.event}`)
    }
    const stored: HistoryRecord = { ...record, recordId: `record-${this.records.length + 1}`, sequence: this.records.length + 1 }
    this.records.push(stored)
    return stored
  }
}

interface Fixture {
  readonly host: ReturnType<typeof createAcpHost>
  readonly duplex: FakeDuplex
  readonly history: FakeHistory
  readonly faults: AcpFault[]
  readonly exit: () => void
  readonly policy: ReturnType<typeof resolveAcpPolicy>
}

const initializeResult: AcpFrame = {
  jsonrpc: '2.0',
  id: 'runtime-initialize',
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true, audio: false },
      sessionCapabilities: { load: true },
    },
    extension: { keep: true },
  },
}

function makePolicy(blacklist: readonly string[] = []): ReturnType<typeof resolveAcpPolicy> {
  const supported = extractAcpCapabilities(initializeResult, [
    'session/new',
    'session/load',
    'callback:session/request_permission',
  ])
  return resolveAcpPolicy({
    intent: { enabled: true, required: [], blacklist, clientCapabilities: [], callbackExecutor: 'controller' },
    engineInstanceId: 'engine-1',
    supported,
    enforceablePolicies: supported,
  })
}

function makeFixture(policy = makePolicy(), maxDeliveryBacklog = 16): Fixture {
  const duplex = new FakeDuplex()
  let resolveExit!: (result: { readonly code: number | null; readonly signal: string | null }) => void
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(resolve => { resolveExit = resolve })
  const handle: EngineHandle = {
    engineInstanceId: 'engine-1',
    pid: 4242,
    targetGeneration: 9,
    acp: duplex,
    exited,
    stop: async () => ({ kind: 'exited', code: 0, signal: null }),
  }
  const history = new FakeHistory()
  const faults: AcpFault[] = []
  const assertAllowed: AcpPolicyAssert = input => assertAcpAllowed(input)
  const host = createAcpHost({
    handle,
    initializeResult,
    policy,
    history,
    assertAllowed,
    agentId: 'agent-a',
    maxDeliveryBacklog,
    onHistoryFault: fault => faults.push(fault),
  })
  return { host, duplex, history, faults, exit: () => resolveExit({ code: 0, signal: null }), policy }
}

const ref1 = { connectionId: 'connection-1', channelId: 'channel-1', targetGeneration: 9, engineInstanceId: 'engine-1' } as const
const ref2 = { connectionId: 'connection-1', channelId: 'channel-2', targetGeneration: 9, engineInstanceId: 'engine-1' } as const
const principal = { accountId: 'local', scopeId: 'local', agentId: 'peer-agent' } as const

/** Drains the host's engine pump, which awaits the history port per frame. */
async function flush(): Promise<void> {
  for (let index = 0; index < 25; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let index = 0; index < 25; index += 1) await Promise.resolve()
}

async function open(fixture: Fixture, ref = ref1): Promise<void> {
  await fixture.host.open({ ref, principal, policy: fixture.policy })
}

async function initialize(fixture: Fixture, ref = ref1, id: string | number = 1): Promise<AcpFrame> {
  await fixture.host.receive({ ...ref, frame: { jsonrpc: '2.0', id, method: 'initialize', params: { clientCapabilities: {} } } })
  return (await fixture.host.read(ref, 0, 100)).frames[0].frame
}

async function newSession(fixture: Fixture, ref = ref1, id: string | number = 2): Promise<string> {
  await fixture.host.receive({ ...ref, frame: { jsonrpc: '2.0', id, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } } })
  const sent = fixture.duplex.sent[fixture.duplex.sent.length - 1]
  return String(sent.id)
}

async function readFrames(fixture: Fixture, ref = ref1): Promise<readonly AcpFrame[]> {
  return (await fixture.host.read(ref, 0, 100)).frames.map(delivery => delivery.frame)
}

describe('createAcpHost', () => {
  it('serves the genuine initialize result under policy without reinitializing the child', async () => {
    const fixture = makeFixture(makePolicy(['capability:/promptCapabilities/image']))
    await open(fixture)
    const response = await initialize(fixture)
    expect(fixture.duplex.sent).toHaveLength(0)
    expect(response.id).toBe(1)
    expect(response.result).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: false, audio: false }, sessionCapabilities: { load: true } },
      extension: { keep: true },
    })
    expect(fixture.history.records.some(record => record.event === 'initialize')).toBe(true)
  })

  it('accepts the flat AcpIngress and rejects a nested ref shape', async () => {
    const fixture = makeFixture()
    await open(fixture)
    await expect(fixture.host.receive({
      ref: ref1,
      frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    } as unknown as Parameters<typeof fixture.host.receive>[0])).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    const response = await initialize(fixture, ref1, 1)
    expect(response.id).toBe(1)
  })

  it('keeps client ids reversible across concurrent channels with distinct child ids', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await open(fixture, ref2)
    await initialize(fixture, ref1, 1)
    await initialize(fixture, ref2, 1)
    const childOne = await newSession(fixture, ref1, 1)
    const childTwo = await newSession(fixture, ref2, 1)
    expect(childOne).not.toBe(childTwo)

    fixture.duplex.push({ jsonrpc: '2.0', id: childTwo, result: { sessionId: 'session-2' } })
    fixture.duplex.push({ jsonrpc: '2.0', id: childOne, result: { sessionId: 'session-1' } })
    await flush()
    const channelOne = await readFrames(fixture, ref1)
    const channelTwo = await readFrames(fixture, ref2)
    expect(channelOne[0].id).toBe(1)
    expect(channelTwo[0].id).toBe(1)
    expect((channelOne[0].result as { sessionId: string }).sessionId).toBe('session-1')
    expect((channelTwo[0].result as { sessionId: string }).sessionId).toBe('session-2')
  })

  it('enforces Session ownership and rejects a second prompt for one Session', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await open(fixture, ref2)
    await initialize(fixture, ref1, 1)
    await initialize(fixture, ref2, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await expect(fixture.host.receive({
      ...ref2,
      frame: { jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [] } },
    })).rejects.toMatchObject({ code: 'SESSION_OWNERSHIP_CONFLICT' })

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } },
    })
    const sends = fixture.duplex.sent.length
    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'again' }] } },
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fixture.duplex.sent).toHaveLength(sends)

    await expect(fixture.host.receive({
      ...ref2,
      frame: { jsonrpc: '2.0', id: 5, method: 'session/load', params: { sessionId: 'session-1' } },
    })).rejects.toMatchObject({ code: 'SESSION_OWNERSHIP_CONFLICT' })
  })

  it('routes engine callbacks only to the owning Session channel and preserves option ids', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await open(fixture, ref2)
    await initialize(fixture, ref1, 1)
    await initialize(fixture, ref2, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-callback-1',
      method: 'session/request_permission',
      params: { sessionId: 'session-1', options: [{ optionId: 'allow', name: 'Allow' }] },
    })
    await flush()
    const callback = (await readFrames(fixture, ref1))[0]
    expect(callback.method).toBe('session/request_permission')
    expect(callback.id).not.toBe('engine-callback-1')
    expect((callback.params as { options: readonly { optionId: string }[] }).options[0].optionId).toBe('allow')
    expect(await readFrames(fixture, ref2)).toHaveLength(0)

    await expect(fixture.host.receive({
      ...ref2,
      frame: { jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
    })).rejects.toMatchObject({ code: 'SESSION_OWNERSHIP_CONFLICT' })

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
    })
    const forwarded = fixture.duplex.sent[fixture.duplex.sent.length - 1]
    expect(forwarded.id).toBe('engine-callback-1')
    expect(forwarded.result).toMatchObject({ outcome: { outcome: 'selected', optionId: 'allow' } })
  })

  it('keeps two engine callbacks with the same engine id on distinct channels uncrossed', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await open(fixture, ref2)
    await initialize(fixture, ref1, 1)
    await initialize(fixture, ref2, 1)
    const childOne = await newSession(fixture, ref1, 1)
    const childTwo = await newSession(fixture, ref2, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: childOne, result: { sessionId: 'session-1' } })
    fixture.duplex.push({ jsonrpc: '2.0', id: childTwo, result: { sessionId: 'session-2' } })
    await flush()
    await readFrames(fixture, ref1)
    await readFrames(fixture, ref2)

    for (const sessionId of ['session-1', 'session-2']) {
      fixture.duplex.push({
        jsonrpc: '2.0',
        id: 'same-engine-id',
        method: 'session/request_permission',
        params: { sessionId, options: [] },
      })
    }
    await flush()
    const callbackOne = (await readFrames(fixture, ref1))[0]
    const callbackTwo = (await readFrames(fixture, ref2))[0]
    expect(callbackOne.id).not.toBe(callbackTwo.id)
    await fixture.host.receive({ ...ref2, frame: { jsonrpc: '2.0', id: callbackTwo.id as string, result: { outcome: { outcome: 'cancelled' } } } })
    expect(fixture.duplex.sent[fixture.duplex.sent.length - 1].id).toBe('same-engine-id')
    expect(fixture.duplex.sent[fixture.duplex.sent.length - 1].result).toMatchObject({ outcome: { outcome: 'cancelled' } })
  })

  it('cancels explicitly when no controller owns a permission callback', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-callback-2',
      method: 'session/request_permission',
      params: { sessionId: 'missing-session', options: [] },
    })
    await flush()
    const cancellation = fixture.duplex.sent[fixture.duplex.sent.length - 1]
    expect(cancellation.id).toBe('engine-callback-2')
    expect(cancellation.result).toMatchObject({ outcome: { outcome: 'cancelled' } })
    expect(fixture.history.records.some(record => record.event === 'callback.unavailable' && record.outcome === 'unknown')).toBe(true)
  })

  it('errors unsupported callbacks before any executor effect', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-callback-3',
      method: 'fs/read_text_file',
      params: { sessionId: 'session-1', path: '/tmp/x' },
    })
    await flush()
    const error = fixture.duplex.sent[fixture.duplex.sent.length - 1]
    expect(error.id).toBe('engine-callback-3')
    expect(error.error).toBeDefined()
    expect(fixture.history.records.some(record => record.event === 'callback.denied' && record.outcome === 'denied')).toBe(true)
  })

  it('records cancel-requested but confirms the prompt only from its terminal result', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'work' }] } },
    })
    const promptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id as string
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } },
    })
    expect(fixture.duplex.sent[fixture.duplex.sent.length - 1].method).toBe('session/cancel')
    expect(fixture.history.records.some(record => record.event === 'cancel.requested')).toBe(true)
    expect(fixture.history.records.some(record => record.event === 'result.received' && record.sessionId === 'session-1')).toBe(false)

    fixture.duplex.push({ jsonrpc: '2.0', id: promptChild, result: { stopReason: 'cancelled' } })
    await flush()
    const result = (await readFrames(fixture, ref1))[0]
    expect(result.id).toBe(2)
    expect(result.result).toMatchObject({ stopReason: 'cancelled' })
    expect(fixture.history.records.some(record => record.event === 'result.received' && record.outcome === 'completed')).toBe(true)
  })

  it('rejects denied modalities and unsupported methods before any stdin write', async () => {
    const fixture = makeFixture(makePolicy(['capability:/promptCapabilities/image']))
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)
    const sends = fixture.duplex.sent.length

    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'image', data: 'x' }] } },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(fixture.duplex.sent).toHaveLength(sends)

    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: 'session-1' } },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' })
    expect(fixture.duplex.sent).toHaveLength(sends)
  })

  it('rejects stale engine and generation refs and ingress after engine exit', async () => {
    const fixture = makeFixture()
    await expect(fixture.host.open({
      ref: { ...ref1, engineInstanceId: 'other-engine' },
      principal,
      policy: fixture.policy,
    })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    await open(fixture)
    await initialize(fixture, ref1, 1)
    await expect(fixture.host.receive({
      ...ref1,
      targetGeneration: 8,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
    })).rejects.toMatchObject({ code: 'STALE_GENERATION' })

    fixture.exit()
    await flush()
    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/new', params: {} },
    })).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
  })

  it('rejects a request when durable append fails before dispatch', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    fixture.history.failOnEvent = 'request.dispatched'
    const sends = fixture.duplex.sent.length
    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
    })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    expect(fixture.duplex.sent).toHaveLength(sends)
  })

  it('delivers the real result and reports a result-history write failure separately', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 2)
    fixture.history.failOnEvent = 'result.received'
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    const delivery = (await readFrames(fixture, ref1))[0]
    expect(delivery.id).toBe(2)
    expect(delivery.result).toMatchObject({ sessionId: 'session-1' })
    expect(fixture.faults.map(fault => fault.code)).toEqual(['HISTORY_UNAVAILABLE'])
  })

  it('marks in-flight work unknown when the engine exits', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'work' }] } },
    })
    fixture.exit()
    await flush()
    const unknown = (await readFrames(fixture, ref1))[0]
    expect(unknown.id).toBe(2)
    expect((unknown.error as { data: { code: string } }).data.code).toBe('RESULT_UNKNOWN')
    expect(fixture.history.records.some(record => record.event === 'result.unknown' && record.outcome === 'unknown')).toBe(true)
  })

  it('bounds live delivery and records overflow instead of dropping it silently', async () => {
    const fixture = makeFixture(makePolicy(), 1)
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    fixture.duplex.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { kind: 'one' } } })
    fixture.duplex.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { kind: 'two' } } })
    await flush()
    const frames = await readFrames(fixture, ref1)
    expect(frames).toHaveLength(1)
    expect(fixture.history.records.some(record => record.event === 'delivery.overflow')).toBe(true)
  })

  it('answers an undeliverable permission callback instead of stranding the engine', async () => {
    const fixture = makeFixture(makePolicy(), 1)
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    // The unread session/new result fills the single backlog slot.
    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-callback-overflow',
      method: 'session/request_permission',
      params: { sessionId: 'session-1', options: [{ optionId: 'allow', name: 'Allow' }] },
    })
    await flush()
    const cancellation = fixture.duplex.sent[fixture.duplex.sent.length - 1]
    expect(cancellation.id).toBe('engine-callback-overflow')
    expect(cancellation.result).toMatchObject({ outcome: { outcome: 'cancelled' } })
    expect(fixture.history.records.some(record => record.event === 'delivery.overflow')).toBe(true)
  })

  it('records an unroutable engine notification instead of dropping it', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'no-owner', update: { kind: 'x' } } })
    await flush()
    expect(fixture.history.records.some(record => record.event === 'notification.unrouted')).toBe(true)
    expect(await readFrames(fixture, ref1)).toHaveLength(0)
  })

  it('marks pending requests and callbacks unknown when a channel closes', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'work' }] } },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-callback-close',
      method: 'session/request_permission',
      params: { sessionId: 'session-1', options: [] },
    })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.close(ref1)
    const frames = await readFrames(fixture, ref1)
    expect(frames).toHaveLength(1)
    expect((frames[0].error as { data: { code: string } }).data.code).toBe('RESULT_UNKNOWN')
    expect(fixture.duplex.sent.some(frame => frame.id === 'engine-callback-close' && frame.result !== undefined)).toBe(true)
    expect(fixture.history.records.some(record => record.event === 'callback.unknown')).toBe(true)
    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 4, method: 'session/new', params: {} },
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
