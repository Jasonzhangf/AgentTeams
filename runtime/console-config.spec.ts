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
it('puts a manual model through the typed console binding with CAS and projection readback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-model-put-')); directories.push(directory)
  const store = createRuntimeConfigStore(createJsonFileConfigPersistence(join(directory, 'config.json')))
  const binding = createConsoleConfigBinding({ agentId: 'a', store,
    models: { listModels: async () => [] },
    applier: { apply: async config => ({ status: 'applied', effectiveRevision: config.acceptedRevision }) },
  })
  await binding.command({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: {
    id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'https://example.test/v1', enabled: true, auth: { kind: 'none' },
  } })
  const entry = { ref: { providerInstanceId: 'p', modelId: 'manual' }, origin: 'manual' as const,
    base: { label: 'Manual', contextWindow: 4096 }, overrides: { label: 'Pinned' } }
  await expect(binding.command({ kind: 'config.model.put', agentId: 'a', expectedRevision: 0, entry })).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
  await expect(binding.command({ kind: 'config.model.put', agentId: 'a', expectedRevision: 1, entry })).resolves.toEqual({ ok: true })
  expect(store.read().acceptedRevision).toBe(2)
  expect(binding.readProjection()).toMatchObject({ acceptedRevision: 2, providers: [{ id: 'p', catalogState: 'ready', models: [{ id: 'manual', label: 'Pinned' }] }] })
  expect(JSON.stringify(binding.readProjection())).not.toContain('credential')
})
it('selects explicit backup through console binding, advances accepted revision, and readback survives restart after apply', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-backup-')); directories.push(directory)
  const file = join(directory, 'config.json')
  const store = createRuntimeConfigStore(createJsonFileConfigPersistence(file))
  const binding = createConsoleConfigBinding({ agentId: 'a', store,
    models: { listModels: async ({ provider }) => provider.id === 'goaichat'
      ? [{ modelId: 'qwen3.8-max', metadata: {} }]
      : [{ modelId: 'gpt-5.5', metadata: {} }] },
    credentials: { resolve: async () => ({ kind: 'bearer', value: 'secret-not-projected' }) },
    applier: { apply: async config => ({ status: 'applied', effectiveRevision: config.acceptedRevision }) },
  })
  await binding.command({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: {
    id: 'rcc', label: 'RCC', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:4444/v1', enabled: true, auth: { kind: 'none' },
  } })
  await binding.command({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 1, provider: {
    id: 'goaichat', label: 'GoAIChat', protocol: 'openai-chat', apiBaseUrl: 'https://llm.goaichat.top/v1', enabled: true,
    auth: { kind: 'bearer', credentialRef: 'cred:goaichat' },
  } })
  await binding.command({ kind: 'config.refreshModels', agentId: 'a', expectedRevision: 2, providerId: 'rcc' })
  await binding.command({ kind: 'config.refreshModels', agentId: 'a', expectedRevision: 3, providerId: 'goaichat' })
  await binding.command({ kind: 'config.bindModel', agentId: 'a', expectedRevision: 4, providerId: 'rcc', modelId: 'gpt-5.5' })
  expect(store.read().agents.a).toEqual({ primary: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' } })

  await binding.command({ kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: 5, backup: { providerInstanceId: 'goaichat', modelId: 'qwen3.8-max' } })
  expect(store.read().acceptedRevision).toBe(6)
  expect(store.read().agents.a).toEqual({
    primary: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' },
    backup: { providerInstanceId: 'goaichat', modelId: 'qwen3.8-max' },
  })
  expect(store.readEffective()).toEqual({ acceptedRevision: 6 })
  await binding.command({ kind: 'config.apply', agentId: 'a' })
  expect(store.readEffective()).toEqual({ acceptedRevision: 6, effectiveRevision: 6 })

  const restarted = createConsoleConfigBinding({ agentId: 'a', store: createRuntimeConfigStore(createJsonFileConfigPersistence(file)),
    models: { listModels: async () => [] },
    applier: { apply: async config => ({ status: 'applied', effectiveRevision: config.acceptedRevision }) },
  })
  expect(restarted.readProjection()).toMatchObject({
    agentId: 'a', acceptedRevision: 6, effectiveRevision: 6,
    providers: [
      { id: 'rcc', authKind: 'none', catalogState: 'ready', models: [{ id: 'gpt-5.5' }] },
      { id: 'goaichat', authKind: 'bearer', catalogState: 'ready', models: [{ id: 'qwen3.8-max' }] },
    ],
  })
  expect(JSON.stringify(restarted.readProjection())).not.toContain('secret-not-projected')
  expect(JSON.stringify(restarted.readProjection())).not.toContain('cred:goaichat')
})
it('rejects stale, missing, conflicting, and wrong-target backup selection without mutating config', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-backup-errors-')); directories.push(directory)
  const store = createRuntimeConfigStore(createJsonFileConfigPersistence(join(directory, 'config.json')))
  store.putProviderInstance(0, { id: 'rcc', label: 'RCC', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:4444/v1', enabled: true,
    auth: { kind: 'none' } })
  store.putModelEntry(1, { ref: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' }, origin: 'manual', base: {}, overrides: {} })
  store.bindAgentModel(2, 'a', { primary: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' } })
  const binding = createConsoleConfigBinding({ agentId: 'a', store,
    models: { listModels: async () => [] },
    applier: { apply: async () => ({ status: 'unsupported', error: { code: 'UNSUPPORTED_OPERATION', message: 'not invoked' } }) },
  })
  const current = store.read().acceptedRevision
  await expect(binding.command({ kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: current - 1,
    backup: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' } })).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
  await expect(binding.command({ kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: current,
    backup: { providerInstanceId: 'missing', modelId: 'm' } })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  await expect(binding.command({ kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: current,
    backup: { providerInstanceId: 'rcc', modelId: 'missing' } })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  await expect(binding.command({ kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: current,
    backup: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' } })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  await expect(binding.command({ kind: 'config.agent.select-backup', agentId: 'other', expectedRevision: current,
    backup: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' } })).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  expect(store.read().acceptedRevision).toBe(current)
  expect(store.read().agents.a).toEqual({ primary: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' } })
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
