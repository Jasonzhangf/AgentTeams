import type { HostIdentity, RouteCandidate } from './frames.ts'

/** Shared service contracts, revision 1. Declarations do not implement transport or authorization. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type ServiceErrorCode = 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_OPERATION' | 'STALE_GENERATION' | 'REVISION_CONFLICT'
  | 'RESOURCE_EXHAUSTED' | 'CONFLICT' | 'RESULT_UNKNOWN' | 'UNAVAILABLE' | 'UPSTREAM_ERROR'
export interface CliExecutionFailure {
  readonly kind: 'cli'
  readonly code: string
  readonly message: string
  readonly contextId?: string
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly stdout?: string
  readonly stderr?: string
}
export interface ServiceError {
  readonly code: ServiceErrorCode
  readonly message: string
  readonly execution?: CliExecutionFailure
}
export interface AuthenticatedAgent {
  readonly accountId: string
  readonly scopeId: string
  readonly agentId: string
}

export interface OperationDeclaration {
  readonly operation: string
  readonly inputSchema: Readonly<Record<string, JsonValue>>
  readonly outputSchema: Readonly<Record<string, JsonValue>>
  readonly cancellation: 'unsupported' | 'cooperative'
}
export interface ResourceDeclaration {
  readonly resourceId: string
  readonly capacity: number
  readonly unit: 'slot' | 'context'
  readonly sharing: 'exclusive' | 'shared'
  readonly allocationScope: 'request' | 'work'
}
export interface CapabilityDeclaration {
  readonly capabilityId: string
  readonly version: string
  readonly operations: readonly OperationDeclaration[]
  readonly resources: readonly ResourceDeclaration[]
}
export interface AgentDeclaration {
  readonly identity: HostIdentity
  readonly scopeId: string
  readonly revision: number
  readonly capabilities: readonly CapabilityDeclaration[]
  readonly routes: readonly RouteCandidate[]
}
export interface RelayPeer {
  readonly declaration: AgentDeclaration
  readonly connectionId: string
  readonly generation: number
  readonly lastSeenAt: string
  readonly presence: 'online' | 'offline'
}
export interface RelayGrant {
  readonly grantId: string
  readonly accountId: string
  readonly scopeId: string
  readonly sourceAgentId: string
  readonly targetAgentId: string
  readonly sourceGeneration: number
  readonly targetGeneration: number
  readonly expiresAt: string
}
export interface ResourceDemand { readonly resourceId: string; readonly amount: number }
export interface WorkProposal {
  readonly workId: string
  readonly consumerAgentId: string
  readonly providerAgentId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly policyRevision: number
}
export type WorkState = 'accepted' | 'closing' | 'closed' | 'rejected'
export interface AgentWork extends WorkProposal { readonly state: WorkState }
export interface WorkRequestControl {
  readonly workId: string
  readonly requestId: string
  readonly operation: string
  readonly targetGeneration: number
  readonly demands: readonly ResourceDemand[]
}
export interface WorkRequest {
  readonly control: WorkRequestControl
  readonly payload: JsonValue
}
export type RequestState = 'running' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown'
export interface WorkRequestStatus {
  readonly workId: string
  readonly requestId: string
  readonly state: RequestState
  readonly error?: ServiceError
}
export interface WorkReply { readonly control: WorkRequestStatus; readonly payload?: JsonValue }
export interface ResourceAllocation {
  readonly allocationId: string
  readonly workId: string
  readonly requestId?: string
  readonly resourceId: string
  readonly amount: number
  readonly scope: 'request' | 'work'
  readonly state: 'held' | 'released' | 'unknown'
}

export type RelayClientControl =
  | { readonly kind: 'relay.login'; readonly protocolVersion: 2; readonly declaration: AgentDeclaration }
  | { readonly kind: 'relay.publish'; readonly generation: number; readonly declaration: AgentDeclaration }
  | { readonly kind: 'relay.presence'; readonly generation: number }
  | { readonly kind: 'relay.directory'; readonly requestId: string; readonly subscribe: boolean }
  | { readonly kind: 'relay.connect'; readonly requestId: string; readonly generation: number; readonly targetAgentId: string; readonly targetGeneration: number }
  | { readonly kind: 'relay.open'; readonly requestId: string; readonly grantId: string; readonly generation: number }
export type RelayServerControl =
  | { readonly kind: 'relay.admitted'; readonly connectionId: string; readonly generation: number }
  | { readonly kind: 'relay.directory'; readonly requestId: string; readonly revision: number; readonly peers: readonly RelayPeer[] }
  | { readonly kind: 'relay.changed'; readonly revision: number; readonly peer: RelayPeer }
  | { readonly kind: 'relay.grant'; readonly requestId: string; readonly grant: RelayGrant }
  | { readonly kind: 'relay.offer'; readonly grant: RelayGrant }
  | { readonly kind: 'relay.opened'; readonly requestId: string; readonly grantId: string }
  | { readonly kind: 'relay.closed'; readonly grantId: string; readonly error?: ServiceError }
  | { readonly kind: 'relay.error'; readonly requestId?: string; readonly error: ServiceError }

/** Route control is never inferred from opaque data bytes. Encoding belongs to the transport adapter. */
export interface RelayDataControl { readonly grantId: string; readonly generation: number }
