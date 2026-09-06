import type { JsonValue, ServiceError, ServiceErrorCode } from './agent-services.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'

/** Console config errors retain their owning service's code and provider/status context. */
export interface ConsoleServiceError extends Omit<ServiceError, 'code'> {
  readonly code: ServiceErrorCode | 'CREDENTIAL_UNAVAILABLE'
  readonly message: string
  readonly status?: number
  readonly providerInstanceId?: string
}

/** Console transport DTOs. Daemons own the source state and command authorization. */
export interface ConsoleProviderView {
  readonly id: string
  readonly label: string
  readonly protocol: 'openai-chat' | 'openai-responses'
  readonly apiBaseUrl: string
  readonly enabled: boolean
  readonly authKind: 'none' | 'bearer'
  readonly catalogState: 'ready' | 'empty' | 'stale' | 'error'
  readonly models: readonly { readonly id: string; readonly label?: string }[]
  readonly error?: ConsoleServiceError
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
    readonly permissionId?: string
  }[]
  readonly configs: readonly {
    readonly agentId: string; readonly acceptedRevision: number; readonly effectiveRevision?: number
    readonly providers: readonly ConsoleProviderView[]; readonly error?: ConsoleServiceError
  }[]
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
  | { readonly ok: false; readonly error: ConsoleServiceError }

/** Host binding; no success is inferred when the transport or daemon reports failure. */
export interface ConsoleClientV1 {
  readProjection(): Promise<ConsoleProjectionV1>
  command(command: ConsoleCommandV1): Promise<ConsoleCommandResultV1>
  /** Dedicated Session data ingress; business content never enters a host command. */
  sendSession(target: { readonly agentId: string; readonly sessionId: string }, payload: JsonValue): Promise<ConsoleCommandResultV1>
}

/** Validate the closed control envelope before dispatch; authorization stays at the daemon. */
export function parseConsoleCommand(value: unknown): ConsoleCommandV1 {
  assertJsonValue(value, 'Console command')
  const command = object(value)
  text(command.agentId)
  let fields: readonly string[]
  switch (command.kind) {
    case 'session.open': fields = ['sessionId']; text(command.sessionId); break
    case 'permission.reply':
      fields = ['sessionId', 'permissionId', 'decision']
      text(command.sessionId); text(command.permissionId)
      if (!['once', 'always', 'reject'].includes(command.decision as string)) throw new Error('Invalid permission decision')
      break
    case 'notification.ack': fields = ['notificationId']; text(command.notificationId); break
    case 'config.refreshModels':
      fields = ['expectedRevision', 'providerId']; revision(command.expectedRevision); text(command.providerId); break
    case 'config.bindModel':
      fields = ['expectedRevision', 'providerId', 'modelId']
      revision(command.expectedRevision); text(command.providerId); text(command.modelId); break
    case 'config.apply': fields = []; break
    case 'config.putProvider': {
      fields = ['expectedRevision', 'provider']; revision(command.expectedRevision)
      const provider = object(command.provider)
      assertEnvelopeKeys(provider, ['id', 'label', 'protocol', 'apiBaseUrl', 'enabled', 'auth'], 'Console provider')
      text(provider.id); text(provider.label); text(provider.apiBaseUrl)
      if (!['openai-chat', 'openai-responses'].includes(provider.protocol as string) || typeof provider.enabled !== 'boolean') throw new Error('Invalid provider declaration')
      const auth = object(provider.auth)
      if (auth.kind === 'none') assertEnvelopeKeys(auth, ['kind'], 'Provider auth')
      else if (auth.kind === 'bearer') {
        assertEnvelopeKeys(auth, ['kind', 'credentialRef'], 'Provider auth'); text(auth.credentialRef)
      } else throw new Error('Invalid provider authentication kind')
      break
    }
    default: throw new Error('Unknown Console command')
  }
  assertEnvelopeKeys(command, ['kind', 'agentId', ...fields], 'Console command')
  return command as unknown as ConsoleCommandV1
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Console control must be an object')
  return value as Record<string, unknown>
}
function text(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Console control requires a non-empty string')
}
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid config revision')
}
