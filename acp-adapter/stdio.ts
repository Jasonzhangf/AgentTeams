import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { AcpFault, AcpFrame } from '../packages/shared/src/acp.ts'
import { AcpError, parseAcpFrame } from '../packages/shared/src/acp.ts'
import type { AcpDuplex } from '../packages/shared/src/engine.ts'

/**
 * Newline-delimited JSON ACP transport over one engine's stdio.
 *
 * Owner: acp-adapter. This is the only stdio ACP frame encoder/decoder. It
 * implements the frozen `AcpDuplex` port from control-protocol/engine.ts and
 * reuses the frozen `parseAcpFrame` validator, so it declares no second frame
 * shape, fault carrier, or duplex type.
 *
 * The transport preserves the complete JSON-RPC object and its id type. It
 * never rewrites a frame, drops a notification, or kills a process: `close()`
 * releases the owned streams only.
 */

export const DEFAULT_ACP_MAX_FRAME_BYTES = 8_388_608

type ClosedResult = { readonly kind: 'eof' } | { readonly kind: 'failed'; readonly error: AcpFault }

export interface StdioAcpDuplexOptions {
  readonly readable: Readable
  readonly writable: Writable
  /** Hard bound for one encoded frame, in bytes. Defaults to 8 MiB. */
  readonly maxFrameBytes?: number
  /**
   * Deadline for one `read()` call. A stalled engine is a transport failure,
   * so the duplex settles `failed` with ENGINE_UNAVAILABLE. Omitted means the
   * caller keeps no read deadline.
   */
  readonly readTimeoutMs?: number
}

interface Waiter {
  resolve: (frame: AcpFrame) => void
  reject: (error: Error) => void
}

export function createStdioAcpDuplex(options: StdioAcpDuplexOptions): AcpDuplex {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_ACP_MAX_FRAME_BYTES
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'ACP maxFrameBytes must be a positive safe integer')
  }
  const readTimeoutMs = options.readTimeoutMs
  if (readTimeoutMs !== undefined && (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1)) {
    throw new AcpError('UNSUPPORTED_CONFIGURATION', 'ACP readTimeoutMs must be a positive safe integer')
  }

  let buffer = Buffer.alloc(0)
  const pending: AcpFrame[] = []
  const waiters: Waiter[] = []
  let settled: ClosedResult | null = null
  let closing = false
  let writeChain: Promise<void> = Promise.resolve()

  let resolveClosed!: (result: ClosedResult) => void
  const closed = new Promise<ClosedResult>(resolve => { resolveClosed = resolve })

  const settle = (result: ClosedResult): void => {
    if (settled !== null) return
    settled = result
    resolveClosed(result)
    while (waiters.length > 0) {
      const waiter = waiters.shift()!
      if (result.kind === 'failed') {
        waiter.reject(new AcpError(result.error.code, result.error.message, result.error.detail))
      } else {
        waiter.reject(new AcpError('ENGINE_UNAVAILABLE', 'ACP stream reached EOF before a frame was available'))
      }
    }
  }

  const failWith = (code: AcpFault['code'], message: string): void => {
    settle({ kind: 'failed', error: { code, message } })
  }

  const deliver = (frame: AcpFrame): void => {
    const waiter = waiters.shift()
    if (waiter === undefined) pending.push(frame)
    else waiter.resolve(frame)
  }

  const consumeLine = (line: Buffer): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8'))
    } catch (cause) {
      failWith('INVALID_ACP_FRAME', `ACP engine stdout is not valid JSON: ${cause instanceof Error ? cause.message : 'parse error'}`)
      return
    }
    try {
      deliver(parseAcpFrame(parsed))
    } catch (cause) {
      failWith('INVALID_ACP_FRAME', cause instanceof Error ? cause.message : 'ACP engine frame is invalid')
    }
  }

  const onData = (chunk: Buffer | string): void => {
    if (settled !== null) return
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')])
    while (settled === null) {
      const newline = buffer.indexOf(0x0a)
      if (newline === -1) {
        if (buffer.length > maxFrameBytes) failWith('INVALID_ACP_FRAME', `ACP frame exceeds ${maxFrameBytes} bytes`)
        break
      }
      let line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      if (line.length > maxFrameBytes) {
        failWith('INVALID_ACP_FRAME', `ACP frame exceeds ${maxFrameBytes} bytes`)
        break
      }
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length === 0) {
        failWith('INVALID_ACP_FRAME', 'ACP engine stdout contained an empty line')
        break
      }
      consumeLine(line)
    }
  }

  const onEnd = (): void => {
    if (settled !== null) return
    if (buffer.length > 0) {
      failWith('INVALID_ACP_FRAME', 'ACP engine stream ended with an incomplete frame')
      return
    }
    settle({ kind: 'eof' })
  }

  const onError = (cause: Error): void => {
    if (settled !== null) return
    failWith('ENGINE_UNAVAILABLE', cause.message)
  }

  const onClose = (): void => {
    if (settled !== null) return
    if (closing) settle({ kind: 'eof' })
    else failWith('ENGINE_UNAVAILABLE', 'ACP engine stream closed unexpectedly')
  }

  options.readable.on('data', onData)
  options.readable.on('end', onEnd)
  options.readable.on('error', onError)
  options.readable.on('close', onClose)

  const writeLine = async (text: string): Promise<void> => {
    try {
      if (!options.writable.write(text)) await once(options.writable, 'drain')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'ACP write failed'
      failWith('ENGINE_UNAVAILABLE', message)
      throw cause instanceof Error ? cause : new Error(message)
    }
  }

  const read = (): Promise<AcpFrame> => {
    const queued = pending.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (settled !== null) {
      if (settled.kind === 'failed') {
        return Promise.reject(new AcpError(settled.error.code, settled.error.message, settled.error.detail))
      }
      return Promise.reject(new AcpError('ENGINE_UNAVAILABLE', 'ACP stream reached EOF'))
    }
    if (readTimeoutMs === undefined) {
      return new Promise<AcpFrame>((resolve, reject) => { waiters.push({ resolve, reject }) })
    }
    return new Promise<AcpFrame>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        const message = `ACP frame read timed out after ${readTimeoutMs}ms`
        failWith('ENGINE_UNAVAILABLE', message)
        reject(new AcpError('ENGINE_UNAVAILABLE', message))
      }, readTimeoutMs)
      waiter.resolve = frame => { clearTimeout(timer); resolve(frame) }
      waiter.reject = error => { clearTimeout(timer); reject(error) }
      waiters.push(waiter)
    })
  }

  const send = (frame: AcpFrame): Promise<void> => {
    if (settled !== null) return Promise.reject(new AcpError('ENGINE_UNAVAILABLE', 'ACP duplex is closed'))
    let text: string
    try {
      parseAcpFrame(frame)
      text = `${JSON.stringify(frame)}\n`
    } catch (cause) {
      return Promise.reject(cause)
    }
    const run = writeChain.then(() => {
      if (settled !== null) throw new AcpError('ENGINE_UNAVAILABLE', 'ACP duplex is closed')
      return writeLine(text)
    })
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  const close = async (): Promise<void> => {
    if (settled !== null) return
    closing = true
    settle({ kind: 'eof' })
    options.readable.pause()
    options.readable.destroy()
    if (!options.writable.writableEnded && !options.writable.destroyed) {
      await new Promise<void>(resolve => { options.writable.end(() => resolve()) })
    }
  }

  return { read, send, closed, close }
}
