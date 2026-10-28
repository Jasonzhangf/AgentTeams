import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { processAlive, terminateProcess } from './local-ownership.ts'

function startTestChild(source: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.once('error', reject)
    child.stdout!.setEncoding('utf8')
    child.stdout!.once('data', data => {
      if (String(data).includes('ready')) resolve(child.pid!)
      else reject(new Error(`unexpected child output: ${String(data)}`))
    })
    child.once('exit', code => reject(new Error(`child exited before ready: ${code}`)))
  })
}

it('stops a cooperative runtime with SIGTERM', async () => {
  const pid = await startTestChild("console.log('ready'); setInterval(() => {}, 1000)")
  await expect(terminateProcess(pid, { gracefulMs: 2_000, hardMs: 1_000 })).resolves.toBe('exited')
  expect(processAlive(pid)).toBe(false)
})

it('kills a runtime that ignores SIGTERM', async () => {
  const pid = await startTestChild("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)")
  await expect(terminateProcess(pid, { gracefulMs: 300, hardMs: 2_000 })).resolves.toBe('killed')
  expect(processAlive(pid)).toBe(false)
})
