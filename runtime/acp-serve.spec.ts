import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer, createConnection, type Socket } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpFrame } from '../packages/shared/src/acp.ts'
import type { AcpDuplex } from '../packages/shared/src/engine.ts'
import { createStdioAcpDuplex } from '../acp-adapter/stdio.ts'
import { adjudicatePermissionReply, projectPermissionOptions } from '../agent-host/acp-host.ts'
import { buildDirectWssRoutePlan } from '../network/route-plan.ts'
import { connectDirectWssTarget } from '../network/direct-route.ts'
import { negotiatedAgreement, runTeamsNegotiation } from '../network/teams-negotiation.ts'
import type { RegistrationStatus } from '../network/registration-client.ts'
import {
  acpServeStatePath,
  acpCapabilityDeclarations,
  classifyServeListener,
  engineAdapterFor,
  formatAcpServeReady,
  formatAcpServeRegistration,
  formatAcpServeStopped,
  publishServeRegistration,
  readAcpServeIntent,
  requireEnforceablePolicies,
  resolveDshExecutable,
  resolveOpenCodeExecutable,
  startAcpServe,
  type AcpServeHandle,
  type ServeEngineAdapter,
} from './acp-serve.ts'
import { localGroupEndpointScopePath, readLocalGroupEndpointRecord } from '../config/local-group-endpoint-store.ts'
import type { AgentRegistration } from './registry-registration.ts'
import { sendLocalMessageRequest } from './local-message-socket.ts'
import { processAlive, processStartTime, terminateProcess } from './local-ownership.ts'

/**
 * `--serve <engine>` entry evidence (owner: runtime).
 *
 * The first group is the entry's own contract without an engine: one v4 agent
 * config, explicit CLI overrides, the engine dispatch and typed refusals. The
 * second group runs the real installed OpenCode engine through the same entry
 * and drives a real ACP client over the entry's listener; it is skipped only
 * when the installed engine is absent, and the skip is recorded in the receipt.
 * The third group drives the DSH branch through a local fake ACP engine: it is
 * deliberately not the real DSH server, because a real DSH session needs a
 * reachable provider route and a credential. The real installed DSH engine is
 * driven through this same entry by the black-box driver in the receipt.
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

/** The first non-internal IPv4 address, or undefined when the host has no LAN interface. */
function lanIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

async function availableLanPort(ip: string): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, ip, () => resolveListen())
  })
  const address = listener.address()
  await new Promise<void>(resolveClose => listener.close(() => resolveClose()))
  if (address === null || typeof address === 'string') throw new Error('no LAN port')
  return address.port
}

/** Real TLS material with the LAN address in the SAN, generated by the documented openssl command. */
function generateTls(directory: string, ip: string): { readonly keyRef: string; readonly certRef: string; readonly cert: Buffer } {
  const keyPath = join(directory, 'lan-key.pem')
  const certPath = join(directory, 'lan-cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=teams-lan-agent', '-addext', `subjectAltName=IP:${ip}`,
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
  return { keyRef: `file:${keyPath}`, certRef: `file:${certPath}`, cert: readFileSync(certPath) }
}

const PROBE_ADMISSION_CREDENTIAL = 'Bearer probe-admission-secret'
const PROBE_REGISTRATION_CREDENTIAL = 'probe-registration-secret'

const LAN_OBSERVER = { accountId: 'local', scopeId: 'local', agentId: 'observer' }

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

/**
 * A local fake DSH ACP engine for the DSH branch of the entry.
 *
 * It is NOT the real DSH server and claims no real inference: a real DSH session
 * needs a reachable provider route and a credential. It is an ACP server process
 * in the exact launch shape the DSH adapter compiles (`--profile acp --patch
 * <ownedDirectory>/teams-dsh-acp.patch.json`, DSH_HOME in its environment), so
 * the entry's dispatch, single-child, readiness, cancel, explicit-PID stop and
 * cleanup-on-failed-start behavior are exercised through the real runtime. Its
 * `session/new` `model` option value is read back from the real derived patch
 * file the entry wrote, so the readiness proof still comes from the engine's own
 * session/new and from the derived config, not from a hardcoded expectation.
 */
const FAKE_DSH_SOURCE = String.raw`import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = name => {
  const index = process.argv.indexOf('--' + name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const dshHome = process.env.DSH_HOME
if (typeof dshHome !== 'string' || dshHome.length === 0) throw new Error('fake dsh: DSH_HOME is required')
if (dshHome === process.env.HOME + '/.dsh') throw new Error('fake dsh: refusing the real ~/.dsh as DSH_HOME')
const patchPath = arg('patch')
const patch = JSON.parse(readFileSync(patchPath, 'utf8'))
const acpRow = patch.find(row => row.id === 'acp')
const modelValue = JSON.stringify([acpRow.config.provider, acpRow.config.model])
writeFileSync(join(dshHome, 'fake-engine-record.json'), JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  dshHome,
  permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
  telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED ?? null,
  modelValue,
}))
writeFileSync(join(dshHome, 'fake-engine.pid'), String(process.pid))
let control = {}
try { control = JSON.parse(readFileSync(join(dshHome, 'fake-engine.control.json'), 'utf8')) } catch {}

const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
let buffer = ''
let cancelPending = false
let pending = null
let sessionCounter = 0
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    const frame = JSON.parse(line)
    if (frame.method === 'initialize') {
      if (control.failInitialize === true) {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'fake dsh: deliberate initialize failure' } })
        continue
      }
      send({ jsonrpc: '2.0', id: frame.id, result: {
        protocolVersion: 1,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      } })
      continue
    }
    if (frame.method === 'session/new') {
      if (control.failSessionNew === true) {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'fake dsh: deliberate session/new failure' } })
        continue
      }
      sessionCounter += 1
      const sessionId = 'fake-dsh-session-' + String(sessionCounter)
      send({ jsonrpc: '2.0', id: frame.id, result: { sessionId, configOptions: [{
        id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelValue,
        options: [{ group: acpRow.config.provider, name: acpRow.config.provider, options: [{ value: modelValue, name: acpRow.config.model }] }],
      }] } })
      continue
    }
    if (frame.method === 'session/prompt') {
      const text = (frame.params?.prompt ?? []).map(part => part?.text ?? '').join(' ')
      if (text.includes('SLOW-CANCEL')) {
        pending = frame.id
        cancelPending = true
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE-START' } } } })
        continue
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE-DSH-REPLY' } } } })
      send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      continue
    }
    if (frame.method === 'session/cancel' && cancelPending && pending !== null) {
      cancelPending = false
      const id = pending
      pending = null
      send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
      continue
    }
  }
})
process.on('SIGTERM', () => { writeFileSync(join(dshHome, 'fake-engine.stopped'), 'SIGTERM'); process.exit(0) })
`

/** Write the fake DSH engine as an executable wrapper with a real shebang. */
async function writeFakeDshEngine(directory: string): Promise<string> {
  const path = join(directory, 'fake-dsh.mjs')
  await writeFile(path, `#!${process.execPath}\n${FAKE_DSH_SOURCE}`)
  chmodSync(path, 0o755)
  return path
}

/** One v4 agent config selecting the DSH engine kind. */
function dshAgentConfig(input: { readonly executable: string; readonly port: number; readonly dataDirectory: string; readonly workspace: string; readonly baseUrl?: string; readonly binding?: boolean; readonly blacklist?: readonly string[]; readonly peers?: string }): string {
  const provider = input.baseUrl === undefined
    ? ''
    : `
[providers.probe]
protocol = "openai-responses"
apiBaseUrl = ${JSON.stringify(input.baseUrl)}
label = "Probe provider"
enabled = true
credentialEnv = "PROBE_DSH_KEY"

[[models]]
provider = "probe"
id = "probe-model"
`
  const binding = input.binding === false
    ? ''
    : `
[model.primary]
provider = "probe"
model = "probe-model"
`
  return `version = 4

[daemon]
kind = "agent"
id = "reasoner-dsh"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(input.dataDirectory)}

[engine]
kind = "dsh"
executable = ${JSON.stringify(input.executable)}
workspace = ${JSON.stringify(input.workspace)}

[listen]
ip = "127.0.0.1"
port = ${input.port}

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = ${JSON.stringify(input.blacklist ?? [])}
clientCapabilities = []
callbackExecutor = "controller"
${provider}${binding}${input.peers ?? ''}`
}

async function writeDshConfig(input: { readonly executable: string; readonly port: number; readonly directory: string; readonly binding?: boolean; readonly blacklist?: readonly string[] }): Promise<string> {
  const configPath = join(input.directory, 'agent-dsh.toml')
  await writeFile(configPath, dshAgentConfig({
    executable: input.executable,
    port: input.port,
    dataDirectory: join(input.directory, 'state'),
    workspace: join(input.directory, 'workspace'),
    baseUrl: 'http://127.0.0.1:1/v1',
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    ...(input.blacklist === undefined ? {} : { blacklist: input.blacklist }),
  }))
  return configPath
}

/** One v4 agent config with a non-loopback listener, TLS, an admission and discovery. */
function lanDshAgentConfig(input: {
  readonly executable: string
  readonly ip: string
  readonly port: number
  readonly dataDirectory: string
  readonly workspace: string
  readonly certRef: string
  readonly keyRef: string
  readonly trustRef: string
}): string {
  return `version = 4

[daemon]
kind = "agent"
id = "reasoner-dsh"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(input.dataDirectory)}

[engine]
kind = "dsh"
executable = ${JSON.stringify(input.executable)}
workspace = ${JSON.stringify(input.workspace)}

[listen]
ip = ${JSON.stringify(input.ip)}
port = ${input.port}
tlsCertRef = ${JSON.stringify(input.certRef)}
tlsKeyRef = ${JSON.stringify(input.keyRef)}

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[relations]
allowed = ["master", "peer"]

[[admissions]]
admissionRef = "adm-observer"
agentId = "observer"
accountId = "local"
scopeId = "local"
credentialRef = "env:PROBE_ADMISSION"

[discovery]
serverId = "lan-registry"
endpoint = "wss://127.0.0.1:1"
credentialRef = "env:PROBE_REGISTRATION"
tlsTrustRef = ${JSON.stringify(input.trustRef)}

[providers.probe]
protocol = "openai-responses"
apiBaseUrl = "http://127.0.0.1:1/v1"
label = "Probe provider"
enabled = true
credentialEnv = "PROBE_DSH_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`
}

function lanEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PROBE_DSH_KEY: PROBE_CREDENTIAL,
    PROBE_ADMISSION: PROBE_ADMISSION_CREDENTIAL,
    PROBE_REGISTRATION: PROBE_REGISTRATION_CREDENTIAL,
  }
}

function dshEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PROBE_DSH_KEY: PROBE_CREDENTIAL, ...extra }
}

/** Read and start one DSH serve intent; the caller owns the returned handle. */
async function startDshServe(input: {
  readonly configPath: string
}): Promise<AcpServeHandle> {
  const intent = await readAcpServeIntent({ engine: 'dsh', configPath: input.configPath })
  const handle = await startAcpServe(intent, {
    env: dshEnv(),
    initializeTimeoutMs: 15_000,
    stopTimeoutMs: 5_000,
  })
  handles.add(handle)
  return handle
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

  it('accepts the dsh engine and dispatches it to the DSH adapter', async () => {
    const directory = await temporaryDirectory()
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({ executable: process.execPath, port, directory })
    const resolved = await readAcpServeIntent({ engine: 'dsh', configPath })
    expect(resolved.effective.engine).toBe('dsh')
    expect(resolved.intent.engine?.kind).toBe('dsh')
    expect(resolved.binding.primary).toEqual({ providerInstanceId: 'probe', modelId: 'probe-model' })
    expect(engineAdapterFor('dsh').kind).toBe('dsh')
    expect(engineAdapterFor('opencode').kind).toBe('opencode')
    expect(engineAdapterFor('dsh').declaredMethods).toContain('callback:session/request_permission')
  })

  it('refuses a dsh config whose agent has no [model.primary] binding', async () => {
    const directory = await temporaryDirectory()
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({ executable: process.execPath, port, directory, binding: false })
    await expect(readAcpServeIntent({ engine: 'dsh', configPath })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('agent reasoner-dsh has no provider/model binding'),
      detail: { binding: 'model.primary', agentId: 'reasoner-dsh' },
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

  it('refuses a control daemon config and a non-loopback listener without [discovery]', async () => {
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

    // The genuinely unsupported shape: a non-loopback listener that passes the
    // TLS/admission schema check but declares no [discovery] server. A manual
    // peer carries no authenticated capability revision for the hello.
    const lanPath = join(directory, 'lan-no-discovery.toml')
    await writeFile(lanPath, `version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(join(directory, 'lan-state'))}

[engine]
kind = "dsh"
executable = ${JSON.stringify(process.execPath)}

[listen]
ip = "192.168.1.20"
port = 7443
tlsCertRef = "file:${join(directory, 'lan-cert.pem')}"
tlsKeyRef = "file:${join(directory, 'lan-key.pem')}"

[acp]
enabled = true

[[admissions]]
admissionRef = "adm-observer"
agentId = "observer"
accountId = "local"
scopeId = "local"
credentialRef = "env:PROBE_ADMISSION"
`)
    await expect(readAcpServeIntent({ engine: 'dsh', configPath: lanPath })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('only with a [discovery] server'),
      detail: { missing: 'discovery' },
    })

    // The same listener with discovery is accepted: the LAN channel is a real
    // supported shape and no longer a blanket refusal.
    const discoveredPath = join(directory, 'lan-with-discovery.toml')
    await writeFile(discoveredPath, `${await readFile(lanPath, 'utf8')}
[discovery]
serverId = "lan-registry"
endpoint = "wss://127.0.0.1:1"
credentialRef = "env:PROBE_REGISTRATION"
tlsTrustRef = "file:${join(directory, 'lan-cert.pem')}"

[providers.probe]
protocol = "openai-responses"
apiBaseUrl = "http://127.0.0.1:1/v1"
label = "Probe provider"
enabled = true
credentialEnv = "PROBE_REGISTRATION"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`)
    const resolved = await readAcpServeIntent({ engine: 'dsh', configPath: discoveredPath })
    expect(resolved.effective.listener).toEqual({ ip: '192.168.1.20', port: 7443 })
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

  it('resolves the installed DSH executable from the config, the environment and PATH', async () => {
    const directory = await temporaryDirectory()
    const installed = join(directory, 'dsh')
    await writeFile(installed, '#!/bin/sh\nexit 0\n')
    chmodSync(installed, 0o755)
    expect(resolveDshExecutable(installed, {})).toBe(installed)
    expect(resolveDshExecutable(undefined, { AGENTTEAMS_DSH_EXECUTABLE: installed })).toBe(installed)
    expect(resolveDshExecutable(undefined, { DSH_EXECUTABLE: installed })).toBe(installed)
    expect(resolveDshExecutable(undefined, { PATH: directory })).toBe(installed)
    expect(() => resolveDshExecutable('dsh', {})).toThrowError(/must be an absolute installed path/)
    expect(() => resolveDshExecutable(undefined, { PATH: '/nonexistent' })).toThrowError(/no DSH executable is configured/)
  })

  it('fails explicitly when an engine adapter declares no enforceable-policy set', () => {
    // The adapter owns which policies it can enforce. The entry must never
    // substitute `declaredMethods` (or any other set) for a missing declaration.
    const declaredOnly: ServeEngineAdapter = {
      kind: 'opencode',
      declaredMethods: ['callback:session/request_permission'],
      compileLaunch: () => Promise.reject(new Error('unused')),
      verifyEffective: () => Promise.reject(new Error('unused')),
    }
    let fault: unknown
    try {
      requireEnforceablePolicies(declaredOnly)
    } catch (cause) {
      fault = cause
    }
    expect(fault).toMatchObject({ name: 'AcpError', code: 'UNSUPPORTED_CONFIGURATION' })
    expect((fault as Error).message).toContain('opencode')
    expect((fault as Error).message).toContain('no enforceable ACP policy set')
    // Both delivered adapters declare their own set, so the entry always has one.
    expect(engineAdapterFor('opencode').enforceablePolicies).toBeDefined()
    expect(engineAdapterFor('dsh').enforceablePolicies).toBeDefined()
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
    // A2.6: the real engine option set projects verbatim into the Console option vocabulary,
    // and only an option the engine really offered can be selected back to it.
    const projected = projectPermissionOptions(callback)
    expect(projected?.map(option => option.optionId)).toEqual(['once', 'always', 'reject'])
    expect(projected?.map(option => option.kind)).toEqual(['once', 'always', 'reject'])
    expect(() => adjudicatePermissionReply({ outcome: { outcome: 'selected', optionId: 'never-offered' } }, projected))
      .toThrowError(/not an option the engine offered/)
    await client.send({ jsonrpc: '2.0', id: callback.id as string, result: adjudicatePermissionReply({ outcome: { outcome: 'selected', optionId: 'once' } }, projected) })
    const result = await client.awaitFrame(frame => frame.id === 'prompt-1')
    expect((result.result as Record<string, unknown>).stopReason).toBe('end_turn')
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)

    const receipt = await handle.stop()
    handles.delete(handle)
    expect(receipt.engine.kind).toBe('exited')
  })
})

describe('--serve dsh entry with a local fake DSH ACP engine', () => {
  it('dispatches dsh to the DSH adapter, starts exactly one child and proves the model from the real session/new', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({ executable: fakeEngine, port, directory })
    const handle = await startDshServe({ configPath })

    // The dispatch really selected the DSH adapter: the child was launched with
    // the DSH launch shape and the DSH_HOME isolation variables.
    expect(handle.engineKind).toBe('dsh')
    const record = JSON.parse(await readFile(join(handle.dataDirectory, 'engine', 'fake-engine-record.json'), 'utf8')) as {
      readonly pid: number
      readonly args: readonly string[]
      readonly dshHome: string
      readonly permissionMode: string | null
      readonly telemetryDisabled: string | null
      readonly modelValue: string
    }
    expect(record.args[0]).toBe('--profile')
    expect(record.args[1]).toBe('acp')
    expect(record.args[2]).toBe('--patch')
    expect(record.args[3]).toBe(join(handle.dataDirectory, 'engine', 'teams-dsh-acp.patch.json'))
    expect(record.dshHome).toBe(join(handle.dataDirectory, 'engine'))
    expect(record.dshHome.startsWith(tmpdir())).toBe(true)
    expect(record.permissionMode).toBe('workspace-write')
    expect(record.telemetryDisabled).toBe('1')
    expect(record.modelValue).toBe('["teams-probe","probe-model"]')
    expect(record.pid).toBe(handle.enginePid)

    // Exactly one engine child: the fake engine records one pid, and that pid is
    // the one the entry reports and reaps.
    expect(Number(await readFile(join(handle.dataDirectory, 'engine', 'fake-engine.pid'), 'utf8'))).toBe(handle.enginePid)

    // The readiness model comes from the engine's own session/new option, which
    // itself was read back from the real derived patch the entry wrote.
    expect(handle.readiness.modelTarget).toEqual({ providerInstanceId: 'probe', modelId: 'probe-model' })
    expect(handle.readiness.modelVerification).toBe('session/new configOptions')
    expect(handle.listener).toEqual({ ip: '127.0.0.1', port })
    const ready = formatAcpServeReady(handle)
    expect(ready).toContain('engine=dsh')
    expect(ready).toContain('model=probe/probe-model')
    expect(ready).toContain('modelVerification=session/new configOptions')

    const client = await connectClient(port)
    clients.add(client)
    await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    const initialized = await client.awaitFrame(frame => frame.id === 'init-1')
    expect((initialized.result as Record<string, unknown>).protocolVersion).toBe(1)
    expect(((initialized.result as Record<string, unknown>).agentInfo as Record<string, unknown>).name).toBe('deepseek-harness-acp')

    await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: directory, mcpServers: [] } })
    const sessionId = sessionIdOf(await client.awaitFrame(frame => frame.id === 'new-1'))
    await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hello' }] } })
    const prompted = await client.awaitFrame(frame => frame.id === 'prompt-1')
    expect((prompted.result as Record<string, unknown>).stopReason).toBe('end_turn')

    // Explicit-PID stop: the engine child really exits and the owned DSH home
    // (the derived patch file and the engine state) is removed.
    const receipt = await handle.stop()
    handles.delete(handle)
    expect(receipt.engine.kind).toBe('exited')
    expect(formatAcpServeStopped(handle, receipt)).toContain('engine=exited')
    expect(existsSync(join(handle.dataDirectory, 'engine'))).toBe(false)
    expect(existsSync(join(handle.dataDirectory, 'acp-history.json'))).toBe(true)
    await expect(async () => {
      process.kill(handle.enginePid, 0)
    }).rejects.toThrow()
  })

  it('cancels an in-flight prompt through the entry and stops by explicit PID', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({ executable: fakeEngine, port, directory })
    const handle = await startDshServe({ configPath })
    const client = await connectClient(port)
    clients.add(client)
    await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    await client.awaitFrame(frame => frame.id === 'init-1')
    await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: directory, mcpServers: [] } })
    const sessionId = sessionIdOf(await client.awaitFrame(frame => frame.id === 'new-1'))

    await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'SLOW-CANCEL' }] } })
    await client.awaitFrame(frame => frame.method === 'session/update' && JSON.stringify(frame.params).includes('FAKE-START'))
    await client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    const cancelled = await client.awaitFrame(frame => frame.id === 'prompt-1')
    expect(cancelled.error, `cancel returned an error frame: ${JSON.stringify(cancelled)}`).toBeUndefined()
    expect((cancelled.result as Record<string, unknown>).stopReason).toBe('cancelled')

    const receipt = await handle.stop()
    handles.delete(handle)
    expect(receipt.engine.kind).toBe('exited')
    expect(existsSync(join(handle.dataDirectory, 'engine'))).toBe(false)
  })

  it('removes the owned DSH home when the readiness session/new fails', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({ executable: fakeEngine, port, directory })
    // The engine reads its injected behavior from its own DSH_HOME, which is the
    // directory the entry owns and the adapter isolates. This failure happens
    // after the daemon started, so it exercises the outer catch path.
    const intent = await readAcpServeIntent({ engine: 'dsh', configPath })
    await mkdir(join(directory, 'state', 'engine'), { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'state', 'engine', 'fake-engine.control.json'), JSON.stringify({ failSessionNew: true }))
    await expect(startAcpServe(intent, {
      env: dshEnv(),
      initializeTimeoutMs: 15_000,
      stopTimeoutMs: 5_000,
    })).rejects.toMatchObject({ name: 'AcpError', code: 'UNSUPPORTED_CONFIGURATION' })
    // The failed start left no engine home behind, but the daemon data
    // directory and its durable history stay.
    expect(existsSync(join(directory, 'state', 'engine'))).toBe(false)
    expect(existsSync(join(directory, 'state', 'acp-history.json'))).toBe(true)
  })

  it('removes the owned DSH home when startAcpAgentDaemon returns a failed outcome', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({ executable: fakeEngine, port, directory })
    // An initialize error makes startAcpAgentDaemon itself return a failed
    // outcome, so this exercises the `outcome.kind === 'failed'` cleanup branch
    // directly; the readiness failure above exercises the outer catch path.
    const intent = await readAcpServeIntent({ engine: 'dsh', configPath })
    await mkdir(join(directory, 'state', 'engine'), { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'state', 'engine', 'fake-engine.control.json'), JSON.stringify({ failInitialize: true }))
    let fault: unknown
    try {
      await startAcpServe(intent, { env: dshEnv(), initializeTimeoutMs: 15_000, stopTimeoutMs: 5_000 })
    } catch (cause) {
      fault = cause
    }
    // The failed-outcome branch rethrows the daemon's own fault with its
    // "engine start failed" prefix; the outer catch path cannot produce that.
    expect(fault).toMatchObject({ name: 'AcpError', code: 'ENGINE_UNAVAILABLE' })
    expect((fault as Error).message).toContain('engine start failed: engine initialize failed')
    // The fake engine had already written its own record and pid file into
    // DSH_HOME, so their removal proves this branch ran its own cleanup. The
    // daemon data directory is retained; no history record exists yet because
    // the failure happens before the first engine request.
    expect(existsSync(join(directory, 'state', 'engine'))).toBe(false)
    expect(existsSync(join(directory, 'state'))).toBe(true)
  })

  it('removes the owned DSH home when compileLaunch throws before the daemon starts', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    // A blacklist key with no enforcement owner is refused by assertLaunchPolicy
    // inside the DSH adapter's compileLaunch: the config compiles and the intent
    // resolves, and the entry has already created its owned engine directory, so
    // this is the pre-daemon throw path rather than the failed-start or the stop
    // path.
    const configPath = await writeDshConfig({
      executable: fakeEngine,
      port,
      directory,
      blacklist: ['internal-tool:dsh:bash'],
    })
    await expect(startDshServe({ configPath })).rejects.toMatchObject({
      name: 'AcpError',
      code: 'UNSUPPORTED_POLICY',
      message: expect.stringContaining('no enforcement owner for blacklist key internal-tool:dsh:bash'),
    })
    // compileLaunch threw, so no child ever ran and the owned engine directory
    // the entry had already created is released; the daemon data directory stays.
    expect(existsSync(join(directory, 'state', 'engine'))).toBe(false)
    expect(existsSync(join(directory, 'state'))).toBe(true)
  })

  it('accepts a blacklist for the capability and client-capability classes the DSH adapter enforces', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({
      executable: fakeEngine,
      port,
      directory,
      blacklist: [
        'capability:/mcpCapabilities/http',
        'capability:/promptCapabilities/image',
        'client-capability:/fs/readTextFile',
      ],
    })
    // The old `?? declaredMethods` substitution refused the capability and
    // client-capability keys as UNSUPPORTED_POLICY before the entry could bind.
    const handle = await startDshServe({ configPath })
    expect(handle.engineKind).toBe('dsh')
    // The accepted blacklist is really enforced: the key the engine advertised
    // left the effective set, and the declared-but-unadvertised keys were
    // accepted instead of being over-refused.
    expect(handle.daemon.policy.denied).toEqual(['capability:/mcpCapabilities/http'])
    expect(handle.daemon.policy.effective).not.toContain('capability:/mcpCapabilities/http')

    const client = await connectClient(port)
    clients.add(client)
    await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    await client.awaitFrame(frame => frame.id === 'init-1')

    const receipt = await handle.stop()
    handles.delete(handle)
    expect(receipt.engine.kind).toBe('exited')
  })

  it('refuses a blacklist key with no enforcement owner before it spawns the engine', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({
      executable: fakeEngine,
      port,
      directory,
      blacklist: ['internal-tool:dsh:bash'],
    })
    await expect(startDshServe({ configPath })).rejects.toMatchObject({
      name: 'AcpError',
      code: 'UNSUPPORTED_POLICY',
      message: expect.stringContaining('no enforcement owner for blacklist key internal-tool:dsh:bash'),
    })
    // The refusal happened before the child started: the fake engine wrote no
    // pid record, and no handle was registered for cleanup.
    expect(existsSync(join(directory, 'state', 'engine', 'fake-engine.pid'))).toBe(false)
  })
})

/**
 * D05 closure: the serve entry composes up to two distinguishable inbound
 * channels onto one daemon.host. The local channel stays the D02 loopback plain
 * channel; the LAN channel is the authenticated direct-WSS Teams chain. The
 * classification, the policy projection and the registration publication are
 * pure or single-purpose, so they are asserted directly.
 */
describe('--serve LAN and local channel composition', () => {
  it('classifies a listener by address, not by a second config key', () => {
    expect(classifyServeListener({ ip: '127.0.0.1' })).toBe('local')
    expect(classifyServeListener({ ip: '127.9.9.9' })).toBe('local')
    expect(classifyServeListener({ ip: '::1' })).toBe('local')
    expect(classifyServeListener({ ip: '192.168.0.3' })).toBe('lan')
    expect(classifyServeListener({ ip: '10.0.0.7' })).toBe('lan')
  })

  it('projects the effective ACP policy into the one published capability', () => {
    const policy = {
      revision: 'sha256:test',
      engineInstanceId: 'engine-1',
      supported: ['acp', 'method:session/new', 'method:session/prompt', 'method:session/cancel', 'callback:session/request_permission'],
      effective: ['acp', 'method:session/prompt', 'method:session/new', 'method:session/cancel', 'callback:session/request_permission'],
      denied: [],
    }
    const declarations = acpCapabilityDeclarations(policy)
    expect(declarations).toHaveLength(1)
    expect(declarations[0].capabilityId).toBe('acp')
    expect(declarations[0].version).toBe('1')
    expect(declarations[0].resources).toEqual([])
    expect(declarations[0].operations.map(operation => operation.operation)).toEqual(['session/cancel', 'session/new', 'session/prompt'])
    expect(declarations[0].operations.every(operation => operation.cancellation === 'cooperative')).toBe(true)
    // The projection never invents a method the accepted policy denied, and it
    // never claims cooperative cancellation without session/cancel.
    expect(declarations[0].operations.some(operation => operation.operation === 'session/request_permission')).toBe(false)
    expect(acpCapabilityDeclarations({ ...policy, effective: ['method:session/new'] })[0].operations)
      .toEqual([{ operation: 'session/new', inputSchema: {}, outputSchema: {}, cancellation: 'unsupported' }])
  })

  it('publishes only when the registration client is enabled and online', async () => {
    const published: string[] = []
    const declaration = {
      identity: { hostId: 'host-a', machineId: 'host-a', agentId: 'reasoner-a', accountId: 'local', agentKind: 'acp' as const, label: 'reasoner-a' },
      scopeId: 'local',
      revision: 2,
      capabilities: [],
      routes: [],
    }
    const online: AgentRegistration = {
      state: 'enabled',
      status: { state: 'online', endpoint: 'wss://registry:9443', generation: 3, attempts: 0, reconnects: 0 },
      client: {
        closed: Promise.resolve({ state: 'online', attempts: 0, reconnects: 0 }),
        status: () => ({ state: 'online', endpoint: 'wss://registry:9443', generation: 3, attempts: 0, reconnects: 0 }),
        start: async () => ({ state: 'online', attempts: 0, reconnects: 0 }),
        directory: async () => [],
        publish: async value => { published.push(value.identity.agentId) },
        stop: async () => undefined,
      },
    }
    expect((await publishServeRegistration({ registration: online, declaration }))?.state).toBe('online')
    expect(published).toEqual(['reasoner-a'])

    const offline: AgentRegistration = {
      ...online,
      status: { state: 'reconnecting', endpoint: 'wss://registry:9443', attempts: 1, reconnects: 0 },
      client: { ...online.client, status: () => ({ state: 'reconnecting', attempts: 1, reconnects: 0 }) },
    }
    expect(await publishServeRegistration({ registration: offline, declaration })).toBeNull()

    const disabled: AgentRegistration = {
      state: 'disabled',
      reason: 'discovery-not-configured',
      status: { state: 'disabled', attempts: 0, reconnects: 0 },
    }
    expect(await publishServeRegistration({ registration: disabled, declaration })).toBeNull()
    expect(published).toEqual(['reasoner-a'])
  })

  it('binds the local channel byte-compatibly and reports no LAN channel for a loopback listener', async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const configPath = await writeDshConfig({ executable: fakeEngine, port, directory })
    const handle = await startDshServe({ configPath })

    expect(handle.localChannel).toEqual({ ip: '127.0.0.1', port })
    expect(handle.listener).toEqual({ ip: '127.0.0.1', port })
    expect(handle.lanChannel).toBeNull()
    expect(handle.capabilitiesRevision).toBe('2')
    expect(handle.registration.state).toBe('disabled')
    expect(Object.keys(handle.teamsStatus).sort()).toEqual(['connections', 'history'])
    expect(handle.teamsStatus.connections()).toEqual([])

    const line = formatAcpServeReady(handle)
    expect(line).toContain(`listener=127.0.0.1:${port}`)
    expect(line).toContain(`localChannel=127.0.0.1:${port}`)
    expect(line).toContain('lanChannel=none')
    expect(line).toContain('capabilitiesRevision=2')
    expect(line).toContain('registration=disabled')
    expect(formatAcpServeRegistration({ state: 'reconnecting', attempts: 2, reconnects: 0, endpoint: 'wss://registry:9443' }))
      .toBe('registration state=reconnecting attempts=2 reconnects=0 endpoint=wss://registry:9443')

    await handle.stop()
    expect(existsSync(join(directory, 'state', 'engine', 'fake-engine.pid'))).toBe(false)
  })

  it('composes the CLI group surface on the registration connection and refuses a request while it is offline', async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    const tls = generateTls(directory, '127.0.0.1')
    const configPath = join(directory, 'agent-discovery.toml')
    await writeFile(configPath, `${dshAgentConfig({
      executable: fakeEngine,
      port,
      dataDirectory: join(directory, 'state'),
      workspace: join(directory, 'workspace'),
      baseUrl: 'http://127.0.0.1:1/v1',
    })}
[discovery]
serverId = "loopback-registry"
endpoint = "wss://127.0.0.1:1"
credentialRef = "env:PROBE_REGISTRATION"
tlsTrustRef = ${JSON.stringify(tls.certRef)}
`)
    const handle = await startAcpServe(await readAcpServeIntent({ engine: 'dsh', configPath }), {
      env: lanEnv(),
      initializeTimeoutMs: 15_000,
      stopTimeoutMs: 5_000,
    })
    handles.add(handle)
    // Registration is enabled, so the CLI group surface exists; the socket is a
    // real filesystem socket under the daemon's data directory.
    expect(handle.registration.state).not.toBe('disabled')
    expect(handle.groupSocketPath).not.toBeNull()
    expect(handle.groupSocketPath?.startsWith(join(directory, 'state'))).toBe(true)
    // The socket this daemon just bound is published into the durable endpoint record the
    // control daemon reads, under the shared account-and-scope directory the Session records
    // use. This is the one binding the control daemon cannot derive on its own.
    expect(handle.groupEndpoint.published).toBe(true)
    // The path is derived from the accepted identity and the shared `~/.agentteams` root, so
    // the control daemon resolves the same file from its own accepted facts.
    expect(handle.groupEndpoint.path).toBe(localGroupEndpointScopePath({
      home: homedir(), accountId: 'local', scopeId: 'local', agentId: handle.agentId,
    }))
    expect(handle.groupEndpoint.failures()).toEqual([])
    const endpointRecord = await readLocalGroupEndpointRecord(handle.groupEndpoint.path)
    expect(endpointRecord?.agentId).toBe(handle.agentId)
    expect(endpointRecord?.groupEndpoint).toEqual({ kind: 'local-socket', socketPath: handle.groupSocketPath })
    // No registry is reachable, so a group request fails with a typed error
    // instead of being answered by a local stand-in.
    await expect(sendLocalMessageRequest({
      socketPath: handle.groupSocketPath!,
      request: { kind: 'group.list', requestId: 'cli-offline' },
      timeoutMs: 2_000,
    })).rejects.toBeDefined()
    const endpointPath = handle.groupEndpoint.path
    await handle.stop()
    // The published endpoint does not outlive the socket it named: the control daemon now
    // reads an honest "not configured" instead of dialing a released path.
    expect(handle.groupEndpoint.published).toBe(false)
    expect(await readLocalGroupEndpointRecord(endpointPath)).toBeUndefined()
  })

  it('attempts every declared peer at start and records a typed failure instead of skipping', async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLoopbackPort()
    // Any readable file works as the peer's TLS trust anchor; the readback fails
    // before a socket is opened, so its content is never parsed here.
    const trustPath = join(directory, 'peer-trust.pem')
    await writeFile(trustPath, readFileSync(fakeEngine))
    const configPath = join(directory, 'agent-peers.toml')
    await writeFile(configPath, dshAgentConfig({
      executable: fakeEngine,
      port,
      dataDirectory: join(directory, 'state'),
      workspace: join(directory, 'workspace'),
      baseUrl: 'http://127.0.0.1:1/v1',
      peers: `
[peers.no-endpoint]
agentId = "peer-c"
hostId = "host-c"
accountId = "local"
scopeId = "local"
credentialRef = "env:PROBE_DSH_KEY"

[peers.with-endpoint]
agentId = "peer-d"
hostId = "host-d"
accountId = "local"
scopeId = "local"
endpoint = "wss://127.0.0.1:1"
admissionRef = "adm-observer"
credentialRef = "env:PROBE_DSH_KEY"
tlsTrustRef = "file:${trustPath}"
`,
    }))
    const handle = await startDshServe({ configPath })

    // The daemon still serves; a peer refusal never crashes the start.
    expect(handle.listener).toEqual({ ip: '127.0.0.1', port })
    expect(handle.egress.list()).toEqual([])
    const failures = [...handle.egressFailures].sort((left, right) => left.peerName.localeCompare(right.peerName))
    expect(failures.map(failure => failure.peerName)).toEqual(['no-endpoint', 'with-endpoint'])
    expect(failures.every(failure => failure.code === 'UNSUPPORTED_CONFIGURATION')).toBe(true)
    // Both refusals are recorded on the owner too, not only in the start receipt.
    expect(handle.egress.failures()).toHaveLength(2)

    const receipt = await handle.stop()
    expect(receipt.channels).toBe(0)
    expect(handle.egress.list()).toEqual([])
  })

  it('converges a second serve on the same data directory before touching the owned engine home', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const firstPort = await availableLoopbackPort()
    const configPath = join(directory, 'agent-single-instance.toml')
    await writeFile(configPath, dshAgentConfig({
      executable: fakeEngine,
      port: firstPort,
      dataDirectory: join(directory, 'state'),
      workspace: join(directory, 'workspace'),
      baseUrl: 'http://127.0.0.1:1/v1',
    }))
    const first = await startDshServe({ configPath })
    const firstState = JSON.parse(await readFile(join(first.dataDirectory, 'agent-serve-state.json'), 'utf8')) as {
      readonly daemonPid: number
      readonly enginePid: number
      readonly agentId: string
    }
    expect(firstState.daemonPid).toBe(process.pid)
    expect(firstState.enginePid).toBe(first.enginePid)
    expect(firstState.agentId).toBe('reasoner-dsh')
    expect(processAlive(first.enginePid)).toBe(true)

    const secondPort = await availableLoopbackPort()
    await writeFile(configPath, dshAgentConfig({
      executable: fakeEngine,
      port: secondPort,
      dataDirectory: join(directory, 'state'),
      workspace: join(directory, 'workspace'),
      baseUrl: 'http://127.0.0.1:1/v1',
    }))
    const second = await startDshServe({ configPath })
    handles.delete(second)
    expect(second.dataDirectory).toBe(first.dataDirectory)
    expect(second.enginePid).not.toBe(first.enginePid)
    expect(processAlive(first.enginePid)).toBe(false)
    expect(second.listener).toEqual({ ip: '127.0.0.1', port: secondPort })
    expect(existsSync(join(second.dataDirectory, 'engine'))).toBe(true)
    const secondState = JSON.parse(await readFile(join(second.dataDirectory, 'agent-serve-state.json'), 'utf8')) as {
      readonly daemonPid: number
      readonly enginePid: number
    }
    expect(secondState.daemonPid).toBe(process.pid)
    expect(secondState.enginePid).toBe(second.enginePid)

    const receipt = await second.stop()
    expect(receipt.engine.kind).toBe('exited')
    expect(processAlive(second.enginePid)).toBe(false)
    expect(existsSync(join(second.dataDirectory, 'engine'))).toBe(false)
    expect(existsSync(join(second.dataDirectory, 'agent-serve-state.json'))).toBe(false)
  })

  it('converges a cross-process serve by recorded pid and process start time', { timeout: 60_000 }, async () => {
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const dataDirectory = join(directory, 'state')
    const configPath = join(directory, 'agent-cross-process.toml')
    const port = await availableLoopbackPort()
    await writeFile(configPath, dshAgentConfig({
      executable: fakeEngine,
      port,
      dataDirectory,
      workspace: join(directory, 'workspace'),
      baseUrl: 'http://127.0.0.1:1/v1',
    }))
    const previous = spawn(process.execPath, [
      '-e', 'setInterval(() => {}, 1000)',
      '--serve', 'dsh', '--config', configPath,
    ], { stdio: 'ignore' })
    const previousPid = previous.pid
    expect(previousPid).toBeTypeOf('number')
    if (previousPid === undefined) throw new Error('spawned fixture has no pid')
    let handle: AcpServeHandle | undefined
    try {
      let previousStart: string | undefined
      for (let attempt = 0; attempt < 100 && previousStart === undefined; attempt += 1) {
        previousStart = await processStartTime(previousPid)
        if (previousStart === undefined) await new Promise(resolveWait => setTimeout(resolveWait, 25))
      }
      expect(previousStart).toBeDefined()
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
      await writeFile(acpServeStatePath(dataDirectory), `${JSON.stringify({
        version: 2,
        agentId: 'reasoner-dsh',
        daemonPid: previousPid,
        daemonStart: previousStart,
        enginePid: 0,
        engineStart: null,
        engineInstanceId: 'stale-instance',
        engineKind: 'dsh',
        engineExecutable: fakeEngine,
        dataDirectory,
        configPath,
      }, null, 2)}\n`)

      handle = await startDshServe({ configPath })
      expect(processAlive(previousPid)).toBe(false)
      expect(handle.enginePid).toBeGreaterThan(0)
      expect(processAlive(handle.enginePid)).toBe(true)
      expect(JSON.parse(await readFile(join(dataDirectory, 'agent-serve-state.json'), 'utf8')))
        .toMatchObject({ version: 2, daemonPid: process.pid, enginePid: handle.enginePid })
    } finally {
      if (processAlive(previousPid)) await terminateProcess(previousPid, { gracefulMs: 1_000, hardMs: 1_000 })
      if (handle !== undefined) await handle.stop()
    }
  })

  it.skipIf(lanIpv4() === undefined)('binds the authenticated LAN channel onto the same host and admits only a real credential', async () => {
    const ip = lanIpv4()
    if (ip === undefined) throw new Error('no LAN interface')
    const directory = await temporaryDirectory()
    const fakeEngine = await writeFakeDshEngine(directory)
    const port = await availableLanPort(ip)
    const tls = generateTls(directory, ip)
    const configPath = join(directory, 'agent-lan.toml')
    await writeFile(configPath, lanDshAgentConfig({
      executable: fakeEngine,
      ip,
      port,
      dataDirectory: join(directory, 'state'),
      workspace: join(directory, 'workspace'),
      certRef: tls.certRef,
      keyRef: tls.keyRef,
      trustRef: tls.certRef,
    }))
    const intent = await readAcpServeIntent({ engine: 'dsh', configPath })
    const handle = await startAcpServe(intent, { env: lanEnv(), initializeTimeoutMs: 15_000, stopTimeoutMs: 5_000 })
    handles.add(handle)

    expect(handle.listener).toEqual({ ip, port })
    expect(handle.localChannel.ip).toBe('127.0.0.1')
    expect(handle.localChannel.port).not.toBe(port)
    expect(handle.lanChannel).toMatchObject({ endpoint: `wss://${ip}:${port}`, port, capabilitiesRevision: '2' })
    expect(handle.capabilitiesRevision).toBe('2')
    expect(['connecting', 'reconnecting', 'failed']).toContain(handle.registration.state)

    const routePlan = () => buildDirectWssRoutePlan({
      hostId: 'host-a',
      directoryGeneration: 1,
      policy: 'manual',
      targetCandidateId: 'lan-1',
      candidates: [{ candidateId: 'lan-1', kind: 'lan', endpoint: `wss://${ip}:${port}`, port, authRequired: true, lastSeenAt: new Date().toISOString() }],
    })
    const hello = {
      hostId: 'host-a',
      agentId: 'reasoner-dsh',
      targetGeneration: 1,
      protocolVersion: 1,
      capabilitiesRevision: '2',
      source: LAN_OBSERVER,
      admissionRef: 'adm-observer',
    }
    const connect = (credential: string) => connectDirectWssTarget({
      transport: { endpoint: `wss://${ip}:${port}`, credential, ca: tls.cert, connectTimeoutMs: 4_000, maxMessageBytes: 262_144, maxBufferedBytes: 262_144, maxPendingFrames: 64 },
      hello,
      plan: routePlan(),
      helloTimeoutMs: 4_000,
    })

    // A wrong credential is refused by the real HTTP admission, before any
    // application frame is read: the ledger stays empty.
    await expect(connect('Bearer wrong-credential')).rejects.toBeDefined()
    expect(handle.teamsStatus.connections()).toEqual([])

    const target = await connect(PROBE_ADMISSION_CREDENTIAL)
    try {
      const transport = {
        peer: LAN_OBSERVER,
        read: async () => JSON.parse((await target.connection.read()).bytes.toString('utf8')),
        send: async (frame: unknown) => { await target.connection.send({ bytes: Buffer.from(JSON.stringify(frame)), binary: false }) },
        closed: target.closed,
        close: () => target.close(),
      }
      const negotiation = await runTeamsNegotiation({
        options: {
          side: 'initiator',
          connectionId: 'spec-conn-1',
          self: LAN_OBSERVER,
          peer: { accountId: 'local', scopeId: 'local', agentId: 'reasoner-dsh' },
          selfGeneration: 11,
          selfCapabilitiesRevision: 'cap-observer',
          selfPolicyRevision: 3,
          allowedRoles: ['master', 'peer'],
          requestedRole: 'master',
          requestedPeerRole: 'peer',
          requestedCapabilities: ['method:session/prompt'],
          requestId: 'spec-req-1',
          expectedTargetGeneration: 1,
          expectedTargetCapabilitiesRevision: '2',
        },
        port: transport,
        timeoutMs: 5_000,
      })
      expect(negotiation.state, JSON.stringify(negotiation.fault ?? negotiation)).toBe('agreed')
      const agreement = negotiatedAgreement(negotiation)
      expect(agreement.sourcePolicyRevision).toBe(3)
      // The responder echoed its own accepted revision (D00 amendment A1).
      expect(agreement.targetPolicyRevision).toBe(intent.accepted.acceptedRevision)

      // The ingress wrote the live ledger: the same host serves the peer. The
      // responder records `ready` after it sends the final ready frame, so the
      // initiator observes the ledger transition a moment later.
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline && handle.teamsStatus.connections()[0]?.state !== 'ready') {
        await new Promise(resolveWait => setTimeout(resolveWait, 25))
      }
      const connections = handle.teamsStatus.connections()
      expect(connections).toHaveLength(1)
      expect(connections[0]).toMatchObject({ remoteAgentId: 'observer', state: 'ready', role: 'peer' })
    } finally {
      await target.close().catch(() => undefined)
    }
  })
})
