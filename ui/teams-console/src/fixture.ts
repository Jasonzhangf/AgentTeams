import type { ConsoleClientV1, ConsoleCommandResultV1, ConsoleProjectionV1, JsonValue } from './client/protocol.ts'

export const fixtureProjection: ConsoleProjectionV1 = {
  version: 1,
  agents: [
    { agentId: 'planner', label: 'Planner', machineId: 'Mac Studio', presence: 'online', capabilities: ['session', 'config'], currentSessionId: 'planner-current', providerId: 'rcc', modelId: 'deepseek-v4' },
    { agentId: 'reviewer', label: 'Reviewer', machineId: 'Mac Studio', presence: 'unknown', capabilities: ['session'], currentSessionId: 'reviewer-current', providerId: 'openai', modelId: 'gpt-5.6-sol' },
    { agentId: 'offline-agent', label: 'Offline Agent', machineId: 'Build Mac', presence: 'offline', capabilities: ['session'] },
  ],
  sessions: [
    { agentId: 'planner', sessionId: 'planner-current', title: 'Plan Teams runtime' },
    { agentId: 'reviewer', sessionId: 'reviewer-current', title: 'Review adapter boundary' },
    { agentId: 'planner', sessionId: 'planner-history', title: 'Define notification flow' },
  ],
  notifications: [
    { agentId: 'planner', notificationId: 'approval-1', sessionId: 'planner-current', kind: 'permission', state: 'pending', title: 'Apply runtime boundary', permissionId: 'permission-1' },
    { agentId: 'reviewer', notificationId: 'notice-1', sessionId: 'reviewer-current', kind: 'notice', state: 'resolved', title: 'Adapter review complete' },
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
          agents: projection.agents.map(agent => agent.agentId === command.agentId ? { ...agent, providerId: command.providerId, modelId: command.modelId } : agent),
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
      return success({ accepted: true })
    },
  }
}
