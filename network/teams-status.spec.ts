import { describe, expect, it } from 'vitest'
import type { HistoryQuery, HistoryRecord } from '../control-protocol/acp.ts'
import type { HistoryPage, HistoryReadPort } from '../control-protocol/teams-state.ts'
import { parseTeamsConnectionStatus } from '../control-protocol/teams-state.ts'
import type { HostDirectoryEntry } from '../server/directory.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'
import type { AccountDirectorySnapshot } from './account-directory.ts'
import type { RegistrationStatus } from './registration-client.ts'
import { createTeamsConnectionHistory } from './teams-connection-history.ts'
import { createTeamsConnectionLedger } from './teams-ingress.ts'
import { createTeamsStatusPort } from './teams-status.ts'

function host(agentId: string): HostDirectoryEntry {
  return {
    hostId: `host-${agentId}`,
    machineId: `host-${agentId}`,
    agentId,
    agentKind: 'acp',
    accountId: 'account-1',
    capabilitiesRevision: '1',
    health: 'ready',
    routeCandidates: [{
      candidateId: `direct-${agentId}`,
      kind: 'lan',
      endpoint: 'wss://127.0.0.1:8443',
      port: 8443,
      authRequired: true,
      lastSeenAt: '2026-10-11T00:00:00.000Z',
    }],
    updatedAt: '2026-10-11T00:00:00.000Z',
    lastSeenAt: '2026-10-11T00:00:00.000Z',
  }
}

function directory(hosts: readonly HostDirectoryEntry[]): AccountDirectorySnapshot {
  return {
    accountId: 'account-1',
    scopeId: 'scope-1',
    generation: 4,
    confirmedGeneration: 4,
    hosts,
    peerStates: hosts.map((entry, index) => ({
      hostId: entry.hostId,
      agentId: entry.agentId,
      scopeId: 'scope-1',
      generation: 21 + index,
      presence: 'online' as const,
    })),
  }
}

const online: RegistrationStatus = { state: 'online', endpoint: 'wss://registry:9443', generation: 5, attempts: 0, reconnects: 0 }

function memoryStore(): AcpHistoryPort & HistoryReadPort & { readonly records: HistoryRecord[] } {
  const records: HistoryRecord[] = []
  return {
    records,
    async append(record) {
      const stored: HistoryRecord = { ...record, recordId: `h-${records.length + 1}`, sequence: records.length + 1 }
      records.push(stored)
      return stored
    },
    async query(query: HistoryQuery): Promise<HistoryPage> {
      const matching = records
        .filter(record => record.kind === query.kind)
        .filter(record => query.beforeSequence === undefined || record.sequence < query.beforeSequence)
      const page = matching.slice(-query.limit)
      return { records: page, ...(matching.length > page.length ? { nextBeforeSequence: page[0]?.sequence } : {}) }
    },
  }
}

describe('Teams status port', () => {
  it('projects the live ledger plus directory and registration into frozen TeamsConnectionStatus', () => {
    const ledger = createTeamsConnectionLedger()
    ledger.open({ remoteAgentId: 'agent-b', connectionId: 'conn-1', state: 'negotiating', targetGeneration: 22, observedAt: '2026-10-11T00:00:00.000Z' })
    ledger.update({ remoteAgentId: 'agent-b', connectionId: 'conn-1', state: 'ready', targetGeneration: 22, role: 'peer', observedAt: '2026-10-11T00:00:01.000Z' })
    const store = memoryStore()
    const port = createTeamsStatusPort({
      ledger,
      localAgentId: 'agent-a',
      directory: directory([host('agent-b'), host('agent-c')]),
      registration: online,
      history: createTeamsConnectionHistory(store),
      now: () => '2026-10-11T00:00:02.000Z',
    })

    const connections = port.connections()
    // Only the frozen DTO crosses the boundary, and it parses as one.
    for (const status of connections) expect(parseTeamsConnectionStatus(status)).toBe(status)
    expect(connections).toEqual([
      { version: 1, remoteAgentId: 'agent-b', state: 'ready', targetGeneration: 22, observedAt: '2026-10-11T00:00:01.000Z', connectionId: 'conn-1', role: 'peer' },
      { version: 1, remoteAgentId: 'agent-c', state: 'disconnected', targetGeneration: 22, observedAt: '2026-10-11T00:00:02.000Z' },
    ])

    // The live view follows the ledger, never a log or a cached projection.
    ledger.close('conn-1', '2026-10-11T00:00:03.000Z')
    expect(port.connections()[0]).toMatchObject({ remoteAgentId: 'agent-b', state: 'closed', observedAt: '2026-10-11T00:00:03.000Z' })
    expect(port.connections()[0].error).toBeUndefined()
  })

  it('delegates history to the connection-history surface and refuses a request query', async () => {
    const store = memoryStore()
    const history = createTeamsConnectionHistory(store)
    const port = createTeamsStatusPort({
      ledger: createTeamsConnectionLedger(),
      localAgentId: 'agent-a',
      directory: directory([]),
      registration: online,
      history,
      now: () => '2026-10-11T00:00:00.000Z',
    })
    await history.record({ event: 'connection.negotiated', agentId: 'agent-b', occurredAt: '2026-10-11T00:00:01.000Z', connectionId: 'conn-1' })
    const page = await port.history({ version: 1, kind: 'connection', limit: 10 })
    expect(page.records.map(record => record.event)).toEqual(['connection.negotiated'])
    await expect(port.history({ version: 1, kind: 'request', limit: 10 }))
      .rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
  })

  it('exposes exactly the two read-only DTO methods', () => {
    const port = createTeamsStatusPort({
      ledger: createTeamsConnectionLedger(),
      localAgentId: 'agent-a',
      directory: directory([]),
      registration: online,
      history: createTeamsConnectionHistory(memoryStore()),
    })
    expect(Object.keys(port).sort()).toEqual(['connections', 'history'])
  })
})
