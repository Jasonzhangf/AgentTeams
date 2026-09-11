import { describe, expect, it } from 'vitest'
import { parseSessionChannelFrame, parseTargetControlFrame } from './frames.ts'

describe('target control frames', () => {
  it('requires direct transport source admission in the control frame', () => {
    expect(() => parseTargetControlFrame({
      kind: 'transport.hello', targetGeneration: 1, protocolVersion: 1,
      hostId: 'host-1', agentId: 'agent-1', capabilitiesRevision: 'cap-1',
    })).toThrow(/source/)
    expect(parseTargetControlFrame({
      kind: 'transport.hello', targetGeneration: 1, protocolVersion: 1,
      hostId: 'host-1', agentId: 'agent-1', capabilitiesRevision: 'cap-1',
      source: { accountId: 'account', scopeId: 'scope', agentId: 'consumer-1' }, admissionRef: 'direct:consumer-1',
    })).toMatchObject({ kind: 'transport.hello', admissionRef: 'direct:consumer-1' })
  })

  it('accepts known target control frames', () => {
    expect(
      parseTargetControlFrame({
        kind: 'channel.open',
        targetGeneration: 7,
        channelId: 'ch-1',
        sessionRef: {
          hostId: 'host-1',
          agentId: 'agent-1',
          sessionId: 'ses-1',
        },
      }),
    ).toMatchObject({
      kind: 'channel.open',
      targetGeneration: 7,
      channelId: 'ch-1',
    })
  })

  it('rejects unknown frame kind', () => {
    expect(() => parseTargetControlFrame({ kind: 'noop' })).toThrow(/unknown target control frame/)
  })

  it('rejects missing required control fields', () => {
    expect(() =>
      parseTargetControlFrame({
        kind: 'channel.open',
        channelId: 'ch-1',
      }),
    ).toThrow(/targetGeneration/)
  })

  it('rejects invalid target generation', () => {
    expect(() =>
      parseTargetControlFrame({
        kind: 'transport.ping',
        targetGeneration: 0,
        nonce: 'n-1',
      }),
    ).toThrow(/targetGeneration/)
  })
})

describe('session channel frames', () => {
  it('accepts session.message with typed body and empty metadata', () => {
    expect(
      parseSessionChannelFrame({
        kind: 'session.message',
        targetGeneration: 7,
        channelId: 'ch-1',
        sessionId: 'ses-1',
        correlationId: 'corr-1',
        role: 'user',
        body: { text: 'hello' },
        metadata: {},
      }),
    ).toMatchObject({
      kind: 'session.message',
      channelId: 'ch-1',
      sessionId: 'ses-1',
    })
  })

  it('rejects target frame kind in session channel parser', () => {
    expect(() =>
      parseSessionChannelFrame({
        kind: 'hello',
        protocolVersion: 1,
        targetGeneration: 1,
        hostId: 'host-1',
        agentId: 'agent-1',
        capabilitiesRevision: 'cap-1',
      }),
    ).toThrow(/unknown session channel frame/)
  })

  it('preserves business metadata without using it as transport generation', () => {
    expect(
      parseSessionChannelFrame({
        kind: 'session.message',
        targetGeneration: 7,
        channelId: 'ch-1',
        sessionId: 'ses-1',
        correlationId: 'corr-1',
        role: 'user',
        body: { text: 'hello' },
        metadata: { targetGeneration: 999 },
      }),
    ).toMatchObject({ targetGeneration: 7, metadata: { targetGeneration: 999 } })
  })

  it('preserves business object keys instead of guessing control intent', () => {
    expect(
      parseSessionChannelFrame({
        kind: 'session.message',
        targetGeneration: 7,
        channelId: 'ch-1',
        sessionId: 'ses-1',
        correlationId: 'corr-1',
        role: 'user',
        body: { text: 'hello', authToken: 'secret' },
      }),
    ).toMatchObject({ body: { text: 'hello', authToken: 'secret' } })
  })

  it('accepts agent.message with opaque business payload', () => {
    expect(
      parseSessionChannelFrame({
        kind: 'agent.message',
        targetGeneration: 7,
        channelId: 'pair-1',
        message: { kind: 'notify', correlationId: 'corr-1', payload: { text: 'ready' } },
      }),
    ).toMatchObject({ kind: 'agent.message', channelId: 'pair-1' })
    expect(
      parseSessionChannelFrame({
        kind: 'agent.message',
        targetGeneration: 7,
        channelId: 'pair-1',
        message: { kind: 'notify', correlationId: 'corr-1', payload: { text: 'ready', targetGeneration: 7 } },
      }),
    ).toMatchObject({ targetGeneration: 7, message: { payload: { targetGeneration: 7 } } })
  })

  it('does not derive envelope generation from business payload', () => {
    expect(() => parseSessionChannelFrame({
      kind: 'agent.message', channelId: 'pair-1',
      message: { kind: 'notify', correlationId: 'c', payload: { targetGeneration: 7 } },
    })).toThrow(/targetGeneration/)
  })

  it('rejects business payload placed on a control frame', () => {
    expect(() => parseTargetControlFrame({ kind: 'transport.ping', targetGeneration: 1, nonce: 'n', body: { text: 'hidden' } })).toThrow(/body/)
  })

  it('rejects unknown envelope fields instead of silently accepting them', () => {
    expect(() => parseSessionChannelFrame({ kind: 'agent.message', targetGeneration: 7, channelId: 'pair-1', route: 'hidden', message: { kind: 'notify', correlationId: 'c', payload: {} } })).toThrow(/route/)
    expect(() => parseTargetControlFrame({ kind: 'toString', targetGeneration: 1 })).toThrow(/unknown/)
  })
})
