#!/usr/bin/env node
/**
 * 8dde877 Console group API black box (owner: runtime / Carol).
 *
 * One real registry daemon, two real agent daemons (OpenCode engine, local stub provider)
 * and one real control daemon, all started through the real CLI. Nothing is driven except
 * the authenticated Console HTTP surface: the driver never imports runtime modules, never
 * writes an endpoint record, never opens the agent group socket and never touches group
 * state directly.
 *
 * Proves over the public entrypoint:
 *  - a declared peer's group frames reach the real group owner and its reply comes back;
 *  - group state, message send and message page are real (durable across frames);
 *  - an owner-authored refusal keeps its own code and status;
 *  - an undeclared agent and a malformed envelope are bad input;
 *  - a declared peer with no published record is not-configured;
 *  - a published record whose socket is dead is unreachable;
 *  - a graceful agent stop withdraws the record, so the same request becomes not-configured.
 *
 * Usage: node docs/evidence/group-webui-first-delivery-20261024/black-box-group-api.mjs
 * Requires: a prior `pnpm build` (the CLI runs generated/runtime-lib), openssl, and a host
 * with a non-internal IPv4 interface.
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The agent group socket is a Unix domain socket. macOS limits its path to about 104
// bytes, so the fixture root must stay short: /tmp is used instead of the default /var/
// folders sandbox root, whose prefix alone would overflow the limit.
const SANDBOX_ROOT = process.env.GROUP_API_SANDBOX_ROOT ?? '/tmp'

const driverDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(driverDirectory, '..', '..', '..')
const CLI = process.env.AGENTTEAMS_CLI ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = process.env.AGENTTEAMS_CLI === undefined ? repositoryRoot : resolve(dirname(process.env.AGENTTEAMS_CLI), '..')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const RECEIPT_PATH = process.env.GROUP_API_RECEIPT_PATH ?? join(driverDirectory, 'receipt.json')
const STEP_DEADLINE_MS = Number(process.env.GROUP_API_STEP_DEADLINE_MS ?? 120_000)
const OVERALL_DEADLINE_MS = Number(process.env.GROUP_API_OVERALL_DEADLINE_MS ?? 900_000)

const ACCOUNT = 'local'
const SCOPE = 'local'
/** The live owner the Console forwards to, and the two peers it must not reach. */
const OWNER = { agentId: 'group-owner', hostId: 'host-group-owner' }
const STOPPED = { agentId: 'group-retire', hostId: 'host-group-retire' }
const ABSENT = { agentId: 'group-absent', hostId: 'host-group-absent' }
const UNDECLARED = 'group-ghost'
const USERNAME = 'group-api-blackbox'
const PASSWORD_ENV = 'GROUP_API_WEBUI_PASSWORD'
const PASSWORD = 'group-api-webui-secret'
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`
const ENDPOINT_FILE_NAME = 'local-group-endpoint.json'

const CREDENTIALS = {
  owner: 'Bearer group-api-owner-secret',
  retire: 'Bearer group-api-retire-secret',
  absent: 'Bearer group-api-absent-secret',
  peer: 'Bearer group-api-peer-secret',
  probe: 'group-api-probe-secret',
}

let step = 'startup'
let logDirectory = null
let cliRunCounter = 0
let ownedRoot = null
const live = { entries: [], registryPid: null, registryConfigPath: null, controlPid: null, controlConfigPath: null }
const receipts = {
  driver: 'group-webui-first-delivery-20261024/black-box-group-api.mjs',
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
  cliRunCounter += 1
  const logPath = join(logDirectory, `cli-${cliRunCounter}.log`)
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

function lanIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

async function availablePort(ip) {
  const listener = createNetServer()
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, ip, () => resolveListen())
  })
  const address = listener.address()
  await new Promise(resolveClose => listener.close(() => resolveClose()))
  return address.port
}

function generateTls(directory, name, sanIp) {
  const keyPath = join(directory, `${name}-key.pem`)
  const certPath = join(directory, `${name}-cert.pem`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=IP:${sanIp},DNS:localhost,IP:127.0.0.1`,
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
  return { keyPath, certPath }
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

/** Local OpenAI-compatible stub provider, so the engine boots without a live model call. */
function startStubProvider() {
  const calls = []
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push({ model: parsed.model ?? '', text: lastUserText(parsed) })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(chunk({ role: 'assistant', content: 'PROBE-START' }))
      response.write(finish)
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

function stableReferenceOf(text) {
  const match = /\[agentteams:([^\]]+)\]/u.exec(typeof text === 'string' ? text : '')
  return match?.[1]
}

/**
 * Local Vikunja HTTP boundary, so the daemon's own vikunja-sync is still the
 * only writer. The create write is applied before its reply is dropped, and the
 * first recovery list read is held past the hub deadline; the stub itself never
 * decides group or issue state.
 */
function startStubVikunja() {
  const tasks = new Map()
  const calls = { create: [], list: [] }
  const sockets = new Set()
  let nextTaskId = 101
  let dropNextCreateResponse = false
  let holdNextListResponse = false
  let held = undefined

  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub-vikunja.invalid')
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const send = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      const projectTasks = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/tasks$/u)
      if (request.method === 'PUT' && projectTasks) {
        const parsed = JSON.parse(body)
        const task = {
          id: nextTaskId,
          project_id: projectTasks[1],
          title: String(parsed.title ?? ''),
          description: String(parsed.description ?? ''),
          done: false,
        }
        nextTaskId += 1
        tasks.set(String(task.id), task)
        calls.create.push({ commitId: stableReferenceOf(task.description), issueId: String(task.id) })
        if (dropNextCreateResponse) {
          dropNextCreateResponse = false
          // The write is applied by this process, but the caller gets no
          // complete response: the external outcome is genuinely unknown.
          response.destroy()
          return
        }
        send(200, task)
        return
      }
      if (request.method === 'GET' && projectTasks) {
        calls.list.push({ projectId: projectTasks[1], taskCount: tasks.size })
        if (holdNextListResponse) {
          holdNextListResponse = false
          held = response
          return
        }
        send(200, [...tasks.values()])
        return
      }
      send(404, { message: 'unsupported stub Vikunja route' })
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveStart({
        baseUrl: `http://127.0.0.1:${address.port}`,
        calls,
        dropNextCreateResponse: () => { dropNextCreateResponse = true },
        holdNextListResponse: () => { holdNextListResponse = true },
        releaseHeldListResponse: () => {
          if (held === undefined) return false
          const response = held
          held = undefined
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('[]')
          return true
        },
        counts: () => ({ create: calls.create.length, list: calls.list.length }),
        close: () => new Promise(resolveClose => {
          if (held !== undefined) {
            held.destroy()
            held = undefined
          }
          for (const socket of sockets) socket.destroy()
          server.close(() => resolveClose())
        }),
      })
    })
  })
}

function registryConfig({ directory, port, keyPath, certPath }) {
  return `version = 4

[daemon]
kind = "registry"
id = "group-api-registry"
hostId = "registry-host"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(join(directory, 'registry-state'))}

[listen]
ip = "127.0.0.1"
port = ${port}
tlsCertRef = "file:${certPath}"
tlsKeyRef = "file:${keyPath}"

[[admissions]]
admissionRef = "adm-owner"
agentId = ${JSON.stringify(OWNER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:GROUP_API_CRED_OWNER"

[[admissions]]
admissionRef = "adm-retire"
agentId = ${JSON.stringify(STOPPED.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:GROUP_API_CRED_RETIRE"

[[admissions]]
admissionRef = "adm-absent"
agentId = ${JSON.stringify(ABSENT.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:GROUP_API_CRED_ABSENT"
`
}

/**
 * The control daemon declares all three peers. Only the owner daemon is ever started, so
 * "declared but absent" and "declared and unreachable" are real states of this deployment.
 */
function controlConfig({ directory, port }) {
  const peer = name => `
[peers.${name}]
agentId = ${JSON.stringify(name)}
hostId = ${JSON.stringify(`host-${name}`)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:GROUP_API_CRED_PEER"
`
  return `version = 4

[daemon]
kind = "control"
id = "group-api-console"
hostId = "console-host"
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
${peer(OWNER.agentId)}${peer(STOPPED.agentId)}${peer(ABSENT.agentId)}`
}

function agentConfig({ id, hostId, ip, port, keyPath, certPath, trustPath, registryPort, directory, baseUrl, credentialRef, vikunjaBaseUrl }) {
  return `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(id)}
hostId = ${JSON.stringify(hostId)}
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
tlsCertRef = "file:${certPath}"
tlsKeyRef = "file:${keyPath}"

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[relations]
allowed = ["master", "peer"]

[[admissions]]
admissionRef = "adm-console"
agentId = "group-api-console"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:GROUP_API_CRED_PEER"

[discovery]
serverId = "group-api-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = ${JSON.stringify(credentialRef)}
tlsTrustRef = "file:${trustPath}"

[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(baseUrl)}
label = "group api stub provider"
enabled = true
credentialEnv = "GROUP_API_PROBE_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
${vikunjaBaseUrl === undefined ? '' : `
[vikunja]
baseUrl = ${JSON.stringify(vikunjaBaseUrl)}
tokenRef = "env:GROUP_API_VIKUNJA_TOKEN"
`}
`
}

function spawnAgent({ label, ip, port, configPath, env }) {
  const child = spawn(process.execPath, [CLI, '--serve', 'opencode', '--ip', ip, '--port', String(port), '--config', configPath], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entry = { label, child, stdout: '', stderr: '', ready: undefined }
  child.stdout.on('data', chunk => {
    entry.stdout += chunk.toString('utf8')
    for (const line of entry.stdout.split('\n')) {
      if (entry.ready === undefined && line.startsWith('serving ')) entry.ready = line
    }
  })
  child.stderr.on('data', chunk => { entry.stderr += chunk.toString('utf8') })
  live.entries.push(entry)
  return entry
}

async function awaitReady(entry) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  while (Date.now() < deadline) {
    if (entry.ready !== undefined) return entry.ready
    if (entry.child.exitCode !== null) throw new Error(`${entry.label} exited before readiness; stderr=${entry.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`${entry.label} never printed a readiness line; stderr=${entry.stderr}`)
}

async function awaitRegistrationOnline(entry) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  while (Date.now() < deadline) {
    const line = entry.stdout.split('\n').filter(candidate => candidate.startsWith('registration ')).pop()
    if (line !== undefined && line.includes('state=online')) return line
    if (entry.child.exitCode !== null) throw new Error(`${entry.label} exited before registration online; stderr=${entry.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`${entry.label} never reported registration state=online; stdout=${entry.stdout}`)
}

function parseFields(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) {
    fields[match[1]] = match[2].trim()
  }
  return fields
}

/** The record the agent wrote and the control daemon reads. The driver only reads it. */
function endpointRecordPath(home, agentId) {
  return join(home, '.agentteams', 'sessions', ACCOUNT, SCOPE, agentId, ENDPOINT_FILE_NAME)
}

async function readEndpointRecord(home, agentId) {
  try {
    return JSON.parse(await readFile(endpointRecordPath(home, agentId), 'utf8'))
  } catch (cause) {
    if (cause?.code === 'ENOENT') return undefined
    throw cause
  }
}

async function awaitEndpointRecord(home, agentId, expected) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  while (Date.now() < deadline) {
    const found = await readEndpointRecord(home, agentId)
    if (expected(found)) return found
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`no matching endpoint record for ${agentId} within ${STEP_DEADLINE_MS}ms`)
}

function groupRequest(origin, agentId, frame, options = {}) {
  const query = options.query ?? `agentId=${encodeURIComponent(agentId)}`
  const body = options.body ?? JSON.stringify({ requestId: frame.requestId, frame })
  return fetch(`${origin}/api/v1/group-request?${query}`, {
    method: 'POST',
    headers: options.authorization === null
      ? { 'content-type': 'application/json' }
      : { authorization: options.authorization ?? BASIC, 'content-type': 'application/json' },
    body,
  }).then(async response => ({ status: response.status, body: await response.json() }))
}

let requestCounter = 0
function nextRequestId(label) {
  requestCounter += 1
  return `req-${label}-${requestCounter}`
}

async function main() {
  const lanIp = lanIpv4()
  if (lanIp === undefined) throw new Error('this host has no non-internal IPv4 interface; the group API black box cannot run')
  const directory = await mkdtemp(join(SANDBOX_ROOT, 'group-api-bb-'))
  ownedRoot = directory
  console.log('# 8dde877 Console group API black box: the real Console route reaches the real group owner')
  receipts.command = [process.execPath, ...process.argv.slice(1)].join(' ')
  receipts.cwd = process.cwd()
  console.log(`cli=${CLI}`)
  console.log(`root=${directory}`)
  console.log(`lanIp=${lanIp}`)

  logDirectory = join(directory, 'cli-logs')
  await mkdir(logDirectory, { recursive: true })
  const tlsDirectory = join(directory, 'tls')
  await mkdir(tlsDirectory, { recursive: true })
  const registryTls = generateTls(tlsDirectory, 'registry', '127.0.0.1')
  const ownerTls = generateTls(tlsDirectory, 'owner', lanIp)
  const retireTls = generateTls(tlsDirectory, 'retire', lanIp)

  // Every daemon resolves its record path from `os.homedir()`, so all of them get this owned
  // home. The driver never creates a record.
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const ownerRecordPath = endpointRecordPath(home, OWNER.agentId)
  assert(!existsSync(ownerRecordPath), 'no endpoint record exists before any agent daemon starts')

  const registryPort = await availablePort('127.0.0.1')
  const controlPort = await availablePort('127.0.0.1')
  const ownerPort = await availablePort(lanIp)
  const retirePort = await availablePort(lanIp)
  const provider = await startStubProvider()
  const vikunja = await startStubVikunja()

  const operatorEnv = {
    HOME: home,
    GROUP_API_CRED_OWNER: CREDENTIALS.owner,
    GROUP_API_CRED_RETIRE: CREDENTIALS.retire,
    GROUP_API_CRED_ABSENT: CREDENTIALS.absent,
    GROUP_API_CRED_PEER: CREDENTIALS.peer,
    GROUP_API_PROBE_KEY: CREDENTIALS.probe,
    GROUP_API_VIKUNJA_TOKEN: 'group-api-vikunja-token',
    [PASSWORD_ENV]: PASSWORD,
  }

  const registryPath = join(directory, 'registry.toml')
  const controlPath = join(directory, 'control.toml')
  const ownerPath = join(directory, 'owner.toml')
  const retirePath = join(directory, 'retire.toml')
  live.registryConfigPath = registryPath
  live.controlConfigPath = controlPath
  await writeFile(registryPath, registryConfig({ directory: join(directory, 'registry'), port: registryPort, keyPath: registryTls.keyPath, certPath: registryTls.certPath }))
  await writeFile(controlPath, controlConfig({ directory: join(directory, 'control'), port: controlPort }))
  await writeFile(ownerPath, agentConfig({
    id: OWNER.agentId, hostId: OWNER.hostId, ip: lanIp, port: ownerPort,
    keyPath: ownerTls.keyPath, certPath: ownerTls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'owner'), baseUrl: provider.baseUrl,
    credentialRef: 'env:GROUP_API_CRED_OWNER', vikunjaBaseUrl: vikunja.baseUrl,
  }))
  await writeFile(retirePath, agentConfig({
    id: STOPPED.agentId, hostId: STOPPED.hostId, ip: lanIp, port: retirePort,
    keyPath: retireTls.keyPath, certPath: retireTls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'retire'), baseUrl: provider.baseUrl,
    credentialRef: 'env:GROUP_API_CRED_RETIRE',
  }))

  step = 'registry start'
  console.log(runCliSync(['registry', 'start', '--config', registryPath], operatorEnv).trim())
  const registryStatus = parseFields(runCliSync(['registry', 'status', '--config', registryPath], operatorEnv).trim())
  live.registryPid = Number(registryStatus.pid)
  assert(registryStatus.state === 'running' && processRow(live.registryPid).length > 0,
    `the real registry daemon reports running with a live pid (${live.registryPid})`)

  step = 'owner agent start'
  const ownerEntry = spawnAgent({ label: 'owner', ip: lanIp, port: ownerPort, configPath: ownerPath, env: operatorEnv })
  const ownerFields = parseFields(await awaitReady(ownerEntry))
  assert(ownerFields.listener === `${lanIp}:${ownerPort}`, `the owner agent serves its real listener (${ownerFields.listener})`)
  const ownerRegistration = await awaitRegistrationOnline(ownerEntry)
  assert(ownerRegistration.includes('state=online'), `the owner agent registered with the real registry (${ownerRegistration})`)
  record('ownerAgent', { pid: ownerEntry.child.pid, listener: ownerFields.listener, registration: ownerRegistration })

  step = 'owner publishes its endpoint record'
  const ownerRecord = await awaitEndpointRecord(home, OWNER.agentId, found => found !== undefined)
  assert(ownerRecord.agentId === OWNER.agentId, `the record names the owner agent (${ownerRecord.agentId})`)
  assert(ownerRecord.groupEndpoint.kind === 'local-socket', `the record names a local socket endpoint (${ownerRecord.groupEndpoint.kind})`)
  const ownerSocketPath = ownerRecord.groupEndpoint.socketPath
  assert(ownerSocketPath.startsWith(join(directory, 'owner')), `the published socket is the daemon's real socket (${ownerSocketPath})`)
  assert(existsSync(ownerSocketPath), 'the published socket really exists on this host')
  record('ownerEndpointRecord', { path: ownerRecordPath, revision: ownerRecord.revision, socketPath: ownerSocketPath })

  step = 'second declared agent start'
  // The second peer runs from the start, so the owner can invite it, it can accept over
  // its own route, and its later graceful stop is the withdrawal evidence.
  const retireEntry = spawnAgent({ label: 'retire', ip: lanIp, port: retirePort, configPath: retirePath, env: operatorEnv })
  const retireFields = parseFields(await awaitReady(retireEntry))
  assert(retireFields.listener === `${lanIp}:${retirePort}`, `the second agent serves its real listener (${retireFields.listener})`)
  const retireRegistration = await awaitRegistrationOnline(retireEntry)
  assert(retireRegistration.includes('state=online'), `the second agent registered with the real registry (${retireRegistration})`)
  const retireRecord = await awaitEndpointRecord(home, STOPPED.agentId, found => found !== undefined)
  assert(typeof retireRecord.groupEndpoint.socketPath === 'string', 'the second agent published its own endpoint record')
  record('retireAgent', { pid: retireEntry.child.pid, listener: retireFields.listener, socketPath: retireRecord.groupEndpoint.socketPath })

  step = 'control start'
  const controlStart = parseFields(runCliSync(['control', 'start', '--config', controlPath], operatorEnv).trim())
  assert(controlStart.state === 'running', `the control daemon reports running (${controlStart.state})`)
  live.controlPid = Number(controlStart.pid)
  assert(processRow(live.controlPid).length > 0, `the control daemon reports a live pid (${live.controlPid})`)
  assert(controlStart.listener === `127.0.0.1:${controlPort}`, `the control daemon serves its declared Console listener (${controlStart.listener})`)
  const origin = `http://127.0.0.1:${controlPort}`
  record('control', { pid: live.controlPid, listener: controlStart.listener })

  step = 'console authentication'
  const listFrame = { kind: 'group.list', requestId: nextRequestId('auth') }
  const anonymous = await groupRequest(origin, OWNER.agentId, listFrame, { authorization: null })
  assert(anonymous.status === 401, `an anonymous group request is refused with 401 (${anonymous.status})`)
  // The route authenticates before it looks at the method, so this one carries credentials.
  const wrongMethod = await fetch(`${origin}/api/v1/group-request?agentId=${OWNER.agentId}`, { headers: { authorization: BASIC } })
  assert(wrongMethod.status === 405, `a GET on the group route is refused as method not allowed (${wrongMethod.status})`)

  step = 'real group read through the owner'
  const emptyList = await groupRequest(origin, OWNER.agentId, listFrame)
  assert(emptyList.status === 200 && emptyList.body.ok === true, `the owner answers group.list over the real Console route (${JSON.stringify(emptyList.body).slice(0, 160)})`)
  assert(emptyList.body.reply.kind === 'group.list', `the reply is the owner's own group.list reply (${emptyList.body.reply.kind})`)
  assert(emptyList.body.reply.requestId === listFrame.requestId, `the reply carries the request id the Console sent (${emptyList.body.reply.requestId})`)
  assert(Array.isArray(emptyList.body.reply.groups) && emptyList.body.reply.groups.length === 0, 'the owner really has no group yet')

  step = 'real group create'
  const createFrame = { kind: 'group.create', requestId: nextRequestId('create'), name: 'console-group-delivery' }
  const created = await groupRequest(origin, OWNER.agentId, createFrame)
  assert(created.status === 200 && created.body.ok === true, `the owner accepted group.create (${JSON.stringify(created.body).slice(0, 200)})`)
  assert(created.body.reply.kind === 'group.created', `the reply is group.created (${created.body.reply.kind})`)
  const groupId = created.body.reply.group.groupId
  assert(typeof groupId === 'string' && groupId.length > 0, `the group has a real id (${groupId})`)
  assert(created.body.reply.group.ownerAgentId === OWNER.agentId, `the group records the owner as owner (${created.body.reply.group.ownerAgentId})`)
  record('createdGroup', { groupId, name: created.body.reply.group.name, owner: created.body.reply.group.ownerAgentId })

  step = 'the group is durable, not a reply echo'
  const listed = await groupRequest(origin, OWNER.agentId, { kind: 'group.list', requestId: nextRequestId('list') })
  const listedIds = listed.body.reply.groups.map(group => group.groupId)
  assert(listedIds.includes(groupId), `a second group.list returns the created group (${JSON.stringify(listedIds)})`)

  step = 'real message send and page'
  const messageBody = 'hello from the console group route'
  const sendFrame = {
    kind: 'message.send', requestId: nextRequestId('send'), commitId: `commit-${groupId}`,
    groupId, targetAgentIds: [OWNER.agentId], replyRequired: false, body: messageBody,
  }
  const sent = await groupRequest(origin, OWNER.agentId, sendFrame)
  assert(sent.status === 200 && sent.body.ok === true, `the owner accepted message.send (${JSON.stringify(sent.body).slice(0, 200)})`)
  assert(sent.body.reply.kind === 'message.sent', `the reply is message.sent (${sent.body.reply.kind})`)
  assert(Number.isSafeInteger(sent.body.reply.sequence) && sent.body.reply.sequence > 0, `the message has a real sequence (${sent.body.reply.sequence})`)
  record('sentMessage', { messageId: sent.body.reply.messageId, sequence: sent.body.reply.sequence })

  const page = await groupRequest(origin, OWNER.agentId, { kind: 'message.page', requestId: nextRequestId('page'), groupId })
  assert(page.status === 200 && page.body.ok === true, `the owner answered message.page (${JSON.stringify(page.body).slice(0, 160)})`)
  const bodies = page.body.reply.messages.map(message => message.body)
  assert(bodies.includes(messageBody), `the page contains the body the Console sent, unchanged (${JSON.stringify(bodies)})`)
  const pagedMessage = page.body.reply.messages.find(message => message.body === messageBody)
  assert(pagedMessage.fromAgentId === OWNER.agentId, `the message records the owner as its real sender (${pagedMessage.fromAgentId})`)
  record('messagePage', { revision: page.body.reply.revision, hasMore: page.body.reply.hasMore, count: page.body.reply.messages.length })

  step = 'real action and issue reads'
  const actions = await groupRequest(origin, OWNER.agentId, { kind: 'action.list', requestId: nextRequestId('actions') })
  assert(actions.status === 200 && actions.body.ok === true && actions.body.reply.kind === 'action.list',
    `the owner answered action.list (${JSON.stringify(actions.body).slice(0, 160)})`)
  const unknownSession = await groupRequest(origin, OWNER.agentId, { kind: 'issue.query', requestId: nextRequestId('issue'), sessionId: 'no-such-session' })
  assert(unknownSession.status === 200, `an unknown issue session stays a 200 owner answer, not a transport failure (${unknownSession.status})`)
  assert(typeof unknownSession.body.ok === 'boolean', `the owner answer is a typed envelope (${JSON.stringify(unknownSession.body).slice(0, 160)})`)
  record('unknownIssueSession', unknownSession.body)

  step = 'fault injection: unknown create and one held recovery read'
  const faultProjectId = 'project-fault'
  const faultCommitId = 'fault-create-1'
  const faultFrame = () => ({
    kind: 'issue.create', requestId: nextRequestId('fault-create'),
    commitId: faultCommitId, groupId, vikunjaProjectId: faultProjectId,
    title: 'fault recovery issue', body: 'created through the real Console route',
  })
  // The external create is applied, then its reply is lost: the hub can only
  // record an unknown outcome.
  vikunja.dropNextCreateResponse()
  const unknownCreate = await groupRequest(origin, OWNER.agentId, faultFrame())
  assert(unknownCreate.status === 200 && unknownCreate.body.ok === false,
    `the lost create reply leaves the write unconfirmed (${JSON.stringify(unknownCreate.body).slice(0, 220)})`)
  assert(vikunja.calls.create.length === 1, 'the stub received exactly one external create write')
  assert(vikunja.calls.create[0].commitId === faultCommitId,
    `the create carried the typed commit id as its stable reference (${vikunja.calls.create[0].commitId})`)
  record('faultUnknownCreate', unknownCreate.body)

  // The first recovery read never answers before the hub's own deadline. A read
  // is not a write: the next retry must issue a fresh read, not replay this.
  vikunja.holdNextListResponse()
  const timedOutRecovery = await groupRequest(origin, OWNER.agentId, faultFrame())
  assert(timedOutRecovery.status === 200 && timedOutRecovery.body.ok === false,
    `a recovery read held past the deadline stays unconfirmed (${JSON.stringify(timedOutRecovery.body).slice(0, 220)})`)
  assert(vikunja.calls.list.length === 1, 'the first recovery read really reached the stub and was held')
  assert(vikunja.releaseHeldListResponse(), 'the held recovery read was released after the hub deadline')
  record('faultTimedOutRecovery', timedOutRecovery.body)

  const recoveredSession = await groupRequest(origin, OWNER.agentId, faultFrame())
  assert(recoveredSession.status === 200 && recoveredSession.body.ok === true && recoveredSession.body.reply.kind === 'issue.session',
    `the next retry reads again and converges (${JSON.stringify(recoveredSession.body).slice(0, 240)})`)
  const faultSessionId = recoveredSession.body.reply.session.sessionId
  assert(faultSessionId.includes(`:${faultProjectId}:`), `the session binds the recovered issue (${faultSessionId})`)
  assert(vikunja.calls.create.length === 1, 'the recovery issued no second create write')
  assert(vikunja.calls.list.length >= 2, `the recovery issued a fresh read (${vikunja.calls.list.length})`)
  record('faultRecoveredSession', { sessionId: faultSessionId, counts: vikunja.counts() })

  // Once confirmed, the same commit replays from the ledger with no external call.
  const replayedSession = await groupRequest(origin, OWNER.agentId, faultFrame())
  assert(replayedSession.status === 200 && replayedSession.body.ok === true,
    `a confirmed create replays its recorded session (${JSON.stringify(replayedSession.body).slice(0, 200)})`)
  assert(vikunja.counts().create === 1 && vikunja.counts().list === 2,
    `the confirmed replay made no external call (${JSON.stringify(vikunja.counts())})`)
  record('faultVikunjaCounts', { counts: vikunja.counts(), creates: vikunja.calls.create, reads: vikunja.calls.list })

  step = 'a second real agent joins over its own route'
  const invited = await groupRequest(origin, OWNER.agentId, {
    kind: 'group.invite', requestId: nextRequestId('invite'), groupId,
    agentId: STOPPED.agentId, role: 'peer',
  })
  assert(invited.status === 200 && invited.body.ok === true && invited.body.reply.kind === 'group.invited',
    `the owner invited the second agent as a peer (${JSON.stringify(invited.body).slice(0, 160)})`)
  const accepted = await groupRequest(origin, STOPPED.agentId, {
    kind: 'group.respond', requestId: nextRequestId('accept'), groupId, accept: true,
  })
  assert(accepted.status === 200 && accepted.body.ok === true && accepted.body.reply.kind === 'group.member',
    `the invited agent accepted over its own real route (${JSON.stringify(accepted.body).slice(0, 160)})`)
  assert(accepted.body.reply.group.members.some(member => member.agentId === STOPPED.agentId),
    'the accepted member is part of the group the owner reads back')

  step = 'owner-authored refusal keeps its own code'
  const forbidden = await groupRequest(origin, OWNER.agentId, {
    kind: 'message.page', requestId: nextRequestId('forbidden'), groupId: 'group-does-not-exist',
  })
  assert(forbidden.status === 200, `an owner refusal is still a 200 owner answer (${forbidden.status})`)
  assert(forbidden.body.ok === false && typeof forbidden.body.error?.code === 'string',
    `the refusal carries the owner's own code (${JSON.stringify(forbidden.body).slice(0, 200)})`)
  record('ownerRefusal', { status: forbidden.status, body: forbidden.body })

  step = 'envelope validation'
  const validFrame = { kind: 'group.list', requestId: nextRequestId('valid') }
  const mismatched = await groupRequest(origin, OWNER.agentId, validFrame, {
    body: JSON.stringify({ requestId: 'other-id', frame: validFrame }),
  })
  assert(mismatched.status === 400 && mismatched.body.code === 'INVALID_INPUT',
    `a requestId that disagrees with its frame is bad input (${mismatched.status} ${JSON.stringify(mismatched.body)})`)
  const unknownKind = await groupRequest(origin, OWNER.agentId, { kind: 'group.unknown', requestId: nextRequestId('unknown') })
  assert(unknownKind.status === 400 && unknownKind.body.code === 'INVALID_INPUT',
    `an unknown frame kind is bad input (${unknownKind.status} ${JSON.stringify(unknownKind.body)})`)
  const extraKey = await groupRequest(origin, OWNER.agentId, validFrame, {
    body: JSON.stringify({ requestId: validFrame.requestId, frame: validFrame, extra: true }),
  })
  assert(extraKey.status === 400 && extraKey.body.code === 'INVALID_INPUT',
    `an extra body key is bad input (${extraKey.status} ${JSON.stringify(extraKey.body)})`)
  const missingTarget = await groupRequest(origin, OWNER.agentId, validFrame, {
    body: JSON.stringify({ requestId: validFrame.requestId, frame: validFrame }), query: '',
  })
  assert(missingTarget.status === 400 && missingTarget.body.code === 'INVALID_INPUT',
    `a missing agentId is bad input (${missingTarget.status} ${JSON.stringify(missingTarget.body)})`)
  const duplicateTarget = await groupRequest(origin, OWNER.agentId, validFrame, {
    body: JSON.stringify({ requestId: validFrame.requestId, frame: validFrame }),
    query: `agentId=${OWNER.agentId}&agentId=${OWNER.agentId}`,
  })
  assert(duplicateTarget.status === 400 && duplicateTarget.body.code === 'INVALID_INPUT',
    `a duplicated agentId is bad input (${duplicateTarget.status} ${JSON.stringify(duplicateTarget.body)})`)
  const extraQuery = await groupRequest(origin, OWNER.agentId, validFrame, {
    body: JSON.stringify({ requestId: validFrame.requestId, frame: validFrame }),
    query: `agentId=${OWNER.agentId}&scope=all`,
  })
  assert(extraQuery.status === 400 && extraQuery.body.code === 'INVALID_INPUT',
    `an extra query parameter is bad input (${extraQuery.status} ${JSON.stringify(extraQuery.body)})`)

  step = 'one hop only'
  const undeclared = await groupRequest(origin, UNDECLARED, { kind: 'group.list', requestId: nextRequestId('ghost') })
  assert(undeclared.status === 400 && undeclared.body.code === 'INVALID_INPUT',
    `an agent this control daemon does not declare is bad input, not a missing endpoint (${undeclared.status} ${JSON.stringify(undeclared.body)})`)
  record('undeclaredAgent', undeclared.body)

  step = 'declared peer with no published record'
  const absent = await groupRequest(origin, ABSENT.agentId, { kind: 'group.list', requestId: nextRequestId('absent') })
  assert(absent.status === 503 && absent.body.code === 'GROUP_ENDPOINT_NOT_CONFIGURED',
    `a declared peer that never published an endpoint is not-configured (${absent.status} ${JSON.stringify(absent.body)})`)
  assert((await readEndpointRecord(home, ABSENT.agentId)) === undefined, 'the absent peer really wrote no record')
  record('absentPeer', absent.body)

  step = 'published record with a dead socket'
  // A hard kill keeps the record and releases the socket: the exact "published but silent"
  // state, produced by the real process rather than by a fixture.
  const ownerKill = new Promise(resolveExit => ownerEntry.child.once('exit', resolveExit))
  ownerEntry.child.kill('SIGKILL')
  await ownerKill
  assert((await readEndpointRecord(home, OWNER.agentId)) !== undefined, 'the killed owner left its published record behind')
  const unreachable = await groupRequest(origin, OWNER.agentId, { kind: 'group.list', requestId: nextRequestId('dead') })
  assert(unreachable.status === 502 && unreachable.body.code === 'GROUP_ENDPOINT_UNREACHABLE',
    `a published endpoint whose socket is gone is unreachable (${unreachable.status} ${JSON.stringify(unreachable.body)})`)
  record('unreachablePeer', unreachable.body)

  step = 'graceful stop withdraws the record'
  const retireBefore = await groupRequest(origin, STOPPED.agentId, { kind: 'group.list', requestId: nextRequestId('retire-live') })
  assert(retireBefore.status === 200 && retireBefore.body.ok === true,
    `the second declared peer answers group.list while it runs (${retireBefore.status})`)
  const retireExit = new Promise(resolveExit => retireEntry.child.once('exit', resolveExit))
  retireEntry.child.kill('SIGTERM')
  await retireExit
  const retired = await awaitEndpointRecord(home, STOPPED.agentId, found => found === undefined).catch(() => undefined)
  assert(retired === undefined, 'the stopped agent withdrew its published record')
  const retireAfter = await groupRequest(origin, STOPPED.agentId, { kind: 'group.list', requestId: nextRequestId('retire-stopped') })
  assert(retireAfter.status === 503 && retireAfter.body.code === 'GROUP_ENDPOINT_NOT_CONFIGURED',
    `the same request becomes not-configured once the agent stopped (${retireAfter.status} ${JSON.stringify(retireAfter.body)})`)
  record('withdrawnEndpoint', retireAfter.body)

  await vikunja.close()
  await provider.close()
}

async function reapEverything(hard) {
  for (const entry of live.entries) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) continue
    const reaped = new Promise(resolveExit => entry.child.once('exit', resolveExit))
    entry.child.kill('SIGTERM')
    const gone = await Promise.race([reaped.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 15_000))])
    if (!gone) {
      entry.child.kill('SIGKILL')
      await new Promise(resolveExit => entry.child.once('exit', resolveExit))
    }
  }
  for (const [configPath, pid, subcommand] of [
    [live.controlConfigPath, live.controlPid, 'control'],
    [live.registryConfigPath, live.registryPid, 'registry'],
  ]) {
    if (pid === null || configPath === null || processRow(pid).length === 0) continue
    try {
      runCliSync([subcommand, 'stop', '--config', configPath], {})
    } catch {
      process.kill(pid, 'SIGTERM')
    }
    if (hard && processRow(pid).length > 0) process.kill(pid, 'SIGKILL')
  }
}

async function removeOwnedRoot() {
  if (ownedRoot === null) return
  if ((process.exitCode ?? 0) === 0) {
    await rm(ownedRoot, { recursive: true, force: true })
    console.log(`cleanup: removed owned root ${ownedRoot}`)
    return
  }
  console.error(`cleanup: keeping owned root ${ownedRoot} for failure forensics`)
}

const deadline = setTimeout(() => {
  console.error(`BLACK-BOX FAIL [${step}]: overall deadline ${OVERALL_DEADLINE_MS}ms elapsed`)
  setTimeout(async () => { await reapEverything(true); await removeOwnedRoot(); process.exit(1) }, 0)
}, OVERALL_DEADLINE_MS)

try {
  await main()
  receipts.finishedAt = new Date().toISOString()
  receipts.exitCode = process.exitCode ?? 0
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipts, null, 2)}\n`)
  console.log(`receipt: wrote ${RECEIPT_PATH} with ${receipts.checks} checks`)
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  for (const entry of live.entries) {
    console.error(`--- ${entry.label} stdout ---\n${entry.stdout}\n--- ${entry.label} stderr ---\n${entry.stderr}`)
  }
  receipts.finishedAt = new Date().toISOString()
  receipts.exitCode = 1
  receipts.error = error instanceof Error ? error.message : String(error)
  try {
    await writeFile(RECEIPT_PATH, `${JSON.stringify(receipts, null, 2)}\n`)
  } catch {
    // The original failure is the reported one.
  }
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await reapEverything(false)
  await removeOwnedRoot()
}

await new Promise(resolveFlush => process.stdout.write('', resolveFlush))
process.exit(process.exitCode ?? 0)
