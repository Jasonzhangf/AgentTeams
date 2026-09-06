import { describe, expect, it } from 'vitest'
import { createConsoleHttpClient, ConsoleTransportError } from '../src/client/api.ts'
import type { ConsoleProjectionV1 } from '../src/client/protocol.ts'

const projection: ConsoleProjectionV1 = {
  version: 1,
  agents: [],
  sessions: [],
  notifications: [],
  configs: [],
}

describe('Console HTTP v1 adapter', () => {
  it('reads the versioned projection endpoint', async () => {
    const requests: string[] = []
    const client = createConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      fetchImpl: async (input) => {
        requests.push(String(input))
        return new Response(JSON.stringify(projection), { status: 200 })
      },
    })

    await expect(client.readProjection()).resolves.toEqual(projection)
    expect(requests).toEqual(['http://localhost:7788/api/v1/projection'])
  })

  it('posts only a control command to the command endpoint', async () => {
    let body = ''
    let url = ''
    const client = createConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      fetchImpl: async (input, init) => {
        url = String(input)
        body = String(init?.body)
        return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), { status: 200 })
      },
    })

    await expect(client.command({ kind: 'session.open', agentId: 'planner', sessionId: 's1' })).resolves.toMatchObject({ ok: true })
    expect(url).toBe('http://localhost:7788/api/v1/command')
    expect(JSON.parse(body)).toEqual({ kind: 'session.open', agentId: 'planner', sessionId: 's1' })
  })

  it('sends Session business payload unchanged through the dedicated ingress', async () => {
    let url = ''
    let body = ''
    const client = createConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      fetchImpl: async (input, init) => {
        url = String(input)
        body = String(init?.body)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })
    const payload = { text: 'hello', nested: { value: 3 } } as const

    await expect(client.sendSession({ agentId: 'planner', sessionId: 's1' }, payload)).resolves.toMatchObject({ ok: true })
    expect(url).toBe('http://localhost:7788/api/v1/session-message?agentId=planner&sessionId=s1')
    expect(JSON.parse(body)).toEqual(payload)
    expect(JSON.parse(body)).not.toHaveProperty('agentId')
    expect(JSON.parse(body)).not.toHaveProperty('sessionId')
  })

  it('fails explicitly on transport, JSON, and result-shape errors', async () => {
    const statusClient = createConsoleHttpClient({ fetchImpl: async () => new Response('denied', { status: 403 }) })
    await expect(statusClient.readProjection()).rejects.toMatchObject({ name: 'ConsoleTransportError', status: 403 })

    const jsonClient = createConsoleHttpClient({ fetchImpl: async () => new Response('{bad', { status: 200 }) })
    await expect(jsonClient.readProjection()).rejects.toBeInstanceOf(ConsoleTransportError)

    const resultClient = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify({ ok: 'yes' }), { status: 200 }) })
    await expect(resultClient.command({ kind: 'config.apply', agentId: 'planner' })).rejects.toThrow(/invalid v1 command result/)
  })

  it('supports host-specific versioned paths without changing the client contract', async () => {
    const requests: string[] = []
    const client = createConsoleHttpClient({
      baseUrl: 'https://host.invalid/console/',
      projectionPath: 'v1/state',
      commandPath: 'v1/control',
      sessionMessagePath: 'v1/data',
      fetchImpl: async input => {
        requests.push(String(input))
        return new Response(JSON.stringify(projection), { status: 200 })
      },
    })
    await client.readProjection()
    expect(requests[0]).toBe('https://host.invalid/console/v1/state')
  })

  it('reports network failures as transport errors', async () => {
    const client = createConsoleHttpClient({ fetchImpl: async () => { throw new Error('offline') } })
    await expect(client.readProjection()).rejects.toThrow('Host request failed: offline')
  })

  it('preserves a host-declared command failure instead of rewriting it', async () => {
    const client = createConsoleHttpClient({
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'not admitted' } }), { status: 200 }),
    })
    await expect(client.command({ kind: 'config.apply', agentId: 'planner' })).resolves.toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'not admitted' } })
  })
})
