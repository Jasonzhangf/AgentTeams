import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGroupRequestClient } from '../src/client/group-client.ts'

/**
 * The shipped client driven over a real HTTP socket, against a minimal server that
 * implements the group endpoint contract verbatim. This proves the transport mapping
 * (base URL, method, query, envelope shape, and status-code separation) without depending
 * on the console host source: the server asserts what it receives, the client asserts what
 * it maps.
 */

type RequestRecord = { url: string; method: string; body: unknown }

async function start(respond: (request: RequestRecord, respond: (status: number, body: unknown) => void) => void) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      try { body = JSON.parse(text) as unknown } catch { body = undefined }
      respond(
        { url: request.url ?? '', method: request.method ?? '', body },
        (status, value) => {
          response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(value))
        },
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

describe('group request client over a real HTTP socket', () => {
  it('posts exactly {requestId, frame} with only the agentId query and resolves a reply', async () => {
    let received: RequestRecord | undefined
    const server = await start((request, respond) => {
      received = request
      respond(200, { ok: true, reply: { kind: 'group.list', requestId: 'r1', groups: [] } })
    })
    try {
      const sender = createGroupRequestClient({ baseUrl: server.url })
      const outcome = await sender.requestGroup('agent-a', { kind: 'group.list', requestId: 'r1' })
      expect(outcome).toEqual({ kind: 'reply', reply: { kind: 'group.list', requestId: 'r1', groups: [] } })
      expect(received!.method).toBe('POST')
      expect(new URL(received!.url, server.url).pathname).toBe('/api/v1/group-request')
      expect(new URL(received!.url, server.url).searchParams.get('agentId')).toBe('agent-a')
      expect([...new URL(received!.url, server.url).searchParams.keys()]).toEqual(['agentId'])
      expect(received!.body).toEqual({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } })
    } finally { await server.close() }
  })

  it('maps 503 to not-configured and 502 GROUP_ENDPOINT_UNREACHABLE to unreachable', async () => {
    const notConfigured = await start((_request, respond) => respond(503, { code: 'GROUP_ENDPOINT_NOT_CONFIGURED', message: 'owner missing' }))
    const unreachable = await start((_request, respond) => respond(502, { code: 'GROUP_ENDPOINT_UNREACHABLE', message: 'socket refused' }))
    try {
      const first = await createGroupRequestClient({ baseUrl: notConfigured.url }).requestGroup('agent-a', { kind: 'group.list', requestId: 'r1' })
      const second = await createGroupRequestClient({ baseUrl: unreachable.url }).requestGroup('agent-a', { kind: 'group.list', requestId: 'r1' })
      expect(first).toEqual({ kind: 'access', access: { kind: 'not-configured', message: 'owner missing' } })
      expect(second).toEqual({ kind: 'access', access: { kind: 'unreachable', message: 'socket refused' } })
    } finally {
      await notConfigured.close()
      await unreachable.close()
    }
  })

  it('passes a 200 owner refusal through verbatim and never treats it as a delivery', async () => {
    const server = await start((_request, respond) => respond(200, { ok: false, error: { code: 'FORBIDDEN', message: 'peer not declared' } }))
    try {
      const outcome = await createGroupRequestClient({ baseUrl: server.url }).requestGroup('agent-a', { kind: 'group.list', requestId: 'r1' })
      expect(outcome).toEqual({ kind: 'refused', code: 'FORBIDDEN', message: 'peer not declared' })
    } finally { await server.close() }
  })

  it('treats a malformed owner envelope as a transport failure, not a silent success', async () => {
    const server = await start((_request, respond) => respond(200, { ok: true, reply: { kind: 'not-a-real-reply' } }))
    try {
      const outcome = await createGroupRequestClient({ baseUrl: server.url }).requestGroup('agent-a', { kind: 'group.list', requestId: 'r1' })
      expect(outcome.kind).toBe('transport')
    } finally { await server.close() }
  })
})
