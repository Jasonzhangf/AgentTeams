import type { ConsoleCommandResultV1, ConsoleServiceError, JsonValue } from '../../../../control-protocol/console-api.ts'
export type {
  ConsoleClientV1,
  ConsoleCommandResultV1,
  ConsoleCommandV1,
  ConsoleProjectionV1,
  ConsoleProviderView,
  ConsoleSessionEventView,
  JsonValue,
} from '../../../../control-protocol/console-api.ts'

export type ServiceError = ConsoleServiceError

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
