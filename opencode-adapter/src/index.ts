import type { PluginInput, Hooks } from '@opencode-ai/plugin'
import type { Session } from '@opencode-ai/sdk'

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
    | 'permission-processed'
  readonly sessionId: string
  readonly requestId?: string
  readonly interactive: boolean
  readonly status: 'pending' | 'processed'
  readonly priority: 'normal' | 'high'
  readonly occurredAt: string
}

export type OpenCodeNotificationSink = (notification: OpenCodeNotification) => void

export interface OpenCodeNotificationStore {
  readonly pending: readonly OpenCodeNotification[]
  readonly processed: readonly OpenCodeNotification[]
}

export interface OpenCodeNotificationStoreBinding {
  readonly get: () => OpenCodeNotificationStore
  readonly sink: OpenCodeNotificationSink
  readonly acknowledge: (notificationId: string) => void
}

export interface OpenCodeSessionProjection {
  readonly id: string
  readonly title?: string
  readonly directory?: string
  readonly time?: Readonly<Record<string, unknown>>
}

export interface OpenCodeHostProjection {
  readonly sessions: readonly OpenCodeSessionProjection[]
  readonly notifications: OpenCodeNotificationStore
}

export interface OpenCodeAgentIdentity {
  readonly agentId: string
  readonly machineId: string
  readonly label: string
  readonly machine: string
  readonly provider: string
  readonly model: string
  readonly sessionIds: readonly string[]
  readonly currentSessionId?: string
}

export interface OpenCodeTeamsProjection {
  readonly agents: readonly OpenCodeAgentIdentity[]
  readonly sessions: readonly (OpenCodeSessionProjection & { readonly agentId: string; readonly running: boolean })[]
  readonly notifications: OpenCodeNotificationStore
}

export interface TeamsNotificationProjectionItem {
  readonly id: string
  readonly sessionId: string
  readonly requestId?: string
  readonly interactive: boolean
  readonly processed: boolean
  readonly priority: 'high' | 'medium'
  readonly createdAt: string
}

export interface OpenCodeHostActions {
  readonly openSession: (sessionId: string) => Promise<void>
  readonly sendMessage: (sessionId: string, text: string) => Promise<void>
  readonly replyPermission: (sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject') => Promise<void>
  readonly acknowledgeNotification: (notificationId: string) => void
}

export interface OpenCodeHostFacade {
  readonly projection: () => OpenCodeHostProjection
  readonly teamsProjection: (identities: readonly OpenCodeAgentIdentity[]) => OpenCodeTeamsProjection
  readonly refreshSessions: (directory?: string) => Promise<readonly OpenCodeSessionProjection[]>
  readonly subscribe: (listener: (projection: OpenCodeHostProjection) => void) => () => void
  readonly actions: OpenCodeHostActions
}

export interface OpenCodePluginRuntime {
  readonly facade: OpenCodeHostFacade
  readonly hooks: Hooks
}

export interface OpenCodeSessionClient {
  readonly session: {
    list(options?: Readonly<Record<string, unknown>>): Promise<{ data?: readonly Session[] } | readonly Session[]>
    get(options: { path: { id: string } }): Promise<{ data?: Session } | Session>
    prompt(options: { path: { id: string }; body: { parts: [{ type: 'text'; text: string }] } }): Promise<unknown>
  }
  readonly postSessionIdPermissionsPermissionId: (options: { path: { id: string; permissionID: string }; body: { response: 'once' | 'always' | 'reject' } }) => Promise<unknown>
}

function responseData<T>(response: T | { data?: T }): T | undefined {
  if (typeof response === 'object' && response !== null && 'data' in response) return response.data
  return response as T
}

export async function listOpenCodeSessions(client: OpenCodeSessionClient, directory?: string): Promise<readonly OpenCodeSessionProjection[]> {
  const result = await client.session.list(directory === undefined ? {} : { query: { directory } })
  const sessions = responseData(result) ?? []
  return sessions.map(session => ({ id: session.id, title: session.title, directory: session.directory, time: session.time }))
}

export async function getOpenCodeSession(client: OpenCodeSessionClient, sessionId: string): Promise<OpenCodeSessionProjection> {
  const result = await client.session.get({ path: { id: sessionId } })
  const session = responseData(result)
  if (session === undefined) throw new Error(`OpenCode session not found: ${sessionId}`)
  return { id: session.id, title: session.title, directory: session.directory, time: session.time }
}

export async function sendOpenCodeMessage(client: OpenCodeSessionClient, sessionId: string, text: string): Promise<void> {
  if (text.trim() === '') throw new Error('OpenCode message must not be empty')
  await client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: 'text', text }] } })
}

export async function replyOpenCodePermission(client: OpenCodeSessionClient, permissionId: string, sessionId: string, response: 'once' | 'always' | 'reject'): Promise<void> {
  await client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: permissionId }, body: { response } })
}

export function createOpenCodeHostFacade(client: OpenCodeSessionClient, binding = createOpenCodeNotificationStoreBinding()): OpenCodeHostFacade {
  let sessions: readonly OpenCodeSessionProjection[] = []
  const listeners = new Set<(projection: OpenCodeHostProjection) => void>()
  const notify = () => { for (const listener of listeners) listener({ sessions, notifications: binding.get() }) }
  return {
    projection: () => ({ sessions, notifications: binding.get() }),
    teamsProjection: identities => projectOpenCodeTeamsProjection(sessions, binding.get(), identities),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refreshSessions: async directory => {
      sessions = await listOpenCodeSessions(client, directory)
      notify()
      return sessions
    },
    actions: {
      openSession: async (sessionId) => { await getOpenCodeSession(client, sessionId) },
      sendMessage: async (sessionId, text) => { await sendOpenCodeMessage(client, sessionId, text) },
      replyPermission: async (sessionId, permissionId, response) => { await replyOpenCodePermission(client, permissionId, sessionId, response) },
      acknowledgeNotification: notificationId => {
        binding.acknowledge(notificationId)
        notify()
      },
    },
  }
}

export function projectOpenCodeTeamsProjection(
  sessions: readonly OpenCodeSessionProjection[],
  notifications: OpenCodeNotificationStore,
  identities: readonly OpenCodeAgentIdentity[],
): OpenCodeTeamsProjection {
  const sessionOwner = new Map(identities.flatMap(identity => identity.sessionIds.map(sessionId => [sessionId, identity.agentId] as const)))
  const projectedSessions = sessions.flatMap(session => {
    const agentId = sessionOwner.get(session.id)
    return agentId === undefined ? [] : [{ ...session, agentId, running: true }]
  })
  return { agents: identities, sessions: projectedSessions, notifications }
}

export function projectOpenCodeNotifications(notifications: OpenCodeNotificationStore): readonly TeamsNotificationProjectionItem[] {
  return sortOpenCodeNotifications([...notifications.pending, ...notifications.processed]).map(notification => ({
    id: notificationIdFor(notification),
    sessionId: notification.sessionId,
    ...(notification.requestId === undefined ? {} : { requestId: notification.requestId }),
    interactive: notification.interactive,
    processed: notification.status === 'processed',
    priority: notification.priority === 'high' ? 'high' : 'medium',
    createdAt: notification.occurredAt,
  }))
}

export async function createOpenCodePluginRuntime(input: PluginInput, binding = createOpenCodeNotificationStoreBinding()): Promise<OpenCodePluginRuntime> {
  const facade = createOpenCodeHostFacade(input.client, binding)
  await facade.refreshSessions(input.directory)
  const hooks = registerOpenCodeHooks(notification => {
    binding.sink(notification)
    void facade.refreshSessions(input.directory)
  }) as Hooks
  return { facade, hooks }
}

const notificationSinks = new Set<OpenCodeNotificationSink>()

export function acknowledgeOpenCodeNotification(store: OpenCodeNotificationStore, notificationId: string): OpenCodeNotificationStore {
  const all = [...store.pending, ...store.processed]
  const target = all.find(item => notificationIdFor(item) === notificationId)
  if (target === undefined) throw new Error(`OpenCode notification not found: ${notificationId}`)
  return {
    pending: store.pending.filter(item => notificationIdFor(item) !== notificationId),
    processed: [...store.processed, { ...target, status: 'processed' }],
  }
}

export function createOpenCodeNotificationStoreBinding(initial: OpenCodeNotificationStore = { pending: [], processed: [] }): OpenCodeNotificationStoreBinding {
  let store = initial
  return {
    get: () => store,
    sink: notification => {
      if (notification.status === 'processed') {
        const id = notificationIdFor(notification)
        store = {
          pending: store.pending.filter(item => notificationIdFor(item) !== id),
          processed: [...store.processed, notification],
        }
        return
      }
      store = { pending: sortOpenCodeNotifications([...store.pending, notification]), processed: store.processed }
    },
    acknowledge: notificationId => { store = acknowledgeOpenCodeNotification(store, notificationId) },
  }
}

export function sortOpenCodeNotifications(notifications: readonly OpenCodeNotification[]): readonly OpenCodeNotification[] {
  return [...notifications].sort((left, right) => {
    const priority = Number(right.priority === 'high') - Number(left.priority === 'high')
    return priority || right.occurredAt.localeCompare(left.occurredAt)
  })
}

function notificationIdFor(notification: OpenCodeNotification): string {
  return `${notification.kind}:${notification.sessionId}:${notification.requestId ?? notification.occurredAt}`
}

export function subscribeOpenCodeNotifications(sink: OpenCodeNotificationSink): () => void {
  notificationSinks.add(sink)
  return () => { notificationSinks.delete(sink) }
}

function sessionIdFromEvent(event: OpenCodeEvent): string | undefined {
  const properties = event.properties
  if (typeof properties?.sessionID === 'string') return properties.sessionID
  if (typeof properties?.info !== 'object' || properties.info === null) return undefined
  const info = properties.info as Record<string, unknown>
  if (typeof info.sessionID === 'string') return info.sessionID
  return typeof info.id === 'string' ? info.id : undefined
}

function permissionIdFromEvent(event: OpenCodeEvent): string | undefined {
  const properties = event.properties
  if (typeof properties?.permissionID === 'string') return properties.permissionID
  if (typeof properties?.id === 'string') return properties.id
  return undefined
}

export function projectOpenCodeEvent(event: OpenCodeEvent): OpenCodeNotification | undefined {
  const properties = event.properties
  const sessionId = sessionIdFromEvent(event)
  if (sessionId === undefined) return undefined

  switch (event.type) {
    case 'session.created':
      return notification('session-created', sessionId, false)
    case 'session.updated':
      return notification('session-updated', sessionId, false)
    case 'session.deleted':
      return notification('session-deleted', sessionId, false)
    case 'session.status':
      return notification('session-status', sessionId, false)
    case 'message.updated':
      return notification('message-updated', sessionId, false)
    case 'permission.updated': {
      const requestId = permissionIdFromEvent(event)
      if (requestId === undefined) return undefined
      return { ...notification('permission-request', sessionId, true), requestId }
    }
    case 'permission.replied': {
      const requestId = permissionIdFromEvent(event)
      if (requestId === undefined) return undefined
      return { ...notification('permission-processed', sessionId, true, 'processed'), requestId }
    }
    default:
      return undefined
  }
}

function notification(kind: OpenCodeNotification['kind'], sessionId: string, interactive: boolean, status: OpenCodeNotification['status'] = 'pending'): OpenCodeNotification {
  return { source: 'opencode', kind, sessionId, interactive, status, priority: interactive ? 'high' : 'normal', occurredAt: new Date().toISOString() }
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
    status: 'pending',
    priority: 'high',
    occurredAt: new Date().toISOString(),
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

export type OpenCodePlugin = (input: PluginInput) => Promise<Hooks>

export function createTeamsOpenCodePlugin(sink: OpenCodeNotificationSink): OpenCodePlugin {
  return async () => registerOpenCodeHooks(sink)
}

export const TeamsOpenCodePluginWithNotifications: OpenCodePlugin = async input => {
  const binding = createOpenCodeNotificationStoreBinding()
  const hooks = registerOpenCodeHooks(notification => {
    binding.sink(notification)
    for (const sink of notificationSinks) sink(notification)
  }) as Hooks
  void input
  return {
    ...hooks,
    event: async eventInput => {
      await hooks.event?.(eventInput)
    },
    'permission.ask': async (permission, output) => {
      await hooks['permission.ask']?.(permission, output)
    },
  }
}

export const TeamsOpenCodePlugin = TeamsOpenCodePluginWithNotifications

export default {
  id: 'teams-opencode-adapter',
  server: TeamsOpenCodePlugin,
}
