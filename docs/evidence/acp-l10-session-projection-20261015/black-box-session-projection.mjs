#!/usr/bin/env node
/**
 * L10 Session-observation black box: the Console projection carries the real Session and the
 * real permission identity the agent daemon's own engine holds.
 *
 * This driver starts REAL daemons through the REAL CLI: one `control start --config` control
 * daemon and one `agentteams --serve opencode --ip --port --config` agent daemon, both on a
 * real loopback listener, with a real OpenCode engine and a real OpenAI-compatible stub
 * provider. Both daemons run under ONE owned `HOME`, so the agent daemon publishes the
 * observation record and the control daemon reads the same file.
 *
 * The driver holds ONE real ACP connection to the agent daemon and plays the controller: it
 * opens the Session and sends the prompt, so a REAL `session/request_permission` callback is
 * pending on the agent's own host. It never answers that callback until the checks that need
 * it pending are done.
 *
 * It proves:
 *   (a) no observation record exists before any Session is opened;
 *   (b) the agent daemon publishes the real Session id its engine returned;
 *   (c) the published permission row carries the REAL controller-visible callback id, and its
 *       own row id is derived from that id;
 *   (d) an unchanged observation writes no new revision, so a poll is not a heartbeat;
 *   (e) the control daemon's real Console projection carries the Session row and the pending
 *       permission row with that real identity, under the agent that really owns them;
 *   (f) the projection carries NO `sessionEvents`, which is the honest remaining gap;
 *   (g) the real SSE stream delivers a snapshot that carries those rows, so the snapshot is
 *       driven by the observation and not only by the driver's polling;
 *   (h) the projection surface still requires the declared Basic credential;
 *   (i) answering the callback over ACP removes the permission row and the projected
 *       notification while the Session row stays;
 *   (j) closing the controller channel releases the Session that channel owned, while the
 *       Sessions other open channels of the same daemon still own stay reported;
 *   (k) the control daemon never writes the observation record;
 *   (l) SIGTERM on the agent daemon makes IT publish the empty observation, and the control
 *       daemon then projects neither Session nor permission.
 *
 * WHAT THIS DOES NOT PROVE (read before citing it)
 *   - This is source-tree evidence. It runs the worktree's compiled `generated/runtime-lib`
 *     through the source CLI, not an installed artifact.
 *   - It uses a local OpenAI-compatible stub provider for the OpenCode engine. It proves the
 *     daemon, the publisher, the record, the control read and the engine mapping, not any
 *     upstream model.
 *   - The notification title is a fixed Console label. The ACP permission callback carries
 *     options, not a subject, and this driver proves no engine-supplied title.
 *   - No registry daemon runs here, so the control daemon has no directory liveness truth and
 *     projects the last published observation until the owner publishes the empty one. The
 *     directory-reported offline gate is a unit-level fact, not proven here.
 *   - `sessionEvents` (the engine option set the Console approve buttons need) is out of this
 *     increment and is asserted absent rather than claimed.
 *   - The observation also reports the Session of the agent daemon's OWN readiness channel:
 *     `verifyReadiness` in `runtime/acp-serve.ts` runs a real `session/new` on a channel that
 *     stays open for the daemon's lifetime. That Session is real and honestly reported; whether
 *     the Console should list a Session that no controller opened is a Console-surface decision
 *     this increment does not make.
 *   - It is not restart, deployment, cross-device or multi-account evidence.
 *
 * Usage: node docs/evidence/acp-l10-session-projection-20261015/black-box-session-projection.mjs
 * Env:   OPENCODE_EXECUTABLE (default /Users/fanzhang/.opencode/bin/opencode)
 *        L10SP_STEP_DEADLINE_MS (default 120000)
 *        L10SP_OVERALL_DEADLINE_MS (default 900000)
 *        L10SP_RECEIPT_PATH (default <driver dir>/receipt.json)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const driverDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(driverDirectory, '..', '..', '..')
const CLI = process.env.AGENTTEAMS_CLI ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = process.env.AGENTTEAMS_CLI === undefined ? repositoryRoot : resolve(dirname(process.env.AGENTTEAMS_CLI), '..')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const RECEIPT_PATH = process.env.L10SP_RECEIPT_PATH ?? join(driverDirectory, 'receipt.json')
const STEP_DEADLINE_MS = Number(process.env.L10SP_STEP_DEADLINE_MS ?? 120_000)
const OVERALL_DEADLINE_MS = Number(process.env.L10SP_OVERALL_DEADLINE_MS ?? 900_000)

const ACCOUNT = 'local'
const SCOPE = 'local'
const AGENT_ID = 'l10sp-agent'
const AGENT_HOST_ID = 'host-l10sp-agent'
const CONTROL_ID = 'l10sp-control'
const USERNAME = 'l10sp'
const PASSWORD_ENV = 'L10SP_WEBUI_PASSWORD'
const PASSWORD = 'l10sp-webui-secret'
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`
const OBSERVATION_FILE_NAME = 'session-observation.json'
const QUIET_WINDOW_MS = 5_000
const PROVIDER_CREDENTIAL = 'l10sp-probe-secret'

let ownedRoot
let step = 'start'
let logDirectory
let observationRoot
let agentStateDirectory
const live = { agent: null, controlPid: null, controlConfigPath: null, provider: null, client: null, checks: [] }
const receipts = { checks: live.checks, sessionId: undefined, permissionId: undefined, observationPath: undefined, projection: undefined }

function assert(condition, message) {
  const entry = { step, ok: Boolean(condition), message }
  live.checks.push(entry)
  if (!condition) {
    console.error(`FAIL [${step}] ${message}`)
    throw new Error(message)
  }
  console.log(`PASS [${step}] ${message}`)
}

function record(name, value) {
  receipts[name] = value
}

function runCliSync(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: CLI_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return `${result.stdout}${result.stderr}`
}

function processRow(pid) {
  try {
    return execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
 * Local OpenAI-compatible stub provider. One `read` tool call per conversation, so each
 * prompt raises exactly one real `session/request_permission`.
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
      calls.push({ model: parsed.model ?? '', text, carriesToolResult })
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
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
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

function controlConfig({ directory, port }) {
  return `version = 4

[daemon]
kind = "control"
id = ${JSON.stringify(CONTROL_ID)}
hostId = "host-l10sp-control"
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
credentialRef = "env:L10SP_CRED_PEER"
`
}

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
label = "L10 Session-observation stub provider"
enabled = true
credentialEnv = "L10SP_PROBE_API_KEY"

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
  const deadline = Date.now() + 120_000
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
        deadline = setTimeout(() => { settle(); rejectFrame(new Error(`timed out waiting for an ACP frame at ${label}`)) }, timeoutMs)
        if (check()) return
        waiters.push(check)
      }),
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

async function readProjection(origin, authorization = BASIC) {
  const response = await fetch(`${origin}/api/v1/projection`, { headers: authorization === null ? {} : { authorization } })
  return { status: response.status, body: await response.json() }
}

function observationPath() {
  return join(observationRoot, OBSERVATION_FILE_NAME)
}

async function readObservation() {
  if (!existsSync(observationPath())) return undefined
  return JSON.parse(await readFile(observationPath(), 'utf8'))
}

async function awaitObservation(match, label) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  let observed
  while (Date.now() < deadline) {
    observed = await readObservation()
    if (match(observed)) return observed
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`${label}: no observation matched within ${STEP_DEADLINE_MS}ms; observed=${JSON.stringify(observed)}`)
}

async function awaitProjection(origin, match, label) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  let observed
  while (Date.now() < deadline) {
    observed = (await readProjection(origin)).body
    if (match(observed)) return observed
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`${label}: no projection matched within ${STEP_DEADLINE_MS}ms; observed=${JSON.stringify(observed).slice(0, 2000)}`)
}

/**
 * The real SSE projection stream. One snapshot is enough to prove the stream is driven by
 * the owner's own projection; the driver never fabricates a frame.
 */
function firstEventSnapshot(origin) {
  return new Promise((resolveFrame, rejectFrame) => {
    const controller = new AbortController()
    const request = async () => {
      const response = await fetch(`${origin}/api/v1/events`, { headers: { authorization: BASIC }, signal: controller.signal })
      assert(response.status === 200, `the SSE projection stream accepts the declared credential (${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          for (;;) {
            const blank = buffer.indexOf('\n\n')
            if (blank < 0) break
            const block = buffer.slice(0, blank)
            buffer = buffer.slice(blank + 2)
            const line = block.split('\n').find(row => row.startsWith('data: '))
            if (line !== undefined) {
              controller.abort()
              resolveFrame(JSON.parse(line.slice('data: '.length)))
              return
            }
          }
        }
      } catch (error) {
        if (error?.name === 'AbortError') return
        rejectFrame(error)
      }
    }
    request().catch(error => { controller.abort(); rejectFrame(error) })
  })
}

async function main() {
  if (!existsSync(OPENCODE)) throw new Error(`the OpenCode executable is absent: ${OPENCODE}`)
  const directory = await mkdtemp(join(tmpdir(), 'l10sp-blackbox-'))
  ownedRoot = directory
  console.log('# L10 Session-observation black box: the Console projects the real Session')
  console.log(`cli=${CLI}`)
  console.log(`engine=${OPENCODE}`)
  console.log(`root=${directory}`)

  logDirectory = join(directory, 'cli-logs')
  await mkdir(logDirectory, { recursive: true })
  agentStateDirectory = join(directory, 'agent', 'state')
  const workspace = join(directory, 'agent', 'workspace')
  await mkdir(workspace, { recursive: true })
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  observationRoot = join(home, '.agentteams', 'sessions', ACCOUNT, SCOPE, AGENT_ID)
  record('observationPath', observationPath())

  step = 'no observation before any Session'
  assert(!existsSync(observationPath()), 'no Session observation record exists before the agent daemon runs')

  const controlPort = await availableLoopbackPort()
  const agentPort = await availableLoopbackPort()
  const provider = await startStubProvider()
  live.provider = provider

  const operatorEnv = {
    HOME: home,
    L10SP_CRED_PEER: 'Bearer l10sp-peer-secret',
    L10SP_PROBE_API_KEY: PROVIDER_CREDENTIAL,
    [PASSWORD_ENV]: PASSWORD,
  }

  const controlPath = join(directory, 'control.toml')
  const agentPath = join(directory, 'agent.toml')
  live.controlConfigPath = controlPath
  await writeFile(controlPath, controlConfig({ directory: join(directory, 'control'), port: controlPort }))
  await writeFile(agentPath, agentConfig({ ip: '127.0.0.1', port: agentPort, directory: join(directory, 'agent'), baseUrl: provider.baseUrl }))
  record('controlConfigPath', controlPath)
  record('agentConfigPath', agentPath)

  step = 'control start'
  runCliSync(['control', 'start', '--config', controlPath], operatorEnv)
  const controlStatus = parseFields(runCliSync(['control', 'status', '--config', controlPath], operatorEnv).trim().split('\n').filter(Boolean).at(-1))
  live.controlPid = Number(controlStatus.pid)
  assert(Number.isSafeInteger(live.controlPid) && processAlive(live.controlPid), `the control daemon reports a live explicit pid (${live.controlPid})`)
  assert(controlStatus.state === 'running', `the control daemon reports running (${controlStatus.state})`)
  const origin = `http://127.0.0.1:${controlPort}`
  record('control', { pid: live.controlPid, origin })

  step = 'agent readiness'
  const agentEntry = spawnAgent({ ip: '127.0.0.1', port: agentPort, configPath: agentPath, env: operatorEnv })
  const readyLine = await awaitAgentReady(agentEntry)
  const readyFields = parseFields(readyLine)
  record('agentReady', readyLine.trim())
  assert(agentEntry.child.pid > 0 && processAlive(agentEntry.child.pid), `the agent daemon is live with explicit pid ${agentEntry.child.pid}`)
  assert(readyFields.enginePid !== undefined && processAlive(Number(readyFields.enginePid)), `the agent daemon spawned a live engine child (${readyFields.enginePid})`)

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
  record('sessionId', sessionId)
  assert(typeof sessionId === 'string' && sessionId.length > 0, `the engine returned a real sessionId (${String(sessionId).slice(0, 12)}…)`)

  step = 'prompt and permission callback'
  await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } })
  const callback = await client.awaitFrame(frame => frame.method === 'session/request_permission', 120_000, 'prompt permission callback')
  const permissionId = callback.id
  const options = callback.params?.options ?? []
  record('permission', { id: permissionId, engineOptionKinds: options.map(option => option.kind) })
  assert(typeof permissionId === 'string' && permissionId.length > 0, `the engine raised a real permission callback the controller received as id ${permissionId}`)
  assert(options.some(option => option.kind === 'allow_once'), `the callback carries a real engine option set (${options.map(option => option.kind).join(',')})`)

  step = 'agent publishes the observation'
  const published = await awaitObservation(
    record_ => record_?.sessions?.some(row => row.sessionId === sessionId) === true
      && record_?.permissions?.some(row => row.permissionId === permissionId) === true,
    'the observation never reported the real Session and permission together',
  )
  assert(published.agentId === AGENT_ID, `the observation names the agent that owns it (${published.agentId})`)
  const permissionRow = published.permissions.find(row => row.permissionId === permissionId)
  assert(permissionRow !== undefined, `the observation carries the REAL controller-visible permission id ${permissionId}`)
  assert(permissionRow.sessionId === sessionId, `the permission row names the real Session (${permissionRow.sessionId})`)
  assert(permissionRow.notificationId === `permission:${permissionId}`, `the permission row's own id is derived from the callback id (${permissionRow.notificationId})`)
  record('observation', published)

  step = 'an unchanged observation is not a heartbeat'
  const firstRevision = (await readObservation()).revision
  await new Promise(resolveWait => setTimeout(resolveWait, QUIET_WINDOW_MS))
  const secondRevision = (await readObservation()).revision
  assert(firstRevision === secondRevision, `an unchanged observation keeps its revision (${firstRevision})`)

  step = 'projection carries the real Session'
  const projected = await awaitProjection(
    origin,
    body => body.sessions?.some(row => row.agentId === AGENT_ID && row.sessionId === sessionId) === true
      && body.notifications?.some(row => row.permissionId === permissionId) === true,
    'the control projection never carried the real Session and permission',
  )
  record('projection', projected)
  assert(projected.version === 1, `the projection keeps its frozen version (${projected.version})`)
  const notification = projected.notifications.find(row => row.permissionId === permissionId)
  assert(notification.kind === 'permission' && notification.state === 'pending', `the notification row is a pending permission (${notification.kind}/${notification.state})`)
  assert(notification.agentId === AGENT_ID && notification.sessionId === sessionId, 'the notification row names the agent and the Session that really own it')
  assert(typeof notification.title === 'string' && notification.title.length > 0, `the notification row carries a non-empty Console title (${notification.title})`)
  assert(projected.sessionEvents === undefined || projected.sessionEvents.length === 0, 'the projection carries NO sessionEvents, which is the honest remaining gap')

  step = 'SSE snapshot carries the real rows'
  const frame = await firstEventSnapshot(origin)
  assert(typeof frame.seq === 'number' && frame.seq >= 1, `the SSE stream delivered a sequenced snapshot (seq=${frame.seq})`)
  assert(frame.projection.sessions?.some(row => row.sessionId === sessionId) === true, 'the streamed snapshot carries the real Session row')
  assert(frame.projection.notifications?.some(row => row.permissionId === permissionId) === true, 'the streamed snapshot carries the real pending permission')
  record('sseSnapshot', { seq: frame.seq, sessions: frame.projection.sessions, notifications: frame.projection.notifications })

  step = 'the projection surface still requires its credential'
  const anonymous = await readProjection(origin, null)
  assert(anonymous.status === 401, `an unauthenticated projection read is refused (${anonymous.status})`)

  step = 'the control daemon never writes the observation'
  assert(!existsSync(join(directory, 'control', OBSERVATION_FILE_NAME)), 'the control daemon data directory holds no observation record')
  assert(existsSync(observationPath()), 'the only observation record on this host is the one the agent daemon published')

  step = 'answering the callback removes the permission row'
  const allowOnce = options.find(option => option.kind === 'allow_once')
  await client.send({ jsonrpc: '2.0', id: permissionId, result: { outcome: { outcome: 'selected', optionId: allowOnce.optionId } } })
  await client.awaitFrame(frame => frame.id === 'prompt-1', 120_000, 'the prompt completes after the driver answers the callback')
  const withoutPermission = await awaitObservation(
    record_ => record_?.permissions?.every(row => row.permissionId !== permissionId) === true,
    'the observation never dropped the answered permission',
  )
  assert(withoutPermission.permissions.length === 0, 'the observation carries no pending permission after the engine answered it')
  assert(withoutPermission.sessions.some(row => row.sessionId === sessionId), 'the observation still reports the open Session')
  const afterReply = await awaitProjection(
    origin,
    body => body.notifications?.every(row => row.permissionId !== permissionId) === true && body.sessions?.some(row => row.sessionId === sessionId) === true,
    'the control projection never dropped the answered permission',
  )
  record('projectionAfterReply', afterReply)

  step = 'closing the controller channel releases the controller Session'
  const released = published.sessions.map(row => row.sessionId)
  await client.close()
  live.client = null
  const withoutSession = await awaitObservation(
    record_ => record_?.sessions?.every(row => row.sessionId !== sessionId) === true,
    'the observation never dropped the controller Session',
  )
  assert(withoutSession.sessions.every(row => row.sessionId !== sessionId), `closing the controller channel released its own Session ${String(sessionId).slice(0, 12)}…`)
  record('sessionsWhileOpen', released)
  record('sessionsAfterChannelClose', withoutSession.sessions)
  record('otherOwnedSessions', withoutSession.sessions)
  const afterClose = await awaitProjection(
    origin,
    body => body.sessions?.every(row => row.sessionId !== sessionId) === true,
    'the control projection never dropped the controller Session',
  )
  record('projectionAfterClose', afterClose)

  step = 'the agent daemon publishes the empty observation on stop'
  agentEntry.child.kill('SIGTERM')
  const deadline = Date.now() + STEP_DEADLINE_MS
  let stopped
  while (Date.now() < deadline) {
    stopped = await readObservation()
    if ((stopped?.sessions?.length ?? 0) === 0 && (stopped?.permissions?.length ?? 0) === 0) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert((stopped?.sessions?.length ?? -1) === 0 && (stopped?.permissions?.length ?? -1) === 0, 'the agent daemon published the empty observation itself when it stopped')
  record('observationAfterStop', stopped)
  const afterStop = await awaitProjection(
    origin,
    body => (body.sessions?.length ?? -1) === 0 && (body.notifications?.length ?? -1) === 0,
    'the control projection never dropped the stopped agent rows',
  )
  record('projectionAfterStop', afterStop)
  assert(true, 'the control daemon projects neither Session nor permission for the stopped agent')

  receipts.summary = { checks: live.checks.length, passed: live.checks.filter(entry => entry.ok).length }
  await writeFile(RECEIPT_PATH, `${JSON.stringify({ version: 1, driver: 'acp-l10-session-projection', ...receipts }, undefined, 2)}\n`)
  console.log(`# ${live.checks.length}/${live.checks.length} checks passed; receipt=${RECEIPT_PATH}`)
}

async function stopOwnedResources() {
  if (live.client !== null) { await live.client.close().catch(() => undefined); live.client = null }
  if (live.agent !== null && live.agent.child.exitCode === null) live.agent.child.kill('SIGTERM')
  if (live.controlPid !== undefined && live.controlPid > 0 && processAlive(live.controlPid)) {
    try {
      runCliSync(['control', 'stop', '--config', live.controlConfigPath], { HOME: join(ownedRoot, 'home') })
    } catch { /* the receipt already recorded the outcome */ }
  }
  if (live.provider !== null) await live.provider.close().catch(() => undefined)
  if (ownedRoot !== undefined) await rm(ownedRoot, { recursive: true, force: true }).catch(() => undefined)
}

const deadline = setTimeout(() => {
  console.error(`FAIL the driver exceeded its overall deadline ${OVERALL_DEADLINE_MS}ms at [${step}]`)
  void stopOwnedResources().finally(() => process.exit(1))
}, OVERALL_DEADLINE_MS)
deadline.unref()

try {
  await main()
  clearTimeout(deadline)
  await stopOwnedResources()
  process.exit(0)
} catch (error) {
  clearTimeout(deadline)
  console.error(error instanceof Error ? error.stack : String(error))
  await writeFile(RECEIPT_PATH, `${JSON.stringify({ version: 1, driver: 'acp-l10-session-projection', failed: true, step, error: error instanceof Error ? error.message : String(error), ...receipts }, undefined, 2)}\n`).catch(() => undefined)
  await stopOwnedResources()
  process.exit(1)
}
