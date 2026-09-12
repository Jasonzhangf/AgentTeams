import { describe, expect, it } from 'vitest'
import { modelLabel, projectAgents, projectConfig, projectNotifications, projectSessionFlow, projectSessions, providerLabel } from '../src/client/model.ts'
import type { ConsoleProjectionV1 } from '../src/client/protocol.ts'

const projection: ConsoleProjectionV1 = {
  version: 1,
  agents: [{ agentId: 'a', label: 'A', machineId: 'M', generation: 7, presence: 'unknown', capabilities: [], modelId: 'missing-model' }],
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

  it('filters the owner-projected Session flow and links approvals to notifications without reordering it', () => {
    const flow = projectSessionFlow({
      ...projection,
      notifications: [{ agentId: 'a', notificationId: 'n', sessionId: 's', kind: 'permission', state: 'pending', title: 'Approve', permissionId: 'p1' }],
      sessionEvents: [
        { eventId: 'message', agentId: 'a', sessionId: 's', kind: 'message', title: 'Message' },
        { eventId: 'other', agentId: 'a', sessionId: 'other', kind: 'tool', title: 'Other tool' },
        { eventId: 'approval', agentId: 'a', sessionId: 's', kind: 'approval', title: 'Approve', state: 'pending', permissionId: 'p1' },
        { eventId: 'notification', agentId: 'a', sessionId: 's', kind: 'notification', title: 'Approval required' },
      ],
    }, 'a', 's')
    expect(flow.map(event => event.kind)).toEqual(['message', 'approval', 'notification'])
    expect(flow[1]).toMatchObject({ eventId: 'approval', notificationId: 'n', state: 'pending' })
  })
})
