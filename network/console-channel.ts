import { parseConsoleWireReply, parseConsoleWireRequest, type ConsoleWireReply, type ConsoleWireRequest } from '../control-protocol/console-wire.ts'
import { assertJsonValue } from '../control-protocol/json-value.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'
import type { WssConnection } from './wss-connection.ts'

function assertTimeoutMs(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RelayProtocolError('INVALID_INPUT', 'Console timeout invalid')
  }
}

async function raceTransport<T>(socket: WssConnection, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      socket.closed.then(error => { throw error }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RelayProtocolError('RESULT_UNKNOWN', 'Console deadline elapsed; do not replay')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function readText(socket: WssConnection): Promise<string> {
  const frame = await socket.read()
  if (frame.binary) throw new RelayProtocolError('INVALID_INPUT', 'Console frames require JSON text')
  return new TextDecoder('utf-8', { fatal: true }).decode(frame.bytes)
}

/** One management request per granted connection; no retry queue or Work execution ownership. */
export async function requestConsole(socket: WssConnection, input: ConsoleWireRequest, timeoutMs: number): Promise<ConsoleWireReply> {
  assertJsonValue(input, 'Console outbound request')
  const text = JSON.stringify(input)
  const request = parseConsoleWireRequest(text)
  assertTimeoutMs(timeoutMs)
  try {
    // Deadline covers the reply only. Racing send against the same timer lets a due
    // setTimeout win over an in-flight write after event-loop delay, so the owner never starts.
    await Promise.race([
      socket.send({ bytes: Buffer.from(text), binary: false }),
      socket.closed.then(error => { throw error }),
    ])
    return await raceTransport(socket, timeoutMs, async () => {
      const reply = parseConsoleWireReply(await readText(socket))
      if (reply.correlationId !== request.correlationId) throw new RelayProtocolError('INVALID_INPUT', 'Console reply correlation mismatch')
      if (reply.kind === 'console.projection.result') {
        if (request.kind !== 'console.projection') throw new RelayProtocolError('INVALID_INPUT', 'Unexpected Console projection reply')
        for (const rows of [reply.projection.agents, reply.projection.sessions, reply.projection.notifications, reply.projection.configs]) {
          if (rows.some(row => row.agentId !== request.agentId)) throw new RelayProtocolError('INVALID_INPUT', 'Console projection belongs to another Agent')
        }
      } else if (request.kind === 'console.projection' && reply.result.ok) throw new RelayProtocolError('INVALID_INPUT', 'Console projection missing from reply')
      return reply
    })
  } finally {
    await socket.close()
  }
}

/** Socket loss/deadline ends transport only; the owning handler continues its execution. */
export async function serveConsole(socket: WssConnection, handler: (request: ConsoleWireRequest) => Promise<ConsoleWireReply>, timeoutMs: number): Promise<void> {
  assertTimeoutMs(timeoutMs)
  try {
    const request = await raceTransport(socket, timeoutMs, async () => parseConsoleWireRequest(await readText(socket)))
    const reply = await handler(request)
    if (reply.correlationId !== request.correlationId) throw new RelayProtocolError('INVALID_INPUT', 'Console handler correlation mismatch')
    assertJsonValue(reply, 'Console outbound reply')
    const text = JSON.stringify(reply)
    parseConsoleWireReply(text)
    await socket.send({ bytes: Buffer.from(text), binary: false })
  } finally {
    await socket.close()
  }
}
