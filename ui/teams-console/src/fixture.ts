import type { ConsoleClientV1, ConsoleCommandResultV1, ConsoleProjectionV1, JsonValue } from './client/protocol.ts'

export const fixtureProjection: ConsoleProjectionV1 = {
  version: 1,
  agents: [
    { kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'Mac Studio', presence: 'online', capabilities: ['session', 'config'],
      capabilityDetails: [
        { capabilityId: 'session', version: '1', operations: ['session.create', 'session.cancel'], resources: [{ resourceId: 'session-slot', capacity: 2, unit: 'slot' }] },
        { capabilityId: 'config', version: '1', operations: ['config.apply'], resources: [{ resourceId: 'config-context', capacity: 1, unit: 'context' }] },
      ],
      sessionCapable: true, sessionAvailability: 'current', sessionEffectiveRevision: 6, currentSessionId: 'planner-current', providerId: 'rcc', modelId: 'deepseek-v4' },
    { kind: 'runtime', agentId: 'reviewer', label: 'Reviewer', machineId: 'Mac Studio', presence: 'unknown', capabilities: ['session'],
      capabilityDetails: [{ capabilityId: 'session', version: '1', operations: ['session.create'], resources: [] }],
      sessionCapable: true, sessionAvailability: 'uncertain', sessionEffectiveRevision: 2, currentSessionId: 'reviewer-current', providerId: 'openai', modelId: 'gpt-5.6-sol', sessionObservation: { state: 'degraded', reason: 'projection-loss', detail: 'one part event lacked identity', droppedEvents: 1 } },
    { kind: 'directory', agentId: 'offline-agent', label: 'Offline Agent', machineId: 'Build Mac', presence: 'offline', capabilities: ['session'] },
    { kind: 'runtime', agentId: 'browser-agent', label: 'AgentBrowser', machineId: 'MacBook Pro', presence: 'online', capabilities: ['browser'],
      capabilityDetails: [{ capabilityId: 'browser', version: '1', operations: ['context.create', 'navigate', 'snapshot', 'context.destroy'],
        resources: [{ resourceId: 'browser-context', capacity: 2, unit: 'context' }, { resourceId: 'browser-slot', capacity: 2, unit: 'slot' }] }],
      sessionCapable: false, sessionAvailability: 'not-applicable' },
  ],
  sessions: [
    { agentId: 'planner', sessionId: 'planner-current', title: 'Plan Teams runtime' },
    { agentId: 'reviewer', sessionId: 'reviewer-current', title: 'Review adapter boundary' },
    { agentId: 'planner', sessionId: 'planner-history', title: 'Define notification flow' },
  ],
  notifications: [
    { agentId: 'planner', notificationId: 'approval-1', sessionId: 'planner-current', kind: 'permission', state: 'pending', title: 'Apply runtime boundary', permissionId: 'permission-1', priority: 'high', occurredAt: '2026-09-07T02:00:05Z', detail: 'Agent requests permission to continue.' },
    { agentId: 'reviewer', notificationId: 'notice-1', sessionId: 'reviewer-current', kind: 'notice', state: 'resolved', title: 'Adapter review complete', priority: 'normal', occurredAt: '2026-09-07T01:50:00Z' },
  ],
  sessionEvents: [
    { eventId: 'event-message-1', agentId: 'planner', sessionId: 'planner-current', kind: 'message', occurredAt: '2026-09-07T02:00:00Z', state: 'completed', messageId: 'message-user-1', role: 'user' },
    { eventId: 'event-tool-1', agentId: 'planner', sessionId: 'planner-current', kind: 'tool', occurredAt: '2026-09-07T02:00:03Z', state: 'completed', messageId: 'message-assistant-1', partId: 'part-tool-1', callId: 'call-1', tool: 'read', input: { path: 'resource-map.json' }, output: 'read resource-map.json', title: 'Read architecture maps', metadata: {} },
    { eventId: 'event-approval-1', agentId: 'planner', sessionId: 'planner-current', kind: 'permission', occurredAt: '2026-09-07T02:00:05Z', state: 'pending', permissionId: 'permission-1', messageId: 'message-assistant-1', title: 'Apply runtime boundary', metadata: {} },
    { eventId: 'event-final-1', agentId: 'planner', sessionId: 'planner-current', kind: 'final', occurredAt: '2026-09-07T02:00:06Z', state: 'completed', messageId: 'message-assistant-1' },
  ],
  configs: [
    {
      agentId: 'planner',
      acceptedRevision: 7,
      effectiveRevision: 6,
      providers: [
        { id: 'rcc', label: 'RCC 4444', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:4444/v1', enabled: true, authKind: 'none', catalogState: 'ready', models: [{ id: 'deepseek-v4', label: 'DeepSeek V4' }, { id: 'deepseek-v4-reasoner', label: 'DeepSeek V4 Reasoner' }] },
        { id: 'empty-provider', label: 'Empty catalog', protocol: 'openai-responses', apiBaseUrl: 'https://provider.invalid/v1', enabled: false, authKind: 'bearer', catalogState: 'empty', models: [] },
      ],
    },
    {
      agentId: 'reviewer',
      acceptedRevision: 2,
      providers: [{ id: 'openai', label: 'OpenAI', protocol: 'openai-responses', apiBaseUrl: 'https://api.openai.com/v1', enabled: true, authKind: 'bearer', catalogState: 'stale', models: [{ id: 'gpt-5.6-sol' }] }],
    },
  ],
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function success(result?: JsonValue): ConsoleCommandResultV1 {
  return result === undefined ? { ok: true } : { ok: true, result }
}

function failure(code: 'INVALID_INPUT' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'UNAVAILABLE', message: string): ConsoleCommandResultV1 {
  return { ok: false, error: { code, message } }
}

export function createFixtureClient(): ConsoleClientV1 & { readonly sentPayloads: readonly JsonValue[] } {
  let projection = clone(fixtureProjection)
  const sentPayloads: JsonValue[] = []
  return {
    sentPayloads,
    async readProjection() { return clone(projection) },
    async command(command): Promise<ConsoleCommandResultV1> {
      if (command.kind === 'session.open') return success({ opened: true, sessionId: command.sessionId })
      if (command.kind === 'permission.reply') {
        const found = projection.notifications.some(notification => notification.notificationId === command.permissionId || notification.notificationId === command.permissionId.replace('permission-', 'approval-'))
        if (!found) return failure('NOT_FOUND', `Permission ${command.permissionId} not found`)
        projection = {
          ...projection,
          notifications: projection.notifications.map(notification => notification.permissionId === command.permissionId ? { ...notification, state: 'resolved' } : notification),
          sessionEvents: projection.sessionEvents?.map(event => event.kind === 'permission' && event.permissionId === command.permissionId
            ? { ...event, state: 'resolved' as const, decision: 'once' as const }
            : event),
        }
        return success()
      }
      if (command.kind === 'notification.ack') {
        projection = {
          ...projection,
          notifications: projection.notifications.map(notification => notification.notificationId === command.notificationId ? { ...notification, state: 'resolved' } : notification),
        }
        return success()
      }
      const config = projection.configs.find(candidate => candidate.agentId === command.agentId)
      if (config === undefined) return failure('NOT_FOUND', `Agent ${command.agentId} config not found`)
      if ('expectedRevision' in command && command.expectedRevision !== config.acceptedRevision) return failure('REVISION_CONFLICT', 'Accepted revision changed; refresh and retry.')
      if (command.kind === 'config.refreshModels') {
        const provider = config.providers.find(candidate => candidate.id === command.providerId)
        if (provider === undefined) return failure('NOT_FOUND', `Provider ${command.providerId} not found`)
        projection = {
          ...projection,
          configs: projection.configs.map(candidate => candidate.agentId !== command.agentId ? candidate : {
            ...candidate,
            acceptedRevision: candidate.acceptedRevision + 1,
            providers: candidate.providers.map(item => item.id !== command.providerId ? item : {
              ...item,
              catalogState: 'ready' as const,
              models: item.models.length === 0 ? [{ id: 'refreshed-model', label: 'Refreshed model' }] : item.models,
              error: undefined,
            }),
          }),
        }
        return success()
      }
      if (command.kind === 'config.bindModel') {
        const provider = config.providers.find(candidate => candidate.id === command.providerId)
        if (provider === undefined || !provider.models.some(model => model.id === command.modelId)) return failure('INVALID_INPUT', `Model ${command.modelId} is not in the provider catalog`)
        projection = {
          ...projection,
          agents: projection.agents.map(agent => agent.kind === 'runtime' && agent.sessionCapable === true && agent.agentId === command.agentId
            ? { ...agent, providerId: command.providerId, modelId: command.modelId }
            : agent),
          configs: projection.configs.map(candidate => candidate.agentId === command.agentId ? { ...candidate, acceptedRevision: candidate.acceptedRevision + 1 } : candidate),
        }
        return success()
      }
      if (command.kind === 'config.putProvider') {
        projection = {
          ...projection,
          configs: projection.configs.map(candidate => candidate.agentId !== command.agentId ? candidate : {
            ...candidate,
            acceptedRevision: candidate.acceptedRevision + 1,
            providers: [...candidate.providers.filter(provider => provider.id !== command.provider.id), {
              id: command.provider.id,
              label: command.provider.label,
              protocol: command.provider.protocol,
              apiBaseUrl: command.provider.apiBaseUrl,
              enabled: command.provider.enabled,
              authKind: command.provider.auth.kind,
              catalogState: 'empty',
              models: [],
            }],
          }),
        }
        return success()
      }
      if (command.kind === 'config.apply') {
        projection = {
          ...projection,
          configs: projection.configs.map(candidate => candidate.agentId === command.agentId ? { ...candidate, effectiveRevision: candidate.acceptedRevision } : candidate),
        }
        return success()
      }
      return failure('INVALID_INPUT', 'Unsupported fixture command')
    },
    async sendSession(target, payload) {
      if (!projection.sessions.some(session => session.agentId === target.agentId && session.sessionId === target.sessionId)) return failure('NOT_FOUND', 'Session not found')
      sentPayloads.push(clone(payload))
      projection = {
        ...projection,
        sessionEvents: [...(projection.sessionEvents ?? []), {
          eventId: `fixture-message-${sentPayloads.length}`,
          agentId: target.agentId,
          sessionId: target.sessionId,
          kind: 'message',
          state: 'pending',
          messageId: `fixture-message-${sentPayloads.length}`,
          role: 'user',
        }],
      }
      return success({ accepted: true })
    },
  }
}
