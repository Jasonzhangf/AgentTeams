import { describe, expect, it } from 'vitest'
import { agents, projectAgentCurrentSessions, projectAgentPresetBindings, projectDshSessionList, projectDshSessions } from '../src/client/model.ts'

describe('Teams live Agent projection', () => {
  it('binds a running session only through its explicit host agent identity', () => {
    const projected = projectAgentCurrentSessions(agents, [
      { id: 'live-planner', title: 'Live plan', agentId: 'planner', running: true },
    ])
    expect(projected.find(agent => agent.id === 'planner')).toMatchObject({
      currentSessionId: 'live-planner', currentSessionTitle: 'Live plan',
    })
  })

  it('does not guess an Agent session from an unrelated or stopped session', () => {
    const projected = projectAgentCurrentSessions(agents, [
      { id: 'unrelated', agentId: 'other-agent', running: true },
      { id: 'stopped-planner', agentId: 'planner', running: false },
    ])
    const planner = projected.find(agent => agent.id === 'planner')
    expect(planner).toBeDefined()
    expect(planner).not.toHaveProperty('currentSessionId')
    expect(planner).not.toHaveProperty('currentSessionTitle')
  })

  it('keeps the host-selected current session even after it stops running', () => {
    const projected = projectAgentCurrentSessions(agents, [
      { id: 'completed-planner', agentId: 'planner', running: false },
    ], 'completed-planner')
    expect(projected.find(agent => agent.id === 'planner')).toMatchObject({ currentSessionId: 'completed-planner' })
  })

  it('accepts DSH preset identity only through an explicit host mapping', () => {
    const projected = projectDshSessions([
      { id: 'live-planner', agentPreset: 'planner', running: true },
      { id: 'unknown', agentPreset: 'other', running: true },
    ], { planner: 'planner' })
    expect(projected).toEqual([
      { id: 'live-planner', agentId: 'planner', running: true },
      { id: 'unknown', running: true },
    ])
  })

  it('rejects duplicate preset ownership instead of choosing silently', () => {
    expect(() => projectAgentPresetBindings([
      { agentId: 'planner', agentPreset: 'standard' },
      { agentId: 'reviewer', agentPreset: 'standard' },
    ])).toThrow(/multiple Agent owners/)
  })

  it('projects the DSH global session seat without changing ownership', () => {
    expect(projectDshSessionList({
      current: 's1',
      byId: { s1: { id: 's1', agentPreset: 'standard', running: false } },
    }, [{ agentId: 'planner', agentPreset: 'standard' }])).toEqual([
      { id: 's1', agentId: 'planner', running: false },
    ])
  })
})
