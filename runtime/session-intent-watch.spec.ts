import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AcpChannelRef, AcpIngress } from '../packages/shared/src/acp.ts'
import type { AcpPendingPermission } from '../agent-host/acp-host.ts'
import {
  readSessionIntentRecord,
  readSessionIntentWatermark,
  sessionIntentPath,
  writeSessionIntentRecord,
  type SessionIntentChange,
} from '../config/session-intent-store.ts'
import { createSessionIntentWatch, type SessionIntentWatchInput } from './acp-serve.ts'

/**
 * The watch maps the three frozen Session writes onto the engine's own ACP frames, and it
 * refuses every write it cannot map to a real engine fact. These cases bind that mapping and
 * the refusal rules against real record files and a recording host.
 *
 * The real end-to-end path — a Console command on a live control daemon that makes a live
 * agent daemon act on its own engine — is the black box, not this spec.
 */

let directory: string
let recordPath: string
let watermarkPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-watch-'))
  recordPath = sessionIntentPath(join(directory, 'record'))
  watermarkPath = join(directory, 'data', 'watermark.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const REF: AcpChannelRef = { connectionId: 'connection-1', channelId: 'channel-1', targetGeneration: 3, engineInstanceId: 'engine-1' }

/** A recording host double. It holds the engine facts the real host would hold. */
function recordingHost(input: {
  readonly pending?: readonly AcpPendingPermission[]
  readonly sessions?: Readonly<Record<string, AcpChannelRef>>
} = {}) {
  const received: AcpIngress[] = []
  return {
    received,
    pendingPermissions: () => input.pending ?? [],
    channelForSession: (sessionId: string) => input.sessions?.[sessionId],
    receive: async (ingress: AcpIngress) => { received.push(ingress) },
  } satisfies SessionIntentWatchInput['host'] & { readonly received: readonly AcpIngress[] }
}

function pending(input: {
  readonly permissionId?: string
  readonly sessionId?: string
  readonly options?: readonly { readonly optionId: string; readonly name: string; readonly kind: 'once' | 'always' | 'reject' }[]
} = {}): AcpPendingPermission {
  return {
    ref: REF,
    sessionId: input.sessionId ?? 'session-1',
    permissionId: input.permissionId ?? 'permission-1',
    options: input.options ?? [
      { optionId: 'allow-once', name: 'Allow once', kind: 'once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'always' },
      { optionId: 'deny', name: 'Reject', kind: 'reject' },
    ],
  }
}

async function write(revision: number, change: SessionIntentChange, path = recordPath): Promise<void> {
  const result = await writeSessionIntentRecord(path, revision, change)
  expect(result.status).toBe('applied')
}

const watchFor = (
  host: SessionIntentWatchInput['host'],
  options: { readonly agentId?: string; readonly recordPath?: string } = {},
): ReturnType<typeof createSessionIntentWatch> => createSessionIntentWatch({
  host,
  recordPath: options.recordPath ?? recordPath,
  watermarkPath,
  agentId: options.agentId ?? 'agent-alpha',
})

describe('pending Session write watch', () => {
  it('answers the engine callback the write names, with the engine own option for the decision', async () => {
    await write(0, { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 'session-1', permissionId: 'permission-1', decision: 'always' })
    const host = recordingHost({ pending: [pending()] })
    const watch = watchFor(host)
    await watch.reconcile()
    // The reply goes to the id the controller received with the request.
    expect(host.received).toEqual([{
      ...REF,
      frame: { jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'selected', optionId: 'allow-always' } } },
    }])
    expect(watch.failures()).toEqual([])
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(1)
  })

  it('answers with the exact engine option the write names, not the first option of that kind', async () => {
    // Two options project to the same `always` kind. The Console named the second one, and the
    // engine must be answered with that one; a same-kind guess would silently replace the
    // operator's decision.
    const twoOfAKind = [
      { optionId: 'allow-always-a', name: 'Always allow A', kind: 'always' as const },
      { optionId: 'allow-always-b', name: 'Always allow B', kind: 'always' as const },
    ]
    await write(0, { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 'session-1', permissionId: 'permission-1', decision: 'always', optionId: 'allow-always-b' })
    const host = recordingHost({ pending: [pending({ options: twoOfAKind })] })
    const watch = watchFor(host)
    await watch.reconcile()
    expect(host.received).toEqual([{
      ...REF,
      frame: { jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'selected', optionId: 'allow-always-b' } } },
    }])
    expect(watch.failures()).toEqual([])
  })

  it('refuses a named engine option the engine never offered, and one that contradicts the decision', async () => {
    await write(0, { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 'session-1', permissionId: 'permission-1', decision: 'always', optionId: 'allow-always-invented' })
    const invented = recordingHost({ pending: [pending()] })
    const first = watchFor(invented)
    await first.reconcile()
    expect(invented.received).toEqual([])
    expect(first.failures()[0]).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(first.failures()[0]?.message).toContain('never offered option allow-always-invented')

    // The named option exists, but its kind is not the decision the same write states. Guessing
    // which one is right would answer the engine with a decision nobody made. This record is
    // separate, because the watch above stopped on its own unappliable first write.
    const contradictingPath = sessionIntentPath(join(directory, 'record-contradicting'))
    await write(0, { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 'session-1', permissionId: 'permission-1', decision: 'once', optionId: 'allow-always' }, contradictingPath)
    const contradicting = recordingHost({ pending: [pending()] })
    const second = watchFor(contradicting, { recordPath: contradictingPath })
    await second.reconcile()
    expect(contradicting.received).toEqual([])
    expect(second.failures()[0]).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(second.failures()[0]?.message).toContain('is kind always')
  })

  it('never turns a decision the engine did not offer into an approval', async () => {
    // The engine offered no `always` option, so the write must be refused, not mapped onto
    // the nearest option.
    await write(0, { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 'session-1', permissionId: 'permission-1', decision: 'always' })
    const host = recordingHost({ pending: [pending({ options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'once' }] })] })
    const watch = watchFor(host)
    await watch.reconcile()
    expect(host.received).toEqual([])
    expect(watch.failures()).toHaveLength(1)
    expect(watch.failures()[0]).toMatchObject({ code: 'INVALID_ACP_FRAME', intentId: expect.any(String) })
    // The refusal is not a silent skip: the watermark stays, so the write is retried and the
    // refusal keeps its own record.
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(0)
  })

  it('refuses a permission the engine no longer awaits', async () => {
    await write(0, { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 'session-1', permissionId: 'permission-gone', decision: 'once' })
    const host = recordingHost({ pending: [pending()] })
    const watch = watchFor(host)
    await watch.reconcile()
    expect(host.received).toEqual([])
    expect(watch.failures()[0]).toMatchObject({ code: 'CONFLICT' })
    expect(watch.failures()[0]?.message).toContain('0 engine callbacks match')
  })

  it('refuses a permission two live callbacks both claim, instead of answering either', async () => {
    const other = sessionIntentPath(join(directory, 'record-two'))
    await write(0, { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 'session-1', permissionId: 'permission-2', decision: 'once' }, other)
    const host = recordingHost({
      pending: [pending({ permissionId: 'permission-2' }), pending({ permissionId: 'permission-2', sessionId: 'session-1' })],
    })
    const watch = watchFor(host, { recordPath: other })
    await watch.reconcile()
    expect(host.received).toEqual([])
    expect(watch.failures()).toHaveLength(1)
    expect(watch.failures()[0]?.message).toContain('2 engine callbacks match')
  })

  it('cancels and prompts only the channel that really owns the Session', async () => {
    await write(0, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' })
    await write(1, { op: 'session.message', agentId: 'agent-alpha', sessionId: 'session-1', payload: { text: '你好', keep: [1, null] } })
    const host = recordingHost({ sessions: { 'session-1': REF } })
    const watch = watchFor(host)
    await watch.reconcile()
    expect(host.received).toHaveLength(2)
    expect(host.received[0]?.frame).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } })
    // The body reaches the engine verbatim and the request carries its own identity.
    const prompt = host.received[1]?.frame
    expect(prompt).toMatchObject({ jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 'session-1', prompt: { text: '你好', keep: [1, null] } } })
    expect(typeof prompt?.id).toBe('string')
    expect(watch.failures()).toEqual([])
  })

  it('refuses a write for a Session no open channel owns, and applies it once one does', async () => {
    await write(0, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-unknown' })
    const absent = recordingHost({ sessions: { 'session-1': REF } })
    const absentWatch = watchFor(absent)
    await absentWatch.reconcile()
    expect(absent.received).toEqual([])
    expect(absentWatch.failures()[0]).toMatchObject({ code: 'CONFLICT' })
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(0)

    // The same write applies on a later pass once a channel owns the Session.
    const live = recordingHost({ sessions: { 'session-unknown': REF } })
    const liveWatch = watchFor(live)
    await liveWatch.reconcile()
    expect(live.received).toHaveLength(1)
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(1)
  })

  it('keeps revision order and stops at the first write it cannot apply', async () => {
    await write(0, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-missing' })
    await write(1, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' })
    const host = recordingHost({ sessions: { 'session-1': REF } })
    const watch = watchFor(host)
    await watch.reconcile()
    // The later write must not overtake the earlier one.
    expect(host.received).toEqual([])
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(0)

    // Once the earlier write can apply, both apply in order in one pass.
    const both = recordingHost({ sessions: { 'session-missing': REF, 'session-1': REF } })
    await watchFor(both).reconcile()
    expect(both.received.map(ingress => ingress.frame)).toEqual([
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-missing' } },
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } },
    ])
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(2)
  })

  it('refuses a record that names another agent instead of applying another daemon write', async () => {
    await write(0, { op: 'session.cancel', agentId: 'agent-beta', sessionId: 'session-1' })
    const host = recordingHost({ sessions: { 'session-1': REF } })
    const watch = watchFor(host, { agentId: 'agent-alpha' })
    await watch.reconcile()
    expect(host.received).toEqual([])
    expect(watch.failures()[0]).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses honestly when the retained window already dropped writes it never saw', async () => {
    // A reader whose watermark is older than the writer's retained boundary cannot know what
    // it missed, so it applies nothing and reports the gap.
    await write(0, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' })
    await write(1, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' })
    const record = await readSessionIntentRecord(recordPath)
    expect(record?.oldestRevision).toBe(1)
    // A writer whose window already dropped revisions 1 and 2.
    await writeFile(recordPath, `${JSON.stringify({ ...record, revision: 4, oldestRevision: 3 })}\n`)
    const host = recordingHost({ sessions: { 'session-1': REF } })
    const watch = watchFor(host)
    await watch.reconcile()
    expect(host.received).toEqual([])
    expect(watch.failures()[0]).toMatchObject({ code: 'CONFLICT' })
    expect(watch.failures()[0]?.message).toContain('applied only through 0')
  })

  it('is a no-op with no record, and a typed refusal with a broken one', async () => {
    const host = recordingHost({ sessions: { 'session-1': REF } })
    const watch = watchFor(host)
    await watch.reconcile()
    expect(watch.failures()).toEqual([])
    expect(host.received).toEqual([])

    await mkdir(dirname(recordPath), { recursive: true })
    await writeFile(recordPath, 'not json\n')
    await watch.reconcile()
    expect(watch.failures()).toHaveLength(1)
    // Nothing was applied and the watermark was never created.
    expect(host.received).toEqual([])
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(0)
  })

  it('never re-applies a write it already applied when the watermark cannot be saved', async () => {
    await write(0, { op: 'session.message', agentId: 'agent-alpha', sessionId: 'session-1', payload: { text: 'once' } })
    const host = recordingHost({ sessions: { 'session-1': REF } })
    // A watermark the watch can read but cannot replace: the directory is immutable, so the
    // temporary file cannot be created, while the missing watermark still reads as revision 0.
    const frozen = join(directory, 'frozen')
    await mkdir(frozen, { recursive: true })
    execFileSync('chflags', ['uchg', frozen])
    try {
      const watch = createSessionIntentWatch({
        host,
        recordPath,
        watermarkPath: join(frozen, 'watermark.json'),
        agentId: 'agent-alpha',
      })

      await watch.reconcile()
      // The write reached the engine and the failed save is a real typed refusal. The frozen
      // ACP fault vocabulary has no `UNAVAILABLE`, so a store fault maps through the same
      // `configFault` bucket the record-read refusal already uses; it never blames the engine.
      expect(host.received).toHaveLength(1)
      expect(watch.failures().map(failure => failure.code)).toEqual(['UNSUPPORTED_CONFIGURATION'])
      expect(watch.failures()[0]?.message).toContain('watermark could not be saved')

      await watch.reconcile()
      // A second prompt would be a second message in the Session, so the write is not re-sent.
      expect(host.received).toHaveLength(1)
      // The durable watermark really was not saved, which is why the process has to remember.
      expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(0)
    } finally {
      execFileSync('chflags', ['nouchg', frozen])
    }
  })

  it('never runs two passes at once, so a poll that overlaps cannot apply the same write twice', async () => {
    await write(0, { op: 'session.message', agentId: 'agent-alpha', sessionId: 'session-1', payload: { text: 'once' } })
    const received: AcpIngress[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const host = {
      pendingPermissions: () => [],
      channelForSession: () => REF,
      // The engine is slow, so the next poll arrives while this write is still in flight.
      receive: async (ingress: AcpIngress) => { received.push(ingress); await gate },
    }
    const watch = createSessionIntentWatch({ host, recordPath, watermarkPath, agentId: 'agent-alpha' })

    const first = watch.reconcile()
    // Let the first pass reach the engine and block there, before it can save its watermark.
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = watch.reconcile()
    // Let the second pass read the still-unsaved watermark, so the overlap is real and not a
    // lucky microtask order.
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    await Promise.all([first, second])

    // Two overlapping passes would both read watermark 0 and both prompt the engine.
    expect(received).toHaveLength(1)
    expect((await readSessionIntentWatermark(watermarkPath)).appliedRevision).toBe(1)
  })

  it('keeps each distinct refusal once instead of growing on every pass', async () => {
    await write(0, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-missing' })
    const host = recordingHost()
    const watch = watchFor(host)
    for (let pass = 0; pass < 5; pass += 1) await watch.reconcile()
    expect(watch.failures()).toHaveLength(1)
    expect(watch.recordPath).toBe(recordPath)
    expect(watch.watermarkPath).toBe(watermarkPath)
  })
})
