import { expect, it, vi } from 'vitest'
import { createManagedConfigOwner } from './managed-config-owner.ts'
import { createRuntimeConfigStore } from '../config/runtime-config.ts'

it('records effective config only after launch and refuses apply during an owned operation', async () => {
  const store = createRuntimeConfigStore({ load: () => undefined, save: () => undefined })
  store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
  await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
  store.bindAgentModel(2, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
  const stop = vi.fn(async () => undefined)
  const launch = vi.fn(async () => ({ url: 'http://127.0.0.1:1', authorization: 'private', pid: 1, effectiveRevision: 3,
    closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop }))
  const owner = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
    startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '' }, launch)
  expect(await store.applyAcceptedConfig(owner)).toEqual({ status: 'applied', effectiveRevision: 3 })
  let release!: () => void
  const running = owner.use(async () => new Promise<void>(resolve => { release = resolve }))
  await expect(owner.apply(store.read())).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(stop).not.toHaveBeenCalled()
  release(); await running
  await owner.stop()
  await expect(owner.use(async () => undefined)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
})
