import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ACP_MAX_FRAME_BYTES, createStdioAcpDuplex } from './stdio.ts'

function createPair(maxFrameBytes = 1024) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = createStdioAcpDuplex({ readable: bToA, writable: aToB, maxFrameBytes })
  const b = createStdioAcpDuplex({ readable: aToB, writable: bToA, maxFrameBytes })
  return { a, b, aToB, bToA }
}

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error('expected rejection') },
    error => error,
  )
}

describe('ACP stdio duplex', () => {
  it('uses an explicit 8 MiB default and reads UTF-8 CRLF NDJSON frames losslessly', async () => {
    expect(DEFAULT_ACP_MAX_FRAME_BYTES).toBe(8_388_608)
    const { a, bToA } = createPair()
    const frame = { jsonrpc: '2.0', id: 'u-1', method: 'session/prompt', params: { text: '你好', keep: [1, null, true] } }
    bToA.write(`${JSON.stringify(frame)}\r\n`)
    await expect(a.read()).resolves.toEqual(frame)
  })

  it('serializes writes and waits for backpressure', async () => {
    const chunks: string[] = []
    const writable = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString())
        setTimeout(callback, 5)
      },
    })
    const duplex = createStdioAcpDuplex({ readable: new PassThrough(), writable, maxFrameBytes: 1024 })
    const first = { jsonrpc: '2.0', id: 1, method: 'one' }
    const second = { jsonrpc: '2.0', id: 2, method: 'two' }
    await Promise.all([duplex.send(first), duplex.send(second)])
    expect(chunks).toEqual([`${JSON.stringify(first)}\n`, `${JSON.stringify(second)}\n`])
  })

  it('keeps independently correlated bidirectional IDs opaque to transport', async () => {
    const { a, b } = createPair()
    const left = { jsonrpc: '2.0', id: 7, method: 'left' }
    const right = { jsonrpc: '2.0', id: 7, method: 'right' }
    await Promise.all([a.send(left), b.send(right)])
    await expect(b.read()).resolves.toEqual(left)
    await expect(a.read()).resolves.toEqual(right)
  })

  it('fails invalid JSON and oversize frames explicitly', async () => {
    const invalid = createPair()
    invalid.bToA.write('not-json\n')
    await expect(failure(invalid.a.read())).resolves.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    await expect(invalid.a.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })

    const oversize = createPair(8)
    oversize.bToA.write('{"jsonrpc":"2.0","method":"x"}')
    await expect(failure(oversize.a.read())).resolves.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    await expect(oversize.a.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
  })

  it('reports a truncated EOF as a framing failure', async () => {
    const { a, bToA } = createPair()
    bToA.write('{"jsonrpc":"2.0"')
    bToA.end()
    await expect(failure(a.read())).resolves.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    await expect(a.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
  })

  it('closes owned streams and reports EOF without killing a process', async () => {
    const { a, b } = createPair()
    await a.close()
    await expect(a.closed).resolves.toEqual({ kind: 'eof' })
    await expect(b.closed).resolves.toEqual({ kind: 'eof' })
  })
})
