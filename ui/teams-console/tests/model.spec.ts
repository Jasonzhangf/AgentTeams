import { describe, expect, it } from 'vitest'
import { canOperateSession, modelLabel, projectAgents, projectConfig, projectNotifications, projectSessionFlow, projectSessions, providerLabel } from '../src/client/model.ts'
import type { ConsoleProjectionV1 } from '../src/client/protocol.ts'

const projection: ConsoleProjectionV1 = {
  version: 1,
  agents: [{ kind: 'runtime', agentId: 'a', label: 'A', machineId: 'M', generation: 7, presence: 'unknown', capabilities: [], sessionCapable: true, sessionAvailability: 'current', sessionEffectiveRevision: 4, modelId: 'missing-model' }],
  sessions: [],
  notifications: [],
  configs: [{ agentId: 'a', acceptedRevision: 4, providers: [{ id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'https://example.invalid/v1', enabled: true, authKind: 'none', catalogState: 'empty', models: [] }] }],
}

describe('projection mapping', () => {
  it('preserves unknown Agent presence and never invents counts or provider values', () => {
    const agent = projectAgents(projection)[0]
    expect(agent).toEqual(expect.objectContaining({ agentId: 'a', presence: 'unknown', sessionCount: 0, notificationCount: 0 }))
    expect(agent.generation).toBe(7)
    expect(agent).not.toHaveProperty('providerId')
  })

  it('keeps empty catalogs empty and reports unknown model explicitly', () => {
    const config = projectConfig(projection, 'a')
    const provider = config?.providers[0]
    expect(provider?.models).toEqual([])
    expect(modelLabel(provider!, 'missing-model')).toBe('Unknown model: missing-model')
  })

  it('projects session and notification arrays without UI-owned mutation', () => {
    const sessions = projectSessions({ ...projection, sessions: [{ agentId: 'a', sessionId: 's', title: 'S' }] })
    const notifications = projectNotifications({ ...projection, notifications: [{ agentId: 'a', notificationId: 'n', kind: 'notice', state: 'pending', title: 'N', priority: 'high', occurredAt: 'owner-time' }] })
    expect(sessions).toEqual([{ agentId: 'a', sessionId: 's', title: 'S' }])
    expect(notifications).toEqual([{ agentId: 'a', notificationId: 'n', kind: 'notice', state: 'pending', title: 'N', priority: 'high', occurredAt: 'owner-time' }])
  })

  it('uses provider id when a projected provider label is blank', () => {
    expect(providerLabel({ id: 'p', label: '  ', protocol: 'openai-chat', apiBaseUrl: 'https://example.invalid', enabled: true, authKind: 'none', catalogState: 'empty', models: [] })).toBe('p')
  })

  it('enables Session actions only for a runtime capable current online row', () => {
    const base = { kind: 'runtime' as const, presence: 'online' as const }
    expect(canOperateSession({ ...base, sessionCapable: true, sessionAvailability: 'current' })).toBe(true)
    expect(canOperateSession({ ...base, sessionCapable: true, sessionAvailability: 'changing' })).toBe(false)
    expect(canOperateSession({ ...base, sessionCapable: false, sessionAvailability: 'not-applicable' })).toBe(false)
    expect(canOperateSession({ kind: 'directory', presence: 'online' })).toBe(false)
    expect(canOperateSession({ ...base, presence: 'offline', sessionCapable: true, sessionAvailability: 'current' })).toBe(false)
  })

  it('preserves the declared capability detail summary without inventing one', () => {
    const detail = [{ capabilityId: 'file-search', version: '3', operations: ['search'],
      resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'context' as const }] }]
    const agents = projectAgents({ ...projection, agents: [
      { kind: 'runtime', agentId: 'a', label: 'A', machineId: 'M', presence: 'online', capabilities: ['file-search'], capabilityDetails: detail,
        sessionCapable: false, sessionAvailability: 'not-applicable' },
    ] })
    expect(agents[0].capabilityDetails).toEqual(detail)
    expect(projectAgents(projection)[0]).not.toHaveProperty('capabilityDetails')
  })

  it('keeps a degraded Session observation independent of readiness', () => {
    const degraded = projectAgents({
      ...projection,
      agents: [{ kind: 'runtime', agentId: 'a', label: 'A', machineId: 'M', presence: 'online', capabilities: [], sessionCapable: true, sessionAvailability: 'current', sessionEffectiveRevision: 4, sessionObservation: { state: 'degraded', reason: 'projection-loss', detail: 'lost one part', droppedEvents: 1 } }],
    })[0]
    expect(degraded.sessionObservation?.state).toBe('degraded')
    expect(degraded.sessionAvailability).toBe('current')
    expect(canOperateSession(degraded)).toBe(true)
  })

  it('filters the owner-projected Session flow and links approvals to notifications without reordering it', () => {
    const flow = projectSessionFlow({
      ...projection,
      notifications: [{ agentId: 'a', notificationId: 'n', sessionId: 's', kind: 'permission', state: 'pending', title: 'Approve', permissionId: 'p1' }],
      sessionEvents: [
        { eventId: 'message', agentId: 'a', sessionId: 's', kind: 'message', state: 'completed', messageId: 'm1', role: 'user' },
        { eventId: 'other', agentId: 'a', sessionId: 'other', kind: 'tool', state: 'running', messageId: 'm1', partId: 'p1', callId: 'c1', tool: 'read', input: {} },
        { eventId: 'approval', agentId: 'a', sessionId: 's', kind: 'permission', state: 'pending', permissionId: 'p1', messageId: 'm1', title: 'Approve', metadata: {} },
        { eventId: 'notification', agentId: 'a', sessionId: 's', kind: 'permission', state: 'resolved', permissionId: 'p2', decision: 'once' },
      ],
    }, 'a', 's')
    expect(flow.map(event => event.kind)).toEqual(['message', 'permission', 'permission'])
    expect(flow[1]).toMatchObject({ eventId: 'approval', notificationId: 'n', state: 'pending' })
  })
})
