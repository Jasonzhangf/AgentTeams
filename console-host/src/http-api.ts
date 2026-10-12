import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseConsoleCommand, type ConsoleClientV1 } from '../../control-protocol/console-api.ts'
import { assertJsonValue } from '../../control-protocol/json-value.ts'
import {
  historyQueryFromSearchParams,
  type ConsoleProjectionSink,
  type ConsoleProjectionSubscriber,
  type HistoryPage,
  type HistoryReadPort,
} from '../../control-protocol/teams-state.ts'

export interface ConsoleApiOptions {
  /** Runtime authenticates this request and returns only its authorized daemon binding. */
  readonly authorize: (request: IncomingMessage) => Promise<ConsoleClientV1 | undefined>
  /** Owner history reader. Absent means the control runtime has no bound history owner. */
  readonly history?: HistoryReadPort
  /** Owner projection feed for the SSE stream. Absent means no stream can be offered. */
  readonly events?: ConsoleProjectionSubscriber
  readonly maxBodyBytes?: number
}

class HttpInputError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/**
 * Typed owner absence. The transport reports that the owner is not bound and never
 * invents an empty history page or a live stream. Runtime absence faults carry their
 * code; the transport checks the closed vocabulary instead of depending on the runtime.
 */
const OWNER_ABSENCE_CODES = ['HISTORY_UNAVAILABLE', 'STREAM_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE'] as const
function ownerAbsenceCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && (OWNER_ABSENCE_CODES as readonly string[]).includes(code) ? code : undefined
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}
async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpInputError(415, 'JSON content type required')
  const chunks: Buffer[] = []
  let bytes = 0
  // Avoid iterator destruction before returning the structured oversized-body response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limit) { request.resume(); throw new HttpInputError(413, 'Request body too large') }
    chunks.push(buffer)
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new HttpInputError(400, 'Invalid JSON body') }
}

/** Real SSE stream: full projection snapshots plus owner health, closed on owner loss. */
function streamEvents(response: ServerResponse, subscriber: ConsoleProjectionSubscriber): Promise<void> {
  return new Promise<void>(resolveStream => {
    let open = true
    let unsubscribe: (() => void) | undefined
    const cleanup = () => {
      open = false
      try { unsubscribe?.() } catch { /* the stream is already ending; keep the owner failure local */ }
    }
    const finish = () => { cleanup(); resolveStream() }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    })
    response.flushHeaders?.()
    const frame = (event: string, payload: unknown) => {
      if (!open) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    const sink: ConsoleProjectionSink = {
      // The event name is the contract the UI live client subscribes to
      // (ui/teams-console/src/client/{live-client,observation}.ts listen for `snapshot`).
      // A named SSE event with no matching listener is dropped silently, so this name and the
      // client listeners must agree; console-host/tests/http-api.spec.ts pins it.
      onSnapshot(snapshot) { frame('snapshot', snapshot) },
      onHealth(state) {
        if (!open) return
        frame('health', state)
        // Owner loss closes the stream; liveness is never fabricated after it.
        if (state.state !== 'live') { cleanup(); response.end() }
      },
    }
    response.once('close', finish)
    response.once('error', finish)
    // A subscriber that throws on subscribe ends the stream instead of leaving it open.
    try { unsubscribe = subscriber(sink) }
    catch { cleanup(); response.end() }
  })
}

/** HTTP transport only: no Session, configuration, relationship or permission state is owned here. */
export function createConsoleApiHandler(options: ConsoleApiOptions) {
  const limit = options.maxBodyBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid Console body limit')
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const client = await options.authorize(request)
      if (!client) { reply(response, 401, { message: 'Console authentication required' }); return }
      const url = new URL(request.url ?? '/', 'http://console.invalid')
      const projection = url.pathname === '/api/v1/projection'
      const command = url.pathname === '/api/v1/command'
      const session = url.pathname === '/api/v1/session-message'
      const history = url.pathname === '/api/v1/history'
      const events = url.pathname === '/api/v1/events'
      if (!projection && !command && !session && !history && !events) { reply(response, 404, { message: 'Unknown Console endpoint' }); return }
      if (request.method !== (projection || history || events ? 'GET' : 'POST')) { reply(response, 405, { message: 'Method not allowed' }); return }
      // The history route is the only route that relaxes the blanket query-parameter
      // rejection; every other route keeps the exact previous refusal.
      if (!session && !history && url.search) throw new HttpInputError(400, 'Unexpected query parameters')
      if (projection) { reply(response, 200, await client.readProjection()); return }
      if (history) {
        let query
        try { query = historyQueryFromSearchParams(url.searchParams) }
        catch (error) { throw new HttpInputError(400, error instanceof Error ? error.message : 'Invalid history query') }
        // A missing or absent owner is a typed refusal, not a transport failure of this server.
        if (options.history === undefined) reply(response, 503, { code: 'HISTORY_UNAVAILABLE', message: 'history owner is not bound to this control daemon' })
        else {
          let page: HistoryPage
          try { page = await options.history.query(query) }
          catch (error) {
            const code = ownerAbsenceCode(error)
            if (code === undefined) reply(response, 502, { message: 'Console owner request failed; outcome not inferred' })
            else reply(response, 503, { code, message: error instanceof Error ? error.message : 'history owner is not bound' })
            return
          }
          reply(response, 200, page)
        }
        return
      }
      if (events) {
        if (options.events === undefined) { reply(response, 503, { code: 'STREAM_UNAVAILABLE', message: 'projection owner is not bound to this control daemon' }); return }
        await streamEvents(response, options.events)
        return
      }
      const value = await body(request, limit)
      if (command) {
        let parsed
        try { parsed = parseConsoleCommand(value) }
        catch { throw new HttpInputError(400, 'Invalid Console command') }
        reply(response, 200, await client.command(parsed))
        return
      }
      const agentId = url.searchParams.get('agentId')
      const sessionId = url.searchParams.get('sessionId')
      if (!agentId || !sessionId || url.searchParams.size !== 2) throw new HttpInputError(400, 'Exact Agent and Session target required')
      assertJsonValue(value, 'Session body')
      reply(response, 200, await client.sendSession({ agentId, sessionId }, value))
    } catch (error) {
      if (!response.headersSent) {
        const absence = ownerAbsenceCode(error)
        if (absence !== undefined) reply(response, 503, { code: absence, message: error instanceof Error ? error.message : 'Console owner is not bound' })
        else reply(response, error instanceof HttpInputError ? error.status : 502,
          { message: error instanceof HttpInputError ? error.message : 'Console owner request failed; outcome not inferred' })
      } else response.destroy()
    }
  }
}
