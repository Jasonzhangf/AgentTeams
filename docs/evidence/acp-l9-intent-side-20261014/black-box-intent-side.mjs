#!/usr/bin/env node
/**
 * L9 intent-side black box: a Console command makes the agent daemon dial.
 *
 * This driver starts REAL daemons through the REAL CLI: one `registry start`, one
 * `control start --config` and two `agentteams --serve opencode --ip <lan> --port
 * <port> --config` agent daemons (an observer that declares the responder as its
 * only peer, and the responder itself) on a real non-loopback LAN address, with
 * real TLS material and real HTTP admission.
 *
 * The observer daemon dials its declared peer at start; from then on the desired
 * relations live in ONE durable record that only the control daemon writes. This
 * driver sends `connection.disconnect` and `connection.connect` over the control
 * daemon's real authenticated HTTP `/api/v1/command` and then reads the daemons'
 * own durable connection history. It never opens a socket to either agent daemon,
 * never sends a Teams frame and never names a role.
 *
 * It proves:
 *   (a) the observer dialed the declared peer at start with NO record present
 *       (`relations-intent.json` does not exist), so the baseline is the accepted
 *       config and not the desired-relations overlay;
 *   (b) `connection.connect` is a real CAS write: the shared record at
 *       `<home>/.agentteams/relations/<accountId>/<scopeId>/relations-intent.json`
 *       carries revision 1 and the desired peer, and the command result reports the
 *       accepted revision and NO connection state;
 *   (c) a successful write changes no Console projection: the control daemon
 *       reports no connection, because it never dials;
 *   (d) repeating `connection.connect` for an already connected peer re-dials
 *       nothing (the observer's `connection.negotiated` count stays 1);
 *   (e) `connection.disconnect` makes the OBSERVER close its live connection:
 *       the observer's durable history records `channel.closed` for the peer and
 *       still records only ONE `connection.negotiated` (no self-retry);
 *   (f) `connection.connect` after that makes the observer dial AGAIN, with a new
 *       agreement `connectionId` and a new `channel.opened` - the dial is caused by
 *       the intent change and by nothing this driver did to the agent daemon;
 *   (g) an agentId the control daemon does not declare is refused typed FORBIDDEN
 *       and writes no record; a stale `expectedRevision` is refused typed
 *       REVISION_CONFLICT and writes no record; a `network.membership.apply` member
 *       outside the record's account and scope is refused typed FORBIDDEN; an
 *       accepted `network.membership.apply` replaces the desired set;
 *   (h) the Console HTTP surface requires the declared Basic credential.
 *
 * WHAT THIS DOES NOT PROVE (read before citing it)
 *   - This is source-tree evidence. It runs the worktree's compiled
 *     `generated/runtime-lib` through the source CLI, not an installed artifact.
 *   - It uses a local OpenAI-compatible stub provider for the OpenCode engine. It
 *     proves the daemon, the watch and the initiator leg, not any upstream model.
 *   - One record serves one account and scope, so both agent daemons read the same
 *     file. Only the observer declares the peer, so only it dials; the responder
 *     records a typed FORBIDDEN for the same desired agentId.
 *   - It is not restart, deployment, cross-device or multi-account evidence.
 *
 * Usage: node docs/evidence/acp-l9-intent-side-20261014/black-box-intent-side.mjs
 * Env:   OPENCODE_EXECUTABLE (default /Users/fanzhang/.opencode/bin/opencode)
 *        L9_STEP_DEADLINE_MS (default 120000)
 *        L9_OVERALL_DEADLINE_MS (default 600000)
 *        L9_RECEIPT_PATH (default <driver dir>/receipt.json)
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'

const driverDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(driverDirectory, '..', '..', '..')
const CLI = process.env.AGENTTEAMS_CLI ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = process.env.AGENTTEAMS_CLI === undefined ? repositoryRoot : resolve(dirname(process.env.AGENTTEAMS_CLI), '..')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const RECEIPT_PATH = process.env.L9_RECEIPT_PATH ?? join(driverDirectory, 'receipt.json')
const STEP_DEADLINE_MS = Number(process.env.L9_STEP_DEADLINE_MS ?? 120_000)
const OVERALL_DEADLINE_MS = Number(process.env.L9_OVERALL_DEADLINE_MS ?? 600_000)

const ACCOUNT = 'local'
const SCOPE = 'local'
const OBSERVER = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'l9-observer' }
const RESPONDER = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'l9-responder' }
const OBSERVER_HOST_ID = 'host-l9-observer'
const RESPONDER_HOST_ID = 'host-l9-responder'
const TARGET_GENERATION = 1
const PEER_NAME = RESPONDER.agentId
const USERNAME = 'l9-intent-side'
const PASSWORD_ENV = 'L9_INTENT_SIDE_WEBUI_PASSWORD'
const PASSWORD = 'l9-intent-side-webui-secret'
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`
const RELATIONS_FILE_NAME = 'relations-intent.json'
/** Three watch polls; the entry polls every 500ms. */
const POLL_SETTLE_MS = 3_500

/** Deterministic, non-secret credentials. Values are never printed. */
const CREDENTIALS = {
  observer: 'Bearer l9-intent-side-observer-secret',
  responder: 'Bearer l9-intent-side-responder-secret',
  peer: 'Bearer l9-intent-side-peer-secret',
  probe: 'l9-intent-side-probe-secret',
}

let step = 'startup'
let logDirectory = null
let cliRunCounter = 0
let ownedRoot = null
let recordRoot = null
const live = { entries: [], registryPid: null, registryConfigPath: null, controlPid: null, controlConfigPath: null }
const receipts = {
  driver: 'acp-l9-intent-side-20261014/black-box-intent-side.mjs',
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

/** Real TLS material from the documented openssl command, with the LAN IP in the SAN. */
function generateTls(directory, name, sanIp) {
  const keyPath = join(directory, `${name}-key.pem`)
  const certPath = join(directory, `${name}-cert.pem`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=IP:${sanIp},DNS:localhost,IP:127.0.0.1`,
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
  return { keyPath, certPath, key: readFileSync(keyPath), cert: readFileSync(certPath) }
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

/** Local OpenAI-compatible stub provider for the OpenCode engine; logs every provider call. */
function startStubProvider() {
  const calls = []
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '').filter(name => name.length > 0)
      const text = lastUserText(parsed)
      calls.push({ model: parsed.model ?? '', toolNames, text })
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

function registryConfig({ directory, port, keyPath, certPath }) {
  return `version = 4

[daemon]
kind = "registry"
id = "l9-registry"
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
admissionRef = "adm-observer"
agentId = ${JSON.stringify(OBSERVER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9_CRED_OBSERVER"

[[admissions]]
admissionRef = "adm-responder"
agentId = ${JSON.stringify(RESPONDER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9_CRED_RESPONDER"
`
}

/**
 * The control daemon. Its accepted `peers` are the only place that carries the
 * account and scope the shared record path resolves from, so the driver declares
 * both agent daemons here and never passes a path.
 */
function controlConfig({ directory, port }) {
  return `version = 4

[daemon]
kind = "control"
id = "l9-console"
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

[peers.${RESPONDER.agentId}]
agentId = ${JSON.stringify(RESPONDER.agentId)}
hostId = ${JSON.stringify(RESPONDER_HOST_ID)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9_CRED_PEER"

[peers.${OBSERVER.agentId}]
agentId = ${JSON.stringify(OBSERVER.agentId)}
hostId = ${JSON.stringify(OBSERVER_HOST_ID)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9_CRED_PEER"
`
}

/**
 * One v4 agent config. `peer` is present only for the observer: it is the single
 * declared peer the daemon dials on its own.
 */
function agentConfig({ id, hostId, ip, port, keyPath, certPath, trustPath, registryPort, directory, baseUrl, credentialRef, inboundAdmission, peer }) {
  const peerBlock = peer === undefined ? '' : `
[peers.${PEER_NAME}]
agentId = ${JSON.stringify(peer.agentId)}
hostId = ${JSON.stringify(peer.hostId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
endpoint = ${JSON.stringify(peer.endpoint)}
admissionRef = ${JSON.stringify(peer.admissionRef)}
credentialRef = ${JSON.stringify(peer.credentialRef)}
tlsTrustRef = "file:${peer.tlsTrustRef}"
`
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
admissionRef = ${JSON.stringify(inboundAdmission.admissionRef)}
agentId = ${JSON.stringify(inboundAdmission.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9_CRED_PEER"

[discovery]
serverId = "l9-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = ${JSON.stringify(credentialRef)}
tlsTrustRef = "file:${trustPath}"

[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(baseUrl)}
label = "L9 intent-side stub provider"
enabled = true
credentialEnv = "L9_PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
${peerBlock}`
}

function spawnEntry({ label, ip, port, configPath, env }) {
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
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (entry.ready !== undefined) return entry.ready
    if (entry.child.exitCode !== null) throw new Error(`${entry.label} exited before readiness; stderr=${entry.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`${entry.label} never printed a readiness line; stderr=${entry.stderr}`)
}

async function awaitRegistrationOnline(entry) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const line = entry.stdout.split('\n').filter(candidate => candidate.startsWith('registration ')).pop()
    if (line !== undefined && line.includes('state=online')) return line
    if (entry.child.exitCode !== null) throw new Error(`${entry.label} exited before registration online; stderr=${entry.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`${entry.label} never reported registration state=online; stdout=${entry.stdout}`)
}

/** Values may contain spaces, so split on `key=` boundaries. */
function parseFields(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) {
    fields[match[1]] = match[2].trim()
  }
  return fields
}

async function readConnectionRecords(stateDirectory) {
  try {
    const document = JSON.parse(await readFile(join(stateDirectory, 'acp-history.json'), 'utf8'))
    if (!Array.isArray(document.records)) return []
    return document.records.filter(record => record.kind === 'connection')
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    throw cause
  }
}

function negotiatedFor(records, agentId) {
  return records.filter(record => record.event === 'connection.negotiated' && record.agentId === agentId)
}

async function awaitNegotiatedCount(stateDirectory, agentId, expected) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  while (Date.now() < deadline) {
    const negotiated = negotiatedFor(await readConnectionRecords(stateDirectory), agentId)
    if (negotiated.length >= expected) return negotiated
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`the observer never recorded ${expected} connection.negotiated for ${agentId} within ${STEP_DEADLINE_MS}ms`)
}

async function awaitConnectionRecord(stateDirectory, predicate, label) {
  const deadline = Date.now() + STEP_DEADLINE_MS
  let observed = []
  while (Date.now() < deadline) {
    observed = await readConnectionRecords(stateDirectory)
    const match = observed.find(predicate)
    if (match !== undefined) return match
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`${label}: no matching connection record within ${STEP_DEADLINE_MS}ms; observed=${JSON.stringify(observed)}`)
}

function agreementSummary(record) {
  const agreement = record.agreement
  return {
    recordConnectionId: record.connectionId,
    agreementConnectionId: agreement?.connectionId,
    event: record.event,
    agentId: record.agentId,
    occurredAt: record.occurredAt,
    source: agreement?.source,
    target: agreement?.target,
    sourceRole: agreement?.sourceRole,
    targetRole: agreement?.targetRole,
    targetGeneration: agreement?.targetGeneration,
    targetCapabilitiesRevision: agreement?.targetCapabilitiesRevision,
  }
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

async function readProjection(origin) {
  const response = await fetch(`${origin}/api/v1/projection`, { headers: { authorization: BASIC } })
  return { status: response.status, body: await response.text() }
}

/** The one shared record the control daemon writes and both daemons read. */
function recordPath() {
  return join(recordRoot, RELATIONS_FILE_NAME)
}

async function readRecord() {
  if (!existsSync(recordPath())) return undefined
  return JSON.parse(await readFile(recordPath(), 'utf8'))
}

async function main() {
  const lanIp = lanIpv4()
  if (lanIp === undefined) throw new Error('this host has no non-internal IPv4 interface; the intent-side black box cannot run')
  const directory = await mkdtemp(join(tmpdir(), 'l9-intent-side-blackbox-'))
  ownedRoot = directory
  console.log('# L9 intent-side black box: a Console command makes the agent daemon dial')
  console.log(`cli=${CLI}`)
  console.log(`root=${directory}`)
  console.log(`lanIp=${lanIp}`)

  logDirectory = join(directory, 'cli-logs')
  await mkdir(logDirectory, { recursive: true })
  const tlsDirectory = join(directory, 'tls')
  await mkdir(tlsDirectory, { recursive: true })
  const registryTls = generateTls(tlsDirectory, 'registry', '127.0.0.1')
  const observerTls = generateTls(tlsDirectory, 'observer', lanIp)
  const responderTls = generateTls(tlsDirectory, 'responder', lanIp)
  assert(registryTls.cert.length > 0 && observerTls.cert.length > 0 && responderTls.cert.length > 0,
    'real openssl TLS material was generated for the registry and both agent daemons')

  // The record path resolves from `os.homedir()`, so every daemon under test gets
  // this owned home. The driver never writes the record itself.
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  recordRoot = join(home, '.agentteams', 'relations', ACCOUNT, SCOPE)
  record('recordPath', recordPath())
  assert(!existsSync(recordPath()), 'no desired-relations record exists before any Console command')

  const registryPort = await availablePort('127.0.0.1')
  const controlPort = await availablePort('127.0.0.1')
  const observerPort = await availablePort(lanIp)
  const responderPort = await availablePort(lanIp)
  const provider = await startStubProvider()

  const operatorEnv = {
    HOME: home,
    L9_CRED_OBSERVER: CREDENTIALS.observer,
    L9_CRED_RESPONDER: CREDENTIALS.responder,
    L9_CRED_PEER: CREDENTIALS.peer,
    L9_PROBE_API_KEY: CREDENTIALS.probe,
    [PASSWORD_ENV]: PASSWORD,
  }

  const registryPath = join(directory, 'registry.toml')
  live.registryConfigPath = registryPath
  const observerPath = join(directory, 'observer.toml')
  const responderPath = join(directory, 'responder.toml')
  const controlPath = join(directory, 'control.toml')
  live.controlConfigPath = controlPath
  await writeFile(registryPath, registryConfig({ directory: join(directory, 'registry'), port: registryPort, keyPath: registryTls.keyPath, certPath: registryTls.certPath }))
  await writeFile(responderPath, agentConfig({
    id: RESPONDER.agentId, hostId: RESPONDER_HOST_ID, ip: lanIp, port: responderPort,
    keyPath: responderTls.keyPath, certPath: responderTls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'responder'), baseUrl: provider.baseUrl,
    credentialRef: 'env:L9_CRED_RESPONDER',
    inboundAdmission: { admissionRef: 'adm-observer', agentId: OBSERVER.agentId },
  }))
  await writeFile(observerPath, agentConfig({
    id: OBSERVER.agentId, hostId: OBSERVER_HOST_ID, ip: lanIp, port: observerPort,
    keyPath: observerTls.keyPath, certPath: observerTls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'observer'), baseUrl: provider.baseUrl,
    credentialRef: 'env:L9_CRED_OBSERVER',
    inboundAdmission: { admissionRef: 'adm-responder', agentId: RESPONDER.agentId },
    peer: {
      agentId: RESPONDER.agentId,
      hostId: RESPONDER_HOST_ID,
      endpoint: `wss://${lanIp}:${responderPort}`,
      admissionRef: 'adm-observer',
      credentialRef: 'env:L9_CRED_PEER',
      tlsTrustRef: responderTls.certPath,
    },
  }))
  await writeFile(controlPath, controlConfig({ directory: join(directory, 'control'), port: controlPort }))
  record('controlConfigPath', controlPath)
  record('observerConfigPath', observerPath)
  record('declaredPeer', { name: PEER_NAME, endpoint: `wss://${lanIp}:${responderPort}`, admissionRef: 'adm-observer' })

  // ---- the real registry daemon, through the real CLI --------------------
  step = 'registry start'
  console.log(runCliSync(['registry', 'start', '--config', registryPath], operatorEnv).trim())
  const registryStatus = parseFields(runCliSync(['registry', 'status', '--config', registryPath], operatorEnv).trim())
  live.registryPid = Number(registryStatus.pid)
  assert(Number.isSafeInteger(live.registryPid) && processRow(live.registryPid).length > 0, `the registry reports a live explicit pid (${live.registryPid})`)
  assert(registryStatus.state === 'running', `the registry reports running (${registryStatus.state})`)
  record('registry', { pid: live.registryPid, endpoint: `wss://127.0.0.1:${registryPort}` })

  // ---- the responder first, so the observer's directory readback sees it ----
  step = 'responder readiness'
  const responderEntry = spawnEntry({ label: 'responder', ip: lanIp, port: responderPort, configPath: responderPath, env: operatorEnv })
  const responderFields = parseFields(await awaitReady(responderEntry))
  assert(responderFields.listener === `${lanIp}:${responderPort}`, `the responder serves the real LAN listener (${responderFields.listener})`)
  const responderRegistration = await awaitRegistrationOnline(responderEntry)
  assert(responderRegistration.includes('state=online'), `the responder registered with the real registry (${responderRegistration})`)
  const responderCapabilitiesRevision = responderFields.capabilitiesRevision
  assert(/^[0-9]+$/.test(responderCapabilitiesRevision), `the responder publishes a numeric capabilities revision (${responderCapabilitiesRevision})`)
  record('responder', {
    pid: responderEntry.child.pid,
    listener: responderFields.listener,
    lanChannel: responderFields.lanChannel,
    capabilitiesRevision: responderCapabilitiesRevision,
    registration: responderRegistration,
  })

  // ---- the observer: it dials the declared peer with no record and no help ----
  step = 'observer start dial'
  const observerEntry = spawnEntry({ label: 'observer', ip: lanIp, port: observerPort, configPath: observerPath, env: operatorEnv })
  const observerFields = parseFields(await awaitReady(observerEntry))
  assert(observerFields.listener === `${lanIp}:${observerPort}`, `the observer serves the real LAN listener (${observerFields.listener})`)
  const observerRegistration = await awaitRegistrationOnline(observerEntry)
  assert(observerRegistration.includes('state=online'), `the observer registered with the real registry (${observerRegistration})`)
  record('observer', {
    pid: observerEntry.child.pid,
    listener: observerFields.listener,
    lanChannel: observerFields.lanChannel,
    capabilitiesRevision: observerFields.capabilitiesRevision,
    registration: observerRegistration,
  })

  const observerState = join(directory, 'observer', 'state')
  const responderState = join(directory, 'responder', 'state')
  const baseline = (await awaitNegotiatedCount(observerState, RESPONDER.agentId, 1))[0]
  const baselineAgreement = agreementSummary(baseline)
  assert(baselineAgreement.source?.agentId === OBSERVER.agentId, `the observer's recorded agreement source is the observer itself (${baselineAgreement.source?.agentId})`)
  assert(baselineAgreement.target?.agentId === RESPONDER.agentId, `the observer's recorded agreement target is the declared peer (${baselineAgreement.target?.agentId})`)
  assert(baselineAgreement.sourceRole === 'peer' && baselineAgreement.targetRole === 'master',
    `the observer negotiated the declared non-degenerate roles (${baselineAgreement.sourceRole}/${baselineAgreement.targetRole})`)
  assert(baselineAgreement.targetGeneration === TARGET_GENERATION,
    `the observer named the responder's published listener generation (${baselineAgreement.targetGeneration})`)
  assert(baselineAgreement.targetCapabilitiesRevision === responderCapabilitiesRevision,
    `the observer read the responder's capability revision from the scoped directory (${baselineAgreement.targetCapabilitiesRevision})`)
  assert(!existsSync(recordPath()), 'the start dial ran with NO desired-relations record: the baseline is the accepted config, not the overlay')
  record('baselineNegotiated', baselineAgreement)

  step = 'baseline channel'
  const baselineChannel = await awaitConnectionRecord(
    observerState,
    record => record.event === 'channel.opened' && record.agentId === RESPONDER.agentId,
    'the observer channel.opened record',
  )
  assert(typeof baselineChannel.channelId === 'string' && typeof baselineChannel.engineInstanceId === 'string',
    `the observer opened a real ACP channel at start (${baselineChannel.channelId})`)
  record('baselineChannel', { channelId: baselineChannel.channelId, engineInstanceId: baselineChannel.engineInstanceId })

  step = 'both sides recorded the same baseline wire connection'
  const responderBaseline = await awaitConnectionRecord(
    responderState,
    record => record.event === 'connection.negotiated' && record.agentId === OBSERVER.agentId,
    'the responder baseline negotiated record',
  )
  // The initiator records its own connection label and the wire agreement id; the
  // responder records the wire agreement id as its connection label. The shared
  // identity across the two histories is therefore the agreement connection id.
  assert(responderBaseline.connectionId === baselineAgreement.agreementConnectionId,
    `the responder recorded the same wire connection as the observer (${responderBaseline.connectionId})`)
  record('responderBaseline', agreementSummary(responderBaseline))

  // ---- the real control daemon, through the real CLI ---------------------
  step = 'control start'
  const controlStart = parseFields(runCliSync(['control', 'start', '--config', controlPath], operatorEnv).trim())
  assert(controlStart.state === 'running', `the control daemon reports running (${controlStart.state})`)
  const controlPid = Number(controlStart.pid)
  live.controlPid = controlPid
  assert(Number.isSafeInteger(controlPid) && processRow(controlPid).length > 0, `the control daemon reports a live explicit pid (${controlPid})`)
  assert(controlStart.listener === `127.0.0.1:${controlPort}`, `the control daemon serves its declared WebUI listener (${controlStart.listener})`)
  record('control', { pid: controlPid, listener: controlStart.listener })
  const origin = `http://127.0.0.1:${controlPort}`

  step = 'console authentication'
  const anonymous = await sendCommand(origin, { kind: 'connection.connect', agentId: RESPONDER.agentId }, null)
  assert(anonymous.status === 401, `an anonymous Console command is refused with 401 (${anonymous.status})`)
  assert(!existsSync(recordPath()), 'the anonymous command wrote no record')

  step = 'connect writes the desired relation'
  const projectionBefore = await readProjection(origin)
  const connectWrite = await sendCommand(origin, { kind: 'connection.connect', agentId: RESPONDER.agentId }, BASIC)
  assert(connectWrite.status === 200 && connectWrite.body.ok === true, `connection.connect is accepted over the real HTTP surface (${JSON.stringify(connectWrite.body)})`)
  assert(connectWrite.body.result?.acceptedRevision === 1, `the command result reports the accepted record revision (${connectWrite.body.result?.acceptedRevision})`)
  assert(connectWrite.body.result?.state === undefined && connectWrite.body.result?.connectionId === undefined,
    'the command result reports no connection state, because the agent daemon reacts later')
  const written = await readRecord()
  assert(written?.revision === 1 && Array.isArray(written.peers), `the shared record carries revision 1 (${JSON.stringify(written)})`)
  assert(written.peers.length === 1 && written.peers[0].agentId === RESPONDER.agentId && written.peers[0].role === 'master',
    `the record carries the frozen desired peer and the one derived role (${JSON.stringify(written.peers)})`)
  record('connectAcceptedRevision', connectWrite.body.result.acceptedRevision)

  step = 'no projection change from a successful write'
  const projectionAfter = await readProjection(origin)
  assert(projectionAfter.status === 200 && projectionAfter.body === projectionBefore.body,
    'the Console projection is unchanged by a successful desired-relations write')
  const projectionBody = JSON.parse(projectionAfter.body)
  assert(projectionBody.connections === undefined || Array.isArray(projectionBody.connections),
    'the control daemon reports no connection it did not make')

  step = 'a repeated connect does not re-dial'
  // The observer is already connected to the peer. The record now desires it, so the
  // interval agrees with the live row and must dial nothing.
  await new Promise(resolveWait => setTimeout(resolveWait, POLL_SETTLE_MS))
  const afterRepeat = negotiatedFor(await readConnectionRecords(observerState), RESPONDER.agentId)
  assert(afterRepeat.length === 1, `the observer still recorded exactly one connection.negotiated (${afterRepeat.length})`)
  const repeatClosed = (await readConnectionRecords(observerState)).filter(record => record.event === 'channel.closed' && record.agentId === RESPONDER.agentId)
  assert(repeatClosed.length === 0, 'the observer closed no channel for an already desired peer')

  step = 'disconnect closes the observer live connection'
  const disconnectWrite = await sendCommand(origin, { kind: 'connection.disconnect', agentId: RESPONDER.agentId }, BASIC)
  assert(disconnectWrite.status === 200 && disconnectWrite.body.ok === true, `connection.disconnect is accepted over the real HTTP surface (${JSON.stringify(disconnectWrite.body)})`)
  assert(disconnectWrite.body.result?.acceptedRevision === 2, `the disconnect reports the accepted record revision (${disconnectWrite.body.result?.acceptedRevision})`)
  const emptied = await readRecord()
  assert(emptied?.revision === 2 && emptied.peers.length === 0, `the record now desires no relation (${JSON.stringify(emptied)})`)
  const observerClosed = await awaitConnectionRecord(
    observerState,
    record => record.event === 'channel.closed' && record.agentId === RESPONDER.agentId && record.connectionId === baseline.connectionId,
    'the observer channel.closed record',
  )
  assert(observerClosed.connectionId === baseline.connectionId,
    `the observer closed the connection the record no longer desires (${observerClosed.connectionId})`)
  // The responder's own ingress sees the same wire connection end.
  const responderClosed = await awaitConnectionRecord(
    responderState,
    record => record.event === 'channel.closed' && record.agentId === OBSERVER.agentId,
    'the responder channel.closed record',
  )
  assert(responderClosed.connectionId === responderBaseline.connectionId,
    `the responder observed the end of the same wire connection (${responderClosed.connectionId})`)
  // A disconnect must not become a re-dial: only the record can make the observer dial.
  await new Promise(resolveWait => setTimeout(resolveWait, POLL_SETTLE_MS))
  const afterDisconnect = negotiatedFor(await readConnectionRecords(observerState), RESPONDER.agentId)
  assert(afterDisconnect.length === 1, `the observer did not re-dial on its own after the disconnect (${afterDisconnect.length} negotiation)`)
  record('observedClosed', { observer: observerClosed.connectionId, responder: responderClosed.connectionId })

  step = 'connect after disconnect makes the observer dial again'
  const reconnectWrite = await sendCommand(origin, { kind: 'connection.connect', agentId: RESPONDER.agentId }, BASIC)
  assert(reconnectWrite.status === 200 && reconnectWrite.body.ok === true, `the second connection.connect is accepted (${JSON.stringify(reconnectWrite.body)})`)
  assert(reconnectWrite.body.result?.acceptedRevision === 3, `the second connect reports the accepted record revision (${reconnectWrite.body.result?.acceptedRevision})`)
  const dialed = await awaitNegotiatedCount(observerState, RESPONDER.agentId, 2)
  const secondAgreement = agreementSummary(dialed[1])
  assert(secondAgreement.agreementConnectionId !== baselineAgreement.agreementConnectionId,
    `the observer dialed a NEW connection because of the intent change (${baselineAgreement.agreementConnectionId} -> ${secondAgreement.agreementConnectionId})`)
  assert(secondAgreement.source?.agentId === OBSERVER.agentId && secondAgreement.target?.agentId === RESPONDER.agentId,
    'the new agreement has the same two sides')
  const secondChannel = await awaitConnectionRecord(
    observerState,
    record => record.event === 'channel.opened' && record.agentId === RESPONDER.agentId && record.connectionId !== baseline.connectionId,
    'the observer second channel.opened record',
  )
  assert(secondChannel.connectionId === secondAgreement.agreementConnectionId
    || secondChannel.connectionId === dialed[1].connectionId,
    `the new dial opened its own ACP channel (${secondChannel.connectionId})`)
  await awaitNegotiatedCount(responderState, OBSERVER.agentId, 2)
  const responderSecond = (await readConnectionRecords(responderState)).filter(record => record.event === 'connection.negotiated' && record.agentId === OBSERVER.agentId)
  assert(responderSecond[1].connectionId === responderBaseline.connectionId === false
    || responderSecond[1].connectionId !== responderBaseline.connectionId,
    `the responder recorded a second, distinct wire connection (${responderSecond[1].connectionId})`)
  assert(!existsSync(join(observerState, 'relations-intent.json')),
    'the observer resolved the record from the shared home path, not from its own data directory')
  record('redialNegotiated', secondAgreement)

  step = 'refused writes leave the record untouched'
  const revisionBeforeRefusals = (await readRecord()).revision
  const unknown = await sendCommand(origin, { kind: 'connection.connect', agentId: 'l9-unknown' }, BASIC)
  assert(unknown.status === 200 && unknown.body.ok === false, 'an undeclared agentId is a typed refusal, not a write')
  assert(unknown.body.error?.code === 'FORBIDDEN', `the undeclared agentId refusal keeps its typed code (${unknown.body.error?.code})`)
  const stale = await sendCommand(origin, {
    kind: 'network.membership.apply',
    agentId: RESPONDER.agentId,
    expectedRevision: 1,
    members: [{ agentId: RESPONDER.agentId, role: 'peer' }],
  }, BASIC)
  assert(stale.body.ok === false && stale.body.error?.code === 'REVISION_CONFLICT',
    `a stale expectedRevision is refused typed (${stale.body.error?.code})`)
  const foreign = await sendCommand(origin, {
    kind: 'network.membership.apply',
    agentId: RESPONDER.agentId,
    expectedRevision: revisionBeforeRefusals,
    members: [{ agentId: RESPONDER.agentId, role: 'peer' }, { agentId: 'l9-foreign', role: 'peer' }],
  }, BASIC)
  assert(foreign.body.ok === false && foreign.body.error?.code === 'FORBIDDEN',
    `a member outside the record's account and scope is refused typed (${foreign.body.error?.code})`)
  const afterRefusals = await readRecord()
  assert(afterRefusals.revision === revisionBeforeRefusals,
    `every refused write left the accepted revision untouched (${afterRefusals.revision})`)

  step = 'membership apply replaces the desired set'
  const applied = await sendCommand(origin, {
    kind: 'network.membership.apply',
    agentId: RESPONDER.agentId,
    expectedRevision: revisionBeforeRefusals,
    members: [{ agentId: RESPONDER.agentId, role: 'master' }],
  }, BASIC)
  assert(applied.status === 200 && applied.body.ok === true, `network.membership.apply is accepted with the accepted revision as its base (${JSON.stringify(applied.body)})`)
  assert(applied.body.result?.acceptedRevision === revisionBeforeRefusals + 1,
    `the apply reports the next accepted revision (${applied.body.result?.acceptedRevision})`)
  const replaced = await readRecord()
  assert(replaced.revision === revisionBeforeRefusals + 1 && replaced.peers.length === 1 && replaced.peers[0].role === 'master',
    `the record carries the replaced desired set (${JSON.stringify(replaced.peers)})`)
  await new Promise(resolveWait => setTimeout(resolveWait, POLL_SETTLE_MS))
  const afterApply = negotiatedFor(await readConnectionRecords(observerState), RESPONDER.agentId)
  assert(afterApply.length === 2, `a replace that keeps the same peer dials nothing new (${afterApply.length})`)
  record('finalRecord', { revision: replaced.revision, peers: replaced.peers })
  record('providerCalls', provider.calls.length)

  console.log('\n## PASS: a Console command wrote the desired relations and the agent daemon dialed because of it')
  record('outcome', 'PASS')
  await provider.close()
  return receipts
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
  for (const [configPath, pid] of [[live.controlConfigPath, live.controlPid], [live.registryConfigPath, live.registryPid]]) {
    if (pid === null || configPath === null || processRow(pid).length === 0) continue
    const subcommand = configPath === live.controlConfigPath ? 'control' : 'registry'
    try {
      runCliSync([subcommand, 'stop', '--config', configPath], {})
    } catch {
      process.kill(pid, 'SIGTERM')
    }
    if (hard) {
      const gone = await new Promise(resolveWait => setTimeout(() => resolveWait(processRow(pid).length === 0), 3_000))
      if (!gone) process.kill(pid, 'SIGKILL')
    }
  }
}

async function removeOwnedRoot() {
  if (ownedRoot === null) return
  if ((process.exitCode ?? 0) === 0) {
    try {
      await rm(ownedRoot, { recursive: true, force: true })
      console.log(`cleanup: removed owned root ${ownedRoot}`)
    } catch (cause) {
      console.error(`cleanup: could not remove owned root ${ownedRoot}: ${cause}`)
      process.exitCode = 1
    }
  } else {
    console.error(`cleanup: keeping owned root ${ownedRoot} for failure forensics`)
  }
}

try {
  const deadline = setTimeout(() => {
    console.error(`BLACK-BOX FAIL [${step}]: overall deadline ${OVERALL_DEADLINE_MS}ms elapsed`)
    setTimeout(async () => { await reapEverything(true); await removeOwnedRoot(); process.exit(1) }, 0)
  }, OVERALL_DEADLINE_MS)
  receipts.steps = []
  await main()
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipts, null, 2)}\n`)
  console.log(`receipt: wrote ${RECEIPT_PATH}`)
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  for (const entry of live.entries) {
    console.error(`--- ${entry.label} stdout ---\n${entry.stdout}\n--- ${entry.label} stderr ---\n${entry.stderr}`)
  }
  process.exitCode = 1
} finally {
  await reapEverything(false)
  await removeOwnedRoot()
}

await new Promise(resolveFlush => process.stdout.write('', resolveFlush))
process.exit(process.exitCode ?? 0)
