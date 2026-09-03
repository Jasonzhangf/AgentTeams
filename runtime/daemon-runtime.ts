import type { BootstrapLinkConfig, LinkState } from '../network/link.ts'
import { connectLink } from '../network/link.ts'
import { registerRuntimeConnection, type AdmissionRequest, type AdmissionState } from '../server/admission.ts'
import { syncSharedRuntimeConfig, type VersionedRuntimeConfig } from '../config/runtime-config.ts'
import { publishRuntimeCapabilities, type RuntimeCapability } from './capability-publication.ts'

export type RuntimeLifecycle = 'created' | 'link-connected' | 'admitted' | 'config-synced' | 'ready' | 'stopped'

export interface RuntimeState {
  readonly lifecycle: RuntimeLifecycle
  readonly link?: LinkState
  readonly admission?: AdmissionState
  readonly configRevision?: number
}

export function startDaemonRuntime(
  config: BootstrapLinkConfig,
  admissionRequest?: AdmissionRequest,
  runtimeConfig?: VersionedRuntimeConfig,
): RuntimeState {
  const link = connectLink(config)
  if (admissionRequest === undefined || runtimeConfig === undefined) return { lifecycle: 'link-connected', link }
  const admission = registerRuntimeConnection(link, config, admissionRequest)
  if (!admission.admitted || admission.permission !== 'granted') {
    throw new Error('runtime: server admission denied')
  }
  const synced = syncSharedRuntimeConfig(runtimeConfig, admission.admitted)
  return { lifecycle: 'ready', link, admission, configRevision: synced.revision }
}

export function advanceRuntimeLifecycle(state: RuntimeState, next: Exclude<RuntimeLifecycle, 'created' | 'stopped'>, revision?: number): RuntimeState {
  const order: readonly RuntimeLifecycle[] = ['created', 'link-connected', 'admitted', 'config-synced', 'ready']
  const currentIndex = order.indexOf(state.lifecycle)
  const nextIndex = order.indexOf(next)
  if (currentIndex < 0 || nextIndex !== currentIndex + 1) {
    throw new Error(`runtime: invalid lifecycle transition ${state.lifecycle} -> ${next}`)
  }
  return { ...state, lifecycle: next, ...(revision === undefined ? {} : { configRevision: revision }) }
}

export function stopDaemonRuntime(state: RuntimeState): RuntimeState {
  if (state.lifecycle !== 'ready') throw new Error('runtime: stop requires ready state')
  return { ...state, lifecycle: 'stopped' }
}

export function startDaemonRuntimeWithCapability(
  config: BootstrapLinkConfig,
  admissionRequest: AdmissionRequest,
  runtimeConfig: VersionedRuntimeConfig,
  machineId: string,
  agentId: string,
): RuntimeCapability {
  const state = startDaemonRuntime(config, admissionRequest, runtimeConfig)
  return publishRuntimeCapabilities(state, machineId, agentId)
}
