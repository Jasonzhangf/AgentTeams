import { describe, expect, it } from 'vitest'
import {
  createChannelState,
  onClose,
  onCloseAck,
  onError,
  onMessage,
  onOpenAck,
  openChannel,
} from './channel-state.ts'

const base = {
  targetGeneration: 7,
  channelId: 'ch-1',
  sessionId: 'ses-1',
  at: 1000,
}

describe('session channel lifecycle state machine', () => {
  it('moves idle -> opening -> open -> closing -> closed', () => {
    const idle = createChannelState()
    const opening = openChannel(idle, base)
    expect(opening.state).toBe('opening')

    const open = onOpenAck(opening, base)
    expect(open.state).toBe('open')

    const closing = onClose(open, base)
    expect(closing.state).toBe('closing')

    const closed = onCloseAck(closing, base)
    expect(closed.state).toBe('closed')
  })

  it('rejects duplicate open while opening', () => {
    const opening = openChannel(createChannelState(), base)
    expect(() => openChannel(opening, base)).toThrow(/INVALID_TRANSITION/)
  })

  it('rejects session message before open ack', () => {
    const opening = openChannel(createChannelState(), base)
    expect(() => onMessage(opening, base)).toThrow(/INVALID_TRANSITION/)
  })

  it('rejects close from idle', () => {
    expect(() => onClose(createChannelState(), base)).toThrow(/INVALID_TRANSITION/)
  })

  it('rejects stale generation events', () => {
    const opening = openChannel(createChannelState(), base)
    expect(() => onOpenAck(opening, { ...base, targetGeneration: 8 })).toThrow(/STALE_GENERATION/)
  })

  it('rejects unknown channel id', () => {
    const open = onOpenAck(openChannel(createChannelState(), base), base)
    expect(() => onMessage(open, { ...base, channelId: 'ch-other' })).toThrow(/CHANNEL_MISMATCH/)
  })

  it('rejects invalid target generation on open', () => {
    expect(() => openChannel(createChannelState(), { ...base, targetGeneration: 0 })).toThrow(/INVALID_GENERATION/)
  })

  it('moves open/closing to failed on explicit error and rejects terminal events', () => {
    const open = onOpenAck(openChannel(createChannelState(), base), base)
    const failed = onError(open, { ...base, code: 'channel.timeout', message: 'timed out' })
    expect(failed.state).toBe('failed')
    expect(failed.error?.code).toBe('channel.timeout')
    expect(() => onMessage(failed, base)).toThrow(/INVALID_TRANSITION/)
  })
})
