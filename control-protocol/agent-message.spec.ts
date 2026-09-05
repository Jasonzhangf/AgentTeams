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

  it('rejects control fields inside Agent message payload', () => {
    expect(() =>
      validateAgentMessage({
        kind: 'notify',
        correlationId: 'corr-2',
        payload: { text: 'hi', targetGeneration: 4 },
      }),
    ).toThrow(/forbidden control field/)
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
