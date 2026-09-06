import { randomUUID } from 'node:crypto'
import { assertJsonValue } from '../control-protocol/json-value.ts'
import { parseWorkWireFrame, type WorkWireReply, type WorkWireRequest } from '../control-protocol/work-wire.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'
import type { WssConnection } from './wss-connection.ts'

type Command = WorkWireRequest extends infer T ? T extends WorkWireRequest ? Omit<T, 'correlationId'> : never : never
export interface WorkChannelOptions {
  readonly timeoutMs: number
  readonly maxPending: number
  readonly maxIncoming: number
  /** Handler is bound to the authenticated peer by the runtime, outside business content. */
  readonly onRequest?: (request: WorkWireRequest) => Promise<WorkWireReply>
}
export interface WorkChannel {
  request(command: Command): Promise<WorkWireReply>
  readonly closed: Promise<Error>
  close(): Promise<void>
}

export function createWorkChannel(socket: WssConnection, input: WorkChannelOptions): WorkChannel {
  const options = { ...input }
  for (const value of [options.timeoutMs, options.maxPending, options.maxIncoming]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RelayProtocolError('INVALID_INPUT', 'Work channel limits must be positive integers')
  }
  if (options.timeoutMs > 2_147_483_647) throw new RelayProtocolError('INVALID_INPUT', 'Work timeout exceeds timer range')
  const pending = new Map<string, { command: Command; resolve(reply: WorkWireReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const incoming = new Set<string>()
  let failure: Error | undefined
  const stop = async (error: Error) => {
    if (!failure) {
      failure = error
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
      pending.clear()
    }
    await socket.close()
  }
  const send = async (frame: WorkWireRequest | WorkWireReply) => {
    if (failure) throw failure
    assertJsonValue(frame, 'Work outbound frame')
    // Validate our own adapter output before it crosses the protocol boundary.
    const text = JSON.stringify(frame)
    parseWorkWireFrame(text)
    await socket.send({ bytes: Buffer.from(text), binary: false })
  }
  const closed = socket.closed.then(async error => { await stop(error); return failure! })
  void (async () => {
    try {
      while (!failure) {
        const raw = await socket.read()
        if (raw.binary) throw new RelayProtocolError('INVALID_INPUT', 'Work frames must be JSON text')
        const frame = parseWorkWireFrame(raw.bytes.toString('utf8'))
        if (frame.kind === 'work.state' || frame.kind === 'work.result' || frame.kind === 'work.error') {
          const request = pending.get(frame.correlationId)
          if (!request) throw new RelayProtocolError('INVALID_INPUT', 'unrecognized Work response correlation')
          const command = request.command
          const workId = command.kind === 'work.propose' ? command.proposal.workId : command.kind === 'work.request' ? command.control.workId : command.workId
          if (frame.kind !== 'work.error') {
            const expectsState = command.kind === 'work.propose' || command.kind === 'work.close'
            if (expectsState !== (frame.kind === 'work.state') ||
              (frame.kind === 'work.state' ? frame.work.workId : frame.control.workId) !== workId ||
              (frame.kind === 'work.result' && (command.kind === 'work.request' || command.kind === 'work.get') &&
                frame.control.requestId !== (command.kind === 'work.request' ? command.control.requestId : command.requestId))) {
              throw new RelayProtocolError('INVALID_INPUT', 'Work response does not match requested operation')
            }
          }
          clearTimeout(request.timer)
          pending.delete(frame.correlationId)
          request.resolve(frame)
        } else {
          if (!options.onRequest) throw new RelayProtocolError('FORBIDDEN', 'this connection does not accept Work requests')
          if (incoming.has(frame.correlationId) || incoming.size >= options.maxIncoming) {
            throw new RelayProtocolError('RESOURCE_EXHAUSTED', 'Work ingress correlation/capacity exhausted')
          }
          incoming.add(frame.correlationId)
          // Handler lifetime belongs to the provider: socket loss is not cancellation.
          void Promise.resolve().then(() => options.onRequest!(frame)).then(reply => {
            if (reply.correlationId !== frame.correlationId) throw new RelayProtocolError('INVALID_INPUT', 'handler response correlation changed')
            return send(reply)
          }).catch(error => stop(error instanceof Error ? error : new Error('Work handler failed')))
            .finally(() => { incoming.delete(frame.correlationId) })
        }
      }
    } catch (error) { await stop(error instanceof Error ? error : new Error('Work channel failed')) }
  })()
  return {
    closed,
    close: () => stop(new RelayProtocolError('UNAVAILABLE', 'Work channel stopped locally')),
    request: async command => {
      if (failure) throw failure
      if (pending.size >= options.maxPending) throw new RelayProtocolError('RESOURCE_EXHAUSTED', 'Work request capacity exhausted')
      assertJsonValue(command, 'Work command')
      const snapshot = structuredClone(command)
      const correlationId = randomUUID()
      const frame = { ...snapshot, correlationId }
      parseWorkWireFrame(JSON.stringify(frame))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { void stop(new RelayProtocolError('RESULT_UNKNOWN', 'Work reply deadline elapsed; do not replay')) }, options.timeoutMs)
        pending.set(correlationId, { command: snapshot, resolve, reject, timer })
        void send(frame).catch(error => stop(error instanceof Error ? error : new Error('Work send failed')))
      })
    },
  }
}
