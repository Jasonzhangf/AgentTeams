import type { ConsoleProjectionSnapshot, ConsoleProjectionSink, ConsoleProjectionUnsubscribe, SessionObservationState } from './protocol.ts'
import { parseConsoleProjectionSnapshot } from './protocol.ts'

export type ObservationState = 'unknown' | 'stale' | 'live'

export interface ObservationSession {
  readonly projection: ConsoleProjectionSnapshot['projection'] | null
  readonly observation: ObservationState
  readonly health: SessionObservationState
}

export interface ObservationControllerOptions {
  readonly subscribe: () => ConsoleProjectionUnsubscribe
  readonly onSnapshot: (projection: ConsoleProjectionSnapshot['projection']) => void
  readonly onObservation: (state: ObservationSession) => void
  readonly onError: (error: unknown) => void
}

export class ProjectionObservationController {
  private expectedSeq: number | null = null
  private health: SessionObservationState = { state: 'live' }
  private projection: ConsoleProjectionSnapshot['projection'] | null = null
  private unsubscribe: ConsoleProjectionUnsubscribe | null = null

  constructor(private readonly options: ObservationControllerOptions) {}

  start(): void {
    if (this.unsubscribe !== null) return
    this.unsubscribe = this.options.subscribe()
    this.emit('live')
  }

  stop(): void {
    if (this.unsubscribe === null) return
    this.unsubscribe()
    this.unsubscribe = null
  }

  onSnapshot(snapshot: unknown): void {
    const parsed = parseConsoleProjectionSnapshot(snapshot)
    if (this.expectedSeq === null || parsed.seq >= this.expectedSeq) {
      this.expectedSeq = parsed.seq + 1
      this.projection = parsed.projection
      this.health = { state: 'live' }
      this.options.onSnapshot(parsed.projection)
      this.emit('live')
      return
    }
    this.health = { state: 'degraded', reason: 'projection-loss', detail: `Missing projection sequence ${this.expectedSeq}`, droppedEvents: this.expectedSeq - parsed.seq }
    this.emit('stale')
  }

  onHealth(state: SessionObservationState): void {
    this.health = state
    this.emit(state.state === 'live' ? 'live' : 'stale')
  }

  getSnapshot(): ObservationSession {
    return { projection: this.projection, observation: this.health.state === 'live' ? 'live' : 'stale', health: this.health }
  }

  private emit(observation: ObservationState): void {
    this.options.onObservation({ projection: this.projection, observation, health: this.health })
  }
}

export function createSinkForController(controller: ProjectionObservationController): ConsoleProjectionSink {
  return {
    onSnapshot(snapshot: ConsoleProjectionSnapshot): void {
      controller.onSnapshot(snapshot)
    },
    onHealth(state: SessionObservationState): void {
      controller.onHealth(state)
    },
  }
}

export function sinkToSubscription(controller: ProjectionObservationController, eventSource: EventSource): ConsoleProjectionUnsubscribe {
  const onMessage = (event: MessageEvent): void => {
    try {
      controller.onSnapshot(JSON.parse(String(event.data)))
    } catch (error) {
      controller.onHealth({ state: 'degraded', reason: 'stream-retry', detail: 'Malformed projection event', droppedEvents: 0 })
    }
  }
  const onHealth = (event: MessageEvent): void => {
    try {
      controller.onHealth(JSON.parse(String(event.data)) as SessionObservationState)
    } catch {
      // A malformed health frame is observation loss, never live state.
      controller.onHealth({ state: 'lost', reason: 'stream-ended', detail: 'Malformed observation health event' })
    }
  }
  const onError = (): void => {
    controller.onHealth({ state: 'lost', reason: 'stream-ended', detail: 'SSE stream ended' })
  }
  eventSource.addEventListener('snapshot', onMessage)
  eventSource.addEventListener('health', onHealth)
  eventSource.addEventListener('error', onError)
  return () => {
    eventSource.removeEventListener('snapshot', onMessage)
    eventSource.removeEventListener('health', onHealth)
    eventSource.removeEventListener('error', onError)
    eventSource.close()
  }
}

export function subscriptionFromSource(subscribe: () => ConsoleProjectionUnsubscribe, createSink: () => ConsoleProjectionSink): ConsoleProjectionUnsubscribe {
  let unsubscribe: ConsoleProjectionUnsubscribe | null = null
  let stopped = false
  try {
    unsubscribe = subscribe()
  } catch (error) {
    stopped = true
    throw error
  }
  return () => {
    if (stopped) return
    stopped = true
    unsubscribe?.()
  }
}
