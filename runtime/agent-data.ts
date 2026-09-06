import { createWorkChannel, type WorkChannelOptions } from '../network/work-channel.ts'
import { serveConsole } from '../network/console-channel.ts'
import type { WssConnection } from '../network/wss-connection.ts'
import type { ConsoleWireReply, ConsoleWireRequest } from '../control-protocol/console-wire.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'

/** The first typed frame selects a protocol; authorization stays in each Agent ingress. */
export async function acceptAgentData(socket: WssConnection, options: {
  readonly work: WorkChannelOptions
  readonly console: (request: ConsoleWireRequest) => Promise<ConsoleWireReply>
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!Number.isSafeInteger(options.work.timeoutMs) || options.work.timeoutMs < 1 || options.work.timeoutMs > 2_147_483_647) throw new RelayProtocolError('INVALID_INPUT', 'Agent opening timeout invalid')
    const first = await Promise.race([
      socket.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RelayProtocolError('UNAVAILABLE', 'Agent data opening deadline elapsed')), options.work.timeoutMs) }),
    ])
    clearTimeout(timer)
    if (first.binary) throw new RelayProtocolError('INVALID_INPUT', 'Agent opening frame must be JSON text')
    const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(first.bytes))
    const kind = frame && typeof frame === 'object' && !Array.isArray(frame) ? (frame as { kind?: unknown }).kind : undefined
    let consumed = false
    const input: WssConnection = {
      closed: socket.closed, close: () => socket.close(), send: frame => socket.send(frame),
      read: () => { if (!consumed) { consumed = true; return Promise.resolve(first) } return socket.read() },
    }
    if (typeof kind === 'string' && kind.startsWith('console.')) await serveConsole(input, options.console, options.work.timeoutMs)
    else if (typeof kind === 'string' && kind.startsWith('work.')) await createWorkChannel(input, options.work).closed
    else throw new RelayProtocolError('UNSUPPORTED_OPERATION', 'Unsupported Agent data protocol')
  } finally {
    clearTimeout(timer)
    await socket.close()
  }
}
