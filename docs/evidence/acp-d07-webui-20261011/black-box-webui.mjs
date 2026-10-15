#!/usr/bin/env node
/**
 * D07 WebUI black box.
 *
 * Real entrypoints only:
 *   - a full `pnpm build` when the compiled UI is missing
 *   - the real `cli/agentteams.mjs control start|status|stop`
 *   - real HTTP over the real WebUI listener, including anonymous and authenticated calls
 *   - real HTTP for the served `/ui/` module graph, history, request-kind refusal and SSE
 *
 * It asserts the frozen HTTP contract, the honest unavailable commands and the anonymous
 * Basic challenge. It does not claim live-browser DOM evidence: headless Chrome cannot
 * supply HTTP Basic credentials to a same-origin `fetch` or `EventSource`, so the frozen DOM
 * marker contract is proven by the real-Chrome render test
 * `ui/teams-console/tests/render-d07.spec.ts` instead.
 *
 * Cleanup is explicit-PID only: no pkill, killall, kill $(...), or xargs kill.
 * On PASS the owned temp root is removed; on failure it is preserved for inspection.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(evidenceRoot, '..', '..', '..')
const cliPath = join(projectRoot, 'cli', 'agentteams.mjs')
const PASSWORD_ENV = 'TEAMS_WEBUI_BLACKBOX_PASSWORD'
const PASSWORD = `blackbox-${Math.random().toString(36).slice(2, 12)}`
const USERNAME = 'teams'
const credential = `${USERNAME}:${PASSWORD}`
const basic = `Basic ${Buffer.from(credential).toString('base64')}`
const D07_MOUNT_MARKER = 'data-team-page-view'
const D07_MOUNT_MARKER_ALTERNATIVE = 'data-team-page'
const FETCH_TIMEOUT_MS = 12_000
const CLI_TIMEOUT_MS = 60_000

const workRoot = mkdtempSync(join(tmpdir(), 'acp-d07-webui-blackbox-'))
const checks = []
const timedOutWaitNames = []
const startedPids = []
let stopped = false
let port
let daemonPid
let generation
let origin

function step(label, operation, timeoutMs = FETCH_TIMEOUT_MS) {
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, rejectTimeout) => {
      const timer = setTimeout(() => rejectTimeout(new Error(`${label} timed out`)), timeoutMs)
      timer.unref?.()
    }),
  ])
}

async function settle(label, predicate, intervalMs = 100, timeoutMs = FETCH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true
    } catch {
      // A transient failure while polling must not consume a later real observation.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs))
  }
  timedOutWaitNames.push(label)
  return false
}

function check(name, detail) {
  checks.push({ name, detail, ok: true })
  process.stdout.write(`PASS ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

function field(line, name) {
  const match = new RegExp(`(?:^| )${name}=([^ ]+)`).exec(line)
  return match === null ? undefined : match[1]
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: CLI_TIMEOUT_MS,
  })
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

function runPnpmBuild() {
  const result = spawnSync('pnpm', ['build'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 300_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(result.status, 0, `pnpm build failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); rejectPort(new Error('no port')); return }
      const selectedPort = address.port
      server.close(() => resolvePort(selectedPort))
    })
  })
}

function portClosed(localPort, timeoutMs = 2_000) {
  return new Promise(resolveClosed => {
    const socket = connect({ host: '127.0.0.1', port: localPort })
    const done = closed => { socket.destroy(); resolveClosed(closed) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
  })
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function stopByExplicitPid(pid) {
  if (!Number.isInteger(pid) || !pidAlive(pid)) return
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

async function authFetch(path, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  timer.unref?.()
  try {
    return await fetch(new URL(path, origin), { ...init, headers: { authorization: basic, ...(init.headers ?? {}) }, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readBoundedSseFrame() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetch(`${origin}/api/v1/events`, { headers: { authorization: basic }, signal: controller.signal })
    if (!response.ok) throw new Error(`SSE returned HTTP ${response.status}`)
    if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      throw new Error(`SSE content-type is ${response.headers.get('content-type')}`)
    }
    if (!(response.headers.get('cache-control') ?? '').includes('no-store')) {
      throw new Error(`SSE cache-control is ${response.headers.get('cache-control')}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf8')
    let buffer = ''
    while (!buffer.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    const frame = buffer.split('\n\n')[0] ?? ''
    const line = frame.split('\n').find(entry => entry.startsWith('data: '))
    assert.ok(line, `no data line in bounded SSE read: ${JSON.stringify(frame)}`)
    return JSON.parse(line.slice('data: '.length))
  } finally {
    clearTimeout(timer)
  }
}

async function assertRefusedCommand(kind, body) {
  const response = await authFetch('/api/v1/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200, `${kind} command returned HTTP ${response.status}`)
  const result = await response.json()
  assert.equal(result.ok, false, `${kind} was not refused`)
  assert.equal(typeof result.error?.code, 'string', `${kind} refusal lacks a real code`)
  return result.error.code
}


const configPath = join(workRoot, 'control.toml')
const dataDirectory = join(workRoot, 'state', 'control-a')
let stopOutput
let stopError

try {
  const browserPath = join(projectRoot, 'ui', 'teams-console', 'lib', 'browser.js')
  await step('full pnpm build if compiled UI is absent', async () => {
    if (!existsSync(browserPath) || !existsSync(join(projectRoot, 'console-host', 'static', 'console.html'))) runPnpmBuild()
  }, 330_000)
  check('compiled control UI assets are present', `browser=${browserPath}`)

  port = await step('allocate loopback port', freePort)
  const selectedPort = port
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `version = 4

[daemon]
kind = "control"
id = "control-a"
hostId = "blackbox-host"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(dataDirectory)}

[webui]
ip = "127.0.0.1"
port = ${selectedPort}
allowedOrigin = "http://127.0.0.1:${selectedPort}"

[webui.auth]
username = "${USERNAME}"
passwordEnv = "${PASSWORD_ENV}"

[relations]
allowed = ["master", "peer"]
`)

  const start = await step('real control start', async () => runCli(['control', 'start', '--config', configPath], { [PASSWORD_ENV]: PASSWORD }), CLI_TIMEOUT_MS)
  assert.equal(start.status, 0, `control start failed: ${start.stderr || start.stdout}`)
  assert.match(start.stdout, /^started state=running /)
  daemonPid = Number(field(start.stdout, 'pid'))
  generation = field(start.stdout, 'generation')
  assert.ok(Number.isSafeInteger(daemonPid) && daemonPid > 0, `no pid in: ${start.stdout}`)
  startedPids.push(daemonPid)
  assert.equal(field(start.stdout, 'listener'), `127.0.0.1:${port}`)
  assert.equal(field(start.stdout, 'daemon'), 'control-a')
  assert.equal(field(start.stdout, 'data'), dataDirectory)
  check('control start binds the declared WebUI listener with an owned pid', `pid=${daemonPid} listener=127.0.0.1:${port}`)

  const status = await step('real control status', async () => runCli(['control', 'status', '--config', configPath]), CLI_TIMEOUT_MS)
  assert.equal(status.status, 0, `control status failed: ${status.stderr}`)
  assert.equal(field(status.stdout, 'state'), 'running')
  assert.equal(field(status.stdout, 'pid'), String(daemonPid))
  assert.equal(field(status.stdout, 'listener'), `127.0.0.1:${port}`)
  check('control status reads back the durable generation', status.stdout)

  origin = `http://127.0.0.1:${port}`

  const home = await step('GET /', () => authFetch('/'))
  assert.equal(home.status, 200)
  const homeBody = await home.text()
  assert.ok(homeBody.includes('console.html') || homeBody.includes('/console-entry.js'), 'home HTML does not reference console-entry.js')
  assert.ok(homeBody.includes('/console-entry.js'), 'home HTML does not reference /console-entry.js')
  check('GET / serves static console.html referencing /console-entry.js', homeBody.slice(0, 80).replaceAll('\n', ' '))

  const entry = await step('GET /console-entry.js', () => authFetch('/console-entry.js'))
  assert.equal(entry.status, 200)
  const entryBody = await entry.text()
  assert.ok(entryBody.length > 0, 'console-entry.js is empty')
  check('GET /console-entry.js serves the browser bootstrap')

  const browser = await step('GET /ui/browser.js', () => authFetch('/ui/browser.js'))
  assert.equal(browser.status, 200)
  assert.match(browser.headers.get('content-type') ?? '', /javascript/)
  const browserBody = await browser.text()
  check('GET /ui/browser.js serves the browser barrel', `${browserBody.length} bytes`)

  // `/ui/browser.js` is a tsc re-export barrel: the D07 page modules live in the chunks it
  // imports. Walk the served module graph so the marker assertion reflects what the browser
  // actually loads, not just the single barrel file.
  const graph = await step('GET the served /ui/ module graph', async () => {
    const visited = new Set()
    const queue = ['/ui/browser.js']
    const bodies = []
    while (queue.length > 0 && visited.size < 64) {
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
    return { modules: visited.size, graph: bodies.join('\n'), summary: [...visited].join(', ') }
  })
  assert.ok(graph.graph.includes(D07_MOUNT_MARKER) || graph.graph.includes(D07_MOUNT_MARKER_ALTERNATIVE),
    `the served /ui/ module graph (${graph.modules} modules) has no D07 mount markers`)
  check('the served /ui/ module graph carries the D07 mount markers',
    `${graph.modules} modules: ${graph.summary.slice(0, 120)}`)

  const projectionResponse = await step('GET projection', () => authFetch('/api/v1/projection'))
  assert.equal(projectionResponse.status, 200)
  assert.ok((projectionResponse.headers.get('content-type') ?? '').startsWith('application/json'))
  const projection = await projectionResponse.json()
  assert.equal(projection.version, 1)
  check('GET /api/v1/projection returns v1 JSON projection', JSON.stringify(projection).length)

  const historyResponse = await step('GET history', () => authFetch('/api/v1/history?version=1&limit=50'))
  assert.equal(historyResponse.status, 200)
  assert.ok((historyResponse.headers.get('content-type') ?? '').startsWith('application/json'))
  const historyPage = await historyResponse.json()
  assert.ok(Array.isArray(historyPage.records), 'history response lacks records[] HistoryPage shape')
  check('GET /api/v1/history returns a HistoryPage shape', `records=${historyPage.records.length}`)

  const refusedHistory = await step('GET request-kind history', () => authFetch('/api/v1/history?version=1&limit=50&kind=request'))
  assert.ok(!refusedHistory.ok, 'kind=request history returned a 2xx page')
  const refusedHistoryBody = await refusedHistory.text()
  // The observed boundary is deliberately asserted exactly as it is, not as we would like it:
  // the D06-owned history route maps an owner failure that is not an owner absence to a bare
  // 502 and drops the owner's typed code. So this check proves the refusal is a 5xx and that
  // no typed code reaches the client here. The UI's typed-code rendering is a separate
  // unit-level claim and is NOT proven by this driver.
  assert.equal(refusedHistory.status, 502, `kind=request history returned ${refusedHistory.status} instead of the observed bare 502`)
  let refusedHistoryPayload
  try { refusedHistoryPayload = JSON.parse(refusedHistoryBody) } catch { refusedHistoryPayload = null }
  assert.ok(refusedHistoryPayload !== null, 'kind=request history body is not JSON')
  assert.equal(refusedHistoryPayload.code, undefined, 'the observed 502 now carries a typed code; update the evidence instead of keeping a stale boundary note')
  check('GET /api/v1/history?kind=request is refused with a bare 502 and no typed code', `status=${refusedHistory.status} code=absent body=${refusedHistoryBody.slice(0, 90)}`)

  const sseFrame = await step('GET SSE projection frame', readBoundedSseFrame)
  assert.ok(Number.isSafeInteger(sseFrame.seq), 'SSE data frame lacks integer seq')
  assert.equal(sseFrame.projection?.version, 1, 'SSE snapshot projection.version is not 1')
  check('GET /api/v1/events streams a real { seq, projection } snapshot', `seq=${sseFrame.seq} version=${sseFrame.projection.version}`)

  // The frozen write commands are typed at the real HTTP surface. This config declares no
  // `peers`, so the control daemon cannot resolve an account and scope for the requested
  // agentId and refuses FORBIDDEN instead of guessing a relation or a record path. All three
  // refusals therefore report the target rule, not the missing-owner rule.
  // 2026-10-15 correction (L9 session-write-side): `permission.reply` used to answer
  // `UNSUPPORTED_OPERATION` because no Session owner was bound. That write side is now bound, so
  // the same undeclared-agentId target rule refuses it FORBIDDEN before any write. The assertion
  // below states the current behaviour; the old expectation is superseded, not a pass.
  const connectCode = await assertRefusedCommand('connection.connect', { kind: 'connection.connect', agentId: 'control-a' })
  assert.equal(connectCode, 'FORBIDDEN')
  const membershipCode = await assertRefusedCommand('network.membership.apply', {
    kind: 'network.membership.apply',
    agentId: 'control-a',
    expectedRevision: 1,
    members: [{ agentId: 'peer-a', role: 'master' }, { agentId: 'peer-b', role: 'peer' }],
  })
  assert.equal(membershipCode, 'FORBIDDEN')
  const permissionCode = await assertRefusedCommand('permission.reply', {
    kind: 'permission.reply',
    agentId: 'control-a',
    sessionId: 'session-does-not-exist',
    permissionId: 'permission-does-not-exist',
    decision: 'once',
    optionId: 'option-not-offered',
  })
  assert.equal(permissionCode, 'FORBIDDEN')
  check('D07 write commands are typed refusals on the real HTTP surface',
    `connection.connect=${connectCode}; network.membership.apply=${membershipCode}; permission.reply=${permissionCode}`)

  // A `permission.reply` payload carrying a field outside the frozen ConsoleCommandV1
  // vocabulary (`callbackId`) must be refused by the closed command parser, never accepted
  // and never forwarded to an engine. The control daemon has no Session owner, so the
  // refused `optionId` can only reach an engine if this boundary is broken.
  const malformedCommand = await step('POST a malformed permission.reply', () => authFetch('/api/v1/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'permission.reply',
      agentId: 'control-a',
      sessionId: 'session-does-not-exist',
      permissionId: 'permission-does-not-exist',
      decision: 'once',
      optionId: 'option-not-offered',
      callbackId: 'callback-id-no-pending-callback-holds',
    }),
  }))
  assert.equal(malformedCommand.status, 400,
    `a permission.reply payload outside the frozen vocabulary returned HTTP ${malformedCommand.status}`)
  const malformedBody = await malformedCommand.text()
  check('a permission.reply payload outside the frozen vocabulary is refused by the parser',
    `status=400 body=${malformedBody.slice(0, 70)}`)

  // Serving gate: an unauthenticated request must be challenged, not served. This is the
  // negative half of the real browser evidence; the authenticated DOM contract itself is
  // proven in `ui/teams-console/tests/render-d07.spec.ts` under real Chrome, because
  // headless Chrome cannot supply HTTP Basic credentials to a same-origin `fetch` or
  // `EventSource`.
  const anonymousHome = await step('GET / without credentials', () => fetch(origin).catch(() => null))
  const anonymousStatus = anonymousHome === null ? 'unreachable' : String(anonymousHome.status)
  const anonymousChallenge = anonymousHome === null ? '' : (anonymousHome.headers.get('www-authenticate') ?? '')
  assert.equal(anonymousStatus, '401', `an unauthenticated GET / returned ${anonymousStatus} instead of 401`)
  assert.match(anonymousChallenge, /^Basic/, `the anonymous challenge is not HTTP Basic: ${anonymousChallenge}`)
  await anonymousHome.body?.cancel().catch(() => {})
  check('the WebUI refuses an unauthenticated browser with a Basic challenge',
    `status=401 challenge=${anonymousChallenge}`)

  // Browser evidence boundary: headless Chrome cannot satisfy this origin's HTTP Basic
  // challenge and cannot attach an Authorization header to a same-origin `fetch` or
  // `EventSource`. A credentialed origin URL is rejected by `fetch` itself
  // ("Request cannot be constructed from a URL that includes credentials"), and the owner
  // serves no credentials endpoint. So D07 claims no live-browser DOM evidence here, and the
  // frozen DOM marker contract is proven separately in real Chrome by
  // `ui/teams-console/tests/render-d07.spec.ts`, which renders the real page modules into a
  // real DOM and checks every frozen marker. No screenshot artifact is claimed: Chrome writes
  // no file for an unauthenticated origin and exits 0, so a captured image would be a blank
  // error page rather than the console.

  const stop = await step('real control stop', async () => runCli(['control', 'stop', '--config', configPath, '--generation', generation ?? '1']), CLI_TIMEOUT_MS)
  assert.equal(stop.status, 0, `control stop failed: ${stop.stderr}`)
  assert.match(stop.stdout, /^stopped state=stopped /)
  stopped = true
  const stopReady = await settle('explicit PID and listener settle after stop', async () => !pidAlive(daemonPid) && await portClosed(port), 50, 5_000)
  assert.equal(stopReady, true, `control pid=${daemonPid} or listener 127.0.0.1:${port} survived explicit-PID stop`)
  assert.equal(pidAlive(daemonPid), false, `control pid=${daemonPid} is still alive after stop`)
  assert.equal(await portClosed(port), true, `listener 127.0.0.1:${port} is still accepting after stop`)
  check('control stop uses the explicit pid and releases the listener', `${stop.stdout}; listener closed`)

  rmSync(workRoot, { recursive: true, force: true })
  process.stdout.write(`\nD07 WebUI black box PASS: ${checks.length} checks\n`)
} catch (error) {
  const firstFailedWait = timedOutWaitNames.length > 0 ? `; timed-out wait: ${timedOutWaitNames.at(-1)}` : ''
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`\nD07 WebUI black box FAIL: ${message}${firstFailedWait}\n`)
  process.stderr.write(`Preserved temp root: ${workRoot}\n`)
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
} finally {
  if (!stopped) {
    try { runCli(['control', 'stop', '--config', configPath, '--generation', generation ?? '1']) } catch { /* keep the typed CLI output if cleanup itself fails */ }
  }
  for (const pid of startedPids) stopByExplicitPid(pid)
  if (process.exitCode === 0) rmSync(workRoot, { recursive: true, force: true })
}
process.stdout.write('')
process.exit(process.exitCode ?? 0)
