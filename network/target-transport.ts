export type TargetTransportStateName = 'connecting' | 'ready' | 'closed' | 'failed'

export interface TargetTransportHello {
  readonly hostId: string
  readonly agentId: string
  readonly targetGeneration: number
  readonly protocolVersion: number
  readonly capabilitiesRevision: string
}

export interface TargetTransportState {
  readonly state: TargetTransportStateName
  readonly targetGeneration: number
  readonly hostId: string
  readonly agentId: string
  readonly protocolVersion: number
  readonly capabilitiesRevision: string
  readonly error?: string
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`INVALID_${label.toUpperCase()}`)
}

function assertState(state: TargetTransportState, expected: TargetTransportStateName): void {
  if (state.state !== expected) throw new Error(`INVALID_TRANSITION: expected ${expected}, got ${state.state}`)
}

export function beginTargetTransport(hello: TargetTransportHello): TargetTransportState {
  positiveInteger(hello.targetGeneration, 'generation')
  positiveInteger(hello.protocolVersion, 'protocol_version')
  if (hello.hostId.length === 0 || hello.agentId.length === 0 || hello.capabilitiesRevision.length === 0) {
    throw new Error('transport: hello identity fields are required')
  }
  return { state: 'connecting', ...hello }
}

export function receiveHelloAck(state: TargetTransportState): TargetTransportState {
  assertState(state, 'connecting')
  return { ...state, state: 'ready' }
}

export function confirmTargetHealth(state: TargetTransportState, generation: number): TargetTransportState {
  assertState(state, 'ready')
  if (state.targetGeneration !== generation) throw new Error('STALE_GENERATION')
  return state
}

export function assertTargetGeneration(state: TargetTransportState, generation: number): void {
  if (state.targetGeneration !== generation) throw new Error('STALE_GENERATION')
}

export function closeTargetTransport(state: TargetTransportState, reason?: string): TargetTransportState {
  if (state.state !== 'ready' && state.state !== 'connecting') {
    throw new Error(`INVALID_TRANSITION: cannot close ${state.state}`)
  }
  return { ...state, state: 'closed', error: reason }
}

export function failTargetTransport(state: TargetTransportState, reason: string): TargetTransportState {
  if (state.state === 'closed' || state.state === 'failed') {
    throw new Error(`INVALID_TRANSITION: cannot fail ${state.state}`)
  }
  return { ...state, state: 'failed', error: reason }
}
