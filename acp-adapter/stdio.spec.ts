import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpError, type AcpFrame } from '../control-protocol/acp.ts'
import { createStdioAcpDuplex } from './stdio.ts'

const peerPath = fileURLToPath(new URL('./test-peer.mjs', import.meta.url))

interface Harness {
  readonly duplex: ReturnType<typeof createStdioAcpDuplex>
  readonly engineOut: PassThrough
  readonly hostOut: PassThrough
  sentLines(): readonly string[]
}

function makeHarness(options: { readonly maxFrameBytes?: number; readonly readTimeoutMs?: number } = {}): Harness {
  const engineOut = new PassThrough()
  const hostOut = new PassThrough()
  const chunks: string[] = []
  hostOut.on('data', chunk => chunks.push(chunk.toString('utf8')))
  const duplex = createStdioAcpDuplex({ readable: engineOut, writable: hostOut, ...options })
  return {
    duplex,
    engineOut,
    hostOut,
    sentLines: () => chunks.join('').split('\n').filter(line => line.length > 0),
  }
}

interface PeerHarness {
  readonly duplex: ReturnType<typeof createStdioAcpDuplex>
  readonly child: ChildProcess
}

const children = new Set<ChildProcess>()

function spawnPeer(mode: string, options: { readonly maxFrameBytes?: number; readonly readTimeoutMs?: number } = {}): PeerHarness {
  const child = spawn(process.execPath, [peerPath, mode], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const duplex = createStdioAcpDuplex({
    readable: child.stdout!,
    writable: child.stdin!,
    ...options,
  })
  return { duplex, child }
}

/** Waits for the natural exit inside a bounded window, then forces cleanup. */
async function waitExit(child: ChildProcess): Promise<{ readonly natural: boolean; readonly code: number | null; readonly signal: string | null }> {
  if (child.exitCode === null && child.signalCode === null) {
    const natural = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 1_000)
      child.once('exit', () => { clearTimeout(timer); resolve(true) })
    })
    if (!natural) {
      child.kill('SIGKILL')
      await new Promise<void>(resolve => { child.once('exit', () => resolve()) })
    }
    return { natural, code: child.exitCode, signal: child.signalCode }
  }
  return { natural: true, code: child.exitCode, signal: child.signalCode }
}

afterEach(async () => {
  for (const child of [...children]) {
    await waitExit(child)
    children.delete(child)
  }
})

describe('createStdioAcpDuplex', () => {
  it('carries requests, notifications and responses in both directions with the original id type', async () => {
    const harness = makeHarness()
    await harness.duplex.send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } })
    await harness.duplex.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } })
    await harness.duplex.send({ jsonrpc: '2.0', id: '1', result: { stopReason: 'end_turn' } })
    expect(harness.sentLines()).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s1","prompt":[]}}',
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}',
      '{"jsonrpc":"2.0","id":"1","result":{"stopReason":"end_turn"}}',
    ])

    harness.engineOut.write('{"jsonrpc":"2.0","id":7,"method":"session/update","params":{"sessionId":"s1","update":{"kind":"a"}}}\n')
    harness.engineOut.write('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}\r\n')
    harness.engineOut.write('{"jsonrpc":"2.0","id":"cb-1","method":"session/request_permission","params":{"options":[]}}\n')
    const update = await harness.duplex.read()
    const response = await harness.duplex.read()
    const callback = await harness.duplex.read()
    expect(update).toEqual({ jsonrpc: '2.0', id: 7, method: 'session/update', params: { sessionId: 's1', update: { kind: 'a' } } })
    expect(response).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
    expect(callback.id).toBe('cb-1')
    expect(typeof callback.id).toBe('string')
  })

  it('preserves legal extension members and _meta instead of stripping payload', async () => {
    const harness = makeHarness()
    const frame: AcpFrame = { jsonrpc: '2.0', id: 3, method: 'x/y', params: { _meta: { trace: 'keep' } }, extension: { keep: true } }
    await harness.duplex.send(frame)
    expect(JSON.parse(harness.sentLines()[0])).toEqual(frame)
  })

  it('rejects an invalid outbound frame before writing anything', async () => {
    const harness = makeHarness()
    await expect(harness.duplex.send({ jsonrpc: '2.0' } as AcpFrame)).rejects.toBeInstanceOf(AcpError)
    await expect(harness.duplex.send({ jsonrpc: '1.0', id: 1, result: {} } as AcpFrame)).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(harness.sentLines()).toHaveLength(0)
  })

  it('fails the duplex on a protocol fault, an empty line and a non-object line', async () => {
    for (const [probe, message] of [
      ['not json\n', 'not valid JSON'],
      ['[]\n', 'must be an object'],
      ['{"jsonrpc":"2.0"}\n', 'requires an id'],
      ['\n', 'empty line'],
    ] as const) {
      const harness = makeHarness()
      harness.engineOut.write(probe)
      await expect(harness.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
      expect((await harness.duplex.closed as { error: { message: string } }).error.message).toContain(message)
      await expect(harness.duplex.read()).rejects.toMatchObject({ code: 'INVALID_ACP_FRAME' })
    }
  })

  it('bounds one frame by maxFrameBytes', async () => {
    const harness = makeHarness({ maxFrameBytes: 32 })
    harness.engineOut.write(`{"jsonrpc":"2.0","id":1,"result":{"pad":"${'x'.repeat(64)}"}}\n`)
    await expect(harness.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
  })

  it('settles clean EOF and rejects a pending or later read with ENGINE_UNAVAILABLE', async () => {
    const harness = makeHarness()
    const pending = harness.duplex.read()
    harness.engineOut.end()
    await expect(harness.duplex.closed).resolves.toEqual({ kind: 'eof' })
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    await expect(harness.duplex.read()).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    await expect(harness.duplex.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
  })

  it('reports an incomplete trailing frame at EOF as a protocol fault', async () => {
    const harness = makeHarness()
    harness.engineOut.write('{"jsonrpc":"2.0","id":1')
    harness.engineOut.end()
    await expect(harness.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
  })

  it('reports an unexpected stream close as ENGINE_UNAVAILABLE', async () => {
    const harness = makeHarness()
    harness.engineOut.destroy()
    await expect(harness.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'ENGINE_UNAVAILABLE' } })
  })

  it('times out one stalled read as a typed transport failure', async () => {
    const harness = makeHarness({ readTimeoutMs: 40 })
    await expect(harness.duplex.read()).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    await expect(harness.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'ENGINE_UNAVAILABLE' } })
  })

  it('closes owned streams without killing the process and settles eof', async () => {
    const harness = makeHarness()
    await harness.duplex.close()
    await expect(harness.duplex.closed).resolves.toEqual({ kind: 'eof' })
    expect(harness.engineOut.destroyed).toBe(true)
    expect(harness.hostOut.writableEnded).toBe(true)
  })
})

describe('createStdioAcpDuplex over a real child process (test peer)', () => {
  it('performs a real bidirectional ACP exchange, including an engine callback', async () => {
    const peer = spawnPeer('callback')
    await peer.duplex.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: {} } })
    const init = await peer.duplex.read()
    expect(init.result).toMatchObject({ protocolVersion: 1 })

    await peer.duplex.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } })
    const session = await peer.duplex.read()
    expect(typeof (session.result as { sessionId: string }).sessionId).toBe('string')

    await peer.duplex.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'test-peer-session-1', prompt: [{ type: 'text', text: 'hi' }] } })
    const update = await peer.duplex.read()
    expect(update.method).toBe('session/update')
    const callback = await peer.duplex.read()
    expect(callback.method).toBe('session/request_permission')
    expect(typeof callback.id).toBe('string')
    await peer.duplex.send({ jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
    const result = await peer.duplex.read()
    expect(result.id).toBe(3)
    expect(result.result).toMatchObject({ callback: { outcome: { outcome: 'selected', optionId: 'allow' } } })

    await peer.duplex.close()
    const stopped = await waitExit(peer.child)
    expect(stopped.natural).toBe(true)
    expect(stopped.code).toBe(0)
  })

  it('observes child exit as EOF and stop cleanup leaves no orphan', async () => {
    const peer = spawnPeer('acp')
    await peer.duplex.send({ jsonrpc: '2.0', id: 1, method: 'test/exit', params: {} })
    await peer.duplex.closed
    const stopped = await waitExit(peer.child)
    expect(stopped.natural).toBe(true)
    expect(stopped.code).toBe(0)
    expect(peer.child.killed).toBe(false)
  })

  it('reports a crash before readiness and a malformed peer as typed failures', async () => {
    const crash = spawnPeer('crash')
    const crashExit = new Promise<number | null>(resolve => { crash.child.once('exit', code => resolve(code)) })
    expect(await crashExit).toBe(3)
    // A child that exits without a partial frame ends the stream cleanly; the
    // runtime turns that EOF plus the exit code into its typed start failure.
    await expect(crash.duplex.closed).resolves.toEqual({ kind: 'eof' })

    const malformed = spawnPeer('malformed')
    await expect(malformed.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
    await waitExit(malformed.child)
  })

  it('bounds a real oversized frame and an incomplete peer exit', async () => {
    const oversize = spawnPeer('oversize', { maxFrameBytes: 4096 })
    await expect(oversize.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
    await waitExit(oversize.child)

    const incomplete = spawnPeer('incomplete')
    await expect(incomplete.duplex.closed).resolves.toMatchObject({ kind: 'failed', error: { code: 'INVALID_ACP_FRAME' } })
    await waitExit(incomplete.child)
  })

  it('times out a real silent peer', async () => {
    const silent = spawnPeer('silent', { readTimeoutMs: 80 })
    await expect(silent.duplex.read()).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    await expect(silent.duplex.closed).resolves.toMatchObject({ kind: 'failed' })
    await waitExit(silent.child)
  })
})
