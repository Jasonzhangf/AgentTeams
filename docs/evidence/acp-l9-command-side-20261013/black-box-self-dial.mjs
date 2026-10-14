#!/usr/bin/env node
/**
 * L9 command-side black box: the agent daemon dials its declared peer itself.
 *
 * This driver starts two REAL `agentteams --serve opencode` daemons on a real
 * non-loopback LAN address, against a REAL registry started through the real
 * `registry start` CLI, with REAL TLS material and REAL HTTP admission. It is
 * the command-side counterpart of the D05 closure driver: D05 proves an
 * external observer can negotiate into a daemon; this driver proves a daemon
 * negotiates OUT to the peer its own accepted config declares, with no external
 * initiator at all.
 *
 * The only thing this driver does after starting the dialer daemon is read the
 * daemons' own durable connection history. It never opens a socket to either
 * daemon, never sends a Teams frame and never names a role. If the initiator leg
 * did not dial on its own, both histories stay empty and the driver fails.
 *
 * It proves, with explicit PIDs and no wildcard kill:
 *   (a) the dialer config declares exactly one peer (`l9-responder`) with its
 *       real endpoint, admissionRef, credentialRef and tlsTrustRef;
 *   (b) the responder registers with the real registry and reports `online`
 *       before the dialer starts, so the dialer's directory readback can see it;
 *   (c) the dialer's own durable history records `connection.negotiated` for
 *       `l9-responder` with the agreement's `source` = dialer, `target` =
 *       responder, `sourceRole` = peer, `targetRole` = master, and
 *       `targetCapabilitiesRevision` equal to the responder's readiness value;
 *   (d) the responder's own durable history records the SAME agreement;
 *   (e) both histories record `channel.opened`, so a real ACP channel opened;
 *   (f) neither history records `connection.failed` for the peer.
 *
 * WHAT THIS DOES NOT PROVE (read before citing it)
 *   - This is source-tree evidence. It runs the worktree's compiled
 *     `generated/runtime-lib` through the source CLI, not an installed artifact.
 *   - It uses a local OpenAI-compatible stub provider for the OpenCode engine.
 *     It proves the daemon and the initiator leg, not any upstream model.
 *   - The `targetGeneration` on the wire is 1, the constant the serve entry
 *     publishes. The dialer reads it as its own runtime constant; the directory
 *     carries only the relay login generation, which is a different value.
 *   - It is not restart, deployment, cross-device or multi-account evidence.
 *
 * Usage: node docs/evidence/acp-l9-command-side-20261013/black-box-self-dial.mjs
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
const DIALER = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'l9-dialer' }
const RESPONDER = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'l9-responder' }
const DIALER_HOST_ID = 'host-l9-dialer'
const RESPONDER_HOST_ID = 'host-l9-responder'
const TARGET_GENERATION = 1
const PEER_NAME = RESPONDER.agentId

/** Deterministic, non-secret credentials. Values are never printed. */
const CREDENTIALS = {
  dialer: 'Bearer l9-command-side-dialer-secret',
  responder: 'Bearer l9-command-side-responder-secret',
  peer: 'Bearer l9-command-side-peer-secret',
  probe: 'l9-command-side-probe-secret',
}

let step = 'startup'
let logDirectory = null
let cliRunCounter = 0
let ownedRoot = null
const live = { entries: [], registryPid: null, registryConfigPath: null }
const receipts = { driver: 'acp-l9-command-side-20261013/black-box-self-dial.mjs', startedAt: new Date().toISOString(), steps: [] }

function assert(condition, message) {
  if (!condition) throw new Error(`BLACK-BOX FAIL [${step}]: ${message}`)
  console.log(`  ok: ${message}`)
}

function note(message) {
  console.log(`  -- ${message}`)
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
admissionRef = "adm-dialer"
agentId = ${JSON.stringify(DIALER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9_CRED_DIALER"

[[admissions]]
admissionRef = "adm-responder"
agentId = ${JSON.stringify(RESPONDER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:L9_CRED_RESPONDER"
`
}

/**
 * One v4 agent config. `peer` is present only for the dialer: it is the single
 * declared peer the daemon must dial on its own.
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
label = "L9 command-side stub provider"
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
    sourceGeneration: agreement?.sourceGeneration,
    targetGeneration: agreement?.targetGeneration,
    sourceCapabilitiesRevision: agreement?.sourceCapabilitiesRevision,
    targetCapabilitiesRevision: agreement?.targetCapabilitiesRevision,
    capabilities: agreement?.capabilities,
  }
}

async function main() {
  const lanIp = lanIpv4()
  if (lanIp === undefined) throw new Error('this host has no non-internal IPv4 interface; the LAN black box cannot run')
  const directory = await mkdtemp(join(tmpdir(), 'l9-command-side-blackbox-'))
  ownedRoot = directory
  console.log('# L9 command-side black box: the agent daemon dials its declared peer itself')
  console.log(`cli=${CLI}`)
  console.log(`root=${directory}`)
  console.log(`lanIp=${lanIp}`)

  logDirectory = join(directory, 'cli-logs')
  await mkdir(logDirectory, { recursive: true })
  const tlsDirectory = join(directory, 'tls')
  await mkdir(tlsDirectory, { recursive: true })
  const registryTls = generateTls(tlsDirectory, 'registry', '127.0.0.1')
  const dialerTls = generateTls(tlsDirectory, 'dialer', lanIp)
  const responderTls = generateTls(tlsDirectory, 'responder', lanIp)
  assert(registryTls.cert.length > 0 && dialerTls.cert.length > 0 && responderTls.cert.length > 0, 'real openssl TLS material was generated for the registry and both daemons')

  const registryPort = await availablePort('127.0.0.1')
  const dialerPort = await availablePort(lanIp)
  const responderPort = await availablePort(lanIp)
  const provider = await startStubProvider()

  const operatorEnv = {
    L9_CRED_DIALER: CREDENTIALS.dialer,
    L9_CRED_RESPONDER: CREDENTIALS.responder,
    L9_CRED_PEER: CREDENTIALS.peer,
    L9_PROBE_API_KEY: CREDENTIALS.probe,
  }

  const registryPath = join(directory, 'registry.toml')
  live.registryConfigPath = registryPath
  const dialerPath = join(directory, 'dialer.toml')
  const responderPath = join(directory, 'responder.toml')
  await writeFile(registryPath, registryConfig({ directory: join(directory, 'registry'), port: registryPort, keyPath: registryTls.keyPath, certPath: registryTls.certPath }))
  await writeFile(responderPath, agentConfig({
    id: RESPONDER.agentId, hostId: RESPONDER_HOST_ID, ip: lanIp, port: responderPort,
    keyPath: responderTls.keyPath, certPath: responderTls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'responder'), baseUrl: provider.baseUrl,
    credentialRef: 'env:L9_CRED_RESPONDER',
    inboundAdmission: { admissionRef: 'adm-dialer', agentId: DIALER.agentId },
  }))
  await writeFile(dialerPath, agentConfig({
    id: DIALER.agentId, hostId: DIALER_HOST_ID, ip: lanIp, port: dialerPort,
    keyPath: dialerTls.keyPath, certPath: dialerTls.certPath, trustPath: registryTls.certPath,
    registryPort, directory: join(directory, 'dialer'), baseUrl: provider.baseUrl,
    credentialRef: 'env:L9_CRED_DIALER',
    inboundAdmission: { admissionRef: 'adm-responder', agentId: RESPONDER.agentId },
    peer: {
      agentId: RESPONDER.agentId,
      hostId: RESPONDER_HOST_ID,
      endpoint: `wss://${lanIp}:${responderPort}`,
      admissionRef: 'adm-dialer',
      credentialRef: 'env:L9_CRED_PEER',
      tlsTrustRef: responderTls.certPath,
    },
  }))
  record('dialerConfigPath', dialerPath)
  record('responderConfigPath', responderPath)
  record('declaredPeer', { name: PEER_NAME, endpoint: `wss://${lanIp}:${responderPort}`, admissionRef: 'adm-dialer' })

  // ---- the real registry daemon, through the real CLI --------------------
  step = 'registry start'
  console.log(runCliSync(['registry', 'start', '--config', registryPath], operatorEnv).trim())
  const registryStatus = parseFields(runCliSync(['registry', 'status', '--config', registryPath], operatorEnv).trim())
  live.registryPid = Number(registryStatus.pid)
  assert(Number.isSafeInteger(live.registryPid) && processRow(live.registryPid).length > 0, `the registry reports a live explicit pid (${live.registryPid})`)
  assert(registryStatus.state === 'running', `the registry reports running (${registryStatus.state})`)
  record('registry', { pid: live.registryPid, endpoint: `wss://127.0.0.1:${registryPort}` })

  // ---- the responder first, so the dialer's directory readback sees it ----
  step = 'responder readiness'
  const responderEntry = spawnEntry({ label: 'responder', ip: lanIp, port: responderPort, configPath: responderPath, env: operatorEnv })
  const responderFields = parseFields(await awaitReady(responderEntry))
  assert(responderFields.listener === `${lanIp}:${responderPort}`, `the responder serves the real LAN listener (${responderFields.listener})`)
  assert(responderFields.lanChannel === `wss://${lanIp}:${responderPort}`, `the responder reports its LAN channel endpoint (${responderFields.lanChannel})`)
  const responderRegistration = await awaitRegistrationOnline(responderEntry)
  assert(responderRegistration.includes('state=online'), `the responder registered with the real registry (${responderRegistration})`)
  const responderCapabilitiesRevision = responderFields.capabilitiesRevision
  assert(/^[0-9]+$/.test(responderCapabilitiesRevision), `the responder publishes a numeric capabilities revision (${responderCapabilitiesRevision})`)
  record('responder', {
    pid: responderEntry.child.pid,
    listener: responderFields.listener,
    lanChannel: responderFields.lanChannel,
    capabilitiesRevision: responderCapabilitiesRevision,
    engineInstance: responderFields.engineInstance,
    registration: responderRegistration,
  })

  // ---- the dialer: it must dial the declared peer with no external help ----
  step = 'dialer readiness'
  const dialerEntry = spawnEntry({ label: 'dialer', ip: lanIp, port: dialerPort, configPath: dialerPath, env: operatorEnv })
  const dialerFields = parseFields(await awaitReady(dialerEntry))
  assert(dialerFields.listener === `${lanIp}:${dialerPort}`, `the dialer serves the real LAN listener (${dialerFields.listener})`)
  assert(dialerFields.lanChannel === `wss://${lanIp}:${dialerPort}`, `the dialer reports its LAN channel endpoint (${dialerFields.lanChannel})`)
  const dialerRegistration = await awaitRegistrationOnline(dialerEntry)
  assert(dialerRegistration.includes('state=online'), `the dialer registered with the real registry (${dialerRegistration})`)
  record('dialer', {
    pid: dialerEntry.child.pid,
    listener: dialerFields.listener,
    lanChannel: dialerFields.lanChannel,
    capabilitiesRevision: dialerFields.capabilitiesRevision,
    engineInstance: dialerFields.engineInstance,
    registration: dialerRegistration,
  })

  // ---- the dialer dialed the declared peer on its own ---------------------
  step = 'dialer initiator leg'
  const dialerState = join(directory, 'dialer', 'state')
  const responderState = join(directory, 'responder', 'state')
  const dialerNegotiated = await awaitConnectionRecord(
    dialerState,
    record => record.event === 'connection.negotiated' && record.agentId === RESPONDER.agentId,
    'the dialer durable history',
  )
  const dialerAgreement = agreementSummary(dialerNegotiated)
  assert(dialerAgreement.source?.agentId === DIALER.agentId && dialerAgreement.source?.accountId === ACCOUNT && dialerAgreement.source?.scopeId === SCOPE,
    `the dialer's recorded agreement source is the dialer itself (${dialerAgreement.source?.agentId})`)
  assert(dialerAgreement.target?.agentId === RESPONDER.agentId && dialerAgreement.target?.accountId === ACCOUNT && dialerAgreement.target?.scopeId === SCOPE,
    `the dialer's recorded agreement target is the declared peer (${dialerAgreement.target?.agentId})`)
  assert(dialerAgreement.sourceRole === 'peer' && dialerAgreement.targetRole === 'master',
    `the dialer negotiated the declared non-degenerate roles (${dialerAgreement.sourceRole}/${dialerAgreement.targetRole})`)
  assert(dialerAgreement.targetGeneration === TARGET_GENERATION,
    `the dialer named the responder's published listener generation (${dialerAgreement.targetGeneration})`)
  assert(dialerAgreement.targetCapabilitiesRevision === responderCapabilitiesRevision,
    `the dialer read the responder's capability revision from the scoped directory (${dialerAgreement.targetCapabilitiesRevision})`)
  record('dialerNegotiated', dialerAgreement)

  step = 'responder accepts the dial'
  const responderNegotiated = await awaitConnectionRecord(
    responderState,
    record => record.event === 'connection.negotiated' && record.agentId === DIALER.agentId,
    'the responder durable history',
  )
  const responderAgreement = agreementSummary(responderNegotiated)
  assert(responderAgreement.agreementConnectionId === dialerAgreement.agreementConnectionId,
    `both sides recorded the same wire agreement connection id (${responderAgreement.agreementConnectionId})`)
  assert(JSON.stringify(responderAgreement.source) === JSON.stringify(dialerAgreement.source)
    && JSON.stringify(responderAgreement.target) === JSON.stringify(dialerAgreement.target)
    && responderAgreement.sourceRole === dialerAgreement.sourceRole
    && responderAgreement.targetRole === dialerAgreement.targetRole,
  'both sides recorded the same agreement identities and roles')
  record('responderNegotiated', responderAgreement)

  step = 'both ACP channels open'
  const dialerChannel = await awaitConnectionRecord(
    dialerState,
    record => record.event === 'channel.opened' && record.agentId === RESPONDER.agentId,
    'the dialer channel.opened record',
  )
  const responderChannel = await awaitConnectionRecord(
    responderState,
    record => record.event === 'channel.opened' && record.agentId === DIALER.agentId,
    'the responder channel.opened record',
  )
  assert(typeof dialerChannel.channelId === 'string' && typeof dialerChannel.engineInstanceId === 'string',
    `the dialer recorded the opened ACP channel (${dialerChannel.channelId})`)
  assert(typeof responderChannel.channelId === 'string' && typeof responderChannel.engineInstanceId === 'string',
    `the responder recorded the opened ACP channel (${responderChannel.channelId})`)
  record('dialerChannel', { channelId: dialerChannel.channelId, engineInstanceId: dialerChannel.engineInstanceId })
  record('responderChannel', { channelId: responderChannel.channelId, engineInstanceId: responderChannel.engineInstanceId })

  step = 'no recorded failure'
  const dialerFailed = (await readConnectionRecords(dialerState)).filter(record => record.event === 'connection.failed' && record.agentId === RESPONDER.agentId)
  const responderFailed = (await readConnectionRecords(responderState)).filter(record => record.event === 'connection.failed' && record.agentId === DIALER.agentId)
  assert(dialerFailed.length === 0, 'the dialer recorded no connection.failed for the declared peer')
  assert(responderFailed.length === 0, 'the responder recorded no connection.failed for the dialer')
  record('providerCalls', provider.calls.length)

  console.log('\n## PASS: the agent daemon dialed its declared peer itself and reached ready')
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
  if (live.registryPid !== null && live.registryConfigPath !== null && processRow(live.registryPid).length > 0) {
    try {
      runCliSync(['registry', 'stop', '--config', live.registryConfigPath], {})
    } catch {
      process.kill(live.registryPid, 'SIGTERM')
    }
    if (hard) {
      const gone = await new Promise(resolveWait => setTimeout(() => resolveWait(processRow(live.registryPid).length === 0), 3_000))
      if (!gone) process.kill(live.registryPid, 'SIGKILL')
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
