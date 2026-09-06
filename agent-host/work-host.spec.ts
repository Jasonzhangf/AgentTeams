import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createFileWorkStore, createWorkLedger, type RequestCompletion } from '../agent/work-resource.ts'
import { createWorkHost, type WorkExecutor } from './work-host.ts'
import type { WorkRequest } from '../control-protocol/agent-services.ts'

const consumer = { accountId: 'account', scopeId: 'scope', agentId: 'consumer' }
const provider = { ...consumer, agentId: 'provider' }
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function setup(executor: WorkExecutor) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-work-host-'))
  directories.push(directory)
  const ledger = createWorkLedger({ provider, generation: 1, store: createFileWorkStore(join(directory, 'work.json')),
    capabilities: [{ capabilityId: 'browser', version: '1',
      operations: [{ operation: 'open', inputSchema: {}, outputSchema: {}, cancellation: 'unsupported' }],
      resources: [{ resourceId: 'context', capacity: 1, unit: 'context', sharing: 'shared', allocationScope: 'work' },
        { resourceId: 'slot', capacity: 1, unit: 'slot', sharing: 'shared', allocationScope: 'request' }] }] })
  const host = createWorkHost({ ledger, policy: () => ({ revision: 1, authorizeWork: () => true }), executor })
  host.propose(consumer, { workId: 'w', consumerAgentId: consumer.agentId, providerAgentId: provider.agentId,
    capabilityId: 'browser', capabilityVersion: '1', policyRevision: 1 })
  return { ledger, host }
}
const request = (id = 'r'): WorkRequest => ({ control: { workId: 'w', requestId: id, operation: 'open', targetGeneration: 1,
  demands: [{ resourceId: 'context', amount: 1 }, { resourceId: 'slot', amount: 1 }] },
  payload: { metadata: { generation: 'business' }, list: [1, null] } })

it('executes once, persists real completion and holds the context until destruction confirms', async () => {
  let finish!: (result: RequestCompletion) => void
  let destroyed!: () => void
  let calls = 0
  const { ledger, host } = setup({ execute: async (_work, input) => {
    calls++
    expect(input.payload).toEqual(request().payload)
    return new Promise(resolve => { finish = resolve })
  }, destroy: async () => new Promise(resolve => { destroyed = () => resolve({ destroyed: true }) }) })
  const executing = host.request(consumer, request())
  expect((await host.request(consumer, request())).state).toBe('running')
  expect(calls).toBe(1)
  expect(ledger.snapshot.allocations.every(item => item.state === 'held')).toBe(true)
  finish({ outcome: 'succeeded', payload: ['preserved', { route: 'business' }] })
  expect((await executing).response).toEqual(['preserved', { route: 'business' }])
  expect(ledger.snapshot.allocations.find(item => item.resourceId === 'slot')?.state).toBe('released')
  const closing = host.close(consumer, 'w')
  await Promise.resolve()
  expect(ledger.snapshot.allocations.find(item => item.resourceId === 'context')?.state).toBe('held')
  destroyed()
  expect((await closing).state).toBe('closed')
  expect(ledger.snapshot.allocations.every(item => item.state === 'released')).toBe(true)
})

it('retains unknown execution allocations when an executor throws', async () => {
  let destroys = 0
  const { ledger, host } = setup({ execute: async () => { throw new Error('executor connection lost') },
    destroy: async () => { destroys++; return { destroyed: true } } })
  expect((await host.request(consumer, request())).state).toBe('unknown')
  expect(ledger.snapshot.allocations.every(item => item.state === 'unknown')).toBe(true)
  await expect(host.close(consumer, 'w')).rejects.toThrow(/RESULT_UNKNOWN/)
  expect(destroys).toBe(0)
})

it('denies a different authenticated consumer and does not expose its request result', async () => {
  const { host } = setup({ execute: async () => ({ outcome: 'succeeded' }), destroy: async () => ({ destroyed: true }) })
  await host.request(consumer, request())
  const impostor = { ...consumer, scopeId: 'other' }
  expect(() => host.get(impostor, 'w', 'r')).toThrow(/FORBIDDEN/)
  await expect(host.close(impostor, 'w')).rejects.toThrow(/FORBIDDEN/)
})

it('waits for running execution before destroying and shares a concurrent close', async () => {
  let finish!: (value: RequestCompletion) => void
  let destroys = 0
  const { host } = setup({ execute: () => new Promise(resolve => { finish = resolve }),
    destroy: async () => { destroys++; return { destroyed: true } } })
  const execution = host.request(consumer, request())
  const closing = host.close(consumer, 'w')
  const duplicateClose = host.close(consumer, 'w')
  expect(destroys).toBe(0)
  expect((await host.request(consumer, request('late'))).state).toBe('failed')
  finish({ outcome: 'succeeded' })
  await execution
  expect((await closing).state).toBe('closed')
  expect((await duplicateClose).state).toBe('closed')
  expect(destroys).toBe(1)
})

it('does not release a context on failed destruction and allows explicit later cleanup', async () => {
  let attempts = 0
  const { host, ledger } = setup({ execute: async () => ({ outcome: 'succeeded' }), destroy: async () => {
    if (++attempts === 1) throw new Error('browser stop unconfirmed')
    return { destroyed: true }
  } })
  await host.request(consumer, request())
  await expect(host.close(consumer, 'w')).rejects.toThrow(/unconfirmed/)
  expect(ledger.snapshot.allocations.find(item => item.resourceId === 'context')?.state).toBe('held')
  expect((await host.close(consumer, 'w')).state).toBe('closed')
})
