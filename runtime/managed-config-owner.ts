import {
  RuntimeConfigError,
  type ConfigApplyResult,
  type ConfigTargetIdentity,
  type DaemonRuntimeConfigView,
  type ManagedConfigUncertainty,
  type ManagedConfigUncertaintyFence,
  type RuntimeConfigApplyRequest,
  type RuntimeConfigApplier,
  type RuntimeConfigObservationPatch,
} from '../config/runtime-config.ts'
import { compileOpenCodeConfig } from '../opencode-adapter/src/index.ts'
import { startManagedOpenCode, type ManagedOpenCodeOptions } from './managed-opencode.ts'

type Handle = Awaited<ReturnType<typeof startManagedOpenCode>>
type Options = Omit<ManagedOpenCodeOptions, 'compiled'> & {
  readonly agentId: string
  readonly persistence: ManagedConfigOwnerPersistence
}

/** Owner-scoped async uncertainty persistence port; U6 consumes `recover()` but never this port. */
export interface ManagedConfigOwnerPersistence {
  readRecovery(ownerAgentId: string): Promise<
    | { readonly state: 'clean' }
    | { readonly state: 'uncertain'; readonly fence: ManagedConfigUncertaintyFence }
  >
  persistUncertainty(input: {
    readonly fence: ManagedConfigUncertainty
    readonly expectedAcceptedRevision: number
  }): Promise<{ readonly persistence: 'committed' }>
  clearUncertainty(input: {
    readonly expectedFence: ManagedConfigUncertainty
    readonly effectiveRevision: number
    readonly currentTarget: ConfigTargetIdentity
  }): Promise<{ readonly persistence: 'committed' }>
}

export interface ManagedConfigOwnerPersistenceOptions {
  readonly agentId: string
  readonly internalPath: string
  readonly persistence: RuntimeConfigStorePersistencePort
}

function sameUncertaintyIdentity(left: ManagedConfigUncertainty, right: ManagedConfigUncertainty): boolean {
  return left.operation.operationId === right.operation.operationId &&
    left.operation.kind === right.operation.kind &&
    left.target.agentId === right.target.agentId &&
    left.target.targetGeneration === right.target.targetGeneration &&
    left.target.acceptedRevision === right.target.acceptedRevision &&
    left.target.acceptedSourceRevision === right.target.acceptedSourceRevision &&
    left.target.acceptedSourceHash === right.target.acceptedSourceHash &&
    left.target.endpointFingerprint === right.target.endpointFingerprint &&
    left.target.credentialRef === right.target.credentialRef &&
    left.substrate.pid === right.substrate.pid &&
    left.substrate.effectiveRevision === right.substrate.effectiveRevision &&
    left.substrate.effectiveHandleFingerprint === right.substrate.effectiveHandleFingerprint
}

type RuntimeConfigStorePersistencePort = {
  withLock<T>(task: () => Promise<T>): Promise<T>
  loadDaemonUnlocked(agentId: string): Promise<DaemonRuntimeConfigView>
  saveObservationUnlocked(agentId: string, patch: RuntimeConfigObservationPatch): Promise<void>
}

/** Owner-owned persistence adapter over the single RuntimeConfigPersistence/store lock. */
export function createManagedConfigOwnerPersistence(options: ManagedConfigOwnerPersistenceOptions): ManagedConfigOwnerPersistence {
  const { agentId, persistence } = options
  return {
    readRecovery: async ownerAgentId => {
      if (ownerAgentId !== agentId) throw new RuntimeConfigError({ code: 'FORBIDDEN', message: 'config: recovery owner does not match this daemon' })
      const view = await persistence.withLock(() => persistence.loadDaemonUnlocked(agentId))
      const fence = (view as DaemonRuntimeConfigView & { readonly uncertain?: readonly ManagedConfigUncertainty[] }).uncertain ?? []
      if (view.applyState === 'uncertain' || fence.length > 0) return { state: 'uncertain', fence: { operations: fence } }
      return { state: 'clean' }
    },
    persistUncertainty: async input => {
      await persistence.withLock(() => persistence.saveObservationUnlocked(agentId, { kind: 'owner-fence', uncertain: input.fence }))
      return { persistence: 'committed' }
    },
    clearUncertainty: async input => {
      await persistence.withLock(async () => {
        const view = await persistence.loadDaemonUnlocked(agentId)
        const operations = (view as DaemonRuntimeConfigView & { readonly uncertain?: readonly ManagedConfigUncertainty[] }).uncertain ?? []
        const remaining = operations.filter(record => !sameUncertaintyIdentity(record, input.expectedFence))
        await persistence.saveObservationUnlocked(agentId, {
          kind: 'target-observation',
          target: input.currentTarget,
          removeUncertainOperationId: input.expectedFence.operation.operationId,
          expectedUncertain: input.expectedFence,
          effectiveRevision: input.effectiveRevision,
          ...(remaining.length === 0 ? { lastApplyError: null } : {}),
        })
      })
      return { persistence: 'committed' }
    },
  }
}

function handleFingerprint(handle: Pick<Handle, 'url' | 'effectiveRevision'>, pid: number | undefined): string {
  return `${handle.url}\u0000${handle.effectiveRevision}\u0000${pid ?? ''}`
}

function uncertaintyError(error: unknown): { readonly code: 'RESULT_UNKNOWN'; readonly message: string } {
  return { code: 'RESULT_UNKNOWN', message: error instanceof Error ? error.message : 'managed runtime outcome is unknown' }
}

function assertPriorSubstratesTerminated(fence: ManagedConfigUncertaintyFence): void {
  for (const record of fence.operations) {
    const pid = record.substrate.pid
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new RuntimeConfigError({ code: 'RESULT_UNKNOWN', message: 'config: prior managed substrate identity is incomplete' })
    }
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') alive = true
    }
    if (alive) throw new RuntimeConfigError({ code: 'CONFLICT', message: `config: prior managed substrate pid=${pid} is still live or cannot be proven exited` })
  }
}

/** Serializes configuration replacement with operations using the owned substrate. */
export function createManagedConfigOwner(options: Options, launch = startManagedOpenCode) {
  let current: Handle | undefined
  let changing = false
  let stopped = false
  let active = 0
  let uncertain = false
  let lastTarget: ConfigTargetIdentity | undefined
  const conflict = () => new RuntimeConfigError({ code: 'CONFLICT', message: 'Managed runtime has active or unconfirmed operations' })

  const fenceFor = (
    kind: 'apply' | 'use-session',
    target: ConfigTargetIdentity,
    handle: Pick<Handle, 'url' | 'effectiveRevision'> & { readonly pid?: number },
    error: unknown,
  ): ManagedConfigUncertainty => ({
    target,
    operation: { operationId: `${kind}:${target.agentId}:${Date.now()}:${Math.random().toString(16).slice(2)}`, kind },
    error: uncertaintyError(error),
    substrate: {
      ...(handle.pid === undefined ? {} : { pid: handle.pid }),
      effectiveRevision: handle.effectiveRevision,
      effectiveHandleFingerprint: handleFingerprint(handle, handle.pid),
    },
  })

  const persistFence = async (fence: ManagedConfigUncertainty): Promise<void> => {
    uncertain = true
    try {
      await options.persistence.persistUncertainty({ fence, expectedAcceptedRevision: fence.target.acceptedRevision })
    } catch (error) {
      // The volatile fence stays set; the caller must surface an explicit typed failure.
      throw new RuntimeConfigError({ code: 'UNAVAILABLE', message: `config: durable uncertainty fence was not persisted: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const owner: RuntimeConfigApplier & {
    recover(readRequest?: () => Promise<RuntimeConfigApplyRequest | undefined>): Promise<'clean' | 'uncertain'>
    reconcile(request: RuntimeConfigApplyRequest): Promise<'clean' | 'uncertain'>
    use<T>(operation: (handle: Pick<Handle, 'url' | 'authorization' | 'effectiveRevision'>) => Promise<T>): Promise<T>
    stop(): Promise<void>
    uncertainty(): boolean
  } = {
    async apply(request: RuntimeConfigApplyRequest): Promise<ConfigApplyResult> {
      if (stopped) throw new RuntimeConfigError({ code: 'UNAVAILABLE', message: 'Managed runtime is stopped' })
      if (changing || active || uncertain) throw conflict()
      const compiled = compileOpenCodeConfig(request.config, options.agentId)
      changing = true
      try {
        if (current) { await current.stop(); current = undefined }
        const handle = await launch({ ...options, compiled })
        current = handle
        lastTarget = request.target
        void handle.closed.then(() => { if (current === handle) current = undefined }, () => { if (current === handle) current = undefined })
        return { status: 'applied', effectiveRevision: handle.effectiveRevision }
      } catch (error) {
        // An ambiguous launch failure is a durable responsibility, not a silent retry.
        const handle = current ?? { url: '', effectiveRevision: request.target.acceptedRevision, pid: undefined }
        const fence = fenceFor('apply', request.target, handle, error)
        await persistFence(fence)
        return { status: 'uncertain', error: fence.error, fence }
      } finally { changing = false }
    },
    async recover(readRequest): Promise<'clean' | 'uncertain'> {
      const recovery = await options.persistence.readRecovery(options.agentId)
      if (recovery.state === 'clean') {
        uncertain = false
        return 'clean'
      }
      uncertain = true
      if (readRequest === undefined) return 'uncertain'
      const request = await readRequest()
      if (request === undefined) return 'uncertain'
      try {
        return await this.reconcile(request)
      } catch {
        uncertain = true
        return 'uncertain'
      }
    },
    async reconcile(request: RuntimeConfigApplyRequest): Promise<'clean' | 'uncertain'> {
      const recovery = await options.persistence.readRecovery(options.agentId)
      if (recovery.state === 'clean') { uncertain = false; return 'clean' }
      if (changing || active || stopped) throw conflict()
      changing = true
      let replacement: Handle | undefined
      try {
        assertPriorSubstratesTerminated(recovery.fence)
        const compiled = compileOpenCodeConfig(request.config, options.agentId)
        if (current) { await current.stop(); current = undefined }
        const handle = await launch({ ...options, compiled })
        replacement = handle
        if (handle.effectiveRevision !== request.target.acceptedRevision) {
          throw new RuntimeConfigError({ code: 'APPLY_TARGET_MISMATCH', message: 'config: recovery apply returned a mismatched effective revision' })
        }
        current = handle
        lastTarget = request.target
        void handle.closed.then(() => { if (current === handle) current = undefined }, () => { if (current === handle) current = undefined })
        for (const record of recovery.fence.operations) {
          await options.persistence.clearUncertainty({ expectedFence: record, effectiveRevision: handle.effectiveRevision, currentTarget: request.target })
        }
        const after = await options.persistence.readRecovery(options.agentId)
        if (after.state === 'clean') { uncertain = false; return 'clean' }
        uncertain = true
        return 'uncertain'
      } catch (error) {
        if (replacement !== undefined && current === replacement) {
          try { await replacement.stop() } catch { /* preserve the first recovery failure */ }
          current = undefined
        }
        uncertain = true
        throw error instanceof RuntimeConfigError ? error : new RuntimeConfigError({ code: 'RESULT_UNKNOWN', message: error instanceof Error ? error.message : 'managed runtime reconcile is unknown' })
      } finally { changing = false }
    },
    async use<T>(operation: (handle: Pick<Handle, 'url' | 'authorization' | 'effectiveRevision'>) => Promise<T>): Promise<T> {
      if (changing || stopped || !current || uncertain) throw new RuntimeConfigError({ code: 'UNAVAILABLE', message: 'Managed runtime is not available' })
      const handle = current
      const target = lastTarget
      active++
      try {
        return await operation({ url: handle.url, authorization: handle.authorization, effectiveRevision: handle.effectiveRevision })
      } catch (error) {
        // A failed exchange is not proof that the substrate's operation ended.
        if (target !== undefined) {
          const fence = fenceFor('use-session', target, handle, error)
          await persistFence(fence)
        } else {
          uncertain = true
        }
        throw error
      } finally { active-- }
    },
    async stop(): Promise<void> {
      if (changing || active || uncertain) throw conflict()
      stopped = true
      if (current) { await current.stop(); current = undefined }
    },
    uncertainty: () => uncertain,
  }
  return owner
}
