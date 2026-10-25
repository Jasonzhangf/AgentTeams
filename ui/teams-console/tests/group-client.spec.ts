import { describe, expect, it } from 'vitest'
import { createGroupRequestClient, GROUP_ENDPOINT_NOT_CONFIGURED, GROUP_ENDPOINT_UNREACHABLE } from '../src/client/group-client.ts'

function okJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const groupListFrame = { kind: 'group.list', requestId: 'r1' } as const

describe('group request client', () => {
  it('posts the envelope to /api/v1/group-request with only the agentId query', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return okJson({ ok: true, reply: { kind: 'group.list', requestId: 'r1', groups: [] } })
    }) as typeof fetch
    const client = createGroupRequestClient({ fetchImpl })
    const outcome = await client.requestGroup('agent-a', { ...groupListFrame })
    expect(outcome).toEqual({ kind: 'reply', reply: { kind: 'group.list', requestId: 'r1', groups: [] } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/v1/group-request?agentId=agent-a')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ requestId: 'r1', frame: { kind: 'group.list', requestId: 'r1' } })
  })

  it('maps 503 to the not-configured access state without collapsing to a refusal', async () => {
    const fetchImpl = (async () => okJson({ code: GROUP_ENDPOINT_NOT_CONFIGURED, message: 'owner missing' }, 503)) as typeof fetch
    const client = createGroupRequestClient({ fetchImpl })
    const outcome = await client.requestGroup('agent-a', { ...groupListFrame })
    expect(outcome).toEqual({ kind: 'access', access: { kind: 'not-configured', message: 'owner missing' } })
  })

  it('maps 502 GROUP_ENDPOINT_UNREACHABLE to unreachable', async () => {
    const fetchImpl = (async () => okJson({ code: GROUP_ENDPOINT_UNREACHABLE, message: 'socket refused' }, 502)) as typeof fetch
    const client = createGroupRequestClient({ fetchImpl })
    const outcome = await client.requestGroup('agent-a', { ...groupListFrame })
    expect(outcome).toEqual({ kind: 'access', access: { kind: 'unreachable', message: 'socket refused' } })
  })

  it('keeps an in-group refusal code verbatim', async () => {
    const fetchImpl = (async () => okJson({ ok: false, error: { code: 'FORBIDDEN', message: 'not declared' } })) as typeof fetch
    const client = createGroupRequestClient({ fetchImpl })
    const outcome = await client.requestGroup('agent-a', { ...groupListFrame })
    expect(outcome).toEqual({ kind: 'refused', code: 'FORBIDDEN', message: 'not declared' })
  })

  it('reports a 502 with an unknown code as a typed refusal, never success', async () => {
    const fetchImpl = (async () => okJson({ code: 'UPSTREAM_ERROR', message: 'bad owner code' }, 502)) as typeof fetch
    const client = createGroupRequestClient({ fetchImpl })
    const outcome = await client.requestGroup('agent-a', { ...groupListFrame })
    expect(outcome).toEqual({ kind: 'refused', code: 'UPSTREAM_ERROR', message: 'bad owner code' })
  })

  it('rejects a malformed local frame before it leaves the UI', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return okJson({}) }) as typeof fetch
    const client = createGroupRequestClient({ fetchImpl })
    const outcome = await client.requestGroup('agent-a', { kind: 'group.list', requestId: 'r1', unexpected: 1 } as never)
    expect(outcome).toMatchObject({ kind: 'refused', code: 'INVALID_INPUT' })
    expect(called).toBe(false)
  })
})
