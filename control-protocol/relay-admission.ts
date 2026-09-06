import type { RelayServerControl, ServiceErrorCode } from './agent-services.ts'
import { assertEnvelopeKeys } from './json-value.ts'

export class RelayProtocolError extends Error {
  constructor(readonly code: ServiceErrorCode, message: string) { super(message) }
}

const errorCodes: readonly ServiceErrorCode[] = [
  'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATION', 'STALE_GENERATION', 'REVISION_CONFLICT', 'RESOURCE_EXHAUSTED',
  'CONFLICT', 'RESULT_UNKNOWN', 'UNAVAILABLE', 'UPSTREAM_ERROR',
]
type Admission = Extract<RelayServerControl, { kind: 'relay.admitted' | 'relay.error' }>

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected control object')
  return value as Record<string, unknown>
}

/** First server frame only. A directory or arbitrary object cannot imply admission. */
export function parseRelayAdmission(text: string): Admission {
  try {
    const input = object(JSON.parse(text))
    if (input.kind === 'relay.admitted') {
      assertEnvelopeKeys(input, ['kind', 'connectionId', 'generation'], 'relay admission')
      if (typeof input.connectionId !== 'string' || !input.connectionId ||
        !Number.isSafeInteger(input.generation) || (input.generation as number) < 1) throw new Error('invalid admission identity')
      return { kind: 'relay.admitted', connectionId: input.connectionId, generation: input.generation as number }
    }
    if (input.kind === 'relay.error') {
      assertEnvelopeKeys(input, ['kind', 'requestId', 'error'], 'relay error')
      const error = object(input.error)
      assertEnvelopeKeys(error, ['code', 'message'], 'service error')
      if (!errorCodes.includes(error.code as ServiceErrorCode) || typeof error.message !== 'string' ||
        (input.requestId !== undefined && (typeof input.requestId !== 'string' || !input.requestId))) throw new Error('invalid service error')
      return { kind: 'relay.error', error: { code: error.code as ServiceErrorCode, message: error.message },
        ...(input.requestId === undefined ? {} : { requestId: input.requestId as string }) }
    }
    throw new Error('unexpected admission frame')
  } catch {
    throw new RelayProtocolError('INVALID_INPUT', 'relay: invalid admission response')
  }
}
