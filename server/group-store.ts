import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * File layout for the hub-owned group state.
 *
 * One writer per file is a caller guarantee: the hub process serializes writes.
 * Every file is written whole and renamed into place, except the message log,
 * which is append-only so a crash cannot renumber earlier records.
 */

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export interface GroupPaths {
  readonly root: string
  readonly groupsFile: string
  readonly sessionsFile: string
  readonly actionsFile: string
  readonly externalOpsFile: string
  readonly messagesFile: string
  readonly watermarksDir: string
}

export function groupPaths(dataDirectory: string, accountId: string, scopeId: string, groupId: string): GroupPaths {
  const root = join(dataDirectory, 'groups', accountId, scopeId, groupId)
  return {
    root,
    groupsFile: join(dataDirectory, 'groups', accountId, scopeId, 'groups.json'),
    sessionsFile: join(root, 'sessions.json'),
    actionsFile: join(root, 'actions.json'),
    externalOpsFile: join(root, 'external-ops.json'),
    messagesFile: join(root, 'messages.jsonl'),
    watermarksDir: join(root, 'watermarks'),
  }
}

export function watermarkFile(paths: GroupPaths, agentId: string): string {
  return join(paths.watermarksDir, `${encodeURIComponent(agentId)}.json`)
}

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE })
  chmodSync(path, DIRECTORY_MODE)
}

/** Read a whole JSON file. A missing file is not an error; a corrupt file is. */
export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  if (text.trim().length === 0) return undefined
  return JSON.parse(text) as T
}

/** Write whole content through a temporary sibling, then rename. */
export function writeJsonFile(path: string, value: unknown): void {
  ensureDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: FILE_MODE })
  chmodSync(temporary, FILE_MODE)
  renameSync(temporary, path)
}

export function appendJsonLine(path: string, value: unknown): void {
  ensureDirectory(dirname(path))
  if (!existsSync(path)) writeFileSync(path, '', { mode: FILE_MODE })
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: FILE_MODE })
}

/** Rewrite a whole JSONL file through a temporary sibling, then rename. */
export function writeJsonLines(path: string, records: readonly unknown[]): void {
  ensureDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, records.map(record => `${JSON.stringify(record)}\n`).join(''), { mode: FILE_MODE })
  chmodSync(temporary, FILE_MODE)
  renameSync(temporary, path)
}

/**
 * Drop a partial final line left by a crash. Returns how many bytes were
 * dropped, or zero when the file already ends on a record boundary. The caller
 * records the drop; this only repairs the physical file so a later append cannot
 * merge into the partial line.
 */
export function repairJsonLinesTail(path: string): number {
  if (!existsSync(path)) return 0
  const text = readFileSync(path, 'utf8')
  if (text.length === 0 || text.endsWith('\n')) return 0
  const boundary = text.lastIndexOf('\n')
  const kept = boundary < 0 ? '' : text.slice(0, boundary + 1)
  writeFileSync(path, kept, { mode: FILE_MODE })
  chmodSync(path, FILE_MODE)
  return text.length - kept.length
}

export interface LogRead<T> {
  readonly records: readonly T[]
  /** A crash can leave a partial final line. It is dropped and reported, never repaired silently. */
  readonly truncatedTail: boolean
}

export function readJsonLines<T>(path: string): LogRead<T> {
  if (!existsSync(path)) return { records: [], truncatedTail: false }
  const text = readFileSync(path, 'utf8')
  if (text.length === 0) return { records: [], truncatedTail: false }
  const terminated = text.endsWith('\n')
  const lines = text.split('\n')
  if (terminated) lines.pop()
  const records: T[] = []
  let truncatedTail = false
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue
    try {
      records.push(JSON.parse(line) as T)
    } catch {
      // Only the final line may be partial. An unreadable middle line is real corruption.
      if (index === lines.length - 1) truncatedTail = true
      else throw new Error('group-store: message log is corrupt before its tail')
    }
  }
  return { records, truncatedTail }
}
