import { describe, expect, it } from 'vitest'
import { runFixedProcess } from './fixed-process.ts'

describe('fixed process runner', () => {
  it('does not invoke a shell and returns JSON stdout/stderr separately', async () => {
    const output = await runFixedProcess({
      executable: process.execPath,
      argv: ['-e', 'process.stdout.write(JSON.stringify({ok:true})); process.stderr.write("warn")'],
      shell: false,
    })
    expect(output.exitCode).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual({ ok: true })
    expect(output.stderr).toBe('warn')
  })

  it('returns nonzero exit status without converting it to success', async () => {
    const output = await runFixedProcess({
      executable: process.execPath,
      argv: ['-e', 'process.stderr.write("failed"); process.exit(9)'],
      shell: false,
    })
    expect(output.exitCode).toBe(9)
    expect(output.stderr).toBe('failed')
  })

  it('reports SIGTERM when a timed-out child exits on the graceful signal', async () => {
    const startedAt = Date.now()
    const output = await runFixedProcess({
      executable: process.execPath,
      argv: ['-e', 'process.stdout.write("ready\\n", () => setInterval(() => {}, 10))'],
      timeoutMs: 100,
      readyToken: 'ready\n',
      shell: false,
    })

    expect(output.timedOut).toBe(true)
    expect(output.signal).toBe('SIGTERM')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
  })

  it('forces a child that ignores SIGTERM to close after the grace period', async () => {
    const startedAt = Date.now()
    const output = await runFixedProcess({
      executable: process.execPath,
      argv: ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n", () => setInterval(() => {}, 10))'],
      timeoutMs: 100,
      readyToken: 'ready\n',
      shell: false,
    })

    expect(output.timedOut).toBe(true)
    expect(output.signal).toBe('SIGKILL')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200)
  })

  it('forces an output-limited child that ignores SIGTERM to close', async () => {
    const output = await runFixedProcess({
      executable: process.execPath,
      argv: ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n", () => setInterval(() => process.stdout.write("x".repeat(1024)), 1))'],
      maxOutputBytes: 1_024,
      readyToken: 'ready\n',
      shell: false,
    })

    expect(output.outputLimitExceeded).toBe(true)
    expect(output.timedOut).toBe(false)
    expect(output.signal).toBe('SIGKILL')
  })

  it('reports a real child stdin close as an explicit process error', async () => {
    await expect(runFixedProcess({
      executable: process.execPath,
      argv: ['-e', 'process.stdin.resume(); process.stdin.once("data", () => process.stdin.destroy()); setTimeout(() => {}, 500)'],
      stdin: 'x'.repeat(16 * 1024 * 1024),
      timeoutMs: 1_000,
      shell: false,
    })).rejects.toMatchObject({
      error: { code: 'PROCESS_ERROR', message: expect.stringMatching(/stdin/) },
    })
  })
})
