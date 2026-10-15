#!/usr/bin/env node
/**
 * L11 installed-artifact live-browser DOM evidence producer.
 *
 * The project already had a real-Chrome DOM run, but it drove the WebUI served from the
 * SOURCE worktree (`docs/evidence/acp-d08-browser-20261011/live-browser-dom.mjs`). The
 * remaining evidence gap is the same observation at the INSTALLED-ARTIFACT level. This
 * producer closes that gap and nothing else.
 *
 * What this producer does:
 *   1. runs the project's own producer `pnpm build:governance`
 *      (`pnpm build && node scripts/package-artifact.mjs --mode final`) and asserts the
 *      staged package receipt;
 *   2. `npm pack`s the staged package and `npm install`s the tarball into an isolated prefix
 *      outside the source tree;
 *   3. starts the registry, one real `--serve opencode` agent daemon (the real installed
 *      OpenCode engine behind a local OpenAI-compatible stub) and the control daemon, ALL
 *      from the INSTALLED CLI, with the real TLS material the documented command produces.
 *      Every listener is loopback: the LAN two-engine and cross-device claims stay with
 *      their own evidence units and are not restated here;
 *   4. reads the control daemon's own state file to prove the running daemon's recorded
 *      entry path is inside the installed package;
 *   5. launches real Chrome with its own throw-away `--user-data-dir`, injects the Basic
 *      credential at the NETWORK layer with `Network.setExtraHTTPHeaders`, and navigates to
 *      a CLEAN origin URL (no userinfo);
 *   6. reads the LIVE DOM of the installed console entry, the page's OWN authenticated
 *      fetch, the page's OWN EventSource subscription, and a real SSE frame;
 *   7. proves the document and every `/ui/*` module the browser received are byte-identical
 *      to the files the installed package contains;
 *   8. captures a real PNG screenshot into this evidence directory.
 *
 * Evidence boundary: this proves the installed package serves the frozen D07 console to a
 * real browser whose page fetches, subscribes and renders from that origin. It does NOT
 * prove restart, deployed-entrypoint replay, cross-device behaviour, mobile layout, or any
 * control-daemon Session/permission write (those owners stay unbound).
 *
 * Usage: node docs/evidence/acp-l11-installed-browser-20261014/installed-browser-dom.mjs
 * Env:   CHROME_BIN (optional Chrome/Chromium executable override)
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(evidenceDirectory, '..', '..', '..')
const RECEIPT_PATH = join(evidenceDirectory, 'receipt.json')
const SCREENSHOT_PATH = join(evidenceDirectory, 'installed-browser-dom.png')
const LOG_EVIDENCE_PATH = join(evidenceDirectory, 'installed-browser-dom.log')

const CONSOLE_USERNAME = 'teams'
const CONSOLE_PASSWORD_ENV = 'L11_CONSOLE_PASSWORD'
const CONSOLE_PASSWORD = `l11-installed-${randomUUID()}`
const BASIC = `Basic ${Buffer.from(`${CONSOLE_USERNAME}:${CONSOLE_PASSWORD}`).toString('base64')}`
const AUTH_CHALLENGE = 'Basic realm="AgentTeams", charset="UTF-8"'
const PAGE_NAMES = ['discovery', 'networking', 'interaction', 'history']
const BAND_LABELS = ['registration', 'connection', 'engine', 'request']

const ACCOUNT = 'local'
const SCOPE = 'local'
const AGENT_ID = 'reasoner-a'
const CONTROL_ID = 'control-a'
const REGISTRY_ID = 'lan-registry'
const PROBE_MODEL = 'probe-model'
const CREDENTIALS = { a: 'Bearer l11-installed-agent-a-secret', control: 'Bearer l11-installed-control-secret' }
const OPENCODE_EXECUTABLE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'

/* ---------------------------------------------------------------------------------------
 * Reporting
 * ------------------------------------------------------------------------------------- */

const checks = []
const measurements = {}
let step = 'startup'
let liveLogPath
let logDescriptor

function emit(line) {
  process.stdout.write(`${line}\n`)
  if (logDescriptor !== undefined) {
    try { writeFileSync(logDescriptor, `${line}\n`, { flag: 'a' }) } catch { /* the log is best effort */ }
  }
}

function check(name, detail) {
  checks.push({ name, detail })
  emit(`PASS ${name} — ${detail}`)
}

function note(message) {
  emit(`  -- ${message}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/* ---------------------------------------------------------------------------------------
 * Process and filesystem helpers
 * ------------------------------------------------------------------------------------- */

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function stopByExplicitPid(pid, signal = 'SIGTERM') {
  if (!pidAlive(pid)) return
  try { process.kill(pid, signal) } catch { /* the process is already gone */ }
}

function processTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return (result.stdout ?? '').split('\n').map(line => line.trim()).filter(line => line.length > 0).map(line => {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? null : { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
  }).filter(row => row !== null)
}

function childrenOf(pid) {
  return processTable().filter(row => row.ppid === pid).map(row => row.pid)
}

function commandOf(pid) {
  return processTable().find(row => row.pid === pid)?.command
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

async function settle(label, predicate, intervalMs = 200, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await predicate()) return true } catch { /* a transient poll failure must not consume a later real observation */ }
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  note(`settle timed out: ${label}`)
  return false
}

/** Readiness values may contain spaces, so split on `key=` boundaries. */
function parseFields(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) fields[match[1]] = match[2].trim()
  return fields
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const executable = candidates.find(candidate => candidate !== undefined && candidate.length > 0 && existsSync(candidate))
  assert(executable !== undefined, 'no Chrome/Chromium executable was found; set CHROME_BIN to the real binary')
  return executable
}

function sha256(bytes) {
  return spawnSync('shasum', ['-a', '256'], { input: bytes, encoding: 'utf8' }).stdout.trim().split(/\s+/)[0]
}

/* ---------------------------------------------------------------------------------------
 * Owned temp root
 * ------------------------------------------------------------------------------------- */

const ownedRoot = mkdtempSync(join(tmpdir(), 'l11-installed-browser-'))
const prefixRoot = join(ownedRoot, 'prefix')
const cliLogDirectory = join(ownedRoot, 'cli-logs')
const tlsDirectory = join(ownedRoot, 'tls')
const packDirectory = join(ownedRoot, 'pack')
const chromeProfileDirectory = join(ownedRoot, 'chrome-profile')
for (const directory of [prefixRoot, cliLogDirectory, tlsDirectory, packDirectory]) mkdirSync(directory, { recursive: true })

const live = {
  prefixRoot,
  installedRoot: undefined,
  cli: undefined,
  cliRoot: undefined,
  artifactReceipt: undefined,
  chromePid: undefined,
  chromeChild: undefined,
  registryPid: undefined,
  registryStopped: false,
  agentChild: undefined,
  agentPid: undefined,
  agentEnginePids: [],
  controlPid: undefined,
  controlStopped: false,
  provider: undefined,
  cdp: undefined,
  session: undefined,
}

let cliRunCounter = 0

function runCliLogged(args, env = {}, timeoutMs = 120_000) {
  cliRunCounter += 1
  const logPath = join(cliLogDirectory, `cli-${cliRunCounter}.log`)
  const descriptor = openSync(logPath, 'a')
  try {
    // `control start` spawns a detached child that inherits stdio, so a pipe would keep the
    // call blocked until that child exits. A plain file avoids it.
    const result = spawnSync(process.execPath, [live.cli, ...args], {
      cwd: live.cliRoot, env: { ...process.env, ...env }, stdio: ['ignore', descriptor, descriptor], timeout: timeoutMs,
    })
    return { status: result.status, output: readFileSync(logPath, 'utf8') }
  } finally {
    closeSync(descriptor)
  }
}

/* ---------------------------------------------------------------------------------------
 * Artifact staging and isolated install
 * ------------------------------------------------------------------------------------- */

function stageAndInstall() {
  step = 'artifact staging'
  // `scripts/package-artifact.mjs` refuses a candidate with untracked product paths or
  // unstaged product diffs (`scripts/receipt-identity.mjs`). This driver stages its OWN
  // evidence directory — never any other path. It never commits, resets, checks out or
  // stashes anything.
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
  const buildLog = join(cliLogDirectory, 'build-governance.log')
  const buildDescriptor = openSync(buildLog, 'a')
  let build
  try {
    build = spawnSync('pnpm', ['build:governance'], {
      cwd: repositoryRoot, env: process.env, stdio: ['ignore', buildDescriptor, buildDescriptor], timeout: 1_800_000,
    })
  } finally {
    closeSync(buildDescriptor)
  }
  const buildOutput = readFileSync(buildLog, 'utf8')
  assert(build.status === 0, `pnpm build:governance exited ${build.status}: ${buildOutput.slice(-1500)}`)

  const receiptPath = join(repositoryRoot, 'generated', 'modules', 'teams-source', 'package-receipt.json')
  assert(existsSync(receiptPath), `the producer wrote no artifact receipt at ${receiptPath}`)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  live.artifactReceipt = receipt
  assert(receipt.mode === 'final', `the artifact mode is ${JSON.stringify(receipt.mode)}, not "final"`)
  assert(receipt.release_eligible === false, `the artifact release_eligible is ${JSON.stringify(receipt.release_eligible)}, not false`)
  assert(typeof receipt.content_sha256 === 'string' && /^[0-9a-f]{64}$/.test(receipt.content_sha256),
    `the artifact content_sha256 is not a 64-hex digest: ${JSON.stringify(receipt.content_sha256)}`)
  const fileCount = Array.isArray(receipt.files) ? receipt.files.length : undefined
  assert(receipt.candidate?.indexed_tree_hash !== undefined, 'the artifact receipt carries no candidate identity')
  check('installed artifact — staged package',
    `pnpm build:governance staged mode=${receipt.mode} release_eligible=${receipt.release_eligible} content_sha256=${receipt.content_sha256} files=${fileCount ?? 'unreported'}`)

  step = 'npm pack'
  const stagedRoot = join(repositoryRoot, 'generated', 'modules', 'teams-source', 'lib')
  assert(existsSync(stagedRoot), `the staged package root is missing: ${stagedRoot}`)
  const packed = spawnSync('npm', ['pack', stagedRoot, '--pack-destination', packDirectory, '--json'], { encoding: 'utf8', timeout: 600_000 })
  assert(packed.status === 0, `npm pack failed: ${packed.stderr || packed.stdout}`)
  let packReport
  try { packReport = JSON.parse(packed.stdout) } catch (error) { throw new Error(`npm pack reported unparseable JSON: ${packed.stdout.slice(0, 300)}`) }
  assert(Array.isArray(packReport) && packReport.length === 1 && typeof packReport[0].filename === 'string',
    `npm pack reported no single tarball: ${packed.stdout.slice(0, 300)}`)
  const tarball = join(packDirectory, packReport[0].filename)
  assert(existsSync(tarball), `the packed tarball is missing: ${tarball}`)
  const tarballBytes = statSync(tarball).size

  step = 'npm install'
  const installed = spawnSync('npm', ['install', '--prefix', prefixRoot, '--no-audit', '--no-fund', '--loglevel', 'error', tarball],
    { encoding: 'utf8', timeout: 1_800_000 })
  assert(installed.status === 0, `npm install failed: ${installed.stderr || installed.stdout}`)

  live.installedRoot = join(prefixRoot, 'node_modules', 'agentteams')
  live.cli = join(live.installedRoot, 'cli', 'agentteams.mjs')
  live.cliRoot = live.installedRoot
  assert(existsSync(live.cli), `the installed CLI is missing: ${live.cli}`)
  const installedReal = realpathSync(live.installedRoot)
  const sourceReal = realpathSync(repositoryRoot)
  assert(!installedReal.startsWith(`${sourceReal}/`), `the installed root resolves inside the source tree: ${installedReal}`)
  check('installed artifact — isolated install',
    `npm pack ${packReport[0].filename} (${tarballBytes} bytes) + npm install --prefix ${prefixRoot.replace(`${ownedRoot}/`, '')}; installed root=${installedReal} cli=${realpathSync(live.cli)}`)

  const installedFiles = [
    'cli/agentteams.mjs',
    'generated/runtime-lib/runtime/control-process.js',
    'generated/runtime-lib/runtime/acp-serve.js',
    'console-host/static/console.html',
    'console-host/static/console-entry.js',
    'ui/teams-console/browser.js',
  ]
  const missing = installedFiles.filter(relative => !existsSync(join(live.installedRoot, relative)))
  assert(missing.length === 0, `the installed package is missing compiled runtime or UI assets: ${missing.join(', ')}`)
  check('installed artifact — carries the compiled runtime and the UI assets',
    `present in the installed package: ${installedFiles.join(', ')}`)
}

/* ---------------------------------------------------------------------------------------
 * Real TLS material and the local OpenAI-compatible stub provider
 * ------------------------------------------------------------------------------------- */

function generateTls(directory, name, sanIp) {
  const keyPath = join(directory, `${name}-key.pem`)
  const certPath = join(directory, `${name}-cert.pem`)
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=IP:${sanIp},DNS:localhost,IP:127.0.0.1`,
    '-keyout', keyPath, '-out', certPath], { encoding: 'utf8' })
  assert(result.status === 0, `openssl TLS generation failed: ${result.stderr}`)
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

/** Local OpenAI-compatible stub. The installed engine child needs a reachable model provider. */
function startStubProvider() {
  const calls = []
  const requestServer = createHttpServer((request, response) => {
    response.on('error', () => undefined)
    request.on('error', () => undefined)
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      let parsed
      try { parsed = JSON.parse(body) } catch { response.writeHead(400).end(); return }
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '').filter(name => name.length > 0)
      calls.push({ model: parsed.model ?? '', toolNames, text: lastUserText(parsed) })
      const model = parsed.model ?? PROBE_MODEL
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-l11', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-l11', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-l11', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'L11-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (toolNames.length === 0) {
        response.write(chunk({ role: 'assistant', content: 'l11' }))
        response.write(finish); response.end('data: [DONE]\n\n'); return
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const toolResults = messages.filter(message => message?.role === 'tool').length
      if (toolResults > 0) {
        response.write(chunk({ role: 'assistant', content: 'L11-TOOL-DONE' }))
        response.write(finish); response.end('data: [DONE]\n\n'); return
      }
      response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_l11_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/etc/hosts' }) } }] }))
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise(resolveStart => {
    requestServer.listen(0, '127.0.0.1', () => {
      resolveStart({
        baseUrl: `http://127.0.0.1:${requestServer.address().port}/v1`,
        calls,
        close: () => new Promise(resolveClose => { requestServer.closeAllConnections?.(); requestServer.close(() => resolveClose()) }),
      })
    })
  })
}

/* ---------------------------------------------------------------------------------------
 * DevTools Protocol client
 * ------------------------------------------------------------------------------------- */

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
  return { send, events, close: () => { try { socket.close() } catch { /* the socket is already closed */ } } }
}

async function evaluate(cdp, session, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, session)
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.text ?? ''} ${result.exceptionDetails.exception?.description ?? ''}`.trim())
  }
  return result.result?.value
}

/** The real request/response table the browser itself observed. */
function networkTable(events) {
  const requests = new Map()
  for (const event of events) {
    if (event.method === 'Network.requestWillBeSent') {
      requests.set(event.params.requestId, {
        url: event.params.request.url, type: event.params.type, method: event.params.request.method, status: undefined, mimeType: undefined,
      })
    }
    if (event.method === 'Network.responseReceived') {
      const record = requests.get(event.params.requestId) ?? { url: event.params.response.url, type: event.params.type, method: 'GET' }
      record.status = event.params.response.status
      record.mimeType = event.params.response.mimeType
      requests.set(event.params.requestId, record)
    }
  }
  return requests
}

function requestIdFor(requests, predicate) {
  for (const [requestId, record] of requests) if (predicate(record)) return requestId
  return undefined
}

async function responseBody(cdp, session, requestId) {
  const body = await cdp.send('Network.getResponseBody', { requestId }, session)
  return body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8')
}

/** Every attribute the frozen D07 marker set uses, read from the live document. */
const DOM_INVENTORY = `(() => {
  const attribute = name => document.querySelector('[' + name + ']')?.getAttribute(name) ?? null
  const attributes = name => [...document.querySelectorAll('[' + name + ']')].map(node => node.getAttribute(name))
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    pageNames: attributes('data-team-page'),
    pageView: attribute('data-team-page-view'),
    bands: attributes('data-team-band'),
    bandStates: attributes('data-band-state'),
    observation: attribute('data-team-observation'),
    cancel: attribute('data-team-cancel'),
    historyCount: attribute('data-history-count'),
    historyPrevEnabled: attribute('data-history-prev') === null ? null : document.querySelector('[data-history-prev]')?.getAttribute('data-enabled') ?? null,
    historyRecords: attributes('data-history-record'),
    permissionOptions: attributes('data-permission-option'),
    agentRows: attributes('data-agent-id'),
    connectionRows: attributes('data-connection-id'),
    bodyText: document.body.innerText.replace(/\\\\n+/g, ' | ').slice(0, 240),
  }
})()`

/* ---------------------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------------------- */

function admission(admissionRef, agentId, envName) {
  return `
[[admissions]]
admissionRef = ${JSON.stringify(admissionRef)}
agentId = ${JSON.stringify(agentId)}
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
credentialRef = "env:${envName}"
`
}

function registryConfig({ dataDirectory, port, certPath, keyPath }) {
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
${admission('adm-a', AGENT_ID, 'L11_CRED_A')}${admission('adm-control', CONTROL_ID, 'L11_CRED_CONTROL')}`
}

function agentConfig({ dataDirectory, ip, port, certPath, keyPath, trustPath, registryPort, workspace, providerBaseUrl }) {
  return `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(AGENT_ID)}
hostId = "host-lan"
accountId = ${JSON.stringify(ACCOUNT)}
scopeId = ${JSON.stringify(SCOPE)}
dataDirectory = ${JSON.stringify(dataDirectory)}

[engine]
kind = "opencode"
executable = ${JSON.stringify(OPENCODE_EXECUTABLE)}
workspace = ${JSON.stringify(workspace)}

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

[discovery]
serverId = ${JSON.stringify(REGISTRY_ID)}
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:L11_CRED_A"
tlsTrustRef = "file:${trustPath}"

[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(providerBaseUrl)}
label = "L11 probe provider"
enabled = true
credentialEnv = "L11_PROBE_API_KEY"

[[models]]
provider = "probe"
id = ${JSON.stringify(PROBE_MODEL)}

[model.primary]
provider = "probe"
model = ${JSON.stringify(PROBE_MODEL)}
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
credentialRef = "env:L11_CRED_CONTROL"
tlsTrustRef = "file:${trustPath}"
`
}

/* ---------------------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------------------- */

const operatorEnv = {
  L11_CRED_A: CREDENTIALS.a,
  L11_CRED_CONTROL: CREDENTIALS.control,
  L11_PROBE_API_KEY: 'l11-probe-secret-value',
  [CONSOLE_PASSWORD_ENV]: CONSOLE_PASSWORD,
}
let failure

async function run() {
  stageAndInstall()

  step = 'daemon material'
  note(`installedRoot=${live.installedRoot}`)
  note(`ownedRoot=${ownedRoot}`)
  // Every listener here is loopback. The LAN two-engine and cross-device claims stay with
  // their own evidence units; this unit proves the INSTALLED artifact and the live browser.
  const registryTls = generateTls(tlsDirectory, 'registry', '127.0.0.1')
  const agentTls = generateTls(tlsDirectory, 'agent-a', '127.0.0.1')
  // Each dialing daemon trusts the real certificate of the daemon it dials: the agent dials
  // the registry and the control daemon dials the registry too, so both trust the registry.
  const registryTrustPath = registryTls.certPath

  const provider = await startStubProvider()
  live.provider = provider

  step = 'daemon configs'
  const registryPort = await availablePort('127.0.0.1')
  const controlPort = await availablePort('127.0.0.1')
  const agentPort = await availablePort('127.0.0.1')
  const registryData = join(ownedRoot, 'registry-state')
  const agentData = join(ownedRoot, 'agent-state')
  const controlData = join(ownedRoot, 'control-state')
  const workspace = join(ownedRoot, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const registryPath = join(ownedRoot, 'registry.toml')
  const agentPath = join(ownedRoot, 'agent.toml')
  const controlPath = join(ownedRoot, 'control.toml')
  writeFileSync(registryPath, registryConfig({ dataDirectory: registryData, port: registryPort, certPath: registryTls.certPath, keyPath: registryTls.keyPath }))
  writeFileSync(agentPath, agentConfig({
    dataDirectory: agentData, ip: '127.0.0.1', port: agentPort, certPath: agentTls.certPath, keyPath: agentTls.keyPath,
    trustPath: registryTrustPath, registryPort, workspace, providerBaseUrl: provider.baseUrl,
  }))
  writeFileSync(controlPath, controlConfig({ dataDirectory: controlData, port: controlPort, registryPort, trustPath: registryTrustPath }))

  step = 'registry start'
  const registryStart = runCliLogged(['registry', 'start', '--config', registryPath], operatorEnv)
  const registryFields = parseFields(registryStart.output.trim().split('\n').filter(Boolean).at(-1) ?? '')
  assert(registryStart.status === 0, `registry start exited ${registryStart.status}: ${registryStart.output.slice(-500)}`)
  assert(registryFields.state === 'running', `the registry did not report running: ${registryStart.output.slice(-300)}`)
  live.registryPid = Number(registryFields.pid)
  assert(pidAlive(live.registryPid), `the registry pid ${live.registryPid} is not alive`)

  step = 'agent start'
  const agentChild = spawn(process.execPath, [live.cli, '--serve', 'opencode', '--ip', '127.0.0.1', '--port', String(agentPort), '--config', agentPath], {
    cwd: live.cliRoot, env: { ...process.env, ...operatorEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  live.agentChild = agentChild
  live.agentPid = agentChild.pid
  let agentOutput = ''
  agentChild.stdout.on('data', chunk => { agentOutput += chunk.toString('utf8') })
  agentChild.stderr.on('data', chunk => { agentOutput += chunk.toString('utf8') })
  assert(Number.isInteger(live.agentPid) && live.agentPid > 0, 'the agent daemon did not report a pid')
  const agentReady = await settle('the installed agent daemon to serve', async () => agentOutput.includes('serving '), 500, 180_000)
  assert(agentReady, `the installed agent daemon never reported serving; output: ${agentOutput.slice(-600)}`)
  live.agentEnginePids = childrenOf(live.agentPid)

  step = 'control start'
  const controlStart = runCliLogged(['control', 'start', '--config', controlPath], operatorEnv)
  const controlFields = parseFields(controlStart.output.trim().split('\n').filter(Boolean).at(-1) ?? '')
  assert(controlStart.status === 0, `control start exited ${controlStart.status}: ${controlStart.output.slice(-500)}`)
  assert(controlFields.state === 'running', `the control daemon did not report running: ${controlStart.output.slice(-300)}`)
  live.controlPid = Number(controlFields.pid)
  assert(pidAlive(live.controlPid), `the control pid ${live.controlPid} is not alive`)
  assert(controlFields.listener === `127.0.0.1:${controlPort}`, `the control daemon bound ${controlFields.listener}`)
  check('installed daemons — registry, agent, control all from the installed CLI',
    `registry pid=${live.registryPid} (127.0.0.1:${registryPort}); agent pid=${live.agentPid} (127.0.0.1:${agentPort}, engine children=${live.agentEnginePids.length}); control pid=${live.controlPid} (127.0.0.1:${controlPort}); all launched from ${realpathSync(live.cli)}`)

  step = 'installed provenance'
  // `control start` re-executes the daemon as a detached child of the installed compiled
  // runtime entry, so the measurable provenance fact is the running process's own command
  // line and the entry path it records, both of which must resolve inside the install.
  const sourceReal = realpathSync(repositoryRoot)
  const installedReal = realpathSync(live.installedRoot)
  // macOS reports the same install under two spellings: the daemon re-executed by Node
  // carries the realpath (`/private/var/...`) while the CLI this driver spawned carries the
  // path it was given (`/var/...`). Both spellings name the same install.
  const installSpellings = [live.installedRoot, installedReal]
  const inInstall = command => installSpellings.some(spelling => command.includes(spelling))
  // Every Teams daemon this producer started is inspected by its own command line. Chrome is
  // deliberately excluded: it is not part of the installed package, so its command line cannot
  // and must not resolve inside the install.
  const daemonCommands = {
    registry: commandOf(live.registryPid) ?? '',
    agent: commandOf(live.agentPid) ?? '',
    control: commandOf(live.controlPid) ?? '',
  }
  for (const [name, command] of Object.entries(daemonCommands)) {
    assert(inInstall(command), `the ${name} daemon command line does not resolve inside the installed root: ${command}`)
    assert(!command.includes(sourceReal), `the ${name} daemon command line names the source tree: ${command}`)
  }
  measurements.daemonCommands = daemonCommands
  const controlCommand = daemonCommands.control
  const agentCommand = daemonCommands.agent
  const statePath = join(controlData, 'control-state.json')
  const stateReady = await settle('the control daemon state file', async () => existsSync(statePath), 200, 15_000)
  assert(stateReady, `the control daemon wrote no state file at ${statePath}`)
  const controlState = JSON.parse(readFileSync(statePath, 'utf8'))
  const stateEntryReal = typeof controlState.entryPath === 'string' ? realpathSync(controlState.entryPath) : ''
  assert(stateEntryReal.startsWith(installedReal),
    `the control daemon state records entryPath=${controlState.entryPath}, which is not inside ${installedReal}`)
  assert(!realpathSync(controlState.entryPath).startsWith(`${sourceReal}/`),
    'the control daemon state records the SOURCE runtime entry')
  measurements.controlEntryPath = realpathSync(controlState.entryPath)
  check('installed provenance — the running daemons are the installed copy',
    `every Teams daemon command line was inspected and resolves inside the install: registry pid=${live.registryPid}, agent pid=${live.agentPid}, control pid=${live.controlPid}; the control daemon's own state entryPath=${measurements.controlEntryPath}; none of those three command lines names the source tree (Chrome is excluded: it is not part of the installed package)`)

  step = 'origin challenge'
  const controlOrigin = `http://127.0.0.1:${controlPort}`
  const anonymous = await fetch(controlOrigin).catch(() => null)
  assert(anonymous !== null && anonymous.status === 401, `an unauthenticated GET / returned ${anonymous?.status}`)
  const challenge = anonymous.headers.get('www-authenticate') ?? ''
  assert(challenge === AUTH_CHALLENGE, `the anonymous challenge is ${challenge}`)
  await anonymous.body?.cancel().catch(() => undefined)
  check('origin challenge', `the installed origin answered an anonymous GET / with 401 challenge="${challenge}"`)

  step = 'independent projection'
  const independentProjectionResponse = await fetch(`${controlOrigin}/api/v1/projection`, { headers: { authorization: BASIC, accept: 'application/json' } })
  assert(independentProjectionResponse.status === 200, `an independent GET /api/v1/projection returned ${independentProjectionResponse.status}`)
  const independentProjectionText = await independentProjectionResponse.text()
  const independentProjection = JSON.parse(independentProjectionText)
  assert(Array.isArray(independentProjection.agents), 'the independent projection carries no agents array')
  const agentRowVisible = await settle('the control directory to publish the registered agent', async () => {
    const response = await fetch(`${controlOrigin}/api/v1/projection`, { headers: { authorization: BASIC, accept: 'application/json' } })
    const body = JSON.parse(await response.text())
    return (body.agents ?? []).some(agent => agent.agentId === AGENT_ID)
  }, 1000, 120_000)
  assert(agentRowVisible, `the control directory never published the registered agent ${AGENT_ID}`)

  step = 'served asset provenance'
  // The three assets the browser will receive, compared with the files the INSTALLED package
  // contains. The installed package serves `ui/teams-console/browser.js` (staged layout).
  const servedAssets = [
    { path: '/console-entry.js', relative: 'console-host/static/console-entry.js' },
    { path: '/ui/browser.js', relative: 'ui/teams-console/browser.js' },
  ]
  const assetFacts = []
  for (const asset of servedAssets) {
    const response = await fetch(`${controlOrigin}${asset.path}`, { headers: { authorization: BASIC } })
    assert(response.status === 200, `GET ${asset.path} returned ${response.status}`)
    const served = Buffer.from(await response.arrayBuffer())
    const installedBytes = readFileSync(join(live.installedRoot, asset.relative))
    const servedDigest = sha256(served)
    const installedDigest = sha256(installedBytes)
    assert(servedDigest === installedDigest,
      `the served ${asset.path} (${servedDigest}, ${served.length} bytes) is not the installed ${asset.relative} (${installedDigest}, ${installedBytes.length} bytes)`)
    assetFacts.push({ path: asset.path, relative: asset.relative, sha256: servedDigest, bytes: served.length })
  }
  const documentResponse = await fetch(`${controlOrigin}/`, { headers: { authorization: BASIC } })
  assert(documentResponse.status === 200, `GET / returned ${documentResponse.status}`)
  const documentBytes = Buffer.from(await documentResponse.arrayBuffer())
  const installedDocument = readFileSync(join(live.installedRoot, 'console-host', 'static', 'console.html'))
  assert(sha256(documentBytes) === sha256(installedDocument),
    'the served document is not byte-identical to the installed console-host/static/console.html')
  measurements.servedAssets = assetFacts
  measurements.documentSha256 = sha256(documentBytes)
  check('served asset provenance — the installed files are what the origin served',
    `document sha256=${measurements.documentSha256}; ${assetFacts.map(fact => `${fact.path}=${fact.sha256} (${fact.bytes} bytes) == installed ${fact.relative}`).join('; ')}`)

  step = 'chrome launch'
  const executable = chromeExecutable()
  const chromeChild = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-debugging-port=0',
    `--user-data-dir=${chromeProfileDirectory}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  live.chromeChild = chromeChild
  live.chromePid = chromeChild.pid
  assert(Number.isInteger(live.chromePid) && live.chromePid > 0, 'Chrome did not report a pid')
  const wsUrl = await new Promise((resolveWs, rejectWs) => {
    let buffered = ''
    const timer = setTimeout(() => rejectWs(new Error(`no DevTools endpoint on stderr; saw: ${buffered.slice(-400)}`)), 30_000)
    chromeChild.stderr.on('data', chunk => {
      buffered += chunk.toString('utf8')
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match !== null) { clearTimeout(timer); resolveWs(match[1]) }
    })
    chromeChild.once('exit', code => { clearTimeout(timer); rejectWs(new Error(`Chrome exited before the DevTools endpoint (code=${code})`)) })
  })
  check('chrome launch', `real Chrome pid=${live.chromePid} --headless=new own --user-data-dir, devtools=${wsUrl}`)

  step = 'cdp attach'
  const cdp = await connectCdp(wsUrl)
  live.cdp = cdp
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  live.session = sessionId
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Network.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  await cdp.send('Network.setExtraHTTPHeaders', { headers: { Authorization: BASIC } }, sessionId)
  note('Network.setExtraHTTPHeaders installed the Basic credential at the network layer')

  step = 'page load'
  await cdp.send('Page.navigate', { url: `${controlOrigin}/` }, sessionId)
  const loaded = await settle('the installed console entry to build its DOM', async () => {
    const inventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
    return inventory.readyState === 'complete' && inventory.pageNames.length === PAGE_NAMES.length
  }, 250, 60_000)
  assert(loaded, 'the installed console entry never built its DOM')
  let inventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
  assert(inventory.url === `${controlOrigin}/`, `the page URL is ${inventory.url}, expected ${controlOrigin}/`)
  assert(!inventory.url.includes('@'), `the page URL carries credentials: ${inventory.url}`)
  assert(inventory.title === 'AgentTeams Console', `the page title is ${JSON.stringify(inventory.title)}`)
  const documentRecord = networkTable(cdp.events).get(requestIdFor(networkTable(cdp.events), record => new URL(record.url).pathname === '/'))
  assert(documentRecord !== undefined && documentRecord.status === 200, `the Document request status is ${documentRecord?.status}`)
  assert((documentRecord.mimeType ?? '').includes('text/html'), `the Document mime type is ${documentRecord.mimeType}`)
  check('page load', `the installed origin loaded in real Chrome: ${inventory.url} title=${JSON.stringify(inventory.title)} readyState=${inventory.readyState} Document=${documentRecord.status} ${documentRecord.mimeType}`)

  step = 'page module graph'
  // One request table for the whole comparison: rebuilding it per module would compare
  // freshly built record objects and silently compare nothing.
  const requests = networkTable(cdp.events)
  const moduleEntries = [...requests.entries()].filter(([, record]) => new URL(record.url).pathname.startsWith('/ui/'))
  assert(moduleEntries.length >= 10, `the page loaded only ${moduleEntries.length} /ui/ modules`)
  const badModules = moduleEntries.filter(([, record]) => record.status !== 200)
  assert(badModules.length === 0, `the page loaded ${badModules.length} /ui/ module(s) with a non-200 status: ${JSON.stringify(badModules.slice(0, 3).map(([, record]) => record.url))}`)
  const entryRecord = [...requests.values()].find(record => new URL(record.url).pathname === '/console-entry.js')
  assert(entryRecord !== undefined && entryRecord.status === 200, `the page did not load /console-entry.js with 200 (status=${entryRecord?.status})`)
  // Every /ui/ module the browser received must be byte-identical to an installed UI file.
  const installedUiRoot = join(live.installedRoot, 'ui', 'teams-console')
  const uiMismatches = []
  let comparedModules = 0
  for (const [requestId, record] of moduleEntries) {
    const relative = new URL(record.url).pathname.replace(/^\/ui\//, '')
    const candidates = [join(installedUiRoot, relative), join(installedUiRoot, 'lib', relative)]
    const installedPath = candidates.find(candidate => existsSync(candidate))
    if (installedPath === undefined) { uiMismatches.push(`no installed file for /ui/${relative}`); continue }
    const served = await responseBody(cdp, sessionId, requestId)
    comparedModules += 1
    if (sha256(served) !== sha256(readFileSync(installedPath))) uiMismatches.push(`/ui/${relative} differs from ${installedPath}`)
  }
  assert(comparedModules === moduleEntries.length, `only ${comparedModules} of ${moduleEntries.length} served /ui/ modules could be compared`)
  assert(uiMismatches.length === 0, `served UI modules do not match the installed package: ${uiMismatches.slice(0, 3).join('; ')}`)
  check('page module graph', `the page received /console-entry.js (200) and ${moduleEntries.length} /ui/ modules, all 200; all ${comparedModules} byte-match the installed package`)

  step = 'page fetch'
  const pageProjectionId = requestIdFor(networkTable(cdp.events), record => new URL(record.url).pathname === '/api/v1/projection')
  assert(pageProjectionId !== undefined, 'the page never issued its own /api/v1/projection request')
  const pageProjectionRecord = networkTable(cdp.events).get(pageProjectionId)
  assert(pageProjectionRecord.status === 200, `the page's own /api/v1/projection returned ${pageProjectionRecord.status}`)
  const pageProjectionText = (await responseBody(cdp, sessionId, pageProjectionId)).toString('utf8')
  const pageProjection = JSON.parse(pageProjectionText)
  // The directory is live, so two reads legitimately differ in sequence and ordering. What is
  // asserted is that the page received the SAME projection shape from the SAME origin: the
  // frozen version, the same registered agent set, and the same empty interaction arrays.
  // Byte equality of the whole document is NOT claimed for a live directory.
  const pageAgentIds = (pageProjection.agents ?? []).map(agent => agent.agentId).sort()
  const independentAgentIds = (independentProjection.agents ?? []).map(agent => agent.agentId).sort()
  assert(pageProjection.version === independentProjection.version, `the page projection version is ${pageProjection.version}`)
  assert(JSON.stringify(pageAgentIds) === JSON.stringify(independentAgentIds),
    `the page shows agents ${JSON.stringify(pageAgentIds)} while the independent read shows ${JSON.stringify(independentAgentIds)}`)
  for (const frozen of ['sessions', 'notifications', 'configs']) {
    assert(JSON.stringify(pageProjection[frozen]) === JSON.stringify(independentProjection[frozen]),
      `the page's ${frozen} differ from the independent read: ${JSON.stringify(pageProjection[frozen])} vs ${JSON.stringify(independentProjection[frozen])}`)
  }
  measurements.pageProjection = { version: pageProjection.version, agents: pageAgentIds, bytes: pageProjectionText.length }
  check('page fetch', `the page's own same-origin fetch('/api/v1/projection') -> ${pageProjectionRecord.status} ${pageProjectionRecord.mimeType}, ${pageProjectionText.length} bytes; version=${pageProjection.version} agents=${JSON.stringify(pageAgentIds)}; the same registered agent set and the same frozen empty interaction arrays as an independent read (whole-document byte equality is not claimed for a live directory)`)

  step = 'DOM markers'
  assert(JSON.stringify([...inventory.pageNames].sort()) === JSON.stringify([...PAGE_NAMES].sort()),
    `the live nav does not carry the four frozen page names: ${JSON.stringify(inventory.pageNames)}`)
  assert(PAGE_NAMES.includes(inventory.pageView), `data-team-page-view is ${JSON.stringify(inventory.pageView)}`)
  assert(inventory.bands.length === BAND_LABELS.length && BAND_LABELS.every(label => inventory.bands.includes(label)),
    `the live state bands are ${JSON.stringify(inventory.bands)}`)
  assert(typeof inventory.observation === 'string' && inventory.observation.length > 0, 'data-team-observation is absent from the live page')
  // `data-team-cancel` (ui/teams-console/src/client/render.ts:593) and `data-permission-option`
  // only exist for a rendered Session. This control daemon binds no Session owner, so there is
  // no Session to cancel and no pending permission to choose: their absence is the SAME gap
  // the D06/D08 evidence already records, not a regression, and nothing here proves them.
  assert(inventory.cancel === null, `the discovery view unexpectedly rendered a cancel control: ${inventory.cancel}`)
  assert(inventory.permissionOptions.length === 0, `the discovery view unexpectedly rendered permission options: ${JSON.stringify(inventory.permissionOptions)}`)
  measurements.domMarkers = {
    pages: inventory.pageNames, view: inventory.pageView, bands: inventory.bands, bandStates: inventory.bandStates,
    observation: inventory.observation, cancel: inventory.cancel, permissionOptions: inventory.permissionOptions,
    connectionRows: inventory.connectionRows, agentRows: inventory.agentRows,
  }
  check('DOM markers', `live DOM of the installed entry: pages=${inventory.pageNames.join(',')} view=${inventory.pageView} bands=${inventory.bands.join(',')} states=${inventory.bandStates.join(',')} observation=${inventory.observation}; data-team-cancel and data-permission-option are ABSENT because this control daemon binds no Session owner (the existing D06/D08 gap), and their absence is not claimed as evidence`)

  step = 'live page subscription'
  const streamPath = record => new URL(record.url).pathname === '/api/v1/events'
  const pageOpenedStream = await settle('the live page to open /api/v1/events on its own', async () =>
    requestIdFor(networkTable(cdp.events), streamPath) !== undefined, 200, 30_000)
  assert(pageOpenedStream, 'the live page never opened /api/v1/events on its own')
  const pageStreamRecord = networkTable(cdp.events).get(requestIdFor(networkTable(cdp.events), streamPath))
  assert(pageStreamRecord.status === 200, `the page's own /api/v1/events returned ${pageStreamRecord.status}`)
  const observedLive = await settle('the shipped client to start its observation controller', async () =>
    (await evaluate(cdp, sessionId, DOM_INVENTORY)).observation === 'live', 250, 20_000)
  assert(observedLive, 'the page opened its own stream but its observation state never became live')
  check('live page subscription', `the installed entry opened its own /api/v1/events (HTTP ${pageStreamRecord.status}) and started its observation controller (data-team-observation=live)`)

  step = 'real agent row'
  const agentRowRendered = await settle('the real registered agent to render', async () =>
    (await evaluate(cdp, sessionId, DOM_INVENTORY)).agentRows.includes(AGENT_ID), 500, 60_000)
  inventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
  assert(agentRowRendered, `the live DOM never rendered data-agent-id="${AGENT_ID}"; saw ${JSON.stringify(inventory.agentRows)}`)
  check('real agent row', `the installed WebUI rendered the real registered agent from the live directory: data-agent-id=${inventory.agentRows.join(',')}`)

  step = 'SSE frame'
  const driverFrame = await evaluate(cdp, sessionId, `(async () => {
    const source = new EventSource('/api/v1/events')
    try {
      return await new Promise((resolveFrame, rejectFrame) => {
        const timer = setTimeout(() => { source.close(); rejectFrame(new Error('no SSE frame within 20s')) }, 20_000)
        source.addEventListener('snapshot', event => {
          clearTimeout(timer)
          source.close()
          try { resolveFrame(JSON.parse(event.data)) } catch (error) { rejectFrame(error) }
        })
      })
    } catch (error) { return { error: String(error) } }
  })()`, true)
  assert(driverFrame !== undefined && driverFrame.error === undefined,
    `a driver-owned EventSource received no snapshot frame: ${JSON.stringify(driverFrame)}`)
  assert(typeof driverFrame.seq === 'number' && typeof driverFrame.projection === 'object' && driverFrame.projection !== null,
    `the SSE frame is not a {seq, projection} snapshot: ${JSON.stringify(driverFrame).slice(0, 200)}`)
  measurements.sse = { seq: driverFrame.seq, agents: (driverFrame.projection.agents ?? []).map(agent => agent.agentId) }
  check('SSE frame', `a driver-owned EventSource on the installed origin received a real snapshot: seq=${driverFrame.seq} agents=${JSON.stringify(measurements.sse.agents)}`)

  step = 'four pages'
  const visitedPages = []
  let historyFacts = { count: null, records: 0, prevEnabled: null }
  for (const page of PAGE_NAMES) {
    const clicked = await evaluate(cdp, sessionId, `(() => { const tab = document.querySelector('[data-team-page="${page}"]'); if (tab === null) return 'absent'; tab.click(); return 'clicked' })()`)
    assert(clicked === 'clicked', `the live nav has no clickable ${page} tab (${clicked})`)
    const rendered = await settle(`the ${page} page to render`, async () => {
      const current = await evaluate(cdp, sessionId, DOM_INVENTORY)
      return current.pageView === page
    }, 200, 15_000)
    assert(rendered, `the live page did not switch to ${page}`)
    if (page === 'history') {
      const historyView = await evaluate(cdp, sessionId, DOM_INVENTORY)
      assert(historyView.historyCount !== null, 'the live history view renders no data-history-count')
      assert(historyView.historyPrevEnabled !== null, 'the live history view renders no data-history-prev control')
      historyFacts = { count: historyView.historyCount, records: historyView.historyRecords.length, prevEnabled: historyView.historyPrevEnabled }
      note(`history view: data-history-count=${historyView.historyCount} data-history-record rows=${historyView.historyRecords.length} data-history-prev[data-enabled]=${historyView.historyPrevEnabled}`)
    }
    visitedPages.push(page)
  }
  measurements.history = historyFacts
  check('four pages', `the live page switched through all four frozen views in real Chrome: ${visitedPages.join(' -> ')}; the history view rendered data-history-count=${historyFacts.count} with ${historyFacts.records} record row(s)`)

  step = 'page runtime errors'
  const exceptions = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown')
  assert(exceptions.length === 0, `the live page raised ${exceptions.length} uncaught exception(s): ${JSON.stringify(exceptions.slice(0, 3))}`)
  // A console error the producer never names is an observation nobody can check. The browser
  // reports a generic text for a missing favicon, so bind the error to the observed Network
  // response path instead of guessing from the text alone.
  const consoleErrors = cdp.events.filter(event => event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error')
  const errorTexts = consoleErrors.map(event => String(event.params.entry.text ?? '').replace(/\s+/g, ' ').slice(0, 160))
  const failedRequests = [...networkTable(cdp.events).values()]
    .filter(record => typeof record.status === 'number' && record.status >= 400)
    .map(record => ({ path: new URL(record.url).pathname, status: record.status }))
  measurements.consoleErrors = errorTexts
  measurements.failedRequests = failedRequests
  assert(failedRequests.every(record => record.path === '/favicon.ico' && record.status === 404),
    `the live page observed unexpected failed requests: ${JSON.stringify(failedRequests)}`)
  // Each console error must be accounted for by its own failed request: a page-originated
  // console.error without a matching failed request fails the run.
  assert(consoleErrors.length === failedRequests.length,
    `the live page logged ${consoleErrors.length} console error(s) for ${failedRequests.length} observed failed request(s): ${JSON.stringify(errorTexts)}`)
  check('page runtime errors', `0 uncaught page exceptions across the whole installed-browser session (${cdp.events.length} CDP events); ${consoleErrors.length} generic console error(s) map only to the expected /favicon.ico 404: ${JSON.stringify(errorTexts)}`)

  step = 'screenshot'
  await evaluate(cdp, sessionId, `(() => { document.querySelector('[data-team-page="discovery"]')?.click(); return true })()`)
  await settle('the discovery view to render before the screenshot', async () =>
    (await evaluate(cdp, sessionId, DOM_INVENTORY)).pageView === 'discovery', 150, 10_000)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  assert(typeof shot.data === 'string' && shot.data.length > 0, 'Page.captureScreenshot returned no data')
  const png = Buffer.from(shot.data, 'base64')
  writeFileSync(SCREENSHOT_PATH, png)
  const signature = png.subarray(0, 8).toString('hex')
  assert(signature === '89504e470d0a1a0a', `the screenshot is not a PNG: signature=${signature}`)
  const ihdrWidth = png.readUInt32BE(16)
  const ihdrHeight = png.readUInt32BE(20)
  assert(ihdrWidth > 100 && ihdrHeight > 100, `the screenshot dimensions are implausible: ${ihdrWidth}x${ihdrHeight}`)
  measurements.screenshot = { path: SCREENSHOT_PATH, bytes: png.length, width: ihdrWidth, height: ihdrHeight }
  check('screenshot', `real PNG ${ihdrWidth}x${ihdrHeight}, ${png.length} bytes (dimensions read from the IHDR chunk) at ${SCREENSHOT_PATH.slice(evidenceDirectory.length + 1)}`)
}

/* ---------------------------------------------------------------------------------------
 * Cleanup
 * ------------------------------------------------------------------------------------- */

async function cleanup() {
  step = 'cleanup'
  if (live.chromePid !== undefined && pidAlive(live.chromePid)) {
    stopByExplicitPid(live.chromePid, 'SIGTERM')
    await settle('Chrome to exit', async () => !pidAlive(live.chromePid), 200, 10_000)
    if (pidAlive(live.chromePid)) stopByExplicitPid(live.chromePid, 'SIGKILL')
    await settle('Chrome to exit after SIGKILL', async () => !pidAlive(live.chromePid), 200, 10_000)
  }
  live.cdp?.close()

  if (live.controlPid !== undefined && !live.controlStopped && pidAlive(live.controlPid)) {
    const stopped = runCliLogged(['control', 'stop', '--config', join(ownedRoot, 'control.toml')], operatorEnv)
    live.controlStopped = stopped.status === 0
    if (!live.controlStopped) note(`control stop exited ${stopped.status}: ${stopped.output.slice(-200)}`)
    await settle('the control daemon to exit', async () => !pidAlive(live.controlPid), 250, 20_000)
    if (pidAlive(live.controlPid)) stopByExplicitPid(live.controlPid, 'SIGKILL')
    await settle('the control daemon to exit after SIGKILL', async () => !pidAlive(live.controlPid), 250, 10_000)
  }

  for (const pid of live.agentEnginePids) {
    if (pidAlive(pid)) stopByExplicitPid(pid, 'SIGTERM')
  }
  if (live.agentPid !== undefined && pidAlive(live.agentPid)) {
    stopByExplicitPid(live.agentPid, 'SIGTERM')
    await settle('the agent daemon to exit', async () => !pidAlive(live.agentPid), 250, 20_000)
    if (pidAlive(live.agentPid)) stopByExplicitPid(live.agentPid, 'SIGKILL')
    await settle('the agent daemon to exit after SIGKILL', async () => !pidAlive(live.agentPid), 250, 10_000)
  }
  for (const pid of live.agentEnginePids) {
    await settle(`engine child ${pid} to exit`, async () => !pidAlive(pid), 200, 10_000)
    if (pidAlive(pid)) stopByExplicitPid(pid, 'SIGKILL')
    await settle(`engine child ${pid} to exit after SIGKILL`, async () => !pidAlive(pid), 200, 5_000)
  }

  if (live.registryPid !== undefined && !live.registryStopped && pidAlive(live.registryPid)) {
    const stopped = runCliLogged(['registry', 'stop', '--config', join(ownedRoot, 'registry.toml')], operatorEnv)
    live.registryStopped = stopped.status === 0
    if (!live.registryStopped) note(`registry stop exited ${stopped.status}: ${stopped.output.slice(-200)}`)
    await settle('the registry to exit', async () => !pidAlive(live.registryPid), 250, 20_000)
    if (pidAlive(live.registryPid)) stopByExplicitPid(live.registryPid, 'SIGKILL')
    await settle('the registry to exit after SIGKILL', async () => !pidAlive(live.registryPid), 250, 10_000)
  }

  await live.provider?.close().catch(() => undefined)

  const owned = [live.registryPid, live.agentPid, ...live.agentEnginePids, live.controlPid, live.chromePid].filter(pid => pid !== undefined)
  const stillAlive = owned.filter(pid => pidAlive(pid))
  const strays = processTable().filter(row => row.command.includes(ownedRoot))
  const chromeStrays = processTable().filter(row => row.command.includes(`--user-data-dir=${chromeProfileDirectory}`))
  note(`cleanup: owned pids=${owned.join(',')} alive=${stillAlive.length}; temp-root matches=${strays.length}; profile Chrome matches=${chromeStrays.length}`)
  return { owned, stillAlive, strays: strays.length, chromeStrays: chromeStrays.length }
}

function writeReceipt(cleanupResult) {
  const receipt = {
    unit: 'acp-l11-installed-browser-20261014',
    produced_at: new Date().toISOString(),
    head_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout.trim(),
    artifact: live.artifactReceipt === undefined ? null : {
      mode: live.artifactReceipt.mode,
      release_eligible: live.artifactReceipt.release_eligible,
      content_sha256: live.artifactReceipt.content_sha256,
      files: Array.isArray(live.artifactReceipt.files) ? live.artifactReceipt.files.length : null,
    },
    installed: live.installedRoot === undefined ? null : {
      prefix: prefixRoot, root: realpathSync(live.installedRoot), cli: realpathSync(live.cli),
    },
    daemons: {
      registry: live.registryPid ?? null, agent: live.agentPid ?? null,
      agent_engine_children: live.agentEnginePids, control: live.controlPid ?? null, chrome: live.chromePid ?? null,
    },
    measurements,
    checks,
    cleanup: cleanupResult,
    // The producer declares no gap of its own: a gap here would be a check it chose not to
    // assert. The unit's unproven items are recorded in verification.json instead.
    gaps: [],
    result: failure === undefined ? 'PASS' : 'FAIL',
  }
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`)
  if (existsSync(liveLogPath)) copyFileSync(liveLogPath, LOG_EVIDENCE_PATH)
  emit(`receipt: ${RECEIPT_PATH}`)
}

/* ---------------------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------------------- */

// The live log lives under the owned temp root, never inside the evidence directory: the
// package identity gate diffs the git index against the working tree, so a log the driver
// keeps writing after it staged its own evidence files would fail that gate. It is copied
// into the evidence directory at the end of the run.
liveLogPath = join(ownedRoot, 'installed-browser-dom.log')
logDescriptor = openSync(liveLogPath, 'a')
emit(`== L11 installed-artifact live-browser DOM run ${new Date().toISOString()} ==`)

let cleanupResult
try {
  await run()
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error))
  process.exitCode = 1
  emit(`FAIL at step "${step}" — ${failure.message}`)
} finally {
  cleanupResult = await cleanup().catch(error => {
    process.exitCode = 1
    emit(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  writeReceipt(cleanupResult)
  const ownedAlive = (cleanupResult?.stillAlive ?? []).length
  if (ownedAlive > 0) {
    process.exitCode = 1
    emit(`FAIL cleanup — ${ownedAlive} owned pid(s) are still alive`)
  }
  if (cleanupResult !== undefined && (cleanupResult.strays > 0 || cleanupResult.chromeStrays > 0)) {
    process.exitCode = 1
    emit(`FAIL cleanup — ${cleanupResult.strays} process(es) still match the owned temp root and ${cleanupResult.chromeStrays} still match the owned Chrome profile`)
  }
  // `process.exitCode` stays `undefined` on the success path, so normalise it before the
  // ownership decision; comparing `undefined === 0` would retain every successful run's root.
  process.exitCode = process.exitCode ?? 0
  emit(`checks=${checks.length} exit=${process.exitCode}`)
  if (logDescriptor !== undefined) { closeSync(logDescriptor); logDescriptor = undefined }
  if (existsSync(liveLogPath)) copyFileSync(liveLogPath, LOG_EVIDENCE_PATH)
  if (process.exitCode === 0) {
    rmSync(ownedRoot, { recursive: true, force: true })
    note(`cleanup: removed the owned temp root ${ownedRoot}`)
  } else {
    note(`cleanup: retained the owned temp root for diagnosis: ${ownedRoot}`)
  }
  if (logDescriptor !== undefined) closeSync(logDescriptor)
}
