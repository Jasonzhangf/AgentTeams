import { describe, expect, it } from 'vitest'
import {
  parseHistoryQuery,
  parseTeamsConnectionState,
  parseTeamsConnectionStatus,
  TEAMS_CONNECTION_STATES,
} from './teams-state.ts'

function status(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    remoteAgentId: 'reasoner-a',
    state: 'ready',
    targetGeneration: 3,
    observedAt: '2026-10-10T21:00:00.000Z',
    connectionId: 'connection-1',
    role: 'peer',
    ...overrides,
  }
}

describe('Teams connection status', () => {
  it('keeps a closed state vocabulary with no inferred states', () => {
    expect([...TEAMS_CONNECTION_STATES]).toEqual([
      'disconnected',
      'connecting',
      'authenticating',
      'negotiating',
      'ready',
      'closed',
      'failed',
    ])
    for (const state of TEAMS_CONNECTION_STATES) expect(parseTeamsConnectionState(state)).toBe(state)
    expect(() => parseTeamsConnectionState('online')).toThrow()
  })

  it('parses an owner status and rejects unknown fields or generations', () => {
    expect(parseTeamsConnectionStatus(status())).toEqual(status())
    expect(() => parseTeamsConnectionStatus(status({ state: 'failed' }))).toThrow()
    expect(() => parseTeamsConnectionStatus(status({ unexpected: true }))).toThrow()
    expect(() => parseTeamsConnectionStatus(status({ targetGeneration: 0 }))).toThrow()
    expect(() => parseTeamsConnectionStatus(status({ observedAt: 'not-a-time' }))).toThrow()
    expect(() => parseTeamsConnectionStatus(status({ role: 'subordinate' }))).toThrow()
    expect(() => parseTeamsConnectionStatus(status({ version: 2 }))).toThrow()
  })

  it('carries a fault only for the failed state', () => {
    const failed = status({ state: 'failed', error: { code: 'ENGINE_UNAVAILABLE', message: 'engine exited' } })
    expect(parseTeamsConnectionStatus(failed)).toMatchObject({ state: 'failed' })
    expect(() => parseTeamsConnectionStatus(status({ error: { code: 'CONFLICT', message: 'no' } }))).toThrow()
    expect(() => parseTeamsConnectionStatus(status({
      state: 'failed',
      error: { message: 'missing code' },
    }))).toThrow()
  })
})

describe('history query', () => {
  it('parses a closed, bounded query', () => {
    expect(parseHistoryQuery({ version: 1, limit: 50 })).toEqual({ version: 1, limit: 50 })
    expect(parseHistoryQuery({
      version: 1,
      kind: 'connection',
      agentId: 'reasoner-a',
      sessionId: 'session-1',
      limit: 10,
      beforeSequence: 42,
    })).toMatchObject({ kind: 'connection', beforeSequence: 42 })
  })

  it('rejects unsupported kinds, unbounded limits, and unknown fields', () => {
    expect(() => parseHistoryQuery({ version: 1, limit: 0 })).toThrow()
    expect(() => parseHistoryQuery({ version: 1, limit: 501 })).toThrow()
    expect(() => parseHistoryQuery({ version: 1, limit: 10, kind: 'work' })).toThrow()
    expect(() => parseHistoryQuery({ version: 2, limit: 10 })).toThrow()
    expect(() => parseHistoryQuery({ version: 1, limit: 10, extra: true })).toThrow()
    expect(() => parseHistoryQuery({ version: 1, limit: 10, beforeSequence: 0 })).toThrow()
  })
})
