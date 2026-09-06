import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startManagedOpenCode } from './managed-opencode.ts'

it('rejects child exit before readiness instead of reporting effective config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-test-'))
  const executable = join(directory, 'exit')
  await writeFile(executable, '#!/bin/sh\nexit 17\n'); await chmod(executable, 0o700)
  try {
    await expect(startManagedOpenCode({ executable, directory, port: 32145, startupTimeoutMs: 1000, stopTimeoutMs: 1000,
      compiled: { agentId: 'a', acceptedRevision: 1, primary: { provider: 'p', model: 'm', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1' } },
      resolveCredential: async () => { throw new Error('no credential expected') } })).rejects.toThrow(/exited/)
  } finally { await rm(directory, { recursive: true }) }
})
