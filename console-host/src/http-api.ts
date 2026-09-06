import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseConsoleCommand, type ConsoleClientV1 } from '../../control-protocol/console-api.ts'
import { assertJsonValue } from '../../control-protocol/json-value.ts'

export interface ConsoleApiOptions {
  /** Runtime authenticates this request and returns only its authorized daemon binding. */
  readonly authorize: (request: IncomingMessage) => Promise<ConsoleClientV1 | undefined>
  readonly maxBodyBytes?: number
}

class HttpInputError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
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
      if (!projection && !command && !session) { reply(response, 404, { message: 'Unknown Console endpoint' }); return }
      if (request.method !== (projection ? 'GET' : 'POST')) { reply(response, 405, { message: 'Method not allowed' }); return }
      if (!session && url.search) throw new HttpInputError(400, 'Unexpected query parameters')
      if (projection) { reply(response, 200, await client.readProjection()); return }
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
      if (!response.headersSent) reply(response, error instanceof HttpInputError ? error.status : 502,
        { message: error instanceof HttpInputError ? error.message : 'Console owner request failed; outcome not inferred' })
      else response.destroy()
    }
  }
}
