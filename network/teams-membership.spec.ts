import { describe, expect, it } from 'vitest'
import type { HostDirectoryEntry } from '../server/directory.ts'
import { TEAMS_CONNECTION_STATUS_VERSION } from '../control-protocol/teams-state.ts'
import type { AccountDirectorySnapshot } from './account-directory.ts'
import type { RegistrationStatus } from './registration-client.ts'
import { membershipHistoryEvents, projectTeamsMembership, type MembershipChannelObservation } from './teams-membership.ts'

function host(agentId: string, hostId = `host-${agentId}`, health: HostDirectoryEntry['health'] = 'ready'): HostDirectoryEntry {
  return {
    hostId,
    machineId: hostId,
    agentId,
    agentKind: 'acp',
    accountId: 'account-1',
    capabilitiesRevision: '1',
    health,
    routeCandidates: [{
      candidateId: `direct-${agentId}`,
      kind: 'lan',
      endpoint: `wss://127.0.0.1:8443`,
      port: 8443,
      authRequired: true,
      lastSeenAt: '2026-10-11T00:00:00.000Z',
    }],
    updatedAt: '2026-10-11T00:00:00.000Z',
    lastSeenAt: '2026-10-11T00:00:00.000Z',
  }
}

function directory(hosts: readonly HostDirectoryEntry[], generation = 4): AccountDirectorySnapshot {
  return {
    accountId: 'account-1',
    scopeId: 'scope-1',
    generation,
    confirmedGeneration: generation,
    hosts,
    peerStates: hosts.map((entry, index) => ({
      hostId: entry.hostId,
      agentId: entry.agentId,
      scopeId: 'scope-1',
      generation: 20 + index + 1,
      presence: entry.health === 'ready' ? 'online' as const : 'offline' as const,
    })),
  }
}

const online: RegistrationStatus = { state: 'online', endpoint: 'wss://registry:9443', generation: 5, attempts: 0, reconnects: 0 }

function channel(overrides: Partial<MembershipChannelObservation> = {}): MembershipChannelObservation {
  return {
    remoteAgentId: 'agent-b',
    connectionId: 'conn-1',
    state: 'ready',
    targetGeneration: 21,
    role: 'master',
    observedAt: '2026-10-11T00:00:05.000Z',
    ...overrides,
  }
}

describe('Teams membership view', () => {
  it('assembles per-remote-agent TeamsConnectionStatus from directory, route and registration surfaces', () => {
    const view = projectTeamsMembership({
      localAgentId: 'agent-a',
      directory: directory([host('agent-b')]),
      registration: online,
      channels: [channel()],
      observedAt: '2026-10-11T00:00:06.000Z',
    })
    expect(view.entries).toHaveLength(1)
    const entry = view.entries[0]
    expect(entry.remoteAgentId).toBe('agent-b')
    expect(entry.status).toEqual({
      version: TEAMS_CONNECTION_STATUS_VERSION,
      remoteAgentId: 'agent-b',
      state: 'ready',
      targetGeneration: 21,
      observedAt: '2026-10-11T00:00:05.000Z',
      connectionId: 'conn-1',
      role: 'master',
    })
    expect(entry.hosts.map(item => item.hostId)).toEqual(['host-agent-b'])
    expect(entry.routes.map(route => route.candidateId)).toEqual(['direct-agent-b'])
    expect(view.registry).toMatchObject({ state: 'online', degraded: false, endpoint: 'wss://registry:9443' })
    expect(entry.halfOpen).toBe(false)
  })

  it('never closes or downgrades an established channel when the registry is lost', () => {
    const before = projectTeamsMembership({
      localAgentId: 'agent-a',
      directory: directory([host('agent-b')]),
      registration: online,
      channels: [channel()],
      observedAt: '2026-10-11T00:00:06.000Z',
    })
    const lost: RegistrationStatus = { state: 'failed', endpoint: 'wss://registry:9443', attempts: 3, reconnects: 1, lastError: { code: 'UNAVAILABLE', message: 'registry unreachable' } }
    const after = projectTeamsMembership({
      localAgentId: 'agent-a',
      directory: directory([host('agent-b', 'host-agent-b', 'stale')], 5),
      registration: lost,
      channels: [channel()],
      observedAt: '2026-10-11T00:00:07.000Z',
    })
    expect(after.entries[0].status.state).toBe('ready')
    expect(after.entries[0].status.connectionId).toBe('conn-1')
    expect(after.registry).toMatchObject({ state: 'failed', degraded: true })
    const events = membershipHistoryEvents(before, after)
    expect(events.map(event => event.event)).toEqual(['connection.registry-lost'])
    expect(events[0]).toMatchObject({ agentId: 'agent-a', occurredAt: '2026-10-11T00:00:07.000Z' })
    expect(events.some(event => event.event === 'connection.closed')).toBe(false)
  })

  it('reports a half-open established channel through the typed status and history surface', () => {
    const before = projectTeamsMembership({
      localAgentId: 'agent-a', directory: directory([host('agent-b')]), registration: online,
      channels: [channel()], observedAt: '2026-10-11T00:00:06.000Z',
    })
    const after = projectTeamsMembership({
      localAgentId: 'agent-a', directory: directory([host('agent-b')]), registration: online,
      channels: [channel({ halfOpen: true })], observedAt: '2026-10-11T00:00:08.000Z',
    })
    expect(after.entries[0].halfOpen).toBe(true)
    expect(after.entries[0].status.state).toBe('ready')
    const events = membershipHistoryEvents(before, after)
    expect(events.map(event => event.event)).toEqual(['connection.half-open'])
    expect(events.every(event => event.event.startsWith('connection.'))).toBe(true)
    expect(events[0].error).toBeUndefined()
  })

  it('reports a closed channel with its typed error and a directory-only remote as disconnected', () => {
    const before = projectTeamsMembership({
      localAgentId: 'agent-a', directory: directory([host('agent-b')]), registration: online,
      channels: [channel()], observedAt: '2026-10-11T00:00:06.000Z',
    })
    const after = projectTeamsMembership({
      localAgentId: 'agent-a',
      directory: directory([host('agent-b'), host('agent-c')], 6),
      registration: online,
      channels: [channel({ state: 'failed', error: { code: 'ENGINE_UNAVAILABLE', message: 'engine exited' } })],
      observedAt: '2026-10-11T00:00:09.000Z',
    })
    expect(after.entries.map(entry => entry.remoteAgentId)).toEqual(['agent-b', 'agent-c'])
    expect(after.entries[0].status).toMatchObject({ state: 'failed', error: { code: 'ENGINE_UNAVAILABLE' } })
    expect(after.entries[1].status).toMatchObject({ state: 'disconnected', targetGeneration: 22 })
    expect(after.entries[1].status.connectionId).toBeUndefined()
    const events = membershipHistoryEvents(before, after)
    expect(events.map(event => event.event)).toContain('connection.failed')
  })

  it('rejects a channel observation that cannot produce a frozen TeamsConnectionStatus', () => {
    expect(() => projectTeamsMembership({
      localAgentId: 'agent-a', directory: directory([]), registration: online,
      channels: [channel({ targetGeneration: 0 })], observedAt: '2026-10-11T00:00:06.000Z',
    })).toThrow(/targetGeneration/)
  })
})
