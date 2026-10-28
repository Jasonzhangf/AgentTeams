#!/usr/bin/env node
/**
 * e562a05 WebUI Session-loop black box.
 *
 * This starts the real control daemon and the real OpenCode-backed agent daemon through the
 * project CLI, both under one temporary HOME. It drives the public Console HTTP surface and
 * the shipped Console DOM in real Chrome:
 *
 *   POST /api/v1/command       session.create / session.open / permission.reply
 *   POST /api/v1/session-message
 *   GET  /api/v1/projection
 *
 * It proves:
 *   1. the control projection exposes the observed agent as an operable runtime agent;
 *   2. a control session.create makes the agent execute session/new and publish a new id;
 *   3. a { text } message reaches the real engine and appears as user, tool, assistant and
 *      final events in projection.sessionEvents;
 *   4. a real pending permission carries the engine option set, and answering it through the
 *      same control intent path completes the turn.
 *
 * The local OpenAI-compatible stub provider is only the model endpoint. The ACP host, agent
 * daemon, control daemon, intent records, observation records, permission callback and HTTP
 * projection are all real processes and real files.
 *
 * Honest boundary: this is source-tree evidence using the worktree CLI and the real OpenCode
 * executable, not an installed artifact. It proves the daemon/control loop and the source-tree
 * browser DOM, not an upstream model or an installed package.
 *
 * Usage: node docs/evidence/e562a05-webui-session-loop/black-box-session-loop.mjs
 * Env: OPENCODE_EXECUTABLE, E562_STEP_DEADLINE_MS, E562_OVERALL_DEADLINE_MS,
 *      E562_RECEIPT_PATH, CHROME_BIN
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(evidenceDirectory, '..', '..', '..')
const CLI = process.env.AGENTTEAMS_CLI ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = process.env.AGENTTEAMS_CLI === undefined ? repositoryRoot : resolve(dirname(process.env.AGENTTEAMS_CLI), '..')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RECEIPT_PATH = process.env.E562_RECEIPT_PATH ?? join(evidenceDirectory, 'receipt.json')
const SCREENSHOT_PATH = join(evidenceDirectory, 'browser-pending-permission.png')
const STEP_DEADLINE_MS = Number(process.env.E562_STEP_DEADLINE_MS ?? 120_000)
const OVERALL_DEADLINE_MS = Number(process.env.E562_OVERALL_DEADLINE_MS ?? 900_000)

const ACCOUNT = 'local'
const SCOPE = 'local'
const AGENT_ID = 'e562-agent'
const AGENT_HOST_ID = 'host-e562-agent'
const CONTROL_ID = 'e562-control'
const USERNAME = 'e562'
const PASSWORD_ENV = 'E562_WEBUI_PASSWORD'
const PASSWORD = 'e562-webui-secret'
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`
const PROVIDER_CREDENTIAL = 'e562-probe-secret'

const checks = []
const receipts = { version: 1, driver: 'e562a05-webui-session-loop', checks }
let ownedRoot
let step = 'start'
let controlConfigPath
let controlPid
let provider
let agent
let chrome

function assert(condition, message) {
  const entry = { step, ok: Boolean(condition), message }
  checks.push(entry)
  if (!condition) throw new Error(`[${step}] ${message}`)
  console.log(`PASS [${step}] ${message}`)
}

function record(name, value) {
  receipts[name] = value
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return `${result.stdout}${result.stderr}`
}

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
 * A real OpenAI-compatible endpoint. The first model turn asks OpenCode to read a file, which
 * forces one real permission callback. After the tool result is sent back, the model answers
 * with a final text so the full loop can complete.
 */
function startStubProvider() {
  const calls = []
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const text = lastUserText(parsed)
      const carriesToolResult = (parsed.messages ?? []).some(message =>
        message?.role === 'tool' || message?.role === 'function' || message?.tool_call_id !== undefined)
      calls.push({ model: parsed.model ?? '', text, carriesToolResult })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-e562', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: 'chatcmpl-e562', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'E562-PROBE-REPLY' }, finish_reason: 'stop' }],
        }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (carriesToolResult) {
        response.write(chunk({ role: 'assistant', content: 'E562-TOOL-DONE' }))
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e562', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      response.write(chunk({
        role: 'assistant',
        tool_calls: [{ index: 0, id: `call_e562_${calls.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/etc/hosts' }) } }],
      }))
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e562', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
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

function controlConfig(directory, port) {
  return `version = 4

[daemon]
kind = "control"
id = ${JSON.stringify(CONTROL_ID)}
hostId = "host-e562-control"
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
credentialRef = "env:E562_CRED_PEER"
`
}

function agentConfig(directory, ip, port, baseUrl) {
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
label = "E562 probe provider"
enabled = true
credentialEnv = "E562_PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`
}

function spawnAgent(ip, port, configPath, env) {
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
  return entry
}

async function awaitAgentReady(entry) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  while (Date.now() < deadline) {
    if (entry.ready !== undefined) return entry.ready
    if (entry.child.exitCode !== null) throw new Error(`agent daemon exited before readiness: ${entry.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`agent daemon did not become ready: ${entry.stderr}`)
}

async function readProjection(origin) {
  const response = await fetch(`${origin}/api/v1/projection`, { headers: { authorization: BASIC } })
  if (response.status !== 200) throw new Error(`projection returned HTTP ${response.status}`)
  return await response.json()
}

async function command(origin, value) {
  const response = await fetch(`${origin}/api/v1/command`, {
    method: 'POST',
    headers: { authorization: BASIC, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
  return { status: response.status, body: await response.json() }
}

async function sendMessage(origin, target, payload) {
  const query = new URLSearchParams({ agentId: target.agentId, sessionId: target.sessionId })
  const response = await fetch(`${origin}/api/v1/session-message?${query.toString()}`, {
    method: 'POST',
    headers: { authorization: BASIC, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

async function awaitProjection(origin, match, label) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  let observed
  while (Date.now() < deadline) {
    observed = await readProjection(origin)
    if (match(observed)) return observed
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`${label}: projection did not match within ${STEP_DEADLINE_MS}ms; observed=${JSON.stringify(observed).slice(0, 2400)}`)
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.onopen = resolveOpen
    socket.onerror = () => rejectOpen(new Error(`CDP connection failed: ${wsUrl}`))
  })
  let nextId = 1
  const pending = new Map()
  const events = []
  socket.onmessage = message => {
    const parsed = JSON.parse(message.data)
    if (parsed.id !== undefined) {
      const entry = pending.get(parsed.id)
      pending.delete(parsed.id)
      if (entry === undefined) return
      if (parsed.error !== undefined) entry.reject(new Error(`CDP ${entry.method} failed: ${JSON.stringify(parsed.error)}`))
      else entry.resolve(parsed.result)
      return
    }
    events.push(parsed)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolveSend, rejectSend) => {
    const id = nextId++
    pending.set(id, { resolve: resolveSend, reject: rejectSend, method })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })
  return { send, events, close: () => { try { socket.close() } catch { /* already closed */ } } }
}

async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId)
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.text ?? ''} ${result.exceptionDetails.exception?.description ?? ''}`.trim())
  }
  return result.result?.value
}

async function awaitUi(cdp, sessionId, expression, label) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  let observed
  while (Date.now() < deadline) {
    observed = await evaluate(cdp, sessionId, expression)
    if (observed) return observed
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`${label}: browser DOM did not satisfy the condition within ${STEP_DEADLINE_MS}ms; observed=${JSON.stringify(observed)}`)
}

async function openBrowser(origin) {
  const profile = join(ownedRoot, 'chrome-profile')
  await mkdir(profile, { recursive: true })
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  const wsUrl = await new Promise((resolveWs, rejectWs) => {
    const timer = setTimeout(() => rejectWs(new Error(`Chrome exposed no DevTools endpoint: ${stderr.slice(-800)}`)), STEP_DEADLINE_MS)
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match !== null) {
        clearTimeout(timer)
        resolveWs(match[1])
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      rejectWs(new Error(`Chrome exited before the DevTools endpoint (code=${code}): ${stderr.slice(-800)}`))
    })
  })
  const cdp = await connectCdp(wsUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Network.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Network.setExtraHTTPHeaders', { headers: { Authorization: BASIC } }, sessionId)
  await cdp.send('Page.navigate', { url: `${origin}/` }, sessionId)
  chrome = { child, cdp, sessionId, wsUrl }
  return chrome
}

async function captureScreenshot() {
  const shot = await chrome.cdp.send('Page.captureScreenshot', { format: 'png' }, chrome.sessionId)
  if (typeof shot.data !== 'string' || shot.data.length === 0) throw new Error('Page.captureScreenshot returned no data')
  const png = Buffer.from(shot.data, 'base64')
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('browser screenshot is not a PNG')
  await writeFile(SCREENSHOT_PATH, png)
  return png.length
}

function permissionOptionKinds(event) {
  return (event.options ?? []).map(option => option.kind)
}

async function main() {
  if (!existsSync(OPENCODE)) throw new Error(`OpenCode executable is absent: ${OPENCODE}`)
  ownedRoot = await mkdtemp(join(tmpdir(), 'e562-blackbox-'))
  const home = join(ownedRoot, 'home')
  await mkdir(home, { recursive: true })
  const workspace = join(ownedRoot, 'agent', 'workspace')
  await mkdir(workspace, { recursive: true })
  record('root', ownedRoot)
  record('engine', OPENCODE)

  const operatorEnv = {
    HOME: home,
    E562_CRED_PEER: 'Bearer e562-peer-secret',
    E562_PROBE_API_KEY: PROVIDER_CREDENTIAL,
    [PASSWORD_ENV]: PASSWORD,
  }
  provider = await startStubProvider()
  const controlPort = await availableLoopbackPort()
  const agentPort = await availableLoopbackPort()
  const origin = `http://127.0.0.1:${controlPort}`
  controlConfigPath = join(ownedRoot, 'control.toml')
  const agentPath = join(ownedRoot, 'agent.toml')
  await writeFile(controlConfigPath, controlConfig(join(ownedRoot, 'control'), controlPort))
  await writeFile(agentPath, agentConfig(join(ownedRoot, 'agent'), '127.0.0.1', agentPort, provider.baseUrl))

  step = 'control start'
  runCli(['control', 'start', '--config', controlConfigPath], operatorEnv)
  const statusLine = runCli(['control', 'status', '--config', controlConfigPath], operatorEnv).trim().split('\n').filter(Boolean).at(-1)
  const status = parseFields(statusLine)
  controlPid = Number(status.pid)
  assert(Number.isSafeInteger(controlPid) && processAlive(controlPid), `control daemon is live with explicit pid ${controlPid}`)
  assert(status.state === 'running', `control daemon reports running (${status.state})`)
  record('control', { pid: controlPid, origin })

  step = 'agent readiness'
  agent = spawnAgent('127.0.0.1', agentPort, agentPath, operatorEnv)
  const ready = await awaitAgentReady(agent)
  const readyFields = parseFields(ready)
  assert(agent.child.pid > 0 && processAlive(agent.child.pid), `agent daemon is live with explicit pid ${agent.child.pid}`)
  assert(readyFields.enginePid !== undefined && processAlive(Number(readyFields.enginePid)), `agent daemon spawned a live OpenCode child (${readyFields.enginePid})`)
  record('agent', { pid: agent.child.pid, enginePid: Number(readyFields.enginePid), ready: ready.trim() })

  step = 'operable runtime projection'
  const operable = await awaitProjection(
    origin,
    body => body.agents?.some(row => row.agentId === AGENT_ID && row.kind === 'runtime' && row.sessionCapable === true
      && (row.sessionAvailability === 'current' || row.sessionAvailability === 'no-current')) === true,
    'observed agent never became an operable runtime row',
  )
  const agentRow = operable.agents.find(row => row.agentId === AGENT_ID)
  assert(agentRow.kind === 'runtime' && agentRow.sessionCapable === true, 'the projection marks the observed agent runtime/sessionCapable')
  assert(agentRow.sessionAvailability === 'current' || agentRow.sessionAvailability === 'no-current', `the runtime row exposes an actionable availability (${agentRow.sessionAvailability})`)
  record('operableAgent', agentRow)

  const baseline = new Set((await readProjection(origin)).sessions.map(row => row.sessionId))
  step = 'session.create through control intent'
  const create = await command(origin, { kind: 'session.create', agentId: AGENT_ID, title: 'E562 black box' })
  assert(create.status === 200 && create.body.ok === true, `control accepted session.create (${create.status})`)
  assert(typeof create.body.result?.acceptedRevision === 'number', `control reported the durable accepted revision (${create.body.result?.acceptedRevision})`)
  record('sessionCreateCommand', create.body)

  step = 'agent executes session/new and publishes it'
  const createdProjection = await awaitProjection(
    origin,
    body => body.sessions?.some(row => row.agentId === AGENT_ID && !baseline.has(row.sessionId)) === true,
    'the agent never published the Session created by control intent',
  )
  const created = createdProjection.sessions.find(row => row.agentId === AGENT_ID && !baseline.has(row.sessionId))
  assert(created !== undefined, `the projection carries the new Session (${created?.sessionId})`)
  record('sessionId', created.sessionId)
  record('projectionAfterCreate', createdProjection)

  step = 'session.open through control'
  const opened = await command(origin, { kind: 'session.open', agentId: AGENT_ID, sessionId: created.sessionId })
  assert(opened.status === 200 && opened.body.ok === true && opened.body.result?.sessionId === created.sessionId, 'control opens the published Session')
  record('sessionOpenCommand', opened.body)

  step = 'message send and timeline events'
  const sent = await sendMessage(origin, { agentId: AGENT_ID, sessionId: created.sessionId }, { text: 'read /etc/hosts' })
  assert(sent.status === 200 && sent.body.ok === true, `the { text } body was accepted by the Session ingress (${sent.status})`)
  record('sessionMessageCommand', sent.body)
  const active = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === created.sessionId && event.kind === 'part'
      && event.partType === 'text' && event.text === 'read /etc/hosts') === true
      && body.sessionEvents?.some(event => event.sessionId === created.sessionId && event.kind === 'tool') === true,
    'the projection never showed the user text and a tool event',
  )
  const userPart = active.sessionEvents.find(event => event.sessionId === created.sessionId && event.kind === 'part'
    && event.partType === 'text' && event.text === 'read /etc/hosts')
  const toolEvent = active.sessionEvents.find(event => event.sessionId === created.sessionId && event.kind === 'tool')
  assert(userPart?.state === 'completed', 'the user text is projected as a completed timeline part')
  assert(toolEvent !== undefined, `the tool state is projected (${toolEvent?.state})`)
  record('activityProjection', { userPart, toolEvent, sessionEvents: active.sessionEvents })

  step = 'real pending permission with options'
  const permissionProjection = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === created.sessionId && event.kind === 'permission'
      && event.state === 'pending' && (event.options?.length ?? 0) > 0) === true
      && body.notifications?.some(row => row.agentId === AGENT_ID && row.sessionId === created.sessionId && row.kind === 'permission') === true,
    'the projection never carried a pending permission with real options',
  )
  const permissionEvent = permissionProjection.sessionEvents.find(event => event.sessionId === created.sessionId
    && event.kind === 'permission' && event.state === 'pending')
  const notification = permissionProjection.notifications.find(row => row.permissionId === permissionEvent.permissionId)
  const kinds = permissionOptionKinds(permissionEvent)
  assert(kinds.includes('once') && kinds.includes('always') && kinds.includes('reject'), `the permission exposes once/always/reject (${kinds.join(',')})`)
  assert(notification?.state === 'pending' && notification.permissionId === permissionEvent.permissionId, 'the pending notification names the same real permission id')
  record('permission', { permissionId: permissionEvent.permissionId, options: permissionEvent.options, notification })

  step = 'Session B executes while Session A awaits permission'
  const concurrentBaseline = new Set((await readProjection(origin)).sessions.map(row => row.sessionId))
  const createB = await command(origin, { kind: 'session.create', agentId: AGENT_ID, title: 'E562 black box B' })
  assert(createB.status === 200 && createB.body.ok === true, `control accepted session.create for Session B (${createB.status})`)
  const projectionB = await awaitProjection(
    origin,
    body => body.sessions?.some(row => row.agentId === AGENT_ID && !concurrentBaseline.has(row.sessionId)) === true,
    'the agent never published Session B created while Session A was pending',
  )
  const sessionB = projectionB.sessions.find(row => row.agentId === AGENT_ID && !concurrentBaseline.has(row.sessionId))
  assert(sessionB !== undefined && sessionB.sessionId !== created.sessionId, `the projection carries a distinct Session B (${sessionB?.sessionId})`)
  const openB = await command(origin, { kind: 'session.open', agentId: AGENT_ID, sessionId: sessionB.sessionId })
  assert(openB.status === 200 && openB.body.ok === true && openB.body.result?.sessionId === sessionB.sessionId, 'control opens Session B')
  const sentB = await sendMessage(origin, { agentId: AGENT_ID, sessionId: sessionB.sessionId }, { text: 'read /etc/hosts' })
  assert(sentB.status === 200 && sentB.body.ok === true, `Session B accepted a message while A was pending (${sentB.status})`)
  const bActivity = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === sessionB.sessionId && event.kind === 'part'
      && event.partType === 'text' && event.text === 'read /etc/hosts') === true
      && body.sessionEvents?.some(event => event.sessionId === sessionB.sessionId && event.kind === 'tool') === true
      && body.sessionEvents?.some(event => event.sessionId === sessionB.sessionId && event.kind === 'permission'
        && event.state === 'pending' && (event.options?.length ?? 0) > 0) === true,
    'Session B did not execute while Session A awaited permission',
  )
  const stillPendingA = bActivity.sessionEvents.some(event => event.sessionId === created.sessionId
    && event.kind === 'permission' && event.permissionId === permissionEvent.permissionId && event.state === 'pending')
  assert(stillPendingA, 'Session A is still waiting on its permission while Session B ran')
  const bPermission = bActivity.sessionEvents.find(event => event.sessionId === sessionB.sessionId
    && event.kind === 'permission' && event.state === 'pending' && (event.options?.length ?? 0) > 0)
  assert(bPermission !== undefined && bPermission.permissionId !== permissionEvent.permissionId,
    'Session B carries its own distinct pending permission')
  record('concurrentSessionB', {
    sessionId: sessionB.sessionId,
    permissionId: bPermission.permissionId,
    sessionAStillPending: stillPendingA,
  })

  step = 'approval completes the turn'
  const allowOnce = permissionEvent.options.find(option => option.kind === 'once')
  const reply = await command(origin, {
    kind: 'permission.reply',
    agentId: AGENT_ID,
    sessionId: created.sessionId,
    permissionId: permissionEvent.permissionId,
    decision: allowOnce.kind,
    optionId: allowOnce.optionId,
  })
  assert(reply.status === 200 && reply.body.ok === true, `control accepted the permission reply (${reply.status})`)
  record('permissionReplyCommand', reply.body)
  const completed = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === created.sessionId && event.kind === 'permission'
      && event.permissionId === permissionEvent.permissionId && event.state === 'resolved') === true
      && body.sessionEvents?.some(event => event.sessionId === created.sessionId && event.kind === 'part'
        && event.partType === 'text' && event.text.includes('E562-TOOL-DONE')) === true
      && body.sessionEvents?.some(event => event.sessionId === created.sessionId && event.kind === 'final' && event.state === 'completed') === true
      && body.sessionEvents?.some(event => event.sessionId === created.sessionId && event.kind === 'tool'
        && event.state === 'completed' && typeof event.output === 'string' && event.output.includes('localhost')) === true
      && body.notifications?.every(row => row.permissionId !== permissionEvent.permissionId) === true,
    'the turn did not complete after the permission reply',
  )
  const resolved = completed.sessionEvents.find(event => event.sessionId === created.sessionId
    && event.kind === 'permission' && event.permissionId === permissionEvent.permissionId)
  const assistantText = completed.sessionEvents.find(event => event.sessionId === created.sessionId
    && event.kind === 'part' && event.partType === 'text' && event.text.includes('E562-TOOL-DONE'))
  const finalEvent = completed.sessionEvents.find(event => event.sessionId === created.sessionId && event.kind === 'final')
  assert(resolved?.state === 'resolved' && resolved.decision === 'once', `the permission is projected resolved (${resolved?.decision})`)
  assert(assistantText?.state === 'completed', 'the assistant final text is projected as a completed part')
  assert(finalEvent?.state === 'completed', 'the final event is projected completed')
  const completedTool = completed.sessionEvents.find(event => event.sessionId === created.sessionId
    && event.kind === 'tool' && event.state === 'completed')
  assert(typeof completedTool?.output === 'string' && completedTool.output.length > 0,
    `the completed /etc/hosts tool event carries non-empty real text (${JSON.stringify(completedTool?.output?.slice(0, 40))})`)
  assert(completedTool.output.includes('localhost'),
    `the completed /etc/hosts tool event contains localhost (${JSON.stringify(completedTool.output.slice(0, 80))})`)
  record('completedProjection', { resolved, assistantText, finalEvent, completedTool, notifications: completed.notifications })

  step = 'Session B completes after its own permission'
  const bAllowOnce = bPermission.options.find(option => option.kind === 'once')
  const replyB = await command(origin, {
    kind: 'permission.reply',
    agentId: AGENT_ID,
    sessionId: sessionB.sessionId,
    permissionId: bPermission.permissionId,
    decision: bAllowOnce.kind,
    optionId: bAllowOnce.optionId,
  })
  assert(replyB.status === 200 && replyB.body.ok === true, `control accepted Session B permission reply (${replyB.status})`)
  const bCompleted = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === sessionB.sessionId && event.kind === 'part'
      && event.partType === 'text' && event.text.includes('E562-TOOL-DONE') && event.state === 'completed') === true
      && body.sessionEvents?.some(event => event.sessionId === sessionB.sessionId && event.kind === 'final' && event.state === 'completed') === true
      && body.sessionEvents?.some(event => event.sessionId === sessionB.sessionId && event.kind === 'tool'
        && event.state === 'completed' && typeof event.output === 'string' && event.output.includes('localhost')) === true,
    'Session B did not reach a completed terminal state after its permission reply',
  )
  const bFinal = bCompleted.sessionEvents.find(event => event.sessionId === sessionB.sessionId && event.kind === 'final')
  const bTool = bCompleted.sessionEvents.find(event => event.sessionId === sessionB.sessionId
    && event.kind === 'tool' && event.state === 'completed')
  assert(bFinal?.state === 'completed', 'Session B final event is completed')
  assert(typeof bTool?.output === 'string' && bTool.output.includes('localhost'), 'Session B completed tool event carries real /etc/hosts text')
  record('concurrentSessionBCompleted', { final: bFinal, tool: bTool })

  step = 'browser console load'
  if (!existsSync(CHROME)) throw new Error(`Chrome executable is absent: ${CHROME}`)
  const browser = await openBrowser(origin)
  const loaded = await awaitUi(
    browser.cdp,
    browser.sessionId,
    `document.readyState === 'complete'
      && document.querySelector('[data-team-page="discovery"]') !== null
      && document.querySelector('[data-agent-id="${AGENT_ID}"]') !== null`,
    'the real Console did not render the observed Agent on the discovery page',
  )
  assert(loaded === true, 'real Chrome loaded the shipped Console and rendered the observed Agent')
  record('browser', { pid: browser.child.pid, devtools: browser.wsUrl })

  step = 'browser creates a session'
  const detailsClicked = await evaluate(
    browser.cdp,
    browser.sessionId,
    `(() => { const button = document.querySelector('[data-focus-key="agent:${AGENT_ID}:details"]'); if (button === null) return 'absent'; button.click(); return 'clicked' })()`,
  )
  assert(detailsClicked === 'clicked', `the live Agent details action was ${detailsClicked}`)
  await awaitUi(
    browser.cdp,
    browser.sessionId,
    `document.querySelector('[data-focus-key="drawer-agent:${AGENT_ID}:create-session"]') !== null`,
    'the Agent drawer did not expose Create session',
  )
  const browserBaseline = new Set((await readProjection(origin)).sessions.map(row => row.sessionId))
  const createClicked = await evaluate(
    browser.cdp,
    browser.sessionId,
    `(() => { const button = document.querySelector('[data-focus-key="drawer-agent:${AGENT_ID}:create-session"]'); if (button === null || button.disabled) return 'disabled'; button.click(); return 'clicked' })()`,
  )
  assert(createClicked === 'clicked', `the live Create session action was ${createClicked}`)
  const browserCreatedProjection = await awaitProjection(
    origin,
    body => body.sessions?.some(row => row.agentId === AGENT_ID && !browserBaseline.has(row.sessionId)) === true,
    'the browser Create session action never produced an observed Session',
  )
  const browserCreated = browserCreatedProjection.sessions.find(row => row.agentId === AGENT_ID && !browserBaseline.has(row.sessionId))
  assert(browserCreated !== undefined, `the projection carries the browser-created Session (${browserCreated?.sessionId})`)
  record('browserSessionCreate', { sessionId: browserCreated.sessionId, accepted: createClicked })

  step = 'browser composer enabled'
  await evaluate(browser.cdp, browser.sessionId, `document.querySelector('.teams-drawer-header .teams-header-actions button:last-child')?.click()`)
  await awaitUi(browser.cdp, browser.sessionId, `document.querySelector('.teams-drawer') === null`, 'the Agent drawer did not close')
  const interactionClicked = await evaluate(
    browser.cdp,
    browser.sessionId,
    `(() => { const tab = document.querySelector('[data-team-page="interaction"]'); if (tab === null) return 'absent'; tab.click(); return 'clicked' })()`,
  )
  assert(interactionClicked === 'clicked', `the Interaction tab was ${interactionClicked}`)
  await awaitUi(browser.cdp, browser.sessionId, `document.querySelector('[data-team-page-view="interaction"]') !== null`, 'the Interaction page did not render')
  await evaluate(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const refresh = [...document.querySelectorAll('.teams-header-actions button')]
        .find(button => button.textContent === 'Refresh' || button.textContent === '刷新');
      if (refresh === undefined || refresh.disabled) return 'refresh-unavailable';
      refresh.click();
      return 'refreshed';
    })()`,
  )
  await awaitUi(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const button = document.querySelector('[data-session-select=${JSON.stringify(browserCreated.sessionId)}]');
      return button !== null && button.disabled === false;
    })()`,
    'the refreshed Interaction page did not expose the browser-created Session',
  )
  const selected = await evaluate(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const button = document.querySelector('[data-session-select=${JSON.stringify(browserCreated.sessionId)}]');
      if (button === null || button.disabled) return 'absent-or-disabled';
      button.click();
      return 'selected';
    })()`,
  )
  assert(selected === 'selected', `the browser-created Session selection result was ${selected}`)
  await awaitUi(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const composer = document.querySelector('textarea[data-focus-key="session:message"]')?.closest('form');
      return composer !== undefined && composer !== null && composer.innerText.includes(${JSON.stringify(browserCreated.sessionId)});
    })()`,
    `the composer did not rebind to the browser-created Session ${browserCreated.sessionId}`,
  )
  const composer = await awaitUi(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const textarea = document.querySelector('textarea[data-focus-key="session:message"]');
      const submit = textarea?.closest('form')?.querySelector('button[type="submit"]');
      if (textarea === undefined || textarea === null || submit === undefined || submit === null) return null;
      return { textareaDisabled: textarea.disabled, submitDisabled: submit.disabled, page: document.querySelector('[data-team-page-view]')?.getAttribute('data-team-page-view') ?? null };
    })()`,
    'the Interaction composer did not render',
  )
  assert(composer.textareaDisabled === false, 'the Interaction message textarea is enabled')
  assert(composer.submitDisabled === false, 'the Interaction Send button is enabled')
  assert(composer.page === 'interaction', `the composer rendered on page ${composer.page}`)
  record('browserComposer', composer)

  step = 'browser sends message and renders timeline'
  const submitted = await evaluate(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const textarea = document.querySelector('textarea[data-focus-key="session:message"]');
      const form = textarea?.closest('form');
      const submit = form?.querySelector('button[type="submit"]');
      if (textarea === null || textarea === undefined || form === null || form === undefined || submit === null || submit === undefined) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'read /etc/hosts');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const liveTextarea = document.querySelector('textarea[data-focus-key="session:message"]');
      const liveForm = liveTextarea?.closest('form');
      const liveSubmit = liveForm?.querySelector('button[type="submit"]');
      if (liveTextarea === null || liveTextarea === undefined || liveForm === null || liveForm === undefined || liveSubmit === null || liveSubmit === undefined) return 'detached';
      if (!liveForm.checkValidity()) return 'invalid';
      liveForm.requestSubmit(liveSubmit);
      return true;
    })()`,
  )
  assert(submitted === true, 'the live message composer submitted')
  let browserMessageRequest
  {
    const deadline = Date.now() + STEP_DEADLINE_MS
    while (Date.now() < deadline) {
      browserMessageRequest = chrome.cdp.events
        .filter(event => event.method === 'Network.requestWillBeSent')
        .map(event => event.params.request)
        .find(request => new URL(request.url).pathname === '/api/v1/session-message')
      if (browserMessageRequest !== undefined) break
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
  assert(browserMessageRequest !== undefined, 'the live composer issued a Session message request')
  const browserMessageUrl = new URL(browserMessageRequest.url)
  assert(browserMessageUrl.searchParams.get('agentId') === AGENT_ID, `the live Session message targeted Agent ${browserMessageUrl.searchParams.get('agentId')}`)
  assert(browserMessageUrl.searchParams.get('sessionId') === browserCreated.sessionId,
    `the live Session message targeted ${browserMessageUrl.searchParams.get('sessionId')}, expected ${browserCreated.sessionId}`)
  record('browserSessionMessageRequest', { method: browserMessageRequest.method, url: browserMessageRequest.url })
  const browserActivity = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === browserCreated.sessionId && event.kind === 'part'
      && event.partType === 'text' && event.text === 'read /etc/hosts') === true
      && body.sessionEvents?.some(event => event.sessionId === browserCreated.sessionId && event.kind === 'tool') === true,
    'the browser-sent message did not appear with its tool event',
  )
  await awaitUi(
    browser.cdp,
    browser.sessionId,
    `document.querySelector('.teams-session-timeline')?.innerText.includes('read /etc/hosts') === true`,
    'the live timeline did not render the user message',
  )
  const browserUserPart = browserActivity.sessionEvents.find(event => event.sessionId === browserCreated.sessionId
    && event.kind === 'part' && event.partType === 'text' && event.text === 'read /etc/hosts')
  assert(browserUserPart?.state === 'completed', 'the browser message is projected as a completed user part')
  record('browserActivity', { userPart: browserUserPart })

  step = 'browser pending permission options'
  const browserPermissionProjection = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === browserCreated.sessionId && event.kind === 'permission'
      && event.state === 'pending' && (event.options?.length ?? 0) > 0) === true,
    'the browser Session never carried a pending permission with options',
  )
  const browserPermission = browserPermissionProjection.sessionEvents.find(event => event.sessionId === browserCreated.sessionId
    && event.kind === 'permission' && event.state === 'pending')
  const permissionUi = await awaitUi(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const buttons = [...document.querySelectorAll('[data-permission-option]')];
      const once = document.querySelector('[data-permission-kind="once"]');
      if (buttons.length < 3 || once === null) return null;
      return {
        optionIds: buttons.map(button => button.getAttribute('data-permission-option')),
        kinds: buttons.map(button => button.getAttribute('data-permission-kind')),
        onceDisabled: once.disabled,
        unavailable: document.querySelector('[data-permission-options-unavailable="true"]') !== null,
      };
    })()`,
    'the live timeline did not render the real permission buttons',
  )
  assert(permissionUi.kinds.includes('once') && permissionUi.kinds.includes('always') && permissionUi.kinds.includes('reject'),
    `the live timeline permission choices are ${permissionUi.kinds.join(',')}`)
  assert(permissionUi.onceDisabled === false, 'the live Allow once button is enabled')
  assert(permissionUi.unavailable === false, 'the live permission did not fall back to the unavailable hint')
  const screenshotBytes = await captureScreenshot()
  record('browserPermission', { event: browserPermission, rendered: permissionUi, screenshot: SCREENSHOT_PATH, screenshotBytes })

  step = 'browser approves and completes'
  const permissionClicked = await evaluate(
    browser.cdp,
    browser.sessionId,
    `(() => { const button = document.querySelector('[data-permission-kind="once"]'); if (button === null || button.disabled) return 'disabled'; button.click(); return 'clicked' })()`,
  )
  assert(permissionClicked === 'clicked', `the live Allow once action was ${permissionClicked}`)
  const browserCompleted = await awaitProjection(
    origin,
    body => body.sessionEvents?.some(event => event.sessionId === browserCreated.sessionId && event.kind === 'permission'
      && event.permissionId === browserPermission.permissionId && event.state === 'resolved' && event.decision === 'once') === true
      && body.sessionEvents?.some(event => event.sessionId === browserCreated.sessionId && event.kind === 'part'
        && event.partType === 'text' && event.text.includes('E562-TOOL-DONE') && event.state === 'completed') === true
      && body.sessionEvents?.some(event => event.sessionId === browserCreated.sessionId && event.kind === 'final' && event.state === 'completed') === true,
    'the browser approval did not complete the Session turn',
  )
  const finalUi = await awaitUi(
    browser.cdp,
    browser.sessionId,
    `(() => {
      const timeline = document.querySelector('.teams-session-timeline');
      const rendered = {
        assistantText: timeline?.innerText.includes('E562-TOOL-DONE') === true,
        finalEvents: document.querySelectorAll('.teams-session-event-final').length,
        pendingPermissionButtons: document.querySelectorAll('[data-permission-option]').length,
      };
      return rendered.assistantText && rendered.finalEvents >= 1 && rendered.pendingPermissionButtons === 0
        ? rendered
        : null;
    })()`,
    'the live timeline did not render the completed turn',
  )
  assert(finalUi.assistantText === true, 'the live timeline rendered the assistant response')
  assert(finalUi.finalEvents >= 1, 'the live timeline rendered the final event')
  assert(finalUi.pendingPermissionButtons === 0, 'the live timeline removed the resolved permission buttons')
  record('browserCompleted', { projection: browserCompleted.sessionEvents.filter(event => event.sessionId === browserCreated.sessionId), finalUi })

  receipts.summary = { checks: checks.length, passed: checks.filter(entry => entry.ok).length }
}

async function stopOwnedResources() {
  if (chrome !== undefined) {
    try { chrome.cdp.close() } catch { /* the CDP socket is already closed */ }
    if (chrome.child.exitCode === null) {
      chrome.child.kill('SIGTERM')
      const deadline = Date.now() + 10_000
      while (chrome.child.exitCode === null && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 100))
      if (chrome.child.exitCode === null && processAlive(chrome.child.pid)) process.kill(chrome.child.pid, 'SIGKILL')
    }
  }
  if (agent !== undefined && agent.child.exitCode === null) {
    agent.child.kill('SIGTERM')
    const deadline = Date.now() + 15_000
    while (agent.child.exitCode === null && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 100))
    if (agent.child.exitCode === null && processAlive(agent.child.pid)) process.kill(agent.child.pid, 'SIGKILL')
  }
  if (controlPid !== undefined && controlPid > 0 && processAlive(controlPid) && controlConfigPath !== undefined) {
    try {
      runCli(['control', 'stop', '--config', controlConfigPath], { HOME: join(ownedRoot, 'home') })
    } catch { /* the control status already recorded the real state */ }
  }
  if (provider !== undefined) await provider.close().catch(() => undefined)
  if (ownedRoot !== undefined) await rm(ownedRoot, { recursive: true, force: true }).catch(() => undefined)
}

const deadline = setTimeout(() => {
  console.error(`FAIL [${step}] overall deadline ${OVERALL_DEADLINE_MS}ms exceeded`)
  void stopOwnedResources().finally(() => process.exit(1))
}, OVERALL_DEADLINE_MS)
deadline.unref()

try {
  await main()
  clearTimeout(deadline)
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipts, undefined, 2)}\n`)
  console.log(`# ${receipts.summary.passed}/${receipts.summary.checks} checks passed; receipt=${RECEIPT_PATH}`)
  await stopOwnedResources()
  process.exit(0)
} catch (error) {
  clearTimeout(deadline)
  console.error(error instanceof Error ? error.stack : String(error))
  await writeFile(RECEIPT_PATH, `${JSON.stringify({ ...receipts, failed: true, step, error: error instanceof Error ? error.message : String(error) }, undefined, 2)}\n`).catch(() => undefined)
  await stopOwnedResources()
  process.exit(1)
}
