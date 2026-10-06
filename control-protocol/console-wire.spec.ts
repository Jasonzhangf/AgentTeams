import { expect, it } from 'vitest'
import { parseConsoleWireReply, parseConsoleWireRequest } from './console-wire.ts'

it('keeps management control closed and Session business JSON separate', () => {
  const payload = [{ kind: 'console.command', metadata: { provider: 'business' } }]
  const frame = { kind: 'console.session', correlationId: 'r', targetGeneration: 1, agentId: 'a', sessionId: 's', payload }
  expect(parseConsoleWireRequest(JSON.stringify(frame))).toEqual(frame)
  expect(parseConsoleWireRequest(JSON.stringify({ kind: 'console.command', correlationId: 'r', targetGeneration: 1,
    command: { kind: 'config.apply', agentId: 'a' } }))).toMatchObject({ command: { kind: 'config.apply' } })
  for (const invalid of [
    { ...frame, targetGeneration: 0 }, { ...frame, control: {} },
    { kind: 'console.projection', correlationId: 'r', targetGeneration: 1, agentId: 'a', payload: {} },
    { kind: 'console.command', correlationId: 'r', targetGeneration: 1, command: { kind: 'config.apply', agentId: 'a', payload } },
  ]) expect(() => parseConsoleWireRequest(JSON.stringify(invalid))).toThrow()
})
it('validates replies and rejects undeclared or malformed projection fields', () => {
  const projection = { version: 1, agents: [{ kind: 'directory', agentId: 'a', machineId: 'm', label: 'A', presence: 'online', capabilities: ['browser'] }],
    sessions: [{ agentId: 'a', sessionId: 's' }], notifications: [], configs: [{ agentId: 'a', acceptedRevision: 0, providers: [] }] }
  const frame = { kind: 'console.projection.result', correlationId: 'r', projection }
  expect(parseConsoleWireReply(JSON.stringify(frame))).toEqual(frame)
  expect(parseConsoleWireReply(JSON.stringify({ ...frame, projection: { ...projection, agents: [{ ...projection.agents[0], generation: 3 }] } }))).toMatchObject({ projection: { agents: [{ generation: 3 }] } })
  const observed = { ...projection, works: [{ agentId: 'a', workId: 'w', consumerAgentId: 'c', providerAgentId: 'a',
    capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'closed' }],
    relations: [{ agentId: 'a', consumerAgentId: 'c', providerAgentId: 'a', capabilityId: 'file-search', capabilityVersion: '1',
      relationPermission: 'granted', workId: 'w' }] }
  expect(parseConsoleWireReply(JSON.stringify({ ...frame, projection: observed }))).toMatchObject({ projection: observed })
  const result = { kind: 'console.result', correlationId: 'r', result: { ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE', message: 'missing', providerInstanceId: 'p' } } }
  expect(parseConsoleWireReply(JSON.stringify(result))).toEqual(result)
  for (const invalid of [
    { ...frame, projection: { ...projection, agents: [{ ...projection.agents[0], credential: 'secret' }] } },
    { ...frame, projection: { ...observed, works: [{ ...observed.works[0], payload: { query: 'secret' } }] } },
    { ...frame, projection: { ...projection, configs: [{ agentId: 'a', acceptedRevision: -1, providers: [] }] } },
    { ...frame, projection: { ...projection, agents: [{ ...projection.agents[0], generation: 0 }] } },
    { ...result, result: { ok: 'yes' } },
    { ...result, result: { ok: false, error: { code: 'invented', message: 'bad' } } },
  ]) expect(() => parseConsoleWireReply(JSON.stringify(invalid))).toThrow()
})

it('closes the Agent observation union and keeps observation decoupled from readiness', () => {
  const base = { version: 1, sessions: [], notifications: [], configs: [] }
  const runtimeCurrent = { kind: 'runtime', agentId: 'a', machineId: 'm', label: 'A', presence: 'online', capabilities: [], sessionCapable: true, sessionAvailability: 'current', sessionEffectiveRevision: 3 }
  const passive = { kind: 'runtime', agentId: 'a', machineId: 'm', label: 'A', presence: 'online', capabilities: [], sessionCapable: false, sessionAvailability: 'not-applicable' }
  const directory = { kind: 'directory', agentId: 'a', machineId: 'm', label: 'A', presence: 'offline', capabilities: [] }
  const frame = (agents: unknown) => ({ kind: 'console.projection.result', correlationId: 'r', projection: { ...base, agents } })
  expect(parseConsoleWireReply(JSON.stringify(frame([runtimeCurrent])))).toMatchObject({ projection: { agents: [{ sessionAvailability: 'current' }] } })
  expect(parseConsoleWireReply(JSON.stringify(frame([{ ...runtimeCurrent, sessionObservation: { state: 'degraded', reason: 'projection-loss', detail: 'lost one event', droppedEvents: 2 } }]))))
    .toMatchObject({ projection: { agents: [{ sessionAvailability: 'current', sessionObservation: { state: 'degraded' } }] } })
  expect(parseConsoleWireReply(JSON.stringify(frame([{ ...runtimeCurrent, sessionObservation: { state: 'lost', reason: 'retry-exhausted', detail: 'stream ended' } }]))))
    .toMatchObject({ projection: { agents: [{ sessionObservation: { state: 'lost' } }] } })
  expect(parseConsoleWireReply(JSON.stringify(frame([passive])))).toMatchObject({ projection: { agents: [{ sessionCapable: false }] } })
  expect(parseConsoleWireReply(JSON.stringify(frame([directory])))).toMatchObject({ projection: { agents: [{ kind: 'directory' }] } })
  const { sessionEffectiveRevision: _revision, ...runtimeCurrentNoRevision } = runtimeCurrent
  for (const invalid of [
    [{ agentId: 'a', machineId: 'm', label: 'A', presence: 'online', capabilities: [] }],
    [{ ...directory, sessionCapable: false }],
    [{ ...directory, providerId: 'p' }],
    [runtimeCurrentNoRevision],
    [{ ...runtimeCurrent, sessionAvailability: 'not-applicable' }],
    [{ ...runtimeCurrent, sessionAvailability: 'bogus' }],
    [{ ...passive, sessionObservation: { state: 'live' } }],
    [{ ...passive, providerId: 'p' }],
    [{ ...runtimeCurrent, sessionObservation: { state: 'degraded', reason: 'projection-loss', droppedEvents: 1 } }],
    [{ ...runtimeCurrent, sessionObservation: { state: 'degraded', reason: 'unknown', detail: 'x', droppedEvents: 1 } }],
    [{ ...runtimeCurrent, sessionObservation: { state: 'lost', reason: 'stream-ended' } }],
    [{ ...runtimeCurrent, sessionObservation: { state: 'bogus' } }],
  ]) expect(() => parseConsoleWireReply(JSON.stringify(frame(invalid)))).toThrow()
})

it('closes create results and preserves cancel baseAccepted three-state', () => {
  const createFrame = (result: unknown) => ({ kind: 'console.result', correlationId: 'r', result })
  expect(parseConsoleWireReply(JSON.stringify(createFrame({ ok: true, result: { kind: 'session.create', agentId: 'a', sessionId: 's', title: 'T', directory: '/tmp', time: { created: 1 } } }))))
    .toMatchObject({ result: { ok: true, result: { kind: 'session.create', sessionId: 's' } } })
  expect(parseConsoleWireReply(JSON.stringify(createFrame({ ok: true, result: { kind: 'session.create', agentId: 'a', sessionId: 's' } }))))
    .toMatchObject({ result: { ok: true } })
  for (const invalid of [
    { ok: true, result: { kind: 'session.create', agentId: 'a', sessionId: 's', model: 'm' } },
    { ok: true, result: { kind: 'session.create', agentId: 'a' } },
  ]) expect(() => parseConsoleWireReply(JSON.stringify(createFrame(invalid)))).toThrow()
  const cancelConfirmed = (extra: Record<string, unknown> = {}) => ({ ok: true, result: {
    kind: 'session.cancel', sessionId: 's', operationId: 'o', promptMessageId: 'm', runtimeGeneration: 1, effectiveRevision: 2,
    baseAccepted: true, reconciliation: 'confirmed', finalState: 'cancelled', messageId: 'm', errorName: 'MessageAbortedError',
    abortOperationId: 'ab', causalEvidence: 'unique-owned-message', ...extra } })
  expect(parseConsoleWireReply(JSON.stringify(createFrame(cancelConfirmed()))))
    .toMatchObject({ result: { ok: true, result: { kind: 'session.cancel', finalState: 'cancelled' } } })
  for (const invalid of [
    cancelConfirmed({ errorName: 'UnknownError' }),
    cancelConfirmed({ causalEvidence: 'guessed-owner' }),
    cancelConfirmed({ reconciliation: 'unknown' }),
    cancelConfirmed({ baseAccepted: false }),
    cancelConfirmed({ extra: true }),
    { ok: true, result: { kind: 'session.cancel', sessionId: 's' } },
  ]) expect(() => parseConsoleWireReply(JSON.stringify(createFrame(invalid)))).toThrow()
  const cancelDetail = (baseAccepted?: boolean) => ({ ok: false, error: { code: 'RESULT_UNKNOWN', message: 'cancel unknown', detail: {
    kind: 'session.cancel', sessionId: 's', operationId: 'o', promptMessageId: 'm', runtimeGeneration: 1, effectiveRevision: 2,
    ...(baseAccepted === undefined ? {} : { baseAccepted }), reconciliation: 'unknown', finalState: 'unknown', reason: 'no-final', abortOperationId: 'ab' } } })
  expect(parseConsoleWireReply(JSON.stringify(createFrame(cancelDetail(true))))).toMatchObject({ result: { error: { detail: { baseAccepted: true } } } })
  expect(parseConsoleWireReply(JSON.stringify(createFrame(cancelDetail(false))))).toMatchObject({ result: { error: { detail: { baseAccepted: false } } } })
  expect(parseConsoleWireReply(JSON.stringify(createFrame(cancelDetail(undefined))))).toMatchObject({ result: { error: { detail: { sessionId: 's' } } } })
  for (const invalid of [
    { ok: false, error: { code: 'RESULT_UNKNOWN', message: 'x', detail: { ...cancelDetail(true).error.detail, reconciliation: 'confirmed' } } },
    { ok: false, error: { code: 'RESULT_UNKNOWN', message: 'x', detail: { ...cancelDetail(true).error.detail, reason: 'bogus' } } },
  ]) expect(() => parseConsoleWireReply(JSON.stringify(createFrame(invalid)))).toThrow()
})
