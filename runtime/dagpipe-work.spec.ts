import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createRelayClient, type RelayClient, type RelayClientOptions } from '../network/relay-client.ts'
import { createWorkChannel } from '../network/work-channel.ts'
import { startAgentDaemon, type AgentDaemon } from './agent-daemon.ts'
import { createWorkIngress } from '../agent-host/work-ingress.ts'
import { createWorkHost, type WorkHost } from '../agent-host/work-host.ts'
import { createCliWorkExecutor, type CliWorkExecutor } from '../agent-host/cli-executor.ts'
import { createFileWorkStore, createWorkLedger, type WorkLedger } from '../agent/work-resource.ts'
import { compileDeclarationEndpoints } from '../server/endpoint-discovery.ts'
import { createAgentWorkClient, type AgentWorkClient } from './agent-work-client.ts'
import { buildRunner } from './dagpipe/build.mjs'
import {
  runWorkExecution,
  type ProjectExecutionReceipt,
  type QueryIntentControl,
  type WorkCloseIntentControl,
  type WorkIntentControl,
  type WorkOpenIntentControl,
  type WorkRequestIntentControl,
} from './dagpipe/host.ts'
import type { HostCallFrame, RunnerFinalFrame } from './dagpipe/protocol.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = join(repoRoot, 'runtime', 'dagpipe', 'fixtures')
const evidenceRoot = join(repoRoot, 'generated', 'u4-receipts', process.env.U4_RECEIPT_RUN_ID ?? `run-${process.pid}`)
const agentWorkGraph = join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'agent-work.graph.json')
const workOpenGraph = join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-open.graph.json')
const workRequestGraph = join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-request.graph.json')
const workCloseGraph = join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-close.graph.json')
const workQueryGraph = join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-query.graph.json')
const invalidFrameRunner = join(fixtureRoot, 'invalid-frame-runner.mjs')
const earlyExitRunner = join(fixtureRoot, 'early-exit-runner.mjs')
const badCorrelationRunner = join(fixtureRoot, 'bad-correlation-runner.mjs')
const malformedFinalRunner = join(fixtureRoot, 'malformed-final-runner.mjs')
const projectId = 'agentteams-d3-u4-work'

let cert: Buffer
let key: Buffer
let certDirectory: string
let runnerPath: string
let buildReceipt: unknown
const evidence: Record<string, unknown>[] = []

interface Harness {
  readonly relay: RelayServer
  readonly provider: AgentDaemon
  readonly consumer: AgentDaemon
  readonly client: AgentWorkClient
  readonly ledger: WorkLedger
  readonly executeCount: () => number
  stop(): Promise<void>
}

function submitControl(workId: string, requestId: string, operation = 'search'): WorkIntentControl {
  return {
    receiverAgentId: 'consumer',
    targetAgentId: 'provider',
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation,
    workId,
    requestId,
    policyRevision: 1,
    demands: [{ resourceId: 'search-slot', amount: 1 }],
  }
}

function queryControl(workId: string, requestId: string): QueryIntentControl {
  return {
    receiverAgentId: 'consumer',
    targetAgentId: 'provider',
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation: 'search',
    workId,
    requestId,
  }
}

function openControl(workId: string, requestId: string, targetGeneration: number): WorkOpenIntentControl {
  return {
    ...submitControl(workId, requestId),
    serviceSelection: 'capability',
    targetGeneration,
  }
}

function requestControl(workId: string, requestId: string, targetGeneration: number): WorkRequestIntentControl {
  return {
    receiverAgentId: 'consumer',
    targetAgentId: 'provider',
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation: 'search',
    workId,
    requestId,
    demands: [{ resourceId: 'search-slot', amount: 1 }],
    serviceSelection: 'capability',
    targetGeneration,
  }
}

function closeControl(workId: string, targetGeneration: number): WorkCloseIntentControl {
  return {
    receiverAgentId: 'consumer',
    targetAgentId: 'provider',
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation: 'search',
    workId,
    serviceSelection: 'capability',
    targetGeneration,
  }
}

function capabilityQueryControl(
  workId: string,
  requestId: string,
  targetGeneration: number,
  linkGeneration?: number,
): QueryIntentControl {
  return {
    ...queryControl(workId, requestId),
    serviceSelection: 'capability',
    targetGeneration,
    ...(linkGeneration === undefined ? {} : { linkGeneration }),
  }
}

type Capabilities = RelayClientOptions['declaration']['capabilities']

function declarationFor(id: string, capabilities: Capabilities = []) {
  return {
    identity: { hostId: id, machineId: id, agentId: id, accountId: 'account', agentKind: 'custom' as const, label: id },
    scopeId: 'scope',
    revision: 1,
    capabilities,
    routes: [] as [],
  }
}

function clientOptions(url: string, id: string, capabilities: Capabilities = []): RelayClientOptions {
  return {
    transport: {
      endpoint: url,
      credential: `Bearer ${id}`,
      ca: cert,
      connectTimeoutMs: 2000,
      maxMessageBytes: 65536,
      maxBufferedBytes: 65536,
      maxPendingFrames: 16,
    },
    admissionTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    maxPendingRequests: 8,
    maxDataConnections: 8,
    declaration: declarationFor(id, capabilities),
  }
}

async function startHarness(options: {
  readonly authorizeWork?: (agentId: string) => boolean
  readonly dropReplyForWorkId?: string
} = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-harness-'))
  const searchRoot = join(directory, 'search-root')
  mkdirSync(searchRoot)
  writeFileSync(join(searchRoot, 'alpha.txt'), 'alpha marker 4b6c377\n')
  writeFileSync(join(searchRoot, 'beta.txt'), 'beta marker 4b6c377\n')

const relay = await createRelayServer({
    host: '127.0.0.1',
    port: 0,
    key,
    cert,
    maxPayload: 65536,
    maxConnections: 16,
    maxGrants: 8,
    maxBufferedAmount: 65536,
    maxPendingMessages: 16,
    maxPendingBytes: 131072,
    grantTtlMs: 10_000,
    authenticate: credential => credential?.startsWith('Bearer ')
      ? { agentId: credential.slice(7), accountId: 'account', scopeId: 'scope' }
      : null,
  })

  const base = createCliWorkExecutor({
    searchRoot,
    profilePrefix: 'teams-d3-u4-work-test',
    searchExecutable: '/opt/homebrew/bin/rg',
    services: [
      {
        capabilityId: 'file-search',
        version: '1',
        operations: ['search'],
        resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }],
      },
    ],
  })
  let executed = 0
  const executor: CliWorkExecutor = {
    capabilities: base.capabilities,
    execute: async (work, request, allocations) => {
      executed += 1
      return base.execute(work, request, allocations)
    },
    destroy: (work, allocations) => base.destroy(work, allocations),
  }

  let host!: WorkHost
  const provider = await startAgentDaemon({
    presenceIntervalMs: 1000,
    relay: {
      ...clientOptions(relay.url, 'provider', executor.capabilities),
      onEvent: async event => {
        if (event.kind !== 'relay.offer') return
        const socket = await provider.network.openData(event.grant)
        const ingress = createWorkIngress(host, { accountId: 'account', scopeId: 'scope', agentId: event.grant.sourceAgentId })
        createWorkChannel(socket, {
          timeoutMs: 2000,
          maxPending: 4,
          maxIncoming: 4,
          onRequest: request => {
            if (request.kind === 'work.request' && request.control.workId === options.dropReplyForWorkId) {
              // The provider still executes and records the real result; only the reply link drops.
              void ingress(request).catch(() => undefined)
              return new Promise(() => undefined)
            }
            return ingress(request)
          },
        })
      },
    },
  })
  const ledger = createWorkLedger({
    provider: { accountId: 'account', scopeId: 'scope', agentId: 'provider' },
    generation: provider.network.generation,
    capabilities: executor.capabilities,
    // The provider ledger admits Endpoint references from the same published
    // declaration the directory exposes, exactly as the real Agent process does.
    endpointCatalog: compileDeclarationEndpoints(declarationFor('provider', executor.capabilities)),
    store: createFileWorkStore(join(directory, 'work-ledger.json')),
  })
  host = createWorkHost({
    ledger,
    executor,
    policy: () => ({
      revision: 1,
      authorizeWork: consumer => options.authorizeWork?.(consumer.agentId) ?? true,
      authorizeRequest: consumer => options.authorizeWork?.(consumer.agentId) ?? true,
    }),
  })

  const consumer = await startAgentDaemon({ presenceIntervalMs: 1000, relay: clientOptions(relay.url, 'consumer') })
  const client = createAgentWorkClient(consumer.network, { accountId: 'account', scopeId: 'scope', agentId: 'consumer' }, { timeoutMs: 2000, maxPending: 8 })

  return {
    relay,
    provider,
    consumer,
    client,
    ledger,
    executeCount: () => executed,
    stop: async () => {
      await client.dispose()
      await consumer.stop()
      await provider.stop()
      await relay.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

function compileGraph(graphPath: string, capabilities?: readonly string[]): RunnerFinalFrame {
  const args = ['compile', '--graph', graphPath]
  if (capabilities) args.push('--capabilities', JSON.stringify(capabilities))
  const stdout = execFileSync(runnerPath, args, { encoding: 'utf8' })
  const lines = stdout.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1]) as RunnerFinalFrame
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error('waitFor timed out')
}

function scheduledNodes(receipt: ProjectExecutionReceipt): readonly string[] {
  return receipt.evidence.nodeSchedule
}

beforeAll(async () => {
  const built = await buildRunner()
  runnerPath = built.runnerPath
  buildReceipt = built.receipt
  certDirectory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-cert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(certDirectory, 'key'), '-out', join(certDirectory, 'cert')], { stdio: 'ignore' })
  cert = readFileSync(join(certDirectory, 'cert'))
  key = readFileSync(join(certDirectory, 'key'))
}, 180_000)

afterAll(() => {
  mkdirSync(join(evidenceRoot, 'results'), { recursive: true })
  writeFileSync(join(evidenceRoot, 'results', 'build-receipt.json'), `${JSON.stringify(buildReceipt, null, 2)}\n`)
  writeFileSync(join(evidenceRoot, 'results', 'u4-sdk-source-final-work-results.json'), `${JSON.stringify({
    protocol: 'teams-u4-sdk-persistent-work-results',
    runner: runnerPath,
    cases: evidence,
  }, null, 2)}\n`)
  rmSync(certDirectory, { recursive: true, force: true })
})

describe('Teams DAGpipe SDK Work runner and Node host', () => {
  it('runs two real submits with distinct identities and real search results, then observes the original request without replay', async () => {
    const harness = await startHarness()
    try {
      const hostCalls: HostCallFrame[] = []
      const first = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-alpha',
        attemptId: '1',
        intent: { control: submitControl('work-alpha', 'req-alpha'), business: { query: 'alpha marker' } },
        onHostCall: frame => hostCalls.push(frame),
      })
      const second = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-beta',
        attemptId: '1',
        intent: { control: submitControl('work-beta', 'req-beta'), business: { query: 'beta marker' } },
      })

      expect(first.status).toBe('completed')
      expect(first.control.workId).toBe('work-alpha')
      expect(first.control.requestId).toBe('req-alpha')
      expect(first.control.requestState).toBe('succeeded')
      expect(first.control.workClosure).toBe('closed')
      expect(first.control.error).toBeUndefined()
      expect(first.business).toMatchObject({
        query: 'alpha marker',
        status: 'matched',
        matches: [expect.objectContaining({ path: './alpha.txt', line: 1, text: 'alpha marker 4b6c377\n' })],
      })
      expect(first.control).not.toHaveProperty('matches')
      expect(Object.keys(first.business as Record<string, unknown>)).not.toContain('control')
      expect(scheduledNodes(first)).toEqual(['resolve-service', 'open-link', 'admit-work', 'request-work', 'settle-work'])
      expect(first.cleanup).toEqual({ channelsOpened: 1, channelsDisposed: 1 })
      const requestCall = hostCalls.find(call => call.control.operation === 'agentWork.request')
      expect(requestCall?.control.args).toMatchObject({
        channelRef: 'channel-1',
        workId: 'work-alpha',
        requestId: 'req-alpha',
        operation: 'search',
        demands: [{ resourceId: 'search-slot', amount: 1 }],
      })
      expect(requestCall?.business).toEqual({ query: 'alpha marker' })
      expect(hostCalls.filter(call => call.control.operation !== 'agentWork.request')
        .every(call => !Object.hasOwn(call, 'business'))).toBe(true)

      expect(second.status).toBe('completed')
      expect(second.control.workId).toBe('work-beta')
      expect(second.control.requestId).toBe('req-beta')
      expect(second.control.requestState).toBe('succeeded')
      expect(second.control.workClosure).toBe('closed')
      expect(second.business).toMatchObject({ matches: [expect.objectContaining({ path: './beta.txt' })] })
      expect(second.business).not.toEqual(first.business)

      const snapshot = harness.ledger.snapshot
      expect(snapshot.works.map(work => work.workId).sort()).toEqual(['work-alpha', 'work-beta'])
      expect(snapshot.requests).toHaveLength(2)
      expect(snapshot.works.every(work => work.state === 'closed')).toBe(true)
      expect(snapshot.allocations.every(allocation => allocation.state === 'released')).toBe(true)
      expect(harness.executeCount()).toBe(2)

      const revisionBeforeQuery = snapshot.revision
      const observed = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workQueryGraph,
        projectId,
        executionId: 'exec-query-alpha',
        attemptId: '1',
        intent: { control: queryControl('work-alpha', 'req-alpha') },
      })
      expect(observed.status).toBe('completed')
      expect(observed.control.requestState).toBe('succeeded')
      expect(observed.control.observed).toBe(true)
      expect(observed.control.workClosure).toBeUndefined()
      expect(observed.business).toEqual(first.business)
      expect(scheduledNodes(observed)).toEqual(['resolve-service', 'open-link', 'query-request', 'return-observation'])
      expect(harness.ledger.snapshot.revision).toBe(revisionBeforeQuery)
      expect(harness.ledger.snapshot.works).toHaveLength(2)
      expect(harness.ledger.snapshot.requests).toHaveLength(2)
      expect(harness.executeCount()).toBe(2)

      evidence.push({ case: 'submit-and-query', first, second, observed })
    } finally {
      await harness.stop()
    }
  }, 30_000)

  it('opens, continues, queries, and closes one persistent Work through the five approved graphs', async () => {
    const harness = await startHarness()
    try {
      const generation = harness.provider.network.generation
      const openCalls: HostCallFrame[] = []
      const opened = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workOpenGraph,
        projectId,
        executionId: 'exec-persistent-open',
        attemptId: '1',
        intent: { control: openControl('work-persistent', 'req-persistent-open', generation), business: { query: 'alpha marker' } },
        onHostCall: frame => openCalls.push(frame),
      })

      expect(opened.status).toBe('completed')
      expect(opened.control).toMatchObject({
        workId: 'work-persistent',
        requestId: 'req-persistent-open',
        providerAgentId: 'provider',
        targetGeneration: generation,
        serviceSelection: 'capability',
        capabilityId: 'file-search',
        capabilityVersion: '1',
        operation: 'search',
        requestState: 'succeeded',
        workClosure: 'retained',
      })
      expect(opened.control).not.toHaveProperty('endpoint')
      expect(opened.business).toMatchObject({
        status: 'matched',
        matches: [expect.objectContaining({ path: './alpha.txt', text: 'alpha marker 4b6c377\n' })],
      })
      expect(scheduledNodes(opened)).toEqual(['resolve-service', 'open-link', 'admit-work', 'request-work', 'return-held-work'])
      expect(opened.cleanup).toEqual({ channelsOpened: 1, channelsDisposed: 1 })
      expect(opened.evidence.hostOperations).toEqual([
        'agentWork.findProvider',
        'agentWork.open',
        'agentWork.propose',
        'agentWork.request',
        'agentWork.dispose',
      ])
      expect(opened.evidence.hostOperations).not.toContain('agentWork.close')
      expect(openCalls.find(call => call.control.operation === 'agentWork.findProvider')?.control.args).toMatchObject({
        serviceSelection: {
          mode: 'capability',
          providerAgentId: 'provider',
          targetGeneration: generation,
          generationPolicy: 'exact',
        },
      })
      expect(harness.ledger.snapshot.works).toMatchObject([{ workId: 'work-persistent', state: 'accepted' }])
      expect(harness.ledger.snapshot.requests).toMatchObject([{ control: { requestId: 'req-persistent-open' }, state: 'succeeded' }])
      expect(harness.executeCount()).toBe(1)

      const requested = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workRequestGraph,
        projectId,
        executionId: 'exec-persistent-request',
        attemptId: '1',
        intent: { control: requestControl('work-persistent', 'req-persistent-next', generation), business: { query: 'beta marker' } },
      })

      expect(requested.status).toBe('completed')
      expect(requested.control).toMatchObject({
        workId: 'work-persistent',
        requestId: 'req-persistent-next',
        providerAgentId: 'provider',
        targetGeneration: generation,
        serviceSelection: 'capability',
        requestState: 'succeeded',
        workClosure: 'retained',
      })
      expect(requested.business).toMatchObject({ matches: [expect.objectContaining({ path: './beta.txt' })] })
      expect(scheduledNodes(requested)).toEqual(['resolve-service', 'open-link', 'continue-work', 'return-held-work'])
      expect(requested.evidence.hostOperations).toEqual([
        'agentWork.findProvider',
        'agentWork.open',
        'agentWork.request',
        'agentWork.dispose',
      ])
      expect(requested.evidence.hostOperations).not.toContain('agentWork.propose')
      expect(harness.ledger.snapshot.works).toMatchObject([{ workId: 'work-persistent', state: 'accepted' }])
      expect(harness.ledger.snapshot.requests).toHaveLength(2)
      expect(harness.executeCount()).toBe(2)

      const revisionBeforeQuery = harness.ledger.snapshot.revision
      const observed = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workQueryGraph,
        projectId,
        executionId: 'exec-persistent-query',
        attemptId: '1',
        intent: { control: capabilityQueryControl('work-persistent', 'req-persistent-next', generation, generation) },
      })

      expect(observed.status).toBe('completed')
      expect(observed.control).toMatchObject({
        workId: 'work-persistent',
        requestId: 'req-persistent-next',
        providerAgentId: 'provider',
        targetGeneration: generation,
        linkGeneration: generation,
        serviceSelection: 'capability',
        capabilityId: 'file-search',
        capabilityVersion: '1',
        operation: 'search',
        requestState: 'succeeded',
        observed: true,
      })
      expect(observed.control.workClosure).toBeUndefined()
      expect(observed.business).toEqual(requested.business)
      expect(scheduledNodes(observed)).toEqual(['resolve-service', 'open-link', 'query-request', 'return-observation'])
      expect(observed.evidence.hostOperations).toEqual([
        'agentWork.findProvider',
        'agentWork.open',
        'agentWork.get',
        'agentWork.dispose',
      ])
      expect(harness.ledger.snapshot.revision).toBe(revisionBeforeQuery)
      expect(harness.ledger.snapshot.requests).toHaveLength(2)
      expect(harness.executeCount()).toBe(2)

      const closed = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workCloseGraph,
        projectId,
        executionId: 'exec-persistent-close',
        attemptId: '1',
        intent: { control: closeControl('work-persistent', generation) },
      })

      expect(closed.status).toBe('completed')
      expect(closed.control).toMatchObject({
        workId: 'work-persistent',
        providerAgentId: 'provider',
        targetGeneration: generation,
        serviceSelection: 'capability',
        operation: 'search',
        workClosure: 'closed',
      })
      expect(closed.control.requestState).toBeUndefined()
      expect(closed.business).toBeUndefined()
      expect(scheduledNodes(closed)).toEqual(['resolve-service', 'open-link', 'close-work'])
      expect(closed.evidence.hostOperations).toEqual([
        'agentWork.findProvider',
        'agentWork.open',
        'agentWork.close',
        'agentWork.dispose',
      ])
      expect(harness.ledger.snapshot.works).toMatchObject([{ workId: 'work-persistent', state: 'closed' }])
      expect(harness.ledger.snapshot.allocations.every(allocation => allocation.state === 'released')).toBe(true)
      expect(harness.executeCount()).toBe(2)

      evidence.push({ case: 'persistent-open-request-query-close', opened, requested, observed, closed })
    } finally {
      await harness.stop()
    }
  }, 45_000)

  it('rejects a stale persistent open generation before any Work effect', async () => {
    const harness = await startHarness()
    try {
      const receipt = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workOpenGraph,
        projectId,
        executionId: 'exec-persistent-stale',
        attemptId: '1',
        intent: {
          control: openControl('work-persistent-stale', 'req-persistent-stale', harness.provider.network.generation + 1),
          business: { query: 'alpha marker' },
        },
      })

      expect(receipt.status).toBe('failed')
      expect(receipt.control.error?.code).toBe('STALE_GENERATION')
      expect(receipt.control.targetGeneration).toBe(harness.provider.network.generation + 1)
      expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
      expect(scheduledNodes(receipt)).toEqual(['resolve-service'])
      expect(receipt.evidence.nodeCompletion).toEqual([])
      expect(harness.ledger.snapshot.works).toHaveLength(0)
      expect(harness.ledger.snapshot.requests).toHaveLength(0)
      expect(harness.executeCount()).toBe(0)
      evidence.push({ case: 'persistent-stale-generation', receipt })
    } finally {
      await harness.stop()
    }
  }, 30_000)

  it('rejects an incomplete persistent capability binding before any host or provider effect', async () => {
    const harness = await startHarness()
    try {
      const hostCalls: HostCallFrame[] = []
      const receipt = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workOpenGraph,
        projectId,
        executionId: 'exec-persistent-incomplete',
        attemptId: '1',
        intent: {
          control: {
            ...openControl('work-persistent-incomplete', 'req-persistent-incomplete', harness.provider.network.generation),
            serviceSelection: undefined,
          },
          business: { query: 'alpha marker' },
        },
        onHostCall: frame => hostCalls.push(frame),
      })

      expect(receipt.status).toBe('failed')
      expect(receipt.control.error?.code).toBe('INVALID_INPUT')
      expect(receipt.control.error?.message).toContain('requires serviceSelection=capability')
      expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
      expect(hostCalls).toHaveLength(0)
      expect(receipt.evidence.hostOperations).toHaveLength(0)
      expect(harness.ledger.snapshot.works).toHaveLength(0)
      expect(harness.ledger.snapshot.requests).toHaveLength(0)
      expect(harness.executeCount()).toBe(0)
      evidence.push({ case: 'persistent-incomplete-binding', receipt })
    } finally {
      await harness.stop()
    }
  }, 30_000)

  it('rejects every required malformed input before any host or provider effect', async () => {
    const harness = await startHarness()
    const generation = harness.provider.network.generation
    const mutationCases: Array<{ label: string; mutate(): unknown; field: string }> = [
      { label: 'requestId', mutate: () => undefined, field: 'requestId' },
      { label: 'demands', mutate: () => undefined, field: 'demands' },
      { label: 'business', mutate: () => undefined, field: 'business' },
      { label: 'policyRevision', mutate: () => undefined, field: 'policyRevision' },
    ]
    const graphCases = [
      { label: 'one-shot', graphPath: agentWorkGraph, control: submitControl('work-malformed', 'req-malformed'), business: { query: 'alpha marker' }, requiresPolicyRevision: true },
      { label: 'work-open', graphPath: workOpenGraph, control: openControl('work-malformed-open', 'req-malformed-open', generation), business: { query: 'alpha marker' }, requiresPolicyRevision: true },
      { label: 'work-request', graphPath: workRequestGraph, control: requestControl('work-malformed-request', 'req-malformed-request', generation), business: { query: 'alpha marker' }, requiresPolicyRevision: false },
    ]
    const queryOnlyCases = [
      {
        label: 'endpoint-query-missing-requestId',
        graphPath: workQueryGraph,
        control: { ...queryControl('work-query', 'req-query'), requestId: undefined },
        expected: 'INVALID_INPUT',
        message: 'requestId',
        noEffect: true,
      },
      {
        label: 'capability-query-missing-target-generation',
        graphPath: workQueryGraph,
        control: { ...capabilityQueryControl('work-query', 'req-query', generation), targetGeneration: undefined },
        expected: 'INVALID_INPUT',
        message: 'targetGeneration',
        noEffect: true,
      },
      {
        label: 'close-without-business',
        graphPath: workCloseGraph,
        control: closeControl('work-query', generation),
        expected: 'FORBIDDEN',
        message: '',
        noEffect: false,
      },
    ]
    try {
      for (const graphCase of graphCases) {
        for (const mutationCase of mutationCases) {
          if (mutationCase.field === 'policyRevision' && !graphCase.requiresPolicyRevision) continue
          const hostCalls: HostCallFrame[] = []
          const revisionBefore = harness.ledger.snapshot.revision
          const control = { ...(graphCase.control as Record<string, unknown>) }
          control[mutationCase.field] = mutationCase.mutate()
          const receipt = await runWorkExecution(harness.client, {
            runnerPath,
            graphPath: graphCase.graphPath,
            projectId,
            executionId: `exec-malformed-${graphCase.label}-${mutationCase.label}`,
            attemptId: '1',
            intent: { control: control as never, ...(mutationCase.field === 'business' ? {} : { business: graphCase.business }) },
            onHostCall: frame => hostCalls.push(frame),
          })

          expect(receipt.status).toBe('failed')
          expect(receipt.control.error?.code).toBe('INVALID_INPUT')
          expect(receipt.control.error?.message).toContain(mutationCase.label)
          expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
          expect(hostCalls).toHaveLength(0)
          expect(receipt.evidence.hostOperations).toHaveLength(0)
          expect(harness.ledger.snapshot.revision).toBe(revisionBefore)
          expect(harness.ledger.snapshot.works).toHaveLength(0)
          expect(harness.ledger.snapshot.requests).toHaveLength(0)
          expect(harness.ledger.snapshot.allocations).toHaveLength(0)
          expect(harness.executeCount()).toBe(0)
          evidence.push({ case: `malformed-input-${graphCase.label}-${mutationCase.label}`, receipt })
        }
      }
      for (const graphCase of queryOnlyCases) {
        const hostCalls: HostCallFrame[] = []
        const revisionBefore = harness.ledger.snapshot.revision
        const receipt = await runWorkExecution(harness.client, {
          runnerPath,
          graphPath: graphCase.graphPath,
          projectId,
          executionId: `exec-query-only-${graphCase.label}`,
          attemptId: '1',
          intent: { control: graphCase.control },
          onHostCall: frame => hostCalls.push(frame),
        })
        expect(receipt.status).toBe('failed')
        expect(receipt.control.error?.code).toBe(graphCase.expected)
        if (graphCase.message.length > 0) expect(receipt.control.error?.message).toContain(graphCase.message)
        if (graphCase.noEffect) {
          expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
          expect(hostCalls).toHaveLength(0)
          expect(receipt.evidence.hostOperations).toHaveLength(0)
          expect(harness.ledger.snapshot.revision).toBe(revisionBefore)
          expect(harness.ledger.snapshot.works).toHaveLength(0)
          expect(harness.ledger.snapshot.requests).toHaveLength(0)
          expect(harness.ledger.snapshot.allocations).toHaveLength(0)
          expect(harness.executeCount()).toBe(0)
        } else {
          expect(hostCalls.map(call => call.control.operation)).toEqual(['agentWork.findProvider', 'agentWork.open', 'agentWork.close', 'agentWork.dispose'])
        }
        evidence.push({ case: `query-only-${graphCase.label}`, receipt })
      }
    } finally {
      await harness.stop()
    }
  }, 45_000)

  it('rejects missing Operators and missing effects at compile with zero business effects', async () => {
    const harness = await startHarness()
    try {
      const revisionBefore = harness.ledger.snapshot.revision
      const mutated = JSON.parse(readFileSync(agentWorkGraph, 'utf8')) as { nodes: { operator: string }[] }
      mutated.nodes[0].operator = 'teams.missing-operator'
      const mutationDirectory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-graph-'))
      const mutatedPath = join(mutationDirectory, 'missing-operator.graph.json')
      writeFileSync(mutatedPath, `${JSON.stringify(mutated)}\n`)

      const missingOperator = compileGraph(mutatedPath)
      expect(missingOperator.type).toBe('compile.failure')
      expect('message' in missingOperator && missingOperator.message).toContain('missing operator')

      const missingEffects = compileGraph(agentWorkGraph, [])
      expect(missingEffects.type).toBe('compile.failure')
      expect('message' in missingEffects && missingEffects.message).toContain('undeclared capability')

      const submitGraph = compileGraph(agentWorkGraph)
      expect(submitGraph.type).toBe('compile.result')
      expect('node_ids' in submitGraph && submitGraph.node_ids).toEqual(['resolve-service', 'open-link', 'admit-work', 'request-work', 'settle-work'])
      const openGraph = compileGraph(workOpenGraph)
      expect(openGraph.type).toBe('compile.result')
      expect('node_ids' in openGraph && openGraph.node_ids).toEqual(['resolve-service', 'open-link', 'admit-work', 'request-work', 'return-held-work'])
      const requestGraph = compileGraph(workRequestGraph)
      expect(requestGraph.type).toBe('compile.result')
      expect('node_ids' in requestGraph && requestGraph.node_ids).toEqual(['resolve-service', 'open-link', 'continue-work', 'return-held-work'])
      const closeGraph = compileGraph(workCloseGraph)
      expect(closeGraph.type).toBe('compile.result')
      expect('node_ids' in closeGraph && closeGraph.node_ids).toEqual(['resolve-service', 'open-link', 'close-work'])
      const queryGraph = compileGraph(workQueryGraph)
      expect(queryGraph.type).toBe('compile.result')
      expect('node_ids' in queryGraph && queryGraph.node_ids).toEqual(['resolve-service', 'open-link', 'query-request', 'return-observation'])

      expect(harness.ledger.snapshot.revision).toBe(revisionBefore)
      expect(harness.ledger.snapshot.works).toHaveLength(0)
      expect(harness.ledger.snapshot.requests).toHaveLength(0)
      expect(harness.executeCount()).toBe(0)

      evidence.push({ case: 'compile-rejections', missingOperator, missingEffects, submitGraph, openGraph, requestGraph, closeGraph, queryGraph })
      rmSync(mutationDirectory, { recursive: true, force: true })
    } finally {
      await harness.stop()
    }
  }, 30_000)

  it('surfaces provider permission, operation and generation rejections explicitly', async () => {
    const forbidden = await startHarness({ authorizeWork: () => false })
    const unsupported = await startHarness()
    const stale = await startHarness()
    try {
      const denied = await runWorkExecution(forbidden.client, {
        runnerPath,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-forbidden',
        attemptId: '1',
        intent: { control: submitControl('work-forbidden', 'req-forbidden'), business: { query: 'alpha marker' } },
      })
      expect(denied.status).toBe('failed')
      expect(denied.control.error?.code).toBe('FORBIDDEN')
      expect(denied.cleanup.channelsOpened).toBe(1)
      expect(denied.cleanup.channelsDisposed).toBe(1)
      expect(forbidden.ledger.snapshot.works).toHaveLength(1)
      expect(forbidden.ledger.snapshot.works[0].state).toBe('rejected')
      expect(forbidden.ledger.snapshot.requests).toHaveLength(0)

      const wrongOperation = await runWorkExecution(unsupported.client, {
        runnerPath,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-unsupported',
        attemptId: '1',
        intent: { control: submitControl('work-unsupported', 'req-unsupported', 'read'), business: { query: 'alpha marker' } },
      })
      expect(wrongOperation.status).toBe('failed')
      expect(wrongOperation.control.error?.code).toBe('UNSUPPORTED_OPERATION')
      expect(wrongOperation.cleanup.channelsOpened).toBe(0)
      expect(unsupported.ledger.snapshot.works).toHaveLength(0)

      const staleClient: AgentWorkClient = {
        ...stale.client,
        findProvider: async input => {
          const target = await stale.client.findProvider(input)
          return { ...target, generation: target.generation + 1 }
        },
      }
      const staleGeneration = await runWorkExecution(staleClient, {
        runnerPath,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-stale',
        attemptId: '1',
        intent: { control: submitControl('work-stale', 'req-stale'), business: { query: 'alpha marker' } },
      })
      expect(staleGeneration.status).toBe('failed')
      expect(staleGeneration.control.error?.code).toBe('STALE_GENERATION')
      expect(staleGeneration.cleanup.channelsOpened).toBe(0)
      expect(stale.ledger.snapshot.works).toHaveLength(0)

      evidence.push({ case: 'rejections', denied, wrongOperation, staleGeneration })
    } finally {
      await forbidden.stop()
      await unsupported.stop()
      await stale.stop()
    }
  }, 30_000)

  it('projects a provider typed refusal from control.reply.error when no close error exists', async () => {
    const harness = await startHarness()
    try {
      const refused = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-resource-refused',
        attemptId: '1',
        intent: {
          control: {
            ...submitControl('work-refused', 'req-refused'),
            demands: [{ resourceId: 'search-slot', amount: 3 }],
          },
          business: { query: 'alpha marker' },
        },
      })

      expect(refused.control.error).toEqual({ code: 'RESOURCE_EXHAUSTED', message: 'resource search-slot capacity exhausted' })
      expect(refused.status).toBe('completed')
      expect(refused.control.requestState).toBe('failed')
      expect(refused.control.workClosure).toBe('closed')
      expect(refused.business).toBeUndefined()
      expect(refused.cleanup).toEqual({ channelsOpened: 1, channelsDisposed: 1 })
      expect(harness.executeCount()).toBe(0)
      expect(harness.ledger.snapshot.works.map(work => work.state)).toEqual(['closed'])
      expect(harness.ledger.snapshot.requests.map(request => request.state)).toEqual(['failed'])

      evidence.push({ case: 'provider-typed-refusal', refused })
    } finally {
      await harness.stop()
    }
  }, 30_000)

  it('keeps the close failure precedence over a provider typed refusal in one receipt', async () => {
    const harness = await startHarness()
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-close-precedence-'))
    const closePrecedenceRunner = join(fixtureDirectory, 'close-precedence-runner.mjs')
    const executionId = 'exec-close-precedence'
    try {
      const frame = {
        type: 'execution.result',
        identity: {
          project_id: projectId,
          graph_id: 'agentteams.agent-work',
          graph_version: '2',
          execution_id: executionId,
          attempt_id: '1',
        },
        compiled: {
          id: 'agentteams.agent-work',
          version: '2',
          node_ids: ['resolve-service', 'open-link', 'admit-work', 'request-work', 'settle-work'],
          input_arcs: ['work.intent'],
          output_arcs: ['work.receipt'],
        },
        outputs: {
          'work.receipt': {
            id: 'work.receipt',
            version: 1,
            schema: 'Object',
            payload: {
              control: {
                workId: 'work-close-precedence',
                requestId: 'req-close-precedence',
                requestState: 'failed',
                workClosure: 'close-failed',
                closeError: { code: 'CLOSE_LINK_LOST', message: 'close reply deadline elapsed' },
                reply: { state: 'failed', error: { code: 'RESOURCE_EXHAUSTED', message: 'resource search-slot capacity exhausted' } },
              },
            },
          },
        },
        journal: [],
      }
      writeFileSync(closePrecedenceRunner, [
        '#!/usr/bin/env node',
        `process.stdout.write(${JSON.stringify(`${JSON.stringify(frame)}\n`)});`,
        'process.stdin.resume();',
        "process.stdin.on('end', () => process.exit(0));",
        '',
      ].join('\n'), { mode: 0o755 })

      const receipt = await runWorkExecution(harness.client, {
        runnerPath: closePrecedenceRunner,
        graphPath: agentWorkGraph,
        projectId,
        executionId,
        attemptId: '1',
        intent: { control: submitControl('work-close-precedence', 'req-close-precedence'), business: { query: 'alpha marker' } },
      })

      expect(receipt.status).toBe('failed')
      expect(receipt.control.workClosure).toBe('close-failed')
      expect(receipt.control.error).toEqual({ code: 'CLOSE_LINK_LOST', message: 'close reply deadline elapsed' })
      expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
      expect(harness.ledger.snapshot.works).toHaveLength(0)
      expect(harness.ledger.snapshot.requests).toHaveLength(0)

      evidence.push({ case: 'close-error-precedence', receipt })
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true })
      await harness.stop()
    }
  }, 20_000)

  it('fails explicitly on host EOF and makes no further host call', async () => {
    const intent = { control: submitControl('work-eof', 'req-eof'), business: { query: 'alpha marker' } }
    const child = spawn(runnerPath, ['run', '--graph', agentWorkGraph, '--project-id', projectId,
      '--execution-id', 'exec-eof', '--attempt-id', '1', '--input', JSON.stringify(intent)], { stdio: ['pipe', 'pipe', 'pipe'] })
    let hostCalls = 0
    let final: RunnerFinalFrame | undefined
    const closed = new Promise<number | null>(resolveClose => child.on('close', code => resolveClose(code)))
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      const frame = JSON.parse(line) as { type: string }
      if (frame.type === 'host.call') {
        hostCalls += 1
        child.stdin.end()
      } else {
        final = frame as RunnerFinalFrame
      }
    }
    expect(await closed).toBe(0)
    expect(hostCalls).toBe(1)
    expect(final?.type).toBe('execution.failure')
    expect(final && 'message' in final && final.message).toContain('host EOF')
    expect(final && 'kind' in final && final.kind).toBe('operator')
    evidence.push({ case: 'host-eof', hostCalls, final })
  }, 20_000)

  it('rejects a bad host-call correlation on the real stdio port without any Work effect', async () => {
    const harness = await startHarness()
    try {
      const receipt = await runWorkExecution(harness.client, {
        runnerPath: badCorrelationRunner,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-bad-correlation',
        attemptId: '1',
        intent: { control: submitControl('work-bad-correlation', 'req-bad-correlation'), business: { query: 'alpha marker' } },
      })
      expect(receipt.status).toBe('failed')
      expect(receipt.control.error?.code).toBe('HOST_PROTOCOL')
      expect(receipt.control.error?.message).toContain('request_id mismatch')
      expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
      expect(harness.ledger.snapshot.works).toHaveLength(0)
      expect(harness.ledger.snapshot.requests).toHaveLength(0)
      expect(harness.executeCount()).toBe(0)
      evidence.push({ case: 'bad-correlation', receipt })
    } finally {
      await harness.stop()
    }
  }, 20_000)

  it('returns completed for only one valid correlated execution.result and preserves its business', async () => {
    const harness = await startHarness()
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-valid-final-runner-'))
    const pidFile = join(fixtureDirectory, 'runner.pid')
    try {
      process.env.TEAMS_D3_U4_MALFORMED_FINAL = 'valid-only'
      process.env.TEAMS_D3_U4_PID_FILE = pidFile
      const receipt = await runWorkExecution(harness.client, {
        runnerPath: malformedFinalRunner,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-bad-final',
        attemptId: '1',
        intent: { control: submitControl('work-bad-final', 'req-bad-final'), business: { query: 'alpha marker' } },
      })

      expect(receipt.status).toBe('completed')
      expect(receipt.control.error).toBeUndefined()
      expect(receipt.control).toMatchObject({
        workId: 'work-bad-final',
        requestId: 'req-bad-final',
        providerAgentId: 'provider',
        requestState: 'succeeded',
        workClosure: 'closed',
      })
      expect(receipt.business).toEqual({ query: 'fixture marker' })
      expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
      expect(receipt.evidence.hostOperations).toHaveLength(0)
      expect(harness.ledger.snapshot.works).toHaveLength(0)
      expect(harness.ledger.snapshot.requests).toHaveLength(0)
      expect(harness.executeCount()).toBe(0)

      expect(existsSync(pidFile)).toBe(true)
      const runnerPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isSafeInteger(runnerPid)).toBe(true)
      expect(() => process.kill(runnerPid, 0)).toThrow()
      evidence.push({ case: 'valid-only-terminal', receipt, runnerPid })
    } finally {
      delete process.env.TEAMS_D3_U4_MALFORMED_FINAL
      delete process.env.TEAMS_D3_U4_PID_FILE
      rmSync(fixtureDirectory, { recursive: true, force: true })
      await harness.stop()
    }
  }, 20_000)

  for (const [kind, message] of [
    ['malformed-json', 'not JSON'],
    ['missing-control', 'lacks control object'],
    ['unknown-frame', 'unsupported type'],
  ] as const) {
    it(`rejects ${kind} from the real runner port and terminates the exact child`, async () => {
      const harness = await startHarness()
      const fixtureDirectory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-invalid-runner-'))
      const pidFile = join(fixtureDirectory, 'runner.pid')
      try {
        process.env.TEAMS_D3_U4_INVALID_FRAME = kind
        process.env.TEAMS_D3_U4_PID_FILE = pidFile
        let receipt: ProjectExecutionReceipt | undefined
        let rejection: unknown
        try {
          receipt = await runWorkExecution(harness.client, {
            runnerPath: invalidFrameRunner,
            graphPath: agentWorkGraph,
            projectId,
            executionId: `exec-invalid-${kind}`,
            attemptId: '1',
            intent: { control: submitControl(`work-invalid-${kind}`, `req-invalid-${kind}`), business: { query: 'alpha marker' } },
          })
        } catch (error) {
          rejection = error
        }

        expect(rejection).toBeUndefined()
        expect(receipt?.status).toBe('failed')
        expect(receipt?.control.error?.code).toBe('HOST_PROTOCOL')
        expect(receipt?.control.error?.message).toContain(message)
        expect(receipt?.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
        expect(harness.ledger.snapshot.works).toHaveLength(0)
        expect(harness.ledger.snapshot.requests).toHaveLength(0)
        expect(harness.executeCount()).toBe(0)

        expect(existsSync(pidFile)).toBe(true)
        const runnerPid = Number(readFileSync(pidFile, 'utf8').trim())
        expect(Number.isSafeInteger(runnerPid)).toBe(true)
        expect(() => process.kill(runnerPid, 0)).toThrow()
        evidence.push({ case: `invalid-runner-${kind}`, receipt, runnerPid })
      } finally {
        delete process.env.TEAMS_D3_U4_INVALID_FRAME
        delete process.env.TEAMS_D3_U4_PID_FILE
        rmSync(fixtureDirectory, { recursive: true, force: true })
        await harness.stop()
      }
    }, 20_000)
  }

  for (const [kind, message] of [
    ['execution-result-missing-compiled', 'lacks execution.result.compiled'],
    ['execution-result-missing-identity', 'lacks execution.result.identity'],
    ['execution-result-missing-journal', 'lacks execution.result.journal'],
    ['execution-result-bad-identity', 'identity mismatch'],
    ['duplicate-final', 'runner emitted a second terminal frame'],
    ['malformed-after-valid-result', 'unsupported type'],
    ['host-call-after-valid-result', 'host.call after its terminal frame'],
  ] as const) {
    it(`returns one HOST_PROTOCOL receipt for malformed terminal frame ${kind} and terminates the exact child`, async () => {
      const harness = await startHarness()
      const fixtureDirectory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-malformed-final-runner-'))
      const pidFile = join(fixtureDirectory, 'runner.pid')
      try {
        process.env.TEAMS_D3_U4_MALFORMED_FINAL = kind
        process.env.TEAMS_D3_U4_PID_FILE = pidFile
        const receipt = await runWorkExecution(harness.client, {
          runnerPath: malformedFinalRunner,
          graphPath: agentWorkGraph,
          projectId,
          executionId: 'exec-bad-final',
          attemptId: '1',
          intent: { control: submitControl('work-bad-final', 'req-bad-final'), business: { query: 'alpha marker' } },
        })

        expect(receipt.status).toBe('failed')
        expect(receipt.control.error?.code).toBe('HOST_PROTOCOL')
        expect(receipt.control.error?.message).toContain(message)
        expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
        expect(receipt.evidence.hostOperations).toHaveLength(0)
        expect(harness.ledger.snapshot.works).toHaveLength(0)
        expect(harness.ledger.snapshot.requests).toHaveLength(0)
        expect(harness.executeCount()).toBe(0)

        expect(existsSync(pidFile)).toBe(true)
        const runnerPid = Number(readFileSync(pidFile, 'utf8').trim())
        expect(Number.isSafeInteger(runnerPid)).toBe(true)
        expect(() => process.kill(runnerPid, 0)).toThrow()
        evidence.push({ case: `malformed-final-${kind}`, receipt, runnerPid })
      } finally {
        delete process.env.TEAMS_D3_U4_MALFORMED_FINAL
        delete process.env.TEAMS_D3_U4_PID_FILE
        rmSync(fixtureDirectory, { recursive: true, force: true })
        await harness.stop()
      }
    }, 20_000)
  }

  it('returns an explicit runner failure and cleans up when the runner exits before the host response', async () => {
    const harness = await startHarness()
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'teams-d3-u4-early-exit-runner-'))
    const pidFile = join(fixtureDirectory, 'runner.pid')
    try {
      process.env.TEAMS_D3_U4_PID_FILE = pidFile
      const receipt = await runWorkExecution(harness.client, {
        runnerPath: earlyExitRunner,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-early-exit',
        attemptId: '1',
        intent: { control: submitControl('work-early-exit', 'req-early-exit'), business: { query: 'alpha marker' } },
      })

      expect(receipt.status).toBe('failed')
      expect(receipt.control.error?.code).toBe('EXECUTION_FAILED')
      expect(receipt.control.error?.message).toContain('without a final frame')
      expect(receipt.cleanup).toEqual({ channelsOpened: 0, channelsDisposed: 0 })
      expect(harness.ledger.snapshot.works).toHaveLength(0)
      expect(harness.ledger.snapshot.requests).toHaveLength(0)
      expect(harness.executeCount()).toBe(0)

      expect(existsSync(pidFile)).toBe(true)
      const runnerPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isSafeInteger(runnerPid)).toBe(true)
      expect(() => process.kill(runnerPid, 0)).toThrow()
      evidence.push({ case: 'early-exit-before-host-response', receipt, runnerPid })
    } finally {
      delete process.env.TEAMS_D3_U4_PID_FILE
      rmSync(fixtureDirectory, { recursive: true, force: true })
      await harness.stop()
    }
  }, 20_000)

  it('returns an explicit unknown result with retained provider responsibility when the request link drops', async () => {
    const harness = await startHarness({ dropReplyForWorkId: 'work-drop' })
    try {
      const receipt = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: agentWorkGraph,
        projectId,
        executionId: 'exec-drop',
        attemptId: '1',
        intent: { control: submitControl('work-drop', 'req-drop'), business: { query: 'alpha marker' } },
      })
      expect(receipt.status).toBe('failed')
      expect(receipt.control.error?.code).toBe('RESULT_UNKNOWN')
      expect(receipt.control.deliveryState).toBe('unconfirmed')
      expect(receipt.control.requestState).toBeUndefined()
      expect(receipt.control.workClosure).toBeUndefined()
      expect(receipt.cleanup.channelsOpened).toBe(1)
      expect(receipt.cleanup.channelsDisposed).toBe(1)
      expect(scheduledNodes(receipt)).toEqual(['resolve-service', 'open-link', 'admit-work', 'request-work'])
      expect(receipt.evidence.nodeCompletion).toEqual(['resolve-service', 'open-link', 'admit-work'])

      const requestsForWork = harness.ledger.snapshot.requests.filter(request => request.control.workId === 'work-drop')
      expect(requestsForWork).toHaveLength(1)
      expect(harness.ledger.snapshot.works.find(work => work.workId === 'work-drop')?.state).toBe('accepted')
      await waitFor(() => harness.ledger.snapshot.requests.find(request => request.control.workId === 'work-drop')?.state === 'succeeded')

      const revisionBeforeQuery = harness.ledger.snapshot.revision
      const observed = await runWorkExecution(harness.client, {
        runnerPath,
        graphPath: workQueryGraph,
        projectId,
        executionId: 'exec-drop-query',
        attemptId: '1',
        intent: { control: queryControl('work-drop', 'req-drop') },
      })
      expect(observed.status).toBe('completed')
      expect(observed.control.requestState).toBe('succeeded')
      expect(observed.control.workClosure).toBeUndefined()
      expect(observed.business).toMatchObject({ matches: [expect.objectContaining({ path: './alpha.txt' })] })
      expect(harness.ledger.snapshot.revision).toBe(revisionBeforeQuery)
      expect(harness.ledger.snapshot.requests.filter(request => request.control.workId === 'work-drop')).toHaveLength(1)
      expect(harness.executeCount()).toBe(1)

      evidence.push({ case: 'link-drop-retained', receipt, observed })
    } finally {
      await harness.stop()
    }
  }, 30_000)
})
