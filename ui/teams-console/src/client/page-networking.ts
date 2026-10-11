import type { ConsoleProjectionV1 } from './protocol.ts'
import { projectNetworkView } from './page-discovery.ts'
import type { NetworkMemberDraft } from './page-discovery.ts'

/**
 * The networking page selects participating agents and assigns master/peer roles. It only
 * needs each owner row's identity to decide membership, so it accepts the minimal shape the
 * owner projection provides rather than requiring the mapped `AgentRow`.
 */
export function selectNetworkMembers(agents: readonly { readonly agentId: string }[], draft: readonly NetworkMemberDraft[], agentId: string, role: 'master' | 'peer'): readonly NetworkMemberDraft[] {
  const existing = draft.filter(member => member.agentId !== agentId)
  if (!agents.some(agent => agent.agentId === agentId)) return existing
  return [...existing, { agentId, role }]
}

export function removeNetworkMember(draft: readonly NetworkMemberDraft[], agentId: string): readonly NetworkMemberDraft[] {
  return draft.filter(member => member.agentId !== agentId)
}

/** Exactly one master and zero or more peers; control is never a default master. */
export function canSubmitMembership(draft: readonly NetworkMemberDraft[], controlAgentId: string | undefined): boolean {
  const masters = draft.filter(member => member.role === 'master')
  if (masters.length !== 1) return false
  if (controlAgentId !== undefined && masters.some(member => member.agentId === controlAgentId)) return false
  return draft.length > 0
}

export function projectMembershipDraft(projection: ConsoleProjectionV1, draft: readonly NetworkMemberDraft[]): readonly NetworkMemberDraft[] {
  const known = new Set(projection.agents.map(agent => agent.agentId))
  return draft.filter(member => known.has(member.agentId))
}

export { projectNetworkView }
