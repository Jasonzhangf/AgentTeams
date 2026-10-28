import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AcpPendingPermission } from '../agent-host/acp-host.ts'
import { readSessionObservationRecord, sessionObservationScopePath } from '../config/session-observation-store.ts'
import { createSessionObservationPublisher } from './session-observation-publisher.ts'
import type { ConsoleSessionEventView } from '../packages/shared/src/console-api.ts'

/**
 * The agent daemon publishes the Sessions its engine really opened and the permission
 * callbacks its engine is really awaiting, so the control daemon's Console projection can
 * carry them. These cases bind the publisher's own decisions — the whole-snapshot shape,
 * the no-heartbeat rule, the Session crossing refusal and the single-writer fence — against
 * real files and the real store.
 *
 * The real end-to-end path (a live engine raising a real `session/request_permission` and a
 * live control daemon projecting it) is the black box, not this spec.
 */

interface FakeEngine {
  sessions: string[]
  permissions: AcpPendingPermission[]
  events: ConsoleSessionEventView[]
}

function pending(permissionId: string, sessionId: string): AcpPendingPermission {
  return {
    ref: { connectionId: 'serve-1', channelId: 'local-1', engineInstanceId: 'engine-1', targetGeneration: 1 },
    sessionId,
    permissionId,
    options: [{ optionId: 'once', name: 'Allow once', kind: 'once' }],
  }
}

/** One real record directory, with the fake engine state the publisher actually reads. */
async function withPublisher(
  task: (engine: FakeEngine, publisher: ReturnType<typeof createSessionObservationPublisher>, path: string) => Promise<void>,
  initial?: Partial<FakeEngine>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-observation-publisher-'))
  const path = sessionObservationScopePath({ home: directory, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' })
  const engine: FakeEngine = { sessions: initial?.sessions ?? [], permissions: initial?.permissions ?? [], events: initial?.events ?? [] }
  const publisher = createSessionObservationPublisher({
    host: { openedSessions: () => engine.sessions, pendingPermissions: () => engine.permissions, sessionEvents: () => engine.events },
    recordPath: path,
    agentId: 'agent-alpha',
  })
  try {
    await task(engine, publisher, path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('session observation publisher', () => {
  it('publishes the Sessions the host holds and the permissions it awaits, at revision 1', async () => {
    await withPublisher(async (_engine, publisher, path) => {
      await publisher.publish()
      const record = await readSessionObservationRecord(path)
      expect(record?.agentId).toBe('agent-alpha')
      expect(record?.revision).toBe(1)
      expect(record?.sessions).toEqual([{ sessionId: 'ses-1' }])
      expect(record?.permissions).toEqual([{
        notificationId: 'permission:acp-callback-1',
        sessionId: 'ses-1',
        permissionId: 'acp-callback-1',
        options: [{ optionId: 'once', name: 'Allow once', kind: 'once' }],
      }])
      expect(publisher.failures()).toEqual([])
    }, { sessions: ['ses-1'], permissions: [pending('acp-callback-1', 'ses-1')] })
  })

  it('writes nothing when a pass observes no change, so a poll is not a heartbeat', async () => {
    await withPublisher(async (_engine, publisher, path) => {
      await publisher.publish()
      await publisher.publish()
      await publisher.publish()
      expect((await readSessionObservationRecord(path))?.revision).toBe(1)
    }, { sessions: ['ses-1'] })
  })

  it('publishes the host ordered Session events and drops events for a Session it no longer holds', async () => {
    const userEvent: ConsoleSessionEventView = {
      eventId: 'evt-user-1',
      agentId: 'agent-alpha',
      sessionId: 'ses-1',
      kind: 'message',
      state: 'completed',
      messageId: 'msg-1',
      role: 'user',
    }
    const finalEvent: ConsoleSessionEventView = {
      eventId: 'evt-final-1',
      agentId: 'agent-alpha',
      sessionId: 'ses-1',
      kind: 'final',
      state: 'completed',
      messageId: 'msg-asst-1',
    }
    const staleEvent: ConsoleSessionEventView = {
      eventId: 'evt-user-closed',
      agentId: 'agent-alpha',
      sessionId: 'ses-closed',
      kind: 'message',
      state: 'completed',
      messageId: 'msg-closed',
      role: 'user',
    }
    await withPublisher(async (engine, publisher, path) => {
      await publisher.publish()
      expect((await readSessionObservationRecord(path))?.sessionEvents).toEqual([userEvent, finalEvent])
      // A Session that closed contributes no event on the next whole snapshot.
      engine.sessions = []
      engine.events = []
      await publisher.publish()
      const record = await readSessionObservationRecord(path)
      expect(record?.revision).toBe(2)
      expect(record?.sessionEvents).toBeUndefined()
    }, { sessions: ['ses-1'], events: [userEvent, finalEvent, staleEvent] })
  })

  it('replaces the observation when a permission resolves and a Session closes', async () => {
    await withPublisher(async (engine, publisher, path) => {
      await publisher.publish()
      // The engine answered the callback, and the controller's channel closed with its Session.
      engine.sessions = []
      engine.permissions = []
      await publisher.publish()
      const record = await readSessionObservationRecord(path)
      expect(record?.revision).toBe(2)
      expect(record?.sessions).toEqual([])
      expect(record?.permissions).toEqual([])
    }, { sessions: ['ses-1'], permissions: [pending('acp-callback-1', 'ses-1')] })
  })

  it('refuses to publish a permission whose Session the host no longer holds', async () => {
    await withPublisher(async (_engine, publisher, path) => {
      await publisher.publish()
      const record = await readSessionObservationRecord(path)
      // The stored record stays one consistent observation: no row names a missing Session.
      expect(record?.permissions).toEqual([])
      expect(publisher.failures()).toEqual([])
    }, { sessions: [], permissions: [pending('acp-callback-1', 'ses-gone')] })
  })

  it('seeds from the durable record and refuses a record that names another agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-observation-publisher-'))
    const path = sessionObservationScopePath({ home: directory, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' })
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify({
        version: 1,
        agentId: 'agent-beta',
        revision: 4,
        updatedAt: '2026-10-15T00:00:00.000Z',
        sessions: [{ sessionId: 'ses-1' }],
        permissions: [],
      })}\n`)
      const publisher = createSessionObservationPublisher({
        host: { openedSessions: () => [], pendingPermissions: () => [], sessionEvents: () => [] },
        recordPath: path,
        agentId: 'agent-alpha',
      })
      await publisher.publish()
      expect(publisher.failures()).toMatchObject([{ agentId: 'agent-alpha', code: 'FORBIDDEN' }])
      // Another agent's bytes stay exactly as they were.
      expect((await readSessionObservationRecord(path))?.revision).toBe(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes overlapping passes, so a poll cannot lose its own write to a conflict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-observation-publisher-'))
    const path = sessionObservationScopePath({ home: directory, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' })
    try {
      // The poll tick and the stop-time publish share this one publisher, and clearing the
      // interval cannot cancel a pass that already started. This host reports a Session on the
      // first read and none on the second, which is what a stop looks like: two passes that ran
      // at once would read the same revision, so the second would fail a CAS conflict it did
      // not cause and the stale non-empty observation would stay on disk.
      let reads = 0
      const publisher = createSessionObservationPublisher({
        host: {
          openedSessions: () => { reads += 1; return reads === 1 ? ['ses-1'] : [] },
          pendingPermissions: () => [],
          sessionEvents: () => [],
        },
        recordPath: path,
        agentId: 'agent-alpha',
      })
      await Promise.all([publisher.publish(), publisher.publish()])
      expect(publisher.failures()).toEqual([])
      const record = await readSessionObservationRecord(path)
      // The last observation is the one that survives, and the two passes did not both claim
      // revision 1.
      expect(record?.sessions).toEqual([])
      expect(record?.revision).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rebases onto the durable revision after another writer moved the record', async () => {
    await withPublisher(async (engine, publisher, path) => {
      await publisher.publish()
      // Another writer advanced the record this daemon owns.
      const current = await readSessionObservationRecord(path)
      await writeFile(path, `${JSON.stringify({ ...current, revision: 9 })}\n`)
      engine.sessions = ['ses-2']
      await publisher.publish()
      expect(publisher.failures()).toMatchObject([{ code: 'REVISION_CONFLICT' }])
      await publisher.publish()
      // The next pass rebased onto revision 9 and published its own observation at 10.
      expect((await readSessionObservationRecord(path))?.revision).toBe(10)
      expect((await readSessionObservationRecord(path))?.sessions).toEqual([{ sessionId: 'ses-2' }])
    }, { sessions: ['ses-1'] })
  })
})
