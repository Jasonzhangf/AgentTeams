import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ConsolePermissionOption, ConsoleSessionEventView } from '../packages/shared/src/console-api.ts'
import { parseConsoleSessionEvent, parsePermissionOptions } from '../packages/shared/src/console-api.ts'
import type { ConfigApplyError, ConfigApplyResult } from './runtime-config.ts'
import { RuntimeConfigError } from './runtime-config.ts'
import { sessionIntentScopeDirectory } from './session-intent-store.ts'
import { writeRecordAtomically } from './durable-record.ts'

/**
 * Durable Session observation: one record per agent, written by the agent daemon and read
 * by the control daemon.
 *
 * The agent daemon owns every Session and permission fact on this path — the sessions its
 * engine actually opened and the permission callbacks its engine is actually awaiting. This
 * record is how those facts reach the control daemon's Console projection, because the
 * control daemon declares no Teams listener and therefore has no channel to ask an agent
 * daemon for them. The direction is the mirror image of `config/session-intent-store.ts`:
 * there the control daemon writes the Session writes and the agent daemon reads them; here
 * the agent daemon publishes its own observation and the control daemon reads it. Neither
 * direction adds a control-to-agent channel, a second Session owner, or a Console data
 * path.
 *
 * The record carries projection rows only. It never carries Session business payloads, no
 * transcript, no permission option set and no credential, and the agent's own host stays
 * the only owner of the facts it publishes.
 */
export const SESSION_OBSERVATION_VERSION = 1
export type SessionObservationVersion = typeof SESSION_OBSERVATION_VERSION

/** Fixed file name inside the same account and scope record directory the intent record uses. */
export const SESSION_OBSERVATION_FILE_NAME = 'session-observation.json'

/** One engine Session the agent daemon really opened on an open channel. */
export interface SessionObservationSession {
  readonly sessionId: string
}

/**
 * One engine permission callback the agent daemon is really awaiting. `permissionId` is the
 * id the controller received with the request, so it is the address a Console
 * `permission.reply` must use; `notificationId` is the projection row's own stable id
 * derived from it.
 */
export interface SessionObservationPermission {
  readonly notificationId: string
  readonly sessionId: string
  readonly permissionId: string
  /** The engine-provided choice set; absent when the engine offered none. */
  readonly options?: readonly ConsolePermissionOption[]
}

export interface SessionObservationRecord {
  readonly version: SessionObservationVersion
  readonly agentId: string
  readonly revision: number
  readonly updatedAt: string
  readonly sessions: readonly SessionObservationSession[]
  readonly permissions: readonly SessionObservationPermission[]
  /** Ordered engine events for the Sessions this snapshot reports. */
  readonly sessionEvents?: readonly ConsoleSessionEventView[]
}

/** The observation the agent daemon publishes; the store owns version, revision and time. */
export interface SessionObservationSnapshot {
  readonly agentId: string
  readonly sessions: readonly SessionObservationSession[]
  readonly permissions: readonly SessionObservationPermission[]
  readonly sessionEvents?: readonly ConsoleSessionEventView[]
}

/**
 * The one record path both daemons derive independently.
 *
 * The directory is the one shared account-and-scope layout `config/session-intent-store.ts`
 * owns, so the two Session records for one agent live side by side under one directory and
 * this module does not restate the layout rule.
 */
export function sessionObservationScopePath(input: {
  readonly home: string
  readonly accountId: string
  readonly scopeId: string
  readonly agentId: string
}): string {
  return resolve(sessionIntentScopeDirectory(input), SESSION_OBSERVATION_FILE_NAME)
}

function fail(code: ConfigApplyError['code'], message: string): never {
  throw new RuntimeConfigError({ code, message })
}

function invalid(message: string): ConfigApplyError {
  return { code: 'INVALID_INPUT', message }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, label: string): ConfigApplyError | undefined {
  if (typeof value !== 'string' || value.length === 0) return invalid(`${label} must be a non-empty string`)
  return undefined
}

/** Validate one engine option set through the one frozen Console parser. */
function validateOptions(value: unknown, label: string): ConfigApplyError | undefined {
  try {
    parsePermissionOptions(value)
    return undefined
  } catch (cause) {
    return invalid(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Validate one ordered event against the frozen Console event union. */
function validateSessionEvents(value: unknown, sessionIds: ReadonlySet<string>): ConfigApplyError | undefined {
  if (!Array.isArray(value)) return invalid('session observation snapshot sessionEvents must be an array')
  for (const [index, event] of value.entries()) {
    try {
      parseConsoleSessionEvent(event)
    } catch (cause) {
      return invalid(`session observation snapshot sessionEvents[${index}]: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (!sessionIds.has(event.sessionId)) {
      return invalid(`session observation snapshot sessionEvents[${index}] names session ${event.sessionId}, which it does not report`)
    }
  }
  return undefined
}

/**
 * Validate one snapshot on its own terms. A permission row that names a Session the same
 * snapshot does not report is refused: the reader would otherwise project a notification
 * whose Session row it cannot name, which is exactly the crossing this record must not
 * carry.
 */
function validateSnapshot(value: unknown): ConfigApplyError | undefined {
  if (!isTable(value)) return invalid('session observation snapshot must be a table')
  const agentError = requireText(value.agentId, 'session observation snapshot agentId')
  if (agentError !== undefined) return agentError
  if (!Array.isArray(value.sessions) || !Array.isArray(value.permissions)) {
    return invalid('session observation snapshot sessions and permissions must be arrays')
  }
  const sessionIds = new Set<string>()
  for (const [index, session] of value.sessions.entries()) {
    if (!isTable(session)) return invalid(`session observation snapshot sessions[${index}] must be a table`)
    const error = requireText(session.sessionId, `session observation snapshot sessions[${index}].sessionId`)
    if (error !== undefined) return error
    if (sessionIds.has(session.sessionId as string)) return invalid(`session observation snapshot repeats sessionId ${session.sessionId as string}`)
    sessionIds.add(session.sessionId as string)
  }
  const notificationIds = new Set<string>()
  for (const [index, permission] of value.permissions.entries()) {
    if (!isTable(permission)) return invalid(`session observation snapshot permissions[${index}] must be a table`)
    for (const field of ['notificationId', 'sessionId', 'permissionId'] as const) {
      const error = requireText(permission[field], `session observation snapshot permissions[${index}].${field}`)
      if (error !== undefined) return error
    }
    if (notificationIds.has(permission.notificationId as string)) {
      return invalid(`session observation snapshot repeats notificationId ${permission.notificationId as string}`)
    }
    notificationIds.add(permission.notificationId as string)
    if (!sessionIds.has(permission.sessionId as string)) {
      return invalid(`session observation snapshot permissions[${index}] names session ${permission.sessionId as string}, which it does not report`)
    }
    if (permission.options !== undefined) {
      const optionsError = validateOptions(permission.options, `session observation snapshot permissions[${index}].options`)
      if (optionsError !== undefined) return optionsError
    }
  }
  if (value.sessionEvents !== undefined) {
    const eventsError = validateSessionEvents(value.sessionEvents, sessionIds)
    if (eventsError !== undefined) return eventsError
  }
  return undefined
}

function parseSnapshot(value: Record<string, unknown>): SessionObservationSnapshot {
  return {
    agentId: value.agentId as string,
    sessions: (value.sessions as Record<string, unknown>[]).map(session => ({ sessionId: session.sessionId as string })),
    permissions: (value.permissions as Record<string, unknown>[]).map(permission => ({
      notificationId: permission.notificationId as string,
      sessionId: permission.sessionId as string,
      permissionId: permission.permissionId as string,
      ...(permission.options === undefined ? {} : { options: permission.options as readonly ConsolePermissionOption[] }),
    })),
    ...(value.sessionEvents === undefined ? {} : { sessionEvents: value.sessionEvents as readonly ConsoleSessionEventView[] }),
  }
}

function parseRecord(text: string, path: string): SessionObservationRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail('INVALID_INPUT', `session observation is not valid JSON: ${path}`)
  }
  if (!isTable(value)) fail('INVALID_INPUT', `session observation must be a table: ${path}`)
  if (value.version !== SESSION_OBSERVATION_VERSION) {
    fail('UNSUPPORTED_VERSION', `session observation version must be ${SESSION_OBSERVATION_VERSION}: ${path}`)
  }
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    fail('INVALID_INPUT', `session observation revision must be a positive integer: ${path}`)
  }
  const updatedError = requireText(value.updatedAt, 'session observation updatedAt')
  if (updatedError !== undefined) fail('INVALID_INPUT', `${updatedError.message}: ${path}`)
  const error = validateSnapshot(value)
  if (error !== undefined) fail('INVALID_INPUT', `${error.message}: ${path}`)
  return {
    version: SESSION_OBSERVATION_VERSION,
    revision: revision as number,
    updatedAt: value.updatedAt as string,
    ...parseSnapshot(value),
  }
}

/**
 * Read the observation record. A missing file means this agent has published nothing yet,
 * which is an honest absence rather than an empty observation. A broken stored record is a
 * typed throw: the reader never falls back to a default that would look like a real
 * observation.
 */
export async function readSessionObservationRecord(path: string): Promise<SessionObservationRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    fail('UNAVAILABLE', `session observation could not be read: ${path}`)
  }
  return parseRecord(text, path)
}

/**
 * Publish one observation with compare-and-swap on the durable revision. The agent daemon
 * is this record's single writer; the fence is what keeps a retry from reporting success
 * for an observation it did not store. `0` creates a record that does not exist yet.
 *
 * The snapshot is the whole observation, not a patch: a Session that closed and a permission
 * that resolved must disappear from the next revision, because a reader that keeps stale
 * rows would project a Session the engine no longer holds.
 */
export async function writeSessionObservationRecord(
  path: string,
  expectedRevision: number,
  snapshot: SessionObservationSnapshot,
): Promise<ConfigApplyResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { status: 'failed', error: invalid(`session observation expectedRevision must be a non-negative integer: ${path}`) }
  }
  const error = validateSnapshot(snapshot)
  if (error !== undefined) return { status: 'failed', error }
  // A malformed stored record fails here with its real code; the write then never runs, so
  // the existing bytes stay exactly as they were.
  const current = await readSessionObservationRecord(path)
  const acceptedRevision = current?.revision ?? 0
  if (acceptedRevision !== expectedRevision) {
    return {
      status: 'failed',
      error: {
        code: 'REVISION_CONFLICT',
        message: `session observation revision is ${acceptedRevision}, expected ${expectedRevision}: ${path}`,
      },
    }
  }
  const revision = acceptedRevision + 1
  return await writeRecordAtomically({
    path,
    label: 'session observation',
    record: { version: SESSION_OBSERVATION_VERSION, revision, updatedAt: new Date().toISOString(), ...snapshot } satisfies SessionObservationRecord,
    acceptedRevision,
    effectiveRevision: revision,
  })
}
