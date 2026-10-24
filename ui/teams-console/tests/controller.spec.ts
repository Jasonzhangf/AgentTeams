import { describe, expect, it, vi } from 'vitest'
import { TeamsConsoleController } from '../src/state/controller.ts'
import { createLiveConsoleHttpClient } from '../src/client/live-client.ts'
import { projectAgents } from '../src/state/model.ts'
import { createFixtureClient } from '../src/fixture.ts'

/** Minimal EventSource double: the live client only needs add/remove/close. */
class RecordingEventSource {
  closed = false
  constructor(readonly url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.closed = true }
}

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

  it('surfaces typed cancel unknown detail without coercing absent baseAccepted', async () => {
    const controller = new TeamsConsoleController({
      ...createFixtureClient(),
      async command() {
        return { ok: false, error: {
          code: 'RESULT_UNKNOWN',
          message: 'Session cancel is not confirmed',
          detail: { kind: 'session.cancel', sessionId: 'planner-current', operationId: 'op-1', abortOperationId: 'abort-1',
            reconciliation: 'unknown', finalState: 'unknown', reason: 'link-lost' },
        } }
      },
    })
    await controller.refresh()
    await expect(controller.cancelSession('planner', 'planner-current')).resolves.toBe(false)
    expect(controller.getSnapshot().error).toContain('reason=link-lost')
    expect(controller.getSnapshot().error).toContain('baseAccepted=absent')
    expect(controller.getSnapshot().error).toContain('abortOperationId=abort-1')
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

  it('pushes nested drawers and pops back to the source without changing projection truth', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    const projection = controller.getSnapshot().projection
    controller.openAgent('planner')
    controller.openSession('planner', 'planner-current')
    expect(controller.getSnapshot().drawerStack).toEqual([
      { kind: 'agent', agentId: 'planner' },
      { kind: 'session', agentId: 'planner', sessionId: 'planner-current' },
    ])
    controller.closeDrawer()
    expect(controller.getSnapshot().drawer).toEqual({ kind: 'agent', agentId: 'planner' })
    expect(controller.getSnapshot().projection).toBe(projection)
  })

  it('resolves a permission reply through the host command', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.replyPermission('planner', 'planner-current', 'permission-1', 'once')).resolves.toBe(true)
    expect(controller.getSnapshot().projection?.notifications[0]?.state).toBe('resolved')
    const resolved = controller.getSnapshot().projection?.sessionEvents?.find(event => event.kind === 'permission' && event.permissionId === 'permission-1')
    expect(resolved?.kind === 'permission' ? resolved.state : undefined).toBe('resolved')
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
    const planner = projectAgents(controller.getSnapshot().projection!).find(agent => agent.agentId === 'planner')
    expect(planner?.modelId).toBe('deepseek-v4')
  })

  it('moves accepted config to effective revision only after apply', async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.applyConfig('planner')).resolves.toBe(true)
    const config = controller.getSnapshot().projection?.configs[0]
    expect(config?.effectiveRevision).toBe(config?.acceptedRevision)
    expect(controller.getSnapshot().notice).toBe('Apply configuration: accepted by Agent')
  })

  it('refreshes the owner projection after sending instead of appending UI-owned transcript state', async () => {
    const client = createFixtureClient()
    let reads = 0
    const controller = new TeamsConsoleController({
      ...client,
      async readProjection() {
        reads += 1
        return client.readProjection()
      },
    })
    await controller.refresh()
    const before = controller.getSnapshot().projection?.sessionEvents?.length
    await expect(controller.sendSession('planner', 'planner-current', { text: 'owner refresh' })).resolves.toBe(true)
    expect(reads).toBe(2)
    expect(controller.getSnapshot().projection?.sessionEvents).toHaveLength((before ?? 0) + 1)
    expect(controller.getSnapshot().notice).toContain('{"accepted":true}')
  })

  it('reads history when the history view is opened, because its only other trigger is disabled', async () => {
    const requests: string[] = []
    const controller = new TeamsConsoleController(createLiveConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      eventSourceImpl: RecordingEventSource as unknown as new (url: string) => EventSource,
      fetchImpl: async input => {
        const url = String(input)
        requests.push(url)
        if (url.includes('/api/v1/history')) return new Response(JSON.stringify({ records: [], nextBeforeSequence: 0 }), { status: 200 })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    }))
    const historyRequests = () => requests.filter(url => url.includes('/api/v1/history'))
    expect(historyRequests()).toHaveLength(0)

    controller.selectPage('history')

    await vi.waitFor(() => expect(controller.getSnapshot().historyStatus).toBe('ready'))
    expect(historyRequests()).toHaveLength(1)
    expect(controller.getSnapshot().page).toBe('history')
  })

  it('starts the first history read for a page restored from persistence', async () => {
    const requests: string[] = []
    const controller = new TeamsConsoleController(createLiveConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      eventSourceImpl: RecordingEventSource as unknown as new (url: string) => EventSource,
      fetchImpl: async input => {
        const url = String(input)
        requests.push(url)
        if (url.includes('/api/v1/history')) return new Response(JSON.stringify({ records: [], nextBeforeSequence: 0 }), { status: 200 })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    }), {
      // A page restored from persistence never goes through selectPage, so the constructor is
      // the only place that can start the first read for it.
      persistence: {
        getItem: (key: string) => key === 'teams-console-draft:teams-console-page' ? JSON.stringify('history') : null,
        setItem: () => {},
      },
    })
    expect(controller.getSnapshot().page).toBe('history')
    await vi.waitFor(() => expect(controller.getSnapshot().historyStatus).toBe('ready'))
    expect(requests.filter(url => url.includes('/api/v1/history'))).toHaveLength(1)
  })

  it('starts no history read for a fixture client, which has no history owner', () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    controller.selectPage('history')
    expect(controller.getSnapshot().historyStatus).toBe('idle')
  })
})
