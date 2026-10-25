import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOCAL_GROUP_ENDPOINT_FILE_NAME,
  LOCAL_GROUP_ENDPOINT_VERSION,
  localGroupEndpointScopePath,
  readLocalGroupEndpointRecord,
  removeLocalGroupEndpointRecord,
  writeLocalGroupEndpointRecord,
  type LocalGroupEndpointSnapshot,
} from './local-group-endpoint-store.ts'
import { SESSION_INTENT_FILE_NAME, sessionIntentScopePath } from './session-intent-store.ts'
import type { ConfigApplyResult } from './runtime-config.ts'

/**
 * The agent daemon publishes the local group socket it really bound; the control daemon reads
 * it to forward Console frames. These cases bind the store's own decisions against real files:
 * the CAS fence, the absolute-path requirement, the honest absence of a never-written record,
 * and the typed refusal of a broken one.
 *
 * The real end-to-end path (a live agent daemon publishing, a live control daemon forwarding)
 * is the black box, not this spec.
 */

const SNAPSHOT: LocalGroupEndpointSnapshot = {
  agentId: 'agent-alpha',
  groupEndpoint: { kind: 'local-socket', socketPath: '/tmp/agentteams-run/agent-messaging.sock' },
}

function applied(result: ConfigApplyResult): number {
  expect(result.status).toBe('applied')
  return (result as { readonly effectiveRevision: number }).effectiveRevision
}

async function withStore(task: (path: string, home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'local-group-endpoint-'))
  try {
    await task(localGroupEndpointScopePath({ home, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' }), home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('local group endpoint store', () => {
  it('publishes the socket path beside the Session records of the same agent', async () => {
    await withStore(async (path, home) => {
      const sessionDirectory = dirname(sessionIntentScopePath({ home, accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' }))
      expect(dirname(path)).toBe(sessionDirectory)
      expect(path.endsWith(`/${LOCAL_GROUP_ENDPOINT_FILE_NAME}`)).toBe(true)
      expect(await readLocalGroupEndpointRecord(path)).toBeUndefined()
      expect(await readdir(sessionDirectory).catch(() => [] as string[])).not.toContain(LOCAL_GROUP_ENDPOINT_FILE_NAME)
      expect(SESSION_INTENT_FILE_NAME).toBe('session-intent.json')
    })
  })

  it('writes a first revision and reads back exactly the published endpoint', async () => {
    await withStore(async path => {
      expect(applied(await writeLocalGroupEndpointRecord(path, 0, SNAPSHOT))).toBe(1)
      const record = await readLocalGroupEndpointRecord(path)
      expect(record).toMatchObject({
        version: LOCAL_GROUP_ENDPOINT_VERSION,
        agentId: 'agent-alpha',
        revision: 1,
        groupEndpoint: { kind: 'local-socket', socketPath: SNAPSHOT.groupEndpoint.socketPath },
      })
      expect(typeof record?.updatedAt).toBe('string')
    })
  })

  it('refuses a stale or future revision instead of overwriting it', async () => {
    await withStore(async path => {
      applied(await writeLocalGroupEndpointRecord(path, 0, SNAPSHOT))
      const stale = await writeLocalGroupEndpointRecord(path, 0, SNAPSHOT)
      expect(stale.status).toBe('failed')
      expect((stale as { readonly error: { readonly code: string } }).error.code).toBe('REVISION_CONFLICT')
      const future = await writeLocalGroupEndpointRecord(path, 7, SNAPSHOT)
      expect((future as { readonly error: { readonly code: string } }).error.code).toBe('REVISION_CONFLICT')
      expect((await readLocalGroupEndpointRecord(path))?.revision).toBe(1)
      expect(applied(await writeLocalGroupEndpointRecord(path, 1, SNAPSHOT))).toBe(2)
    })
  })

  it('refuses a relative socket path, an empty one and an unknown transport kind', async () => {
    await withStore(async path => {
      for (const snapshot of [
        { agentId: 'agent-alpha', groupEndpoint: { kind: 'local-socket' as const, socketPath: 'agent-messaging.sock' } },
        { agentId: 'agent-alpha', groupEndpoint: { kind: 'local-socket' as const, socketPath: '' } },
        { agentId: '', groupEndpoint: { kind: 'local-socket' as const, socketPath: '/tmp/x.sock' } },
        { agentId: 'agent-alpha', groupEndpoint: { kind: 'tcp' as never, socketPath: '/tmp/x.sock' } },
      ]) {
        const result = await writeLocalGroupEndpointRecord(path, 0, snapshot)
        expect(result.status).toBe('failed')
        expect((result as { readonly error: { readonly code: string } }).error.code).toBe('INVALID_INPUT')
      }
      expect(await readLocalGroupEndpointRecord(path)).toBeUndefined()
    })
  })

  it('refuses a broken stored record instead of falling back to a default endpoint', async () => {
    await withStore(async path => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '{"version":1,"agentId":"agent-alpha","revision":1,"updatedAt":"t","groupEndpoint":{"kind":"local-socket","socketPath":"relative"}}', 'utf8')
      await expect(readLocalGroupEndpointRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })

      await writeFile(path, '{"version":9}', 'utf8')
      await expect(readLocalGroupEndpointRecord(path)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })

      await writeFile(path, 'not json', 'utf8')
      await expect(readLocalGroupEndpointRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    })
  })

  it('withdraws the record and treats an already absent one as withdrawn', async () => {
    await withStore(async path => {
      applied(await writeLocalGroupEndpointRecord(path, 0, SNAPSHOT))
      await removeLocalGroupEndpointRecord(path)
      expect(await readLocalGroupEndpointRecord(path)).toBeUndefined()
      await expect(removeLocalGroupEndpointRecord(path)).resolves.toBeUndefined()
    })
  })
})
