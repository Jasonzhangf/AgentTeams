import { describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { openDshSession } from '../src/client/dsh-adapter.ts'

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
})
