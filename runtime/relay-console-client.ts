import { randomUUID } from 'node:crypto'
import type { ConsoleClientV1, ConsoleServiceError } from '../control-protocol/console-api.ts'
import { parseConsoleWireRequest, type ConsoleWireRequest } from '../control-protocol/console-wire.ts'
import { assertJsonValue } from '../control-protocol/json-value.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'
import type { RelayClient } from '../network/relay-client.ts'
import { requestConsole } from '../network/console-channel.ts'

type Request = ConsoleWireRequest extends infer T ? T extends ConsoleWireRequest ? Omit<T, 'targetGeneration' | 'correlationId'> : never : never
export class ConsoleProjectionError extends Error {
  constructor(readonly error: ConsoleServiceError) { super(error.message) }
}

/** One Agent binding over the existing authenticated relay; directory state never grants management rights. */
export function createRelayConsoleClient(relay: RelayClient, agentId: string, timeoutMs: number): ConsoleClientV1 {
  if (!agentId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RelayProtocolError('INVALID_INPUT', 'Invalid Console relay binding')
  const exchange = async (input: Request) => {
    assertJsonValue(input, 'Console client request')
    const snapshot = parseConsoleWireRequest(JSON.stringify({ ...input, correlationId: randomUUID(), targetGeneration: 1 }))
    const targetId = snapshot.kind === 'console.command' ? snapshot.command.agentId : snapshot.agentId
    if (targetId !== agentId) throw new RelayProtocolError('FORBIDDEN', 'Console client is bound to another Agent')
    const peer = (await relay.directory(false)).find(peer => peer.declaration.identity.agentId === agentId)
    if (!peer) throw new RelayProtocolError('NOT_FOUND', 'Agent is absent from the admitted directory')
    if (peer.presence !== 'online') throw new RelayProtocolError('UNAVAILABLE', 'Agent is offline')
    const grant = await relay.connect(agentId, peer.generation)
    const socket = await relay.openData(grant)
    return requestConsole(socket, { ...snapshot, targetGeneration: peer.generation }, timeoutMs)
  }
  return {
    readProjection: async () => {
      const reply = await exchange({ kind: 'console.projection', agentId })
      if (reply.kind === 'console.projection.result') return reply.projection
      if (!reply.result.ok) throw new ConsoleProjectionError(reply.result.error)
      throw new RelayProtocolError('INVALID_INPUT', 'Console projection result missing')
    },
    command: async command => {
      const reply = await exchange({ kind: 'console.command', command })
      if (reply.kind !== 'console.result') throw new RelayProtocolError('INVALID_INPUT', 'Unexpected Console command response')
      return reply.result
    },
    sendSession: async (target, payload) => {
      const reply = await exchange({ kind: 'console.session', ...target, payload })
      if (reply.kind !== 'console.result') throw new RelayProtocolError('INVALID_INPUT', 'Unexpected Console Session response')
      return reply.result
    },
  }
}
