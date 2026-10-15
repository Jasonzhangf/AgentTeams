#!/usr/bin/env node
/**
 * L9 Session-write-side black box: a Console command makes the agent daemon act on its own
 * engine, and the Console never becomes a data relay.
 *
 * This driver starts REAL daemons through the REAL CLI: one `control start --config` control
 * daemon and one `agentteams --serve opencode --ip --port --config` agent daemon, both on a
 * real loopback listener with real HTTP admission, a real OpenCode engine and a real
 * OpenAI-compatible stub provider. Both daemons run under ONE owned `HOME`, so the control
 * daemon writes and the agent daemon reads the same durable record.
 *
 * The driver holds ONE real ACP connection to the agent daemon. That connection plays the
 * controller: it opens the Session and sends the first prompt, so a REAL
 * `session/request_permission` callback is pending on the agent's own host.
 *
 * It then sends every Session write over the control daemon's real authenticated HTTP
 * surface, and never answers over the ACP connection:
 *   - `POST /api/v1/command` with `permission.reply` and `session.cancel`;
 *   - `POST /api/v1/session-message?agentId=&sessionId=` with the Session body.
 *
 * It proves:
 *   (a) the three Session writes are real CAS writes of ONE durable record per target agent
 *       at `<home>/.agentteams/sessions/<accountId>/<scopeId>/<agentId>/session-intent.json`,
 *       and the command result reports the accepted revision and NO Session state;
 *   (b) `permission.reply` reaches the engine through the AGENT daemon: the prompt the
 *       driver sent completes even though the driver never answered the callback over ACP,
 *       and the engine's own history records the adjudicated outcome;
 *   (c) the Console Session body ingress reaches the engine as a real `session/prompt`: a
 *       NEW prompt starts and the engine raises a NEW `session/request_permission` while the
 *       driver sends no prompt and no frame on the ACP connection;
 *   (d) `session.cancel` reaches the engine: the in-flight prompt ends;
 *   (e) a `permission.reply` naming a permission the engine never awaited is REFUSED: the
 *       prompt stays pending, and the record revision advances past the watermark, which is
 *       the durable trace of a write the daemon would not apply;
 *   (f) an agentId the control daemon does not declare is refused typed FORBIDDEN and writes
 *       no record;
 *   (g) the Console HTTP surface requires the declared Basic credential;
 *   (h) the control daemon never reports a Session: its projection keeps `sessions: []`.
 *
 * WHAT THIS DOES NOT PROVE (read before citing it)
 *   - This is source-tree evidence. It runs the worktree's compiled `generated/runtime-lib`
 *     through the source CLI, not an installed artifact.
 *   - It uses a local OpenAI-compatible stub provider for the OpenCode engine. It proves the
 *     daemon, the watch, the record and the engine mapping, not any upstream model.
 *   - The permission identity the Console names is the callback id the controller received
 *     with the request. Publishing that identity in the Console projection is L10 and is not
 *     claimed here; the driver learns it from the callback frame on its own ACP connection.
 *   - It is not restart, deployment, cross-device or multi-account evidence.
 *
 * Usage: node docs/evidence/acp-l9-session-write-side-20261014/black-box-session-write.mjs
 * Env:   OPENCODE_EXECUTABLE (default /Users/fanzhang/.opencode/bin/opencode)
 *        L9SW_STEP_DEADLINE_MS (default 120000)
 *        L9SW_OVERALL_DEADLINE_MS (default 600000)
 *        L9SW_RECEIPT_PATH (default <driver dir>/receipt.json)
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection, createServer as createNetServer } from 'node:net'

const driverDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(driverDirectory, '..', '..', '..')
const CLI = process.env.AGENTTEAMS_CLI ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = process.env.AGENTTEAMS_CLI === undefined ? repositoryRoot : resolve(dirname(process.env.AGENTTEAMS_CLI), '..')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const RECEIPT_PATH = process.env.L9SW_RECEIPT_PATH ?? join(driverDirectory, 'receipt.json')
const STEP_DEADLINE_MS = Number(process.env.L9SW_STEP_DEADLINE_MS ?? 120_000)
const OVERALL_DEADLINE_MS = Number(process.env.L9SW_OVERALL_DEADLINE_MS ?? 600_000)

const ACCOUNT = 'local'
const SCOPE = 'local'
const AGENT_ID = 'l9sw-agent'
const AGENT_HOST_ID = 'host-l9sw-agent'
const CONTROL_ID = 'l9sw-control'
const USERNAME = 'l9sw'
const PASSWORD_ENV = 'L9SW_WEBUI_PASSWORD'
const PASSWORD = 'l9sw-webui-secret'
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`
const RECORD_FILE_NAME = 'session-intent.json'
const WATERMARK_FILE_NAME = 'session-intent-watermark.json'
/** Three watch polls; the entry polls every 500ms. */
const POLL_SETTLE_MS = 3_500
const PROVIDER_CREDENTIAL = 'l9sw-probe-secret'

let step = 'startup'
let logDirectory = null
let ownedRoot = null
let recordRoot = null
let agentStateDirectory = null
const live = { agent: null, controlPid: null, controlConfigPath: null, controlStarted: false, provider: null, client: null }
const receipts = {
  driver: 'acp-l9-session-write-side-20261014/black-box-session-write.mjs',
  startedAt: new Date().toISOString(),
  steps: [],
  checks: 0,
}

function assert(condition, message) {
  if (!condition) throw new Error(`BLACK-BOX FAIL [${step}]: ${message}`)
  receipts.checks += 1
  console.log(`  ok: ${message}`)
}

function record(name, value) {
  receipts.steps.push({ step, name, value })
  console.log(`  receipt: ${name} = ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

function runCliSync(args, env) {
  const logPath = join(logDirectory, `cli-${receipts.steps.length}-${Date.now()}.log`)
  const fd = openSync(logPath, 'a')
  try {
    execFileSync(process.execPath, [CLI, ...args], {
      cwd: CLI_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
    })
  } finally {
    closeSync(fd)
  }
  return readFileSync(logPath, 'utf8')
}

function processRow(pid) {
  try {
    return execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** CLI status lines are space-separated `key=value` fields, and a value never contains a space. */
function parseFields(line) {
  const fields = {}
  for (const part of line.trim().split(/\s+/)) {
    const at = part.indexOf('=')
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1)
  }
  return fields
}

async function availableLoopbackPort() {
  const listener = createNetServer()
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = listener.address()
  await new Promise(resolveClose => listener.close(() => resolveClose()))
  return address.port
}

function lastUserText(parsed) {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue
    const content = messages[index].content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
  }
  return ''
}

/**
 * Local OpenAI-compatible stub provider. One `read` tool call per conversation: once the
 * conversation already carries a tool result, the model answers in text. Each prompt
 * therefore raises exactly one real `session/request_permission`, so the driver can count
 * prompts by counting permission callbacks.
 */
function startStubProvider() {
  const calls = []
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const text = lastUserText(parsed)
      const carriesToolResult = (parsed.messages ?? []).some(message =>
        message?.role === 'tool' || message?.role === 'function' || message?.tool_call_id !== undefined)
      calls.push({ model: parsed.model ?? '', text, carriesToolResult, streaming: body.includes('"stream":true') })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (carriesToolResult) {
        response.write(chunk({ role: 'assistant', content: 'PROBE-TOOL-DONE' }))
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_probe_${calls.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/etc/hosts' }) } }] }))
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveStart({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        calls,
        close: () => new Promise(resolveClose => server.close(() => resolveClose())),
      })
    })
  })
}

/** The control daemon. Its accepted `peers` are the only place the record path resolves from. */
function controlConfig({ directory, port }) {
  return `version = 4

[daemon]
kind = "control"
id = ${JSON.stringify(CONTROL_ID)}
hostId = "host-l9sw-control"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(join(directory, 'control-state'))}

[webui]
ip = "127.0.0.1"
port = ${port}
allowedOrigin = "http://127.0.0.1:${port}"

[webui.auth]
username = ${JSON.stringify(USERNAME)}
passwordEnv = ${JSON.stringify(PASSWORD_ENV)}

[relations]
allowed = ["master", "peer"]

[peers.${AGENT_ID}]
agentId = ${JSON.stringify(AGENT_ID)}
hostId = ${JSON.stringify(AGENT_HOST_ID)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9SW_CRED_PEER"
`
}

/** One v4 agent config: no declared peers, so this daemon dials nothing on its own. */
function agentConfig({ ip, port, directory, baseUrl }) {
  return `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(AGENT_ID)}
hostId = ${JSON.stringify(AGENT_HOST_ID)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(join(directory, 'state'))}

[engine]
kind = "opencode"
executable = ${JSON.stringify(OPENCODE)}
workspace = ${JSON.stringify(join(directory, 'workspace'))}

[listen]
ip = ${JSON.stringify(ip)}
port = ${port}

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[relations]
allowed = ["master", "peer"]

[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(baseUrl)}
label = "L9 Session-write-side stub provider"
enabled = true
credentialEnv = "L9SW_PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`
}

function spawnAgent({ ip, port, configPath, env }) {
  const child = spawn(process.execPath, [CLI, '--serve', 'opencode', '--ip', ip, '--port', String(port), '--config', configPath], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entry = { child, stdout: '', stderr: '', ready: undefined }
  child.stdout.on('data', chunk => {
    entry.stdout += chunk.toString('utf8')
    for (const line of entry.stdout.split('\n')) {
      if (entry.ready === undefined && line.startsWith('serving ')) entry.ready = line
    }
  })
  child.stderr.on('data', chunk => { entry.stderr += chunk.toString('utf8') })
  live.agent = entry
  return entry
}

async function awaitAgentReady(entry) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (entry.ready !== undefined) return entry.ready
    if (entry.child.exitCode !== null) throw new Error(`the agent daemon exited before readiness; stderr=${entry.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`the agent daemon never printed a readiness line; stderr=${entry.stderr}`)
}

/** A real newline-delimited JSON ACP connection to the agent daemon's listener. */
function connectClient(port) {
  return new Promise((resolveConnect, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = ''
    const frames = []
    const waiters = []
    socket.on('error', reject)
    socket.on('connect', () => resolveConnect({
      send: frame => new Promise(resolveSend => socket.write(`${JSON.stringify(frame)}\n`, resolveSend)),
      awaitFrame: (match, timeoutMs = 90_000, label = step) => new Promise((resolveFrame, rejectFrame) => {
        let settled = false
        let deadline
        const settle = () => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          const at = waiters.indexOf(check)
          if (at >= 0) waiters.splice(at, 1)
        }
        const check = () => {
          for (let index = 0; index < frames.length; index += 1) {
            if (match(frames[index])) {
              settle()
              resolveFrame(frames.splice(index, 1)[0])
              return true
            }
          }
          return false
        }
        // A negative await settles as a timeout, and its matcher must stop consuming frames.
        deadline = setTimeout(() => { settle(); rejectFrame(new Error(`timed out waiting for an ACP frame at ${label}`)) }, timeoutMs)
        if (check()) return
        waiters.push(check)
      }),
      /** Every frame this connection ever received, for the durable receipt. */
      seen: () => [...frames],
      close: () => new Promise(resolveClose => socket.end(() => resolveClose())),
    }))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim().length === 0) continue
        frames.push(JSON.parse(line))
        for (const checkFn of [...waiters]) checkFn()
      }
    })
  })
}

async function sendCommand(origin, body, authorization) {
  const response = await fetch(`${origin}/api/v1/command`, {
    method: 'POST',
    headers: authorization === null
      ? { 'content-type': 'application/json' }
      : { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function sendSessionBody(origin, target, payload, authorization) {
  const query = new URLSearchParams({ agentId: target.agentId, sessionId: target.sessionId })
  const response = await fetch(`${origin}/api/v1/session-message?${query.toString()}`, {
    method: 'POST',
    headers: authorization === null
      ? { 'content-type': 'application/json' }
      : { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

async function readProjection(origin) {
  const response = await fetch(`${origin}/api/v1/projection`, { headers: { authorization: BASIC } })
  return { status: response.status, body: await response.json() }
}

/** The one record the control daemon writes and this agent daemon reads. */
function recordPath() {
  return join(recordRoot, RECORD_FILE_NAME)
}

function watermarkPath() {
  return join(agentStateDirectory, WATERMARK_FILE_NAME)
}

async function readRecord() {
  if (!existsSync(recordPath())) return undefined
  return JSON.parse(await readFile(recordPath(), 'utf8'))
}

async function readWatermark() {
  if (!existsSync(watermarkPath())) return undefined
  return JSON.parse(await readFile(watermarkPath(), 'utf8'))
}

async function awaitWatermark(expected) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  let observed
  while (Date.now() < deadline) {
    observed = await readWatermark()
    if (observed?.appliedRevision === expected) return observed
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`the agent daemon never reached watermark revision ${expected} within ${STEP_DEADLINE_MS}ms; observed=${JSON.stringify(observed)}`)
}

/** The engine's own durable ACP history, read only as evidence. */
async function readHistory() {
  try {
    const document = JSON.parse(await readFile(join(agentStateDirectory, 'acp-history.json'), 'utf8'))
    return Array.isArray(document.records) ? document.records : []
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    throw cause
  }
}

async function awaitHistory(kind, predicate, label) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  let observed = []
  while (Date.now() < deadline) {
    observed = (await readHistory()).filter(entry => entry.kind === kind)
    const match = observed.find(predicate)
    if (match !== undefined) return match
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`${label}: no ${kind} record matched within ${STEP_DEADLINE_MS}ms; observed=${JSON.stringify(observed).slice(0, 2000)}`)
}

async function main() {
  if (!existsSync(OPENCODE)) throw new Error(`the OpenCode executable is absent: ${OPENCODE}`)
  const directory = await mkdtemp(join(tmpdir(), 'l9sw-blackbox-'))
  ownedRoot = directory
  console.log('# L9 Session-write-side black box: a Console command makes the agent daemon act')
  console.log(`cli=${CLI}`)
  console.log(`engine=${OPENCODE}`)
  console.log(`root=${directory}`)

  logDirectory = join(directory, 'cli-logs')
  await mkdir(logDirectory, { recursive: true })
  agentStateDirectory = join(directory, 'agent', 'state')
  const workspace = join(directory, 'agent', 'workspace')
  await mkdir(workspace, { recursive: true })
  // The record path resolves from `os.homedir()`, so every daemon under test gets this
  // owned home. The driver never writes the record itself.
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  recordRoot = join(home, '.agentteams', 'sessions', ACCOUNT, SCOPE, AGENT_ID)
  record('recordPath', recordPath())
  record('watermarkPath', watermarkPath())
  assert(!existsSync(recordPath()), 'no pending Session write record exists before any Console command')

  const controlPort = await availableLoopbackPort()
  const agentPort = await availableLoopbackPort()
  const provider = await startStubProvider()
  live.provider = provider

  const operatorEnv = {
    HOME: home,
    L9SW_CRED_PEER: 'Bearer l9sw-peer-secret',
    L9SW_PROBE_API_KEY: PROVIDER_CREDENTIAL,
    [PASSWORD_ENV]: PASSWORD,
  }

  const controlPath = join(directory, 'control.toml')
  const agentPath = join(directory, 'agent.toml')
  live.controlConfigPath = controlPath
  await writeFile(controlPath, controlConfig({ directory: join(directory, 'control'), port: controlPort }))
  await writeFile(agentPath, agentConfig({ ip: '127.0.0.1', port: agentPort, directory: join(directory, 'agent'), baseUrl: provider.baseUrl }))
  record('controlConfigPath', controlPath)
  record('agentConfigPath', agentPath)
  record('declaredPeer', { name: AGENT_ID, accountId: ACCOUNT, scopeId: SCOPE })

  // ---- the real control daemon, through the real CLI ----------------------
  step = 'control start'
  console.log(runCliSync(['control', 'start', '--config', controlPath], operatorEnv).trim())
  live.controlStarted = true
  const controlStatus = parseFields(runCliSync(['control', 'status', '--config', controlPath], operatorEnv).trim().split('\n').filter(Boolean).at(-1))
  live.controlPid = Number(controlStatus.pid)
  assert(Number.isSafeInteger(live.controlPid) && processRow(live.controlPid).length > 0, `the control daemon reports a live explicit pid (${live.controlPid})`)
  assert(controlStatus.state === 'running', `the control daemon reports running (${controlStatus.state})`)
  record('control', { pid: live.controlPid, origin: `http://127.0.0.1:${controlPort}` })

  const origin = `http://127.0.0.1:${controlPort}`

  // ---- the real agent daemon ---------------------------------------------
  step = 'agent readiness'
  const agentEntry = spawnAgent({ ip: '127.0.0.1', port: agentPort, configPath: agentPath, env: operatorEnv })
  const readyLine = await awaitAgentReady(agentEntry)
  const readyFields = parseFields(readyLine)
  record('agentReady', readyLine.trim())
  assert(agentEntry.child.pid > 0 && processRow(agentEntry.child.pid).length > 0, `the agent daemon is live with explicit pid ${agentEntry.child.pid}`)
  assert(readyFields.enginePid !== undefined && processRow(Number(readyFields.enginePid)).length > 0, `the agent daemon spawned a live engine child (${readyFields.enginePid})`)

  // ---- the real controller connection, on the agent daemon's own listener --
  step = 'controller connect'
  const client = await connectClient(agentPort)
  live.client = client
  await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  await client.awaitFrame(frame => frame.id === 'init-1', 60_000, 'initialize')
  assert(true, 'the controller opened a real ACP channel to the agent daemon')

  step = 'session/new'
  await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: workspace, mcpServers: [] } })
  const newFrame = await client.awaitFrame(frame => frame.id === 'new-1', 90_000, 'session/new')
  const sessionId = newFrame.result?.sessionId
  assert(typeof sessionId === 'string' && sessionId.length > 0, `the engine returned a real sessionId (${String(sessionId).slice(0, 12)}…)`)
  record('sessionId', sessionId)

  // ---- (b) permission.reply through the control daemon --------------------
  step = 'prompt 1 (driver)'
  await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } })
  const callbackOne = await client.awaitFrame(frame => frame.method === 'session/request_permission', 90_000, 'prompt 1 permission callback')
  const permissionOne = callbackOne.id
  const optionsOne = callbackOne.params?.options ?? []
  assert(typeof permissionOne === 'string' && permissionOne.length > 0, `the engine raised a real permission callback the controller received as id ${String(permissionOne)}`)
  // The frame carries the engine's own ACP option kinds. The host projects them onto the
  // frozen Console vocabulary (`allow_once` -> `once`), and the Console decision `once` must
  // therefore resolve to the engine option the host projects as `once`.
  const rawKinds = optionsOne.map(option => option.kind)
  assert(rawKinds.includes('allow_once'), `the callback carries a real engine option set (${rawKinds.join(',')})`)
  assert(rawKinds.includes('reject_once'), `the callback carries the engine's own rejection option (${rawKinds.join(',')})`)
  record('permissionOne', {
    id: permissionOne,
    engineOptionKinds: rawKinds,
    consoleDecision: 'once',
    resolvesToEngineOptionId: optionsOne.find(option => option.kind === 'allow_once')?.optionId,
  })

  step = 'permission.reply'
  // The frozen command carries the engine option the Console chose. It is sent with the real
  // optionId OpenCode offered, so the durable record is checked to carry it verbatim. This
  // engine's optionIds equal the projected kinds, so this step cannot by itself tell a named
  // option from a same-kind guess; the watch spec proves that distinction with two options of
  // one kind.
  const replyOne = await sendCommand(origin, {
    kind: 'permission.reply', agentId: AGENT_ID, sessionId, permissionId: permissionOne, decision: 'once', optionId: 'once',
  }, BASIC)
  assert(replyOne.status === 200 && replyOne.body?.ok === true, `the control daemon accepted permission.reply (${JSON.stringify(replyOne.body)})`)
  assert(replyOne.body?.result?.acceptedRevision === 1, `the result reports the accepted revision 1 and nothing else (${JSON.stringify(replyOne.body?.result)})`)
  assert(!JSON.stringify(replyOne.body).includes('session') || replyOne.body?.result?.sessionId === undefined,
    'the command result carries no Session state')
  const recordOne = await readRecord()
  assert(recordOne?.revision === 1 && recordOne?.intents?.length === 1, `the durable record carries revision 1 with one intent (${JSON.stringify(recordOne?.intents?.map(intent => intent.kind))})`)
  assert(recordOne.intents[0].kind === 'permission.reply' && recordOne.intents[0].permissionId === permissionOne,
    'the record names the permission by the id the controller received')
  assert(recordOne.intents[0].optionId === 'once',
    `the durable record carries the engine option the frozen command named (${JSON.stringify(recordOne.intents[0].optionId)})`)
  record('recordAfterReply', { revision: recordOne.revision, oldestRevision: recordOne.oldestRevision, kinds: recordOne.intents.map(intent => intent.kind) })

  // The agent daemon applies the write to its OWN host. The driver never answers over ACP.
  const promptOneDone = await client.awaitFrame(frame => frame.id === 'prompt-1', 90_000, 'prompt 1 completion')
  assert(promptOneDone.result !== undefined || promptOneDone.error !== undefined,
    'the prompt the driver sent completed while the driver never answered the callback over ACP')
  await awaitWatermark(1)
  assert(true, 'the agent daemon advanced its own consumed watermark to revision 1')
  // The agent daemon's own durable history is the strongest evidence for (b): it records the
  // reply the daemon sent, the exact dispatched callback that reply answered, and the real
  // engine optionId it selected.
  const callbackReply = await awaitHistory('request', entry => entry.event === 'callback.reply' && entry.sessionId === sessionId, 'the callback reply the daemon sent')
  const dispatched = (await readHistory()).find(entry => entry.recordId === callbackReply.requestRecordId)
  assert(dispatched?.event === 'callback.dispatched' && dispatched.sessionId === sessionId,
    'the reply the daemon sent answers a callback the engine really dispatched for this Session')
  const outcome = callbackReply.frame?.result?.outcome
  assert(outcome?.outcome === 'selected' && outcome?.optionId === 'once',
    `the daemon answered with the engine's own optionId for the Console decision once (${JSON.stringify(outcome)})`)
  record('callbackOutcome', {
    replyEvent: callbackReply.event,
    answeredRecordId: callbackReply.requestRecordId,
    dispatchedEvent: dispatched.event,
    selectedOptionId: outcome.optionId,
    sessionId,
  })
  const callsAfterOne = provider.calls.length
  assert(callsAfterOne >= 1, `the stub provider served the real prompt (${callsAfterOne} provider call(s))`)

  // ---- (c) the Console Session body ingress reaches the engine ------------
  step = 'session-message'
  // A real ACP prompt body: a content-block array, carried verbatim to the engine.
  const body = [{ type: 'text', text: 'read /etc/hosts l9sw-body-1' }]
  const sent = await sendSessionBody(origin, { agentId: AGENT_ID, sessionId }, body, BASIC)
  assert(sent.status === 200 && sent.body?.ok === true, `the control daemon accepted the Session body ingress (${JSON.stringify(sent.body)})`)
  assert(sent.body?.result?.acceptedRevision === 2, `the body ingress reports the accepted revision 2 (${JSON.stringify(sent.body?.result)})`)
  await awaitWatermark(2)
  assert(true, 'the agent daemon advanced its own consumed watermark to revision 2')

  // The daemon sent `session/prompt` on its own: the prompt request carries the daemon's own
  // id, the engine really ran it, and the driver never sent a prompt or any frame.
  const daemonPrompt = await client.awaitFrame(frame => typeof frame.id === 'string' && frame.id.startsWith('session-intent-'), 90_000, 'the daemon prompt completion')
  assert(daemonPrompt.result !== undefined || daemonPrompt.error !== undefined,
    `the prompt the DAEMON sent from the Console body completed (${JSON.stringify(daemonPrompt.result ?? daemonPrompt.error).slice(0, 160)})`)
  const daemonRequest = await awaitHistory('request', entry => entry.event === 'request.dispatched'
    && entry.sessionId === sessionId && typeof entry.frame?.id === 'string' && entry.frame.id.startsWith('session-intent-'),
    'the daemon request.dispatched record')
  assert(daemonRequest.frame.method === 'session/prompt', `the daemon dispatched a real session/prompt for the Console body (${daemonRequest.frame.method})`)
  const providerText = provider.calls.at(-1)?.text ?? ''
  assert(providerText.includes('l9sw-body-1'), `the engine received the Console body verbatim (${JSON.stringify(providerText.slice(0, 120))})`)
  record('bodyReachedEngine', {
    daemonRequestId: daemonRequest.frame.id,
    dispatchedMethod: daemonRequest.frame.method,
    providerText: providerText.slice(0, 200),
  })

  // ---- (d) session.cancel through the control daemon ----------------------
  step = 'second session'
  await client.send({ jsonrpc: '2.0', id: 'new-2', method: 'session/new', params: { cwd: workspace, mcpServers: [] } })
  const newFrameTwo = await client.awaitFrame(frame => frame.id === 'new-2', 90_000, 'session/new 2')
  const sessionTwo = newFrameTwo.result?.sessionId
  assert(typeof sessionTwo === 'string' && sessionTwo.length > 0 && sessionTwo !== sessionId, `the engine returned a second real sessionId (${String(sessionTwo).slice(0, 12)}…)`)

  step = 'prompt on the second session'
  const secondBody = await sendSessionBody(origin, { agentId: AGENT_ID, sessionId: sessionTwo }, [{ type: 'text', text: 'read /etc/hosts l9sw-body-2' }], BASIC)
  assert(secondBody.status === 200 && secondBody.body?.result?.acceptedRevision === 3, `the second Session body reports the accepted revision 3 (${JSON.stringify(secondBody.body?.result)})`)
  const callbackTwo = await client.awaitFrame(frame => frame.method === 'session/request_permission', 90_000, 'second session permission callback')
  assert(callbackTwo.id !== permissionOne, `a NEW engine permission callback arrived for a prompt the driver never sent (${String(callbackTwo.id)})`)
  await awaitWatermark(3)
  assert(true, 'the agent daemon advanced its own consumed watermark to revision 3')

  step = 'session.cancel'
  const cancel = await sendCommand(origin, { kind: 'session.cancel', agentId: AGENT_ID, sessionId: sessionTwo }, BASIC)
  assert(cancel.status === 200 && cancel.body?.ok === true, `the control daemon accepted session.cancel (${JSON.stringify(cancel.body)})`)
  assert(cancel.body?.result?.acceptedRevision === 4, `session.cancel reports the accepted revision 4 (${JSON.stringify(cancel.body?.result)})`)
  const cancelled = await client.awaitFrame(frame => typeof frame.id === 'string' && frame.id.startsWith('session-intent-'), 90_000, 'the cancelled daemon prompt')
  assert(cancelled.result !== undefined || cancelled.error !== undefined,
    `the prompt the DAEMON sent for the second Session ended after the cancel (${JSON.stringify(cancelled.result ?? cancelled.error).slice(0, 200)})`)
  await awaitWatermark(4)
  assert(true, 'the agent daemon advanced its own consumed watermark to revision 4')

  // ---- (e) a permission the engine never awaited is refused ---------------
  step = 'third session'
  await client.send({ jsonrpc: '2.0', id: 'new-3', method: 'session/new', params: { cwd: workspace, mcpServers: [] } })
  const newFrameThree = await client.awaitFrame(frame => frame.id === 'new-3', 90_000, 'session/new 3')
  const sessionThree = newFrameThree.result?.sessionId
  assert(typeof sessionThree === 'string' && sessionThree.length > 0, `the engine returned a third real sessionId (${String(sessionThree).slice(0, 12)}…)`)

  step = 'prompt on the third session'
  const thirdBody = await sendSessionBody(origin, { agentId: AGENT_ID, sessionId: sessionThree }, [{ type: 'text', text: 'read /etc/hosts l9sw-body-3' }], BASIC)
  assert(thirdBody.status === 200 && thirdBody.body?.result?.acceptedRevision === 5, `the third Session body reports the accepted revision 5 (${JSON.stringify(thirdBody.body?.result)})`)
  const callbackThree = await client.awaitFrame(frame => frame.method === 'session/request_permission', 90_000, 'third session permission callback')
  const permissionThree = callbackThree.id
  assert(typeof permissionThree === 'string' && permissionThree.length > 0, `a third real permission callback is pending (${String(permissionThree)})`)
  await awaitWatermark(5)
  assert(true, 'the agent daemon advanced its own consumed watermark to revision 5')

  step = 'invented permission'
  const before = await readWatermark()
  const invented = await sendCommand(origin, {
    kind: 'permission.reply', agentId: AGENT_ID, sessionId: sessionThree, permissionId: 'permission-the-engine-never-awaited', decision: 'once',
  }, BASIC)
  assert(invented.status === 200 && invented.body?.ok === true,
    'the control daemon writes the record: the refusal belongs to the agent daemon, not to the Console')
  const recordSix = await readRecord()
  assert(recordSix?.revision === 6, `the record advanced to revision 6 (${recordSix?.revision})`)
  // The agent daemon must NOT advance: it cannot map the write to a real engine callback, and
  // it must never invent an approval.
  await new Promise(resolveWait => setTimeout(resolveWait, POLL_SETTLE_MS))
  const after = await readWatermark()
  assert(after?.appliedRevision === before?.appliedRevision, `the agent daemon did not apply the invented permission (watermark stayed ${after?.appliedRevision})`)
  // The prompt whose permission the invented write named must still be pending: the engine
  // never received an approval, and the daemon never guessed one.
  const thirdEnded = await client.awaitFrame(frame => typeof frame.id === 'string' && frame.id.startsWith('session-intent-'), 6_000, 'a prompt that must not end').then(() => true).catch(() => false)
  assert(!thirdEnded, 'the third Session prompt stayed pending: no approval was invented for the unknown permission')
  record('refusedWrite', {
    recordRevision: recordSix.revision,
    watermark: after?.appliedRevision,
    pendingPermission: permissionThree,
    refusedPermissionId: 'permission-the-engine-never-awaited',
  })

  // ---- (f) an undeclared target is refused and writes nothing -------------
  step = 'undeclared target'
  const beforeBytes = await readFile(recordPath(), 'utf8')
  const undeclared = await sendCommand(origin, { kind: 'session.cancel', agentId: 'agent-not-declared', sessionId }, BASIC)
  assert(undeclared.status === 200 && undeclared.body?.ok === false && undeclared.body?.error?.code === 'FORBIDDEN',
    `an undeclared agentId is refused typed FORBIDDEN (${JSON.stringify(undeclared.body?.error)})`)
  assert(await readFile(recordPath(), 'utf8') === beforeBytes, 'the refused command did not touch the record')
  const undeclaredSession = await sendSessionBody(origin, { agentId: 'agent-not-declared', sessionId }, { text: 'x' }, BASIC)
  assert(undeclaredSession.status === 200 && undeclaredSession.body?.ok === false && undeclaredSession.body?.error?.code === 'FORBIDDEN',
    `an undeclared Session body target is refused typed FORBIDDEN (${JSON.stringify(undeclaredSession.body?.error)})`)
  record('undeclaredRefusal', undeclared.body.error)

  // ---- (g) the Console HTTP surface requires the credential ---------------
  step = 'authentication'
  const unauthenticated = await sendCommand(origin, { kind: 'session.cancel', agentId: AGENT_ID, sessionId }, null)
  assert(unauthenticated.status === 401, `the Console command route refuses a request with no credential (${unauthenticated.status})`)
  const projectionUnauthenticated = await fetch(`${origin}/api/v1/projection`)
  assert(projectionUnauthenticated.status === 401, `the Console projection route refuses a request with no credential (${projectionUnauthenticated.status})`)

  // ---- (h) the control daemon never reports a Session --------------------
  step = 'projection'
  const projection = await readProjection(origin)
  assert(projection.status === 200, 'the authenticated projection is readable')
  assert(Array.isArray(projection.body?.sessions) && projection.body.sessions.length === 0,
    `the control daemon reports no Session, because it never fakes one (${JSON.stringify(projection.body?.sessions)})`)
  record('projection', { agents: projection.body?.agents?.length ?? 0, sessions: projection.body?.sessions?.length ?? 0 })

  step = 'cleanup'
  await client.close()
  receipts.verdict = 'PASS'
  receipts.finishedAt = new Date().toISOString()
  receipts.checks = receipts.checks
  console.log(`\n# PASS: ${receipts.checks} checks`)
}

async function stopOwnedResources() {
  if (live.client !== null) await live.client.close().catch(() => undefined)
  if (live.agent !== null && live.agent.child.exitCode === null) {
    // The declared lifecycle channel is the CLI, and it needs an explicit generation.
    live.agent.child.kill('SIGTERM')
    await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
    if (live.agent.child.exitCode === null) live.agent.child.kill('SIGKILL')
  }
  if (live.controlStarted && live.controlConfigPath !== null) {
    try {
      execFileSync(process.execPath, [CLI, 'control', 'stop', '--config', live.controlConfigPath], {
        cwd: CLI_ROOT, env: { ...process.env, HOME: join(ownedRoot, 'home') }, stdio: 'ignore',
      })
    } catch { /* the receipt keeps the failure */ }
  }
  if (live.provider !== null) await live.provider.close().catch(() => undefined)
}

let exitCode = 0
const deadline = setTimeout(() => {
  console.error(`BLACK-BOX FAIL: the overall deadline of ${OVERALL_DEADLINE_MS}ms expired at step ${step}`)
  exitCode = 1
  void finish()
}, OVERALL_DEADLINE_MS)

async function finish() {
  clearTimeout(deadline)
  await stopOwnedResources()
  const retained = process.env.L9SW_KEEP_ROOT === '1'
  if (!retained && ownedRoot !== null) await rm(ownedRoot, { recursive: true, force: true })
  receipts.retainedRoot = retained ? ownedRoot : null
  receipts.controlPid = live.controlPid
  receipts.agentPid = live.agent?.child?.pid ?? null
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipts, null, 2)}\n`)
  console.log(`# receipt: ${RECEIPT_PATH}`)
  process.exit(exitCode)
}

try {
  await main()
} catch (error) {
  exitCode = 1
  receipts.verdict = 'FAIL'
  receipts.failure = { step, message: error instanceof Error ? error.message : String(error) }
  receipts.agentStderr = live.agent?.stderr?.slice(-4000) ?? null
  receipts.agentStdout = live.agent?.stdout?.slice(-2000) ?? null
  console.error(`\nBLACK-BOX FAIL [${step}]: ${error instanceof Error ? error.message : String(error)}`)
  if (receipts.agentStderr) console.error(`--- agent stderr ---\n${receipts.agentStderr}`)
} finally {
  await finish()
}
