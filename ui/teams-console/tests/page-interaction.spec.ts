import { describe, expect, it } from 'vitest'
import { permissionOptions, projectInteraction } from '../src/client/page-interaction.ts'
import type { ConsoleProjectionV1 } from '../src/client/protocol.ts'

const projection: ConsoleProjectionV1 = {
  version: 1,
  agents: [{ kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'M', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' }],
  sessions: [{ agentId: 'planner', sessionId: 's1', title: 'S' }],
  notifications: [],
  configs: [],
  sessionEvents: [
    { eventId: 'e1', agentId: 'planner', sessionId: 's1', kind: 'message', state: 'completed', messageId: 'm1', role: 'user' },
    { eventId: 'e2', agentId: 'planner', sessionId: 's1', kind: 'permission', state: 'pending', permissionId: 'p1', messageId: 'm1', title: 'Approve', metadata: {}, options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'once' },
      { optionId: 'reject-1', name: 'Reject', kind: 'reject' },
    ] },
    { eventId: 'e3', agentId: 'planner', sessionId: 's1', kind: 'permission', state: 'pending', permissionId: 'p2', messageId: 'm1', title: 'No options', metadata: {} },
  ],
}

describe('interaction page projection', () => {
  it('projects the owner flow and pending permissions with engine choices', () => {
    const view = projectInteraction(projection, 'planner', 's1')
    expect(view.flow.map(event => event.kind)).toEqual(['message', 'permission', 'permission'])
    expect(view.pendingPermissions).toHaveLength(2)
    expect(view.operable).toBe(true)
    const options = permissionOptions(view.pendingPermissions[0])
    expect(options.map(option => option.optionId)).toEqual(['allow-once', 'reject-1'])
  })

  it('renders no choice buttons when the engine offered none', () => {
    const view = projectInteraction(projection, 'planner', 's1')
    const options = permissionOptions(view.pendingPermissions[1])
    expect(options).toEqual([])
  })
})
