import type { RuntimeState } from './daemon-runtime.ts'

export interface RuntimeCapability {
  readonly machineId: string
  readonly agentId: string
  readonly capabilities: readonly string[]
  readonly runtimeGeneration: number
}

export function publishRuntimeCapabilities(
  state: RuntimeState,
  machineId: string,
  agentId: string,
): RuntimeCapability {
  if (state.lifecycle !== 'ready' || state.link === undefined || state.admission?.admitted !== true) {
    throw new Error('runtime: capabilities require admitted ready state')
  }
  if (machineId.length === 0 || agentId.length === 0) throw new Error('runtime: machineId and agentId are required')
  return {
    machineId,
    agentId,
    capabilities: ['observe'],
    runtimeGeneration: state.link.generation,
  }
}
