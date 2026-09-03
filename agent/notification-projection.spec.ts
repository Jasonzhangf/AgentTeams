import { describe, expect, it } from 'vitest'
import { acknowledgeNotification, projectAgentNotifications, resolveNotificationTarget, type AgentNotification } from './notification-projection.ts'

const notification = (overrides: Partial<AgentNotification> = {}): AgentNotification => ({
  id: 'n-1', agentId: 'planner', title: 'Approval', priority: 'high', state: 'pending', interactive: true, sessionId: 's-1', createdAt: '2026-09-01T17:00:00Z', ...overrides,
})

describe('Teams notification projection', () => {
  it('sorts pending and important notifications before processed ones', () => {
    const result = projectAgentNotifications([
      notification({ id: 'done', state: 'processed', createdAt: '2026-09-01T18:00:00Z' }),
      notification({ id: 'medium', priority: 'medium' }),
      notification({ id: 'high-new', createdAt: '2026-09-01T19:00:00Z' }),
    ])
    expect(result.map(item => item.id)).toEqual(['high-new', 'medium', 'done'])
  })

  it('routes interactive notifications only to an existing session target', () => {
    expect(resolveNotificationTarget(notification())).toEqual({ kind: 'session', agentId: 'planner', sessionId: 's-1' })
    expect(resolveNotificationTarget(notification({ interactive: false, sessionId: undefined }))).toEqual({ kind: 'agent', agentId: 'planner' })
    expect(() => resolveNotificationTarget(notification({ sessionId: undefined }))).toThrow(/no session target/)
  })

  it('acknowledges through the business owner projection', () => {
    expect(acknowledgeNotification(notification())).toMatchObject({ state: 'processed' })
  })
})
