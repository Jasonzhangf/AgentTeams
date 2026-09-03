import { describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { openDshSession, openCurrentAgentSession } from '../src/client/dsh-adapter.ts'
import type { AgentFixture } from '../src/client/model.ts'

describe('openDshSession', () => {
  it('opens the requested DSH session before closing Teams', () => {
    const events: string[] = []
    const sessions = {
      open: vi.fn(() => { events.push('open') }),
    } as unknown as ISessions
    const closeTeams = vi.fn(() => { events.push('close') })

    openDshSession(sessions, closeTeams, 'planner-current')

    expect(sessions.open).toHaveBeenCalledWith('planner-current')
    expect(closeTeams).toHaveBeenCalledOnce()
    expect(events).toEqual(['open', 'close'])
  })

  it('refuses to forward an agent without a current session', () => {
    const sessions = { open: vi.fn() } as unknown as ISessions
    const closeTeams = vi.fn()
    const agent = { id: 'planner', currentSessionId: undefined } as unknown as AgentFixture
    expect(() => { openCurrentAgentSession(sessions, closeTeams, agent) }).toThrow(/no current session/)
    expect(sessions.open).not.toHaveBeenCalled()
    expect(closeTeams).not.toHaveBeenCalled()
  })

  it('only touches the session owner and never reads transcript, draft, queue, or approval', () => {
    const usedKeys = new Set<string>()
    const openImpl = () => { usedKeys.add('open:called') }
    const fakeSession = new Proxy({ open: openImpl }, {
      get(target, key) {
        if (typeof key === 'symbol') return (target as Record<symbol, unknown>)[key]
        usedKeys.add(String(key))
        if (String(key) === 'open') return openImpl
        return undefined
      },
    }) as unknown as ISessions
    const closeTeams = vi.fn()

    openDshSession(fakeSession, closeTeams, 'planner-current')

    expect(usedKeys.has('open:called')).toBe(true)
    expect(usedKeys.has('history')).toBe(false)
    expect(usedKeys.has('queue')).toBe(false)
    expect(usedKeys.has('draft')).toBe(false)
    expect(usedKeys.has('approval')).toBe(false)
  })
})

describe('openCurrentAgentSession', () => {
  it('delegates to the DSH runtime session owner when a current session exists', () => {
    const sessions = { open: vi.fn() } as unknown as ISessions
    const closeTeams = vi.fn()
    const agent = { id: 'planner', currentSessionId: 'planner-current' } as unknown as AgentFixture

    openCurrentAgentSession(sessions, closeTeams, agent)

    expect(sessions.open).toHaveBeenCalledWith('planner-current')
    expect(closeTeams).toHaveBeenCalledOnce()
  })
})
