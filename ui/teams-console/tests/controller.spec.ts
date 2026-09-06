import { describe, expect, it } from 'vitest'
import { TeamsConsoleController } from '../src/client/controller.ts'
import { createFixtureClient } from '../src/fixture.ts'

describe('TeamsConsoleController', () => {
  it('loads a projection, opens a Session, and sends unchanged business payload', async () => {
    const client = createFixtureClient()
    const controller = new TeamsConsoleController(client)
    await controller.refresh()
    controller.openConsole()
    controller.openSession('planner', 'planner-current')
    expect(controller.getSnapshot().drawer).toEqual({ kind: 'session', agentId: 'planner', sessionId: 'planner-current' })

    await expect(controller.openSessionCommand('planner', 'planner-current')).resolves.toBe(true)
    await expect(controller.sendSession('planner', 'planner-current', { text: 'hello' })).resolves.toBe(true)
    expect(client.sentPayloads).toEqual([{ text: 'hello' }])
  })

  it('does not bind a model absent from the host catalog', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.bindModel('planner', 'empty-provider', 'guessed-model')).resolves.toBe(false)
    expect(controller.getSnapshot().error).toContain('unknown model')
  })

  it('surfaces revision conflicts and keeps the error visible', async () => {
    const controller = new TeamsConsoleController({
      ...createFixtureClient(),
      async command() { return { ok: false, error: { code: 'REVISION_CONFLICT', message: 'stale revision' } } },
    })
    await controller.refresh()
    const result = await controller.acknowledge('approval-1', 'planner')
    expect(result).toBe(false)
    expect(controller.getSnapshot().error).toContain('REVISION_CONFLICT')
  })

  it('closes the drawer without losing the loaded projection', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    controller.openConsole()
    controller.openAgent('planner')
    controller.closeDrawer()
    expect(controller.getSnapshot().drawer).toBeNull()
    expect(controller.getSnapshot().projection).not.toBeNull()
  })

  it('resolves a permission reply through the host command', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.replyPermission('planner', 'planner-current', 'permission-1', 'once')).resolves.toBe(true)
    expect(controller.getSnapshot().projection?.notifications[0]?.state).toBe('resolved')
  })

  it('acknowledges a notification through the host command', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.acknowledge('approval-1', 'planner')).resolves.toBe(true)
    expect(controller.getSnapshot().projection?.notifications[0]?.state).toBe('resolved')
  })

  it('reports projection read failures without inventing an empty state', async () => {
    const controller = new TeamsConsoleController({
      async readProjection() { throw new Error('daemon unavailable') },
      async command() { return { ok: true } },
      async sendSession() { return { ok: true } },
    })
    await controller.refresh()
    expect(controller.getSnapshot().status).toBe('error')
    expect(controller.getSnapshot().projection).toBeNull()
    expect(controller.getSnapshot().error).toContain('daemon unavailable')
  })

  it('rejects an incomplete provider form before sending a command', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    controller.beginAddProvider()
    await expect(controller.putProvider('planner')).resolves.toBe(false)
    expect(controller.getSnapshot().error).toContain('ID, label, and API base URL')
  })

  it('adds a provider through config.putProvider and refreshes accepted state', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    controller.beginAddProvider()
    controller.setProviderDraft('id', 'new-provider')
    controller.setProviderDraft('label', 'New provider')
    controller.setProviderDraft('apiBaseUrl', 'https://provider.invalid/v1')
    await expect(controller.putProvider('planner')).resolves.toBe(true)
    expect(controller.getSnapshot().projection?.configs[0]?.providers.some(provider => provider.id === 'new-provider')).toBe(true)
  })

  it('refreshes an empty provider catalog without selecting the returned model', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.refreshModels('planner', 'empty-provider')).resolves.toBe(true)
    const provider = controller.getSnapshot().projection?.configs[0]?.providers.find(candidate => candidate.id === 'empty-provider')
    expect(provider?.models).toEqual([{ id: 'refreshed-model', label: 'Refreshed model' }])
    expect(controller.getSnapshot().projection?.agents[0]?.modelId).toBe('deepseek-v4')
  })

  it('moves accepted config to effective revision only after apply', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.applyConfig('planner')).resolves.toBe(true)
    const config = controller.getSnapshot().projection?.configs[0]
    expect(config?.effectiveRevision).toBe(config?.acceptedRevision)
  })
})
