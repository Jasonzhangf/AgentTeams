export type NotificationPriority = 'high' | 'medium' | 'low'
export type NotificationState = 'pending' | 'processed'

export interface AgentNotification {
  readonly id: string
  readonly agentId: string
  readonly sessionId?: string
  readonly title: string
  readonly priority: NotificationPriority
  readonly state: NotificationState
  readonly interactive: boolean
  readonly createdAt: string
}

export type NotificationTarget =
  | { readonly kind: 'session'; readonly agentId: string; readonly sessionId: string }
  | { readonly kind: 'agent'; readonly agentId: string }

export function projectAgentNotifications(notifications: readonly AgentNotification[]): readonly AgentNotification[] {
  return [...notifications].sort((left, right) => {
    if ((left.state === 'pending') !== (right.state === 'pending')) return left.state === 'pending' ? -1 : 1
    const priority = { high: 0, medium: 1, low: 2 } as const
    if (priority[left.priority] !== priority[right.priority]) return priority[left.priority] - priority[right.priority]
    return right.createdAt.localeCompare(left.createdAt)
  })
}

export function resolveNotificationTarget(notification: AgentNotification): NotificationTarget {
  if (notification.agentId.length === 0) throw new Error('agent: notification requires agentId')
  if (notification.interactive && notification.sessionId === undefined) {
    throw new Error(`agent: interactive notification "${notification.id}" has no session target`)
  }
  return notification.sessionId === undefined
    ? { kind: 'agent', agentId: notification.agentId }
    : { kind: 'session', agentId: notification.agentId, sessionId: notification.sessionId }
}

export function acknowledgeNotification(notification: AgentNotification): AgentNotification {
  if (notification.state === 'processed') return notification
  return { ...notification, state: 'processed' }
}
