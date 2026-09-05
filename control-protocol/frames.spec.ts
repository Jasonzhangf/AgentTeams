import { describe, expect, it } from 'vitest'
import { parseSessionChannelFrame, parseTargetControlFrame } from './frames.ts'

describe('target control frames', () => {
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

  it('rejects control fields in metadata', () => {
    expect(() =>
      parseSessionChannelFrame({
        kind: 'session.message',
        targetGeneration: 7,
        channelId: 'ch-1',
        sessionId: 'ses-1',
        correlationId: 'corr-1',
        role: 'user',
        body: { text: 'hello' },
        metadata: { targetGeneration: 7 },
      }),
    ).toThrow(/metadata.*targetGeneration/)
  })

  it('rejects control fields in body top-level record', () => {
    expect(() =>
      parseSessionChannelFrame({
        kind: 'session.message',
        targetGeneration: 7,
        channelId: 'ch-1',
        sessionId: 'ses-1',
        correlationId: 'corr-1',
        role: 'user',
        body: { text: 'hello', authToken: 'secret' },
      }),
    ).toThrow(/body.*authToken/)
  })

  it('accepts agent.message with business payload and rejects routing fields in payload', () => {
    expect(
      parseSessionChannelFrame({
        kind: 'agent.message',
        targetGeneration: 7,
        channelId: 'pair-1',
        message: { kind: 'notify', correlationId: 'corr-1', payload: { text: 'ready' } },
      }),
    ).toMatchObject({ kind: 'agent.message', channelId: 'pair-1' })
    expect(() =>
      parseSessionChannelFrame({
        kind: 'agent.message',
        targetGeneration: 7,
        channelId: 'pair-1',
        message: { kind: 'notify', correlationId: 'corr-1', payload: { text: 'ready', targetGeneration: 7 } },
      }),
    ).toThrow(/targetGeneration/)
  })
})
