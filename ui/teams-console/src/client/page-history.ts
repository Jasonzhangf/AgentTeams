import type { HistoryPage, HistoryQuery } from './protocol.ts'

export interface HistoryViewState {
  readonly status: 'idle' | 'loading' | 'ready' | 'refused' | 'error'
  readonly page: HistoryPage | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly nextBeforeSequence: number | undefined
}

/** The history page queries connections; a request-kind refusal stays a real typed state. */
export function historyQueryFor(kind: 'connection' | 'request', beforeSequence: number | undefined): HistoryQuery {
  return { version: 1, kind, limit: 20, ...(beforeSequence === undefined ? {} : { beforeSequence }) }
}

export function isRequestKindRefusal(error: { readonly code: string; readonly message: string } | null): boolean {
  return error !== null && error.code !== 'HISTORY_UNAVAILABLE'
}
