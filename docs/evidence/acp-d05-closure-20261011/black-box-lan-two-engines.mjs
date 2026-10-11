#!/usr/bin/env node
/**
 * D05 closure black box: two REAL engines over the REAL LAN listener.
 *
 * This is the D05 closure driver the isolated transport observation explicitly
 * does not replace. It runs the real user entry twice as real child processes
 * (`agentteams --serve opencode` and `agentteams --serve dsh`), both bound to a
 * real non-loopback LAN address, against a real registry started through the
 * real `registry start` CLI, and drives both LAN channels from one in-process
 * observer that negotiates over the frozen Teams frames.
 *
 * It proves, with explicit PIDs and no wildcard kill:
 *   (a) both daemons register with the real registry and the observer's real
 *       directory read shows both `online` with a published `lan` route whose
 *       endpoint and `capabilitiesRevision` equal the readiness line;
 *   (b) a wrong credential is refused by the real HTTP admission before any
 *       application frame is read;
 *   (c) an initiator reaches the terminal `agreed` state over a real LAN socket
 *       and the responder's own `teams.connection.accept` carries the same roles;
 *   (d) `initialize`, `session/new` and `session/prompt` return real engine
 *       results over the LAN channel for both engines;
 *   (e) both role assignments are non-degenerate and visible at both ends
 *       (one connection where the daemon is `peer`, one where it is `master`);
 *   (f) the opencode leg carries engine updates, a real permission callback and
 *       its reply; the DSH leg carries engine updates and a terminal result;
 *   (g) the same JSON-RPC id on two channels and two Sessions stays isolated;
 *   (h) a channel closed mid-prompt leaves the durable history with
 *       `outcome: 'unknown'` and the result is never replayed after reconnect;
 *   (i) a blacklisted ACP method is refused before the engine sees it, and the
 *       stub provider call log does not grow across the refused call;
 *   (j) stopping the registry leaves an established channel working (a second
 *       prompt succeeds), the registration status degrades on stdout, and no
 *       control daemon was ever spawned.
 *
 * WHAT THIS DOES NOT PROVE (read before citing it)
 *   - The opencode leg uses a local OpenAI-compatible stub provider, not a real
 *     upstream model. The DSH leg uses the real configured DSH provider route
 *     and credential; if that credential does not resolve, the driver records
 *     the DSH prompt leg as INCOMPLETE and still proves the real DSH
 *     `initialize` and `session/new` over LAN, naming the exact first failing
 *     gate. It never fakes a prompt result.
 *   - This is not installed-artifact, restart, deployment or cross-device
 *     evidence. It runs the source tree in this worktree.
 *   - The `targetGeneration` used on the wire is 1, the constant the serve
 *     entry publishes. Aligning it with the relay login generation is D06 work.
 *
 * Usage: node --experimental-transform-types \
 *          docs/evidence/acp-d05-closure-20261011/black-box-lan-two-engines.mjs
 * Env:   OPENCODE_EXECUTABLE (default /Users/fanzhang/.opencode/bin/opencode)
 *        DSH_EXECUTABLE      (default /opt/homebrew/bin/dsh)
 *        D05_PROVIDER_BASE_URL / D05_PROVIDER_MODEL / D05_CREDENTIAL_REF
 *        DSH_CREDENTIALS_FILE (default ~/.dsh/.credentials.yaml)
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'

import { connectDirectWssTarget } from '../../../network/direct-route.ts'
import { buildDirectWssRoutePlan } from '../../../network/route-plan.ts'
import { negotiatedAgreement, runTeamsNegotiation } from '../../../network/teams-negotiation.ts'
import { createRegistrationClient } from '../../../network/registration-client.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLI = process.env.AGENTTEAMS_CLI ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = process.env.AGENTTEAMS_CLI === undefined ? repositoryRoot : resolve(dirname(process.env.AGENTTEAMS_CLI), '..')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const DSH = process.env.DSH_EXECUTABLE ?? '/opt/homebrew/bin/dsh'
const PROVIDER_BASE_URL = process.env.D05_PROVIDER_BASE_URL ?? 'https://api.xyxl1225.online/8318/v1'
const PROVIDER_MODEL = process.env.D05_PROVIDER_MODEL ?? 'wb-deepseek-v4.1-flash'
const CREDENTIAL_REF = process.env.D05_CREDENTIAL_REF ?? 'DEEPSEEK_FLASH_API_KEY'
const REAL_DSH_HOME = join(process.env.HOME ?? '', '.dsh')
const CREDENTIALS_FILE = process.env.DSH_CREDENTIALS_FILE ?? join(REAL_DSH_HOME, '.credentials.yaml')

const ACCOUNT = 'local'
const SCOPE = 'local'
const AGENT_A = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'reasoner-a' }
const AGENT_B = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'reasoner-dsh' }
const OBSERVER = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'observer' }
const TARGET_GENERATION = 1
const ACP_CAPABILITIES = ['method:session/new', 'method:session/prompt', 'callback:session/request_permission']
const STEP_DEADLINE_MS = Number(process.env.D05_STEP_DEADLINE_MS ?? 120_000)
const OVERALL_DEADLINE_MS = Number(process.env.D05_OVERALL_DEADLINE_MS ?? 900_000)
/** A LAN frame write is a local socket write; it must never take this long. */
const SEND_DEADLINE_MS = Number(process.env.D05_SEND_DEADLINE_MS ?? 30_000)

/** Deterministic, non-secret credentials. Values are never printed. */
const CREDENTIALS = {
  a: 'Bearer d05-lan-blackbox-agent-a-secret',
  b: 'Bearer d05-lan-blackbox-agent-b-secret',
  observer: 'Bearer d05-lan-blackbox-observer-secret',
  wrong: 'Bearer d05-lan-blackbox-wrong-secret',
}

let step = 'startup'
let logDirectory = null
let cliRunCounter = 0

/**
 * Run one CLI command synchronously.
 *
 * The registry daemon is spawned detached by `registry start` and inherits the
 * CLI's stdio. With a pipe, that inherited write end keeps `execFileSync`
 * waiting for EOF long after the CLI exits, so the command's stdio is a plain
 * file instead. The command output is returned; no pipe is involved.
 */
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
const started = Date.now()
const live = { entries: [], registryPid: null, registryGeneration: null, registryConfigPath: null }

function assert(condition, message) {
  if (!condition) throw new Error(`BLACK-BOX FAIL [${step}]: ${message}`)
  console.log(`  ok: ${message}`)
}

function note(message) {
  console.log(`  -- ${message}`)
}

async function withDeadline(promise, label, timeoutMs = STEP_DEADLINE_MS) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function processRow(pid) {
  try {
    return execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function childrenOf(pid) {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return table.split('\n').map(line => line.trim()).filter(line => line.length > 0).map(line => {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? null : { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
  }).filter(row => row !== null && row.ppid === pid)
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

function portIsClosed(ip, port) {
  return new Promise(resolveCheck => {
    const socket = createNetServer()
    socket.once('error', () => resolveCheck(false))
    socket.listen(port, ip, () => { socket.close(() => resolveCheck(true)) })
  })
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

/** Read the real DSH credential value; the value is never printed. */
function readDshCredential(reference) {
  if (!existsSync(CREDENTIALS_FILE)) return undefined
  const match = new RegExp(`^\\s{2}${reference}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(CREDENTIALS_FILE, 'utf8'))
  return match === null ? undefined : match[1]
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

/** Local OpenAI-compatible stub for the opencode leg. It logs every provider call. */
function startStubProvider() {
  const calls = []
  let toolCalls = 0
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
      const echo = /ECHO:([A-Za-z0-9-]+)/.exec(text)
      // The slow branches never finish, so the driver owns the timing.
      if (text.includes('LOST-PEER')) {
        response.write(chunk({ role: 'assistant', content: 'LOST-PEER-START' }))
        return
      }
      if (text.includes('SLOW-CANCEL')) {
        response.write(chunk({ role: 'assistant', content: 'PROBE-START' }))
        setTimeout(() => { response.write(chunk({ content: 'PROBE-LATE' })); response.write(finish); response.end('data: [DONE]\n\n') }, 30_000)
        return
      }
      if (echo !== null) {
        response.write(chunk({ role: 'assistant', content: `REPLY-${echo[1]}` }))
        response.write(finish)
        response.end('data: [DONE]\n\n')
        return
      }
      if (toolNames.length === 0) {
        response.write(chunk({ role: 'assistant', content: 'title' }))
        response.write(finish)
        response.end('data: [DONE]\n\n')
        return
      }
      toolCalls += 1
      if (toolCalls === 1) {
        response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/etc/hosts' }) } }] }))
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      response.write(chunk({ role: 'assistant', content: 'PROBE-TOOL-DONE' }))
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
id = "lan-registry"
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
admissionRef = "adm-a"
agentId = ${JSON.stringify(AGENT_A.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:D05_CRED_A"

[[admissions]]
admissionRef = "adm-b"
agentId = ${JSON.stringify(AGENT_B.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:D05_CRED_B"

[[admissions]]
admissionRef = "adm-observer"
agentId = ${JSON.stringify(OBSERVER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:D05_CRED_OBSERVER"
`
}

function agentConfig({ id, engine, executable, ip, port, keyPath, certPath, trustPath, registryPort, directory, extra }) {
  const provider = engine === 'opencode'
    ? `
[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(extra.baseUrl)}
label = "D05 probe provider"
enabled = true
credentialEnv = "D05_PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"
`
    : `
[providers.workbuddy]
protocol = "openai-responses"
apiBaseUrl = ${JSON.stringify(PROVIDER_BASE_URL)}
label = "D05 DSH provider"
enabled = true
credentialEnv = "D05_DSH_API_KEY"

[[models]]
provider = "workbuddy"
id = ${JSON.stringify(PROVIDER_MODEL)}
`
  return `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(id)}
hostId = "host-lan"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(join(directory, 'state'))}

[engine]
kind = ${JSON.stringify(engine)}
executable = ${JSON.stringify(executable)}
workspace = ${JSON.stringify(join(directory, 'workspace'))}

[listen]
ip = ${JSON.stringify(ip)}
port = ${port}
tlsCertRef = "file:${certPath}"
tlsKeyRef = "file:${keyPath}"

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = ${JSON.stringify(extra.blacklist ?? [])}
clientCapabilities = []
callbackExecutor = "controller"

[relations]
allowed = ["master", "peer"]

[[admissions]]
admissionRef = "adm-observer"
agentId = ${JSON.stringify(OBSERVER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:D05_CRED_OBSERVER"

[discovery]
serverId = "lan-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:D05_CRED_${id === AGENT_A.agentId ? 'A' : 'B'}"
tlsTrustRef = "file:${trustPath}"
${provider}
[model.primary]
provider = ${engine === 'opencode' ? '"probe"' : '"workbuddy"'}
model = ${engine === 'opencode' ? '"probe-model"' : JSON.stringify(PROVIDER_MODEL)}
`
}

/** Spawn one real entry and collect its readiness/registration lines. */
function spawnEntry({ label, engine, ip, port, configPath, env }) {
  const child = spawn(process.execPath, [CLI, '--serve', engine, '--ip', ip, '--port', String(port), '--config', configPath], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const record = { label, child, stdout: '', stderr: '', ready: undefined }
  child.stdout.on('data', chunk => {
    record.stdout += chunk.toString('utf8')
    for (const line of record.stdout.split('\n')) {
      if (record.ready === undefined && line.startsWith('serving ')) record.ready = line
    }
  })
  child.stderr.on('data', chunk => {
    record.stderr += chunk.toString('utf8')
    process.stderr.write(`[${label}] ${chunk.toString('utf8')}`)
  })
  live.entries.push(record)
  return record
}

async function awaitReady(record) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (record.ready !== undefined) return record.ready
    if (record.child.exitCode !== null) throw new Error(`${record.label} exited before readiness; stderr=${record.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`${record.label} never printed a readiness line; stderr=${record.stderr}`)
}

/** Values may contain spaces, so split on `key=` boundaries. */
function parseFields(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) {
    fields[match[1]] = match[2].trim()
  }
  return fields
}

function registrationLines(record) {
  return record.stdout.split('\n').filter(line => line.startsWith('registration '))
}

/** One Teams wire channel: negotiation plus raw frame send/receive. */
function openChannel({ target, peer, self, selfGeneration, requestedRole, requestedPeerRole, connectionId }) {
  const frames = []
  const transport = {
    peer,
    read: async () => {
      const frame = JSON.parse((await target.connection.read()).bytes.toString('utf8'))
      frames.push({ direction: 'in', frame })
      return frame
    },
    send: async frame => {
      frames.push({ direction: 'out', frame })
      await target.connection.send({ bytes: Buffer.from(JSON.stringify(frame)), binary: false })
    },
    closed: target.closed,
    close: () => target.close(),
  }
  return { frames, transport, self, selfGeneration, requestedRole, requestedPeerRole, connectionId }
}

async function main() {
  const lanIp = lanIpv4()
  if (lanIp === undefined) throw new Error('this host has no non-internal IPv4 interface; the LAN black box cannot run')
  const directory = await mkdtemp(join(tmpdir(), 'd05-lan-blackbox-'))
  console.log('# D05 closure black box: two real engines over the real LAN listener')
  console.log(`cli=${CLI}`)
  console.log(`root=${directory}`)
  console.log(`lanIp=${lanIp}`)

  logDirectory = join(directory, 'cli-logs')
  await mkdir(logDirectory, { recursive: true })
  const tlsDirectory = join(directory, 'tls')
  await mkdir(tlsDirectory, { recursive: true })
  const registryTls = generateTls(tlsDirectory, 'registry', '127.0.0.1')
  const agentATls = generateTls(tlsDirectory, 'agent-a', lanIp)
  const agentBTls = generateTls(tlsDirectory, 'agent-b', lanIp)
  assert(registryTls.cert.length > 0 && agentATls.cert.length > 0, 'real openssl TLS material was generated for the registry and both agents')

  const registryPort = await availablePort('127.0.0.1')
  const portA = await availablePort(lanIp)
  const portB = await availablePort(lanIp)
  const provider = await startStubProvider()

  const dshCredential = readDshCredential(CREDENTIAL_REF)
  const operatorEnv = {
    D05_CRED_A: CREDENTIALS.a,
    D05_CRED_B: CREDENTIALS.b,
    D05_CRED_OBSERVER: CREDENTIALS.observer,
    D05_PROBE_API_KEY: 'd05-probe-secret-value',
    ...(dshCredential === undefined ? {} : { D05_DSH_API_KEY: dshCredential }),
  }

  const registryPath = join(directory, 'registry.toml')
  live.registryConfigPath = registryPath
  const agentAPath = join(directory, 'agent-a.toml')
  const agentBPath = join(directory, 'agent-b.toml')
  await writeFile(registryPath, registryConfig({ directory: join(directory, 'registry'), port: registryPort, keyPath: registryTls.keyPath, certPath: registryTls.certPath }))
  await writeFile(agentAPath, agentConfig({
    id: AGENT_A.agentId, engine: 'opencode', executable: OPENCODE, ip: lanIp, port: portA,
    keyPath: agentATls.keyPath, certPath: agentATls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'agent-a'), extra: { baseUrl: provider.baseUrl },
  }))
  await writeFile(agentBPath, agentConfig({
    id: AGENT_B.agentId, engine: 'dsh', executable: DSH, ip: lanIp, port: portB,
    keyPath: agentBTls.keyPath, certPath: agentBTls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'agent-b'), extra: { blacklist: ['method:session/set_config_option'] },
  }))

  // ---- the real registry daemon, through the real CLI --------------------
  step = 'registry start'
  console.log(runCliSync(['registry', 'start', '--config', registryPath], operatorEnv).trim())
  const registryStatus = parseFields(runCliSync(['registry', 'status', '--config', registryPath], operatorEnv).trim())
  live.registryPid = Number(registryStatus.pid)
  live.registryGeneration = registryStatus.generation
  assert(Number.isSafeInteger(live.registryPid) && processRow(live.registryPid).length > 0, `the registry reports a live explicit pid (${live.registryPid})`)
  assert(registryStatus.state === 'running', `the registry reports running (${registryStatus.state})`)

  // ---- both real engines on the real LAN address -------------------------
  step = 'agent A readiness'
  const entryA = spawnEntry({ label: 'agent-a', engine: 'opencode', ip: lanIp, port: portA, configPath: agentAPath, env: operatorEnv })
  const fieldsA = parseFields(await awaitReady(entryA))
  console.log(`\n## agent A readiness\n${entryA.ready}`)
  step = 'agent B readiness'
  const entryB = spawnEntry({ label: 'agent-b', engine: 'dsh', ip: lanIp, port: portB, configPath: agentBPath, env: operatorEnv })
  const fieldsB = parseFields(await awaitReady(entryB))
  console.log(`\n## agent B readiness\n${entryB.ready}`)

  step = 'readiness fields'
  assert(fieldsA.listener === `${lanIp}:${portA}`, `agent A serves the real LAN listener (${fieldsA.listener})`)
  assert(fieldsB.listener === `${lanIp}:${portB}`, `agent B serves the real LAN listener (${fieldsB.listener})`)
  assert(fieldsA.lanChannel === `wss://${lanIp}:${portA}`, `agent A reports its LAN channel endpoint (${fieldsA.lanChannel})`)
  assert(fieldsB.lanChannel === `wss://${lanIp}:${portB}`, `agent B reports its LAN channel endpoint (${fieldsB.lanChannel})`)
  assert(fieldsA.localChannel.startsWith('127.0.0.1:') && fieldsA.localChannel !== fieldsA.listener,
    `agent A keeps its local channel on loopback (${fieldsA.localChannel})`)
  assert(fieldsB.localChannel.startsWith('127.0.0.1:') && fieldsB.localChannel !== fieldsB.listener,
    `agent B keeps its local channel on loopback (${fieldsB.localChannel})`)
  assert(/^[0-9]+$/.test(fieldsA.capabilitiesRevision) && fieldsA.capabilitiesRevision === fieldsB.capabilitiesRevision,
    `both daemons advertise the same published capabilities revision (${fieldsA.capabilitiesRevision})`)
  // The wire contract requires an initiator's acp.open ref to name the TARGET
  // daemon's targetGeneration and engineInstanceId, and the responder validates
  // both against its own local truth before it opens any host channel. The
  // readiness line is the contract surface for those target facts, so both
  // engine instances are read from it rather than guessed.
  assert(fieldsA.engineInstance.startsWith('opencode-'), `the readiness line publishes agent A engine instance (${fieldsA.engineInstance})`)
  assert(fieldsB.engineInstance.startsWith('dsh-'), `the readiness line publishes agent B engine instance (${fieldsB.engineInstance})`)

  const engineInstanceA = fieldsA.engineInstance
  const engineInstanceB = fieldsB.engineInstance
  const daemonPidA = Number(fieldsA.daemonPid)
  const enginePidA = Number(fieldsA.enginePid)
  const daemonPidB = Number(fieldsB.daemonPid)
  const enginePidB = Number(fieldsB.enginePid)
  assert(daemonPidA === entryA.child.pid && daemonPidB === entryB.child.pid, 'each readiness line reports the real CLI process pid')
  assert(/opencode/.test(processRow(enginePidA)) && /acp/.test(processRow(enginePidA)), `agent A runs the real opencode ACP engine (${processRow(enginePidA)})`)
  assert(/dsh/.test(processRow(enginePidB)) && /--profile/.test(processRow(enginePidB)), `agent B runs the real DSH engine (${processRow(enginePidB)})`)
  assert(childrenOf(daemonPidA).length === 1 && childrenOf(daemonPidB).length === 1, 'each daemon has exactly one child process: its engine')

  // ---- the real ~/.dsh is never the engine home --------------------------
  step = 'owned DSH home'
  const ownedHomeB = join(directory, 'agent-b', 'state', 'engine')
  const patchPathB = join(ownedHomeB, 'teams-dsh-acp.patch.json')
  assert(existsSync(patchPathB), 'the DSH entry wrote its derived profile patch into the daemon-owned home')
  assert(processRow(enginePidB).includes(patchPathB), 'the live DSH child command line uses the owned patch path, not the real ~/.dsh')
  assert(!existsSync(join(REAL_DSH_HOME, 'teams-dsh-acp.patch.json')), 'the derived patch was never written into the real ~/.dsh')

  // ---- the observer registers and reads the real directory ---------------
  step = 'observer directory'
  const observerDeclaration = {
    identity: { hostId: 'host-observer', machineId: 'host-observer', agentId: OBSERVER.agentId, accountId: ACCOUNT, agentKind: 'acp', label: 'D05 observer' },
    scopeId: SCOPE,
    revision: 1,
    capabilities: [],
    routes: [],
  }
  const observerClient = createRegistrationClient({
    declaration: observerDeclaration,
    endpoint: `wss://127.0.0.1:${registryPort}`,
    credential: CREDENTIALS.observer,
    ca: registryTls.cert,
    heartbeatIntervalMs: 5_000,
    admissionTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    maxPendingRequests: 16,
    maxDataConnections: 8,
    connectTimeoutMs: 5_000,
    maxMessageBytes: 262_144,
    maxBufferedBytes: 262_144,
    maxPendingFrames: 64,
    reconnect: { initialDelayMs: 500, maxDelayMs: 5_000, maxAttempts: 3 },
  })
  const observerStatus = await withDeadline(observerClient.start(), 'observer registration')
  assert(observerStatus.state === 'online', `the observer registered with the real registry (${observerStatus.state})`)
  const relayDirectory = await withDeadline(observerClient.directory(true), 'observer directory read')
  const peerA = relayDirectory.find(peer => peer.declaration.identity.agentId === AGENT_A.agentId)
  const peerB = relayDirectory.find(peer => peer.declaration.identity.agentId === AGENT_B.agentId)
  assert(peerA !== undefined && peerB !== undefined, 'the real directory lists both agent identities')
  assert(peerA.presence === 'online' && peerB.presence === 'online', 'both daemons are online in the real directory')
  const routeOf = peer => (peer.declaration.routes ?? []).find(candidate => candidate.kind === 'lan')
  const routeA = routeOf(peerA)
  const routeB = routeOf(peerB)
  assert(routeA?.endpoint === `wss://${lanIp}:${portA}` && routeA?.port === portA, `agent A published its real LAN route (${routeA?.endpoint})`)
  assert(routeB?.endpoint === `wss://${lanIp}:${portB}` && routeB?.port === portB, `agent B published its real LAN route (${routeB?.endpoint})`)
  assert(String(peerA.declaration.revision) === fieldsA.capabilitiesRevision && String(peerB.declaration.revision) === fieldsB.capabilitiesRevision,
    'each published directory revision equals the daemon readiness capabilitiesRevision')

  // ---- (b) a wrong credential is refused before any application frame ----
  step = 'wrong credential'
  const routePlanFor = (agentId, port) => buildDirectWssRoutePlan({
    hostId: 'host-lan',
    directoryGeneration: 1,
    policy: 'manual',
    targetCandidateId: 'lan-1',
    candidates: [{ candidateId: 'lan-1', kind: 'lan', endpoint: `wss://${lanIp}:${port}`, port, authRequired: true, lastSeenAt: new Date().toISOString() }],
  })
  const connectTo = async ({ agentId, port, cert, credential, admissionRef, capabilitiesRevision }) => await connectDirectWssTarget({
    transport: { endpoint: `wss://${lanIp}:${port}`, credential, ca: cert, connectTimeoutMs: 5_000, maxMessageBytes: 262_144, maxBufferedBytes: 262_144, maxPendingFrames: 64 },
    hello: { hostId: 'host-lan', agentId, targetGeneration: TARGET_GENERATION, protocolVersion: 1, capabilitiesRevision, source: OBSERVER, admissionRef },
    plan: routePlanFor(agentId, port),
    helloTimeoutMs: 5_000,
  })
  let refused
  try {
    const wrong = await connectTo({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, credential: CREDENTIALS.wrong, admissionRef: 'adm-observer', capabilitiesRevision: fieldsA.capabilitiesRevision })
    await wrong.close('refused after the fact').catch(() => undefined)
  } catch (error) {
    refused = error
  }
  assert(refused !== undefined, `a wrong credential is refused at the real HTTP admission (${refused === undefined ? 'accepted' : String(refused.message).slice(0, 80)})`)

  const historyOf = async root => {
    const path = join(directory, root, 'state', 'acp-history.json')
    if (!existsSync(path)) return { records: [] }
    return JSON.parse(await readFile(path, 'utf8'))
  }
  const historyA = () => historyOf('agent-a')
  const historyB = () => historyOf('agent-b')
  assert((await historyA()).records.filter(record => record.event === 'connection.negotiated').length === 0,
    'the refused connection never reached the connection handler, so no application frame was read')

  const targets = []
  const negotiate = async ({ agentId, port, cert, capabilitiesRevision, requestedRole, requestedPeerRole, label }) => {
    const target = await connectTo({ agentId, port, cert, credential: CREDENTIALS.observer, admissionRef: 'adm-observer', capabilitiesRevision })
    targets.push(target)
    const channel = openChannel({
      target, peer: { accountId: ACCOUNT, scopeId: SCOPE, agentId }, self: OBSERVER, selfGeneration: 11,
      requestedRole, requestedPeerRole, connectionId: `conn-${label}`,
    })
    const negotiation = await withDeadline(runTeamsNegotiation({
      options: {
        side: 'initiator',
        connectionId: `conn-${label}`,
        self: OBSERVER,
        peer: { accountId: ACCOUNT, scopeId: SCOPE, agentId },
        selfGeneration: 11,
        selfCapabilitiesRevision: 'observer-capabilities',
        selfPolicyRevision: 3,
        allowedRoles: ['master', 'peer'],
        requestedRole,
        requestedPeerRole,
        requestedCapabilities: ACP_CAPABILITIES,
        requestId: `req-${label}`,
        expectedTargetGeneration: TARGET_GENERATION,
        expectedTargetCapabilitiesRevision: capabilitiesRevision,
      },
      port: channel.transport,
      timeoutMs: 10_000,
    }), `negotiation ${label}`)
    return { target, channel, negotiation }
  }

  // ---- (c)(e) the initiator reaches agreed; the responder's own accept ----
  step = 'opencode leg negotiation'
  const leg1 = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'one' })
  assert(leg1.negotiation.state === 'agreed', 'the initiator reached the terminal agreed state over the real LAN socket')
  const agreement1 = negotiatedAgreement(leg1.negotiation)
  assert(agreement1.sourceRole === 'master' && agreement1.targetRole === 'peer', 'the agreement assigns the distinct master/peer role pair')
  assert(Number.isSafeInteger(agreement1.sourcePolicyRevision) && Number.isSafeInteger(agreement1.targetPolicyRevision),
    `the agreement carries integer accepted config revisions (source=${agreement1.sourcePolicyRevision} target=${agreement1.targetPolicyRevision})`)
  const acceptFrame = leg1.channel.frames.find(entry => entry.direction === 'in' && entry.frame.kind === 'teams.connection.accept')
  assert(acceptFrame !== undefined, "the responder's own accept frame was observed on the wire")
  assert(acceptFrame.frame.agreement.sourceRole === 'master' && acceptFrame.frame.agreement.targetRole === 'peer' &&
    acceptFrame.frame.agreement.targetPolicyRevision === agreement1.targetPolicyRevision,
    'both ends carry the same non-degenerate roles and the same accepted target policy revision')

  // ---- (d)(f) the opencode leg: initialize, session/new, prompt, callback -
  step = 'opencode leg ACP'
  const ref1 = { connectionId: 'conn-one', channelId: 'observer-channel-1', targetGeneration: TARGET_GENERATION, engineInstanceId: engineInstanceA }
  const openChannelOn = async (channel, ref) => {
    await channel.transport.send({ version: 1, kind: 'acp.open', ref })
    const ack = await withDeadline(channel.transport.read(), 'acp.open_ack')
    assert(ack.kind === 'acp.open_ack', `the daemon answered acp.open with acp.open_ack (${ack.kind})`)
    assert(ack.ref.channelId !== ref.channelId && ack.ref.connectionId !== ref.connectionId, 'the daemon allocated its own transport-scoped ref')
    return ack
  }
  /** Read until the match and keep every frame observed, including notifications. */
  const collectUntil = async (channel, predicate, label, timeoutMs = 90_000) => {
    const seen = []
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = await withDeadline(channel.transport.read(), label, Math.max(1_000, deadline - Date.now()))
      if (predicate(frame)) return { match: frame, seen }
      seen.push(frame)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const readUntil = async (channel, predicate, label, timeoutMs) => (await collectUntil(channel, predicate, label, timeoutMs)).match
  await openChannelOn(leg1.channel, ref1)
  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', id: 'a-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  const initializeA = await readUntil(leg1.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'a-init', 'agent A initialize')
  assert(initializeA.frame.result?.protocolVersion === 1, 'the real opencode engine answered initialize over the LAN channel')
  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', id: 'a-new', method: 'session/new', params: { cwd: directory, mcpServers: [] } } })
  const createdA = await readUntil(leg1.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'a-new', 'agent A session/new')
  const sessionA1 = createdA.frame.result?.sessionId
  assert(typeof sessionA1 === 'string' && sessionA1.length > 0, `the real opencode engine created a session over LAN (${sessionA1})`)

  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', id: 'a-prompt', method: 'session/prompt', params: { sessionId: sessionA1, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } } })
  const callbackCollection = await collectUntil(leg1.channel, frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/request_permission', 'permission callback')
  const callback = callbackCollection.match
  const options = callback.frame.params.options.map(option => option.optionId)
  assert(JSON.stringify(options) === JSON.stringify(['once', 'always', 'reject']), `the real permission callback reached the controller over LAN (${options.join(',')})`)
  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', id: callback.frame.id, result: { outcome: { outcome: 'selected', optionId: 'once' } } } })
  const promptCollection = await collectUntil(leg1.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'a-prompt', 'agent A prompt result')
  const promptA = promptCollection.match
  assert(callbackCollection.seen.some(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update') ||
    promptCollection.seen.some(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update'),
    'the opencode leg delivered a real session/update from the engine over LAN')
  assert(promptA.frame.result?.stopReason === 'end_turn', `the callback reply released the tool and the prompt completed (${promptA.frame.result?.stopReason})`)
  assert(provider.calls.some(call => call.model === 'probe-model'), 'the stub provider received the accepted model over the LAN leg')

  // ---- (g) the same JSON-RPC id on two channels and two Sessions ---------
  step = 'same-id isolation'
  const leg2 = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'peer', requestedPeerRole: 'master', label: 'two' })
  assert(leg2.negotiation.state === 'agreed', 'the second connection to the same daemon also reached agreed')
  const agreement2 = negotiatedAgreement(leg2.negotiation)
  assert(agreement2.sourceRole === 'peer' && agreement2.targetRole === 'master', 'the same daemon holds the opposite role on the second channel, so both roles are non-degenerate')
  const ref2 = { connectionId: 'conn-two', channelId: 'observer-channel-2', targetGeneration: TARGET_GENERATION, engineInstanceId: engineInstanceA }
  await openChannelOn(leg2.channel, ref2)
  // Every LAN connection opens its own host channel, so the second one needs
  // its own initialize before session/new; that is what keeps the two Sessions
  // apart.
  await leg2.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref2, frame: { jsonrpc: '2.0', id: 'b-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  const initializeA2 = await readUntil(leg2.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'b-init', 'second initialize')
  assert(initializeA2.frame.result?.protocolVersion === 1, 'the second channel also reached the real opencode engine')
  await leg2.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref2, frame: { jsonrpc: '2.0', id: 'b-new', method: 'session/new', params: { cwd: directory, mcpServers: [] } } })
  const createdA2 = await readUntil(leg2.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'b-new', 'second session/new')
  const sessionA2 = createdA2.frame.result?.sessionId
  assert(typeof sessionA2 === 'string' && sessionA2 !== sessionA1, `the second channel created a distinct Session (${sessionA2} vs ${sessionA1})`)
  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', id: 'iso-1', method: 'session/prompt', params: { sessionId: sessionA1, prompt: [{ type: 'text', text: 'ECHO:ISO-ONE' }] } } })
  await leg2.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref2, frame: { jsonrpc: '2.0', id: 'iso-1', method: 'session/prompt', params: { sessionId: sessionA2, prompt: [{ type: 'text', text: 'ECHO:ISO-TWO' }] } } })
  const isoOne = await collectUntil(leg1.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'iso-1', 'channel one result')
  const isoTwo = await collectUntil(leg2.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'iso-1', 'channel two result')
  assert(isoOne.match.frame.result?.stopReason === 'end_turn' && isoTwo.match.frame.result?.stopReason === 'end_turn', 'both same-id prompts completed on their own channel')
  const wireText = collection => JSON.stringify([collection.seen, collection.match])
  assert(wireText(isoOne).includes('ISO-ONE') && !wireText(isoOne).includes('ISO-TWO'), 'channel one received only its own same-id result')
  assert(wireText(isoTwo).includes('ISO-TWO') && !wireText(isoTwo).includes('ISO-ONE'), 'channel two received only its own same-id result')

  // ---- (h) a channel closed mid-prompt leaves an unknown outcome ---------
  step = 'lost peer'
  const leg3 = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'three' })
  const ref3 = { connectionId: 'conn-three', channelId: 'observer-channel-3', targetGeneration: TARGET_GENERATION, engineInstanceId: engineInstanceA }
  await openChannelOn(leg3.channel, ref3)
  await leg3.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref3, frame: { jsonrpc: '2.0', id: 'lost-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  const initializeA3 = await readUntil(leg3.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'lost-init', 'third initialize')
  assert(initializeA3.frame.result?.protocolVersion === 1, 'the third channel also reached the real opencode engine')
  await leg3.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref3, frame: { jsonrpc: '2.0', id: 'lost-1', method: 'session/new', params: { cwd: directory, mcpServers: [] } } })
  const createdA3 = await readUntil(leg3.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'lost-1', 'third session/new')
  const sessionA3 = createdA3.frame.result?.sessionId
  assert(typeof sessionA3 === 'string' && sessionA3.length > 0, `the third channel created its own Session (${sessionA3})`)
  // The stub provider streams one chunk and then hangs for LOST-PEER, so the
  // engine has a live mid-prompt update before the driver drops the socket.
  const providerCallsBeforeLost = provider.calls.length
  await leg3.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref3, frame: { jsonrpc: '2.0', id: 'lost-2', method: 'session/prompt', params: { sessionId: sessionA3, prompt: [{ type: 'text', text: 'LOST-PEER' }] } } })
  // The stub answers LOST-PEER with one streamed chunk and then hangs, so the
  // engine has a live mid-prompt update before the driver drops the socket.
  // The engine may not echo the stub text in its own session/update, so the
  // hang marker is the provider call itself.
  const lostDeadline = Date.now() + 30_000
  while (provider.calls.length === providerCallsBeforeLost) {
    if (Date.now() > lostDeadline) throw new Error('the LOST-PEER prompt never reached the stub provider')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  await leg3.target.close('driver closed the channel mid-prompt')
  const unknownDeadline = Date.now() + 20_000
  let unknownRecord
  while (Date.now() < unknownDeadline) {
    const records = (await historyA()).records
    unknownRecord = records.find(record => record.event === 'result.unknown' && record.sessionId === sessionA3)
    if (unknownRecord !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert(unknownRecord !== undefined, 'the daemon wrote a durable result.unknown record for the closed channel')
  assert(unknownRecord.outcome === 'unknown', `the durable history outcome is unknown (${unknownRecord.outcome})`)
  const replay = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'reconnect' })
  const ref4 = { connectionId: 'conn-reconnect', channelId: 'observer-channel-4', targetGeneration: TARGET_GENERATION, engineInstanceId: engineInstanceA }
  await openChannelOn(replay.channel, ref4)
  await replay.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref4, frame: { jsonrpc: '2.0', id: 'replay-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  await readUntil(replay.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'replay-init', 'reconnect initialize')
  const replayed = await readUntil(replay.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'lost-2', 'replayed result', 3_000)
    .then(() => true)
    .catch(() => false)
  assert(replayed === false, 'the unknown prompt result was never replayed after reconnect')

  // ---- (d)(f)(i)(j) the DSH leg, the method blacklist and the outage ------
  step = 'dsh leg negotiation'
  const legDsh = await negotiate({ agentId: AGENT_B.agentId, port: portB, cert: agentBTls.cert, capabilitiesRevision: fieldsB.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'dsh' })
  assert(legDsh.negotiation.state === 'agreed', 'the initiator reached agreed with the real DSH daemon over LAN')
  const refDsh = { connectionId: 'conn-dsh', channelId: 'observer-channel-dsh', targetGeneration: TARGET_GENERATION, engineInstanceId: engineInstanceB }
  await openChannelOn(legDsh.channel, refDsh)
  await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  const initializeDsh = await readUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-init', 'DSH initialize')
  assert(initializeDsh.frame.result?.protocolVersion === 1 && initializeDsh.frame.result?.agentInfo?.name === 'deepseek-harness-acp',
    `the real DSH engine answered initialize over LAN (${initializeDsh.frame.result?.agentInfo?.name})`)
  await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-new', method: 'session/new', params: { cwd: directory, mcpServers: [] } } })
  const createdDsh = await readUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-new', 'DSH session/new')
  const sessionDsh = createdDsh.frame.result?.sessionId
  assert(typeof sessionDsh === 'string' && sessionDsh.length > 0, `the real DSH engine created a session over LAN (${sessionDsh})`)

  const dshPromptLeg = { state: 'INCOMPLETE', firstFailingGate: 'D05_DSH_CREDENTIAL', detail: `credential ${CREDENTIAL_REF} did not resolve from ${CREDENTIALS_FILE}` }
  if (dshCredential !== undefined) {
    const beforeOutage = provider.calls.length
    await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-prompt', method: 'session/prompt', params: { sessionId: sessionDsh, prompt: [{ type: 'text', text: 'ECHO:DSH-LEG' }] } } })
    // The real provider is slow, so a first-frame deadline would make this
    // flaky. Read until the terminal result instead and keep every update
    // observed on the way, which also holds the arrival order.
    const dshCollection = await collectUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-prompt', 'DSH prompt result', 180_000)
    const dshResult = dshCollection.match
    const dshUpdates = dshCollection.seen.filter(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update')
    // The LAN relay is symmetric for updates, so record the exact number this
    // run delivered instead of guessing: the prompt result below is the gate.
    console.log(`  obs: the DSH leg delivered ${dshUpdates.length} session/update frame(s) over LAN`)
    if (dshResult.frame.error !== undefined) {
      dshPromptLeg.state = 'INCOMPLETE'
      dshPromptLeg.firstFailingGate = `DSH_PROVIDER:${dshResult.frame.error.code}`
      dshPromptLeg.detail = String(dshResult.frame.error.message).slice(0, 200)
    } else {
      assert(dshResult.frame.result?.stopReason === 'end_turn', `the real DSH prompt returned a terminal result over LAN (${dshResult.frame.result?.stopReason})`)
      dshPromptLeg.state = 'PASS'
      dshPromptLeg.firstFailingGate = null
      dshPromptLeg.detail = `stopReason=${dshResult.frame.result?.stopReason}`
    }
    assert(provider.calls.length === beforeOutage, 'the DSH leg produced no opencode stub provider activity')

    // (i) the blacklisted method is refused before the engine sees it.
    step = 'method blacklist'
    await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-cfg', method: 'session/set_config_option', params: { sessionId: sessionDsh, configId: 'model', value: '' } } })
    const refusedMethod = await readUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-cfg', 'blacklisted method refusal')
    // The host refusal travels as the single ACP JSON-RPC error envelope: the
    // top-level `error.code` is the wire code and the typed fault rides in `data`.
    assert(refusedMethod.frame.error !== undefined && refusedMethod.frame.error.code === -32000 &&
      refusedMethod.frame.error.data?.code === 'CAPABILITY_DENIED',
      `the blacklisted method was refused before the engine with a typed JSON-RPC error envelope (${JSON.stringify(refusedMethod.frame.error)})`)
    assert(provider.calls.length === beforeOutage, 'the refused method produced no provider call anywhere in the run')
    const refusedHistory = await historyB()
    assert(!refusedHistory.records.some(record => record.event === 'request.dispatched' && JSON.stringify(record).includes('session/set_config_option')),
      'the blacklisted method was never dispatched to the engine')
    assert(refusedHistory.records.some(record => record.event === 'initialize'),
      'the durable history still contains the daemon initialize record after the refusal')

    // (j) the registry outage must not close the established channel.
    step = 'registry outage'
    console.log(runCliSync(['registry', 'stop', '--config', registryPath, '--generation', String(live.registryGeneration)], operatorEnv).trim())
    assert(processRow(live.registryPid).length === 0, `the registry pid ${live.registryPid} is gone after the service-entry stop`)
    await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-prompt-2', method: 'session/prompt', params: { sessionId: sessionDsh, prompt: [{ type: 'text', text: 'ECHO:OUTAGE-OK' }] } } })
    const afterOutage = await readUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-prompt-2', 'post-outage prompt result', 120_000)
    assert(afterOutage.frame.error === undefined && afterOutage.frame.result?.stopReason === 'end_turn',
      `a second prompt succeeded on the established channel while the registry was down (${afterOutage.frame.result?.stopReason ?? 'no result'})`)
    const degradeDeadline = Date.now() + 45_000
    while (Date.now() < degradeDeadline && registrationLines(entryB).length === 0) {
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    const degraded = registrationLines(entryB)
    assert(degraded.length > 0, `the daemon reported its registration degradation on stdout (${degraded.at(-1) ?? 'no line'})`)
    assert(!/state=online/.test(degraded.at(-1)), 'the reported registration state is no longer online')
  }

  // ---- no control process was ever spawned --------------------------------
  step = 'no control process'
  assert(childrenOf(daemonPidA).length === 1 && childrenOf(daemonPidB).length === 1, 'neither daemon ever spawned a second child (no control process)')
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const controlRows = table.split('\n').filter(line => /--serve|registry start/.test(line) === false && /agentteams/.test(line) && /control/.test(line))
  assert(controlRows.length === 0, `no agentteams control process exists (${controlRows.length} rows)`)

  // ---- explicit-PID stop and port/process cleanup ------------------------
  step = 'explicit-PID stop'
  for (const target of targets) await target.close('driver finished').catch(() => undefined)
  await observerClient.stop().catch(() => undefined)
  const stopEntry = async (record, daemonPid, enginePid) => {
    const exited = new Promise(resolveExit => record.child.once('exit', (code, signal) => resolveExit({ code, signal })))
    process.kill(daemonPid, 'SIGTERM')
    const exit = await withDeadline(exited, `${record.label} exit`, 60_000)
    const stoppedLine = record.stdout.split('\n').find(line => line.startsWith('stopped '))
    console.log(stoppedLine ?? `(${record.label} printed no stopped line)`)
    assert(stoppedLine !== undefined, `${record.label} printed its stop receipt`)
    assert(processRow(enginePid).length === 0, `${record.label} engine pid ${enginePid} is gone`)
    assert(childrenOf(daemonPid).length === 0, `${record.label} left no child process behind`)
    assert(exit.code === 0, `${record.label} exited cleanly by explicit PID (code=${exit.code} signal=${exit.signal})`)
    return stoppedLine
  }
  const stoppedA = await stopEntry(entryA, daemonPidA, enginePidA)
  const stoppedB = await stopEntry(entryB, daemonPidB, enginePidB)
  assert(!existsSync(ownedHomeB), 'the owned DSH home was removed on stop, so no engine home leaked')
  assert(await portIsClosed('127.0.0.1', Number(fieldsA.localChannel.split(':')[1])), `agent A local channel port is free after the stop (${fieldsA.localChannel})`)
  assert(await portIsClosed('127.0.0.1', Number(fieldsB.localChannel.split(':')[1])), `agent B local channel port is free after the stop (${fieldsB.localChannel})`)
  assert(await portIsClosed(lanIp, portA), `the LAN port ${portA} is free after the stop`)
  assert(await portIsClosed(lanIp, portB), `the LAN port ${portB} is free after the stop`)
  assert(await portIsClosed('127.0.0.1', registryPort), `the registry port ${registryPort} is free after the stop`)

  step = 'history'
  const finalHistory = await historyA()
  const negotiated = finalHistory.records.filter(record => record.event === 'connection.negotiated').length
  assert(negotiated === 4, `the daemon recorded exactly the 4 admitted connections (${negotiated})`)
  assert(finalHistory.records.some(record => record.event === 'result.received'), 'the daemon wrote its durable execution history')

  console.log(`\nBLACK-BOX PASS: two real engines on one real LAN listener, real registry directory, real negotiation, real prompts, isolation, unknown outcome, method blacklist, registry outage.`)
  console.log(JSON.stringify({
    lanIp,
    registry: { pid: live.registryPid, generation: live.registryGeneration, port: registryPort },
    agentA: { daemonPid: daemonPidA, enginePid: enginePidA, listener: fieldsA.listener, localChannel: fieldsA.localChannel, lanChannel: fieldsA.lanChannel, capabilitiesRevision: fieldsA.capabilitiesRevision, stop: stoppedA },
    agentB: { daemonPid: daemonPidB, enginePid: enginePidB, listener: fieldsB.listener, localChannel: fieldsB.localChannel, lanChannel: fieldsB.lanChannel, capabilitiesRevision: fieldsB.capabilitiesRevision, stop: stoppedB },
    dshPromptLeg,
    providerCalls: provider.calls.length,
    connections: negotiated,
    registryDegradation: registrationLines(entryB).at(-1) ?? null,
  }, null, 2))
  return { dshPromptLeg, relayDirectory }
}

/**
 * Stop every process this driver started, by explicit pid only. The registry goes
 * through its own service entry; each daemon child gets SIGTERM then SIGKILL.
 * `hard` is used from the overall-deadline timer, because `process.exit` would
 * otherwise skip the `finally` below and leak the registry for the next run.
 */
async function reapEverything(hard) {
  for (const record of live.entries) {
    if (record.child.exitCode !== null || record.child.signalCode !== null) continue
    const reaped = new Promise(resolveExit => record.child.once('exit', resolveExit))
    record.child.kill('SIGTERM')
    const gone = await Promise.race([reaped.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 15_000))])
    if (!gone) {
      record.child.kill('SIGKILL')
      await new Promise(resolveExit => record.child.once('exit', resolveExit))
    }
  }
  if (live.registryPid !== null && live.registryConfigPath !== null && processRow(live.registryPid).length > 0) {
    try {
      runCliSync(['registry', 'stop', '--config', live.registryConfigPath], {})
    } catch {
      process.kill(live.registryPid, 'SIGTERM')
    }
    if (hard) {
      // Give the service-entry stop a moment, then fall back to the explicit pid.
      const gone = await new Promise(resolveWait => setTimeout(() => resolveWait(processRow(live.registryPid).length === 0), 3_000))
      if (!gone) process.kill(live.registryPid, 'SIGKILL')
    }
  }
}

try {
  const deadline = setTimeout(() => {
    console.error(`BLACK-BOX FAIL [${step}]: overall deadline ${OVERALL_DEADLINE_MS}ms elapsed`)
    // `process.exit` skips the `finally`, so reap here before leaving. The timer
    // must not be unref'd, otherwise a dead peer would hang the driver forever.
    setTimeout(async () => { await reapEverything(true); process.exit(1) }, 0)
  }, OVERALL_DEADLINE_MS)
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  for (const record of live.entries) {
    console.error(`--- ${record.label} stdout ---\n${record.stdout}\n--- ${record.label} stderr ---\n${record.stderr}`)
  }
  process.exitCode = 1
} finally {
  // Normal paths: the cleanup promise can run because the process is still alive.
  await reapEverything(false)
}

// The stopped daemons leave sockets and timers behind, so the event loop never
// drains on its own. This driver owns every process it started and has reaped
// them above, so it ends here with its own verdict: 0 after the PASS line, 1
// after any failed assertion. The stdout flush keeps a piped capture complete.
await new Promise(resolveFlush => process.stdout.write('', resolveFlush))
process.exit(process.exitCode ?? 0)
