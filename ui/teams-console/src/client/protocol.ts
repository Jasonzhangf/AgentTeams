export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type ServiceErrorCode = 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_OPERATION' | 'STALE_GENERATION' | 'REVISION_CONFLICT'
  | 'RESOURCE_EXHAUSTED' | 'CONFLICT' | 'RESULT_UNKNOWN' | 'UNAVAILABLE' | 'UPSTREAM_ERROR' | 'CREDENTIAL_UNAVAILABLE'
export interface ServiceError { readonly code: ServiceErrorCode; readonly message: string; readonly status?: number; readonly providerInstanceId?: string }

export interface ConsoleProviderView {
  readonly id: string
  readonly label: string
  readonly protocol: 'openai-chat' | 'openai-responses'
  readonly apiBaseUrl: string
  readonly enabled: boolean
  readonly authKind: 'none' | 'bearer'
  readonly catalogState: 'ready' | 'empty' | 'stale' | 'error'
  readonly models: readonly { readonly id: string; readonly label?: string }[]
  readonly error?: ServiceError
}

export interface ConsoleSessionEventView {
  readonly eventId: string
  readonly agentId: string
  readonly sessionId: string
  readonly kind: 'message' | 'tool' | 'approval' | 'notification'
  readonly title: string
  readonly occurredAt?: string
  readonly state?: 'pending' | 'running' | 'succeeded' | 'failed' | 'resolved' | 'unknown'
  readonly detail?: string
  readonly permissionId?: string
}

export interface ConsoleProjectionV1 {
  readonly version: 1
  readonly agents: readonly {
    readonly agentId: string
    readonly label: string
    readonly machineId: string
    readonly presence: 'online' | 'offline' | 'unknown'
    readonly capabilities: readonly string[]
    readonly currentSessionId?: string
    readonly providerId?: string
    readonly modelId?: string
  }[]
  readonly sessions: readonly { readonly agentId: string; readonly sessionId: string; readonly title?: string }[]
  readonly notifications: readonly {
    readonly agentId: string; readonly notificationId: string; readonly sessionId?: string
    readonly kind: 'notice' | 'permission'; readonly state: 'pending' | 'resolved'; readonly title: string
    readonly permissionId?: string; readonly priority?: 'low' | 'normal' | 'high' | 'critical'
    readonly occurredAt?: string; readonly detail?: string
  }[]
  readonly configs: readonly {
    readonly agentId: string; readonly acceptedRevision: number; readonly effectiveRevision?: number
    readonly providers: readonly ConsoleProviderView[]; readonly error?: ServiceError
  }[]
  /** Optional owner-projected Session activity. The UI never appends to or persists this stream. */
  readonly sessionEvents?: readonly ConsoleSessionEventView[]
}

export type ConsoleCommandV1 =
  | { readonly kind: 'session.open'; readonly agentId: string; readonly sessionId: string }
  | { readonly kind: 'permission.reply'; readonly agentId: string; readonly sessionId: string; readonly permissionId: string; readonly decision: 'once' | 'always' | 'reject' }
  | { readonly kind: 'notification.ack'; readonly agentId: string; readonly notificationId: string }
  | { readonly kind: 'config.refreshModels'; readonly agentId: string; readonly expectedRevision: number; readonly providerId: string }
  | { readonly kind: 'config.bindModel'; readonly agentId: string; readonly expectedRevision: number; readonly providerId: string; readonly modelId: string }
  | { readonly kind: 'config.apply'; readonly agentId: string }
  | { readonly kind: 'config.putProvider'; readonly agentId: string; readonly expectedRevision: number;
      readonly provider: { readonly id: string; readonly label: string; readonly protocol: ConsoleProviderView['protocol']; readonly apiBaseUrl: string; readonly enabled: boolean;
        readonly auth: { readonly kind: 'none' } | { readonly kind: 'bearer'; readonly credentialRef: string } } }
export type ConsoleCommandResultV1 =
  | { readonly ok: true; readonly result?: JsonValue }
  | { readonly ok: false; readonly error: ServiceError }

export interface ConsoleClientV1 {
  readProjection(): Promise<ConsoleProjectionV1>
  command(command: ConsoleCommandV1): Promise<ConsoleCommandResultV1>
  sendSession(target: { readonly agentId: string; readonly sessionId: string }, payload: JsonValue): Promise<ConsoleCommandResultV1>
}

export function isServiceError(value: unknown): value is ServiceError {
  if (typeof value !== 'object' || value === null) return false
  const error = value as { readonly code?: unknown; readonly message?: unknown }
  return typeof error.code === 'string' && typeof error.message === 'string'
}

export function formatServiceError(error: ServiceError): string {
  return `${error.code}: ${error.message}`
}

export function isCommandFailure(result: ConsoleCommandResultV1): result is { readonly ok: false; readonly error: ServiceError } {
  return result.ok === false
}

export function commandFailureMessage(result: ConsoleCommandResultV1): string | undefined {
  return isCommandFailure(result) ? formatServiceError(result.error) : undefined
}

export function asJsonValue(value: string): JsonValue {
  return value
}
