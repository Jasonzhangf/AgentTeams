export type ChannelStateName = 'idle' | 'opening' | 'open' | 'closing' | 'closed' | 'failed'

export interface ChannelContext {
  targetGeneration: number
  channelId: string
  sessionId: string
  at: number
}

export interface ChannelError {
  code: string
  message: string
  at: number
}

export interface ChannelState {
  state: ChannelStateName
  targetGeneration?: number
  channelId?: string
  sessionId?: string
  openedAt?: number
  closedAt?: number
  error?: ChannelError
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`INVALID_${label.toUpperCase()}`)
}

function assertTransition(state: ChannelState, expected: ChannelStateName): void {
  if (state.state !== expected) {
    throw new Error(`INVALID_TRANSITION: expected ${expected}, got ${state.state}`)
  }
}

function assertContext(state: ChannelState, context: ChannelContext): void {
  positiveInteger(context.targetGeneration, 'generation')
  if (state.targetGeneration !== context.targetGeneration) throw new Error('STALE_GENERATION')
  if (state.channelId !== context.channelId || state.sessionId !== context.sessionId) {
    throw new Error('CHANNEL_MISMATCH')
  }
}

export function createChannelState(): ChannelState {
  return { state: 'idle' }
}

export function openChannel(state: ChannelState, context: ChannelContext): ChannelState {
  assertTransition(state, 'idle')
  positiveInteger(context.targetGeneration, 'generation')
  if (context.channelId.length === 0 || context.sessionId.length === 0) {
    throw new Error('INVALID_CHANNEL_ID')
  }
  return {
    state: 'opening',
    targetGeneration: context.targetGeneration,
    channelId: context.channelId,
    sessionId: context.sessionId,
  }
}

export function onOpenAck(state: ChannelState, context: ChannelContext): ChannelState {
  assertTransition(state, 'opening')
  assertContext(state, context)
  return { ...state, state: 'open', openedAt: context.at }
}

export function onMessage(state: ChannelState, context: ChannelContext): ChannelState {
  assertTransition(state, 'open')
  assertContext(state, context)
  return state
}

export function onClose(state: ChannelState, context: ChannelContext): ChannelState {
  assertTransition(state, 'open')
  assertContext(state, context)
  return { ...state, state: 'closing' }
}

export function onCloseAck(state: ChannelState, context: ChannelContext): ChannelState {
  assertTransition(state, 'closing')
  assertContext(state, context)
  return { ...state, state: 'closed', closedAt: context.at }
}

export function onError(
  state: ChannelState,
  context: ChannelContext & Pick<ChannelError, 'code' | 'message'>,
): ChannelState {
  if (state.state !== 'opening' && state.state !== 'open' && state.state !== 'closing') {
    throw new Error(`INVALID_TRANSITION: cannot fail ${state.state}`)
  }
  assertContext(state, context)
  return {
    ...state,
    state: 'failed',
    error: { code: context.code, message: context.message, at: context.at },
  }
}
