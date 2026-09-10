import type { ServiceErrorCode } from '../control-protocol/agent-services.ts'
import { resolveHostFromDirectory, type AccountDirectorySnapshot } from './account-directory.ts'
import { activeDirectWssCandidate, buildDirectWssRoutePlan, type RoutePlan } from './route-plan.ts'
import { connectDirectWssTarget, type DirectWssTarget, type DirectWssTargetOptions } from './direct-route.ts'
import type { RouteCandidate } from '../server/directory.ts'
import type { WssConnectionOptions } from './wss-connection.ts'

type HostDirectoryEntry = AccountDirectorySnapshot['hosts'][number]
type RelayCandidateKind = 'relay-ws' | 'relay-webrtc'

export type PeerRouteErrorCode = Extract<ServiceErrorCode, 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'STALE_GENERATION' | 'RESULT_UNKNOWN' | 'UNAVAILABLE'>

export class PeerRouteError extends Error {
  constructor(readonly code: PeerRouteErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
  }
}

export interface PeerRouteBinding {
  readonly kind: 'direct-wss' | RelayCandidateKind
  readonly connectionId: string
  readonly connectionGeneration: number
  readonly directoryGeneration: number
  readonly targetGeneration: number
  readonly candidateId: string
}

export interface PeerRouteConnectionBinding {
  readonly connectionId: string
  readonly connectionGeneration: number
}

export interface PeerRouteExpectedBinding extends PeerRouteConnectionBinding {
  readonly directoryGeneration: number
  readonly targetGeneration: number
}

export interface DirectPeerRouteInput {
  readonly directory: AccountDirectorySnapshot
  readonly hostId: string
  readonly targetCandidateId: string
  readonly targetGeneration: number
  readonly protocolVersion: number
  readonly binding: PeerRouteConnectionBinding
  readonly transport: Omit<WssConnectionOptions, 'endpoint'>
  readonly helloTimeoutMs: number
}

export interface RelayPeerRouteInput {
  readonly directory: AccountDirectorySnapshot
  readonly hostId: string
  readonly targetCandidateId: string
  readonly targetGeneration: number
  readonly binding: PeerRouteConnectionBinding
}

export interface DirectPeerRouteOptions extends DirectWssTargetOptions {
  readonly kind: 'direct-wss'
  readonly peerRoute: PeerRouteBinding & { readonly kind: 'direct-wss' }
}

export interface RelayPeerRouteOptions {
  readonly kind: 'relay'
  readonly peerRoute: PeerRouteBinding & { readonly kind: RelayCandidateKind }
  readonly target: {
    readonly hostId: string
    readonly agentId: string
    readonly capabilitiesRevision: string
    readonly targetGeneration: number
  }
}

export type PeerRouteOptions = DirectPeerRouteOptions | RelayPeerRouteOptions

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PeerRouteError('INVALID_INPUT', `peer-route: ${label} is required`)
  }
  return value
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PeerRouteError('INVALID_INPUT', `peer-route: ${label} must be a positive safe integer`)
  }
  return value as number
}

function confirmedDirectoryGeneration(directory: AccountDirectorySnapshot): number {
  if (directory.confirmedGeneration === undefined) {
    throw new PeerRouteError('STALE_GENERATION', 'peer-route: confirmed directory generation is required')
  }
  if (directory.confirmedGeneration !== directory.generation) {
    throw new PeerRouteError('STALE_GENERATION', 'peer-route: confirmed directory generation is stale')
  }
  return directory.confirmedGeneration
}

function readyPeer(directory: AccountDirectorySnapshot, hostId: string): HostDirectoryEntry {
  const resolvedHostId = requiredString(hostId, 'hostId')
  let peer: HostDirectoryEntry
  try {
    peer = resolveHostFromDirectory(directory, resolvedHostId)
  } catch (error) {
    throw new PeerRouteError('NOT_FOUND', `peer-route: unknown peer host ${resolvedHostId}`, error)
  }
  if (peer.accountId !== directory.accountId) {
    throw new PeerRouteError('INVALID_INPUT', 'peer-route: peer host is outside the confirmed account directory')
  }
  requiredString(peer.agentId, 'agentId')
  requiredString(peer.capabilitiesRevision, 'capabilitiesRevision')
  if (peer.health !== 'ready') {
    throw new PeerRouteError('UNAVAILABLE', `peer-route: peer host is not ready (${peer.health})`)
  }
  return peer
}

function selectedCandidate(peer: HostDirectoryEntry, candidateId: string): RouteCandidate {
  const selected = peer.routeCandidates.find(candidate => candidate.candidateId === requiredString(candidateId, 'targetCandidateId'))
  if (!selected) throw new PeerRouteError('INVALID_INPUT', 'peer-route: selected target candidate is missing')
  return selected
}

function bindingFor(
  directoryGeneration: number,
  targetGeneration: number,
  binding: PeerRouteConnectionBinding,
  kind: PeerRouteBinding['kind'],
  candidateId: string,
): PeerRouteBinding {
  return {
    kind,
    connectionId: requiredString(binding.connectionId, 'connectionId'),
    connectionGeneration: positiveSafeInteger(binding.connectionGeneration, 'connectionGeneration'),
    directoryGeneration,
    targetGeneration: positiveSafeInteger(targetGeneration, 'targetGeneration'),
    candidateId: requiredString(candidateId, 'targetCandidateId'),
  }
}

function validateProtocolAndTimeout(protocolVersion: number, helloTimeoutMs: number): void {
  positiveSafeInteger(protocolVersion, 'protocol version')
  positiveSafeInteger(helloTimeoutMs, 'hello timeout')
  if (helloTimeoutMs > 2_147_483_647) {
    throw new PeerRouteError('INVALID_INPUT', 'peer-route: hello timeout must be a valid positive timer duration')
  }
}

function validateTransport(transport: Omit<WssConnectionOptions, 'endpoint'>): void {
  if (typeof transport.credential !== 'string' || transport.credential.length === 0 || /[\r\n]/.test(transport.credential)) {
    throw new PeerRouteError('INVALID_INPUT', 'peer-route: a valid authorization credential is required')
  }
  for (const key of ['connectTimeoutMs', 'maxMessageBytes', 'maxBufferedBytes', 'maxPendingFrames'] as const) {
    positiveSafeInteger(transport[key], key)
  }
  if (transport.connectTimeoutMs > 2_147_483_647) {
    throw new PeerRouteError('INVALID_INPUT', 'peer-route: connection timeout exceeds timer range')
  }
}

function relayKind(candidate: RouteCandidate): RelayCandidateKind {
  if (candidate.kind !== 'relay-ws' && candidate.kind !== 'relay-webrtc') {
    throw new PeerRouteError('INVALID_INPUT', 'peer-route: selected target candidate is a direct candidate')
  }
  return candidate.kind
}

export function assembleDirectWssTargetOptions(input: DirectPeerRouteInput): DirectPeerRouteOptions {
  const directoryGeneration = confirmedDirectoryGeneration(input.directory)
  const peer = readyPeer(input.directory, input.hostId)
  const targetCandidate = selectedCandidate(peer, input.targetCandidateId)
  if (targetCandidate.kind === 'relay-ws' || targetCandidate.kind === 'relay-webrtc') {
    throw new PeerRouteError('INVALID_INPUT', 'peer-route: selected target candidate is a relay candidate')
  }
  validateProtocolAndTimeout(input.protocolVersion, input.helloTimeoutMs)
  validateTransport(input.transport)
  let plan: RoutePlan
  let candidate: ReturnType<typeof activeDirectWssCandidate>
  try {
    plan = buildDirectWssRoutePlan({
      hostId: peer.hostId,
      directoryGeneration,
      policy: 'manual',
      candidates: [targetCandidate],
      targetCandidateId: input.targetCandidateId,
    })
    candidate = activeDirectWssCandidate(plan)
  } catch (error) {
    throw new PeerRouteError('INVALID_INPUT', error instanceof Error ? `peer-route: ${error.message}` : 'peer-route: direct route is invalid', error)
  }
  return {
    kind: 'direct-wss',
    transport: { ...input.transport, endpoint: candidate.endpoint },
    hello: {
      hostId: peer.hostId,
      agentId: peer.agentId,
      targetGeneration: input.targetGeneration,
      protocolVersion: input.protocolVersion,
      capabilitiesRevision: peer.capabilitiesRevision,
    },
    plan,
    helloTimeoutMs: input.helloTimeoutMs,
    peerRoute: bindingFor(directoryGeneration, input.targetGeneration, input.binding, 'direct-wss', targetCandidate.candidateId) as PeerRouteBinding & { readonly kind: 'direct-wss' },
  }
}

export function assembleRelayPeerRoute(input: RelayPeerRouteInput): RelayPeerRouteOptions {
  const directoryGeneration = confirmedDirectoryGeneration(input.directory)
  const peer = readyPeer(input.directory, input.hostId)
  const candidate = selectedCandidate(peer, input.targetCandidateId)
  const kind = relayKind(candidate)
  const peerRoute = bindingFor(directoryGeneration, input.targetGeneration, input.binding, kind, candidate.candidateId)
  return {
    kind: 'relay',
    peerRoute: peerRoute as PeerRouteBinding & { readonly kind: RelayCandidateKind },
    target: {
      hostId: peer.hostId,
      agentId: peer.agentId,
      capabilitiesRevision: peer.capabilitiesRevision,
      targetGeneration: input.targetGeneration,
    },
  }
}

export function assemblePeerRoute(input: DirectPeerRouteInput | RelayPeerRouteInput): PeerRouteOptions {
  return 'transport' in input ? assembleDirectWssTargetOptions(input) : assembleRelayPeerRoute(input)
}

export function connectDirectPeerRoute(input: DirectPeerRouteInput): Promise<DirectWssTarget> {
  return connectDirectWssTarget(assembleDirectWssTargetOptions(input))
}

export function assertPeerRouteBinding(
  route: PeerRouteBinding,
  expected: PeerRouteExpectedBinding,
): void {
  if (route.connectionId !== requiredString(expected.connectionId, 'connectionId')) {
    throw new PeerRouteError('CONFLICT', 'peer-route: connection binding does not match the selected route')
  }
  if (route.connectionGeneration !== positiveSafeInteger(expected.connectionGeneration, 'connectionGeneration')) {
    throw new PeerRouteError('STALE_GENERATION', 'peer-route: connection generation is stale')
  }
  if (route.directoryGeneration !== positiveSafeInteger(expected.directoryGeneration, 'directoryGeneration')) {
    throw new PeerRouteError('STALE_GENERATION', 'peer-route: directory generation is stale')
  }
  if (route.targetGeneration !== positiveSafeInteger(expected.targetGeneration, 'targetGeneration')) {
    throw new PeerRouteError('STALE_GENERATION', 'peer-route: target generation is stale')
  }
}
