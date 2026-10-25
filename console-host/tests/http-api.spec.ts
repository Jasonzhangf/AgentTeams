import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsoleApiHandler, type ConsoleApiOptions } from '../src/http-api.ts'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })
async function start(authorized = true, extra: Omit<ConsoleApiOptions, 'authorize' | 'maxBodyBytes'> = {}) {
  const client = {
    readProjection: vi.fn(async () => ({ version: 1 as const, agents: [], sessions: [], notifications: [], configs: [] })),
    command: vi.fn(async () => ({ ok: false as const, error: { code: 'FORBIDDEN' as const, message: 'Agent denied' } })),
    sendSession: vi.fn(async () => ({ ok: true as const })),
  }
  const server = createServer(createConsoleApiHandler({ authorize: async () => authorized ? client : undefined, maxBodyBytes: 512, ...extra }))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { client, url: `http://127.0.0.1:${address.port}` }
}
it('authenticates reads and mutations before dispatch', async () => {
  const { url, client } = await start(false)
  expect((await fetch(`${url}/api/v1/projection`)).status).toBe(401)
  expect((await fetch(`${url}/api/v1/command`, { method: 'POST', body: '{}' })).status).toBe(401)
  expect(client.readProjection).not.toHaveBeenCalled()
  expect(client.command).not.toHaveBeenCalled()
})
it('preserves daemon denial and keeps Session JSON out of commands', async () => {
  const { url, client } = await start()
  const command = { kind: 'config.apply', agentId: 'a' }
  const result = await fetch(`${url}/api/v1/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  expect(await result.json()).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Agent denied' } })
  const payload = [{ metadata: { provider: 'ordinary business text' }, kind: 'config.apply' }]
  const sent = await fetch(`${url}/api/v1/session-message?agentId=a&sessionId=s`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  expect(sent.status).toBe(200)
  expect(client.sendSession).toHaveBeenCalledWith({ agentId: 'a', sessionId: 's' }, payload)
  expect(client.command).toHaveBeenCalledExactlyOnceWith(command)
})
it('rejects invalid controls, duplicate targets, oversized bodies and wrong methods', async () => {
  const { url, client } = await start()
  const post = (path: string, body: string) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  expect((await post('/api/v1/command', '{')).status).toBe(400)
  expect((await post('/api/v1/command', JSON.stringify({ kind: 'config.apply', agentId: 'a', payload: {} }))).status).toBe(400)
  expect((await post('/api/v1/session-message?agentId=a&agentId=b&sessionId=s', 'null')).status).toBe(400)
  expect((await post('/api/v1/command', JSON.stringify('x'.repeat(600)))).status).toBe(413)
  expect((await fetch(url + '/api/v1/command')).status).toBe(405)
  expect(client.command).not.toHaveBeenCalled()
  expect(client.sendSession).not.toHaveBeenCalled()
})
it('does not retry or fabricate a result when the owner fails after dispatch', async () => {
  const { url, client } = await start()
  client.command.mockRejectedValueOnce(new Error('private upstream detail'))
  const response = await fetch(url + '/api/v1/command', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'config.apply', agentId: 'a' }),
  })
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ message: 'Console owner request failed; outcome not inferred' })
  expect(client.command).toHaveBeenCalledTimes(1)
})

it('relaxes query-parameter rejection only for the closed history route', async () => {
  const queries: unknown[] = []
  const { url } = await start(true, {
    history: { query: async query => { queries.push(query); return { records: [], nextBeforeSequence: 2 } } },
  })
  const page = await fetch(`${url}/api/v1/history?version=1&kind=request&agentId=a&sessionId=s&limit=5&beforeSequence=9`)
  expect(page.status).toBe(200)
  expect(await page.json()).toEqual({ records: [], nextBeforeSequence: 2 })
  expect(queries).toEqual([{ version: 1, kind: 'request', agentId: 'a', sessionId: 's', limit: 5, beforeSequence: 9 }])
  // The frozen parser owns the closed refusal; the transport never widens it.
  for (const path of [
    '/api/v1/history?version=1&limit=5&agentId=a&agentId=b',
    '/api/v1/history?version=1&limit=5&kind=work',
    '/api/v1/history?version=2&limit=5',
    '/api/v1/history?version=1&limit=0',
    '/api/v1/history?version=1&limit=501',
    '/api/v1/history?version=1&limit=5&beforeSequence=0',
    '/api/v1/history?version=1&limit=5&unknown=1',
    '/api/v1/history?limit=5',
    '/api/v1/history?version=1',
  ]) expect((await fetch(url + path)).status, path).toBe(400)
  // Every other route keeps the exact previous blanket rejection.
  expect((await fetch(`${url}/api/v1/projection?agentId=a`)).status).toBe(400)
  expect((await fetch(`${url}/api/v1/events?agentId=a`)).status).toBe(400)
  expect((await fetch(`${url}/api/v1/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405)
  expect(queries).toHaveLength(1)
})

it('reports a typed owner absence for history and events instead of fabricating them', async () => {
  const { url } = await start()
  const history = await fetch(`${url}/api/v1/history?version=1&limit=5`)
  expect(history.status).toBe(503)
  expect(await history.json()).toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
  const events = await fetch(`${url}/api/v1/events`)
  expect(events.status).toBe(503)
  expect(await events.json()).toMatchObject({ code: 'STREAM_UNAVAILABLE' })
})

it('streams real SSE projection snapshots and closes the stream on owner loss', async () => {
  let unsubscribe = 0
  const { url } = await start(true, {
    events: sink => {
      sink.onHealth({ state: 'live' })
      sink.onSnapshot({ seq: 1, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } })
      sink.onSnapshot({ seq: 2, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } })
      sink.onHealth({ state: 'lost', reason: 'stream-ended', detail: 'owner projection ended' })
      return () => { unsubscribe += 1 }
    },
  })
  const response = await fetch(`${url}/api/v1/events`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.text()
  const frames = body.split('\n\n').filter(Boolean)
  expect(frames).toHaveLength(4)
  expect(frames[0]).toBe('event: health\ndata: {"state":"live"}')
  // The event NAME is part of the stream contract: the UI live client subscribes by name, and a
  // named SSE event that no listener matches is dropped silently. Pin the name here so the
  // server can never drift from ui/teams-console/src/client/live-client.ts and ui/teams-console/src/state/observation.ts.
  expect(frames[1].startsWith('event: snapshot\n')).toBe(true)
  expect(frames[2].startsWith('event: snapshot\n')).toBe(true)
  expect(frames[3].startsWith('event: health\n')).toBe(true)
  expect(JSON.parse(frames[1].split('data: ')[1]!)).toEqual({ seq: 1, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } })
  expect(JSON.parse(frames[2].split('data: ')[1]!)).toMatchObject({ seq: 2 })
  expect(JSON.parse(frames[3].split('data: ')[1]!)).toEqual({ state: 'lost', reason: 'stream-ended', detail: 'owner projection ended' })
  expect(unsubscribe).toBe(1)
})

it('forwards one closed group frame to the authenticated agent group owner and preserves its reply', async () => {
  const forwarded: unknown[] = []
  const { url } = await start(true, {
    group: {
      forward: async input => {
        forwarded.push(input)
        return { outcome: 'reply', reply: { kind: 'group.list', requestId: 'r1', groups: [] } }
      },
    },
  })
  const response = await fetch(`${url}/api/v1/group-request?agentId=agent-a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, reply: { kind: 'group.list', requestId: 'r1', groups: [] } })
  // The frame reaches the group owner verbatim: the transport adds no field and drops none.
  expect(forwarded).toEqual([{ agentId: 'agent-a', request: { kind: 'group.list', requestId: 'r1' } }])
})

it('keeps the group owner own code and message verbatim for every typed refusal', async () => {
  for (const error of [
    { code: 'FORBIDDEN' as const, message: 'agent is not a group member' },
    { code: 'UNAVAILABLE' as const, message: 'group hub is not connected' },
    { code: 'UPSTREAM_ERROR' as const, message: 'upstream refused the write' },
    { code: 'RESULT_UNKNOWN' as const, message: 'the write may have been applied; do not replay' },
  ]) {
    const { url } = await start(true, { group: { forward: async () => ({ outcome: 'owner-error', error }) } })
    const response = await fetch(`${url}/api/v1/group-request?agentId=agent-a`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error })
  }
})

it('reports a missing group endpoint as typed not-configured and an unanswered one as unreachable', async () => {
  const missing = await start(true, {
    group: { forward: async () => ({ outcome: 'not-configured', message: 'agent agent-a has published no local group endpoint' }) },
  })
  const configured = await fetch(`${missing.url}/api/v1/group-request?agentId=agent-a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })
  expect(configured.status).toBe(503)
  expect(await configured.json()).toEqual({ code: 'GROUP_ENDPOINT_NOT_CONFIGURED', message: 'agent agent-a has published no local group endpoint' })

  const unreachable = await start(true, {
    group: { forward: async () => ({ outcome: 'unreachable', error: { code: 'GROUP_ENDPOINT_UNREACHABLE', message: 'connect ECONNREFUSED' } }) },
  })
  const refused = await fetch(`${unreachable.url}/api/v1/group-request?agentId=agent-a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })
  expect(refused.status).toBe(502)
  expect(await refused.json()).toEqual({ code: 'GROUP_ENDPOINT_UNREACHABLE', message: 'connect ECONNREFUSED' })

  // A timeout keeps its own do-not-replay code instead of being flattened into unreachable.
  const timedOut = await start(true, {
    group: { forward: async () => ({ outcome: 'unreachable', error: { code: 'RESULT_UNKNOWN', message: 'request timed out' } }) },
  })
  const unknown = await fetch(`${timedOut.url}/api/v1/group-request?agentId=agent-a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })
  expect(unknown.status).toBe(502)
  expect(await unknown.json()).toEqual({ code: 'RESULT_UNKNOWN', message: 'request timed out' })
})

it('refuses an undeclared agent, an unwritable envelope and an unknown code as bad input', async () => {
  const forwarded: unknown[] = []
  const { url } = await start(true, {
    group: {
      forward: async input => {
        forwarded.push(input)
        return { outcome: 'invalid-target', message: 'agentId agent-z is not declared by this control daemon\'s accepted peers' }
      },
    },
  })
  const undeclared = await fetch(`${url}/api/v1/group-request?agentId=agent-z`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })
  expect(undeclared.status).toBe(400)
  expect(await undeclared.json()).toEqual({ code: 'INVALID_INPUT', message: 'agentId agent-z is not declared by this control daemon\'s accepted peers' })
  expect(forwarded).toHaveLength(1)

  const post = (path: string, body: string): Promise<Response> => fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  const envelope = (value: unknown): string => JSON.stringify(value)
  // Exactly one agentId query, exactly the two body keys, and one frame request id.
  for (const path of ['/api/v1/group-request', '/api/v1/group-request?agentId=a&agentId=b', '/api/v1/group-request?agentId=a&other=1']) {
    const refused = await post(path, envelope({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }))
    expect(refused.status, path).toBe(400)
    expect(await refused.json()).toMatchObject({ code: 'INVALID_INPUT' })
  }
  for (const body of [
    { requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' }, extra: true },
    { requestId: 'r1', frame: { kind: 'group.list', requestId: 'r2' } },
    { requestId: '', frame: { kind: 'group.list', requestId: '' } },
    { requestId: 'r1', frame: { kind: 'group.unknown', requestId: 'r1' } },
    { requestId: 'r1' },
  ]) {
    const refused = await post('/api/v1/group-request?agentId=a', envelope(body))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ code: 'INVALID_INPUT' })
  }
  expect((await fetch(`${url}/api/v1/group-request?agentId=a`)).status).toBe(405)
})

it('refuses a group error code outside the closed envelope vocabulary', async () => {
  const { url } = await start(true, {
    // A forwarder from another module is not type-checked by this transport, so the closed
    // vocabulary is enforced here too instead of reaching the UI as a new code.
    group: { forward: async () => ({ outcome: 'unreachable', error: { code: 'GROUP_ENDPOINT_MELTED' as never, message: 'unknown' } }) },
  })
  const response = await fetch(`${url}/api/v1/group-request?agentId=agent-a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ code: 'UPSTREAM_ERROR' })
})

it('reports an unbound group owner as typed not-configured and never authenticates late', async () => {
  const unbound = await start()
  const response = await fetch(`${unbound.url}/api/v1/group-request?agentId=agent-a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'GROUP_ENDPOINT_NOT_CONFIGURED' })

  const denied = await start(false, { group: { forward: async () => { throw new Error('must not run') } } })
  expect((await fetch(`${denied.url}/api/v1/group-request?agentId=agent-a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } }),
  })).status).toBe(401)
})
