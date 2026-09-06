import type { ConsoleClientV1, ConsoleProjectionV1 } from '../control-protocol/console-api.ts'
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
      for (const [agentId, client] of owners) {
        const projection = await client.readProjection()
        for (const rows of [projection.agents, projection.sessions, projection.configs, projection.notifications]) {
          if (rows.some(row => row.agentId !== agentId)) throw new RelayProtocolError('INVALID_INPUT', 'Console projection crossed its Agent owner')
        }
        agents.push(...projection.agents)
        sessions.push(...projection.sessions)
        configs.push(...projection.configs)
        notifications.push(...projection.notifications)
      }
      return { version: 1, agents, sessions, configs, notifications }
    },
    command: async command => owner(command.agentId).command(command),
    sendSession: async (target, payload) => owner(target.agentId).sendSession(target, payload),
  }
}
