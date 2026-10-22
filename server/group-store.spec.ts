import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendJsonLine,
  ensureDirectory,
  groupPaths,
  readJsonFile,
  readJsonLines,
  watermarkFile,
  writeJsonFile,
} from './group-store.ts'

const roots: string[] = []

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'group-store-'))
  roots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('group store paths', () => {
  it('keeps one scope directory and one group subdirectory', () => {
    const paths = groupPaths('/data', 'acct', 'scope', 'g1')
    expect(paths.groupsFile).toBe('/data/groups/acct/scope/groups.json')
    expect(paths.messagesFile).toBe('/data/groups/acct/scope/g1/messages.jsonl')
    expect(watermarkFile(paths, 'agent/a')).toBe('/data/groups/acct/scope/g1/watermarks/agent%2Fa.json')
  })
})

describe('json files', () => {
  it('round-trips a value and reports a missing file as undefined', () => {
    const directory = root()
    const file = join(directory, 'groups.json')
    expect(readJsonFile(file)).toBeUndefined()
    writeJsonFile(file, { groups: [{ groupId: 'g1' }] })
    expect(readJsonFile(file)).toEqual({ groups: [{ groupId: 'g1' }] })
  })

  it('creates the directory with owner-only permissions and the file 0600', () => {
    const directory = root()
    const nested = join(directory, 'a', 'b')
    const file = join(nested, 'sessions.json')
    writeJsonFile(file, { ok: true })
    expect(statSync(nested).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('replaces content atomically and leaves no temporary sibling', () => {
    const directory = root()
    ensureDirectory(directory)
    const file = join(directory, 'actions.json')
    writeJsonFile(file, { v: 1 })
    writeJsonFile(file, { v: 2 })
    expect(readJsonFile(file)).toEqual({ v: 2 })
    expect(readFileSync(file, 'utf8')).toContain('"v":2')
  })
})

describe('message log', () => {
  it('appends records and reads them back in order', () => {
    const directory = root()
    const file = join(directory, 'messages.jsonl')
    appendJsonLine(file, { sequence: 1 })
    appendJsonLine(file, { sequence: 2 })
    expect(readJsonLines<{ sequence: number }>(file).records).toEqual([{ sequence: 1 }, { sequence: 2 }])
  })

  it('drops a partial tail line and reports it instead of failing the whole log', () => {
    const directory = root()
    const file = join(directory, 'messages.jsonl')
    appendJsonLine(file, { sequence: 1 })
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"sequence":2`)
    const read = readJsonLines<{ sequence: number }>(file)
    expect(read.records).toEqual([{ sequence: 1 }])
    expect(read.truncatedTail).toBe(true)
  })

  it('rejects corruption before the tail instead of skipping a record', () => {
    const directory = root()
    const file = join(directory, 'messages.jsonl')
    writeFileSync(file, '{"sequence":1}\nnot-json\n{"sequence":3}\n')
    expect(() => readJsonLines(file)).toThrow(/corrupt before its tail/)
  })

  it('reports an empty or missing log as empty without a tail defect', () => {
    const directory = root()
    const file = join(directory, 'messages.jsonl')
    expect(readJsonLines(file)).toEqual({ records: [], truncatedTail: false })
    writeFileSync(file, '')
    expect(readJsonLines(file)).toEqual({ records: [], truncatedTail: false })
  })
})
