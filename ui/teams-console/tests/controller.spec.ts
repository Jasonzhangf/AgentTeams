import { describe, expect, it } from 'vitest'
import { TeamsConsoleController } from '../src/client/controller.ts'
import type { AgentFixture } from '../src/client/model.ts'

const agent: AgentFixture = {
  id: 'planner',
  label: 'Planner',
  machine: 'Mac Studio',
  status: 'running',
  provider: 'rcc',
  model: 'deepseek-v4',
  currentSessionId: 'planner-current',
  currentSessionTitle: 'Plan Teams runtime',
  sessionCount: 1,
  notificationCount: 1,
  attention: 'high',
}

describe('TeamsConsoleController', () => {
  it('opens on Topology and switches among the five entries', () => {
    const controller = new TeamsConsoleController()

    expect(controller.getSnapshot()).toMatchObject({
      open: false,
      entry: 'topology',
      drawers: [],
      expanded: false,
    })

    controller.openConsole()
    expect(controller.getSnapshot().open).toBe(true)

    for (const entry of ['conversations', 'notifications', 'search', 'memory', 'topology'] as const) {
      controller.selectEntry(entry)
      expect(controller.getSnapshot().entry).toBe(entry)
      expect(controller.getSnapshot().drawers).toEqual([])
    }
  })

  it('opens the current session directly and reports when none exists', () => {
    const controller = new TeamsConsoleController()
    controller.openConsole()
    controller.focusCurrentSession(agent)

    expect(controller.getSnapshot().drawers).toEqual([{
      kind: 'session',
      agent,
      sessionId: 'planner-current',
    }])

    const withoutSession = { ...agent, currentSessionId: undefined, currentSessionTitle: undefined }
    controller.focusCurrentSession(withoutSession)
    expect(controller.getSnapshot().drawers).toHaveLength(1)
    expect(controller.getSnapshot().notice).toContain('No current session')
  })

  it('delegates current-session opening to the DSH adapter when configured', () => {
    const opened: AgentFixture[] = []
    const controller = new TeamsConsoleController((selected) => { opened.push(selected) })

    controller.openConsole()
    controller.focusCurrentSession(agent)

    expect(opened).toEqual([agent])
    expect(controller.getSnapshot().drawers).toEqual([])
  })

  it('pushes and pops nested drawers while keeping expanded state coherent', () => {
    const controller = new TeamsConsoleController()
    controller.pushDrawer({ kind: 'agent', agent })
    controller.pushDrawer({ kind: 'notifications', agent })
    controller.toggleExpanded()

    expect(controller.getSnapshot().drawers).toHaveLength(2)
    expect(controller.getSnapshot().expanded).toBe(true)

    controller.popDrawer()
    expect(controller.getSnapshot().drawers).toHaveLength(1)
    expect(controller.getSnapshot().expanded).toBe(true)

    controller.popDrawer()
    expect(controller.getSnapshot().drawers).toEqual([])
    expect(controller.getSnapshot().expanded).toBe(false)
  })

  it('resets navigation, drawers, expansion, and notices on close', () => {
    const controller = new TeamsConsoleController()
    controller.openConsole()
    controller.selectEntry('notifications')
    controller.focusNotifications(agent)
    controller.toggleExpanded()
    controller.showNotice('temporary')
    controller.closeConsole()

    expect(controller.getSnapshot()).toEqual({
      open: false,
      entry: 'topology',
      drawers: [],
      expanded: false,
      notice: null,
    })
  })

  it('opens Settings as a utility drawer without adding a sixth entry', () => {
    const controller = new TeamsConsoleController()
    controller.openConsole()
    controller.pushDrawer({ kind: 'settings' })

    expect(controller.getSnapshot().entry).toBe('topology')
    expect(controller.getSnapshot().drawers).toEqual([{ kind: 'settings' }])
  })

  it('handles the Escape key on the top drawer without disturbing the entry state', () => {
    const controller = new TeamsConsoleController()
    controller.openConsole()
    controller.selectEntry('conversations')
    controller.pushDrawer({ kind: 'agent', agent })
    controller.pushDrawer({ kind: 'notifications', agent })

    expect(controller.handlesKeyboard({ key: 'Escape' })).toBe(true)
    controller.popDrawer()
    expect(controller.getSnapshot().drawers).toHaveLength(1)
    expect(controller.getSnapshot().entry).toBe('conversations')

    expect(controller.handlesKeyboard({ key: 'Escape' })).toBe(true)
    controller.popDrawer()
    expect(controller.getSnapshot().drawers).toEqual([])

    expect(controller.handlesKeyboard({ key: 'Escape' })).toBe(false)
    expect(controller.handlesKeyboard({ key: 'a' })).toBe(false)
  })
})
