import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthenticatedAgent, CapabilityDeclaration, WorkRequest } from '../control-protocol/agent-services.ts'
import {
  createFileWorkStore,
  createTrustedWorkAuthority,
  createWorkLedger,
  confirmWorkDestroyed,
  completeRequest,
  closeWork,
  getRequest,
  proposeWork,
  recover,
  recoverFileWorkStoreLock,
  requestCancellation,
  requestWork,
  type ProviderWorkPolicy,
} from './work-resource.ts'

const consumer: AuthenticatedAgent = { accountId: 'account-a', scopeId: 'scope-a', agentId: 'consumer-a' }
const provider: AuthenticatedAgent = { accountId: 'account-a', scopeId: 'scope-a', agentId: 'provider-a' }
const capability: CapabilityDeclaration = {
  capabilityId: 'browser/v1',
  version: '1.0.0',
  operations: [
    { operation: 'open', inputSchema: {}, outputSchema: {}, cancellation: 'cooperative' },
    { operation: 'snapshot', inputSchema: {}, outputSchema: {}, cancellation: 'cooperative' },
  ],
  resources: [
    { resourceId: 'browser-context', capacity: 2, unit: 'context', sharing: 'shared', allocationScope: 'work' },
    { resourceId: 'request-slot', capacity: 2, unit: 'slot', sharing: 'shared', allocationScope: 'request' },
  ],
}

const policy = (overrides: Partial<ProviderWorkPolicy> = {}): ProviderWorkPolicy => ({
  revision: 7,
  authorizeWork: () => true,
  authorizeRequest: () => true,
  ...overrides,
})

const request = (workId: string, requestId: string, operation = 'open', targetGeneration = 4, demands = [
  { resourceId: 'browser-context', amount: 1 },
  { resourceId: 'request-slot', amount: 1 },
]): WorkRequest => ({
  control: { workId, requestId, operation, targetGeneration, demands },
  payload: { url: 'https://example.test' },
})

const workProposal = (workId: string, consumerAgentId = consumer.agentId) => ({
  workId,
  consumerAgentId,
  providerAgentId: provider.agentId,
  capabilityId: capability.capabilityId,
  capabilityVersion: capability.version,
  policyRevision: 7,
})

const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function ledger(fileName = 'work.json') {
  const directory = mkdtempSync(join(tmpdir(), 'teams-work-'))
  tempDirs.push(directory)
  return createWorkLedger({
    provider,
    generation: 4,
    capabilities: [capability],
    store: createFileWorkStore(join(directory, fileName)),
  })
}

function accept(ledgerState: ReturnType<typeof ledger>, workId: string, consumerAgentId = consumer.agentId) {
  return proposeWork(ledgerState, consumer, workProposal(workId, consumerAgentId), policy())
}

describe('Agent Work resource admission', () => {
  it('rejects unauthenticated identity claims and incompatible capability versions', () => {
    const state = ledger()
    expect(() => proposeWork(state, { ...consumer, agentId: 'other-agent' }, workProposal('work-identity'), policy())).toThrowError(/FORBIDDEN/)
    expect(() => proposeWork(state, consumer, { ...workProposal('work-version'), capabilityVersion: '9.0.0' }, policy())).toThrowError(/UNSUPPORTED_VERSION/)
  })

  it('requires provider-wide resource ids across capabilities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-work-resource-id-'))
    tempDirs.push(directory)
    const duplicateCapability: CapabilityDeclaration = { ...capability, capabilityId: 'another-browser/v1' }
    expect(() => createWorkLedger({
      provider,
      generation: 4,
      capabilities: [capability, duplicateCapability],
      store: createFileWorkStore(join(directory, 'work.json')),
    })).toThrowError(/CONFLICT/)
  })

  it('enforces account and scope even when agent ids match', () => {
    const state = ledger()
    accept(state, 'work-a')
    const outsideScope = { ...consumer, accountId: 'account-b', scopeId: 'scope-b' }
    expect(() => proposeWork(state, outsideScope, workProposal('work-a'), policy())).toThrowError(/FORBIDDEN/)
    expect(() => requestWork(state, { authenticatedConsumer: outsideScope, request: request('work-a', 'request-a'), policy: policy() })).toThrowError(/FORBIDDEN/)
    requestWork(state, { authenticatedConsumer: consumer, request: request('work-a', 'request-a'), policy: policy() })
    expect(() => requestCancellation(state, outsideScope, 'work-a', 'request-a')).toThrowError(/FORBIDDEN/)
    expect(() => closeWork(state, outsideScope, 'work-a')).toThrowError(/FORBIDDEN/)
  })

  it('requires a positive demand for every declared resource', () => {
    const state = ledger()
    accept(state, 'work-a')
    expect(() => requestWork(state, {
      authenticatedConsumer: consumer,
      request: request('work-a', 'empty-request', 'open', 4, []),
      policy: policy(),
    })).toThrowError(/INVALID_INPUT/)
    expect(() => requestWork(state, {
      authenticatedConsumer: consumer,
      request: request('work-a', 'partial-request', 'open', 4, [{ resourceId: 'browser-context', amount: 1 }]),
      policy: policy(),
    })).toThrowError(/INVALID_INPUT/)
    expect(state.snapshot.requests).toHaveLength(0)
  })

  it('rejects non-JSON payload objects and sparse arrays', () => {
    const state = ledger()
    accept(state, 'work-a')
    expect(() => requestWork(state, {
      authenticatedConsumer: consumer,
      request: { ...request('work-a', 'date-payload'), payload: new Date() as never },
      policy: policy(),
    })).toThrowError(/INVALID_INPUT/)
    expect(() => requestWork(state, {
      authenticatedConsumer: consumer,
      request: { ...request('work-a', 'map-payload'), payload: new Map() as never },
      policy: policy(),
    })).toThrowError(/INVALID_INPUT/)
    const sparse: unknown[] = []
    sparse.length = 1
    expect(() => requestWork(state, {
      authenticatedConsumer: consumer,
      request: { ...request('work-a', 'sparse-payload'), payload: sparse as never },
      policy: policy(),
    })).toThrowError(/INVALID_INPUT/)
    expect(state.snapshot.requests).toHaveLength(0)
  })

  it('atomically admits multi-resource work and rejects capacity overflow without partial allocation', () => {
    const state = ledger()
    accept(state, 'work-a')
    accept(state, 'work-b')
    requestWork(state, { authenticatedConsumer: consumer, request: request('work-a', 'request-a', 'open', 4, [
      { resourceId: 'browser-context', amount: 1 },
      { resourceId: 'request-slot', amount: 1 },
    ]), policy: policy() })
    requestWork(state, { authenticatedConsumer: consumer, request: request('work-b', 'request-b', 'open', 4, [
      { resourceId: 'browser-context', amount: 1 },
      { resourceId: 'request-slot', amount: 1 },
    ]), policy: policy() })
    accept(state, 'work-c')
    const result = requestWork(state, { authenticatedConsumer: consumer, request: request('work-c', 'request-c'), policy: policy() })
    expect(result.executionAllowed).toBe(false)
    expect(result.request.state).toBe('failed')
    expect(result.request.error?.code).toBe('RESOURCE_EXHAUSTED')
    expect(state.snapshot.allocations).toHaveLength(4)
    expect(state.snapshot.allocations.every(allocation => allocation.state === 'held')).toBe(true)
  })

  it('deduplicates requests and rejects changed parameters for the same request id', () => {
    const state = ledger()
    accept(state, 'work-a')
    const first = requestWork(state, { authenticatedConsumer: consumer, request: request('work-a', 'request-a'), policy: policy() })
    expect(() => requestWork(state, {
      authenticatedConsumer: { ...consumer, agentId: 'other-agent' },
      request: request('work-a', 'request-a'),
      policy: policy(),
    })).toThrowError(/FORBIDDEN/)
    const duplicate = requestWork(state, { authenticatedConsumer: consumer, request: request('work-a', 'request-a'), policy: policy() })
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.executionAllowed).toBe(false)
    expect(duplicate.request).toEqual(first.request)
    expect(state.snapshot.allocations).toHaveLength(2)
    expect(() => requestWork(state, {
      authenticatedConsumer: consumer,
      request: { ...request('work-a', 'request-a'), payload: { url: 'https://changed.test' } },
      policy: policy(),
    })).toThrowError(/CONFLICT/)
  })

  it('keeps request tuple keys unambiguous', () => {
    const state = ledger()
    accept(state, 'a:b')
    accept(state, 'a')
    requestWork(state, { authenticatedConsumer: consumer, request: request('a:b', 'c'), policy: policy() })
    requestWork(state, { authenticatedConsumer: consumer, request: request('a', 'b:c'), policy: policy() })
    expect(state.snapshot.requests).toHaveLength(2)
  })

  it('keeps unknown and cancel-requested work held until trusted completion', () => {
    const state = ledger()
    accept(state, 'work-a')
    requestWork(state, { authenticatedConsumer: consumer, request: request('work-a', 'request-a', 'open', 4, [
      { resourceId: 'request-slot', amount: 1 },
      { resourceId: 'browser-context', amount: 1 },
    ]), policy: policy() })
    requestCancellation(state, consumer, 'work-a', 'request-a')
    expect(getRequest(state, 'work-a', 'request-a').state).toBe('cancel_requested')
    const authority = createTrustedWorkAuthority()
    completeRequest(state, authority, 'work-a', 'request-a', { outcome: 'unknown' })
    expect(getRequest(state, 'work-a', 'request-a').state).toBe('unknown')
    expect(state.snapshot.allocations.find(allocation => allocation.resourceId === 'request-slot')?.state).toBe('unknown')
    expect(() => completeRequest(state, {} as never, 'work-a', 'request-a', { outcome: 'cancelled' })).toThrowError(/FORBIDDEN/)
    completeRequest(state, authority, 'work-a', 'request-a', { outcome: 'cancelled' })
    expect(state.snapshot.allocations.find(allocation => allocation.resourceId === 'request-slot')?.state).toBe('released')
  })

  it('holds work-scoped context through request completion and releases only after destroy confirmation', () => {
    const state = ledger()
    accept(state, 'work-a')
    requestWork(state, { authenticatedConsumer: consumer, request: request('work-a', 'request-a'), policy: policy() })
    const authority = createTrustedWorkAuthority()
    completeRequest(state, authority, 'work-a', 'request-a', { outcome: 'succeeded', payload: { contextId: 'ctx-1' } })
    expect(state.snapshot.allocations.find(allocation => allocation.resourceId === 'browser-context')?.state).toBe('held')
    closeWork(state, consumer, 'work-a')
    expect(() => confirmWorkDestroyed(state, authority, 'work-a')).not.toThrow()
    expect(state.snapshot.works[0]?.state).toBe('closed')
    expect(state.snapshot.allocations.find(allocation => allocation.resourceId === 'browser-context')?.state).toBe('released')
  })

  it('recovers persisted in-flight requests as unknown and never clears corrupt state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-work-recover-'))
    tempDirs.push(directory)
    const file = join(directory, 'work.json')
    const first = createWorkLedger({ provider, generation: 4, capabilities: [capability], store: createFileWorkStore(file) })
    accept(first, 'work-a')
    requestWork(first, { authenticatedConsumer: consumer, request: request('work-a', 'request-a'), policy: policy() })
    const restarted = createWorkLedger({ provider, generation: 5, capabilities: [capability], store: createFileWorkStore(file) })
    const concurrent = createWorkLedger({ provider, generation: 5, capabilities: [capability], store: createFileWorkStore(file) })
    const authority = createTrustedWorkAuthority()
    expect(() => recover(restarted, {} as never, [])).toThrowError(/FORBIDDEN/)
    recover(restarted, authority, [])
    expect(getRequest(restarted, 'work-a', 'request-a').state).toBe('unknown')
    expect(restarted.snapshot.allocations.find(allocation => allocation.resourceId === 'request-slot')?.state).toBe('unknown')
    expect(() => recover(restarted, authority, [{ workId: 'work-a', requestId: 'request-a', requestState: 'succeeded' }])).toThrowError(/terminal state requires completion data/)
    recover(restarted, authority, [{
      workId: 'work-a',
      requestId: 'request-a',
      completion: { outcome: 'succeeded', payload: { contextId: 'ctx-2' } },
    }])
    expect(getRequest(restarted, 'work-a', 'request-a').state).toBe('succeeded')
    expect(restarted.snapshot.allocations.find(allocation => allocation.resourceId === 'request-slot')?.state).toBe('released')
    expect(restarted.snapshot.allocations.find(allocation => allocation.resourceId === 'browser-context')?.state).toBe('unknown')
    expect(() => restarted.store.save(restarted.snapshot.revision, {
      version: 99,
      revision: restarted.snapshot.revision + 1,
    } as never)).toThrowError(/INVALID_INPUT/)
    expect(() => createWorkLedger({ provider, generation: 5, capabilities: [capability], store: createFileWorkStore(file) })).not.toThrow()
    proposeWork(restarted, consumer, workProposal('work-b'), policy())
    expect(() => proposeWork(concurrent, consumer, workProposal('work-c'), policy())).toThrowError(/REVISION_CONFLICT/)
    writeFileSync(file, '{not-json', 'utf8')
    expect(() => createWorkLedger({ provider, generation: 5, capabilities: [capability], store: createFileWorkStore(file) })).toThrowError(/INVALID_INPUT/)
    expect(readFileSync(file, 'utf8')).toBe('{not-json')
  })

  it('keeps crash locks fail-closed until daemon owner supplies exact exit proof', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-work-lock-'))
    tempDirs.push(directory)
    const file = join(directory, 'work.json')
    const state = createWorkLedger({ provider, generation: 4, capabilities: [capability], store: createFileWorkStore(file) })
    const lockPath = `${file}.lock`
    const proof = { version: 1, ownerPid: 987654, ownerStartToken: 'start-token-1', lockToken: 'lock-token-1' }
    writeFileSync(lockPath, JSON.stringify(proof), 'utf8')
    expect(() => accept(state, 'work-locked')).toThrowError(/UNAVAILABLE/)
    const authority = createTrustedWorkAuthority()
    expect(() => recoverFileWorkStoreLock(file, authority, { ...proof, lockToken: 'wrong-token' }, () => true)).toThrowError(/CONFLICT/)
    expect(existsSync(lockPath)).toBe(true)
    expect(() => recoverFileWorkStoreLock(file, authority, proof, () => false)).toThrowError(/UNAVAILABLE/)
    expect(existsSync(lockPath)).toBe(true)
    recoverFileWorkStoreLock(file, authority, proof, owner => owner.pid === proof.ownerPid && owner.startToken === proof.ownerStartToken)
    expect(existsSync(lockPath)).toBe(false)
    expect(() => accept(state, 'work-recovered')).not.toThrow()
  })

  it('rejects structurally valid snapshots with dangling request or allocation references', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-work-integrity-'))
    tempDirs.push(directory)
    const file = join(directory, 'work.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      revision: 0,
      provider,
      works: [],
      requests: [{
        control: { workId: 'missing-work', requestId: 'request-a', operation: 'open', targetGeneration: 4, demands: [] },
        payload: {},
        state: 'running',
        allocationIds: [],
      }],
      allocations: [],
    }), 'utf8')
    expect(() => createWorkLedger({ provider, generation: 4, capabilities: [capability], store: createFileWorkStore(file) })).toThrowError(/INVALID_INPUT/)
    expect(readFileSync(file, 'utf8')).toContain('missing-work')
  })
})
