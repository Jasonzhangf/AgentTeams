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
  const projection = { version: 1, agents: [{ agentId: 'a', machineId: 'm', label: 'A', presence: 'online', capabilities: ['browser'] }],
    sessions: [{ agentId: 'a', sessionId: 's' }], notifications: [], configs: [{ agentId: 'a', acceptedRevision: 0, providers: [] }] }
  const frame = { kind: 'console.projection.result', correlationId: 'r', projection }
  expect(parseConsoleWireReply(JSON.stringify(frame))).toEqual(frame)
  const result = { kind: 'console.result', correlationId: 'r', result: { ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE', message: 'missing', providerInstanceId: 'p' } } }
  expect(parseConsoleWireReply(JSON.stringify(result))).toEqual(result)
  for (const invalid of [
    { ...frame, projection: { ...projection, agents: [{ ...projection.agents[0], credential: 'secret' }] } },
    { ...frame, projection: { ...projection, configs: [{ agentId: 'a', acceptedRevision: -1, providers: [] }] } },
    { ...result, result: { ok: 'yes' } },
    { ...result, result: { ok: false, error: { code: 'invented', message: 'bad' } } },
  ]) expect(() => parseConsoleWireReply(JSON.stringify(invalid))).toThrow()
})
