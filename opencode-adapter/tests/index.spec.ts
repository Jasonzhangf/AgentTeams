import { describe, expect, it } from 'vitest'
import {
  createTeamsOpenCodePlugin,
  projectOpenCodeEvent,
  projectOpenCodePermission,
  registerOpenCodeHooks,
  subscribeOpenCodeNotifications,
  TeamsOpenCodePlugin,
  type OpenCodeNotification,
  listOpenCodeSessions,
  getOpenCodeSession,
  sendOpenCodeMessage,
  replyOpenCodePermission,
  acknowledgeOpenCodeNotification,
  sortOpenCodeNotifications,
  createOpenCodeNotificationStoreBinding,
  createOpenCodeHostFacade,
  createOpenCodePluginRuntime,
  projectOpenCodeTeamsProjection,
  projectOpenCodeNotifications,
  compileOpenCodeConfig,
  createOpenCodeConfigApplier,
} from '../src/index.ts'

describe('OpenCode Teams adapter', () => {
  it('projects OpenCode session events from the SDK info shape', () => {
    const notification = projectOpenCodeEvent({
      type: 'session.created',
      properties: { info: { id: 'ses_created' } },
    })
    expect(notification).toMatchObject({
      source: 'opencode',
      kind: 'session-created',
      sessionId: 'ses_created',
      interactive: false,
    })
    expect(notification?.status).toBe('pending')
  })

  it('does not project unknown or session-less events', () => {
    expect(projectOpenCodeEvent({ type: 'tool.execute.after', properties: { sessionID: 'ses_3' } })).toBeUndefined()
    expect(projectOpenCodeEvent({ type: 'permission.asked', properties: { id: 'per_2' } })).toBeUndefined()
  })

  it('projects permission.ask as the interactive hook contract', () => {
    expect(projectOpenCodePermission({ id: 'per_3', sessionID: 'ses_3' })).toMatchObject({
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
    expect(received).toMatchObject([{
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
    expect(sink).toMatchObject([{
      source: 'opencode',
      kind: 'session-status',
      sessionId: 'ses_5',
      interactive: false,
    }])
  })

  it('default server entry publishes notifications to subscribers', async () => {
    const received: OpenCodeNotification[] = []
    const unsubscribe = subscribeOpenCodeNotifications(notification => { received.push(notification) })
    const hooks = await TeamsOpenCodePlugin({ client: { session: { list: async () => ({ data: [] }) } }, directory: '' } as never)
    await hooks.event?.({ event: { type: 'session.created', properties: { sessionID: 'ses-live' } } })
    unsubscribe()
    expect(received).toMatchObject([{ source: 'opencode', kind: 'session-created', sessionId: 'ses-live', interactive: false }])
  })

  it('uses the OpenCode SDK for session discovery, focused session, message send, and permission reply', async () => {
    const calls: string[] = []
    const client = { session: {
      list: async () => { calls.push('list'); return { data: [{ id: 'ses_1', title: 'Current' }] } },
      get: async () => { calls.push('get'); return { data: { id: 'ses_1', title: 'Current' } } },
      prompt: async (input: { path: { id: string }; body: { parts: readonly [{ type: 'text'; text: string }] } }) => { calls.push(`prompt:${input.path.id}:${input.body.parts[0].text}`) },
    }, postSessionIdPermissionsPermissionId: async (input: { path: { id: string; permissionID: string }; body: { response: 'once' | 'always' | 'reject' } }) => { calls.push(`permission:${input.path.id}:${input.path.permissionID}:${input.body.response}`) }}
    await expect(listOpenCodeSessions(client)).resolves.toEqual([{ id: 'ses_1', title: 'Current' }])
    await expect(getOpenCodeSession(client, 'ses_1')).resolves.toEqual({ id: 'ses_1', title: 'Current' })
    await sendOpenCodeMessage(client, 'ses_1', 'hello')
    await replyOpenCodePermission(client, 'per_1', 'ses_1', 'once')
    expect(calls).toEqual(['list', 'get', 'prompt:ses_1:hello', 'permission:ses_1:per_1:once'])
  })

  it('sorts notifications by priority and acknowledges a pending item', () => {
    const low = projectOpenCodeEvent({ type: 'session.updated', properties: { sessionID: 'ses_low' } })!
    const high = projectOpenCodePermission({ id: 'per_high', sessionID: 'ses_high' })
    const sorted = sortOpenCodeNotifications([low, high])
    expect(sorted[0]).toMatchObject({ requestId: 'per_high', priority: 'high' })
    const acknowledged = acknowledgeOpenCodeNotification({ pending: [high], processed: [] }, 'permission-request:ses_high:per_high')
    expect(acknowledged.pending).toEqual([])
    expect(acknowledged.processed[0]).toMatchObject({ status: 'processed', requestId: 'per_high' })
  })

  it('binds the hook sink to one pending/processed notification store', () => {
    const binding = createOpenCodeNotificationStoreBinding()
    const low = projectOpenCodeEvent({ type: 'session.updated', properties: { sessionID: 'ses_low' } })!
    const high = projectOpenCodePermission({ id: 'per_high', sessionID: 'ses_high' })
    binding.sink(low)
    binding.sink(high)
    expect(binding.get().pending.map(item => item.sessionId)).toEqual(['ses_high', 'ses_low'])
    binding.sink({ ...high, status: 'processed' })
    expect(binding.get().processed).toHaveLength(1)
    expect(binding.get().pending).toHaveLength(1)
    binding.acknowledge('permission-request:ses_high:per_high')
    expect(binding.get().pending).toHaveLength(1)
  })

  it('projects permission lifecycle events into pending and processed notifications', () => {
    expect(projectOpenCodeEvent({
      type: 'permission.updated',
      properties: { sessionID: 'ses_6', id: 'per_6' },
    })).toMatchObject({ kind: 'permission-request', requestId: 'per_6', status: 'pending', priority: 'high' })
    expect(projectOpenCodeEvent({
      type: 'permission.replied',
      properties: { sessionID: 'ses_6', permissionID: 'per_6', response: 'reject' },
    })).toMatchObject({ kind: 'permission-processed', requestId: 'per_6', status: 'processed', priority: 'high' })
  })

  it('exposes a host facade with typed projections and OpenCode-owned actions', async () => {
    const calls: string[] = []
    const client = { session: {
      list: async () => ({ data: [] }),
      get: async ({ path }: { path: { id: string } }) => { calls.push(`get:${path.id}`); return { data: { id: path.id, title: 'Focused' } } },
      prompt: async ({ path }: { path: { id: string } }) => { calls.push(`prompt:${path.id}`) },
    }, postSessionIdPermissionsPermissionId: async ({ path, body }: { path: { id: string; permissionID: string }; body: { response: 'once' | 'always' | 'reject' } }) => { calls.push(`reply:${path.id}:${path.permissionID}:${body.response}`) }}
    const facade = createOpenCodeHostFacade(client)
    await expect(facade.refreshSessions()).resolves.toEqual([])
    await facade.actions.openSession('ses_7')
    await facade.actions.sendMessage('ses_7', 'hello')
    await facade.actions.replyPermission('ses_7', 'per_7', 'reject')
    expect(facade.projection().notifications).toEqual({ pending: [], processed: [] })
    expect(calls).toEqual(['get:ses_7', 'prompt:ses_7', 'reply:ses_7:per_7:reject'])
  })

  it('binds PluginInput client, refreshes sessions, and returns host hooks', async () => {
    const input = {
      client: { session: {
        list: async () => ({ data: [{ id: 'ses_8', title: 'Live' }] }),
        get: async () => ({ data: { id: 'ses_8', title: 'Live' } }),
        prompt: async () => undefined,
      }}, postSessionIdPermissionsPermissionId: async () => undefined,
      directory: '/workspace',
    }
    const runtime = await createOpenCodePluginRuntime(input as never)
    expect(runtime.facade.projection().sessions).toEqual([{ id: 'ses_8', title: 'Live' }])
    expect(typeof runtime.hooks.event).toBe('function')
    await runtime.hooks.event?.({ event: { type: 'session.status', properties: { sessionID: 'ses_8' } } })
    expect(runtime.facade.projection().notifications.pending).toHaveLength(1)
  })

  it('notifies facade subscribers after session refresh', async () => {
    const updates: string[][] = []
    const client = { session: {
      list: async () => ({ data: [{ id: 'ses_sub', title: 'Subscribed' }] }),
      get: async () => ({ data: { id: 'ses_sub', title: 'Subscribed' } }),
      prompt: async () => undefined,
    }, postSessionIdPermissionsPermissionId: async () => undefined }
    const facade = createOpenCodeHostFacade(client)
    const unsubscribe = facade.subscribe(projection => { updates.push(projection.sessions.map(session => session.id)) })
    await facade.refreshSessions()
    unsubscribe()
    expect(updates).toEqual([['ses_sub']])
  })

  it('projects sessions only through explicit host identity bindings', () => {
    const projected = projectOpenCodeTeamsProjection(
      [{ id: 'ses_bound', title: 'Bound' }, { id: 'ses_unknown', title: 'Unknown' }],
      { pending: [], processed: [] },
      [{ agentId: 'agent_a', machineId: 'machine_a', label: 'Agent A', machine: 'Machine A', provider: 'provider', model: 'model', sessionIds: ['ses_bound'], currentSessionId: 'ses_bound' }],
    )
    expect(projected.sessions).toEqual([{ id: 'ses_bound', title: 'Bound', agentId: 'agent_a', running: true }])
    expect(projected.agents[0].currentSessionId).toBe('ses_bound')
  })

  it('projects notification store entries without carrying message bodies', () => {
    const item = projectOpenCodeNotifications({
      pending: [projectOpenCodePermission({ id: 'per_10', sessionID: 'ses_10' })],
      processed: [],
    })[0]
    expect(item).toMatchObject({ id: 'permission-request:ses_10:per_10', sessionId: 'ses_10', requestId: 'per_10', interactive: true, processed: false, priority: 'high' })
    expect(Object.keys(item)).not.toContain('metadata')
    expect(Object.keys(item)).not.toContain('body')
  })

  it('refreshes the session projection when a session lifecycle event arrives', async () => {
    let listed = [{ id: 'ses_9', title: 'Initial' }]
    const input = {
      client: { session: {
        list: async () => ({ data: listed }),
        get: async () => ({ data: listed[0] }),
        prompt: async () => undefined,
      }}, postSessionIdPermissionsPermissionId: async () => undefined,
      directory: '/workspace',
    }
    const runtime = await createOpenCodePluginRuntime(input as never)
    listed = [...listed, { id: 'ses_10', title: 'Created' }]
    await runtime.hooks.event?.({ event: { type: 'session.created', properties: { sessionID: 'ses_10' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtime.facade.projection().sessions.map(session => session.id)).toEqual(['ses_9', 'ses_10'])
  })

  it('compiles only the selected provider/model projection and keeps credentials opaque', () => {
    const compiled = compileOpenCodeConfig({
      revision: 11,
      acceptedRevision: 11,
      providers: {
        primary: {
          id: 'primary',
          label: 'Primary',
          protocol: 'openai-responses',
          apiBaseUrl: 'http://127.0.0.1:4444/v1',
          enabled: true,
          auth: { kind: 'none' },
        },
        backup: {
          id: 'backup',
          label: 'Backup',
          protocol: 'openai-chat',
          apiBaseUrl: 'https://backup.example/v1',
          enabled: true,
          auth: { kind: 'bearer', credentialRef: 'credential:backup' },
        },
      },
      catalogs: {
        primary: { state: 'ready', entries: [{ ref: { providerInstanceId: 'primary', modelId: 'primary-model' }, origin: 'manual', base: {}, overrides: {} }] },
        backup: { state: 'ready', entries: [{ ref: { providerInstanceId: 'backup', modelId: 'backup-model' }, origin: 'manual', base: {}, overrides: {} }] },
      },
      agents: {
        planner: {
          primary: { providerInstanceId: 'primary', modelId: 'primary-model' },
          backup: { providerInstanceId: 'backup', modelId: 'backup-model' },
        },
      },
    }, 'planner')

    expect(compiled).toEqual({
      agentId: 'planner',
      acceptedRevision: 11,
      primary: { provider: 'primary', model: 'primary-model', protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:4444/v1' },
      backup: { provider: 'backup', model: 'backup-model', protocol: 'openai-chat', baseUrl: 'https://backup.example/v1', credentialRef: 'credential:backup' },
    })
    expect(JSON.stringify(compiled)).not.toContain('secret')
    expect(Object.keys(compiled.primary)).toEqual(['provider', 'model', 'protocol', 'baseUrl'])
  })

  it('rejects compilation when a selected model is absent or unavailable', () => {
    const config = {
      revision: 3,
      acceptedRevision: 3,
      providers: {
        primary: {
          id: 'primary',
          label: 'Primary',
          protocol: 'openai-responses' as const,
          apiBaseUrl: 'http://127.0.0.1:4444/v1',
          enabled: true,
          auth: { kind: 'none' as const },
        },
      },
      catalogs: { primary: { state: 'ready' as const, entries: [] } },
      agents: { planner: { primary: { providerInstanceId: 'primary', modelId: 'missing' } } },
    }
    expect(() => compileOpenCodeConfig(config, 'planner')).toThrow(/model not found/)
  })

  it('reports unsupported config apply without an effective revision', async () => {
    const result = await createOpenCodeConfigApplier().apply({
      revision: 4,
      acceptedRevision: 4,
      providers: {},
      catalogs: {},
      agents: {},
    })
    expect(result).toEqual({
      status: 'unsupported',
      error: { code: 'UNSUPPORTED_OPERATION', message: 'OpenCode config apply API is unsupported' },
    })
    expect(result).not.toHaveProperty('effectiveRevision')
  })

  it('propagates SDK list errors instead of treating them as an empty catalog', async () => {
    const client = {
      session: {
        list: async () => ({ data: undefined, error: { message: 'unauthorized' }, response: { status: 401 } }),
      },
    }
    await expect(listOpenCodeSessions(client as never)).rejects.toMatchObject({ status: 401 })
  })

  it('rejects non-2xx SDK envelopes even when they contain data', async () => {
    const client = {
      session: {
        list: async () => ({ data: [], response: { status: 302 } }),
      },
    }
    await expect(listOpenCodeSessions(client as never)).rejects.toMatchObject({ status: 302 })
  })

  it('rejects a raw non-2xx SDK status instead of passing it to the projection', async () => {
    const client = {
      session: {
        list: async () => ({ status: 500 }),
      },
    }
    await expect(listOpenCodeSessions(client as never)).rejects.toMatchObject({ status: 500, code: 'UPSTREAM_ERROR' })
  })

  it('propagates SDK get status errors without rewriting them as not found', async () => {
    const client = {
      session: {
        get: async () => ({ data: undefined, error: { message: 'forbidden' }, response: { status: 403 } }),
      },
    }
    await expect(getOpenCodeSession(client as never, 'ses_forbidden')).rejects.toMatchObject({ status: 403 })
  })

  it('propagates prompt and permission SDK errors', async () => {
    const client = {
      session: {
        prompt: async () => ({ data: undefined, error: { message: 'upstream unavailable' }, response: { status: 503 } }),
      },
      postSessionIdPermissionsPermissionId: async () => ({ data: undefined, error: { message: 'permission missing' }, response: { status: 404 } }),
    }
    await expect(sendOpenCodeMessage(client as never, 'ses_upstream', 'hello')).rejects.toMatchObject({ status: 503 })
    await expect(replyOpenCodePermission(client as never, 'per_missing', 'ses_upstream', 'reject')).rejects.toMatchObject({ status: 404 })
  })
})
