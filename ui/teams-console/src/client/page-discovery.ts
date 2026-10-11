import type { ConsoleProjectionV1, ConsoleConnectionView } from './protocol.ts'
import { projectAgents, type AgentRow } from './model.ts'

export interface DiscoveryRow {
  readonly agent: AgentRow
  readonly connections: readonly ConsoleConnectionView[]
}

/** Project the owner rows the discovery page renders; directory and offline rows stay. */
export function projectDiscoveryRows(projection: ConsoleProjectionV1): readonly DiscoveryRow[] {
  const rows: DiscoveryRow[] = []
  for (const agent of projectAgents(projection)) {
    rows.push({ agent, connections: (projection.connections ?? []).filter(connection => connection.status.remoteAgentId === agent.agentId) })
  }
  return rows
}

export interface NetworkMemberDraft {
  readonly agentId: string
  readonly role: 'master' | 'peer'
}

export interface AcceptedRelation {
  readonly providerAgentId: string
  readonly consumerAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly relationPermission: string
}

/** Draft members and accepted relations; never defaults control to master. */
export function projectNetworkView(projection: ConsoleProjectionV1, draft: readonly NetworkMemberDraft[]): {
  readonly draft: readonly NetworkMemberDraft[]
  readonly accepted: readonly AcceptedRelation[]
} {
  const accepted = (projection.relations ?? []).map(relation => ({
    providerAgentId: relation.providerAgentId,
    consumerAgentId: relation.consumerAgentId,
    capabilityId: relation.capabilityId,
    capabilityVersion: relation.capabilityVersion,
    relationPermission: relation.relationPermission,
  }))
  return { draft, accepted }
}
