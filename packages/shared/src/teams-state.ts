import { AcpError, parseAcpFault } from './acp.ts'
import type { AcpFault, HistoryRecord } from './acp.ts'
import type { JsonValue } from './agent-services.ts'
import { parseConsoleProjection, type ConsoleProjectionV1, type SessionObservationState } from './console-api.ts'
import type { RelationRole } from './teams-connection.ts'

/**
 * Public Teams lifecycle and history read surface. Owner: control-protocol.
 * Version: 1 for the connection-status and history-query shapes below.
 *
 * Request/execution lifecycle is intentionally NOT redefined here. The canonical
 * vocabulary stays `RequestState` in `agent-services.ts`; registration presence
 * stays the server directory health vocabulary. This module only adds the two
 * facts no existing owner declares: the transport/negotiation lifecycle of one
 * Teams connection, and the history read request/response shape.
 */

export const TEAMS_CONNECTION_STATUS_VERSION = 1
export const TEAMS_HISTORY_QUERY_VERSION = 1

/** Transport and negotiation lifecycle for one Teams connection. */
export type TeamsConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'negotiating'
  | 'ready'
  | 'closed'
  | 'failed'

export const TEAMS_CONNECTION_STATES: readonly TeamsConnectionState[] = [
  'disconnected',
  'connecting',
  'authenticating',
  'negotiating',
  'ready',
  'closed',
  'failed',
]

export interface TeamsConnectionStatus {
  readonly version: typeof TEAMS_CONNECTION_STATUS_VERSION
  readonly remoteAgentId: string
  readonly state: TeamsConnectionState
  /** The target daemon generation this observation belongs to. */
  readonly targetGeneration: number
  /** Owner event time; never derived from UI animation. */
  readonly observedAt: string
  readonly connectionId?: string
  readonly role?: RelationRole
  /** Present only for `failed`; `closed` carries no error. */
  readonly error?: AcpFault
}

/** One page of owner-recorded history. Records keep their owning sequence. */
export interface HistoryQuery {
  readonly version: typeof TEAMS_HISTORY_QUERY_VERSION
  readonly kind?: 'request' | 'connection'
  readonly agentId?: string
  readonly sessionId?: string
  readonly limit: number
  /** Return records with a strictly smaller sequence; enables paging. */
  readonly beforeSequence?: number
}

export interface HistoryPage {
  readonly records: readonly HistoryRecord[]
  /** Set only when more matching records exist before this page. */
  readonly nextBeforeSequence?: number
}

/** Read-only history port. agent-host owns request history, network owns connection history. */
export interface HistoryReadPort {
  query(query: HistoryQuery): Promise<HistoryPage>
}

/**
 * One owner projection snapshot carried by the SSE stream. `seq` is the owner's own
 * monotonic projection sequence; a consumer that sees a gap treats the projection as
 * degraded instead of inventing the missing rows. The full projection is always carried,
 * so the UI never keeps a delta store as a second source of truth.
 */
export interface ConsoleProjectionSnapshot {
  readonly seq: number
  readonly projection: ConsoleProjectionV1
}

/**
 * Owner projection feed. The owner decides when a snapshot exists and when the owner is
 * lost; a subscriber must never fabricate liveness after `onHealth` reports loss.
 */
export interface ConsoleProjectionSink {
  onSnapshot(snapshot: ConsoleProjectionSnapshot): void
  onHealth(state: SessionObservationState): void
}

export type ConsoleProjectionUnsubscribe = () => void

/** SSE source. Returns the unsubscribe handle that the server calls when the stream ends. */
export type ConsoleProjectionSubscriber = (sink: ConsoleProjectionSink) => ConsoleProjectionUnsubscribe

function fail(message: string): never {
  // Malformed DTOs reuse the single fault carrier; this module declares no
  // second error class or code vocabulary.
  throw new AcpError('INVALID_ACP_FRAME', message)
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownKeys(value: Record<string, JsonValue>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) fail(`${label} has unsupported fields: ${unknown.join(', ')}`)
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

export function parseTeamsConnectionState(value: unknown): TeamsConnectionState {
  if (typeof value !== 'string' || !TEAMS_CONNECTION_STATES.includes(value as TeamsConnectionState)) {
    fail(`Teams connection state is unsupported: ${String(value)}`)
  }
  return value as TeamsConnectionState
}

export function parseTeamsConnectionStatus(value: unknown): TeamsConnectionStatus {
  if (!isRecord(value)) fail('Teams connection status must be an object')
  unknownKeys(value, ['version', 'remoteAgentId', 'state', 'targetGeneration', 'observedAt', 'connectionId', 'role', 'error'], 'Teams connection status')
  if (value.version !== TEAMS_CONNECTION_STATUS_VERSION) {
    fail(`Teams connection status version must be ${TEAMS_CONNECTION_STATUS_VERSION}`)
  }
  const state = parseTeamsConnectionState(value.state)
  if (!Number.isSafeInteger(value.targetGeneration) || (value.targetGeneration as number) < 1) {
    fail('Teams connection status targetGeneration must be a positive integer')
  }
  const observedAt = text(value.observedAt, 'Teams connection status observedAt')
  if (Number.isNaN(Date.parse(observedAt))) fail('Teams connection status observedAt must be an ISO timestamp')
  if (value.connectionId !== undefined) text(value.connectionId, 'Teams connection status connectionId')
  if (value.role !== undefined && value.role !== 'master' && value.role !== 'peer') {
    fail('Teams connection status role must be master or peer')
  }
  if (state === 'failed') {
    if (value.error === undefined) fail('Teams connection status requires an error when failed')
    // The fault shape has one owner; reuse its parser instead of re-checking fields.
    parseAcpFault(value.error)
  } else if (value.error !== undefined) {
    fail('Teams connection status carries an error only when failed')
  }
  return value as unknown as TeamsConnectionStatus
}

export function parseHistoryQuery(value: unknown): HistoryQuery {
  if (!isRecord(value)) fail('history query must be an object')
  unknownKeys(value, ['version', 'kind', 'agentId', 'sessionId', 'limit', 'beforeSequence'], 'history query')
  if (value.version !== TEAMS_HISTORY_QUERY_VERSION) {
    fail(`history query version must be ${TEAMS_HISTORY_QUERY_VERSION}`)
  }
  if (value.kind !== undefined && value.kind !== 'request' && value.kind !== 'connection') {
    fail('history query kind must be request or connection')
  }
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 500) {
    fail('history query limit must be an integer from 1 to 500')
  }
  if (value.beforeSequence !== undefined && (!Number.isSafeInteger(value.beforeSequence) || (value.beforeSequence as number) < 1)) {
    fail('history query beforeSequence must be a positive integer')
  }
  if (value.agentId !== undefined) text(value.agentId, 'history query agentId')
  if (value.sessionId !== undefined) text(value.sessionId, 'history query sessionId')
  return value as unknown as HistoryQuery
}

/** Closed validation of one SSE projection frame; the sequence is the owner's own counter. */
export function parseConsoleProjectionSnapshot(value: unknown): ConsoleProjectionSnapshot {
  if (!isRecord(value)) fail('projection snapshot must be an object')
  unknownKeys(value, ['seq', 'projection'], 'projection snapshot')
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) fail('projection snapshot seq must be a non-negative integer')
  parseConsoleProjection(value.projection)
  return value as unknown as ConsoleProjectionSnapshot
}

const HISTORY_QUERY_FIELDS = ['version', 'kind', 'agentId', 'sessionId', 'limit', 'beforeSequence'] as const

/**
 * The one HTTP query-string → `HistoryQuery` mapping. It refuses every parameter name
 * outside the frozen query, and every duplicate, before the closed parser runs.
 */
export function historyQueryFromSearchParams(params: URLSearchParams): HistoryQuery {
  for (const key of params.keys()) {
    if (!HISTORY_QUERY_FIELDS.includes(key as typeof HISTORY_QUERY_FIELDS[number])) fail(`history query has unsupported fields: ${key}`)
    if (params.getAll(key).length !== 1) fail(`history query has duplicate fields: ${key}`)
  }
  const query: Record<string, unknown> = {}
  const version = params.get('version')
  if (version === null || version.length === 0) fail('history query version is required')
  query.version = Number(version)
  const limit = params.get('limit')
  if (limit === null || limit.length === 0) fail('history query limit is required')
  query.limit = Number(limit)
  const kind = params.get('kind')
  if (kind !== null) query.kind = kind
  const agentId = params.get('agentId')
  if (agentId !== null) query.agentId = agentId
  const sessionId = params.get('sessionId')
  if (sessionId !== null) query.sessionId = sessionId
  const beforeSequence = params.get('beforeSequence')
  if (beforeSequence !== null) query.beforeSequence = Number(beforeSequence)
  return parseHistoryQuery(query)
}
