import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsoleApiHandler } from '../src/http-api.ts'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })
async function start(authorized = true) {
  const client = {
    readProjection: vi.fn(async () => ({ version: 1 as const, agents: [], sessions: [], notifications: [], configs: [] })),
    command: vi.fn(async () => ({ ok: false as const, error: { code: 'FORBIDDEN' as const, message: 'Agent denied' } })),
    sendSession: vi.fn(async () => ({ ok: true as const })),
  }
  const server = createServer(createConsoleApiHandler({ authorize: async () => authorized ? client : undefined, maxBodyBytes: 512 }))
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
