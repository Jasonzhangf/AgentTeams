import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { ConfigApplyError, ConfigApplyResult } from './runtime-config.ts'
import { RuntimeConfigError } from './runtime-config.ts'
import { sessionIntentScopeDirectory } from './session-intent-store.ts'
import { writeRecordAtomically } from './durable-record.ts'

/**
 * Durable local group endpoint: one record per agent, written by the agent daemon and read
 * by the control daemon.
 *
 * The agent daemon owns the one local group message socket it really binds for its CLI
 * clients (`runtime/agent-messaging.ts` `localSocketPathFor`). The control daemon serves the
 * authenticated Console HTTP surface, but it declares no Teams listener and has no channel
 * to ask an agent daemon where that socket lives. The frozen v4 `PeerIntent`
 * (`config/daemon-intent.ts`) carries `agentId`, `hostId`, `accountId`, `scopeId`,
 * `endpoint?`, `admissionRef?`, `credentialRef` and `tlsTrustRef?` and no peer
 * `dataDirectory`, so the control daemon cannot derive the peer's socket from its own facts.
 *
 * This record is that one missing binding, and nothing else:
 *  - the agent daemon is its single writer, publishing the socket path it just bound;
 *  - the control daemon is its single reader, forwarding Console frames to that path;
 *  - the directory is the shared account and scope layout `config/session-intent-store.ts`
 *    owns, so both sides resolve the same file from their own accepted facts and no config
 *    key is added.
 *
 * The record carries no group business state: no group list, no membership, no message and
 * no Session. Group truth stays in the hub behind the agent daemon. A missing record means
 * the agent has published nothing (its group surface is not configured in this deployment);
 * it is an honest absence, never an empty endpoint.
 */
export const LOCAL_GROUP_ENDPOINT_VERSION = 1
export type LocalGroupEndpointVersion = typeof LOCAL_GROUP_ENDPOINT_VERSION

/** Fixed file name inside the same account and scope record directory the Session records use. */
export const LOCAL_GROUP_ENDPOINT_FILE_NAME = 'local-group-endpoint.json'

/** One local transport an agent daemon binds for group requests. Unix socket only today. */
export interface LocalGroupEndpoint {
  readonly kind: 'local-socket'
  /** The absolute socket path the agent daemon really bound. */
  readonly socketPath: string
}

export interface LocalGroupEndpointRecord {
  readonly version: LocalGroupEndpointVersion
  readonly agentId: string
  readonly revision: number
  readonly updatedAt: string
  readonly groupEndpoint: LocalGroupEndpoint
}

/** What the agent daemon publishes; the store owns version, revision and time. */
export interface LocalGroupEndpointSnapshot {
  readonly agentId: string
  readonly groupEndpoint: LocalGroupEndpoint
}

/**
 * The one record path both daemons derive independently.
 *
 * The directory is the shared account-and-scope layout `config/session-intent-store.ts`
 * owns, so this module does not restate that rule and the agent's local transport record
 * sits beside the two Session records of the same agent.
 */
export function localGroupEndpointScopePath(input: {
  readonly home: string
  readonly accountId: string
  readonly scopeId: string
  readonly agentId: string
}): string {
  return resolve(sessionIntentScopeDirectory(input), LOCAL_GROUP_ENDPOINT_FILE_NAME)
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

/**
 * Validate one snapshot on its own terms. The socket path must be absolute: a relative path
 * would be resolved against whichever daemon happens to read the record, which is exactly
 * the guessed binding this record exists to replace.
 */
function validateSnapshot(value: unknown): ConfigApplyError | undefined {
  if (!isTable(value)) return invalid('local group endpoint snapshot must be a table')
  const agentError = requireText(value.agentId, 'local group endpoint snapshot agentId')
  if (agentError !== undefined) return agentError
  if (!isTable(value.groupEndpoint)) return invalid('local group endpoint snapshot groupEndpoint must be a table')
  if (value.groupEndpoint.kind !== 'local-socket') {
    return invalid('local group endpoint snapshot groupEndpoint.kind must be local-socket')
  }
  const socketError = requireText(value.groupEndpoint.socketPath, 'local group endpoint snapshot socketPath')
  if (socketError !== undefined) return socketError
  if (!isAbsolute(value.groupEndpoint.socketPath as string)) {
    return invalid('local group endpoint snapshot socketPath must be an absolute path')
  }
  return undefined
}

function parseSnapshot(value: Record<string, unknown>): LocalGroupEndpointSnapshot {
  const endpoint = value.groupEndpoint as Record<string, unknown>
  return {
    agentId: value.agentId as string,
    groupEndpoint: { kind: 'local-socket', socketPath: endpoint.socketPath as string },
  }
}

function parseRecord(text: string, path: string): LocalGroupEndpointRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail('INVALID_INPUT', `local group endpoint is not valid JSON: ${path}`)
  }
  if (!isTable(value)) fail('INVALID_INPUT', `local group endpoint must be a table: ${path}`)
  if (value.version !== LOCAL_GROUP_ENDPOINT_VERSION) {
    fail('UNSUPPORTED_VERSION', `local group endpoint version must be ${LOCAL_GROUP_ENDPOINT_VERSION}: ${path}`)
  }
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    fail('INVALID_INPUT', `local group endpoint revision must be a positive integer: ${path}`)
  }
  const updatedError = requireText(value.updatedAt, 'local group endpoint updatedAt')
  if (updatedError !== undefined) fail('INVALID_INPUT', `${updatedError.message}: ${path}`)
  const error = validateSnapshot(value)
  if (error !== undefined) fail('INVALID_INPUT', `${error.message}: ${path}`)
  return {
    version: LOCAL_GROUP_ENDPOINT_VERSION,
    revision: revision as number,
    updatedAt: value.updatedAt as string,
    ...parseSnapshot(value),
  }
}

/**
 * Read the endpoint record. A missing file means this agent has published no local group
 * endpoint, which is an honest absence rather than an empty endpoint. A broken stored record
 * is a typed throw: the reader never falls back to a default path that would look like a
 * real binding.
 */
export async function readLocalGroupEndpointRecord(path: string): Promise<LocalGroupEndpointRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    fail('UNAVAILABLE', `local group endpoint could not be read: ${path}`)
  }
  return parseRecord(text, path)
}

/**
 * Publish one endpoint with compare-and-swap on the durable revision. The agent daemon is
 * this record's single writer; the fence is what keeps a retry from reporting success for a
 * binding it did not store. `0` creates a record that does not exist yet.
 */
export async function writeLocalGroupEndpointRecord(
  path: string,
  expectedRevision: number,
  snapshot: LocalGroupEndpointSnapshot,
): Promise<ConfigApplyResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { status: 'failed', error: invalid(`local group endpoint expectedRevision must be a non-negative integer: ${path}`) }
  }
  const error = validateSnapshot(snapshot)
  if (error !== undefined) return { status: 'failed', error }
  // A malformed stored record fails here with its real code; the write then never runs, so
  // the existing bytes stay exactly as they were.
  const current = await readLocalGroupEndpointRecord(path)
  const acceptedRevision = current?.revision ?? 0
  if (acceptedRevision !== expectedRevision) {
    return {
      status: 'failed',
      error: {
        code: 'REVISION_CONFLICT',
        message: `local group endpoint revision is ${acceptedRevision}, expected ${expectedRevision}: ${path}`,
      },
    }
  }
  const revision = acceptedRevision + 1
  return await writeRecordAtomically({
    path,
    label: 'local group endpoint',
    record: { version: LOCAL_GROUP_ENDPOINT_VERSION, revision, updatedAt: new Date().toISOString(), ...snapshot } satisfies LocalGroupEndpointRecord,
    acceptedRevision,
    effectiveRevision: revision,
  })
}

/**
 * Remove the record when the socket it names no longer exists.
 *
 * The agent daemon removes its own record on stop, so the control daemon reads an honest
 * "not configured" instead of dialing a stale path. A missing file is already the desired
 * state; any other failure is typed, because a record that survives its socket would make
 * the reader report `unreachable` for an agent that stopped on purpose.
 */
export async function removeLocalGroupEndpointRecord(path: string): Promise<void> {
  try {
    await rm(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    fail('UNAVAILABLE', `local group endpoint could not be removed: ${path}`)
  }
}
