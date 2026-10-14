#!/usr/bin/env node
/**
 * D06 PART 2 control-daemon black box: the real network status port.
 *
 * Real entrypoints only:
 *   - the real CLI `cli/agentteams.mjs control start|status|stop`
 *   - the real compiled D05 owners under `generated/runtime-lib/` for the durable record
 *   - a real control daemon child over a real TCP socket
 *   - real HTTP requests for the wire surface
 *
 * It proves that the control daemon binds the real D05 network status port: the additive
 * `connections` field is a real owner read, `kind: connection` history returns the real
 * durable rows the D05 owner wrote (including real pagination), a relation command for an
 * agentId this daemon does not declare is refused typed, and a clean CLI stop releases pid,
 * listener and owned state.
 *
 * `pnpm build` must have run: the CLI loads `generated/runtime-lib/runtime/control-process.js`
 * and this script loads the compiled D05 owners from the same tree.
 *
 * Cleanup is explicit-PID only. It never uses pkill/killall/kill $(...).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const evidenceRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(evidenceRoot, '..', '..', '..')
const cliPath = process.env.AGENTTEAMS_CLI ?? join(projectRoot, 'cli', 'agentteams.mjs')
const PASSWORD_ENV = 'TEAMS_CONTROL_PART2_BLACKBOX_PASSWORD'
const PASSWORD = `part2-${Math.random().toString(36).slice(2, 12)}`
const USERNAME = 'teams'
const AUTH_CHALLENGE = 'Basic realm="AgentTeams", charset="UTF-8"'
const basic = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`

const checks = []
const workRoot = mkdtempSync(join(tmpdir(), 'acp-d06-part2-blackbox-'))
const reportDir = process.env.AGENTTEAMS_EVIDENCE_OUT ?? resolve(projectRoot, '..', '.worker-runs', 'acp-d06-part2-20261011')
const reportPath = join(reportDir, 'black-box-control-part2.report.json')

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
  return match === undefined ? undefined : match[1]
}

const configPath = join(workRoot, 'control.toml')
const dataDirectory = join(workRoot, 'state', 'control-part2')

let port
let startedPid
let stopped = false

try {
  port = await freePort()
  mkdirSync(dirname(configPath), { recursive: true })

  writeFileSync(configPath, `version = 4

[daemon]
kind = "control"
id = "control-part2"
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

  // 1. A real durable connection row, written through the real compiled D05 owners — the
  //    same store and the same record vocabulary the daemon itself uses. The daemon must
  //    return this row over the wire unchanged.
  const { createAcpHistoryStore } = await import(pathToFileURL(join(projectRoot, 'generated', 'runtime-lib', 'runtime', 'acp-history-store.js')).href)
  const { createTeamsConnectionHistory } = await import(pathToFileURL(join(projectRoot, 'generated', 'runtime-lib', 'network', 'teams-connection-history.js')).href)
  const store = await createAcpHistoryStore({ directory: dataDirectory })
  const history = createTeamsConnectionHistory(store)
  const first = await history.record({
    event: 'connection.negotiated',
    agentId: 'peer-b',
    occurredAt: '2026-10-11T00:00:00.000Z',
    connectionId: 'connection-1',
    outcome: 'completed',
  })
  const second = await history.record({
    event: 'connection.closed',
    agentId: 'peer-b',
    occurredAt: '2026-10-11T00:01:00.000Z',
    connectionId: 'connection-1',
    outcome: 'completed',
  })
  assert.equal(first.kind, 'connection')
  assert.equal(first.sequence, 1)
  assert.equal(second.sequence, 2)
  assert.ok(existsSync(join(dataDirectory, 'acp-history.json')), 'the real durable store file was not written')
  check('the real D05 owner wrote two durable connection rows', `sequences=${first.sequence},${second.sequence} file=acp-history.json`)

  // 2. Real CLI start.
  const start = runCli(['control', 'start', '--config', configPath], { [PASSWORD_ENV]: PASSWORD })
  assert.equal(start.status, 0, `control start failed: ${start.stderr || start.stdout}`)
  assert.match(start.stdout, /^started state=running /)
  startedPid = Number(field(start.stdout, 'pid'))
  assert.ok(Number.isSafeInteger(startedPid) && startedPid > 0, `no pid in: ${start.stdout}`)
  assert.equal(field(start.stdout, 'listener'), `127.0.0.1:${port}`)
  assert.equal(field(start.stdout, 'data'), dataDirectory)
  assert.ok(!start.stdout.includes(PASSWORD) && !start.stderr.includes(PASSWORD), 'credential value leaked to CLI output')
  check('control start binds the declared listener with an owned pid', `pid=${startedPid} listener=127.0.0.1:${port}`)

  const origin = `http://127.0.0.1:${port}`
  assert.equal((await fetch(`${origin}/`)).status, 401)
  const challenge = await fetch(`${origin}/`)
  assert.equal(challenge.headers.get('www-authenticate'), AUTH_CHALLENGE)
  check('anonymous WebUI request returns 401 with the exact Basic challenge', AUTH_CHALLENGE)

  // 3. The additive connection projection is a real owner read from the bound D05 port.
  const projection = await fetch(`${origin}/api/v1/projection`, { headers: { authorization: basic } })
  assert.equal(projection.status, 200)
  const projectionBody = await projection.json()
  assert.equal(projectionBody.version, 1)
  assert.deepEqual(projectionBody.agents, [])
  assert.ok(Array.isArray(projectionBody.connections), 'the bound port must project a real connections array')
  assert.deepEqual(projectionBody.connections, [], 'no channel is established, so no connection may be reported')
  check('the bound D05 port projects a real connection list and fabricates none', 'connections=[]')

  // 4. The real durable rows come back over the wire, newest first, with real pagination.
  const page = await fetch(`${origin}/api/v1/history?version=1&kind=connection&limit=5`, { headers: { authorization: basic } })
  assert.equal(page.status, 200)
  const pageBody = await page.json()
  assert.equal(pageBody.records.length, 2)
  assert.deepEqual(pageBody.records.map(record => [record.sequence, record.event, record.agentId, record.connectionId, record.outcome]), [
    [2, 'connection.closed', 'peer-b', 'connection-1', 'completed'],
    [1, 'connection.negotiated', 'peer-b', 'connection-1', 'completed'],
  ])
  const firstPage = await (await fetch(`${origin}/api/v1/history?version=1&kind=connection&limit=1`, { headers: { authorization: basic } })).json()
  assert.equal(firstPage.records.length, 1)
  assert.equal(firstPage.records[0].sequence, 2)
  assert.equal(firstPage.nextBeforeSequence, 2)
  const nextPage = await (await fetch(`${origin}/api/v1/history?version=1&kind=connection&limit=1&beforeSequence=2`, { headers: { authorization: basic } })).json()
  assert.equal(nextPage.records.length, 1)
  assert.equal(nextPage.records[0].sequence, 1)
  assert.equal('nextBeforeSequence' in nextPage, false)
  check('history returns the real durable connection rows with real pagination', '2 rows, 1 + 1 paged')

  // 5. A2.4 relation commands name a target this daemon must be able to resolve. This
  //    daemon declares no [peers], so the target cannot be resolved: the command is a
  //    typed refusal that guesses no relation, no record path and no connection outcome.
  const command = await fetch(`${origin}/api/v1/command`, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'connection.connect', agentId: 'peer-b' }),
  })
  assert.equal(command.status, 200)
  const commandBody = await command.json()
  assert.equal(commandBody.ok, false)
  assert.equal(commandBody.error.code, 'FORBIDDEN')
  assert.equal('result' in commandBody, false)
  check('a relation command for an agentId the daemon does not declare is refused typed with no result',
    commandBody.error.code)

  // 6. Clean CLI stop: no pid, no listener, no owned state.
  const stop = runCli(['control', 'stop', '--config', configPath, '--generation', field(start.stdout, 'generation')])
  assert.equal(stop.status, 0, `control stop failed: ${stop.stderr}`)
  assert.match(stop.stdout, /^stopped state=stopped /)
  stopped = true
  const deadline = Date.now() + 5_000
  while (pidAlive(startedPid) && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  assert.equal(pidAlive(startedPid), false, `control pid=${startedPid} is still alive after stop`)
  assert.equal(await portClosed(port), true, `listener 127.0.0.1:${port} is still accepting after stop`)
  // 146824a: the durable data directory holds this daemon's kind:'connection' history, so a
  // stop removes the runtime state record and keeps the directory. See D08-F2.
  assert.equal(existsSync(join(dataDirectory, 'control-state.json')), false, 'the runtime state record survived stop')
  assert.equal(existsSync(dataDirectory), true, 'the durable data directory was removed by stop')
  check('CLI stop removes the pid, the listener and the runtime state record', `${stop.stdout}; listener closed; durable data directory kept`)
} catch (error) {
  process.stderr.write(`\nD06 PART 2 control black box FAIL: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  if (!stopped && startedPid !== undefined && pidAlive(startedPid)) {
    try { process.kill(startedPid, 'SIGTERM') } catch { /* already gone */ }
  }
  try {
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify({ checks, failed: process.exitCode === 1 }, null, 2)}\n`)
  } catch { /* the report is derived output; a write failure never changes the verdict */ }
  rmSync(workRoot, { recursive: true, force: true })
  if (process.exitCode !== 1) process.stdout.write(`\nD06 PART 2 control black box PASS: ${checks.length} checks\n`)
}
