import type { ConsoleCommandResultV1, ConsoleServiceError, JsonValue } from '../../../../control-protocol/console-api.ts'
export type {
  ConsoleAgentObservationV1,
  ConsoleClientV1,
  ConsoleCommandResultV1,
  ConsoleCommandV1,
  ConsoleProjectionV1,
  ConsoleProviderView,
  ConsoleSessionEventView,
  JsonValue,
  SessionCancelUnknownDetail,
  SessionCreateResult,
  SessionObservationState,
} from '../../../../control-protocol/console-api.ts'

export {
  parseConsoleAgentObservation,
  parseConsoleSessionEvent,
  parseSessionCancelUnknownDetail,
  parseSessionCreateResult,
} from '../../../../control-protocol/console-api.ts'

export type ServiceError = ConsoleServiceError

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
