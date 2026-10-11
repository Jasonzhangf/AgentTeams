import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryRecord } from '../control-protocol/acp.ts'
import type { HistoryQuery } from '../control-protocol/teams-state.ts'
import { createAcpHistoryStore } from './acp-history-store.ts'

const directories = new Set<string>()

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'acp-history-'))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  for (const directory of [...directories]) {
    await rm(directory, { recursive: true, force: true })
    directories.delete(directory)
  }
})

type RecordInput = Omit<HistoryRecord, 'recordId' | 'sequence'>

function record(overrides: Partial<RecordInput> = {}): RecordInput {
  return { occurredAt: new Date().toISOString(), agentId: 'agent-a', kind: 'request', event: 'request.dispatched', ...overrides }
}

function query(overrides: Partial<HistoryQuery> = {}): HistoryQuery {
  return { version: 1, limit: 10, ...overrides }
}

describe('createAcpHistoryStore', () => {
  it('appends ordered records and pages newest-first with a next cursor', async () => {
    const store = await createAcpHistoryStore({ directory: await tempDirectory() })
    for (let index = 1; index <= 5; index += 1) await store.append(record({ event: `event-${index}` }))

    const first = await store.query(query({ limit: 2 }))
    expect(first.records.map(item => item.event)).toEqual(['event-5', 'event-4'])
    expect(first.records.map(item => item.sequence)).toEqual([5, 4])
    expect(first.records.map(item => item.recordId)).toEqual(['acp-history-5', 'acp-history-4'])
    expect(first.nextBeforeSequence).toBe(4)

    const second = await store.query(query({ limit: 2, beforeSequence: first.nextBeforeSequence }))
    expect(second.records.map(item => item.event)).toEqual(['event-3', 'event-2'])
    const third = await store.query(query({ limit: 2, beforeSequence: second.nextBeforeSequence }))
    expect(third.records.map(item => item.event)).toEqual(['event-1'])
    expect(third.nextBeforeSequence).toBeUndefined()
  })

  it('filters by kind, agentId and sessionId', async () => {
    const store = await createAcpHistoryStore({ directory: await tempDirectory() })
    await store.append(record({ event: 'a', sessionId: 'session-1' }))
    await store.append(record({ event: 'b', agentId: 'agent-b', sessionId: 'session-1' }))
    await store.append(record({ event: 'c', kind: 'connection', agentId: 'agent-a' }))

    expect((await store.query(query({ sessionId: 'session-1' }))).records.map(item => item.event)).toEqual(['b', 'a'])
    expect((await store.query(query({ agentId: 'agent-b' }))).records.map(item => item.event)).toEqual(['b'])
    expect((await store.query(query({ kind: 'connection' }))).records.map(item => item.event)).toEqual(['c'])
    expect((await store.query(query({ agentId: 'agent-a', kind: 'connection' }))).records.map(item => item.event)).toEqual(['c'])
  })

  it('persists across an owner restart and continues the sequence', async () => {
    const directory = await tempDirectory()
    const first = await createAcpHistoryStore({ directory })
    await first.append(record({ event: 'before-restart' }))
    const second = await createAcpHistoryStore({ directory })
    const page = await second.query(query())
    expect(page.records.map(item => item.event)).toEqual(['before-restart'])
    await second.append(record({ event: 'after-restart' }))
    expect((await second.query(query())).records.map(item => item.sequence)).toEqual([2, 1])
  })

  it('prunes to the retention bound and persists the prune', async () => {
    const directory = await tempDirectory()
    const store = await createAcpHistoryStore({ directory, retention: 3 })
    for (let index = 1; index <= 5; index += 1) await store.append(record({ event: `event-${index}` }))
    expect((await store.query(query())).records.map(item => item.event)).toEqual(['event-5', 'event-4', 'event-3'])
    const reopened = await createAcpHistoryStore({ directory, retention: 3 })
    expect((await reopened.query(query())).records.map(item => item.event)).toEqual(['event-5', 'event-4', 'event-3'])
  })

  it('reports a write failure and never claims the unwritten record', async () => {
    const store = await createAcpHistoryStore({ directory: await tempDirectory() })
    await store.append(record({ event: 'stored' }))
    // Replace the durable file with a directory so the atomic rename fails.
    await rm(store.path, { force: true })
    await mkdir(store.path)
    await expect(store.append(record({ event: 'lost' }))).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    expect((await store.query(query())).records.map(item => item.event)).toEqual(['stored'])

    await rm(store.path, { recursive: true, force: true })
    await store.append(record({ event: 'recovered' }))
    expect((await store.query(query())).records.map(item => item.event)).toEqual(['recovered', 'stored'])
  })

  it('rejects a corrupt history file explicitly at creation', async () => {
    const directory = await tempDirectory()
    await writeFile(join(directory, 'acp-history.json'), '{not json', 'utf8')
    await expect(createAcpHistoryStore({ directory })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
  })

  it('rejects an invalid history query through the frozen parser', async () => {
    const store = await createAcpHistoryStore({ directory: await tempDirectory() })
    await expect(store.query({ version: 1, limit: 0 })).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    await expect(store.query({ version: 2, limit: 1 } as unknown as HistoryQuery)).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
  })

  it('holds records only and exposes no pending or resume surface', async () => {
    const directory = await tempDirectory()
    const store = await createAcpHistoryStore({ directory })
    expect(Object.keys(store).sort()).toEqual(['append', 'path', 'query'])
    await store.append(record({ event: 'request.dispatched', sessionId: 'session-1', requestRecordId: 'r1' }))
    const reopened = await createAcpHistoryStore({ directory })
    expect(Object.keys(reopened).sort()).toEqual(['append', 'path', 'query'])
    const page = await reopened.query(query({ sessionId: 'session-1' }))
    expect(page.records).toHaveLength(1)
    expect(page.records[0]).toMatchObject({ event: 'request.dispatched', requestRecordId: 'r1' })
    // A dispatched request with no result stays a record; it is not an obligation.
    expect('outcome' in page.records[0]).toBe(false)
  })
})
