import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createJsonFileConfigPersistence, createRuntimeConfigStore } from '../config/runtime-config.ts'
import { createConsoleConfigBinding } from './console-config.ts'
import { createServer } from 'node:http'
import { createConsoleApiHandler } from '../console-host/src/http-api.ts'
import { createConsoleHttpClient } from '../ui/teams-console/src/client/api.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }) })
it('routes config CAS to durable owner and retains apply failure without effective success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-config-')); directories.push(directory)
  const file = join(directory, 'config.json')
  const store = createRuntimeConfigStore(createJsonFileConfigPersistence(file))
  const binding = createConsoleConfigBinding({ agentId: 'a', store,
    models: { listModels: async () => [{ modelId: 'm', metadata: {} }] },
    applier: { apply: async () => ({ status: 'unsupported', error: { code: 'UNSUPPORTED_OPERATION', message: 'Managed child absent' } }) },
  })
  await binding.command({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: {
    id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'https://example.test/v1', enabled: true, auth: { kind: 'none' },
  } })
  await expect(binding.command({ kind: 'config.refreshModels', agentId: 'a', expectedRevision: 0, providerId: 'p' })).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
  await binding.command({ kind: 'config.refreshModels', agentId: 'a', expectedRevision: 1, providerId: 'p' })
  await binding.command({ kind: 'config.bindModel', agentId: 'a', expectedRevision: 2, providerId: 'p', modelId: 'm' })
  await expect(binding.command({ kind: 'config.apply', agentId: 'a' })).resolves.toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
  const reloaded = createRuntimeConfigStore(createJsonFileConfigPersistence(file)).read()
  expect(reloaded.agents.a.primary).toEqual({ providerInstanceId: 'p', modelId: 'm' })
  expect(reloaded.acceptedRevision).toBe(3)
  expect(reloaded.effectiveRevision).toBeUndefined()
  expect(reloaded.lastApplyError?.code).toBe('UNSUPPORTED_OPERATION')
  expect(binding.readProjection()).toMatchObject({ agentId: 'a', acceptedRevision: 3,
    providers: [{ id: 'p', authKind: 'none', catalogState: 'ready', models: [{ id: 'm' }] }],
    error: { code: 'UNSUPPORTED_OPERATION' },
  })
  expect(binding.readProjection()).not.toHaveProperty('effectiveRevision')
  await expect(binding.command({ kind: 'config.apply', agentId: 'other' })).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
})
it('carries credential error context through real HTTP to the UI client without converting it to success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-errors-')); directories.push(directory)
  const store = createRuntimeConfigStore(createJsonFileConfigPersistence(join(directory, 'config.json')))
  store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'https://example.test/v1', enabled: true,
    auth: { kind: 'bearer', credentialRef: 'private-reference' } })
  const binding = createConsoleConfigBinding({ agentId: 'a', store,
    models: { listModels: async () => { throw new Error('must not reach provider without credentials') } },
    applier: { apply: async () => { throw new Error('not invoked') } },
  })
  const server = createServer(createConsoleApiHandler({ authorize: async () => ({
    readProjection: async () => { throw new Error('not invoked') },
    sendSession: async () => { throw new Error('not invoked') },
    command: async command => {
      if (command.kind !== 'config.refreshModels') throw new Error('test supports only refresh')
      return binding.command(command)
    },
  }) }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const client = createConsoleHttpClient({ baseUrl: `http://127.0.0.1:${address.port}` })
    const result = await client.command({ kind: 'config.refreshModels', agentId: 'a', expectedRevision: 1, providerId: 'p' })
    expect(result).toEqual({ ok: false, error: store.read().catalogs.p.error })
    expect(result).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE', providerInstanceId: 'p' } })
    expect(JSON.stringify(result)).not.toContain('private-reference')
    expect(JSON.stringify(binding.readProjection())).not.toContain('private-reference')
    expect(binding.readProjection().providers[0]).toMatchObject({ authKind: 'bearer', catalogState: 'error', error: { code: 'CREDENTIAL_UNAVAILABLE' } })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
