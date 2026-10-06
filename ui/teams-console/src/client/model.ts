import type { ConsoleProjectionV1, ConsoleProviderView, ConsoleSessionEventView } from './protocol.ts'

export type ConsoleEntry = 'topology' | 'conversations' | 'notifications' | 'search' | 'memory'
export type UiStatus = 'online' | 'offline' | 'unknown'

export interface AgentRow {
  readonly agentId: string
  readonly label: string
  readonly machineId: string
  readonly generation?: number
  readonly presence: UiStatus
  readonly capabilities: readonly string[]
  readonly kind: 'runtime' | 'directory'
  readonly sessionCapable?: boolean
  readonly sessionAvailability?: 'changing' | 'stopped' | 'no-current' | 'uncertain' | 'current' | 'not-applicable'
  readonly sessionObservation?: import('./protocol.ts').SessionObservationState
  readonly sessionEffectiveRevision?: number
  readonly currentSessionId?: string
  readonly providerId?: string
  readonly modelId?: string
  readonly sessionCount: number
  readonly notificationCount: number
}

/** Structural subset shared by the owner observation union and the UI AgentRow. */
export interface SessionOperableAgent {
  readonly kind: 'runtime' | 'directory'
  readonly sessionCapable?: boolean
  readonly sessionAvailability?: string
  readonly presence: UiStatus
}

/** UI enablement: owner runtime row, real managed Session capability, current readiness, online presence. */
export function canOperateSession(agent: SessionOperableAgent): boolean {
  return agent.kind === 'runtime' && agent.sessionCapable === true
    && agent.sessionAvailability === 'current' && agent.presence === 'online'
}

export interface SessionRow {
  readonly agentId: string
  readonly sessionId: string
  readonly title?: string
}

export interface NotificationRow {
  readonly agentId: string
  readonly notificationId: string
  readonly sessionId?: string
  readonly kind: 'notice' | 'permission'
  readonly state: 'pending' | 'resolved'
  readonly title: string
  readonly permissionId?: string
  readonly priority?: 'low' | 'normal' | 'high' | 'critical'
  readonly occurredAt?: string
  readonly detail?: string
}

export type SessionFlowRow = ConsoleSessionEventView & { readonly notificationId?: string }

export interface AgentConfigView {
  readonly agentId: string
  readonly acceptedRevision: number
  readonly effectiveRevision?: number
  readonly providers: readonly ConsoleProviderView[]
  readonly error?: { readonly code: string; readonly message: string }
}

export function projectAgents(projection: ConsoleProjectionV1): readonly AgentRow[] {
  const sessions = new Map<string, number>()
  for (const session of projection.sessions) sessions.set(session.agentId, (sessions.get(session.agentId) ?? 0) + 1)
  const notifications = new Map<string, number>()
  for (const notification of projection.notifications) {
    if (notification.state === 'pending') {
      notifications.set(notification.agentId, (notifications.get(notification.agentId) ?? 0) + 1)
    }
  }
  return projection.agents.map(agent => ({
    ...agent,
    sessionCount: sessions.get(agent.agentId) ?? 0,
    notificationCount: notifications.get(agent.agentId) ?? 0,
  }))
}

export function projectSessions(projection: ConsoleProjectionV1): readonly SessionRow[] {
  return projection.sessions
}

export function projectNotifications(projection: ConsoleProjectionV1): readonly NotificationRow[] {
  return projection.notifications
}

export function projectSessionFlow(projection: ConsoleProjectionV1, agentId: string, sessionId: string): readonly SessionFlowRow[] {
  const notificationByPermission = new Map(
    projection.notifications
      .filter(notification => notification.agentId === agentId && notification.sessionId === sessionId && notification.permissionId !== undefined)
      .map(notification => [notification.permissionId as string, notification.notificationId]),
  )
  return (projection.sessionEvents ?? [])
    .filter(event => event.agentId === agentId && event.sessionId === sessionId)
    .map(event => ({
      ...event,
      ...(event.kind !== 'permission' ? {} : { notificationId: notificationByPermission.get(event.permissionId) }),
    }))
}

export function projectConfig(projection: ConsoleProjectionV1, agentId: string): AgentConfigView | undefined {
  return projection.configs.find(config => config.agentId === agentId)
}

export function providerById(config: AgentConfigView | undefined, providerId: string): ConsoleProviderView | undefined {
  return config?.providers.find(provider => provider.id === providerId)
}

export function providerLabel(provider: ConsoleProviderView): string {
  return provider.label.trim() || provider.id
}

export function modelLabel(provider: ConsoleProviderView, modelId: string | undefined): string {
  if (modelId === undefined) return 'Model not selected'
  const model = provider.models.find(candidate => candidate.id === modelId)
  return model === undefined ? `Unknown model: ${modelId}` : model.label ?? model.id
}

export function projectionHasAgent(projection: ConsoleProjectionV1 | null, agentId: string): boolean {
  return projection?.agents.some(agent => agent.agentId === agentId) ?? false
}
