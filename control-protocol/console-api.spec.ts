import { describe, expect, it } from 'vitest'
import {
  parseConsoleAgentObservation,
  parseConsoleCommand,
  parseConsoleSessionEvent,
  parseConsoleWorkRelationProjection,
  parseSessionCancelUnknownDetail,
  parseSessionCreateResult,
  projectCapabilityDetails,
} from './console-api.ts'

describe('Console control ingress', () => {
  it('admits each frozen command without changing it', () => {
    const commands = [
      { kind: 'session.open', agentId: 'a', sessionId: 's' },
      { kind: 'session.create', agentId: 'a' },
      { kind: 'session.create', agentId: 'a', title: 'New session' },
      { kind: 'session.cancel', agentId: 'a', sessionId: 's' },
      { kind: 'permission.reply', agentId: 'a', sessionId: 's', permissionId: 'p', decision: 'reject' },
      { kind: 'notification.ack', agentId: 'a', notificationId: 'n' },
      { kind: 'config.refreshModels', agentId: 'a', expectedRevision: 0, providerId: 'p' },
      { kind: 'config.bindModel', agentId: 'a', expectedRevision: 1, providerId: 'p', modelId: 'm' },
      { kind: 'config.model.put', agentId: 'a', expectedRevision: 2, entry: {
        ref: { providerInstanceId: 'p', modelId: 'manual' }, origin: 'manual', base: { label: 'Manual', contextWindow: 4096 }, overrides: {},
      } },
      { kind: 'config.apply', agentId: 'a' },
      { kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: 4, backup: { providerInstanceId: 'b', modelId: 'm' } },
      { kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: {
        id: 'p', label: 'P', protocol: 'openai-responses', apiBaseUrl: 'https://example.test/v1', enabled: true,
        auth: { kind: 'bearer', credentialRef: 'provider/p' },
      } },
    ]
    for (const command of commands) expect(parseConsoleCommand(command)).toEqual(command)
  })

  it('rejects unknown commands, fields and invalid identities or revisions', () => {
    for (const command of [
      null, [], { kind: 'session.delete', agentId: 'a' },
      { kind: 'session.open', agentId: 'a', sessionId: '' },
      { kind: 'session.create', agentId: 'a', model: 'm' },
      { kind: 'session.create', agentId: 'a', providerId: 'p', modelId: 'm' },
      { kind: 'session.create', agentId: 'a', config: {} },
      { kind: 'session.create', agentId: 'a', title: '' },
      { kind: 'session.cancel', agentId: 'a', sessionId: '' },
      { kind: 'session.cancel', agentId: 'a', sessionId: 's', model: 'm' },
      { kind: 'session.open', agentId: 'a', sessionId: 's', model: 'm' },
      { kind: 'config.apply', agentId: 'a', payload: { text: 'business' } },
      { kind: 'config.apply', agentId: 'a', metadata: {} },
      { kind: 'config.bindModel', agentId: 'a', expectedRevision: -1, providerId: 'p', modelId: 'm' },
      { kind: 'config.refreshModels', agentId: 'a', expectedRevision: 0.5, providerId: 'p' },
      { kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: -1, backup: { providerInstanceId: 'b', modelId: 'm' } },
      { kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: 1, backup: { providerInstanceId: 'b', modelId: 'm', credentialRef: 'secret' } },
      { kind: 'config.agent.select-backup', agentId: 'a', expectedRevision: 1, backup: { providerInstanceId: 'b' } },
      { kind: 'config.agent.selectBackup', agentId: 'a', expectedRevision: 1, backup: { providerInstanceId: 'b', modelId: 'm' } },
      { kind: 'permission.reply', agentId: 'a', sessionId: 's', permissionId: 'p', decision: 'yes' },
      { kind: 'config.model.put', agentId: 'a', expectedRevision: 0, entry: { ref: { providerInstanceId: 'p', modelId: 'm' }, origin: 'discovered', base: {}, overrides: {} } },
      { kind: 'config.model.put', agentId: 'a', expectedRevision: 0, entry: { ref: { providerInstanceId: 'p', modelId: 'm' }, origin: 'manual', base: { contextWindow: 0 }, overrides: {} } },
      { kind: 'config.model.put', agentId: 'a', expectedRevision: 0, entry: { ref: { providerInstanceId: 'p', modelId: 'm' }, origin: 'manual', base: {}, overrides: {}, extra: true } },
    ]) expect(() => parseConsoleCommand(command)).toThrow()
  })

  it('rejects inline credentials and surplus nested provider fields', () => {
    const provider = { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'https://example.test/v1', enabled: true }
    for (const auth of [{ kind: 'none', token: 'secret' }, { kind: 'bearer', apiKey: 'secret' }, { kind: 'bearer', credentialRef: '' }]) {
      expect(() => parseConsoleCommand({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: { ...provider, auth } })).toThrow()
    }
    expect(() => parseConsoleCommand({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: { ...provider, auth: { kind: 'none' }, payload: {} } })).toThrow()
  })

  it('admits observe-only work and relation rows and rejects request payloads', () => {
    const works = [{ agentId: 'a', workId: 'w', consumerAgentId: 'c', providerAgentId: 'a', capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'closed' }]
    const relations = [{ agentId: 'a', consumerAgentId: 'c', providerAgentId: 'a', capabilityId: 'file-search', capabilityVersion: '1', relationPermission: 'granted', workId: 'w' }]
    expect(parseConsoleWorkRelationProjection({ works, relations })).toEqual({ works, relations })
    expect(() => parseConsoleWorkRelationProjection({ works: [{ ...works[0], payload: { query: 'secret' } }], relations })).toThrow()
    expect(() => parseConsoleWorkRelationProjection({ works, relations: [{ ...relations[0], metadata: {} }] })).toThrow()
    expect(() => parseConsoleWorkRelationProjection({ agents: [], sessions: [], notifications: [], configs: [] })).toThrow()
  })

  it('closes the Agent observation union and rejects false or directory session fields', () => {
    const runtime = { kind: 'runtime', agentId: 'a', label: 'A', machineId: 'm', presence: 'online', capabilities: [], sessionCapable: true, sessionAvailability: 'current', sessionEffectiveRevision: 3 }
    expect(parseConsoleAgentObservation(runtime)).toEqual(runtime)
    expect(parseConsoleAgentObservation({ ...runtime, sessionObservation: { state: 'degraded', reason: 'projection-loss', detail: 'x', droppedEvents: 1 } })).toMatchObject({ sessionAvailability: 'current' })
    expect(parseConsoleAgentObservation({ kind: 'directory', agentId: 'a', label: 'A', machineId: 'm', presence: 'offline', capabilities: [] })).toMatchObject({ kind: 'directory' })
    expect(parseConsoleAgentObservation({ kind: 'runtime', agentId: 'a', label: 'A', machineId: 'm', presence: 'online', capabilities: [], sessionCapable: false, sessionAvailability: 'not-applicable' })).toMatchObject({ sessionCapable: false })
    const { sessionEffectiveRevision: _drop, ...noRevision } = runtime
    for (const invalid of [
      { agentId: 'a', label: 'A', machineId: 'm', presence: 'online', capabilities: [] },
      { kind: 'directory', agentId: 'a', label: 'A', machineId: 'm', presence: 'offline', capabilities: [], sessionCapable: false },
      { kind: 'directory', agentId: 'a', label: 'A', machineId: 'm', presence: 'offline', capabilities: [], modelId: 'x' },
      noRevision,
      { ...runtime, sessionAvailability: 'not-applicable' },
      { ...runtime, sessionAvailability: 'bogus' },
      { ...runtime, sessionObservation: { state: 'degraded', reason: 'projection-loss', droppedEvents: 1 } },
      { ...runtime, sessionObservation: { state: 'lost', reason: 'retry-exhausted' } },
      { ...runtime, sessionObservation: { state: 'bogus' } },
      { kind: 'runtime', agentId: 'a', label: 'A', machineId: 'm', presence: 'online', capabilities: [], sessionCapable: false, sessionAvailability: 'not-applicable', providerId: 'p' },
    ]) expect(() => parseConsoleAgentObservation(invalid)).toThrow()
  })

  it('closes the Session event union and preserves the three-state cancel detail', () => {
    const events = [
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'message', state: 'completed', messageId: 'm', role: 'assistant' },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'part', state: 'observed', messageId: 'm', partId: 'p', partType: 'subtask', sourcePart: { id: 'p', prompt: 'x' } },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'tool', state: 'running', messageId: 'm', partId: 'p', callId: 'c', tool: 'bash', input: { command: 'ls' } },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'permission', state: 'resolved', permissionId: 'p', decision: 'unknown', rawResponse: 'later' },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'final', state: 'completed', messageId: 'm' },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'error', state: 'failed', error: { name: 'UnknownError', data: {} }, correlation: { kind: 'session', sessionId: 's' } },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'cancel', state: 'unknown', sessionId: 's', reason: 'no-final', baseAccepted: true },
    ]
    for (const event of events) expect(parseConsoleSessionEvent(event)).toEqual(event)
    for (const invalid of [
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'message', state: 'succeeded', messageId: 'm', role: 'assistant' },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'part', state: 'observed', messageId: 'm', partId: 'p', partType: 'text', sourcePart: {} },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'tool', state: 'running', messageId: 'm', partId: 'p', callId: 'c', tool: 'bash' },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'permission', state: 'resolved', permissionId: 'p', decision: 'maybe' },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'final', state: 'completed' },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'error', state: 'failed', error: { name: 'Bogus', data: {} }, correlation: { kind: 'session', sessionId: 's' } },
      { eventId: 'e', agentId: 'a', sessionId: 's', kind: 'cancel', state: 'reconciled', sessionId: 's', reason: 'no-final' },
    ]) expect(() => parseConsoleSessionEvent(invalid)).toThrow()
    expect(parseSessionCreateResult({ kind: 'session.create', agentId: 'a', sessionId: 's' })).toMatchObject({ sessionId: 's' })
    expect(() => parseSessionCreateResult({ kind: 'session.create', agentId: 'a', sessionId: 's', model: 'm' })).toThrow()
    const detail = (baseAccepted?: boolean) => ({ kind: 'session.cancel', sessionId: 's', ...(baseAccepted === undefined ? {} : { baseAccepted }), reconciliation: 'unknown', finalState: 'unknown', reason: 'no-final' })
    expect(parseSessionCancelUnknownDetail(detail(true))).toMatchObject({ baseAccepted: true })
    expect(parseSessionCancelUnknownDetail(detail(false))).toMatchObject({ baseAccepted: false })
    expect(parseSessionCancelUnknownDetail(detail(undefined))).toMatchObject({ sessionId: 's' })
    expect(() => parseSessionCancelUnknownDetail({ ...detail(true), reconciliation: 'confirmed' })).toThrow()
  })

  it('accepts the declared capability detail summary and rejects illegal nested shapes', () => {
    const detail = [{ capabilityId: 'file-search', version: '3', operations: ['search'],
      resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'context' }] }]
    const runtime = { kind: 'runtime', agentId: 'a', label: 'A', machineId: 'm', presence: 'online', capabilities: ['file-search'],
      capabilityDetails: detail, sessionCapable: true, sessionAvailability: 'current', sessionEffectiveRevision: 3 }
    expect(parseConsoleAgentObservation(runtime)).toEqual(runtime)
    expect(parseConsoleAgentObservation({ kind: 'directory', agentId: 'a', label: 'A', machineId: 'm', presence: 'offline',
      capabilities: ['file-search'], capabilityDetails: detail })).toMatchObject({ kind: 'directory', capabilityDetails: detail })
    // An explicit empty declaration stays empty; it is not the same as an absent field.
    expect(parseConsoleAgentObservation({ kind: 'runtime', agentId: 'a', label: 'A', machineId: 'm', presence: 'online',
      capabilities: [], capabilityDetails: [], sessionCapable: false, sessionAvailability: 'not-applicable' }))
      .toMatchObject({ capabilityDetails: [] })
    for (const invalid of [
      { ...runtime, capabilityDetails: [{ ...detail[0], capacity: 1 }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], resources: [{ resourceId: 'r', capacity: 0, unit: 'slot' }] }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], resources: [{ resourceId: 'r', capacity: 1.5, unit: 'slot' }] }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], resources: [{ resourceId: 'r', capacity: 1, unit: 'core' }] }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], resources: [{ resourceId: 'r', capacity: 1 }] }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], resources: [{ resourceId: 'r', capacity: 1, unit: 'slot', sharing: 'exclusive' }] }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], resources: [{ resourceId: 'r', capacity: 1, unit: 'slot', allocationScope: 'work' }] }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], operations: ['search', ''] }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], version: '' }] },
      { ...runtime, capabilityDetails: [{ ...detail[0], allocationScope: 'work' }] },
      { ...runtime, capabilityDetails: 'none' },
    ]) expect(() => parseConsoleAgentObservation(invalid)).toThrow()
  })

  it('projects a published declaration into the canonical detail summary', () => {
    const declaration = [{ capabilityId: 'file-search', version: '3',
      operations: [{ operation: 'search', inputSchema: { type: 'object' }, outputSchema: {}, cancellation: 'unsupported' as const }],
      resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'context' as const, sharing: 'exclusive' as const, allocationScope: 'request' as const }] }]
    expect(projectCapabilityDetails(declaration)).toEqual([{ capabilityId: 'file-search', version: '3', operations: ['search'],
      resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'context' }] }])
    expect(projectCapabilityDetails([])).toEqual([])
  })
})
