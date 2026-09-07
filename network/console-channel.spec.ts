import { expect, it } from 'vitest'
import { requestConsole, serveConsole } from './console-channel.ts'
import type { WssConnection, WssFrame } from './wss-connection.ts'
import { WssConnectionError } from './wss-connection.ts'

function closedError() {
  return new WssConnectionError('UNAVAILABLE', 'network: connection stopped locally')
}

function mockSocket(): WssConnection & { deliver(frame: WssFrame): void } {
  const queue: WssFrame[] = []
  let terminal: WssConnectionError | undefined
  let reader: { resolve(frame: WssFrame): void; reject(error: WssConnectionError): void } | undefined
  let resolveClosed!: (error: WssConnectionError) => void
  const closed = new Promise<WssConnectionError>(resolve => { resolveClosed = resolve })
  const terminate = (error: WssConnectionError) => {
    if (terminal) return
    terminal = error
    reader?.reject(error)
    reader = undefined
    resolveClosed(error)
  }
  return {
    closed,
    deliver(frame) {
      if (terminal) return
      if (reader) {
        const pending = reader
        reader = undefined
        pending.resolve(frame)
        return
      }
      queue.push(frame)
    },
    async read() {
      if (terminal) throw terminal
      const frame = queue.shift()
      if (frame) return frame
      return new Promise<WssFrame>((resolve, reject) => { reader = { resolve, reject } })
    },
    async send() {
      if (terminal) throw terminal
    },
    async close() {
      terminate(closedError())
      await closed
    },
  }
}

it('invokes the owner after a delayed send even when the client deadline is shorter than send latency', async () => {
  const left = mockSocket()
  const right = mockSocket()
  const originalSend = left.send.bind(left)
  left.send = async frame => {
    await new Promise<void>(resolve => { setTimeout(resolve, 30) })
    await originalSend(frame)
    right.deliver(frame)
  }
  let calls = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const serving = serveConsole(right, async request => {
    calls += 1
    await pending
    return { kind: 'console.result', correlationId: request.correlationId, result: { ok: true } }
  }, 1000).catch(error => error)
  try {
    await expect(requestConsole(left, { kind: 'console.command', correlationId: 'r', targetGeneration: 1,
      command: { kind: 'config.apply', agentId: 'daemon' } }, 10)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
    expect(calls).toBe(1)
    release()
    await serving
  } finally { release() }
})
