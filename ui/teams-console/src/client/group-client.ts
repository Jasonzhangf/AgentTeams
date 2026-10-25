import type { GroupWireReply, GroupWireRequest } from '../../../../packages/shared/src/group-wire.ts'
import { parseGroupWireReply, parseGroupWireRequest } from '../../../../packages/shared/src/group-wire.ts'

/**
 * UI-owned additive group port.
 *
 * Console contract (owns transport mapping only):
 *   POST /api/v1/group-request?agentId=<agentId>
 *   body {requestId, frame} with frame.requestId === requestId
 *   200 {ok:true, reply} | 200 {ok:false, error}
 *   503 {code:'GROUP_ENDPOINT_NOT_CONFIGURED'} | 502 {code:'GROUP_ENDPOINT_UNREACHABLE'}
 * This module never invents a reply, never retries, and never turns an unknown
 * outcome into success. The caller owns requestId and commit identity.
 */

/** Endpoint access state, independent of any in-group failure. */
export type GroupAccessState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'not-configured'; readonly message: string }
  | { readonly kind: 'unreachable'; readonly message: string }

/** Outcome of one group request. The UI renders each kind differently. */
export type GroupRequestOutcome =
  | { readonly kind: 'reply'; readonly reply: GroupWireReply }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }
  | { readonly kind: 'access'; readonly access: GroupAccessState }
  | { readonly kind: 'transport'; readonly message: string }

export interface GroupRequestSender {
  readonly requestGroup: (agentId: string, frame: GroupWireRequest) => Promise<GroupRequestOutcome>
}

export interface GroupClientOptions {
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly groupRequestPath?: string
}

export const GROUP_ENDPOINT_NOT_CONFIGURED = 'GROUP_ENDPOINT_NOT_CONFIGURED'
export const GROUP_ENDPOINT_UNREACHABLE = 'GROUP_ENDPOINT_UNREACHABLE'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function typedError(value: unknown): { readonly code: string; readonly message: string } | undefined {
  if (!isRecord(value)) return undefined
  const error = isRecord(value.error) ? value.error : value
  if (typeof error.code !== 'string' || error.code.length === 0) return undefined
  return { code: error.code, message: typeof error.message === 'string' ? error.message : error.code }
}

/** The reply is validated with the canonical codec so a drifted owner shape fails here. */
function parseReply(value: unknown): GroupWireReply | undefined {
  try {
    return parseGroupWireReply(JSON.stringify(value))
  } catch {
    return undefined
  }
}

function resolveUrl(path: string, baseUrl: string | undefined, agentId: string): string {
  const target = `${path}?agentId=${encodeURIComponent(agentId)}`
  if (baseUrl === undefined) return target
  return new URL(target, baseUrl).toString()
}

/**
 * Build a group request sender over the additive Console envelope endpoint.
 * The frame is validated locally first, and the envelope requestId must equal the
 * frame requestId, so a mismatch fails here instead of at the owner boundary.
 */
export function createGroupRequestClient(options: GroupClientOptions = {}): GroupRequestSender {
  const fetchImpl = options.fetchImpl ?? fetch
  const path = options.groupRequestPath ?? '/api/v1/group-request'

  return {
    async requestGroup(agentId: string, frame: GroupWireRequest): Promise<GroupRequestOutcome> {
      const encoded = JSON.stringify(frame)
      try {
        parseGroupWireRequest(encoded)
      } catch (error) {
        return { kind: 'refused', code: 'INVALID_INPUT', message: error instanceof Error ? error.message : 'Invalid group frame' }
      }
      if (agentId.length === 0) {
        return { kind: 'access', access: { kind: 'not-configured', message: 'No agent target is selected for this group request.' } }
      }

      let response: Response
      try {
        response = await fetchImpl(resolveUrl(path, options.baseUrl, agentId), {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: frame.requestId, frame }),
        })
      } catch (error) {
        // A thrown fetch is a transport failure of the Console host itself, not of the
        // group endpoint, so it must not read as a group refusal.
        return { kind: 'transport', message: error instanceof Error ? error.message : 'Network request failed' }
      }

      const text = await response.text().catch(() => '')
      let body: unknown
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          body = undefined
        }
      }
      const typed = typedError(body)

      if (response.status === 503) {
        return { kind: 'access', access: { kind: 'not-configured', message: typed?.message ?? 'The group endpoint is not configured.' } }
      }
      if (response.status === 502) {
        if (typed === undefined || typed.code === GROUP_ENDPOINT_UNREACHABLE) {
          return { kind: 'access', access: { kind: 'unreachable', message: typed?.message ?? 'The group endpoint is unreachable.' } }
        }
        // Any other 502 code is an upstream failure reported by the group owner.
        return { kind: 'refused', code: typed.code, message: typed.message }
      }
      if (!response.ok) {
        if (typed !== undefined) return { kind: 'refused', code: typed.code, message: typed.message }
        return { kind: 'transport', message: `HTTP ${response.status}` }
      }
      if (!isRecord(body)) return { kind: 'transport', message: 'Group owner returned an unreadable envelope' }

      if (body.ok === true) {
        const reply = parseReply(body.reply)
        if (reply === undefined) return { kind: 'transport', message: 'Group owner returned an unrecognised reply frame' }
        return { kind: 'reply', reply }
      }
      if (body.ok === false) {
        const failure = typedError(body)
        if (failure === undefined) return { kind: 'transport', message: 'Group owner refused the request without a typed error' }
        if (failure.code === GROUP_ENDPOINT_NOT_CONFIGURED) return { kind: 'access', access: { kind: 'not-configured', message: failure.message } }
        if (failure.code === GROUP_ENDPOINT_UNREACHABLE) return { kind: 'access', access: { kind: 'unreachable', message: failure.message } }
        return { kind: 'refused', code: failure.code, message: failure.message }
      }
      return { kind: 'transport', message: 'Group owner returned an envelope without an ok flag' }
    },
  }
}

/** Merge the additive group port into an existing canonical client without forking it. */
export function withGroupRequests<T extends object>(client: T, sender: GroupRequestSender): T & GroupRequestSender {
  return { ...client, requestGroup: sender.requestGroup }
}
