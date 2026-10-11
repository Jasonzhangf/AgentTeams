import type { AcpFault, HistoryRecord } from '../control-protocol/acp.ts'
import { AcpError, parseAcpFault } from '../control-protocol/acp.ts'
import type { TeamsAgreement } from '../control-protocol/teams-connection.ts'
import type { HistoryPage, HistoryQuery, HistoryReadPort } from '../control-protocol/teams-state.ts'
import { parseHistoryQuery } from '../control-protocol/teams-state.ts'
import type { AcpHistoryPort } from '../agent-host/acp-history.ts'

/**
 * Teams connection history (owner: network).
 *
 * A thin typed wrapper over the injected durable store. It writes and reads only
 * `kind: 'connection'` records and keeps the frozen `HistoryRecord` shape, so
 * connection/role history never becomes a second request-history source and
 * never gains a second field vocabulary.
 *
 * The record shape carries no `role` or `targetGeneration` field: those facts
 * live in the typed `agreement` that a negotiation record stores. This module
 * does not invent fields to flatten them.
 */

export const TEAMS_CONNECTION_EVENTS = [
  'connection.negotiated',
  'connection.rejected',
  'connection.closed',
  'connection.failed',
  'connection.half-open',
  'connection.registry-lost',
  'connection.registry-restored',
  'channel.opened',
  'channel.closed',
  'generation.replaced',
] as const

export type TeamsConnectionEvent = (typeof TEAMS_CONNECTION_EVENTS)[number]

export type TeamsConnectionOutcome = 'completed' | 'failed' | 'denied' | 'unknown'

export interface TeamsConnectionHistoryEntry {
  readonly event: TeamsConnectionEvent
  readonly agentId: string
  readonly occurredAt: string
  readonly connectionId?: string
  readonly channelId?: string
  readonly engineInstanceId?: string
  readonly requestRecordId?: string
  readonly sessionId?: string
  readonly outcome?: TeamsConnectionOutcome
  readonly error?: AcpFault
  /** The negotiated agreement this connection event belongs to. */
  readonly agreement?: TeamsAgreement
}

export interface TeamsConnectionHistory {
  record(entry: TeamsConnectionHistoryEntry): Promise<HistoryRecord>
  /** Reads only `kind: 'connection'` records. A `request` query is refused, not silently rewritten. */
  query(query: HistoryQuery): Promise<HistoryPage>
}

const OUTCOMES: readonly TeamsConnectionOutcome[] = ['completed', 'failed', 'denied', 'unknown']

function fail(message: string): never {
  throw new AcpError('INVALID_ACP_FRAME', message)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`teams-connection-history: ${label} must be a non-empty string`)
  return value
}

function optionalText(value: unknown, label: string): void {
  if (value !== undefined) text(value, label)
}

export function createTeamsConnectionHistory(store: AcpHistoryPort & HistoryReadPort): TeamsConnectionHistory {
  const record = async (entry: TeamsConnectionHistoryEntry): Promise<HistoryRecord> => {
    if (!TEAMS_CONNECTION_EVENTS.includes(entry.event)) {
      fail(`teams-connection-history: unsupported connection event ${String(entry.event)}`)
    }
    text(entry.agentId, 'agentId')
    const occurredAt = text(entry.occurredAt, 'occurredAt')
    if (Number.isNaN(Date.parse(occurredAt))) fail('teams-connection-history: occurredAt must be an ISO timestamp')
    optionalText(entry.connectionId, 'connectionId')
    optionalText(entry.channelId, 'channelId')
    optionalText(entry.engineInstanceId, 'engineInstanceId')
    optionalText(entry.requestRecordId, 'requestRecordId')
    optionalText(entry.sessionId, 'sessionId')
    if (entry.outcome !== undefined && !OUTCOMES.includes(entry.outcome)) {
      fail(`teams-connection-history: unsupported outcome ${String(entry.outcome)}`)
    }
    if (entry.error !== undefined) parseAcpFault(entry.error)
    return store.append({
      kind: 'connection',
      event: entry.event,
      agentId: entry.agentId,
      occurredAt,
      ...(entry.connectionId === undefined ? {} : { connectionId: entry.connectionId }),
      ...(entry.channelId === undefined ? {} : { channelId: entry.channelId }),
      ...(entry.engineInstanceId === undefined ? {} : { engineInstanceId: entry.engineInstanceId }),
      ...(entry.requestRecordId === undefined ? {} : { requestRecordId: entry.requestRecordId }),
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.agreement === undefined ? {} : { agreement: entry.agreement }),
    })
  }

  const query = async (raw: HistoryQuery): Promise<HistoryPage> => {
    const parsed = parseHistoryQuery(raw)
    if (parsed.kind !== undefined && parsed.kind !== 'connection') {
      fail('teams-connection-history: this surface reads connection records only')
    }
    return store.query({ ...parsed, kind: 'connection' })
  }

  return { record, query }
}
