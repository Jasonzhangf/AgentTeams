import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonFileConfigPersistence, createRuntimeConfigStore } from '../config/runtime-config.ts'
import { createConsoleConfigBinding } from './console-config.ts'
import { createManagedConfigOwner } from './managed-config-owner.ts'

const startupTimeoutMs = 10_000
const stopTimeoutMs = 3_000

it('applies accepted Teams config to a real isolated OpenCode child and reads effective revision', { timeout: 18_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-live-'))
  const store = createRuntimeConfigStore(createJsonFileConfigPersistence(join(directory, 'teams-config.json')))
  let managed: ReturnType<typeof createManagedConfigOwner> | undefined
  try {
    store.putProviderInstance(0, { id: 'rcc-4444', label: 'RCC 4444', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:4444/v1', enabled: true,
      auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'rcc-4444', { listModels: async () => [{ modelId: 'gpt-5.5', metadata: { label: 'gpt-5.5' } }] })
    store.bindAgentModel(2, 'llm-agent', { primary: { providerInstanceId: 'rcc-4444', modelId: 'gpt-5.5' } })
    // Choose an available port after the test store is ready; child configuration is real.
    const net = await import('node:net')
    const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
    managed = createManagedConfigOwner({ agentId: 'llm-agent', executable: '/Users/fanzhang/.opencode/bin/opencode', directory: join(directory, 'opencode'),
      port, startupTimeoutMs, stopTimeoutMs, resolveCredential: async () => { throw new Error('credential resolver must not run') } })
    const binding = createConsoleConfigBinding({ agentId: 'llm-agent', store, models: { listModels: async () => [] }, applier: managed })
    expect(await binding.command({ kind: 'config.apply', agentId: 'llm-agent' })).toEqual({ ok: true })
    expect(store.readEffective()).toEqual({ acceptedRevision: 3, effectiveRevision: 3 })
  } finally {
    try { await managed?.stop() }
    finally { await rm(directory, { recursive: true }) }
  }
})
