import { describe, expect, it } from 'vitest'
import {
  createHostDirectory,
  listDirectoryHosts,
  removeDirectoryHost,
  removeStaleHosts,
  touchHostPresence,
  upsertDirectoryHost,
} from './directory.ts'

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

describe('Teams server host directory', () => {
  it('upserts hosts and lists them by account without business payload', () => {
    const directory = upsertDirectoryHost(createHostDirectory(), baseHost, '2026-09-04T00:00:00.000Z')
    expect(listDirectoryHosts(directory, 'account-a')).toHaveLength(1)
    expect(listDirectoryHosts(directory, 'account-b')).toHaveLength(0)
    expect(directory.hosts.get('host-a')).not.toHaveProperty('sessionId')
    expect(directory.hosts.get('host-a')).not.toHaveProperty('permissionId')
  })

  it('rejects business payload fields in directory input', () => {
    const polluted = Object.assign({}, baseHost, { sessionId: 'ses-1' }) as never
    expect(() => upsertDirectoryHost(createHostDirectory(), polluted)).toThrow(/business payload field/)
  })

  it('refreshes presence and marks stale hosts explicitly', () => {
    const seeded = upsertDirectoryHost(createHostDirectory(), {
      ...baseHost,
      lastSeenAt: '2026-09-04T00:00:00.000Z',
    }, '2026-09-04T00:00:00.000Z')
    const refreshed = touchHostPresence(seeded, 'host-a', '2026-09-04T00:01:00.000Z')
    expect(refreshed.hosts.get('host-a')?.health).toBe('ready')
    const stale = removeStaleHosts(refreshed, '2026-09-04T00:03:00.000Z', 90_000)
    expect(stale.hosts.get('host-a')?.health).toBe('stale')
  })

  it('removes hosts explicitly', () => {
    const seeded = upsertDirectoryHost(createHostDirectory(), baseHost, '2026-09-04T00:00:00.000Z')
    expect(() => removeDirectoryHost(seeded, 'missing')).toThrow(/unknown host/)
    const removed = removeDirectoryHost(seeded, 'host-a')
    expect(listDirectoryHosts(removed)).toHaveLength(0)
  })
})
