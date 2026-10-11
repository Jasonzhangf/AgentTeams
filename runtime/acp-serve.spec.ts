import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer, createConnection, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpFrame } from '../control-protocol/acp.ts'
import type { AcpDuplex } from '../control-protocol/engine.ts'
import { createStdioAcpDuplex } from '../acp-adapter/stdio.ts'
import {
  formatAcpServeReady,
  formatAcpServeStopped,
  readAcpServeIntent,
  resolveOpenCodeExecutable,
  startAcpServe,
  type AcpServeHandle,
} from './acp-serve.ts'

/**
 * `--serve opencode` entry evidence (owner: runtime).
 *
 * The first group is the entry's own contract without an engine: one v4 agent
 * config, explicit CLI overrides, and typed refusals. The second group runs the
 * real installed OpenCode engine through the same entry and drives a real ACP
 * client over the entry's listener; it is skipped only when the installed engine
 * is absent, and the skip is recorded in the receipt.
 */
const EXECUTABLE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const engineAvailable = existsSync(EXECUTABLE)
const PROBE_CREDENTIAL = 'probe-secret-value'

interface StubProvider {
  readonly baseUrl: string
  readonly calls: { readonly model: string; readonly toolNames: readonly string[] }[]
  close(): Promise<void>
}

type Plan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly args: Readonly<Record<string, string>> }
  | { readonly kind: 'slow'; readonly text: string; readonly delayMs: number }

async function startProvider(plan: (input: { readonly call: number; readonly toolNames: readonly string[] }) => Plan): Promise<StubProvider> {
  const calls: { model: string; toolNames: readonly string[] }[] = []
  let toolCalls = 0
  const server: HttpServer = createHttpServer((request, response) => {
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
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub provider did not bind a port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  }
}

async function availableLoopbackPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = listener.address()
  await new Promise<void>(resolveClose => listener.close(() => resolveClose()))
  if (address === null || typeof address === 'string') throw new Error('no loopback port')
  return address.port
}

function agentConfig(input: { readonly baseUrl: string; readonly port: number; readonly executable: string; readonly dataDirectory: string; readonly workspace: string }): string {
  return `version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(input.dataDirectory)}

[engine]
kind = "opencode"
executable = ${JSON.stringify(input.executable)}
workspace = ${JSON.stringify(input.workspace)}

[listen]
ip = "127.0.0.1"
port = ${input.port}

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(input.baseUrl)}
label = "Probe provider"
enabled = true
credentialEnv = "PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`
}

async function writeAgentConfig(input: { readonly baseUrl: string; readonly port: number; readonly executable: string; readonly directory: string }): Promise<string> {
  const configPath = join(input.directory, 'agent.toml')
  await writeFile(configPath, agentConfig({
    baseUrl: input.baseUrl,
    port: input.port,
    executable: input.executable,
    dataDirectory: join(input.directory, 'state'),
    workspace: join(input.directory, 'workspace'),
  }))
  return configPath
}

/** A real ACP client over the entry's listener, reusing the one frame codec. */
interface ServeClient {
  send(frame: AcpFrame): Promise<void>
  awaitFrame(match: (frame: AcpFrame) => boolean, timeoutMs?: number): Promise<AcpFrame>
  close(): Promise<void>
}

async function connectClient(port: number): Promise<ServeClient> {
  const socket: Socket = createConnection({ host: '127.0.0.1', port })
  await new Promise<void>((resolveConnect, reject) => {
    socket.once('connect', () => resolveConnect())
    socket.once('error', reject)
  })
  const duplex: AcpDuplex = createStdioAcpDuplex({ readable: socket, writable: socket })
  const seen: AcpFrame[] = []
  return {
    send: frame => duplex.send(frame),
    awaitFrame: async (match, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        for (let index = 0; index < seen.length; index += 1) {
          if (match(seen[index])) return seen.splice(index, 1)[0]
        }
        if (Date.now() >= deadline) throw new Error('timed out waiting for an ACP frame from the serve listener')
        let frame: AcpFrame
        try {
          frame = await duplex.read()
        } catch {
          throw new Error('the serve listener closed the channel')
        }
        seen.push(frame)
      }
    },
    close: () => duplex.close(),
  }
}

function sessionIdOf(frame: AcpFrame): string {
  const result = frame.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('session/new returned no object result')
  const sessionId = (result as Record<string, unknown>).sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session/new returned no sessionId')
  return sessionId
}

const handles = new Set<AcpServeHandle>()
const clients = new Set<ServeClient>()
const providers = new Set<StubProvider>()
const directories = new Set<string>()

afterEach(async () => {
  for (const client of [...clients]) { await client.close().catch(() => undefined); clients.delete(client) }
  for (const handle of [...handles]) { await handle.stop().catch(() => undefined); handles.delete(handle) }
  for (const provider of [...providers]) { await provider.close(); providers.delete(provider) }
  for (const directory of [...directories]) { await rm(directory, { recursive: true, force: true }); directories.delete(directory) }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'd02-serve-'))
  directories.add(directory)
  return directory
}

describe('--serve opencode entry without an engine', () => {
  it('refuses the quick-start base intent with a typed fault naming the missing binding', async () => {
    const home = await temporaryDirectory()
    await expect(readAcpServeIntent({ engine: 'opencode', ip: '127.0.0.1', port: 7443, home })).rejects.toMatchObject({
      name: 'AcpError',
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('no provider/model binding'),
      detail: { binding: 'model.primary', agentId: 'agent' },
    })
  })

  it('requires --ip and --port for the quick-start entry', async () => {
    const home = await temporaryDirectory()
    await expect(readAcpServeIntent({ engine: 'opencode', home })).rejects.toMatchObject({
      name: 'AcpError',
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('requires --ip and --port'),
    })
  })

  it('rejects --ip without --port', async () => {
    const home = await temporaryDirectory()
    await expect(readAcpServeIntent({ engine: 'opencode', ip: '127.0.0.1', home })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('--ip and --port must be given together'),
    })
  })

  it('refuses --serve dsh because the DSH serve wiring is not delivered', async () => {
    const directory = await temporaryDirectory()
    const port = await availableLoopbackPort()
    const configPath = await writeAgentConfig({ baseUrl: 'http://127.0.0.1:1/v1', port, executable: EXECUTABLE, directory })
    await expect(readAcpServeIntent({ engine: 'dsh', configPath })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('the DSH engine adapter exists at source level'),
    })
  })

  it('refuses a config that declares no [model.primary] binding', async () => {
    const directory = await temporaryDirectory()
    const port = await availableLoopbackPort()
    const configPath = join(directory, 'unbound.toml')
    await writeFile(configPath, `version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(join(directory, 'state'))}

[engine]
kind = "opencode"
executable = ${JSON.stringify(EXECUTABLE)}

[listen]
ip = "127.0.0.1"
port = ${port}

[acp]
enabled = true
`)
    await expect(readAcpServeIntent({ engine: 'opencode', configPath })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('agent reasoner-a has no provider/model binding'),
      detail: { binding: 'model.primary', agentId: 'reasoner-a' },
    })
  })

  it('refuses a control daemon config and a non-loopback listener', async () => {
    const directory = await temporaryDirectory()
    const controlPath = join(directory, 'control.toml')
    await writeFile(controlPath, `version = 4

[daemon]
kind = "control"
id = "console"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(join(directory, 'control-state'))}

[webui]
ip = "127.0.0.1"
port = 7331
`)
    await expect(readAcpServeIntent({ engine: 'opencode', configPath: controlPath })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('requires an agent daemon config'),
    })

    const provider = await startProvider(() => ({ kind: 'text', text: 'unused' }))
    providers.add(provider)
    const configPath = await writeAgentConfig({ baseUrl: provider.baseUrl, port: 7443, executable: EXECUTABLE, directory })
    await expect(readAcpServeIntent({ engine: 'opencode', configPath, ip: '192.168.1.20' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    })
  })

  it('applies --ip/--port and reads the effective config back from the same intent', async () => {
    const directory = await temporaryDirectory()
    const provider = await startProvider(() => ({ kind: 'text', text: 'unused' }))
    providers.add(provider)
    const configPath = await writeAgentConfig({ baseUrl: provider.baseUrl, port: 7443, executable: EXECUTABLE, directory })
    const moved = await availableLoopbackPort()
    const resolved = await readAcpServeIntent({ engine: 'opencode', configPath, ip: '127.0.0.1', port: moved })
    expect(resolved.effective.listener).toEqual({ ip: '127.0.0.1', port: moved })
    expect(resolved.effective.kind).toBe('agent')
    expect(resolved.effective.engine).toBe('opencode')
    expect(resolved.binding.primary).toEqual({ providerInstanceId: 'probe', modelId: 'probe-model' })
    expect(resolved.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(resolved.intent.daemon.dataDirectory.startsWith(directory)).toBe(true)
  })

  it('refuses an unreadable config file', async () => {
    await expect(readAcpServeIntent({ engine: 'opencode', configPath: '/nonexistent/agent.toml' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('serve config cannot be read'),
    })
  })

  it('resolves the installed executable from the config, the environment and PATH', async () => {
    expect(resolveOpenCodeExecutable(EXECUTABLE, {})).toBe(EXECUTABLE)
    expect(resolveOpenCodeExecutable(undefined, { OPENCODE_EXECUTABLE: EXECUTABLE })).toBe(EXECUTABLE)
    expect(resolveOpenCodeExecutable(undefined, { PATH: `/nonexistent:${EXECUTABLE.slice(0, EXECUTABLE.lastIndexOf('/'))}` })).toBe(EXECUTABLE)
    expect(() => resolveOpenCodeExecutable('opencode', {})).toThrowError(/must be an absolute installed path/)
    expect(() => resolveOpenCodeExecutable(undefined, { PATH: '/nonexistent' })).toThrowError(/no OpenCode executable is configured/)
  })
})

describe.skipIf(!engineAvailable)('--serve opencode entry with the installed engine', () => {
  it('starts one daemon and one engine, proves the accepted model, prompts, cancels and stops', { timeout: 120_000 }, async () => {
    const directory = await temporaryDirectory()
    const provider = await startProvider(({ toolNames }) => (toolNames.length === 0
      ? { kind: 'text', text: 'title' }
      : { kind: 'slow', text: 'PROBE-LATE', delayMs: 30_000 }))
    providers.add(provider)
    const port = await availableLoopbackPort()
    const configPath = await writeAgentConfig({ baseUrl: provider.baseUrl, port, executable: EXECUTABLE, directory })

    const resolved = await readAcpServeIntent({ engine: 'opencode', configPath })
    const handle = await startAcpServe(resolved, { env: { ...process.env, PROBE_API_KEY: PROBE_CREDENTIAL } })
    handles.add(handle)

    // The entry proved the accepted binding from the engine's own session/new.
    expect(handle.readiness.modelTarget).toEqual({ providerInstanceId: 'probe', modelId: 'probe-model' })
    expect(handle.readiness.modelVerification).toBe('session/new configOptions')
    expect(handle.enginePid).toBeGreaterThan(0)
    expect(handle.listener).toEqual({ ip: '127.0.0.1', port })
    const ready = formatAcpServeReady(handle)
    expect(ready).toContain('engine=opencode')
    expect(ready).toContain('model=probe/probe-model')
    expect(ready).toContain(`enginePid=${handle.enginePid}`)

    const client = await connectClient(port)
    clients.add(client)
    await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    const initialized = await client.awaitFrame(frame => frame.id === 'init-1')
    expect((initialized.result as Record<string, unknown>).protocolVersion).toBe(1)

    await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: directory, mcpServers: [] } })
    const sessionId = sessionIdOf(await client.awaitFrame(frame => frame.id === 'new-1'))

    await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'slow' }] } })
    // Wait until the provider call is really in flight. Cancelling on any
    // session/update would race the request itself.
    await client.awaitFrame(frame => frame.method === 'session/update' && JSON.stringify(frame.params).includes('PROBE-START'))
    await client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    const cancelled = await client.awaitFrame(frame => frame.id === 'prompt-1')
    expect(cancelled.error, `cancel returned an error frame: ${JSON.stringify(cancelled)}`).toBeUndefined()
    expect((cancelled.result as Record<string, unknown>).stopReason).toBe('cancelled')
    // The accepted model really reached the local provider through the entry.
    expect(provider.calls.some(call => call.model === 'probe-model')).toBe(true)

    const receipt = await handle.stop()
    handles.delete(handle)
    expect(receipt.engine.kind).toBe('exited')
    expect(formatAcpServeStopped(handle, receipt)).toContain('stopped')
    // The engine home stayed inside the daemon-owned data directory.
    const history = JSON.parse(await readFile(join(directory, 'state', 'acp-history.json'), 'utf8')) as { records: readonly { event: string }[] }
    expect(history.records.map(record => record.event)).toContain('request.dispatched')
  })

  it('delivers a real permission callback through the serve listener and applies the reply', { timeout: 120_000 }, async () => {
    const directory = await temporaryDirectory()
    let toolCall = 0
    const provider = await startProvider(({ toolNames }) => {
      if (toolNames.length === 0) return { kind: 'text', text: 'title' }
      toolCall += 1
      return toolCall === 1 ? { kind: 'tool', tool: 'read', args: { filePath: '/etc/hosts' } } : { kind: 'text', text: 'PROBE-TOOL-DONE' }
    })
    providers.add(provider)
    const port = await availableLoopbackPort()
    const configPath = await writeAgentConfig({ baseUrl: provider.baseUrl, port, executable: EXECUTABLE, directory })

    const handle = await startAcpServe(await readAcpServeIntent({ engine: 'opencode', configPath }), {
      env: { ...process.env, PROBE_API_KEY: PROBE_CREDENTIAL },
    })
    handles.add(handle)

    const client = await connectClient(port)
    clients.add(client)
    await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    await client.awaitFrame(frame => frame.id === 'init-1')
    await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: directory, mcpServers: [] } })
    const sessionId = sessionIdOf(await client.awaitFrame(frame => frame.id === 'new-1'))

    await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } })
    const callback = await client.awaitFrame(frame => frame.method === 'session/request_permission', 60_000)
    const options = (callback.params as Record<string, unknown>).options as readonly { optionId: string }[]
    expect(options.map(option => option.optionId)).toEqual(['once', 'always', 'reject'])
    await client.send({ jsonrpc: '2.0', id: callback.id as string, result: { outcome: { outcome: 'selected', optionId: 'once' } } })
    const result = await client.awaitFrame(frame => frame.id === 'prompt-1')
    expect((result.result as Record<string, unknown>).stopReason).toBe('end_turn')
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)

    const receipt = await handle.stop()
    handles.delete(handle)
    expect(receipt.engine.kind).toBe('exited')
  })
})
