import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { HistoryRecord } from '../packages/shared/src/acp.ts'
import { AcpError } from '../packages/shared/src/acp.ts'
import type { HistoryPage, HistoryQuery, HistoryReadPort } from '../packages/shared/src/teams-state.ts'
import { parseHistoryQuery } from '../packages/shared/src/teams-state.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'

/**
 * Durable execution-history store owned by runtime.
 *
 * It implements the agent-host write port (`AcpHistoryPort`) and the frozen
 * public read port (`HistoryReadPort`). It stores records only: a restart
 * reloads ordered records and never rebuilds a pending request, callback, or
 * execution task, and history is never a scheduling source.
 */

const STORE_VERSION = 1
const DEFAULT_RETENTION = 1000
const DEFAULT_FILE_NAME = 'acp-history.json'

export interface AcpHistoryStore extends AcpHistoryPort, HistoryReadPort {
  /** Absolute path of the durable history file. */
  readonly path: string
}

export interface CreateAcpHistoryStoreInput {
  /** The daemon's own data directory. */
  readonly directory: string
  readonly fileName?: string
  /** Maximum retained records; the oldest records are pruned first. */
  readonly retention?: number
}

interface StoreDocument {
  readonly version: typeof STORE_VERSION
  readonly records: readonly HistoryRecord[]
}

function fail(message: string): never {
  throw new AcpError('HISTORY_UNAVAILABLE', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDocument(text: string, path: string): readonly HistoryRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    fail(`ACP history file is not valid JSON (${path}): ${cause instanceof Error ? cause.message : 'parse error'}`)
  }
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.records)) {
    fail(`ACP history file has an unsupported shape (${path})`)
  }
  return parsed.records as readonly HistoryRecord[]
}

export async function createAcpHistoryStore(input: CreateAcpHistoryStoreInput): Promise<AcpHistoryStore> {
  if (input === null || typeof input !== 'object') fail('ACP history store input is required')
  if (typeof input.directory !== 'string' || input.directory.length === 0) fail('ACP history directory is required')
  const retention = input.retention ?? DEFAULT_RETENTION
  if (!Number.isSafeInteger(retention) || retention < 1) fail('ACP history retention must be a positive safe integer')
  const directory = resolve(input.directory)
  const path = join(directory, input.fileName ?? DEFAULT_FILE_NAME)

  let records: HistoryRecord[] = []
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const existing = await readFile(path, 'utf8')
    records = [...parseDocument(existing, path)]
  } catch (cause) {
    if (cause instanceof AcpError) throw cause
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail(`ACP history file cannot be read (${path}): ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  let sequence = records.reduce((max, record) => Math.max(max, record.sequence), 0)
  let writeChain: Promise<unknown> = Promise.resolve()

  const persist = async (): Promise<void> => {
    const document: StoreDocument = { version: STORE_VERSION, records }
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } catch (cause) {
      await unlink(temporary).catch(() => undefined)
      fail(`ACP history write failed (${path}): ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const append = (record: Omit<HistoryRecord, 'recordId' | 'sequence'>): Promise<HistoryRecord> => {
    const run = writeChain.then(async () => {
      const previous = records
      const stored: HistoryRecord = { ...record, recordId: `acp-history-${sequence + 1}`, sequence: sequence + 1 }
      records = [...records, stored]
      if (records.length > retention) records = records.slice(records.length - retention)
      try {
        await persist()
      } catch (cause) {
        // A record that did not reach durable storage must not appear stored,
        // and a failed prune must not drop records the file still holds.
        records = previous
        throw cause
      }
      sequence = stored.sequence
      return stored
    })
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  const query = async (raw: HistoryQuery): Promise<HistoryPage> => {
    const parsed = parseHistoryQuery(raw)
    const before = parsed.beforeSequence ?? Number.MAX_SAFE_INTEGER
    const matching = records
      .filter(record => record.sequence < before)
      .filter(record => parsed.kind === undefined || record.kind === parsed.kind)
      .filter(record => parsed.agentId === undefined || record.agentId === parsed.agentId)
      .filter(record => parsed.sessionId === undefined || record.sessionId === parsed.sessionId)
      .sort((left, right) => right.sequence - left.sequence)
    const page = matching.slice(0, parsed.limit)
    const nextBeforeSequence = matching.length > page.length ? page[page.length - 1].sequence : undefined
    return {
      records: page,
      ...(nextBeforeSequence === undefined ? {} : { nextBeforeSequence }),
    }
  }

  return { path, append, query }
}
