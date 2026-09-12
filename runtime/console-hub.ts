import type { ConsoleClientV1, ConsoleProjectionV1 } from '../control-protocol/console-api.ts'
import type { RelayPeer } from '../control-protocol/agent-services.ts'
import { parseConsoleWorkRelationProjection } from '../control-protocol/console-api.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'

export interface ConsoleDirectoryBinding {
  readonly peers: readonly RelayPeer[]
  readonly client: (peer: RelayPeer) => ConsoleClientV1
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
      const discoveredState = await discovered()
      const entries = discovery
        ? discoveredState.peers.map(peer => ({ agentId: peer.declaration.identity.agentId, peer, client: peer.presence === 'online' ? discoveredState.client(peer) : undefined }))
        : [...owners].map(([agentId, client]) => ({ agentId, client, peer: undefined }))
      for (const { agentId, client, peer } of entries) {
        const directoryAgent = peer === undefined ? undefined : {
          agentId,
          label: peer.declaration.identity.label,
          machineId: peer.declaration.identity.machineId,
          generation: peer.generation,
          presence: peer.presence,
          capabilities: peer.declaration.capabilities.map(capability => capability.capabilityId),
        } as const
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
        for (const rows of [projection.agents, projection.sessions, projection.configs, projection.notifications, observed.works, observed.relations]) {
          if (rows.some(row => row.agentId !== agentId)) throw new RelayProtocolError('INVALID_INPUT', 'Console projection crossed its Agent owner')
        }
        const projectedAgents = projection.agents.length === 0 && directoryAgent ? [directoryAgent] : projection.agents.map(agent => ({
          ...agent,
          ...(directoryAgent === undefined ? {} : { label: directoryAgent.label, machineId: directoryAgent.machineId,
            generation: directoryAgent.generation, presence: directoryAgent.presence, capabilities: directoryAgent.capabilities }),
        }))
        agents.push(...projectedAgents)
        sessions.push(...projection.sessions)
        configs.push(...projection.configs)
        notifications.push(...projection.notifications)
        works.push(...observed.works)
        relations.push(...observed.relations)
      }
      return { version: 1, agents, sessions, configs, notifications, works, relations }
    },
    command: async command => (await owner(command.agentId)).command(command),
    sendSession: async (target, payload) => (await owner(target.agentId)).sendSession(target, payload),
  }
}
