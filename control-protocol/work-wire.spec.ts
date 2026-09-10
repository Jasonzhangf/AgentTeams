import { expect, it } from 'vitest'
import { parseWorkWireFrame } from './work-wire.ts'

it('preserves arbitrary business JSON while rejecting misplaced control', () => {
  const value = { kind: 'work.request', correlationId: 'c', control: { workId: 'w', requestId: 'r',
    operation: 'search', targetGeneration: 1, demands: [] }, payload: [{ metadata: { generation: 'text' }, route: null }] }
  expect(parseWorkWireFrame(JSON.stringify(value))).toEqual(value)
  expect(() => parseWorkWireFrame(JSON.stringify({ ...value, providerId: 'guess' }))).toThrow()
  expect(() => parseWorkWireFrame(JSON.stringify({ ...value, control: { ...value.control, payload: 'bad' } }))).toThrow()
  expect(() => parseWorkWireFrame(JSON.stringify({ ...value, control: { ...value.control, targetGeneration: 1e100 } }))).toThrow()
})

it('validates Work state, result, proposal, query and error envelopes', () => {
  const work = { workId: 'w', consumerAgentId: 'a', providerAgentId: 'b', capabilityId: 'search', capabilityVersion: '1', policyRevision: 1 }
  const frames = [
    { kind: 'work.propose', correlationId: 'c', proposal: work },
    { kind: 'work.state', correlationId: 'c', work: { ...work, state: 'accepted' } },
    { kind: 'work.get', correlationId: 'c', workId: 'w', requestId: 'r' },
    { kind: 'work.close', correlationId: 'c', workId: 'w' },
    { kind: 'work.result', correlationId: 'c', control: { workId: 'w', requestId: 'r', state: 'succeeded' }, payload: null },
    { kind: 'work.error', correlationId: 'c', error: { code: 'FORBIDDEN', message: 'denied' } },
  ]
  for (const frame of frames) expect(parseWorkWireFrame(JSON.stringify(frame))).toEqual(frame)
  expect(() => parseWorkWireFrame(JSON.stringify({ ...frames[5], error: { code: 'invented', message: 'denied' } }))).toThrow()
})

it('carries Endpoint admission as typed Work control and rejects extra fields', () => {
  const proposal = { workId: 'w', consumerAgentId: 'a', providerAgentId: 'b', capabilityId: 'search', capabilityVersion: '1', policyRevision: 1,
    endpoint: { workId: 'w', providerAgentId: 'b', endpointId: 'search-endpoint', revision: 2, capabilityId: 'search', capabilityVersion: '1', operation: 'search' } }
  expect(parseWorkWireFrame(JSON.stringify({ kind: 'work.propose', correlationId: 'c', proposal }))).toMatchObject({ proposal })
  expect(() => parseWorkWireFrame(JSON.stringify({ kind: 'work.propose', correlationId: 'c', proposal: { ...proposal,
    endpoint: { ...proposal.endpoint, metadata: 'payload' } } }))).toThrow()
})

it('keeps CLI error details in typed control and rejects malformed or additional error fields', () => {
  const execution = { kind: 'cli', code: 'PROCESS_ERROR', message: 'external command failed',
    exitCode: null, signal: 'SIGTERM', stdout: '', stderr: 'detail\n' }
  const frame = { kind: 'work.result', correlationId: 'c', control: { workId: 'w', requestId: 'r', state: 'unknown',
    error: { code: 'RESULT_UNKNOWN', message: 'unconfirmed', execution } } }
  expect(parseWorkWireFrame(JSON.stringify(frame))).toEqual(frame)
  for (const invalid of [{ ...execution, exitCode: -1 }, { ...execution, exitCode: 1.5 },
    { ...execution, stderr: [] }, { ...execution, retry: true }, { ...execution, kind: 'inferred' }]) {
    expect(() => parseWorkWireFrame(JSON.stringify({ ...frame, control: { ...frame.control,
      error: { ...frame.control.error, execution: invalid } } }))).toThrow()
  }
})
