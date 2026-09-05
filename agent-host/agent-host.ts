import type { OpenCodeAgentIdentity, OpenCodeHostFacade } from '../opencode-adapter/src/index.ts'
import type { HostRegistrationRequest } from '../network/host-registration.ts'

export interface AgentHostConfig {
  readonly hostId: string
  readonly machineId: string
  readonly agentId: string
  readonly agentKind: 'opencode'
  readonly accountId: string
  readonly label: string
  readonly endpoint: string
  readonly authMode: 'none' | 'shared-api-key' | 'shared-token'
  readonly credentialRef?: string
  readonly capabilitiesRevision: string
  readonly openCodeDirectory: string
}

export interface AgentHostBinding {
  readonly config: AgentHostConfig
  readonly registration: () => HostRegistrationRequest
  readonly projection: () => OpenCodeAgentIdentity
  readonly actions: OpenCodeHostFacade['actions']
}

function requiredString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`agent-host: ${label} is required`)
  return value
}

export function createAgentHostConfig(input: AgentHostConfig): AgentHostConfig {
  requiredString(input.hostId, 'hostId')
  requiredString(input.machineId, 'machineId')
  requiredString(input.agentId, 'agentId')
  requiredString(input.accountId, 'accountId')
  requiredString(input.label, 'label')
  requiredString(input.endpoint, 'endpoint')
  requiredString(input.capabilitiesRevision, 'capabilitiesRevision')
  requiredString(input.openCodeDirectory, 'openCodeDirectory')
  if (!input.endpoint.startsWith('http://') && !input.endpoint.startsWith('https://')) {
    throw new Error('agent-host: endpoint must use http:// or https://')
  }
  if (input.authMode !== 'none' && input.credentialRef === undefined) {
    throw new Error('agent-host: credentialRef is required for authenticated links')
  }
  return input
}

export function createAgentHostBinding(config: AgentHostConfig, facade: OpenCodeHostFacade): AgentHostBinding {
  const resolved = createAgentHostConfig(config)
  const projection: OpenCodeAgentIdentity = {
    agentId: resolved.agentId,
    machineId: resolved.machineId,
    label: resolved.label,
    machine: resolved.machineId,
    provider: 'opencode',
    model: 'opencode',
    sessionIds: facade.projection().sessions.map(session => session.id),
  }
  return {
    config: resolved,
    projection: () => projection,
    registration: () => ({
      hostId: resolved.hostId,
      machineId: resolved.machineId,
      agentId: resolved.agentId,
      agentKind: 'opencode',
      accountId: resolved.accountId,
      capabilitiesRevision: resolved.capabilitiesRevision,
      authMode: resolved.authMode,
      routeCandidates: [
        {
          candidateId: `${resolved.hostId}:server`,
          kind: 'relay-ws',
          endpoint: resolved.endpoint,
          authRequired: resolved.authMode !== 'none',
          lastSeenAt: new Date().toISOString(),
        },
      ],
    }),
    actions: facade.actions,
  }
}
