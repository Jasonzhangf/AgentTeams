import type { JsonValue } from '../control-protocol/agent-services.ts'

export type CliOperation = 'context.create' | 'navigate' | 'snapshot' | 'context.destroy' | 'search'

export interface ContextCreateRequest {
  readonly operation: 'context.create'
  readonly initialUrl?: string
}

export interface NavigateRequest {
  readonly operation: 'navigate'
  readonly contextId: string
  readonly url: string
}

export interface SnapshotRequest {
  readonly operation: 'snapshot'
  readonly contextId: string
}

export interface ContextDestroyRequest {
  readonly operation: 'context.destroy'
  readonly contextId: string
}

export interface SearchRequest {
  readonly operation: 'search'
  readonly query: string
  readonly maxResults?: number
}

export type CliRequest = ContextCreateRequest | NavigateRequest | SnapshotRequest | ContextDestroyRequest | SearchRequest

export interface BrowserContext {
  readonly contextId: string
  readonly profile: string
  readonly sessionId: string
}

export interface ContextCreateResult extends BrowserContext {
  readonly raw: JsonValue
}

export interface NavigateResult {
  readonly contextId: string
  readonly url: string
  readonly navigated: true
  readonly raw: JsonValue
}

export interface SnapshotResult {
  readonly contextId: string
  readonly url: string
  readonly html: string
  readonly raw: JsonValue
}

export interface ContextDestroyResult {
  readonly contextId: string
  readonly profile: string
  readonly state: 'stopped'
  readonly raw: JsonValue
}

export interface SearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
  readonly raw: JsonValue
}

export interface SearchResult {
  readonly query: string
  readonly status: 'matched' | 'no_match'
  readonly exitCode: 0 | 1
  readonly matches: readonly SearchMatch[]
  readonly truncated: boolean
  readonly stdout: string
  readonly stderr: string
}

export type AdapterResult = ContextCreateResult | NavigateResult | SnapshotResult | ContextDestroyResult | SearchResult

export type AdapterErrorCode =
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'BOUNDARY_VIOLATION'
  | 'PROCESS_ERROR'
  | 'PROTOCOL_ERROR'
  | 'UNAVAILABLE'

export interface AdapterErrorShape {
  readonly code: AdapterErrorCode
  readonly message: string
  readonly contextId?: string
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly stdout?: string
  readonly stderr?: string
}

export class CliAdapterError extends Error {
  readonly error: AdapterErrorShape

  constructor(error: AdapterErrorShape) {
    super(`${error.code}: ${error.message}`)
    this.name = 'CliAdapterError'
    this.error = error
  }
}

export function asAdapterError(error: unknown): AdapterErrorShape {
  if (error instanceof CliAdapterError) return error.error
  return {
    code: 'UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
  }
}
