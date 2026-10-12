#!/usr/bin/env node
/**
 * D08 live-browser DOM evidence producer — the closure of the A07 "live-browser DOM"
 * evidence boundary recorded by docs/evidence/acp-d08-acceptance-20261011.
 *
 * The boundary claim was: "headless Chrome cannot satisfy the origin's HTTP Basic
 * challenge for a same-origin fetch/EventSource, and a credentialed origin URL is
 * rejected by fetch". That claim is too broad. This producer drives REAL Chrome over the
 * DevTools Protocol, injects the Basic Authorization header at the NETWORK layer with
 * `Network.setExtraHTTPHeaders`, and navigates to a CLEAN origin URL (no userinfo). The
 * page URL therefore carries no credentials, so a relative `fetch()`/`EventSource` is
 * accepted by the browser, while every request still carries the header the origin
 * demands. Nothing about the page is synthetic: the real control daemon serves the real
 * console entry, and the DOM assertions read the DOM that entry builds.
 *
 * What this producer does:
 *   1. builds (or reuses) the worktree runtime/UI artifacts, then starts the REAL control
 *      daemon through the project's own CLI (`control start --config ...`);
 *   2. launches real Chrome with its own throw-away `--user-data-dir` and connects to the
 *      browser endpoint printed on stderr;
 *   3. attaches to a page target, enables Page/Network/Runtime, sets the Basic header and
 *      navigates to `http://<ip>:<port>/`;
 *   4. reads the LIVE DOM of the real console entry (frozen D07 markers, the four page
 *      names, real UI navigation), the page's OWN authenticated `fetch` through the
 *      Network domain, the page's OWN SSE subscription, and a real SSE frame with the
 *      server's real sequence;
 *   5. compares the projection the page received with the projection an independent HTTP
 *      client reads from the same endpoint, byte for byte;
 *   6. captures a real PNG screenshot into this evidence directory.
 *
 * This producer found three real defects in the shipped WebUI/Console path and they are fixed
 * in this unit (see notes.md "Defects this producer found"):
 *   - the origin emitted `event: projection` while both UI clients subscribe to `snapshot`,
 *     so a named SSE event matched no listener and was dropped silently;
 *   - nothing in the product called `controller.startObservation()`, so the shipped page
 *     never opened `/api/v1/events` at all;
 *   - the history view had no initial read, and its only other trigger is disabled until a
 *     read has happened, so the view could never show a record.
 * Each now has a real `PASS` check rather than an unverified `GAP` claim, and each check is
 * worded to claim only what it measures:
 *   - defect 1 is proven by the "SSE frame" check: an EventSource subscribing to `snapshot`
 *     receives a real frame, and that check times out under the old name;
 *   - defect 2 is proven by the "live page subscription" check: the shipped entry opens its
 *     OWN `/api/v1/events` request. That check does NOT claim the shipped client applied a
 *     snapshot: `ProjectionObservationController.start()` emits `live` before any snapshot
 *     arrives, and the page also renders from its own HTTP projection fetch;
 *   - defect 3 is proven by the "history readback from the page" check: the shipped history
 *     view issues its own `/api/v1/history` request.
 *
 * Honest boundary (printed as a `GAP` line, never as PASS):
 *   - the control daemon binds no Console/Session owner and records no registration
 *     transition here, so the projection is a real but EMPTY snapshot: no Session,
 *     permission or history row exists, and `data-team-cancel`,
 *     `data-permission-option` and `data-history-record` cannot be observed. No
 *     event-driven animation is claimed.
 *
 * Cleanup is explicit-PID only: no pkill, killall, `kill $(...)`, or `xargs kill`. Every
 * process this producer starts is stopped by its explicit pid, in `finally`. Chrome always
 * uses its own `--user-data-dir` inside the owned temp root. On PASS the owned temp root is
 * removed; on failure it is retained and printed.
 *
 * Usage: node docs/evidence/acp-d08-browser-20261011/live-browser-dom.mjs
 * Env:   CHROME_BIN (optional Chrome/Chromium executable override)
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(evidenceDirectory, '..', '..', '..')
const CLI = join(repositoryRoot, 'cli', 'agentteams.mjs')
const SCREENSHOT_PATH = join(evidenceDirectory, 'live-browser-dom.png')

const CONSOLE_USERNAME = 'teams'
const CONSOLE_PASSWORD_ENV = 'D08_BROWSER_CONSOLE_PASSWORD'
const CONSOLE_PASSWORD = `d08-browser-${randomUUID()}`
const BASIC = `Basic ${Buffer.from(`${CONSOLE_USERNAME}:${CONSOLE_PASSWORD}`).toString('base64')}`
const AUTH_CHALLENGE = 'Basic realm="AgentTeams", charset="UTF-8"'
const PAGE_NAMES = ['discovery', 'networking', 'interaction', 'history']
const BAND_LABELS = ['registration', 'connection', 'engine', 'request']
/** Frozen D07 marker attributes; the data-dependent ones are checked by the GAP lines. */
const D07_MARKERS = ['data-team-page', 'data-team-page-view', 'data-team-band', 'data-team-observation', 'data-team-cancel', 'data-permission-option', 'data-history-record', 'data-history-count']

/* ---------------------------------------------------------------------------------------
 * Reporting
 * ------------------------------------------------------------------------------------- */

const checks = []
const gaps = []
let step = 'startup'

function check(name, detail) {
  checks.push({ name, detail })
  process.stdout.write(`PASS ${name} — ${detail}\n`)
}

function gap(name, reason) {
  gaps.push({ name, reason })
  process.stdout.write(`GAP ${name} — ${reason}\n`)
}

function note(message) {
  process.stdout.write(`  -- ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/* ---------------------------------------------------------------------------------------
 * Process / filesystem helpers
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

/* ---------------------------------------------------------------------------------------
 * Owned temp root, build reuse, and the project CLI
 * ------------------------------------------------------------------------------------- */

const ownedRoot = mkdtempSync(join(tmpdir(), 'd08-browser-'))
const cliLogDirectory = join(ownedRoot, 'cli-logs')
const controlDataDirectory = join(ownedRoot, 'control-state')
const controlConfigPath = join(ownedRoot, 'control.toml')
const chromeProfileDirectory = join(ownedRoot, 'chrome-profile')
mkdirSync(cliLogDirectory, { recursive: true })

const live = {
  chromePid: undefined,
  chromeChild: undefined,
  controlPid: undefined,
  controlStopped: false,
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
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: repositoryRoot, env: { ...process.env, ...env }, stdio: ['ignore', descriptor, descriptor], timeout: timeoutMs,
    })
    return { status: result.status, output: readFileSync(logPath, 'utf8') }
  } finally {
    closeSync(descriptor)
  }
}

/**
 * The control daemon resolves its presentation roots beside the compiled runtime entry, so
 * `generated/runtime-lib/runtime/control-process.js` and `ui/teams-console/lib/browser.js`
 * must exist. A clean worktree is built with the project's own producer; an already-built
 * The producer always rebuilds. Reusing an existing build silently produced evidence for code
 * that was no longer on disk: a real SSE event-name mismatch between the server and the UI
 * client was masked because the stale build still carried the old server string.
 */
function ensureBuilt() {
  const runtimeEntry = join(repositoryRoot, 'generated', 'runtime-lib', 'runtime', 'control-process.js')
  const uiBarrel = join(repositoryRoot, 'ui', 'teams-console', 'lib', 'browser.js')
  note('running the project build so no evidence can come from a stale artifact: pnpm build')
  const buildLog = join(cliLogDirectory, 'build.log')
  const descriptor = openSync(buildLog, 'a')
  let build
  try {
    build = spawnSync('pnpm', ['build'], { cwd: repositoryRoot, env: process.env, stdio: ['ignore', descriptor, descriptor], timeout: 900_000 })
  } finally {
    closeSync(descriptor)
  }
  assert(build.status === 0, `pnpm build exited ${build.status}: ${readFileSync(buildLog, 'utf8').slice(-1200)}`)
  assert(existsSync(runtimeEntry), `the build did not produce ${runtimeEntry}`)
  assert(existsSync(uiBarrel), `the build did not produce ${uiBarrel}`)
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
    bodyText: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 240),
  }
})()`

/* ---------------------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------------------- */

const operatorEnv = { [CONSOLE_PASSWORD_ENV]: CONSOLE_PASSWORD }
let failure = undefined

async function run() {
  step = 'build'
  ensureBuilt()
  assert(existsSync(CLI), `the worktree CLI entry is missing: ${CLI}`)

  step = 'control config'
  const controlPort = await availablePort('127.0.0.1')
  const controlOrigin = `http://127.0.0.1:${controlPort}`
  // The exact v4 control-daemon shape: one `[daemon]` with its own data directory and a
  // `[webui]` listener guarded by `[webui.auth]`. No `[discovery]` is declared, so the
  // daemon binds no registration client and records no membership transition.
  writeFileSync(controlConfigPath, `version = 4

[daemon]
kind = "control"
id = "control-a"
hostId = "control-host"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(controlDataDirectory)}

[webui]
ip = "127.0.0.1"
port = ${controlPort}
allowedOrigin = ${JSON.stringify(controlOrigin)}

[webui.auth]
username = ${JSON.stringify(CONSOLE_USERNAME)}
passwordEnv = ${JSON.stringify(CONSOLE_PASSWORD_ENV)}
`)

  step = 'control start'
  const controlStart = runCliLogged(['control', 'start', '--config', controlConfigPath], operatorEnv)
  const controlFields = parseFields(controlStart.output.trim().split('\n').filter(Boolean).at(-1) ?? '')
  assert(controlStart.status === 0, `control start exited ${controlStart.status}: ${controlStart.output.slice(-400)}`)
  assert(controlFields.state === 'running', `control did not report running: ${controlStart.output.slice(-200)}`)
  live.controlPid = Number(controlFields.pid)
  assert(pidAlive(live.controlPid), `the control pid ${live.controlPid} is not alive`)
  assert(controlFields.listener === `127.0.0.1:${controlPort}`, `control bound ${controlFields.listener}, expected 127.0.0.1:${controlPort}`)
  check('control daemon', `real control daemon via the worktree CLI: state=${controlFields.state} pid=${live.controlPid} listener=${controlFields.listener} url=${controlFields.url}`)

  step = 'origin challenge'
  const anonymous = await fetch(controlOrigin).catch(() => null)
  assert(anonymous !== null && anonymous.status === 401, `an unauthenticated GET / returned ${anonymous?.status}`)
  const challenge = anonymous.headers.get('www-authenticate') ?? ''
  assert(challenge === AUTH_CHALLENGE, `the anonymous challenge is ${challenge}`)
  await anonymous.body?.cancel().catch(() => undefined)
  check('origin challenge', `anonymous GET / -> 401 challenge="${challenge}"`)

  // The independent HTTP reference. Every later "the page shows X" comparison is against
  // this read, taken by a plain Node fetch with the same Basic credential.
  const independentProjectionResponse = await fetch(`${controlOrigin}/api/v1/projection`, { headers: { authorization: BASIC, accept: 'application/json' } })
  assert(independentProjectionResponse.status === 200, `independent GET /api/v1/projection returned ${independentProjectionResponse.status}`)
  const independentProjectionText = await independentProjectionResponse.text()
  const independentProjection = JSON.parse(independentProjectionText)

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
  check('chrome launch', `real Chrome pid=${live.chromePid} headless=new own --user-data-dir=${chromeProfileDirectory.replace(`${ownedRoot}/`, '')} devtools=${wsUrl}`)

  step = 'cdp attach'
  const cdp = await connectCdp(wsUrl)
  live.cdp = cdp
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  live.session = sessionId
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Network.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Network.setExtraHTTPHeaders', { headers: { Authorization: BASIC } }, sessionId)
  note('Network.setExtraHTTPHeaders installed the Basic credential at the network layer')

  step = 'page load'
  await cdp.send('Page.navigate', { url: `${controlOrigin}/` }, sessionId)
  const loaded = await settle('the real console entry to build its DOM', async () => {
    const inventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
    return inventory.readyState === 'complete' && inventory.pageNames.length === PAGE_NAMES.length
  }, 250, 30_000)
  assert(loaded, 'the real console entry never built its DOM')
  const inventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
  assert(inventory.url === `${controlOrigin}/`, `the page navigated to ${inventory.url}, expected ${controlOrigin}/`)

  const requests = networkTable(cdp.events)
  // The target starts on about:blank, so the document of interest is the one the console
  // origin really served, not the initial blank target.
  const documentRecord = [...requests.values()].find(record => record.type === 'Document' && record.url.startsWith(controlOrigin))
  assert(documentRecord !== undefined, 'the browser observed no Document request for the console origin')
  assert(documentRecord.status === 200, `the document request returned ${documentRecord.status}`)
  assert((documentRecord.mimeType ?? '').includes('text/html'), `the document mime type is ${documentRecord.mimeType}`)
  assert(inventory.title === 'AgentTeams Console', `the live page title is ${JSON.stringify(inventory.title)}`)
  check('page load', `clean origin URL (no userinfo) ${inventory.url} -> document ${documentRecord.status} ${documentRecord.mimeType}; readyState=${inventory.readyState} title=${JSON.stringify(inventory.title)}`)

  step = 'page module graph'
  const scriptRecords = [...requests.values()].filter(record => record.type === 'Script')
  const scriptStatuses = scriptRecords.map(record => record.status)
  const entryRecord = scriptRecords.find(record => new URL(record.url).pathname === '/console-entry.js')
  const barrelRecord = scriptRecords.find(record => new URL(record.url).pathname === '/ui/browser.js')
  assert(entryRecord !== undefined && entryRecord.status === 200, `/console-entry.js was not served to the page (${JSON.stringify(entryRecord ?? null)})`)
  assert(barrelRecord !== undefined && barrelRecord.status === 200, `/ui/browser.js was not served to the page (${JSON.stringify(barrelRecord ?? null)})`)
  const uiModules = scriptRecords.filter(record => new URL(record.url).pathname.startsWith('/ui/'))
  assert(uiModules.length >= 10, `the page loaded only ${uiModules.length} /ui/ modules`)
  assert(scriptStatuses.every(status => status === 200), `a page module failed: ${JSON.stringify(scriptRecords.filter(record => record.status !== 200).map(record => [record.url, record.status]))}`)
  check('page module graph', `the real entry loaded ${scriptRecords.length} scripts, all 200: /console-entry.js + /ui/browser.js + ${uiModules.length} /ui/ modules`)

  step = 'page fetch'
  const fetched = await settle('the page\'s own /api/v1/projection fetch', async () =>
    requestIdFor(networkTable(cdp.events), record => new URL(record.url).pathname === '/api/v1/projection') !== undefined, 200, 20_000)
  assert(fetched, 'the page never issued its own /api/v1/projection request')
  const projectionRequestId = requestIdFor(networkTable(cdp.events), record => new URL(record.url).pathname === '/api/v1/projection')
  const projectionRecord = networkTable(cdp.events).get(projectionRequestId)
  assert(projectionRecord.status === 200, `the page's own /api/v1/projection returned ${projectionRecord.status}`)
  assert((projectionRecord.mimeType ?? '').includes('application/json'), `the page's projection mime type is ${projectionRecord.mimeType}`)
  const projectionBody = await cdp.send('Network.getResponseBody', { requestId: projectionRequestId }, sessionId)
  const pageProjectionText = projectionBody.base64Encoded ? Buffer.from(projectionBody.body, 'base64').toString('utf8') : projectionBody.body
  check('page fetch', `the page's own same-origin fetch('/api/v1/projection') -> ${projectionRecord.status} ${projectionRecord.mimeType}, ${pageProjectionText.length} bytes (observed on the Network domain)`)

  step = 'DOM markers'
  assert(JSON.stringify([...inventory.pageNames].sort()) === JSON.stringify([...PAGE_NAMES].sort()),
    `the live nav does not carry the four frozen page names: ${JSON.stringify(inventory.pageNames)}`)
  assert(PAGE_NAMES.includes(inventory.pageView), `data-team-page-view is ${JSON.stringify(inventory.pageView)}`)
  assert(inventory.bands.length === BAND_LABELS.length && BAND_LABELS.every(label => inventory.bands.includes(label)),
    `the live state bands are ${JSON.stringify(inventory.bands)}`)
  assert(typeof inventory.observation === 'string' && inventory.observation.length > 0, 'data-team-observation is absent from the live page')
  assert(inventory.agentRows.length === 0, `the empty projection must render no agent row, saw ${JSON.stringify(inventory.agentRows)}`)
  check('DOM markers', `live DOM of the real entry: page names=${inventory.pageNames.join(',')} view=${inventory.pageView} bands=${inventory.bands.join(',')} states=${inventory.bandStates.join(',')} observation=${inventory.observation} agentRows=${inventory.agentRows.length}`)

  step = 'live page subscription'
  // The shipped page's OWN client must open the stream. The driver creates its own EventSource
  // much later, so any /api/v1/events request observed at this point can only come from the
  // real client. This check exists because nothing in the product used to call
  // controller.startObservation(), so the page opened no stream at all.
  const streamPath = record => new URL(record.url).pathname === '/api/v1/events'
  const pageOpenedStream = await settle('the live page to open /api/v1/events on its own', async () =>
    requestIdFor(networkTable(cdp.events), streamPath) !== undefined, 200, 20_000)
  assert(pageOpenedStream, 'the live page never opened /api/v1/events on its own; the shipped client did not start observation')
  const pageStreamRecord = networkTable(cdp.events).get(requestIdFor(networkTable(cdp.events), streamPath))
  assert(pageStreamRecord.status === 200, `the page's own /api/v1/events returned ${pageStreamRecord.status}`)
  // `ProjectionObservationController.start()` emits `live` before any snapshot arrives
  // (ui/teams-console/src/client/observation.ts:27-31), so this proves the shipped client
  // STARTED its subscription, not that it applied a snapshot. Snapshot application by the
  // shipped client is not separately observable here: the projection is empty, and the page
  // also renders from its own HTTP fetch. The event-name agreement (defect 1) is proven by the
  // driver-owned "SSE frame" check below, which subscribes to `snapshot` and would time out if
  // the origin still emitted `projection`.
  const observedLive = await settle('the live page to start its own observation subscription', async () =>
    (await evaluate(cdp, sessionId, DOM_INVENTORY)).observation === 'live', 250, 20_000)
  const liveInventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
  assert(observedLive,
    `the page opened its own stream but its observation state stayed ${JSON.stringify(liveInventory.observation)}`)
  check('live page subscription', `the shipped entry opened its own /api/v1/events (HTTP ${pageStreamRecord.status}) and started its observation controller (data-team-observation=${liveInventory.observation}); snapshot application by the shipped client is NOT claimed here`)

  step = 'four pages'
  const visitedPages = []
  for (const page of PAGE_NAMES) {
    const clicked = await evaluate(cdp, sessionId, `(() => { const tab = document.querySelector('[data-team-page="${page}"]'); if (tab === null) return 'absent'; tab.click(); return 'clicked' })()`)
    assert(clicked === 'clicked', `the live nav has no clickable ${page} tab (${clicked})`)
    const rendered = await settle(`the ${page} page to render`, async () => {
      const current = await evaluate(cdp, sessionId, DOM_INVENTORY)
      return current.pageView === page
    }, 150, 10_000)
    assert(rendered, `clicking the ${page} tab did not render data-team-page-view="${page}"`)
    const current = await evaluate(cdp, sessionId, DOM_INVENTORY)
    visitedPages.push(`${page}(rows=${current.agentRows.length},records=${current.historyRecords.length},count=${current.historyCount ?? '-'})`)
  }
  check('four pages', `real UI navigation rendered all four pages: ${visitedPages.join(' ')}`)

  step = 'history readback from the page'
  // Opening the history view must make the page read its own history. The view's only other
  // trigger is the "previous" control, which is disabled until a page has been read, so a view
  // that never reads on open can never show a record.
  const historyPath = record => new URL(record.url).pathname === '/api/v1/history'
  const pageReadHistory = await settle('the live history view to read /api/v1/history on its own', async () =>
    requestIdFor(networkTable(cdp.events), historyPath) !== undefined, 200, 20_000)
  const historyRecord = networkTable(cdp.events).get(requestIdFor(networkTable(cdp.events), historyPath))
  const historyInventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
  assert(pageReadHistory,
    `opening the history view issued no /api/v1/history request; the rendered count stayed ${JSON.stringify(historyInventory.historyCount)} and the "previous" control stayed disabled=${JSON.stringify(historyInventory.historyPrevEnabled)}`)
  assert(historyRecord.status === 200, `the page's own /api/v1/history returned ${historyRecord.status}`)
  check('history readback from the page', `the live history view read its own history (HTTP ${historyRecord.status}) and rendered data-history-count=${JSON.stringify(historyInventory.historyCount)} with data-history-prev enabled=${JSON.stringify(historyInventory.historyPrevEnabled)}`)

  step = 'SSE frame'
  // The shipped entry opens its own subscription (asserted above). This second EventSource is
  // created by the driver INSIDE the real page's JavaScript context so the frame can be read
  // back as text: same origin, same network layer, real server, real sequence.
  const sseResult = await evaluate(cdp, sessionId, `new Promise(resolve => {
    const source = new EventSource('/api/v1/events');
    const finish = value => { try { source.close() } catch {} ; resolve(value) };
    const timer = setTimeout(() => finish('timeout'), 15_000);
    source.addEventListener('snapshot', event => { clearTimeout(timer); finish('snapshot:' + String(event.data)) });
    source.addEventListener('error', () => { clearTimeout(timer); finish('error') });
  })`, true)
  assert(typeof sseResult === 'string' && sseResult.startsWith('snapshot:'), `the live page's EventSource did not receive a snapshot frame (${JSON.stringify(sseResult)})`)
  const sseFrame = JSON.parse(sseResult.slice('snapshot:'.length))
  assert(Number.isSafeInteger(sseFrame.seq) && sseFrame.seq >= 1, `the SSE frame carries no real sequence (${JSON.stringify(sseFrame).slice(0, 160)})`)
  assert(sseFrame.projection?.version === 1, `the SSE frame carries no v1 projection (${JSON.stringify(sseFrame).slice(0, 160)})`)
  const pageEventSourceRequests = [...networkTable(cdp.events).values()].filter(record => new URL(record.url).pathname === '/api/v1/events')
  assert(pageEventSourceRequests.some(record => record.status === 200), `the browser observed no 200 on /api/v1/events (${JSON.stringify(pageEventSourceRequests)})`)
  check('SSE frame', `a same-origin EventSource inside the live page that subscribes to \`snapshot\` received a real frame: seq=${sseFrame.seq} projectionVersion=${sseFrame.projection.version} (HTTP ${pageEventSourceRequests.map(record => record.status).join(',')} on /api/v1/events); this is the check that proves the origin's event name matches the client subscription, because it times out when the origin emits any other name`)

  step = 'projection match'
  const pageProjection = JSON.parse(pageProjectionText)
  assert(pageProjectionText === independentProjectionText,
    `the projection the page received differs from an independent HTTP read:\n  page   = ${pageProjectionText}\n  server = ${independentProjectionText}`)
  assert(JSON.stringify(sseFrame.projection) === JSON.stringify(independentProjection),
    `the SSE snapshot differs from an independent HTTP read:\n  sse    = ${JSON.stringify(sseFrame.projection)}\n  server = ${independentProjectionText}`)
  const finalInventory = await evaluate(cdp, sessionId, DOM_INVENTORY)
  assert(finalInventory.agentRows.length === independentProjection.agents.length,
    `the DOM shows ${finalInventory.agentRows.length} agent rows while the server returned ${independentProjection.agents.length}`)
  check('projection match', `page-received bytes === independent HTTP read (${pageProjectionText.length} bytes); SSE snapshot === independent read; DOM agent rows ${finalInventory.agentRows.length} === server agents ${independentProjection.agents.length}`)

  step = 'page runtime errors'
  const exceptions = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown')
  assert(exceptions.length === 0, `the live page raised ${exceptions.length} uncaught exception(s): ${JSON.stringify(exceptions.slice(0, 3))}`)
  check('page runtime errors', `0 uncaught page exceptions across the whole live session (${cdp.events.length} CDP events observed)`)

  step = 'screenshot'
  // Return to the default discovery view so the screenshot carries the frozen state bands.
  await evaluate(cdp, sessionId, `(() => { document.querySelector('[data-team-page="discovery"]')?.click(); return true })()`)
  await settle('the discovery view to render before the screenshot', async () =>
    (await evaluate(cdp, sessionId, DOM_INVENTORY)).pageView === 'discovery', 150, 10_000)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  assert(typeof shot.data === 'string' && shot.data.length > 0, 'Page.captureScreenshot returned no data')
  const png = Buffer.from(shot.data, 'base64')
  writeFileSync(SCREENSHOT_PATH, png)
  const signature = png.subarray(0, 8).toString('hex')
  assert(signature === '89504e470d0a1a0a', `the screenshot is not a PNG (signature ${signature})`)
  assert(png.length > 5_000, `the screenshot is implausibly small (${png.length} bytes)`)
  // Read the real dimensions out of the IHDR chunk instead of restating a recorded value.
  assert(png.subarray(12, 16).toString('ascii') === 'IHDR', `the first PNG chunk is ${png.subarray(12, 16).toString('ascii')}, not IHDR`)
  const pngWidth = png.readUInt32BE(16)
  const pngHeight = png.readUInt32BE(20)
  assert(pngWidth > 0 && pngHeight > 0, `the PNG IHDR carries no real size (${pngWidth}x${pngHeight})`)
  assert(pngWidth > 400 && pngHeight > 300, `the screenshot is implausibly small at ${pngWidth}x${pngHeight}`)
  check('screenshot', `real PNG written to ${SCREENSHOT_PATH}: ${pngWidth}x${pngHeight}, ${png.length} bytes (${statSync(SCREENSHOT_PATH).size} bytes on disk)`)

  /* -------------------------------------------------------------------------------------
   * Honest boundaries. Each is a check this producer genuinely cannot make here.
   * ----------------------------------------------------------------------------------- */

  gap('event-driven DOM markers',
    `data-team-cancel, data-permission-option and data-history-record need a real Session, permission or history row. This control daemon binds no Console/Session owner and declares no [discovery], so /api/v1/projection is a real but empty snapshot (${JSON.stringify(independentProjection.agents)} agents, ${independentProjection.sessions.length} sessions, ${independentProjection.notifications.length} notifications); those markers are NOT asserted and no event-driven animation is claimed`)
}

/* ---------------------------------------------------------------------------------------
 * Cleanup — explicit PID only, always in `finally`
 * ------------------------------------------------------------------------------------- */

async function cleanup() {
  try { live.cdp?.close() } catch { /* the CDP socket is already closed */ }

  if (live.chromePid !== undefined && pidAlive(live.chromePid)) {
    stopByExplicitPid(live.chromePid, 'SIGTERM')
    await settle('Chrome to exit', async () => !pidAlive(live.chromePid), 200, 10_000)
    if (pidAlive(live.chromePid)) stopByExplicitPid(live.chromePid, 'SIGKILL')
    await settle('Chrome to exit after SIGKILL', async () => !pidAlive(live.chromePid), 200, 10_000)
  }

  if (live.controlPid !== undefined && !live.controlStopped && pidAlive(live.controlPid)) {
    const stopped = runCliLogged(['control', 'stop', '--config', controlConfigPath], operatorEnv)
    live.controlStopped = true
    if (stopped.status !== 0) note(`control stop exited ${stopped.status}: ${stopped.output.slice(-200)}`)
    await settle('the control daemon to exit', async () => !pidAlive(live.controlPid), 250, 20_000)
    if (pidAlive(live.controlPid)) stopByExplicitPid(live.controlPid, 'SIGKILL')
    await settle('the control daemon to exit after SIGKILL', async () => !pidAlive(live.controlPid), 250, 10_000)
  }

  const strayChrome = processTable().filter(row => row.command.includes(`--user-data-dir=${chromeProfileDirectory}`))
  const chromeAlive = live.chromePid !== undefined && pidAlive(live.chromePid)
  const controlAlive = live.controlPid !== undefined && pidAlive(live.controlPid)
  note(`cleanup: chrome pid ${live.chromePid ?? '-'} alive=${chromeAlive} (profile-matching processes=${strayChrome.length}); control pid ${live.controlPid ?? '-'} alive=${controlAlive}`)
  if (chromeAlive || controlAlive || strayChrome.length > 0) process.exitCode = 1
}

/** Best-effort dump of everything observed so far. It never replaces the FAIL reason. */
async function dumpFailure() {
  process.stderr.write(`\n--- live-browser DOM failure dump ---\n`)
  process.stderr.write(`step: ${step}\n`)
  if (live.cdp !== undefined && live.session !== undefined) {
    try {
      const inventory = await evaluate(live.cdp, live.session, DOM_INVENTORY)
      process.stderr.write(`DOM inventory: ${JSON.stringify(inventory)}\n`)
      const shot = await live.cdp.send('Page.captureScreenshot', { format: 'png' }, live.session)
      if (typeof shot.data === 'string' && shot.data.length > 0) {
        const failureShot = join(ownedRoot, 'live-browser-dom-failure.png')
        writeFileSync(failureShot, Buffer.from(shot.data, 'base64'))
        process.stderr.write(`failure screenshot: ${failureShot}\n`)
      }
    } catch (error) {
      process.stderr.write(`DOM dump unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    try {
      const requests = networkTable(live.cdp.events)
      process.stderr.write(`network (${requests.size} requests):\n`)
      for (const record of requests.values()) process.stderr.write(`  ${record.status ?? '-'} ${record.type ?? '-'} ${record.url}\n`)
    } catch (error) {
      process.stderr.write(`network dump unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  const cliLogs = existsSync(cliLogDirectory) ? readFileSync(join(cliLogDirectory, 'cli-1.log'), 'utf8') : ''
  process.stderr.write(`control start log tail:\n${cliLogs.slice(-1200)}\n`)
  process.stderr.write(`owned temp root retained for inspection: ${ownedRoot}\n`)
}

process.exitCode = 0
try {
  await run()
} catch (error) {
  process.exitCode = 1
  const reason = error instanceof Error ? error.message : String(error)
  process.stdout.write(`live-browser DOM FAIL [${step}]: ${reason}\n`)
  await dumpFailure().catch(() => undefined)
} finally {
  await cleanup().catch(error => {
    process.exitCode = 1
    process.stderr.write(`cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}

if ((process.exitCode ?? 0) === 0) {
  process.stdout.write(`live-browser DOM PASS: ${checks.length} checks\n`)
  process.stdout.write(`gaps: ${gaps.length}\n`)
  rmSync(ownedRoot, { recursive: true, force: true })
  process.stdout.write(`cleanup: removed owned root ${ownedRoot}\n`)
} else {
  process.stderr.write(`Owned temp root retained for inspection: ${ownedRoot}\n`)
}

// Flush stdout, then exit with the recorded status. The unref'd fallback stops a stuck
// flush from hanging the producer.
const finalCode = process.exitCode ?? 0
setTimeout(() => process.exit(finalCode), 5_000).unref()
process.stdout.write('', () => process.exit(finalCode))
