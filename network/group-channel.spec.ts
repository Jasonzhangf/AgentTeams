import { describe, expect, it } from 'vitest'
import type { ServiceError } from '../control-protocol/agent-services.ts'
import type { GroupWireReply, GroupWireRequest } from '../control-protocol/group-wire.ts'
import {
  createGroupChannel,
  type GroupChannelPush,
  type GroupChannelTransport,
} from './group-channel.ts'

interface FakeTransport {
  readonly transport: GroupChannelTransport
  readonly sent: string[]
  deliver(frame: unknown): void
  deliverText(text: string): void
  handlerCount(): number
}

function fakeTransport(): FakeTransport {
  const handlers = new Set<(text: string) => void>()
  const sent: string[] = []
  const deliverText = (text: string): void => {
    for (const handler of [...handlers]) handler(text)
  }
  return {
    transport: {
      send: text => { sent.push(text) },
      onMessage: handler => {
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      },
    },
    sent,
    deliver: frame => {
      const text = JSON.stringify(frame)
      if (text === undefined) throw new Error('fake transport cannot serialize the frame')
      deliverText(text)
    },
    deliverText,
    handlerCount: () => handlers.size,
  }
}

function listRequest(requestId: string): GroupWireRequest {
  return { kind: 'group.list', requestId }
}

function sentText(fake: FakeTransport, index: number): Record<string, unknown> {
  const text = fake.sent[index]
  if (text === undefined) throw new Error(`no outbound frame at index ${index}`)
  return JSON.parse(text) as Record<string, unknown>
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

describe('group channel request correlation', () => {
  it('sends one frame through the injected transport and resolves the matching requestId', async () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 1_000, maxPendingRequests: 4 })
    const pending = channel.request(listRequest('r1'))

    expect(fake.sent).toHaveLength(1)
    expect(sentText(fake, 0)).toEqual({ kind: 'group.list', requestId: 'r1' })

    fake.deliver({ kind: 'group.list', requestId: 'r1', groups: [] })
    await expect(pending).resolves.toMatchObject({ kind: 'group.list', requestId: 'r1' })
    expect(channel.status()).toMatchObject({ state: 'open', pending: 0 })

    channel.close()
    expect(fake.handlerCount()).toBe(0)
  })

  it('keeps concurrent requests independent when replies arrive out of order', async () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 1_000, maxPendingRequests: 4 })
    const list = channel.request(listRequest('r-list'))
    const send = channel.request({
      kind: 'message.send', requestId: 'r-send', commitId: 'c1', groupId: 'g1',
      targetAgentIds: ['agent-b'], replyRequired: false, body: 'hello',
    })

    fake.deliver({ kind: 'message.sent', requestId: 'r-send', messageId: 'm1', sequence: 7 })
    fake.deliver({ kind: 'group.list', requestId: 'r-list', groups: [] })

    await expect(send).resolves.toMatchObject({ kind: 'message.sent', requestId: 'r-send', sequence: 7 })
    await expect(list).resolves.toMatchObject({ kind: 'group.list', requestId: 'r-list' })
    expect(channel.status().pending).toBe(0)
  })

  it('rejects a duplicate requestId and bounds the pending table', async () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 1_000, maxPendingRequests: 1 })
    const first = channel.request(listRequest('r1'))

    await expect(channel.request(listRequest('r1'))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(channel.request(listRequest('r2'))).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })

    fake.deliver({ kind: 'group.list', requestId: 'r1', groups: [] })
    await expect(first).resolves.toMatchObject({ kind: 'group.list', requestId: 'r1' })
  })
})

describe('group channel failure paths', () => {
  it('fails a timed-out request explicitly, frees its slot and leaves the channel open', async () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 20, maxPendingRequests: 2 })
    const timedOut = channel.request(listRequest('r-timeout'))

    await expect(timedOut).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
      serviceError: { code: 'RESULT_UNKNOWN' },
    })
    expect(channel.status()).toMatchObject({ state: 'open', pending: 0 })

    const next = channel.request(listRequest('r-next'))
    fake.deliver({ kind: 'group.list', requestId: 'r-next', groups: [] })
    await expect(next).resolves.toMatchObject({ kind: 'group.list', requestId: 'r-next' })
    channel.close()
  })

  it('fails every waiting request on disconnect and refuses new writes until reconnected', async () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 1_000, maxPendingRequests: 4 })
    const pending = channel.request(listRequest('r1'))

    channel.disconnect({ code: 'UNAVAILABLE', message: 'registration connection lost' })
    await expect(pending).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'registration connection lost',
      serviceError: { code: 'UNAVAILABLE', message: 'registration connection lost' },
    })
    await expect(channel.request(listRequest('r2'))).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(fake.sent).toHaveLength(1)
    expect(channel.status()).toMatchObject({ state: 'disconnected', pending: 0 })

    await channel.reconnected()
    const recovered = channel.request(listRequest('r3'))
    fake.deliver({ kind: 'group.list', requestId: 'r3', groups: [] })
    await expect(recovered).resolves.toMatchObject({ kind: 'group.list', requestId: 'r3' })
    channel.close()
  })

  it('rejects the matching waiter with the relay ServiceError instead of resolving a success', async () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 1_000, maxPendingRequests: 4 })
    const pending = channel.request({ kind: 'group.leave', requestId: 'r-error', groupId: 'g1' })

    fake.deliver({
      kind: 'relay.error', requestId: 'r-error',
      error: { code: 'FORBIDDEN', message: 'only an admin may remove a member' },
    })

    await expect(pending).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'only an admin may remove a member',
      serviceError: { code: 'FORBIDDEN', message: 'only an admin may remove a member' },
    })
    expect(channel.status().pending).toBe(0)
    channel.close()
  })

  it('isolates malformed and uncorrelated relay errors without closing the shared channel', async () => {
    const fake = fakeTransport()
    const errors: ServiceError[] = []
    const channel = createGroupChannel({
      transport: fake.transport,
      timeoutMs: 1_000,
      maxPendingRequests: 4,
      onError: error => errors.push(error),
    })
    const pending = channel.request(listRequest('r1'))

    fake.deliverText('not a group frame')
    fake.deliver({ kind: 'relay.error', error: { code: 'UNAVAILABLE', message: 'push write failed' } })

    expect(errors.map(error => error.code)).toEqual(['INVALID_INPUT', 'UNAVAILABLE'])
    expect(channel.status().state).toBe('open')

    fake.deliver({ kind: 'group.list', requestId: 'r1', groups: [] })
    await expect(pending).resolves.toMatchObject({ kind: 'group.list', requestId: 'r1' })
    channel.close()
  })
})

describe('group channel pushes and reconnect', () => {
  it('delivers pushes only to current subscribers', () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 1_000, maxPendingRequests: 4 })
    const pushes: GroupChannelPush[] = []
    const detach = channel.subscribe(push => pushes.push(push))

    fake.deliver({
      kind: 'message.received', groupId: 'g1',
      message: {
        messageId: 'm1', commitId: 'c1', sequence: 3, groupId: 'g1', fromAgentId: 'agent-a',
        targetAgentIds: ['agent-b'], replyRequired: true, body: 'review this',
        sentAt: '2026-10-22T00:00:00.000Z',
      },
    })
    expect(pushes).toEqual([expect.objectContaining({ kind: 'message.received', groupId: 'g1' })])

    detach()
    fake.deliver({ kind: 'action.changed', action: {
      actionId: 'a1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-a',
      assigneeAgentId: 'agent-b', kind: 'review', reason: 'check', expectedResult: 'verdict',
      replyRequired: false, state: 'in_progress', createdAt: '2026-10-22T00:00:00.000Z',
    } })
    expect(pushes).toHaveLength(1)
    channel.close()
  })

  it('runs resubscribe once per reconnect and lets it issue requests through the same channel', async () => {
    const fake = fakeTransport()
    const calls: string[] = []
    const channel = createGroupChannel({
      transport: fake.transport,
      timeoutMs: 1_000,
      maxPendingRequests: 4,
      resubscribe: async request => {
        calls.push('resubscribe')
        const reply = await request({ kind: 'message.page', requestId: 'r-resubscribe', groupId: 'g1' })
        calls.push(reply.kind)
      },
    })

    await channel.reconnected()
    expect(calls).toEqual([])

    channel.disconnect()
    const restoring = channel.reconnected()
    await waitFor(() => fake.sent.some(text => text.includes('r-resubscribe')))
    expect(calls).toEqual(['resubscribe'])

    fake.deliver({ kind: 'message.page', requestId: 'r-resubscribe', messages: [], revision: 1, hasMore: false })
    await restoring
    expect(calls).toEqual(['resubscribe', 'message.page'])

    await channel.reconnected()
    expect(calls).toEqual(['resubscribe', 'message.page'])
    channel.close()
  })

  it('fails pending work and detaches the transport when closed', async () => {
    const fake = fakeTransport()
    const channel = createGroupChannel({ transport: fake.transport, timeoutMs: 1_000, maxPendingRequests: 4 })
    const pending = channel.request(listRequest('r1'))

    channel.close()
    await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(channel.request(listRequest('r2'))).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(channel.status()).toMatchObject({ state: 'closed', pending: 0 })
    expect(fake.handlerCount()).toBe(0)
  })
})
