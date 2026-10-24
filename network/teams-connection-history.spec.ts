import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpError } from '../packages/shared/src/acp.ts'
import type { TeamsAgreement } from '../packages/shared/src/teams-connection.ts'
import { createAcpHistoryStore } from '../runtime/acp-history-store.ts'
import { createTeamsConnectionHistory, type TeamsConnectionHistory } from './teams-connection-history.ts'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'teams-connection-history-'))
  directories.push(directory)
  return directory
}

afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

async function fixture(): Promise<{ history: TeamsConnectionHistory; store: Awaited<ReturnType<typeof createAcpHistoryStore>> }> {
  const store = await createAcpHistoryStore({ directory: tempDirectory() })
  return { history: createTeamsConnectionHistory(store), store }
}

const agreement: TeamsAgreement = {
  connectionId: 'conn-1',
  relationRevision: 1,
  source: { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-a' },
  target: { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-b' },
  sourceRole: 'master',
  targetRole: 'peer',
  sourceGeneration: 11,
  targetGeneration: 22,
  sourceCapabilitiesRevision: 'cap-a',
  targetCapabilitiesRevision: 'cap-b',
  sourcePolicyRevision: 3,
  targetPolicyRevision: 7,
  capabilities: ['method:session/new'],
}

describe('Teams connection history', () => {
  it('records connection and role events behind the frozen HistoryReadPort shape with kind connection', async () => {
    const { history } = await fixture()
    expect(Object.keys(history).sort()).toEqual(['query', 'record'])
    const record = await history.record({
      event: 'connection.negotiated',
      agentId: 'agent-a',
      occurredAt: '2026-10-11T00:00:01.000Z',
      connectionId: 'conn-1',
      outcome: 'completed',
      agreement,
    })
    expect(record).toMatchObject({ kind: 'connection', event: 'connection.negotiated', sequence: 1, agentId: 'agent-a' })
    expect(typeof record.recordId).toBe('string')
    const page = await history.query({ version: 1, limit: 10 })
    expect(page.records).toHaveLength(1)
    expect(page.records[0]).toMatchObject({ kind: 'connection', connectionId: 'conn-1', outcome: 'completed' })
    // Role and target generation stay in the typed agreement; the record gains no flattened field.
    expect(page.records[0].agreement).toEqual(agreement)
    expect(page.records[0]).not.toHaveProperty('role')
    expect(page.records[0]).not.toHaveProperty('targetGeneration')
    expect(page.nextBeforeSequence).toBeUndefined()
  })

  it('pages newest-first with a strict beforeSequence and an explicit nextBeforeSequence', async () => {
    const { history } = await fixture()
    for (let index = 1; index <= 5; index += 1) {
      await history.record({ event: 'channel.opened', agentId: 'agent-a', occurredAt: `2026-10-11T00:00:0${index}.000Z`, connectionId: `conn-${index}` })
    }
    const first = await history.query({ version: 1, limit: 2 })
    expect(first.records.map(record => record.sequence)).toEqual([5, 4])
    expect(first.nextBeforeSequence).toBe(4)
    const second = await history.query({ version: 1, limit: 2, beforeSequence: first.nextBeforeSequence })
    expect(second.records.map(record => record.sequence)).toEqual([3, 2])
    expect(second.nextBeforeSequence).toBe(2)
    const third = await history.query({ version: 1, limit: 2, beforeSequence: second.nextBeforeSequence })
    expect(third.records.map(record => record.sequence)).toEqual([1])
    expect(third.nextBeforeSequence).toBeUndefined()
  })

  it('filters by agent and session and refuses a request-kind query on the connection surface', async () => {
    const { history } = await fixture()
    await history.record({ event: 'connection.negotiated', agentId: 'agent-a', occurredAt: '2026-10-11T00:00:01.000Z', connectionId: 'conn-1' })
    await history.record({ event: 'channel.opened', agentId: 'agent-b', occurredAt: '2026-10-11T00:00:02.000Z', connectionId: 'conn-2', sessionId: 's-1' })
    const byAgent = await history.query({ version: 1, kind: 'connection', agentId: 'agent-b', limit: 10 })
    expect(byAgent.records).toHaveLength(1)
    expect(byAgent.records[0]).toMatchObject({ agentId: 'agent-b', sessionId: 's-1' })
    const bySession = await history.query({ version: 1, kind: 'connection', sessionId: 's-1', limit: 10 })
    expect(bySession.records).toHaveLength(1)
    await expect(history.query({ version: 1, kind: 'request', limit: 10 })).rejects.toBeInstanceOf(AcpError)
  })

  it('keeps records durable across a store reopen and never restores a pending connection', async () => {
    const directory = tempDirectory()
    const first = createTeamsConnectionHistory(await createAcpHistoryStore({ directory }))
    await first.record({ event: 'connection.negotiated', agentId: 'agent-a', occurredAt: '2026-10-11T00:00:01.000Z', connectionId: 'conn-1' })
    await first.record({ event: 'connection.closed', agentId: 'agent-a', occurredAt: '2026-10-11T00:00:02.000Z', connectionId: 'conn-1', outcome: 'unknown' })
    const reopened = createTeamsConnectionHistory(await createAcpHistoryStore({ directory }))
    const page = await reopened.query({ version: 1, limit: 10 })
    expect(page.records.map(record => record.event)).toEqual(['connection.closed', 'connection.negotiated'])
    expect(page.records.every(record => record.kind === 'connection')).toBe(true)
  })

  it('rejects an invalid history query before it reaches the store', async () => {
    const { history } = await fixture()
    await expect(history.query({ version: 1, limit: 0 })).rejects.toBeInstanceOf(AcpError)
    await expect(history.query({ version: 2, limit: 10 } as unknown as { version: 1; limit: number })).rejects.toBeInstanceOf(AcpError)
  })
})
