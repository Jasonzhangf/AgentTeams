import { describe, expect, it } from 'vitest'
import { projectDiscoveryRows } from '../src/client/page-discovery.ts'
import type { ConsoleProjectionV1, TeamsConnectionStatus } from '../src/client/protocol.ts'
import { parseTeamsConnectionStatus } from '../src/client/protocol.ts'

const status = parseTeamsConnectionStatus({
  version: 1, remoteAgentId: 'planner', state: 'ready', targetGeneration: 3,
  observedAt: '2026-09-07T02:00:00Z', connectionId: 'conn-1', role: 'peer',
})

const projection: ConsoleProjectionV1 = {
  version: 1,
  agents: [
    { kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'Mac', presence: 'online', capabilities: ['session'], engine: 'opencode', lastSeenAt: '2026-09-07T01:59:00Z', generation: 3, sessionCapable: true, sessionAvailability: 'current' },
    { kind: 'directory', agentId: 'offline-agent', label: 'Offline Agent', machineId: 'Build Mac', presence: 'offline', capabilities: ['session'] },
  ],
  sessions: [],
  notifications: [],
  configs: [],
  connections: [{ status, halfOpen: false, localRole: 'peer' }],
}

describe('discovery page projection', () => {
  it('keeps offline and directory rows and attaches owner connections', () => {
    const rows = projectDiscoveryRows(projection)
    expect(rows.map(row => row.agent.agentId)).toEqual(['planner', 'offline-agent'])
    const planner = rows[0]
    expect(planner.agent.presence).toBe('online')
    expect(planner.agent.engine).toBe('opencode')
    expect(planner.agent.lastSeenAt).toBe('2026-09-07T01:59:00Z')
    expect(planner.connections.map(connection => connection.status.state)).toEqual(['ready'])
  })

  it('keeps a row with no current connection', () => {
    const rows = projectDiscoveryRows({ ...projection, agents: [projection.agents[1]] })
    expect(rows).toHaveLength(1)
    expect(rows[0].agent.agentId).toBe('offline-agent')
    expect(rows[0].connections).toEqual([])
  })
})
