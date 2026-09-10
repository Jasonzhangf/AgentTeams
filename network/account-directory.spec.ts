import { describe, expect, it } from 'vitest'
import { createHostDirectory, upsertDirectoryHost } from '../server/directory.ts'
import {
  confirmDirectoryGeneration,
  createAccountDirectorySnapshot,
  projectRelayDirectory,
  refreshRelayDirectory,
  refreshAccountDirectory,
  resolveHostFromDirectory,
} from './account-directory.ts'
import type { RelayPeer } from '../control-protocol/agent-services.ts'

const baseHost = {
  hostId: 'host-a',
  machineId: 'machine-a',
  agentId: 'agent-a',
  agentKind: 'opencode' as const,
  accountId: 'account-a',
  capabilitiesRevision: 'cap-1',
  routeCandidates: [
    {
      candidateId: 'candidate-1',
      kind: 'relay-ws' as const,
      endpoint: 'https://relay.test/ws',
      authRequired: true,
      lastSeenAt: '2026-09-04T00:00:00.000Z',
    },
  ],
}

function relayPeer(overrides: Partial<RelayPeer> = {}): RelayPeer {
  return {
    declaration: {
      identity: { hostId: 'host-a', machineId: 'machine-a', agentId: 'agent-a', accountId: 'account-a', agentKind: 'opencode', label: 'Agent A' },
      scopeId: 'scope-a', revision: 7, capabilities: [], routes: [
        { candidateId: 'direct', kind: 'ipv4', endpoint: 'wss://agent-a.example', authRequired: true, lastSeenAt: '2026-09-04T00:00:00.000Z' },
        { candidateId: 'relay', kind: 'relay-ws', endpoint: 'wss://relay.example', authRequired: true, lastSeenAt: '2026-09-04T00:00:00.000Z' },
      ],
    },
    connectionId: 'connection-a', generation: 4, lastSeenAt: '2026-09-04T00:00:00.000Z', presence: 'online',
    ...overrides,
  }
}

describe('Teams Master account directory lifecycle', () => {
  it('creates an account snapshot only after a confirmed directory generation', () => {
    const directory = upsertDirectoryHost(createHostDirectory(), baseHost, '2026-09-04T00:00:00.000Z')
    const snapshot = createAccountDirectorySnapshot(directory, 'account-a')
    expect(snapshot.hosts[0]).toMatchObject({ hostId: 'host-a', accountId: 'account-a' })
    expect(() => createAccountDirectorySnapshot(createHostDirectory(), 'account-a')).toThrow(/no confirmed/)
  })

  it('confirms the current generation before route resolution', () => {
    const snapshot = createAccountDirectorySnapshot(
      upsertDirectoryHost(createHostDirectory(), baseHost, '2026-09-04T00:00:00.000Z'),
      'account-a',
    )
    expect(confirmDirectoryGeneration(snapshot, snapshot.generation).confirmedGeneration).toBe(snapshot.generation)
    expect(() => confirmDirectoryGeneration(snapshot, snapshot.generation + 2)).toThrow(/must match/)
  })

  it('refreshes directory truth without reusing stale account state', () => {
    const first = createAccountDirectorySnapshot(
      upsertDirectoryHost(createHostDirectory(), baseHost, '2026-09-04T00:00:00.000Z'),
      'account-a',
    )
    const secondDirectory = upsertDirectoryHost(createHostDirectory(), baseHost, '2026-09-04T00:00:01.000Z')
    const refreshed = refreshAccountDirectory(first, secondDirectory)
    expect(refreshed.generation).toBe(secondDirectory.generation)
    expect(() => refreshAccountDirectory(refreshed, createHostDirectory())).toThrow(/went backwards/)
  })

  it('resolves hosts only from the confirmed account directory', () => {
    const snapshot = createAccountDirectorySnapshot(
      upsertDirectoryHost(createHostDirectory(), baseHost, '2026-09-04T00:00:00.000Z'),
      'account-a',
    )
    expect(resolveHostFromDirectory(snapshot, 'host-a').machineId).toBe('machine-a')
    expect(() => resolveHostFromDirectory(snapshot, 'host-b')).toThrow(/unknown host/)
  })

  it('projects Relay peers into a confirmed route directory without credentials', () => {
    const snapshot = projectRelayDirectory('account-a', 12, [relayPeer()])
    expect(snapshot).toMatchObject({ accountId: 'account-a', scopeId: 'scope-a', generation: 12, confirmedGeneration: 12 })
    expect(snapshot.hosts[0]).toMatchObject({ hostId: 'host-a', health: 'ready', capabilitiesRevision: '7' })
    expect(snapshot.hosts[0].routeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'direct', endpoint: 'wss://agent-a.example' }),
      expect.objectContaining({ candidateId: 'relay', endpoint: 'wss://relay.example' }),
    ]))
    expect(snapshot.hosts[0].routeCandidates.every(candidate => !('credential' in candidate))).toBe(true)
    expect(snapshot.peerStates).toEqual([{ hostId: 'host-a', agentId: 'agent-a', scopeId: 'scope-a', generation: 4, presence: 'online' }])
  })

  it('rejects stale, cross-account, cross-scope, and duplicate Relay peers', () => {
    expect(projectRelayDirectory('account-a', 0, [], 'scope-a')).toMatchObject({ scopeId: 'scope-a', generation: 0, hosts: [], peerStates: [] })
    expect(() => projectRelayDirectory('account-a', 0, [relayPeer()])).toThrow(/initial revision/)
    expect(() => projectRelayDirectory('account-a', 1, [relayPeer({ generation: 0 })])).toThrow(/generation/)
    expect(() => projectRelayDirectory('account-a', 1, [relayPeer({ declaration: { ...relayPeer().declaration, identity: { ...relayPeer().declaration.identity, accountId: 'account-b' } } })])).toThrow(/outside account/)
    expect(() => projectRelayDirectory('account-a', 1, [relayPeer(), relayPeer({ declaration: { ...relayPeer().declaration, identity: { ...relayPeer().declaration.identity, hostId: 'host-b', agentId: 'agent-b' }, scopeId: 'scope-b' } })])).toThrow(/different scopes/)
    expect(() => projectRelayDirectory('account-a', 1, [relayPeer(), relayPeer()])).toThrow(/duplicate peer host/)
    const current = projectRelayDirectory('account-a', 4, [relayPeer()])
    expect(() => refreshRelayDirectory(current, 3, [relayPeer()])).toThrow(/went backwards/)
    expect(refreshRelayDirectory(current, 5, [relayPeer()]).generation).toBe(5)
    expect(() => refreshRelayDirectory(current, 5, [relayPeer({ declaration: { ...relayPeer().declaration, scopeId: 'scope-b' } })])).toThrow(/confirmed scope/)
    const initial = projectRelayDirectory('account-a', 0, [], 'scope-a')
    expect(() => refreshRelayDirectory(initial, 1, [relayPeer({ declaration: { ...relayPeer().declaration, scopeId: 'scope-b' } })])).toThrow(/confirmed scope/)
  })
})
