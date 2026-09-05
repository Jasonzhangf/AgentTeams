import { describe, expect, it } from 'vitest'
import { createHostDirectory, upsertDirectoryHost } from '../server/directory.ts'
import {
  confirmDirectoryGeneration,
  createAccountDirectorySnapshot,
  refreshAccountDirectory,
  resolveHostFromDirectory,
} from './account-directory.ts'

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
})
