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
    expect(projection.agents).toEqual([{ agentId: 'opencode-local', machineId: 'local', label: 'OpenCode', sessionIds: ['ses_host'] }])
    await new Promise<void>(resolve => upstream.close(() => { resolve() }))
  })

  it('uses only the owning host selection, independent of list ordering', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(request.url === '/permission' ? [] : [{ id: 'first' }, { id: 'selected' }]))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('missing address')
    const options = {
      agents: [{ agentId: 'agent', machineId: 'local', label: 'Agent', openCodeUrl: `http://127.0.0.1:${address.port}` }],
      staticRoot: '.',
    }
    try {
      const projection = await projectConsoleHost({ ...options, readCurrentSession: async agentId => {
        expect(agentId).toBe('agent')
        return 'selected'
      } })
      expect(projection.agents[0].currentSessionId).toBe('selected')
      expect((await projectConsoleHost({ ...options, readCurrentSession: async () => undefined })).agents[0].currentSessionId).toBeUndefined()
      await expect(projectConsoleHost({ ...options, readCurrentSession: async () => 'missing' })).rejects.toThrow(/selected session.*missing/)
      await expect(projectConsoleHost({ ...options, readCurrentSession: async () => { throw new Error('host unavailable') } })).rejects.toThrow(/host unavailable/)
    } finally {
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
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
