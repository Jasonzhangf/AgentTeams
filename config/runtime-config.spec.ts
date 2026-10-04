import { describe, expect, it } from 'vitest'
import {
  createEmptyRuntimeConfig,
  createRuntimeConfigStore,
  providerIntentFingerprint,
  RuntimeConfigError,
  type ConfigApplyResult,
  type ConfigApplyError,
  type DaemonRuntimeConfigView,
  type ManagedConfigUncertainty,
  type ModelEntry,
  type ProviderInstance,
  type ProviderCatalogObservation,
  type RuntimeConfigPersistence,
  type RuntimeConfigObservationPatch,
  type RuntimeConfigStoreSections,
  type VersionedRuntimeConfig,
} from './runtime-config.ts'

class MemoryPersistence implements RuntimeConfigPersistence {
  readonly agentId = 'a'
  private sourceRevision = 0
  private sourceHash = 'sha256:'
  private machine: RuntimeConfigStoreSections = { providers: {}, models: [], bindings: {} }
  private accepted?: { acceptedRevision: number; acceptedSourceRevision: number; acceptedSourceHash: string; snapshot: VersionedRuntimeConfig }
  private effective: { effectiveRevision?: number; applyState?: 'clean' | 'uncertain'; lastApplyError?: ConfigApplyError; uncertain?: ManagedConfigUncertainty[] } = {}
  private observations: Record<string, Record<string, ProviderCatalogObservation>> = {}
  loadCalls = 0
  failSaves = false
  queue: Promise<unknown> = Promise.resolve()

  async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async loadDaemonUnlocked(agentId: string): Promise<DaemonRuntimeConfigView> {
    this.loadCalls += 1
    if (agentId !== this.agentId) throw new Error('wrong agent')
    const snapshot = this.accepted?.snapshot ?? createEmptyRuntimeConfig()
    const providers = this.accepted === undefined ? this.machine.providers : snapshot.providers
    const catalogs: Record<string, VersionedRuntimeConfig['catalogs'][string]> = {}
    for (const provider of Object.values(providers)) {
      const manual = (snapshot.catalogs[provider.id]?.entries ?? this.machine.models).filter(entry => entry.ref.providerInstanceId === provider.id && entry.origin === 'manual')
      const observation = this.observations[agentId]?.[provider.id]
      if (observation !== undefined && observation.providerFingerprint === providerIntentFingerprint(provider)) {
        catalogs[provider.id] = {
          state: observation.state,
          entries: [...manual, ...observation.discoveredEntries],
          ...(observation.refreshedAt === undefined ? {} : { refreshedAt: observation.refreshedAt }),
          ...(observation.error === undefined ? {} : { error: observation.error }),
        }
      } else if (observation !== undefined) {
        catalogs[provider.id] = { state: 'stale', entries: manual.map(entry => ({ ...entry, availability: 'unavailable' as const })) }
      } else {
        catalogs[provider.id] = { state: manual.length > 0 ? 'ready' : 'empty', entries: manual }
      }
    }
    return {
      agentId,
      revision: this.accepted?.acceptedRevision ?? 0,
      acceptedRevision: this.accepted?.acceptedRevision ?? 0,
      ...(this.effective.effectiveRevision === undefined ? {} : { effectiveRevision: this.effective.effectiveRevision }),
      providers: structuredClone(providers),
      catalogs,
      agents: structuredClone(this.accepted?.snapshot.agents ?? this.machine.bindings),
      ...(this.effective.lastApplyError === undefined ? {} : { lastApplyError: this.effective.lastApplyError }),
      sourceRevision: this.sourceRevision,
      sourceHash: this.sourceHash,
      acceptedSourceRevision: this.accepted?.acceptedSourceRevision ?? 0,
      acceptedSourceHash: this.accepted?.acceptedSourceHash ?? '',
      applyState: this.effective.applyState ?? 'clean',
      targetGeneration: 1,
      ...(this.effective.uncertain === undefined ? {} : { uncertain: this.effective.uncertain }),
    } as DaemonRuntimeConfigView
  }

  async saveMachineSourceUnlocked(input: {
    expectedSourceRevision: number
    expectedSourceHash: string
    sections: RuntimeConfigStoreSections
  }): Promise<{ sourceRevision: number; sourceHash: string }> {
    if (this.failSaves) throw new Error('disk full')
    if (input.expectedSourceRevision !== this.sourceRevision || input.expectedSourceHash !== this.sourceHash) {
      throw new RuntimeConfigError({ code: 'SOURCE_CHANGED', message: 'machine source changed' })
    }
    this.machine = structuredClone(input.sections)
    this.sourceRevision += 1
    this.sourceHash = `sha256:${this.sourceRevision}`
    return { sourceRevision: this.sourceRevision, sourceHash: this.sourceHash }
  }

  async acceptMachineSourceUnlocked(agentId: string, input: {
    sourceRevision: number
    sourceHash: string
    expectedAcceptedRevision: number
    expectedAcceptedSourceHash: string | undefined
  }): Promise<{ acceptedRevision: number; acceptedSourceRevision: number; acceptedSourceHash: string }> {
    if (this.failSaves) throw new Error('disk full')
    if ((this.accepted?.acceptedRevision ?? 0) !== input.expectedAcceptedRevision) {
      throw new RuntimeConfigError({ code: 'REVISION_CONFLICT', message: 'accepted revision conflict' })
    }
    const acceptedRevision = (this.accepted?.acceptedRevision ?? 0) + 1
    const catalogs: Record<string, VersionedRuntimeConfig['catalogs'][string]> = {}
    const previous = this.accepted?.snapshot.catalogs ?? {}
    for (const provider of Object.values(this.machine.providers)) {
      const manual = this.machine.models.filter(entry => entry.ref.providerInstanceId === provider.id)
      const discovered = (previous[provider.id]?.entries ?? []).filter(entry => entry.origin === 'discovered')
      const entries = [...manual, ...discovered]
      catalogs[provider.id] = { state: entries.length > 0 ? 'ready' : 'empty', entries }
    }
    this.accepted = {
      acceptedRevision,
      acceptedSourceRevision: input.sourceRevision,
      acceptedSourceHash: input.sourceHash,
      snapshot: { revision: acceptedRevision, acceptedRevision, providers: structuredClone(this.machine.providers), catalogs, agents: structuredClone(this.machine.bindings) },
    }
    return { acceptedRevision, acceptedSourceRevision: input.sourceRevision, acceptedSourceHash: input.sourceHash }
  }

  async saveObservationUnlocked(agentId: string, patch: RuntimeConfigObservationPatch): Promise<void> {
    if (this.failSaves) throw new Error('disk full')
    if (patch.kind === 'owner-fence') {
      const existing = this.effective.uncertain ?? []
      const key = patch.uncertain.operation.operationId
      this.effective.uncertain = existing.some(record => record.operation.operationId === key)
        ? existing.map(record => record.operation.operationId === key ? patch.uncertain : record)
        : [...existing, patch.uncertain]
      this.effective.applyState = 'uncertain'
      return
    }
    if (patch.target.agentId !== agentId) throw new Error('wrong agent')
    const current = await this.loadDaemonUnlocked(agentId)
    if (current.acceptedRevision !== patch.target.acceptedRevision
      || current.acceptedSourceRevision !== patch.target.acceptedSourceRevision
      || current.acceptedSourceHash !== patch.target.acceptedSourceHash
      || current.targetGeneration !== patch.target.targetGeneration) {
      throw new RuntimeConfigError({ code: 'REVISION_CONFLICT', message: 'observation target no longer matches' })
    }
    if (patch.effectiveRevision !== undefined) this.effective.effectiveRevision = patch.effectiveRevision
    if (patch.lastApplyError === null) delete this.effective.lastApplyError
    else if (patch.lastApplyError !== undefined) this.effective.lastApplyError = patch.lastApplyError
    if (patch.applyState !== undefined) this.effective.applyState = patch.applyState
    if (patch.removeUncertainOperationId !== undefined) {
      const existing = this.effective.uncertain ?? []
      const target = existing.find(record => record.operation.operationId === patch.removeUncertainOperationId)
      if (target === undefined || patch.expectedUncertain === undefined
        || patch.expectedUncertain.operation.operationId !== patch.removeUncertainOperationId) {
        throw new RuntimeConfigError({ code: 'CONFLICT', message: 'uncertainty removal does not match' })
      }
      this.effective.uncertain = existing.filter(record => record.operation.operationId !== patch.removeUncertainOperationId)
    }
    if (patch.catalogObservations !== undefined) {
      this.observations[agentId] = { ...(this.observations[agentId] ?? {}), ...patch.catalogObservations }
    }
    if ((this.effective.uncertain ?? []).length > 0) this.effective.applyState = 'uncertain'
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
  it('keeps durable applyState uncertain while other uncertainty records remain', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    let state = await store.putProviderInstance(0, rcc)
    const view = await store.read()
    const target = {
      agentId: 'a',
      targetGeneration: view.targetGeneration,
      acceptedRevision: view.acceptedRevision,
      acceptedSourceRevision: view.acceptedSourceRevision,
      acceptedSourceHash: view.acceptedSourceHash,
      endpointFingerprint: providerIntentFingerprint(view.providers[rcc.id]!),
    }
    const fence = {
      target,
      operation: { operationId: 'op-1', kind: 'use-session' as const },
      error: { code: 'RESULT_UNKNOWN' as const, message: 'unknown' },
      substrate: { pid: 1, effectiveRevision: state.effectiveRevision ?? 0, effectiveHandleFingerprint: 'handle-1' },
    }
    await persistence.withLock(() => persistence.saveObservationUnlocked('a', { kind: 'owner-fence', uncertain: fence }))
    await persistence.withLock(() => persistence.saveObservationUnlocked('a', {
      kind: 'target-observation', target, applyState: 'clean', lastApplyError: null,
    }))
    const after = await store.readEffective()
    expect(after.applyState).toBe('uncertain')
  })

  it('keeps same-protocol same-name models isolated by provider instance', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    expect(persistence.loadCalls).toBe(0)
    let state = await store.putProviderInstance(0, rcc)
    state = await store.putProviderInstance(state.acceptedRevision, {
      ...rcc,
      id: 'rcc-secondary',
      apiBaseUrl: 'https://secondary.example/v1',
    })
    state = await store.putModelEntry(state.acceptedRevision, {
      ref: { providerInstanceId: rcc.id, modelId: 'same-model' },
      origin: 'manual',
      base: { label: 'Primary' },
      overrides: {},
    })
    state = await store.putModelEntry(state.acceptedRevision, {
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
    let state = await store.putProviderInstance(0, rcc)
    state = await store.putModelEntry(state.acceptedRevision, manualModel)
    state = await store.putModelEntry(state.acceptedRevision, {
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

  it('keeps a manually configured model usable when the real catalog is empty', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    let state = await store.putProviderInstance(0, rcc)
    state = await store.putModelEntry(state.acceptedRevision, manualModel)

    const result = await store.refreshProviderModels(state.acceptedRevision, rcc.id, { listModels: async () => [] })

    expect(result).toMatchObject({ status: 'ready' })
    expect(result.config.catalogs[rcc.id]).toMatchObject({ state: 'ready', entries: [manualModel] })
    expect((await createRuntimeConfigStore(persistence).read()).catalogs[rcc.id]).toMatchObject({ state: 'ready', entries: [manualModel] })
  })

  it('keeps refresh failure explicit and never converts it to an empty catalog', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    let state = await store.putProviderInstance(0, rcc)
    state = await store.putModelEntry(state.acceptedRevision, manualModel)

    const result = await store.refreshProviderModels(state.acceptedRevision, rcc.id, {
      listModels: async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }) },
    })

    expect(result.status).toBe('error')
    expect(result.error).toMatchObject({ status: 401 })
    expect(result.config.catalogs[rcc.id]?.entries).toEqual([manualModel])
  })

  it('uses credential resolver as a port and does not persist resolved values', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    const state = await store.putProviderInstance(0, goaichat)
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
    const state = await store.putProviderInstance(0, rcc)
    await expect(store.putProviderInstance(0, goaichat)).rejects.toThrow(/revision conflict/)

    const unsupported = await store.applyAcceptedConfig({
      apply: async () => ({
        status: 'unsupported' as const,
        error: { code: 'UNSUPPORTED_OPERATION' as const, message: 'OpenCode apply is unsupported' },
      }),
    })
    expect(unsupported.status).toBe('unsupported')
    expect((await store.read()).acceptedRevision).toBe(state.acceptedRevision)
    expect((await store.read()).effectiveRevision).toBeUndefined()
    expect((await createRuntimeConfigStore(persistence).read()).acceptedRevision).toBe(state.acceptedRevision)

    const failed = await store.applyAcceptedConfig({
      apply: async () => { throw new Error('apply failed') },
    })
    expect(failed).toEqual({ status: 'failed', error: { code: 'UNAVAILABLE', message: 'apply failed' } })
  })

  it('persists accepted and effective revisions for the explicit RCC primary and GoAIChat backup binding', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    let state = await store.putProviderInstance(0, rcc)
    state = await store.putProviderInstance(state.acceptedRevision, goaichat)
    state = await store.putModelEntry(state.acceptedRevision, {
      ref: { providerInstanceId: rcc.id, modelId: 'gpt-5.5' },
      origin: 'manual', base: { label: 'RCC configured model' }, overrides: {},
    })
    state = await store.putModelEntry(state.acceptedRevision, {
      ref: { providerInstanceId: goaichat.id, modelId: 'qwen3.8-max' },
      origin: 'manual', base: { label: 'GoAIChat configured model' }, overrides: {},
    })
    state = await store.bindAgentModel(state.acceptedRevision, 'planner', {
      primary: { providerInstanceId: rcc.id, modelId: 'gpt-5.5' },
      backup: { providerInstanceId: goaichat.id, modelId: 'qwen3.8-max' },
    })

    await expect(store.applyAcceptedConfig({
      apply: async request => ({ status: 'applied', effectiveRevision: request.config.acceptedRevision }),
    })).resolves.toEqual({ status: 'applied', effectiveRevision: state.acceptedRevision })

    expect(await store.readEffective()).toEqual({ acceptedRevision: state.acceptedRevision, acceptedSourceRevision: state.acceptedSourceRevision, acceptedSourceHash: state.acceptedSourceHash, effectiveRevision: state.acceptedRevision, applyState: 'clean' })
    const restarted = createRuntimeConfigStore(persistence)
    expect((await restarted.read()).agents.planner).toEqual({
      primary: { providerInstanceId: rcc.id, modelId: 'gpt-5.5' },
      backup: { providerInstanceId: goaichat.id, modelId: 'qwen3.8-max' },
    })
    expect(await restarted.readEffective()).toEqual({ acceptedRevision: state.acceptedRevision, acceptedSourceRevision: state.acceptedSourceRevision, acceptedSourceHash: state.acceptedSourceHash, effectiveRevision: state.acceptedRevision, applyState: 'clean' })
  })

  it('clears a previous apply error after a later successful apply', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    await store.putProviderInstance(0, rcc)
    await store.putModelEntry(1, manualModel)
    await store.bindAgentModel(2, 'planner', { primary: manualModel.ref })

    await expect(store.applyAcceptedConfig({
      apply: async () => ({ status: 'failed', error: { code: 'UPSTREAM_ERROR' as const, message: 'temporary apply failure' } }),
    })).resolves.toEqual({ status: 'failed', error: { code: 'UPSTREAM_ERROR', message: 'temporary apply failure' } })
    expect(await store.readEffective()).toMatchObject({ lastApplyError: { code: 'UPSTREAM_ERROR' } })

    await expect(store.applyAcceptedConfig({
      apply: async request => ({ status: 'applied', effectiveRevision: request.config.acceptedRevision }),
    })).resolves.toEqual({ status: 'applied', effectiveRevision: (await store.read()).acceptedRevision })
    expect(await store.readEffective()).toEqual({
      acceptedRevision: (await store.read()).acceptedRevision,
      acceptedSourceRevision: (await store.read()).acceptedSourceRevision,
      acceptedSourceHash: (await store.read()).acceptedSourceHash,
      effectiveRevision: (await store.read()).acceptedRevision,
      applyState: 'clean',
    })
    expect(await createRuntimeConfigStore(persistence).readEffective()).toEqual(await store.readEffective())
  })

  it('protects provider removal while an Agent binding still references it', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    let state = await store.putProviderInstance(0, rcc)
    state = await store.putModelEntry(state.acceptedRevision, manualModel)
    state = await store.bindAgentModel(state.acceptedRevision, 'planner', { primary: manualModel.ref })
    await expect(store.removeProviderInstance(state.acceptedRevision, rcc.id)).rejects.toThrow(/binding/)
  })

  it('rejects a deferred apply whose target advanced instead of overwriting the newer accepted config', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    const accepted = await store.putProviderInstance(0, rcc)
    const result = deferred<ConfigApplyResult>()
    const applying = store.applyAcceptedConfig({ apply: async request => {
      expect(request.config.acceptedRevision).toBe(accepted.acceptedRevision)
      return result.promise
    } })

    const updated = await store.putProviderInstance(accepted.acceptedRevision, { ...rcc, label: 'RCC updated' })
    result.resolve({ status: 'applied', effectiveRevision: accepted.acceptedRevision })
    await expect(applying).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })

    expect((await store.read()).acceptedRevision).toBe(updated.acceptedRevision)
    expect((await store.read()).providers[rcc.id]?.label).toBe('RCC updated')
    expect((await store.read()).effectiveRevision).toBeUndefined()
    expect((await createRuntimeConfigStore(persistence).read()).providers[rcc.id]?.label).toBe('RCC updated')
  })

  it('rejects an apply that completes after the accepted revision advanced, instead of trusting callback order', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    const accepted = await store.putProviderInstance(0, rcc)
    const firstGate = deferred<void>()
    let actualEffectiveRevision: number | undefined
    const first = store.applyAcceptedConfig({ apply: async request => {
      await firstGate.promise
      actualEffectiveRevision = request.config.acceptedRevision
      return { status: 'applied', effectiveRevision: request.config.acceptedRevision }
    } })
    const updated = await store.putProviderInstance(accepted.acceptedRevision, { ...rcc, label: 'RCC updated' })
    const second = store.applyAcceptedConfig({ apply: async request => {
      actualEffectiveRevision = request.config.acceptedRevision
      return { status: 'applied', effectiveRevision: request.config.acceptedRevision }
    } })

    await expect(second).rejects.toMatchObject({ code: 'CONFLICT' })
    firstGate.resolve()
    await expect(first).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(actualEffectiveRevision).toBe(accepted.acceptedRevision)
    expect((await store.read()).acceptedRevision).toBe(updated.acceptedRevision)
    expect((await store.read()).effectiveRevision).toBeUndefined()
  })

  it('does not update memory before durable apply observation is saved', async () => {
    const persistence = new MemoryPersistence()
    const store = createRuntimeConfigStore(persistence)
    const accepted = await store.putProviderInstance(0, rcc)
    persistence.failSaves = true

    await expect(store.applyAcceptedConfig({
      apply: async () => ({ status: 'applied' as const, effectiveRevision: accepted.acceptedRevision }),
    })).rejects.toThrow('disk full')
    expect((await store.read()).effectiveRevision).toBeUndefined()
    expect((await createRuntimeConfigStore(persistence).read()).effectiveRevision).toBeUndefined()
  })

  it('isolates accepted state from mutable provider, binding, and read aliases', async () => {
    const store = createRuntimeConfigStore(new MemoryPersistence())
    const provider = { ...rcc }
    await store.putProviderInstance(0, provider)
    provider.label = 'caller mutation'
    expect((await store.read()).providers[rcc.id]?.label).toBe('RCC')

    const snapshot = await store.read()
    ;(snapshot.providers[rcc.id] as { label: string }).label = 'read mutation'
    expect((await store.read()).providers[rcc.id]?.label).toBe('RCC')
  })
})
