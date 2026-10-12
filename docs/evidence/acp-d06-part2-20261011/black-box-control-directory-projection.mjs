#!/usr/bin/env node
/**
 * D06 control directory-projection black box: the real D04 directory behind the control WebUI.
 *
 * This increment was previously carried as a separate "D09" unit. It is folded into D06: there
 * is no separate D09 unit, gate or evidence directory. This driver is the re-homed original.
 *
 * Real entrypoints only:
 *   - `agentteams registry start|stop` for the real registry daemon (real TLS, real admissions)
 *   - `agentteams --serve opencode` twice for two real registered agent daemons
 *   - `agentteams control start|stop` for the real control daemon under test
 *   - real authenticated HTTP for `GET /api/v1/projection` and `GET /api/v1/events`
 *
 * It proves:
 *   (a) the control daemon's projection is not the hardcoded empty snapshot: its agent rows
 *       are the real registered peers with their real generation/presence/host facts;
 *   (b) the additive connection rows are the same real directory peers;
 *   (c) the SSE stream emits a real frame whose `seq` advances when a second real agent
 *       registers into the directory.
 *
 * `pnpm build` must have run: the CLI loads `generated/runtime-lib/`.
 * Cleanup is explicit-PID only. It never uses pkill/killall/kill $(...).
 *
 * Usage: node docs/evidence/acp-d06-part2-20261011/black-box-control-directory-projection.mjs
 * Env:   AGENTTEAMS_CLI        (default <repo>/cli/agentteams.mjs)
 *        OPENCODE_EXECUTABLE   (default /Users/fanzhang/.opencode/bin/opencode)
 *        TEAMS_CONTROL_PROJECTION_EVIDENCE_OUT
 *                              (default <repo>/../.worker-runs/acp-d06-directory-projection-20261011)
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(evidenceRoot, '..', '..', '..')
const CLI = process.env.AGENTTEAMS_CLI ?? join(projectRoot, 'cli', 'agentteams.mjs')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const REPORT_DIR = process.env.TEAMS_CONTROL_PROJECTION_EVIDENCE_OUT ?? resolve(projectRoot, '..', '.worker-runs', 'acp-d06-directory-projection-20261011')

const ACCOUNT = 'local'
const SCOPE = 'local'
const CONTROL_ID = 'control-a'
const AGENT_A = 'reasoner-a'
const AGENT_B = 'reasoner-b'
const PASSWORD_ENV = 'TEAMS_CONTROL_BLACKBOX_PASSWORD'
const PASSWORD = `teams-${Math.random().toString(36).slice(2, 12)}`
const USERNAME = 'teams'
const basic = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`
const CREDENTIALS = {
  control: `Bearer teams-control-${Math.random().toString(36).slice(2, 10)}`,
  a: `Bearer teams-agent-a-${Math.random().toString(36).slice(2, 10)}`,
  b: `Bearer teams-agent-b-${Math.random().toString(36).slice(2, 10)}`,
}
const CREDENTIAL_ENV = {
  control: 'TEAMS_CRED_CONTROL',
  a: 'TEAMS_CRED_A',
  b: 'TEAMS_CRED_B',
}
const STEP_TIMEOUT_MS = Number(process.env.TEAMS_STEP_TIMEOUT_MS ?? 120_000)

const checks = []
const children = []
let ownedRoot

const delay = (ms) => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

function check(name, detail) {
  checks.push({ name, detail, ok: true })
  process.stdout.write(`PASS ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); rejectPort(new Error('no port')); return }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: projectRoot, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000,
  })
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

function field(line, name) {
  const match = new RegExp(`(?:^| )${name}=([^ ]+)`).exec(line)
  return match === undefined ? undefined : match[1]
}

/** One real background entry (agent or control child) with its collected stdout lines. */
function spawnEntry(args, env, label) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: projectRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  const consume = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length > 0) { lines.push(trimmed); process.stdout.write(`[${label}] ${trimmed}\n`) }
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  children.push(child)
  return {
    child,
    lines,
    async waitForLine(accept, description) {
      const deadline = Date.now() + STEP_TIMEOUT_MS
      while (Date.now() < deadline) {
        const found = lines.find(accept)
        if (found !== undefined) return found
        if (child.exitCode !== null) throw new Error(`${label} exited early code=${child.exitCode}\n${lines.join('\n')}`)
        await delay(50)
      }
      throw new Error(`timed out waiting for ${description} on ${label}\n${lines.join('\n')}`)
    },
  }
}

async function stopEntry(entry, label) {
  const pid = entry.child.pid
  if (pid === undefined || !pidAlive(pid)) return
  entry.child.kill('SIGTERM')
  const deadline = Date.now() + 10_000
  while (pidAlive(pid) && Date.now() < deadline) await delay(50)
  if (pidAlive(pid)) {
    entry.child.kill('SIGKILL')
    process.stdout.write(`WARN ${label} pid=${pid} needed SIGKILL\n`)
  }
}

function portClosed(port, timeoutMs = 500) {
  return new Promise(resolveClosed => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = closed => { socket.destroy(); resolveClosed(closed) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
  })
}

/** A real SSE reader over the control daemon's own event stream. */
async function openEventStream(url) {
  const response = await fetch(url, { headers: { authorization: basic } })
  assert.equal(response.status, 200, `event stream status ${response.status}`)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames = []
  let buffer = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (event === undefined || data === undefined) continue
          frames.push({ event, data: JSON.parse(data) })
        }
      }
    } catch { /* the stream closed */ }
  })()
  return {
    frames,
    async waitForFrame(accept, description) {
      const deadline = Date.now() + STEP_TIMEOUT_MS
      while (Date.now() < deadline) {
        const found = frames.find(accept)
        if (found !== undefined) return found
        await delay(50)
      }
      throw new Error(`timed out waiting for ${description}; frames=${JSON.stringify(frames)}`)
    },
    async close() {
      await reader.cancel().catch(() => undefined)
      await pump
    },
  }
}

/* ----------------------------------------------------------------------------------------- */

function registryConfig(root, port, certPath, keyPath) {
  const admission = (ref, agentId, credentialEnv) => `
[[admissions]]
admissionRef = ${JSON.stringify(ref)}
agentId = ${JSON.stringify(agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:${credentialEnv}"
`
  return `version = 4

[daemon]
kind = "registry"
id = "teams-registry"
hostId = "registry-host"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(join(root, 'registry-state'))}

[listen]
ip = "127.0.0.1"
port = ${port}
tlsCertRef = "file:${certPath}"
tlsKeyRef = "file:${keyPath}"
${admission('adm-control', CONTROL_ID, CREDENTIAL_ENV.control)}${admission('adm-a', AGENT_A, CREDENTIAL_ENV.a)}${admission('adm-b', AGENT_B, CREDENTIAL_ENV.b)}`
}

function agentConfig(root, id, port, registryPort, credentialEnv, trustPath) {
  return `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(id)}
hostId = ${JSON.stringify(`${id}-host`)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(join(root, `state-${id}`))}

[engine]
kind = "opencode"
executable = ${JSON.stringify(OPENCODE)}
workspace = ${JSON.stringify(join(root, `workspace-${id}`))}

[listen]
ip = "127.0.0.1"
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
apiBaseUrl = "http://127.0.0.1:1/v1"
label = "D06 stub provider"
enabled = true
credentialEnv = "TEAMS_PROBE_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"

[discovery]
serverId = "teams-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:${credentialEnv}"
tlsTrustRef = "file:${trustPath}"
`
}

function controlConfig(root, port, registryPort, trustPath) {
  return `version = 4

[daemon]
kind = "control"
id = ${JSON.stringify(CONTROL_ID)}
hostId = "control-host"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(join(root, 'control-state'))}

[webui]
ip = "127.0.0.1"
port = ${port}
allowedOrigin = "http://127.0.0.1:${port}"

[webui.auth]
username = ${JSON.stringify(USERNAME)}
passwordEnv = ${JSON.stringify(PASSWORD_ENV)}

[relations]
allowed = ["master", "peer"]

[discovery]
serverId = "teams-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:${CREDENTIAL_ENV.control}"
tlsTrustRef = "file:${trustPath}"
`
}

/* ----------------------------------------------------------------------------------------- */

let registryUrl
let registryPid
let registryGeneration
let controlUrl
let controlPid
let controlGeneration
let agentA
let agentB
let stream
const report = { checks, commands: [], facts: {} }

async function main() {
  ownedRoot = mkdtempSync(join(tmpdir(), 'acp-d06-directory-projection-'))
  process.stdout.write(`owned temp root: ${ownedRoot}\n`)
  const certPath = join(ownedRoot, 'registry-cert.pem')
  const keyPath = join(ownedRoot, 'registry-key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })

  const registryPort = await freePort()
  const registryConfigPath = join(ownedRoot, 'registry.toml')
  writeFileSync(registryConfigPath, registryConfig(ownedRoot, registryPort, certPath, keyPath))

  // ---- 1. the real registry daemon -------------------------------------------------------
  const registryEnv = {
    [CREDENTIAL_ENV.control]: CREDENTIALS.control,
    [CREDENTIAL_ENV.a]: CREDENTIALS.a,
    [CREDENTIAL_ENV.b]: CREDENTIALS.b,
  }
  const registryStart = runCli(['registry', 'start', '--config', registryConfigPath], registryEnv)
  report.commands.push(`agentteams registry start --config ${registryConfigPath}`)
  process.stdout.write(`registry start: ${registryStart.stdout}\n`)
  assert.equal(registryStart.status, 0, `registry start failed: ${registryStart.stderr}`)
  assert.equal(field(registryStart.stdout, 'state'), 'running')
  registryUrl = field(registryStart.stdout, 'url')
  registryPid = Number(field(registryStart.stdout, 'pid'))
  registryGeneration = Number(field(registryStart.stdout, 'generation'))
  check('real registry daemon is running', `url=${registryUrl} pid=${registryPid} generation=${registryGeneration}`)

  // ---- 2. two real registered agent daemons ----------------------------------------------
  const portA = await freePort()
  const agentAConfigPath = join(ownedRoot, 'agent-a.toml')
  writeFileSync(agentAConfigPath, agentConfig(ownedRoot, AGENT_A, portA, registryPort, CREDENTIAL_ENV.a, certPath))
  agentA = spawnEntry(['--serve', 'opencode', '--ip', '127.0.0.1', '--port', String(portA), '--config', agentAConfigPath],
    { ...registryEnv, TEAMS_PROBE_KEY: 'stub-key' }, 'agent-a')
  const readyA = await agentA.waitForLine(line => line.startsWith('serving ') && line.includes(`agent=${AGENT_A}`), 'agent A readiness')
  assert.match(readyA, /registration=online/, `agent A did not register: ${readyA}`)
  check('real agent A registered with the registry', `${AGENT_A} registration=online`)

  // ---- 3. the real control daemon under test ---------------------------------------------
  const controlPort = await freePort()
  const controlConfigPath = join(ownedRoot, 'control.toml')
  writeFileSync(controlConfigPath, controlConfig(ownedRoot, controlPort, registryPort, certPath))
  const controlStart = runCli(['control', 'start', '--config', controlConfigPath], { ...registryEnv, [PASSWORD_ENV]: PASSWORD })
  report.commands.push(`agentteams control start --config ${controlConfigPath}`)
  process.stdout.write(`control start: ${controlStart.stdout}\n`)
  assert.equal(controlStart.status, 0, `control start failed: ${controlStart.stderr}`)
  assert.equal(field(controlStart.stdout, 'state'), 'running')
  controlUrl = field(controlStart.stdout, 'url')
  controlPid = Number(field(controlStart.stdout, 'pid'))
  controlGeneration = Number(field(controlStart.stdout, 'generation'))
  check('real control daemon is running', `url=${controlUrl} pid=${controlPid} generation=${controlGeneration}`)

  // ---- 4. GET /api/v1/projection returns the real directory rows -------------------------
  const projectionResponse = await fetch(`${controlUrl}/api/v1/projection`, { headers: { authorization: basic } })
  assert.equal(projectionResponse.status, 200, `projection status ${projectionResponse.status}`)
  const projection = await projectionResponse.json()
  report.facts.firstProjection = projection
  process.stdout.write(`projection: ${JSON.stringify(projection)}\n`)
  const agentRows = projection.agents.filter(agent => agent.agentId === AGENT_A)
  assert.equal(agentRows.length, 1, `expected one ${AGENT_A} agent row, got ${JSON.stringify(projection.agents)}`)
  assert.equal(agentRows[0].kind, 'directory')
  assert.equal(agentRows[0].presence, 'online')
  assert.equal(agentRows[0].machineId, `${AGENT_A}-host`)
  assert.ok(Number.isSafeInteger(agentRows[0].generation) && agentRows[0].generation >= 1)
  check('projection carries the real registered agent row', JSON.stringify(agentRows[0]))
  const connectionRows = (projection.connections ?? []).filter(row => row.status.remoteAgentId === AGENT_A)
  assert.equal(connectionRows.length, 1, `expected one ${AGENT_A} connection row, got ${JSON.stringify(projection.connections)}`)
  assert.equal(connectionRows[0].status.state, 'disconnected')
  check('projection carries the same real directory peer as a connection row', JSON.stringify(connectionRows[0]))

  // ---- 5. the SSE stream emits a real frame from the same read ---------------------------
  stream = await openEventStream(`${controlUrl}/api/v1/events`)
  const firstFrame = await stream.waitForFrame(frame => frame.event === 'projection'
    && frame.data.projection.agents.some(agent => agent.agentId === AGENT_A), 'the first real projection frame')
  report.facts.firstFrame = firstFrame
  check('SSE emitted a real projection frame', `seq=${firstFrame.data.seq} agents=${firstFrame.data.projection.agents.map(agent => agent.agentId).join(',')}`)

  // ---- 6. a real directory change advances the SSE seq -----------------------------------
  const portB = await freePort()
  const agentBConfigPath = join(ownedRoot, 'agent-b.toml')
  writeFileSync(agentBConfigPath, agentConfig(ownedRoot, AGENT_B, portB, registryPort, CREDENTIAL_ENV.b, certPath))
  agentB = spawnEntry(['--serve', 'opencode', '--ip', '127.0.0.1', '--port', String(portB), '--config', agentBConfigPath],
    { ...registryEnv, TEAMS_PROBE_KEY: 'stub-key' }, 'agent-b')
  const readyB = await agentB.waitForLine(line => line.startsWith('serving ') && line.includes(`agent=${AGENT_B}`), 'agent B readiness')
  assert.match(readyB, /registration=online/, `agent B did not register: ${readyB}`)
  check('real agent B registered with the registry', `${AGENT_B} registration=online`)

  const changedFrame = await stream.waitForFrame(frame => frame.event === 'projection'
    && frame.data.seq > firstFrame.data.seq
    && frame.data.projection.agents.some(agent => agent.agentId === AGENT_B), 'a changed projection frame')
  report.facts.changedFrame = changedFrame
  assert.ok(changedFrame.data.seq > firstFrame.data.seq)
  check('SSE seq advanced on the real directory change', `seq ${firstFrame.data.seq} -> ${changedFrame.data.seq} agents=${changedFrame.data.projection.agents.map(agent => agent.agentId).join(',')}`)

  // ---- 7. the HTTP read agrees with the streamed change ----------------------------------
  const second = await (await fetch(`${controlUrl}/api/v1/projection`, { headers: { authorization: basic } })).json()
  report.facts.secondProjection = second
  const ids = second.agents.map(agent => agent.agentId).sort()
  assert.deepEqual(ids, [AGENT_A, AGENT_B], `expected both real agents, got ${JSON.stringify(ids)}`)
  assert.ok(second.agents.every(agent => agent.kind === 'directory' && agent.presence === 'online'))
  check('HTTP projection now carries both real registered agents', JSON.stringify(second.agents))
}

async function cleanup() {
  process.stdout.write('\ncleanup\n')
  if (stream !== undefined) await stream.close()
  if (agentA !== undefined) await stopEntry(agentA, 'agent-a')
  if (agentB !== undefined) await stopEntry(agentB, 'agent-b')
  if (controlPid !== undefined) {
    const controlConfigPath = join(ownedRoot, 'control.toml')
    const stopped = runCli(['control', 'stop', '--config', controlConfigPath, '--generation', String(controlGeneration)])
    process.stdout.write(`control stop: ${stopped.stdout}${stopped.stderr === '' ? '' : ` ${stopped.stderr}`}\n`)
    if (pidAlive(controlPid)) { try { process.kill(controlPid, 'SIGTERM') } catch { /* already gone */ } }
    const deadline = Date.now() + 10_000
    while (pidAlive(controlPid) && Date.now() < deadline) await delay(50)
    if (pidAlive(controlPid)) process.stdout.write(`WARN control pid=${controlPid} still alive\n`)
  }
  if (registryPid !== undefined) {
    const registryConfigPath = join(ownedRoot, 'registry.toml')
    const stopped = runCli(['registry', 'stop', '--config', registryConfigPath, '--generation', String(registryGeneration)])
    process.stdout.write(`registry stop: ${stopped.stdout}${stopped.stderr === '' ? '' : ` ${stopped.stderr}`}\n`)
    if (pidAlive(registryPid)) { try { process.kill(registryPid, 'SIGTERM') } catch { /* already gone */ } }
    const deadline = Date.now() + 10_000
    while (pidAlive(registryPid) && Date.now() < deadline) await delay(50)
    if (pidAlive(registryPid)) process.stdout.write(`WARN registry pid=${registryPid} still alive\n`)
  }
  if (controlUrl !== undefined) {
    const controlPort = Number(new URL(controlUrl).port)
    process.stdout.write(`control port ${controlPort} closed: ${await portClosed(controlPort)}\n`)
  }
}

try {
  await main()
  await cleanup()
  report.facts.cleanup = { controlPid, registryPid, agentAPid: agentA?.child.pid, agentBPid: agentB?.child.pid }
  rmSync(ownedRoot, { recursive: true, force: true })
  process.stdout.write(`\nALL ${checks.length} CHECKS PASS\n`)
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(join(REPORT_DIR, 'black-box-control-directory-projection.report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 0
} catch (error) {
  process.stdout.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  await cleanup().catch(() => undefined)
  report.facts.cleanup = { controlPid, registryPid, agentAPid: agentA?.child.pid, agentBPid: agentB?.child.pid }
  report.error = error instanceof Error ? error.message : String(error)
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(join(REPORT_DIR, 'black-box-control-directory-projection.report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`owned temp root kept for forensics: ${ownedRoot}\n`)
  process.exitCode = 1
}
