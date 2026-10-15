import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SESSION_OBSERVATION_FILE_NAME,
  SESSION_OBSERVATION_VERSION,
  readSessionObservationRecord,
  sessionObservationScopePath,
  writeSessionObservationRecord,
  type SessionObservationSnapshot,
} from './session-observation-store.ts'
import { SESSION_INTENT_FILE_NAME, sessionIntentScopePath } from './session-intent-store.ts'
import type { ConfigApplyResult } from './runtime-config.ts'

/**
 * The agent daemon publishes its own Session and permission observation; the control daemon
 * reads it. These cases bind the store's own decisions — the CAS fence, the whole-snapshot
 * replacement, the crossing refusal, and the honest absence of a record that was never
 * written — against real files.
 *
 * The real end-to-end path (a live agent daemon publishing a permission its engine raised,
 * and a live control daemon projecting it) is the black box, not this spec.
 */

const SNAPSHOT: SessionObservationSnapshot = {
  agentId: 'agent-alpha',
  sessions: [{ sessionId: 'ses-1' }],
  permissions: [{ notificationId: 'permission:acp-callback-1', sessionId: 'ses-1', permissionId: 'acp-callback-1' }],
}

function applied(result: ConfigApplyResult): number {
  expect(result.status).toBe('applied')
  return (result as { readonly effectiveRevision: number }).effectiveRevision
}

async function withStore(task: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-observation-'))
  try {
    await task(sessionObservationScopePath({ home: directory, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' }), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('session observation store', () => {
  it('reads a record that was never written as an honest absence', async () => {
    await withStore(async path => {
      expect(await readSessionObservationRecord(path)).toBeUndefined()
    })
  })

  it('writes the first observation at revision 1 and carries the snapshot verbatim', async () => {
    await withStore(async (path, directory) => {
      expect(applied(await writeSessionObservationRecord(path, 0, SNAPSHOT))).toBe(1)
      const record = await readSessionObservationRecord(path)
      expect(record?.version).toBe(SESSION_OBSERVATION_VERSION)
      expect(record?.agentId).toBe('agent-alpha')
      expect(record?.revision).toBe(1)
      expect(record?.sessions).toEqual([{ sessionId: 'ses-1' }])
      expect(record?.permissions).toEqual([
        { notificationId: 'permission:acp-callback-1', sessionId: 'ses-1', permissionId: 'acp-callback-1' },
      ])
      // The one account-and-scope layout: the observation sits beside the intent record.
      expect(path).toBe(join(sessionIntentScopePath({ home: directory, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' }).replace(SESSION_INTENT_FILE_NAME, SESSION_OBSERVATION_FILE_NAME)))
      expect(await readdir(join(directory, '.agentteams', 'sessions', 'local', 'local', 'agent-alpha'))).toEqual([SESSION_OBSERVATION_FILE_NAME])
      // Mode 0o600, and the atomic write leaves no temporary file behind.
      expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
    })
  })

  it('keeps one agent per record so two agents never share an observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-observation-'))
    try {
      const alpha = sessionObservationScopePath({ home: directory, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' })
      const beta = sessionObservationScopePath({ home: directory, accountId: 'local', scopeId: 'local', agentId: 'agent-beta' })
      expect(alpha).not.toBe(beta)
      expect(applied(await writeSessionObservationRecord(alpha, 0, SNAPSHOT))).toBe(1)
      expect(await readSessionObservationRecord(beta)).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses a stale revision and leaves the durable bytes untouched', async () => {
    await withStore(async path => {
      expect(applied(await writeSessionObservationRecord(path, 0, SNAPSHOT))).toBe(1)
      const before = await readFile(path, 'utf8')
      const stale = await writeSessionObservationRecord(path, 0, { ...SNAPSHOT, sessions: [{ sessionId: 'ses-2' }], permissions: [] })
      expect(stale.status).toBe('failed')
      expect(stale).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
      expect(await readFile(path, 'utf8')).toBe(before)
      expect(applied(await writeSessionObservationRecord(path, 1, { ...SNAPSHOT, sessions: [{ sessionId: 'ses-2' }], permissions: [] }))).toBe(2)
      expect((await readSessionObservationRecord(path))?.sessions).toEqual([{ sessionId: 'ses-2' }])
    })
  })

  it('replaces the whole observation so a closed Session and a resolved permission disappear', async () => {
    await withStore(async path => {
      expect(applied(await writeSessionObservationRecord(path, 0, SNAPSHOT))).toBe(1)
      expect(applied(await writeSessionObservationRecord(path, 1, { agentId: 'agent-alpha', sessions: [{ sessionId: 'ses-1' }, { sessionId: 'ses-2' }], permissions: [] }))).toBe(2)
      const record = await readSessionObservationRecord(path)
      expect(record?.sessions).toEqual([{ sessionId: 'ses-1' }, { sessionId: 'ses-2' }])
      expect(record?.permissions).toEqual([])
    })
  })

  it('refuses a permission row that names a Session the same snapshot does not report', async () => {
    await withStore(async path => {
      const result = await writeSessionObservationRecord(path, 0, {
        agentId: 'agent-alpha',
        sessions: [{ sessionId: 'ses-1' }],
        permissions: [{ notificationId: 'permission:acp-callback-1', sessionId: 'ses-other', permissionId: 'acp-callback-1' }],
      })
      expect(result.status).toBe('failed')
      expect(result).toMatchObject({ error: { code: 'INVALID_INPUT' } })
      expect(await readSessionObservationRecord(path)).toBeUndefined()
    })
  })

  it('refuses a repeated notificationId, a repeated sessionId and an empty identity', async () => {
    await withStore(async path => {
      const repeatedNotification = await writeSessionObservationRecord(path, 0, {
        ...SNAPSHOT,
        permissions: [
          { notificationId: 'permission:1', sessionId: 'ses-1', permissionId: 'acp-callback-1' },
          { notificationId: 'permission:1', sessionId: 'ses-1', permissionId: 'acp-callback-2' },
        ],
      })
      expect(repeatedNotification).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } })
      const repeatedSession = await writeSessionObservationRecord(path, 0, {
        agentId: 'agent-alpha',
        sessions: [{ sessionId: 'ses-1' }, { sessionId: 'ses-1' }],
        permissions: [],
      })
      expect(repeatedSession).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } })
      const emptyAgent = await writeSessionObservationRecord(path, 0, { ...SNAPSHOT, agentId: '' })
      expect(emptyAgent).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } })
      // A refused write never creates the record.
      expect(await readSessionObservationRecord(path)).toBeUndefined()
    })
  })

  it('throws the stored record own code instead of falling back to a default', async () => {
    await withStore(async path => {
      // The store creates the account and scope directory on its own write, so a raw broken
      // record needs the directory first.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'not json\n')
      await expect(readSessionObservationRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await writeFile(path, `{"version":9}\n`)
      await expect(readSessionObservationRecord(path)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
      await writeFile(path, `{"version":1,"revision":0,"updatedAt":"t","agentId":"agent-alpha","sessions":[],"permissions":[]}\n`)
      await expect(readSessionObservationRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      // A stored permission that lost its Session row is the same crossing refusal on read.
      await writeFile(path, `{"version":1,"revision":1,"updatedAt":"t","agentId":"agent-alpha","sessions":[],"permissions":[{"notificationId":"permission:1","sessionId":"ses-1","permissionId":"acp-callback-1"}]}\n`)
      await expect(readSessionObservationRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    })
  })
})
