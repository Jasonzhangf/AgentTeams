import { describe, expect, it } from 'vitest'
import type { Action, Group, Message } from '../control-protocol/group-wire.ts'
import { dedupeMessageBatch, routeGroupMessage } from './message-router.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:01:00.000Z'
const T2 = '2026-10-22T00:02:00.000Z'
const T3 = '2026-10-22T00:03:00.000Z'
const T4 = '2026-10-22T00:04:00.000Z'
const T5 = '2026-10-22T00:05:00.000Z'
const T6 = '2026-10-22T00:06:00.000Z'

const group: Group = {
  groupId: 'g1',
  name: 'release',
  ownerAgentId: 'agent-a',
  createdAt: T0,
  members: [
    { agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'], intervals: [{ joinedAt: T0 }] },
    { agentId: 'agent-b', role: 'peer', mastersOf: [], intervals: [{ joinedAt: T1 }] },
    { agentId: 'agent-c', role: 'peer', mastersOf: [], intervals: [{ joinedAt: T1 }] },
  ],
}

const action: Action = {
  actionId: 'a1',
  commitId: 'ac1',
  sessionId: 's1',
  initiatorAgentId: 'agent-a',
  assigneeAgentId: 'agent-b',
  kind: 'review',
  reason: 'check the plan',
  expectedResult: 'a written verdict',
  replyRequired: false,
  state: 'pending',
  createdAt: T0,
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'm1',
    commitId: 'mc1',
    sequence: 1,
    groupId: 'g1',
    fromAgentId: 'agent-a',
    targetAgentIds: ['agent-b'],
    replyRequired: false,
    body: 'please review',
    sentAt: T2,
    ...overrides,
  }
}

describe('message routing visibility', () => {
  it('keeps a group message visible to all active members and pushes online members', () => {
    const routed = routeGroupMessage({
      group,
      message: message(),
      onlineAgentIds: ['agent-b', 'agent-c'],
    })
    expect(routed.visibleToAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c'])
    expect(routed.pushAgentIds).toEqual(['agent-b', 'agent-c'])
    expect(routed.offlineAgentIds).toEqual([])
    expect(routed.duplicate).toBe(false)
  })

  it('reports offline members instead of silently dropping them', () => {
    const routed = routeGroupMessage({
      group,
      message: message(),
      onlineAgentIds: ['agent-b'],
    })
    expect(routed.pushAgentIds).toEqual(['agent-b'])
    expect(routed.offlineAgentIds).toEqual(['agent-c'])
  })

  it('suppresses a push for an already delivered message id', () => {
    const routed = routeGroupMessage({
      group,
      message: message(),
      onlineAgentIds: ['agent-b', 'agent-c'],
      deliveredMessageIds: ['m1'],
    })
    expect(routed.duplicate).toBe(true)
    expect(routed.pushAgentIds).toEqual([])
  })

  it('rejects a sender or target without a valid membership interval', () => {
    expect(() => routeGroupMessage({
      group,
      message: message({ fromAgentId: 'agent-d' }),
      onlineAgentIds: [],
    })).toThrow(/sender agent-d is not an active member/)
    expect(() => routeGroupMessage({
      group,
      message: message({ targetAgentIds: ['agent-d'] }),
      onlineAgentIds: [],
    })).toThrow(/target agent-d is not an active member/)
  })
})

describe('message routing action targets', () => {
  it('accepts exactly the action assignee as the target set', () => {
    const routed = routeGroupMessage({
      group,
      message: message({ actionId: 'a1', sessionId: 's1', targetAgentIds: ['agent-b'] }),
      action,
      onlineAgentIds: ['agent-b', 'agent-c'],
    })
    expect(routed.visibleToAgentIds).toContain('agent-c')
    expect(routed.pushAgentIds).toEqual(['agent-b', 'agent-c'])
  })

  it('rejects a target set that differs from the action assignee', () => {
    expect(() => routeGroupMessage({
      group,
      message: message({ actionId: 'a1', sessionId: 's1', targetAgentIds: ['agent-c'] }),
      action,
      onlineAgentIds: [],
    })).toThrow(/exactly equal the action assignee/)
    expect(() => routeGroupMessage({
      group,
      message: message({ actionId: 'a1', sessionId: 's1', targetAgentIds: ['agent-b', 'agent-c'] }),
      action,
      onlineAgentIds: [],
    })).toThrow(/exactly equal the action assignee/)
    expect(() => routeGroupMessage({
      group,
      message: message({ actionId: 'a1', sessionId: 's1', targetAgentIds: [] }),
      action,
      onlineAgentIds: [],
    })).toThrow(/exactly equal the action assignee/)
  })

  it('rejects an action link without a record or across sessions', () => {
    expect(() => routeGroupMessage({
      group,
      message: message({ actionId: 'missing', sessionId: 's1' }),
      onlineAgentIds: [],
    })).toThrow(/has no action record/)
    expect(() => routeGroupMessage({
      group,
      message: message({ actionId: 'a1', sessionId: 's2' }),
      action,
      onlineAgentIds: [],
    })).toThrow(/same issue session/)
  })

  it('rejects an action supplied without an actionId on the message', () => {
    expect(() => routeGroupMessage({
      group,
      message: message(),
      action,
      onlineAgentIds: [],
    })).toThrow(/without actionId/)
  })
})

describe('message routing reentry', () => {
  const reentryGroup: Group = {
    ...group,
    members: [
      { agentId: 'agent-a', role: 'master', mastersOf: ['agent-b'], intervals: [{ joinedAt: T0 }] },
      {
        agentId: 'agent-b',
        role: 'peer',
        mastersOf: [],
        intervals: [{ joinedAt: T1, leftAt: T3 }, { joinedAt: T5 }],
      },
    ],
  }

  it('does not expose messages sent while the member was absent', () => {
    const absent = routeGroupMessage({
      group: reentryGroup,
      message: message({ messageId: 'm-absent', sentAt: T4, targetAgentIds: [] }),
      onlineAgentIds: ['agent-b'],
    })
    expect(absent.visibleToAgentIds).toEqual(['agent-a'])
    expect(absent.pushAgentIds).toEqual([])
    const after = routeGroupMessage({
      group: reentryGroup,
      message: message({ messageId: 'm-after', sentAt: T6, targetAgentIds: [] }),
      onlineAgentIds: ['agent-b'],
    })
    expect(after.visibleToAgentIds).toEqual(['agent-a', 'agent-b'])
    expect(after.pushAgentIds).toEqual(['agent-b'])
  })
})

describe('message batch deduplication', () => {
  it('keeps the first occurrence and reports duplicates', () => {
    const batch = dedupeMessageBatch([
      message({ messageId: 'm1' }),
      message({ messageId: 'm1' }),
      message({ messageId: 'm2' }),
    ])
    expect(batch.unique.map(entry => entry.messageId)).toEqual(['m1', 'm2'])
    expect(batch.duplicates.map(entry => entry.messageId)).toEqual(['m1'])
  })

  it('treats already delivered ids as duplicates', () => {
    const batch = dedupeMessageBatch([
      message({ messageId: 'm1' }),
      message({ messageId: 'm2' }),
    ], ['m2'])
    expect(batch.unique.map(entry => entry.messageId)).toEqual(['m1'])
    expect(batch.duplicates.map(entry => entry.messageId)).toEqual(['m2'])
  })
})
