import type { AuthenticatedAgent, ServiceErrorCode } from '../control-protocol/agent-services.ts'
import type { ConsoleClientV1, ConsoleCommandV1 } from '../control-protocol/console-api.ts'
import { parseConsoleWireRequest, type ConsoleWireReply, type ConsoleWireRequest } from '../control-protocol/console-wire.ts'
import { assertJsonValue } from '../control-protocol/json-value.ts'

export type ConsoleAccess =
  | { readonly kind: 'observe'; readonly agentId: string }
  | { readonly kind: 'command'; readonly agentId: string; readonly commandKind: ConsoleCommandV1['kind'] }
  | { readonly kind: 'session'; readonly agentId: string; readonly sessionId: string }

/** Relay authentication establishes the peer, not management authority. Policy sees only control. */
export function createConsoleIngress(options: {
  readonly agentId: string
  readonly generation: () => number
  readonly authorize: (peer: AuthenticatedAgent, access: ConsoleAccess) => boolean
  readonly client: ConsoleClientV1
}, authenticatedPeer: AuthenticatedAgent) {
  const { agentId, generation, authorize, client } = options
  const peer = Object.freeze({ ...authenticatedPeer })
  return async (input: ConsoleWireRequest): Promise<ConsoleWireReply> => {
    assertJsonValue(input, 'Console ingress')
    const request = parseConsoleWireRequest(JSON.stringify(input))
    const denied = (code: ServiceErrorCode, message: string): ConsoleWireReply => ({
      kind: 'console.result', correlationId: request.correlationId, result: { ok: false, error: { code, message } },
    })
    if (request.targetGeneration !== generation()) return denied('STALE_GENERATION', 'Console request targets an old daemon generation')
    const targetId = request.kind === 'console.command' ? request.command.agentId : request.agentId
    if (targetId !== agentId) return denied('FORBIDDEN', 'Console request targets another Agent')
    const access: ConsoleAccess = request.kind === 'console.projection' ? { kind: 'observe', agentId }
      : request.kind === 'console.command' ? { kind: 'command', agentId, commandKind: request.command.kind }
      : { kind: 'session', agentId, sessionId: request.sessionId }
    if (!authorize(peer, access)) return denied('FORBIDDEN', 'Agent management policy denied this request')
    if (request.kind === 'console.projection') return { kind: 'console.projection.result', correlationId: request.correlationId, projection: await client.readProjection() }
    const result = request.kind === 'console.command' ? await client.command(request.command)
      : await client.sendSession({ agentId, sessionId: request.sessionId }, request.payload)
    return { kind: 'console.result', correlationId: request.correlationId, result }
  }
}
