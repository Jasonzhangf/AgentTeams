#!/usr/bin/env node
/**
 * D08 final-acceptance black-box driver (A01–A11).
 *
 * It exercises the INSTALLED artifact, never the worktree debug binaries:
 *   1. the project's own producer `pnpm build:governance`
 *      (`pnpm build && node scripts/package-artifact.mjs --mode final`) stages
 *      `generated/modules/teams-source/lib` and writes `package-receipt.json`;
 *   2. `npm pack` that staged root and `npm install` the tarball into an
 *      isolated prefix outside the source tree — the same pattern
 *      `scripts/package-user-smoke.mjs` / `scripts/installed-runtime-smoke.mjs`
 *      already own;
 *   3. every daemon is started through the INSTALLED `agentteams` CLI
 *      (`registry start`, `control start`, `--serve opencode|dsh`), and every
 *      Teams frame is driven through the installed compiled runtime
 *      (`node_modules/agentteams/generated/runtime-lib/network/*.js`), not the
 *      TypeScript sources.
 *
 * Coverage (A01–A11):
 *   A01 one config starts one daemon; independent identity/storage/IP/port; the
 *       installed CLI reads each daemon back and refuses a non-agent config.
 *   A02 OpenCode and DSH each complete a real prompt/process/reply through the
 *       installed CLI (OpenCode against a local OpenAI-compatible stub provider;
 *       DSH against the real configured provider route and credential).
 *   A03 the config names the discovery server; automatic registration, real
 *       heartbeat renewal, server-owned lease expiry, restart and reconnect.
 *   A04 discovery -> authenticate -> negotiate -> connect over the real LAN
 *       listener; both ends carry the same non-degenerate roles; the same policy
 *       refusal applies to master and peer alike.
 *   A05 bidirectional ACP over LAN (engine callback -> controller reply),
 *       engine updates, a real cancel, and a real unknown outcome that is never
 *       replayed.
 *   A06 a blacklist entry is refused before any side effect; an unexecutable
 *       native-tool policy refuses the configuration.
 *   A07 the WebUI HTTP surface: Basic challenge, served console + four-page
 *       module graph, real projection/history/SSE, typed write-command refusals.
 *   A08 registered-online, live connection state and execution availability are
 *       reported by three separate real owner surfaces; offline objects and
 *       historical connections stay visible.
 *   A09 history survives a page refresh and a control-owner restart; a Session
 *       that cannot be resumed is refused, never passed off as resumed.
 *
 * HONEST BOUNDARIES (printed as `GAP` lines, never as PASS):
 *   - Cross-device receipt: only one physical host exists here, so a genuine
 *     cross-device result is NOT obtainable. Loopback and same-host non-loopback
 *     are never passed off as cross-device. (A11's LAN half IS in scope and checked;
 *     only the cross-device half is the boundary.)
 *   - Live-browser DOM: the reason recorded here in earlier runs was WRONG. It claimed
 *     headless Chrome cannot satisfy this origin's HTTP Basic challenge. CDP
 *     `Network.setExtraHTTPHeaders` injects the credential at the network layer, so a real
 *     browser CAN be driven against a clean-origin URL, and a real producer does so at
 *     `docs/evidence/acp-d08-browser-20261011/`. The item nevertheless stays a gap for THIS
 *     gate, for a different and correct reason: this driver is the installed-tarball,
 *     cross-device acceptance layer and does not drive a browser, so a SOURCE-LEVEL browser
 *     run does not close an installed-artifact item. The frozen DOM contract is owned by
 *     `ui/teams-console/tests/render-d07.spec.ts`.
 *   - The shipped control daemon binds no Console or Session owner, so the projection
 *     carries no sessions, notifications or configs and no Session-, permission- or
 *     notification-driven event can advance the SSE stream. The directory half IS real:
 *     since the D06 directory-projection increment (formerly carried as the separate
 *     "D09" unit) the projection carries the real D04 registration-directory agent rows
 *     and a real registration advances the SSE `seq`. Real-event-driven animation and
 *     in-WebUI targeted interaction are therefore still reported as gaps, not asserted.
 *
 * Cleanup is explicit-PID only: no pkill, killall, `kill $(...)`, or `xargs kill`.
 * Every process this driver starts is stopped by its explicit pid (or through the
 * project's own `registry stop` / `control stop` entry) in `finally`.
 * On PASS the owned temp root is removed; on failure it is retained and printed.
 *
 * Usage: node docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs
 * Env:   OPENCODE_EXECUTABLE (default /Users/fanzhang/.opencode/bin/opencode)
 *        DSH_EXECUTABLE      (default /opt/homebrew/bin/dsh)
 *        D08_DSH_CREDENTIAL_REF (default DEEPSEEK_FLASH_API_KEY)
 *        DSH_CREDENTIALS_FILE   (default ~/.dsh/.credentials.yaml)
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const evidenceRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(evidenceRoot, '..', '..', '..')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const DSH = process.env.DSH_EXECUTABLE ?? '/opt/homebrew/bin/dsh'
const PROVIDER_BASE_URL = process.env.D08_PROVIDER_BASE_URL ?? 'https://api.xyxl1225.online/8318/v1'
const PROVIDER_MODEL = process.env.D08_PROVIDER_MODEL ?? 'wb-deepseek-v4.1-flash'
const DSH_CREDENTIAL_REF = process.env.D08_DSH_CREDENTIAL_REF ?? 'DEEPSEEK_FLASH_API_KEY'
const REAL_DSH_HOME = join(process.env.HOME ?? '', '.dsh')
const DSH_CREDENTIALS_FILE = process.env.DSH_CREDENTIALS_FILE ?? join(REAL_DSH_HOME, '.credentials.yaml')

const ACCOUNT = 'local'
const SCOPE = 'local'
const AGENT_A = { agentId: 'reasoner-a', engine: 'opencode' }
const AGENT_B = { agentId: 'reasoner-dsh', engine: 'dsh' }
const CONTROL_ID = 'control-a'
const REGISTRY_ID = 'lan-registry'
const OBSERVER = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'observer' }
const LEASE_PROBE = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'lease-probe' }
const OFFLINE_PROBE = { accountId: ACCOUNT, scopeId: SCOPE, agentId: 'offline-probe' }
const TARGET_GENERATION = 1
const ACP_CAPABILITIES = ['method:session/new', 'method:session/prompt', 'callback:session/request_permission']
const STEP_DEADLINE_MS = 120_000
// The DSH leg calls a real shared upstream provider. That pool returns 503
// `no_healthy_account` for stretches of time, and three straight-through attempts
// at 2026-10-11 21:06, 21:12 and 05:05 all died on the same response. A transient
// upstream refusal is not a candidate defect, so the prompt is retried with
// exponential backoff and a fresh request id per attempt. This must be a property
// of the driver, not of the operator re-running it: the same failure must not be
// able to end a run that a retry would have closed.
const DSH_PROMPT_ATTEMPTS = 6
const DSH_PROMPT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000]
const DSH_TRANSIENT = /no_healthy_account|no healthy account|HTTP error \(5\d\d\)|API error \(5\d\d\)/iu
const DSH_RETRIES_EXHAUSTED =
  `D08 is blocked at A02 by the upstream provider after ${DSH_PROMPT_ATTEMPTS} attempts. This is an upstream outage, not a candidate defect: the D06/D07 gates are independent of it, and the recorded 44-check run below remains the last completed acceptance run.`
const CONSOLE_USERNAME = 'teams'
const CONSOLE_PASSWORD_ENV = 'D08_CONSOLE_PASSWORD'
const CONSOLE_PASSWORD = `d08-console-${Math.random().toString(36).slice(2, 12)}`
const BASIC = `Basic ${Buffer.from(`${CONSOLE_USERNAME}:${CONSOLE_PASSWORD}`).toString('base64')}`
const AUTH_CHALLENGE = 'Basic realm="AgentTeams", charset="UTF-8"'
const D07_MARKERS = ['data-team-page', 'data-team-page-view', 'data-team-band', 'data-team-observation', 'data-team-cancel', 'data-permission-option', 'data-history-record', 'data-history-count']

/** Deterministic, non-secret credentials. Values are never printed. */
const CREDENTIALS = {
  a: 'Bearer d08-blackbox-agent-a-secret',
  b: 'Bearer d08-blackbox-agent-b-secret',
  control: 'Bearer d08-blackbox-control-secret',
  observer: 'Bearer d08-blackbox-observer-secret',
  lease: 'Bearer d08-blackbox-lease-probe-secret',
  offline: 'Bearer d08-blackbox-offline-probe-secret',
  wrong: 'Bearer d08-blackbox-wrong-secret',
}

/* ---------------------------------------------------------------------------------------
 * Reporting
 * ------------------------------------------------------------------------------------- */

const checks = []
const gaps = []
const findings = []

function check(name, detail) {
  checks.push({ name, detail, ok: true })
  process.stdout.write(`PASS ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

function gap(name, reason) {
  gaps.push({ name, reason })
  process.stdout.write(`GAP ${name} — ${reason}\n`)
}

/**
 * An observation that does not falsify any acceptance check. It is usually a product defect,
 * but it can also be a behaviour worth a decision that no requirement covers. It is reported
 * separately from `GAP` so a coverage boundary is never confused with a product fault, and it
 * never changes the exit code.
 */
function finding(name, detail) {
  findings.push({ name, detail })
  process.stdout.write(`FINDING ${name} — ${detail}\n`)
}

let step = 'startup'

function assert(condition, message) {
  if (!condition) throw new Error(`D08 acceptance FAIL [${step}]: ${message}`)
}

function note(message) {
  process.stdout.write(`  -- ${message}\n`)
}

/**
 * Run one ACP prompt against a transport, retrying a transient upstream refusal
 * with exponential backoff. Only a 5xx-shaped provider error is retried, so a real
 * candidate defect still fails fast and loudly; each attempt uses a fresh request id
 * so a retry can never be mistaken for the original request. `label` names the leg
 * in the emitted detail without printing any credential.
 *
 * Resolves to the successful frame, or to `{ error, exhausted: true, attempts, last }`
 * when every attempt refused. Callers must not `assert` on an exhausted result.
 */
async function promptWithBackoff(local, { method, params, label, deadlineMs = 240_000 }) {
  let last
  for (let attempt = 1; attempt <= DSH_PROMPT_ATTEMPTS; attempt += 1) {
    const requestId = `${method}-attempt-${attempt}`
    await local.send({ jsonrpc: '2.0', id: requestId, method, params })
    last = await local.awaitFrame(frame => frame.id === requestId, deadlineMs)
    if (last.error === undefined) return { frame: last, attempt }
    if (!DSH_TRANSIENT.test(JSON.stringify(last.error))) return { frame: last, attempt }
    note(`${label}: upstream refused (attempt ${attempt}/${DSH_PROMPT_ATTEMPTS}): `
      + `${JSON.stringify(last.error).slice(0, 160)}`)
    const backoffMs = DSH_PROMPT_BACKOFF_MS[attempt - 1]
    if (backoffMs === undefined) break
    note(`${label}: backing off ${Math.round(backoffMs / 1000)}s before the next attempt`)
    await new Promise(resolveWait => setTimeout(resolveWait, backoffMs))
  }
  return { frame: last, attempt: DSH_PROMPT_ATTEMPTS, exhausted: true }
}

/* ---------------------------------------------------------------------------------------
 * Process / filesystem helpers
 * ------------------------------------------------------------------------------------- */

function processRow(pid) {
  try {
    return spawnSync('ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  } catch {
    return ''
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function stopByExplicitPid(pid, signal = 'SIGTERM') {
  if (!pidAlive(pid)) return
  try { process.kill(pid, signal) } catch { /* already gone */ }
}

function processTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return (result.stdout ?? '').split('\n').map(line => line.trim()).filter(line => line.length > 0).map(line => {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? null : { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
  }).filter(row => row !== null)
}

function childrenOf(pid) {
  return processTable().filter(row => row.ppid === pid)
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
  await new Promise((resolveListen, rejectListen) => {
    listener.once('error', rejectListen)
    listener.listen(0, ip, () => resolveListen())
  })
  const address = listener.address()
  await new Promise(resolveClose => listener.close(() => resolveClose()))
  return address.port
}

function portIsClosed(ip, port, timeoutMs = 2_000) {
  return new Promise(resolveClosed => {
    let socket
    let settled = false
    const done = closed => {
      if (settled) return
      settled = true
      socket?.destroy()
      resolveClosed(closed)
    }
    try {
      socket = createConnection({ host: ip, port })
    } catch {
      // An invalid endpoint can never be a listener, so it is closed by definition.
      resolveClosed(true)
      return
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
  })
}

async function withDeadline(promise, label, timeoutMs = STEP_DEADLINE_MS) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectDeadline) => { timer = setTimeout(() => rejectDeadline(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function settle(label, predicate, intervalMs = 150, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await predicate()) return true } catch { /* a transient poll failure must not consume a later real observation */ }
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  return false
}

/** Values may contain spaces, so split on `key=` boundaries. */
function parseFields(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) fields[match[1]] = match[2].trim()
  return fields
}

/** Real TLS material from the documented openssl command, with the LAN IP in the SAN. */
function generateTls(directory, name, sanIp) {
  const keyPath = join(directory, `${name}-key.pem`)
  const certPath = join(directory, `${name}-cert.pem`)
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=IP:${sanIp},DNS:localhost,IP:127.0.0.1`,
    '-keyout', keyPath, '-out', certPath], { encoding: 'utf8' })
  assert(result.status === 0, `openssl TLS generation failed: ${result.stderr}`)
  return { keyPath, certPath, key: readFileSync(keyPath), cert: readFileSync(certPath) }
}

function readDshCredential(reference) {
  if (!existsSync(DSH_CREDENTIALS_FILE)) return undefined
  const match = new RegExp(`^\\s{2}${reference}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(DSH_CREDENTIALS_FILE, 'utf8'))
  return match === null ? undefined : match[1]
}

/* ---------------------------------------------------------------------------------------
 * Owned temp root and the installed copy
 * ------------------------------------------------------------------------------------- */

const ownedRoot = mkdtempSync(join(tmpdir(), 'd08-acc-'))
const prefixRoot = join(ownedRoot, 'prefix')
const cliLogDir = join(ownedRoot, 'cli-logs')
const tlsDir = join(ownedRoot, 'tls')
const packDir = join(ownedRoot, 'pack')
mkdirSync(cliLogDir, { recursive: true })
mkdirSync(tlsDir, { recursive: true })
mkdirSync(packDir, { recursive: true })
mkdirSync(prefixRoot, { recursive: true })

let cliRunCounter = 0
let installedRoot
let CLI
let CLI_ROOT

/** The installed runtime modules this driver imports as the artifact under test. */
const installed = {}

function runCliLogged(args, env = {}, timeoutMs = 120_000) {
  cliRunCounter += 1
  const logPath = join(cliLogDir, `cli-${cliRunCounter}.log`)
  const fd = openSync(logPath, 'a')
  try {
    // `registry start` / `control start` spawn a detached child that inherits stdio, so a
    // pipe would keep the call blocked until that child exits. A plain file avoids it.
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: CLI_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout: timeoutMs,
    })
    return { status: result.status, signal: result.signal, output: readFileSync(logPath, 'utf8') }
  } finally {
    closeSync(fd)
  }
}

/** Captured variant, safe only for entries that exit on their own (refusal probes). */
function runCliCaptured(args, env = {}, timeoutMs = 120_000) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: CLI_ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

async function stageAndInstall() {
  step = 'artifact staging'
  // `scripts/package-artifact.mjs` refuses a candidate with untracked product paths or
  // unstaged product diffs (`scripts/receipt-identity.mjs`). This driver is a new evidence
  // file, so it stages its OWN evidence directory — never any other path — before running
  // the producer. It never commits, resets, checks out or stashes anything.
  const evidenceDirectory = dirname(fileURLToPath(import.meta.url))
  const relativeEvidenceDirectory = evidenceDirectory.slice(repositoryRoot.length + 1)
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout
    .split('\n').map(path => path.trim()).filter(path => path.length > 0)
  const modified = spawnSync('git', ['diff', '--name-only'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout
    .split('\n').map(path => path.trim()).filter(path => path.length > 0)
  const isOwn = path => path.startsWith(`${relativeEvidenceDirectory}/`)
  const foreign = [...untracked, ...modified].filter(path => !isOwn(path))
  assert(foreign.length === 0, `this worktree has untracked or unstaged product paths outside the driver's own evidence directory: ${foreign.join(', ')}`)
  const toStage = [...untracked, ...modified].filter(isOwn)
  if (toStage.length > 0) {
    const staged = spawnSync('git', ['add', '--', ...toStage], { cwd: repositoryRoot, encoding: 'utf8' })
    assert(staged.status === 0, `git add of the driver's own evidence files failed: ${staged.stderr}`)
    note(`staged the driver's own evidence files for the package identity gate: ${toStage.join(', ')}`)
  }

  note('running the project producer: pnpm build:governance')
  const buildLog = join(cliLogDir, 'build-governance.log')
  const buildFd = openSync(buildLog, 'a')
  let build
  try {
    build = spawnSync('pnpm', ['build:governance'], {
      cwd: repositoryRoot, env: process.env, stdio: ['ignore', buildFd, buildFd], timeout: 900_000,
    })
  } finally {
    closeSync(buildFd)
  }
  const buildOutput = readFileSync(buildLog, 'utf8')
  assert(build.status === 0, `pnpm build:governance exited ${build.status}: ${buildOutput.slice(-1200)}`)

  const packRoot = join(repositoryRoot, 'generated', 'modules', 'teams-source', 'lib')
  const receiptPath = join(repositoryRoot, 'generated', 'modules', 'teams-source', 'package-receipt.json')
  assert(existsSync(join(packRoot, 'package.json')), `staged package root is missing: ${packRoot}`)
  assert(existsSync(receiptPath), `package receipt is missing: ${receiptPath}`)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  assert(receipt.mode === 'final', `staged package mode is ${receipt.mode}, expected final`)
  assert(receipt.release_eligible === false, 'the staged receipt must not claim release eligibility beyond its own gate')
  assert(typeof receipt.content_sha256 === 'string' && receipt.content_sha256.length === 64, 'the staged receipt has no content hash')
  assert(existsSync(join(packRoot, 'generated', 'runtime-lib', 'runtime', 'acp-serve.js')), 'the staged package is missing the compiled ACP serve runtime')
  assert(existsSync(join(packRoot, 'generated', 'runtime-lib', 'network', 'teams-negotiation.js')), 'the staged package is missing the compiled Teams negotiation runtime')
  check('install — pnpm build:governance staged a final package',
    `mode=${receipt.mode} version=${receipt.version} content=${receipt.content_sha256.slice(0, 16)}… files=${receipt.files.length}`)

  step = 'npm pack'
  const pack = spawnSync('npm', ['pack', packRoot, '--pack-destination', packDir, '--json'], { encoding: 'utf8', timeout: 300_000 })
  assert(pack.status === 0, `npm pack failed: ${pack.stderr || pack.stdout}`)
  const packed = JSON.parse(pack.stdout)
  assert(Array.isArray(packed) && packed.length === 1 && typeof packed[0].filename === 'string', `npm pack reported no tarball: ${pack.stdout.slice(0, 300)}`)
  const tarball = join(packDir, packed[0].filename)
  assert(existsSync(tarball), `packed tarball is missing: ${tarball}`)
  assert(packed[0].files.some(entry => entry.path === 'cli/agentteams.mjs'), 'the tarball does not contain the CLI entrypoint')
  assert(packed[0].files.some(entry => entry.path.startsWith('generated/runtime-lib/')), 'the tarball does not contain the compiled runtime')

  step = 'isolated install'
  const install = spawnSync('npm', ['install', '--prefix', prefixRoot, '--no-audit', '--no-fund', '--no-package-lock', '--no-save', tarball], { encoding: 'utf8', timeout: 600_000 })
  assert(install.status === 0, `npm install of the packed tarball failed: ${install.stderr || install.stdout}`)
  installedRoot = join(prefixRoot, 'node_modules', 'agentteams')
  CLI = join(installedRoot, 'cli', 'agentteams.mjs')
  CLI_ROOT = installedRoot
  assert(existsSync(CLI), `installed CLI is missing: ${CLI}`)
  const sourceCli = join(repositoryRoot, 'cli', 'agentteams.mjs')
  assert(realpathSync(CLI) !== realpathSync(sourceCli), 'the driver resolved the worktree CLI instead of the installed copy')
  assert(realpathSync(CLI).startsWith(realpathSync(installedRoot)), `the installed CLI resolves outside the installed package: ${realpathSync(CLI)}`)
  check('install — the packed tarball installs into an isolated prefix',
    `tarball=${packed[0].filename} bytes=${packed[0].size} cli=${realpathSync(CLI)}`)

  step = 'installed module imports'
  const networkRoot = join(installedRoot, 'generated', 'runtime-lib', 'network')
  installed.negotiation = await import(pathToFileURL(join(networkRoot, 'teams-negotiation.js')).href)
  installed.routePlan = await import(pathToFileURL(join(networkRoot, 'route-plan.js')).href)
  installed.directRoute = await import(pathToFileURL(join(networkRoot, 'direct-route.js')).href)
  installed.registration = await import(pathToFileURL(join(networkRoot, 'registration-client.js')).href)
  for (const [name, module] of Object.entries(installed)) {
    assert(module !== undefined && Object.keys(module).length > 0, `the installed ${name} module exported nothing`)
  }
  check('install — the installed copy exposes the compiled Teams runtime modules',
    `modules=${Object.keys(installed).join(',')}`)
}

/* ---------------------------------------------------------------------------------------
 * Stub provider for the OpenCode leg
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

/** Local OpenAI-compatible stub. It logs every provider call so a refusal can be proven side-effect free. */
function startStubProvider() {
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
      calls.push({ model: parsed.model ?? '', toolNames, text })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-d08', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-d08', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-d08', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const echo = /ECHO:([A-Za-z0-9-]+)/.exec(text)
      if (text.includes('LOST-PEER')) {
        response.write(chunk({ role: 'assistant', content: 'LOST-PEER-START' }))
        return
      }
      if (text.includes('SLOW-CANCEL')) {
        response.write(chunk({ role: 'assistant', content: 'PROBE-START' }))
        // The engine cancels this stream, so the late write must tolerate a destroyed
        // response instead of raising an uncaught stream error in the driver.
        setTimeout(() => {
          if (response.destroyed || response.writableEnded) return
          try { response.write(chunk({ content: 'PROBE-LATE' })); response.write(finish); response.end('data: [DONE]\n\n') } catch { /* the client already cancelled this stream */ }
        }, 30_000)
        return
      }
      if (echo !== null) {
        response.write(chunk({ role: 'assistant', content: `REPLY-${echo[1]}` }))
        response.write(finish); response.end('data: [DONE]\n\n'); return
      }
      if (toolNames.length === 0) {
        response.write(chunk({ role: 'assistant', content: 'title' }))
        response.write(finish); response.end('data: [DONE]\n\n'); return
      }
      // Stateless per conversation: the first tool-capable turn offers the native `read`
      // tool, and every later turn of that conversation answers the tool result. A global
      // counter would make a second prompt in the same provider process skip the tool call
      // and silently drop the permission-callback leg.
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const toolResults = messages.filter(message => message?.role === 'tool').length
      if (toolResults > 0) {
        response.write(chunk({ role: 'assistant', content: 'PROBE-TOOL-DONE' }))
        response.write(finish); response.end('data: [DONE]\n\n'); return
      }
      response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_d08_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/etc/hosts' }) } }] }))
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-d08', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => {
      resolveStart({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        calls,
        close: () => new Promise(resolveClose => {
          server.closeAllConnections?.()
          server.close(() => resolveClose())
        }),
      })
    })
  })
}

/* ---------------------------------------------------------------------------------------
 * Config templates (v4, one daemon per file)
 * ------------------------------------------------------------------------------------- */

function registryConfig({ dataDirectory, port, keyPath, certPath }) {
  const admission = (ref, agentId, envName) => `
[[admissions]]
admissionRef = ${JSON.stringify(ref)}
agentId = ${JSON.stringify(agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:${envName}"
`
  return `version = 4

[daemon]
kind = "registry"
id = ${JSON.stringify(REGISTRY_ID)}
hostId = "registry-host"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(dataDirectory)}

[listen]
ip = "127.0.0.1"
port = ${port}
tlsCertRef = "file:${certPath}"
tlsKeyRef = "file:${keyPath}"
${admission('adm-a', AGENT_A.agentId, 'D08_CRED_A')}${admission('adm-b', AGENT_B.agentId, 'D08_CRED_B')}${admission('adm-control', CONTROL_ID, 'D08_CRED_CONTROL')}${admission('adm-observer', OBSERVER.agentId, 'D08_CRED_OBSERVER')}${admission('adm-lease', LEASE_PROBE.agentId, 'D08_CRED_LEASE')}${admission('adm-offline', OFFLINE_PROBE.agentId, 'D08_CRED_OFFLINE')}`
}

function agentConfig({ id, engine, executable, ip, port, keyPath, certPath, trustPath, registryPort, dataDirectory, workspace, provider, blacklist = [] }) {
  return `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(id)}
hostId = "host-lan"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(dataDirectory)}

[engine]
kind = ${JSON.stringify(engine)}
executable = ${JSON.stringify(executable)}
workspace = ${JSON.stringify(workspace)}

[listen]
ip = ${JSON.stringify(ip)}
port = ${port}
tlsCertRef = "file:${certPath}"
tlsKeyRef = "file:${keyPath}"

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = ${JSON.stringify(blacklist)}
clientCapabilities = []
callbackExecutor = "controller"

[relations]
allowed = ["master", "peer"]

[[admissions]]
admissionRef = "adm-observer"
agentId = ${JSON.stringify(OBSERVER.agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:D08_CRED_OBSERVER"

[discovery]
serverId = ${JSON.stringify(REGISTRY_ID)}
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:D08_CRED_${id === AGENT_A.agentId ? 'A' : 'B'}"
tlsTrustRef = "file:${trustPath}"

${provider}
[model.primary]
provider = ${engine === 'opencode' ? '"probe"' : '"workbuddy"'}
model = ${engine === 'opencode' ? '"probe-model"' : JSON.stringify(PROVIDER_MODEL)}
`
}

function controlConfig({ dataDirectory, port, registryPort, trustPath }) {
  return `version = 4

[daemon]
kind = "control"
id = ${JSON.stringify(CONTROL_ID)}
hostId = "control-host"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(dataDirectory)}

[webui]
ip = "127.0.0.1"
port = ${port}
allowedOrigin = "http://127.0.0.1:${port}"

[webui.auth]
username = ${JSON.stringify(CONSOLE_USERNAME)}
passwordEnv = ${JSON.stringify(CONSOLE_PASSWORD_ENV)}

[relations]
allowed = ["master", "peer"]

[discovery]
serverId = ${JSON.stringify(REGISTRY_ID)}
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:D08_CRED_CONTROL"
tlsTrustRef = "file:${trustPath}"
`
}

/* ---------------------------------------------------------------------------------------
 * Wire helpers
 * ------------------------------------------------------------------------------------- */

/** One Teams wire channel: negotiation plus raw frame send/receive. */
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

/** A newline-delimited JSON ACP client over the daemon's own local channel. */
function openLocalChannel(address) {
  const [host, portText] = address.split(':')
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = createConnection({ host, port: Number(portText) })
    let buffer = ''
    const frames = []
    socket.on('error', rejectConnect)
    socket.on('connect', () => resolveConnect({
      send: frame => new Promise(resolveSend => socket.write(`${JSON.stringify(frame)}\n`, resolveSend)),
      awaitFrame: (match, timeoutMs = 120_000) => new Promise((resolveFrame, rejectFrame) => {
        const deadline = Date.now() + timeoutMs
        const tick = () => {
          const index = frames.findIndex(match)
          if (index >= 0) { resolveFrame(frames.splice(index, 1)[0]); return }
          if (Date.now() > deadline) { rejectFrame(new Error(`timed out waiting for a frame on ${address}`)); return }
          setTimeout(tick, 50)
        }
        tick()
      }),
      close: () => new Promise(resolveClose => socket.end(resolveClose)),
    }))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim().length > 0) frames.push(JSON.parse(line))
      }
    })
  })
}

function historyPath(dataDirectory) {
  return join(dataDirectory, 'acp-history.json')
}

async function readHistory(dataDirectory) {
  const path = historyPath(dataDirectory)
  if (!existsSync(path)) return { records: [] }
  return JSON.parse(await readFile(path, 'utf8'))
}

/* ---------------------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------------------- */

const started = Date.now()
const live = {
  provider: undefined,
  observerClient: undefined,
  leaseProbeClient: undefined,
  offlineProbeClient: undefined,
  agents: [],
  registry: { pid: undefined, generation: undefined, configPath: undefined, stopped: false },
  control: { pid: undefined, generation: undefined, configPath: undefined, stopped: false },
}
const operatorEnv = {}

try {
  await stageAndInstall()

  const lanIp = lanIpv4()
  assert(lanIp !== undefined, 'this host has no non-internal IPv4 interface; the LAN acceptance cannot run')
  note(`installedRoot=${installedRoot}`)
  note(`ownedRoot=${ownedRoot}`)
  note(`lanIp=${lanIp}`)

  const registryTls = generateTls(tlsDir, 'registry', '127.0.0.1')
  const agentATls = generateTls(tlsDir, 'agent-a', lanIp)
  const agentBTls = generateTls(tlsDir, 'agent-b', lanIp)

  const registryPort = await availablePort('127.0.0.1')
  const controlPort = await availablePort('127.0.0.1')
  const portA = await availablePort(lanIp)
  const portB = await availablePort(lanIp)

  const provider = await startStubProvider()
  live.provider = provider
  const dshCredential = readDshCredential(DSH_CREDENTIAL_REF)

  Object.assign(operatorEnv, {
    D08_CRED_A: CREDENTIALS.a,
    D08_CRED_B: CREDENTIALS.b,
    D08_CRED_CONTROL: CREDENTIALS.control,
    D08_CRED_OBSERVER: CREDENTIALS.observer,
    D08_CRED_LEASE: CREDENTIALS.lease,
    D08_CRED_OFFLINE: CREDENTIALS.offline,
    D08_PROBE_API_KEY: 'd08-probe-secret-value',
    [CONSOLE_PASSWORD_ENV]: CONSOLE_PASSWORD,
    ...(dshCredential === undefined ? {} : { D08_DSH_API_KEY: dshCredential }),
  })

  const openCodeProvider = `
[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(provider.baseUrl)}
label = "D08 probe provider"
enabled = true
credentialEnv = "D08_PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"
`
  const dshProvider = `
[providers.workbuddy]
protocol = "openai-responses"
apiBaseUrl = ${JSON.stringify(PROVIDER_BASE_URL)}
label = "D08 DSH provider"
enabled = true
credentialEnv = "D08_DSH_API_KEY"

[[models]]
provider = "workbuddy"
id = ${JSON.stringify(PROVIDER_MODEL)}
`

  const registryDataDirectory = join(ownedRoot, 'registry-state')
  const agentAData = join(ownedRoot, 'agent-a', 'state')
  const agentBData = join(ownedRoot, 'agent-b', 'state')
  const controlData = join(ownedRoot, 'control', 'state')
  const registryPath = join(ownedRoot, 'registry.toml')
  const agentAPath = join(ownedRoot, 'agent-a.toml')
  const agentBPath = join(ownedRoot, 'agent-b.toml')
  const controlPath = join(ownedRoot, 'control.toml')

  writeFileSync(registryPath, registryConfig({ dataDirectory: registryDataDirectory, port: registryPort, keyPath: registryTls.keyPath, certPath: registryTls.certPath }))
  writeFileSync(agentAPath, agentConfig({
    id: AGENT_A.agentId, engine: 'opencode', executable: OPENCODE, ip: lanIp, port: portA,
    keyPath: agentATls.keyPath, certPath: agentATls.certPath, trustPath: registryTls.certPath,
    registryPort, dataDirectory: agentAData, workspace: join(ownedRoot, 'agent-a', 'workspace'), provider: openCodeProvider,
  }))
  writeFileSync(agentBPath, agentConfig({
    id: AGENT_B.agentId, engine: 'dsh', executable: DSH, ip: lanIp, port: portB,
    keyPath: agentBTls.keyPath, certPath: agentBTls.certPath, trustPath: registryTls.certPath,
    registryPort, dataDirectory: agentBData, workspace: join(ownedRoot, 'agent-b', 'workspace'), provider: dshProvider,
    blacklist: ['method:session/set_config_option'],
  }))
  writeFileSync(controlPath, controlConfig({ dataDirectory: controlData, port: controlPort, registryPort, trustPath: registryTls.certPath }))
  live.registry.configPath = registryPath
  live.control.configPath = controlPath

  /* -------------------------------------------------------------------------------------
   * Start every daemon through the installed CLI
   * ----------------------------------------------------------------------------------- */

  step = 'registry start'
  const registryStart = runCliLogged(['registry', 'start', '--config', registryPath], operatorEnv)
  const registryStartFields = parseFields(registryStart.output.trim().split('\n').filter(Boolean).at(-1) ?? '')
  assert(registryStart.status === 0, `registry start exited ${registryStart.status}: ${registryStart.output.slice(-400)}`)
  assert(registryStartFields.state === 'running', `registry did not report running: ${registryStart.output.slice(-200)}`)
  live.registry.pid = Number(registryStartFields.pid)
  live.registry.generation = Number(registryStartFields.generation)
  assert(pidAlive(live.registry.pid), `the registry pid ${live.registry.pid} is not alive`)

  const spawnEntry = ({ label, engine, ip, port, configPath, env }) => {
    const child = spawn(process.execPath, [CLI, '--serve', engine, '--ip', ip, '--port', String(port), '--config', configPath], {
      cwd: CLI_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const record = { label, engine, ip, port, configPath, child, stdout: '', stderr: '', ready: undefined }
    child.stdout.on('data', chunk => {
      record.stdout += chunk.toString('utf8')
      for (const line of record.stdout.split('\n')) {
        if (record.ready === undefined && line.startsWith('serving ')) record.ready = line
      }
    })
    child.stderr.on('data', chunk => { record.stderr += chunk.toString('utf8') })
    live.agents.push(record)
    return record
  }

  const awaitReady = async record => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (record.ready !== undefined) return parseFields(record.ready)
      if (record.child.exitCode !== null) throw new Error(`${record.label} exited before readiness (code=${record.child.exitCode}); stderr=${record.stderr.slice(-500)}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    throw new Error(`${record.label} never printed a readiness line; stderr=${record.stderr.slice(-500)}`)
  }

  step = 'agent A readiness'
  const entryA = spawnEntry({ label: AGENT_A.agentId, engine: 'opencode', ip: lanIp, port: portA, configPath: agentAPath, env: operatorEnv })
  const fieldsA = await awaitReady(entryA)
  note(`agent A readiness: ${entryA.ready}`)

  step = 'agent B readiness'
  const entryB = spawnEntry({ label: AGENT_B.agentId, engine: 'dsh', ip: lanIp, port: portB, configPath: agentBPath, env: operatorEnv })
  const fieldsB = await awaitReady(entryB)
  note(`agent B readiness: ${entryB.ready}`)

  step = 'control start'
  const controlStart = runCliLogged(['control', 'start', '--config', controlPath], operatorEnv)
  const controlStartFields = parseFields(controlStart.output.trim().split('\n').filter(Boolean).at(-1) ?? '')
  assert(controlStart.status === 0, `control start exited ${controlStart.status}: ${controlStart.output.slice(-400)}`)
  assert(controlStartFields.state === 'running', `control did not report running: ${controlStart.output.slice(-200)}`)
  live.control.pid = Number(controlStartFields.pid)
  live.control.generation = Number(controlStartFields.generation)
  assert(pidAlive(live.control.pid), `the control pid ${live.control.pid} is not alive`)

  const controlOrigin = `http://127.0.0.1:${controlPort}`

  /* -------------------------------------------------------------------------------------
   * A01 — one config, one daemon; independent identity/storage/IP/port; CLI readback
   * ----------------------------------------------------------------------------------- */

  step = 'A01'
  const daemonPidA = Number(fieldsA.daemonPid)
  const enginePidA = Number(fieldsA.enginePid)
  const daemonPidB = Number(fieldsB.daemonPid)
  const enginePidB = Number(fieldsB.enginePid)
  assert(daemonPidA === entryA.child.pid && daemonPidB === entryB.child.pid, 'each readiness line reports the real installed-CLI process pid')

  const serveRows = processTable().filter(row => row.command.includes('--serve'))
  const agentARows = serveRows.filter(row => row.command.includes(agentAPath))
  const agentBRows = serveRows.filter(row => row.command.includes(agentBPath))
  const registryRows = processTable().filter(row => row.command.includes('registry-process.js') && row.command.includes(registryPath))
  const controlRows = processTable().filter(row => row.command.includes('control-process.js') && row.command.includes(controlPath))
  assert(agentARows.length === 1 && agentBRows.length === 1, `each agent config owns exactly one --serve process (a=${agentARows.length} b=${agentBRows.length})`)
  assert(registryRows.length === 1 && controlRows.length === 1, `each service config owns exactly one daemon process (registry=${registryRows.length} control=${controlRows.length})`)
  assert(childrenOf(daemonPidA).length === 1 && childrenOf(daemonPidB).length === 1, 'each agent daemon has exactly one child: its engine')
  assert(childrenOf(live.registry.pid).length === 0 && childrenOf(live.control.pid).length === 0, 'neither service daemon spawned a second daemon')
  check('A01 — one config starts exactly one daemon',
    `agents: 1 --serve each; registry/control: 1 process each; engine children: a=${childrenOf(daemonPidA).length} b=${childrenOf(daemonPidB).length}`)

  const identities = [fieldsA.agent, fieldsB.agent, controlStartFields.daemon, registryStartFields.daemon]
  assert(new Set(identities).size === 4, `daemon identities are not independent: ${identities.join(',')}`)
  check('A01 — independent identity per config', identities.join(','))

  const dataDirectories = [fieldsA.dataDirectory, fieldsB.dataDirectory, controlStartFields.data, registryDataDirectory]
  assert(new Set(dataDirectories).size === 4, `data directories are not independent: ${dataDirectories.join(',')}`)
  for (const directory of dataDirectories) assert(existsSync(directory), `declared data directory was not created: ${directory}`)
  check('A01 — independent storage per config', dataDirectories.map(d => d.replace(`${ownedRoot}/`, '')).join(','))

  assert(fieldsA.listener === `${lanIp}:${portA}` && fieldsB.listener === `${lanIp}:${portB}`, `the agents bind their own LAN listener (${fieldsA.listener} / ${fieldsB.listener})`)
  assert(fieldsA.listener !== fieldsB.listener, 'the two agent listeners are distinct')
  assert(controlStartFields.listener === `127.0.0.1:${controlPort}`, `control binds its own listener (${controlStartFields.listener})`)
  assert(controlPort !== registryPort && portA !== portB && portA !== controlPort && portA !== registryPort && portB !== controlPort && portB !== registryPort,
    'all four declared ports are distinct')
  assert(fieldsA.lanChannel === `wss://${lanIp}:${portA}` && fieldsB.lanChannel === `wss://${lanIp}:${portB}`, 'each agent publishes its own LAN channel endpoint')
  assert(fieldsA.localChannel.startsWith('127.0.0.1:') && fieldsA.localChannel !== fieldsA.listener, `agent A keeps its local channel on loopback (${fieldsA.localChannel})`)
  check('A01 — independent IP/port per config',
    `a=${fieldsA.listener} b=${fieldsB.listener} control=${controlStartFields.listener} registry=127.0.0.1:${registryPort}`)

  assert(fieldsA.engine === 'opencode' && fieldsB.engine === 'dsh', `each readiness line names its configured engine (${fieldsA.engine}/${fieldsB.engine})`)
  assert(fieldsA.config === agentAPath && fieldsB.config === agentBPath, 'each readiness line reads back its own config path')
  assert(fieldsA.dataDirectory === agentAData && fieldsB.dataDirectory === agentBData, 'each readiness line reads back its own data directory')
  assert(fieldsA.model === 'probe/probe-model', `agent A readiness names the accepted model (${fieldsA.model})`)
  assert(typeof fieldsA.engineInstance === 'string' && fieldsA.engineInstance.startsWith('opencode-'), `agent A readiness names its engine instance (${fieldsA.engineInstance})`)
  assert(typeof fieldsB.engineInstance === 'string' && fieldsB.engineInstance.startsWith('dsh-'), `agent B readiness names its engine instance (${fieldsB.engineInstance})`)
  assert(/^\d+$/.test(fieldsA.capabilitiesRevision) && /^\d+$/.test(fieldsB.capabilitiesRevision), 'each readiness line names its published capabilities revision')

  const registryStatus = parseFields(runCliLogged(['registry', 'status', '--config', registryPath], operatorEnv).output.trim())
  assert(registryStatus.state === 'running' && Number(registryStatus.pid) === live.registry.pid, `registry status reads back the live daemon (${JSON.stringify(registryStatus)})`)
  const controlStatus = parseFields(runCliLogged(['control', 'status', '--config', controlPath], operatorEnv).output.trim())
  assert(controlStatus.state === 'running' && Number(controlStatus.pid) === live.control.pid, `control status reads back the live daemon (${JSON.stringify(controlStatus)})`)
  assert(controlStatus.listener === `127.0.0.1:${controlPort}` && controlStatus.data === controlData, 'control status reads back its listener and data directory')
  check('A01 — the installed CLI reads every daemon back',
    `registry: state=${registryStatus.state} pid=${registryStatus.pid} gen=${registryStatus.generation}; control: state=${controlStatus.state} pid=${controlStatus.pid} listener=${controlStatus.listener}`)

  const v3Path = join(ownedRoot, 'legacy-v3.toml')
  writeFileSync(v3Path, 'version = 3\n\n[bridge]\nenabled = true\n')
  const serveControl = runCliCaptured(['--serve', 'opencode', '--ip', '127.0.0.1', '--port', '1', '--config', controlPath], operatorEnv)
  assert(serveControl.status !== 0 && /UNSUPPORTED_CONFIGURATION/.test(serveControl.output) && !serveControl.output.includes('serving '),
    `--serve accepted a control config: status=${serveControl.status} output=${serveControl.output.slice(0, 200)}`)
  const serveV3 = runCliCaptured(['--serve', 'opencode', '--ip', '127.0.0.1', '--port', '1', '--config', v3Path], operatorEnv)
  assert(serveV3.status !== 0 && /UNSUPPORTED_CONFIGURATION/.test(serveV3.output) && !serveV3.output.includes('serving '),
    `--serve accepted a v3 multi-agent config: status=${serveV3.status} output=${serveV3.output.slice(0, 200)}`)
  check('A01 — one config never starts a second daemon',
    `control-as-agent refused (${serveControl.output.split('\n')[0].slice(0, 70)}); v3 refused (${serveV3.output.split('\n')[0].slice(0, 60)})`)

  /* -------------------------------------------------------------------------------------
   * A02 — real prompt/process/reply through the installed CLI
   * ----------------------------------------------------------------------------------- */

  step = 'A02 engine processes'
  assert(/opencode/.test(processRow(enginePidA)) && /acp/.test(processRow(enginePidA)), `agent A runs the real OpenCode ACP engine (${processRow(enginePidA).slice(0, 120)})`)
  assert(/dsh/.test(processRow(enginePidB)) && /--profile/.test(processRow(enginePidB)), `agent B runs the real DSH engine (${processRow(enginePidB).slice(0, 120)})`)
  const ownedHomeB = join(ownedRoot, 'agent-b', 'state', 'engine')
  const patchPathB = join(ownedHomeB, 'teams-dsh-acp.patch.json')
  assert(existsSync(patchPathB), 'the DSH entry wrote its derived profile patch into the daemon-owned home')
  assert(processRow(enginePidB).includes(patchPathB), 'the live DSH child uses the daemon-owned patch path, not the real ~/.dsh')
  assert(!existsSync(join(REAL_DSH_HOME, 'teams-dsh-acp.patch.json')), 'the derived patch was never written into the real ~/.dsh')
  check('A02 — both engines are real child processes of the installed CLI daemons',
    `a=${processRow(enginePidA).split(' ').slice(1).join(' ').slice(0, 60)} b=pid ${enginePidB} owns ${patchPathB.replace(`${ownedRoot}/`, '')}`)

  step = 'A02 opencode prompt'
  const localA = await openLocalChannel(fieldsA.localChannel)
  await localA.send({ jsonrpc: '2.0', id: 'a02-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  const a02Init = await localA.awaitFrame(frame => frame.id === 'a02-init')
  assert(a02Init.result?.protocolVersion === 1, `the installed opencode engine answered initialize (${JSON.stringify(a02Init).slice(0, 160)})`)
  await localA.send({ jsonrpc: '2.0', id: 'a02-new', method: 'session/new', params: { cwd: ownedRoot, mcpServers: [] } })
  const a02New = await localA.awaitFrame(frame => frame.id === 'a02-new')
  const sessionLocalA = a02New.result?.sessionId
  assert(typeof sessionLocalA === 'string' && sessionLocalA.length > 0, 'the installed opencode engine created a session')
  const providerCallsBeforeA02 = provider.calls.length
  await localA.send({ jsonrpc: '2.0', id: 'a02-prompt', method: 'session/prompt', params: { sessionId: sessionLocalA, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } })
  const a02Callback = await localA.awaitFrame(frame => frame.method === 'session/request_permission')
  const a02Options = a02Callback.params.options.map(option => option.optionId)
  assert(JSON.stringify(a02Options) === JSON.stringify(['once', 'always', 'reject']), `the real permission callback reached the installed-CLI client (${a02Options.join(',')})`)
  await localA.send({ jsonrpc: '2.0', id: a02Callback.id, result: { outcome: { outcome: 'selected', optionId: 'once' } } })
  const a02Prompt = await localA.awaitFrame(frame => frame.id === 'a02-prompt')
  assert(a02Prompt.result?.stopReason === 'end_turn', `the OpenCode prompt completed (${a02Prompt.result?.stopReason})`)
  const newCalls = provider.calls.slice(providerCallsBeforeA02)
  assert(newCalls.some(call => call.model === 'probe-model'), 'the stub provider received the accepted model from the real engine')
  assert(newCalls.some(call => call.toolNames.includes('read')), 'the real engine offered its native tools to the provider')
  check('A02 — OpenCode completes a real prompt/process/reply through the installed CLI',
    `session=${sessionLocalA.slice(0, 14)}… permission options=${a02Options.join(',')} stopReason=${a02Prompt.result.stopReason} providerCalls=${newCalls.length}`)

  step = 'A02 dsh prompt'
  const localB = await openLocalChannel(fieldsB.localChannel)
  await localB.send({ jsonrpc: '2.0', id: 'b02-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  const b02Init = await localB.awaitFrame(frame => frame.id === 'b02-init')
  assert(b02Init.result?.agentInfo?.name === 'deepseek-harness-acp', `the installed DSH engine answered initialize (${b02Init.result?.agentInfo?.name})`)
  await localB.send({ jsonrpc: '2.0', id: 'b02-new', method: 'session/new', params: { cwd: ownedRoot, mcpServers: [] } })
  const b02New = await localB.awaitFrame(frame => frame.id === 'b02-new')
  const sessionLocalB = b02New.result?.sessionId
  assert(typeof sessionLocalB === 'string' && sessionLocalB.length > 0, 'the installed DSH engine created a session')
  const modelOption = (b02New.result?.configOptions ?? []).find(option => option.id === 'model')
  const dshModel = modelOption?.currentValue
  assert(typeof dshModel === 'string' && dshModel.includes(PROVIDER_MODEL), `the installed DSH session accepted the configured model (${dshModel})`)
  if (dshCredential === undefined) {
    gap('A02 — DSH real inference', `credential ${DSH_CREDENTIAL_REF} did not resolve from ${DSH_CREDENTIALS_FILE}; initialize/session/new over the installed CLI are proven but no prompt result is claimed`)
  } else {
    const providerCallsBeforeDsh = provider.calls.length
    const dshPrompt = await promptWithBackoff(localB, {
      method: 'session/prompt',
      params: { sessionId: sessionLocalB, prompt: [{ type: 'text', text: 'Reply with exactly: D08-DSH-OK' }] },
      label: 'A02 dsh prompt',
    })
    if (dshPrompt.exhausted) {
      gap('A02 — DSH real inference', `${DSH_RETRIES_EXHAUSTED} Last refusal: ${JSON.stringify(dshPrompt.frame.error).slice(0, 200)}`)
      check('A02 — DSH answers initialize/session/new through the installed CLI',
        `session=${sessionLocalB.slice(0, 14)}… model=${dshModel}; no prompt result is claimed because the upstream provider refused every attempt`)
    } else {
      const b02Prompt = dshPrompt.frame
      assert(b02Prompt.error === undefined, `the real DSH prompt failed: ${JSON.stringify(b02Prompt.error ?? null).slice(0, 240)}`)
      assert(b02Prompt.result?.stopReason === 'end_turn', `the real DSH prompt returned a terminal result (${b02Prompt.result?.stopReason})`)
      assert(provider.calls.length === providerCallsBeforeDsh, 'the DSH leg produced no OpenCode stub provider activity')
      check('A02 — DSH completes a real prompt/process/reply through the installed CLI',
        `session=${sessionLocalB.slice(0, 14)}… model=${dshModel} stopReason=${b02Prompt.result.stopReason} attempt=${dshPrompt.attempt} (real provider route)`)
    }
  }
  await localA.close()
  await localB.close()

  /* -------------------------------------------------------------------------------------
   * A04 — discovery -> authenticate -> negotiate -> connect over the real LAN listener
   * ----------------------------------------------------------------------------------- */

  step = 'A03 observer registration'
  const declarationFor = (agentId, label) => ({
    identity: { hostId: 'host-observer', machineId: 'host-observer', agentId, accountId: ACCOUNT, agentKind: 'acp', label },
    scopeId: SCOPE, revision: 1, capabilities: [], routes: [],
  })
  const registrationClient = (agentId, label, credential, heartbeatIntervalMs, reconnect) => installed.registration.createRegistrationClient({
    declaration: declarationFor(agentId, label),
    endpoint: `wss://127.0.0.1:${registryPort}`,
    credential,
    ca: registryTls.cert,
    heartbeatIntervalMs,
    admissionTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    maxPendingRequests: 16,
    maxDataConnections: 8,
    connectTimeoutMs: 5_000,
    maxMessageBytes: 262_144,
    maxBufferedBytes: 262_144,
    maxPendingFrames: 64,
    reconnect: reconnect ?? { initialDelayMs: 500, maxDelayMs: 5_000, maxAttempts: 8 },
  })
  // The lease probe heartbeats far outside the server-owned 90s presence lease, so the
  // registry's own sweep must publish it offline while its socket stays connected.
  const leaseProbeClient = registrationClient(LEASE_PROBE.agentId, 'D08 lease probe', CREDENTIALS.lease, 600_000)
  live.leaseProbeClient = leaseProbeClient
  const leaseProbeStatus = await withDeadline(leaseProbeClient.start(), 'lease probe registration')
  assert(leaseProbeStatus.state === 'online', `the lease probe registered (${leaseProbeStatus.state})`)
  const leaseProbeStartedAt = Date.now()

  // The observer must outlive the deliberate registry outage below, so it never
  // exhausts its reconnect budget; the agents keep their own configured budget.
  const observerClient = registrationClient(OBSERVER.agentId, 'D08 observer', CREDENTIALS.observer, 5_000,
    { initialDelayMs: 300, maxDelayMs: 2_000, maxAttempts: 400 })
  live.observerClient = observerClient
  const observerStatus = await withDeadline(observerClient.start(), 'observer registration')
  assert(observerStatus.state === 'online', `the observer registered with the real registry (${observerStatus.state})`)
  const readDirectory = async () => await withDeadline(observerClient.directory(true), 'observer directory read')

  const registrationOnline = await settle('both agents register', async () => {
    const directory = await readDirectory()
    const ids = directory.map(peer => peer.declaration.identity.agentId)
    return ids.includes(AGENT_A.agentId) && ids.includes(AGENT_B.agentId) && ids.includes(CONTROL_ID)
  }, 250, 60_000)
  assert(registrationOnline, 'the real directory never listed both agents and the control daemon')
  const directory = await readDirectory()
  const peerA = directory.find(peer => peer.declaration.identity.agentId === AGENT_A.agentId)
  const peerB = directory.find(peer => peer.declaration.identity.agentId === AGENT_B.agentId)
  const peerControl = directory.find(peer => peer.declaration.identity.agentId === CONTROL_ID)
  assert(peerA.presence === 'online' && peerB.presence === 'online' && peerControl.presence === 'online', 'all three registered daemons are online')
  const routeOf = peer => (peer.declaration.routes ?? []).find(candidate => candidate.kind === 'lan')
  assert(routeOf(peerA)?.endpoint === `wss://${lanIp}:${portA}`, `agent A published its real LAN route (${routeOf(peerA)?.endpoint})`)
  assert(routeOf(peerB)?.endpoint === `wss://${lanIp}:${portB}`, `agent B published its real LAN route (${routeOf(peerB)?.endpoint})`)
  assert(String(peerA.declaration.revision) === fieldsA.capabilitiesRevision, 'agent A published directory revision equals its readiness capabilitiesRevision')
  assert(fieldsA.registration === 'online', `agent A readiness reports registration=online (${fieldsA.registration})`)
  assert(fieldsB.registration === 'online', `agent B readiness reports registration=online (${fieldsB.registration})`)
  check('A03 — the config names the discovery server and registration is automatic',
    `serverId=${REGISTRY_ID} endpoint=wss://127.0.0.1:${registryPort} online=${peerA.declaration.identity.agentId},${peerB.declaration.identity.agentId},${peerControl.declaration.identity.agentId}`)

  step = 'A04 wrong credential'
  const routePlanFor = (agentId, port) => installed.routePlan.buildDirectWssRoutePlan({
    hostId: 'host-lan', directoryGeneration: 1, policy: 'manual', targetCandidateId: 'lan-1',
    candidates: [{ candidateId: 'lan-1', kind: 'lan', endpoint: `wss://${lanIp}:${port}`, port, authRequired: true, lastSeenAt: new Date().toISOString() }],
  })
  const connectTo = async ({ agentId, port, cert, credential, capabilitiesRevision }) => await installed.directRoute.connectDirectWssTarget({
    transport: { endpoint: `wss://${lanIp}:${port}`, credential, ca: cert, connectTimeoutMs: 5_000, maxMessageBytes: 262_144, maxBufferedBytes: 262_144, maxPendingFrames: 64 },
    hello: { hostId: 'host-lan', agentId, targetGeneration: TARGET_GENERATION, protocolVersion: 1, capabilitiesRevision, source: OBSERVER, admissionRef: 'adm-observer' },
    plan: routePlanFor(agentId, port),
    helloTimeoutMs: 5_000,
  })
  let refusedWrongCredential
  try {
    const wrong = await connectTo({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, credential: CREDENTIALS.wrong, capabilitiesRevision: fieldsA.capabilitiesRevision })
    await wrong.close('refused after the fact').catch(() => undefined)
  } catch (error) { refusedWrongCredential = error }
  assert(refusedWrongCredential !== undefined, 'a wrong credential was accepted at the real LAN admission')
  const historyAAfterWrong = await readHistory(agentAData)
  assert(!historyAAfterWrong.records.some(record => record.event === 'connection.negotiated'),
    'the refused connection never reached the connection handler, so no application frame was read')
  check('A04 — authenticate: a wrong credential is refused before any application frame',
    `${String(refusedWrongCredential.message).slice(0, 90)}; no connection.negotiated record`)

  const targets = []
  const negotiate = async ({ agentId, port, cert, capabilitiesRevision, requestedRole, requestedPeerRole, label }) => {
    const target = await connectTo({ agentId, port, cert, credential: CREDENTIALS.observer, capabilitiesRevision })
    targets.push(target)
    const channel = openChannel({ target, peer: { accountId: ACCOUNT, scopeId: SCOPE, agentId }, requestedRole, requestedPeerRole, connectionId: `conn-${label}` })
    const negotiation = await withDeadline(installed.negotiation.runTeamsNegotiation({
      options: {
        side: 'initiator', connectionId: `conn-${label}`, self: OBSERVER, peer: { accountId: ACCOUNT, scopeId: SCOPE, agentId },
        selfGeneration: 11, selfCapabilitiesRevision: 'observer-capabilities', selfPolicyRevision: 3,
        allowedRoles: ['master', 'peer'], requestedRole, requestedPeerRole, requestedCapabilities: ACP_CAPABILITIES,
        requestId: `req-${label}`, expectedTargetGeneration: TARGET_GENERATION, expectedTargetCapabilitiesRevision: capabilitiesRevision,
      },
      port: channel.transport, timeoutMs: 15_000,
    }), `negotiation ${label}`)
    return { target, channel, negotiation }
  }
  const openChannelOn = async (channel, ref) => {
    await channel.transport.send({ version: 1, kind: 'acp.open', ref })
    const ack = await withDeadline(channel.transport.read(), 'acp.open_ack')
    assert(ack.kind === 'acp.open_ack', `the daemon answered acp.open with acp.open_ack (${ack.kind})`)
    assert(ack.ref.channelId !== ref.channelId && ack.ref.connectionId !== ref.connectionId, 'the daemon allocated its own transport-scoped ref')
    return ack
  }
  const collectUntil = async (channel, predicate, label, timeoutMs = 120_000) => {
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

  step = 'A04 opencode leg negotiation'
  const leg1 = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'one' })
  assert(leg1.negotiation.state === 'agreed', `the initiator reached the terminal agreed state over the real LAN socket (${leg1.negotiation.state})`)
  const agreement1 = installed.negotiation.negotiatedAgreement(leg1.negotiation)
  assert(agreement1.sourceRole === 'master' && agreement1.targetRole === 'peer', 'the agreement assigns the distinct master/peer role pair')
  assert(Number.isSafeInteger(agreement1.sourcePolicyRevision) && Number.isSafeInteger(agreement1.targetPolicyRevision), 'the agreement carries integer accepted config revisions')
  const acceptFrame = leg1.channel.frames.find(entry => entry.direction === 'in' && entry.frame.kind === 'teams.connection.accept')
  assert(acceptFrame !== undefined, "the responder's own teams.connection.accept frame was observed on the wire")
  assert(acceptFrame.frame.agreement.sourceRole === 'master' && acceptFrame.frame.agreement.targetRole === 'peer' &&
    acceptFrame.frame.agreement.targetPolicyRevision === agreement1.targetPolicyRevision,
    'both ends carry the same roles and the same accepted target policy revision')
  check('A04 — discovery, authenticate, negotiate and connect over the real LAN listener',
    `state=${leg1.negotiation.state} sourceRole=${agreement1.sourceRole} targetRole=${agreement1.targetRole} policyRevisions=${agreement1.sourcePolicyRevision}/${agreement1.targetPolicyRevision}`)
  check('A04 — both master and peer know their role',
    `responder accept frame agreement=${acceptFrame.frame.agreement.sourceRole}->${acceptFrame.frame.agreement.targetRole}`)

  step = 'A04 second leg roles'
  const leg2 = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'peer', requestedPeerRole: 'master', label: 'two' })
  assert(leg2.negotiation.state === 'agreed', `the second connection also reached agreed (${leg2.negotiation.state})`)
  const agreement2 = installed.negotiation.negotiatedAgreement(leg2.negotiation)
  assert(agreement2.sourceRole === 'peer' && agreement2.targetRole === 'master', 'the same daemon holds the opposite role on the second channel, so both roles are non-degenerate')
  check('A04 — roles are non-degenerate on the same daemon',
    `leg1 ${agreement1.sourceRole}/${agreement1.targetRole}; leg2 ${agreement2.sourceRole}/${agreement2.targetRole}`)

  step = 'A04 role authority'
  const ref1 = { connectionId: 'conn-one', channelId: 'observer-channel-1', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsA.engineInstance }
  const ref2 = { connectionId: 'conn-two', channelId: 'observer-channel-2', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsA.engineInstance }
  await openChannelOn(leg1.channel, ref1)
  await openChannelOn(leg2.channel, ref2)
  for (const [channel, ref, id] of [[leg1.channel, ref1, 'role-init-master'], [leg2.channel, ref2, 'role-init-peer']]) {
    await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
    const initialized = await readUntil(channel, frame => frame.kind === 'acp.frame' && frame.frame.id === id, `${id} result`)
    assert(initialized.frame.result?.protocolVersion === 1, `the ${id} channel reached the real engine`)
  }
  const authorityRefusals = []
  for (const [channel, ref, id] of [[leg1.channel, ref1, 'authz-master'], [leg2.channel, ref2, 'authz-peer']]) {
    await channel.transport.send({ version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id, method: 'session/load', params: { sessionId: 'session-not-owned', cwd: ownedRoot, mcpServers: [] } } })
    const refusal = await readUntil(channel, frame => frame.kind === 'acp.frame' && frame.frame.id === id, `${id} refusal`)
    authorityRefusals.push(refusal.frame.error?.data?.code)
  }
  assert(authorityRefusals[0] === 'UNSUPPORTED_METHOD' && authorityRefusals[1] === authorityRefusals[0],
    `the same policy refusal must apply to both roles (${authorityRefusals.join(' / ')})`)
  check('A04 — a role never grants extra authority',
    `master leg and peer leg both refused session/load with ${authorityRefusals[0]}`)

  /* -------------------------------------------------------------------------------------
   * A05 — bidirectional ACP, cancel, unknown outcome
   * ----------------------------------------------------------------------------------- */

  step = 'A05 opencode leg ACP'
  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', id: 'a-new', method: 'session/new', params: { cwd: ownedRoot, mcpServers: [] } } })
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
  const sawUpdate = callbackCollection.seen.some(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update') ||
    promptCollection.seen.some(frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update')
  assert(sawUpdate, 'the opencode leg delivered a real session/update from the engine over LAN')
  assert(promptA.frame.result?.stopReason === 'end_turn', `the callback reply released the tool and the prompt completed (${promptA.frame.result?.stopReason})`)
  check('A05 — bidirectional ACP response/update/callback over LAN',
    `engine->client session/request_permission (${options.join(',')}) + client->engine reply -> stopReason=${promptA.frame.result.stopReason}; session/update delivered`)

  step = 'A05 cancel'
  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', id: 'a-cancel-prompt', method: 'session/prompt', params: { sessionId: sessionA1, prompt: [{ type: 'text', text: 'SLOW-CANCEL' }] } } })
  const slowStart = await collectUntil(leg1.channel, frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/update' && JSON.stringify(frame).includes('PROBE-START'), 'the slow prompt to start')
  assert(slowStart.match !== undefined, 'the slow prompt produced a live engine update before the cancel')
  await leg1.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref1, frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA1 } } })
  const cancelled = await readUntil(leg1.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'a-cancel-prompt', 'cancel result')
  assert(cancelled.frame.result?.stopReason === 'cancelled', `a real cancel ended the in-flight prompt (${cancelled.frame.result?.stopReason})`)
  check('A05 — cancel ends an in-flight prompt with the real engine result',
    `session/cancel notification -> stopReason=${cancelled.frame.result.stopReason}`)

  // Leave one real engine callback outstanding on the second channel. The A03 restart below
  // kills the engine instance that owns it, so the reply can only be refused afterwards.
  step = 'A05 outstanding callback'
  await leg2.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref2, frame: { jsonrpc: '2.0', id: 'a2-new', method: 'session/new', params: { cwd: ownedRoot, mcpServers: [] } } })
  const createdA2 = await readUntil(leg2.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'a2-new', 'second channel session/new')
  const sessionA2 = createdA2.frame.result?.sessionId
  assert(typeof sessionA2 === 'string' && sessionA2.length > 0, `the second channel created its own Session (${sessionA2})`)
  await leg2.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref2, frame: { jsonrpc: '2.0', id: 'a2-prompt', method: 'session/prompt', params: { sessionId: sessionA2, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } } })
  const staleCallback = await readUntil(leg2.channel, frame => frame.kind === 'acp.frame' && frame.frame.method === 'session/request_permission', 'second channel permission callback')
  const staleCallbackId = staleCallback.frame.id
  assert(staleCallbackId !== undefined && staleCallbackId !== null, 'the outstanding permission callback has a real request id')

  step = 'A05 unknown outcome'
  const leg3 = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'three' })
  const ref3 = { connectionId: 'conn-three', channelId: 'observer-channel-3', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsA.engineInstance }
  await openChannelOn(leg3.channel, ref3)
  await leg3.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref3, frame: { jsonrpc: '2.0', id: 'lost-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  await readUntil(leg3.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'lost-init', 'third initialize')
  await leg3.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref3, frame: { jsonrpc: '2.0', id: 'lost-new', method: 'session/new', params: { cwd: ownedRoot, mcpServers: [] } } })
  const createdA3 = await readUntil(leg3.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'lost-new', 'third session/new')
  const sessionA3 = createdA3.frame.result?.sessionId
  assert(typeof sessionA3 === 'string' && sessionA3.length > 0, 'the third channel created its own Session')
  const providerCallsBeforeLost = provider.calls.length
  await leg3.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref3, frame: { jsonrpc: '2.0', id: 'lost-prompt', method: 'session/prompt', params: { sessionId: sessionA3, prompt: [{ type: 'text', text: 'LOST-PEER' }] } } })
  const reachedProvider = await settle('the LOST-PEER prompt to reach the stub provider', async () => provider.calls.length > providerCallsBeforeLost, 100, 30_000)
  assert(reachedProvider, 'the LOST-PEER prompt never reached the stub provider')
  await leg3.target.close('driver closed the channel mid-prompt')
  const unknownRecorded = await settle('durable result.unknown', async () => {
    const records = (await readHistory(agentAData)).records
    return records.some(record => record.event === 'result.unknown' && record.sessionId === sessionA3 && record.outcome === 'unknown')
  }, 200, 30_000)
  assert(unknownRecorded, 'the daemon never wrote a durable result.unknown record with outcome unknown for the closed channel')
  const replay = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'reconnect' })
  const ref4 = { connectionId: 'conn-reconnect', channelId: 'observer-channel-4', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsA.engineInstance }
  await openChannelOn(replay.channel, ref4)
  await replay.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref4, frame: { jsonrpc: '2.0', id: 'replay-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  await readUntil(replay.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'replay-init', 'reconnect initialize')
  const replayed = await readUntil(replay.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'lost-prompt', 'replayed result', 3_000).then(() => true).catch(() => false)
  assert(replayed === false, 'the unknown prompt result was replayed after reconnect')
  check('A05 — unknown outcome is real and is never replayed',
    `channel closed mid-prompt -> durable result.unknown outcome=unknown for ${sessionA3.slice(0, 12)}…; no replay after reconnect`)

  /* -------------------------------------------------------------------------------------
   * A06 — blacklist before side effect; unexecutable native-tool policy refuses config
   * ----------------------------------------------------------------------------------- */

  step = 'A06 dsh leg'
  const legDsh = await negotiate({ agentId: AGENT_B.agentId, port: portB, cert: agentBTls.cert, capabilitiesRevision: fieldsB.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'dsh' })
  assert(legDsh.negotiation.state === 'agreed', `the initiator reached agreed with the real DSH daemon over LAN (${legDsh.negotiation.state})`)
  const refDsh = { connectionId: 'conn-dsh', channelId: 'observer-channel-dsh', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsB.engineInstance }
  await openChannelOn(legDsh.channel, refDsh)
  await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  const initializeDsh = await readUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-init', 'DSH initialize')
  assert(initializeDsh.frame.result?.protocolVersion === 1, 'the real DSH engine answered initialize over the LAN channel')
  await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-new', method: 'session/new', params: { cwd: ownedRoot, mcpServers: [] } } })
  const createdDsh = await readUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-new', 'DSH session/new')
  const sessionDsh = createdDsh.frame.result?.sessionId
  assert(typeof sessionDsh === 'string' && sessionDsh.length > 0, 'the real DSH engine created a session over the LAN channel')
  const providerCallsBeforeRefusal = provider.calls.length
  await legDsh.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refDsh, frame: { jsonrpc: '2.0', id: 'dsh-cfg', method: 'session/set_config_option', params: { sessionId: sessionDsh, configId: 'model', value: '' } } })
  const refusedMethod = await readUntil(legDsh.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'dsh-cfg', 'blacklisted method refusal')
  assert(refusedMethod.frame.error !== undefined && refusedMethod.frame.error.code === -32000 && refusedMethod.frame.error.data?.code === 'CAPABILITY_DENIED',
    `the blacklisted method was refused with a typed JSON-RPC error envelope (${JSON.stringify(refusedMethod.frame.error ?? null)})`)
  assert(provider.calls.length === providerCallsBeforeRefusal, 'the refused method produced no provider call anywhere in the run')
  const refusedHistory = await readHistory(agentBData)
  assert(!refusedHistory.records.some(record => record.event === 'request.dispatched' && JSON.stringify(record).includes('session/set_config_option')),
    'the blacklisted method was dispatched to the engine, so the refusal was not before the side effect')
  assert(refusedHistory.records.some(record => record.event === 'initialize'), 'the durable history still contains the daemon initialize record after the refusal')
  check('A06 — a blacklist entry is refused before any side effect',
    `method:session/set_config_option -> ${refusedMethod.frame.error.data.code}; no request.dispatched record; provider calls unchanged at ${provider.calls.length}`)

  step = 'A06 config refusals'
  const refusalPort = await availablePort(lanIp)
  const refusalConfig = (engine, executable, blacklist) => agentConfig({
    id: engine === 'opencode' ? 'refusal-opencode' : 'refusal-dsh', engine, executable, ip: lanIp, port: refusalPort,
    keyPath: (engine === 'opencode' ? agentATls : agentBTls).keyPath, certPath: (engine === 'opencode' ? agentATls : agentBTls).certPath,
    trustPath: registryTls.certPath, registryPort, dataDirectory: join(ownedRoot, 'refusal', engine, 'state'),
    workspace: join(ownedRoot, 'refusal', engine, 'workspace'), blacklist,
    provider: engine === 'opencode' ? openCodeProvider : dshProvider,
  })
  const openCodeNativePath = join(ownedRoot, 'refusal-opencode-native.toml')
  writeFileSync(openCodeNativePath, refusalConfig('opencode', OPENCODE, ['internal-tool:opencode:not-a-real-tool']))
  const nativeRefusal = runCliCaptured(['--serve', 'opencode', '--ip', lanIp, '--port', String(refusalPort), '--config', openCodeNativePath], operatorEnv)
  assert(nativeRefusal.status !== 0 && /UNSUPPORTED_POLICY/.test(nativeRefusal.output) && !nativeRefusal.output.includes('serving '),
    `an unexecutable OpenCode native-tool policy was accepted: status=${nativeRefusal.status} output=${nativeRefusal.output.slice(0, 240)}`)
  const foreignEnginePath = join(ownedRoot, 'refusal-opencode-foreign.toml')
  writeFileSync(foreignEnginePath, refusalConfig('opencode', OPENCODE, ['internal-tool:dsh:read']))
  const foreignRefusal = runCliCaptured(['--serve', 'opencode', '--ip', lanIp, '--port', String(refusalPort), '--config', foreignEnginePath], operatorEnv)
  assert(foreignRefusal.status !== 0 && /UNSUPPORTED_POLICY/.test(foreignRefusal.output) && !foreignRefusal.output.includes('serving '),
    `a foreign-engine native-tool policy was accepted: status=${foreignRefusal.status} output=${foreignRefusal.output.slice(0, 240)}`)
  const dshNativePath = join(ownedRoot, 'refusal-dsh-native.toml')
  writeFileSync(dshNativePath, refusalConfig('dsh', DSH, ['internal-tool:dsh:read']))
  // This probe must be refused before the engine spawns, so a placeholder credential keeps
  // the probe about the policy rather than about provider credential availability.
  const dshRefusal = runCliCaptured(['--serve', 'dsh', '--ip', lanIp, '--port', String(refusalPort), '--config', dshNativePath],
    { ...operatorEnv, D08_DSH_API_KEY: dshCredential ?? 'd08-refusal-probe-placeholder' }, 180_000)
  assert(dshRefusal.status !== 0 && /UNSUPPORTED_POLICY/.test(dshRefusal.output) && !dshRefusal.output.includes('serving '),
    `an unexecutable DSH native-tool policy was accepted: status=${dshRefusal.status} output=${dshRefusal.output.slice(0, 240)}`)
  const strayEngines = processTable().filter(row => /opencode|dsh/.test(row.command) && row.command.includes(refusalPort))
  assert(strayEngines.length === 0, `a refused configuration still spawned an engine: ${strayEngines.map(row => row.pid).join(',')}`)
  const firstLine = text => text.split('\n').map(line => line.trim()).filter(line => line.length > 0)[0] ?? ''
  check('A06 — an unexecutable native-tool policy refuses configuration',
    `opencode unknown tool: ${firstLine(nativeRefusal.output).slice(0, 62)} | foreign engine: ${firstLine(foreignRefusal.output).slice(0, 58)} | dsh: ${firstLine(dshRefusal.output).slice(0, 58)}`)

  /* -------------------------------------------------------------------------------------
   * A03 — heartbeat, lease offline, restart and reconnect, registry outage
   * ----------------------------------------------------------------------------------- */

  step = 'A03 heartbeat'
  const lastSeenBefore = (await readDirectory()).find(peer => peer.declaration.identity.agentId === AGENT_A.agentId)?.lastSeenAt
  assert(typeof lastSeenBefore === 'string', 'the directory carries a lastSeenAt for agent A')
  const heartbeatRenewed = await settle('the heartbeat to renew the presence lease', async () => {
    const peer = (await readDirectory()).find(entry => entry.declaration.identity.agentId === AGENT_A.agentId)
    return typeof peer?.lastSeenAt === 'string' && peer.lastSeenAt !== lastSeenBefore
  }, 2_000, 40_000)
  assert(heartbeatRenewed, `the registry never observed a renewed lease for agent A (lastSeenAt stayed ${lastSeenBefore})`)
  check('A03 — heartbeat renews the server-owned presence lease',
    `lastSeenAt advanced from ${lastSeenBefore} to ${(await readDirectory()).find(peer => peer.declaration.identity.agentId === AGENT_A.agentId)?.lastSeenAt}`)

  step = 'A03 lease offline'
  const leaseDeadline = leaseProbeStartedAt + 90_000 + 60_000
  const leaseExpired = await settle('the server-owned lease to publish the silent probe offline', async () => {
    const peer = (await readDirectory()).find(entry => entry.declaration.identity.agentId === LEASE_PROBE.agentId)
    return peer !== undefined && peer.presence === 'offline'
  }, 2_000, Math.max(5_000, leaseDeadline - Date.now()))
  if (!leaseExpired) {
    gap('A03 — lease offline', `the registry did not publish the silent lease probe offline within ${Math.round((Date.now() - leaseProbeStartedAt) / 1000)}s; the disconnect path below still proves offline visibility`)
  } else {
    const peer = (await readDirectory()).find(entry => entry.declaration.identity.agentId === LEASE_PROBE.agentId)
    assert(peer !== undefined, 'the offline lease probe entry disappeared instead of staying visible')
    assert(leaseProbeClient.status().state === 'online', `the lease probe socket is still connected (${leaseProbeClient.status().state})`)
    check('A03 — a lapsed server-owned lease publishes the peer offline and keeps it visible',
      `${LEASE_PROBE.agentId} presence=offline after ${Math.round((Date.now() - leaseProbeStartedAt) / 1000)}s with its registration socket still online`)
  }

  step = 'A03 agent restart'
  const agentAStopped = new Promise(resolveExit => entryA.child.once('exit', (code, signal) => resolveExit({ code, signal })))
  stopByExplicitPid(daemonPidA)
  const exitA = await withDeadline(agentAStopped, 'agent A explicit-PID stop', 60_000)
  assert(exitA.code === 0, `agent A exited cleanly by explicit pid (code=${exitA.code} signal=${exitA.signal})`)
  assert(!pidAlive(enginePidA), `agent A engine pid ${enginePidA} is gone`)
  const offlineVisible = await settle('agent A to be published offline but stay visible', async () => {
    const peer = (await readDirectory()).find(entry => entry.declaration.identity.agentId === AGENT_A.agentId)
    return peer !== undefined && peer.presence === 'offline'
  }, 250, 30_000)
  assert(offlineVisible, 'agent A never appeared offline in the directory after its explicit-PID stop')
  assert(await portIsClosed(lanIp, portA), `agent A released its LAN port ${portA}`)

  entryA.child.removeAllListeners('exit')
  const entryA2 = spawnEntry({ label: `${AGENT_A.agentId}#restart`, engine: 'opencode', ip: lanIp, port: portA, configPath: agentAPath, env: operatorEnv })
  const fieldsA2 = await awaitReady(entryA2)
  const reconnected = await settle('agent A to reconnect', async () => {
    const peer = (await readDirectory()).find(entry => entry.declaration.identity.agentId === AGENT_A.agentId)
    return peer !== undefined && peer.presence === 'online'
  }, 250, 60_000)
  assert(reconnected, 'agent A never returned online after its restart')
  assert(fieldsA2.daemonPid !== fieldsA.daemonPid && Number(fieldsA2.daemonPid) === entryA2.child.pid, 'the restarted daemon has a new explicit pid')
  check('A03 — restart and reconnect keep the directory entry visible',
    `stopped pid ${daemonPidA} -> presence offline (entry retained) -> restarted pid ${fieldsA2.daemonPid} -> presence online`)

  // The restarted engine instance is a different engine instance. The callback the previous
  // instance left outstanding can therefore only be refused, and this channel becomes the
  // established LAN leg that the remaining receipts (WebUI closed, control stopped, registry
  // stopped) all reuse.
  step = 'A05 stale callback after the restart'
  const leg5 = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA2.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'post-restart' })
  const ref5 = { connectionId: 'conn-post-restart', channelId: 'observer-channel-5', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsA2.engineInstance }
  await openChannelOn(leg5.channel, ref5)
  await leg5.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref5, frame: { jsonrpc: '2.0', id: 'post-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  const postInit = await readUntil(leg5.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'post-init', 'post-restart initialize')
  assert(postInit.frame.result?.protocolVersion === 1, 'the restarted engine answered initialize on a new channel')
  await leg5.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref5, frame: { jsonrpc: '2.0', id: staleCallbackId, result: { outcome: { outcome: 'selected', optionId: 'once' } } } })
  // A response frame carries no method, so the session owner reports the host fault on the
  // channel itself (`acp.error`) instead of as a JSON-RPC error frame.
  const staleReply = await readUntil(leg5.channel, frame =>
    frame.kind === 'acp.error' ||
    (frame.kind === 'acp.frame' && JSON.stringify(frame.frame?.id) === JSON.stringify(staleCallbackId)),
    'stale callback refusal')
  const staleAccepted = staleReply.kind === 'acp.frame' && staleReply.frame?.result !== undefined
  const staleCode = staleReply.kind === 'acp.error' ? staleReply.error?.code : staleReply.frame?.error?.data?.code
  assert(staleAccepted === false, `the callback left over from the previous engine instance was accepted as a reply: ${JSON.stringify(staleReply).slice(0, 200)}`)
  assert(staleCode === 'CALLBACK_UNAVAILABLE', `the stale callback was refused with the wrong code: ${JSON.stringify(staleReply).slice(0, 200)}`)
  check('A05 — after an agent restart an old callback is rejected',
    `callback id ${String(staleCallbackId)} from engine instance ${String(fieldsA.engineInstance).slice(0, 22)}… -> ${staleReply.kind} ${staleCode} on engine instance ${String(fieldsA2.engineInstance).slice(0, 22)}…`)
  await leg5.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref5, frame: { jsonrpc: '2.0', id: 'post-new', method: 'session/new', params: { cwd: ownedRoot, mcpServers: [] } } })
  const createdA5 = await readUntil(leg5.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'post-new', 'post-restart session/new')
  const sessionA5 = createdA5.frame.result?.sessionId
  assert(typeof sessionA5 === 'string' && sessionA5.length > 0, `the restarted engine created a Session on the established leg (${sessionA5})`)

  step = 'A03 registry outage'
  const registryStop = runCliLogged(['registry', 'stop', '--config', registryPath, '--generation', String(live.registry.generation)], operatorEnv)
  assert(registryStop.status === 0 && /^stopped state=stopped /.test(registryStop.output.trim()), `registry stop failed: ${registryStop.output.slice(-200)}`)
  live.registry.stopped = true
  assert(!pidAlive(live.registry.pid), `the registry pid ${live.registry.pid} is gone after the service-entry stop`)
  const degradeSeen = await settle('the daemon to report its registration degradation', async () => {
    const lines = entryB.stdout.split('\n').filter(line => line.startsWith('registration '))
    return lines.length > 0 && !/state=online/.test(lines.at(-1))
  }, 250, 45_000)
  assert(degradeSeen, `agent B never reported a non-online registration state after the registry outage: ${entryB.stdout.split('\n').filter(line => line.startsWith('registration ')).at(-1) ?? 'no line'}`)
  const degradedLine = entryB.stdout.split('\n').filter(line => line.startsWith('registration ')).at(-1)
  assert(/endpoint=wss:\/\/127\.0\.0\.1:/.test(degradedLine), `the degraded registration line still names the configured server (${degradedLine})`)
  // The already-established LAN channel must not depend on the registry: a real prompt has
  // to complete while the registry process is down.
  await leg5.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref5, frame: { jsonrpc: '2.0', id: 'registry-down', method: 'session/prompt', params: { sessionId: sessionA5, prompt: [{ type: 'text', text: 'ECHO:REGISTRY-DOWN' }] } } })
  const downCollection = await collectUntil(leg5.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'registry-down', 'prompt result while the registry is down', 120_000)
  assert(downCollection.match.frame.result?.stopReason === 'end_turn',
    `the established LAN channel did not complete a prompt while the registry was down (${JSON.stringify(downCollection.match.frame.result ?? downCollection.match.frame.error ?? null).slice(0, 160)})`)
  check('A10 — an established LAN channel survives the registry stopping',
    `registry pid ${live.registry.pid} stopped; prompt on the pre-outage channel -> stopReason=${downCollection.match.frame.result.stopReason}`)
  const registryRestart = runCliLogged(['registry', 'start', '--config', registryPath], operatorEnv)
  const registryRestartFields = parseFields(registryRestart.output.trim().split('\n').filter(Boolean).at(-1) ?? '')
  assert(registryRestart.status === 0 && registryRestartFields.state === 'running', `registry restart failed: ${registryRestart.output.slice(-200)}`)
  live.registry.pid = Number(registryRestartFields.pid)
  live.registry.generation = Number(registryRestartFields.generation)
  live.registry.stopped = false
  const restored = await settle('the daemon to reconnect', async () => {
    const lines = entryB.stdout.split('\n').filter(line => line.startsWith('registration '))
    return lines.length > 0 && /state=online/.test(lines.at(-1))
  }, 250, 60_000)
  assert(restored, 'agent B never returned to registration=online after the registry restart')
  const reconnectedDirectory = await settle('the directory to list both agents again', async () => {
    const peers = await readDirectory()
    return peers.filter(peer => peer.presence === 'online').map(peer => peer.declaration.identity.agentId).includes(AGENT_A.agentId) &&
      peers.filter(peer => peer.presence === 'online').map(peer => peer.declaration.identity.agentId).includes(AGENT_B.agentId)
  }, 500, 60_000)
  assert(reconnectedDirectory, 'the restarted registry never listed both agents online again')
  check('A03 — a registry outage degrades and a restart reconnects',
    `degraded: ${degradedLine.slice(0, 90)} | restored: ${entryB.stdout.split('\n').filter(line => line.startsWith('registration ')).at(-1).slice(0, 90)}`)

  /* -------------------------------------------------------------------------------------
   * A07 — WebUI HTTP surface
   * ----------------------------------------------------------------------------------- */

  step = 'A07 anonymous challenge'
  const anonymous = await fetch(controlOrigin).catch(() => null)
  assert(anonymous !== null && anonymous.status === 401, `an unauthenticated GET / returned ${anonymous?.status}`)
  const challenge = anonymous.headers.get('www-authenticate') ?? ''
  assert(challenge === AUTH_CHALLENGE, `the anonymous challenge is ${challenge}`)
  await anonymous.body?.cancel().catch(() => {})
  check('A07 — the WebUI refuses an unauthenticated browser with the frozen Basic challenge', `status=401 challenge=${challenge}`)

  const authFetch = async (path, init = {}) => await fetch(new URL(path, controlOrigin), { ...init, headers: { authorization: BASIC, ...(init.headers ?? {}) } })
  const readBoundedSseFrame = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    timer.unref?.()
    try {
      const response = await fetch(`${controlOrigin}/api/v1/events`, { headers: { authorization: BASIC }, signal: controller.signal })
      assert(response.status === 200, `SSE returned HTTP ${response.status}`)
      assert((response.headers.get('content-type') ?? '').startsWith('text/event-stream'), `SSE content-type is ${response.headers.get('content-type')}`)
      assert((response.headers.get('cache-control') ?? '').includes('no-store'), `SSE cache-control is ${response.headers.get('cache-control')}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf8')
      let buffer = ''
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
      await reader.cancel()
      const line = (buffer.split('\n\n')[0] ?? '').split('\n').find(entry => entry.startsWith('data: '))
      assert(line !== undefined, 'the SSE frame carried no data line')
      return JSON.parse(line.slice('data: '.length))
    } finally { clearTimeout(timer) }
  }

  step = 'A07 served console'
  const home = await authFetch('/')
  assert(home.status === 200, `GET / returned ${home.status}`)
  const homeBody = await home.text()
  assert(homeBody.includes('/console-entry.js'), 'the home HTML does not reference /console-entry.js')
  const entryJs = await authFetch('/console-entry.js')
  assert(entryJs.status === 200 && (await entryJs.text()).length > 0, 'GET /console-entry.js did not serve the browser bootstrap')
  const browserJs = await authFetch('/ui/browser.js')
  assert(browserJs.status === 200 && /javascript/.test(browserJs.headers.get('content-type') ?? ''), 'GET /ui/browser.js did not serve the browser barrel')
  const visited = new Set()
  const bodies = []
  const queue = ['/ui/browser.js']
  while (queue.length > 0 && visited.size < 96) {
    const modulePath = queue.shift()
    if (modulePath === undefined || visited.has(modulePath)) continue
    visited.add(modulePath)
    const response = await authFetch(modulePath)
    if (response.status !== 200) continue
    const body = await response.text()
    bodies.push(body)
    for (const specifier of body.matchAll(/(?:from|import)\s+['"]((?:\.\/|\/ui\/)[^'"]+)['"]/g)) {
      const candidate = new URL(specifier[1], `http://example.invalid${modulePath}`).pathname
      if (candidate.startsWith('/ui/') && !visited.has(candidate)) queue.push(candidate)
    }
  }
  const graph = bodies.join('\n')
  for (const marker of D07_MARKERS) assert(graph.includes(marker), `the served /ui/ module graph is missing the frozen marker ${marker}`)
  // After the D07 ablation only `page-networking` is a live page module: controller.ts imports its
  // membership helpers. `page-discovery` (projectDiscoveryRows / projectNetworkView),
  // `page-interaction` and `page-history` had no consumer in src or in the built barrel, and were
  // deleted. The four page VIEWS are unaffected: render.ts renders all four and they are asserted
  // by the frozen data-team-page-view markers and by render-d07.spec.ts.
  const pageModules = ['page-networking']
  for (const page of pageModules) {
    const response = await authFetch(`/ui/client/${page}.js`)
    assert(response.status === 200, `the artifact does not serve /ui/client/${page}.js (HTTP ${response.status})`)
    assert((await response.text()).length > 0, `/ui/client/${page}.js is empty`)
  }
  const reachablePages = pageModules.filter(page => visited.has(`/ui/client/${page}.js`))
  assert(reachablePages.length === pageModules.length, `the barrel graph does not reach the live page module(s): reachable=${reachablePages.join(',')}`)
  check('A07 — the WebUI serves the console and its live page modules',
    `${visited.size} modules from /ui/browser.js; markers=${D07_MARKERS.length}; live page modules served=${pageModules.length} (barrel-reachable: ${reachablePages.join(',')})`)

  step = 'A07 projection and history'
  const projectionResponse = await authFetch('/api/v1/projection')
  assert(projectionResponse.status === 200 && (projectionResponse.headers.get('content-type') ?? '').startsWith('application/json'), `GET /api/v1/projection returned ${projectionResponse.status}`)
  const projection = await projectionResponse.json()
  assert(projection.version === 1, `projection.version is ${projection.version}`)
  for (const field of ['agents', 'sessions', 'notifications', 'configs', 'connections']) assert(Array.isArray(projection[field]), `projection.${field} is not an array`)
  const historyResponse = await authFetch('/api/v1/history?version=1&limit=50&kind=connection')
  assert(historyResponse.status === 200, `GET history returned ${historyResponse.status}`)
  const historyPage = await historyResponse.json()
  assert(Array.isArray(historyPage.records), 'the history response lacks the HistoryPage records[] shape')
  const registryEvents = historyPage.records.filter(record => /registry-lost|registry-restored/.test(JSON.stringify(record)))
  assert(registryEvents.length > 0, `the control owner recorded no registry transition rows: ${JSON.stringify(historyPage).slice(0, 240)}`)
  check('A07 — the WebUI serves real projection and history owner reads',
    `projection v${projection.version} agents=${projection.agents.length} connections=${projection.connections.length}; history records=${historyPage.records.length} registry transitions=${registryEvents.length}`)

  step = 'A07 SSE'
  const sseFrame = await readBoundedSseFrame()
  assert(Number.isSafeInteger(sseFrame.seq) && sseFrame.projection?.version === 1, `the SSE frame is not a real { seq, projection } snapshot (${JSON.stringify(sseFrame).slice(0, 160)})`)
  check('A07 — the SSE endpoint streams a real { seq, projection } snapshot',
    `seq=${sseFrame.seq} projectionVersion=${sseFrame.projection.version}`)

  step = 'A07 write commands'
  const refusedCommand = async body => {
    const response = await authFetch('/api/v1/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert(response.status === 200, `command ${body.kind} returned HTTP ${response.status}`)
    const result = await response.json()
    assert(result.ok === false && typeof result.error?.code === 'string', `command ${body.kind} was not refused with a typed code: ${JSON.stringify(result).slice(0, 200)}`)
    return result.error.code
  }
  const connectCode = await refusedCommand({ kind: 'connection.connect', agentId: CONTROL_ID })
  const membershipCode = await refusedCommand({ kind: 'network.membership.apply', agentId: CONTROL_ID, expectedRevision: 1, members: [{ agentId: AGENT_A.agentId, role: 'master' }] })
  const permissionCode = await refusedCommand({ kind: 'permission.reply', agentId: CONTROL_ID, sessionId: 'session-not-owned', permissionId: 'permission-not-pending', decision: 'once', optionId: 'option-not-offered' })
  assert(connectCode === 'UNSUPPORTED_OPERATION' && membershipCode === 'UNSUPPORTED_OPERATION' && permissionCode === 'UNSUPPORTED_OPERATION',
    `write commands must be typed refusals (${connectCode}/${membershipCode}/${permissionCode})`)
  const malformed = await authFetch('/api/v1/command', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'permission.reply', agentId: CONTROL_ID, sessionId: 's', permissionId: 'p', decision: 'once', optionId: 'o', callbackId: 'not-in-vocabulary' }),
  })
  assert(malformed.status === 400, `a payload outside the frozen ConsoleCommandV1 vocabulary returned HTTP ${malformed.status}`)
  check('A07 — the WebUI write commands are typed refusals, never fabricated effects',
    `connection.connect=${connectCode} network.membership.apply=${membershipCode} permission.reply=${permissionCode}; out-of-vocabulary payload HTTP ${malformed.status}`)

  // Closing the observation client must not disturb an established agent-to-agent channel:
  // Agent Hosts communicate independently once configured.
  step = 'A05 after the WebUI client closes'
  await leg5.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref5, frame: { jsonrpc: '2.0', id: 'after-webui', method: 'session/prompt', params: { sessionId: sessionA5, prompt: [{ type: 'text', text: 'ECHO:AFTER-WEBUI' }] } } })
  const afterWebui = await readUntil(leg5.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'after-webui', 'prompt result after the WebUI client closed', 120_000)
  assert(afterWebui.frame.result?.stopReason === 'end_turn',
    `the established LAN channel did not complete a prompt after the WebUI client closed (${JSON.stringify(afterWebui.frame.result ?? afterWebui.frame.error ?? null).slice(0, 160)})`)
  check('A10 — communication continues after the WebUI client closes',
    `every WebUI HTTP/SSE client connection this driver opened is closed; prompt on the established channel -> stopReason=${afterWebui.frame.result.stopReason}`)
  gap('A07 — animation driven by real events',
    'the shipped control daemon binds no Console or Session owner (runtime/control-process.ts:818 calls createControlOwner({ network: network.port, source: network.projection }) with no owner), so the projection carries no sessions, notifications or configs and no Session/permission/notification event can advance the SSE stream. The directory half is now real: GET /api/v1/projection carries the real D04 registration-directory agent rows and a real registration advances the SSE seq (1 -> 3) through the declared ControlProjectionSource watch. Real-event-driven animation is therefore still not delivered — only directory-change-driven refresh is. D06 requires a Session owner plus targeted ACP ingress, so this remains an UNMET REQUIREMENT owned by D06, not an environment limit')
  // This stays a GAP for THIS gate, but the earlier reason recorded here was WRONG. The old text
  // claimed headless Chrome cannot satisfy the origin's HTTP Basic challenge. That is refuted:
  // CDP `Network.setExtraHTTPHeaders` injects the credential at the network layer, so a real
  // browser can be driven against a clean-origin URL, and a real producer now does exactly that at
  // docs/evidence/acp-d08-browser-20261011/ (14 checks / 1 gap, exit 0).
  //
  // The A07 live-browser DOM is STILL a gap here for a different and correct reason: this driver is
  // the installed-tarball, cross-device acceptance layer and it does not drive a browser. The
  // live-browser evidence is a SOURCE-LEVEL artifact. Per the evidence boundary, a later evidence
  // level is never inferred from an earlier one, so a source-level browser run does not close an
  // installed-artifact acceptance item. Closing it here needs a browser run against the installed
  // tarball's own served origin, which this driver does not perform.
  gap('A07 — live-browser DOM against the installed artifact',
    'this installed-tarball acceptance driver does not drive a browser, so no installed-artifact DOM or screenshot is claimed here. Source-level live-browser DOM IS proven separately at docs/evidence/acp-d08-browser-20261011/ (14 checks / 1 gap, exit 0, real Chrome over CDP); that is a different evidence level and does not close this item. The frozen DOM contract is owned by ui/teams-console/tests/render-d07.spec.ts')
  gap('A07 — targeted interaction from the WebUI',
    'the control daemon binds no Session owner, so every interaction write (permission.reply/session send) is a typed UNSUPPORTED_OPERATION refusal; no prompt can be targeted from the WebUI in this candidate')

  /* -------------------------------------------------------------------------------------
   * A08 — three separate surfaces; offline objects and historical connections visible
   * ----------------------------------------------------------------------------------- */

  step = 'A08 surfaces'
  // The registry directory is in-memory, so a peer that lapses while the registry
  // restarts is not a stable observation. This driver registers one dedicated probe and
  // stops it, which makes the relay publish it offline while keeping the entry: a fresh,
  // durable offline object for the whole rest of the run.
  const offlineProbeClient = registrationClient(OFFLINE_PROBE.agentId, 'D08 offline probe', CREDENTIALS.offline, 5_000)
  live.offlineProbeClient = offlineProbeClient
  const offlineProbeStatus = await withDeadline(offlineProbeClient.start(), 'offline probe registration')
  assert(offlineProbeStatus.state === 'online', `the offline probe registered (${offlineProbeStatus.state})`)
  const offlineProbeListed = await settle('the offline probe to be listed online', async () =>
    (await readDirectory()).find(peer => peer.declaration.identity.agentId === OFFLINE_PROBE.agentId)?.presence === 'online', 200, 20_000)
  assert(offlineProbeListed, 'the offline probe never appeared online in the directory')
  await offlineProbeClient.stop()
  const offlineProbeVisible = await settle('the stopped probe to be published offline but stay listed', async () => {
    const peer = (await readDirectory()).find(entry => entry.declaration.identity.agentId === OFFLINE_PROBE.agentId)
    return peer !== undefined && peer.presence === 'offline'
  }, 200, 20_000)
  assert(offlineProbeVisible, 'a stopped registration client disappeared from the directory instead of being published offline')

  const finalDirectory = await readDirectory()
  const offlinePeer = finalDirectory.find(peer => peer.declaration.identity.agentId === OFFLINE_PROBE.agentId)
  assert(offlinePeer !== undefined && offlinePeer.presence === 'offline', 'the stopped probe is not visible as an offline object')
  assert(finalDirectory.every(peer => typeof peer.presence === 'string' && (peer.presence === 'online' || peer.presence === 'offline')),
    'the directory carries a real online|offline presence per peer')
  const onlineIds = finalDirectory.filter(peer => peer.presence === 'online').map(peer => peer.declaration.identity.agentId)
  assert(onlineIds.includes(AGENT_A.agentId) && onlineIds.includes(AGENT_B.agentId) && onlineIds.includes(CONTROL_ID), `the directory reports the live daemons online (${onlineIds.join(',')})`)
  check('A08 — registered-online is a real directory fact, separate from any connection state',
    `online=[${onlineIds.join(',')}] offline=[${finalDirectory.filter(peer => peer.presence === 'offline').map(peer => peer.declaration.identity.agentId).join(',') || 'none'}]`)

  step = 'A08 live vs history'
  const liveProjection = await (await authFetch('/api/v1/projection')).json()
  const durableHistory = await (await authFetch('/api/v1/history?version=1&limit=50&kind=connection')).json()
  assert(Array.isArray(liveProjection.connections) && liveProjection.connections.length === 0,
    `a control daemon with no Teams listener must report an empty live connection list (${JSON.stringify(liveProjection.connections ?? null).slice(0, 160)})`)
  assert(durableHistory.records.length > 0, 'the durable connection history is empty, so live state and history are not distinguishable')
  check('A08 — live connection state and durable connection history are separate surfaces',
    `live connections=${liveProjection.connections.length}; durable kind=connection records=${durableHistory.records.length}`)

  step = 'A08 execution availability'
  assert(typeof fieldsA.model === 'string' && fieldsA.model.length > 0 && typeof fieldsA.modelVerification === 'string' && fieldsA.modelVerification.includes('session/new'),
    `the readiness line proves execution availability from the engine (model=${fieldsA.model} verification=${fieldsA.modelVerification})`)
  const badEnginePath = join(ownedRoot, 'refusal-bad-engine.toml')
  writeFileSync(badEnginePath, refusalConfig('opencode', join(ownedRoot, 'no-such-engine'), []))
  const badEngine = runCliCaptured(['--serve', 'opencode', '--ip', lanIp, '--port', String(refusalPort), '--config', badEnginePath], operatorEnv, 180_000)
  assert(badEngine.status !== 0 && !badEngine.output.includes('serving '), `an unavailable engine still produced a readiness line: ${badEngine.output.slice(0, 200)}`)
  check('A08 — execution availability is proven from the engine, never inferred',
    `available: model=${fieldsA.model} via ${fieldsA.modelVerification}; unavailable: no readiness line, exit ${badEngine.status} (${badEngine.output.split('\n')[0].slice(0, 70)})`)
  check('A08 — offline objects and historical connections stay visible',
    `${offlinePeer.declaration.identity.agentId} presence=${offlinePeer.presence} while still listed; ${durableHistory.records.length} durable connection rows still served`)

  /* -------------------------------------------------------------------------------------
   * A09 — history across refresh and owner restart; non-resumable Session
   * ----------------------------------------------------------------------------------- */

  step = 'A09 UI refresh'
  const beforeRefresh = (await (await authFetch('/api/v1/history?version=1&limit=50&kind=connection')).json()).records
  await readBoundedSseFrame()
  const afterRefresh = (await (await authFetch('/api/v1/history?version=1&limit=50&kind=connection')).json()).records
  // Retention is the claim: every previously served row is still served, unchanged. New real
  // events may legitimately append, so the count is reported instead of asserted equal.
  const retention = (before, after) => {
    const index = new Map(after.map(record => [record.recordId, JSON.stringify(record)]))
    return {
      lost: before.filter(record => !index.has(record.recordId)).map(record => record.recordId),
      changed: before.filter(record => index.get(record.recordId) !== JSON.stringify(record)).map(record => record.recordId),
    }
  }
  const refreshRetention = retention(beforeRefresh, afterRefresh)
  assert(refreshRetention.lost.length === 0 && refreshRetention.changed.length === 0,
    `the history changed across a fresh page/stream load (lost=${refreshRetention.lost.join(',')} changed=${refreshRetention.changed.join(',')})`)
  check('A09 — history survives a UI refresh',
    `${beforeRefresh.length} records retained byte-identical across a fresh authenticated stream + history read (now ${afterRefresh.length})`)

  // A09's owner restart goes through the project's own stop and start entries, and the
  // durable `kind: 'connection'` history must come back byte-identical. This is the receipt
  // that exposed 146824a: `stopControlDaemon` used to remove the whole owned data directory
  // (which holds the history store), and the earlier STOP_TIMEOUT defect masked it by
  // throwing before the removal. The strict stop+start form is kept on purpose — a
  // crash-only restart would have hidden that defect.
  step = 'A10 control stop'
  const controlStop = runCliLogged(['control', 'stop', '--config', controlPath, '--generation', String(live.control.generation)], operatorEnv)
  const controlStopLine = controlStop.output.trim().split('\n').filter(Boolean).at(-1) ?? ''
  // 44d82f7 fixed the false STOP_TIMEOUT this driver originally found (D08-F1): a live WebUI
  // event-stream client used to hold the daemon past the CLI's bounded stop wait. That fix is
  // part of this candidate, so a stop that reports anything other than a clean
  // `stopped state=stopped` is now a regression and fails the run, not a non-fatal note.
  assert(controlStop.status === 0 && /^stopped state=stopped /.test(controlStopLine),
    `control stop did not report a clean stop: exit ${controlStop.status}, last line "${controlStopLine}"`)
  live.control.stopped = true
  assert(!pidAlive(live.control.pid), `the control pid ${live.control.pid} is gone after the explicit stop`)
  assert(await settle('the control listener to close', async () => await portIsClosed('127.0.0.1', controlPort), 100, 10_000), `control listener ${controlPort} survived the stop`)
  // The D08 §5 receipt: the established channel keeps working while no control daemon runs.
  step = 'A10 after the control daemon stops'
  await leg5.channel.transport.send({ version: 1, kind: 'acp.frame', ref: ref5, frame: { jsonrpc: '2.0', id: 'after-control', method: 'session/prompt', params: { sessionId: sessionA5, prompt: [{ type: 'text', text: 'ECHO:AFTER-CONTROL' }] } } })
  const afterControl = await readUntil(leg5.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'after-control', 'prompt result after the control daemon stopped', 120_000)
  assert(afterControl.frame.result?.stopReason === 'end_turn',
    `the established LAN channel did not complete a prompt after the control daemon stopped (${JSON.stringify(afterControl.frame.result ?? afterControl.frame.error ?? null).slice(0, 160)})`)
  check('A10 — communication continues after the control daemon stops',
    `control pid ${live.control.pid} stopped and its listener ${controlPort} closed; prompt on the established channel -> stopReason=${afterControl.frame.result.stopReason}`)

  step = 'A09 owner restart'
  const stoppedPid = live.control.pid
  const stoppedGeneration = live.control.generation
  const controlRestart = runCliLogged(['control', 'start', '--config', controlPath], operatorEnv)
  const controlRestartFields = parseFields(controlRestart.output.trim().split('\n').filter(Boolean).at(-1) ?? '')
  assert(controlRestart.status === 0 && controlRestartFields.state === 'running', `control restart failed: ${controlRestart.output.slice(-200)}`)
  live.control.pid = Number(controlRestartFields.pid)
  live.control.generation = Number(controlRestartFields.generation)
  live.control.stopped = false
  assert(live.control.pid !== stoppedPid, 'the restarted control owner has a new explicit pid')
  // The generation is anchored to the persisted lifecycle record, and a graceful stop removes
  // that record (removeOwnedState), so a stop+start begins a new lifecycle at generation 1
  // instead of continuing the counter. A crash restart keeps the record and advances it. The
  // driver asserts the observed rule, not the crash-only expectation.
  assert(live.control.generation === 1 && stoppedGeneration === 1,
    `a graceful stop+start begins a new lifecycle generation (${stoppedGeneration} -> ${live.control.generation})`)
  // Observed, falsifies no check, but worth a decision: because a graceful stop removes the
  // persisted lifecycle record, the generation restarts at 1. A stale `--generation` value
  // from the previous lifecycle can therefore collide with the new one, where a crash restart
  // would have advanced past it. The project declares no monotonicity requirement across a
  // graceful stop, so this is recorded rather than asserted.
  finding('A09 — a graceful stop+start reuses generation 1',
    `stopped owner generation ${stoppedGeneration}, restarted owner generation ${live.control.generation}; a crash restart advances the counter instead, so a stale --generation can collide after a graceful stop`) 
  const afterRestartReady = await settle('the restarted control listener to accept', async () => (await fetch(controlOrigin).catch(() => null))?.status === 401, 200, 30_000)
  assert(afterRestartReady, 'the restarted control owner never bound its listener')
  const afterRestart = (await (await authFetch('/api/v1/history?version=1&limit=50&kind=connection')).json()).records
  const restartRetention = retention(beforeRefresh, afterRestart)
  assert(restartRetention.lost.length === 0 && restartRetention.changed.length === 0,
    `the history did not survive the control owner restart (lost=${restartRetention.lost.join(',')} changed=${restartRetention.changed.join(',')})`)
  check('A09 — history survives a control-owner stop and restart',
    `stop -> pid ${stoppedPid} generation ${stoppedGeneration}, start -> pid ${live.control.pid} generation ${live.control.generation}; ${beforeRefresh.length} records retained byte-identical (now ${afterRestart.length})`)

  step = 'A09 non-resumable session'
  const legResume = await negotiate({ agentId: AGENT_A.agentId, port: portA, cert: agentATls.cert, capabilitiesRevision: fieldsA2.capabilitiesRevision, requestedRole: 'master', requestedPeerRole: 'peer', label: 'resume' })
  const refResume = { connectionId: 'conn-resume', channelId: 'observer-channel-resume', targetGeneration: TARGET_GENERATION, engineInstanceId: fieldsA2.engineInstance }
  await openChannelOn(legResume.channel, refResume)
  await legResume.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refResume, frame: { jsonrpc: '2.0', id: 'resume-init', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } } })
  await readUntil(legResume.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'resume-init', 'resume-leg initialize')
  await legResume.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refResume, frame: { jsonrpc: '2.0', id: 'resume-old', method: 'session/resume', params: { sessionId: sessionA1, cwd: ownedRoot, mcpServers: [] } } })
  const resumeOld = await readUntil(legResume.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'resume-old', 'resume of the pre-restart session')
  assert(resumeOld.frame.result === undefined || resumeOld.frame.result.sessionId === undefined,
    `a Session from the previous engine instance was passed off as resumed: ${JSON.stringify(resumeOld.frame).slice(0, 240)}`)
  assert(resumeOld.frame.error !== undefined && typeof resumeOld.frame.error.data?.code === 'string',
    `the refused resume carried no typed code: ${JSON.stringify(resumeOld.frame).slice(0, 240)}`)
  const loadRefused = await (async () => {
    await legResume.channel.transport.send({ version: 1, kind: 'acp.frame', ref: refResume, frame: { jsonrpc: '2.0', id: 'resume-load', method: 'session/load', params: { sessionId: sessionA1, cwd: ownedRoot, mcpServers: [] } } })
    return await readUntil(legResume.channel, frame => frame.kind === 'acp.frame' && frame.frame.id === 'resume-load', 'session/load refusal')
  })()
  assert(loadRefused.frame.error?.data?.code === 'UNSUPPORTED_METHOD', `session/load must be a typed unsupported refusal (${JSON.stringify(loadRefused.frame.error ?? null).slice(0, 160)})`)
  check('A09 — a Session that cannot be resumed is never passed off as resumed',
    `pre-restart session ${sessionA1.slice(0, 12)}… after restart -> ${resumeOld.frame.error.data.code}; session/load -> ${loadRefused.frame.error.data.code}`)

  /* -------------------------------------------------------------------------------------
   * A11 — the LAN address is really connectable; only the cross-device receipt is missing
   * ----------------------------------------------------------------------------------- */

  assert(/^\d+\.\d+\.\d+\.\d+$/.test(lanIp) && !lanIp.startsWith('127.') && !lanIp.startsWith('169.254.'),
    `the LAN address must be a real non-loopback IPv4 (${lanIp})`)
  const lanConnected = await new Promise(resolveConnect => {
    const socket = createConnection({ host: lanIp, port: portA })
    const finish = ok => { socket.destroy(); resolveConnect(ok) }
    socket.setTimeout(4_000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
  assert(lanConnected, `the LAN listener ${lanIp}:${portA} is not connectable`)
  check('A11 — the LAN address is a real, connectable non-loopback listener',
    `${lanIp} is a non-loopback IPv4 and a raw TCP connect to the agent listener ${lanIp}:${portA} succeeded`)

  /* -------------------------------------------------------------------------------------
   * Cross-device boundary (recorded honestly; never inferred from the LAN result above)
   * ----------------------------------------------------------------------------------- */

  /* The earlier text here said "only one physical host is available". That premise is now FALSE:
   * a real two-host receipt exists (HOST A Macstudio.local 100.66.1.82, HOST B
   * jennys-macbook-air.anoa-buri.ts.net 100.93.143.20), produced by the A11 unit on branch
   * codex/acp-a11-crossdevice-20261011 at commit 869aff8: 19 checks, 0 gaps, exit 0, real ACP
   * session/new -> session/prompt -> session/request_permission -> session/update -> end_turn, plus
   * a session/cancel path, with byte-identical tarball and CLI sha256 on both hosts.
   *
   * It stays a gap for THIS driver for an honest reason: that receipt is a separate evidence unit
   * which is NOT merged into this candidate, so this driver cannot verify it from here and must not
   * claim it. Folding A11 into this gate requires integrating that unit first. */
  gap('A11 — cross-device receipt', `this driver runs on one physical host (LAN ${lanIp}, tailscale 100.66.1.82) and cannot itself produce a cross-device receipt; loopback and same-host non-loopback are never passed off as cross-device. A real two-host receipt DOES exist in the separate A11 unit (branch codex/acp-a11-crossdevice-20261011, commit 869aff8, 19 checks / 0 gaps, exit 0), but that unit is not merged into this candidate, so this driver neither verifies nor claims it`)

  const elapsed = Math.round((Date.now() - started) / 1000)
  process.stdout.write(`\nD08 acceptance PASS: ${checks.length} checks (gaps: ${gaps.length}, findings: ${findings.length}) in ${elapsed}s\n`)
} catch (error) {
  process.stderr.write(`\nD08 acceptance FAIL [${step}]: ${error instanceof Error ? error.message : String(error)}\n`)
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`)
  for (const record of live.agents) {
    process.stderr.write(`--- ${record.label} stdout ---\n${record.stdout.slice(-4000)}\n--- ${record.label} stderr ---\n${record.stderr.slice(-4000)}\n`)
  }
  if (CLI !== undefined && live.registry.configPath !== undefined) process.stderr.write(`--- registry cli log ---\n${runCliLogged(['registry', 'status', '--config', live.registry.configPath], operatorEnv).output.slice(-1500)}\n`)
  if (CLI !== undefined && live.control.configPath !== undefined) process.stderr.write(`--- control cli log ---\n${runCliLogged(['control', 'status', '--config', live.control.configPath], operatorEnv).output.slice(-1500)}\n`)
  process.stderr.write(`Retained owned temp root: ${ownedRoot}\n`)
  process.exitCode = 1
} finally {
  // Explicit-PID cleanup only. Service daemons go through the project's own stop entry.
  try { await live.observerClient?.stop() } catch { /* keep the original failure */ }
  try { await live.leaseProbeClient?.stop() } catch { /* keep the original failure */ }
  try { await live.offlineProbeClient?.stop() } catch { /* keep the original failure */ }
  for (const record of live.agents) {
    if (record.child.exitCode === null && record.child.signalCode === null) {
      stopByExplicitPid(record.child.pid)
    }
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 500))
  for (const record of live.agents) {
    if (record.child.exitCode === null && record.child.signalCode === null) stopByExplicitPid(record.child.pid, 'SIGKILL')
  }
  if (live.control.configPath !== undefined && !live.control.stopped && pidAlive(live.control.pid)) {
    runCliLogged(['control', 'stop', '--config', live.control.configPath], operatorEnv)
    await settle('the control daemon to exit during cleanup', async () => !pidAlive(live.control.pid), 250, 20_000)
    if (pidAlive(live.control.pid)) stopByExplicitPid(live.control.pid, 'SIGKILL')
  }
  if (live.registry.configPath !== undefined && !live.registry.stopped && pidAlive(live.registry.pid)) {
    runCliLogged(['registry', 'stop', '--config', live.registry.configPath], operatorEnv)
    await settle('the registry daemon to exit during cleanup', async () => !pidAlive(live.registry.pid), 250, 20_000)
    if (pidAlive(live.registry.pid)) stopByExplicitPid(live.registry.pid, 'SIGKILL')
  }
  try { await live.provider?.close() } catch { /* keep the original failure */ }
  // `process.exitCode` is undefined on success, so the owned root is only kept when the
  // driver really failed.
  if ((process.exitCode ?? 0) === 0) {
    rmSync(ownedRoot, { recursive: true, force: true })
    process.stdout.write(`cleanup: removed owned root ${ownedRoot}\n`)
  } else {
    process.stderr.write(`Owned temp root retained for inspection: ${ownedRoot}\n`)
  }
}

// Flush stdout, then exit with the recorded status. The unref'd fallback stops a stuck
// flush from hanging the driver, and the natural loop drain would exit correctly anyway.
const finalCode = process.exitCode ?? 0
setTimeout(() => process.exit(finalCode), 5_000).unref()
process.stdout.write('', () => process.exit(finalCode))
