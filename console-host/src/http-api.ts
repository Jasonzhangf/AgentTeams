import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServiceError } from '../../packages/shared/src/agent-services.ts'
import { ConsoleProjectionError, parseConsoleCommand, type ConsoleClientV1 } from '../../packages/shared/src/console-api.ts'
import { parseGroupWireRequest, type GroupWireReply, type GroupWireRequest } from '../../packages/shared/src/group-wire.ts'
import { assertJsonValue } from '../../packages/shared/src/json-value.ts'
import {
  historyQueryFromSearchParams,
  type ConsoleProjectionSink,
  type ConsoleProjectionSubscriber,
  type HistoryPage,
  type HistoryReadPort,
} from '../../packages/shared/src/teams-state.ts'

/**
 * The closed envelope vocabulary: every ServiceError code the group owner may answer with,
 * plus the two transport-only endpoint codes that never enter the group wire. A hub that
 * answers `FORBIDDEN`, `UNAVAILABLE`, `UPSTREAM_ERROR` or `RESULT_UNKNOWN` keeps its own code,
 * and the two local-transport outcomes stay distinct from it.
 */
export type ConsoleGroupEnvelopeCode =
  | ServiceError['code']
  | 'GROUP_ENDPOINT_NOT_CONFIGURED'
  | 'GROUP_ENDPOINT_UNREACHABLE'

export interface ConsoleGroupFailure {
  readonly code: ConsoleGroupEnvelopeCode
  readonly message: string
}

/**
 * One forwarded group frame and what the group owner's path answered.
 *
 * The transport owns no group semantics and no group authority: it validates the envelope,
 * hands the closed frame to the bound forwarder and maps the outcome to one status.
 *  - `reply`: the group owner answered with a group reply;
 *  - `owner-error`: the group owner answered with a typed error; the code and message travel
 *    verbatim;
 *  - `invalid-target`: the request named an agent this daemon does not declare; it is a bad
 *    input, never a missing endpoint;
 *  - `not-configured`: the target agent published no local group endpoint, so no request was
 *    sent at all;
 *  - `unreachable`: an endpoint is published but no group owner answered, so the frame may or
 *    may not have been applied.
 */
export type ConsoleGroupForwardOutcome =
  | { readonly outcome: 'reply'; readonly reply: GroupWireReply }
  | { readonly outcome: 'owner-error'; readonly error: ServiceError }
  | { readonly outcome: 'invalid-target'; readonly message: string }
  | { readonly outcome: 'not-configured'; readonly message: string }
  | { readonly outcome: 'unreachable'; readonly error: ConsoleGroupFailure }

/** The runtime's one local group socket binding for a declared peer agent. */
export interface ConsoleGroupForwardPort {
  forward(input: { readonly agentId: string; readonly request: GroupWireRequest }): Promise<ConsoleGroupForwardOutcome>
}

export interface ConsoleApiOptions {
  /** Runtime authenticates this request and returns only its authorized daemon binding. */
  readonly authorize: (request: IncomingMessage) => Promise<ConsoleClientV1 | undefined>
  /** Owner history reader. Absent means the control runtime has no bound history owner. */
  readonly history?: HistoryReadPort
  /** Owner projection feed for the SSE stream. Absent means no stream can be offered. */
  readonly events?: ConsoleProjectionSubscriber
  /** Local group socket binding per declared peer. Absent means no group route is offered. */
  readonly group?: ConsoleGroupForwardPort
  readonly maxBodyBytes?: number
}

class HttpInputError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
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

/**
 * The closed vocabulary a group envelope may carry. The service codes mirror
 * `ServiceError['code']` verbatim; the two endpoint codes are transport-only and never enter
 * the group wire, so a hub that answers `FORBIDDEN`, `UNAVAILABLE`, `UPSTREAM_ERROR` or
 * `RESULT_UNKNOWN` keeps its own code and the two local-transport outcomes stay distinct.
 * An unknown code is refused by this transport instead of being forwarded to the UI.
 */
const SERVICE_ERROR_CODES = [
  'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATION', 'STALE_GENERATION', 'REVISION_CONFLICT', 'RESOURCE_EXHAUSTED',
  'CONFLICT', 'RESULT_UNKNOWN', 'UNAVAILABLE', 'UPSTREAM_ERROR',
] as const satisfies readonly ServiceError['code'][]
const GROUP_ENDPOINT_CODES = ['GROUP_ENDPOINT_NOT_CONFIGURED', 'GROUP_ENDPOINT_UNREACHABLE'] as const
function groupErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const known = (SERVICE_ERROR_CODES as readonly string[]).includes(value) ||
    (GROUP_ENDPOINT_CODES as readonly string[]).includes(value)
  return known ? value : undefined
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
      // (ui/teams-console/src/client/live-client.ts and ui/teams-console/src/state/observation.ts listen for `snapshot`).
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

/**
 * The one group envelope: one closed group frame plus the requestId it must carry. The frame
 * is decoded by the frozen group-wire parser, so the transport never interprets a business
 * field and never widens the closed frame union.
 */
function groupEnvelope(value: unknown): GroupWireRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpInputError(400, 'Group request envelope must be an object', 'INVALID_INPUT')
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).sort().join(',') !== 'frame,requestId') {
    throw new HttpInputError(400, 'Group request envelope takes exactly requestId and frame', 'INVALID_INPUT')
  }
  const requestId = envelope.requestId
  if (typeof requestId !== 'string' || requestId.length === 0) throw new HttpInputError(400, 'Group request requestId must be a non-empty string', 'INVALID_INPUT')
  let request: GroupWireRequest
  try { request = parseGroupWireRequest(JSON.stringify(envelope.frame)) }
  catch { throw new HttpInputError(400, 'Invalid group request frame', 'INVALID_INPUT') }
  if (request.requestId !== requestId) throw new HttpInputError(400, 'Group request envelope requestId must match the frame requestId', 'INVALID_INPUT')
  return request
}

/**
 * Map one forward outcome to one status. The group owner's own answer keeps its code and
 * message verbatim (200 `ok:false`), an undeclared target is a bad input (400), a missing
 * endpoint is the typed `not-configured` absence (503), and an unanswered endpoint is a
 * transport failure (502) whose code is the owner's own when it has one — `RESULT_UNKNOWN`
 * therefore stays `RESULT_UNKNOWN` instead of being flattened into a retryable-looking
 * unreachable.
 */
function groupOutcome(response: ServerResponse, result: ConsoleGroupForwardOutcome): void {
  if (result.outcome === 'reply') { reply(response, 200, { ok: true, reply: result.reply }); return }
  if (result.outcome === 'owner-error') { reply(response, 200, { ok: false, error: result.error }); return }
  if (result.outcome === 'invalid-target') {
    reply(response, 400, { code: 'INVALID_INPUT', message: result.message })
    return
  }
  if (result.outcome === 'not-configured') {
    reply(response, 503, { code: 'GROUP_ENDPOINT_NOT_CONFIGURED', message: result.message })
    return
  }
  const code = groupErrorCode(result.error.code)
  if (code === undefined) {
    reply(response, 502, { code: 'UPSTREAM_ERROR', message: 'group forwarder returned an error code outside the Console group vocabulary' })
    return
  }
  reply(response, 502, { code, message: result.error.message })
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
      const group = url.pathname === '/api/v1/group-request'
      if (!projection && !command && !session && !history && !events && !group) { reply(response, 404, { message: 'Unknown Console endpoint' }); return }
      if (request.method !== (projection || history || events ? 'GET' : 'POST')) { reply(response, 405, { message: 'Method not allowed' }); return }
      // The history route and the group route carry their own closed query readers; every
      // other route keeps the exact previous refusal.
      if (!session && !history && !group && url.search) throw new HttpInputError(400, 'Unexpected query parameters')
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
      if (group) {
        // One declared peer per request. The exact target keeps a Console request from
        // reaching an agent this daemon does not declare, and the peer's own identity is
        // what the group owner authenticates: the Console adds no actor of its own.
        const agentId = url.searchParams.get('agentId')
        if (!agentId || url.searchParams.size !== 1) throw new HttpInputError(400, 'Exact Agent target required', 'INVALID_INPUT')
        const frame = groupEnvelope(value)
        if (options.group === undefined) {
          reply(response, 503, { code: 'GROUP_ENDPOINT_NOT_CONFIGURED', message: 'the group owner is not bound to this control daemon' })
          return
        }
        groupOutcome(response, await options.group.forward({ agentId, request: frame }))
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
        // A route that names its own input code reports it; every earlier refusal keeps the
        // exact previous body, so no existing client sees a new shape.
        else if (error instanceof HttpInputError) reply(response, error.status, error.code === undefined ? { message: error.message } : { code: error.code, message: error.message })
        else if (error instanceof ConsoleProjectionError) {
          const { code, message } = error.error
          const status = code === 'FORBIDDEN' ? 403 : code === 'UNAUTHENTICATED' ? 401
            : code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400
            : code === 'STALE_GENERATION' || code === 'REVISION_CONFLICT' || code === 'CONFLICT' ? 409
            : code === 'UNAVAILABLE' || code === 'RESOURCE_EXHAUSTED' ? 503 : 502
          reply(response, status, { code, message })
        }
        else reply(response, 502, { message: 'Console owner request failed; outcome not inferred' })
      } else response.destroy()
    }
  }
}
