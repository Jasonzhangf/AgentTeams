import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RelationRole } from '../packages/shared/src/teams-connection.ts'
import {
  RELATIONS_INTENT_FILE_NAME,
  RELATIONS_INTENT_VERSION,
  readRelationsIntentRecord,
  relationsIntentPath,
  writeRelationsIntentRecord,
  type RelationsIntentChange,
  type RelationsIntentRecord,
} from './relations-intent-store.ts'
import { RuntimeConfigError, type ConfigApplyError, type ConfigApplyResult } from './runtime-config.ts'

/** One real temp directory per case; the store and its records are real files. */
async function withStore(task: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'relations-intent-'))
  const path = relationsIntentPath(directory)
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

async function readRecord(path: string): Promise<RelationsIntentRecord> {
  const record = await readRelationsIntentRecord(path)
  if (record === undefined) throw new Error(`expected a durable relations intent record at ${path}`)
  return record
}

function failedWith(result: ConfigApplyResult): ConfigApplyError {
  if (result.status !== 'failed') throw new Error(`expected a failed result, got ${result.status}`)
  return result.error
}

/** A typed throw is the required outcome; a resolved value is a test failure. */
async function failureOf(call: Promise<unknown>): Promise<RuntimeConfigError> {
  try {
    await call
  } catch (error) {
    if (error instanceof RuntimeConfigError) return error
    throw error
  }
  throw new Error('expected the call to fail with a typed error')
}

const connectBeta: RelationsIntentChange = { op: 'connect', agentId: 'agent-beta', role: 'peer' }

describe('relations intent store', () => {
  it('derives the record path inside the daemon data directory and reads a missing file as undefined', async () => {
    await withStore(async (path, directory) => {
      expect(path).toBe(join(directory, RELATIONS_INTENT_FILE_NAME))
      expect(path).toBe(join(directory, 'relations-intent.json'))
      expect(await readRelationsIntentRecord(path)).toBeUndefined()
    })
  })

  it('accepts a connect on an empty store as revision 1', async () => {
    await withStore(async path => {
      const result = await writeRelationsIntentRecord(path, 0, connectBeta)
      expect(result).toEqual({ status: 'applied', effectiveRevision: 1 })

      const record = await readRecord(path)
      expect(record.version).toBe(RELATIONS_INTENT_VERSION)
      expect(record.revision).toBe(1)
      expect(record.peers).toEqual([{ agentId: 'agent-beta', role: 'peer' }])
      expect(Number.isNaN(Date.parse(record.updatedAt))).toBe(false)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    })
  })

  it('bumps the revision on the second connect', async () => {
    await withStore(async path => {
      expect(await writeRelationsIntentRecord(path, 0, connectBeta)).toEqual({ status: 'applied', effectiveRevision: 1 })
      const result = await writeRelationsIntentRecord(path, 1, { op: 'connect', agentId: 'agent-gamma', role: 'master' })
      expect(result).toEqual({ status: 'applied', effectiveRevision: 2 })

      const record = await readRecord(path)
      expect(record.revision).toBe(2)
      expect(record.peers).toEqual([
        { agentId: 'agent-beta', role: 'peer' },
        { agentId: 'agent-gamma', role: 'master' },
      ])
    })
  })

  it('replaces the whole desired relation set', async () => {
    await withStore(async path => {
      await writeRelationsIntentRecord(path, 0, connectBeta)
      const replaced = await writeRelationsIntentRecord(path, 1, {
        op: 'replace',
        peers: [
          { agentId: 'agent-delta', role: 'master' },
          { agentId: 'agent-epsilon', role: 'peer' },
        ],
      })
      expect(replaced).toEqual({ status: 'applied', effectiveRevision: 2 })
      expect((await readRecord(path)).peers).toEqual([
        { agentId: 'agent-delta', role: 'master' },
        { agentId: 'agent-epsilon', role: 'peer' },
      ])

      const emptied = await writeRelationsIntentRecord(path, 2, { op: 'replace', peers: [] })
      expect(emptied).toEqual({ status: 'applied', effectiveRevision: 3 })
      const record = await readRecord(path)
      expect(record.revision).toBe(3)
      expect(record.peers).toEqual([])
    })
  })

  it('treats a disconnect of an absent agent as a no-op that still bumps the revision', async () => {
    await withStore(async path => {
      await writeRelationsIntentRecord(path, 0, connectBeta)
      const noop = await writeRelationsIntentRecord(path, 1, { op: 'disconnect', agentId: 'agent-absent' })
      expect(noop).toEqual({ status: 'applied', effectiveRevision: 2 })

      const afterNoop = await readRecord(path)
      expect(afterNoop.revision).toBe(2)
      expect(afterNoop.peers).toEqual([{ agentId: 'agent-beta', role: 'peer' }])

      const removed = await writeRelationsIntentRecord(path, 2, { op: 'disconnect', agentId: 'agent-beta' })
      expect(removed).toEqual({ status: 'applied', effectiveRevision: 3 })
      const afterRemove = await readRecord(path)
      expect(afterRemove.revision).toBe(3)
      expect(afterRemove.peers).toEqual([])
    })
  })

  it('refuses a stale expectedRevision with REVISION_CONFLICT and leaves the record untouched', async () => {
    await withStore(async path => {
      await writeRelationsIntentRecord(path, 0, connectBeta)
      const before = await readFile(path)

      const result = await writeRelationsIntentRecord(path, 0, { op: 'connect', agentId: 'agent-gamma', role: 'peer' })
      expect(failedWith(result).code).toBe('REVISION_CONFLICT')
      expect((await readFile(path)).equals(before)).toBe(true)
      expect((await readRecord(path)).revision).toBe(1)
    })
  })

  it('refuses an unknown role, an unknown agent identity, and a duplicate agent as INVALID_INPUT', async () => {
    await withStore(async path => {
      // `owner` is not a frozen RelationRole; the cast only defeats the compiler.
      const unknownRole: RelationsIntentChange = { op: 'connect', agentId: 'agent-beta', role: 'owner' as unknown as RelationRole }
      expect(failedWith(await writeRelationsIntentRecord(path, 0, unknownRole)).code).toBe('INVALID_INPUT')

      // `agent beta` is a string that is not a frozen agent identity.
      const unknownAgent: RelationsIntentChange = { op: 'connect', agentId: 'agent beta', role: 'peer' }
      expect(failedWith(await writeRelationsIntentRecord(path, 0, unknownAgent)).code).toBe('INVALID_INPUT')

      const duplicateInPayload: RelationsIntentChange = {
        op: 'replace',
        peers: [
          { agentId: 'agent-beta', role: 'peer' },
          { agentId: 'agent-beta', role: 'master' },
        ],
      }
      expect(failedWith(await writeRelationsIntentRecord(path, 0, duplicateInPayload)).code).toBe('INVALID_INPUT')

      await writeRelationsIntentRecord(path, 0, connectBeta)
      const duplicateOfStored: RelationsIntentChange = { op: 'connect', agentId: 'agent-beta', role: 'master' }
      expect(failedWith(await writeRelationsIntentRecord(path, 1, duplicateOfStored)).code).toBe('INVALID_INPUT')
      expect((await readRecord(path)).revision).toBe(1)
    })
  })

  it('throws a typed error for an unknown or malformed stored record', async () => {
    await withStore(async path => {
      await writeFile(path, '{ "version": 1, "revision":', 'utf8')
      expect((await failureOf(readRelationsIntentRecord(path))).code).toBe('INVALID_INPUT')

      await writeFile(path, JSON.stringify({ version: RELATIONS_INTENT_VERSION + 1, revision: 1, peers: [], updatedAt: 'now' }), 'utf8')
      expect((await failureOf(readRelationsIntentRecord(path))).code).toBe('UNSUPPORTED_VERSION')

      await writeFile(path, JSON.stringify({ version: RELATIONS_INTENT_VERSION, revision: 0, peers: [], updatedAt: 'now' }), 'utf8')
      expect((await failureOf(readRelationsIntentRecord(path))).code).toBe('INVALID_INPUT')

      await writeFile(path, JSON.stringify({
        version: RELATIONS_INTENT_VERSION,
        revision: 1,
        peers: [{ agentId: 'agent-beta', role: 'peer' }, { agentId: 'agent-beta', role: 'master' }],
        updatedAt: 'now',
      }), 'utf8')
      expect((await failureOf(readRelationsIntentRecord(path))).code).toBe('INVALID_INPUT')
    })
  })

  it('leaves a malformed existing record untouched on a refused write', async () => {
    await withStore(async path => {
      const malformed = '{ "version": 1, "revision": 1, "peers": ['
      await writeFile(path, malformed, 'utf8')

      const refusal = await failureOf(writeRelationsIntentRecord(path, 1, connectBeta))
      expect(refusal.code).toBe('INVALID_INPUT')
      expect(await readFile(path, 'utf8')).toBe(malformed)
    })
  })

  it.skipIf(process.platform !== 'darwin')(
    'reports an uncertain fence when the rename fails after the temporary write',
    async () => {
      await withStore(async (path, directory) => {
        await writeRelationsIntentRecord(path, 0, connectBeta)
        const before = await readFile(path)
        // A real macOS immutable target makes rename fail with EPERM while the
        // mode-0o600 temporary write still succeeds.
        freeze(path)

        const result = await writeRelationsIntentRecord(path, 1, { op: 'connect', agentId: 'agent-gamma', role: 'peer' })
        if (result.status !== 'uncertain') throw new Error(`expected an uncertain result, got ${result.status}`)
        expect(result.error.code).toBe('RESULT_UNKNOWN')
        expect(result.fence.error).toEqual(result.error)
        expect(result.fence.operation.kind).toBe('apply')
        expect(result.fence.target.acceptedRevision).toBe(1)
        expect(result.fence.substrate.effectiveRevision).toBe(2)
        expect(result.fence.substrate.effectiveHandleFingerprint).toBe(`${path}\u0000${2}`)

        expect((await readFile(path)).equals(before)).toBe(true)
        expect((await readRecord(path)).revision).toBe(1)
        expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
      })
    },
  )
})
