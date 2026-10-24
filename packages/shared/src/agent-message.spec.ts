import { describe, expect, it } from 'vitest'
import { buildAgentPairChannelId, validateAgentMessage, validateAgentPairChannelRef } from './agent-message.ts'

describe('control-protocol Agent-to-Agent message schema', () => {
  it('validates business payload without control/routing fields', () => {
    expect(
      validateAgentMessage({
        kind: 'request.capability',
        correlationId: 'corr-1',
        payload: { capability: 'review' },
      }),
    ).toEqual({
      kind: 'request.capability',
      correlationId: 'corr-1',
      payload: { capability: 'review' },
    })
  })

  it('preserves JSON arrays and business fields with control-like names', () => {
    const payload = { results: [{ config: { token: 'example', route: ['a', null, 3] } }], targetGeneration: 4 }
    expect(validateAgentMessage({ kind: 'notify', correlationId: 'corr-2', payload }).payload).toEqual(payload)
  })

  it('rejects misplaced control fields on the message envelope', () => {
    expect(() =>
      validateAgentMessage({
        kind: 'notify',
        correlationId: 'corr-2',
        targetGeneration: 4,
        payload: { text: 'hi' },
      }),
    ).toThrow(/targetGeneration/)
  })

  it.each([undefined, NaN, Infinity, 1n, () => 1, new Date(), new Map(), Symbol('x')])('rejects non-JSON payload entries: %s', (entry) => {
    expect(() => validateAgentMessage({ kind: 'notify', correlationId: 'c', payload: { entry } })).toThrow(/JSON/)
  })

  it('rejects cyclic payloads without rejecting shared JSON objects', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateAgentMessage({ kind: 'notify', correlationId: 'c', payload: cyclic })).toThrow(/JSON/)
    const shared = { text: 'same' }
    expect(validateAgentMessage({ kind: 'notify', correlationId: 'c', payload: { a: shared, b: shared } }).payload).toEqual({ a: shared, b: shared })
  })

  it('rejects properties JSON serialization would silently drop or execute', () => {
    const sparse = new Array(2)
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => { throw new Error('must not execute') } })
    const hidden = Object.defineProperty({}, 'x', { value: 1 })
    const symbol = { [Symbol('x')]: 1 }
    const extra = Object.assign([1], { extra: 2 })
    for (const payload of [{ sparse }, getter, hidden, symbol, { extra }]) {
      expect(() => validateAgentMessage({ kind: 'notify', correlationId: 'c', payload })).toThrow(/JSON/)
    }
  })

  it('validates pair channel ref and derives stable channel ids', () => {
    const ref = validateAgentPairChannelRef({
      channelId: 'agent-alpha:agent-beta:agent-pair',
      relationId: 'rel-1',
      fromAgentId: 'agent-alpha',
      toAgentId: 'agent-beta',
      targetGeneration: 3,
    })
    expect(ref.targetGeneration).toBe(3)
    expect(buildAgentPairChannelId('agent-alpha', 'agent-beta')).toBe(buildAgentPairChannelId('agent-beta', 'agent-alpha'))
    expect(() => buildAgentPairChannelId('agent-alpha', 'agent-alpha')).toThrow(/self/)
  })
})
