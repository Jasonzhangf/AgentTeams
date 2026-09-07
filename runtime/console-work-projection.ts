import type { AgentWork, WorkState } from '../control-protocol/agent-services.ts'
import type { ConsoleRelationView, ConsoleWorkView } from '../control-protocol/console-api.ts'

function relationPermission(state: WorkState): ConsoleRelationView['relationPermission'] {
  if (state === 'rejected') return 'revoked'
  return 'granted'
}

/** Map durable Agent Work control fields only; request payloads never enter Console observation. */
export function projectConsoleWorkObservations(agentId: string, works: readonly AgentWork[]): {
  readonly works: readonly ConsoleWorkView[]
  readonly relations: readonly ConsoleRelationView[]
} {
  if (!agentId) throw new Error('Console work observation requires the projecting Agent')
  return {
    works: works.map(work => ({
      agentId,
      workId: work.workId,
      consumerAgentId: work.consumerAgentId,
      providerAgentId: work.providerAgentId,
      capabilityId: work.capabilityId,
      capabilityVersion: work.capabilityVersion,
      policyRevision: work.policyRevision,
      state: work.state,
    })),
    relations: works.map(work => ({
      agentId,
      consumerAgentId: work.consumerAgentId,
      providerAgentId: work.providerAgentId,
      capabilityId: work.capabilityId,
      capabilityVersion: work.capabilityVersion,
      relationPermission: relationPermission(work.state),
      workId: work.workId,
    })),
  }
}
