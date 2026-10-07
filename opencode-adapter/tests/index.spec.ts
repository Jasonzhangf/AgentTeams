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
  createOpenCodeSession,
  cancelOpenCodeSession,
  createOpenCodePromptMessageId,
  promptOpenCodeSession,
  decodeOpenCodeSessionMessage,
  projectOpenCodeSessionEvent,
  projectOpenCodeSessionMessages,
  readOpenCodeSessionMessages,
  subscribeOpenCodeEvents,
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
    const bodies: unknown[] = []
    const client = { session: {
      list: async () => { calls.push('list'); return { data: [{ id: 'ses_1', title: 'Current' }] } },
      get: async () => { calls.push('get'); return { data: { id: 'ses_1', title: 'Current' } } },
      prompt: async (input: { path: { id: string }; body: { parts: readonly [{ type: 'text'; text: string }] } }) => { bodies.push(input.body); calls.push(`prompt:${input.path.id}:${input.body.parts[0].text}`) },
    }, postSessionIdPermissionsPermissionId: async (input: { path: { id: string; permissionID: string }; body: { response: 'once' | 'always' | 'reject' } }) => { calls.push(`permission:${input.path.id}:${input.path.permissionID}:${input.body.response}`) }}
    await expect(listOpenCodeSessions(client)).resolves.toEqual([{ id: 'ses_1', title: 'Current' }])
    await expect(getOpenCodeSession(client, 'ses_1')).resolves.toEqual({ id: 'ses_1', title: 'Current' })
    await sendOpenCodeMessage(client, 'ses_1', 'hello')
    await replyOpenCodePermission(client, 'per_1', 'ses_1', 'once')
    expect(calls).toEqual(['list', 'get', 'prompt:ses_1:hello', 'permission:ses_1:per_1:once'])
    expect(bodies).toEqual([{ parts: [{ type: 'text', text: 'hello' }] }])
  })

  it('projects explicit primary and backup targets into the SDK model field', async () => {
    const bodies: unknown[] = []
    const client = { session: {
      prompt: async ({ body }: { body: unknown }) => { bodies.push(body) },
    }}

    await sendOpenCodeMessage(client as never, 'ses_primary', 'use primary', { providerID: 'rcc-4444', modelID: 'gpt-5.5' })
    await sendOpenCodeMessage(client as never, 'ses_backup', 'use backup', { providerID: 'goaichat-openai', modelID: 'qwen3.8-max' })

    expect(bodies).toEqual([
      { parts: [{ type: 'text', text: 'use primary' }], model: { providerID: 'rcc-4444', modelID: 'gpt-5.5' } },
      { parts: [{ type: 'text', text: 'use backup' }], model: { providerID: 'goaichat-openai', modelID: 'qwen3.8-max' } },
    ])
  })

  it('rejects invalid explicit targets before invoking the SDK', async () => {
    let calls = 0
    const client = { session: {
      prompt: async () => { calls += 1 },
    }}

    await expect(sendOpenCodeMessage(client as never, 'ses_invalid', 'hello', { providerID: ' ', modelID: 'model' })).rejects.toMatchObject({ operation: 'session.prompt', code: 'INVALID_INPUT' })
    await expect(sendOpenCodeMessage(client as never, 'ses_invalid', 'hello', { providerID: 'provider', modelID: '' })).rejects.toMatchObject({ operation: 'session.prompt', code: 'INVALID_INPUT' })
    expect(calls).toBe(0)
  })

  it('rejects non-closed and non-plain explicit targets before invoking the SDK', async () => {
    let calls = 0
    const client = { session: {
      prompt: async () => { calls += 1 },
    }}
    const extraSymbol = Symbol('extra')
    let getterCalls = 0
    const accessorTarget = Object.defineProperty({ providerID: 'provider', modelID: 'model' }, 'modelID', {
      enumerable: true,
      get: () => { getterCalls += 1; return 'model' },
    })
    const nonEnumerableTarget = Object.defineProperty({ modelID: 'model' }, 'providerID', {
      value: 'provider',
      enumerable: false,
    })
    const ClassTarget = class {
      readonly providerID = 'provider'
      readonly modelID = 'model'
    }
    const invalidTargets: readonly unknown[] = [
      { providerID: 'provider', modelID: 'model', fallback: 'backup' },
      Object.assign({ providerID: 'provider', modelID: 'model' }, { [extraSymbol]: true }),
      ['provider', 'model'],
      new Date(),
      new ClassTarget(),
      accessorTarget,
      nonEnumerableTarget,
    ]

    for (const target of invalidTargets) {
      await expect(sendOpenCodeMessage(client as never, 'ses_invalid', 'hello', target as never)).rejects.toMatchObject({ operation: 'session.prompt', code: 'INVALID_INPUT' })
    }
    expect(calls).toBe(0)
    expect(getterCalls).toBe(0)
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
    await facade.actions.sendMessage('ses_7', { text: 'hello' })
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
    await expect(sendOpenCodeMessage(client as never, 'ses_upstream', 'hello', { providerID: 'provider', modelID: 'model' })).rejects.toMatchObject({ status: 503 })
    await expect(replyOpenCodePermission(client as never, 'per_missing', 'ses_upstream', 'reject')).rejects.toMatchObject({ status: 404 })
  })

  it('creates a Session from the real SDK envelope and never invents identity', async () => {
    const client = { session: { create: async (input?: { body?: { title?: string } }) => ({ data: { id: 'ses_new', title: input?.body?.title, directory: '/tmp/x', time: { created: 5 } } }) } }
    await expect(createOpenCodeSession(client as never, 'agent-a', 'Title')).resolves.toEqual({ kind: 'session.create', agentId: 'agent-a', sessionId: 'ses_new', title: 'Title', directory: '/tmp/x', time: { created: 5 } })
    await expect(createOpenCodeSession(client as never, 'agent-a')).resolves.toMatchObject({ sessionId: 'ses_new' })
    await expect(createOpenCodeSession({ session: { create: async () => ({ data: { title: 'no id' } }) } } as never, 'agent-a')).rejects.toMatchObject({ operation: 'session.create', code: 'INVALID_RESPONSE' })
    await expect(createOpenCodeSession(client as never, '')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('returns raw abort acceptance through the SDK', async () => {
    await expect(cancelOpenCodeSession({ session: { abort: async () => ({ data: true }) } } as never, 's')).resolves.toBe(true)
    await expect(cancelOpenCodeSession({ session: { abort: async () => ({ data: false }) } } as never, 's')).resolves.toBe(false)
    await expect(cancelOpenCodeSession({ session: { abort: async () => ({ data: undefined }) } } as never, 's')).resolves.toBeUndefined()
  })

  it('dispatches a prompt with the owner messageID and binds only a matching assistant response', async () => {
    const bodies: unknown[] = []
    const client = { session: { prompt: async ({ body }: { body: unknown }) => { bodies.push(body) } } }
    const requestId = 'msg_00000000000000000000000001'
    await expect(promptOpenCodeSession(client as never, 's', 'hello', { providerID: 'p', modelID: 'm' }, requestId)).resolves.toBeUndefined()
    expect(bodies).toEqual([{ messageID: requestId, parts: [{ type: 'text', text: 'hello' }], model: { providerID: 'p', modelID: 'm' } }])
    await expect(promptOpenCodeSession(client as never, 's', 'hello', { providerID: '', modelID: 'm' }, 'msg_00000000000000000000000002')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // The substrate rejects any prompt id that is not a `msg_`-prefixed Session.Message.ID,
    // so that shape is refused at this boundary instead of by the managed child.
    for (const invalid of [' ', '', 'req-1', '2a2dbca7-27e8-4947-a1ca-2ee86712b346', 'ses_00000000000000000000000001']) {
      await expect(promptOpenCodeSession(client as never, 's', 'hello', { providerID: 'p', modelID: 'm' }, invalid)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    const responding = (info: unknown) => ({ session: { prompt: async () => ({ data: { info, parts: [] } }) } })
    await expect(promptOpenCodeSession(responding({ id: 'a1', sessionID: 's', parentID: requestId }) as never, 's', 'hello', { providerID: 'p', modelID: 'm' }, requestId))
      .resolves.toEqual({ messageId: 'a1', sessionId: 's', parentId: requestId })
    // A response for another session, another request, or without identity never binds.
    for (const info of [{ id: 'a1', sessionID: 'other', parentID: requestId }, { id: 'a1', sessionID: 's', parentID: 'other' }, { sessionID: 's', parentID: requestId }, { id: 'a1', sessionID: 's' }, undefined]) {
      await expect(promptOpenCodeSession(responding(info) as never, 's', 'hello', { providerID: 'p', modelID: 'm' }, requestId)).resolves.toBeUndefined()
    }
  })

  it('allocates prompt message ids in the substrate Session.Message.ID shape', () => {
    const allocated = new Set<string>()
    for (let index = 0; index < 64; index += 1) {
      const messageId = createOpenCodePromptMessageId()
      expect(messageId.startsWith('msg_')).toBe(true)
      expect(messageId.length).toBeGreaterThan(4)
      allocated.add(messageId)
    }
    expect(allocated.size).toBe(64)
  })

  it('decodes only the closed text payload before any side effect', () => {
    expect(decodeOpenCodeSessionMessage({ text: 'hi' })).toEqual({ text: 'hi' })
    for (const invalid of [null, [], 'hi', { text: '' }, { text: 1 }, { text: 'hi', extra: true }, { config: {} }]) {
      expect(() => decodeOpenCodeSessionMessage(invalid as never)).toThrow()
    }
  })

  it('projects every SDK event variant into the closed Session event union', () => {
    const part = (p: Record<string, unknown>) => projectOpenCodeSessionEvent({ type: 'message.part.updated', properties: { part: { sessionID: 's', messageID: 'm', id: 'p', ...p } } })
    expect(projectOpenCodeSessionEvent({ type: 'message.updated', properties: { info: { id: 'm', sessionID: 's', role: 'assistant', parentID: 'req', time: { completed: 1 } } } }))
      .toMatchObject({ kind: 'event', parentMessageId: 'req', event: { kind: 'final', state: 'completed' } })
    expect(part({ type: 'text', text: 'hi' })).toMatchObject({ kind: 'event', event: { kind: 'part', partType: 'text' } })
    expect(part({ type: 'reasoning', text: 'why' })).toMatchObject({ kind: 'event', event: { kind: 'part', partType: 'reasoning' } })
    // The SDK types `time` as `{ start, end? }`: only a present `end` proves completion.
    expect(part({ type: 'text', text: 'hi', time: { start: 1 } })).toMatchObject({ kind: 'event', event: { kind: 'part', state: 'pending' } })
    expect(part({ type: 'text', text: 'hi', time: { start: 1, end: 2 } })).toMatchObject({ kind: 'event', event: { kind: 'part', state: 'completed' } })
    expect(part({ type: 'reasoning', text: 'why', time: { start: 1 } })).toMatchObject({ kind: 'event', event: { kind: 'part', state: 'pending' } })
    expect(part({ type: 'reasoning', text: 'why', time: { start: 1, end: 2 } })).toMatchObject({ kind: 'event', event: { kind: 'part', state: 'completed' } })
    expect(part({ type: 'file', filename: 'a' })).toMatchObject({ kind: 'event', event: { kind: 'part', state: 'observed', partType: 'file' } })
    expect(part({ type: 'tool', tool: 'bash', callID: 'c', state: { status: 'running', input: { command: 'ls' } } })).toMatchObject({ kind: 'event', event: { kind: 'tool', state: 'running' } })
    expect(projectOpenCodeSessionEvent({ type: 'permission.updated', properties: { id: 'p', sessionID: 's', messageID: 'm', title: 'T', metadata: {} } })).toMatchObject({ kind: 'event', event: { kind: 'permission', state: 'pending' } })
    expect(projectOpenCodeSessionEvent({ type: 'permission.replied', properties: { sessionID: 's', permissionID: 'p', response: 'later' } })).toMatchObject({ kind: 'event', event: { kind: 'permission', state: 'resolved', decision: 'unknown', rawResponse: 'later' } })
    expect(projectOpenCodeSessionEvent({ type: 'session.error', properties: { sessionID: 's', error: { name: 'UnknownError', data: {} } } })).toMatchObject({ kind: 'event', event: { kind: 'error', correlation: { kind: 'session' } } })
  })

  it('reads a real transcript through session.messages and reuses the closed event classifier', async () => {
    const calls: { id: string; query: unknown }[] = []
    const client = { session: {
      messages: async ({ path, query }: { path: { id: string }; query?: unknown }) => {
        calls.push({ id: path.id, query })
        return { data: [
          { info: { id: 'm-user', sessionID: 's', role: 'user' }, parts: [{ id: 'p-user', sessionID: 's', messageID: 'm-user', type: 'text', text: 'hello' }] },
          { info: { id: 'm-assistant', sessionID: 's', role: 'assistant', parentID: 'm-user', time: { completed: 1 } },
            parts: [{ id: 'p-tool', sessionID: 's', messageID: 'm-assistant', type: 'tool', tool: 'bash', callID: 'c', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } }] },
        ] }
      },
    } }
    const messages = await readOpenCodeSessionMessages(client as never, 's')
    expect(calls).toEqual([{ id: 's', query: undefined }])
    expect(projectOpenCodeSessionMessages(messages)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'event', event: expect.objectContaining({ kind: 'message', messageId: 'm-user', role: 'user' }) }),
      expect.objectContaining({ kind: 'event', event: expect.objectContaining({ kind: 'part', partId: 'p-user', text: 'hello' }) }),
      expect.objectContaining({ kind: 'event', parentMessageId: 'm-user', event: expect.objectContaining({ kind: 'final', messageId: 'm-assistant', state: 'completed' }) }),
      expect.objectContaining({ kind: 'event', event: expect.objectContaining({ kind: 'tool', partId: 'p-tool', state: 'completed', output: 'ok' }) }),
    ]))
  })

  it('reports malformed session.messages entries as invalid instead of dropping them', () => {
    expect(projectOpenCodeSessionMessages('nope')).toEqual([{ kind: 'invalid', reason: 'session.messages response is not an array', raw: 'nope' }])
    expect(projectOpenCodeSessionMessages([null])).toEqual([expect.objectContaining({ kind: 'invalid' })])
    expect(projectOpenCodeSessionMessages([{ info: { id: 'm', sessionID: 's', role: 'user' } }])).toEqual([
      expect.objectContaining({ kind: 'event' }),
      expect.objectContaining({ kind: 'invalid', reason: 'session.messages entry is missing parts' }),
    ])
  })

  it('fails unknown tags and invalid shapes explicitly instead of faking success', () => {
    expect(projectOpenCodeSessionEvent({ type: 'mystery.event', properties: {} })).toMatchObject({ kind: 'unsupported' })
    expect(projectOpenCodeSessionEvent({ type: 'message.part.updated', properties: { part: { sessionID: 's', messageID: 'm', id: 'p', type: 'bogus' } } })).toMatchObject({ kind: 'unsupported' })
    expect(projectOpenCodeSessionEvent({ type: 'message.part.updated', properties: { part: { type: 'text', text: 'x' } } })).toMatchObject({ kind: 'invalid' })
    expect(projectOpenCodeSessionEvent({ type: 'permission.replied', properties: { sessionID: 's', permissionID: 'p' } })).toMatchObject({ kind: 'invalid' })
    expect(projectOpenCodeSessionEvent({ type: 'session.error', properties: {} })).toMatchObject({ kind: 'invalid' })
    expect(projectOpenCodeSessionEvent({ properties: {} })).toMatchObject({ kind: 'invalid' })
    // The installed SDK declares a closed event tag set: a suffixed foreign tag is not a part event.
    expect(projectOpenCodeSessionEvent({ type: 'message.part.updated.foo',
      properties: { part: { sessionID: 's', messageID: 'm', id: 'p', type: 'text', text: 'x' } } })).toMatchObject({ kind: 'unsupported' })
    const toolPart = (state: Record<string, unknown>) => ({ type: 'message.part.updated',
      properties: { part: { sessionID: 's', messageID: 'm', id: 'p', type: 'tool', tool: 'bash', callID: 'c', state } } })
    // A tool part carrying a non-JSON value fails at this adapter boundary, not in the Console wire parser.
    expect(projectOpenCodeSessionEvent(toolPart({ status: 'completed', input: undefined }))).toMatchObject({ kind: 'invalid' })
    expect(projectOpenCodeSessionEvent(toolPart({ status: 'completed', input: () => undefined }))).toMatchObject({ kind: 'invalid' })
    expect(projectOpenCodeSessionEvent(toolPart({ status: 'running', input: {}, metadata: new Map() }))).toMatchObject({ kind: 'invalid' })
    expect(projectOpenCodeSessionEvent(toolPart({ status: 'completed', input: {}, attachments: 'not-an-array' }))).toMatchObject({ kind: 'invalid' })
    // A well-formed tool part still projects with its validated JSON payload.
    expect(projectOpenCodeSessionEvent(toolPart({ status: 'completed', input: { command: 'ls' }, metadata: { ok: true }, attachments: [{ kind: 'file' }] })))
      .toMatchObject({ kind: 'event', event: { kind: 'tool', state: 'completed', input: { command: 'ls' }, attachments: [{ kind: 'file' }] } })
  })

  it('classifies recognized non-outcome SDK events as intentionally ignored, never as projection loss', () => {
    // session.created/status/idle are members of the installed SDK Event union but carry no
    // projection outcome. They are deliberately ignored, not an unsupported/loss signal.
    for (const type of ['session.created', 'session.updated', 'session.status', 'session.idle', 'session.deleted', 'session.compacted']) {
      expect(projectOpenCodeSessionEvent({ type, properties: { sessionID: 's' } })).toMatchObject({ kind: 'ignored' })
    }
    // A genuinely unknown tag still fails explicitly.
    expect(projectOpenCodeSessionEvent({ type: 'not.a.real.event', properties: {} })).toMatchObject({ kind: 'unsupported' })
  })

  it('forwards the real SDK event stream and stops on abort', async () => {
    async function* stream() { yield { type: 'a', properties: {} }; yield { type: 'b', properties: {} } }
    const controller = new AbortController()
    const received: string[] = []
    for await (const event of subscribeOpenCodeEvents({ event: { subscribe: async () => ({ data: { stream: stream() } }) } } as never, controller.signal)) received.push(event.type)
    expect(received).toEqual(['a', 'b'])
    let closed = false
    async function* endless() { try { while (true) yield { type: 'x', properties: {} } } finally { closed = true } }
    const abortController = new AbortController()
    const iterator = subscribeOpenCodeEvents({ event: { subscribe: async () => ({ data: { stream: endless() } }) } } as never, abortController.signal)
    expect((await iterator.next()).value.type).toBe('x')
    abortController.abort()
    expect((await iterator.next()).done).toBe(true)
    expect(closed).toBe(true)
  })

  it('forwards the abort signal and never waits for an SDK stream that cannot close', async () => {
    const controller = new AbortController()
    let forwarded: unknown
    // The SDK generator is parked on a retry sleep: closing it cannot settle, so only the
    // forwarded signal can end the stream.
    async function* parked() { await new Promise(() => {}); yield { type: 'never', properties: {} } }
    const stream = subscribeOpenCodeEvents({ event: { subscribe: async (options: unknown) => { forwarded = options; return { data: { stream: parked() } } } } } as never, controller.signal)
    const pending = stream.next()
    controller.abort()
    expect(await pending).toMatchObject({ done: true })
    expect(forwarded).toEqual({ signal: controller.signal })
  })
})
