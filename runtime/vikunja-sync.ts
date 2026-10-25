import type { ServiceError, ServiceErrorCode } from '../packages/shared/src/agent-services.ts'
import type { IssueState } from '../packages/shared/src/group-wire.ts'

/**
 * Minimal Vikunja write and read capability (design 8.1, 11.1, 11.2, 13.1, 15).
 *
 * Ownership: the calling daemon owns when an operation is attempted and what a
 * result means for a session. This module owns only the HTTP exchange and its
 * explicit outcome. It persists nothing, retries nothing, and never turns an
 * ambiguous exchange into success:
 *
 * - a complete HTTP 4xx/5xx response is a definite failure mapped to
 *   `ServiceError`;
 * - a transport failure, timeout, or incomplete response to a write is
 *   `RESULT_UNKNOWN`, because the server may already have applied it;
 * - a read never writes, so its transport failure is `UNAVAILABLE`.
 *
 * Close and reopen write the requested `done` value and read the task back. The
 * result always carries the actual state. When an external change wins the
 * race, the caller sees the mismatch and decides conflict; this module never
 * rewrites the issue to hide it.
 *
 * API mapping (Vikunja REST v1, to be re-verified against a running Vikunja):
 * - create task: `PUT /api/v1/projects/{projectId}/tasks`
 * - read task: `GET /api/v1/tasks/{issueId}`
 * - update task (done): `POST /api/v1/tasks/{issueId}`
 * - create comment: `PUT /api/v1/tasks/{issueId}/comments`
 * - list project tasks: `GET /api/v1/projects/{projectId}/tasks`
 * - list task comments: `GET /api/v1/tasks/{issueId}/comments`
 */

const STABLE_REFERENCE_PREFIX = '[agentteams:'
const STABLE_REFERENCE_SUFFIX = ']'
const STABLE_REFERENCE_ID = /^[^\s[\]]+$/u
const DEFAULT_TIMEOUT_MS = 10_000

export type VikunjaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface VikunjaSyncOptions {
  readonly baseUrl: string
  /** Resolved token value, never a reference and never persisted here. */
  readonly token: string
  /** Defaults to the global fetch. Injected only by tests or another transport owner. */
  readonly fetch?: VikunjaFetch
  readonly timeoutMs?: number
}

export interface VikunjaIssue {
  readonly issueId: string
  readonly title: string
  readonly state: IssueState
}

export interface VikunjaIssueState {
  readonly issueId: string
  readonly state: IssueState
  /** Present when the server reported the owning project; a reference needs it. */
  readonly projectId?: string
}

export interface VikunjaComment {
  readonly commentId: string
  readonly issueId: string
  readonly body: string
}

/**
 * Actual state after a close or reopen write plus readback. The caller compares
 * `actualState` with `expectedState`; a mismatch is a conflict, not a rewrite.
 */
export interface VikunjaStateProjection {
  readonly issueId: string
  readonly expectedState: IssueState
  readonly actualState: IssueState
}

export type VikunjaResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'failed'; readonly error: ServiceError }
  | { readonly status: 'unknown'; readonly error: ServiceError }

export interface CreateIssueInput {
  readonly projectId: string
  readonly title: string
  readonly body: string
  /** Stable operation id written into the body as `[agentteams:<id>]`. */
  readonly ref: string
}

export interface IssueInput {
  readonly issueId: string
}

export interface WriteCommentInput {
  readonly issueId: string
  readonly body: string
  /** Stable result id written into the comment body as `[agentteams:<id>]`. */
  readonly ref: string
}

export interface FindIssueInput {
  readonly projectId: string
  readonly ref: string
}

export interface FindCommentInput {
  readonly issueId: string
  readonly ref: string
}

export interface VikunjaSync {
  createIssue(input: CreateIssueInput): Promise<VikunjaResult<VikunjaIssue>>
  referenceIssue(input: IssueInput): Promise<VikunjaResult<VikunjaIssue>>
  readState(input: IssueInput): Promise<VikunjaResult<VikunjaIssueState>>
  writeComment(input: WriteCommentInput): Promise<VikunjaResult<VikunjaComment>>
  closeIssue(input: IssueInput): Promise<VikunjaResult<VikunjaStateProjection>>
  reopenIssue(input: IssueInput): Promise<VikunjaResult<VikunjaStateProjection>>
  findIssueByStableRef(input: FindIssueInput): Promise<VikunjaResult<VikunjaIssue | undefined>>
  findCommentByStableRef(input: FindCommentInput): Promise<VikunjaResult<VikunjaComment | undefined>>
}

/** Local input or construction error; never a remote-operation outcome. */
export class VikunjaSyncError extends Error {
  readonly code: ServiceErrorCode

  constructor(code: ServiceErrorCode, message: string) {
    super(message)
    this.name = 'VikunjaSyncError'
    this.code = code
  }
}

type Exchange =
  | { readonly kind: 'response'; readonly status: number; readonly body: string }
  | { readonly kind: 'unreadable'; readonly status: number }
  | { readonly kind: 'transport' }

interface ParsedIssue {
  readonly issueId: string
  readonly title: string
  readonly state: IssueState
  readonly description: string
  readonly projectId?: string
  /**
   * Exactly the fields the server really returned as strings, so a full-update write can
   * re-submit what it means to keep without inventing an empty value for a field the server
   * never reported.
   */
  readonly preserve: Readonly<Record<string, unknown>>
}

interface ParsedComment {
  readonly commentId: string
  readonly body: string
}

function failure(code: ServiceErrorCode, message: string): VikunjaResult<never> {
  return { status: 'failed', error: { code, message } }
}

function unknown(message: string): VikunjaResult<never> {
  return { status: 'unknown', error: { code: 'RESULT_UNKNOWN', message } }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

/**
 * The same identity as a JSON number, for a full-update body that must speak the server's own
 * type. `undefined` leaves the field out instead of sending a string where an integer belongs.
 */
function numericIdentifier(value: string): number | undefined {
  if (!/^[0-9]+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseIssueRecord(value: unknown): ParsedIssue | undefined {
  if (!isRecord(value)) return undefined
  const issueId = identifier(value.id)
  if (issueId === undefined || typeof value.done !== 'boolean') return undefined
  const projectId = identifier(value.project_id)
  return {
    issueId,
    title: typeof value.title === 'string' ? value.title : '',
    state: value.done ? 'closed' : 'open',
    description: typeof value.description === 'string' ? value.description : '',
    ...(projectId === undefined ? {} : { projectId }),
    preserve: {
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
    },
  }
}

/**
 * The body one full-update task write carries: the fields the server really reported, with
 * `done` replaced.
 *
 * Vikunja's `POST /api/v1/tasks/{id}` is a full update — an omitted field is reset — so a body
 * carrying only `done` erases the title and the description. `PATCH` is not an alternative:
 * v2.7.1 answers it with `405 Method Not Allowed`. The description is where `createIssue`
 * writes the stable reference, so losing it also loses `findIssueByStableRef`, and a later
 * sync would create a duplicate issue instead of finding the existing one.
 */
function preserveOnFullUpdate(issue: ParsedIssue, done: boolean): Record<string, unknown> {
  const id = numericIdentifier(issue.issueId)
  const projectId = issue.projectId === undefined ? undefined : numericIdentifier(issue.projectId) ?? issue.projectId
  return {
    ...(id === undefined ? {} : { id }),
    ...issue.preserve,
    done,
    ...(projectId === undefined ? {} : { project_id: projectId }),
  }
}

function parseCommentRecord(value: unknown): ParsedComment | undefined {
  if (!isRecord(value)) return undefined
  const commentId = identifier(value.id)
  if (commentId === undefined || typeof value.comment !== 'string') return undefined
  return { commentId, body: value.comment }
}

function toIssue(issue: ParsedIssue): VikunjaIssue {
  return { issueId: issue.issueId, title: issue.title, state: issue.state }
}

function errorCodeForStatus(status: number): ServiceErrorCode {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 405) return 'UNSUPPORTED_OPERATION'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RESOURCE_EXHAUSTED'
  if (status >= 500) return 'UPSTREAM_ERROR'
  if (status >= 400) return 'INVALID_INPUT'
  return 'UNAVAILABLE'
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function requiredValue(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new VikunjaSyncError('INVALID_INPUT', `vikunja ${label} must be a non-empty string`)
  }
  return value
}

/** Build the stable reference written into a title, body, or comment body. */
export function stableReference(ref: string): string {
  if (!STABLE_REFERENCE_ID.test(ref)) {
    throw new VikunjaSyncError('INVALID_INPUT', 'vikunja stable reference id must be non-empty and contain no whitespace or brackets')
  }
  return `${STABLE_REFERENCE_PREFIX}${ref}${STABLE_REFERENCE_SUFFIX}`
}

function withStableReference(text: string, reference: string): string {
  return text.length === 0 ? reference : `${text}\n\n${reference}`
}

function normalizedBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new VikunjaSyncError('INVALID_INPUT', 'vikunja baseUrl must be a valid http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VikunjaSyncError('INVALID_INPUT', 'vikunja baseUrl must use http or https')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new VikunjaSyncError('INVALID_INPUT', 'vikunja baseUrl must not embed account credentials')
  }
  if (url.hash.length > 0 || url.search.length > 0) {
    throw new VikunjaSyncError('INVALID_INPUT', 'vikunja baseUrl must not include a query or fragment')
  }
  return value.replace(/\/+$/u, '')
}

/**
 * One client for one account token. The caller resolves `tokenRef` through the
 * Config credential owner before this point; the token is used only in the
 * Authorization header and never enters a return value.
 */
export function createVikunjaSync(options: VikunjaSyncOptions): VikunjaSync {
  const baseUrl = normalizedBaseUrl(options.baseUrl)
  const token = requiredValue(options.token, 'token')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new VikunjaSyncError('INVALID_INPUT', 'vikunja timeoutMs must be a positive integer')
  }
  const fetchImpl: VikunjaFetch = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new VikunjaSyncError('UNAVAILABLE', 'vikunja fetch is unavailable')
  try {
    new Headers({ authorization: `Bearer ${token}` })
  } catch {
    throw new VikunjaSyncError('INVALID_INPUT', 'vikunja token is not valid for an HTTP header')
  }

  const request = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<Exchange> => {
    const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}` })
    if (payload !== undefined) headers.set('content-type', 'application/json')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: 'manual',
        signal: controller.signal,
      })
      try {
        return { kind: 'response', status: response.status, body: await response.text() }
      } catch {
        return { kind: 'unreadable', status: response.status }
      }
    } catch {
      return { kind: 'transport' }
    } finally {
      clearTimeout(timer)
    }
  }

  const read = async <T>(
    label: string,
    path: string,
    parse: (value: unknown) => T | undefined,
  ): Promise<VikunjaResult<T>> => {
    const exchange = await request('GET', path)
    if (exchange.kind === 'transport') {
      return failure('UNAVAILABLE', `${label}: request failed before a response`)
    }
    if (exchange.kind === 'unreadable') {
      return failure(
        isSuccess(exchange.status) ? 'UPSTREAM_ERROR' : errorCodeForStatus(exchange.status),
        `${label}: response body could not be read (HTTP ${exchange.status})`,
      )
    }
    if (!isSuccess(exchange.status)) {
      return failure(errorCodeForStatus(exchange.status), `${label}: request returned HTTP ${exchange.status}`)
    }
    let value: unknown
    try {
      value = JSON.parse(exchange.body)
    } catch {
      return failure('UPSTREAM_ERROR', `${label}: response is not valid JSON`)
    }
    const parsed = parse(value)
    if (parsed === undefined) return failure('UPSTREAM_ERROR', `${label}: response is incomplete`)
    return { status: 'ok', value: parsed }
  }

  const write = async <T>(
    label: string,
    method: 'POST' | 'PUT',
    path: string,
    payload: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T | undefined,
  ): Promise<VikunjaResult<T>> => {
    const exchange = await request(method, path, payload)
    if (exchange.kind === 'transport') {
      return unknown(`${label}: no complete response was received; the write may or may not have been applied`)
    }
    if (exchange.kind === 'unreadable') {
      if (!isSuccess(exchange.status)) {
        return failure(errorCodeForStatus(exchange.status), `${label}: request returned HTTP ${exchange.status}`)
      }
      return unknown(`${label}: HTTP ${exchange.status} body was incomplete; the write was accepted but its result is unknown`)
    }
    if (!isSuccess(exchange.status)) {
      return failure(errorCodeForStatus(exchange.status), `${label}: request returned HTTP ${exchange.status}`)
    }
    let value: unknown
    try {
      value = JSON.parse(exchange.body)
    } catch {
      return unknown(`${label}: HTTP ${exchange.status} response is not valid JSON; the write was accepted but its result is unknown`)
    }
    const parsed = parse(value)
    if (parsed === undefined) {
      return unknown(`${label}: HTTP ${exchange.status} response is incomplete; the write was accepted but its result is unknown`)
    }
    return { status: 'ok', value: parsed }
  }

  const readState = async (input: IssueInput): Promise<VikunjaResult<VikunjaIssueState>> => {
    const issueId = requiredValue(input.issueId, 'issue id')
    return read('vikunja issue read', `/api/v1/tasks/${encodeURIComponent(issueId)}`, value => {
      const issue = parseIssueRecord(value)
      return issue === undefined
        ? undefined
        : { issueId: issue.issueId, state: issue.state, ...(issue.projectId === undefined ? {} : { projectId: issue.projectId }) }
    })
  }

  /**
   * Close or reopen one issue.
   *
   * The update is a full update, so the current record is read first and merged into the body:
   * a body carrying only `done` resets every field it omits, and in v2.7.1 that resets the
   * description, which is where `createIssue` wrote the stable reference. The state that ends
   * up stored is still reported from a real read after the write, never from the write's own
   * echo, and an unanswered write keeps the `RESULT_UNKNOWN` outcome instead of being retried.
   */
  const setDone = async (
    label: string,
    issueId: string,
    done: boolean,
  ): Promise<VikunjaResult<VikunjaStateProjection>> => {
    // Read before write: nothing has been written yet, so a refused read is the close's own
    // failure and never a `RESULT_UNKNOWN`.
    const current = await read('vikunja issue read before state write', `/api/v1/tasks/${encodeURIComponent(issueId)}`, parseIssueRecord)
    if (current.status !== 'ok') {
      return failure(current.error.code, `${label}: the issue could not be read before the write (${current.error.message})`)
    }
    const exchange = await request('POST', `/api/v1/tasks/${encodeURIComponent(issueId)}`, preserveOnFullUpdate(current.value, done))
    if (exchange.kind === 'transport') {
      return unknown(`${label}: no complete response was received; the write may or may not have been applied`)
    }
    if (!isSuccess(exchange.status)) {
      return failure(errorCodeForStatus(exchange.status), `${label}: request returned HTTP ${exchange.status}`)
    }
    // The stored state is what the readback says, not what the write echoed.
    const state = await readState({ issueId })
    if (state.status !== 'ok') {
      return unknown(`${label}: the write was accepted but the issue state could not be read back (${state.error.message})`)
    }
    return {
      status: 'ok',
      value: { issueId, expectedState: done ? 'closed' : 'open', actualState: state.value.state },
    }
  }

  return {
    createIssue: async input => {
      const projectId = requiredValue(input.projectId, 'project id')
      const title = requiredValue(input.title, 'issue title')
      const reference = stableReference(input.ref)
      return write(
        'vikunja issue create',
        'PUT',
        `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`,
        { title, description: withStableReference(input.body, reference) },
        value => {
          const issue = parseIssueRecord(value)
          return issue === undefined ? undefined : toIssue(issue)
        },
      )
    },
    referenceIssue: async input => {
      const issueId = requiredValue(input.issueId, 'issue id')
      return read('vikunja issue reference', `/api/v1/tasks/${encodeURIComponent(issueId)}`, value => {
        const issue = parseIssueRecord(value)
        return issue === undefined ? undefined : toIssue(issue)
      })
    },
    readState,
    writeComment: async input => {
      const issueId = requiredValue(input.issueId, 'issue id')
      const reference = stableReference(input.ref)
      const body = withStableReference(input.body, reference)
      return write(
        'vikunja comment create',
        'PUT',
        `/api/v1/tasks/${encodeURIComponent(issueId)}/comments`,
        { comment: body },
        value => {
          const comment = parseCommentRecord(value)
          return comment === undefined ? undefined : { commentId: comment.commentId, issueId, body: comment.body }
        },
      )
    },
    closeIssue: async input => setDone('vikunja issue close', requiredValue(input.issueId, 'issue id'), true),
    reopenIssue: async input => setDone('vikunja issue reopen', requiredValue(input.issueId, 'issue id'), false),
    findIssueByStableRef: async input => {
      const projectId = requiredValue(input.projectId, 'project id')
      const reference = stableReference(input.ref)
      const result = await read<VikunjaIssue | null>(
        'vikunja issue readback',
        `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`,
        value => {
          if (!Array.isArray(value)) return undefined
          const issues: ParsedIssue[] = []
          for (const entry of value) {
            const issue = parseIssueRecord(entry)
            if (issue === undefined) return undefined
            issues.push(issue)
          }
          const match = issues.find(issue => issue.title.includes(reference) || issue.description.includes(reference))
          return match === undefined ? null : toIssue(match)
        },
      )
      if (result.status !== 'ok') return result
      return { status: 'ok', value: result.value ?? undefined }
    },
    findCommentByStableRef: async input => {
      const issueId = requiredValue(input.issueId, 'issue id')
      const reference = stableReference(input.ref)
      const result = await read<VikunjaComment | null>(
        'vikunja comment readback',
        `/api/v1/tasks/${encodeURIComponent(issueId)}/comments`,
        value => {
          if (!Array.isArray(value)) return undefined
          const comments: ParsedComment[] = []
          for (const entry of value) {
            const comment = parseCommentRecord(entry)
            if (comment === undefined) return undefined
            comments.push(comment)
          }
          const match = comments.find(comment => comment.body.includes(reference))
          return match === undefined ? null : { commentId: match.commentId, issueId, body: match.body }
        },
      )
      if (result.status !== 'ok') return result
      return { status: 'ok', value: result.value ?? undefined }
    },
  }
}
