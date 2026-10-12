#!/usr/bin/env node
/**
 * A11 cross-device receipt producer (two physical hosts).
 *
 * A11 has two halves. The first half ("the LAN address is a real, connectable
 * non-loopback listener") is already proven by
 * `docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs`. The second
 * half ("a genuine cross-device receipt") was a GAP because only one physical
 * host existed. This producer closes that half with a real two-host exchange.
 *
 * Topology (both hosts are physical machines):
 *
 *   HOST A  Mac Studio, this machine. Tailscale IPv4 100.66.1.82.
 *           - runs the project's own producer `pnpm build:governance` and packs
 *             the staged root with `npm pack`;
 *           - runs the discovery registry daemon from the INSTALLED CLI, bound to
 *             HOST A's Tailscale address;
 *           - runs the OpenAI-compatible probe provider the remote engine calls;
 *           - runs the ACP initiator (session/new, prompt, permission callback +
 *             reply, cancel, session/update) against HOST B.
 *
 *   HOST B  jennys-macbook-air.anoa-buri.ts.net, arm64 macOS, Tailscale IPv4
 *           100.93.143.20, user `jenny`.
 *           - receives the packed tarball and installs it into an ISOLATED npm
 *             prefix under HOST B's home;
 *           - starts the agent daemon from the INSTALLED entrypoint, bound to
 *             HOST B's own Tailscale address, with its own config file, identity,
 *             data directory and TLS material generated ON HOST B;
 *           - registers itself with HOST A's registry over the network;
 *           - spawns the real `opencode` engine (copied to HOST B) which calls
 *             the probe provider back on HOST A.
 *
 * The receipt is asserted from BOTH sides:
 *   - HOST A: the resolved peer address is neither loopback nor any HOST A
 *     address, the peer hostname differs from HOST A's hostname, HOST B's own
 *     declared route is read back from HOST A's registry, and the ACP reply
 *     (stopReason end_turn) plus the permission callback are received.
 *   - HOST B: the daemon's own readiness line (agent, listener, daemonPid,
 *     enginePid, capabilitiesRevision, dataDirectory) and the daemon's durable
 *     connection history (`acp-history.json`) show the inbound observer peer and
 *     the negotiated agreement.
 *
 * Cleanup is explicit-PID only on both hosts: no `pkill`, `killall`,
 * `kill $(...)`, `xargs kill` or any pattern kill. Every process this producer
 * starts is stopped by its own recorded PID, or through the project's own
 * `registry stop` entry.
 *
 * Usage:  node docs/evidence/acp-a11-crossdevice-20261011/cross-device-receipt.mjs
 * Env:    A11_SSH_TARGET        ssh alias/host for HOST B (default `jenny`)
 *         A11_HOST_B_TS_IP      HOST B Tailscale IPv4 (default 100.93.143.20)
 *         A11_HOST_B_HOSTNAME   HOST B DNS name (default jennys-macbook-air.anoa-buri.ts.net)
 *         A11_HOST_B_HOME       HOST B home (default /Users/jenny)
 *         A11_HOST_B_NODE_BIN   HOST B node bin dir
 *         A11_HOST_B_PREFIX     HOST B isolated install root
 *         A11_HOST_B_OPENCODE   HOST B opencode executable
 *         A11_KEEP_HOST_B       `1` keeps the HOST B install root (default 1)
 *         A11_PROBE_LLM         `1` uses a real provider instead of the probe
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import { lookup } from 'node:dns/promises'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ---------------------------------------------------------------------------------------
 * Operator knobs
 * ------------------------------------------------------------------------------------- */

const SSH_TARGET = process.env.A11_SSH_TARGET ?? 'jenny'
const HOST_B_TS_IP = process.env.A11_HOST_B_TS_IP ?? '100.93.143.20'
const HOST_B_HOSTNAME = process.env.A11_HOST_B_HOSTNAME ?? 'jennys-macbook-air.anoa-buri.ts.net'
const HOST_B_HOME = process.env.A11_HOST_B_HOME ?? '/Users/jenny'
const HOST_B_NODE_BIN = process.env.A11_HOST_B_NODE_BIN ?? `${HOST_B_HOME}/.agentteams-node/node-v22.22.2-darwin-arm64/bin`
const HOST_B_PREFIX = process.env.A11_HOST_B_PREFIX ?? `${HOST_B_HOME}/.agentteams-a11/acp-a11-crossdevice-20261011`
const HOST_B_OPENCODE = process.env.A11_HOST_B_OPENCODE ?? `${HOST_B_HOME}/.agentteams-a11/engine/bin/opencode`
const KEEP_HOST_B = (process.env.A11_KEEP_HOST_B ?? '1') === '1'

const ACCOUNT = 'local'
const SCOPE = 'local'
const REGISTRY_ID = 'a11-registry'
const HOST_B_AGENT_ID = 'reasoner-b'
const HOST_B_HOST_ID = 'host-b-macbook-air'
const OBSERVER = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'observer' }
const TARGET_GENERATION = 1
const ACP_CAPABILITIES = ['method:session/new', 'method:session/prompt', 'callback:session/request_permission']

/** Deterministic shape, per-run random value. Never printed in full. */
const token = () => `Bearer a11-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
const CREDENTIALS = { b: token(), observer: token(), probe: `a11-probe-${Math.random().toString(36).slice(2, 10)}` }

const evidenceRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(evidenceRoot, '..', '..', '..')
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15']

/* ---------------------------------------------------------------------------------------
 * Reporting
 * ------------------------------------------------------------------------------------- */

const checks = []
const gaps = []
let step = 'startup'

function check(name, detail) {
  checks.push({ name, detail, ok: true })
  process.stdout.write(`PASS ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}
function gap(name, reason) {
  gaps.push({ name, reason })
  process.stdout.write(`GAP ${name} — ${reason}\n`)
}
function note(message) { process.stdout.write(`  -- ${message}\n`) }
function assert(condition, message) {
  if (!condition) throw new Error(`A11 cross-device FAIL [${step}]: ${message}`)
}
function redact(value) {
  if (typeof value !== 'string') return value
  let out = value
  for (const secret of Object.values(CREDENTIALS)) out = out.split(secret).join('<redacted-credential>')
  return out
}

/* ---------------------------------------------------------------------------------------
 * Process / ssh helpers
 * ------------------------------------------------------------------------------------- */

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Explicit-PID stop. The only kill path this producer has. */
function stopByExplicitPid(pid, signal = 'SIGTERM') {
  if (!pidAlive(pid)) return false
  try { process.kill(pid, signal); return true } catch { return false }
}

function runLocal(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options })
}

/** Run one command on HOST B. `input` is written to the remote stdin. */
function sshB(command, options = {}) {
  return spawnSync('ssh', [...SSH_OPTS, SSH_TARGET, command], {
    encoding: 'utf8', timeout: options.timeoutMs ?? 120_000, input: options.input, maxBuffer: 128 * 1024 * 1024,
  })
}

/** Run one command on HOST B and require success, returning stdout. */
function sshBOrFail(command, label, options = {}) {
  const result = sshB(command, options)
  assert(result.status === 0, `${label} on HOST B exited ${result.status}: ${redact(`${result.stdout ?? ''}${result.stderr ?? ''}`).slice(-800)}`)
  return result.stdout ?? ''
}

function scpToHostB(localPath, remotePath) {
  const result = spawnSync('scp', [...SSH_OPTS, '-q', localPath, `${SSH_TARGET}:${remotePath}`], { encoding: 'utf8', timeout: 900_000 })
  assert(result.status === 0, `scp ${localPath} -> HOST B:${remotePath} exited ${result.status}: ${redact(result.stderr ?? '').slice(-400)}`)
}

/** A file on HOST B with an exact content and mode, written over ssh stdin (never argv). */
function writeHostBFile(remotePath, content, mode = 0o600) {
  const directory = remotePath.slice(0, remotePath.lastIndexOf('/'))
  sshBOrFail(`mkdir -p ${shellQuote(directory)} && cat > ${shellQuote(remotePath)} && chmod ${mode.toString(8)} ${shellQuote(remotePath)}`, `write ${remotePath}`, { input: content })
}

function shellQuote(value) { return `'${String(value).split("'").join(`'\\''`)}'` }

async function withDeadline(promise, label, timeoutMs = 120_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectDeadline) => { timer = setTimeout(() => rejectDeadline(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

async function settle(label, predicate, intervalMs = 200, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await predicate()) return true } catch { /* a transient poll failure is not an observation */ }
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  return false
}

/** Values may contain spaces, so split on `key=` boundaries (same rule the D08 driver uses). */
function parseFields(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) fields[match[1]] = match[2].trim()
  return fields
}

function localAddresses() {
  const addresses = new Set()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address)
  }
  return addresses
}

function tailscaleIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address.startsWith('100.')) return entry.address
    }
  }
  return undefined
}

async function freePort(ip) {
  const listener = createNetServer()
  await new Promise((resolveListen, rejectListen) => {
    listener.once('error', rejectListen)
    listener.listen(0, ip, () => resolveListen())
  })
  const port = listener.address().port
  await new Promise(resolveClose => listener.close(() => resolveClose()))
  return port
}

/* ---------------------------------------------------------------------------------------
 * The probe provider (HOST A side), same stateless behaviour the D08 driver proved
 * ------------------------------------------------------------------------------------- */

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

function startProbeProvider(ip) {
  const calls = []
  const server = createHttpServer((request, response) => {
    response.on('error', () => undefined)
    request.on('error', () => undefined)
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '').filter(name => name.length > 0)
      const text = lastUserText(parsed)
      calls.push({ model: parsed.model ?? '', toolNames, text, at: new Date().toISOString() })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-a11', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-a11', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-a11', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'A11-PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (text.includes('SLOW-CANCEL')) {
        response.write(chunk({ role: 'assistant', content: 'PROBE-START' }))
        setTimeout(() => {
          if (response.destroyed || response.writableEnded) return
          try { response.write(chunk({ content: 'PROBE-LATE' })); response.write(finish); response.end('data: [DONE]\n\n') } catch { /* the client already cancelled */ }
        }, 30_000)
        return
      }
      if (toolNames.length === 0) {
        response.write(chunk({ role: 'assistant', content: 'title' }))
        response.write(finish); response.end('data: [DONE]\n\n'); return
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const toolResults = messages.filter(message => message?.role === 'tool').length
      if (toolResults > 0) {
        response.write(chunk({ role: 'assistant', content: 'PROBE-TOOL-DONE' }))
        response.write(finish); response.end('data: [DONE]\n\n'); return
      }
      response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_a11_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/etc/hosts' }) } }] }))
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-a11', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart)
    server.listen(0, ip, () => resolveStart({
      baseUrl: `http://${ip}:${server.address().port}/v1`,
      port: server.address().port,
      calls,
      close: () => new Promise(resolveClose => { server.closeAllConnections?.(); server.close(() => resolveClose()) }),
    }))
  })
}

/* ---------------------------------------------------------------------------------------
 * Wire helpers (the D08 initiator pattern, copied into this producer)
 * ------------------------------------------------------------------------------------- */

function openChannel({ target, peer, requestedRole, requestedPeerRole, connectionId }) {
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
  return { frames, transport, requestedRole, requestedPeerRole, connectionId }
}

/* ---------------------------------------------------------------------------------------
 * Owned temp root on HOST A
 * ------------------------------------------------------------------------------------- */

const ownedRoot = mkdtempSync(join(tmpdir(), 'a11-xdev-'))
const cliLogDir = join(ownedRoot, 'cli-logs')
const packDir = join(ownedRoot, 'pack')
const tlsDir = join(ownedRoot, 'tls')
for (const directory of [cliLogDir, packDir, tlsDir]) mkdirSync(directory, { recursive: true })

const live = {
  probe: undefined,
  observerClient: undefined,
  targets: [],
  registry: { pid: undefined, configPath: undefined, stopped: false },
  hostB: { pid: undefined, enginePid: undefined, started: false, stopped: false, prefix: HOST_B_PREFIX },
}
const operatorEnv = {}
let CLI
let CLI_ROOT
let installedRoot
const installed = {}

function runCliLogged(args, env = {}, timeoutMs = 120_000) {
  const logPath = join(cliLogDir, `cli-${Date.now()}.log`)
  const fd = openSync(logPath, 'a')
  try {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: CLI_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout: timeoutMs,
    })
    return { status: result.status, signal: result.signal, output: readFileSync(logPath, 'utf8') }
  } finally { closeSync(fd) }
}

/* ---------------------------------------------------------------------------------------
 * Steps
 * ------------------------------------------------------------------------------------- */

async function stageAndInstallOnHostA() {
  step = 'artifact staging'
  // The project's producer refuses a candidate with untracked or unstaged product
  // paths. This producer is a new evidence file, so it stages its OWN evidence
  // directory and never any other path. It never commits, resets or stashes.
  const relativeEvidenceDirectory = evidenceRoot.slice(repositoryRoot.length + 1)
  const untracked = runLocal('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repositoryRoot }).stdout
    .split('\n').map(path => path.trim()).filter(path => path.length > 0)
  const modified = runLocal('git', ['diff', '--name-only'], { cwd: repositoryRoot }).stdout
    .split('\n').map(path => path.trim()).filter(path => path.length > 0)
  const isOwn = path => path.startsWith(`${relativeEvidenceDirectory}/`)
  const foreign = [...untracked, ...modified].filter(path => !isOwn(path))
  assert(foreign.length === 0, `this worktree has untracked or unstaged product paths outside this producer's own evidence directory: ${foreign.join(', ')}`)
  const toStage = [...untracked, ...modified].filter(isOwn)
  if (toStage.length > 0) {
    const staged = runLocal('git', ['add', '--', ...toStage], { cwd: repositoryRoot })
    assert(staged.status === 0, `git add of this producer's own evidence files failed: ${staged.stderr}`)
    note(`staged this producer's own evidence files for the package identity gate: ${toStage.join(', ')}`)
  }

  note('running the project producer: pnpm build:governance')
  const buildLog = join(cliLogDir, 'build-governance.log')
  const buildFd = openSync(buildLog, 'a')
  let build
  try {
    build = spawnSync('pnpm', ['build:governance'], { cwd: repositoryRoot, env: process.env, stdio: ['ignore', buildFd, buildFd], timeout: 1_800_000 })
  } finally { closeSync(buildFd) }
  const buildOutput = readFileSync(buildLog, 'utf8')
  assert(build.status === 0, `pnpm build:governance exited ${build.status}: ${buildOutput.slice(-1200)}`)
  const producerTail = buildOutput.trim().split('\n').slice(-1)[0]
  assert(/package artifact final agentteams@/.test(buildOutput), `the producer did not report a final package: ${buildOutput.slice(-600)}`)

  const packRoot = join(repositoryRoot, 'generated', 'modules', 'teams-source', 'lib')
  const receiptPath = join(repositoryRoot, 'generated', 'modules', 'teams-source', 'package-receipt.json')
  assert(existsSync(join(packRoot, 'package.json')), `staged package root is missing: ${packRoot}`)
  assert(existsSync(receiptPath), `package receipt is missing: ${receiptPath}`)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  assert(receipt.mode === 'final', `staged package mode is ${receipt.mode}, expected final`)
  assert(existsSync(join(packRoot, 'generated', 'runtime-lib', 'runtime', 'acp-serve.js')), 'the staged package is missing the compiled ACP serve runtime')
  assert(existsSync(join(packRoot, 'generated', 'runtime-lib', 'network', 'direct-route.js')), 'the staged package is missing the compiled direct-route runtime')
  check('producer — pnpm build:governance staged a final package on HOST A',
    `mode=${receipt.mode} version=${receipt.version} content=${receipt.content_sha256.slice(0, 16)}… files=${receipt.files.length}`)
  note(`producer tail: ${producerTail}`)

  step = 'npm pack'
  const pack = runLocal('npm', ['pack', packRoot, '--pack-destination', packDir, '--json'], { timeout: 300_000 })
  assert(pack.status === 0, `npm pack failed: ${pack.stderr || pack.stdout}`)
  const packed = JSON.parse(pack.stdout)
  assert(Array.isArray(packed) && packed.length === 1 && typeof packed[0].filename === 'string', `npm pack reported no tarball: ${pack.stdout.slice(0, 300)}`)
  const tarball = join(packDir, packed[0].filename)
  assert(existsSync(tarball), `packed tarball is missing: ${tarball}`)
  const tarballSha = runLocal('shasum', ['-a', '256', tarball]).stdout.trim().split(/\s+/)[0]
  check('producer — the staged root packs into one tarball',
    `${packed[0].filename} bytes=${packed[0].size} sha256=${tarballSha.slice(0, 16)}…`)

  step = 'HOST A isolated install'
  const prefixRoot = join(ownedRoot, 'prefix')
  mkdirSync(prefixRoot, { recursive: true })
  const install = runLocal('npm', ['install', '--prefix', prefixRoot, '--no-audit', '--no-fund', '--no-package-lock', '--no-save', tarball], { timeout: 900_000 })
  assert(install.status === 0, `npm install of the packed tarball failed: ${install.stderr || install.stdout}`)
  installedRoot = join(prefixRoot, 'node_modules', 'agentteams')
  CLI = join(installedRoot, 'cli', 'agentteams.mjs')
  CLI_ROOT = installedRoot
  assert(existsSync(CLI), `installed CLI is missing: ${CLI}`)
  assert(realpathSync(CLI) !== realpathSync(join(repositoryRoot, 'cli', 'agentteams.mjs')), 'the producer resolved the worktree CLI instead of the installed copy')
  const networkRoot = join(installedRoot, 'generated', 'runtime-lib', 'network')
  installed.negotiation = await import(pathToFileURL(join(networkRoot, 'teams-negotiation.js')).href)
  installed.routePlan = await import(pathToFileURL(join(networkRoot, 'route-plan.js')).href)
  installed.directRoute = await import(pathToFileURL(join(networkRoot, 'direct-route.js')).href)
  installed.registration = await import(pathToFileURL(join(networkRoot, 'registration-client.js')).href)
  check('producer — the tarball installs into an isolated prefix on HOST A and exposes the compiled runtime',
    `cli=${realpathSync(CLI)} modules=${Object.keys(installed).join(',')}`)
  return { tarball, tarballSha, filename: packed[0].filename, receipt }
}

function provisionHostB(tarball) {
  step = 'HOST B install'
  // Every destructive path on HOST B is checked against the producer's own prefix
  // before it is used, so a computed path can never reach a foreign directory.
  assert(HOST_B_PREFIX.startsWith(`${HOST_B_HOME}/.agentteams-a11/`), `refusing to use a HOST B prefix outside this producer's own root: ${HOST_B_PREFIX}`)
  sshBOrFail(`mkdir -p ${shellQuote(`${HOST_B_PREFIX}/pack`)} ${shellQuote(`${HOST_B_PREFIX}/run`)} ${shellQuote(`${HOST_B_PREFIX}/tls`)}`, 'create the HOST B prefix')
  // A fresh daemon state per run: the previous run's durable history must never
  // be mistaken for this run's inbound peer evidence.
  sshBOrFail(`rm -rf ${shellQuote(`${HOST_B_PREFIX}/state`)} ${shellQuote(`${HOST_B_PREFIX}/workspace`)} ${shellQuote(`${HOST_B_PREFIX}/run/agent.log`)} ${shellQuote(`${HOST_B_PREFIX}/run/agent.pid`)}`, 'clear the previous HOST B run state')
  const remoteTarball = `${HOST_B_PREFIX}/pack/${tarball.split('/').pop()}`
  scpToHostB(tarball, remoteTarball)
  const remoteSha = sshBOrFail(`shasum -a 256 ${shellQuote(remoteTarball)}`, 'hash the copied tarball').trim().split(/\s+/)[0]
  return { remoteTarball, remoteSha }
}

async function main() {
  const hostA = osHostname()
  const hostATs = tailscaleIpv4()
  assert(hostATs !== undefined, 'HOST A has no Tailscale IPv4 address (100.x); the two-host receipt cannot run')
  const ownAddresses = localAddresses()
  note(`HOST A hostname=${hostA} tailscale=${hostATs}`)

  step = 'HOST B preconditions'
  const hostBProbe = sshBOrFail(
    `hostname; sw_vers -productVersion; uname -m; export PATH=${shellQuote(HOST_B_NODE_BIN)}:"$PATH"; node --version; npm --version; ls -l ${shellQuote(HOST_B_OPENCODE)}`,
    'probe HOST B')
  const [hostBName, hostBVersion, hostBArch, hostBNode, hostBNpm] = hostBProbe.trim().split('\n')
  assert(hostBName !== hostA, `HOST B reports the same hostname as HOST A (${hostBName}); this is not a cross-device run`)
  assert(/^v\d+\./.test(hostBNode), `HOST B node did not report a version (${hostBNode})`)
  check('preconditions — two distinct physical hosts',
    `HOST A ${hostA} (${hostATs}) vs HOST B ${hostBName} (${HOST_B_TS_IP}), macOS ${hostBVersion} ${hostBArch}, node ${hostBNode}, npm ${hostBNpm}`)

  const staged = await stageAndInstallOnHostA()
  const provisioned = provisionHostB(staged.tarball)
  assert(provisioned.remoteSha === staged.tarballSha, `the tarball changed in transit (${staged.tarballSha} != ${provisioned.remoteSha})`)

  step = 'HOST B isolated install'
  const hostBInstallCommand = `export PATH="${HOST_B_NODE_BIN}:$PATH"; npm install --prefix ${HOST_B_PREFIX}/prefix --no-audit --no-fund --no-package-lock --no-save ${provisioned.remoteTarball}`
  const hostBInstall = sshB(hostBInstallCommand, { timeoutMs: 900_000 })
  assert(hostBInstall.status === 0, `the HOST B npm install exited ${hostBInstall.status}: ${redact(`${hostBInstall.stdout}${hostBInstall.stderr}`).slice(-800)}`)
  const hostBInstallOutput = redact(`${hostBInstall.stdout ?? ''}${hostBInstall.stderr ?? ''}`).trim()
  const hostBCli = `${HOST_B_PREFIX}/prefix/node_modules/agentteams/cli/agentteams.mjs`
  const hostBCliCheck = sshBOrFail(`ls -l ${shellQuote(hostBCli)}; shasum -a 256 ${shellQuote(hostBCli)}`, 'verify the installed CLI on HOST B')
  const hostBCliSha = hostBCliCheck.trim().split('\n').at(-1).trim().split(/\s+/)[0]
  // The staged `package-receipt.json` sits outside the packed root, so it travels
  // beside the tarball; the installed CLI bytes are compared host to host instead.
  scpToHostB(join(repositoryRoot, 'generated', 'modules', 'teams-source', 'package-receipt.json'), `${HOST_B_PREFIX}/pack/package-receipt.json`)
  const hostBReceipt = JSON.parse(sshBOrFail(`cat ${shellQuote(`${HOST_B_PREFIX}/pack/package-receipt.json`)}`, 'read the copied package receipt'))
  const hostACliSha = runLocal('shasum', ['-a', '256', CLI]).stdout.trim().split(/\s+/)[0]
  assert(hostBReceipt.content_sha256 === staged.receipt.content_sha256,
    `the HOST B copy of the package receipt differs from HOST A's staged receipt (${hostBReceipt.content_sha256} != ${staged.receipt.content_sha256})`)
  assert(hostBCliSha === hostACliSha,
    `the installed CLI differs between the hosts (HOST A ${hostACliSha} != HOST B ${hostBCliSha})`)
  check('HOST B — the packed tarball installs into an isolated prefix and the installed CLI is byte-identical to HOST A\'s',
    `prefix=${HOST_B_PREFIX}/prefix content=${hostBReceipt.content_sha256.slice(0, 16)}… cliSha256=${hostBCliSha.slice(0, 16)}… cli=${hostBCli}`)
  note(`install command: ${hostBInstallCommand}`)
  note(`install output: ${hostBInstallOutput.split('\n').slice(-3).join(' | ')}`)
  note(`installed CLI: ${hostBCliCheck.trim().split('\n')[0]}`)

  /* -----------------------------------------------------------------------------------
   * TLS: the agent material is generated ON HOST B so its private key never leaves B.
   * --------------------------------------------------------------------------------- */
  step = 'TLS'
  const agentTlsDir = `${HOST_B_PREFIX}/tls`
  const agentTlsCommand = [
    `cd ${shellQuote(agentTlsDir)}`,
    `&& openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=${HOST_B_HOSTNAME}`,
    `-addext "subjectAltName=IP:${HOST_B_TS_IP},DNS:${HOST_B_HOSTNAME},DNS:localhost,IP:127.0.0.1"`,
    `-keyout agent-key.pem -out agent-cert.pem > /dev/null 2>&1`,
    `&& chmod 600 agent-key.pem && ls -l agent-cert.pem agent-key.pem`,
  ].join(' ')
  sshBOrFail(agentTlsCommand, 'generate HOST B agent TLS material')
  const agentCertPath = join(tlsDir, 'agent-cert.pem')
  const fetched = spawnSync('scp', [...SSH_OPTS, '-q', `${SSH_TARGET}:${agentTlsDir}/agent-cert.pem`, agentCertPath], { encoding: 'utf8', timeout: 60_000 })
  assert(fetched.status === 0, `fetching HOST B's agent certificate failed: ${fetched.stderr}`)
  const agentCert = readFileSync(agentCertPath)
  // LibreSSL (the macOS system openssl) has no `-ext`, so the SAN is read from `-text`.
  const sanReadback = sshBOrFail(
    `openssl x509 -in ${shellQuote(`${agentTlsDir}/agent-cert.pem`)} -noout -subject -text | grep -A1 "Subject Alternative Name" | tr -s " "`,
    'read HOST B certificate SAN')
  assert(sanReadback.includes(HOST_B_TS_IP) && sanReadback.includes(HOST_B_HOSTNAME),
    `the HOST B certificate does not carry HOST B's own names: ${sanReadback.trim()}`)
  check('TLS — the HOST B listener certificate is generated on HOST B and carries HOST B\'s own names',
    sanReadback.trim().split('\n').join(' ').slice(0, 200))

  const registryTls = { keyPath: join(tlsDir, 'registry-key.pem'), certPath: join(tlsDir, 'registry-cert.pem') }
  const opensslRegistry = runLocal('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${hostATs}`, '-addext', `subjectAltName=IP:${hostATs},DNS:localhost,IP:127.0.0.1`,
    '-keyout', registryTls.keyPath, '-out', registryTls.certPath])
  assert(opensslRegistry.status === 0, `registry TLS generation failed: ${opensslRegistry.stderr}`)
  const registryCert = readFileSync(registryTls.certPath)
  writeHostBFile(`${HOST_B_PREFIX}/run/registry-cert.pem`, registryCert.toString('utf8'), 0o644)
  const hostBRegistryCertSha = sshBOrFail(`shasum -a 256 ${shellQuote(`${HOST_B_PREFIX}/run/registry-cert.pem`)}`, 'hash the registry certificate on HOST B').trim().split(/\s+/)[0]
  const hostARegistryCertSha = runLocal('shasum', ['-a', '256', registryTls.certPath]).stdout.trim().split(/\s+/)[0]
  assert(hostBRegistryCertSha === hostARegistryCertSha, 'the registry trust certificate changed in transit')
  check('TLS — the HOST B daemon trusts the HOST A registry certificate byte-identically',
    `sha256=${hostARegistryCertSha.slice(0, 16)}…`)

  /* -----------------------------------------------------------------------------------
   * Configs
   * --------------------------------------------------------------------------------- */
  step = 'configs'
  const registryPort = await freePort(hostATs)
  const agentPort = Number(sshBOrFail(
    `export PATH=${shellQuote(HOST_B_NODE_BIN)}:"$PATH"; node -e "const n=require('node:net');const s=n.createServer();s.listen(0,'${HOST_B_TS_IP}',()=>{console.log(s.address().port);s.close()})"`,
    'pick a free port on HOST B'))
  assert(Number.isInteger(agentPort) && agentPort > 0, `HOST B returned no free port (${agentPort})`)

  const admission = (ref, agentId, envName) => `
[[admissions]]
admissionRef = ${JSON.stringify(ref)}
agentId = ${JSON.stringify(agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:${envName}"
`
  const registryConfigPath = join(ownedRoot, 'registry.toml')
  const registryDataDirectory = join(ownedRoot, 'registry-state')
  writeFileSync(registryConfigPath, `version = 4

[daemon]
kind = "registry"
id = ${JSON.stringify(REGISTRY_ID)}
hostId = "host-a-mac-studio"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(registryDataDirectory)}

[listen]
ip = ${JSON.stringify(hostATs)}
port = ${registryPort}
tlsCertRef = "file:${registryTls.certPath}"
tlsKeyRef = "file:${registryTls.keyPath}"
${admission('adm-b', HOST_B_AGENT_ID, 'A11_CRED_B')}${admission('adm-observer', OBSERVER.agentId, 'A11_CRED_OBSERVER')}`)

  const probeProvider = live.probe
  const hostBAgentConfig = `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(HOST_B_AGENT_ID)}
hostId = ${JSON.stringify(HOST_B_HOST_ID)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(`${HOST_B_PREFIX}/state`)}

[engine]
kind = "opencode"
executable = ${JSON.stringify(HOST_B_OPENCODE)}
workspace = ${JSON.stringify(`${HOST_B_PREFIX}/workspace`)}

[listen]
ip = ${JSON.stringify(HOST_B_TS_IP)}
port = ${agentPort}
tlsCertRef = "file:${agentTlsDir}/agent-cert.pem"
tlsKeyRef = "file:${agentTlsDir}/agent-key.pem"

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[relations]
allowed = ["master", "peer"]
${admission('adm-observer', OBSERVER.agentId, 'A11_CRED_OBSERVER')}
[discovery]
serverId = ${JSON.stringify(REGISTRY_ID)}
endpoint = ${JSON.stringify(`wss://${hostATs}:${registryPort}`)}
credentialRef = "env:A11_CRED_B"
tlsTrustRef = "file:${HOST_B_PREFIX}/run/registry-cert.pem"

[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(probeProvider.baseUrl)}
label = "A11 cross-device probe provider"
enabled = true
credentialEnv = "A11_PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`
  writeHostBFile(`${HOST_B_PREFIX}/run/agent.toml`, hostBAgentConfig, 0o600)
  const hostBConfigSha = sshBOrFail(`shasum -a 256 ${shellQuote(`${HOST_B_PREFIX}/run/agent.toml`)}`, 'hash the HOST B agent config').trim().split(/\s+/)[0]
  check('configs — HOST B owns its own config file, identity, data directory and listener',
    `agent=${HOST_B_AGENT_ID} listener=${HOST_B_TS_IP}:${agentPort} data=${HOST_B_PREFIX}/state discovery=wss://${hostATs}:${registryPort} sha256=${hostBConfigSha.slice(0, 16)}…`)
  note(`probe provider (HOST A) base URL reachable from HOST B: ${probeProvider.baseUrl}`)

  /* -----------------------------------------------------------------------------------
   * Start HOST A registry through the INSTALLED CLI
   * --------------------------------------------------------------------------------- */
  step = 'HOST A registry start'
  const registryStart = runCliLogged(['registry', 'start', '--config', registryConfigPath], {
    A11_CRED_B: CREDENTIALS.b, A11_CRED_OBSERVER: CREDENTIALS.observer,
  })
  const registryLine = registryStart.output.trim().split('\n').filter(Boolean).at(-1) ?? ''
  assert(registryStart.status === 0, `registry start exited ${registryStart.status}: ${registryStart.output.slice(-400)}`)
  const registryFields = parseFields(registryLine)
  assert(registryFields.state === 'running', `the registry did not report running: ${registryLine.slice(0, 200)}`)
  live.registry.pid = Number(registryFields.pid)
  live.registry.configPath = registryConfigPath
  assert(pidAlive(live.registry.pid), `the registry pid ${live.registry.pid} is not alive`)
  check('HOST A — the discovery registry runs from the INSTALLED CLI on HOST A\'s Tailscale address',
    `${registryLine.replace(/\s+/g, ' ').slice(0, 200)}`)

  /* -----------------------------------------------------------------------------------
   * Start the HOST B agent daemon from the INSTALLED entrypoint, by explicit PID
   * --------------------------------------------------------------------------------- */
  step = 'HOST B agent start'
  const startScript = `#!/bin/sh
set -e
export PATH=${shellQuote(HOST_B_NODE_BIN)}:"$PATH"
export A11_CRED_OBSERVER=${shellQuote(CREDENTIALS.observer)}
export A11_CRED_B=${shellQuote(CREDENTIALS.b)}
export A11_PROBE_API_KEY=${shellQuote(CREDENTIALS.probe)}
cd ${shellQuote(HOST_B_PREFIX)}
exec node ${shellQuote(hostBCli)} --serve opencode --ip ${HOST_B_TS_IP} --port ${agentPort} --config ${shellQuote(`${HOST_B_PREFIX}/run/agent.toml`)}
`
  writeHostBFile(`${HOST_B_PREFIX}/run/start-agent.sh`, startScript, 0o700)
  const hostBStartCommand = `sh ${shellQuote(`${HOST_B_PREFIX}/run/start-agent.sh`)} > ${shellQuote(`${HOST_B_PREFIX}/run/agent.log`)} 2>&1 < /dev/null & echo $! > ${shellQuote(`${HOST_B_PREFIX}/run/agent.pid`)}; cat ${shellQuote(`${HOST_B_PREFIX}/run/agent.pid`)}`
  const started = sshB(hostBStartCommand, { timeoutMs: 60_000 })
  assert(started.status === 0, `starting the HOST B daemon exited ${started.status}: ${started.stderr}`)
  live.hostB.pid = Number((started.stdout ?? '').trim())
  live.hostB.started = true
  assert(Number.isInteger(live.hostB.pid) && live.hostB.pid > 0, `HOST B reported no daemon pid (${started.stdout})`)
  note(`HOST B daemon pid file: ${live.hostB.pid}`)

  const readiness = await (async () => {
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const log = sshB(`cat ${shellQuote(`${HOST_B_PREFIX}/run/agent.log`)}`).stdout ?? ''
      const line = log.split('\n').find(candidate => candidate.startsWith('serving '))
      if (line !== undefined) return line
      if (/^stopped /m.test(log)) throw new Error(`the HOST B daemon stopped before readiness:\n${redact(log).slice(-1500)}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
    }
    const log = sshB(`cat ${shellQuote(`${HOST_B_PREFIX}/run/agent.log`)}`).stdout ?? ''
    throw new Error(`the HOST B daemon never printed a readiness line:\n${redact(log).slice(-1500)}`)
  })()
  const fieldsB = parseFields(readiness)
  live.hostB.enginePid = Number(fieldsB.enginePid)
  assert(Number(fieldsB.daemonPid) === live.hostB.pid, `the HOST B readiness daemonPid ${fieldsB.daemonPid} differs from the recorded pid ${live.hostB.pid}`)
  assert(fieldsB.listener === `${HOST_B_TS_IP}:${agentPort}`, `the HOST B daemon bound ${fieldsB.listener}, expected ${HOST_B_TS_IP}:${agentPort}`)
  check('HOST B — the daemon starts from the INSTALLED entrypoint on HOST B\'s own Tailscale address',
    redact(readiness).replace(/\s+/g, ' ').slice(0, 320))
  check('HOST B — the daemon spawned the real opencode engine as its own child',
    `enginePid=${fieldsB.enginePid} model=${fieldsB.model} modelVerification=${fieldsB.modelVerification}`)

  const registrationOnline = await settle('the HOST B daemon to register with the HOST A registry', async () => {
    const log = sshB(`cat ${shellQuote(`${HOST_B_PREFIX}/run/agent.log`)}`).stdout ?? ''
    return fieldsB.registration === 'online' || /^registration state=online/m.test(log)
  }, 1_000, 90_000)
  assert(registrationOnline, `the HOST B daemon never reached registration=online (readiness said ${fieldsB.registration})`)
  check('cross-device — the HOST B daemon registers with the HOST A registry over the network',
    `readiness registration=${fieldsB.registration}; discovery=wss://${hostATs}:${registryPort}`)

  /* -----------------------------------------------------------------------------------
   * HOST A: read HOST B's own published route out of HOST A's registry directory
   * --------------------------------------------------------------------------------- */
  step = 'HOST A directory readback'
  const declarationFor = agentId => ({
    identity: { hostId: 'host-observer', machineId: 'host-observer', agentId, accountId: ACCOUNT, agentKind: 'acp', label: 'A11 cross-device observer' },
    scopeId: SCOPE, revision: 1, capabilities: [], routes: [],
  })
  const observerClient = installed.registration.createRegistrationClient({
    declaration: declarationFor(OBSERVER.agentId),
    endpoint: `wss://${hostATs}:${registryPort}`,
    credential: CREDENTIALS.observer,
    ca: registryCert,
    heartbeatIntervalMs: 5_000,
    admissionTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    maxPendingRequests: 16,
    maxDataConnections: 8,
    connectTimeoutMs: 5_000,
    maxMessageBytes: 262_144,
    maxBufferedBytes: 262_144,
    maxPendingFrames: 64,
    reconnect: { initialDelayMs: 500, maxDelayMs: 5_000, maxAttempts: 40 },
  })
  live.observerClient = observerClient
  const observerStatus = await withDeadline(observerClient.start(), 'observer registration')
  assert(observerStatus.state === 'online', `the HOST A observer registered (${observerStatus.state})`)
  const directoryRead = await settle('the directory to list the HOST B agent', async () => {
    const directory = await withDeadline(observerClient.directory(true), 'directory read')
    return directory.some(peer => peer.declaration.identity.agentId === HOST_B_AGENT_ID && peer.presence === 'online')
  }, 500, 60_000)
  assert(directoryRead, 'the HOST A registry never listed the HOST B agent as online')
  const directory = await withDeadline(observerClient.directory(true), 'directory read')
  const peerB = directory.find(peer => peer.declaration.identity.agentId === HOST_B_AGENT_ID)
  const routeB = (peerB.declaration.routes ?? []).find(candidate => candidate.kind === 'lan')
  assert(routeB?.endpoint === `wss://${HOST_B_TS_IP}:${agentPort}`,
    `HOST B published ${routeB?.endpoint}, expected wss://${HOST_B_TS_IP}:${agentPort}`)
  assert(String(peerB.declaration.revision) === String(fieldsB.capabilitiesRevision),
    `HOST B's readiness capabilitiesRevision ${fieldsB.capabilitiesRevision} differs from its published directory revision ${peerB.declaration.revision}`)
  check('HOST A — HOST A\'s registry lists HOST B as an online peer with HOST B\'s own declared Tailscale route',
    `agent=${HOST_B_AGENT_ID} presence=${peerB.presence} route=${routeB.endpoint} revision=${peerB.declaration.revision}`)

  /* -----------------------------------------------------------------------------------
   * HOST A -> HOST B direct WSS: resolve, prove remote, negotiate, exchange ACP
   * --------------------------------------------------------------------------------- */
  step = 'HOST A -> HOST B connect'
  const resolved = await lookup(HOST_B_HOSTNAME, { all: true })
  const resolvedV4 = resolved.filter(entry => entry.family === 4).map(entry => entry.address)
  note(`HOST B hostname ${HOST_B_HOSTNAME} resolved on HOST A to ${resolvedV4.join(',')}`)
  assert(resolvedV4.includes(HOST_B_TS_IP), `HOST B's hostname did not resolve to ${HOST_B_TS_IP} (${resolvedV4.join(',')})`)
  assert(HOST_B_HOSTNAME !== hostA, `the peer hostname equals HOST A's hostname (${hostA})`)

  const endpoint = `wss://${HOST_B_HOSTNAME}:${agentPort}`
  const remoteCheck = (() => {
    const target = resolvedV4[0]
    const loopback = target.startsWith('127.') || target === '::1'
    const own = ownAddresses.has(target)
    const differentHost = HOST_B_HOSTNAME !== hostA
    return { target, loopback, own, differentHost, ok: !loopback && !own && differentHost }
  })()
  assert(!remoteCheck.loopback, `the peer address ${remoteCheck.target} is loopback`)
  assert(!remoteCheck.own, `the peer address ${remoteCheck.target} is one of HOST A's own addresses`)
  assert(remoteCheck.differentHost, 'the peer hostname is HOST A itself')
  check('HOST A — the peer address is neither loopback nor any HOST A address, and the hostname is a different host',
    `hostname=${HOST_B_HOSTNAME} resolved=${remoteCheck.target} loopback=false own=false hostA=${hostA}`)

  const routePlanFor = port => installed.routePlan.buildDirectWssRoutePlan({
    hostId: 'host-a-mac-studio', directoryGeneration: 1, policy: 'manual', targetCandidateId: 'lan-1',
    candidates: [{ candidateId: 'lan-1', kind: 'lan', endpoint, port, authRequired: true, lastSeenAt: new Date().toISOString() }],
  })
  const connectTo = async () => await installed.directRoute.connectDirectWssTarget({
    transport: {
      endpoint, credential: CREDENTIALS.observer, ca: agentCert, connectTimeoutMs: 8_000,
      maxMessageBytes: 262_144, maxBufferedBytes: 262_144, maxPendingFrames: 64,
    },
    hello: {
      // The hello carries the TARGET daemon's own identity: the direct listener
      // accepts it only when hostId, agentId, generation, protocol version and
      // capabilities revision all match its own published declaration. `source`
      // and `admissionRef` carry the initiator's admitted identity instead.
      hostId: HOST_B_HOST_ID, agentId: HOST_B_AGENT_ID, targetGeneration: TARGET_GENERATION,
      protocolVersion: 1, capabilitiesRevision: fieldsB.capabilitiesRevision, source: OBSERVER, admissionRef: 'adm-observer',
    },
    plan: routePlanFor(agentPort),
    helloTimeoutMs: 8_000,
  })
  const target = await withDeadline(connectTo(), 'direct WSS connect to HOST B', 30_000)
  live.targets.push(target)
  const channel = openChannel({
    target, peer: { accountId: ACCOUNT, scopeId: SCOPE, agentId: HOST_B_AGENT_ID },
    requestedRole: 'master', requestedPeerRole: 'peer', connectionId: 'conn-cross-device',
  })
  const negotiation = await withDeadline(installed.negotiation.runTeamsNegotiation({
    options: {
      side: 'initiator', connectionId: 'conn-cross-device', self: OBSERVER,
      peer: { accountId: ACCOUNT, scopeId: SCOPE, agentId: HOST_B_AGENT_ID },
      selfGeneration: 11, selfCapabilitiesRevision: 'observer-capabilities', selfPolicyRevision: 3,
      allowedRoles: ['master', 'peer'], requestedRole: 'master', requestedPeerRole: 'peer',
      requestedCapabilities: ACP_CAPABILITIES, requestId: 'req-cross-device',
      expectedTargetGeneration: TARGET_GENERATION, expectedTargetCapabilitiesRevision: fieldsB.capabilitiesRevision,
    },
    port: channel.transport, timeoutMs: 20_000,
  }), 'cross-device negotiation')
  assert(negotiation.state === 'agreed', `the cross-device negotiation did not agree (${negotiation.state})`)
  const agreement = installed.negotiation.negotiatedAgreement(negotiation)
  assert(agreement.target.agentId === HOST_B_AGENT_ID && agreement.source.agentId === OBSERVER.agentId,
    `the agreement identities are wrong (${agreement.source.agentId} -> ${agreement.target.agentId})`)
  assert(agreement.sourceRole === 'master' && agreement.targetRole === 'peer', 'the agreement roles are wrong')
  check('HOST A -> HOST B — authenticate, negotiate and connect over the direct WSS listener',
    `endpoint=${endpoint} state=${negotiation.state} ${agreement.source.agentId}(master) -> ${agreement.target.agentId}(peer) targetRevision=${agreement.targetCapabilitiesRevision}`)

  const ref = { connectionId: 'conn-cross-device', channelId: 'observer-channel-cross-device', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsB.engineInstance }
  const readUntil = async (predicate, label, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs
    const seen = []
    while (Date.now() < deadline) {
      const frame = await withDeadline(channel.transport.read(), label, Math.max(1_000, deadline - Date.now()))
      if (predicate(frame)) return { match: frame, seen }
      seen.push(frame)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  await channel.transport.send({ version: 1, kind: 'acp.open', ref })
  const ack = await withDeadline(channel.transport.read(), 'acp.open_ack')
  assert(ack.kind === 'acp.open_ack', `HOST B answered acp.open with ${ack.kind}`)
  assert(ack.ref.channelId !== ref.channelId && ack.ref.connectionId !== ref.connectionId, 'HOST B did not allocate its own transport-scoped ref')

  step = 'cross-device ACP initialize'
  await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id: 'xd-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  const initialized = await readUntil(frame => frame.kind === 'acp.frame' && frame.frame.id === 'xd-init', 'initialize result')
  assert(initialized.match.frame.result?.protocolVersion === 1, `the HOST B engine did not answer initialize (${JSON.stringify(initialized.match.frame).slice(0, 200)})`)

  step = 'cross-device ACP session/new'
  await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id: 'xd-new', method: 'session/new', params: { cwd: `${HOST_B_PREFIX}/workspace`, mcpServers: [] } } })
  const created = await readUntil(frame => frame.kind === 'acp.frame' && frame.frame.id === 'xd-new', 'session/new result')
  const sessionId = created.match.frame.result?.sessionId
  assert(typeof sessionId === 'string' && sessionId.length > 0, `HOST B's engine created no Session (${JSON.stringify(created.match.frame).slice(0, 240)})`)
  check('HOST B — the remote opencode engine creates a real ACP Session on HOST B',
    `sessionId=${sessionId} cwd=${HOST_B_PREFIX}/workspace enginePid=${fieldsB.enginePid}`)

  step = 'cross-device ACP prompt + permission callback'
  const providerCallsBefore = live.probe.calls.length
  await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id: 'xd-prompt', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } } })
  const callbackCollection = await readUntil(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/request_permission', 'permission callback')
  const options = callbackCollection.match.frame.params.options.map(option => option.optionId)
  assert(JSON.stringify(options) === JSON.stringify(['once', 'always', 'reject']), `the permission callback options are wrong (${options.join(',')})`)
  await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id: callbackCollection.match.frame.id, result: { outcome: { outcome: 'selected', optionId: 'once' } } } })
  const promptCollection = await readUntil(frame => frame.kind === 'acp.frame' && frame.frame.id === 'xd-prompt', 'prompt result')
  const sawUpdate = [...callbackCollection.seen, ...promptCollection.seen].some(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update')
  assert(sawUpdate, 'HOST B delivered no real session/update from the remote engine')
  assert(promptCollection.match.frame.result?.stopReason === 'end_turn', `the remote prompt ended with ${promptCollection.match.frame.result?.stopReason}`)
  assert(live.probe.calls.length > providerCallsBefore, 'the HOST B engine never called the HOST A probe provider')
  const probeCall = live.probe.calls.at(-1)
  check('HOST A <-> HOST B — a real ACP prompt/reply with a permission callback round trip crosses the two devices',
    `sessionId=${sessionId} engine->client session/request_permission(${options.join(',')}) + client->engine reply -> stopReason=${promptCollection.match.frame.result.stopReason}; session/update delivered; HOST B's engine called the HOST A provider (${probeCall.toolNames.join(',') || 'no-tools'})`)

  step = 'cross-device ACP cancel'
  await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id: 'xd-cancel-prompt', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'SLOW-CANCEL' }] } } })
  const slowStart = await readUntil(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update' && JSON.stringify(frame).includes('PROBE-START'), 'the slow prompt to start')
  assert(slowStart.match !== undefined, 'the slow prompt produced no live engine update before the cancel')
  await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } } })
  const cancelled = await readUntil(frame => frame.kind === 'acp.frame' && frame.frame.id === 'xd-cancel-prompt', 'cancel result')
  assert(cancelled.match.frame.result?.stopReason === 'cancelled', `the cross-device cancel ended with ${cancelled.match.frame.result?.stopReason}`)
  check('HOST A -> HOST B — a real cancel ends the in-flight remote prompt with the engine\'s own result',
    `session/cancel -> stopReason=${cancelled.match.frame.result.stopReason}`)

  /* -----------------------------------------------------------------------------------
   * HOST B side evidence: the daemon's own durable connection history
   * --------------------------------------------------------------------------------- */
  step = 'HOST B history readback'
  const historyReady = await settle('HOST B to record the inbound connection', async () => {
    const raw = sshB(`cat ${shellQuote(`${HOST_B_PREFIX}/state/acp-history.json`)}`).stdout ?? ''
    return raw.includes('connection.negotiated')
  }, 500, 30_000)
  assert(historyReady, 'HOST B never recorded connection.negotiated in its own durable history')
  const hostBHistoryRaw = sshBOrFail(`cat ${shellQuote(`${HOST_B_PREFIX}/state/acp-history.json`)}`, 'read the HOST B history')
  const hostBHistory = JSON.parse(hostBHistoryRaw)
  const negotiated = hostBHistory.records.find(record => record.kind === 'connection' && record.event === 'connection.negotiated')
  assert(negotiated !== undefined, 'HOST B history has no connection.negotiated record')
  assert(negotiated.agreement?.source?.agentId === OBSERVER.agentId,
    `HOST B recorded the inbound peer as ${negotiated.agreement?.source?.agentId}, expected ${OBSERVER.agentId}`)
  assert(negotiated.agreement?.target?.agentId === HOST_B_AGENT_ID,
    `HOST B recorded itself as ${negotiated.agreement?.target?.agentId}, expected ${HOST_B_AGENT_ID}`)
  const openedChannels = hostBHistory.records.filter(record => record.event === 'channel.opened')
  assert(openedChannels.length >= 1, 'HOST B recorded no channel.opened event')
  check('HOST B — HOST B\'s own durable history records the inbound HOST A peer and the negotiated agreement',
    `records=${hostBHistory.records.length} negotiated: ${negotiated.agreement.source.agentId}(${negotiated.agreement.sourceRole}) -> ${negotiated.agreement.target.agentId}(${negotiated.agreement.targetRole}) connectionId=${negotiated.connectionId} channels=${openedChannels.length}`)

  const hostBLog = redact(sshBOrFail(`cat ${shellQuote(`${HOST_B_PREFIX}/run/agent.log`)}`, 'read the HOST B daemon log'))
  return {
    hostA, hostATs, hostBName, hostBVersion, hostBArch, hostBNode, hostBNpm,
    endpoint, resolvedV4, agentPort, registryPort, fieldsB, agreement, sessionId,
    promptStopReason: promptCollection.match.frame.result.stopReason,
    cancelStopReason: cancelled.match.frame.result.stopReason,
    options, negotiated, openedChannels: openedChannels.length,
    hostBLog, hostBHistory, readiness, registryLine, hostBInstallCommand, hostBInstallOutput,
    hostBCli, hostACliSha, hostBCliSha, staged, provisioned, hostBReceipt, sanReadback, hostBConfigSha,
    probeBaseUrl: probeProvider.baseUrl, probeCalls: live.probe.calls,
    remoteCheck,
  }
}

/* ---------------------------------------------------------------------------------------
 * Entry with explicit-PID cleanup on both hosts
 * ------------------------------------------------------------------------------------- */

let result
let failure
try {
  live.probe = await startProbeProvider(tailscaleIpv4() ?? '127.0.0.1')
  note(`probe provider (HOST A) listening on ${live.probe.baseUrl}`)
  result = await main()
} catch (error) {
  failure = error
} finally {
  // Explicit-PID cleanup only, on both hosts.
  try { for (const target of live.targets) await target.close('producer finished').catch(() => undefined) } catch { /* keep the original failure */ }
  try { await live.observerClient?.stop() } catch { /* keep the original failure */ }

  if (live.hostB.started && !live.hostB.stopped && Number.isInteger(live.hostB.pid)) {
    const killResult = sshB(`kill -TERM ${live.hostB.pid} 2>/dev/null; echo killed=$?`, { timeoutMs: 30_000 })
    note(`HOST B explicit-PID stop: kill -TERM ${live.hostB.pid} -> ${(killResult.stdout ?? '').trim()}`)
    const exited = await settle('the HOST B daemon to exit', async () => {
      const check = sshB(`kill -0 ${live.hostB.pid} 2>/dev/null; echo alive=$?`, { timeoutMs: 20_000 })
      return (check.stdout ?? '').includes('alive=1')
    }, 500, 30_000)
    if (!exited) {
      sshB(`kill -KILL ${live.hostB.pid} 2>/dev/null; echo killed=$?`, { timeoutMs: 20_000 })
      note(`HOST B daemon ${live.hostB.pid} needed SIGKILL`)
    }
    live.hostB.stopped = true
    const engineGone = live.hostB.enginePid === undefined ? true : await settle('the HOST B engine child to exit', async () => {
      const check = sshB(`kill -0 ${live.hostB.enginePid} 2>/dev/null; echo alive=$?`, { timeoutMs: 20_000 })
      return (check.stdout ?? '').includes('alive=1')
    }, 500, 20_000)
    note(`HOST B engine pid ${live.hostB.enginePid} exited=${engineGone}`)
    live.hostB.engineGone = engineGone
    // Capture the daemon's own shutdown receipt and its final durable history.
    live.hostB.finalLog = redact(sshB(`cat ${shellQuote(`${HOST_B_PREFIX}/run/agent.log`)}`).stdout ?? '')
    live.hostB.stopLine = live.hostB.finalLog.split('\n').find(line => line.startsWith('stopped '))
    try {
      live.hostB.finalHistory = JSON.parse(sshB(`cat ${shellQuote(`${HOST_B_PREFIX}/state/acp-history.json`)}`).stdout ?? '{}')
    } catch { live.hostB.finalHistory = undefined }
  }

  if (live.registry.pid !== undefined && !live.registry.stopped && pidAlive(live.registry.pid)) {
    const stop = runCliLogged(['registry', 'stop', '--config', live.registry.configPath], { A11_CRED_B: CREDENTIALS.b, A11_CRED_OBSERVER: CREDENTIALS.observer })
    note(`HOST A registry stop: ${stop.output.trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''}`)
    const exited = await settle('the HOST A registry to exit', async () => !pidAlive(live.registry.pid), 300, 20_000)
    if (!exited) stopByExplicitPid(live.registry.pid, 'SIGKILL')
    live.registry.stopped = true
  }
  try { await live.probe?.close() } catch { /* keep the original failure */ }

  if (failure === undefined) {
    rmSync(ownedRoot, { recursive: true, force: true })
    process.stdout.write(`cleanup: removed the HOST A owned root ${ownedRoot}\n`)
  } else {
    process.stderr.write(`HOST A owned root retained for inspection: ${ownedRoot}\n`)
  }
  if (live.hostB.started) {
    process.stdout.write(KEEP_HOST_B
      ? `cleanup: kept the HOST B install root ${HOST_B_PREFIX} (A11_KEEP_HOST_B=1); it holds the isolated npm prefix, the agent config, the daemon log and the durable history\n`
      : `cleanup: removing the HOST B install root ${HOST_B_PREFIX}\n`)
    if (!KEEP_HOST_B) sshB(`rm -rf ${shellQuote(HOST_B_PREFIX)}`, { timeoutMs: 60_000 })
  }
}

/* ---------------------------------------------------------------------------------------
 * Machine-readable result
 * ------------------------------------------------------------------------------------- */

const summary = {
  unit: 'acp-a11-crossdevice-20261011',
  requirement: 'A11 — genuine cross-device receipt (two physical hosts)',
  producedAt: new Date().toISOString(),
  ok: failure === undefined,
  hosts: {
    hostA: { hostname: result?.hostA, tailscaleIpv4: result?.hostATs, role: 'initiator + registry + probe provider', os: `${process.platform} ${process.arch}` },
    hostB: { hostname: result?.hostBName, tailscaleIpv4: HOST_B_TS_IP, ssh: SSH_TARGET, role: 'installed agent daemon + opencode engine', os: result === undefined ? undefined : `darwin ${result.hostBArch} macOS ${result.hostBVersion}`, node: result?.hostBNode, npm: result?.hostBNpm },
  },
  remotePeerCheck: result?.remoteCheck,
  endpoint: result?.endpoint,
  resolvedAddresses: result?.resolvedV4,
  ports: { hostARegistry: result?.registryPort, hostBAgentListener: result?.agentPort },
  hostBReadiness: result?.readiness,
  hostBInstalledCli: result?.hostBCli,
  hostBInstallCommand: result?.hostBInstallCommand,
  hostBInstallOutput: result?.hostBInstallOutput,
  hostBConfigSha256: result?.hostBConfigSha,
  hostBCertificateSan: result?.sanReadback,
  artifact: result === undefined ? undefined : {
    tarball: result.staged.filename, sha256: result.staged.tarballSha,
    hostASha256: result.staged.tarballSha, hostBSha256: result.provisioned.remoteSha,
    contentSha256: result.staged.receipt.content_sha256, version: result.staged.receipt.version,
    hostBReceiptContentSha256: result.hostBReceipt.content_sha256,
    hostAInstalledCliSha256: result.hostACliSha, hostBInstalledCliSha256: result.hostBCliSha,
  },
  acpExchange: result === undefined ? undefined : {
    sessionId: result.sessionId,
    permissionOptions: result.options,
    promptStopReason: result.promptStopReason,
    cancelStopReason: result.cancelStopReason,
    agreement: {
      source: result.agreement.source.agentId, sourceRole: result.agreement.sourceRole,
      target: result.agreement.target.agentId, targetRole: result.agreement.targetRole,
      targetCapabilitiesRevision: result.agreement.targetCapabilitiesRevision,
    },
  },
  hostBSideEvidence: result === undefined ? undefined : {
    connectionNegotiated: {
      event: result.negotiated.event, connectionId: result.negotiated.connectionId,
      inboundPeer: result.negotiated.agreement.source.agentId,
      inboundRole: result.negotiated.agreement.sourceRole,
      localAgent: result.negotiated.agreement.target.agentId,
      localRole: result.negotiated.agreement.targetRole,
      occurredAt: result.negotiated.occurredAt,
    },
    channelOpenedRecords: result.openedChannels,
    channelClosedRecords: live.hostB.finalHistory?.records?.filter(record => record.event === 'channel.closed').length,
    daemonStopLine: live.hostB.stopLine,
    readinessLine: result.readiness,
  },
  probeProviderBaseUrl: result?.probeBaseUrl,
  probeProviderCalls: result?.probeCalls,
  cleanup: {
    hostADaemonPid: live.registry.pid,
    hostBDaemonPid: live.hostB.pid,
    hostBEnginePid: live.hostB.enginePid,
    hostBEngineExited: live.hostB.engineGone,
    hostAOwnedRootRemoved: failure === undefined,
    hostBInstallRootKept: live.hostB.started ? KEEP_HOST_B : false,
    hostBInstallRoot: HOST_B_PREFIX,
  },
  checks,
  gaps,
  error: failure === undefined ? undefined : { message: failure.message, step },
}

writeFileSync(join(evidenceRoot, 'verification.json'), `${JSON.stringify(summary, null, 2)}\n`)
if (result !== undefined) {
  writeFileSync(join(evidenceRoot, 'raw-host-b-daemon.log'), live.hostB.finalLog ?? result.hostBLog)
  writeFileSync(join(evidenceRoot, 'raw-host-b-history.json'), `${JSON.stringify(live.hostB.finalHistory ?? result.hostBHistory, null, 2)}\n`)
  writeFileSync(join(evidenceRoot, 'raw-host-a-registry.log'), redact(result.registryLine))
}
process.stdout.write(`\nA11 cross-device ${failure === undefined ? 'PASS' : 'FAIL'}: ${checks.length} checks, ${gaps.length} gaps\n`)
if (failure !== undefined) process.stderr.write(`A11 cross-device FAIL [${step}]: ${redact(failure.message)}\n`)
process.stdout.write(`verification.json written to ${join(evidenceRoot, 'verification.json')}\n`)
process.exitCode = failure === undefined ? 0 : 1
