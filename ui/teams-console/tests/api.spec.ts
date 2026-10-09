import { describe, expect, it } from 'vitest'
import { createConsoleHttpClient, ConsoleTransportError } from '../src/client/api.ts'
import type { ConsoleProjectionV1 } from '../src/client/protocol.ts'

const projection: ConsoleProjectionV1 = {
  version: 1,
  agents: [],
  sessions: [],
  notifications: [],
  configs: [],
}

describe('Console HTTP v1 adapter', () => {
  it('reads the versioned projection endpoint', async () => {
    const requests: string[] = []
    const client = createConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      fetchImpl: async (input) => {
        requests.push(String(input))
        return new Response(JSON.stringify(projection), { status: 200 })
      },
    })

    await expect(client.readProjection()).resolves.toEqual(projection)
    expect(requests).toEqual(['http://localhost:7788/api/v1/projection'])
  })

  it('admits the public accepted binding through the real consumer parser', async () => {
    const observed = {
      ...projection,
      configs: [{
        agentId: 'planner', acceptedRevision: 2,
        acceptedBinding: { primary: { providerInstanceId: 'rcc', modelId: 'gpt-5.5' },
          backup: { providerInstanceId: 'backup', modelId: 'qwen3.8-max' } },
        providers: [],
      }],
    }
    const client = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify(observed), { status: 200 }) })
    await expect(client.readProjection()).resolves.toEqual(observed)
  })

  it('posts only a control command to the command endpoint', async () => {
    let body = ''
    let url = ''
    const client = createConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      fetchImpl: async (input, init) => {
        url = String(input)
        body = String(init?.body)
        return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), { status: 200 })
      },
    })

    await expect(client.command({ kind: 'session.open', agentId: 'planner', sessionId: 's1' })).resolves.toMatchObject({ ok: true })
    expect(url).toBe('http://localhost:7788/api/v1/command')
    expect(JSON.parse(body)).toEqual({ kind: 'session.open', agentId: 'planner', sessionId: 's1' })
  })

  it('sends Session business payload unchanged through the dedicated ingress', async () => {
    let url = ''
    let body = ''
    const client = createConsoleHttpClient({
      baseUrl: 'http://localhost:7788',
      fetchImpl: async (input, init) => {
        url = String(input)
        body = String(init?.body)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })
    const payload = { text: 'hello', nested: { value: 3 } } as const

    await expect(client.sendSession({ agentId: 'planner', sessionId: 's1' }, payload)).resolves.toMatchObject({ ok: true })
    expect(url).toBe('http://localhost:7788/api/v1/session-message?agentId=planner&sessionId=s1')
    expect(JSON.parse(body)).toEqual(payload)
    expect(JSON.parse(body)).not.toHaveProperty('agentId')
    expect(JSON.parse(body)).not.toHaveProperty('sessionId')
  })

  it('fails explicitly on transport, JSON, and result-shape errors', async () => {
    const statusClient = createConsoleHttpClient({ fetchImpl: async () => new Response('denied', { status: 403 }) })
    await expect(statusClient.readProjection()).rejects.toMatchObject({ name: 'ConsoleTransportError', status: 403 })

    const jsonClient = createConsoleHttpClient({ fetchImpl: async () => new Response('{bad', { status: 200 }) })
    await expect(jsonClient.readProjection()).rejects.toBeInstanceOf(ConsoleTransportError)

    const resultClient = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify({ ok: 'yes' }), { status: 200 }) })
    await expect(resultClient.command({ kind: 'config.apply', agentId: 'planner' })).rejects.toThrow(/invalid v1 command result/)

    const activityClient = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify({ ...projection, sessionEvents: {} }), { status: 200 }) })
    await expect(activityClient.readProjection()).rejects.toThrow(/invalid v1 projection/)

    const forkedClient = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify({ ...projection, uiSessionLedger: [] }), { status: 200 }) })
    await expect(forkedClient.readProjection()).rejects.toThrow(/invalid v1 projection/)
  })

  it('rejects a malformed Session success at the browser client boundary', async () => {
    const respond = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 })

    // `session.create` must return the closed SessionCreateResult shape, not a bare success.
    const createAbsent = createConsoleHttpClient({ fetchImpl: respond({ ok: true }) })
    await expect(createAbsent.command({ kind: 'session.create', agentId: 'planner' }))
      .rejects.toThrow(/invalid v1 command result/)

    const createMalformed = createConsoleHttpClient({ fetchImpl: respond({ ok: true, result: { kind: 'session.create', sessionId: 's' } }) })
    await expect(createMalformed.command({ kind: 'session.create', agentId: 'planner' }))
      .rejects.toThrow(/invalid v1 command result/)

    // `session.cancel` must return either a confirmed cancel or a typed unknown detail.
    const cancelBare = createConsoleHttpClient({ fetchImpl: respond({ ok: true, result: { kind: 'session.cancel', sessionId: 's' } }) })
    await expect(cancelBare.command({ kind: 'session.cancel', agentId: 'planner', sessionId: 's' }))
      .rejects.toThrow(/invalid v1 command result/)

    // A well-formed SessionCreateResult stays accepted on the same ingress.
    const createValid = createConsoleHttpClient({ fetchImpl: respond({ ok: true,
      result: { kind: 'session.create', agentId: 'planner', sessionId: 's' } }) })
    expect(await createValid.command({ kind: 'session.create', agentId: 'planner' })).toMatchObject({ ok: true })

    const cancelValid = createConsoleHttpClient({ fetchImpl: respond({ ok: true, result: { kind: 'session.cancel', sessionId: 's',
      operationId: 'op', promptMessageId: 'm', runtimeGeneration: 1, effectiveRevision: 4, baseAccepted: true,
      reconciliation: 'confirmed', finalState: 'cancelled', messageId: 'm', errorName: 'MessageAbortedError',
      abortOperationId: 'op2', causalEvidence: 'unique-owned-message' } }) })
    expect(await cancelValid.command({ kind: 'session.cancel', agentId: 'planner', sessionId: 's' })).toMatchObject({ ok: true })

    const sendValid = createConsoleHttpClient({ fetchImpl: respond({ ok: true }) })
    expect(await sendValid.sendSession({ agentId: 'planner', sessionId: 's' }, { text: 'probe' })).toMatchObject({ ok: true })
  })

  it('admits observe-only work and relation rows and still rejects unknown projection keys', async () => {
    const work = {
      agentId: 'provider', workId: 'offline-work', consumerAgentId: 'consumer', providerAgentId: 'provider',
      capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'closed' as const,
    }
    const observed: ConsoleProjectionV1 = {
      ...projection,
      works: [work],
      relations: [{
        agentId: 'provider', consumerAgentId: 'consumer', providerAgentId: 'provider',
        capabilityId: 'file-search', capabilityVersion: '1', relationPermission: 'granted', workId: 'offline-work',
      }],
    }
    const client = createConsoleHttpClient({
      fetchImpl: async () => new Response(JSON.stringify(observed), { status: 200 }),
    })
    await expect(client.readProjection()).resolves.toEqual(observed)

    const payloadClient = createConsoleHttpClient({
      fetchImpl: async () => new Response(JSON.stringify({
        ...observed,
        works: [{ ...work, payload: { query: 'secret' } }],
      }), { status: 200 }),
    })
    await expect(payloadClient.readProjection()).rejects.toThrow(/invalid v1 projection/)

    const metadataClient = createConsoleHttpClient({
      fetchImpl: async () => new Response(JSON.stringify({ ...observed, metadata: {} }), { status: 200 }),
    })
    await expect(metadataClient.readProjection()).rejects.toThrow(/invalid v1 projection/)
  })

  it('carries directory generation on Agent rows and rejects invalid generation values', async () => {
    const withGeneration = {
      ...projection,
      agents: [{ kind: 'directory', agentId: 'worker', label: 'Worker', machineId: 'Build', generation: 8, presence: 'offline', capabilities: ['file-search'] }],
    }
    const client = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify(withGeneration), { status: 200 }) })
    await expect(client.readProjection()).resolves.toEqual(withGeneration)

    for (const generation of [0, -1, 1.5, '8']) {
      const invalid = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify({
        ...projection,
        agents: [{ kind: 'directory', agentId: 'worker', label: 'Worker', machineId: 'Build', generation, presence: 'offline', capabilities: ['file-search'] }],
      }), { status: 200 }) })
      await expect(invalid.readProjection()).rejects.toThrow(/invalid v1 projection/)
    }
  })

  it('admits the declared capability detail and rejects an undeclared nested field', async () => {
    const detail = [{ capabilityId: 'file-search', version: '3', operations: ['search'],
      resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'context' }] }]
    const withDetail = {
      ...projection,
      agents: [{ kind: 'directory', agentId: 'worker', label: 'Worker', machineId: 'Build', presence: 'offline',
        capabilities: ['file-search'], capabilityDetails: detail }],
    }
    const client = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify(withDetail), { status: 200 }) })
    await expect(client.readProjection()).resolves.toEqual(withDetail)

    const illegal = createConsoleHttpClient({ fetchImpl: async () => new Response(JSON.stringify({
      ...withDetail,
      agents: [{ ...withDetail.agents[0], capabilityDetails: [{ ...detail[0], resources: [{ resourceId: 'r', capacity: 1, unit: 'slot', sharing: 'shared' }] }] }],
    }), { status: 200 }) })
    await expect(illegal.readProjection()).rejects.toThrow(/invalid v1 projection/)
  })

  it('supports host-specific versioned paths without changing the client contract', async () => {
    const requests: string[] = []
    const client = createConsoleHttpClient({
      baseUrl: 'https://host.invalid/console/',
      projectionPath: 'v1/state',
      commandPath: 'v1/control',
      sessionMessagePath: 'v1/data',
      fetchImpl: async input => {
        requests.push(String(input))
        return new Response(JSON.stringify(projection), { status: 200 })
      },
    })
    await client.readProjection()
    expect(requests[0]).toBe('https://host.invalid/console/v1/state')
  })

  it('reports network failures as transport errors', async () => {
    const client = createConsoleHttpClient({ fetchImpl: async () => { throw new Error('offline') } })
    await expect(client.readProjection()).rejects.toThrow('Host request failed: offline')
  })

  it('preserves a host-declared command failure instead of rewriting it', async () => {
    const client = createConsoleHttpClient({
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'not admitted' } }), { status: 200 }),
    })
    await expect(client.command({ kind: 'config.apply', agentId: 'planner' })).resolves.toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'not admitted' } })
  })
})
