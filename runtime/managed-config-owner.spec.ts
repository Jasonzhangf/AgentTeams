import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createManagedConfigOwner, createManagedConfigOwnerPersistence } from './managed-config-owner.ts'
import { createJsonFileConfigPersistence, createRuntimeConfigStore } from '../config/runtime-config.ts'

const mockCompiled = (acceptedRevision: number) => ({ agentId: 'a', acceptedRevision, primary: { provider: 'p', model: 'm', protocol: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:1/v1' } })

it('records effective config only after launch and refuses apply during an owned operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-owner-'))
  try {
    const persistence = createJsonFileConfigPersistence(join(directory, 'config.json'))
    const store = createRuntimeConfigStore(persistence, { agentId: 'a' })
    await store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
    await store.bindAgentModel(1, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
    const stop = vi.fn(async () => undefined)
   const launch = vi.fn(async () => ({ url: 'http://127.0.0.1:1', authorization: 'private', pid: 1, effectiveRevision: 2,
      compiled: mockCompiled(2),
      closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop }))
    const owner = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
      startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '',
      persistence: createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence }) }, launch)
    expect(await store.applyAcceptedConfig(owner)).toEqual({ status: 'applied', effectiveRevision: 2 })
    let release!: () => void
    const running = owner.use(async () => new Promise<void>(resolve => { release = resolve }))
    const current = await store.read()
    await expect(owner.apply({ target: {
      agentId: 'a', targetGeneration: 1, acceptedRevision: current.acceptedRevision,
      acceptedSourceRevision: current.acceptedSourceRevision, acceptedSourceHash: current.acceptedSourceHash,
      endpointFingerprint: '', credentialRef: undefined,
    }, config: current })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(stop).not.toHaveBeenCalled()
    release(); await running
    await owner.stop()
    await expect(owner.use(async () => undefined)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('recovers uncertain after an ambiguous exchange and refuses use until reconcile succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-recover-'))
  try {
    const persistence = createJsonFileConfigPersistence(join(directory, 'config.json'))
    const store = createRuntimeConfigStore(persistence, { agentId: 'a' })
    await store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
    await store.bindAgentModel(1, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
    let launchCount = 0
    const owner = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
      startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '',
      persistence: createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence }) },
    async () => ({ url: `http://127.0.0.1:${++launchCount}`, authorization: 'private', pid: 1, effectiveRevision: 2,
      compiled: mockCompiled(2),
      closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop: async () => undefined }))
    expect(await owner.recover()).toBe('clean')
    expect(await store.applyAcceptedConfig(owner)).toEqual({ status: 'applied', effectiveRevision: 2 })
    await expect(owner.use(async () => { throw new Error('ambiguous exchange') })).rejects.toThrow('ambiguous exchange')
    expect(owner.uncertainty()).toBe(true)
    expect(owner.readiness()).toEqual({ state: 'uncertain', effectiveRevision: 2 })
    const restarted = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
      startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '',
      persistence: createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence }) },
    async () => ({ url: `http://127.0.0.1:${++launchCount}`, authorization: 'private', pid: 1, effectiveRevision: 2,
      compiled: mockCompiled(2),
      closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop: async () => undefined }))
    expect(await restarted.recover()).toBe('uncertain')
    await expect(restarted.use(async () => undefined)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('reconciles a dead durable fence on startup and clears the stale apply error in the same observation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-reconcile-'))
  try {
    const persistence = createJsonFileConfigPersistence(join(directory, 'config.json'))
    const store = createRuntimeConfigStore(persistence, { agentId: 'a' })
    await store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
    await store.bindAgentModel(1, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
    const current = await store.read()
    const target = {
      agentId: 'a', targetGeneration: current.targetGeneration, acceptedRevision: current.acceptedRevision,
      acceptedSourceRevision: current.acceptedSourceRevision, acceptedSourceHash: current.acceptedSourceHash,
      endpointFingerprint: '',
    }
    await persistence.withLock(() => persistence.saveObservationUnlocked('a', {
      kind: 'target-observation', target, lastApplyError: { code: 'UPSTREAM_ERROR', message: 'stale error' },
    }))
    const dead = spawnSync(process.execPath, ['-e', '']).pid!
    await persistence.withLock(() => persistence.saveObservationUnlocked('a', {
      kind: 'owner-fence',
      uncertain: {
        target,
        operation: { operationId: 'restart-op', kind: 'apply' },
        error: { code: 'RESULT_UNKNOWN', message: 'apply outcome unknown' },
        substrate: { pid: dead, effectiveRevision: current.acceptedRevision, effectiveHandleFingerprint: 'old-handle' },
      },
    }))
    let launches = 0
    const owner = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
      startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '',
      persistence: createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence }) },
    async () => ({ url: `http://127.0.0.1:${++launches}`, authorization: 'private', pid: process.pid, effectiveRevision: current.acceptedRevision,
      compiled: mockCompiled(current.acceptedRevision),
      closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop: async () => undefined }))
    expect(await owner.recover(async () => ({ target, config: await store.read() }))).toBe('clean')
    expect(launches).toBe(1)
    expect(await store.readEffective()).toMatchObject({ acceptedRevision: current.acceptedRevision,
      effectiveRevision: current.acceptedRevision, applyState: 'clean' })
    expect(await store.readEffective()).not.toHaveProperty('lastApplyError')
    const recovered = await persistence.withLock(() => persistence.loadDaemonUnlocked('a')) as { readonly uncertain?: readonly unknown[] }
    expect(recovered.uncertain ?? []).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('does not launch a replacement while a fenced prior substrate is live or unprovable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-blocked-reconcile-'))
  try {
    const persistence = createJsonFileConfigPersistence(join(directory, 'config.json'))
    const store = createRuntimeConfigStore(persistence, { agentId: 'a' })
    await store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
    await store.bindAgentModel(1, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
    const current = await store.read()
    const target = {
      agentId: 'a', targetGeneration: current.targetGeneration, acceptedRevision: current.acceptedRevision,
      acceptedSourceRevision: current.acceptedSourceRevision, acceptedSourceHash: current.acceptedSourceHash,
      endpointFingerprint: '',
    }
    for (const [operationId, pid] of [['live-op', process.pid], ['unknown-op', undefined]] as const) {
      await persistence.withLock(() => persistence.saveObservationUnlocked('a', {
        kind: 'owner-fence',
        uncertain: {
          target,
          operation: { operationId, kind: 'use-session' },
          error: { code: 'RESULT_UNKNOWN', message: 'prior substrate outcome unknown' },
          substrate: { ...(pid === undefined ? {} : { pid }), effectiveRevision: current.acceptedRevision, effectiveHandleFingerprint: `${operationId}-handle` },
        },
      }))
    }
    let launches = 0
    const owner = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
      startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '',
      persistence: createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence }) },
    async () => ({ url: `http://127.0.0.1:${++launches}`, authorization: 'private', pid: process.pid, effectiveRevision: current.acceptedRevision,
      compiled: mockCompiled(current.acceptedRevision),
      closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop: async () => undefined }))
    expect(await owner.recover(async () => ({ target, config: await store.read() }))).toBe('uncertain')
    expect(launches).toBe(0)
    expect(await store.readEffective()).toMatchObject({ applyState: 'uncertain' })
    const fence = await persistence.withLock(() => persistence.loadDaemonUnlocked('a')) as { readonly uncertain?: readonly unknown[] }
    expect(fence.uncertain).toHaveLength(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('removes only the exact cleared fence and keeps the other uncertainty and error until the last clear', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-multi-fence-'))
  try {
    const persistence = createJsonFileConfigPersistence(join(directory, 'config.json'))
    const store = createRuntimeConfigStore(persistence, { agentId: 'a' })
    await store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
    await store.bindAgentModel(1, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
    const current = await store.read()
    const target = {
      agentId: 'a', targetGeneration: current.targetGeneration, acceptedRevision: current.acceptedRevision,
      acceptedSourceRevision: current.acceptedSourceRevision, acceptedSourceHash: current.acceptedSourceHash,
      endpointFingerprint: '',
    }
    const first = {
      target,
      operation: { operationId: 'first-op', kind: 'apply' as const },
      error: { code: 'RESULT_UNKNOWN' as const, message: 'first unknown' },
      substrate: { pid: 999999, effectiveRevision: current.acceptedRevision, effectiveHandleFingerprint: 'first' },
    }
    const second = {
      target,
      operation: { operationId: 'second-op', kind: 'use-session' as const },
      error: { code: 'RESULT_UNKNOWN' as const, message: 'second unknown' },
      substrate: { pid: 999999, effectiveRevision: current.acceptedRevision, effectiveHandleFingerprint: 'second' },
    }
    await persistence.withLock(() => persistence.saveObservationUnlocked('a', {
      kind: 'target-observation', target, lastApplyError: { code: 'UPSTREAM_ERROR', message: 'retain me' },
    }))
    await persistence.withLock(() => persistence.saveObservationUnlocked('a', { kind: 'owner-fence', uncertain: first }))
    await persistence.withLock(() => persistence.saveObservationUnlocked('a', { kind: 'owner-fence', uncertain: second }))
    const port = createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence })
    await port.clearUncertainty({ expectedFence: first, effectiveRevision: current.acceptedRevision, currentTarget: target })
    expect(await store.readEffective()).toMatchObject({ applyState: 'uncertain', lastApplyError: { code: 'UPSTREAM_ERROR' } })
    const afterFirst = await persistence.withLock(() => persistence.loadDaemonUnlocked('a')) as { readonly uncertain?: readonly { readonly operation: { readonly operationId: string } }[] }
    expect(afterFirst.uncertain?.map(record => record.operation.operationId)).toEqual(['second-op'])
    await port.clearUncertainty({ expectedFence: second, effectiveRevision: current.acceptedRevision, currentTarget: target })
    expect(await store.readEffective()).toMatchObject({ applyState: 'clean' })
    expect(await store.readEffective()).not.toHaveProperty('lastApplyError')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('projects readiness for changing, stopped, no-current, uncertain and current', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-readiness-'))
  try {
    const persistence = createJsonFileConfigPersistence(join(directory, 'config.json'))
    const store = createRuntimeConfigStore(persistence, { agentId: 'a' })
    await store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
    await store.bindAgentModel(1, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
    let releaseLaunch!: () => void
    const gate = new Promise<void>(resolve => { releaseLaunch = resolve })
    const stop = vi.fn(async () => undefined)
    let launches = 0
    const owner = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
      startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '',
      persistence: createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence }) },
    async () => { await gate; launches += 1
      return { url: `http://127.0.0.1:${launches}`, authorization: 'private', pid: 1, effectiveRevision: 2, compiled: mockCompiled(2),
        closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop } })
    expect(owner.readiness()).toEqual({ state: 'no-current' })
   const applying = store.applyAcceptedConfig(owner)
    await new Promise(resolveTick => setTimeout(resolveTick, 0))
   expect(owner.readiness()).toEqual({ state: 'changing' })
    releaseLaunch()
    await applying
    expect(owner.readiness()).toEqual({ state: 'current', effectiveRevision: 2, modelTarget: { providerID: 'p', modelID: 'm' }, activeOperations: 0 })
    let release!: () => void
    const running = owner.use(async () => new Promise<void>(resolve => { release = resolve }))
    expect(owner.readiness()).toMatchObject({ state: 'current', activeOperations: 1 })
    release(); await running
    await owner.stop()
    expect(owner.readiness()).toEqual({ state: 'stopped' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('contains an expected callback result without poisoning readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-contained-'))
  try {
    const persistence = createJsonFileConfigPersistence(join(directory, 'config.json'))
    const store = createRuntimeConfigStore(persistence, { agentId: 'a' })
    await store.putProviderInstance(0, { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
    await store.refreshProviderModels(1, 'p', { listModels: async () => [{ modelId: 'm', metadata: {} }] })
    await store.bindAgentModel(1, 'a', { primary: { providerInstanceId: 'p', modelId: 'm' } })
    const owner = createManagedConfigOwner({ agentId: 'a', executable: '/test', directory: '/test', port: 1,
      startupTimeoutMs: 1000, stopTimeoutMs: 1000, resolveCredential: async () => '',
      persistence: createManagedConfigOwnerPersistence({ agentId: 'a', internalPath: join(directory, 'internal.toml'), persistence }) },
    async () => ({ url: 'http://127.0.0.1:9', authorization: 'private', pid: 1, effectiveRevision: 2, compiled: mockCompiled(2),
      closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}), stop: async () => undefined }))
    await store.applyAcceptedConfig(owner)
    const expected = await owner.use(async () => ({ code: 'NOT_FOUND', ok: false }))
    expect(expected).toEqual({ code: 'NOT_FOUND', ok: false })
    expect(owner.uncertainty()).toBe(false)
    expect(owner.readiness()).toMatchObject({ state: 'current', activeOperations: 0 })
    await expect(owner.use(async () => 'still usable')).resolves.toBe('still usable')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
