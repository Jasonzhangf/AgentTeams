import { describe, expect, it } from 'vitest'
import {
  advanceWatermark,
  appendMessage,
  backlogSince,
  createMessageLog,
  pageMessages,
  restoreMessageLog,
  trimMessages,
  unreadCount,
  watermarkFor,
  type MessageLogState,
} from './message-log.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:01:00.000Z'
const T2 = '2026-10-22T00:02:00.000Z'

function log(count: number): MessageLogState {
  let state = createMessageLog('g1')
  for (let index = 1; index <= count; index += 1) {
    state = appendMessage(state, {
      commitId: `c${index}`,
      groupId: 'g1',
      fromAgentId: 'agent-a',
      targetAgentIds: ['agent-b'],
      replyRequired: false,
      body: `message ${index}`,
      sentAt: T0,
    }).state
  }
  return state
}

describe('message log append', () => {
  it('assigns a monotonic sequence and a positive revision', () => {
    let state = createMessageLog('g1')
    const first = appendMessage(state, {
      commitId: 'c1', groupId: 'g1', fromAgentId: 'agent-a', targetAgentIds: ['agent-b'],
      replyRequired: true, body: 'hi', sentAt: T0,
    })
    state = first.state
    const second = appendMessage(state, {
      commitId: 'c2', groupId: 'g1', fromAgentId: 'agent-b', targetAgentIds: ['agent-a'],
      replyRequired: false, body: 'ok', sentAt: T1,
    })
    expect(first.message.sequence).toBe(1)
    expect(second.message.sequence).toBe(2)
    expect(second.state.revision).toBe(3)
    expect(pageMessages(second.state).messages.map(message => message.sequence)).toEqual([1, 2])
  })

  it('returns the original record for a repeated commit and rejects different content', () => {
    const state = log(1)
    const repeated = appendMessage(state, {
      commitId: 'c1', groupId: 'g1', fromAgentId: 'agent-a', targetAgentIds: ['agent-b'],
      replyRequired: false, body: 'message 1', sentAt: T2,
    })
    expect(repeated.state).toBe(state)
    expect(repeated.message.sequence).toBe(1)
    expect(() => appendMessage(state, {
      commitId: 'c1', groupId: 'g1', fromAgentId: 'agent-a', targetAgentIds: ['agent-b'],
      replyRequired: false, body: 'changed', sentAt: T2,
    })).toThrow(/conflicts with an existing message/)
  })

  it('rejects a message for another group', () => {
    const state = createMessageLog('g1')
    expect(() => appendMessage(state, {
      commitId: 'c1', groupId: 'g2', fromAgentId: 'agent-a', targetAgentIds: [],
      replyRequired: false, body: 'hi', sentAt: T0,
    })).toThrow(/does not match log group/)
  })
})

describe('message log paging', () => {
  it('pages after a cursor with hasMore', () => {
    const state = log(3)
    const first = pageMessages(state, { limit: 2 })
    expect(first.messages.map(message => message.sequence)).toEqual([1, 2])
    expect(first.hasMore).toBe(true)
    const second = pageMessages(state, { cursor: 2, limit: 2 })
    expect(second.messages.map(message => message.sequence)).toEqual([3])
    expect(second.hasMore).toBe(false)
    expect(second.gapBeforeSequence).toBeUndefined()
  })

  it('returns an empty page beyond the last sequence', () => {
    const page = pageMessages(log(2), { cursor: 10 })
    expect(page.messages).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  it('rejects a negative cursor or non-positive limit', () => {
    const state = log(1)
    expect(() => pageMessages(state, { cursor: -1 })).toThrow(/cursor/)
    expect(() => pageMessages(state, { limit: 0 })).toThrow(/limit/)
  })
})

describe('message log retention', () => {
  it('reports a retention gap explicitly after trimming', () => {
    const state = trimMessages(log(5), 3)
    const page = pageMessages(state, { cursor: 0 })
    expect(page.messages.map(message => message.sequence)).toEqual([4, 5])
    expect(page.gapBeforeSequence).toBe(4)
    const backlog = backlogSince(state, 0)
    expect(backlog.messages.map(message => message.sequence)).toEqual([4, 5])
    expect(backlog.gapBeforeSequence).toBe(4)
  })

  it('does not report a gap when the cursor already covers the missing range', () => {
    const page = pageMessages(trimMessages(log(5), 3), { cursor: 3 })
    expect(page.gapBeforeSequence).toBeUndefined()
    expect(page.messages.map(message => message.sequence)).toEqual([4, 5])
  })

  it('limits backlog and reports hasMore', () => {
    const backlog = backlogSince(log(4), 0, 2)
    expect(backlog.messages.map(message => message.sequence)).toEqual([1, 2])
    expect(backlog.hasMore).toBe(true)
  })

  it('continues the sequence after a full trim and rejects trimming past the tail', () => {
    let state = trimMessages(log(2), 2)
    expect(state.messages).toEqual([])
    expect(() => trimMessages(state, 3)).toThrow(/past the last appended sequence/)
    const appended = appendMessage(state, {
      commitId: 'c3', groupId: 'g1', fromAgentId: 'agent-a', targetAgentIds: [],
      replyRequired: false, body: 'after trim', sentAt: T1,
    })
    expect(appended.message.sequence).toBe(3)
    state = appended.state
    expect(pageMessages(state).messages.map(message => message.sequence)).toEqual([3])
  })
})

describe('message log watermarks', () => {
  it('counts unread messages after the watermark', () => {
    const state = log(3)
    expect(unreadCount(state, 'agent-b')).toBe(3)
    const advanced = advanceWatermark(state, { agentId: 'agent-b', upToSequence: 2 }, T1)
    expect(watermarkFor(advanced, 'agent-b')?.upToSequence).toBe(2)
    expect(unreadCount(advanced, 'agent-b')).toBe(1)
  })

  it('rejects a backward watermark or one beyond the log', () => {
    const state = advanceWatermark(log(3), { agentId: 'agent-b', upToSequence: 2 }, T1)
    expect(() => advanceWatermark(state, { agentId: 'agent-b', upToSequence: 1 }, T2))
      .toThrow(/cannot move backward/)
    expect(() => advanceWatermark(state, { agentId: 'agent-b', upToSequence: 4 }, T2))
      .toThrow(/cannot pass the last appended sequence/)
  })

  it('keeps a lagging watermark when retention moves', () => {
    const state = advanceWatermark(log(5), { agentId: 'agent-b', upToSequence: 1 }, T1)
    const trimmed = trimMessages(state, 3)
    expect(watermarkFor(trimmed, 'agent-b')?.upToSequence).toBe(1)
    expect(unreadCount(trimmed, 'agent-b')).toBe(2)
    expect(pageMessages(trimmed, { cursor: 1 }).gapBeforeSequence).toBe(4)
  })
})

describe('message log restore', () => {
  const record = (sequence: number) => ({
    messageId: `m${sequence}`,
    commitId: `c${sequence}`,
    sequence,
    groupId: 'g1',
    fromAgentId: 'agent-a',
    targetAgentIds: ['agent-b'],
    replyRequired: false,
    body: `message ${sequence}`,
    sentAt: T0,
  })

  it('rebuilds from increasing records', () => {
    const state = restoreMessageLog({ groupId: 'g1', messages: [record(1), record(2)] })
    expect(state.messages.map(message => message.sequence)).toEqual([1, 2])
    expect(pageMessages(state).revision).toBe(3)
  })

  it('rejects sequence rollback, duplicates and a foreign group', () => {
    expect(() => restoreMessageLog({ groupId: 'g1', messages: [record(2), record(1)] }))
      .toThrow(/strictly increase/)
    expect(() => restoreMessageLog({ groupId: 'g1', messages: [record(1), record(1)] }))
      .toThrow(/strictly increase|duplicate/)
    expect(() => restoreMessageLog({ groupId: 'g2', messages: [record(1)] }))
      .toThrow(/another group/)
  })

  it('rejects a watermark beyond the restored tail', () => {
    expect(() => restoreMessageLog({
      groupId: 'g1',
      messages: [record(1)],
      watermarks: [{ agentId: 'agent-b', groupId: 'g1', upToSequence: 2, updatedAt: T0 }],
    })).toThrow(/passes the last appended sequence/)
  })
})
