import type { RelayPeer } from '../control-protocol/agent-services.ts'
import type { HostDirectory, HostDirectoryEntry, HostDirectoryInput } from '../server/directory.ts'
import { createHostDirectory, listDirectoryHosts, upsertDirectoryHost } from '../server/directory.ts'

export interface AccountDirectoryPeerState {
  readonly hostId: string
  readonly agentId: string
  readonly scopeId: string
  readonly generation: number
  readonly presence: RelayPeer['presence']
}

export interface AccountDirectorySnapshot {
  readonly accountId: string
  readonly scopeId?: string
  readonly generation: number
  readonly confirmedGeneration?: number
  readonly hosts: readonly HostDirectoryEntry[]
  /** Relay connection metadata retained beside the route projection. */
  readonly peerStates?: readonly AccountDirectoryPeerState[]
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`account-directory: ${label} must be a positive integer`)
  return value as number
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`account-directory: ${label} is required`)
  return value
}

/** Projects the admitted Relay directory into the route-oriented account view. */
export function projectRelayDirectory(
  accountId: string,
  revision: number,
  peers: readonly RelayPeer[],
  expectedScopeId?: string,
): AccountDirectorySnapshot {
  const selectedAccountId = requiredString(accountId, 'accountId')
  const admittedScopeId = expectedScopeId === undefined ? undefined : requiredString(expectedScopeId, 'scopeId')
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('account-directory: directory revision must be a non-negative integer')
  if (revision === 0) {
    if (peers.length !== 0) throw new Error('account-directory: initial revision cannot contain peers')
    return {
      accountId: selectedAccountId,
      ...(admittedScopeId === undefined ? {} : { scopeId: admittedScopeId }),
      generation: 0,
      hosts: [],
      peerStates: [],
    }
  }
  const directoryRevision = positiveInteger(revision, 'directory revision')
  let scopeId: string | undefined
  let directory = createHostDirectory()
  const peerStates: AccountDirectoryPeerState[] = []
  const hostIds = new Set<string>()
  for (const peer of peers) {
    const identity = peer.declaration.identity
    const hostId = requiredString(identity.hostId, 'peer.hostId')
    if (hostIds.has(hostId)) throw new Error(`account-directory: duplicate peer host ${hostId}`)
    hostIds.add(hostId)
    const peerScopeId = requiredString(peer.declaration.scopeId, 'peer.scopeId')
    if (identity.accountId !== selectedAccountId) throw new Error(`account-directory: peer ${hostId} is outside account ${selectedAccountId}`)
    if (scopeId === undefined) scopeId = peerScopeId
    else if (scopeId !== peerScopeId) throw new Error('account-directory: peers are from different scopes')
    if (admittedScopeId !== undefined && admittedScopeId !== peerScopeId) throw new Error('account-directory: peer scope does not match the confirmed scope')
    const generation = positiveInteger(peer.generation, `peer ${hostId} generation`)
    const registration: HostDirectoryInput = {
      hostId,
      machineId: requiredString(identity.machineId, `peer ${hostId}.machineId`),
      agentId: requiredString(identity.agentId, `peer ${hostId}.agentId`),
      agentKind: identity.agentKind,
      accountId: selectedAccountId,
      capabilitiesRevision: String(positiveInteger(peer.declaration.revision, `peer ${hostId} declaration revision`)),
      routeCandidates: peer.declaration.routes,
      health: peer.presence === 'online' ? 'ready' : 'stale',
      lastSeenAt: peer.lastSeenAt,
    }
    directory = upsertDirectoryHost(directory, registration, peer.lastSeenAt)
    peerStates.push({ hostId, agentId: registration.agentId, scopeId: peerScopeId, generation, presence: peer.presence })
  }
  const projected: AccountDirectorySnapshot = {
    accountId: selectedAccountId,
    ...((admittedScopeId ?? scopeId) === undefined ? {} : { scopeId: admittedScopeId ?? scopeId }),
    generation: directoryRevision,
    hosts: listDirectoryHosts({ ...directory, generation: directoryRevision }, selectedAccountId),
    peerStates,
  }
  return confirmDirectoryGeneration(projected, directoryRevision)
}

export function refreshRelayDirectory(
  previous: AccountDirectorySnapshot,
  revision: number,
  peers: readonly RelayPeer[],
): AccountDirectorySnapshot {
  const nextRevision = positiveInteger(revision, 'directory revision')
  if (nextRevision < previous.generation) throw new Error('account-directory: relay directory revision went backwards')
  return projectRelayDirectory(previous.accountId, nextRevision, peers, previous.scopeId)
}

export function createAccountDirectorySnapshot(
  directory: HostDirectory,
  accountId: string,
): AccountDirectorySnapshot {
  if (directory.generation < 1) throw new Error('account-directory: no confirmed directory generation')
  return {
    accountId,
    generation: directory.generation,
    hosts: listDirectoryHosts(directory, accountId),
  }
}

export function confirmDirectoryGeneration(
  snapshot: AccountDirectorySnapshot,
  confirmedGeneration: number,
): AccountDirectorySnapshot {
  if (!Number.isInteger(confirmedGeneration) || confirmedGeneration < 1) {
    throw new Error('account-directory: confirmed generation must be a positive integer')
  }
  if (confirmedGeneration !== snapshot.generation) {
    throw new Error('account-directory: confirmed generation must match the current directory generation')
  }
  return { ...snapshot, confirmedGeneration }
}

export function refreshAccountDirectory(
  previous: AccountDirectorySnapshot,
  directory: HostDirectory,
): AccountDirectorySnapshot {
  if (directory.generation < previous.generation) {
    throw new Error('account-directory: directory generation went backwards')
  }
  return createAccountDirectorySnapshot(directory, previous.accountId)
}

export function resolveHostFromDirectory(
  snapshot: AccountDirectorySnapshot,
  hostId: string,
): HostDirectoryEntry {
  const host = snapshot.hosts.find((entry) => entry.hostId === hostId)
  if (!host) throw new Error(`account-directory: unknown host ${hostId}`)
  return host
}
