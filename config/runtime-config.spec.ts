import { describe, expect, it } from 'vitest'
import {
  createEmptyRuntimeConfig,
  createRuntimeConfigStore,
  type ModelEntry,
  type ProviderInstance,
  type ConfigApplyResult,
  type RuntimeConfigPersistence,
} from './runtime-config.ts'

class MemoryPersistence implements RuntimeConfigPersistence {
  private value
  loadCalls = 0
  failSaves = false

  constructor(initial = createEmptyRuntimeConfig()) {
    this.value = initial
  }

  load() {
    this.loadCalls += 1
    return this.value
  }

  save(next: typeof this.value): void {
    if (this.failSaves) throw new Error('disk full')
    this.value = next
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

const rcc: ProviderInstance = {
  id: 'rcc-4444',
  label: 'RCC',
  protocol: 'openai-responses',
  apiBaseUrl: 'http://127.0.0.1:4444/v1',
  enabled: true,
  auth: { kind: 'none' },
}

const goaichat: ProviderInstance = {
  id: 'goaichat-openai',
  label: 'GoAIChat',
  protocol: 'openai-chat',
  apiBaseUrl: 'https://llm.goaichat.top/v1',
  enabled: true,
  auth: { kind: 'bearer', credentialRef: 'cred:goaichat' },
}

const manualModel: ModelEntry = {
  ref: { providerInstanceId: rcc.id, modelId: 'manual-model' },
  origin: 'manual',
  base: { label: 'Manual model' },
  overrides: { label: 'Pinned model' },
}

describe('Teams config owner', () => {
  it('keeps same-protocol same-name models isolated by provider instance', () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    expect(persistence.loadCalls).toBe(1)
    let state = store.putProviderInstance(0, rcc)
    state = store.putProviderInstance(state.acceptedRevision, {
      ...rcc,
      id: 'rcc-secondary',
      apiBaseUrl: 'https://secondary.example/v1',
    })
    state = store.putModelEntry(state.acceptedRevision, {
      ref: { providerInstanceId: rcc.id, modelId: 'same-model' },
      origin: 'manual',
      base: { label: 'Primary' },
      overrides: {},
    })
    state = store.putModelEntry(state.acceptedRevision, {
      ref: { providerInstanceId: 'rcc-secondary', modelId: 'same-model' },
      origin: 'manual',
      base: { label: 'Secondary' },
      overrides: {},
    })

    expect(state.catalogs[rcc.id]?.entries[0]?.base.label).toBe('Primary')
    expect(state.catalogs['rcc-secondary']?.entries[0]?.base.label).toBe('Secondary')
  })

  it('merges refresh results without deleting manual entries or overrides', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    let state = store.putProviderInstance(0, rcc)
    state = store.putModelEntry(state.acceptedRevision, manualModel)
    state = store.putModelEntry(state.acceptedRevision, {
      ref: { providerInstanceId: rcc.id, modelId: 'discovered-model' },
      origin: 'discovered',
      base: { label: 'Old label', contextWindow: 1000 },
      overrides: { label: 'User label' },
    })

    const result = await store.refreshProviderModels(state.acceptedRevision, rcc.id, {
      listModels: async () => [
        { modelId: 'discovered-model', metadata: { label: 'New label', contextWindow: 2000 } },
        { modelId: 'manual-model', metadata: { label: 'Remote label' } },
      ],
    })

    expect(result.status).toBe('ready')
    expect(result.config.catalogs[rcc.id]?.entries).toEqual(expect.arrayContaining([
      manualModel,
      expect.objectContaining({
        ref: { providerInstanceId: rcc.id, modelId: 'discovered-model' },
        base: { label: 'New label', contextWindow: 2000 },
        overrides: { label: 'User label' },
        availability: 'available',
      }),
    ]))
    expect(result.config.catalogs[rcc.id]?.entries.filter(entry => entry.ref.modelId === 'manual-model')).toHaveLength(1)
  })

  it('keeps refresh failure explicit and never converts it to an empty catalog', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    let state = store.putProviderInstance(0, rcc)
    state = store.putModelEntry(state.acceptedRevision, manualModel)

    const result = await store.refreshProviderModels(state.acceptedRevision, rcc.id, {
      listModels: async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }) },
    })

    expect(result.status).toBe('error')
    expect(result.error).toMatchObject({ status: 401 })
    expect(result.config.catalogs[rcc.id]?.entries).toEqual([manualModel])
  })

  it('uses credential resolver as a port and does not persist resolved values', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    const state = store.putProviderInstance(0, goaichat)
    let resolvedReference = ''
    let resolvedValue = ''
    const result = await store.refreshProviderModels(state.acceptedRevision, goaichat.id, {
      listModels: async ({ credential }) => {
        resolvedValue = credential?.value ?? ''
        return []
      },
    }, {
      resolve: async reference => {
        resolvedReference = reference
        return { kind: 'bearer', value: 'secret-value-never-persisted' }
      },
    })

    expect(result.status).toBe('empty')
    expect(resolvedReference).toBe('cred:goaichat')
    expect(resolvedValue).toBe('secret-value-never-persisted')
    expect(JSON.stringify(result.config)).not.toContain('secret-value-never-persisted')
  })

  it('rejects stale CAS, survives store recreation, and separates effective revision', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    const state = store.putProviderInstance(0, rcc)
    expect(() => store.putProviderInstance(0, goaichat)).toThrow(/revision conflict/)

    const unsupported = await store.applyAcceptedConfig({
      apply: async () => ({
        status: 'unsupported' as const,
        error: { code: 'UNSUPPORTED_OPERATION' as const, message: 'OpenCode apply is unsupported' },
      }),
    })
    expect(unsupported.status).toBe('unsupported')
    expect(store.read().acceptedRevision).toBe(state.acceptedRevision)
    expect(store.read().effectiveRevision).toBeUndefined()
    expect(createRuntimeConfigStore(persistence).read().acceptedRevision).toBe(state.acceptedRevision)

    const failed = await store.applyAcceptedConfig({
      apply: async () => { throw new Error('apply failed') },
    })
    expect(failed).toEqual({ status: 'failed', error: { code: 'UNAVAILABLE', message: 'apply failed' } })
  })

  it('protects provider removal while an Agent binding still references it', () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    let state = store.putProviderInstance(0, rcc)
    state = store.putModelEntry(state.acceptedRevision, manualModel)
    state = store.bindAgentModel(state.acceptedRevision, 'planner', { primary: manualModel.ref })
    expect(() => store.removeProviderInstance(state.acceptedRevision, rcc.id)).toThrow(/binding/)
  })

  it('does not overwrite a newer accepted config when apply is deferred', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    const accepted = store.putProviderInstance(0, rcc)
    const result = deferred<ConfigApplyResult>()
    const applying = store.applyAcceptedConfig({ apply: async config => {
      expect(config.acceptedRevision).toBe(accepted.acceptedRevision)
      return result.promise
    } })

    const updated = store.putProviderInstance(accepted.acceptedRevision, { ...rcc, label: 'RCC updated' })
    result.resolve({ status: 'applied', effectiveRevision: accepted.acceptedRevision })
    await expect(applying).resolves.toMatchObject({ status: 'applied' })

    expect(store.read().acceptedRevision).toBe(updated.acceptedRevision)
    expect(store.read().providers[rcc.id]?.label).toBe('RCC updated')
    expect(createRuntimeConfigStore(persistence).read().providers[rcc.id]?.label).toBe('RCC updated')
  })

  it('rejects overlapping apply side effects instead of trusting callback order', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    const accepted = store.putProviderInstance(0, rcc)
    const firstGate = deferred<void>()
    let actualEffectiveRevision: number | undefined
    const first = store.applyAcceptedConfig({ apply: async config => {
      await firstGate.promise
      actualEffectiveRevision = config.acceptedRevision
      return { status: 'applied', effectiveRevision: config.acceptedRevision }
    } })
    const updated = store.putProviderInstance(accepted.acceptedRevision, { ...rcc, label: 'RCC updated' })
    const second = store.applyAcceptedConfig({ apply: async config => {
      actualEffectiveRevision = config.acceptedRevision
      return { status: 'applied', effectiveRevision: config.acceptedRevision }
    } })

    await expect(second).rejects.toMatchObject({ code: 'CONFLICT' })
    firstGate.resolve()
    await expect(first).resolves.toMatchObject({ status: 'applied' })
    expect(actualEffectiveRevision).toBe(accepted.acceptedRevision)
    expect(store.read().acceptedRevision).toBe(updated.acceptedRevision)
    expect(store.read().effectiveRevision).toBe(accepted.acceptedRevision)
  })

  it('does not update memory before durable apply observation is saved', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    const accepted = store.putProviderInstance(0, rcc)
    persistence.failSaves = true

    await expect(store.applyAcceptedConfig({
      apply: async () => ({ status: 'applied' as const, effectiveRevision: accepted.acceptedRevision }),
    })).rejects.toThrow('disk full')
    expect(store.read().effectiveRevision).toBeUndefined()
    expect(createRuntimeConfigStore(persistence).read().effectiveRevision).toBeUndefined()
  })

  it('isolates accepted state from mutable provider, binding, and read aliases', () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    const provider = { ...rcc }
    let state = store.putProviderInstance(0, provider)
    provider.label = 'caller mutation'
    expect(store.read().providers[rcc.id]?.label).toBe('RCC')

    const snapshot = store.read()
    ;(snapshot.providers[rcc.id] as { label: string }).label = 'read mutation'
    expect(store.read().providers[rcc.id]?.label).toBe('RCC')

    state = store.putModelEntry(state.acceptedRevision, manualModel)
    const binding = { primary: { ...manualModel.ref } }
    state = store.bindAgentModel(state.acceptedRevision, 'planner', binding)
    binding.primary.modelId = 'caller mutation'
    expect(store.read().agents.planner?.primary.modelId).toBe(manualModel.ref.modelId)
  })
})
