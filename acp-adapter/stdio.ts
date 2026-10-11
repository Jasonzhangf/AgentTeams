import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { AcpFault, AcpFrame } from '../control-protocol/acp.ts'
import { AcpError, parseAcpFrame } from '../control-protocol/acp.ts'

export const DEFAULT_ACP_MAX_FRAME_BYTES = 8_388_608

export interface AcpDuplex {
  /** The single reader. Calls are serialized in arrival order. */
  read(): Promise<AcpFrame>
  /** Serialize one JSON-RPC frame and wait for backpressure. */
  send(frame: AcpFrame): Promise<void>
  readonly closed: Promise<{ readonly kind: 'eof' } | { readonly kind: 'failed'; readonly error: AcpFault }>
  /** Close owned streams without killing any process. */
  close(): Promise<void>
}

interface Waiter {
  readonly resolve: (frame: AcpFrame) => void
  readonly reject: (error: Error) => void
}

type ClosedResult = { readonly kind: 'eof' } | { readonly kind: 'failed'; readonly error: AcpFault }

export function createStdioAcpDuplex(input: {
  readonly readable: Readable
  readonly writable: Writable
  readonly maxFrameBytes?: number
}): AcpDuplex {
  const maxFrameBytes = input.maxFrameBytes ?? DEFAULT_ACP_MAX_FRAME_BYTES
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'maxFrameBytes must be a positive finite integer')
  }

  let buffer = Buffer.alloc(0)
  const frames: AcpFrame[] = []
  const waiters: Waiter[] = []
  let settled: ClosedResult | null = null
  let closing = false
  let writeChain: Promise<void> = Promise.resolve()

  let resolveClosed!: (result: ClosedResult) => void
  const closed = new Promise<ClosedResult>(resolve => { resolveClosed = resolve })

  const fault = (code: AcpFault['code'], message: string): AcpFault => ({ code, message })

  const settle = (result: ClosedResult): void => {
    if (settled) return
    settled = result
    resolveClosed(result)
    while (waiters.length > 0) {
      const waiter = waiters.shift()!
      if (result.kind === 'failed') waiter.reject(new AcpError(result.error.code, result.error.message, result.error.detail))
      else waiter.reject(new AcpError('ENGINE_UNAVAILABLE', 'ACP stream reached EOF before a frame was available'))
    }
  }

  const failFrame = (message: string): void => {
    settle({ kind: 'failed', error: fault('INVALID_ACP_FRAME', message) })
  }

  const deliver = (frame: AcpFrame): void => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(frame)
    else frames.push(frame)
  }

  const consumeLine = (line: Buffer): void => {
    const text = line.toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      failFrame(`ACP stdout is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`)
      return
    }
    try {
      deliver(parseAcpFrame(parsed))
    } catch (error) {
      failFrame(error instanceof Error ? error.message : 'ACP frame is invalid')
    }
  }

  const onData = (chunk: Buffer | string): void => {
    if (settled) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    buffer = Buffer.concat([buffer, bytes])
    while (!settled) {
      const newline = buffer.indexOf(0x0a)
      if (newline === -1) {
        if (buffer.length > maxFrameBytes) failFrame(`ACP frame exceeds ${maxFrameBytes} bytes`)
        break
      }
      let line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      if (line.length > maxFrameBytes) {
        failFrame(`ACP frame exceeds ${maxFrameBytes} bytes`)
        break
      }
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length === 0) {
        failFrame('ACP stdout contained an empty line')
        break
      }
      consumeLine(line)
    }
  }

  const onEnd = (): void => {
    if (settled) return
    if (buffer.length > 0) {
      failFrame('ACP stream ended with an incomplete frame')
      return
    }
    settle({ kind: 'eof' })
  }

  const onError = (error: Error): void => {
    if (settled) return
    settle({ kind: 'failed', error: fault('ENGINE_UNAVAILABLE', error.message) })
  }

  const onClose = (): void => {
    if (settled) return
    if (closing) settle({ kind: 'eof' })
    else settle({ kind: 'failed', error: fault('ENGINE_UNAVAILABLE', 'ACP stream closed unexpectedly') })
  }

  input.readable.on('data', onData)
  input.readable.on('end', onEnd)
  input.readable.on('error', onError)
  input.readable.on('close', onClose)

  const writeLine = async (text: string): Promise<void> => {
    if (settled) throw new AcpError('ENGINE_UNAVAILABLE', 'ACP duplex is closed')
    try {
      if (!input.writable.write(text)) await once(input.writable, 'drain')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ACP write failed'
      settle({ kind: 'failed', error: fault('ENGINE_UNAVAILABLE', message) })
      throw error instanceof Error ? error : new Error(message)
    }
  }

  const read = (): Promise<AcpFrame> => {
    const frame = frames.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    if (settled) {
      if (settled.kind === 'failed') {
        return Promise.reject(new AcpError(settled.error.code, settled.error.message, settled.error.detail))
      }
      return Promise.reject(new AcpError('ENGINE_UNAVAILABLE', 'ACP stream reached EOF'))
    }
    return new Promise<AcpFrame>((resolve, reject) => { waiters.push({ resolve, reject }) })
  }

  const send = (frame: AcpFrame): Promise<void> => {
    if (settled) return Promise.reject(new AcpError('ENGINE_UNAVAILABLE', 'ACP duplex is closed'))
    let text: string
    try {
      parseAcpFrame(frame)
      text = `${JSON.stringify(frame)}\n`
    } catch (error) {
      return Promise.reject(error)
    }
    const run = writeChain.then(() => writeLine(text))
    writeChain = run.catch(() => {})
    return run
  }

  const close = async (): Promise<void> => {
    if (settled) return
    closing = true
    settle({ kind: 'eof' })
    input.readable.pause()
    input.readable.destroy()
    if (!input.writable.writableEnded && !input.writable.destroyed) {
      await new Promise<void>(resolve => {
        input.writable.end(() => resolve())
      })
    }
  }

  return { read, send, closed, close }
}
