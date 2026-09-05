import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createConsoleHost, projectConsoleHost } from '../src/index.ts'

describe('Teams standalone Console Host', () => {
  it('projects OpenCode sessions through the host boundary', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(request.url === '/permission'
        ? JSON.stringify([])
        : JSON.stringify([{ id: 'ses_host', title: 'Host session', directory: '/workspace' }]))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => { resolve() }))
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('upstream address missing')
    const projection = await projectConsoleHost({
      agents: [{ agentId: 'opencode-local', machineId: 'local', label: 'OpenCode', openCodeUrl: `http://127.0.0.1:${address.port}` }],
      staticRoot: '.',
    })
    expect(projection.sessions).toEqual([{ id: 'ses_host', title: 'Host session', directory: '/workspace', running: false, agentId: 'opencode-local' }])
    expect(projection.agents).toEqual([{ agentId: 'opencode-local', machineId: 'local', label: 'OpenCode', sessionIds: ['ses_host'], currentSessionId: 'ses_host' }])
    await new Promise<void>(resolve => upstream.close(() => { resolve() }))
  })

  it('serves health and projection routes', async () => {
    const server = createConsoleHost({
      agents: [{ agentId: 'opencode-local', machineId: 'local', label: 'OpenCode', openCodeUrl: 'http://127.0.0.1:1' }],
      staticRoot: '.',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('host address missing')
    const response = await fetch(`http://127.0.0.1:${address.port}/health`)
    expect(await response.json()).toEqual({ ok: true })
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })
})
