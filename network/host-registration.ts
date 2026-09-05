import type { BootstrapAuthMode, BootstrapLinkConfig, LinkState } from './link.ts'
import type { HostDirectory, HostDirectoryInput } from '../server/directory.ts'
import { upsertDirectoryHost } from '../server/directory.ts'

export interface HostRegistrationRequest {
  readonly hostId: string
  readonly machineId: string
  readonly agentId: string
  readonly agentKind: 'opencode' | 'acp' | 'custom'
  readonly accountId: string
  readonly capabilitiesRevision: string
  readonly routeCandidates: readonly HostDirectoryInput['routeCandidates'][number][]
  readonly authMode: BootstrapAuthMode
  readonly configuredCredential?: string
  readonly presentedCredential?: string
}

export type HostRegistrationResult =
  | { readonly ok: true; readonly directory: HostDirectory; readonly registration: HostDirectoryInput }
  | { readonly ok: false; readonly reason: 'credential_mismatch' | 'link_not_connected' | 'invalid_request' }

export function prepareAgentHostRegistration(request: HostRegistrationRequest): HostDirectoryInput {
  if (request.hostId.length === 0 || request.machineId.length === 0 || request.agentId.length === 0 || request.accountId.length === 0) {
    throw new Error('registration: host identity fields are required')
  }
  if (request.capabilitiesRevision.length === 0) throw new Error('registration: capabilitiesRevision is required')
  if (request.routeCandidates.length === 0) throw new Error('registration: routeCandidates are required')
  return {
    hostId: request.hostId,
    machineId: request.machineId,
    agentId: request.agentId,
    agentKind: request.agentKind,
    accountId: request.accountId,
    capabilitiesRevision: request.capabilitiesRevision,
    routeCandidates: request.routeCandidates,
    health: 'starting',
  }
}

function credentialsMatch(request: HostRegistrationRequest): boolean {
  if (request.authMode === 'none') return true
  return request.configuredCredential !== undefined
    && request.configuredCredential === request.presentedCredential
}

export function registerAgentHost(
  directory: HostDirectory,
  link: LinkState,
  config: BootstrapLinkConfig,
  request: HostRegistrationRequest,
  now = new Date().toISOString(),
): HostRegistrationResult {
  if (link.status !== 'connected' || link.endpoint !== config.endpoint) {
    return { ok: false, reason: 'link_not_connected' }
  }
  if (!credentialsMatch(request)) {
    return { ok: false, reason: 'credential_mismatch' }
  }
  let registration: HostDirectoryInput
  try {
    registration = prepareAgentHostRegistration(request)
  } catch {
    return { ok: false, reason: 'invalid_request' }
  }
  return { ok: true, directory: upsertDirectoryHost(directory, registration, now), registration }
}
