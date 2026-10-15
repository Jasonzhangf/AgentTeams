import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SESSION_INTENT_FILE_NAME,
  SESSION_INTENT_VERSION,
  SESSION_INTENT_WATERMARK_FILE_NAME,
  SESSION_INTENT_WINDOW,
  pendingSessionIntents,
  readSessionIntentRecord,
  readSessionIntentWatermark,
  sessionIntentPath,
  sessionIntentScopePath,
  sessionIntentWatermarkPath,
  writeSessionIntentRecord,
  writeSessionIntentWatermark,
  type SessionIntentChange,
} from './session-intent-store.ts'
import { RuntimeConfigError, type ConfigApplyResult } from './runtime-config.ts'

/**
 * The control daemon writes the Session writes the Console submitted; the agent daemon
 * reads the same record. These cases bind the store's own decisions — the one CAS fence,
 * the retained window, the verbatim body, and the honest refusal of a reader that fell
 * behind — against real files.
 *
 * The real end-to-end path (a Console command on a live control daemon that makes a live
 * agent daemon act on its own Session) is the black box, not this spec.
 */

async function withStore(task: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-intent-'))
  const path = sessionIntentPath(directory)
  try {
    await task(path, directory)
  } finally {
    release(path)
    await rm(directory, { recursive: true, force: true })
  }
}

/** The macOS immutable flag blocks the rename without touching the temporary write. */
function freeze(path: string): void {
  execFileSync('chflags', ['uchg', path])
}

function release(path: string): void {
  if (process.platform !== 'darwin' || !existsSync(path)) return
  try {
    execFileSync('chflags', ['nouchg', path])
  } catch { /* the record was never made immutable */ }
}

function applied(result: ConfigApplyResult): number {
  expect(result.status).toBe('applied')
  return (result as { readonly effectiveRevision: number }).effectiveRevision
}

const PERMISSION: SessionIntentChange = {
  op: 'permission.reply',
  agentId: 'agent-alpha',
  sessionId: 'session-1',
  permissionId: 'permission-1',
  decision: 'once',
}

describe('session intent record', () => {
  it('creates the record at revision 1 and appends one intent per write', async () => {
    await withStore(async path => {
      expect(await readSessionIntentRecord(path)).toBeUndefined()
      expect(applied(await writeSessionIntentRecord(path, 0, PERMISSION))).toBe(1)
      expect(applied(await writeSessionIntentRecord(path, 1, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' }))).toBe(2)
      const record = await readSessionIntentRecord(path)
      expect(record?.version).toBe(SESSION_INTENT_VERSION)
      expect(record?.revision).toBe(2)
      expect(record?.oldestRevision).toBe(1)
      expect(record?.intents.map(intent => intent.kind)).toEqual(['permission.reply', 'session.cancel'])
      expect(record?.intents[0]).toMatchObject({ permissionId: 'permission-1', decision: 'once' })
      // Each intent carries its own identity, so a reader can never confuse two writes.
      expect(new Set(record?.intents.map(intent => intent.intentId)).size).toBe(2)
    })
  })

  it('is one CAS fence: a stale expectation is refused and the bytes stay exactly as they were', async () => {
    await withStore(async path => {
      await writeSessionIntentRecord(path, 0, PERMISSION)
      const before = await readFile(path, 'utf8')
      const refused = await writeSessionIntentRecord(path, 0, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' })
      expect(refused.status).toBe('failed')
      expect((refused as { readonly error: { readonly code: string } }).error.code).toBe('REVISION_CONFLICT')
      expect(await readFile(path, 'utf8')).toBe(before)
      // The caller that retries at the revision the store reported moves on.
      expect(applied(await writeSessionIntentRecord(path, 1, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' }))).toBe(2)
    })
  })

  it('refuses every change that cannot name a real Session write', async () => {
    await withStore(async path => {
      const cases: readonly unknown[] = [
        { op: 'session.prompt', agentId: 'agent-alpha', sessionId: 's' },
        { op: 'session.cancel', agentId: 'bad agent', sessionId: 's' },
        { op: 'session.cancel', agentId: 'agent-alpha', sessionId: '' },
        { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 's', decision: 'once' },
        { op: 'permission.reply', agentId: 'agent-alpha', sessionId: 's', permissionId: 'p', decision: 'sometimes' },
        { op: 'session.message', agentId: 'agent-alpha', sessionId: 's' },
        // A body JSON cannot carry is refused here, so the record never holds a key the
        // reader then fails to find.
        { op: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload: undefined },
      ]
      for (const change of cases) {
        const result = await writeSessionIntentRecord(path, 0, change as SessionIntentChange)
        expect(result.status).toBe('failed')
        expect((result as { readonly error: { readonly code: string } }).error.code).toBe('INVALID_INPUT')
      }
      // A refused change never created the record.
      expect(await readSessionIntentRecord(path)).toBeUndefined()
      expect((await readdir(join(path, '..'))).filter(name => name.includes('.tmp'))).toEqual([])
    })
  })

  it('carries the business body verbatim, including an explicit null and nested values', async () => {
    await withStore(async path => {
      const payload = { text: '你好', nested: { list: [1, 'two', null, { deep: true }] }, keep: '  spaced  ' }
      await writeSessionIntentRecord(path, 0, { op: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload })
      await writeSessionIntentRecord(path, 1, { op: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload: null })
      const record = await readSessionIntentRecord(path)
      expect(record?.intents[0]).toMatchObject({ kind: 'session.message', payload })
      expect(record?.intents[1]).toMatchObject({ kind: 'session.message', payload: null })
    })
  })

  it('is a typed throw on a broken record and never overwrites it', async () => {
    await withStore(async path => {
      // A well-formed record at revision 2 carries two intents, one per revision.
      await writeFile(path, '{"version":1,"revision":2,"oldestRevision":1,"intents":[{"intentId":"i","kind":"session.cancel","agentId":"agent-alpha","sessionId":"s"},{"intentId":"j","kind":"session.cancel","agentId":"agent-alpha","sessionId":"s"}],"updatedAt":"t"}\n')
      const result = await writeSessionIntentRecord(path, 1, PERMISSION)
      // The stored revision really is 2, so the CAS fence refuses instead of writing at 1.
      expect(result.status).toBe('failed')
      expect((result as { readonly error: { readonly code: string } }).error.code).toBe('REVISION_CONFLICT')
      await writeFile(path, 'not json\n')
      await expect(writeSessionIntentRecord(path, 0, PERMISSION)).rejects.toBeInstanceOf(RuntimeConfigError)
      expect(await readFile(path, 'utf8')).toBe('not json\n')
      await writeFile(path, '{"version":9}\n')
      await expect(readSessionIntentRecord(path)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
      await writeFile(path, '{"version":1,"revision":1,"oldestRevision":2,"intents":[],"updatedAt":"t"}\n')
      await expect(readSessionIntentRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await writeFile(path, '{"version":1,"revision":1,"oldestRevision":1,"intents":[{"intentId":"i","kind":"session.cancel","agentId":"bad agent","sessionId":"s"}],"updatedAt":"t"}\n')
      await expect(readSessionIntentRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    })
  })

  it('reports uncertain with the real fence when the atomic rename fails', async () => {
    if (process.platform !== 'darwin') return
    await withStore(async path => {
      await writeSessionIntentRecord(path, 0, PERMISSION)
      freeze(path)
      const result = await writeSessionIntentRecord(path, 1, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' })
      expect(result.status).toBe('uncertain')
      const fence = (result as { readonly fence: { readonly substrate: { readonly effectiveRevision: number } } }).fence
      expect(fence.substrate.effectiveRevision).toBe(2)
      release(path)
      // The durable bytes are still the first write, so the retry at revision 1 succeeds.
      expect((await readSessionIntentRecord(path))?.revision).toBe(1)
      expect(applied(await writeSessionIntentRecord(path, 1, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' }))).toBe(2)
    })
  })

  it('keeps a fixed window and advances the retained boundary when it drops', async () => {
    await withStore(async path => {
      for (let index = 0; index < SESSION_INTENT_WINDOW + 3; index += 1) {
        const result = await writeSessionIntentRecord(path, index, {
          op: 'session.message',
          agentId: 'agent-alpha',
          sessionId: 's',
          payload: index,
        })
        expect(applied(result)).toBe(index + 1)
      }
      const record = await readSessionIntentRecord(path)
      expect(record?.intents.length).toBe(SESSION_INTENT_WINDOW)
      expect(record?.revision).toBe(SESSION_INTENT_WINDOW + 3)
      expect(record?.oldestRevision).toBe(4)
      // The retained intents are the newest ones, in order.
      expect((record?.intents[0] as { readonly payload: number }).payload).toBe(3)
      expect((record?.intents.at(-1) as { readonly payload: number }).payload).toBe(SESSION_INTENT_WINDOW + 2)
    })
  })
})

describe('session intent reader view', () => {
  it('returns only the intents after the reader watermark, in order', async () => {
    await withStore(async path => {
      await writeSessionIntentRecord(path, 0, PERMISSION)
      await writeSessionIntentRecord(path, 1, { op: 'session.cancel', agentId: 'agent-alpha', sessionId: 'session-1' })
      await writeSessionIntentRecord(path, 2, { op: 'session.message', agentId: 'agent-beta', sessionId: 's', payload: 'x' })
      const record = await readSessionIntentRecord(path)
      expect(pendingSessionIntents(undefined, 0)).toEqual({ state: 'pending', intents: [], throughRevision: 0 })
      expect(pendingSessionIntents(record, 0)).toMatchObject({ state: 'pending', throughRevision: 3 })
      expect(pendingSessionIntents(record, 0).state === 'pending' && pendingSessionIntents(record, 0).intents.map(intent => intent.kind))
        .toEqual(['permission.reply', 'session.cancel', 'session.message'])
      const afterOne = pendingSessionIntents(record, 1)
      expect(afterOne.state === 'pending' && afterOne.intents.map(intent => intent.kind)).toEqual(['session.cancel', 'session.message'])
      expect(pendingSessionIntents(record, 3)).toMatchObject({ state: 'pending', intents: [], throughRevision: 3 })
    })
  })

  it('refuses a reader that fell behind the retained window instead of skipping', async () => {
    await withStore(async path => {
      for (let index = 0; index < SESSION_INTENT_WINDOW + 1; index += 1) {
        await writeSessionIntentRecord(path, index, { op: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload: index })
      }
      const record = await readSessionIntentRecord(path)
      expect(record?.oldestRevision).toBe(2)
      // A reader at revision 0 missed the dropped revision 1, so it must refuse. A reader
      // at revision 1 has every retained intent still ahead of it and can resume.
      expect(pendingSessionIntents(record, 0)).toEqual({ state: 'behind', appliedRevision: 0, oldestRevision: 2 })
      expect(pendingSessionIntents(record, 1)).toMatchObject({ state: 'pending', throughRevision: SESSION_INTENT_WINDOW + 1 })
      await writeSessionIntentRecord(path, SESSION_INTENT_WINDOW + 1, { op: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload: 'last' })
      const grown = await readSessionIntentRecord(path)
      expect(grown?.oldestRevision).toBe(3)
      expect(pendingSessionIntents(grown, 0)).toEqual({ state: 'behind', appliedRevision: 0, oldestRevision: 3 })
      expect(pendingSessionIntents(grown, 1)).toEqual({ state: 'behind', appliedRevision: 1, oldestRevision: 3 })
      expect(pendingSessionIntents(grown, 2)).toMatchObject({ state: 'pending' })
    })
  })

  it('refuses a record whose intent count does not cover its own revision span', async () => {
    await withStore(async path => {
      await writeSessionIntentRecord(path, 0, { op: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload: 1 })
      expect(await readSessionIntentRecord(path)).toMatchObject({ revision: 1, oldestRevision: 1 })

      // A record that claims revision 10 but carries 5 intents would let the reader advance its
      // watermark to 10 and skip revisions 6..10 without any refusal, so it is refused instead.
      const truncated = JSON.stringify({ version: 1, revision: 10, oldestRevision: 1, updatedAt: '2026-10-15T00:00:00.000Z', intents: Array.from({ length: 5 }, (_unused, index) => ({ intentId: `intent-${index}`, kind: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload: index })) })
      await writeFile(path, `${truncated}\n`)
      await expect(readSessionIntentRecord(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(readSessionIntentRecord(path)).rejects.toThrow(/incomplete/)

      // The write path never overwrites those bytes either: its own read throws first, so the
      // malformed record is refused instead of being replaced by a fresh one.
      await expect(writeSessionIntentRecord(path, 10, { op: 'session.message', agentId: 'agent-alpha', sessionId: 's', payload: 'next' }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect((await readFile(path, 'utf8')).trim()).toBe(truncated)
    })
  })
})

describe('session intent watermark', () => {
  it('is the reader own file, absent means nothing applied, and it round-trips', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-watermark-'))
    try {
      const path = sessionIntentWatermarkPath(directory)
      expect(path.endsWith(SESSION_INTENT_WATERMARK_FILE_NAME)).toBe(true)
      expect(await readSessionIntentWatermark(path)).toEqual({ version: SESSION_INTENT_VERSION, appliedRevision: 0 })
      await writeSessionIntentWatermark(path, 7)
      expect(await readSessionIntentWatermark(path)).toEqual({ version: SESSION_INTENT_VERSION, appliedRevision: 7 })
      await writeSessionIntentWatermark(path, 0)
      expect((await readSessionIntentWatermark(path)).appliedRevision).toBe(0)
      const mode = (await stat(path)).mode & 0o777
      expect(mode).toBe(0o600)
      await writeFile(path, '{"version":1,"appliedRevision":-1}\n')
      await expect(readSessionIntentWatermark(path)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('session intent path convention', () => {
  it('derives one record per target agent, account and scope, beside the relations record', () => {
    const path = sessionIntentScopePath({ home: '/tmp/home', accountId: 'local', scopeId: 'local', agentId: 'agent-alpha' })
    expect(path).toBe(join('/tmp/home', '.agentteams', 'sessions', 'local', 'local', 'agent-alpha', SESSION_INTENT_FILE_NAME))
    // One record has exactly one reading daemon, so two agents never share one record.
    expect(path).not.toBe(sessionIntentScopePath({ home: '/tmp/home', accountId: 'local', scopeId: 'local', agentId: 'agent-beta' }))
    expect(path).not.toBe(sessionIntentScopePath({ home: '/tmp/home', accountId: 'local', scopeId: 'other', agentId: 'agent-alpha' }))
  })
})
