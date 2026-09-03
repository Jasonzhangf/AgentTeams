import { describe, expect, it } from 'vitest'
import { projectDshAgentSessionList, projectHostSessionIdentities } from './agent-identity.ts'

describe('DSH host Agent identity producer contract', () => {
  it('projects only explicitly owned preset sessions', () => {
    expect(projectHostSessionIdentities([
      { sessionId: 's1', agentPreset: 'standard', running: false, current: true, title: 'Plan' },
      { sessionId: 's2', agentPreset: 'unknown', running: true, current: false },
    ], [{ agentId: 'planner', agentPreset: 'standard' }])).toEqual([{
      sessionId: 's1', agentId: 'planner', running: false, current: true, title: 'Plan',
    }])
  })

  it('rejects duplicate ownership and never chooses an owner silently', () => {
    expect(() => projectHostSessionIdentities([], [
      { agentId: 'planner', agentPreset: 'standard' },
      { agentId: 'reviewer', agentPreset: 'standard' },
    ])).toThrow(/duplicate Agent preset/)
  })

  it('binds the host current id without requiring a running state', () => {
    expect(projectDshAgentSessionList({
      currentSessionId: 's1',
      items: [{ sessionId: 's1', agentPreset: 'standard', running: false, current: false }],
    }, [{ agentId: 'planner', agentPreset: 'standard' }])).toEqual([{
      sessionId: 's1', agentId: 'planner', running: false, current: true,
    }])
  })
})
