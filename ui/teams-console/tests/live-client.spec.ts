import { describe, expect, it } from 'vitest'
import { createLiveConsoleHttpClient } from '../src/client/live-client.ts'
import type { ConsoleProjectionSink, HistoryPage } from '../src/client/protocol.ts'

const page: HistoryPage = {
  records: [{
    recordId: 'r1', sequence: 1, occurredAt: '2026-09-07T02:00:00Z', agentId: 'planner',
    kind: 'connection', event: 'ready', outcome: 'completed',
  }],
  nextBeforeSequence: 0,
}

const emptyProjection = { version: 1, agents: [], sessions: [], notifications: [], configs: [] }

/** Minimal EventSource double: the client only needs add/remove/close plus dispatch. */
class FakeEventSource {
  static instance: FakeEventSource | undefined
  readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>()
  closed = false
  constructor(readonly url: string) { FakeEventSource.instance = this }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener))
  }
  close(): void { this.closed = true }
  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent)
  }
}

function liveClient(history?: (url: string) => Response) {
  const requests: string[] = []
  const client = createLiveConsoleHttpClient({
    baseUrl: 'http://localhost:7788',
    eventSourceImpl: FakeEventSource as unknown as new (url: string) => EventSource,
    fetchImpl: async input => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/api/v1/history')) {
        if (history !== undefined) return history(url)
        return new Response(JSON.stringify(page), { status: 200 })
      }
      if (url.includes('/api/v1/projection')) return new Response(JSON.stringify(emptyProjection), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  })
  return { client, requests }
}

describe('live console client additive capability', () => {
  it('reads connection history and pages with beforeSequence', async () => {
    const { client, requests } = liveClient()
    await expect(client.readHistory({ version: 1, kind: 'connection', limit: 20, beforeSequence: 10 })).resolves.toEqual(page)
    expect(requests[0]).toContain('/api/v1/history?')
    expect(requests[0]).toContain('kind=connection')
    expect(requests[0]).toContain('beforeSequence=10')
  })

  it('keeps a request-kind refusal a real typed error, never an empty page', async () => {
    const { client } = liveClient(() => new Response(JSON.stringify({ code: 'INVALID_ACP_FRAME', message: 'owner refuses request history' }), { status: 502 }))
    await expect(client.readHistory({ version: 1, kind: 'request', limit: 20 })).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME', message: '502: owner refuses request history', status: 502 })
  })

  it('keeps the canonical ports on the live client and delivers owner snapshots through the sink', async () => {
    const { client, requests } = liveClient()
    const snapshots: number[] = []
    const health: string[] = []
    const sink: ConsoleProjectionSink = {
      onSnapshot: snapshot => { snapshots.push(snapshot.seq) },
      onHealth: state => { health.push(state.state) },
    }
    const unsubscribe = client.subscribeProjection(sink)
    const source = FakeEventSource.instance
    expect(source?.url).toContain('/api/v1/events')
    source?.emit('snapshot', JSON.stringify({ seq: 1, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } }))
    expect(snapshots).toEqual([1])
    unsubscribe()
    expect(source?.closed).toBe(true)
    expect(health).toEqual([])
    // The live client is additive: the canonical projection/command/session ports must stay
    // reachable on the same object AND still go through the live client's own options. A
    // regression to `{ readHistory, subscribeProjection }` or to a base client built without
    // those options is invisible to api.spec.ts, which exercises the base client alone.
    await expect(client.readProjection()).resolves.toEqual(emptyProjection)
    await expect(client.command({ kind: 'config.apply', agentId: 'planner' })).resolves.toEqual({ ok: true })
    await expect(client.sendSession({ agentId: 'planner', sessionId: 's1' }, { text: 'probe' })).resolves.toEqual({ ok: true })
    expect(requests.map(url => new URL(url).pathname)).toEqual(['/api/v1/projection', '/api/v1/command', '/api/v1/session-message'])
  })

  it('reports observation loss instead of live state for a malformed frame', () => {
    const { client } = liveClient()
    const health: string[] = []
    client.subscribeProjection({
      onSnapshot: () => { throw new Error('a malformed frame must not be projected') },
      onHealth: state => { health.push(state.state) },
    })
    FakeEventSource.instance?.emit('snapshot', '{bad')
    expect(health).toEqual(['degraded'])
  })
})
