export interface OpenCodePluginInput {
  readonly client: unknown
  readonly project: unknown
  readonly directory: string
  readonly worktree: string
  readonly experimental_workspace: unknown
  readonly serverUrl: URL
  readonly $: unknown
}

export interface OpenCodeEvent {
  readonly type: string
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface OpenCodeEventInput {
  readonly event: OpenCodeEvent
}

export interface OpenCodePermissionInput {
  readonly id: string
  readonly sessionID: string
}

export interface OpenCodeHooks {
  readonly event?: (input: OpenCodeEventInput) => Promise<void>
  readonly 'permission.ask'?: (input: OpenCodePermissionInput, output: {
    status: 'ask' | 'deny' | 'allow'
  }) => Promise<void>
}

export interface OpenCodeNotification {
  readonly source: 'opencode'
  readonly kind:
    | 'session-created'
    | 'session-updated'
    | 'session-deleted'
    | 'session-status'
    | 'message-updated'
    | 'permission-request'
  readonly sessionId: string
  readonly requestId?: string
  readonly interactive: boolean
}

export type OpenCodeNotificationSink = (notification: OpenCodeNotification) => void

function sessionIdFromEvent(event: OpenCodeEvent): string | undefined {
  const properties = event.properties
  if (typeof properties?.sessionID === 'string') return properties.sessionID
  if (typeof properties?.info !== 'object' || properties.info === null) return undefined
  const info = properties.info as Record<string, unknown>
  if (typeof info.sessionID === 'string') return info.sessionID
  return typeof info.id === 'string' ? info.id : undefined
}

export function projectOpenCodeEvent(event: OpenCodeEvent): OpenCodeNotification | undefined {
  const properties = event.properties
  const sessionId = sessionIdFromEvent(event)
  if (sessionId === undefined) return undefined

  switch (event.type) {
    case 'session.created':
      return { source: 'opencode', kind: 'session-created', sessionId, interactive: false }
    case 'session.updated':
      return { source: 'opencode', kind: 'session-updated', sessionId, interactive: false }
    case 'session.deleted':
      return { source: 'opencode', kind: 'session-deleted', sessionId, interactive: false }
    case 'session.status':
      return { source: 'opencode', kind: 'session-status', sessionId, interactive: false }
    case 'message.updated':
      return { source: 'opencode', kind: 'message-updated', sessionId, interactive: false }
    default:
      return undefined
  }
}

export function projectOpenCodePermission(
  permission: OpenCodePermissionInput,
): OpenCodeNotification {
  return {
    source: 'opencode',
    kind: 'permission-request',
    sessionId: permission.sessionID,
    requestId: permission.id,
    interactive: true,
  }
}

export function registerOpenCodeHooks(sink: OpenCodeNotificationSink): OpenCodeHooks {
  return {
    event: async ({ event }) => {
      const notification = projectOpenCodeEvent(event)
      if (notification !== undefined) sink(notification)
    },
    'permission.ask': async (permission) => {
      sink(projectOpenCodePermission(permission))
    },
  }
}

export type OpenCodePlugin = (
  input: OpenCodePluginInput,
  options?: Readonly<Record<string, unknown>>,
) => Promise<OpenCodeHooks>

export function createTeamsOpenCodePlugin(sink: OpenCodeNotificationSink): OpenCodePlugin {
  return async () => registerOpenCodeHooks(sink)
}

export const TeamsOpenCodePlugin: OpenCodePlugin = async () => ({})

export default {
  id: 'teams-opencode-adapter',
  server: TeamsOpenCodePlugin,
}
