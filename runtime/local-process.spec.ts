import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeLocalConfig } from './local-config.ts'
import { runLocalProcess } from './local-process.ts'
import type { LocalSupervisor } from './local-supervisor.ts'

it('turns a post-ready supervisor failure into cleanup and a nonzero launcher result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-process-'))
  const path = join(root, 'config.toml')
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await writeLocalConfig(path, `version = 1

[relay]
config = "relay.json"

[daemons.browser]
config = "browser.json"
`)
    let state: LocalSupervisor['state'] extends () => infer S ? S : never = 'stopped'
    let stopped = false
    const failure = new Error('child exited unexpectedly')
    const supervisor: LocalSupervisor = {
      state: () => state,
      failure: () => state === 'failed' ? failure : undefined,
      processes: () => [],
      start: async () => { state = 'running'; setTimeout(() => { state = 'failed' }, 10) },
      stop: async () => { stopped = true; state = 'stopped' },
    }
    await expect(runLocalProcess(['--config', path], () => supervisor)).rejects.toThrow(failure.message)
    expect(stopped).toBe(true)
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = previousExitCode
    await rm(root, { recursive: true, force: true })
  }
})
