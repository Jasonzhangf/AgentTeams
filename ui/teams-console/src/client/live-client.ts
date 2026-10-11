import type { ConsoleCommandResultV1, ConsoleCommandV1, ConsoleProjectionV1, ConsoleProjectionSnapshot, ConsoleProjectionSink, ConsoleProjectionUnsubscribe, HistoryPage, HistoryQuery, JsonValue, TeamsConsoleLiveClientV1 } from './protocol.ts'
import { parseConsoleProjectionSnapshot, isCommandFailure, formatServiceError } from './protocol.ts'
import { ConsoleTransportError as TransportError } from './api.ts'
import { createConsoleHttpClient, type ConsoleHttpClientOptions } from './api.ts'

export interface LiveClientOptions extends ConsoleHttpClientOptions {
  readonly historyPath?: string
  readonly eventsPath?: string
  readonly eventSourceImpl?: new (url: string) => EventSource
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function typedErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code
  return 'HISTORY_REFUSED'
}

/**
 * Real fetch+EventSource client for the ADDITIVE D07 capability. It builds on the
 * canonical `createConsoleHttpClient` (unchanged and backwards compatible) and adds
 * the two UI-owned ports: `GET /api/v1/history` and `GET /api/v1/events`.
 */
export function createLiveConsoleHttpClient(options: LiveClientOptions = {}): TeamsConsoleLiveClientV1 {
  const base = createConsoleHttpClient(options)
  const fetchImpl = options.fetchImpl ?? fetch
  const historyPath = options.historyPath ?? '/api/v1/history'
  const eventsPath = options.eventsPath ?? '/api/v1/events'
  const EventSourceImpl = options.eventSourceImpl ?? EventSource

  async function requestHistory(query: HistoryQuery): Promise<HistoryPage> {
    const params = new URLSearchParams()
    params.set('version', String(query.version))
    params.set('limit', String(query.limit))
    if (query.kind !== undefined) params.set('kind', query.kind)
    if (query.agentId !== undefined) params.set('agentId', query.agentId)
    if (query.sessionId !== undefined) params.set('sessionId', query.sessionId)
    if (query.beforeSequence !== undefined) params.set('beforeSequence', String(query.beforeSequence))
    const url = `${historyPath}?${params.toString()}`
    let response: Response
    try {
      response = await fetchImpl(resolveUrl(url, options.baseUrl), { method: 'GET', headers: { Accept: 'application/json' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed'
      throw new TransportError(`Host history request failed: ${message}`)
    }
    const body: unknown = await readJson(response)
    if (!response.ok) {
      const detail = isRecord(body) && typeof body.message === 'string'
        ? `${response.status}: ${body.message}`
        : `HTTP ${response.status}`
      const error = new TransportError(detail, response.status)
      Object.defineProperty(error, 'code', { value: typedErrorCode(body), enumerable: false, writable: false })
      throw error
    }
    try {
      if (!isRecord(body) || !Array.isArray(body.records)) throw new Error('History page must carry records')
      return body as unknown as HistoryPage
    } catch {
      throw new TransportError('Host returned an invalid v1 history page', response.status)
    }
  }

  function subscribeProjection(sink: ConsoleProjectionSink): ConsoleProjectionUnsubscribe {
    const url = resolveUrl(eventsPath, options.baseUrl)
    const source = new EventSourceImpl(url)
    const onSnapshot = (event: MessageEvent): void => {
      let snapshot: ConsoleProjectionSnapshot
      try {
        snapshot = parseConsoleProjectionSnapshot(JSON.parse(String(event.data)))
      } catch {
        sink.onHealth({ state: 'degraded', reason: 'projection-loss', detail: 'Malformed projection event', droppedEvents: 0 })
        return
      }
      sink.onSnapshot(snapshot)
    }
    const onHealth = (event: MessageEvent): void => {
      try {
        sink.onHealth(JSON.parse(String(event.data)) as import('./protocol.ts').SessionObservationState)
      } catch {
        sink.onHealth({ state: 'lost', reason: 'stream-ended', detail: 'Malformed observation health event' })
      }
    }
    const onError = (): void => {
      sink.onHealth({ state: 'lost', reason: 'stream-ended', detail: 'SSE stream ended' })
    }
    source.addEventListener('snapshot', onSnapshot)
    source.addEventListener('health', onHealth)
    source.addEventListener('error', onError)
    return () => {
      source.removeEventListener('snapshot', onSnapshot)
      source.removeEventListener('health', onHealth)
      source.removeEventListener('error', onError)
      source.close()
    }
  }

  return {
    ...base,
    readHistory: requestHistory,
    subscribeProjection,
  }
}

function resolveUrl(path: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return path
  return new URL(path, baseUrl).toString()
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) throw new TransportError('Host returned an empty response', response.status)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new TransportError('Host returned invalid JSON', response.status)
  }
}
