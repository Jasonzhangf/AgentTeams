import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sessionObservationScopePath, writeSessionObservationRecord } from '../config/session-observation-store.ts'
import { readObservedSessionProjection } from './control-process.ts'

/**
 * The control daemon projects the Sessions and pending permissions each declared agent
 * daemon published. These cases bind the reader's own decisions — the directory presence
 * gate, the `agentId` crossing refusal, and the isolation of one broken record — against
 * real files.
 *
 * The real end-to-end proof (a live agent daemon publishing an engine-raised permission and
 * a live control daemon streaming it to a live Console) is the black box, not this spec.
 */

const PEER = { agentId: 'agent-alpha', accountId: 'local', scopeId: 'local' }

async function publish(home: string, peer: typeof PEER, revision = 0): Promise<string> {
  const path = sessionObservationScopePath({ home, ...peer })
  const result = await writeSessionObservationRecord(path, revision, {
    agentId: peer.agentId,
    sessions: [{ sessionId: 'ses-1' }],
    permissions: [{ notificationId: 'permission:acp-callback-1', sessionId: 'ses-1', permissionId: 'acp-callback-1' }],
  })
  expect(result.status).toBe('applied')
  return path
}

describe('control Session observation projection', () => {
  it('projects the Sessions and pending permissions an online peer published', async () => {
    const home = await mkdtemp(join(tmpdir(), 'control-observation-'))
    try {
      await publish(home, PEER)
      const projected = await readObservedSessionProjection({ home, peers: [PEER], presence: new Map([['agent-alpha', 'online']]) })
      expect(projected.sessions).toEqual([{ agentId: 'agent-alpha', sessionId: 'ses-1' }])
      expect(projected.notifications).toEqual([{
        agentId: 'agent-alpha',
        notificationId: 'permission:acp-callback-1',
        sessionId: 'ses-1',
        kind: 'permission',
        state: 'pending',
        title: 'Permission request',
        permissionId: 'acp-callback-1',
      }])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('projects nothing for a peer the directory reports as not online', async () => {
    const home = await mkdtemp(join(tmpdir(), 'control-observation-'))
    try {
      await publish(home, PEER)
      const offline = await readObservedSessionProjection({ home, peers: [PEER], presence: new Map([['agent-alpha', 'offline']]) })
      expect(offline).toEqual({ sessions: [], notifications: [] })
      const stopped = await readObservedSessionProjection({ home, peers: [PEER], presence: new Map([['agent-alpha', 'stopped']]) })
      expect(stopped).toEqual({ sessions: [], notifications: [] })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps the last published observation when no directory reports the peer, and none when nothing was published', async () => {
    const home = await mkdtemp(join(tmpdir(), 'control-observation-'))
    try {
      await publish(home, PEER)
      // A deployment with no registry has no liveness truth. The owner's own empty
      // observation on stop is what removes these rows, so the last one stays until then.
      const unreported = await readObservedSessionProjection({ home, peers: [PEER], presence: new Map() })
      expect(unreported.sessions).toEqual([{ agentId: 'agent-alpha', sessionId: 'ses-1' }])
      const undeclared = await readObservedSessionProjection({ home, peers: [], presence: new Map() })
      expect(undeclared).toEqual({ sessions: [], notifications: [] })
      const absent = await readObservedSessionProjection({
        home,
        peers: [{ agentId: 'agent-gamma', accountId: 'local', scopeId: 'local' }],
        presence: new Map(),
      })
      expect(absent).toEqual({ sessions: [], notifications: [] })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses to project a record that names another agent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'control-observation-'))
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const path = await publish(home, PEER)
      // agent-beta's record now sits where agent-alpha's own record belongs.
      await writeFile(path, `${JSON.stringify({
        version: 1,
        agentId: 'agent-beta',
        revision: 2,
        updatedAt: '2026-10-15T00:00:00.000Z',
        sessions: [{ sessionId: 'ses-beta' }],
        permissions: [],
      })}\n`)
      const projected = await readObservedSessionProjection({ home, peers: [PEER], presence: new Map([['agent-alpha', 'online']]) })
      expect(projected).toEqual({ sessions: [], notifications: [] })
      // The refusal is reported, never silent.
      expect(reported.mock.calls.flat().join('\n')).toContain('agent-beta')
    } finally {
      reported.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('serves the rest of the directory when one peer record is broken', async () => {
    const home = await mkdtemp(join(tmpdir(), 'control-observation-'))
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await publish(home, PEER)
      const broken = sessionObservationScopePath({ home, accountId: 'local', scopeId: 'local', agentId: 'agent-gamma' })
      await mkdir(dirname(broken), { recursive: true })
      await writeFile(broken, 'not json\n')
      const projected = await readObservedSessionProjection({
        home,
        peers: [PEER, { agentId: 'agent-gamma', accountId: 'local', scopeId: 'local' }],
        presence: new Map([['agent-alpha', 'online'], ['agent-gamma', 'online']]),
      })
      expect(projected.sessions).toEqual([{ agentId: 'agent-alpha', sessionId: 'ses-1' }])
      expect(projected.notifications).toHaveLength(1)
      expect(reported.mock.calls.flat().join('\n')).toContain('agent-gamma')
    } finally {
      reported.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })
})
