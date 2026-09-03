export interface AgentRuntimeConfig {
  readonly provider: string
  readonly model: string
}

export interface VersionedRuntimeConfig {
  readonly revision: number
  readonly agents: Readonly<Record<string, AgentRuntimeConfig>>
}

export function readConfigVersion(config: VersionedRuntimeConfig): number {
  return config.revision
}

export function syncSharedRuntimeConfig(config: VersionedRuntimeConfig, admitted: boolean): VersionedRuntimeConfig {
  if (!admitted) throw new Error('config: cannot sync before server admission')
  return config
}

export function saveAgentRuntimeConfig(
  config: VersionedRuntimeConfig,
  agentId: string,
  next: AgentRuntimeConfig,
  expectedRevision: number,
): VersionedRuntimeConfig {
  if (expectedRevision !== config.revision) {
    throw new Error(`config: revision conflict expected=${expectedRevision} current=${config.revision}`)
  }
  if (agentId.length === 0 || next.provider.length === 0 || next.model.length === 0) {
    throw new Error('config: agent, provider, and model are required')
  }
  return {
    revision: config.revision + 1,
    agents: { ...config.agents, [agentId]: next },
  }
}
