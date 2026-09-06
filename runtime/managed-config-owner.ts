import { RuntimeConfigError, type VersionedRuntimeConfig, type ConfigApplyResult } from '../config/runtime-config.ts'
import { compileOpenCodeConfig } from '../opencode-adapter/src/index.ts'
import { startManagedOpenCode, type ManagedOpenCodeOptions } from './managed-opencode.ts'

type Handle = Awaited<ReturnType<typeof startManagedOpenCode>>
type Options = Omit<ManagedOpenCodeOptions, 'compiled'> & { readonly agentId: string }

/** Serializes configuration replacement with operations using the owned substrate. */
export function createManagedConfigOwner(options: Options, launch = startManagedOpenCode) {
  let current: Handle | undefined
  let changing = false
  let stopped = false
  let active = 0
  let uncertain = false
  const conflict = () => new RuntimeConfigError({ code: 'CONFLICT', message: 'Managed runtime has active or unconfirmed operations' })
  return {
    async apply(config: VersionedRuntimeConfig): Promise<ConfigApplyResult> {
      if (stopped) throw new RuntimeConfigError({ code: 'UNAVAILABLE', message: 'Managed runtime is stopped' })
      if (changing || active || uncertain) throw conflict()
      const compiled = compileOpenCodeConfig(config, options.agentId)
      changing = true
      try {
        if (current) { await current.stop(); current = undefined }
        const handle = await launch({ ...options, compiled })
        current = handle
        void handle.closed.then(() => { if (current === handle) current = undefined }, () => { if (current === handle) current = undefined })
        return { status: 'applied', effectiveRevision: handle.effectiveRevision }
      } finally { changing = false }
    },
    async use<T>(operation: (handle: Pick<Handle, 'url' | 'authorization' | 'effectiveRevision'>) => Promise<T>): Promise<T> {
      if (changing || stopped || !current || uncertain) throw new RuntimeConfigError({ code: 'UNAVAILABLE', message: 'Managed runtime is not available' })
      const handle = current
      active++
      try {
        return await operation({ url: handle.url, authorization: handle.authorization, effectiveRevision: handle.effectiveRevision })
      } catch (error) {
        // A failed exchange is not proof that the substrate's operation ended.
        uncertain = true
        throw error
      } finally { active-- }
    },
    async stop(): Promise<void> {
      if (changing || active || uncertain) throw conflict()
      stopped = true
      if (current) { await current.stop(); current = undefined }
    },
  }
}
