import type { JsonValue } from './agent-services.ts'
import type { TeamsAgreement } from './teams-connection.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'

/** A complete JSON-RPC object. Teams control never flattens or rewrites it. */
export type AcpFrame = Readonly<Record<string, JsonValue>>
export type AcpRpcId = string | number

export interface AcpChannelRef {
  readonly connectionId: string
  readonly channelId: string
  readonly targetGeneration: number
  readonly engineInstanceId: string
}

export interface AcpIngress extends AcpChannelRef {
  readonly frame: AcpFrame
}

export interface AcpDelivery extends AcpIngress {
  /** The channel owner assigns this value in monotonically increasing order. */
  readonly sequence: number
}

export type AcpFaultCode =
  | 'INVALID_ACP_FRAME'
  | 'UNSUPPORTED_METHOD'
  | 'UNSUPPORTED_CAPABILITY'
  | 'UNSUPPORTED_POLICY'
  | 'UNSUPPORTED_CONFIGURATION'
  | 'CAPABILITY_DENIED'
  | 'AUTHENTICATION_REQUIRED'
  | 'STALE_GENERATION'
  | 'SESSION_OWNERSHIP_CONFLICT'
  | 'CALLBACK_UNAVAILABLE'
  | 'ENGINE_UNAVAILABLE'
  | 'RESULT_UNKNOWN'
  | 'HISTORY_UNAVAILABLE'
  | 'CONFLICT'
  | 'FORBIDDEN'

export interface AcpFault {
  readonly code: AcpFaultCode
  readonly message: string
  readonly detail?: JsonValue
}

/** Typed local failure carrier for protocol, transport, and policy boundaries. */
export class AcpError extends Error {
  readonly code: AcpFaultCode
  readonly detail?: JsonValue

  constructor(code: AcpFaultCode, message: string, detail?: JsonValue) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }

  toFault(): AcpFault {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    }
  }
}

export interface HistoryRecord {
  readonly recordId: string
  readonly sequence: number
  readonly occurredAt: string
  readonly agentId: string
  readonly kind: 'request' | 'connection'
  readonly event: string
  readonly connectionId?: string
  readonly channelId?: string
  readonly engineInstanceId?: string
  readonly requestRecordId?: string
  readonly sessionId?: string
  readonly frame?: AcpFrame
  readonly agreement?: TeamsAgreement
  readonly outcome?: 'completed' | 'failed' | 'denied' | 'unknown'
  readonly error?: AcpFault
}

const FAULT_CODES: readonly AcpFaultCode[] = [
  'INVALID_ACP_FRAME',
  'UNSUPPORTED_METHOD',
  'UNSUPPORTED_CAPABILITY',
  'UNSUPPORTED_POLICY',
  'UNSUPPORTED_CONFIGURATION',
  'CAPABILITY_DENIED',
  'AUTHENTICATION_REQUIRED',
  'STALE_GENERATION',
  'SESSION_OWNERSHIP_CONFLICT',
  'CALLBACK_UNAVAILABLE',
  'ENGINE_UNAVAILABLE',
  'RESULT_UNKNOWN',
  'HISTORY_UNAVAILABLE',
  'CONFLICT',
  'FORBIDDEN',
]

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonContainer(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null
}

function isRpcId(value: JsonValue | undefined): value is AcpRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
}

function fail(message: string): never {
  throw new AcpError('INVALID_ACP_FRAME', message)
}

function assertRpcId(value: JsonValue | undefined, path: string): asserts value is AcpRpcId {
  if (!isRpcId(value)) fail(`${path} must be a string or finite safe integer`)
}

function assertMethod(value: JsonValue | undefined, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)
}

function assertErrorObject(value: JsonValue): void {
  if (!isRecord(value)) fail('ACP error must be an object')
  if (!Number.isSafeInteger(value.code)) fail('ACP error.code must be a finite safe integer')
  if (typeof value.message !== 'string' || value.message.length === 0) {
    fail('ACP error.message must be a non-empty string')
  }
  if (Object.hasOwn(value, 'data')) assertJsonValue(value.data, 'ACP error.data')
}

/**
 * Validate a complete JSON-RPC envelope without cloning or coercing it.
 * Legal extension members, `_meta`, params, and results remain untouched.
 */
export function parseAcpFrame(value: unknown): AcpFrame {
  try {
    assertJsonValue(value, 'ACP frame')
  } catch (error) {
    fail(error instanceof Error ? error.message : 'ACP frame must contain only JSON values')
  }
  if (!isRecord(value)) fail('ACP frame must be an object')
  if (value.jsonrpc !== '2.0') fail('ACP frame.jsonrpc must equal "2.0"')

  const hasMethod = Object.hasOwn(value, 'method')
  const hasId = Object.hasOwn(value, 'id')
  const hasResult = Object.hasOwn(value, 'result')
  const hasError = Object.hasOwn(value, 'error')

  if (hasMethod) {
    assertMethod(value.method, 'ACP frame.method')
    if (hasResult || hasError) fail('ACP request or notification cannot contain result or error')
    if (Object.hasOwn(value, 'params') && !isJsonContainer(value.params as JsonValue)) {
      fail('ACP frame.params must be an object or array')
    }
    if (hasId) assertRpcId(value.id, 'ACP frame.id')
    return value
  }

  if (!hasId) fail('ACP response requires an id')
  assertRpcId(value.id, 'ACP frame.id')
  if (hasResult === hasError) fail('ACP response must contain exactly one of result or error')
  if (hasError) assertErrorObject(value.error as JsonValue)
  return value
}

export function parseAcpFault(value: unknown): AcpFault {
  try {
    assertJsonValue(value, 'ACP fault')
    if (!isRecord(value)) throw new AcpError('INVALID_ACP_FRAME', 'ACP fault must be an object')
    assertEnvelopeKeys(value, ['code', 'message', 'detail'], 'ACP fault')
    if (typeof value.code !== 'string' || !FAULT_CODES.includes(value.code as AcpFaultCode)) {
      throw new AcpError('INVALID_ACP_FRAME', 'ACP fault.code is unsupported')
    }
    if (typeof value.message !== 'string' || value.message.length === 0) {
      throw new AcpError('INVALID_ACP_FRAME', 'ACP fault.message must be a non-empty string')
    }
    if (value.detail !== undefined) assertJsonValue(value.detail, 'ACP fault.detail')
    return value as unknown as AcpFault
  } catch (error) {
    if (error instanceof AcpError) throw error
    throw new AcpError('INVALID_ACP_FRAME', error instanceof Error ? error.message : 'ACP fault is invalid')
  }
}
