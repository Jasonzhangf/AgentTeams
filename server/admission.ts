import type { BootstrapAuthMode, BootstrapLinkConfig, LinkState } from '../network/link.ts'

export interface AdmissionRequest {
  readonly machineId: string
  readonly authMode: BootstrapAuthMode
  readonly configuredCredential?: string
  readonly presentedCredential?: string
}

export interface AdmissionState {
  readonly machineId: string
  readonly admitted: boolean
  readonly permission: 'denied' | 'granted'
}

export function authenticateMachine(request: AdmissionRequest): boolean {
  if (request.authMode === 'none') return true
  return request.configuredCredential !== undefined
    && request.configuredCredential === request.presentedCredential
}

export function evaluatePermission(admitted: boolean, requestedCapability: string): AdmissionState['permission'] {
  if (!admitted || requestedCapability.length === 0) return 'denied'
  return requestedCapability === 'observe' ? 'granted' : 'denied'
}

export function registerRuntimeConnection(link: LinkState, config: BootstrapLinkConfig, request: AdmissionRequest): AdmissionState {
  if (link.status !== 'connected' || link.endpoint !== config.endpoint) {
    throw new Error('server: runtime link is not connected to the configured endpoint')
  }
  const admitted = authenticateMachine(request)
  return {
    machineId: request.machineId,
    admitted,
    permission: evaluatePermission(admitted, 'observe'),
  }
}
