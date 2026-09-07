import type { ConsoleClientV1, ConsoleProjectionV1 } from '../control-protocol/console-api.ts'
import { parseConsoleWorkRelationProjection } from '../control-protocol/console-api.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'

/** Compose bound owners without storing a second copy of their state. */
export function createConsoleHub(bindings: readonly { readonly agentId: string; readonly client: ConsoleClientV1 }[]): ConsoleClientV1 {
  const owners = new Map<string, ConsoleClientV1>()
  for (const { agentId, client } of bindings) {
    if (!agentId || owners.has(agentId)) throw new RelayProtocolError('INVALID_INPUT', 'Console requires unique Agent bindings')
    owners.set(agentId, client)
  }
  function owner(agentId: string): ConsoleClientV1 {
    const client = owners.get(agentId)
    if (!client) throw new RelayProtocolError('NOT_FOUND', 'Agent is not bound to this Console')
    return client
  }
  return {
    async readProjection() {
      const agents: ConsoleProjectionV1['agents'][number][] = []
      const sessions: ConsoleProjectionV1['sessions'][number][] = []
      const configs: ConsoleProjectionV1['configs'][number][] = []
      const notifications: ConsoleProjectionV1['notifications'][number][] = []
      const works: NonNullable<ConsoleProjectionV1['works']>[number][] = []
      const relations: NonNullable<ConsoleProjectionV1['relations']>[number][] = []
      for (const [agentId, client] of owners) {
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
        agents.push(...projection.agents)
        sessions.push(...projection.sessions)
        configs.push(...projection.configs)
        notifications.push(...projection.notifications)
        works.push(...observed.works)
        relations.push(...observed.relations)
      }
      return { version: 1, agents, sessions, configs, notifications, works, relations }
    },
    command: async command => owner(command.agentId).command(command),
    sendSession: async (target, payload) => owner(target.agentId).sendSession(target, payload),
  }
}
