import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createVikunjaSync,
  stableReference,
  VikunjaSyncError,
  type VikunjaResult,
} from './vikunja-sync.ts'

interface RecordedRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly authorization: string | undefined
  readonly contentType: string | undefined
  readonly body: string
}

interface TestServer {
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
  readonly close: () => Promise<void>
}

const servers: TestServer[] = []

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  await new Promise<void>((resolve, reject) => {
    request.once('end', resolve)
    request.once('error', reject)
  })
  return Buffer.concat(chunks)
}

async function startServer(
  handler: (request: RecordedRequest, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((incoming, response) => {
    void (async () => {
      const body = await readBody(incoming)
      requests.push({
        method: incoming.method,
        url: incoming.url,
        authorization: incoming.headers.authorization,
        contentType: incoming.headers['content-type'],
        body: body.toString('utf8'),
      })
      handler(requests[requests.length - 1], response)
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not expose an address')
  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
  servers.push(testServer)
  return testServer
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function sync(server: TestServer, options: Partial<{ timeoutMs: number }> = {}) {
  return createVikunjaSync({ baseUrl: server.baseUrl, token: 'test-token', ...options })
}

function expectUnknown<T>(result: VikunjaResult<T>): void {
  expect(result.status).toBe('unknown')
  if (result.status === 'unknown') {
    expect(result.error).toMatchObject({ code: 'RESULT_UNKNOWN' })
  }
}

function expectFailed<T>(result: VikunjaResult<T>, code: string, status?: number): void {
  expect(result.status).toBe('failed')
  if (result.status === 'failed') {
    expect(result.error.code).toBe(code)
  }
}

describe('vikunja sync', () => {
  it('creates an issue with the Vikunja path, bearer auth, and a stable reference in the body', async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, { id: 41, title: 'Fix it', description: 'Details', done: false })
    })

    const result = await sync(server).createIssue({
      projectId: '7',
      title: 'Fix it',
      body: 'Details',
      ref: 'commit-1',
    })

    expect(result).toEqual({ status: 'ok', value: { issueId: '41', title: 'Fix it', state: 'open' } })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'PUT',
      url: '/api/v1/projects/7/tasks',
      authorization: 'Bearer test-token',
    })
    expect(JSON.parse(server.requests[0].body)).toEqual({
      title: 'Fix it',
      description: `Details\n\n${stableReference('commit-1')}`,
    })
  })

  it.each([
    [false, 'open'],
    [true, 'closed'],
  ] as const)('maps a done=%s task read to the %s state', async (done, state) => {
    const server = await startServer((_request, response) => {
      json(response, 200, { id: 9, title: 'Track', done })
    })

    const result = await sync(server).readState({ issueId: '9' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '9', state } })
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/tasks/9' })
  })

  it('references an existing issue without writing', async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, { id: 5, title: 'Existing', done: true })
    })

    const result = await sync(server).referenceIssue({ issueId: '5' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '5', title: 'Existing', state: 'closed' } })
    expect(server.requests).toHaveLength(1)
  })

  it('writes a comment with the stable reference in its body', async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, { id: 12, comment: 'Result', task_id: 5 })
    })

    const result = await sync(server).writeComment({ issueId: '5', body: 'Result', ref: 'result-1' })

    expect(result).toEqual({ status: 'ok', value: { commentId: '12', issueId: '5', body: 'Result' } })
    expect(server.requests[0]).toMatchObject({
      method: 'PUT',
      url: '/api/v1/tasks/5/comments',
      authorization: 'Bearer test-token',
    })
    expect(JSON.parse(server.requests[0].body)).toEqual({
      comment: `Result\n\n${stableReference('result-1')}`,
    })
  })

  it('closes an issue and reports the readback actual state', async () => {
    const server = await startServer((request, response) => {
      if (request.method === 'POST') return json(response, 200, { id: 5, title: 'Track', description: 'Body', done: true })
      return json(response, 200, { id: 5, title: 'Track', description: 'Body', done: true })
    })

    const result = await sync(server).closeIssue({ issueId: '5' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '5', expectedState: 'closed', actualState: 'closed' } })
    // One read before the write, the write itself, one read after it.
    expect(server.requests).toHaveLength(3)
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/tasks/5' })
    expect(server.requests[1]).toMatchObject({ method: 'POST', url: '/api/v1/tasks/5' })
    // The update is a full update, so it carries the fields it must keep, not only `done`.
    expect(JSON.parse(server.requests[1].body)).toEqual({ id: 5, title: 'Track', description: 'Body', done: true })
    expect(server.requests[2]).toMatchObject({ method: 'GET', url: '/api/v1/tasks/5' })
  })

  it('expresses a close conflict as the actual state without rewriting', async () => {
    const server = await startServer((request, response) => {
      if (request.method === 'POST') return json(response, 200, { id: 5, title: 'Track', done: true })
      return json(response, 200, { id: 5, title: 'Track', done: false })
    })

    const result = await sync(server).closeIssue({ issueId: '5' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '5', expectedState: 'closed', actualState: 'open' } })
    // The write happened once and was not repeated to repair the mismatch.
    expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  })

  it('reopens an issue with done=false and reports the actual state', async () => {
    const server = await startServer((request, response) => {
      if (request.method === 'POST') return json(response, 200, { id: 5, title: 'Track', done: false })
      return json(response, 200, { id: 5, title: 'Track', done: false })
    })

    const result = await sync(server).reopenIssue({ issueId: '5' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '5', expectedState: 'open', actualState: 'open' } })
    expect(JSON.parse(server.requests[1].body)).toEqual({ id: 5, title: 'Track', done: false })
  })

  it('keeps the description and its stable reference through a full-update close', async () => {
    // Vikunja v2.7.1 answers POST /api/v1/tasks/{id} with full-update semantics: a field the
    // body omits is reset. This stub replaces the stored task the same way, so a body carrying
    // only `done` erases the description — and with it the stable reference `createIssue` wrote
    // there, which is what `findIssueByStableRef` later searches for.
    const stored: Record<string, unknown> = {
      id: 5,
      title: 'accept-issue',
      description: `hello\n\n${stableReference('test-ref-1')}`,
      done: false,
      project_id: 2,
    }
    const server = await startServer((request, response) => {
      if (request.method === 'POST') {
        const body = JSON.parse(request.body) as Record<string, unknown>
        for (const key of Object.keys(stored)) if (!(key in body)) delete stored[key]
        Object.assign(stored, body)
        return json(response, 200, stored)
      }
      if (request.url === '/api/v1/projects/2/tasks') return json(response, 200, [stored])
      return json(response, 200, stored)
    })

    const result = await sync(server).closeIssue({ issueId: '5' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '5', expectedState: 'closed', actualState: 'closed' } })
    // The write carried the whole task, so the server kept the body and its reference.
    expect(stored.description).toBe(`hello\n\n${stableReference('test-ref-1')}`)
    expect(stored.title).toBe('accept-issue')
    expect(stored.project_id).toBe(2)
    expect(JSON.parse(server.requests[1].body)).toEqual({
      id: 5,
      title: 'accept-issue',
      description: `hello\n\n${stableReference('test-ref-1')}`,
      done: true,
      project_id: 2,
    })
    // The reference the sync looks up is still findable after the close.
    const found = await sync(server).findIssueByStableRef({ projectId: '2', ref: 'test-ref-1' })
    expect(found).toEqual({ status: 'ok', value: { issueId: '5', title: 'accept-issue', state: 'closed' } })
  })

  it('keeps priority, dates and progress through a full-update close', async () => {
    // The same full-update stub as above, now with the non-default fields a real
    // Vikunja task can carry. A body that carries only the identity and body
    // resets every omitted field, so this catches the field-loss regression.
    const stored: Record<string, unknown> = {
      id: 6,
      title: 'keep-fields',
      description: 'details',
      done: false,
      project_id: 2,
      priority: 4,
      due_date: '2026-11-30T00:00:00Z',
      start_date: '2026-11-01T00:00:00Z',
      percent_done: 0.25,
      hex_color: '336699',
    }
    const server = await startServer((request, response) => {
      if (request.method === 'POST') {
        const body = JSON.parse(request.body) as Record<string, unknown>
        for (const key of Object.keys(stored)) if (!(key in body)) delete stored[key]
        Object.assign(stored, body)
        return json(response, 200, stored)
      }
      return json(response, 200, stored)
    })

    const result = await sync(server).closeIssue({ issueId: '6' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '6', expectedState: 'closed', actualState: 'closed' } })
    expect(JSON.parse(server.requests[1].body)).toMatchObject({
      id: 6,
      project_id: 2,
      priority: 4,
      due_date: '2026-11-30T00:00:00Z',
      start_date: '2026-11-01T00:00:00Z',
      percent_done: 0.25,
      hex_color: '336699',
      done: true,
    })
    expect(stored).toMatchObject({
      priority: 4,
      due_date: '2026-11-30T00:00:00Z',
      start_date: '2026-11-01T00:00:00Z',
      percent_done: 0.25,
      hex_color: '336699',
      done: true,
    })
  })

  it.each([
    [400, 'INVALID_INPUT'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RESOURCE_EXHAUSTED'],
    [500, 'UPSTREAM_ERROR'],
  ] as const)('maps HTTP %s to ServiceError %s without retrying', async (status, code) => {
    const server = await startServer((_request, response) => {
      response.statusCode = status
      response.end('failure')
    })

    const result = await sync(server).readState({ issueId: '1' })

    expectFailed(result, code)
    expect(server.requests).toHaveLength(1)
  })

  it('does not retry a failed write', async () => {
    const server = await startServer((_request, response) => {
      response.statusCode = 503
      response.end('unavailable')
    })

    const result = await sync(server).createIssue({
      projectId: '7', title: 'Fix', body: 'Details', ref: 'commit-1',
    })

    expectFailed(result, 'UPSTREAM_ERROR')
    expect(server.requests).toHaveLength(1)
  })

  it('returns RESULT_UNKNOWN when the server drops the write connection', async () => {
    const server = await startServer((_request, response) => {
      response.destroy()
    })

    const result = await sync(server).createIssue({
      projectId: '7', title: 'Fix', body: 'Details', ref: 'commit-1',
    })

    expectUnknown(result)
    expect(server.requests).toHaveLength(1)
  })

  it('returns RESULT_UNKNOWN on a write timeout instead of success', async () => {
    const server = await startServer(() => {
      // Never respond; the client's own timeout is the only terminator.
    })

    const result = await sync(server, { timeoutMs: 20 }).writeComment({
      issueId: '5', body: 'Result', ref: 'result-1',
    })

    expectUnknown(result)
    expect(server.requests).toHaveLength(1)
  })

  it.each([
    ['{}', 'missing id'],
    ['{', 'invalid json'],
  ] as const)('returns RESULT_UNKNOWN for an incomplete 2xx write response (%s)', async (body, _label) => {
    const server = await startServer((_request, response) => {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end(body)
    })

    const result = await sync(server).createIssue({
      projectId: '7', title: 'Fix', body: 'Details', ref: 'commit-1',
    })

    expectUnknown(result)
  })

  it('reports an incomplete read response as a failure, not unknown', async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, {})
    })

    const result = await sync(server).readState({ issueId: '1' })

    expectFailed(result, 'UPSTREAM_ERROR')
  })

  it('finds an issue by the stable reference in its body', async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, [
        { id: 1, title: 'Other', description: 'no match', done: false },
        { id: 2, title: 'Track', description: `Body\n\n${stableReference('commit-2')}`, done: false },
      ])
    })

    const result = await sync(server).findIssueByStableRef({ projectId: '7', ref: 'commit-2' })

    expect(result).toEqual({ status: 'ok', value: { issueId: '2', title: 'Track', state: 'open' } })
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/projects/7/tasks' })
  })

  it('returns ok with no value when no issue matches the stable reference', async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, [
        { id: 1, title: 'Other', description: 'no match', done: false },
      ])
    })

    const result = await sync(server).findIssueByStableRef({ projectId: '7', ref: 'commit-2' })

    expect(result).toEqual({ status: 'ok', value: undefined })
  })

  it('finds and misses comments by stable reference', async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, [
        { id: 1, comment: 'first' },
        { id: 2, comment: `second ${stableReference('result-1')}` },
      ])
    })

    const hit = await sync(server).findCommentByStableRef({ issueId: '5', ref: 'result-1' })
    const miss = await sync(server).findCommentByStableRef({ issueId: '5', ref: 'result-2' })

    expect(hit).toEqual({ status: 'ok', value: { commentId: '2', issueId: '5', body: `second ${stableReference('result-1')}` } })
    expect(miss).toEqual({ status: 'ok', value: undefined })
  })

  it('reports a read transport failure as UNAVAILABLE', async () => {
    const server = await startServer((_request, response) => {
      response.destroy()
    })

    const result = await sync(server).readState({ issueId: '1' })

    expectFailed(result, 'UNAVAILABLE')
  })

  it('rejects an invalid construction instead of reaching the network', () => {
    expect(() => createVikunjaSync({ baseUrl: 'ftp://host', token: 't' })).toThrowError(VikunjaSyncError)
    expect(() => createVikunjaSync({ baseUrl: 'https://host', token: '' })).toThrowError(VikunjaSyncError)
    expect(() => createVikunjaSync({ baseUrl: 'https://user:pw@host', token: 't' })).toThrowError(VikunjaSyncError)
  })
})
