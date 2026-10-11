import { describe, expect, it } from 'vitest'
import { canSubmitMembership, projectMembershipDraft, selectNetworkMembers } from '../src/client/page-networking.ts'
import type { ConsoleProjectionV1 } from '../src/client/protocol.ts'

// Canonical owner observations: the networking page's projection consumes the raw
// projection (not the mapped AgentRow), so the fixture must satisfy the owner union.
const agents = [
  { kind: 'runtime' as const, agentId: 'planner', label: 'Planner', machineId: 'M', presence: 'online' as const,
    capabilities: [], sessionCapable: true as const, sessionAvailability: 'current' as const },
  { kind: 'runtime' as const, agentId: 'control', label: 'Control', machineId: 'M', presence: 'online' as const,
    capabilities: [], sessionCapable: true as const, sessionAvailability: 'current' as const },
]

const projection: ConsoleProjectionV1 = {
  version: 1,
  agents: [...agents, { kind: 'directory', agentId: 'offline-agent', label: 'Offline', machineId: 'M',
    presence: 'offline', capabilities: [] }],
  sessions: [],
  notifications: [],
  configs: [],
  relations: [{
    agentId: 'planner', consumerAgentId: 'consumer', providerAgentId: 'planner',
    capabilityId: 'session', capabilityVersion: '1', relationPermission: 'granted',
  }],
}

describe('networking page projection', () => {
  it('selects members and keeps the draft separated from accepted relations', () => {
    const draft = selectNetworkMembers(agents, [], 'planner', 'master')
    const projected = projectMembershipDraft(projection, [...draft, { agentId: 'gone', role: 'peer' }])
    expect(projected.map(member => member.agentId)).toEqual(['planner'])
    expect(projection.relations).toHaveLength(1)
  })

  it('submits only with exactly one master and never defaults control to master', () => {
    expect(canSubmitMembership([{ agentId: 'planner', role: 'master' }], 'control')).toBe(true)
    expect(canSubmitMembership([{ agentId: 'planner', role: 'master' }, { agentId: 'reviewer', role: 'peer' }], 'control')).toBe(true)
    expect(canSubmitMembership([{ agentId: 'planner', role: 'peer' }], 'control')).toBe(false)
    expect(canSubmitMembership([{ agentId: 'control', role: 'master' }], 'control')).toBe(false)
    expect(canSubmitMembership([], 'control')).toBe(false)
  })
})
