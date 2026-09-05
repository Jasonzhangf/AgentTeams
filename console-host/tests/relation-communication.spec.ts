import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createConsoleHost } from '../src/index.ts'

interface TestServer {
  readonly port: number
  readonly close: () => Promise<void>
  readonly calls: readonly string[]
}

function testUpstream(sessions: readonly Record<string, unknown>[]): Promise<TestServer> {
  const calls: string[] = []
  return new Promise(resolveServer => {
    const server = createServer((request, response) => {
      calls.push(request.url ?? '/')
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url === '/session' || request.url === '/session/') {
        response.end(JSON.stringify(sessions))
        return
      }
      if (request.url === '/permission') {
        response.end(JSON.stringify([]))
        return
      }
      response.end(JSON.stringify({ ok: true }))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('upstream address missing')
      resolveServer({
        port: address.port,
        close: () => new Promise<void>(done => server.close(() => { done() })),
        calls,
      })
    })
  })
}

describe('Teams Console Host relation and agent message relay', () => {
  it('stores relation reports and relays an agent message through the master host', async () => {
    const alpha = await testUpstream([{ id: 'ses_alpha', title: 'Alpha session' }])
    const beta = await testUpstream([{ id: 'ses_beta', title: 'Beta session' }])
    const console = createConsoleHost({
      agents: [
        { agentId: 'agent-alpha', machineId: 'machine-alpha', label: 'Alpha', openCodeUrl: `http://127.0.0.1:${alpha.port}` },
        { agentId: 'agent-beta', machineId: 'machine-beta', label: 'Beta', openCodeUrl: `http://127.0.0.1:${beta.port}` },
      ],
      staticRoot: '.',
    })
    await new Promise<void>(resolve => console.listen(0, '127.0.0.1', () => { resolve() }))
    const address = console.address()
    if (address === null || typeof address === 'string') throw new Error('console address missing')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const consumer = await postJson(`${base}/api/relation`, {
        relationId: 'rel-1',
        reporterAgentId: 'agent-alpha',
        subjectAgentId: 'agent-beta',
        capabilityId: 'review',
        role: 'consumer',
        state: 'requested',
        reportRevision: 1,
        reportedAt: '2026-09-04T01:00:00Z',
      })
      expect(consumer).toMatchObject({ consistency: 'consumer-only' })

      const provider = await postJson(`${base}/api/relation`, {
        relationId: 'rel-1',
        reporterAgentId: 'agent-beta',
        subjectAgentId: 'agent-alpha',
        capabilityId: 'review',
        role: 'provider',
        state: 'allowed',
        reportRevision: 1,
        reportedAt: '2026-09-04T01:01:00Z',
      })
      expect(provider).toMatchObject({ consistency: 'matched', consumerAgentId: 'agent-alpha', providerAgentId: 'agent-beta' })

      const relayed = await postJson(`${base}/api/agent-message`, {
        messageId: 'msg-1',
        relationId: 'rel-1',
        fromAgentId: 'agent-alpha',
        toAgentId: 'agent-beta',
        message: {
          kind: 'notify',
          correlationId: 'corr-1',
          payload: { text: 'hello beta' },
        },
      })
      expect(relayed).toMatchObject({ toAgentId: 'agent-beta', kind: 'notify' })

      const projection = await (await fetch(`${base}/api/projection`)).json() as { relations: Array<{ consistency: string }>; messages: readonly unknown[] }
      expect(projection.relations[0].consistency).toBe('matched')
      expect(projection.messages).toHaveLength(1)
      expect(beta.calls.some(call => call.includes('/prompt_async') || call.includes('/session/ses_beta'))).toBe(true)
    } finally {
      await new Promise<void>(resolve => console.close(() => { resolve() }))
      await alpha.close()
      await beta.close()
    }
  })
})

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(String(result.error ?? 'request failed'))
  return result
}
