import type { ConsoleAgentObservationV1, ConsoleClientV1, ConsoleProjectionV1 } from '../packages/shared/src/console-api.ts'
import type { RelayPeer } from '../packages/shared/src/agent-services.ts'
import { parseConsoleWorkRelationProjection, projectCapabilityDetails } from '../packages/shared/src/console-api.ts'
import { RelayProtocolError } from '../packages/shared/src/relay-codec.ts'

export interface ConsoleDirectoryBinding {
  readonly peers: readonly RelayPeer[]
  readonly client: (peer: RelayPeer) => ConsoleClientV1
}

/**
 * One directory agent row projected from an admitted Relay peer. The peer's published
 * declaration owns the identity, generation, presence and capability facts; this is the
 * single mapper for a directory row, shared by the Console hub and the control daemon's
 * directory projection.
 */
export function directoryAgentObservation(peer: RelayPeer): ConsoleAgentObservationV1 {
  return {
    kind: 'directory',
    agentId: peer.declaration.identity.agentId,
    label: peer.declaration.identity.label,
    machineId: peer.declaration.identity.machineId,
    generation: peer.generation,
    presence: peer.presence,
    capabilities: peer.declaration.capabilities.map(capability => capability.capabilityId),
    capabilityDetails: projectCapabilityDetails(peer.declaration.capabilities),
  }
}

/** Compose bound owners without storing a second copy of their state. Empty static bindings use directory discovery. */
export function createConsoleHub(
  bindings: readonly { readonly agentId: string; readonly client: ConsoleClientV1 }[],
  discovery?: () => Promise<ConsoleDirectoryBinding>,
): ConsoleClientV1 {
  if (discovery && bindings.length > 0) throw new RelayProtocolError('INVALID_INPUT', 'Console cannot combine static bindings with directory discovery')
  const owners = new Map<string, ConsoleClientV1>()
  for (const { agentId, client } of bindings) {
    if (!agentId || owners.has(agentId)) throw new RelayProtocolError('INVALID_INPUT', 'Console requires unique Agent bindings')
    owners.set(agentId, client)
  }
  async function discovered(): Promise<ConsoleDirectoryBinding> {
    if (!discovery) return { peers: [], client: () => { throw new RelayProtocolError('NOT_FOUND', 'Agent is not bound to this Console') } }
    const result = await discovery()
    const ids = new Set<string>()
    for (const peer of result.peers) {
      const agentId = peer.declaration.identity.agentId
      if (!agentId || ids.has(agentId)) throw new RelayProtocolError('INVALID_INPUT', 'Relay directory contains duplicate Agent identities')
      ids.add(agentId)
    }
    return result
  }
  async function owner(agentId: string): Promise<ConsoleClientV1> {
    const client = owners.get(agentId)
    if (client) return client
    const result = await discovered()
    const peer = result.peers.find(candidate => candidate.declaration.identity.agentId === agentId)
    if (!peer) throw new RelayProtocolError('NOT_FOUND', 'Agent is not admitted to this Console directory')
    if (peer.presence !== 'online') throw new RelayProtocolError('UNAVAILABLE', 'Agent is offline')
    return result.client(peer)
  }
  return {
    async readProjection() {
      const agents: ConsoleProjectionV1['agents'][number][] = []
      const sessions: ConsoleProjectionV1['sessions'][number][] = []
      const configs: ConsoleProjectionV1['configs'][number][] = []
      const notifications: ConsoleProjectionV1['notifications'][number][] = []
      const works: NonNullable<ConsoleProjectionV1['works']>[number][] = []
      const relations: NonNullable<ConsoleProjectionV1['relations']>[number][] = []
      const sessionEvents: NonNullable<ConsoleProjectionV1['sessionEvents']>[number][] = []
      const discoveredState = await discovered()
      const entries = discovery
        ? discoveredState.peers.map(peer => ({ agentId: peer.declaration.identity.agentId, peer, client: peer.presence === 'online' ? discoveredState.client(peer) : undefined }))
        : [...owners].map(([agentId, client]) => ({ agentId, client, peer: undefined }))
      for (const { agentId, client, peer } of entries) {
        const directoryAgent = peer === undefined ? undefined : directoryAgentObservation(peer)
        if (client === undefined) {
          if (directoryAgent) agents.push(directoryAgent)
          continue
        }
        const projection = await client.readProjection()
        let observed: ReturnType<typeof parseConsoleWorkRelationProjection>
        try {
          observed = parseConsoleWorkRelationProjection(projection)
        } catch (error) {
          throw new RelayProtocolError('INVALID_INPUT', error instanceof Error ? error.message : 'Console projection requires work and relation observations')
        }
        for (const rows of [projection.agents, projection.sessions, projection.configs, projection.notifications,
          projection.sessionEvents ?? [], observed.works, observed.relations]) {
          if (rows.some(row => row.agentId !== agentId)) throw new RelayProtocolError('INVALID_INPUT', 'Console projection crossed its Agent owner')
        }
        const projectedAgents = projection.agents.length === 0 && directoryAgent ? [directoryAgent] : projection.agents.map(agent => ({
          ...agent,
          // The online directory row owns the ID list and its detail together: never keep the
          // runtime fixture's detail beside the directory's IDs.
          ...(directoryAgent === undefined ? {} : { label: directoryAgent.label, machineId: directoryAgent.machineId,
            generation: directoryAgent.generation, presence: directoryAgent.presence, capabilities: directoryAgent.capabilities,
            capabilityDetails: directoryAgent.capabilityDetails }),
        }))
        agents.push(...projectedAgents)
        sessions.push(...projection.sessions)
        configs.push(...projection.configs)
        notifications.push(...projection.notifications)
        works.push(...observed.works)
        relations.push(...observed.relations)
        sessionEvents.push(...(projection.sessionEvents ?? []))
      }
      return { version: 1, agents, sessions, configs, notifications, works, relations, ...(sessionEvents.length === 0 ? {} : { sessionEvents }) }
    },
    command: async command => (await owner(command.agentId)).command(command),
    sendSession: async (target, payload) => (await owner(target.agentId)).sendSession(target, payload),
  }
}
