import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpChannelRef, AcpFrame } from '../../packages/shared/src/acp.ts'
import type { AcpPolicyIntent } from '../../config/acp-policy.ts'
import type { VersionedRuntimeConfig } from '../../config/runtime-config.ts'
import { openCodeAcpAdapter } from '../src/acp-engine.ts'
import { createAcpHistoryStore } from '../../runtime/acp-history-store.ts'
import { startAcpAgentDaemon, type AcpAgentDaemon } from '../../runtime/acp-daemon.ts'

/**
 * Real-process evidence: the installed OpenCode ACP server is spawned through
 * the D02 adapter + D01 runtime, and every ACP exchange below is a genuine
 * frame from that process. The model provider is a local OpenAI-compatible
 * stub, so no external credential or network is used; the engine routing,
 * Session, update, permission and cancel semantics are real.
 */
const EXECUTABLE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const engineAvailable = existsSync(EXECUTABLE)

const intent: AcpPolicyIntent = { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' }
const principal = { accountId: 'local', scopeId: 'local', agentId: 'peer-agent' } as const
const ref: AcpChannelRef = { connectionId: 'connection-1', channelId: 'channel-1', targetGeneration: 3, engineInstanceId: 'engine-1' }

interface PlanInput {
  readonly call: number
  readonly toolNames: readonly string[]
}

type Plan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly args: Readonly<Record<string, string>> }
  | { readonly kind: 'slow'; readonly text: string; readonly delayMs: number }

interface StubProvider {
  readonly baseUrl: string
  readonly calls: { readonly model: string; readonly toolNames: readonly string[] }[]
  close(): Promise<void>
}

async function startProvider(plan: (input: PlanInput) => Plan): Promise<StubProvider> {
  const calls: { model: string; toolNames: readonly string[] }[] = []
  let toolCalls = 0
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { model?: string; tools?: readonly { function?: { name?: string } }[] }
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '').filter(name => name.length > 0)
      calls.push({ model: parsed.model ?? '', toolNames })
      const decided = plan({ call: calls.length, toolNames })
      const model = parsed.model ?? 'probe-model'
      const chunk = (delta: unknown) => `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (decided.kind === 'tool') {
        toolCalls += 1
        response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_probe_${toolCalls}`, type: 'function', function: { name: decided.tool, arguments: JSON.stringify(decided.args) } }] }))
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      if (decided.kind === 'slow') {
        response.write(chunk({ role: 'assistant', content: 'PROBE-START' }))
        setTimeout(() => { response.write(chunk({ content: decided.text })); response.write(finish); response.end('data: [DONE]\n\n') }, decided.delayMs)
        return
      }
      response.write(chunk({ role: 'assistant', content: decided.text }))
      response.write(finish)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub provider did not bind a port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function acceptedConfig(baseUrl: string): VersionedRuntimeConfig {
  return {
    revision: 9,
    acceptedRevision: 9,
    effectiveRevision: 9,
    providers: {
      probe: { id: 'probe', label: 'Probe', protocol: 'openai-chat', apiBaseUrl: baseUrl, enabled: true, auth: { kind: 'bearer', credentialRef: 'env:PROBE_API_KEY' } },
    },
    catalogs: {
      probe: { state: 'ready', entries: [{ ref: { providerInstanceId: 'probe', modelId: 'probe-model' }, origin: 'manual', base: {}, overrides: {} }] },
    },
    agents: { 'agent-a': { primary: { providerInstanceId: 'probe', modelId: 'probe-model' } } },
  }
}

const daemons = new Set<AcpAgentDaemon>()
const directories = new Set<string>()
const providers = new Set<StubProvider>()

afterEach(async () => {
  for (const daemon of [...daemons]) { await daemon.stop(); daemons.delete(daemon) }
  for (const provider of [...providers]) { await provider.close(); providers.delete(provider) }
  for (const directory of [...directories]) { await rm(directory, { recursive: true, force: true }); directories.delete(directory) }
})

async function startRealDaemon(input: {
  readonly plan: (input: PlanInput) => Plan
  readonly blacklist?: readonly string[]
}) {
  const provider = await startProvider(input.plan)
  providers.add(provider)
  const directory = await mkdtemp(join(tmpdir(), 'd02-real-'))
  directories.add(directory)
  const owned = join(directory, 'engine')
  const launchInput = {
    kind: 'opencode' as const,
    executable: EXECUTABLE,
    workspace: directory,
    ownedDirectory: owned,
    target: { agentId: 'agent-a', targetGeneration: 3, acceptedRevision: 9, acceptedSourceRevision: 5, acceptedSourceHash: 'hash', endpointFingerprint: 'endpoint' },
    accepted: acceptedConfig(provider.baseUrl),
    policy: { ...intent, ...(input.blacklist === undefined ? {} : { blacklist: input.blacklist }) },
  }
  const launch = await openCodeAcpAdapter.compileLaunch(launchInput)
  const store = await createAcpHistoryStore({ directory })
  const outcome = await startAcpAgentDaemon({
    launch,
    engineInstanceId: 'engine-1',
    targetGeneration: 3,
    policy: {
      intent: launchInput.policy,
      adapterMethods: openCodeAcpAdapter.declaredMethods,
      enforceablePolicies: openCodeAcpAdapter.enforceablePolicies,
    },
    history: store,
    initialize: { params: { protocolVersion: 1, clientCapabilities: {} }, timeoutMs: 45_000 },
    stopTimeoutMs: 5_000,
    agentId: 'agent-a',
    resolveCredential: async reference => {
      if (reference !== 'env:PROBE_API_KEY') throw new Error(`unexpected credential reference ${reference}`)
      return 'probe-secret-value'
    },
  })
  if (outcome.kind === 'failed') throw new Error(`daemon start failed: ${outcome.fault.code} ${outcome.fault.message}`)
  daemons.add(outcome.daemon)
  await outcome.daemon.host.open({ ref, principal, policy: outcome.daemon.policy })
  return { daemon: outcome.daemon, launchInput, provider, store, directory }
}

async function nextFrames(daemon: AcpAgentDaemon, count = 1, timeoutMs = 30_000): Promise<readonly AcpFrame[]> {
  const frames: AcpFrame[] = []
  const deadline = Date.now() + timeoutMs
  while (frames.length < count && Date.now() < deadline) {
    const page = await daemon.host.read(ref, 0, 200)
    frames.push(...page.frames.map(delivery => delivery.frame))
    if (frames.length < count) await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (frames.length < count) throw new Error(`timed out waiting for ${count} ACP frames (got ${frames.length})`)
  return frames
}

async function awaitFrame(daemon: AcpAgentDaemon, match: (frame: AcpFrame) => boolean, timeoutMs = 60_000): Promise<AcpFrame> {
  const frames = await collectFrames(daemon, match, timeoutMs)
  return frames[frames.length - 1]
}

/** Read every frame up to and including the first match, so no frame is hidden. */
async function collectFrames(daemon: AcpAgentDaemon, match: (frame: AcpFrame) => boolean, timeoutMs = 60_000): Promise<readonly AcpFrame[]> {
  const seen: AcpFrame[] = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = await daemon.host.read(ref, 0, 200)
    for (const delivery of page.frames) {
      seen.push(delivery.frame)
      if (match(delivery.frame)) return seen
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for an ACP frame')
}

async function initializeChannel(daemon: AcpAgentDaemon): Promise<AcpFrame> {
  await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  return awaitFrame(daemon, frame => frame.id === 'init-1')
}

async function newSession(daemon: AcpAgentDaemon): Promise<AcpFrame> {
  await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } } })
  return awaitFrame(daemon, frame => frame.id === 'new-1')
}

function sessionIdOf(frame: AcpFrame): string {
  const result = frame.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('session/new returned no object result')
  const sessionId = (result as Record<string, unknown>).sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session/new returned no sessionId')
  return sessionId
}

describe.skipIf(!engineAvailable)('installed OpenCode ACP engine through the D02 adapter', () => {
  it('runs a real prompt with the accepted model binding and reports the real effective model', { timeout: 90_000 }, async () => {
    const { daemon, launchInput, provider, store } = await startRealDaemon({ plan: () => ({ kind: 'text', text: 'PROBE-REPLY-OK' }) })

    const initialize = await initializeChannel(daemon)
    const initializeResult = initialize.result as Record<string, unknown>
    expect(initializeResult.protocolVersion).toBe(1)
    expect((initializeResult.agentInfo as Record<string, unknown>).version).toBe('1.18.23')

    const created = await newSession(daemon)
    const sessionId = sessionIdOf(created)
    expect(sessionId.startsWith('ses_')).toBe(true)

    // The accepted model binding is proven from the engine's own session/new report.
    const verified = await openCodeAcpAdapter.verifyEffective({
      handle: daemon.handle,
      launch: launchInput,
      initializeResult: initialize,
      sessionConfigResult: created,
    })
    expect(verified.modelTarget).toEqual({ providerInstanceId: 'probe', modelId: 'probe-model' })
    expect(verified.effectiveRevision).toBe(9)

    await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Say PROBE-REPLY-OK' }] } } })
    const result = await awaitFrame(daemon, frame => frame.id === 'prompt-1')
    const resultValue = result.result as Record<string, unknown>
    expect(resultValue.stopReason).toBe('end_turn')

    // The provider really received a request for the configured model.
    expect(provider.calls.some(call => call.model === 'probe-model')).toBe(true)

    const page = await store.query({ version: 1, limit: 100 })
    const events = page.records.map(record => record.event)
    expect(events).toContain('request.dispatched')
    expect(events).toContain('result.received')
    expect(page.records.some(record => record.sessionId === sessionId)).toBe(true)
  })

  it('cancels a real in-flight prompt through the notification form', { timeout: 90_000 }, async () => {
    const { daemon, store } = await startRealDaemon({
      plan: ({ toolNames }) => (toolNames.length === 0 ? { kind: 'text', text: 'title' } : { kind: 'slow', text: 'PROBE-LATE', delayMs: 8_000 }),
    })
    await initializeChannel(daemon)
    const sessionId = sessionIdOf(await newSession(daemon))

    await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'slow' }] } } })
    await nextFrames(daemon, 1)
    await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } } })

    const result = await awaitFrame(daemon, frame => frame.id === 'prompt-1')
    expect((result.result as Record<string, unknown>).stopReason).toBe('cancelled')
    const page = await store.query({ version: 1, limit: 100 })
    expect(page.records.map(record => record.event)).toContain('cancel.requested')
  })

  it('delivers a real permission callback and applies the client reply', { timeout: 90_000 }, async () => {
    let toolCall = 0
    const { daemon, provider } = await startRealDaemon({
      plan: ({ toolNames }) => {
        if (toolNames.length === 0) return { kind: 'text', text: 'title' }
        toolCall += 1
        return toolCall === 1 ? { kind: 'tool', tool: 'read', args: { filePath: '/etc/hosts' } } : { kind: 'text', text: 'PROBE-TOOL-DONE' }
      },
    })
    await initializeChannel(daemon)
    const sessionId = sessionIdOf(await newSession(daemon))

    await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } } })
    const callback = await awaitFrame(daemon, frame => frame.method === 'session/request_permission', 30_000)
    const options = (callback.params as Record<string, unknown>).options as readonly { optionId: string }[]
    expect(options.map(option => option.optionId)).toEqual(['once', 'always', 'reject'])

    await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'once' } } } })
    const result = await awaitFrame(daemon, frame => frame.id === 'prompt-1')
    expect((result.result as Record<string, unknown>).stopReason).toBe('end_turn')
    // The tool result reached the model, so the permission reply really released the tool.
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('enforces a native-tool blacklist before the tool can run', { timeout: 90_000 }, async () => {
    let toolCall = 0
    const { daemon, provider } = await startRealDaemon({
      blacklist: ['internal-tool:opencode:read'],
      plan: ({ toolNames }) => {
        if (toolNames.length === 0) return { kind: 'text', text: 'title' }
        toolCall += 1
        return toolCall === 1 ? { kind: 'tool', tool: 'read', args: { filePath: '/etc/hosts' } } : { kind: 'text', text: 'PROBE-TOOL-DONE' }
      },
    })
    await initializeChannel(daemon)
    const sessionId = sessionIdOf(await newSession(daemon))

    await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } } })
    const frames = await collectFrames(daemon, frame => frame.id === 'prompt-1')
    const result = frames[frames.length - 1]
    expect((result.result as Record<string, unknown>).stopReason).toBe('end_turn')
    // A denied native tool is removed from the engine tool set, so the engine
    // never offers it and never asks the controller for permission.
    const toolRequest = provider.calls.find(call => call.toolNames.length > 0)
    expect(toolRequest?.toolNames).not.toContain('read')
    expect(frames.map(frame => frame.method).filter(method => method === 'session/request_permission')).toEqual([])
  })
})
