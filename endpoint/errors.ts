export const ENDPOINT_ERROR_CODES = [
  'INVALID_IDENTITY',
  'INVALID_REVISION',
  'INVALID_LIFECYCLE',
  'DUPLICATE_ENDPOINT_ID',
  'CROSS_AGENT_OWNERSHIP',
  'CAPABILITY_OUTSIDE_ENDPOINT',
  'RESOURCE_OUTSIDE_ENDPOINT',
  'ENDPOINT_DISABLED',
  'STALE_REVISION',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_INPUT',
] as const

export type EndpointErrorCode = (typeof ENDPOINT_ERROR_CODES)[number]

export interface EndpointError extends Error {
  readonly name: 'EndpointError'
  readonly code: EndpointErrorCode
}

export function isEndpointError(error: unknown): error is EndpointError {
  return error instanceof Error && error.name === 'EndpointError' && ENDPOINT_ERROR_CODES.includes((error as EndpointError).code)
}

export function fail(code: EndpointErrorCode, message: string): never {
  const error = new Error(`${code}: ${message}`) as EndpointError
  Object.defineProperty(error, 'name', { value: 'EndpointError' })
  Object.defineProperty(error, 'code', { value: code, enumerable: true })
  throw error
}
