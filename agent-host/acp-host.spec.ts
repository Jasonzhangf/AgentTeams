import { describe, expect, it } from 'vitest'
import type { AcpFault, AcpFrame, HistoryRecord } from '../packages/shared/src/acp.ts'
import { AcpError } from '../packages/shared/src/acp.ts'
import type { ConsoleSessionEventView } from '../packages/shared/src/console-api.ts'
import type { AcpDuplex, EngineHandle } from '../packages/shared/src/engine.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from '../config/acp-policy.ts'
import type { AcpHistoryPort } from './acp-history.ts'
import type { AcpPolicyAssert } from './acp-host.ts'
import { adjudicatePermissionReply, createAcpHost, isRetryablePromptFault, projectPermissionOptions } from './acp-host.ts'

type ClosedResult = { readonly kind: 'eof' } | { readonly kind: 'failed'; readonly error: AcpFault }

class FakeDuplex implements AcpDuplex {
  readonly sent: AcpFrame[] = []
  readonly closed: Promise<ClosedResult>
  private readonly queue: AcpFrame[] = []
  private readonly waiters: { resolve: (frame: AcpFrame) => void; reject: (error: Error) => void }[] = []
  private closedResult: ClosedResult | null = null
  private resolveClosed!: (result: ClosedResult) => void
  private sendGate?: Promise<void>

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
    if (this.sendGate !== undefined) {
      return this.sendGate.then(() => { this.sent.push(frame) })
    }
    this.sent.push(frame)
    return Promise.resolve()
  }

  /** Hold every engine send until the returned gate is released or rejected. */
  holdSends(): { release: () => void; reject: (error: Error) => void } {
    let release!: () => void
    let reject!: (error: Error) => void
    this.sendGate = new Promise<void>((resolve, fail) => {
      release = resolve
      reject = fail
    })
    return {
      release: () => { this.sendGate = undefined; release() },
      reject: (error: Error) => { this.sendGate = undefined; reject(error) },
    }
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
  /** While set, every append waits on this gate, so a close's durable settling stays in flight. */
  private wait?: Promise<void>
  private openGate?: () => void

  /**
   * Hold every further append until the returned function is called. This makes the window
   * between a close marking its channel closed and releasing the Session ids observable.
   */
  holdAppends(): () => void {
    let openGate!: () => void
    this.wait = new Promise<void>(resolve => { openGate = resolve })
    this.openGate = openGate
    return () => { this.wait = undefined; this.openGate = undefined; openGate() }
  }

  async append(record: Omit<HistoryRecord, 'recordId' | 'sequence'>): Promise<HistoryRecord> {
    if (this.wait !== undefined) await this.wait
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

function makeFixture(policy = makePolicy(), maxDeliveryBacklog = 16, promptRetry?: { readonly maxAttempts?: number; readonly sleep?: (milliseconds: number) => Promise<void> }): Fixture {
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
    ...(promptRetry === undefined ? {} : { promptRetry }),
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

  it('rejects a notification-form initialize instead of re-initializing the engine', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const sends = fixture.duplex.sent.length

    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', method: 'initialize', params: { clientCapabilities: {} } },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' })

    expect(fixture.duplex.sent).toHaveLength(sends)
    expect(fixture.history.records.filter(record => record.event === 'initialize')).toHaveLength(1)
    expect(fixture.history.records.some(record => record.event === 'notification.dispatched')).toBe(false)
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

    await expect(fixture.host.receive({
      ...ref2,
      frame: { jsonrpc: '2.0', id: 6, method: 'session/cancel', params: { sessionId: 'session-1' } },
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
      params: { sessionId: 'session-1', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
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

  it('reports the Sessions an open channel holds and forgets them when it closes', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    // Before any Session exists, the host holds none.
    expect(fixture.host.openedSessions()).toEqual([])
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    expect(fixture.host.openedSessions()).toEqual(['session-1'])
    // The channel's own close releases the Session, so it must not be reported after it.
    await fixture.host.close(ref1)
    expect(fixture.host.openedSessions()).toEqual([])
  })

  it('reports no Session after the engine ends the channel it owns', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    expect(fixture.host.openedSessions()).toEqual(['session-1'])
    // The engine ended, so the channel holds no Session any more. A publisher must not report a
    // Session whose engine no longer runs, and it cannot ask the channel that just died.
    fixture.exit()
    await flush()
    expect(fixture.host.openedSessions()).toEqual([])
  })

  it('reports a closed channel as holding no Session while its close is still settling durably', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    expect(fixture.host.openedSessions()).toEqual(['session-1'])
    // `close()` marks the channel closed and only then awaits the durable settle calls, so an
    // observer that samples the host inside that window must not see the closed channel's
    // Session. The gate keeps the settle in flight until the sample has read the host.
    const release = fixture.history.holdAppends()
    const closing = fixture.host.close(ref1)
    try {
      await Promise.resolve()
      expect(fixture.host.openedSessions()).toEqual([])
    } finally {
      release()
    }
    await closing
    expect(fixture.host.openedSessions()).toEqual([])
  })

  it('projects ordered Session events from the real prompt, update, tool and permission frames', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] },
      },
    })
    const promptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id

    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read', rawInput: { path: '/tmp/x' }, status: 'pending' },
      },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          title: 'read',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
      },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-permission-events',
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'call-1', title: 'read' },
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    await flush()

    const pending = fixture.host.pendingPermissions()
    expect(pending).toHaveLength(1)
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: pending[0].permissionId, result: { outcome: { outcome: 'selected', optionId: 'once' } } },
    })
    fixture.duplex.push({ jsonrpc: '2.0', id: promptChild, result: { stopReason: 'end_turn' } })
    await flush()

    const events = fixture.host.sessionEvents?.() ?? []
    expect(events.map(event => [event.kind, event.state])).toEqual([
      ['message', 'completed'],
      ['part', 'completed'],
      ['part', 'completed'],
      ['tool', 'completed'],
      ['permission', 'resolved'],
      ['message', 'completed'],
      ['final', 'completed'],
    ])
    expect(events[0]).toMatchObject({ role: 'user', state: 'completed' })
    expect(events[1]).toMatchObject({ partType: 'text', text: 'hello', state: 'completed' })
    expect(events[2]).toMatchObject({ partType: 'text', text: 'hi', state: 'completed' })
    expect(events[3]).toMatchObject({ callId: 'call-1', tool: 'read', state: 'completed', output: 'done' })
    expect(events[4]).toMatchObject({ permissionId: pending[0].permissionId, state: 'resolved', decision: 'once' })
    expect(events[5]).toMatchObject({ role: 'assistant', state: 'completed' })
    expect(events[6]).toMatchObject({ state: 'completed', finish: 'end_turn' })

    // The projection leaves with the Session ids it belongs to.
    await fixture.host.close(ref1)
    expect(fixture.host.sessionEvents?.() ?? []).toEqual([])
  })

  it('admits a second Session prompt while one Session is already in flight (no cross-Session CONFLICT)', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const childA = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: childA, result: { sessionId: 'session-a' } })
    const childB = await newSession(fixture, ref1, 2)
    fixture.duplex.push({ jsonrpc: '2.0', id: childB, result: { sessionId: 'session-b' } })
    await flush()
    await readFrames(fixture, ref1)

    // Session A prompt goes in flight.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-a', prompt: [{ type: 'text', text: 'a' }] } },
    })
    // Session B prompt on the same shared channel must not be blocked by A.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-b', prompt: [{ type: 'text', text: 'b' }] } },
    })
    const sends = fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')
    expect(sends).toHaveLength(2)

    // A second concurrent prompt on the same Session still fails with CONFLICT.
    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 'session-a', prompt: [{ type: 'text', text: 'a-again' }] } },
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')).toHaveLength(2)

    // Each in-flight prompt keeps its own identity: a text update and a response for one Session
    // must land on that Session's own message, never on the other Session's in-flight prompt.
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-b', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'reply-b' } } },
    })
    await flush()
    fixture.duplex.push({ jsonrpc: '2.0', id: sends[1].id, result: { stopReason: 'end_turn' } })
    fixture.duplex.push({ jsonrpc: '2.0', id: sends[0].id, result: { stopReason: 'end_turn' } })
    await flush()

    const events = fixture.host.sessionEvents?.() ?? []
    const textsOf = (sessionId: string): string[] => events
      .filter(event => event.sessionId === sessionId && event.kind === 'part' && event.partType === 'text')
      .map(event => (event as { text?: string }).text ?? '')
    // The engine's text update for B belongs to B; A keeps only its own prompt text.
    expect(textsOf('session-b')).toEqual(['b', 'reply-b'])
    expect(textsOf('session-a')).toEqual(['a'])
    expect(events.some(event => event.sessionId === 'session-b' && event.kind === 'final' && event.state === 'completed')).toBe(true)
    expect(events.some(event => event.sessionId === 'session-a' && event.kind === 'final' && event.state === 'completed')).toBe(true)

    // Both responses released their own entry, so each Session admits a new prompt again.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId: 'session-a', prompt: [{ type: 'text', text: 'a2' }] } },
    })
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: 'session-b', prompt: [{ type: 'text', text: 'b2' }] } },
    })
    expect(fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')).toHaveLength(4)
  })

  it('isolates a shared tool call id by owning Session instead of merging fields', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const childA = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: childA, result: { sessionId: 'session-a' } })
    const childB = await newSession(fixture, ref1, 2)
    fixture.duplex.push({ jsonrpc: '2.0', id: childB, result: { sessionId: 'session-b' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-a', prompt: [{ type: 'text', text: 'a' }] } },
    })
    const aPromptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-b', prompt: [{ type: 'text', text: 'b' }] } },
    })
    const bPromptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id

    // Both Sessions emit the same engine call id with their own title and input.
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-a', update: { sessionUpdate: 'tool_call', toolCallId: 'call-shared', title: 'read-a', rawInput: { path: '/tmp/a' }, status: 'pending' } },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-b', update: { sessionUpdate: 'tool_call', toolCallId: 'call-shared', title: 'write-b', rawInput: { path: '/tmp/b' }, status: 'pending' } },
    })
    await flush()

    // A status-only update for B must inherit B's own tool and input, never A's.
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-b', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-shared', status: 'running' } },
    })
    await flush()

    const events = fixture.host.sessionEvents?.() ?? []
    const toolRows = events.filter((event): event is Extract<ConsoleSessionEventView, { readonly kind: 'tool' }> =>
      event.kind === 'tool' && event.callId === 'call-shared')
    expect(toolRows).toHaveLength(2)
    const a = toolRows.find(event => event.sessionId === 'session-a')
    const b = toolRows.find(event => event.sessionId === 'session-b')
    expect(a).toMatchObject({ state: 'pending', tool: 'read-a', input: { path: '/tmp/a' }, callId: 'call-shared' })
    expect(b).toMatchObject({ state: 'running', tool: 'write-b', input: { path: '/tmp/b' }, callId: 'call-shared' })
    expect(a!.eventId).not.toBe(b!.eventId)
    expect(a!.partId).not.toBe(b!.partId)

    // Completing each Session keeps its own row, fields and output.
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-a', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-shared', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a-output' } }] } },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-b', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-shared', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'b-output' } }] } },
    })
    await flush()

    const completed = (fixture.host.sessionEvents?.() ?? []).filter((event): event is Extract<ConsoleSessionEventView, { readonly kind: 'tool' }> =>
      event.kind === 'tool' && event.callId === 'call-shared')
    expect(completed).toHaveLength(2)
    expect(completed.find(event => event.sessionId === 'session-a'))
      .toMatchObject({ state: 'completed', tool: 'read-a', input: { path: '/tmp/a' }, output: 'a-output', callId: 'call-shared' })
    expect(completed.find(event => event.sessionId === 'session-b'))
      .toMatchObject({ state: 'completed', tool: 'write-b', input: { path: '/tmp/b' }, output: 'b-output', callId: 'call-shared' })

    fixture.duplex.push({ jsonrpc: '2.0', id: aPromptChild, result: { stopReason: 'end_turn' } })
    fixture.duplex.push({ jsonrpc: '2.0', id: bPromptChild, result: { stopReason: 'end_turn' } })
    await flush()
  })

  it('keeps an earlier prompt tool row when the same Session reuses a call id in a later prompt', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'first' }] } },
    })
    const firstPromptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call-shared', title: 'read-first', rawInput: { path: '/tmp/first' }, status: 'pending' } },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-shared', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'first-output' } }] } },
    })
    fixture.duplex.push({ jsonrpc: '2.0', id: firstPromptChild, result: { stopReason: 'end_turn' } })
    await flush()

    const firstTools = (fixture.host.sessionEvents?.() ?? []).filter((event): event is Extract<ConsoleSessionEventView, { readonly kind: 'tool' }> =>
      event.kind === 'tool' && event.callId === 'call-shared')
    expect(firstTools).toHaveLength(1)
    expect(firstTools[0]).toMatchObject({ sessionId: 'session-1', tool: 'read-first', input: { path: '/tmp/first' }, output: 'first-output', state: 'completed', callId: 'call-shared' })

    // A later prompt reuses the same engine call id and carries its own title, input and output.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'second' }] } },
    })
    const secondPromptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call-shared', title: 'write-second', rawInput: { path: '/tmp/second' }, status: 'pending' } },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-shared', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'second-output' } }] } },
    })
    fixture.duplex.push({ jsonrpc: '2.0', id: secondPromptChild, result: { stopReason: 'end_turn' } })
    await flush()

    const toolRows = (fixture.host.sessionEvents?.() ?? []).filter((event): event is Extract<ConsoleSessionEventView, { readonly kind: 'tool' }> =>
      event.kind === 'tool' && event.callId === 'call-shared')
    expect(toolRows).toHaveLength(2)
    const earlier = toolRows.find(event => event.messageId === firstTools[0].messageId)
    const later = toolRows.find(event => event.messageId !== firstTools[0].messageId)
    expect(earlier).toMatchObject({ tool: 'read-first', input: { path: '/tmp/first' }, output: 'first-output', state: 'completed', callId: 'call-shared' })
    expect(later).toMatchObject({ tool: 'write-second', input: { path: '/tmp/second' }, output: 'second-output', state: 'completed', callId: 'call-shared' })
    expect(earlier!.eventId).not.toBe(later!.eventId)
    expect(earlier!.partId).not.toBe(later!.partId)
    expect(earlier!.messageId).not.toBe(later!.messageId)
    expect(earlier!.callId).toBe('call-shared')
    expect(later!.callId).toBe('call-shared')
  })

  it('reserves same-Session admission before the first history append so an overlapping prompt is rejected', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    // Hold the durable request append so the first prompt is still waiting at the first
    // asynchronous boundary. A second prompt for the same Session must not pass admission
    // while that reservation is held.
    const release = fixture.history.holdAppends()
    const first = fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'first' }] } },
    })
    await flush()
    const second = fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'second' }] } },
    })
    release()

    await expect(second).rejects.toMatchObject({ code: 'CONFLICT' })
    await first
    const sends = fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')
    expect(sends).toHaveLength(1)
    expect(sends[0].params).toMatchObject({ sessionId: 'session-1', prompt: [{ type: 'text', text: 'first' }] })
  })

  it('rolls back only the failed dispatch rows and preserves another Session concurrent events', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const childA = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: childA, result: { sessionId: 'session-a' } })
    const childB = await newSession(fixture, ref1, 2)
    fixture.duplex.push({ jsonrpc: '2.0', id: childB, result: { sessionId: 'session-b' } })
    await flush()
    await readFrames(fixture, ref1)

    // Session A goes in flight and emits a tool event before B starts.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-a', prompt: [{ type: 'text', text: 'a' }] } },
    })
    const aPromptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-a', update: { sessionUpdate: 'tool_call', toolCallId: 'call-a', title: 'read', rawInput: { path: '/tmp/a' }, status: 'pending' } },
    })
    await flush()

    // B reaches its engine send and stops on a deferred gate, then fails after A has
    // advanced. This is the window where a length-based rollback would remove A's rows.
    const gate = fixture.duplex.holdSends()
    const bPrompt = fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-b', prompt: [{ type: 'text', text: 'b' }] } },
    })
    await flush()

    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-a',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-a',
          title: 'read',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
      },
    })
    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-permission-a',
      method: 'session/request_permission',
      params: {
        sessionId: 'session-a',
        toolCall: { toolCallId: 'call-a', title: 'read' },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      },
    })
    await flush()
    const pendingA = fixture.host.pendingPermissions().find(item => item.sessionId === 'session-a')
    expect(pendingA).toBeDefined()

    gate.reject(new Error('engine send failed'))
    await expect(bPrompt).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })

    // B's own projection rows are removed, while A's tool and permission events survive.
    const events = fixture.host.sessionEvents?.() ?? []
    expect(events.filter(event => event.sessionId === 'session-b')).toEqual([])
    expect(events.some(event => event.sessionId === 'session-a' && event.kind === 'tool' && event.callId === 'call-a')).toBe(true)
    expect(events.some(event => event.sessionId === 'session-a' && event.kind === 'permission' && event.permissionId === pendingA?.permissionId)).toBe(true)

    // A can still resolve its permission and prompt, and its final event remains intact.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: pendingA!.permissionId, result: { outcome: { outcome: 'selected', optionId: 'once' } } },
    })
    fixture.duplex.push({ jsonrpc: '2.0', id: aPromptChild, result: { stopReason: 'end_turn' } })
    await flush()

    const finalEvents = fixture.host.sessionEvents?.() ?? []
    expect(finalEvents.some(event => event.sessionId === 'session-a' && event.kind === 'final' && event.state === 'completed')).toBe(true)
    expect(finalEvents.filter(event => event.sessionId === 'session-b')).toEqual([])
  })

  it('projects real ACP nested ToolCallContent for completed and failed tool events', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'read /etc/hosts' }] } },
    })
    const promptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id

    // Completed tool with the real nested content shape from the OpenCode ACP sample.
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          title: 'read',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: '127.0.0.1\tlocalhost' } }],
        },
      },
    })
    // Failed tool with nested error content.
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-2',
          title: 'read',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'error', text: 'permission denied' } }],
        },
      },
    })
    await flush()

    const events = fixture.host.sessionEvents?.() ?? []
    const completed = events.find(event => event.kind === 'tool' && event.callId === 'call-1')
    const failed = events.find(event => event.kind === 'tool' && event.callId === 'call-2')
    expect(completed).toMatchObject({ state: 'completed', output: '127.0.0.1\tlocalhost' })
    expect(failed).toMatchObject({ state: 'error', error: 'permission denied' })

    // The prompt resolves so the channel can release.
    fixture.duplex.push({ jsonrpc: '2.0', id: promptChild, result: { stopReason: 'end_turn' } })
    await flush()
  })

  it('records missing completed tool content as engine.protocol-fault, never an empty success', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'read /etc/hosts' }] } },
    })

    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'read', status: 'completed' },
      },
    })
    await flush()
    const fault = fixture.history.records.find(record => record.event === 'engine.protocol-fault')
    expect(fault?.error?.message).toContain('ToolCallContent')
    // A failed projection must not surface as a successful empty tool event in the projection.
    const projected = (fixture.host.sessionEvents?.() ?? []).filter(event => event.eventId !== undefined)
    expect(projected).not.toContainEqual(
      expect.objectContaining({ kind: 'tool', state: 'completed', output: '' }))
  })

  it('records an unsupported tool content block as engine.protocol-fault', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'read /etc/hosts' }] } },
    })

    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-2',
          title: 'read',
          status: 'completed',
          content: [{ type: 'text', text: 'wrong shape' }],
        },
      },
    })
    await flush()
    const fault = fixture.history.records.find(record => record.event === 'engine.protocol-fault')
    expect(fault?.error?.code).toBe('INVALID_ACP_FRAME')
    expect(fault?.error?.message).toContain('unsupported or malformed')
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
      params: { sessionId: 'session-1', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
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

  it('retries a failed prompt that produced no output on the same Session and answers once', async () => {
    const fixture = makeFixture(makePolicy(), 16, { maxAttempts: 3, sleep: async () => {} })
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } },
    })
    const firstChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    // The engine fails the first attempt as a JSON-RPC internal error: transient, no output.
    fixture.duplex.push({ jsonrpc: '2.0', id: firstChild, error: { code: -32603, message: 'Internal error' } })
    await flush()
    // The retry takes a fresh child id under the same client request, and the client sees
    // nothing yet: the in-flight prompt is still one prompt.
    const retried = fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')
    expect(retried).toHaveLength(2)
    expect(retried[1].id).not.toBe(firstChild)
    expect(await readFrames(fixture, ref1)).toHaveLength(0)

    fixture.duplex.push({ jsonrpc: '2.0', id: retried[1].id, result: { stopReason: 'end_turn' } })
    await flush()
    const frames = await readFrames(fixture, ref1)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: 2, result: { stopReason: 'end_turn' } })
    expect(frames[0].error).toBeUndefined()
    const events = fixture.host.sessionEvents?.() ?? []
    const finals = events.filter(event => event.kind === 'final')
    expect(finals).toHaveLength(1)
    expect(finals[0].state).toBe('completed')
  })

  it('does not retry a prompt that already produced output, and reports its real failure', async () => {
    const fixture = makeFixture(makePolicy(), 16, { maxAttempts: 3, sleep: async () => {} })
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } },
    })
    const promptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'partial' } } },
    })
    await flush()
    fixture.duplex.push({ jsonrpc: '2.0', id: promptChild, error: { code: -32603, message: 'Internal error' } })
    await flush()
    // Output was already published, so repeating the turn would duplicate it: one failure.
    expect(fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')).toHaveLength(1)
    const terminal = (await readFrames(fixture, ref1)).filter(frame => frame.id === 2)
    expect(terminal).toHaveLength(1)
    expect(terminal[0].error).toBeDefined()
    const events = fixture.host.sessionEvents?.() ?? []
    expect(events.filter(event => event.kind === 'final' && event.state === 'failed')).toHaveLength(1)
    expect(events.some(event => event.kind === 'part' && event.partType === 'text' && (event as { text?: string }).text === 'partial')).toBe(true)
  })

  it('stops at the bounded attempt count and reports the last real failure', async () => {
    const fixture = makeFixture(makePolicy(), 16, { maxAttempts: 3, sleep: async () => {} })
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } },
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dispatched = fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')
      expect(dispatched).toHaveLength(attempt)
      fixture.duplex.push({ jsonrpc: '2.0', id: dispatched[dispatched.length - 1].id, error: { code: -32603, message: 'Internal error' } })
      await flush()
    }
    // Exactly the bound was spent, and the client is answered once with the real fault.
    expect(fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')).toHaveLength(3)
    const terminal = (await readFrames(fixture, ref1)).filter(frame => frame.id === 2)
    expect(terminal).toHaveLength(1)
    expect(terminal[0].error).toBeDefined()
    const events = fixture.host.sessionEvents?.() ?? []
    expect(events.filter(event => event.kind === 'final' && event.state === 'failed')).toHaveLength(1)
    // Admission is released: the same Session accepts a new prompt afterwards.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'again' }] } },
    })
    expect(fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')).toHaveLength(4)
  })

  it('does not retry a prompt after a tool call was already published', async () => {
    const fixture = makeFixture(makePolicy(), 16, { maxAttempts: 3, sleep: async () => {} })
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } },
    })
    const promptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    fixture.duplex.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read', rawInput: { path: '/tmp/x' }, status: 'pending' },
      },
    })
    await flush()
    fixture.duplex.push({ jsonrpc: '2.0', id: promptChild, error: { code: -32603, message: 'Internal error' } })
    await flush()
    // A published tool call is an execution side effect: repeating the turn could run it twice.
    expect(fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')).toHaveLength(1)
    const terminal = (await readFrames(fixture, ref1)).filter(frame => frame.id === 2)
    expect(terminal).toHaveLength(1)
    expect(terminal[0].error).toBeDefined()
    const events = fixture.host.sessionEvents?.() ?? []
    expect(events.some(event => event.kind === 'tool' && event.callId === 'call-1')).toBe(true)
    expect(events.filter(event => event.kind === 'final' && event.state === 'failed')).toHaveLength(1)
  })

  it('does not dispatch a retry into a channel that closed during the backoff', async () => {
    let releaseSleep!: () => void
    const sleepGate = new Promise<void>(resolve => { releaseSleep = resolve })
    const fixture = makeFixture(makePolicy(), 16, { maxAttempts: 3, sleep: async () => { await sleepGate } })
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } },
    })
    const promptChild = fixture.duplex.sent[fixture.duplex.sent.length - 1].id
    fixture.duplex.push({ jsonrpc: '2.0', id: promptChild, error: { code: -32603, message: 'Internal error' } })
    await flush()
    // The backoff is still pending when the client closes its channel. The retry must not
    // fabricate a new engine dispatch or a delivery for a client that is no longer there.
    await fixture.host.close(ref1)
    releaseSleep()
    await flush()
    expect(fixture.duplex.sent.filter(frame => frame.method === 'session/prompt')).toHaveLength(1)
    expect(await readFrames(fixture, ref1)).toHaveLength(0)
  })
})

describe('prompt retry fault classification', () => {
  it('refuses a retry for a -32603 wrapped 401 or 403', () => {
    expect(isRetryablePromptFault({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', detail: { status: 401 } } })).toBe(false)
    expect(isRetryablePromptFault({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'HTTP 403 Forbidden' } })).toBe(false)
  })

  it('keeps transient 429 and 503 failures retryable', () => {
    expect(isRetryablePromptFault({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', detail: { status: 429 } } })).toBe(true)
    expect(isRetryablePromptFault({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'HTTP 503 Service Unavailable' } })).toBe(true)
  })
})

describe('permission option decision path (A2.6)', () => {
  const engineCallback: AcpFrame = {
    jsonrpc: '2.0',
    id: 'engine-permission',
    method: 'session/request_permission',
    params: {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-1', title: 'read' },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  }

  it('projects the engine-supplied option set verbatim and never mints an option', () => {
    expect(projectPermissionOptions(engineCallback)).toEqual([
      { optionId: 'once', name: 'Allow once', kind: 'once' },
      { optionId: 'always', name: 'Allow always', kind: 'always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject' },
    ])
    // An engine that offers no options gets no fabricated set: the additive field stays absent.
    expect(projectPermissionOptions({ jsonrpc: '2.0', id: 'x', method: 'session/request_permission', params: { sessionId: 's', options: [] } })).toBeUndefined()
    expect(projectPermissionOptions({ jsonrpc: '2.0', id: 'x', method: 'session/request_permission', params: { sessionId: 's' } })).toBeUndefined()
    // A malformed or ambiguous engine set fails at this owning boundary.
    for (const params of [
      { sessionId: 's', options: [{ optionId: 'a', name: 'A', kind: 'maybe' }] },
      { sessionId: 's', options: [{ optionId: '', name: 'A', kind: 'allow_once' }] },
      { sessionId: 's', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'a', name: 'B', kind: 'reject_once' }] },
      { sessionId: 's', options: [{ optionId: 'a', name: 'A' }] },
      { sessionId: 's', options: 'allow' },
    ]) {
      expect(() => projectPermissionOptions({ jsonrpc: '2.0', id: 'x', method: 'session/request_permission', params }))
        .toThrowError(/INVALID_ACP_FRAME|permission option/)
    }
  })

  it('adjudicates a reply against the real option set and never auto-approves', () => {
    const options = projectPermissionOptions(engineCallback)!
    expect(adjudicatePermissionReply({ outcome: { outcome: 'selected', optionId: 'always' } }, options))
      .toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(adjudicatePermissionReply({ outcome: { outcome: 'cancelled' } }, options))
      .toEqual({ outcome: { outcome: 'cancelled' } })
    // An option the engine never offered is refused; the host never invents a selection.
    expect(() => adjudicatePermissionReply({ outcome: { outcome: 'selected', optionId: 'never-offered' } }, options))
      .toThrowError(/not an option the engine offered/)
    // Selecting anything while the engine offered no options is refused, not guessed.
    expect(() => adjudicatePermissionReply({ outcome: { outcome: 'selected', optionId: 'once' } }, undefined))
      .toThrowError(/not an option the engine offered/)
    for (const result of [{ outcome: { outcome: 'selected' } }, { outcome: { outcome: 'approved' } }, { outcome: 'selected' }, 'selected']) {
      expect(() => adjudicatePermissionReply(result, options)).toThrowError(/permission reply/)
    }
  })

  it('delivers the engine optionId end to end and refuses a foreign selection', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    fixture.duplex.push(engineCallback)
    await flush()
    const callback = (await readFrames(fixture, ref1))[0]
    expect(projectPermissionOptions(callback)).toEqual([
      { optionId: 'once', name: 'Allow once', kind: 'once' },
      { optionId: 'always', name: 'Allow always', kind: 'always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject' },
    ])

    // A selection the engine never offered is refused and the callback stays answerable.
    await expect(fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'foreign' } } },
    })).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(fixture.duplex.sent.some(frame => frame.id === 'engine-permission')).toBe(false)

    // The engine's own optionId reaches the engine unchanged.
    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'always' } } },
    })
    const forwarded = fixture.duplex.sent[fixture.duplex.sent.length - 1]
    expect(forwarded.id).toBe('engine-permission')
    expect(forwarded.result).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(fixture.history.records.some(record => record.event === 'callback.reply')).toBe(true)
  })

  it('refuses a malformed engine option set instead of forwarding an unactionable callback', async () => {
    const fixture = makeFixture()
    await open(fixture, ref1)
    await initialize(fixture, ref1, 1)
    const child = await newSession(fixture, ref1, 1)
    fixture.duplex.push({ jsonrpc: '2.0', id: child, result: { sessionId: 'session-1' } })
    await flush()
    await readFrames(fixture, ref1)

    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-permission-bad',
      method: 'session/request_permission',
      params: { sessionId: 'session-1', options: [{ optionId: 'a', name: 'A', kind: 'maybe' }] },
    })
    await flush()
    expect(await readFrames(fixture, ref1)).toHaveLength(0)
    const refusal = fixture.duplex.sent[fixture.duplex.sent.length - 1]
    expect(refusal.id).toBe('engine-permission-bad')
    expect(refusal.error).toBeDefined()
    expect(fixture.history.records.some(record => record.event === 'callback.denied' && record.outcome === 'denied')).toBe(true)
  })

  it('reports the open permission callback and the owning channel, and reports neither once the channel closes', async () => {
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
      id: 'engine-permission-open',
      method: 'session/request_permission',
      params: { sessionId: 'session-1', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    })
    await flush()
    const callback = (await readFrames(fixture, ref1))[0]

    // The controller sees the id it received with the request, and the engine's real option set.
    expect(fixture.host.pendingPermissions()).toEqual([{
      ref: ref1,
      sessionId: 'session-1',
      permissionId: callback.id,
      options: [{ optionId: 'allow', name: 'Allow', kind: 'once' }],
    }])
    expect(fixture.host.channelForSession('session-1')).toEqual(ref1)
    expect(fixture.host.channelForSession('session-unknown')).toBeUndefined()
    // A Session the other channel never adopted has no owner, so no ref is invented for it.
    expect(fixture.host.channelForSession('session-2')).toBeUndefined()

    await fixture.host.receive({
      ...ref1,
      frame: { jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
    })
    expect(fixture.host.pendingPermissions()).toEqual([])

    fixture.duplex.push({
      jsonrpc: '2.0',
      id: 'engine-permission-late',
      method: 'session/request_permission',
      params: { sessionId: 'session-1', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    })
    await flush()
    await readFrames(fixture, ref1)
    expect(fixture.host.pendingPermissions()).toHaveLength(1)

    await fixture.host.close(ref1)
    // A closed channel can accept no write, so it must not be reported as the owner.
    expect(fixture.host.pendingPermissions()).toEqual([])
    expect(fixture.host.channelForSession('session-1')).toBeUndefined()
  })
})
