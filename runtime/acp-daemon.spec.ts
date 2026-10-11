import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpChannelRef, AcpFrame } from '../control-protocol/acp.ts'
import type { EngineLaunchSpec } from '../control-protocol/engine.ts'
import type { AcpPolicyIntent } from '../config/acp-policy.ts'
import type { AcpHost } from '../agent-host/acp-host.ts'
import { createAcpHistoryStore } from './acp-history-store.ts'
import { bootstrapAcpInitialize, startAcpAgentDaemon, startAcpEngineHandle, type AcpAgentDaemon } from './acp-daemon.ts'

const peerPath = fileURLToPath(new URL('../acp-adapter/test-peer.mjs', import.meta.url))
const peerDirectory = dirname(peerPath)

const daemons = new Set<AcpAgentDaemon>()
const directories = new Set<string>()

function launchFor(mode: string): EngineLaunchSpec {
  return {
    executable: process.execPath,
    args: [peerPath, mode],
    cwd: peerDirectory,
    env: { PATH: process.env.PATH ?? '' },
    credentialEnvRefs: {},
    files: [],
    supportedPolicies: [],
  }
}

const intent: AcpPolicyIntent = { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' }

/** Count live OS processes whose command line carries the unique probe marker. */
function matchingProcessCount(marker: string): number {
  try {
    const output = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return output.split('\n').filter(line => line.trim().length > 0).length
  } catch {
    // pgrep exits non-zero when nothing matches.
    return 0
  }
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'acp-daemon-'))
  directories.add(directory)
  return directory
}

function refFor(generation: number, channelId = 'channel-1'): AcpChannelRef {
  return { connectionId: 'connection-1', channelId, targetGeneration: generation, engineInstanceId: 'engine-1' }
}

const principal = { accountId: 'local', scopeId: 'local', agentId: 'peer-agent' } as const

afterEach(async () => {
  for (const daemon of [...daemons]) {
    await daemon.stop()
    daemons.delete(daemon)
  }
  for (const directory of [...directories]) {
    await rm(directory, { recursive: true, force: true })
    directories.delete(directory)
  }
})

async function collect(host: AcpHost, ref: AcpChannelRef, expected: number, timeoutMs = 5_000): Promise<readonly AcpFrame[]> {
  const frames: AcpFrame[] = []
  const deadline = Date.now() + timeoutMs
  while (frames.length < expected && Date.now() < deadline) {
    const page = await host.read(ref, 0, 100)
    frames.push(...page.frames.map(delivery => delivery.frame))
    if (frames.length < expected) await new Promise(resolve => setTimeout(resolve, 5))
  }
  return frames
}

async function startDaemon(input: {
  readonly mode: string
  readonly directory: string
  readonly generation: number
  readonly blacklist?: readonly string[]
  readonly initializeTimeoutMs?: number
}): Promise<Awaited<ReturnType<typeof startAcpAgentDaemon>>> {
  const store = await createAcpHistoryStore({ directory: input.directory })
  return startAcpAgentDaemon({
    launch: launchFor(input.mode),
    engineInstanceId: 'engine-1',
    targetGeneration: input.generation,
    policy: { intent: { ...intent, ...(input.blacklist === undefined ? {} : { blacklist: input.blacklist }) } },
    history: store,
    initialize: { params: { clientCapabilities: {} }, timeoutMs: input.initializeTimeoutMs ?? 5_000 },
    stopTimeoutMs: 2_000,
    agentId: 'agent-a',
  })
}

describe('startAcpEngineHandle', () => {
  it('reports a typed failure when the engine executable does not exist', async () => {
    const outcome = await startAcpEngineHandle({
      launch: { ...launchFor('acp'), executable: join(peerDirectory, 'missing-engine') },
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      stopTimeoutMs: 1_000,
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.fault.code).toBe('ENGINE_UNAVAILABLE')
  })

  it('requires a credential resolver when the launch declares credential env refs', async () => {
    const outcome = await startAcpEngineHandle({
      launch: { ...launchFor('acp'), credentialEnvRefs: { API_KEY: 'env:TEST_KEY' } },
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      stopTimeoutMs: 1_000,
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.fault.code).toBe('UNSUPPORTED_CONFIGURATION')
  })

  it('reaps a long-lived engine child and returns real cleanup when a spawn option is invalid', async () => {
    const marker = `acp-orphan-probe-${process.pid}-${Date.now()}`
    expect(matchingProcessCount(marker)).toBe(0)
    const outcome = await startAcpEngineHandle({
      launch: {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)', marker],
        cwd: peerDirectory,
        env: { PATH: process.env.PATH ?? '' },
        credentialEnvRefs: {},
        files: [],
        supportedPolicies: [],
      },
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      stopTimeoutMs: 2_000,
      maxFrameBytes: 0,
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.fault.code).toBe('UNSUPPORTED_CONFIGURATION')
    expect(outcome.cleanup).toMatchObject({ kind: 'exited' })
    // The genuinely long-lived child must be gone from the OS process table.
    expect(matchingProcessCount(marker)).toBe(0)
  })

  it('stops a started handle with a typed exit outcome', async () => {
    const started = await startAcpEngineHandle({
      launch: launchFor('acp'),
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      stopTimeoutMs: 2_000,
    })
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    const stopped = await started.handle.stop()
    expect(stopped).toMatchObject({ kind: 'exited' })
    await expect(started.handle.exited).resolves.toMatchObject({})
    expect(await started.handle.stop()).toEqual(stopped)
  })
})

describe('bootstrapAcpInitialize', () => {
  it('fails as a typed outcome when the engine exits before initialize completes', async () => {
    const started = await startAcpEngineHandle({
      launch: launchFor('crash'),
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      stopTimeoutMs: 2_000,
    })
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    const outcome = await bootstrapAcpInitialize(started.handle, { timeoutMs: 2_000 })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.fault.code).toBe('ENGINE_UNAVAILABLE')
    await started.handle.stop()
  })

  it('times out a silent engine as a typed outcome', async () => {
    const started = await startAcpEngineHandle({
      launch: launchFor('silent'),
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      stopTimeoutMs: 2_000,
    })
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    const outcome = await bootstrapAcpInitialize(started.handle, { timeoutMs: 150 })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.fault.message).toContain('timed out')
    expect(await started.handle.stop()).toMatchObject({ kind: 'exited' })
  })
})

describe('startAcpAgentDaemon', () => {
  it('starts a real engine child and serves channels from one bootstrap initialize', async () => {
    const store = await createAcpHistoryStore({ directory: await tempDirectory() })
    const outcome = await startAcpAgentDaemon({
      launch: launchFor('acp'),
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      policy: { intent },
      history: store,
      initialize: { params: { clientCapabilities: {} }, timeoutMs: 5_000 },
      stopTimeoutMs: 2_000,
      agentId: 'agent-a',
    })
    expect(outcome.kind).toBe('started')
    if (outcome.kind !== 'started') return
    daemons.add(outcome.daemon)
    expect(outcome.daemon.initializeResult).toMatchObject({ result: { protocolVersion: 1 } })
    expect(outcome.daemon.handle.pid).toBeGreaterThan(0)

    const ref = refFor(1)
    await outcome.daemon.host.open({ ref, principal, policy: outcome.daemon.policy })
    await outcome.daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { clientCapabilities: {} } } })
    const [init] = await collect(outcome.daemon.host, ref, 1)
    expect(init.id).toBe('init-1')
    expect(init.result).toMatchObject({ protocolVersion: 1 })

    await outcome.daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } } })
    const [session] = await collect(outcome.daemon.host, ref, 1)
    expect(session.id).toBe(1)
    const sessionId = (session.result as { sessionId: string }).sessionId

    await outcome.daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } } })
    const updates = await collect(outcome.daemon.host, ref, 2)
    expect(updates[0].method).toBe('session/update')
    expect(updates[1].id).toBe(2)
    expect(updates[1].result).toMatchObject({ stopReason: 'end_turn' })

    const history = await store.query({ version: 1, limit: 100 })
    expect(history.records.filter(item => item.event === 'initialize')).toHaveLength(1)
    expect(history.records.some(item => item.event === 'result.unmatched')).toBe(false)
  })

  it('reports a typed start failure with no orphan child when the engine crashes', async () => {
    const outcome = await startDaemon({ mode: 'crash', directory: await tempDirectory(), generation: 1 })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.fault.code).toBe('ENGINE_UNAVAILABLE')
      expect(outcome.cleanup).toMatchObject({ kind: 'exited' })
    }
  })

  it('keeps history across an owner restart and does not rebuild pending work', async () => {
    const directory = await tempDirectory()
    const first = await startDaemon({ mode: 'acp', directory, generation: 1 })
    expect(first.kind).toBe('started')
    if (first.kind !== 'started') return
    daemons.add(first.daemon)
    const refOne = refFor(1, 'channel-1')
    await first.daemon.host.open({ ref: refOne, principal, policy: first.daemon.policy })
    await first.daemon.host.receive({ ...refOne, frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })
    await collect(first.daemon.host, refOne, 1)
    await first.daemon.host.receive({ ...refOne, frame: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } } })
    const [session] = await collect(first.daemon.host, refOne, 1)
    await first.daemon.host.receive({
      ...refOne,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: (session.result as { sessionId: string }).sessionId, prompt: [{ type: 'text', text: 'first run' }] } },
    })
    await collect(first.daemon.host, refOne, 2)
    await first.daemon.stop()
    daemons.delete(first.daemon)

    const second = await startDaemon({ mode: 'acp', directory, generation: 2 })
    expect(second.kind).toBe('started')
    if (second.kind !== 'started') return
    daemons.add(second.daemon)
    const refTwo = refFor(2, 'channel-1')
    await expect(second.daemon.host.receive({
      ...refOne,
      frame: { jsonrpc: '2.0', id: 1, method: 'session/new', params: {} },
    })).rejects.toMatchObject({ code: 'STALE_GENERATION' })

    await second.daemon.host.open({ ref: refTwo, principal, policy: second.daemon.policy })
    await second.daemon.host.receive({ ...refTwo, frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })
    await collect(second.daemon.host, refTwo, 1)
    await second.daemon.host.receive({ ...refTwo, frame: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } } })
    const [fresh] = await collect(second.daemon.host, refTwo, 1)
    await second.daemon.host.receive({
      ...refTwo,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: (fresh.result as { sessionId: string }).sessionId, prompt: [{ type: 'text', text: 'second run' }] } },
    })
    const updates = await collect(second.daemon.host, refTwo, 2)
    expect(updates[1].result).toMatchObject({ stopReason: 'end_turn' })

    const store = await createAcpHistoryStore({ directory })
    const page = await store.query({ version: 1, limit: 100 })
    const sequences = page.records.map(item => item.sequence)
    expect(sequences.length).toBeGreaterThan(3)
    expect(new Set(sequences).size).toBe(sequences.length)
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toBeLessThan(sequences[index - 1])
    }
    expect(page.records.some(item => item.event === 'request.dispatched' && item.sessionId?.startsWith('test-peer-session-'))).toBe(true)
    expect(page.records.filter(item => item.event === 'result.received').length).toBeGreaterThanOrEqual(2)
  })

  it('rejects a blacklisted capability before the engine write', async () => {
    const directory = await tempDirectory()
    const outcome = await startDaemon({ mode: 'acp', directory, generation: 1, blacklist: ['capability:/promptCapabilities/image'] })
    expect(outcome.kind).toBe('started')
    if (outcome.kind !== 'started') return
    daemons.add(outcome.daemon)
    const ref = refFor(1)
    await outcome.daemon.host.open({ ref, principal, policy: outcome.daemon.policy })
    await outcome.daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })
    await collect(outcome.daemon.host, ref, 1)
    await outcome.daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } } })
    const [session] = await collect(outcome.daemon.host, ref, 1)
    const sessionId = (session.result as { sessionId: string }).sessionId

    await expect(outcome.daemon.host.receive({
      ...ref,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'image', data: 'x' }] } },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

    const store = await createAcpHistoryStore({ directory })
    expect((await store.query({ version: 1, limit: 100 })).records.filter(item => item.event === 'request.dispatched')).toHaveLength(1)

    await outcome.daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'allowed' }] } } })
    const updates = await collect(outcome.daemon.host, ref, 2)
    expect(updates[1].id).toBe(3)
  })

  it('surfaces a durable history write failure through the live host', async () => {
    const directory = await tempDirectory()
    const store = await createAcpHistoryStore({ directory })
    const outcome = await startAcpAgentDaemon({
      launch: launchFor('acp'),
      engineInstanceId: 'engine-1',
      targetGeneration: 1,
      policy: { intent },
      history: store,
      initialize: { params: { clientCapabilities: {} }, timeoutMs: 5_000 },
      stopTimeoutMs: 2_000,
    })
    expect(outcome.kind).toBe('started')
    if (outcome.kind !== 'started') return
    daemons.add(outcome.daemon)
    const ref = refFor(1)
    await outcome.daemon.host.open({ ref, principal, policy: outcome.daemon.policy })
    await outcome.daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })
    await collect(outcome.daemon.host, ref, 1)

    await rm(store.path, { force: true })
    await mkdir(store.path)
    await expect(outcome.daemon.host.receive({
      ...ref,
      frame: { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } },
    })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    expect((await store.query({ version: 1, limit: 100 })).records.some(item => item.event === 'request.dispatched')).toBe(false)
  })
})
