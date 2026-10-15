import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { JsonValue } from '../control-protocol/agent-services.ts'
import type { ConfigApplyError, ConfigApplyResult } from './runtime-config.ts'
import { RuntimeConfigError } from './runtime-config.ts'
import { writeRecordAtomically } from './durable-record.ts'

/**
 * Durable Session-write intent: one record per account and scope.
 *
 * The control daemon writes the Session writes the Console submitted; the agent daemon
 * reads the same record at the shared conventional path (`sessionIntentScopePath`). The
 * record owns only the pending writes and their revision. It never mirrors Session state,
 * transcripts, permission options or credentials, and a reader never falls back to a
 * default when the record is missing or broken.
 *
 * Why a record and not a control-to-agent channel: the user decision recorded for
 * `connection.connect` (2026-10-14) is that the agent daemon reacts on its own and the
 * control daemon only writes desired intent, so no control-to-agent channel exists. A
 * Session write is an event rather than a desired state, so the record carries an ordered
 * window of pending intents and each reading daemon keeps its own consumed watermark in
 * its own directory. Exactly one writer owns the record and its one compare-and-swap
 * fence.
 */
export const SESSION_INTENT_VERSION = 1
export type SessionIntentVersion = typeof SESSION_INTENT_VERSION

/** Fixed file name inside the account and scope record directory. */
export const SESSION_INTENT_FILE_NAME = 'session-intent.json'

/**
 * The retained window. The writer drops the oldest intents beyond this count and reports
 * the oldest revision it still carries, so a reader that fell behind refuses instead of
 * skipping a write it can no longer see.
 */
export const SESSION_INTENT_WINDOW = 256

/** The frozen Console permission decision vocabulary (`ConsoleCommandV1` `permission.reply`). */
export type SessionPermissionDecision = 'once' | 'always' | 'reject'

/** One pending Session write. `payload` stays verbatim `JsonValue`-compatible data. */
export type SessionIntent =
  | {
    readonly intentId: string
    readonly kind: 'permission.reply'
    readonly agentId: string
    readonly sessionId: string
    readonly permissionId: string
    readonly decision: SessionPermissionDecision
    /**
     * The engine option the Console chose, carried verbatim from the frozen command. The
     * reading daemon must answer with exactly this option, never with a same-kind guess.
     */
    readonly optionId?: string
  }
  | {
    readonly intentId: string
    readonly kind: 'session.cancel'
    readonly agentId: string
    readonly sessionId: string
  }
  | {
    readonly intentId: string
    readonly kind: 'session.message'
    readonly agentId: string
    readonly sessionId: string
    /** The business body, carried verbatim; the transport never parses or strips it. */
    readonly payload: JsonValue
  }

export interface SessionIntentRecord {
  readonly version: SessionIntentVersion
  readonly revision: number
  /** Oldest revision still retained; equals `revision` when no intent was dropped yet. */
  readonly oldestRevision: number
  readonly intents: readonly SessionIntent[]
  readonly updatedAt: string
}

/** The three mutations the frozen Session write commands need. */
export type SessionIntentChange =
  | { readonly op: 'permission.reply'; readonly agentId: string; readonly sessionId: string; readonly permissionId: string; readonly decision: SessionPermissionDecision; readonly optionId?: string }
  | { readonly op: 'session.cancel'; readonly agentId: string; readonly sessionId: string }
  | { readonly op: 'session.message'; readonly agentId: string; readonly sessionId: string; readonly payload: JsonValue }

/** The owning daemon's record path. One derivation serves the writer and the reader. */
export function sessionIntentPath(dataDirectory: string): string {
  return resolve(dataDirectory, SESSION_INTENT_FILE_NAME)
}

/**
 * The one record path both daemons derive independently.
 *
 * The writer (the control daemon) and the reader (the agent daemon) must agree without a new
 * config key, and the frozen v4 `PeerIntent` carries no peer `dataDirectory`. The identities
 * both sides already carry are the target agent plus the account and scope pair: the writer
 * reads the target peer's `agentId`, `accountId` and `scopeId` from its own declared
 * `peers`, and the reader reads its own `daemon.id`, `daemon.accountId` and
 * `daemon.scopeId`. `~/.agentteams` is the project's established local root and
 * `config/relations-intent-store.ts` already uses the same account and scope convention.
 *
 * One record serves one target agent, so one record has exactly one reading daemon and one
 * writer. A write a daemon cannot apply therefore delays only that daemon's own later
 * writes; it never blocks another agent's.
 *
 * Limitation: a control daemon and an agent daemon in different accounts, scopes or
 * identities resolve different records. The quick-start layout gives both `local`.
 */
export function sessionIntentScopeDirectory(input: {
  readonly home: string
  readonly accountId: string
  readonly scopeId: string
  readonly agentId: string
}): string {
  return resolve(input.home, '.agentteams', 'sessions', input.accountId, input.scopeId, input.agentId)
}

/** The one record path for one target agent. */
export function sessionIntentScopePath(input: {
  readonly home: string
  readonly accountId: string
  readonly scopeId: string
  readonly agentId: string
}): string {
  return sessionIntentPath(sessionIntentScopeDirectory(input))
}

/**
 * The reading daemon's own consumed watermark. It lives in the reader's own data
 * directory, so the writer and the reader never share a fence and the writer's record
 * stays single-writer.
 */
export const SESSION_INTENT_WATERMARK_FILE_NAME = 'session-intent-watermark.json'

export interface SessionIntentWatermark {
  readonly version: SessionIntentVersion
  /** Highest revision this daemon already applied. */
  readonly appliedRevision: number
}

export function sessionIntentWatermarkPath(dataDirectory: string): string {
  return resolve(dataDirectory, SESSION_INTENT_WATERMARK_FILE_NAME)
}

/** The frozen agent identity pattern: the exact expression the config parser applies. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function fail(code: ConfigApplyError['code'], message: string): never {
  throw new RuntimeConfigError({ code, message })
}

function invalid(message: string): ConfigApplyError {
  return { code: 'INVALID_INPUT', message }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDecision(value: unknown): value is SessionPermissionDecision {
  return value === 'once' || value === 'always' || value === 'reject'
}

function requireAgentId(value: unknown, label: string): ConfigApplyError | undefined {
  if (typeof value !== 'string' || !AGENT_ID.test(value)) {
    return invalid(`${label} is not a valid agent identity`)
  }
  return undefined
}

function requireText(value: unknown, label: string): ConfigApplyError | undefined {
  if (typeof value !== 'string' || value.length === 0) return invalid(`${label} must be a non-empty string`)
  return undefined
}

/**
 * A body the record can carry. The record is one JSON file, so a value that JSON cannot
 * represent is refused here instead of being written as a key that the reader then fails to
 * find. `undefined`, a function and a symbol are the values JSON drops.
 */
function isJsonValue(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined
  } catch {
    return false
  }
}

/** Validate one change on its own terms, before the stored record is read. */
function validateChange(value: unknown): ConfigApplyError | undefined {
  if (!isTable(value)) return invalid('session intent change must be a table')
  if (value.op !== 'permission.reply' && value.op !== 'session.cancel' && value.op !== 'session.message') {
    return invalid('session intent change must be permission.reply, session.cancel, or session.message')
  }
  const agentError = requireAgentId(value.agentId, 'session intent change agentId')
  if (agentError !== undefined) return agentError
  const sessionError = requireText(value.sessionId, 'session intent change sessionId')
  if (sessionError !== undefined) return sessionError
  if (value.op === 'permission.reply') {
    const permissionError = requireText(value.permissionId, 'session intent change permissionId')
    if (permissionError !== undefined) return permissionError
    if (!isDecision(value.decision)) {
      return invalid('session intent change decision must be once, always, or reject')
    }
    // The frozen command carries the engine option the Console chose, and the reading daemon
    // answers with that exact option. It stays optional, because an engine may offer none.
    if (value.optionId !== undefined) {
      return requireText(value.optionId, 'session intent change optionId')
    }
    return undefined
  }
  if (value.op === 'session.message') {
    // A missing body is refused here; an explicit `null` body is a real body and is carried.
    if (!Object.hasOwn(value, 'payload')) return invalid('session intent change payload is required')
    if (!isJsonValue(value.payload)) return invalid('session intent change payload must be a JSON value')
  }
  return undefined
}

/** Validate one stored intent. A stored intent is held to the same rules as a change. */
function parseIntent(value: unknown, label: string): SessionIntent {
  if (!isTable(value)) fail('INVALID_INPUT', `session intent ${label} must be a table: stored record`)
  const intentIdError = requireText(value.intentId, `session intent ${label}.intentId`)
  if (intentIdError !== undefined) fail('INVALID_INPUT', `${intentIdError}: stored record`)
  const error = validateChange({ ...value, op: value.kind })
  if (error !== undefined) fail('INVALID_INPUT', `${error.message}: stored record`)
  const base = { intentId: value.intentId as string, agentId: value.agentId as string, sessionId: value.sessionId as string }
  if (value.kind === 'permission.reply') {
    return {
      ...base,
      kind: 'permission.reply',
      permissionId: value.permissionId as string,
      decision: value.decision as SessionPermissionDecision,
      ...(value.optionId === undefined ? {} : { optionId: value.optionId as string }),
    }
  }
  if (value.kind === 'session.cancel') return { ...base, kind: 'session.cancel' }
  return { ...base, kind: 'session.message', payload: value.payload as JsonValue }
}

function decode(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    fail('INVALID_INPUT', `session intent is not valid JSON: ${path}`)
  }
}

function parseRecord(text: string, path: string): SessionIntentRecord {
  const value = decode(text, path)
  if (!isTable(value)) fail('INVALID_INPUT', `session intent must be a table: ${path}`)
  if (value.version !== SESSION_INTENT_VERSION) {
    fail('UNSUPPORTED_VERSION', `session intent version must be ${SESSION_INTENT_VERSION}: ${path}`)
  }
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    fail('INVALID_INPUT', `session intent revision must be a positive integer: ${path}`)
  }
  const oldest = value.oldestRevision
  if (!Number.isSafeInteger(oldest) || (oldest as number) < 1 || (oldest as number) > (revision as number)) {
    fail('INVALID_INPUT', `session intent oldestRevision must be a positive integer no greater than revision: ${path}`)
  }
  const updatedAt = value.updatedAt
  if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
    fail('INVALID_INPUT', `session intent updatedAt must be a non-empty string: ${path}`)
  }
  if (!Array.isArray(value.intents)) fail('INVALID_INPUT', `session intent intents must be an array: ${path}`)
  if (value.intents.length > SESSION_INTENT_WINDOW) {
    fail('INVALID_INPUT', `session intent carries ${value.intents.length} intents, above the retained window: ${path}`)
  }
  // Each retained intent stands for exactly one revision: `intents[i]` is revision
  // `oldestRevision + i`. A record whose count disagrees is refused here, because the reader
  // would otherwise advance its watermark over revisions this record never carried and skip
  // them without a refusal.
  if (value.intents.length !== (revision as number) - (oldest as number) + 1) {
    fail('INVALID_INPUT', `session intent carries ${value.intents.length} intents for revisions ${oldest as number}..${revision as number}, so the record is incomplete: ${path}`)
  }
  const intents = value.intents.map((intent, index) => parseIntent(intent, `intents[${index}]`))
  const seen = new Set<string>()
  for (const intent of intents) {
    if (seen.has(intent.intentId)) fail('INVALID_INPUT', `session intent declares duplicate intentId ${intent.intentId}: ${path}`)
    seen.add(intent.intentId)
  }
  return {
    version: SESSION_INTENT_VERSION,
    revision: revision as number,
    oldestRevision: oldest as number,
    intents,
    updatedAt,
  }
}

/**
 * Read the durable record. A missing file is `undefined`; a broken file is a typed
 * `RuntimeConfigError` carrying a real `ConfigErrorCode`, never a default.
 */
export async function readSessionIntentRecord(path: string): Promise<SessionIntentRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    fail('UNAVAILABLE', `session intent could not be read: ${path}`)
  }
  return parseRecord(text, path)
}

/**
 * Read the reading daemon's own consumed watermark. A missing file means nothing was
 * applied yet, which is revision `0`.
 */
export async function readSessionIntentWatermark(path: string): Promise<SessionIntentWatermark> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { version: SESSION_INTENT_VERSION, appliedRevision: 0 }
    fail('UNAVAILABLE', `session intent watermark could not be read: ${path}`)
  }
  const value = decode(text, path)
  if (!isTable(value)) fail('INVALID_INPUT', `session intent watermark must be a table: ${path}`)
  if (value.version !== SESSION_INTENT_VERSION) {
    fail('UNSUPPORTED_VERSION', `session intent watermark version must be ${SESSION_INTENT_VERSION}: ${path}`)
  }
  const applied = value.appliedRevision
  if (!Number.isSafeInteger(applied) || (applied as number) < 0) {
    fail('INVALID_INPUT', `session intent watermark appliedRevision must be a non-negative integer: ${path}`)
  }
  return { version: SESSION_INTENT_VERSION, appliedRevision: applied as number }
}

/**
 * Persist the reading daemon's own watermark. The reader owns this file alone, so there is
 * no fence here: a lost write only makes the reader apply an intent twice, and the apply
 * path is what refuses an already-satisfied write.
 */
export async function writeSessionIntentWatermark(path: string, appliedRevision: number): Promise<void> {
  if (!Number.isSafeInteger(appliedRevision) || appliedRevision < 0) {
    fail('INVALID_INPUT', `session intent watermark appliedRevision must be a non-negative integer: ${path}`)
  }
  const result = await writeRecordAtomically({
    path,
    label: 'session intent watermark',
    record: { version: SESSION_INTENT_VERSION, appliedRevision },
    acceptedRevision: appliedRevision,
    effectiveRevision: appliedRevision,
  })
  if (result.status !== 'applied') fail('UNAVAILABLE', result.error.message)
}

/**
 * The reading daemon's view of one record. Both sides derive the intent revision from the
 * same rule, so the derivation lives here rather than in the reader: the intent at index
 * `i` carries revision `oldestRevision + i`.
 *
 * `behind` is the honest refusal. The record carries only a fixed window, so a reader whose
 * watermark is older than the window can no longer see the writes it missed. It must refuse
 * instead of skipping them, and the writer's own retained boundary is the evidence.
 */
export type SessionIntentPending =
  | { readonly state: 'pending'; readonly intents: readonly SessionIntent[]; readonly throughRevision: number }
  | { readonly state: 'behind'; readonly appliedRevision: number; readonly oldestRevision: number }

export function pendingSessionIntents(
  record: SessionIntentRecord | undefined,
  appliedRevision: number,
): SessionIntentPending {
  if (!Number.isSafeInteger(appliedRevision) || appliedRevision < 0) {
    fail('INVALID_INPUT', 'session intent appliedRevision must be a non-negative integer')
  }
  if (record === undefined) return { state: 'pending', intents: [], throughRevision: appliedRevision }
  if (appliedRevision >= record.revision) return { state: 'pending', intents: [], throughRevision: appliedRevision }
  if (appliedRevision < record.oldestRevision - 1) {
    return { state: 'behind', appliedRevision, oldestRevision: record.oldestRevision }
  }
  const first = appliedRevision - record.oldestRevision + 1
  return {
    state: 'pending',
    intents: record.intents.slice(first),
    throughRevision: record.revision,
  }
}

/**
 * Durable write, one mode-`0o600` temporary file then one atomic rename, with the three
 * honest outcomes that rule owns. The discipline itself lives in
 * `config/durable-record.ts`, shared with the Session observation store so a second durable
 * record cannot grow its own copy of it.
 */
async function persist(path: string, record: SessionIntentRecord, acceptedRevision: number): Promise<ConfigApplyResult> {
  return await writeRecordAtomically({
    path,
    label: 'session intent',
    record,
    acceptedRevision,
    effectiveRevision: record.revision,
  })
}

/**
 * Apply one change with compare-and-swap on the durable revision. The revision is monotonic
 * and starts at 1. `expectedRevision` is the caller's CAS expectation; `0` creates a record
 * that does not exist yet.
 *
 * Input that cannot name a valid change is a `failed` result with `INVALID_INPUT`; a broken
 * stored file is the read's typed throw. A refused write never touches the durable target.
 */
export async function writeSessionIntentRecord(
  path: string,
  expectedRevision: number,
  next: SessionIntentChange,
): Promise<ConfigApplyResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { status: 'failed', error: invalid(`session intent expectedRevision must be a non-negative integer: ${path}`) }
  }
  const changeError = validateChange(next)
  if (changeError !== undefined) return { status: 'failed', error: changeError }

  // A malformed stored record fails here with its real code; the write then never runs, so
  // the existing bytes stay exactly as they were.
  const current = await readSessionIntentRecord(path)
  const acceptedRevision = current?.revision ?? 0
  if (acceptedRevision !== expectedRevision) {
    return {
      status: 'failed',
      error: {
        code: 'REVISION_CONFLICT',
        message: `session intent revision is ${acceptedRevision}, expected ${expectedRevision}: ${path}`,
      },
    }
  }

  const stored = current?.intents ?? []
  const intent: SessionIntent = next.op === 'permission.reply'
    ? { intentId: randomUUID(), kind: 'permission.reply', agentId: next.agentId, sessionId: next.sessionId, permissionId: next.permissionId, decision: next.decision, ...(next.optionId === undefined ? {} : { optionId: next.optionId }) }
    : next.op === 'session.cancel'
      ? { intentId: randomUUID(), kind: 'session.cancel', agentId: next.agentId, sessionId: next.sessionId }
      : { intentId: randomUUID(), kind: 'session.message', agentId: next.agentId, sessionId: next.sessionId, payload: next.payload }

  // The retained window is fixed: the newest intents survive and the oldest are dropped.
  // `oldestRevision` reports what the window no longer carries, so a reader that fell
  // behind refuses instead of skipping a write it can no longer see.
  const kept = [...stored, intent].slice(-SESSION_INTENT_WINDOW)
  const dropped = stored.length + 1 - kept.length
  const record: SessionIntentRecord = {
    version: SESSION_INTENT_VERSION,
    revision: acceptedRevision + 1,
    oldestRevision: dropped > 0 ? (current?.oldestRevision ?? 1) + dropped : (current?.oldestRevision ?? 1),
    intents: kept,
    updatedAt: new Date().toISOString(),
  }
  return persist(path, record, acceptedRevision)
}
