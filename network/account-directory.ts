import type { HostDirectory, HostDirectoryEntry } from '../server/directory.ts'
import { listDirectoryHosts } from '../server/directory.ts'

export interface AccountDirectorySnapshot {
  readonly accountId: string
  readonly generation: number
  readonly confirmedGeneration?: number
  readonly hosts: readonly HostDirectoryEntry[]
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
