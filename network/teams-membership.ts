import type { ServiceError } from '../packages/shared/src/agent-services.ts'
import type { AcpFault } from '../packages/shared/src/acp.ts'
import { AcpError } from '../packages/shared/src/acp.ts'
import type { RelationRole } from '../packages/shared/src/teams-connection.ts'
import type { TeamsConnectionState, TeamsConnectionStatus } from '../packages/shared/src/teams-state.ts'
import { TEAMS_CONNECTION_STATUS_VERSION, parseTeamsConnectionStatus } from '../packages/shared/src/teams-state.ts'
import type { HostDirectoryEntry, RouteCandidate } from '../server/directory.ts'
import type { AccountDirectorySnapshot } from './account-directory.ts'
import type { RegistrationClientState, RegistrationStatus } from './registration-client.ts'
import type { TeamsConnectionHistoryEntry } from './teams-connection-history.ts'

/**
 * Teams membership and role view (owner: network).
 *
 * It assembles the per-remote-agent frozen `TeamsConnectionStatus` from the
 * three surfaces network already owns: the account directory/route projection,
 * the registration client health, and the live connection observations reported
 * by the session layer. It declares no fourth source and stores nothing.
 *
 * A registry outage is a health fact, not a connection fact: a lost registry
 * never closes, downgrades or rewrites an established channel. Half-open and
 * role facts travel as typed status plus typed connection-history events, never
 * through a Session payload.
 */

export interface MembershipChannelObservation {
  readonly remoteAgentId: string
  readonly connectionId?: string
  readonly state: TeamsConnectionState
  readonly targetGeneration: number
  readonly role?: RelationRole
  readonly observedAt: string
  /** True when the connection is established but its peer stopped answering. */
  readonly halfOpen?: boolean
  readonly error?: AcpFault
}

export interface TeamsMembershipInput {
  readonly localAgentId: string
  readonly directory: AccountDirectorySnapshot
  readonly registration: RegistrationStatus
  readonly channels: readonly MembershipChannelObservation[]
  readonly observedAt: string
}

export interface TeamsMembershipRegistryView {
  readonly state: RegistrationClientState
  /** True when the registry surface is not online; never a reason to drop a channel. */
  readonly degraded: boolean
  readonly endpoint?: string
  readonly lastError?: ServiceError
}

export interface TeamsMembershipEntry {
  readonly remoteAgentId: string
  readonly status: TeamsConnectionStatus
  readonly halfOpen: boolean
  readonly hosts: readonly HostDirectoryEntry[]
  readonly routes: readonly RouteCandidate[]
}

export interface TeamsMembershipView {
  readonly observedAt: string
  readonly localAgentId: string
  readonly registry: TeamsMembershipRegistryView
  readonly entries: readonly TeamsMembershipEntry[]
}

function fail(message: string): never {
  throw new AcpError('INVALID_ACP_FRAME', `teams-membership: ${message}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function registryView(registration: RegistrationStatus): TeamsMembershipRegistryView {
  text(registration.state, 'registration.state')
  return {
    state: registration.state,
    degraded: registration.state !== 'online',
    ...(registration.endpoint === undefined ? {} : { endpoint: registration.endpoint }),
    ...(registration.lastError === undefined ? {} : { lastError: registration.lastError }),
  }
}

function statusOf(observation: MembershipChannelObservation): TeamsConnectionStatus {
  const remoteAgentId = text(observation.remoteAgentId, 'channel.remoteAgentId')
  text(observation.observedAt, 'channel.observedAt')
  return parseTeamsConnectionStatus({
    version: TEAMS_CONNECTION_STATUS_VERSION,
    remoteAgentId,
    state: observation.state,
    targetGeneration: observation.targetGeneration,
    observedAt: observation.observedAt,
    ...(observation.connectionId === undefined ? {} : { connectionId: observation.connectionId }),
    ...(observation.role === undefined ? {} : { role: observation.role }),
    ...(observation.state === 'failed' ? { error: observation.error } : {}),
  })
}

export function projectTeamsMembership(input: TeamsMembershipInput): TeamsMembershipView {
  const localAgentId = text(input.localAgentId, 'localAgentId')
  text(input.observedAt, 'observedAt')
  const entries: TeamsMembershipEntry[] = []
  const seen = new Set<string>()

  const enrich = (remoteAgentId: string, status: TeamsConnectionStatus, halfOpen: boolean): TeamsMembershipEntry => {
    const hosts = input.directory.hosts.filter(host => host.agentId === remoteAgentId)
    return {
      remoteAgentId,
      status,
      halfOpen,
      hosts,
      routes: hosts.flatMap(host => host.routeCandidates),
    }
  }

  for (const observation of input.channels) {
    // One entry per remote agent. When a remote has several channels the first
    // observation in caller order owns the entry; the view never merges them.
    if (seen.has(observation.remoteAgentId)) continue
    const status = statusOf(observation)
    seen.add(status.remoteAgentId)
    entries.push(enrich(status.remoteAgentId, status, observation.halfOpen === true))
  }

  for (const peerState of input.directory.peerStates ?? []) {
    if (seen.has(peerState.agentId)) continue
    seen.add(peerState.agentId)
    // A directory-known remote with no channel has no connection; the view says
    // `disconnected` and never fabricates one.
    const status = parseTeamsConnectionStatus({
      version: TEAMS_CONNECTION_STATUS_VERSION,
      remoteAgentId: peerState.agentId,
      state: 'disconnected',
      targetGeneration: peerState.generation,
      observedAt: input.observedAt,
    })
    entries.push(enrich(status.remoteAgentId, status, false))
  }

  entries.sort((left, right) => left.remoteAgentId < right.remoteAgentId ? -1 : left.remoteAgentId > right.remoteAgentId ? 1 : 0)
  return { observedAt: input.observedAt, localAgentId, registry: registryView(input.registration), entries }
}

/**
 * Typed connection/role history events for a membership transition.
 *
 * A degraded registry produces one registry event and never a `connection.closed`
 * event. Per-connection events carry the remote agent id; the daemon-wide
 * registry event carries the local agent id.
 */
export function membershipHistoryEvents(
  previous: TeamsMembershipView | undefined,
  next: TeamsMembershipView,
): readonly TeamsConnectionHistoryEntry[] {
  const events: TeamsConnectionHistoryEntry[] = []
  const registryBase = { agentId: next.localAgentId, occurredAt: next.observedAt }
  if (previous !== undefined && previous.registry.degraded !== next.registry.degraded) {
    // The registry `ServiceError` code is not an `AcpFaultCode`; the event keeps
    // the transition only and never invents a fault code.
    events.push({
      ...registryBase,
      event: next.registry.degraded ? 'connection.registry-lost' : 'connection.registry-restored',
    })
  }

  const previousByAgent = new Map((previous?.entries ?? []).map(entry => [entry.remoteAgentId, entry]))
  for (const entry of next.entries) {
    const before = previousByAgent.get(entry.remoteAgentId)
    const connectionBase = {
      agentId: entry.remoteAgentId,
      occurredAt: next.observedAt,
      ...(entry.status.connectionId === undefined ? {} : { connectionId: entry.status.connectionId }),
    }
    if (entry.halfOpen && before?.halfOpen !== true) {
      events.push({ ...connectionBase, event: 'connection.half-open' })
    }
    if (before !== undefined && before.status.state !== 'failed' && before.status.state !== 'closed') {
      if (entry.status.state === 'failed') {
        events.push({
          ...connectionBase,
          event: 'connection.failed',
          ...(entry.status.error === undefined ? {} : { error: entry.status.error }),
        })
      } else if (entry.status.state === 'closed') {
        events.push({ ...connectionBase, event: 'connection.closed' })
      }
    }
  }

  for (const [remoteAgentId, before] of previousByAgent) {
    if (next.entries.some(entry => entry.remoteAgentId === remoteAgentId)) continue
    if (before.status.state === 'closed') continue
    events.push({
      agentId: remoteAgentId,
      occurredAt: next.observedAt,
      event: 'connection.closed',
      ...(before.status.connectionId === undefined ? {} : { connectionId: before.status.connectionId }),
    })
  }
  return events
}
