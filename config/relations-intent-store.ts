import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RelationRole } from '../control-protocol/teams-connection.ts'
import { writeRecordAtomically } from './durable-record.ts'
import type { ConfigApplyError, ConfigApplyResult } from './runtime-config.ts'
import { RuntimeConfigError } from './runtime-config.ts'

/**
 * Durable desired-relations intent: one record per agent identity.
 *
 * The control daemon writes the peer relations it wants; the agent daemon reads
 * the same record at the shared conventional path (`relationsIntentPathFor`). The
 * record owns only the desired intent and its revision. It never mirrors live
 * connection state, negotiation results, or credentials, and a reader never falls
 * back to a default when the record is missing or broken.
 */
export const RELATIONS_INTENT_VERSION = 1
export type RelationsIntentVersion = typeof RELATIONS_INTENT_VERSION

/** Fixed file name inside the agent's record directory. */
export const RELATIONS_INTENT_FILE_NAME = 'relations-intent.json'

/** One desired peer relation; `role` is the frozen control-protocol role. */
export interface DesiredPeerRelation {
  readonly agentId: string
  readonly role: RelationRole
}

export interface RelationsIntentRecord {
  readonly version: RelationsIntentVersion
  readonly revision: number
  readonly peers: readonly DesiredPeerRelation[]
  readonly updatedAt: string
}

/** The three mutations the frozen relation commands need. */
export type RelationsIntentChange =
  | { readonly op: 'connect'; readonly agentId: string; readonly role: RelationRole }
  | { readonly op: 'disconnect'; readonly agentId: string }
  | { readonly op: 'replace'; readonly peers: readonly DesiredPeerRelation[] }

/** The owning daemon's record path. One derivation serves the writer and the reader. */
export function relationsIntentPath(dataDirectory: string): string {
  return resolve(dataDirectory, RELATIONS_INTENT_FILE_NAME)
}

/**
 * The shared record path both daemons derive independently.
 *
 * The writer (the control daemon) and the reader (the agent daemon) must agree
 * without a new config key, and the frozen v4 `PeerIntent` carries no peer
 * `dataDirectory`. The one identity both sides already carry is the account and
 * scope pair: the writer reads the target peer's `accountId` and `scopeId` from
 * its own declared `peers`, and the reader reads its own `daemon.accountId` and
 * `daemon.scopeId`. `~/.agentteams` is the project's established local root
 * (`runtime/acp-serve.ts` resolves its own `configDirectory` from it, and
 * `config/`'s local layout uses it), so the record is one desired membership set
 * per account and scope.
 *
 * Limitation: a control daemon and an agent daemon in different accounts or
 * scopes resolve different records. The quick-start layout gives both `local`.
 */
export function relationsIntentScopeDirectory(input: {
  readonly home: string
  readonly accountId: string
  readonly scopeId: string
}): string {
  return resolve(input.home, '.agentteams', 'relations', input.accountId, input.scopeId)
}

/** The one shared record path for one account and scope. */
export function relationsIntentScopePath(input: {
  readonly home: string
  readonly accountId: string
  readonly scopeId: string
}): string {
  return relationsIntentPath(relationsIntentScopeDirectory(input))
}

/**
 * The frozen agent identity pattern: the exact regular expression the single-daemon
 * config parser applies to `daemon.id` and the local config applies to an agent id.
 * A stored or submitted agent identity must match it.
 */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function fail(code: ConfigApplyError['code'], message: string): never {
  throw new RuntimeConfigError({ code, message })
}

function invalid(message: string): ConfigApplyError {
  return { code: 'INVALID_INPUT', message }
}

function isRelationRole(value: unknown): value is RelationRole {
  return value === 'master' || value === 'peer'
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One peer rule set, shared by the read parser and the write validator. */
function peerError(value: unknown, label: string): ConfigApplyError | undefined {
  if (!isTable(value)) return invalid(`relations intent ${label} must be a table`)
  if (typeof value.agentId !== 'string' || !AGENT_ID.test(value.agentId)) {
    return invalid(`relations intent ${label}.agentId is not a valid agent identity`)
  }
  if (!isRelationRole(value.role)) return invalid(`relations intent ${label}.role must be master or peer`)
  return undefined
}

function parsePeers(value: unknown, path: string): readonly DesiredPeerRelation[] {
  if (!Array.isArray(value)) fail('INVALID_INPUT', `relations intent peers must be an array: ${path}`)
  const peers = value.map((peer, index) => {
    const error = peerError(peer, `peers[${index}]`)
    if (error !== undefined) fail('INVALID_INPUT', `${error.message}: ${path}`)
    return peer as unknown as DesiredPeerRelation
  })
  const seen = new Set<string>()
  for (const peer of peers) {
    if (seen.has(peer.agentId)) fail('INVALID_INPUT', `relations intent declares duplicate agentId ${peer.agentId}: ${path}`)
    seen.add(peer.agentId)
  }
  return peers
}

function decode(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    fail('INVALID_INPUT', `relations intent is not valid JSON: ${path}`)
  }
}

function parseRecord(text: string, path: string): RelationsIntentRecord {
  const value = decode(text, path)
  if (!isTable(value)) fail('INVALID_INPUT', `relations intent must be a table: ${path}`)
  if (value.version !== RELATIONS_INTENT_VERSION) {
    fail('UNSUPPORTED_VERSION', `relations intent version must be ${RELATIONS_INTENT_VERSION}: ${path}`)
  }
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    fail('INVALID_INPUT', `relations intent revision must be a positive integer: ${path}`)
  }
  const updatedAt = value.updatedAt
  if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
    fail('INVALID_INPUT', `relations intent updatedAt must be a non-empty string: ${path}`)
  }
  return {
    version: RELATIONS_INTENT_VERSION,
    revision: revision as number,
    peers: parsePeers(value.peers, path),
    updatedAt,
  }
}

/**
 * Read the durable record. A missing file is `undefined`; a broken file is a
 * typed `RuntimeConfigError` carrying a real `ConfigErrorCode`, never a default.
 */
export async function readRelationsIntentRecord(path: string): Promise<RelationsIntentRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    fail('UNAVAILABLE', `relations intent could not be read: ${path}`)
  }
  return parseRecord(text, path)
}

/**
 * Validate the change on its own terms: op, agent identity pattern, relation
 * role, and duplicates inside a `replace` payload. A duplicate against the
 * stored peers is checked by the writer, where the stored peers are in hand.
 */
function validateChange(value: unknown): ConfigApplyError | undefined {
  if (!isTable(value)) return invalid('relations intent change must be a table')
  if (value.op === 'connect' || value.op === 'disconnect') {
    if (typeof value.agentId !== 'string' || !AGENT_ID.test(value.agentId)) {
      return invalid('relations intent change agentId is not a valid agent identity')
    }
    if (value.op === 'connect' && !isRelationRole(value.role)) {
      return invalid('relations intent change role must be master or peer')
    }
    return undefined
  }
  if (value.op !== 'replace') return invalid('relations intent change must be connect, disconnect, or replace')
  if (!Array.isArray(value.peers)) return invalid('relations intent replace requires a peers array')
  const seen = new Set<string>()
  for (const [index, peer] of value.peers.entries()) {
    const error = peerError(peer, `change peers[${index}]`)
    if (error !== undefined) return error
    const agentId = (peer as DesiredPeerRelation).agentId
    if (seen.has(agentId)) return invalid(`relations intent change declares duplicate agentId ${agentId}`)
    seen.add(agentId)
  }
  return undefined
}

/**
 * Durable write: the one shared atomic-write discipline in `config/durable-record.ts`
 * (a mode-`0o600` temporary file in the target directory, then a rename). A failed
 * temporary write leaves the target untouched and is a known failure. A failed rename is
 * never `applied`: the target may already carry the new bytes, so the result is
 * `uncertain` with the real substrate facts.
 */
async function persist(path: string, record: RelationsIntentRecord, acceptedRevision: number): Promise<ConfigApplyResult> {
  return writeRecordAtomically({
    path,
    label: 'relations intent',
    record,
    acceptedRevision,
    effectiveRevision: record.revision,
  })
}

/**
 * Apply one change with compare-and-swap on the durable revision. The revision
 * is monotonic and starts at 1. `expectedRevision` is the caller's CAS
 * expectation; `0` creates a record that does not exist yet. A `disconnect` of
 * an absent agent is a no-op that still bumps the revision, because a caller
 * that retries the same command at the same expectation must then move on.
 *
 * Input that cannot name a valid change is a `failed` result with
 * `INVALID_INPUT`; a broken stored file is the read's typed throw. A refused
 * write never touches the durable target.
 */
export async function writeRelationsIntentRecord(
  path: string,
  expectedRevision: number,
  next: RelationsIntentChange,
): Promise<ConfigApplyResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { status: 'failed', error: invalid(`relations intent expectedRevision must be a non-negative integer: ${path}`) }
  }
  const changeError = validateChange(next)
  if (changeError !== undefined) return { status: 'failed', error: changeError }

  // A malformed stored record fails here with its real code; the write then
  // never runs, so the existing bytes stay exactly as they were.
  const current = await readRelationsIntentRecord(path)
  const acceptedRevision = current?.revision ?? 0
  if (acceptedRevision !== expectedRevision) {
    return {
      status: 'failed',
      error: {
        code: 'REVISION_CONFLICT',
        message: `relations intent revision is ${acceptedRevision}, expected ${expectedRevision}: ${path}`,
      },
    }
  }

  const stored = current?.peers ?? []
  if (next.op === 'connect' && stored.some(peer => peer.agentId === next.agentId)) {
    return { status: 'failed', error: invalid(`relations intent already declares agentId ${next.agentId}`) }
  }
  const peers: readonly DesiredPeerRelation[] = next.op === 'connect'
    ? [...stored, { agentId: next.agentId, role: next.role }]
    : next.op === 'disconnect'
      // Disconnecting an absent agent is a no-op that still bumps the revision.
      ? stored.filter(peer => peer.agentId !== next.agentId)
      : [...next.peers]

  const record: RelationsIntentRecord = {
    version: RELATIONS_INTENT_VERSION,
    revision: acceptedRevision + 1,
    peers,
    updatedAt: new Date().toISOString(),
  }
  return persist(path, record, acceptedRevision)
}
