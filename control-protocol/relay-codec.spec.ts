import { describe, expect, it } from 'vitest'
import type { AgentDeclaration, RelayServerControl } from './agent-services.ts'
import { parseRelayAdmission } from './relay-admission.ts'
import { parseAgentDeclaration, parseRelayServerControl } from './relay-codec.ts'

const schema = JSON.parse('{"__proto__":{"type":"string"},"targetGeneration":7,"business":{"array":[1,null,true]}}') as AgentDeclaration['capabilities'][number]['operations'][number]['inputSchema']

const declaration: AgentDeclaration = {
  identity: {
    hostId: 'host-a',
    machineId: 'machine-a',
    agentId: 'agent-a',
    accountId: 'account-a',
    agentKind: 'custom',
    label: 'Agent A',
  },
  scopeId: 'scope-a',
  revision: 3,
  capabilities: [{
    capabilityId: 'capability-a',
    version: '1',
    operations: [{ operation: 'operation-a', inputSchema: schema, outputSchema: {}, cancellation: 'unsupported' }],
    resources: [{ resourceId: 'resource-a', capacity: 2, unit: 'slot', sharing: 'shared', allocationScope: 'request' }],
  }],
  routes: [{ candidateId: 'route-a', kind: 'relay-ws', endpoint: 'wss://relay.example', port: 443, authRequired: true, lastSeenAt: '2026-09-06T05:00:00.000Z' }],
}

const peer = {
  declaration,
  connectionId: 'connection-a',
  generation: 4,
  lastSeenAt: '2026-09-06T05:00:00.000Z',
  presence: 'online' as const,
}

const grant = {
  grantId: 'grant-a',
  accountId: 'account-a',
  scopeId: 'scope-a',
  sourceAgentId: 'agent-a',
  targetAgentId: 'agent-b',
  sourceGeneration: 4,
  targetGeneration: 8,
  expiresAt: '2026-09-06T06:00:00.000Z',
}

const serverFrames: readonly RelayServerControl[] = [
  { kind: 'relay.admitted', connectionId: 'connection-a', generation: 4 },
  { kind: 'relay.directory', requestId: 'directory-a', revision: 5, peers: [peer] },
  { kind: 'relay.changed', revision: 6, peer },
  { kind: 'relay.grant', requestId: 'connect-a', grant },
  { kind: 'relay.offer', grant },
  { kind: 'relay.opened', requestId: 'open-a', grantId: 'grant-a' },
  { kind: 'relay.closed', grantId: 'grant-a', error: { code: 'UNAVAILABLE', message: 'closed' } },
  { kind: 'relay.error', requestId: 'request-a', error: { code: 'FORBIDDEN', message: 'denied' } },
]

describe('relay protocol codec', () => {
  it('preserves valid nested business schemas and control-like property names', () => {
    const parsed = parseAgentDeclaration(declaration)
    expect(parsed).toEqual(declaration)
    expect(Object.keys(parsed.capabilities[0]?.operations[0]?.inputSchema ?? {})).toContain('__proto__')
    expect(Object.prototype.hasOwnProperty.call(parsed.capabilities[0]?.operations[0]?.inputSchema, '__proto__')).toBe(true)
  })

  it('rejects unknown declaration fields and unsafe numeric values', () => {
    expect(() => parseAgentDeclaration({ ...declaration, extra: true })).toThrow(/extra/)
    expect(() => parseAgentDeclaration({
      ...declaration,
      capabilities: [{ ...declaration.capabilities[0], operations: [{ ...declaration.capabilities[0]!.operations[0], extra: true }] }],
    })).toThrow(/extra/)
    expect(() => parseAgentDeclaration({ ...declaration, revision: 0 })).toThrow(/revision/)
    expect(() => parseAgentDeclaration({ ...declaration, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/revision/)
  })

  it('parses every relay server control shape', () => {
    for (const frame of serverFrames) expect(parseRelayServerControl(JSON.stringify(frame))).toEqual(frame)
  })

  it('rejects unknown envelope fields and invalid peer or grant values', () => {
    expect(() => parseRelayServerControl(JSON.stringify({ kind: 'relay.admitted', connectionId: 'connection-a', generation: 1, extra: true }))).toThrow(/extra/)
    expect(() => parseRelayServerControl(JSON.stringify({ kind: 'relay.directory', requestId: 'directory-a', revision: 1, peers: [{ ...peer, lastSeenAt: 'not-a-date' }] }))).toThrow(/lastSeenAt/)
    expect(() => parseRelayServerControl(JSON.stringify({ kind: 'relay.grant', requestId: 'connect-a', grant: { ...grant, targetGeneration: 1e100 } }))).toThrow(/targetGeneration/)
    expect(() => parseRelayServerControl(JSON.stringify({ kind: 'relay.closed', grantId: 'grant-a', error: { code: 'FORBIDDEN', message: 'denied', extra: true } }))).toThrow(/extra/)
  })

  it('accepts only admitted or error frames as relay admission', () => {
    expect(parseRelayAdmission(JSON.stringify(serverFrames[0]))).toMatchObject({ kind: 'relay.admitted' })
    expect(parseRelayAdmission(JSON.stringify(serverFrames[7]))).toMatchObject({ kind: 'relay.error' })
    expect(() => parseRelayAdmission(JSON.stringify(serverFrames[1]))).toThrow(/invalid admission response/)
  })
})
