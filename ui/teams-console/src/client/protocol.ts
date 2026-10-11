import type {
  ConsoleClientV1,
  ConsoleCommandResultV1,
  ConsoleServiceError,
  JsonValue,
} from '../../../../control-protocol/console-api.ts'
import type {
  ConsoleProjectionSnapshot,
  ConsoleProjectionSink,
  ConsoleProjectionUnsubscribe,
  HistoryPage,
  HistoryQuery,
  TeamsConnectionState,
  TeamsConnectionStatus,
} from '../../../../control-protocol/teams-state.ts'

export type {
  ConsoleAgentObservationV1,
  ConsoleCapabilityDetail,
  ConsoleClientV1,
  ConsoleCommandResultV1,
  ConsoleCommandV1,
  ConsoleConnectionView,
  ConsolePermissionOption,
  ConsolePermissionOptionKind,
  ConsoleProjectionV1,
  ConsoleProviderView,
  ConsoleSessionEventView,
  JsonValue,
  PermissionReplyResult,
  SessionCancelUnknownDetail,
  SessionCreateResult,
  SessionObservationState,
} from '../../../../control-protocol/console-api.ts'

export type {
  ConsoleProjectionSnapshot,
  ConsoleProjectionSink,
  ConsoleProjectionUnsubscribe,
  HistoryPage,
  HistoryQuery,
  TeamsConnectionState,
  TeamsConnectionStatus,
} from '../../../../control-protocol/teams-state.ts'

export {
  parseConsoleAgentObservation,
  parseConsoleSessionEvent,
  parsePermissionReplyResult,
  parseSessionCancelConfirmed,
  parseSessionCancelUnknownDetail,
  parseSessionCreateResult,
} from '../../../../control-protocol/console-api.ts'

export {
  parseConsoleProjectionSnapshot,
  parseTeamsConnectionState,
  parseTeamsConnectionStatus,
} from '../../../../control-protocol/teams-state.ts'

export type ServiceError = ConsoleServiceError

/** UI-owned ADDITIVE capability extending the frozen canonical `ConsoleClientV1`. */
export type TeamsConsoleClientV1 = ConsoleClientV1 & {
  readonly readHistory: (query: HistoryQuery) => Promise<HistoryPage>
  readonly subscribeProjection: (sink: ConsoleProjectionSink) => ConsoleProjectionUnsubscribe
}

/** The D07 live client is the canonical client plus UI-owned read/event capabilities. */
export type TeamsConsoleLiveClientV1 = ConsoleClientV1 & TeamsConsoleClientV1

export function isServiceError(value: unknown): value is ServiceError {
  if (typeof value !== 'object' || value === null) return false
  const error = value as { readonly code?: unknown; readonly message?: unknown }
  return typeof error.code === 'string' && typeof error.message === 'string'
}

export function formatServiceError(error: ServiceError): string {
  const base = `${error.code}: ${error.message}`
  if (error.detail === undefined) return base
  const detail = error.detail
  const fields = [
    `sessionId=${detail.sessionId}`,
    `reason=${detail.reason}`,
    `reconciliation=${detail.reconciliation}`,
    `finalState=${detail.finalState}`,
    `baseAccepted=${detail.baseAccepted === undefined ? 'absent' : String(detail.baseAccepted)}`,
    ...(detail.operationId === undefined ? [] : [`operationId=${detail.operationId}`]),
    ...(detail.abortOperationId === undefined ? [] : [`abortOperationId=${detail.abortOperationId}`]),
  ]
  return `${base} (${fields.join(', ')})`
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
