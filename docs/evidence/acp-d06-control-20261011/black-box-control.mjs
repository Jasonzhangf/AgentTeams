#!/usr/bin/env node
/**
 * D06 control-daemon black box (PART 1 + PART 2).
 *
 * Real entrypoints only:
 *   - the real CLI `cli/agentteams.mjs control start|status|stop`
 *   - a real control daemon child over a real TCP socket
 *   - real HTTP requests for the browser-facing entrypoint and the wire surface
 *
 * It proves: the exact Basic challenge, served frozen UI bytes, the closed history
 * parse, a real SSE stream that closes on owner loss, the closed validation of the new
 * command kinds, and a clean CLI stop that leaves neither pid nor listening port.
 *
 * PART 2 binds the real D05 network status port, so the additive `connections` field and
 * the `kind: connection` history page are real owner reads instead of typed absences. The
 * three assertions that encoded the PART 1 unbound-port limitation were updated here; the
 * stronger PART 2 evidence (a real durable connection row returned over the wire) lives in
 * `docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs`.
 *
 * Cleanup is explicit-PID only. It never uses pkill/killall/kill $(...).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(evidenceRoot, '..', '..', '..')
// Default to the source CLI. `AGENTTEAMS_CLI` points the same black box at the packaged
// staged entrypoint, which proves the delivered artifact, not just the source tree.
const cliPath = process.env.AGENTTEAMS_CLI ?? join(projectRoot, 'cli', 'agentteams.mjs')
const PASSWORD_ENV = 'TEAMS_CONTROL_BLACKBOX_PASSWORD'
const PASSWORD = `blackbox-${Math.random().toString(36).slice(2, 12)}`
const USERNAME = 'teams'
const AUTH_CHALLENGE = 'Basic realm="AgentTeams", charset="UTF-8"'
const basic = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`

const checks = []
const startedPids = []
const workRoot = mkdtempSync(join(tmpdir(), 'acp-d06-control-blackbox-'))
// The run report is derived output and carries a pid and a temp path, so it is written to
// the owning run-notes directory. Writing it into the repo would leave the git index dirty
// after every run and break the receipt-identity gate.
const reportDir = process.env.AGENTTEAMS_EVIDENCE_OUT ?? resolve(projectRoot, '..', '.worker-runs', 'acp-d06-control-20261011')
const reportPath = join(reportDir, 'black-box-control.report.json')

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

/** A TCP connect refusal proves the listener is gone; it never inspects other processes. */
function portClosed(port, timeoutMs = 500) {
  return new Promise(resolveClosed => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = closed => { socket.destroy(); resolveClosed(closed) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
  })
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

function field(line, name) {
  const match = new RegExp(`(?:^| )${name}=([^ ]+)`).exec(line)
  return match === null ? undefined : match[1]
}

/** Reads one SSE frame's JSON payload from its `data:` line. */
function frameData(frame) {
  const line = frame.split('\n').find(entry => entry.startsWith('data: '))
  assert.ok(line !== undefined, `SSE frame has no data line: ${JSON.stringify(frame)}`)
  return JSON.parse(line.slice('data: '.length))
}

function stopByExplicitPid(pid) {
  if (!pidAlive(pid)) return
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

const configPath = join(workRoot, 'control.toml')
const dataDirectory = join(workRoot, 'state', 'control-a')
const fixturePath = join(workRoot, 'projection-fixture.json')

let port
let startedPid
let stopped = false

try {
  port = await freePort()
  mkdirSync(dirname(configPath), { recursive: true })

  // A real v4 single-daemon control config with a declared WebUI and a declared
  // credential environment reference; the value never enters the config or any log.
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
port = ${port}
allowedOrigin = "http://127.0.0.1:${port}"

[webui.auth]
username = "${USERNAME}"
passwordEnv = "${PASSWORD_ENV}"

[relations]
allowed = ["master", "peer"]
`)

  // The deterministic projection seam is an operator-supplied, closed input for the
  // SSE stream; the transport, frames and socket stay real.
  writeFileSync(fixturePath, `${JSON.stringify({
    snapshots: [
      { delayMs: 0, seq: 1, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } },
      { delayMs: 20, seq: 2, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } },
    ],
    closeAfter: { delayMs: 40, reason: 'stream-ended', detail: 'owner projection ended' },
  }, null, 2)}\n`)

  // 1. Real CLI start.
  const start = runCli(['control', 'start', '--config', configPath], {
    [PASSWORD_ENV]: PASSWORD,
    AGENTTEAMS_CONTROL_PROJECTION_FIXTURE: fixturePath,
  })
  assert.equal(start.status, 0, `control start failed: ${start.stderr || start.stdout}`)
  assert.match(start.stdout, /^started state=running /)
  startedPid = Number(field(start.stdout, 'pid'))
  assert.ok(Number.isSafeInteger(startedPid) && startedPid > 0, `no pid in: ${start.stdout}`)
  startedPids.push(startedPid)
  assert.equal(field(start.stdout, 'listener'), `127.0.0.1:${port}`)
  assert.equal(field(start.stdout, 'daemon'), 'control-a')
  assert.equal(field(start.stdout, 'data'), dataDirectory)
  assert.ok(!start.stdout.includes(PASSWORD) && !start.stderr.includes(PASSWORD), 'credential value leaked to CLI output')
  check('control start binds the declared listener with an owned pid', `pid=${startedPid} listener=127.0.0.1:${port}`)

  // 2. Real CLI status reads back the same durable generation.
  const status = runCli(['control', 'status', '--config', configPath])
  assert.equal(status.status, 0, `control status failed: ${status.stderr}`)
  assert.equal(field(status.stdout, 'state'), 'running')
  assert.equal(field(status.stdout, 'pid'), String(startedPid))
  assert.equal(field(status.stdout, 'listener'), `127.0.0.1:${port}`)
  check('control status reads back the durable generation', status.stdout)

  const origin = `http://127.0.0.1:${port}`

  // 3. The browser-facing entrypoint refuses anonymous reads with the exact challenge.
  const anonymous = await fetch(`${origin}/`)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('www-authenticate'), AUTH_CHALLENGE)
  check('anonymous WebUI request returns 401 with the exact Basic challenge', AUTH_CHALLENGE)

  // 4. Valid credentials serve the frozen UI bytes over the real socket.
  const html = await fetch(`${origin}/`, { headers: { authorization: basic } })
  assert.equal(html.status, 200)
  const htmlBody = await html.text()
  assert.ok(htmlBody.includes('AgentTeams Console'), 'console.html bytes are not the frozen console')
  const htmlBytes = readFileSync(join(projectRoot, 'console-host', 'static', 'console.html'))
  assert.equal(Buffer.byteLength(htmlBody), htmlBytes.byteLength, 'served console.html byte length differs')

  const entry = await fetch(`${origin}/console-entry.js`, { headers: { authorization: basic } })
  assert.equal(entry.status, 200)
  const entryBody = await entry.text()
  assert.equal(entryBody, readFileSync(join(projectRoot, 'console-host', 'static', 'console-entry.js'), 'utf8'))

  const browser = await fetch(`${origin}/ui/browser.js`, { headers: { authorization: basic } })
  assert.equal(browser.status, 200)
  assert.match(browser.headers.get('content-type') ?? '', /javascript/)
  const browserBody = await browser.text()
  assert.equal(browserBody, readFileSync(join(projectRoot, 'ui', 'teams-console', 'lib', 'browser.js'), 'utf8'))
  assert.match(browser.headers.get('content-security-policy') ?? '', /default-src 'self'/)
  check('served console.html, console-entry.js and ui/browser.js bytes match the frozen sources',
    `${htmlBytes.byteLength} + ${Buffer.byteLength(entryBody)} + ${Buffer.byteLength(browserBody)} bytes`)

  // 5. The v1 projection is a real payload from the owner binding.
  const projection = await fetch(`${origin}/api/v1/projection`, { headers: { authorization: basic } })
  assert.equal(projection.status, 200)
  const projectionBody = await projection.json()
  assert.equal(projectionBody.version, 1)
  assert.deepEqual(projectionBody.agents, [])
  assert.deepEqual(projectionBody.sessions, [])
  // PART 2 (A2.7): the real D05 network status port is bound, so the additive connection
  // projection is a real owner read. This daemon has no established channel, so the list is
  // honestly empty and is never an absent field or a fabricated row.
  assert.ok(Array.isArray(projectionBody.connections), 'the bound network port must project a real connections array')
  assert.deepEqual(projectionBody.connections, [], 'no connection exists, so none may be reported')
  check('projection carries the real D05 connection projection and fabricates no connection')

  // 6. The new command kinds are closed at the wire boundary; the accepted shape fails typed.
  const rejected = [
    { kind: 'network.membership.apply', agentId: 'control-a', expectedRevision: 1, members: [{ agentId: 'b', role: 'owner' }] },
    { kind: 'network.membership.apply', agentId: 'control-a', expectedRevision: 1, members: [{ agentId: 'b', role: 'peer' }, { agentId: 'b', role: 'master' }] },
    { kind: 'connection.attach', agentId: 'control-a' },
    { kind: 'connection.connect', agentId: 'control-a', role: 'master' },
    { kind: 'permission.reply', agentId: 'control-a', sessionId: 's', permissionId: 'p', decision: 'once', optionId: '' },
  ]
  for (const body of rejected) {
    const response = await fetch(`${origin}/api/v1/command`, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${response.status}`)
  }
  for (const body of [
    { kind: 'connection.connect', agentId: 'control-a' },
    { kind: 'connection.disconnect', agentId: 'control-a' },
    { kind: 'network.membership.apply', agentId: 'control-a', expectedRevision: 3, members: [{ agentId: 'b', role: 'master' }, { agentId: 'c', role: 'peer' }] },
  ]) {
    const response = await fetch(`${origin}/api/v1/command`, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200, `expected 200 for ${JSON.stringify(body)}, got ${response.status}`)
    const result = await response.json()
    // PART 2 (A2.7): the frozen D05 read port declares no mutation, so a connection command
    // is refused typed. The daemon never guesses or fakes a connection outcome.
    assert.equal(result.ok, false, `expected a typed refusal for ${JSON.stringify(body)}`)
    assert.equal(result.error.code, 'UNSUPPORTED_OPERATION')
  }
  check('new command kinds are closed at the wire boundary and the bound read port refuses mutations typed',
    `${rejected.length} refused shapes, 3 typed refusals`)

  // 7. History: a closed query parse plus a typed owner absence.
  const historyClosed = [
    '/api/v1/history?version=1&limit=5&agentId=a&agentId=b',
    '/api/v1/history?version=1&limit=5&kind=work',
    '/api/v1/history?version=2&limit=5',
    '/api/v1/history?version=1&limit=0',
    '/api/v1/history?version=1&limit=501',
    '/api/v1/history?version=1&limit=5&beforeSequence=0',
    '/api/v1/history?version=1&limit=5&unknown=1',
    '/api/v1/history?limit=5',
    '/api/v1/history?version=1',
  ]
  for (const path of historyClosed) {
    const response = await fetch(origin + path, { headers: { authorization: basic } })
    assert.equal(response.status, 400, `expected 400 for ${path}, got ${response.status}`)
  }
  // PART 2 (A2.7): the bound history surface is the real D05 connection-history owner, so a
  // connection query returns a real (empty) HistoryPage from durable storage. A request-kind
  // query is refused by that owner instead of being rewritten, and the control daemon
  // declares no second history source; the transport reports the non-absence owner failure
  // as "outcome not inferred" and never fabricates a page.
  const historyPage = await fetch(`${origin}/api/v1/history?version=1&kind=connection&limit=5`, { headers: { authorization: basic } })
  assert.equal(historyPage.status, 200)
  assert.deepEqual(await historyPage.json(), { records: [] })
  const historyRefused = await fetch(`${origin}/api/v1/history?version=1&kind=request&limit=5`, { headers: { authorization: basic } })
  assert.equal(historyRefused.status, 502)
  assert.deepEqual(await historyRefused.json(), { message: 'Console owner request failed; outcome not inferred' })
  // The relaxation is scoped: every other route keeps the blanket refusal.
  assert.equal((await fetch(`${origin}/api/v1/projection?agentId=a`, { headers: { authorization: basic } })).status, 400)
  assert.equal((await fetch(`${origin}/api/v1/events?agentId=a`, { headers: { authorization: basic } })).status, 400)
  check('history reads the real D05 connection owner and keeps a closed query parse',
    `${historyClosed.length} refused queries, 1 real empty page, 1 owner refusal`)

  // 8. SSE: a real stream with >= 2 projection frames that closes on owner loss.
  const stream = await fetch(`${origin}/api/v1/events`, { headers: { authorization: basic } })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/)
  assert.equal(stream.headers.get('cache-control'), 'no-store')
  const streamBody = await stream.text()
  const frames = streamBody.split('\n\n').filter(Boolean)
  assert.ok(frames.length >= 3, `expected at least 3 SSE frames, got ${frames.length}: ${JSON.stringify(frames)}`)
  // The event name is the name the UI live clients subscribe to; a named SSE event that no
  // listener matches is dropped silently, so it is asserted here as well as in the D06 gate.
  assert.equal(frames[0], 'event: snapshot\ndata: {"seq":1,"projection":{"version":1,"agents":[],"sessions":[],"notifications":[],"configs":[]}}')
  const second = frameData(frames[1])
  assert.equal(second.seq, 2)
  assert.equal(second.projection.version, 1)
  const last = frameData(frames[frames.length - 1])
  assert.equal(last.state, 'lost')
  assert.equal(last.reason, 'stream-ended')
  // The terminal frame is the health event, and the server never fabricated a live state.
  assert.match(frames[frames.length - 1], /^event: health\n/)
  const healthFrames = frames.filter(frame => frame.startsWith('event: health'))
  assert.equal(healthFrames.length, 1, `expected exactly one health frame, got ${healthFrames.length}`)
  assert.equal(streamBody.includes('"state":"live"'), false, 'the server fabricated a live health state')
  // response.text() only resolves because the server closed the stream itself.
  // A fresh read is a new, independent stream.
  const reopened = await fetch(`${origin}/api/v1/events`, { headers: { authorization: basic } })
  assert.equal(reopened.status, 200)
  await reopened.text()
  check('SSE streams real projection snapshots and closes the stream on owner loss',
    `${frames.length} frames, last=${last.state}/${last.reason}`)

  // 9. Clean CLI stop: no pid, no listener, no owned state.
  const stop = runCli(['control', 'stop', '--config', configPath, '--generation', field(start.stdout, 'generation')])
  assert.equal(stop.status, 0, `control stop failed: ${stop.stderr}`)
  assert.match(stop.stdout, /^stopped state=stopped /)
  stopped = true
  const deadline = Date.now() + 5_000
  while (pidAlive(startedPid) && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  assert.equal(pidAlive(startedPid), false, `control pid=${startedPid} is still alive after stop`)
  assert.equal(await portClosed(port), true, `listener 127.0.0.1:${port} is still accepting after stop`)
  // 146824a: the data directory is durable, because the daemon keeps its kind:'connection'
  // history there and D06 requires that history to survive a restart. A stop therefore removes
  // the runtime state record and keeps the directory. The D08 run found the old rm -rf here
  // destroying the history; see docs/evidence/acp-d08-acceptance-20261011/notes.md (D08-F2).
  assert.equal(existsSync(join(dataDirectory, 'control-state.json')), false, 'the runtime state record survived stop')
  assert.equal(existsSync(dataDirectory), true, 'the durable data directory was removed by stop')
  const afterStop = runCli(['control', 'status', '--config', configPath])
  assert.equal(afterStop.status, 0)
  assert.equal(field(afterStop.stdout, 'state'), 'stopped')
  check('CLI stop removes the pid, the listener and the runtime state record', `${stop.stdout}; listener closed; durable data directory kept`)

  // 10. A taken port is a typed failure at the real CLI, and it leaves no runtime state record.
  const takenPort = await freePort()
  const occupant = createServer()
  await new Promise(resolveListen => occupant.listen(takenPort, '127.0.0.1', resolveListen))
  try {
    const takenConfig = join(workRoot, 'taken.toml')
    const takenData = join(workRoot, 'state', 'taken')
    writeFileSync(takenConfig, readFileSync(configPath, 'utf8')
      .replace(/dataDirectory = .*/u, `dataDirectory = ${JSON.stringify(takenData)}`)
      .replace(/port = \d+/u, `port = ${takenPort}`)
      .replace(/allowedOrigin = .*/u, `allowedOrigin = "http://127.0.0.1:${takenPort}"`))
    const taken = runCli(['control', 'start', '--config', takenConfig], { [PASSWORD_ENV]: PASSWORD })
    assert.equal(taken.status, 1, `expected exit 1 for a taken port, got ${taken.status}: ${taken.stdout}`)
    assert.match(taken.stderr, /^PORT_OCCUPIED: /, `expected a typed PORT_OCCUPIED failure, got: ${taken.stderr}`)
    // A failed start removes the runtime state record. The durable data directory stays, for
    // the same reason a stop keeps it (146824a).
    assert.equal(existsSync(join(takenData, 'control-state.json')), false, 'a failed start kept its runtime state record')
    assert.equal(runCli(['control', 'status', '--config', takenConfig]).stdout.includes('state=running'), false)
    check('a taken webui port fails with the typed PORT_OCCUPIED code and no runtime state record', taken.stderr)
  } finally {
    await new Promise(resolveClose => occupant.close(() => resolveClose()))
  }

  const report = {
    ok: true,
    part: 'acp-d06-control-20261011-part1',
    recordedAt: new Date().toISOString(),
    projectRoot,
    configPath,
    dataDirectory,
    listener: `127.0.0.1:${port}`,
    pid: startedPid,
    checks,
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`\nD06 control black box PASS: ${checks.length} checks\n`)
} catch (error) {
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({
    ok: false,
    part: 'acp-d06-control-20261011-part1',
    recordedAt: new Date().toISOString(),
    configPath,
    dataDirectory,
    checks,
    error: error instanceof Error ? `${error.message}` : String(error),
  }, null, 2)}\n`)
  process.stderr.write(`\nD06 control black box FAIL: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  // Explicit-PID cleanup only. A clean stop already removed the process.
  if (!stopped) runCli(['control', 'stop', '--config', configPath])
  for (const pid of startedPids) stopByExplicitPid(pid)
  rmSync(workRoot, { recursive: true, force: true })
}
