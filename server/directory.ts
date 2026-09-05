export type HostHealthState = 'starting' | 'ready' | 'error' | 'stale'
export type RouteCandidateKind = 'lan' | 'tailscale' | 'ipv6' | 'ipv4' | 'gateway' | 'relay-ws' | 'relay-webrtc'

export interface RouteCandidate {
  readonly candidateId: string
  readonly kind: RouteCandidateKind
  readonly endpoint?: string
  readonly port?: number
  readonly authRequired: boolean
  readonly lastSeenAt: string
}

export interface HostDirectoryEntry {
  readonly hostId: string
  readonly machineId: string
  readonly agentId: string
  readonly agentKind: 'opencode' | 'acp' | 'custom'
  readonly accountId: string
  readonly capabilitiesRevision: string
  readonly health: HostHealthState
  readonly routeCandidates: readonly RouteCandidate[]
  readonly updatedAt: string
  readonly lastSeenAt: string
}

export interface HostDirectory {
  readonly generation: number
  readonly hosts: ReadonlyMap<string, HostDirectoryEntry>
}

export type HostDirectoryInput = Omit<HostDirectoryEntry, 'health' | 'lastSeenAt' | 'updatedAt'>
  & { readonly health?: HostHealthState; readonly lastSeenAt?: string }

const BUSINESS_PAYLOAD_KEYS = ['sessionId', 'permissionId', 'notificationId', 'requestId'] as const

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`directory: ${label} is required`)
  return value
}

function assertNoBusinessPayload(input: HostDirectoryInput): void {
  for (const key of BUSINESS_PAYLOAD_KEYS) {
    if (key in input) throw new Error(`directory: business payload field ${key} is forbidden`)
  }
  for (const candidate of input.routeCandidates ?? []) {
    for (const key of BUSINESS_PAYLOAD_KEYS) {
      if (key in candidate) throw new Error(`directory: route candidate business field ${key} is forbidden`)
    }
  }
}

function normalizeRouteCandidates(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  return candidates.map((candidate) => {
    requiredString(candidate.candidateId, 'candidateId')
    if (candidate.endpoint !== undefined && !candidate.endpoint.startsWith('http://') && !candidate.endpoint.startsWith('https://')) {
      throw new Error('directory: route endpoint must use http:// or https://')
    }
    if (candidate.port !== undefined && (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535)) {
      throw new Error('directory: route port must be between 1 and 65535')
    }
    return {
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      ...(candidate.endpoint === undefined ? {} : { endpoint: candidate.endpoint }),
      ...(candidate.port === undefined ? {} : { port: candidate.port }),
      authRequired: candidate.authRequired,
      lastSeenAt: candidate.lastSeenAt,
    }
  })
}

export function createHostDirectory(): HostDirectory {
  return { generation: 0, hosts: new Map() }
}

export function upsertDirectoryHost(directory: HostDirectory, input: HostDirectoryInput, now = new Date().toISOString()): HostDirectory {
  assertNoBusinessPayload(input)
  const entry: HostDirectoryEntry = {
    hostId: requiredString(input.hostId, 'hostId'),
    machineId: requiredString(input.machineId, 'machineId'),
    agentId: requiredString(input.agentId, 'agentId'),
    agentKind: input.agentKind,
    accountId: requiredString(input.accountId, 'accountId'),
    capabilitiesRevision: requiredString(input.capabilitiesRevision, 'capabilitiesRevision'),
    health: input.health ?? 'starting',
    routeCandidates: normalizeRouteCandidates(input.routeCandidates),
    updatedAt: now,
    lastSeenAt: input.lastSeenAt ?? now,
  }
  const hosts = new Map(directory.hosts)
  hosts.set(entry.hostId, entry)
  return { generation: directory.generation + 1, hosts }
}

export function touchHostPresence(directory: HostDirectory, hostId: string, now = new Date().toISOString()): HostDirectory {
  const previous = directory.hosts.get(hostId)
  if (!previous) throw new Error(`directory: unknown host ${hostId}`)
  const hosts = new Map(directory.hosts)
  hosts.set(hostId, {
    ...previous,
    health: 'ready',
    updatedAt: now,
    lastSeenAt: now,
  })
  return { generation: directory.generation + 1, hosts }
}

export function removeDirectoryHost(directory: HostDirectory, hostId: string): HostDirectory {
  if (!directory.hosts.has(hostId)) throw new Error(`directory: unknown host ${hostId}`)
  const hosts = new Map(directory.hosts)
  hosts.delete(hostId)
  return { generation: directory.generation + 1, hosts }
}

export function removeStaleHosts(directory: HostDirectory, now = new Date().toISOString(), staleAfterMs = 90_000): HostDirectory {
  const cutoff = Date.parse(now) - staleAfterMs
  const hosts = new Map(directory.hosts)
  for (const [hostId, entry] of hosts) {
    const seen = Date.parse(entry.lastSeenAt)
    if (!Number.isFinite(seen) || seen < cutoff) {
      hosts.set(hostId, { ...entry, health: 'stale' })
    }
  }
  if (hosts.size === directory.hosts.size && [...hosts.entries()].every(([hostId, entry]) => {
    const previous = directory.hosts.get(hostId)
    return previous && previous.health === entry.health && previous.lastSeenAt === entry.lastSeenAt
  })) {
    return directory
  }
  return { generation: directory.generation + 1, hosts }
}

export function listDirectoryHosts(directory: HostDirectory, accountId?: string): readonly HostDirectoryEntry[] {
  return [...directory.hosts.values()]
    .filter((entry) => accountId === undefined || entry.accountId === accountId)
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
}
