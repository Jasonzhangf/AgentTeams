import { describe, expect, it } from 'vitest'
import {
  createTeamsOpenCodePlugin,
  projectOpenCodeEvent,
  projectOpenCodePermission,
  registerOpenCodeHooks,
  type OpenCodeNotification,
} from '../src/index.ts'

describe('OpenCode Teams adapter', () => {
  it('projects OpenCode session events from the SDK info shape', () => {
    expect(projectOpenCodeEvent({
      type: 'session.created',
      properties: { info: { id: 'ses_created' } },
    })).toEqual({
      source: 'opencode',
      kind: 'session-created',
      sessionId: 'ses_created',
      interactive: false,
    })
  })

  it('does not project unknown or session-less events', () => {
    expect(projectOpenCodeEvent({ type: 'tool.execute.after', properties: { sessionID: 'ses_3' } })).toBeUndefined()
    expect(projectOpenCodeEvent({ type: 'permission.asked', properties: { id: 'per_2' } })).toBeUndefined()
  })

  it('projects permission.ask as the interactive hook contract', () => {
    expect(projectOpenCodePermission({ id: 'per_3', sessionID: 'ses_3' })).toEqual({
      source: 'opencode',
      kind: 'permission-request',
      sessionId: 'ses_3',
      requestId: 'per_3',
      interactive: true,
    })
  })

  it('registers OpenCode event and permission hooks', async () => {
    const received: OpenCodeNotification[] = []
    const hooks = registerOpenCodeHooks((notification) => { received.push(notification) })
    await hooks.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_4', status: { type: 'busy' } },
      },
    })
    await hooks['permission.ask']?.({ id: 'per_4', sessionID: 'ses_4' }, { status: 'ask' })
    expect(received).toEqual([{
      source: 'opencode',
      kind: 'session-status',
      sessionId: 'ses_4',
      interactive: false,
    }, {
      source: 'opencode',
      kind: 'permission-request',
      sessionId: 'ses_4',
      requestId: 'per_4',
      interactive: true,
    }])
  })

  it('exports the OpenCode v1 install shape', async () => {
    const sink: OpenCodeNotification[] = []
    const hooks = await createTeamsOpenCodePlugin((notification) => { sink.push(notification) })({} as never)
    await hooks.event?.({
      event: { type: 'session.status', properties: { sessionID: 'ses_5' } },
    })
    expect(sink).toEqual([{
      source: 'opencode',
      kind: 'session-status',
      sessionId: 'ses_5',
      interactive: false,
    }])
  })
})
