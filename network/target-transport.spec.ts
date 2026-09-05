import { describe, expect, it } from 'vitest'
import {
  beginTargetTransport,
  closeTargetTransport,
  confirmTargetHealth,
  failTargetTransport,
  receiveHelloAck,
} from './target-transport.ts'

const hello = {
  hostId: 'host-a',
  agentId: 'agent-a',
  targetGeneration: 7,
  protocolVersion: 1,
  capabilitiesRevision: 'cap-1',
}

describe('Teams target transport lifecycle', () => {
  it('transitions connecting -> ready after hello ack and keeps the same generation', () => {
    const connecting = beginTargetTransport(hello)
    const ready = receiveHelloAck(connecting)
    expect(ready.state).toBe('ready')
    expect(confirmTargetHealth(ready, hello.targetGeneration).state).toBe('ready')
  })

  it('rejects stale generation health checks', () => {
    const ready = receiveHelloAck(beginTargetTransport(hello))
    expect(() => confirmTargetHealth(ready, hello.targetGeneration + 1)).toThrow(/STALE_GENERATION/)
  })

  it('closes and fails explicitly without silent state reuse', () => {
    const closed = closeTargetTransport(receiveHelloAck(beginTargetTransport(hello)), 'user quit')
    expect(closed.state).toBe('closed')
    expect(closed.error).toBe('user quit')
    const failed = failTargetTransport(beginTargetTransport(hello), 'hello timeout')
    expect(failed.state).toBe('failed')
    expect(() => failTargetTransport(failed, 'again')).toThrow(/cannot fail failed/)
  })
})
