import { describe, expect, it } from 'vitest'
import { ProjectionObservationController } from '../src/client/observation.ts'
import type { ConsoleProjectionV1 } from '../src/client/protocol.ts'

const projection: ConsoleProjectionV1 = { version: 1, agents: [], sessions: [], notifications: [], configs: [] }

function controller() {
  const observations: string[] = []
  const projections: number[] = []
  const instance = new ProjectionObservationController({
    subscribe: () => () => { stopped = true },
    onSnapshot: () => { projections.push(1) },
    onObservation: state => { observations.push(state.observation) },
    onError: () => {},
  })
  let stopped = false
  return { instance, observations, projections, wasStopped: () => stopped }
}

describe('projection observation controller', () => {
  it('starts live and follows owner snapshot sequence', () => {
    const { instance, observations, projections } = controller()
    instance.start()
    instance.onSnapshot({ seq: 1, projection })
    instance.onSnapshot({ seq: 2, projection })
    expect(observations).toEqual(['live', 'live', 'live'])
    expect(projections).toHaveLength(2)
    expect(instance.getSnapshot().observation).toBe('live')
  })

  it('reports a sequence gap as stale without applying the older snapshot', () => {
    const { instance, observations, projections } = controller()
    instance.start()
    instance.onSnapshot({ seq: 5, projection })
    instance.onSnapshot({ seq: 3, projection })
    expect(observations).toEqual(['live', 'live', 'stale'])
    expect(projections).toHaveLength(1)
    expect(instance.getSnapshot().observation).toBe('stale')
    expect(instance.getSnapshot().health.state).toBe('degraded')
  })

  it('treats owner health loss as stale and releases the subscription on stop', () => {
    const state = controller()
    state.instance.start()
    state.instance.onHealth({ state: 'lost', reason: 'stream-ended', detail: 'stream closed' })
    // The emitted observation is the real wiring the controller state consumes; a snapshot read
    // alone derives from `health` and would stay green even if a lost owner emitted `live`.
    expect(state.observations).toEqual(['live', 'stale'])
    expect(state.instance.getSnapshot().observation).toBe('stale')
    expect(state.instance.getSnapshot().health).toEqual({ state: 'lost', reason: 'stream-ended', detail: 'stream closed' })
    state.instance.stop()
    expect(state.wasStopped()).toBe(true)
    expect(state.instance.getSnapshot().observation).toBe('stale')
  })
})
