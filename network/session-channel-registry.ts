import {
  ChannelContext,
  ChannelError,
  ChannelState,
  createChannelState,
  onClose,
  onCloseAck,
  onError,
  onMessage,
  onOpenAck,
  openChannel,
} from '../control-protocol/channel-state.ts'

export interface SessionChannelRegistry {
  readonly channels: ReadonlyMap<string, ChannelState>
}

export function createSessionChannelRegistry(): SessionChannelRegistry {
  return { channels: new Map() }
}

function contextFor(state: ChannelState, targetGeneration: number, channelId: string, at: number): ChannelContext {
  if (state.channelId !== channelId) throw new Error('CHANNEL_MISMATCH')
  if (state.targetGeneration !== targetGeneration) throw new Error('STALE_GENERATION')
  if (state.sessionId === undefined) throw new Error('CHANNEL_MISSING_SESSION')
  return { targetGeneration, channelId, sessionId: state.sessionId, at }
}

function write(registry: SessionChannelRegistry, channelId: string, state: ChannelState): SessionChannelRegistry {
  const channels = new Map(registry.channels)
  channels.set(channelId, state)
  return { channels }
}

export function openSessionChannel(
  registry: SessionChannelRegistry,
  targetGeneration: number,
  channelId: string,
  sessionId: string,
  at: number,
): SessionChannelRegistry {
  if (registry.channels.has(channelId)) throw new Error('CHANNEL_ALREADY_EXISTS')
  const next = openChannel(createChannelState(), { targetGeneration, channelId, sessionId, at })
  return write(registry, channelId, next)
}

export function acknowledgeSessionChannel(
  registry: SessionChannelRegistry,
  targetGeneration: number,
  channelId: string,
  at: number,
): SessionChannelRegistry {
  const state = registry.channels.get(channelId)
  if (!state) throw new Error('UNKNOWN_CHANNEL')
  const next = onOpenAck(state, contextFor(state, targetGeneration, channelId, at))
  return write(registry, channelId, next)
}

export function sendSessionMessage(
  registry: SessionChannelRegistry,
  targetGeneration: number,
  channelId: string,
  at: number,
): SessionChannelRegistry {
  const state = registry.channels.get(channelId)
  if (!state) throw new Error('UNKNOWN_CHANNEL')
  const next = onMessage(state, contextFor(state, targetGeneration, channelId, at))
  return write(registry, channelId, next)
}

export function closeSessionChannel(
  registry: SessionChannelRegistry,
  targetGeneration: number,
  channelId: string,
  at: number,
): SessionChannelRegistry {
  const state = registry.channels.get(channelId)
  if (!state) throw new Error('UNKNOWN_CHANNEL')
  const next = onClose(state, contextFor(state, targetGeneration, channelId, at))
  return write(registry, channelId, next)
}

export function acknowledgeSessionChannelClose(
  registry: SessionChannelRegistry,
  targetGeneration: number,
  channelId: string,
  at: number,
): SessionChannelRegistry {
  const state = registry.channels.get(channelId)
  if (!state) throw new Error('UNKNOWN_CHANNEL')
  const next = onCloseAck(state, contextFor(state, targetGeneration, channelId, at))
  return write(registry, channelId, next)
}

export function failSessionChannel(
  registry: SessionChannelRegistry,
  targetGeneration: number,
  channelId: string,
  at: number,
  error: Pick<ChannelError, 'code' | 'message'>,
): SessionChannelRegistry {
  const state = registry.channels.get(channelId)
  if (!state) throw new Error('UNKNOWN_CHANNEL')
  const next = onError(state, { ...contextFor(state, targetGeneration, channelId, at), ...error })
  return write(registry, channelId, next)
}
