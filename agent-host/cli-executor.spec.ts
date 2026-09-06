import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCliWorkExecutor } from './cli-executor.ts'
import { createWorkHost } from './work-host.ts'
import { createFileWorkStore, createWorkLedger } from '../agent/work-resource.ts'
import type { AgentWork } from '../control-protocol/agent-services.ts'
import { createWorkIngress } from './work-ingress.ts'
import { parseWorkWireFrame } from '../control-protocol/work-wire.ts'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'teams-cli-executor-'))
  directories.push(root)
  writeFileSync(join(root, 'sample.txt'), 'unique needle with metadata and generation\n')
  return root
}
const work: AgentWork = { workId: 'w', consumerAgentId: 'consumer', providerAgentId: 'provider',
  capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'accepted' }

it('runs real fixed-root search through provider admission and trusted completion', async () => {
  const root = fixture()
  const executor = createCliWorkExecutor({ camoExecutable: '/opt/homebrew/bin/camo', searchExecutable: '/opt/homebrew/bin/rg',
    searchRoot: root, profilePrefix: 'teams-test-executor' })
  const provider = { accountId: 'account', scopeId: 'scope', agentId: 'provider' }
  const consumer = { ...provider, agentId: 'consumer' }
  const ledger = createWorkLedger({ provider, generation: 1, capabilities: executor.capabilities,
    store: createFileWorkStore(join(root, 'ledger.json')) })
  const host = createWorkHost({ ledger, executor, policy: () => ({ revision: 1, authorizeWork: () => true }) })
  host.propose(consumer, work)
  const result = await host.request(consumer, { control: { workId: 'w', requestId: 'r', targetGeneration: 1,
    operation: 'search', demands: [{ resourceId: 'search-slot', amount: 1 }] }, payload: { query: 'unique needle' } })
  expect(result.state).toBe('succeeded')
  expect(result.response).toMatchObject({ status: 'matched', matches: expect.arrayContaining([expect.objectContaining({ path: './sample.txt' })]) })
  expect(ledger.snapshot.allocations.every(item => item.state === 'released')).toBe(true)
  expect((await host.close(consumer, 'w')).state).toBe('closed')
})

it('rejects mismatched operation envelopes before invoking a process', async () => {
  const executor = createCliWorkExecutor({ camoExecutable: '/missing/camo', searchExecutable: '/missing/rg',
    searchRoot: fixture(), profilePrefix: 'teams-test-executor' })
  const result = await executor.execute(work, { control: { workId: 'w', requestId: 'r', targetGeneration: 1,
    operation: 'search', demands: [] }, payload: { operation: 'context.destroy', query: 'x' } })
  expect(result).toMatchObject({ outcome: 'failed', error: { code: 'INVALID_INPUT' } })
})

it('preserves a missing browser context error code through the executor boundary', async () => {
  const executor = createCliWorkExecutor({ camoExecutable: '/missing/camo', searchExecutable: '/missing/rg',
    searchRoot: fixture(), profilePrefix: 'teams-test-executor' })
  const result = await executor.execute({ ...work, capabilityId: 'browser' }, { control: { workId: 'w', requestId: 'r', targetGeneration: 1,
    operation: 'snapshot', demands: [] }, payload: { contextId: 'missing' } })
  expect(result).toMatchObject({ outcome: 'failed', error: { code: 'NOT_FOUND' } })
})

it('preserves real CLI failure output through durable Work state and the wire error chain', async () => {
  const root = fixture()
  const executable = join(root, 'failing-search')
  writeFileSync(executable, '#!/bin/sh\nprintf "partial output\\n"\nprintf "failure detail\\n" >&2\nexit 7\n', { mode: 0o700 })
  const executor = createCliWorkExecutor({ camoExecutable: '/missing/camo', searchExecutable: executable,
    searchRoot: root, profilePrefix: 'teams-test-executor' })
  const provider = { accountId: 'account', scopeId: 'scope', agentId: 'provider' }
  const consumer = { ...provider, agentId: 'consumer' }
  const store = createFileWorkStore(join(root, 'ledger.json'))
  const ledger = createWorkLedger({ provider, generation: 1, capabilities: executor.capabilities, store })
  const host = createWorkHost({ ledger, executor, policy: () => ({ revision: 1, authorizeWork: () => true }) })
  host.propose(consumer, work)
  const reply = await createWorkIngress(host, consumer)({ kind: 'work.request', correlationId: 'c',
    control: { workId: 'w', requestId: 'r', operation: 'search', targetGeneration: 1, demands: [{ resourceId: 'search-slot', amount: 1 }] },
    payload: { query: 'needle' } })
  const expected = { code: 'UPSTREAM_ERROR', execution: { kind: 'cli', code: 'PROCESS_ERROR', exitCode: 7,
    signal: null, stdout: 'partial output\n', stderr: 'failure detail\n' } }
  expect(parseWorkWireFrame(JSON.stringify(reply))).toMatchObject({ control: { state: 'failed', error: expected } })
  expect(createWorkLedger({ provider, generation: 2, capabilities: executor.capabilities, store }).snapshot.requests[0].error).toMatchObject(expected)
  expect(ledger.snapshot.allocations.every(item => item.state === 'released')).toBe(true)
})
