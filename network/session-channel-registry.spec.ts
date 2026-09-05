import { describe, expect, it } from 'vitest'
import {
  acknowledgeSessionChannel,
  acknowledgeSessionChannelClose,
  closeSessionChannel,
  createSessionChannelRegistry,
  failSessionChannel,
  openSessionChannel,
  sendSessionMessage,
} from './session-channel-registry.ts'

describe('Teams session channel multiplex registry', () => {
  it('opens multiple session channels on one target transport', () => {
    const first = openSessionChannel(createSessionChannelRegistry(), 7, 'ch-1', 'ses-1', 1)
    const second = openSessionChannel(first, 7, 'ch-2', 'ses-2', 2)
    expect(second.channels.size).toBe(2)
    expect(acknowledgeSessionChannel(second, 7, 'ch-2', 3).channels.get('ch-2')?.state).toBe('open')
  })

  it('rejects duplicate channel, unknown channel, and stale generation events', () => {
    const opened = openSessionChannel(createSessionChannelRegistry(), 7, 'ch-1', 'ses-1', 1)
    expect(() => openSessionChannel(opened, 7, 'ch-1', 'ses-2', 2)).toThrow(/CHANNEL_ALREADY_EXISTS/)
    expect(() => acknowledgeSessionChannel(opened, 7, 'missing', 2)).toThrow(/UNKNOWN_CHANNEL/)
    expect(() => acknowledgeSessionChannel(opened, 8, 'ch-1', 2)).toThrow(/STALE_GENERATION/)
  })

  it('closes and fails channels explicitly; failed channels cannot message', () => {
    const opened = openSessionChannel(createSessionChannelRegistry(), 7, 'ch-1', 'ses-1', 1)
    const ready = acknowledgeSessionChannel(opened, 7, 'ch-1', 2)
    const failed = failSessionChannel(ready, 7, 'ch-1', 3, { code: 'agent_error', message: 'boom' })
    expect(failed.channels.get('ch-1')?.state).toBe('failed')
    expect(() => sendSessionMessage(failed, 7, 'ch-1', 4)).toThrow(/expected open/)
  })

  it('closes and acknowledges close through the channel state machine', () => {
    const opened = openSessionChannel(createSessionChannelRegistry(), 7, 'ch-1', 'ses-1', 1)
    const ready = acknowledgeSessionChannel(opened, 7, 'ch-1', 2)
    const closing = closeSessionChannel(ready, 7, 'ch-1', 3)
    const closed = acknowledgeSessionChannelClose(closing, 7, 'ch-1', 4)
    expect(closed.channels.get('ch-1')?.state).toBe('closed')
  })
})
