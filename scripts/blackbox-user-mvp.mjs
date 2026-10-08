#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'toml'
import { currentCandidateIdentity, validateCandidateIdentity } from './receipt-identity.mjs'

const root = resolve(import.meta.dirname, '..')
const defaultPackRoot = join(root, 'generated', 'modules', 'teams-source', 'lib')
const defaultPackageReceiptPath = join(root, 'generated', 'modules', 'teams-source', 'package-receipt.json')
const defaultReceiptPath = join(root, 'generated', 'u7-driver', 'blackbox-user-mvp.receipt.json')
export const exitCode = Object.freeze({ passed: 0, failed: 1, unverified: 2 })

// The BB09 installed Console fixture owns one credential reference. The value
// only exists in this process environment and in the isolated installed HOME.
const consoleUsername = 'bb-console'
const consolePasswordEnv = 'AGENTTEAMS_BB_CONSOLE_PASSWORD'
const consolePassword = 'bb-console-pass'
const consoleLinkAuthEnv = 'AGENTTEAMS_CONSOLE_AUTH'
const consoleLinkAuth = 'bb-console-link'

const cases = [
  { id: 'BB01', owner: 'U1+U5+U7', gate: 'installed package lifecycle and Console assets', implemented: true, run: runBB01 },
  { id: 'BB02', owner: 'U2+U7', gate: 'config.toml-only two-daemon bridge discovery', implemented: true, run: runBB02 },
  { id: 'BB03', owner: 'U3', gate: 'real browser service lifecycle and capacity', implemented: true, run: runBB03 },
  { id: 'BB04', owner: 'D3/U4', gate: 'installed public Work submit and query', implemented: true, run: runBB04 },
  { id: 'BB05', owner: 'U3+U4', gate: 'installed Work rejection matrix', implemented: true, run: runBB05 },
  { id: 'BB06', owner: 'U3+U4', gate: 'persistent browser Work capacity', implemented: true, run: runBB06 },
  { id: 'BB07', owner: 'D3/U4', gate: 'installed Work unknown and recovery query', implemented: true, run: runBB07 },
  { id: 'BB08', owner: 'U2+U4', gate: 'installed config generation and stale rejection', implemented: true, run: runBB08 },
  { id: 'BB09', owner: 'U5', gate: 'installed Console lifecycle and offline Work', implemented: true, run: runBB09 },
  { id: 'BB10', owner: 'U2+U6', gate: 'installed explicit provider/model session', implemented: true, run: runBB10 },
  { id: 'BB11', owner: 'D3/U4', gate: 'installed SDK Work and compile negatives', implemented: true, run: runBB11 },
  { id: 'BB12', owner: 'U6', gate: 'installed Session message tool permission cancel', implemented: true, run: runBB12 },
  { id: 'BB13', owner: 'D4/U7', gate: 'existing lifecycle store failure recovery invalidation matrix', implemented: true, run: runBB13 },
  { id: 'BB14', owner: 'U1+U7', gate: 'failed start stop and owned resource cleanup', implemented: true, run: runBB14 },
]

function usage() {
  return `usage: node scripts/blackbox-user-mvp.mjs --help
       node scripts/blackbox-user-mvp.mjs --list
       node scripts/blackbox-user-mvp.mjs --case <ID>[,<ID>...] --receipt <path>
       node scripts/blackbox-user-mvp.mjs --case all --receipt <path>

Cases: ${cases.map(item => item.id).join(', ')}
Exit codes: 0 passed, 1 failed, 2 unverified`
}

function fail(message) {
  throw new Error(`blackbox-user-mvp: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function now() {
  return new Date().toISOString()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256(readFileSync(path))
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env,
  })
  const output = {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
  if (options.logPath !== undefined) writeJson(options.logPath, output)
  if (options.expectStatus !== undefined && result.status !== options.expectStatus) {
    fail(`${command} ${args.join(' ')} exited ${result.status}; expected ${options.expectStatus}\n${output.stderr || output.stdout}`)
  }
  if (options.expectNonZero === true && (result.status === 0 || result.status === null)) {
    fail(`${command} ${args.join(' ')} unexpectedly succeeded\n${output.stdout}${output.stderr}`)
  }
  return output
}

function runChecked(command, args, options = {}) {
  return run(command, args, { ...options, expectStatus: 0 })
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForProcessesGone(pids, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every(pid => !processAlive(pid))) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  const alive = pids.filter(pid => processAlive(pid))
  fail(`owned process cleanup is unconfirmed: ${alive.join(', ')}`)
}

function parseCliStatus(stdout) {
  const state = /(?:^|\s)state=([^\s]+)/u.exec(stdout)?.[1]
  const generation = Number(/(?:^|\s)generation=(\d+)(?:\s|$)/u.exec(stdout)?.[1])
  const pid = Number(/(?:^|\s)pid=(\d+)(?:\s|$)/u.exec(stdout)?.[1])
  const endpoints = [...stdout.matchAll(/endpoint=(\S+) identity=(\S+) role=(\S+) presence=(\S+) generation=(\d+) capabilities=(\S+)/gu)].map(match => ({
    agentId: match[1],
    identity: match[2],
    role: match[3],
    presence: match[4],
    generation: Number(match[5]),
    capabilities: match[6] === '-' ? [] : match[6].split(','),
  }))
  return {
    state,
    generation: Number.isSafeInteger(generation) ? generation : undefined,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
    endpoints,
  }
}

function listeningPids(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0 || result.stdout.trim() === '') return []
  return result.stdout.trim().split(/\s+/u).map(Number).filter(Number.isSafeInteger)
}

function assertPortsClosed(ports) {
  const open = Object.entries(ports)
    .map(([id, port]) => ({ id, port, pids: listeningPids(port) }))
    .filter(item => item.pids.length > 0)
  assert(open.length === 0, `owned listeners remain: ${JSON.stringify(open)}`)
}

const defaultAgentIds = Object.freeze(['bb-provider', 'bb-receiver'])

function parseInternal(path, agentIds = defaultAgentIds) {
  const internal = parseToml(readFileSync(path, 'utf8'))
  const launcher = internal.launcher
  assert(launcher?.state === 'running', 'internal launcher is not running')
  const ids = ['relay', ...agentIds]
  const processes = ids.map(id => {
    const record = internal.daemon?.[id]
    assert(record?.pid > 0 && Number.isSafeInteger(record.pid), `internal ${id} pid is missing`)
    assert(typeof record.entryPath === 'string' && record.entryPath.length > 0, `internal ${id} entryPath is missing`)
    assert(record.generation === launcher.generation, `internal ${id} generation does not match launcher`)
    return { id, pid: record.pid, entryPath: record.entryPath, generation: record.generation, startToken: record.startToken }
  })
  const relayProjection = JSON.parse(internal.relay?.config ?? '')
  const daemonConfigs = Object.fromEntries(agentIds.map(id => {
    const record = internal.daemon?.[id]
    assert(record?.config !== undefined, `internal ${id} projection is missing`)
    return [id, JSON.parse(record.config)]
  }))
  const ports = {
    relay: relayProjection.listen?.port,
    ...Object.fromEntries(agentIds.map(id => [id, daemonConfigs[id].leasePort])),
  }
  for (const [id, port] of Object.entries(ports)) {
    assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, `internal ${id} port is invalid`)
  }
  assert(new Set(Object.values(ports)).size === Object.keys(ports).length, 'internal ports contain duplicates')
  return {
    internalPath: path,
    launcher: { pid: launcher.pid, generation: launcher.generation, startToken: launcher.startToken },
    processes,
    ports,
    services: Object.fromEntries(agentIds.map(id => [id, daemonConfigs[id].endpoint?.services ?? []])),
  }
}

function lifecyclePids(internal) {
  return [internal.launcher.pid, ...internal.processes.map(process => process.pid)]
}

function configFixtureText(searchExecutable, options = {}) {
  const consoleSection = options.console === true
    ? `
[console]
enabled = true
username = ${JSON.stringify(consoleUsername)}
passwordEnv = ${JSON.stringify(consolePasswordEnv)}
`
    : ''
  return `version = 3

[bridge]
enabled = true

[agents.bb-provider]
enabled = true
role = "provider"
label = "BB-Provider"

[agents.bb-provider.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "bb-account"
agentKind = "custom"
label = "BB-Provider"

[agents.bb-provider.runtime]
scopeId = "bb-scope"
dataDirectory = "data/bb-provider"
policy = { revision = 1, allowedConsumers = ["bb-receiver"], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-bb-provider" }

[agents.bb-provider.services.file-search]
version = "1"
operations = ["search"]
resources = [{ resourceId = "search-slot", capacity = 2, unit = "slot" }]

[agents.bb-receiver]
enabled = true
role = "receiver"
label = "BB-Receiver"

[agents.bb-receiver.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "bb-account"
agentKind = "custom"
label = "BB-Receiver"

[agents.bb-receiver.runtime]
scopeId = "bb-scope"
dataDirectory = "data/bb-receiver"
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-bb-receiver" }

[agents.bb-receiver.connect]
targetAgentId = "bb-provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
demands = [{ resourceId = "search-slot", amount = 1 }]
${consoleSection}`
}

/**
 * The installed launcher publishes `<config dir>/.internal/work-control.sock`.
 * A unix socket path is limited to about 104 bytes, so the fixture root must stay
 * short. Prefer `/tmp` over a long per-user TMPDIR so the control socket is created.
 */
function temporaryRootBase() {
  return existsSync('/tmp') ? '/tmp' : tmpdir()
}

function installPackage(packRoot, evidenceDir, label, extraEnv = {}) {
  const temporaryRoot = mkdtempSync(join(temporaryRootBase(), `agentteams-u7-${label}-`))
  const prefix = join(temporaryRoot, 'prefix')
  const home = join(temporaryRoot, 'home')
  const npmCache = join(temporaryRoot, 'npm-cache')
  const packDestination = join(temporaryRoot, 'pack')
  mkdirSync(home, { recursive: true })
  mkdirSync(prefix, { recursive: true })
  mkdirSync(npmCache, { recursive: true })
  mkdirSync(packDestination, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    AGENTTEAMS_BB_PROVIDER_AUTH: 'bb-provider-auth',
    AGENTTEAMS_BB_RECEIVER_AUTH: 'bb-receiver-auth',
    [consoleLinkAuthEnv]: consoleLinkAuth,
    [consolePasswordEnv]: consolePassword,
    ...extraEnv,
  }
  const packed = runChecked('npm', ['pack', packRoot, '--pack-destination', packDestination, '--json'], {
    cwd: temporaryRoot,
    env: { ...env, npm_config_cache: npmCache },
    logPath: join(evidenceDir, 'npm-pack.json'),
  })
  const packResult = JSON.parse(packed.stdout)[0]
  const tarball = join(packDestination, packResult.filename)
  runChecked('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-package-lock', '--no-save', tarball], {
    cwd: temporaryRoot,
    env: { ...env, npm_config_cache: npmCache },
    logPath: join(evidenceDir, 'npm-install.json'),
  })
  const installedRoot = realpathSync(join(prefix, 'node_modules', 'agentteams'))
  const cli = join(prefix, 'node_modules', '.bin', 'agentteams')
  const cliRealpath = realpathSync(cli)
  const packageReceipt = readJson(defaultPackageReceiptPath)
  const installedContentSha256 = hashDirectory(installedRoot)
  assert(installedContentSha256 === packageReceipt.content_sha256,
    `installed content ${installedContentSha256} does not match staged package ${packageReceipt.content_sha256}`)
  return {
    label,
    temporaryRoot,
    prefix,
    home,
    npmCache,
    packDestination,
    tarball,
    tarballSha256: sha256File(tarball),
    installedRoot,
    cli,
    cliRealpath,
    installedContentSha256,
    env,
    configPath: join(home, '.agentteams', 'config.toml'),
    cleanup() {
      rmSync(temporaryRoot, { recursive: true, force: true })
      assert(!existsSync(temporaryRoot), `temporary install root was not removed: ${temporaryRoot}`)
    },
  }
}

function hashDirectory(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child)
      else fail(`unsupported directory entry: ${child}`)
    }
  }
  visit(directory)
  files.sort()
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(relative(directory, file).split(sep).join('/'))
    digest.update('\0')
    digest.update(readFileSync(file))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function listFiles(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(relative(directory, child).split(sep).join('/'))
      // The running launcher publishes a unix control socket below `.internal/`.
      // It is not a user-facing file, so it stays outside this file surface.
      else if (!entry.isSocket()) fail(`unsupported directory entry: ${child}`)
    }
  }
  visit(directory)
  return files.sort()
}

function consoleProbe(installedRoot, evidenceDir) {
  const script = String.raw`
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const packageRoot = process.env.AGENTTEAMS_INSTALLED_PACKAGE_ROOT
assert.ok(packageRoot, 'installed package root is required')
const { createConsoleServer, createConsoleAuthorization } = await import(
  pathToFileURL(packageRoot + '/console-host/lib/index.mjs').href
)
const client = {
  readProjection: async () => ({ version: 1, agents: [], sessions: [], configs: [], notifications: [] }),
  command: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'bb owner denial' } }),
  sendSession: async () => ({ ok: true }),
}
let authorize
const server = createConsoleServer({
  staticRoot: packageRoot + '/console-host/static',
  uiRoot: packageRoot + '/ui/teams-console',
  authenticationChallenge: 'Basic realm="AgentTeams", charset="UTF-8"',
  authorize: request => authorize ? authorize(request) : undefined,
})
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
try {
  const origin = 'http://127.0.0.1:' + server.address().port
  authorize = createConsoleAuthorization({ username: 'bb-user', password: 'bb-pass', origin, client })
  const authorization = 'Basic ' + Buffer.from('bb-user:bb-pass').toString('base64')
  const unauthorized = await fetch(origin)
  assert.equal(unauthorized.status, 401)
  const page = await fetch(origin, { headers: { authorization } })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), readFileSync(packageRoot + '/console-host/static/console.html', 'utf8'))
  const entry = await fetch(origin + '/console-entry.js', { headers: { authorization } })
  assert.equal(entry.status, 200)
  assert.equal(entry.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const browser = await fetch(origin + '/ui/browser.js', { headers: { authorization } })
  assert.equal(browser.status, 200)
  const icon = await fetch(origin + '/ui/assets/agentbrowser-icon.jpg', { headers: { authorization } })
  assert.equal(icon.status, 200)
  const iconBytes = Buffer.from(await icon.arrayBuffer())
  assert.equal(createHash('sha256').update(iconBytes).digest('hex'),
    createHash('sha256').update(readFileSync(packageRoot + '/ui/teams-console/assets/agentbrowser-icon.jpg')).digest('hex'))
  const crossSite = await fetch(origin, { headers: { authorization, 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 401)
  console.log(JSON.stringify({
    unauthorized: unauthorized.status,
    page: page.status,
    consoleEntry: entry.status,
    browser: browser.status,
    icon: icon.status,
    crossSite: crossSite.status,
  }))
} finally {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
`
  const result = run(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, AGENTTEAMS_INSTALLED_PACKAGE_ROOT: installedRoot },
    expectStatus: 0,
    logPath: join(evidenceDir, 'console-probe.json'),
  })
  return JSON.parse(result.stdout.trim())
}

function ensureUserConfig(fixture, evidenceDir, options = {}) {
  runChecked(fixture.cli, ['init'], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, 'init.json'),
  })
  const rg = runChecked('which', ['rg'], { env: fixture.env, logPath: join(evidenceDir, 'which-rg.json') }).stdout.trim()
  assert(rg.startsWith('/'), `rg executable is not absolute: ${rg}`)
  const configText = options.buildConfigText === undefined ? configFixtureText(rg, options) : options.buildConfigText(rg)
  writeFileSync(fixture.configPath, configText, { encoding: 'utf8', mode: 0o600 })
  return { configText, configSha256: sha256(configText) }
}

function assertInstalledEntries(fixture, internal) {
  assert(fixture.cliRealpath.startsWith(fixture.installedRoot + sep), `installed CLI escaped package root: ${fixture.cliRealpath}`)
  assert(fixture.cliRealpath !== join(root, 'cli', 'agentteams.mjs'), 'installed CLI resolved to the source tree')
  for (const process of internal.processes) {
    assert(process.entryPath.startsWith(fixture.installedRoot + sep), `${process.id} entry escaped installed package: ${process.entryPath}`)
    assert(!process.entryPath.startsWith(root + sep), `${process.id} entry resolved to the source tree: ${process.entryPath}`)
  }
}

/**
 * Start the installed launcher. `options.launchEnv` is the dedicated child-env
 * object for a credential-holding launch; every other command keeps `fixture.env`
 * so a credential reaches only the owned launcher child and its descendants.
 */
function startAndReadLifecycle(fixture, evidenceDir, prefix, agentIds = defaultAgentIds, options = {}) {
  const start = runChecked(fixture.cli, ['start', '--config', fixture.configPath], {
    cwd: fixture.temporaryRoot,
    env: options.launchEnv ?? fixture.env,
    logPath: join(evidenceDir, `${prefix}-start.json`),
  })
  const status = runChecked(fixture.cli, ['status', '--config', fixture.configPath], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, `${prefix}-status.json`),
  })
  const parsed = parseCliStatus(status.stdout)
  assert(parsed.state === 'running' && parsed.pid !== undefined && parsed.generation !== undefined,
    `installed lifecycle did not reach running: ${status.stdout.trim()}`)
  assert(parsed.endpoints.length === agentIds.length && parsed.endpoints.every(endpoint => endpoint.presence === 'online'),
    `installed lifecycle directory is not online: ${status.stdout.trim()}`)
  const internal = parseInternal(join(dirname(fixture.configPath), 'internal.toml'), agentIds)
  assert(internal.launcher.generation === parsed.generation, 'status generation does not match internal launcher generation')
  assert(internal.launcher.pid === parsed.pid, 'status pid does not match internal launcher pid')
  assertInstalledEntries(fixture, internal)
  return { start, status, parsed, internal }
}

function stopFixtureIfNeeded(fixture, generation) {
  if (generation === undefined) return
  try {
    runChecked(fixture.cli, ['stop', '--config', fixture.configPath, '--generation', String(generation)], {
      cwd: fixture.temporaryRoot,
      env: fixture.env,
    })
  } catch {
    // Preserve the primary failure. The case receipt records cleanup state.
  }
}

async function stopAndAssertClean(fixture, lifecycle, evidenceDir, prefix) {
  const pids = lifecyclePids(lifecycle.internal)
  const stop = runChecked(fixture.cli, ['stop', '--config', fixture.configPath, '--generation', String(lifecycle.parsed.generation)], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, `${prefix}-stop.json`),
  })
  await waitForProcessesGone(pids)
  const status = runChecked(fixture.cli, ['status', '--config', fixture.configPath], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, `${prefix}-stopped-status.json`),
  })
  assert(status.stdout.includes('state=stopped'), `installed lifecycle did not stop: ${status.stdout.trim()}`)
  assertPortsClosed(lifecycle.internal.ports)
  return { stop, status, pids }
}

/**
 * Stop the installed lifecycle from a Session case. The installed supervisor
 * occasionally records a spontaneous relay exit before any stop request
 * (`local relay exited unexpectedly code=0 signal=null`) and then reports that
 * pre-existing failure from the stop command. The lifecycle contract belongs to
 * the lifecycle cases, so a Session case records the anomaly and still asserts
 * the observable cleanup: every owned process gone, every owned port closed and
 * a terminal launcher state.
 */
async function stopSessionFixture(fixture, lifecycle, evidenceDir, prefix, options = {}) {
  const pids = lifecyclePids(lifecycle.internal)
  const stop = run(fixture.cli, ['stop', '--config', fixture.configPath, '--generation', String(lifecycle.parsed.generation)], {
    cwd: fixture.temporaryRoot,
    env: options.launchEnv ?? fixture.env,
    logPath: join(evidenceDir, `${prefix}-stop.json`),
  })
  const relayAnomaly = stop.status !== 0 && /local relay exited unexpectedly/.test(String(stop.stderr))
  assert(stop.status === 0 || relayAnomaly,
    `installed lifecycle stop failed: status=${stop.status} stderr=${String(stop.stderr).trim()}`)
  await waitForProcessesGone(pids)
  const status = runChecked(fixture.cli, ['status', '--config', fixture.configPath], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, `${prefix}-stopped-status.json`),
  })
  assert(relayAnomaly || status.stdout.includes('state=stopped'),
    `installed lifecycle did not stop: ${status.stdout.trim()}`)
  assert(!relayAnomaly || /state=(stopped|failed)/.test(status.stdout),
    `installed lifecycle did not reach a terminal state: ${status.stdout.trim()}`)
  assertPortsClosed(lifecycle.internal.ports)
  return { stop, status, pids, relay_anomaly: relayAnomaly }
}

async function runBB01(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB01')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb01')
  let lifecycle
  let result
  try {
    const config = ensureUserConfig(fixture, evidenceDir)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb01')
    const consoleResult = consoleProbe(fixture.installedRoot, evidenceDir)
    assert(consoleResult.unauthorized === 401 && consoleResult.page === 200 && consoleResult.consoleEntry === 200 &&
      consoleResult.browser === 200 && consoleResult.icon === 200 && consoleResult.crossSite === 401,
    `installed Console assets did not pass: ${JSON.stringify(consoleResult)}`)
    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb01')
    const allPids = lifecyclePids(lifecycle.internal)
    assert(allPids.every(pid => !processAlive(pid)), 'owned lifecycle processes remain after stop')
    const listenerState = Object.fromEntries(Object.entries(lifecycle.internal.ports).map(([id, port]) => [id, listeningPids(port)]))
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        commands: [
          'npm install --prefix <tmp>/prefix --no-audit --no-fund <tarball>',
          'agentteams init',
          'agentteams start --config <isolated-home>/.agentteams/config.toml',
          'agentteams status --config <isolated-home>/.agentteams/config.toml',
          'installed Console HTTP asset probe',
          'agentteams stop --config <isolated-home>/.agentteams/config.toml --generation <generation>',
          'agentteams status --config <isolated-home>/.agentteams/config.toml',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        installed_root: fixture.installedRoot,
        config_sha256: config.configSha256,
        start: lifecycle.parsed,
        internal_path: lifecycle.internal.internalPath,
        internal_ports: lifecycle.internal.ports,
        process_entry_paths: lifecycle.internal.processes.map(process => process.entryPath),
        console: consoleResult,
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        owned_listeners_after_stop: listenerState,
        temporary_root: fixture.temporaryRoot,
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

async function runBB02(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB02')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb02')
  let lifecycle
  let result
  try {
    const config = ensureUserConfig(fixture, evidenceDir)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb02')
    const provider = lifecycle.parsed.endpoints.find(endpoint => endpoint.agentId === 'bb-provider')
    const receiver = lifecycle.parsed.endpoints.find(endpoint => endpoint.agentId === 'bb-receiver')
    assert(provider !== undefined && receiver !== undefined, 'status did not publish both configured agents')
    assert(provider.capabilities.some(capability => capability.startsWith('file-search@1:search[search-slot:2:slot]')),
      `provider did not publish file-search: ${JSON.stringify(provider)}`)
    assert(receiver.capabilities.length === 0, `receiver must not publish capabilities: ${JSON.stringify(receiver)}`)
    const daemonPids = lifecycle.internal.processes.filter(process => process.id !== 'relay').map(process => process.pid)
    assert(daemonPids.length === 2 && new Set(daemonPids).size === 2, 'two independent daemon PIDs were not observed')
    assert(!daemonPids.includes(lifecycle.internal.launcher.pid), 'daemon PID must differ from launcher PID')
    assert(lifecycle.internal.services['bb-provider'].some(service => service.capabilityId === 'file-search' && service.version === '1' &&
      service.operations.includes('search') && service.resources.some(resource => resource.resourceId === 'search-slot' && resource.capacity === 2)),
    'internal.toml provider projection does not declare file-search')
    assert(lifecycle.internal.services['bb-receiver'].length === 0, 'internal.toml receiver projection must not declare services')
    assert(sha256File(fixture.configPath) === config.configSha256, 'config.toml changed after start; user intent was not the only editable source')
    const agentteamsFiles = listFiles(join(fixture.home, '.agentteams'))
    const userFacingFiles = agentteamsFiles.filter(file => !file.includes('/')).sort()
    assert(userFacingFiles.join(',') === 'config.toml,internal.toml',
      `the user-facing surface is not exactly config.toml plus derived internal.toml: ${userFacingFiles.join(', ')}`)
    const editableJson = agentteamsFiles.filter(file => file.endsWith('.json') && !file.startsWith('.internal/') && !file.startsWith('data/'))
    assert(editableJson.length === 0, `editable JSON configuration appeared: ${editableJson.join(', ')}`)
    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb02')
    const listenerState = Object.fromEntries(Object.entries(lifecycle.internal.ports).map(([id, port]) => [id, listeningPids(port)]))
    const configSha256AfterStart = sha256File(fixture.configPath)
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        config_path: fixture.configPath,
        config_sha256: config.configSha256,
        configured_agents: ['bb-provider', 'bb-receiver'],
        commands: ['agentteams init', 'edit config.toml only', 'agentteams start', 'agentteams status', 'agentteams stop --generation <generation>'],
      },
      external_observation: {
        status_stdout: lifecycle.status.stdout,
        endpoints: lifecycle.parsed.endpoints,
        internal_path: lifecycle.internal.internalPath,
        internal_launcher: lifecycle.internal.launcher,
        daemon_pids: daemonPids,
        daemon_entry_paths: lifecycle.internal.processes.filter(process => process.id !== 'relay').map(process => process.entryPath),
        ports: lifecycle.internal.ports,
        services: lifecycle.internal.services,
        config_sha256_after_start: configSha256AfterStart,
        agentteams_files: agentteamsFiles,
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_listeners_after_stop: listenerState,
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

const workReceiverId = 'bb-receiver'
const workProviderId = 'bb-provider'
const workDemands = '[{"resourceId":"search-slot","amount":1}]'

function writeWorkFixture(fixture) {
  const directory = join(dirname(fixture.configPath), 'files')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'a.txt'), 'marker-alpha\n')
  writeFileSync(join(directory, 'b.txt'), 'marker-beta\n')
  return directory
}

function providerLedger(fixture) {
  const path = join(dirname(fixture.configPath), 'data', workProviderId, 'work.json')
  return { path, snapshot: existsSync(path) ? readJson(path) : undefined }
}

const emptyProviderLedger = Object.freeze({ works: [], requests: [], allocations: [] })

/** A refusal must leave no accepted Work, request or allocation behind. */
function assertNoProviderWork(fixture, label) {
  const snapshot = providerLedger(fixture).snapshot
  if (snapshot === undefined) return
  assert(snapshot.works.length === 0 && snapshot.requests.length === 0 && snapshot.allocations.length === 0,
    `${label} wrote provider work state: ${JSON.stringify(snapshot)}`)
}

function runWork(fixture, evidenceDir, name, args, options = {}) {
  return run(fixture.cli, args, {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, `${name}.json`),
    ...options,
  })
}

function completedWorkReceipt(output) {
  const text = output.stdout.trim()
  assert(text.length > 0, `work command produced no stdout: ${output.stderr.trim()}`)
  const receipt = JSON.parse(text)
  assert(receipt.status === 'completed', `work command did not complete: ${text}`)
  return receipt
}

function failedWorkReceipt(output) {
  const text = output.stderr.trim()
  assert(text.length > 0, 'work command failure produced no typed receipt on stderr')
  const receipt = JSON.parse(text)
  assert(receipt.status === 'failed', `work command failure was not a typed failed receipt: ${text}`)
  assert(typeof receipt.control?.error?.code === 'string' && receipt.control.error.code.length > 0,
    `work command failure did not carry a typed error code: ${text}`)
  return receipt
}

function assertMatchedSearch(receipt, expectedPath) {
  assert(receipt.business?.status === 'matched', `business was not a matched search: ${JSON.stringify(receipt.business)}`)
  const matches = receipt.business.matches
  assert(Array.isArray(matches) && matches.length > 0 && matches.every(match => match.path === expectedPath),
    `business did not match only ${expectedPath}: ${JSON.stringify(matches)}`)
}

async function runBB04(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB04')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb04')
  let lifecycle
  let result
  try {
    const config = ensureUserConfig(fixture, evidenceDir)
    writeWorkFixture(fixture)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb04')
    const provider = lifecycle.parsed.endpoints.find(endpoint => endpoint.agentId === workProviderId)
    assert(provider !== undefined && provider.presence === 'online', 'status did not publish the online Work provider')

    const submitA = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb04-submit-a',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', workReceiverId, '--payload', '{"query":"marker-alpha"}'],
      { expectStatus: 0 }))
    assert(submitA.control.graphId === 'agentteams.agent-work' && submitA.control.graphVersion === '2',
      `submit bound the wrong graph: ${submitA.control.graphId}@${submitA.control.graphVersion}`)
    assert(submitA.control.providerAgentId === workProviderId && submitA.control.capabilityId === 'file-search' &&
      submitA.control.capabilityVersion === '1' && submitA.control.operation === 'search',
    `submit bound the wrong provider/capability: ${JSON.stringify(submitA.control)}`)
    assert(submitA.control.requestState === 'succeeded' && submitA.control.workClosure === 'closed',
      `submit did not close a succeeded request: ${JSON.stringify(submitA.control)}`)
    assert(submitA.evidence?.nodeSchedule?.join(',') === 'resolve-service,open-link,admit-work,request-work,settle-work',
      `submit ran the wrong node schedule: ${JSON.stringify(submitA.evidence?.nodeSchedule)}`)
    assert(submitA.cleanup?.channelsOpened === 1 && submitA.cleanup?.channelsDisposed === 1,
      `submit leaked a Work channel: ${JSON.stringify(submitA.cleanup)}`)
    assertMatchedSearch(submitA, './a.txt')

    const submitB = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb04-submit-b',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', workReceiverId, '--payload', '{"query":"marker-beta"}'],
      { expectStatus: 0 }))
    assertMatchedSearch(submitB, './b.txt')
    assert(submitA.control.workId !== submitB.control.workId && submitA.control.requestId !== submitB.control.requestId,
      'two submits reused a Work or request identity')

    const queryA = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb04-query-a',
      ['work', 'query', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--work-id', submitA.control.workId, '--request-id', submitA.control.requestId],
      { expectStatus: 0 }))
    assert(queryA.control.graphId === 'agentteams.work-query' && queryA.control.graphVersion === '1',
      `query bound the wrong graph: ${queryA.control.graphId}@${queryA.control.graphVersion}`)
    assert(queryA.control.observed === true, 'query did not observe the original request')
    assert(queryA.control.workId === submitA.control.workId && queryA.control.requestId === submitA.control.requestId,
      'query did not preserve the original Work/request identity')
    assert(queryA.control.executionId !== submitA.control.executionId && queryA.control.attemptId !== submitA.control.attemptId,
      'query reused the original execution identity')
    assert(JSON.stringify(queryA.business) === JSON.stringify(submitA.business), 'query did not return the original business result')
    assert(queryA.evidence.hostOperations.includes('agentWork.get'), 'query did not read the provider ledger')
    assert(!queryA.evidence.hostOperations.includes('agentWork.propose') && !queryA.evidence.hostOperations.includes('agentWork.request'),
      `query re-executed business work: ${JSON.stringify(queryA.evidence.hostOperations)}`)

    const unknown = failedWorkReceipt(runWork(fixture, evidenceDir, 'bb04-query-unknown',
      ['work', 'query', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--work-id', 'bb04-unknown-work', '--request-id', 'bb04-unknown-request'],
      { expectNonZero: true }))
    assert(unknown.control.workId === 'bb04-unknown-work' && unknown.control.requestId === 'bb04-unknown-request',
      'the typed failure did not preserve the queried identity')
    assert(!unknown.evidence.hostOperations.includes('agentWork.request') && !unknown.evidence.hostOperations.includes('agentWork.propose'),
      'the unknown query re-executed business work')

    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb04')
    const allPids = lifecyclePids(lifecycle.internal)
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        config_path: fixture.configPath,
        config_sha256: config.configSha256,
        receiver: workReceiverId,
        commands: [
          'agentteams start --config <isolated-home>/.agentteams/config.toml',
          'agentteams work submit --receiver bb-receiver --payload {"query":"marker-alpha"}',
          'agentteams work submit --receiver bb-receiver --payload {"query":"marker-beta"}',
          'agentteams work query --receiver bb-receiver --work-id <A> --request-id <A>',
          'agentteams work query --receiver bb-receiver --work-id bb04-unknown-work --request-id bb04-unknown-request (typed failure)',
          'agentteams stop --generation <generation>',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        start: lifecycle.parsed,
        submit_a: submitA,
        submit_b: submitB,
        query_a: queryA,
        unknown_query: unknown,
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

async function runBB07(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB07')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb07')
  let lifecycle
  let result
  try {
    ensureUserConfig(fixture, evidenceDir)
    const files = writeWorkFixture(fixture)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb07')
    const opened = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb07-open',
      ['work', 'open', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--operation', 'search', '--demands', workDemands, '--payload', '{"query":"marker-alpha"}'],
      { expectStatus: 0 }))
    assert(opened.control.graphId === 'agentteams.work-open', `persistent Work bound the wrong graph: ${opened.control.graphId}`)
    assert(opened.control.workClosure === 'retained', `persistent Work was not retained: ${opened.control.workClosure}`)
    assertMatchedSearch(opened, './a.txt')
    const binding = ['--provider', workProviderId, '--provider-generation', String(opened.control.targetGeneration),
      '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search']
    const capabilityQuery = ['work', 'query', '--config', fixture.configPath, '--receiver', workReceiverId,
      '--service-selection', 'capability', '--work-id', opened.control.workId, '--request-id', opened.control.requestId, ...binding]
    const ledgerBefore = providerLedger(fixture)
    assert(ledgerBefore.snapshot !== undefined, 'the provider ledger was not published after a retained Work')
    const worksBefore = ledgerBefore.snapshot.works.length
    const requestsBefore = ledgerBefore.snapshot.requests.filter(request => request.control.workId === opened.control.workId).length

    const generationOne = lifecycle.parsed.generation
    const stopped = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb07')
    const stoppedStatus = parseCliStatus(stopped.status.stdout)
    assert(stoppedStatus.state === 'stopped' && stoppedStatus.endpoints.every(endpoint => endpoint.presence === 'offline'),
      `stopped lifecycle still published online endpoints: ${stopped.status.stdout.trim()}`)

    const whileStopped = runWork(fixture, evidenceDir, 'bb07-query-stopped', capabilityQuery, { expectNonZero: true })
    assert(/local Work control is unavailable/u.test(`${whileStopped.stdout}\n${whileStopped.stderr}`),
      `query without a launcher did not report the local control contract: ${whileStopped.stdout}${whileStopped.stderr}`)

    // Delete the original marker so a replay would return a different result.
    rmSync(join(files, 'a.txt'), { force: true })
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb07-restart')
    assert(lifecycle.parsed.generation > generationOne,
      `restart did not advance the launcher generation: ${generationOne} -> ${lifecycle.parsed.generation}`)

    const recovered = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb07-query-recovered', capabilityQuery, { expectStatus: 0 }))
    assert(recovered.control.observed === true, 'the recovery query did not observe the original request')
    assert(recovered.control.workId === opened.control.workId && recovered.control.requestId === opened.control.requestId,
      'the recovery query did not preserve the original Work/request identity')
    assert(recovered.control.targetGeneration === opened.control.targetGeneration,
      `the recovery query did not keep the original provider generation: ${recovered.control.targetGeneration}`)
    assert(Number.isSafeInteger(recovered.control.linkGeneration), 'the recovery query did not separate the link generation')
    assert(JSON.stringify(recovered.business) === JSON.stringify(opened.business),
      'the recovery query replayed the request instead of reading the original result')
    assert(recovered.evidence.hostOperations.includes('agentWork.get') && !recovered.evidence.hostOperations.includes('agentWork.request'),
      `the recovery query re-executed business work: ${JSON.stringify(recovered.evidence.hostOperations)}`)

    const unknownRequest = failedWorkReceipt(runWork(fixture, evidenceDir, 'bb07-query-unknown-request',
      ['work', 'query', '--config', fixture.configPath, '--receiver', workReceiverId, '--service-selection', 'capability',
        '--work-id', opened.control.workId, '--request-id', 'bb07-unknown-request', ...binding],
      { expectNonZero: true }))
    assert(unknownRequest.control.workId === opened.control.workId && unknownRequest.control.requestId === 'bb07-unknown-request',
      'the unknown request failure did not preserve the queried identity')
    assert(!unknownRequest.evidence.hostOperations.includes('agentWork.request'),
      'the unknown request query re-executed business work')

    const ledgerAfter = providerLedger(fixture)
    assert(ledgerAfter.snapshot.works.length === worksBefore, 'a recovery or unknown query created a new Work')
    assert(ledgerAfter.snapshot.requests.filter(request => request.control.workId === opened.control.workId).length === requestsBefore,
      'a recovery or unknown query created a new request')

    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb07-final')
    const allPids = lifecyclePids(lifecycle.internal)
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        receiver: workReceiverId,
        commands: [
          'agentteams work open --receiver bb-receiver --operation search --demands [...] --payload {"query":"marker-alpha"}',
          'agentteams stop --generation <g1>',
          'agentteams work query --service-selection capability --work-id <W> --request-id <R> --provider bb-provider --provider-generation <g> ... (while stopped, typed failure)',
          'agentteams start',
          'agentteams work query --service-selection capability --work-id <W> --request-id <R> ... (recovery)',
          'agentteams work query ... --request-id bb07-unknown-request (typed failure)',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        opened,
        stopped_stdout: stopped.status.stdout,
        query_while_stopped: { status: whileStopped.status, stderr: whileStopped.stderr.trim() },
        restart_generation: { from: generationOne, to: lifecycle.parsed.generation },
        recovered,
        unknown_request: unknownRequest,
        provider_ledger: { path: ledgerAfter.path, works: worksBefore, requests_for_work: requestsBefore },
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

async function runBB08(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB08')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb08')
  let lifecycle
  let result
  try {
    const config = ensureUserConfig(fixture, evidenceDir)
    writeWorkFixture(fixture)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb08')
    const generationOne = lifecycle.parsed.generation
    const internalOne = parseToml(readFileSync(lifecycle.internal.internalPath, 'utf8'))
    assert(typeof internalOne.sourceRevision === 'number' && typeof internalOne.sourceHash === 'string',
      'internal.toml did not record the accepted config revision')
    assert(internalOne.sourceHash === `sha256:${sha256(config.configText)}`, 'internal.toml source hash does not match config.toml')
    assert(internalOne.configRuntime !== undefined && internalOne.configRuntime.accepted !== undefined &&
      internalOne.configRuntime.effective !== undefined,
    'internal.toml did not separate accepted and effective config runtime slices')

    const first = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb08-submit-current',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--generation', String(generationOne), '--payload', '{"query":"marker-alpha"}'],
      { expectStatus: 0 }))
    assertMatchedSearch(first, './a.txt')

    await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb08')
    const edited = `${config.configText}\n[providers.bb-local]\nprotocol = "openai-chat"\napiBaseUrl = "https://example.invalid/v1"\nlabel = "BB-Local"\nenabled = true\n\n[[models]]\nprovider = "bb-local"\nid = "bb-local-model"\n\n[agents.bb-provider.model]\nprimary = { provider = "bb-local", model = "bb-local-model" }\n`
    writeFileSync(fixture.configPath, edited, { encoding: 'utf8', mode: 0o600 })

    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb08-restart')
    const generationTwo = lifecycle.parsed.generation
    assert(generationTwo > generationOne, `restart did not advance the launcher generation: ${generationOne} -> ${generationTwo}`)
    const internalTwo = parseToml(readFileSync(lifecycle.internal.internalPath, 'utf8'))
    assert(internalTwo.sourceRevision > internalOne.sourceRevision, 'restart did not advance the accepted config source revision')
    assert(internalTwo.sourceHash !== internalOne.sourceHash, 'restart did not record the edited config hash')
    assert(internalTwo.sourceHash === `sha256:${sha256(edited)}`, 'internal.toml did not persist the edited user intent')
    assert(sha256File(fixture.configPath) === sha256(edited), 'config.toml is not the persisted user intent')

    const ledgerBeforeStale = providerLedger(fixture)
    const stale = runWork(fixture, evidenceDir, 'bb08-stale-generation',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--generation', String(generationOne), '--payload', '{"query":"marker-beta"}'],
      { expectNonZero: true })
    assert(/stale launcher generation/u.test(`${stale.stdout}\n${stale.stderr}`),
      `the stale launcher generation was not refused: ${stale.stdout}${stale.stderr}`)
    const ledgerAfterStale = providerLedger(fixture)
    assert(ledgerAfterStale.snapshot.works.length === ledgerBeforeStale.snapshot.works.length,
      'the stale launcher generation refusal created a Work side effect')

    const second = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb08-submit-new',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--generation', String(generationTwo), '--payload', '{"query":"marker-beta"}'],
      { expectStatus: 0 }))
    assertMatchedSearch(second, './b.txt')

    const recovered = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb08-query-retained',
      ['work', 'query', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--work-id', first.control.workId, '--request-id', first.control.requestId],
      { expectStatus: 0 }))
    assert(recovered.control.observed === true, 'the pre-restart Work responsibility did not survive the restart')
    assert(recovered.control.targetGeneration === first.control.targetGeneration,
      'the retained Work did not keep its original provider generation')
    assert(JSON.stringify(recovered.business) === JSON.stringify(first.business), 'the retained Work returned a different result')

    const staleProvider = failedWorkReceipt(runWork(fixture, evidenceDir, 'bb08-stale-provider-generation',
      ['work', 'open', '--config', fixture.configPath, '--receiver', workReceiverId, '--operation', 'search',
        '--demands', workDemands, '--provider-generation', '99', '--payload', '{"query":"marker-alpha"}'],
      { expectNonZero: true }))
    assert(staleProvider.control.error.code.length > 0, 'the stale provider generation did not carry a typed error')

    const agentteamsFiles = listFiles(join(fixture.home, '.agentteams'))
    const userFacingFiles = agentteamsFiles.filter(file => !file.includes('/')).sort()
    assert(userFacingFiles.join(',') === 'config.toml,internal.toml',
      `the user-facing surface is not exactly config.toml plus derived internal.toml: ${userFacingFiles.join(', ')}`)
    const editableJson = agentteamsFiles.filter(file => file.endsWith('.json') && !file.startsWith('.internal/') && !file.startsWith('data/'))
    assert(editableJson.length === 0, `editable JSON configuration appeared: ${editableJson.join(', ')}`)

    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb08-final')
    const allPids = lifecyclePids(lifecycle.internal)
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        receiver: workReceiverId,
        commands: [
          'agentteams init',
          'edit config.toml only (add providers/models/binding and change the provider label)',
          'agentteams start',
          'agentteams work submit --generation <g1>',
          'agentteams stop --generation <g1>',
          'agentteams start',
          'agentteams work submit --generation <g1> (stale, typed failure)',
          'agentteams work submit --generation <g2>',
          'agentteams work query --work-id <first> --request-id <first>',
          'agentteams work open --provider-generation 99 (stale provider, typed failure)',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        config_sha256_before_edit: config.configSha256,
        config_sha256_after_edit: sha256(edited),
        source_revision: { before: internalOne.sourceRevision, after: internalTwo.sourceRevision },
        source_hash: { before: internalOne.sourceHash, after: internalTwo.sourceHash },
        generation: { before: generationOne, after: generationTwo },
        first_submit: first,
        stale_submit: { status: stale.status, stderr: stale.stderr.trim() },
        ledger_after_stale: { works: ledgerAfterStale.snapshot.works.length },
        second_submit: second,
        retained_query: recovered,
        stale_provider_generation: staleProvider,
        agentteams_files: agentteamsFiles,
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

function parseCliConsole(stdout) {
  const fields = {}
  for (const token of stdout.trim().split(/\s+/u)) {
    const equals = token.indexOf('=')
    if (equals > 0) fields[token.slice(0, equals)] = token.slice(equals + 1)
  }
  return fields
}

function runConsole(fixture, evidenceDir, name, args, options = {}) {
  return run(fixture.cli, ['console', ...args, '--config', fixture.configPath], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, `${name}.json`),
    ...options,
  })
}

function assertConsoleOnline(status, label) {
  assert(status.console === 'enabled' && status.consoleState === 'online',
    `${label} was not an online Console: ${JSON.stringify(status)}`)
  assert(status.consoleCredential === 'configured', `${label} did not report a configured credential`)
  assert(typeof status.consoleUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/u.test(status.consoleUrl),
    `${label} did not publish a loopback url: ${status.consoleUrl}`)
  const generation = Number(status.consoleGeneration)
  const pid = Number(status.consolePid)
  assert(Number.isSafeInteger(generation) && generation > 0, `${label} had an invalid Console generation`)
  assert(Number.isSafeInteger(pid) && pid > 0, `${label} had an invalid Console pid`)
  return { generation, pid, url: status.consoleUrl }
}

/** Read the U5-owned `[consoleRuntime]` row from the derived internal state. */
function readConsoleRuntime(internalPath) {
  const internal = parseToml(readFileSync(internalPath, 'utf8'))
  assert(internal.consoleRuntime !== undefined, 'internal.toml has no published [consoleRuntime] row')
  return internal.consoleRuntime
}

/**
 * A closed loopback listener is the observable proof that the installed Console
 * endpoint is gone. A short TCP connect attempt must fail.
 */
function consoleListenerGone(url) {
  const parsed = new URL(url)
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
import net from 'node:net'
const socket = net.createConnection({ host: ${JSON.stringify(parsed.hostname)}, port: ${Number(parsed.port)} })
const finish = alive => { socket.destroy(); console.log(alive ? 'alive' : 'gone'); process.exit(0) }
socket.setTimeout(750)
socket.once('connect', () => finish(true))
socket.once('timeout', () => finish(false))
socket.once('error', () => finish(false))
`], { encoding: 'utf8' })
  return result.stdout.trim() === 'gone'
}

// ---------------------------------------------------------------------------
// BB09 round 12: the installed Console observed in a real headless Camo browser.
// The Console URL, credential and static assets all come from the installed
// package; every browser assertion reads the same owner projection the installed
// Console serves. The canonical credential of BB10 never reaches this fixture.
// ---------------------------------------------------------------------------

const bb09StubProviderId = 'bb-console-stub'
const bb09StubModelId = 'bb-console-model'

/**
 * The BB09 user `config.toml`. Both daemons are real and both explicitly
 * authorize `__console`; a local OpenAI-compatible stub provider gives the
 * Console a real provider/model row to configure. The refusal scenario reuses
 * this text with an empty manager list.
 */
function bb09ConfigText(spec) {
  const managerList = `[${spec.allowedManagers.map(id => JSON.stringify(id)).join(', ')}]`
  return `version = 3

[bridge]
enabled = true

[agents.${workProviderId}]
enabled = true
role = "provider"
label = "BB09-Provider"

[agents.${workProviderId}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "local"
agentKind = "custom"
label = "BB09-Provider"

[agents.${workProviderId}.runtime]
scopeId = "local"
dataDirectory = "data/${workProviderId}"
policy = { revision = 1, allowedConsumers = ["${workReceiverId}"], allowedManagers = ${managerList} }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(spec.searchExecutable)}, searchRoot = "files", profilePrefix = "teams-${workProviderId}" }

[agents.${workProviderId}.services.file-search]
version = "1"
operations = ["search"]
resources = [{ resourceId = "search-slot", capacity = 2, unit = "slot" }]

[agents.${workProviderId}.model]
primary = { provider = "${bb09StubProviderId}", model = "${bb09StubModelId}" }

[agents.${workReceiverId}]
enabled = true
role = "receiver"
label = "BB09-Receiver"

[agents.${workReceiverId}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "local"
agentKind = "custom"
label = "BB09-Receiver"

[agents.${workReceiverId}.runtime]
scopeId = "local"
dataDirectory = "data/${workReceiverId}"
policy = { revision = 1, allowedConsumers = [], allowedManagers = ${managerList} }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(spec.searchExecutable)}, searchRoot = "files", profilePrefix = "teams-${workReceiverId}" }

[agents.${workReceiverId}.connect]
targetAgentId = "${workProviderId}"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
demands = [{ resourceId = "search-slot", amount = 1 }]

[providers.${bb09StubProviderId}]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(`${spec.stubBaseUrl}/v1`)}
label = "BB09 Console Stub"
enabled = true

[[models]]
provider = "${bb09StubProviderId}"
id = "${bb09StubModelId}"
label = "BB09 Stub Model"

[console]
enabled = true
username = ${JSON.stringify(consoleUsername)}
passwordEnv = ${JSON.stringify(consolePasswordEnv)}
`
}

/**
 * The accepted config revision an Agent durably owns. The management policy of
 * the refusal scenario denies the Console's observation too, so the revision
 * non-advance is read from the Agent's own derived internal projection.
 */
function readAcceptedConfigRevision(internalPath, agentId) {
  const internal = parseToml(readFileSync(internalPath, 'utf8'))
  const slice = internal.configRuntime?.accepted?.[agentId]
  return slice === undefined ? undefined : slice.acceptedRevision
}

/** Replace every occurrence of a provisioned credential value in recorded text. */
function redactCredential(text, secrets) {
  let redacted = String(text)
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    redacted = redacted.split(secret).join('<redacted>')
  }
  return redacted.replace(/:\/\/([^/@\s:]+):[^/@\s]*@/gu, '://$1:<redacted>@')
}

/** Run one real Camo invocation against the isolated fixture HOME. */
function camoRun(fixture, camo, evidenceDir, name, args, options = {}) {
  return run(camo.executable, args, {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    ...(options.record === false ? {} : { logPath: join(evidenceDir, `${name}.json`) }),
    ...options.run,
  })
}

/**
 * Run a Camo invocation whose argv or output can carry a provisioned secret. The
 * redacted record is written before any exit-status check, so a failing credential
 * bearing invocation still produces redacted evidence and never prints the value.
 */
function camoRunRedacted(fixture, camo, evidenceDir, name, args, secrets, options = {}) {
  const { run: runOptions = {}, ...rest } = options
  const { expectStatus, ...keptRunOptions } = runOptions
  const output = camoRun(fixture, camo, evidenceDir, name, args, { ...rest, record: false, run: keptRunOptions })
  const record = {
    command: output.command,
    args: output.args.map(argument => redactCredential(argument, secrets)),
    status: output.status,
    signal: output.signal,
    stdout: redactCredential(output.stdout, secrets),
    stderr: redactCredential(output.stderr, secrets),
  }
  writeJson(join(evidenceDir, `${name}.json`), record)
  if (expectStatus !== undefined && output.status !== expectStatus) {
    fail(`${output.command} ${record.args.join(' ')} exited ${output.status}; expected ${expectStatus}\n${record.stderr || record.stdout}`)
  }
  return { ...output, stdout: record.stdout, stderr: record.stderr }
}

function camoJson(output, label) {
  const text = output.stdout.trim()
  assert(text.length > 0, `${label} printed no stdout: ${output.stderr.trim()}`)
  try {
    return JSON.parse(text)
  } catch {
    return fail(`${label} did not print one JSON document: ${text.slice(0, 400)}`)
  }
}

function camoEvaluate(fixture, camo, evidenceDir, name, profile, script, secrets = []) {
  const output = secrets.length === 0
    ? camoRun(fixture, camo, evidenceDir, name, ['evaluate', '--profile', profile, '--script', script], { expectStatus: 0 })
    : camoRunRedacted(fixture, camo, evidenceDir, name, ['evaluate', '--profile', profile, '--script', script], secrets, { run: { expectStatus: 0 } })
  const parsed = camoJson(output, name)
  assert(Object.hasOwn(parsed, 'result'), `${name} returned no evaluate result: ${output.stdout.trim()}`)
  return parsed.result
}

function camoClick(fixture, camo, evidenceDir, name, profile, selector, secrets = []) {
  const args = ['click', '--profile', profile, '--selector', selector]
  const output = secrets.length === 0
    ? camoRun(fixture, camo, evidenceDir, name, args, { expectStatus: 0 })
    : camoRunRedacted(fixture, camo, evidenceDir, name, args, secrets, { run: { expectStatus: 0 } })
  const parsed = camoJson(output, name)
  assert(parsed.clicked === true, `${name} did not report a real click: ${output.stdout.trim()}`)
  return parsed
}

function camoStopProfile(fixture, camo, evidenceDir, name, profile) {
  const output = camoRun(fixture, camo, evidenceDir, name, ['stop', '--profile', profile])
  return output
}

function camoStopDaemon(fixture, camo, evidenceDir, name, profile) {
  return camoRun(fixture, camo, evidenceDir, name, ['daemon', 'stop', '--profile', profile])
}

/**
 * Release every owned browser profile and its daemon. Best-effort by contract:
 * a failure is recorded in the cleanup receipt and never replaces the primary
 * observation.
 */
function camoTeardown(fixture, camo, evidenceDir, profiles, label) {
  const records = []
  for (const profile of profiles) {
    const stop = camoStopProfile(fixture, camo, evidenceDir, `${label}-stop-${profile}`, profile)
    const daemon = camoStopDaemon(fixture, camo, evidenceDir, `${label}-daemon-${profile}`, profile)
    records.push({ profile, stop_status: stop.status, daemon_status: daemon.status })
  }
  return records
}

/** Fail the case if any recorded evidence file contains a provisioned secret. */
/** Refuse to keep any evidence artifact that captured a provisioned credential value. */
function assertNoSecretInEvidence(directory, secrets) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      assertNoSecretInEvidence(path, secrets)
      continue
    }
    const text = readFileSync(path)
    for (const secret of secrets) {
      if (typeof secret !== 'string' || secret.length === 0) continue
      assert(!text.includes(secret), `evidence ${path} contains a provisioned credential value`)
    }
  }
}

const bb09AgentRowsScript = `JSON.stringify([...document.querySelectorAll('article.teams-agent-card')].map(card => {
  const keys = [...card.querySelectorAll('button[data-focus-key]')].map(node => node.dataset.focusKey)
  const details = keys.find(key => /^agent:.+:details$/u.test(key))
  const presence = card.querySelector('.teams-presence')
  return {
    agentId: details === undefined ? null : details.replace(/^agent:/u, '').replace(/:details$/u, ''),
    label: card.querySelector('.teams-identity-copy strong')?.textContent ?? null,
    machineId: (card.querySelector('.teams-identity-copy span')?.textContent ?? '').split(' · ')[0],
    presence: presence === null ? null : [...presence.classList].find(name => name.startsWith('teams-presence-'))?.slice('teams-presence-'.length) ?? null,
    text: card.textContent ?? '',
  }
}))`

/**
 * The real headless Camo acceptance of the installed Console. Returns every
 * observation the BB09 receipt records; every assertion is on a browser-visible
 * or browser-fetched fact, never on a fixture client.
 */
async function bb09BrowserAcceptance(options) {
  const { fixture, camo, evidenceDir, profiles, initial, configText, authorization } = options
  const profile = options.profile
  const cleanUrl = `${initial.url}/`
  const userinfo = new URL(initial.url)
  userinfo.username = consoleUsername
  userinfo.password = consolePassword
  const secrets = [consolePassword]
  const observed = {}

  const started = camoRunRedacted(fixture, camo, evidenceDir, 'browser-start',
    ['start', '--profile', profile, '--url', userinfo.toString(), '--headless'], secrets, { run: { expectStatus: 0 } })
  const startResult = camoJson(started, 'browser-start')
  assert(typeof startResult.target === 'string' && startResult.target.length > 0,
    `the installed Console browser session published no target: ${started.stdout}`)
  assert(!started.stdout.includes(consolePassword) && !started.stderr.includes(consolePassword),
    'the browser start evidence still carried the Console credential')
  profiles.add(profile)
  observed.start = { target: startResult.target, sessionId: startResult.sessionId, profile: startResult.profile }

  const userinfoInfo = camoJson(camoRun(fixture, camo, evidenceDir, 'browser-userinfo-page',
    ['get-page-info', '--profile', profile], { expectStatus: 0 }), 'browser-userinfo-page')
  assert(userinfoInfo.info?.title === 'AgentTeams Console',
    `the installed Console page did not publish its title: ${JSON.stringify(userinfoInfo.info)}`)

  // The credential-bearing load cannot serve the page's own relative fetches, so
  // the observed recipe re-navigates the same authenticated profile to the clean
  // URL and asserts the UI, its title and its API from there.
  camoRun(fixture, camo, evidenceDir, 'browser-clean-navigation',
    ['goto', cleanUrl, '--profile', profile, '--waitUntil', 'load'], { expectStatus: 0 })
  const cleanInfo = camoJson(camoRun(fixture, camo, evidenceDir, 'browser-page',
    ['get-page-info', '--profile', profile], { expectStatus: 0 }), 'browser-page')
  assert(cleanInfo.info?.url === cleanUrl, `the clean Console navigation landed elsewhere: ${JSON.stringify(cleanInfo.info)}`)
  assert(cleanInfo.info?.title === 'AgentTeams Console', `the clean Console page lost its title: ${JSON.stringify(cleanInfo.info)}`)
  assert(cleanInfo.info?.readyState === 'complete', `the clean Console page never finished loading: ${JSON.stringify(cleanInfo.info)}`)
  observed.clean = { url: cleanInfo.info.url, title: cleanInfo.info.title, readyState: cleanInfo.info.readyState }

  const projectionStatus = await camoEvaluate(fixture, camo, evidenceDir, 'browser-projection-status',
    profile, `fetch('/api/v1/projection', { method: 'GET' }).then(r => r.status)`)
  assert(projectionStatus === 200, `the browser projection fetch did not succeed: ${projectionStatus}`)
  const projectionJson = await camoEvaluate(fixture, camo, evidenceDir, 'browser-projection',
    profile, `fetch('/api/v1/projection', { method: 'GET' }).then(r => r.json()).then(j => JSON.stringify(j))`)
  assert(typeof projectionJson === 'string' && projectionJson.length > 0,
    'the browser projection fetch returned no document')
  const projection = JSON.parse(projectionJson)
  assert(projection.version === 1 && Array.isArray(projection.agents),
    `the browser projection was not a version 1 document: ${projectionJson.slice(0, 400)}`)
  writeJson(join(evidenceDir, 'browser-projection.json'), projection)

  const rows = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-agents-dom', profile, bb09AgentRowsScript))
  writeJson(join(evidenceDir, 'browser-agents-dom.json'), rows)
  assert(rows.length === 2, `the browser rendered ${rows.length} Agent rows, not two: ${JSON.stringify(rows)}`)
  for (const agentId of [workProviderId, workReceiverId]) {
    const domRow = rows.find(row => row.agentId === agentId)
    const projectionRow = projection.agents.find(row => row.agentId === agentId)
    assert(domRow !== undefined, `the browser rendered no row for the real daemon ${agentId}: ${JSON.stringify(rows)}`)
    assert(projectionRow !== undefined, `the owner projection has no row for the real daemon ${agentId}`)
    assert(projectionRow.presence === 'online', `the owner projection reports ${agentId} as ${projectionRow.presence}`)
    assert(domRow.presence === 'online', `the browser rendered ${agentId} as ${domRow.presence}`)
    assert(domRow.label === projectionRow.label && domRow.machineId === projectionRow.machineId,
      `the browser row for ${agentId} did not match the owner projection: ${JSON.stringify(domRow)}`)
  }
  observed.agents = rows.map(row => ({ agentId: row.agentId, label: row.label, machineId: row.machineId, presence: row.presence }))

  // (a) Authoritative declaration detail: the owner projection must carry the
  // producer's declared services/resources, the rendered card must show the
  // capability, its operations and its declared capacity, and both must agree with
  // the installed public `status` declaration.
  const providerProjection = projection.agents.find(row => row.agentId === workProviderId)
  const declared = 'file-search@1:search[search-slot:2:slot]'
  assert(options.statusStdout.includes(`capabilities=${declared}`),
    `the installed public status did not declare the producer capability and resource: ${options.statusStdout.trim()}`)
  assert(configText.includes('resourceId = "search-slot"') && configText.includes('capacity = 2'),
    'the BB09 fixture did not declare the file-search resource the case asserts')
  const details = providerProjection.capabilityDetails
  assert(Array.isArray(details) && details.length > 0,
    `the owner projection carried no capabilityDetails for ${workProviderId}: ${JSON.stringify(providerProjection)}`)
  const fileSearch = details.find(entry => entry.capabilityId === 'file-search')
  assert(fileSearch !== undefined && fileSearch.version === '1'
    && Array.isArray(fileSearch.operations) && fileSearch.operations.includes('search'),
  `the owner projection did not carry the declared file-search service: ${JSON.stringify(details)}`)
  const resource = fileSearch.resources?.find(entry => entry.resourceId === 'search-slot')
  assert(resource?.capacity === 2 && resource.unit === 'slot',
    `the owner projection did not carry the declared search-slot resource: ${JSON.stringify(fileSearch.resources)}`)
  const projectedDeclaration = `${fileSearch.capabilityId}@${fileSearch.version}:${fileSearch.operations.join(',')}`
    + `[${(fileSearch.resources ?? []).map(entry => `${entry.resourceId}:${entry.capacity}:${entry.unit}`).join(',')}]`
  assert(projectedDeclaration === declared,
    `the owner projection declaration ${projectedDeclaration} does not match the installed public status declaration ${declared}`)
  writeJson(join(evidenceDir, 'browser-resources-dom.json'), {
    declared, projected: projectedDeclaration, capabilityDetails: details,
    rendered: rows.find(row => row.agentId === workProviderId)?.text ?? '',
  })
  const providerText = rows.find(row => row.agentId === workProviderId)?.text ?? ''
  // The rendered label spacing comes from the product locale, not a behavior contract;
  // assert the observable service, resource, and capacity-with-unit facts by value.
  assert(/file-search/u.test(providerText) && /search-slot/u.test(providerText) && /2\s*slot/u.test(providerText),
    `the browser card did not render the declared service and resource detail: ${providerText}`)
  assert(!/剩余/u.test(providerText) && !/remaining/iu.test(providerText),
    `the browser card presented the declared capacity as remaining capacity: ${providerText}`)

  // (b) Observation interaction: a real click opens the Agent drawer, a real click
  // closes it, and a real panel refresh reads the declaration back. The installed
  // Console marks the panel inert while a drawer is open, so panel buttons are only
  // clicked with the drawer closed and drawer buttons only while it is open.
  camoClick(fixture, camo, evidenceDir, 'browser-detail-action', profile,
    `button[data-focus-key="agent:${workProviderId}:details"]`)
  const detailText = await camoEvaluate(fixture, camo, evidenceDir, 'browser-detail-dom',
    profile, `document.querySelector('.teams-drawer')?.textContent ?? ''`)
  assert(typeof detailText === 'string' && detailText.includes('file-search'),
    `the Agent drawer did not show the agent declaration: ${String(detailText).slice(0, 400)}`)
  assert(/search-slot/u.test(detailText),
    `the Agent drawer did not show the declared resource: ${String(detailText).slice(0, 400)}`)
  camoClick(fixture, camo, evidenceDir, 'browser-detail-close', profile,
    '.teams-drawer .teams-header-actions button:nth-of-type(2)')
  camoClick(fixture, camo, evidenceDir, 'browser-refresh-action', profile,
    '.teams-panel .teams-header-actions button:nth-of-type(2)')
  const refreshedRows = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-refresh-dom',
    profile, bb09AgentRowsScript))
  const refreshedProvider = refreshedRows.find(row => row.agentId === workProviderId)
  assert(refreshedProvider !== undefined && /file-search/u.test(refreshedProvider.text),
    `the refreshed panel lost the Agent declaration: ${JSON.stringify(refreshedRows)}`)
  // The rendered label spacing comes from the product locale, not a behavior
  // contract; assert the observable service, resource, and capacity facts by value.
  assert(/file-search/u.test(refreshedProvider.text) && /search-slot/u.test(refreshedProvider.text)
    && /2\s*slot/u.test(refreshedProvider.text),
    `the refreshed panel lost the declared resource detail: ${refreshedProvider.text}`)

  // (c) Configuration interaction: a real click opens the Console settings entry,
  // the settings toolbar selects a real Agent, and a real provider-card click runs
  // an existing provider operation. The accepted revision advances for that Agent
  // only and the browser reads the result back from the owner projection.
  const before = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-before',
    profile, `fetch('/api/v1/projection').then(r => r.json()).then(j => JSON.stringify({ configs: j.configs }))`))
  writeJson(join(evidenceDir, 'browser-config-before.json'), before)
  const beforeRow = before.configs.find(row => row.agentId === workProviderId)
  assert(beforeRow !== undefined, `the installed Console published no config row for ${workProviderId}: ${JSON.stringify(before.configs)}`)
  const otherBefore = before.configs.find(row => row.agentId === workReceiverId)
  camoClick(fixture, camo, evidenceDir, 'browser-config-open', profile, 'button[data-focus-key="console:settings"]')
  const selectAction = await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-select-action', profile,
    `(() => { const select = document.querySelector('div.teams-config-toolbar select.teams-select'); if (select === null) return 'missing'; select.value = ${JSON.stringify(workProviderId)}; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value })()`)
  assert(selectAction === workProviderId, `the Console settings panel did not select ${workProviderId}: ${selectAction}`)
  const cardState = await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-card', profile,
    `JSON.stringify({ selected: document.querySelector('div.teams-config-toolbar select.teams-select')?.value ?? null, providers: [...document.querySelectorAll('article.teams-provider-card')].map(card => ({ text: card.textContent ?? '', catalog: card.querySelector('.teams-catalog-state')?.textContent ?? null })) })`)
  const cardView = JSON.parse(cardState)
  assert(cardView.selected === workProviderId, `the settings toolbar did not keep the selected Agent: ${cardState}`)
  assert(cardView.providers.length === 1, `the settings panel did not render the one configured provider: ${cardState}`)
  camoClick(fixture, camo, evidenceDir, 'browser-config-actions', profile,
    'article.teams-provider-card .teams-provider-actions button:nth-of-type(2)')
  const after = await waitForAsync(async () => {
    const current = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-after',
      profile, `fetch('/api/v1/projection').then(r => r.json()).then(j => JSON.stringify({ configs: j.configs }))`))
    const row = current.configs.find(candidate => candidate.agentId === workProviderId)
    return row !== undefined && row.acceptedRevision > beforeRow.acceptedRevision ? current : undefined
  }, 60_000, 'the Console provider operation to advance the accepted revision')
  writeJson(join(evidenceDir, 'browser-config-after.json'), after)
  const afterRow = after.configs.find(row => row.agentId === workProviderId)
  assert(afterRow.acceptedRevision === beforeRow.acceptedRevision + 1,
    `the Console provider operation advanced the accepted revision by ${afterRow.acceptedRevision - beforeRow.acceptedRevision}: ${JSON.stringify(afterRow)}`)
  const afterCard = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-after-dom', profile,
    `JSON.stringify({ catalog: document.querySelector('article.teams-provider-card .teams-catalog-state')?.textContent ?? null, models: [...document.querySelectorAll('article.teams-provider-card select.teams-select option')].map(option => option.value) })`))
  assert(afterCard.models.includes(bb09StubModelId),
    `the settings panel did not show the refreshed provider catalog: ${JSON.stringify(afterCard)}`)
  const otherAfter = after.configs.find(row => row.agentId === workReceiverId)
  assert(JSON.stringify(otherAfter ?? null) === JSON.stringify(otherBefore ?? null),
    `the Console provider operation changed another Agent's config: ${JSON.stringify([otherBefore, otherAfter])}`)
  camoClick(fixture, camo, evidenceDir, 'browser-config-close', profile,
    '.teams-drawer .teams-header-actions button:nth-of-type(2)')
  observed.config = {
    agent: workProviderId,
    accepted_before: beforeRow.acceptedRevision,
    accepted_after: afterRow.acceptedRevision,
    provider_card_catalog: afterCard.catalog,
    other_agent_unchanged: otherAfter === undefined,
  }

  const screenshot = camoRun(fixture, camo, evidenceDir, 'browser-screenshot',
    ['screenshot', '--profile', profile, '--path', join(evidenceDir, 'browser-page.png')], { expectStatus: 0 })
  observed.screenshot = camoJson(screenshot, 'browser-screenshot').path

  // (d) Authentication refusal: a fresh, credential-free profile gets the browser
  // challenge and the same-origin API still answers 401.
  const noCredProfile = options.noCredentialProfile
  const noCredStart = camoRun(fixture, camo, evidenceDir, 'browser-unauthenticated-start',
    ['start', '--profile', noCredProfile, '--url', cleanUrl, '--headless'], { expectStatus: 0 })
  camoJson(noCredStart, 'browser-unauthenticated-start')
  profiles.add(noCredProfile)
  const noCredBody = await camoEvaluate(fixture, camo, evidenceDir, 'browser-unauthenticated',
    noCredProfile, 'document.body.innerText')
  assert(typeof noCredBody === 'string' && /Authentication required/u.test(noCredBody),
    `the credential-free browser was not challenged: ${String(noCredBody).slice(0, 200)}`)
  const noCredStatus = await camoEvaluate(fixture, camo, evidenceDir, 'browser-unauthenticated-api',
    noCredProfile, `fetch('/api/v1/projection', { method: 'GET' }).then(r => r.status)`)
  assert(noCredStatus === 401, `the credential-free browser API returned ${noCredStatus}, not 401`)
  observed.unauthenticated = { body: noCredBody, projection_status: noCredStatus }

  // (e) Origin refusal: an authenticated wrong-Origin request is refused while the
  // same-origin browser operation above already succeeded.
  const wrongOrigin = await fetch(`${cleanUrl}api/v1/projection`, { headers: { authorization, origin: 'http://bb-cross-site.invalid' } })
  const crossSite = await fetch(`${cleanUrl}api/v1/projection`, { headers: { authorization, 'sec-fetch-site': 'cross-site' } })
  const sameOrigin = await fetch(`${cleanUrl}api/v1/projection`, { headers: { authorization, 'sec-fetch-site': 'same-origin' } })
  assert(wrongOrigin.status === 401, `an authenticated wrong-Origin request returned ${wrongOrigin.status}`)
  assert(crossSite.status === 401, `an authenticated cross-site request returned ${crossSite.status}`)
  assert(sameOrigin.status === 200, `an authenticated same-origin request returned ${sameOrigin.status}`)
  writeJson(join(evidenceDir, 'origin-refusals.json'), { wrong_origin: wrongOrigin.status, cross_site: crossSite.status })
  writeJson(join(evidenceDir, 'browser-same-origin.json'), { status: sameOrigin.status, projection_fetch: projectionStatus })
  observed.origin = { wrong_origin: wrongOrigin.status, cross_site: crossSite.status, same_origin: sameOrigin.status }

  const authRefusals = await fetch(`${cleanUrl}api/v1/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'config.refreshModels', agentId: workProviderId, expectedRevision: 0, providerId: bb09StubProviderId }),
  })
  assert(authRefusals.status === 401, `an unauthenticated management command returned ${authRefusals.status}`)
  writeJson(join(evidenceDir, 'auth-refusals.json'), { unauthenticated_command: authRefusals.status, unauthenticated_projection: 401 })
  observed.auth_refusals = { unauthenticated_command: authRefusals.status }

  assertNoSecretInEvidence(evidenceDir, secrets)
  return observed
}

/**
 * The isolated Agent-policy refusal scenario: a second real install whose daemons
 * do not authorize `__console`. The public management entry must answer FORBIDDEN
 * and the refused Agent's own accepted revision must not advance.
 */
async function bb09AgentPolicyRefusal(context, evidenceDir) {
  const refusalDir = join(evidenceDir, 'agent-policy-refusal')
  mkdirSync(refusalDir, { recursive: true })
  const fixture = installPackage(context.packRoot, refusalDir, 'bb09-refusal',
    { AGENTTEAMS_OPENCODE_EXECUTABLE: openCodeExecutablePath(refusalDir) })
  let lifecycle
  try {
    const config = ensureUserConfig(fixture, refusalDir, {
      buildConfigText: searchExecutable => bb09ConfigText({ stubBaseUrl: 'http://127.0.0.1:1', searchExecutable, allowedManagers: [] }),
    })
    lifecycle = startAndReadLifecycle(fixture, refusalDir, 'bb09-refusal')
    const console = startInstalledSessionConsole(fixture, refusalDir, 'bb09-refusal')
    const before = readAcceptedConfigRevision(lifecycle.internal.internalPath, workProviderId)
    assert(before !== undefined, 'the refusal fixture published no accepted config revision')
    const refusal = await consoleHttp(console.url, console.authorization, '/api/v1/command', {
      body: { kind: 'config.refreshModels', agentId: workProviderId, expectedRevision: before, providerId: bb09StubProviderId },
    })
    assert(refusal.status === 200 && refusal.body?.ok === false && refusal.body.error?.code === 'FORBIDDEN',
      `the public management entry did not refuse an unauthorized manager: ${refusal.status} ${refusal.text.slice(0, 300)}`)
    const after = readAcceptedConfigRevision(lifecycle.internal.internalPath, workProviderId)
    assert(after === before, `the refused management command advanced the Agent config revision: ${before} -> ${after}`)
    writeJson(join(refusalDir, 'agent-policy-refusal.json'), {
      command: { kind: 'config.refreshModels', agentId: workProviderId, providerId: bb09StubProviderId },
      http_status: refusal.status,
      result: publicJson(refusal.body),
      accepted_revision_before: before,
      accepted_revision_after: after,
      console_config_sha256: config.configSha256,
    })
    const stopped = await stopAndAssertClean(fixture, lifecycle, refusalDir, 'bb09-refusal-final')
    lifecycle = undefined
    return { http_status: refusal.status, error: publicJson(refusal.body.error), accepted_revision_before: before,
      accepted_revision_after: after, stop_stdout: stopped.stop.stdout }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The refusal observation is the primary record.
    }
  }
}

async function runBB09(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB09')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb09',
    { AGENTTEAMS_OPENCODE_EXECUTABLE: openCodeExecutablePath(evidenceDir) })
  const camo = resolveCamo(evidenceDir)
  provisionBrowserRuntime(fixture, evidenceDir)
  const stub = createSessionProviderStub({ models: [bb09StubModelId] })
  const profiles = new Set()
  const camoProfiles = [`bb09-main-${process.pid}`, `bb09-nocred-${process.pid}`]
  let lifecycle
  let result
  try {
    const stubUrl = await listenProviderStub(stub)
    const config = ensureUserConfig(fixture, evidenceDir, {
      buildConfigText: searchExecutable => bb09ConfigText({ stubBaseUrl: stubUrl, searchExecutable, allowedManagers: ['__console'] }),
    })
    writeWorkFixture(fixture)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb09')

    // The installed public `status` line embeds the Console observation, so the
    // installed Console entrypoint must be online immediately after start.
    const startStatus = parseCliConsole(lifecycle.status.stdout)
    const initial = assertConsoleOnline(startStatus, 'installed Console after start')
    assert(!lifecycle.status.stdout.includes(consolePassword), 'installed status printed the Console credential value')
    const entry = readConsoleRuntime(lifecycle.internal.internalPath)
    assert(typeof entry.entryPath === 'string' && entry.entryPath.startsWith(fixture.installedRoot + sep),
      `installed Console entry escaped the installed package: ${entry.entryPath}`)
    assert(!entry.entryPath.startsWith(root + sep), `installed Console entry resolved to the source tree: ${entry.entryPath}`)
    assert(entry.entryPath.includes('console-process'), `installed Console entry is not the Console child: ${entry.entryPath}`)
    assert(entry.pid === initial.pid, 'status Console pid does not match the persisted Console runtime')

    // The Console listener is a real installed Console child; assert the
    // authenticated page and the unauthorized refusal on the live URL.
    const unauthorized = await fetch(initial.url)
    assert(unauthorized.status === 401, `installed Console served an unauthenticated request: ${unauthorized.status}`)
    const authorization = `Basic ${Buffer.from(`${consoleUsername}:${consolePassword}`).toString('base64')}`
    const authorized = await fetch(initial.url, { headers: { authorization } })
    assert(authorized.status === 200, `installed Console rejected the configured credential: ${authorized.status}`)

    // The real browser acceptance of the installed Console: two real daemons, the
    // authoritative declaration, the observation/config interactions and the
    // authentication/origin refusals, all from a headless Camo browser.
    const browser = await bb09BrowserAcceptance({
      fixture, camo, evidenceDir, profiles,
      profile: camoProfiles[0], noCredentialProfile: camoProfiles[1],
      initial, statusStdout: lifecycle.status.stdout, configText: config.configText, authorization,
    })
    const agentPolicy = await bb09AgentPolicyRefusal(context, evidenceDir)

    // Stop Console through the installed CLI, then assert the installed Console
    // endpoint is gone while Work submitted through the installed CLI still
    // completes against the same surviving daemons.
    const stop = runConsole(fixture, evidenceDir, 'bb09-console-stop', ['stop'], { expectStatus: 0 })
    const stopStatus = parseCliConsole(stop.stdout)
    assert(stopStatus.consoleState === 'stopped', `installed console stop did not report stopped: ${stop.stdout.trim()}`)
    await waitForProcessesGone([initial.pid])
    assert(consoleListenerGone(initial.url), `installed Console endpoint still accepts connections after stop: ${initial.url}`)

    const afterStop = parseInternal(join(dirname(fixture.configPath), 'internal.toml'))
    assert(afterStop.launcher.pid === lifecycle.parsed.pid && afterStop.launcher.generation === lifecycle.parsed.generation,
      'installed console stop replaced the launcher')
    assert(afterStop.processes.map(process => process.pid).join(',') === lifecycle.internal.processes.map(process => process.pid).join(','),
      'installed console stop replaced an Agent daemon')

    const offlineWork = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb09-work-without-console',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', workReceiverId, '--payload', '{"query":"marker-beta"}'],
      { expectStatus: 0 }))
    assertMatchedSearch(offlineWork, './b.txt')

    // Restart Console and assert it comes back on the same persisted port with a
    // new Console generation and pid.
    const restart = runConsole(fixture, evidenceDir, 'bb09-console-restart', ['start'], { expectStatus: 0 })
    const restarted = assertConsoleOnline(parseCliConsole(restart.stdout), 'installed Console after restart')
    assert(restarted.url === initial.url, `installed Console restart did not reuse the persisted url: ${initial.url} -> ${restarted.url}`)
    assert(restarted.generation > initial.generation, 'installed Console restart did not advance the Console generation')
    assert(restarted.pid !== initial.pid, 'installed Console restart reused the Console pid')

    // Typed failure path: an unreadable Console observation must return
    // CONSOLE_STATUS_UNAVAILABLE, never a fabricated healthy state. Removing the
    // launcher's published control socket makes the observation unreadable.
    const controlSocket = parseToml(readFileSync(lifecycle.internal.internalPath, 'utf8')).workControl?.socketPath
    assert(typeof controlSocket === 'string' && controlSocket !== '', 'installed lifecycle has no published Work control socket')
    rmSync(controlSocket, { force: true })
    const unavailableCli = runConsole(fixture, evidenceDir, 'bb09-console-status-unavailable', ['status'], { expectNonZero: true })
    assert(/Console control socket is unavailable/u.test(`${unavailableCli.stdout}\n${unavailableCli.stderr}`),
      `console status did not report the typed observation failure: ${unavailableCli.stdout}${unavailableCli.stderr}`)
    // The typed terminal (`CONSOLE_STATUS_UNAVAILABLE`) is a runtime-boundary
    // detail that no installed public entrypoint exposes, so this case asserts the
    // public refusal above rather than importing an installed internal module.

    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb09')
    const allPids = lifecyclePids(lifecycle.internal)

    // Typed failure path: a Console start while `[console]` is disabled must be a
    // typed refusal with zero child and zero online Console runtime row.
    const disabledConfigText = config.configText.replace('[console]\nenabled = true', '[console]\nenabled = false')
    assert(disabledConfigText !== config.configText, 'BB09 fixture did not contain an enabled Console section')
    writeFileSync(fixture.configPath, disabledConfigText, { encoding: 'utf8', mode: 0o600 })
    const disabledLifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb09-disabled')
    const disabledCli = runConsole(fixture, evidenceDir, 'bb09-console-disabled', ['start'], { expectNonZero: true })
    assert(/Console is disabled/u.test(`${disabledCli.stdout}\n${disabledCli.stderr}`),
      `console start did not refuse a disabled Console: ${disabledCli.stdout}${disabledCli.stderr}`)
    // Same boundary rule as above: the typed `CONSOLE_DISABLED` terminal is not a
    // public output, so the refusal above and the zero-child state below are what
    // this case asserts.
    const disabledRuntime = readConsoleRuntime(disabledLifecycle.internal.internalPath)
    assert(disabledRuntime.state === 'stopped' && disabledRuntime.pid === undefined,
      `a disabled Console start wrote a live runtime row: ${JSON.stringify(disabledRuntime)}`)
    const disabledFinal = await stopAndAssertClean(fixture, disabledLifecycle, evidenceDir, 'bb09-disabled-final')
    const disabledPids = lifecyclePids(disabledLifecycle.internal)
    const browserCleanup = camoTeardown(fixture, camo, evidenceDir, profiles, 'browser-cleanup')
    profiles.clear()
    writeJson(join(evidenceDir, 'browser-cleanup.json'), { profiles: browserCleanup })
    assertNoSecretInEvidence(evidenceDir, [consolePassword])
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        config_sha256: config.configSha256,
        commands: [
          'agentteams init',
          'agentteams start --config <isolated-home>/.agentteams/config.toml',
          'agentteams status --config <isolated-home>/.agentteams/config.toml',
          'camo start --profile <bb09> --url http://<user>:<redacted>@<consoleUrl>/ --headless',
          'camo goto <consoleUrl>/ --profile <bb09>',
          'camo evaluate fetch(/api/v1/projection)',
          'camo click button[data-focus-key="agent:bb-provider:details"]',
          'camo click .teams-drawer .teams-header-actions button:nth-of-type(2) (close drawer)',
          'camo click .teams-panel .teams-header-actions button:nth-of-type(2) (refresh projection)',
          'camo click button[data-focus-key="console:settings"]',
          'camo evaluate div.teams-config-toolbar select.teams-select (select bb-provider)',
          'camo click article.teams-provider-card .teams-provider-actions button:nth-of-type(2) (refresh models)',
          'camo start --profile <bb09-nocred> --url <consoleUrl>/ --headless (credential-free)',
          'agentteams console stop --config <isolated-home>/.agentteams/config.toml',
          'agentteams work submit --receiver bb-receiver --payload {"query":"marker-beta"} (Console stopped)',
          'agentteams console start --config <isolated-home>/.agentteams/config.toml (same persisted url)',
          'agentteams console status --config <isolated-home>/.agentteams/config.toml (unreadable observation, CONSOLE_STATUS_UNAVAILABLE)',
          'agentteams stop --generation <generation>',
          'set [console].enabled=false; agentteams start',
          'agentteams console start --config <isolated-home>/.agentteams/config.toml (CONSOLE_DISABLED)',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        launcher: lifecycle.parsed,
        console_entry_path: entry.entryPath,
        console_status_after_start: initial,
        console_http: { unauthorized: unauthorized.status, authorized: authorized.status },
        browser,
        agent_policy_refusal: agentPolicy,
        browser_cleanup: browserCleanup,
        console_status_after_stop: { state: stopStatus.consoleState, stdout: stop.stdout.trim() },
        console_listener_gone_after_stop: consoleListenerGone(initial.url),
        work_without_console: offlineWork.control,
        console_status_after_restart: restarted,
        console_status_unavailable: { cli: unavailableCli.stderr.trim() },
        disabled_console_start: { cli: disabledCli.stderr.trim(), runtime: disabledRuntime },
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        disabled_stop_stdout: disabledFinal.stop.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        disabled_pids_after_stop: disabledPids,
        disabled_pids_alive_after_stop: disabledPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      if (existsSync(fixture.temporaryRoot)) camoTeardown(fixture, camo, evidenceDir, profiles, 'browser-final')
    } catch {
      // Browser teardown is best-effort; the cleanup record carries the outcome.
    }
    await closeProviderStub(stub)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// BB10 / BB12: the installed Session entry. Both cases install the staged
// package outside the source tree, start the installed launcher plus the
// installed Console child, and drive real Session actions through the Console
// HTTP ingress to the managed OpenCode child. The LLM is a local
// OpenAI-compatible stub, so no external credential or network is required.
// ---------------------------------------------------------------------------

// The session fixture reuses the two daemon ids the shared lifecycle helpers
// already own, so the installed launcher, the derived internal.toml and the
// Console credentials keep one shape across every case.
const sessionAgentId = 'bb-provider'
const passiveAgentId = 'bb-receiver'
const sessionPrimaryProviderId = 'bb-primary'
const sessionBackupProviderId = 'bb-backup'
const sessionManualProviderId = 'bb-manual'
const sessionPrimaryModel = 'bb-primary-model'
const sessionBackupModel = 'bb-backup-model'
const sessionManualModel = 'bb-manual-model'
const sessionSentinel = 'bb-session-provider-ok'
const sessionToolMarker = 'bb12-tool-probe'
const sessionToolCallId = 'call_bb12_tool'
const sessionPermissionMarker = 'bb12-permission-probe'
const sessionPermissionCallId = 'call_bb12_permission'
const sessionHoldMarker = 'bb12-hold-open'
const sessionEnvSentinel = 'bb12-env-sentinel'

/** Resolve the real OpenCode binary from the environment instead of a written path. */
function openCodeExecutablePath(evidenceDir) {
  const resolved = runChecked('which', ['opencode'], { logPath: join(evidenceDir, 'which-opencode.json') }).stdout.trim()
  assert(resolved.startsWith('/'), `opencode executable is not absolute: ${resolved}`)
  return resolved
}

async function waitForAsync(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      const absent = new Error(`blackbox-user-mvp: timed out waiting for ${label}`)
      absent.absentObservation = true
      throw absent
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
}

/** A timeout is an observable absence; a failing probe stays a real error. */
async function optionalWait(probe, timeoutMs) {
  try {
    return await waitForAsync(probe, timeoutMs, 'an optional observation')
  } catch (error) {
    if (error?.absentObservation === true) return undefined
    throw error
  }
}

function publicJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * The session fixture: `bb-provider` owns one explicit primary binding, one
 * explicit backup binding and the Console manager policy; `bb-receiver` is a
 * real runtime daemon without any model binding, so it must stay passive.
 */
function sessionConfigFixtureText(providerBaseUrls, searchExecutable) {
  const provider = (id, label, baseUrl) => `
[providers.${id}]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(`${baseUrl}/v1`)}
label = ${JSON.stringify(label)}
enabled = true`
  return `version = 3

[bridge]
enabled = true

[agents.${sessionAgentId}]
enabled = true
role = "provider"
label = "BB-Session"

[agents.${sessionAgentId}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "local"
agentKind = "custom"
label = "BB-Session"

[agents.${sessionAgentId}.runtime]
scopeId = "local"
dataDirectory = "data/${sessionAgentId}"
policy = { revision = 1, allowedConsumers = [], allowedManagers = ["__console"] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-${sessionAgentId}" }

[agents.${sessionAgentId}.model]
primary = { provider = "${sessionPrimaryProviderId}", model = "${sessionPrimaryModel}" }
backup = { provider = "${sessionBackupProviderId}", model = "${sessionBackupModel}" }

[agents.${passiveAgentId}]
enabled = true
role = "provider"
label = "BB-Passive"

[agents.${passiveAgentId}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "local"
agentKind = "custom"
label = "BB-Passive"

[agents.${passiveAgentId}.runtime]
scopeId = "local"
dataDirectory = "data/${passiveAgentId}"
policy = { revision = 1, allowedConsumers = [], allowedManagers = ["__console"] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-${passiveAgentId}" }

[console]
enabled = true
username = ${JSON.stringify(consoleUsername)}
passwordEnv = ${JSON.stringify(consolePasswordEnv)}
agentIds = ["${sessionAgentId}", "${passiveAgentId}"]
${provider(sessionPrimaryProviderId, 'BB Primary', providerBaseUrls.primary)}
${provider(sessionBackupProviderId, 'BB Backup', providerBaseUrls.backup)}
${provider(sessionManualProviderId, 'BB Manual', providerBaseUrls.manual)}

[[models]]
provider = "${sessionPrimaryProviderId}"
id = "${sessionPrimaryModel}"
label = "BB Primary Model"

[[models]]
provider = "${sessionBackupProviderId}"
id = "${sessionBackupModel}"
label = "BB Backup Model"
`
}

/**
 * One local OpenAI-compatible provider stub. `/v1/models` answers the catalog
 * refresh; `/v1/chat/completions` answers the newest turn only, so a tool call
 * ends after its own result comes back. The recorded request bodies are the
 * external evidence of which explicit provider/model a Session really used.
 */
function createSessionProviderStub(options = {}) {
  const requests = []
  const held = []
  const state = { fail: false }
  const models = options.models ?? []
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }))
      return
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unsupported provider stub route' } }))
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(body)
      if (state.fail) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bb session provider stub failure', type: 'api_error' } }))
        return
      }
      let input
      try { input = JSON.parse(body) } catch { input = {} }
      const messages = Array.isArray(input.messages) ? input.messages : []
      const newest = messages[messages.length - 1]
      const promptText = typeof newest?.content === 'string' ? newest.content : JSON.stringify(newest?.content ?? '')
      if (options.holdMarker !== undefined && promptText.includes(options.holdMarker)) {
        held.push(response)
        return
      }
      const toolCall = options.toolCommand === undefined ? undefined : { index: 0, id: options.toolCallId, type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: options.toolCommand }) } }
      // The substrate default allows every tool except a `*.env` read, which it asks
      // about; that read is the only probe here that surfaces a real permission.
      const permissionCall = options.envProbePath === undefined ? undefined : { index: 0, id: options.permissionCallId, type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ filePath: options.envProbePath }) } }
      const call = options.permissionMarker !== undefined && promptText.includes(options.permissionMarker) ? permissionCall
        : options.toolMarker !== undefined && promptText.includes(options.toolMarker) ? toolCall
          : undefined
      writeSessionChatResponse(response, body, input, call)
    })
  })
  return { server, requests, held, state }
}

function writeSessionChatResponse(response, body, input, call) {
  const chunk = payload => `data: ${JSON.stringify(payload)}\n\n`
  if (body.includes('"stream":true')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (call !== undefined) {
      response.write(chunk({ id: 'chatcmpl-bb', object: 'chat.completion.chunk', created: 1, model: input.model,
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] }))
      response.write(chunk({ id: 'chatcmpl-bb', object: 'chat.completion.chunk', created: 1, model: input.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    } else {
      response.write(chunk({ id: 'chatcmpl-bb', object: 'chat.completion.chunk', created: 1, model: input.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: sessionSentinel }, finish_reason: null }] }))
      response.write(chunk({ id: 'chatcmpl-bb', object: 'chat.completion.chunk', created: 1, model: input.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
    response.end('data: [DONE]\n\n')
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  if (call !== undefined) {
    response.end(JSON.stringify({ id: 'chatcmpl-bb', object: 'chat.completion', created: 1, model: input.model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  response.end(JSON.stringify({ id: 'chatcmpl-bb', object: 'chat.completion', created: 1, model: input.model,
    choices: [{ index: 0, message: { role: 'assistant', content: sessionSentinel }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
}

async function listenProviderStub(stub) {
  await new Promise((resolveListen, rejectListen) => stub.server.listen(0, '127.0.0.1', error => error ? rejectListen(error) : resolveListen()))
  const address = stub.server.address()
  assert(address !== null && typeof address === 'object', 'the provider stub did not bind a loopback port')
  return `http://127.0.0.1:${address.port}`
}

async function closeProviderStub(stub) {
  if (stub === undefined) return
  for (const response of stub.held.splice(0)) {
    try { response.destroy() } catch { /* the response is already closed */ }
  }
  try { await new Promise(resolveClose => stub.server.close(() => resolveClose())) } catch { /* the stub is already closed */ }
}

async function consoleHttp(consoleUrl, authorization, path, options = {}) {
  const response = await fetch(`${consoleUrl}${path}`, {
    method: options.method ?? 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body, text }
}

function sessionConsoleClient(consoleUrl, authorization) {
  return {
    projection: () => consoleHttp(consoleUrl, authorization, '/api/v1/projection', { method: 'GET' }),
    command: command => consoleHttp(consoleUrl, authorization, '/api/v1/command', { body: command }),
    sessionMessage: (agentId, sessionId, payload, timeoutMs = 30_000) => consoleHttp(consoleUrl, authorization,
      `/api/v1/session-message?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`,
      { body: payload, timeoutMs }),
  }
}

function readSessionEvents(projection, agentId, sessionId) {
  return projection.sessionEvents?.filter(event => event.agentId === agentId && event.sessionId === sessionId) ?? []
}

function sessionCancelConfirmed(result) {
  return result?.ok === true && result.result?.kind === 'session.cancel' && result.result.finalState === 'cancelled'
}

function sessionCancelUnknown(result) {
  return result?.ok === false && result.error?.code === 'RESULT_UNKNOWN'
    && result.error.detail?.kind === 'session.cancel' && result.error.detail.finalState === 'unknown'
}

/**
 * The Console hub opens its relay link to each managed daemon lazily, so the
 * first projection read can race the link. Retry until the projection is a real
 * `version 1` document and record the exact response that was accepted.
 */
async function readInstalledProjection(client, evidenceDir, name, timeoutMs = 90_000) {
  let last
  const body = await optionalWait(async () => {
    // The Console listener can be briefly unreachable right after an installed
    // restart, so a connection failure is a retry, not the observation.
    try {
      const response = await client.projection()
      last = response
      return response.status === 200 && response.body?.version === 1 && Array.isArray(response.body.agents)
        ? response.body
        : undefined
    } catch (error) {
      last = { status: 0, text: error instanceof Error ? error.message : String(error) }
      return undefined
    }
  }, timeoutMs)
  assert(body !== undefined,
    `the installed Console projection was not readable: status=${last?.status} body=${(last?.text ?? '').slice(0, 400)}`)
  if (evidenceDir !== undefined) writeJson(join(evidenceDir, `${name}-projection.json`), body)
  return body
}

function startInstalledSessionConsole(fixture, evidenceDir, prefix) {
  const start = runConsole(fixture, evidenceDir, `${prefix}-console-start`, ['start'], { expectStatus: 0 })
  const online = assertConsoleOnline(parseCliConsole(start.stdout), `${prefix} installed Console`)
  return {
    start,
    ...online,
    authorization: `Basic ${Buffer.from(`${consoleUsername}:${consolePassword}`).toString('base64')}`,
  }
}

async function applySessionConfigAndWait(client, agentId, evidenceDir, prefix) {
  const applied = await client.command({ kind: 'config.apply', agentId })
  assert(applied.body.ok === true, `config.apply failed for ${agentId}: ${JSON.stringify(applied.body)}`)
  const agent = await waitForAsync(async () => {
    const row = (await readInstalledProjection(client, undefined, 'apply')).agents.find(candidate => candidate.agentId === agentId)
    return row?.sessionCapable === true && row.sessionAvailability === 'current' ? row : undefined
  }, 180_000, `the installed ${agentId} Session runtime to become current`)
  writeJson(join(evidenceDir, `${prefix}-config-apply.json`), publicJson(applied.body))
  return { applied: publicJson(applied.body), agent: publicJson(agent) }
}

function waitForSessionTurn(sessionEvents, previousFinals, label) {
  return waitForAsync(async () => {
    const finals = (await sessionEvents()).filter(event => event.kind === 'final')
    return finals.length > previousFinals ? finals.at(-1) : undefined
  }, 180_000, label)
}

async function createAndOpenSession(client, title, evidenceDir, prefix) {
  const created = await client.command({ kind: 'session.create', agentId: sessionAgentId, title })
  assert(created.body.ok === true && created.body.result?.kind === 'session.create'
    && typeof created.body.result.sessionId === 'string',
  `session.create did not return a typed Session result: ${JSON.stringify(created.body)}`)
  // The create result carries only real OpenCode Session identity and never a
  // provider/model commitment, so no default can be mistaken for an explicit binding.
  for (const forbidden of ['providerId', 'modelId', 'provider', 'model', 'config']) {
    assert(created.body.result[forbidden] === undefined,
      `session.create fabricated a ${forbidden} commitment: ${JSON.stringify(created.body.result)}`)
  }
  const sessionId = created.body.result.sessionId
  const opened = await client.command({ kind: 'session.open', agentId: sessionAgentId, sessionId })
  assert(opened.body.ok === true, `session.open failed: ${JSON.stringify(opened.body)}`)
  const hydrated = await readInstalledProjection(client, undefined, 'session-open')
  assert(hydrated.sessions.some(session => session.agentId === sessionAgentId && session.sessionId === sessionId),
    'session.open did not hydrate the bounded projection')
  writeJson(join(evidenceDir, `${prefix}-session.json`), { created: publicJson(created.body), opened: publicJson(opened.body) })
  return { sessionId, created: publicJson(created.body), opened: publicJson(opened.body) }
}

// ---------------------------------------------------------------------------
// BB10 round 12: two real Teams provider instances. The case derives both
// provider instances from their then-current declared sources, persists only the
// credential *env name* in the isolated fixture config, and passes the single
// declared secret value to the owned installed launcher through one dedicated
// child-env object. Every missing precondition is a typed precondition failure
// (`status: 'unverified'`), never a fabricated success and never a silent skip.
// ---------------------------------------------------------------------------

const canonicalProviderId = 'goaichat-openai'
const rccProviderId = 'rcc-4444'
const canonicalCredentialEnv = 'TEAMS_BB10_CANONICAL_API_KEY'
const rccConfigSourcePath = '/Volumes/extension/.rcc/config.toml'
const canonicalProviderSourcePath = '/Volumes/extension/.rcc/provider/goaichat_openai/config.v2.toml'
const rccServerId = 'routecodex_v3_4444'
// Confirmed against the then-current catalog at implementation time. Teams
// persists and sends exactly this token: no `/` <-> `.` rewrite, no guessing.
const rccSelectedModelToken = 'goaichat_openai.qwen3.8-max'
const bb10DispatchTimeoutMs = 120_000
const bb10VisibleTaskPrompt = '请用一句简短中文解释什么是回声。不要调用工具，也不要读写文件。'

/** A precondition failure: not a product failure and not a fabricated pass. */
class Bb10SourceError extends Error {
  constructor(missingCapability, message, detail = {}) {
    super(message)
    this.name = 'Bb10SourceError'
    this.missingCapability = missingCapability
    this.detail = detail
  }
}

function bb10SourceFailure(missingCapability, message, detail = {}) {
  throw new Bb10SourceError(missingCapability, message, detail)
}

function bb10Record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bb10RequiredText(value, missingCapability, label) {
  if (typeof value !== 'string' || value.trim() === '') bb10SourceFailure(missingCapability, `${label} is missing or empty`)
  return value
}

function bb10ParseToml(text, missingCapability, label) {
  try {
    return parseToml(text)
  } catch (error) {
    return bb10SourceFailure(missingCapability, `${label} is not valid TOML`,
      { reason: error instanceof Error ? error.message : String(error) })
  }
}

function bb10ProtocolFromSource(type, label) {
  if (type === 'openai_chat') return 'openai-chat'
  if (type === 'openai_responses') return 'openai-responses'
  return bb10SourceFailure('canonical provider protocol is unsupported',
    `${label} declares an unsupported provider type`, { provider_type: type })
}

/**
 * Derive the canonical Teams provider instance from its declared source. The
 * declared provider id is normalized to the Teams instance id (`_` -> `-`).
 */
function parseCanonicalProviderSource(text, label) {
  const capability = 'canonical provider source is unusable'
  const root = bb10ParseToml(text, capability, label)
  const provider = root.provider
  if (!bb10Record(provider)) bb10SourceFailure(capability, `${label} declares no [provider] table`)
  const id = bb10RequiredText(provider.id, capability, `${label} provider.id`)
  const type = bb10RequiredText(provider.type, capability, `${label} provider.type`)
  const baseUrl = bb10RequiredText(provider.baseURL, capability, `${label} provider.baseURL`)
  const defaultModel = bb10RequiredText(provider.defaultModel, capability, `${label} provider.defaultModel`)
  const auth = provider.auth
  if (!bb10Record(auth)) bb10SourceFailure(capability, `${label} declares no [provider.auth] table`)
  const entries = auth.entries
  if (!Array.isArray(entries) || entries.length !== 1) {
    bb10SourceFailure('canonical credential entry is not unique',
      `${label} declares ${Array.isArray(entries) ? entries.length : 'no'} auth entries; exactly one is required`)
  }
  const entry = entries[0]
  if (!bb10Record(entry)) bb10SourceFailure(capability, `${label} auth entry is not a table`)
  const alias = bb10RequiredText(entry.alias, capability, `${label} auth entry alias`)
  const secretFile = bb10RequiredText(entry.secretFile, capability, `${label} auth entry secretFile`)
  const secretKey = bb10RequiredText(entry.secretKey, capability, `${label} auth entry secretKey`)
  return {
    label, id, instanceId: id.replace(/_/gu, '-'), type, protocol: bb10ProtocolFromSource(type, label),
    baseUrl, defaultModel, authAlias: alias, secretFile, secretKey,
  }
}

/** Derive the RCC provider instance from its declared server block. */
function parseRccServerSource(text, label, serverId) {
  const capability = 'rcc server source is unusable'
  const root = bb10ParseToml(text, capability, label)
  const servers = root.servers
  if (!bb10Record(servers)) bb10SourceFailure(capability, `${label} declares no [servers] table`)
  const server = servers[serverId]
  if (!bb10Record(server)) bb10SourceFailure(capability, `${label} declares no server ${serverId}`, { server_id: serverId })
  if (server.enabled !== true) bb10SourceFailure(capability, `${label} server ${serverId} is not enabled`, { server_id: serverId })
  const bind = bb10RequiredText(server.bind, capability, `${label} server ${serverId} bind`)
  const port = server.port
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    bb10SourceFailure(capability, `${label} server ${serverId} port is not a usable TCP port`, { server_id: serverId })
  }
  const endpoints = server.endpoints
  if (!Array.isArray(endpoints) || !endpoints.includes('openai_chat')) {
    bb10SourceFailure('rcc server does not expose the openai_chat endpoint',
      `${label} server ${serverId} endpoints do not include openai_chat`, { server_id: serverId })
  }
  const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind
  return { label, serverId, bind, host, port, protocol: 'openai-chat', baseUrl: `http://${host}:${port}/v1` }
}

/**
 * The declared credential source is a flat `name = value` file, not hierarchical
 * TOML. Parse it line by line: trim, skip blank lines and whole-line `#`
 * comments, split at the first `=`, trim name and value, match the exact key and
 * strip only outer quotes. No interpolation, no escaping, no shell. Errors carry
 * only the class, path, key name and line number, never the raw line or value.
 */
function parseFlatSecretKey(text, keyName, label) {
  const capability = 'canonical credential source is unusable'
  const values = new Map()
  const lines = String(text).split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '' || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals <= 0) bb10SourceFailure(capability, `${label} has a malformed credential line`, { line: index + 1 })
    const name = line.slice(0, equals).trim()
    if (name === '') bb10SourceFailure(capability, `${label} has a credential line with no key name`, { line: index + 1 })
    let value = line.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value === '') bb10SourceFailure(capability, `${label} declares an empty credential value`, { key: name, line: index + 1 })
    if (values.has(name)) bb10SourceFailure(capability, `${label} declares the credential key more than once`, { key: name, line: index + 1 })
    values.set(name, value)
  }
  const value = values.get(keyName)
  if (value === undefined) {
    bb10SourceFailure('canonical credential key is absent', `${label} does not declare the selected credential key`, { key: keyName })
  }
  return value
}

/** Read only the single declared auth entry's secret value. Never log the value. */
function readDeclaredSecretKey(secretFile, secretKey) {
  const capability = 'canonical credential source is unusable'
  if (!existsSync(secretFile)) bb10SourceFailure(capability, 'the declared credential file does not exist', { secret_file: secretFile })
  let text
  try {
    text = readFileSync(secretFile, 'utf8')
  } catch {
    return bb10SourceFailure(capability, 'the declared credential file could not be read', { secret_file: secretFile })
  }
  return parseFlatSecretKey(text, secretKey, secretFile)
}

/** Probe one provider's declared model catalog without any credential. */
async function probeProviderCatalog(baseUrl, missingCapability, label) {
  const url = `${baseUrl.replace(/\/+$/u, '')}/models`
  let response
  try {
    response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    return bb10SourceFailure(missingCapability, `${label} did not answer at ${url}`,
      { url, reason: error instanceof Error ? error.message : String(error) })
  }
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = undefined }
  const list = body === undefined ? [] : [body.data, body.models].find(Array.isArray) ?? []
  return { url, status: response.status, ids: list.map(entry => bb10Record(entry) ? entry.id : entry).filter(id => typeof id === 'string') }
}

/**
 * Resolve every BB10 precondition from the then-current sources. Each failure is
 * a typed `Bb10SourceError`, so the case reports `unverified` with the missing
 * capability instead of a fabricated pass.
 */
async function resolveBb10Preconditions(evidenceDir) {
  let openCodeExecutable
  try {
    openCodeExecutable = openCodeExecutablePath(evidenceDir)
  } catch (error) {
    return bb10SourceFailure('managed OpenCode executable is unavailable',
      'the installed OpenCode executable is not resolvable', { reason: error instanceof Error ? error.message : String(error) })
  }
  if (!existsSync(rccConfigSourcePath)) {
    bb10SourceFailure('rcc config source is unavailable', 'the declared RCC config source is missing', { source: rccConfigSourcePath })
  }
  const rcc = parseRccServerSource(readFileSync(rccConfigSourcePath, 'utf8'), rccConfigSourcePath, rccServerId)
  const rccCatalog = await probeProviderCatalog(rcc.baseUrl, 'rcc endpoint is unreachable', `the RCC server ${rcc.serverId}`)
  if (rccCatalog.status !== 200) {
    bb10SourceFailure('rcc catalog is unavailable', `the RCC catalog returned HTTP ${rccCatalog.status}`, { url: rccCatalog.url })
  }
  if (!rccCatalog.ids.includes(rccSelectedModelToken)) {
    bb10SourceFailure('selected rcc model is absent from the current catalog',
      'the selected RCC model token is not in the then-current catalog',
      { url: rccCatalog.url, model_count: rccCatalog.ids.length })
  }
  if (!existsSync(canonicalProviderSourcePath)) {
    bb10SourceFailure('canonical provider source is unavailable', 'the declared canonical provider source is missing',
      { source: canonicalProviderSourcePath })
  }
  const canonical = parseCanonicalProviderSource(readFileSync(canonicalProviderSourcePath, 'utf8'), canonicalProviderSourcePath)
  if (canonical.instanceId !== canonicalProviderId) {
    bb10SourceFailure('canonical provider identity changed',
      'the declared provider id no longer maps to the Teams instance id this case binds',
      { instance_id: canonical.instanceId })
  }
  const canonicalCatalog = await probeProviderCatalog(canonical.baseUrl, 'canonical endpoint is unreachable',
    `the canonical provider ${canonical.id}`)
  if (canonicalCatalog.status !== 200 && canonicalCatalog.status !== 401) {
    bb10SourceFailure('canonical catalog is unavailable', `the canonical endpoint returned HTTP ${canonicalCatalog.status}`,
      { url: canonicalCatalog.url })
  }
  const credentialValue = readDeclaredSecretKey(canonical.secretFile, canonical.secretKey)
  writeJson(join(evidenceDir, 'bb10-sources.json'), {
    opencode_executable: openCodeExecutable,
    rcc: { source: rccConfigSourcePath, server_id: rcc.serverId, base_url: rcc.baseUrl, protocol: rcc.protocol,
      bind: rcc.bind, port: rcc.port, selected_model: rccSelectedModelToken,
      catalog_url: rccCatalog.url, catalog_status: rccCatalog.status, catalog_model_count: rccCatalog.ids.length },
    canonical: { source: canonicalProviderSourcePath, provider_id: canonical.id, protocol: canonical.protocol,
      base_url: canonical.baseUrl, default_model: canonical.defaultModel, auth_alias: canonical.authAlias,
      secret_key: canonical.secretKey, secret_file: canonical.secretFile, credential_env: canonicalCredentialEnv,
      credential_length: credentialValue.length, catalog_url: canonicalCatalog.url,
      catalog_status: canonicalCatalog.status, catalog_model_count: canonicalCatalog.ids.length },
  })
  return { openCodeExecutable, rcc, canonical, credentialValue }
}

/**
 * The BB10 user `config.toml`. Both real providers are declared with the exact
 * model spellings their own catalogs publish. Only the credential *env name* is
 * persisted; the value itself is never written to any user or derived config.
 */
function canonicalSessionConfigText(spec, searchExecutable) {
  // Teams joins `/models` and `/chat/completions` onto `apiBaseUrl`, so the
  // declared source base URL (which already ends in `/v1`) is persisted as-is.
  const provider = (id, label, baseUrl, credentialEnv) => `
[providers.${id}]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(baseUrl.replace(/\/+$/u, ''))}
label = ${JSON.stringify(label)}
enabled = true${credentialEnv === undefined ? '' : `\ncredentialEnv = ${JSON.stringify(credentialEnv)}`}`
  return `version = 3

[bridge]
enabled = true

[agents.${sessionAgentId}]
enabled = true
role = "provider"
label = "BB10-Real"

[agents.${sessionAgentId}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "local"
agentKind = "custom"
label = "BB10-Real"

[agents.${sessionAgentId}.runtime]
scopeId = "local"
dataDirectory = "data/${sessionAgentId}"
policy = { revision = 1, allowedConsumers = [], allowedManagers = ["__console"] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-${sessionAgentId}" }

[agents.${sessionAgentId}.model]
primary = { provider = "${rccProviderId}", model = "${rccSelectedModelToken}" }

[agents.${passiveAgentId}]
enabled = true
role = "provider"
label = "BB10-Passive"

[agents.${passiveAgentId}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "local"
agentKind = "custom"
label = "BB10-Passive"

[agents.${passiveAgentId}.runtime]
scopeId = "local"
dataDirectory = "data/${passiveAgentId}"
policy = { revision = 1, allowedConsumers = [], allowedManagers = ["__console"] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-${passiveAgentId}" }

[console]
enabled = true
username = ${JSON.stringify(consoleUsername)}
passwordEnv = ${JSON.stringify(consolePasswordEnv)}
agentIds = ["${sessionAgentId}", "${passiveAgentId}"]
${provider(rccProviderId, 'RCC 4444', spec.rccBaseUrl)}
${provider(canonicalProviderId, 'GoAIChat OpenAI', spec.canonicalBaseUrl, canonicalCredentialEnv)}

[[models]]
provider = "${rccProviderId}"
id = "${rccSelectedModelToken}"
label = "RCC canonical model"

[[models]]
provider = "${canonicalProviderId}"
id = "${spec.canonicalModel}"
label = "GoAIChat default model"
`
}

/** The single dedicated child-env object that carries the credential value. */
function bb10LaunchEnv(fixture, credentialValue) {
  return { ...fixture.env, [canonicalCredentialEnv]: credentialValue }
}

/**
 * One real provider turn through the installed Console Session entry. The
 * assertion is on the visible result: a successful dispatch, a successful final
 * and at least one non-empty assistant text part. Reasoning, tool results, ACKs,
 * HTTP 200 and a provider capability test do not count.
 */
async function visibleAssistantTurn(client, agentId, sessionId, prompt, evidenceDir, prefix, label) {
  const events = async () => readSessionEvents(
    await readInstalledProjection(client, undefined, `${prefix}-events`), agentId, sessionId)
  const finalsBefore = (await events()).filter(event => event.kind === 'final').length
  const sent = await client.sessionMessage(agentId, sessionId, { text: prompt }, bb10DispatchTimeoutMs)
  assert(sent.body.ok === true, `${label} dispatch failed: ${JSON.stringify(sent.body).slice(0, 400)}`)
  const final = await waitForSessionTurn(events, finalsBefore, `${label} final event`)
  const all = await events()
  const parts = all.filter(event => event.kind === 'part' && event.partType === 'text'
    && typeof event.text === 'string' && event.text.trim() !== '')
  assert(final.state === 'completed', `${label} did not complete successfully: ${JSON.stringify(final)}`)
  assert(parts.length > 0,
    `${label} produced no non-empty assistant text part (reasoning and tool parts do not count): ${JSON.stringify(all.filter(event => event.kind === 'part').map(publicJson))}`)
  const text = parts.at(-1).text.trim()
  writeJson(join(evidenceDir, `${prefix}-turn.json`), {
    prompt, dispatch: publicJson(sent.body), final: publicJson(final),
    assistant_text: text, assistant_parts: parts.length, finish: final.finish ?? null,
  })
  return { dispatch: publicJson(sent.body), final: publicJson(final), text, parts: parts.length, finish: final.finish ?? null }
}

function bb10UnverifiedResult(context, evidenceDir, missingCapability, message, detail = {}, cleanup = {}) {
  writeJson(join(evidenceDir, 'bb10-unverified.json'), {
    missing_capability: missingCapability, message, detail: publicJson(detail), cleanup,
  })
  return {
    status: 'unverified',
    missing_capability: missingCapability,
    public_input: { package: context.packRoot, case: 'BB10' },
    external_observation: { missing_capability: missingCapability, error: message, detail: publicJson(detail), cleanup },
    evidence_path: evidenceDir,
  }
}

async function runBB10(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB10')
  mkdirSync(evidenceDir, { recursive: true })
  let fixture
  let lifecycle
  let result
  try {
    let preconditions
    try {
      preconditions = await resolveBb10Preconditions(evidenceDir)
    } catch (error) {
      if (!(error instanceof Bb10SourceError)) throw error
      return bb10UnverifiedResult(context, evidenceDir, error.missingCapability, error.message, error.detail,
        { fixture_created: false, installed_processes: 'none', retained_obligations: [] })
    }

    fixture = installPackage(context.packRoot, evidenceDir, 'bb10',
      { AGENTTEAMS_OPENCODE_EXECUTABLE: preconditions.openCodeExecutable })
    const launchEnv = bb10LaunchEnv(fixture, preconditions.credentialValue)
    const config = ensureUserConfig(fixture, evidenceDir, {
      buildConfigText: searchExecutable => canonicalSessionConfigText({
        rccBaseUrl: preconditions.rcc.baseUrl,
        canonicalBaseUrl: preconditions.canonical.baseUrl,
        canonicalModel: preconditions.canonical.defaultModel,
      }, searchExecutable),
    })
    assert(!config.configText.includes(preconditions.credentialValue),
      'the isolated user config persisted the canonical credential value instead of its env name')
    assert(config.configText.includes(canonicalCredentialEnv),
      'the isolated user config did not persist the canonical credential env name')

    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb10', defaultAgentIds, { launchEnv })
    const console = startInstalledSessionConsole(fixture, evidenceDir, 'bb10')
    const client = sessionConsoleClient(console.url, console.authorization)

    // (a) Two real daemons with two real configured provider rows.
    const discovery = await readInstalledProjection(client, evidenceDir, 'bb10')
    const sessionRow = discovery.agents.find(agent => agent.agentId === sessionAgentId)
    const passiveRow = discovery.agents.find(agent => agent.agentId === passiveAgentId)
    assert(sessionRow?.sessionCapable === true, `the installed ${sessionAgentId} row is not Session capable: ${JSON.stringify(sessionRow)}`)
    assert(passiveRow?.sessionCapable === false, `the installed ${passiveAgentId} row is not passive: ${JSON.stringify(passiveRow)}`)
    const configRow = discovery.configs.find(row => row.agentId === sessionAgentId)
    assert(configRow !== undefined, `the installed projection published no config row for ${sessionAgentId}`)
    const providerIds = configRow.providers.map(provider => provider.id)
    for (const id of [rccProviderId, canonicalProviderId]) {
      assert(providerIds.includes(id), `the installed config row does not publish the real provider ${id}: ${JSON.stringify(providerIds)}`)
    }

    // (b) Both real provider catalogs refresh through the Console config entry.
    // A catalog refresh only writes a directory observation; it never advances
    // the accepted revision (config/runtime-config.ts:918-921 asserts the
    // expected revision and :946 calls saveObservationUnlocked). Both refreshes
    // therefore run against the same public accepted revision.
    const acceptedRevision = configRow.acceptedRevision
    const rccRefresh = await client.command({ kind: 'config.refreshModels', agentId: sessionAgentId,
      expectedRevision: acceptedRevision, providerId: rccProviderId })
    assert(rccRefresh.body.ok === true, `the RCC catalog refresh failed: ${JSON.stringify(rccRefresh.body).slice(0, 400)}`)
    const canonicalRefresh = await client.command({ kind: 'config.refreshModels', agentId: sessionAgentId,
      expectedRevision: acceptedRevision, providerId: canonicalProviderId })
    if (canonicalRefresh.body.ok === false && canonicalRefresh.body.error?.code === 'CREDENTIAL_UNAVAILABLE') {
      return bb10UnverifiedResult(context, evidenceDir, 'canonical credential env did not reach the installed child',
        'config.refreshModels reported CREDENTIAL_UNAVAILABLE for the canonical provider',
        { rcc_refresh: publicJson(rccRefresh.body), canonical_refresh: publicJson(canonicalRefresh.body) },
        { fixture_created: true, cleanup: 'case finally block: installed stop, temp root removal' })
    }
    assert(canonicalRefresh.body.ok === true,
      `the canonical catalog refresh failed: ${JSON.stringify(canonicalRefresh.body).slice(0, 400)}`)
    const refreshed = await readInstalledProjection(client, evidenceDir, 'bb10-refreshed')
    const refreshedRow = refreshed.configs.find(row => row.agentId === sessionAgentId)
    assert(refreshedRow.acceptedRevision === configRow.acceptedRevision,
      `the catalog refresh advanced the accepted revision: ${JSON.stringify([configRow.acceptedRevision, refreshedRow.acceptedRevision])}`)
    const rccCatalogRow = refreshedRow.providers.find(provider => provider.id === rccProviderId)
    const canonicalCatalogRow = refreshedRow.providers.find(provider => provider.id === canonicalProviderId)
    assert(rccCatalogRow?.catalogState === 'ready' && rccCatalogRow.models.some(model => model.id === rccSelectedModelToken),
      `the RCC catalog did not publish the selected model: ${JSON.stringify(rccCatalogRow).slice(0, 400)}`)
    if (!(canonicalCatalogRow?.catalogState === 'ready'
      && canonicalCatalogRow.models.some(model => model.id === preconditions.canonical.defaultModel))) {
      // The canonical provider's declared default model is the only model this
      // case may bind; if its live catalog no longer publishes it, the real
      // provider precondition is gone and the case reports unverified.
      return bb10UnverifiedResult(context, evidenceDir, 'canonical declared model is absent from the current catalog',
        'the canonical provider catalog did not publish its declared default model',
        { catalog_state: canonicalCatalogRow?.catalogState ?? null,
          model_count: canonicalCatalogRow?.models.length ?? 0 },
        { fixture_created: true, cleanup: 'case finally block: installed stop, temp root removal' })
    }

    // (c) Apply the accepted RCC binding, then run one real RCC Session turn.
    const firstApply = await applySessionConfigAndWait(client, sessionAgentId, evidenceDir, 'bb10')
    assert(firstApply.agent.providerId === rccProviderId && firstApply.agent.modelId === rccSelectedModelToken,
      `the installed projection did not report the RCC binding: ${JSON.stringify(firstApply.agent)}`)
    const appliedConfig = (await readInstalledProjection(client, evidenceDir, 'bb10-rcc-config'))
      .configs.find(row => row.agentId === sessionAgentId)
    assert(appliedConfig !== undefined && appliedConfig.effectiveRevision === appliedConfig.acceptedRevision,
      `the RCC apply left the effective revision behind the accepted revision: ${JSON.stringify(appliedConfig)}`)
    assert(firstApply.agent.sessionEffectiveRevision === appliedConfig.acceptedRevision,
      `the running RCC runtime revision does not match the accepted revision: ${JSON.stringify([firstApply.agent, appliedConfig])}`)
    const session = await createAndOpenSession(client, 'BB10 real RCC model', evidenceDir, 'bb10')
    const rccTurn = await visibleAssistantTurn(client, sessionAgentId, session.sessionId,
      bb10VisibleTaskPrompt, evidenceDir, 'bb10-rcc', 'the real RCC provider turn')

    // (d) Explicitly select the canonical provider as primary and backup through
    // the Console config entry, then apply it through the installed restart.
    const beforeSelection = (await readInstalledProjection(client, undefined, 'bb10-selection-before'))
      .configs.find(row => row.agentId === sessionAgentId)
    const selectionRevision = beforeSelection.acceptedRevision
    const selectBackup = await client.command({ kind: 'config.agent.select-backup', agentId: sessionAgentId,
      expectedRevision: selectionRevision,
      backup: { providerInstanceId: canonicalProviderId, modelId: preconditions.canonical.defaultModel } })
    assert(selectBackup.body.ok === true, `the explicit backup selection failed: ${JSON.stringify(selectBackup.body)}`)
    const bindModel = await client.command({ kind: 'config.bindModel', agentId: sessionAgentId,
      expectedRevision: selectionRevision + 1, providerId: canonicalProviderId, modelId: preconditions.canonical.defaultModel })
    assert(bindModel.body.ok === true, `the explicit primary selection failed: ${JSON.stringify(bindModel.body)}`)
    const acceptedSelection = (await readInstalledProjection(client, evidenceDir, 'bb10-selection-accepted'))
      .configs.find(row => row.agentId === sessionAgentId)
    assert(acceptedSelection.acceptedRevision === selectionRevision + 2,
      `the accepted revision did not advance with the explicit selection: ${JSON.stringify(acceptedSelection)}`)

    const generationBefore = lifecycle.parsed.generation
    const switchStop = await stopSessionFixture(fixture, lifecycle, evidenceDir, 'bb10-switch')
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb10-switch', defaultAgentIds, { launchEnv })
    assert(lifecycle.parsed.generation > generationBefore,
      `the installed restart did not advance the launcher generation: ${generationBefore} -> ${lifecycle.parsed.generation}`)
    const switchedConsole = startInstalledSessionConsole(fixture, evidenceDir, 'bb10-switch')
    const switchedClient = sessionConsoleClient(switchedConsole.url, switchedConsole.authorization)
    const restartedRow = (await readInstalledProjection(switchedClient, evidenceDir, 'bb10-switch-restarted'))
      .configs.find(row => row.agentId === sessionAgentId)
    assert(restartedRow.acceptedRevision === selectionRevision + 2,
      `the accepted explicit selection did not survive the installed restart: ${JSON.stringify(restartedRow)}`)
    const switchedApply = await applySessionConfigAndWait(switchedClient, sessionAgentId, evidenceDir, 'bb10-switch')
    assert(switchedApply.agent.providerId === canonicalProviderId
      && switchedApply.agent.modelId === preconditions.canonical.defaultModel,
    `the explicit selection did not become the effective Session binding: ${JSON.stringify(switchedApply.agent)}`)

    // (e) One real canonical-provider Session turn through the same public entry.
    const switchedSession = await createAndOpenSession(switchedClient, 'BB10 real canonical model', evidenceDir, 'bb10-switch')
    const canonicalTurn = await visibleAssistantTurn(switchedClient, sessionAgentId, switchedSession.sessionId,
      bb10VisibleTaskPrompt, evidenceDir, 'bb10-canonical', 'the real canonical provider turn')
    const readback = await readInstalledProjection(switchedClient, evidenceDir, 'bb10-readback')
    const readbackConfig = readback.configs.find(row => row.agentId === sessionAgentId)
    const readbackAgent = readback.agents.find(row => row.agentId === sessionAgentId)
    assert(readbackConfig !== undefined && readbackConfig.effectiveRevision === readbackConfig.acceptedRevision
      && readbackConfig.applyState === 'clean',
    `the canonical binding did not settle clean at its accepted revision: ${JSON.stringify(readbackConfig)}`)
    assert(readbackAgent?.providerId === canonicalProviderId
      && readbackAgent?.modelId === preconditions.canonical.defaultModel,
    `the canonical binding did not survive the canonical Session: ${JSON.stringify(readbackAgent)}`)

    const final = await stopSessionFixture(fixture, lifecycle, evidenceDir, 'bb10')
    const allPids = lifecyclePids(lifecycle.internal)
    const consoleGone = consoleListenerGone(switchedConsole.url)
    assert(consoleGone, `the installed Console endpoint survived the launcher stop: ${switchedConsole.url}`)
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        config_sha256: config.configSha256,
        session_agent: sessionAgentId,
        passive_agent: passiveAgentId,
        commands: [
          'agentteams init',
          'agentteams start --config <isolated-home>/.agentteams/config.toml (credential env passed only to this child)',
          'agentteams console start --config <isolated-home>/.agentteams/config.toml',
          'POST /api/v1/command {"kind":"config.refreshModels","providerId":"rcc-4444"}',
          'POST /api/v1/command {"kind":"config.refreshModels","providerId":"goaichat-openai"}',
          'POST /api/v1/command {"kind":"config.apply","agentId":"bb-provider"}',
          'POST /api/v1/command {"kind":"session.create","agentId":"bb-provider"}',
          'POST /api/v1/session-message?agentId=bb-provider&sessionId=<S1> {"text":"<visible task>"} (real RCC provider)',
          'POST /api/v1/command {"kind":"config.agent.select-backup","backup":{"providerInstanceId":"goaichat-openai"}}',
          'POST /api/v1/command {"kind":"config.bindModel","providerId":"goaichat-openai"}',
          'agentteams stop --config <isolated-home>/.agentteams/config.toml --generation <G>',
          'agentteams start --config <isolated-home>/.agentteams/config.toml',
          'agentteams console start --config <isolated-home>/.agentteams/config.toml',
          'POST /api/v1/command {"kind":"config.apply","agentId":"bb-provider"} (canonical binding)',
          'POST /api/v1/session-message?agentId=bb-provider&sessionId=<S2> {"text":"<visible task>"} (real canonical provider)',
          'agentteams stop --generation <generation>',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        launcher: lifecycle.parsed,
        sources: {
          rcc: { source: rccConfigSourcePath, server_id: rccServerId, base_url: preconditions.rcc.baseUrl,
            selected_model: rccSelectedModelToken },
          canonical: { source: canonicalProviderSourcePath, provider_id: preconditions.canonical.id,
            base_url: preconditions.canonical.baseUrl, default_model: preconditions.canonical.defaultModel,
            auth_alias: preconditions.canonical.authAlias, secret_key: preconditions.canonical.secretKey,
            credential_env: canonicalCredentialEnv, credential_length: preconditions.credentialValue.length },
        },
        discovery: { session_agent: publicJson(sessionRow), passive_agent: publicJson(passiveRow),
          providers: providerIds, accepted_revision: configRow.acceptedRevision },
        catalogs: {
          rcc_refresh: publicJson(rccRefresh.body), canonical_refresh: publicJson(canonicalRefresh.body),
          rcc_catalog_state: rccCatalogRow.catalogState, rcc_model_count: rccCatalogRow.models.length,
          canonical_catalog_state: canonicalCatalogRow.catalogState,
          canonical_model_count: canonicalCatalogRow.models.length,
          accepted_revision_after_refresh: refreshedRow.acceptedRevision,
        },
        rcc_binding: { apply: firstApply, config: publicJson(appliedConfig), session: session.created, turn: rccTurn },
        explicit_selection: { accepted_revision_before: selectionRevision, select_backup: publicJson(selectBackup.body),
          bind_model: publicJson(bindModel.body), accepted_revision_after: acceptedSelection.acceptedRevision,
          accepted_row: publicJson(acceptedSelection) },
        switch_apply: { launcher_generation_before: generationBefore, launcher_generation_after: lifecycle.parsed.generation,
          accepted_after_restart: publicJson(restartedRow), effective_after_switch: publicJson(switchedApply.agent),
          session: switchedSession.created },
        canonical_binding: { turn: canonicalTurn, config: publicJson(readbackConfig), agent: publicJson(readbackAgent) },
        lifecycle_anomaly: {
          switch_stop_relay_exit: switchStop.relay_anomaly,
          switch_stop_stderr: switchStop.relay_anomaly ? switchStop.stop.stderr.trim() : '',
          final_stop_relay_exit: final.relay_anomaly,
          final_stop_stderr: final.relay_anomaly ? final.stop.stderr.trim() : '',
        },
        console_listener_gone_after_stop: consoleGone,
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture?.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

async function runBB12(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB12')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb12',
    { AGENTTEAMS_OPENCODE_EXECUTABLE: openCodeExecutablePath(evidenceDir) })
  const toolMarkerPath = join(fixture.temporaryRoot, 'bb12-tool-marker')
  // The managed child reports a fast command's captured stdout only when the
  // stream wins its exit race, so the probe writes its own result to a file too.
  const toolResultPath = join(fixture.temporaryRoot, 'bb12-tool-result')
  // The gated file name must not contain the permission marker: the stub sees the
  // tool result on the next provider call, so a shared substring would re-issue
  // the read call forever instead of ending the turn.
  const envProbePath = join(fixture.temporaryRoot, 'gated-read.env')
  writeFileSync(envProbePath, `${sessionEnvSentinel}\n`)
  const toolCommand = `printf bb12-tool-ran > '${toolMarkerPath}' && printf bb12-tool-output-ok > '${toolResultPath}'`
  const provider = createSessionProviderStub({
    models: [sessionPrimaryModel],
    toolMarker: sessionToolMarker,
    toolCallId: sessionToolCallId,
    toolCommand,
    permissionMarker: sessionPermissionMarker,
    permissionCallId: sessionPermissionCallId,
    envProbePath,
    holdMarker: sessionHoldMarker,
  })
  let lifecycle
  let result
  let captureFailure
  try {
    const providerUrl = await listenProviderStub(provider)
    const config = ensureUserConfig(fixture, evidenceDir, {
      buildConfigText: searchExecutable => sessionConfigFixtureText({ primary: providerUrl, backup: providerUrl, manual: providerUrl }, searchExecutable),
    })
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb12')
    const console = startInstalledSessionConsole(fixture, evidenceDir, 'bb12')
    const client = sessionConsoleClient(console.url, console.authorization)
    const sessionEvents = async () => readSessionEvents(await readInstalledProjection(client, undefined, 'events'), sessionAgentId, sessionId)

    const discovery = await readInstalledProjection(client, evidenceDir, 'bb12')
    const sessionRow = discovery.agents.find(agent => agent.agentId === sessionAgentId)
    const passiveRow = discovery.agents.find(agent => agent.agentId === passiveAgentId)
    assert(sessionRow?.sessionCapable === true, `the installed ${sessionAgentId} row is not Session capable: ${JSON.stringify(sessionRow)}`)
    assert(passiveRow?.sessionCapable === false && passiveRow.sessionAvailability === 'not-applicable',
      `the installed ${passiveAgentId} row is not a passive runtime row: ${JSON.stringify(passiveRow)}`)

    const applied = await applySessionConfigAndWait(client, sessionAgentId, evidenceDir, 'bb12')
    const session = await createAndOpenSession(client, 'BB12 installed Session entry', evidenceDir, 'bb12')
    const sessionId = session.sessionId
    captureFailure = async error => ({
      error: error instanceof Error ? error.message : String(error),
      session_events: publicJson(await sessionEvents()),
      provider_requests: provider.requests.map(text => { try { return JSON.parse(text) } catch { return text } }),
      held_responses: provider.held.length,
    })

    // (1) A Session message preserves its meaning: the exact text reaches the
    // real provider call and the managed child's own projection keeps it.
    const meaningPrompt = 'bb12 message meaning probe'
    const meaningFinals = (await sessionEvents()).filter(event => event.kind === 'final').length
    const meaningSent = await client.sessionMessage(sessionAgentId, sessionId, { text: meaningPrompt })
    assert(meaningSent.body.ok === true, `the meaning probe failed: ${JSON.stringify(meaningSent.body)}`)
    const meaningFinal = await waitForSessionTurn(sessionEvents, meaningFinals, 'the meaning probe turn to finish')
    const providerPrompt = await waitForAsync(async () => provider.requests.map(text => JSON.parse(text))
      .find(request => JSON.stringify(request.messages ?? '').includes(meaningPrompt)), 120_000,
    'the provider stub to receive the exact Session message')
    const userPart = await waitForAsync(async () => (await sessionEvents())
      .find(event => event.kind === 'part' && event.partType === 'text' && event.text === meaningPrompt), 60_000,
    'the projected user text part to preserve the exact message')
    const assistantPart = await waitForAsync(async () => (await sessionEvents())
      .find(event => event.kind === 'part' && event.partType === 'text' && event.text === sessionSentinel), 60_000,
    'the projected assistant text part')

    // (2) A real tool call preserves tool identity, complete arguments and the
    // matching result; a syntactically valid response is not that evidence.
    const toolFinals = (await sessionEvents()).filter(event => event.kind === 'final').length
    const toolSent = await client.sessionMessage(sessionAgentId, sessionId, { text: `bb12 tool request ${sessionToolMarker}` })
    assert(toolSent.body.ok === true, `the tool probe turn failed: ${JSON.stringify(toolSent.body)}`)
    await waitForSessionTurn(sessionEvents, toolFinals, 'the tool probe turn to finish')
    const toolEvent = await waitForAsync(async () => (await sessionEvents())
      .filter(event => event.kind === 'tool' && event.callId === sessionToolCallId)
      .find(event => event.state === 'completed'), 60_000, 'the completed tool event')
    assert(toolEvent.tool === 'bash', `the tool event did not preserve the tool name: ${JSON.stringify(toolEvent)}`)
    assert(toolEvent.input !== null && typeof toolEvent.input === 'object' && !Array.isArray(toolEvent.input)
      && Object.keys(toolEvent.input).length === 1 && toolEvent.input.command === toolCommand,
    `the tool event did not preserve the complete arguments: ${JSON.stringify(toolEvent.input)}`)
    assert(toolEvent.messageId !== undefined && toolEvent.partId !== undefined,
      `the tool event did not carry its message/part identity: ${JSON.stringify(toolEvent)}`)
    // The matching result is the effect the arguments declare, read from the
    // host filesystem, plus the exit status the substrate reported for it.
    const toolObservation = await waitForAsync(async () => {
      if (!existsSync(toolMarkerPath) || !existsSync(toolResultPath)) return undefined
      return { marker: readFileSync(toolMarkerPath, 'utf8'), result: readFileSync(toolResultPath, 'utf8') }
    }, 30_000, 'the real bash tool to produce its declared side effect')
    assert(toolObservation.marker === 'bb12-tool-ran' && toolObservation.result === 'bb12-tool-output-ok',
      `the tool side effect did not match the arguments: ${JSON.stringify(toolObservation)}`)
    assert(toolEvent.metadata?.exit === 0,
      `the tool result did not report the successful exit status of the matching call: ${JSON.stringify(toolEvent.metadata)}`)

    // (3) / (4) Approving a real permission request produces the expected side
    // effect; rejecting it does not. A `*.env` read is the one gated probe.
    const resolvedPermissions = new Set()
    const nextPermission = (timeoutMs = 60_000) => optionalWait(async () => (await sessionEvents())
      .find(event => event.kind === 'permission' && event.state === 'pending' && !resolvedPermissions.has(event.permissionId)), timeoutMs)
    const newestTool = async callId => (await sessionEvents())
      .filter(event => event.kind === 'tool' && event.callId === callId).at(-1)
    const replyPermission = async (pending, decision) => {
      const replied = await client.command({ kind: 'permission.reply', agentId: sessionAgentId, sessionId,
        permissionId: pending.permissionId, decision })
      assert(replied.body.ok === true, `the permission ${decision} reply failed: ${JSON.stringify(replied.body)}`)
      const resolved = await waitForAsync(async () => (await sessionEvents())
        .find(event => event.kind === 'permission' && event.state === 'resolved' && event.permissionId === pending.permissionId),
      60_000, 'the resolved permission event')
      resolvedPermissions.add(pending.permissionId)
      return resolved
    }
    // The substrate asks once per matching rule, so one tool call can surface more
    // than one request. A round ends only when every request it raised is answered.
    const answerRound = async decision => {
      const replies = []
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const pending = await nextPermission(attempt === 0 ? 60_000 : 15_000)
        if (pending === undefined) break
        replies.push({ pending: publicJson(pending), resolved: publicJson(await replyPermission(pending, decision)) })
      }
      return replies
    }
    const permission = { status: 'unverified', rounds: [],
      reason: 'the managed OpenCode child surfaced no pending permission for the gated read' }

    const approvedDispatch = client.sessionMessage(sessionAgentId, sessionId, { text: `bb12 permission probe ${sessionPermissionMarker}` }, 180_000)
      .then(response => ({ ok: true, response }), error => ({ ok: false, error }))
    const approvedReplies = await answerRound('once')
    if (approvedReplies.length === 0) {
      const settled = await approvedDispatch
      permission.dispatch = settled.ok ? publicJson(settled.response.body) : String(settled.error)
      assert(false, `the managed OpenCode child surfaced no pending permission for the gated read: ${JSON.stringify(permission)}`)
    }
    const approvedSettled = await approvedDispatch
    assert(approvedSettled.ok && approvedSettled.response.body.ok === true,
      `the approved turn did not complete: ${approvedSettled.error ?? JSON.stringify(approvedSettled.response?.body)}`)
    const readEvent = await waitForAsync(async () => {
      const event = await newestTool(sessionPermissionCallId)
      return event !== undefined && event.state === 'completed' ? event : undefined
    }, 60_000, 'the approved read tool event')
    assert(String(readEvent.output).includes(sessionEnvSentinel),
      `approving the read permission did not let the tool read the file: ${JSON.stringify(readEvent)}`)
    permission.rounds.push({ decision: 'once', replies: approvedReplies,
      tool_event: publicJson(readEvent), side_effect: 'env-content-read' })

    const priorPartIds = new Set((await sessionEvents()).filter(event => event.kind === 'tool').map(event => event.partId))
    const rejectedDispatch = client.sessionMessage(sessionAgentId, sessionId, { text: `bb12 permission probe ${sessionPermissionMarker}` }, 180_000)
      .then(response => ({ ok: true, response }), error => ({ ok: false, error }))
    const rejectedReplies = await answerRound('reject')
    assert(rejectedReplies.length > 0, 'the managed OpenCode child surfaced no second pending permission for the reject round')
    const rejectedOutcome = await rejectedDispatch
    const rejectedEvent = await optionalWait(async () => (await sessionEvents())
      .filter(event => event.kind === 'tool' && !priorPartIds.has(event.partId)).at(-1), 30_000)
    assert(rejectedEvent === undefined || rejectedEvent.state !== 'completed' || !String(rejectedEvent.output).includes(sessionEnvSentinel),
      `rejecting the read permission still returned the file content: ${JSON.stringify(rejectedEvent)}`)
    permission.rounds.push({ decision: 'reject', replies: rejectedReplies,
      dispatch: rejectedOutcome.ok ? publicJson(rejectedOutcome.response.body) : String(rejectedOutcome.error),
      tool_event: rejectedEvent === undefined ? null : publicJson(rejectedEvent), side_effect: 'env-content-absent' })
    permission.status = 'passed'
    delete permission.reason

    // (5) Cancel keeps the base acceptance plus a correlated confirmed-or-unknown
    // outcome, and never records the raw abort acceptance as the final cancel.
    const heldFinals = (await sessionEvents()).filter(event => event.kind === 'final').length
    const heldDispatch = client.sessionMessage(sessionAgentId, sessionId, { text: `bb12 held prompt ${sessionHoldMarker}` }, 120_000)
      .then(response => ({ ok: true, response }), error => ({ ok: false, error }))
    await waitForAsync(async () => provider.requests.some(body => body.includes(sessionHoldMarker)) ? true : undefined,
      60_000, 'the held prompt to reach the provider stub')
    const cancelled = await client.command({ kind: 'session.cancel', agentId: sessionAgentId, sessionId })
    assert(sessionCancelConfirmed(cancelled.body) || sessionCancelUnknown(cancelled.body),
      `session.cancel was neither a confirmed cancel nor a typed unknown: ${JSON.stringify(cancelled.body)}`)
    const cancelResult = cancelled.body
    const baseAccepted = sessionCancelConfirmed(cancelResult)
      ? cancelResult.result.baseAccepted
      : cancelResult.error.detail.baseAccepted
    assert(baseAccepted === true, `session.cancel did not preserve the base acceptance: ${JSON.stringify(cancelResult)}`)
    for (const response of provider.held.splice(0)) {
      try { response.destroy() } catch { /* the child is already gone */ }
    }
    const heldOutcome = await heldDispatch
    const cancelEvents = (await sessionEvents()).filter(event => event.kind === 'cancel')
    const terminalCancel = cancelEvents.at(-1)
    assert(terminalCancel !== undefined && (terminalCancel.state === 'reconciled' || terminalCancel.state === 'unknown'),
      `the terminal cancel record is not a correlated confirmed-or-unknown outcome: ${JSON.stringify(terminalCancel)}`)
    assert(terminalCancel.state !== 'accepted' && terminalCancel.state !== 'rejected',
      `the base abort acceptance was recorded as the final cancel: ${JSON.stringify(terminalCancel)}`)
    const settledFinal = await optionalWait(async () => {
      const finals = (await sessionEvents()).filter(event => event.kind === 'final')
      return finals.length > heldFinals ? finals.at(-1) : undefined
    }, 60_000)

    // (6) A passive Agent must refuse Session explicitly instead of degrading.
    const passiveCreate = await client.command({ kind: 'session.create', agentId: passiveAgentId })
    assert(passiveCreate.body.ok === false && passiveCreate.body.error?.code === 'UNSUPPORTED_OPERATION',
      `the passive Agent session.create was not a typed refusal: ${JSON.stringify(passiveCreate.body)}`)
    const passiveSend = await client.sessionMessage(passiveAgentId, sessionId, { text: 'bb12 passive probe' })
    assert(passiveSend.body.ok === false && passiveSend.body.error?.code === 'UNSUPPORTED_OPERATION',
      `the passive Agent session.send was not a typed refusal: ${JSON.stringify(passiveSend.body)}`)
    const passiveRefusal = { create: publicJson(passiveCreate.body), send: publicJson(passiveSend.body) }

    const final = await stopSessionFixture(fixture, lifecycle, evidenceDir, 'bb12')
    const allPids = lifecyclePids(lifecycle.internal)
    const consoleGone = consoleListenerGone(console.url)
    assert(consoleGone, `the installed Console endpoint survived the launcher stop: ${console.url}`)
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        config_sha256: config.configSha256,
        session_agent: sessionAgentId,
        passive_agent: passiveAgentId,
        commands: [
          'agentteams init',
          'agentteams start --config <isolated-home>/.agentteams/config.toml',
          'agentteams console start --config <isolated-home>/.agentteams/config.toml',
          'POST /api/v1/command {"kind":"config.apply","agentId":"bb-provider"}',
          'POST /api/v1/command {"kind":"session.create","agentId":"bb-provider"}',
          'POST /api/v1/session-message?agentId=bb-provider&sessionId=<S> {"text":"bb12 message meaning probe"}',
          'POST /api/v1/session-message?agentId=bb-provider&sessionId=<S> {"text":"bb12 tool request <marker>"}',
          'POST /api/v1/command {"kind":"permission.reply","decision":"once"}',
          'POST /api/v1/command {"kind":"permission.reply","decision":"reject"}',
          'POST /api/v1/command {"kind":"session.cancel","agentId":"bb-provider","sessionId":"<S>"}',
          'POST /api/v1/command {"kind":"session.create","agentId":"bb-receiver"} (typed refusal)',
          'POST /api/v1/session-message?agentId=bb-receiver&sessionId=<S> (typed refusal)',
          'agentteams stop --generation <generation>',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        launcher: lifecycle.parsed,
        console: { url: console.url, pid: console.pid, generation: console.generation },
        discovery: { session_agent: publicJson(sessionRow), passive_agent: publicJson(passiveRow) },
        config_apply: applied,
        session: session.created,
        message_meaning: { prompt: meaningPrompt, result: publicJson(meaningSent.body), final: publicJson(meaningFinal),
          provider_model: providerPrompt.model, user_part: publicJson(userPart), assistant_part: publicJson(assistantPart) },
        tool: { prompt: `bb12 tool request ${sessionToolMarker}`, result: publicJson(toolSent.body), command: toolCommand,
          side_effect: publicJson(toolObservation), exit: toolEvent.metadata?.exit ?? null, event: publicJson(toolEvent) },
        permission: publicJson(permission),
        cancel: { result: publicJson(cancelResult), terminal_event: publicJson(terminalCancel), settled_final: settledFinal === undefined ? null : publicJson(settledFinal), events: publicJson(cancelEvents),
          dispatch: heldOutcome.ok ? publicJson(heldOutcome.response.body) : String(heldOutcome.error) },
        passive_refusal: passiveRefusal,
        lifecycle_anomaly: { final_stop_relay_exit: final.relay_anomaly, final_stop_stderr: final.relay_anomaly ? final.stop.stderr.trim() : '' },
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } catch (error) {
    if (captureFailure !== undefined) {
      try {
        writeJson(join(evidenceDir, 'bb12-failure.json'), await captureFailure(error))
      } catch {
        // The case result records the primary failure.
      }
    }
    throw error
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    await closeProviderStub(provider)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

const workGraphEffects = ['agent.work.close', 'agent.work.get', 'agent.work.propose', 'agent.work.request', 'directory.read', 'network.close', 'network.connect']

function compileInstalledGraph(runnerPath, graphPath, capabilities, evidenceDir, name) {
  const args = ['compile', '--graph', graphPath]
  if (capabilities !== undefined) args.push('--capabilities', JSON.stringify(capabilities))
  const output = run(runnerPath, args, { logPath: join(evidenceDir, `${name}.json`) })
  assert(output.status === 0, `installed runner compile crashed: ${output.stderr.trim()}`)
  const lines = output.stdout.trim().split('\n').filter(Boolean)
  assert(lines.length > 0, `installed runner compile produced no output for ${name}`)
  return JSON.parse(lines[lines.length - 1])
}

function assertCompileFailure(frame, expectedMessage, name) {
  assert(frame.type === 'compile.failure' && frame.stage === 'compile',
    `${name} did not produce a typed compile failure: ${JSON.stringify(frame)}`)
  assert(typeof frame.message === 'string' && frame.message.includes(expectedMessage),
    `${name} compile failure did not describe the contract break: ${JSON.stringify(frame)}`)
}

async function runBB11(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB11')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb11')
  let lifecycle
  let result
  try {
    ensureUserConfig(fixture, evidenceDir)
    writeWorkFixture(fixture)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb11')
    const packageReceipt = readJson(defaultPackageReceiptPath)
    const sdk = packageReceipt.sdk
    assert(sdk?.included === true && Array.isArray(sdk.graphs) && sdk.graphs.length === 5,
      'the staged package receipt did not stage the five Work graphs')
    const runtimeRoot = join(fixture.installedRoot, 'runtime', 'dagpipe')
    const runnerPath = join(runtimeRoot, 'bin', 'darwin-arm64', 'agentteams-dagpipe-runner')
    const manifest = readJson(join(runtimeRoot, 'manifest.json'))
    assert(manifest.runner.sha256 === sdk.runner_sha256 && sha256File(runnerPath) === sdk.runner_sha256,
      'the installed runner hash does not match the staged SDK manifest')
    const installedGraphs = Object.fromEntries(manifest.graphs.map(graph => [graph.id, join(runtimeRoot, graph.path)]))
    for (const graph of sdk.graphs) {
      assert(installedGraphs[graph.id] !== undefined && sha256File(installedGraphs[graph.id]) === graph.sha256,
        `the installed graph ${graph.id} does not match the staged SDK graph`)
    }

    const submitted = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb11-submit',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', workReceiverId, '--payload', '{"query":"marker-alpha"}'],
      { expectStatus: 0 }))
    assert(submitted.control.graphId === 'agentteams.agent-work' && submitted.control.graphVersion === '2' &&
      submitted.evidence.graphId === 'agentteams.agent-work',
    `submit did not bind the agent-work graph: ${JSON.stringify(submitted.control)}`)
    assertMatchedSearch(submitted, './a.txt')
    const queried = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb11-query',
      ['work', 'query', '--config', fixture.configPath, '--receiver', workReceiverId,
        '--work-id', submitted.control.workId, '--request-id', submitted.control.requestId],
      { expectStatus: 0 }))
    assert(queried.control.graphId === 'agentteams.work-query' && queried.control.observed === true,
      `query did not bind the work-query graph: ${JSON.stringify(queried.control)}`)
    assert(JSON.stringify(queried.business) === JSON.stringify(submitted.business), 'query returned a different business result')
    assert(queried.evidence.hostOperations.includes('agentWork.get') && !queried.evidence.hostOperations.includes('agentWork.request'),
      `query re-executed business work: ${JSON.stringify(queried.evidence.hostOperations)}`)
    const ledgerBefore = providerLedger(fixture)
    assert(ledgerBefore.snapshot.works.length === 1, `the provider ledger recorded ${ledgerBefore.snapshot.works.length} Works after one submit`)

    const baseline = compileInstalledGraph(runnerPath, installedGraphs['agent-work'], workGraphEffects, evidenceDir, 'bb11-compile-baseline')
    assert(baseline.type === 'compile.result' && baseline.graph_id === 'agentteams.agent-work' && baseline.graph_version === '2',
      `the installed baseline compile did not resolve the agent-work graph: ${JSON.stringify(baseline)}`)
    assert(JSON.stringify(baseline.node_ids) === JSON.stringify(['resolve-service', 'open-link', 'admit-work', 'request-work', 'settle-work']),
      `the installed baseline compile resolved the wrong nodes: ${JSON.stringify(baseline.node_ids)}`)

    const compileDir = join(fixture.temporaryRoot, 'bb11-compile')
    mkdirSync(compileDir, { recursive: true })
    const graphSource = readJson(installedGraphs['agent-work'])
    const missingOperator = structuredClone(graphSource)
    missingOperator.nodes[0].operator = 'teams.missing-operator'
    writeJson(join(compileDir, 'missing-operator.graph.json'), missingOperator)
    const missingOperatorFrame = compileInstalledGraph(runnerPath, join(compileDir, 'missing-operator.graph.json'), workGraphEffects, evidenceDir, 'bb11-compile-missing-operator')
    assertCompileFailure(missingOperatorFrame, 'missing operator', 'an unregistered operator')
    const arcError = structuredClone(graphSource)
    arcError.edges[1].arc_id = 'bb11.not.a.declared.arc'
    writeJson(join(compileDir, 'arc-error.graph.json'), arcError)
    const arcErrorFrame = compileInstalledGraph(runnerPath, join(compileDir, 'arc-error.graph.json'), workGraphEffects, evidenceDir, 'bb11-compile-arc-error')
    assertCompileFailure(arcErrorFrame, 'is not output of', 'an ARC contract error')
    const missingEffectsFrame = compileInstalledGraph(runnerPath, installedGraphs['agent-work'], [], evidenceDir, 'bb11-compile-missing-effects')
    assertCompileFailure(missingEffectsFrame, 'undeclared capability', 'a missing effects set')
    const ledgerAfterCompile = providerLedger(fixture)
    assert(ledgerAfterCompile.snapshot.works.length === ledgerBefore.snapshot.works.length,
      'a compile negative produced a business side effect')

    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb11')
    const allPids = lifecyclePids(lifecycle.internal)
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        receiver: workReceiverId,
        commands: [
          'agentteams work submit --receiver bb-receiver --payload {"query":"marker-alpha"}',
          'agentteams work query --receiver bb-receiver --work-id <W> --request-id <R>',
          'installed runner compile --graph runtime/dagpipe/graphs/agent-work.graph.json --capabilities [...]',
          'installed runner compile --graph <isolated candidate> (missing operator / ARC error / missing effects)',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        runtime: {
          runner_path: runnerPath,
          runner_sha256: sdk.runner_sha256,
          manifest_path: join(runtimeRoot, 'manifest.json'),
          graph_sha256: Object.fromEntries(sdk.graphs.map(graph => [graph.id, graph.sha256])),
        },
        submit: submitted,
        query: queried,
        compile: {
          baseline,
          missing_operator: missingOperatorFrame,
          arc_error: arcErrorFrame,
          missing_effects: missingEffectsFrame,
        },
        provider_ledger_works_after_compile: ledgerAfterCompile.snapshot.works.length,
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

function shimPnpm(realPnpm, proofDir) {
  const shimDir = join(proofDir, 'shim')
  mkdirSync(shimDir, { recursive: true })
  const shimPath = join(shimDir, 'pnpm')
  writeFileSync(shimPath, `#!/bin/sh
set -eu
PROOF_ROOT="${'$'}{AGENTTEAMS_GATE_PROOF_ROOT:?explicit owned proof directory required}"
printf '%s args=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$PROOF_ROOT/pnpm-invocations.log"
if [ "$1" = "smoke:installed" ] && [ ! -e "$PROOF_ROOT/smoke-failure-used" ]; then
  : > "$PROOF_ROOT/smoke-failure-used"
  printf 'INJECTED_FAILURE: one-shot smoke:installed exit 86\\n' >&2
  exit 86
fi
exec ${JSON.stringify(realPnpm)} "$@"
`, { mode: 0o755 })
  return { shimDir, shimPath }
}

function pnpmInvocationCounts(proofDir) {
  const path = join(proofDir, 'pnpm-invocations.log')
  if (!existsSync(path)) return { verify: 0, smokeInstalled: 0 }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  return {
    verify: lines.filter(line => line.endsWith(' args=verify')).length,
    smokeInstalled: lines.filter(line => line.endsWith(' args=smoke:installed')).length,
  }
}

function readLifecycleState(fixtureRoot) {
  const path = join(fixtureRoot, '.appsdk-control', 'lifecycle-adapter', 'stages', 'teams-lifecycle-admission.json')
  assert(existsSync(path), `lifecycle store is missing: ${path}`)
  return { path, state: readJson(path) }
}

function runLifecycleAdapter(fixtureRoot, env, logPath) {
  return run(process.execPath, ['scripts/lifecycle-adapter.mjs'], {
    cwd: fixtureRoot,
    env,
    logPath,
  })
}

/**
 * Interrupted-recovery simulation: drop the committed pre-review validation
 * record while retaining the stage state and stage receipts. The next admission
 * must re-enter the stage loop and reuse the valid stages instead of re-running
 * `pnpm verify` or `pnpm smoke:installed`.
 */
function removeValidationRecords(fixtureRoot) {
  const recordsRoot = join(fixtureRoot, '.appsdk', 'records')
  if (!existsSync(recordsRoot)) return []
  const removed = []
  for (const name of readdirSync(recordsRoot)) {
    if (!name.startsWith('pre-review-validation-record-')) continue
    rmSync(join(recordsRoot, name))
    removed.push(name)
  }
  return removed
}

function commitFixtureChange(fixtureRoot, message) {
  runChecked('git', ['add', '.'], { cwd: fixtureRoot })
  runChecked('git', ['-c', 'user.name=u7-bb13-fixture', '-c', 'user.email=u7-bb13-fixture@example.invalid', 'commit', '--quiet', '-m', message], { cwd: fixtureRoot })
}

function latestSmokeReceipt(state) {
  const receiptPath = state.stages['pnpm-smoke-installed']?.receiptPath
  assert(receiptPath !== undefined && existsSync(receiptPath), 'smoke stage receipt is missing')
  return { path: receiptPath, receipt: readJson(receiptPath) }
}

async function runBB13(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB13')
  mkdirSync(evidenceDir, { recursive: true })
  const worktreeStatus = runChecked('git', ['status', '--porcelain'], { cwd: root, logPath: join(evidenceDir, 'worktree-status.json') })
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentteams-u7-bb13-'))
  const proofDir = join(fixtureRoot, '..', `agentteams-u7-bb13-proof-${process.pid}-${Date.now()}`)
  mkdirSync(proofDir, { recursive: true })
  const realPnpm = runChecked('which', ['pnpm'], { logPath: join(evidenceDir, 'which-pnpm.json') }).stdout.trim()
  assert(realPnpm.startsWith('/'), `pnpm executable is not absolute: ${realPnpm}`)
  const { shimDir } = shimPnpm(realPnpm, proofDir)
  const shimEnv = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    AGENTTEAMS_GATE_PROOF_ROOT: proofDir,
  }
  const observations = []
  let result
  try {
    runChecked('git', ['clone', '--quiet', '--no-local', root, fixtureRoot], { cwd: root, logPath: join(evidenceDir, 'git-clone.json') })
    runChecked('git', ['checkout', '--quiet', '--detach', context.candidate.head_commit], { cwd: fixtureRoot, logPath: join(evidenceDir, 'git-checkout.json') })
    for (const packageDir of ['', 'opencode-adapter', 'console-host', 'ui/teams-console']) {
      const source = join(root, packageDir, 'node_modules')
      if (existsSync(source)) symlinkSync(source, join(fixtureRoot, packageDir, 'node_modules'), 'dir')
    }
    // The repository ignores node_modules as a directory, so a node_modules symlink
    // is still untracked. The lifecycle adapter requires a fully clean candidate, so
    // exclude the fixture's own dependency links without touching tracked files.
    const excludePath = join(fixtureRoot, '.git', 'info', 'exclude')
    writeFileSync(excludePath, `${readFileSync(excludePath, 'utf8')}node_modules\n`, { encoding: 'utf8' })

    const failure = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'failure.json'))
    assert(failure.status !== 0, 'BB13 injected smoke failure unexpectedly succeeded')
    let store = readLifecycleState(fixtureRoot)
    assert(store.state.stages['pnpm-verify']?.status === 'passed', 'verify stage did not persist before smoke failure')
    assert(store.state.stages['pnpm-smoke-installed']?.status === 'blocked', 'smoke stage did not record the deterministic failure')
    observations.push({ phase: 'failure', state: store.state, counts: pnpmInvocationCounts(proofDir) })

    const recovery = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'recovery.json'))
    assert(recovery.status === 0, 'BB13 recovery did not pass')
    store = readLifecycleState(fixtureRoot)
    assert(store.state.stages['pnpm-verify']?.status === 'reused', 'verify stage was not reused after recovery')
    assert(store.state.stages['pnpm-smoke-installed']?.status === 'passed', 'smoke stage did not recover to passed')
    const countsAfterRecovery = pnpmInvocationCounts(proofDir)
    observations.push({ phase: 'recovery', state: store.state, counts: countsAfterRecovery })

    // Unchanged-input re-entry with the completed validation record intact must
    // be idempotent: the adapter returns the existing validation without touching
    // the stages or re-executing a command.
    const idempotent = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'idempotent-entry.json'))
    assert(idempotent.status === 0, 'BB13 idempotent re-entry did not pass')
    assert(/"idempotent":true/u.test(idempotent.stdout),
      `BB13 idempotent re-entry did not return the completed validation: ${idempotent.stdout.trim()}`)
    const countsAfterIdempotent = pnpmInvocationCounts(proofDir)
    store = readLifecycleState(fixtureRoot)
    assert(store.state.stages['pnpm-verify']?.status === 'reused' && store.state.stages['pnpm-smoke-installed']?.status === 'passed',
      'BB13 idempotent re-entry mutated the completed stages')
    assert(countsAfterIdempotent.verify === countsAfterRecovery.verify && countsAfterIdempotent.smokeInstalled === countsAfterRecovery.smokeInstalled,
      'BB13 idempotent re-entry re-executed a completed stage')
    observations.push({ phase: 'idempotent-entry', state: store.state, counts: countsAfterIdempotent })

    // Interrupted-recovery re-entry: the validation record is gone while stage
    // state and receipts survive, so the adapter re-enters the stage loop and
    // reuses both unchanged stages instead of re-executing them.
    const removedValidationRecords = removeValidationRecords(fixtureRoot)
    assert(removedValidationRecords.length > 0, 'BB13 interrupted-recovery step found no validation record to remove')
    const reentry = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'reentry.json'))
    assert(reentry.status === 0, 'BB13 re-entry did not pass')
    const countsAfterReentry = pnpmInvocationCounts(proofDir)
    store = readLifecycleState(fixtureRoot)
    assert(store.state.stages['pnpm-verify']?.status === 'reused' && store.state.stages['pnpm-smoke-installed']?.status === 'reused',
      'BB13 re-entry did not reuse both completed stages')
    assert(countsAfterReentry.verify === countsAfterRecovery.verify && countsAfterReentry.smokeInstalled === countsAfterRecovery.smokeInstalled,
      'BB13 re-entry re-executed a completed stage')
    observations.push({ phase: 'reentry', state: store.state, counts: countsAfterReentry })

    const sourcePath = join(fixtureRoot, 'network', 'relay-client.ts')
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// BB13 source invalidation fixture\n`)
    commitFixtureChange(fixtureRoot, 'bb13 source change')
    const sourceRun = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'source-change.json'))
    assert(sourceRun.status === 0, 'BB13 source change did not recover')
    store = readLifecycleState(fixtureRoot)
    assert(store.state.invalidationHistory.some(entry => entry.stage_id === 'pnpm-verify' && entry.reason === 'fingerprint_changed'),
      'BB13 source change did not invalidate the verify stage')
    assert(store.state.invalidationHistory.some(entry => entry.stage_id === 'pnpm-smoke-installed' && entry.reason === 'fingerprint_changed'),
      'BB13 source change did not invalidate the dependent smoke stage')
    observations.push({ phase: 'source-change', state: store.state, counts: pnpmInvocationCounts(proofDir) })

    const graphPath = join(fixtureRoot, 'docs', 'architecture', 'verification-map.json')
    const graph = readJson(graphPath)
    graph.bb13_graph_registry_probe = 'changed for the BB13 invalidation matrix'
    writeJson(graphPath, graph)
    commitFixtureChange(fixtureRoot, 'bb13 graph registry change')
    const graphRun = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'graph-registry-change.json'))
    assert(graphRun.status === 0, 'BB13 graph/registry change did not recover')
    store = readLifecycleState(fixtureRoot)
    assert(store.state.invalidationHistory.some(entry => entry.stage_id === 'pnpm-verify' && entry.reason === 'fingerprint_changed'),
      'BB13 graph/registry change did not invalidate the verify stage')
    observations.push({ phase: 'graph-registry-change', state: store.state, counts: pnpmInvocationCounts(proofDir) })

    const configPath = join(fixtureRoot, 'pnpm-workspace.yaml')
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n# BB13 config invalidation fixture\n`)
    commitFixtureChange(fixtureRoot, 'bb13 config change')
    const configRun = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'config-change.json'))
    assert(configRun.status === 0, 'BB13 config change did not recover')
    store = readLifecycleState(fixtureRoot)
    assert(store.state.invalidationHistory.some(entry => entry.stage_id === 'pnpm-verify' && entry.reason === 'fingerprint_changed'),
      'BB13 config change did not invalidate the verify stage')
    observations.push({ phase: 'config-change', state: store.state, counts: pnpmInvocationCounts(proofDir) })

    const artifactPath = join(fixtureRoot, 'generated', 'modules', 'teams-source', 'module.compiled.json')
    writeFileSync(artifactPath, `${readFileSync(artifactPath, 'utf8')}\n`)
    const artifactRun = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'artifact-change.json'))
    assert(artifactRun.status === 0, 'BB13 artifact change did not recover')
    store = readLifecycleState(fixtureRoot)
    assert(store.state.invalidationHistory.some(entry => entry.stage_id === 'pnpm-verify' && entry.reason === 'receipt_or_required_input_invalid'),
      'BB13 artifact change did not invalidate the verify stage')
    observations.push({ phase: 'artifact-change', state: store.state, counts: pnpmInvocationCounts(proofDir) })

    const smoke = latestSmokeReceipt(store.state)
    const evidenceId = smoke.receipt.evidence_ids[0]
    const evidencePath = join(fixtureRoot, '.appsdk', 'records', 'evidence', 'teams-source', `${evidenceId}.json`)
    assert(existsSync(evidencePath), `BB13 evidence file is missing: ${evidencePath}`)
    rmSync(evidencePath)
    const beforeMissingCounts = pnpmInvocationCounts(proofDir)
    const missingRun = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'evidence-delete.json'))
    assert(missingRun.status === 0, 'BB13 evidence deletion did not recover')
    store = readLifecycleState(fixtureRoot)
    const afterMissingCounts = pnpmInvocationCounts(proofDir)
    assert(afterMissingCounts.verify === beforeMissingCounts.verify, 'BB13 evidence deletion re-executed the independent verify stage')
    assert(afterMissingCounts.smokeInstalled === beforeMissingCounts.smokeInstalled + 1, 'BB13 evidence deletion did not re-execute the dependent smoke stage')
    // A stage re-execution mints a new attempt-scoped receipt and evidence ids, so
    // the deleted file is superseded rather than rewritten at the same path. The
    // honest observable is a fresh receipt whose referenced evidence records all exist.
    const regeneratedSmoke = latestSmokeReceipt(store.state)
    assert(regeneratedSmoke.receipt.receipt_id !== smoke.receipt.receipt_id,
      'BB13 evidence deletion reused the stale smoke receipt instead of re-executing')
    const evidenceRoot = join(fixtureRoot, '.appsdk', 'records', 'evidence', 'teams-source')
    assert(regeneratedSmoke.receipt.evidence_ids.length > 0 &&
      regeneratedSmoke.receipt.evidence_ids.every(id => existsSync(join(evidenceRoot, `${id}.json`))),
      'BB13 deleted required evidence was not regenerated as fresh present records')
    observations.push({ phase: 'evidence-delete', state: store.state, counts: afterMissingCounts })

    result = {
      status: 'passed',
      public_input: {
        lifecycle_adapter: 'node scripts/lifecycle-adapter.mjs',
        store: '.appsdk-control/lifecycle-adapter/stages/teams-lifecycle-admission.json',
        fault: 'one-shot smoke:installed exit 86',
        mutations: ['source', 'graph/registry', 'config', 'artifact', 'required evidence file deletion'],
      },
      external_observation: {
        fixture_root: fixtureRoot,
        outer_worktree_status: worktreeStatus.stdout,
        fixture_candidate: currentCandidateIdentity(fixtureRoot),
        store_path: store.path,
        phases: observations.map(observation => ({
          phase: observation.phase,
          counts: observation.counts,
          stages: Object.fromEntries(Object.entries(observation.state.stages).map(([id, stage]) => [id, {
            status: stage.status,
            receiptId: stage.receiptId,
            reuseReceiptId: stage.reuseReceiptId,
            evidenceIds: stage.evidenceIds,
          }])),
          reuseReceipts: observation.state.reuseReceipts.length,
          invalidationHistory: observation.state.invalidationHistory.slice(-4),
        })),
        final_counts: pnpmInvocationCounts(proofDir),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    rmSync(proofDir, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
  return result
}

function startSentinel() {
  return new Promise((resolveSentinel, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
import net from 'node:net'
const server = net.createServer()
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ pid: process.pid, port: server.address().port }))
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => reject(new Error('sentinel listener did not start')), 5_000)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      const line = output.split('\n').find(Boolean)
      if (line === undefined) return
      clearTimeout(timer)
      resolveSentinel({ child, ...JSON.parse(line) })
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function stopSentinel(sentinel) {
  if (!sentinel) return
  sentinel.child.kill('SIGTERM')
}

async function runBB14(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB14')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb14')
  let lifecycle
  let sentinel
  let result
  try {
    ensureUserConfig(fixture, evidenceDir)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb14')
    sentinel = await startSentinel()
    const duplicate = run(fixture.cli, ['start', '--config', fixture.configPath], {
      cwd: fixture.temporaryRoot,
      env: fixture.env,
      expectNonZero: true,
      logPath: join(evidenceDir, 'bb14-duplicate-start.json'),
    })
    assert(/already running|ALREADY_RUNNING/iu.test(`${duplicate.stdout}\n${duplicate.stderr}`),
      `duplicate start did not report an explicit running error: ${duplicate.stdout}${duplicate.stderr}`)
    const statusBeforeStop = runChecked(fixture.cli, ['status', '--config', fixture.configPath], {
      cwd: fixture.temporaryRoot,
      env: fixture.env,
      logPath: join(evidenceDir, 'bb14-status-before-stop.json'),
    })
    const parsedBeforeStop = parseCliStatus(statusBeforeStop.stdout)
    assert(parsedBeforeStop.state === 'running' && parsedBeforeStop.generation === lifecycle.parsed.generation &&
      parsedBeforeStop.pid === lifecycle.parsed.pid, 'duplicate start changed the owned generation or launcher')
    const final = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb14')
    assert(processAlive(sentinel.pid), 'unrelated sentinel process was stopped by lifecycle cleanup')
    assert(listeningPids(sentinel.port).includes(sentinel.pid), 'unrelated sentinel listener was stopped by lifecycle cleanup')
    const listenerState = Object.fromEntries(Object.entries(lifecycle.internal.ports).map(([id, port]) => [id, listeningPids(port)]))
    fixture.cleanup()
    const dirty = runChecked('git', ['status', '--porcelain'], { cwd: root, logPath: join(evidenceDir, 'worktree-status.json') }).stdout.trim()
    const retained = []
    const lifecycleStatePath = join(root, '.appsdk-control', 'lifecycle-adapter', 'stages', 'teams-lifecycle-admission.json')
    if (existsSync(lifecycleStatePath)) {
      retained.push({
        owner: 'development-governance',
        path: lifecycleStatePath,
        release_action: 'Retain until lifecycle admission close or remove with the owning task cleanup.',
      })
    }
    if (dirty !== '') {
      for (const line of dirty.split('\n')) {
        retained.push({
          owner: 'current worktree',
          path: line.slice(3),
          release_action: 'Commit the intended change or remove the generated file before delivery.',
        })
      }
    }
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        commands: ['agentteams init', 'agentteams start', 'agentteams start (duplicate failure)', 'agentteams status', 'agentteams stop --generation <generation>'],
      },
      external_observation: {
        first_generation: lifecycle.parsed.generation,
        duplicate_start_stdout: duplicate.stdout,
        duplicate_start_stderr: duplicate.stderr,
        status_before_stop: parsedBeforeStop,
        stop_stdout: final.stop.stdout,
        stopped_stdout: final.status.stdout,
        owned_pids: lifecyclePids(lifecycle.internal),
        owned_ports: lifecycle.internal.ports,
        owned_listeners_after_stop: listenerState,
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
        evidence_dir: evidenceDir,
        sentinel: { pid: sentinel.pid, port: sentinel.port, alive_after_stop: processAlive(sentinel.pid) },
        retained,
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopSentinel(sentinel)
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// BB03 / BB05 / BB06: the installed browser Work lifecycle, the installed Work
// rejection matrix and the persistent browser capacity contract. Every case
// installs the staged package outside the source tree and drives the public
// `agentteams work` entry plus the public `agentteams status` projection. The
// real browser side effect is observed from the running Camoufox process for
// the profile the provider returned, never from a mock ledger.
// ---------------------------------------------------------------------------

const browserOperations = Object.freeze(['context.create', 'navigate', 'snapshot', 'context.destroy'])
const browserCapabilityId = 'browser'
const browserContextDemands = '[{"resourceId":"browser-context","amount":1},{"resourceId":"browser-slot","amount":1}]'
const browserSearchDemands = '[{"resourceId":"search-slot","amount":1}]'
const browserPageMarker = 'bb-camo-needle'
const browserCaseReceiver = 'bb-receiver'
const browserReceiverOne = 'bb-receiver-1'
const browserReceiverTwo = 'bb-receiver-2'
const browserIntruder = 'bb-intruder'
const missingCamoExecutable = '/missing/camo'

/** Resolve a real executable from PATH instead of writing a machine path. */
function resolveExecutable(name, evidenceDir) {
  const resolved = runChecked('which', [name], { logPath: join(evidenceDir, `which-${name}.json`) }).stdout.trim()
  assert(resolved.startsWith('/'), `${name} executable is not absolute: ${resolved}`)
  return resolved
}

function resolveCamo(evidenceDir) {
  const executable = resolveExecutable('camo', evidenceDir)
  const version = runChecked(executable, ['--version'], { logPath: join(evidenceDir, 'camo-version.json') }).stdout.trim()
  assert(version.length > 0, 'camo --version produced no version')
  return { executable, version }
}

/**
 * Camoufox resolves its admitted browser runtime from
 * `$HOME/Library/Caches/camoufox`. The installed fixture owns an isolated HOME,
 * so the driver links the machine's already admitted runtime into that HOME.
 * This is fixture provisioning: it writes no product file and no source path.
 */
function provisionBrowserRuntime(fixture, evidenceDir) {
  const source = join(homedir(), 'Library', 'Caches', 'camoufox')
  assert(existsSync(join(source, 'version.json')), `the machine Camoufox runtime is missing: ${source}`)
  const target = join(fixture.home, 'Library', 'Caches', 'camoufox')
  mkdirSync(dirname(target), { recursive: true })
  if (!existsSync(target)) symlinkSync(source, target)
  assert(realpathSync(target) === realpathSync(source), `the fixture Camoufox runtime does not resolve to the machine runtime: ${target}`)
  const record = { source, target, resolved: realpathSync(target) }
  writeJson(join(evidenceDir, 'camoufox-runtime.json'), record)
  return record
}

function agentAuthEnv(agentIds) {
  return Object.fromEntries(agentIds.map(id => [`AGENTTEAMS_${id.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}_AUTH`, `${id}-auth`]))
}

/**
 * Compose the user `config.toml` for the browser cases. The receiver set, the
 * declared services and the provider admission policy are explicit inputs so
 * each case states the exact public intent it drives.
 */
function browserCaseConfigText(searchExecutable, spec) {
  const lines = [
    'version = 3', '', '[bridge]', 'enabled = true', '',
    '[agents.bb-provider]', 'enabled = true', 'role = "provider"', 'label = "BB-Provider"', '',
    '[agents.bb-provider.identity]', 'hostId = "bb-local"', 'machineId = "bb-machine"', 'accountId = "bb-account"',
    'agentKind = "custom"', 'label = "BB-Provider"', '',
    '[agents.bb-provider.runtime]', 'scopeId = "bb-scope"', 'dataDirectory = "data/bb-provider"',
    `policy = { revision = 1, allowedConsumers = ${JSON.stringify(spec.allowedConsumers)}, allowedManagers = [] }`,
    `cli = { camoExecutable = ${JSON.stringify(spec.camoExecutable)}, searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-bb-provider" }`, '',
  ]
  if (spec.fileSearch !== false) {
    lines.push('[agents.bb-provider.services.file-search]', 'version = "1"', 'operations = ["search"]',
      'resources = [{ resourceId = "search-slot", capacity = 2, unit = "slot" }]', '')
  }
  if (spec.browser !== null && spec.browser !== undefined) {
    lines.push('[agents.bb-provider.services.browser]', 'version = "1"',
      `operations = ${JSON.stringify(browserOperations)}`, 'resources = [',
      `  { resourceId = "browser-context", capacity = ${spec.browser.context}, unit = "context" },`,
      `  { resourceId = "browser-slot", capacity = ${spec.browser.slot}, unit = "slot" },`, ']', '')
  }
  for (const receiver of spec.receivers) {
    const label = receiver.label ?? receiver.id
    lines.push(`[agents.${receiver.id}]`, 'enabled = true', 'role = "receiver"', `label = ${JSON.stringify(label)}`, '',
      `[agents.${receiver.id}.identity]`, 'hostId = "bb-local"', 'machineId = "bb-machine"', 'accountId = "bb-account"',
      'agentKind = "custom"', `label = ${JSON.stringify(label)}`, '',
      `[agents.${receiver.id}.runtime]`, 'scopeId = "bb-scope"', `dataDirectory = "data/${receiver.id}"`,
      'policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }',
      `cli = { camoExecutable = ${JSON.stringify(missingCamoExecutable)}, searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-${receiver.id}" }`, '')
    const connect = receiver.capability === 'browser'
      ? { capabilityId: browserCapabilityId, operation: 'context.create',
        demands: '[{ resourceId = "browser-context", amount = 1 }, { resourceId = "browser-slot", amount = 1 }]' }
      : { capabilityId: 'file-search', operation: 'search', demands: '[{ resourceId = "search-slot", amount = 1 }]' }
    lines.push(`[agents.${receiver.id}.connect]`, 'targetAgentId = "bb-provider"',
      `capabilityId = ${JSON.stringify(connect.capabilityId)}`, 'capabilityVersion = "1"',
      `operation = ${JSON.stringify(connect.operation)}`, `demands = ${connect.demands}`, '')
  }
  return `${lines.join('\n')}\n`
}

function initializeInstalledConfig(fixture, evidenceDir, name) {
  runChecked(fixture.cli, ['init'], { cwd: fixture.temporaryRoot, env: fixture.env, logPath: join(evidenceDir, `${name}-init.json`) })
}

function writeCaseConfig(fixture, evidenceDir, name, text) {
  writeFileSync(fixture.configPath, text, { encoding: 'utf8', mode: 0o600 })
  const record = { sha256: sha256(text), text }
  writeJson(join(evidenceDir, `${name}-config.json`), record)
  return record
}

/** The public `work` entry reports a completed receipt on stdout and a failed receipt on stderr. */
function workReceipt(output) {
  const stdout = output.stdout.trim()
  const stderr = output.stderr.trim()
  const text = stdout.length > 0 ? stdout : stderr
  assert(text.length > 0, `work command produced no receipt (exit ${output.status})`)
  let receipt
  try {
    receipt = JSON.parse(text)
  } catch {
    fail(`work command produced a non-JSON result: ${text}`)
  }
  assert(receipt?.status === 'completed' || receipt?.status === 'failed',
    `work command produced an unknown receipt status: ${text}`)
  return receipt
}

function runWorkReceipt(fixture, evidenceDir, name, args) {
  const output = runWork(fixture, evidenceDir, name, args)
  return { output, receipt: workReceipt(output) }
}

function browserBinding(providerGeneration, capabilityId, operation) {
  return ['--provider', workProviderId, '--provider-generation', String(providerGeneration),
    '--capability-id', capabilityId, '--capability-version', '1', '--operation', operation]
}

function openBrowserContext(fixture, evidenceDir, name, receiver, generation, url) {
  return runWorkReceipt(fixture, evidenceDir, name, ['work', 'open', '--config', fixture.configPath,
    '--receiver', receiver, ...browserBinding(generation, browserCapabilityId, 'context.create'),
    '--demands', browserContextDemands, '--payload', JSON.stringify({ initialUrl: url })])
}

function queryBrowserRequest(fixture, evidenceDir, name, receiver, receipt) {
  const control = receipt.control
  return runWorkReceipt(fixture, evidenceDir, name, ['work', 'query', '--config', fixture.configPath,
    '--receiver', receiver, '--service-selection', 'capability', '--work-id', control.workId,
    '--request-id', control.requestId, ...browserBinding(control.targetGeneration, control.capabilityId, control.operation)])
}

function closeBrowserWork(fixture, evidenceDir, name, receiver, receipt) {
  const control = receipt.control
  return runWorkReceipt(fixture, evidenceDir, name, ['work', 'close', '--config', fixture.configPath,
    '--receiver', receiver, '--work-id', control.workId, ...browserBinding(control.targetGeneration, control.capabilityId, control.operation)])
}

/**
 * Read the recorded browser request back through the public get-only query. A
 * running request is polled; the observation must never re-execute the Work.
 */
async function observeBrowserContext(fixture, evidenceDir, name, receiver, receipt, timeoutMs = 120_000) {
  const observed = await waitForAsync(async () => {
    const query = queryBrowserRequest(fixture, evidenceDir, name, receiver, receipt)
    if (query.receipt.status !== 'completed') return undefined
    if (query.receipt.control.requestState === 'running') return undefined
    return query.receipt
  }, timeoutMs, `${name} to observe a terminal browser request`)
  assert(observed.control.observed === true, `${name} did not observe the original request: ${JSON.stringify(observed.control)}`)
  assert(observed.control.requestState === 'succeeded',
    `${name} did not complete the real browser request: ${JSON.stringify(observed.control)}`)
  assert(typeof observed.business?.contextId === 'string' && observed.business.contextId.startsWith('browser-context-'),
    `${name} did not return a real browser context id: ${JSON.stringify(observed.business)}`)
  assert(typeof observed.business?.profile === 'string' && observed.business.profile.startsWith('teams-'),
    `${name} did not return a real browser profile: ${JSON.stringify(observed.business)}`)
  assert(observed.evidence.hostOperations.includes('agentWork.get') && !observed.evidence.hostOperations.includes('agentWork.request'),
    `${name} re-executed instead of reading the recorded request: ${JSON.stringify(observed.evidence.hostOperations)}`)
  return observed
}

/** The real Camoufox browser processes owned by this fixture's isolated HOME. */
function browserProfilesUnder(fixture) {
  const result = spawnSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const roots = [join(fixture.home, '.camo', 'profiles'), join('/private', fixture.home, '.camo', 'profiles')]
  const profiles = new Map()
  for (const line of result.stdout.split('\n')) {
    if (!line.includes('/MacOS/camoufox -no-remote')) continue
    const match = /-profile\s+(\S+)/u.exec(line)
    if (match === null) continue
    const root = roots.find(candidate => match[1].startsWith(`${candidate}/`))
    if (root === undefined) continue
    const pid = Number(/^\s*(\d+)/u.exec(line)?.[1])
    if (!Number.isSafeInteger(pid)) continue
    const profile = match[1].slice(root.length + 1)
    profiles.set(profile, [...(profiles.get(profile) ?? []), pid])
  }
  return profiles
}

/** Every process whose command line still names this fixture's isolated HOME. */
function fixtureProcesses(fixture) {
  const result = spawnSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const needles = [fixture.home, join('/private', fixture.home)]
  return result.stdout.split('\n')
    .filter(line => needles.some(needle => line.includes(needle)))
    .map(line => ({ pid: Number(/^\s*(\d+)/u.exec(line)?.[1]), command: line.replace(/^\s*\d+\s+/u, '') }))
    .filter(entry => Number.isSafeInteger(entry.pid))
}

function cleanupBrowserProfiles(fixture, camoExecutable, profiles, evidenceDir) {
  for (const profile of profiles) {
    const name = profile.slice(-24)
    run(camoExecutable, ['stop', '--profile', profile], { cwd: fixture.temporaryRoot, env: fixture.env,
      logPath: join(evidenceDir, `camo-stop-${name}.json`) })
    run(camoExecutable, ['daemon', 'stop', '--profile', profile], { cwd: fixture.temporaryRoot, env: fixture.env,
      logPath: join(evidenceDir, `camo-daemon-stop-${name}.json`) })
  }
}

async function startBrowserPage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<html><body><h1>${browserPageMarker}</h1></body></html>`)
  })
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert(address !== null && typeof address === 'object', 'the browser page server did not bind a port')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise(resolveClose => server.close(() => resolveClose()))
    },
  }
}

async function runBB03(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB03')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb03')
  const camo = resolveCamo(evidenceDir)
  const searchExecutable = resolveExecutable('rg', evidenceDir)
  const runtime = provisionBrowserRuntime(fixture, evidenceDir)
  const page = await startBrowserPage()
  const profiles = new Set()
  let lifecycle
  let result
  try {
    writeWorkFixture(fixture)
    initializeInstalledConfig(fixture, evidenceDir, 'bb03')

    // (A) Browser disabled: the provider declares file-search only.
    const disabledConfig = browserCaseConfigText(searchExecutable, {
      camoExecutable: missingCamoExecutable,
      browser: null,
      allowedConsumers: [browserCaseReceiver],
      receivers: [{ id: browserCaseReceiver, capability: 'file-search' }],
    })
    writeCaseConfig(fixture, evidenceDir, 'bb03-disabled', disabledConfig)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb03-disabled')
    const disabledProvider = lifecycle.parsed.endpoints.find(endpoint => endpoint.agentId === workProviderId)
    assert(disabledProvider?.presence === 'online', `the disabled provider is not online: ${JSON.stringify(lifecycle.parsed.endpoints)}`)
    assert(disabledProvider.capabilities.some(capability => capability.startsWith('file-search@1:')),
      `the enabled file-search capability is not advertised: ${JSON.stringify(disabledProvider.capabilities)}`)
    assert(!disabledProvider.capabilities.some(capability => capability.startsWith(`${browserCapabilityId}@`)),
      `a disabled browser capability was advertised: ${JSON.stringify(disabledProvider.capabilities)}`)
    const disabledOpen = openBrowserContext(fixture, evidenceDir, 'bb03-disabled-open', browserCaseReceiver, disabledProvider.generation, page.url)
    assert(disabledOpen.receipt.status === 'failed', `a disabled capability was matchable: ${JSON.stringify(disabledOpen.receipt)}`)
    assert(disabledOpen.receipt.control.error?.code === 'NOT_FOUND',
      `the disabled capability refusal was not NOT_FOUND: ${JSON.stringify(disabledOpen.receipt.control.error)}`)
    assert(disabledOpen.receipt.business === undefined, 'a disabled capability returned a business result')
    assertNoProviderWork(fixture, 'a disabled capability')
    assert(browserProfilesUnder(fixture).size === 0, 'a disabled capability created a real browser context')
    const disabledObservation = {
      advertised_capabilities: disabledProvider.capabilities,
      refusal: publicJson(disabledOpen.receipt.control),
      provider_ledger_present: existsSync(providerLedger(fixture).path),
      browser_processes: browserProfilesUnder(fixture).size,
    }
    await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb03-disabled')
    lifecycle = undefined

    // (B) Browser declared but pointing at a nonexistent CLI.
    const missingConfig = browserCaseConfigText(searchExecutable, {
      camoExecutable: missingCamoExecutable,
      browser: { context: 1, slot: 1 },
      allowedConsumers: [browserCaseReceiver],
      receivers: [{ id: browserCaseReceiver, capability: 'browser' }],
    })
    writeCaseConfig(fixture, evidenceDir, 'bb03-missing', missingConfig)
    const missingStart = run(fixture.cli, ['start', '--config', fixture.configPath], { cwd: fixture.temporaryRoot, env: fixture.env,
      logPath: join(evidenceDir, 'bb03-missing-start.json') })
    assert(missingStart.status !== 0, 'start succeeded with a nonexistent browser CLI')
    assert(/camoExecutable cannot be inspected/u.test(`${missingStart.stdout}\n${missingStart.stderr}`),
      `the missing browser CLI was not refused explicitly: ${missingStart.stdout}${missingStart.stderr}`)
    const missingStatus = parseCliStatus(runChecked(fixture.cli, ['status', '--config', fixture.configPath], { cwd: fixture.temporaryRoot,
      env: fixture.env, logPath: join(evidenceDir, 'bb03-missing-status.json') }).stdout)
    assert(missingStatus.state === 'failed', `the missing browser CLI did not fail the lifecycle: ${JSON.stringify(missingStatus)}`)
    assert(missingStatus.endpoints.length === 0, 'the missing browser CLI still advertised endpoints')
    assertNoProviderWork(fixture, 'the missing browser CLI')
    assert(browserProfilesUnder(fixture).size === 0, 'the missing browser CLI created a real browser context')
    assert(fixtureProcesses(fixture).length === 0, `the failed lifecycle left owned processes: ${JSON.stringify(fixtureProcesses(fixture))}`)
    const missingObservation = {
      start_status: missingStart.status,
      start_stderr: missingStart.stderr.trim(),
      lifecycle: publicJson(missingStatus),
      provider_ledger_present: existsSync(providerLedger(fixture).path),
      browser_processes: browserProfilesUnder(fixture).size,
      owned_processes: fixtureProcesses(fixture).length,
    }

    // (C) The real browser executable is enabled and owns its context lifecycle.
    const enabledConfig = browserCaseConfigText(searchExecutable, {
      camoExecutable: camo.executable,
      browser: { context: 1, slot: 1 },
      allowedConsumers: [browserCaseReceiver],
      receivers: [{ id: browserCaseReceiver, capability: 'browser' }],
    })
    writeCaseConfig(fixture, evidenceDir, 'bb03-enabled', enabledConfig)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb03-enabled')
    const enabledProvider = lifecycle.parsed.endpoints.find(endpoint => endpoint.agentId === workProviderId)
    const advertised = `${browserCapabilityId}@1:${browserOperations.join(',')}[browser-context:1:context,browser-slot:1:slot]`
    assert(lifecycle.status.stdout.includes(advertised),
      `the real browser capability was not advertised with its resources: ${lifecycle.status.stdout.trim()}`)

    const search = runWorkReceipt(fixture, evidenceDir, 'bb03-file-search-open', ['work', 'open', '--config', fixture.configPath,
      '--receiver', browserCaseReceiver, ...browserBinding(enabledProvider.generation, 'file-search', 'search'),
      '--demands', browserSearchDemands, '--payload', '{"query":"marker-alpha"}'])
    assert(search.receipt.status === 'completed', `the real file-search Work did not complete: ${JSON.stringify(search.receipt)}`)
    assertMatchedSearch(search.receipt, './a.txt')

    const opened = openBrowserContext(fixture, evidenceDir, 'bb03-browser-open', browserCaseReceiver, enabledProvider.generation, page.url)
    assert(opened.receipt.status === 'failed' && opened.receipt.control.error?.code === 'RESULT_UNKNOWN'
      && opened.receipt.control.deliveryState === 'unconfirmed',
    `the installed browser create did not report an unconfirmed delivery: ${JSON.stringify(opened.receipt)}`)
    const observed = await observeBrowserContext(fixture, evidenceDir, 'bb03-browser-query', browserCaseReceiver, opened.receipt)
    profiles.add(observed.business.profile)
    const created = browserProfilesUnder(fixture)
    assert(created.has(observed.business.profile),
      `the real Camoufox process for ${observed.business.profile} is missing: ${JSON.stringify([...created.keys()])}`)

    const closed = closeBrowserWork(fixture, evidenceDir, 'bb03-browser-close', browserCaseReceiver, opened.receipt)
    assert(closed.receipt.status === 'completed'
      || (closed.receipt.control.error?.code === 'RESULT_UNKNOWN' && closed.receipt.control.deliveryState === 'unconfirmed'),
    `the browser close was neither completed nor an unconfirmed delivery: ${JSON.stringify(closed.receipt)}`)
    await waitForAsync(async () => browserProfilesUnder(fixture).has(observed.business.profile) ? undefined : true,
      60_000, 'the real browser context destruction')
    const ledger = providerLedger(fixture).snapshot
    const closedWork = ledger.works.find(work => work.workId === opened.receipt.control.workId)
    assert(closedWork?.state === 'closed', `the provider ledger did not close the browser Work: ${JSON.stringify(closedWork)}`)
    const workAllocations = ledger.allocations.filter(allocation => allocation.workId === opened.receipt.control.workId)
    assert(workAllocations.length === 2 && workAllocations.every(allocation => allocation.state === 'released'),
      `the provider ledger did not release the browser allocations: ${JSON.stringify(workAllocations)}`)

    await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb03-enabled')
    lifecycle = undefined
    cleanupBrowserProfiles(fixture, camo.executable, profiles, evidenceDir)
    assert(browserProfilesUnder(fixture).size === 0,
      `real browser processes remain after confirmed destruction: ${JSON.stringify([...browserProfilesUnder(fixture).keys()])}`)
    await page.close()
    fixture.cleanup()

    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        commands: ['agentteams init', 'agentteams start', 'agentteams status',
          'agentteams work open --capability-id browser --operation context.create',
          'agentteams work query --service-selection capability',
          'agentteams work close', 'agentteams stop --generation <generation>'],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        camo,
        camoufox_runtime: runtime,
        disabled: disabledObservation,
        missing_executable: missingObservation,
        enabled: {
          advertised_capabilities: enabledProvider.capabilities,
          file_search: { control: publicJson(search.receipt.control), business: publicJson(search.receipt.business) },
          browser_open: publicJson(opened.receipt.control),
          browser_observation: { control: publicJson(observed.control), business: publicJson(observed.business) },
          browser_close: publicJson(closed.receipt.control),
          real_context_pids: created.get(observed.business.profile),
          provider_work_state: closedWork?.state,
          provider_allocation_states: workAllocations.map(allocation => allocation.state),
        },
        browser_processes_after_cleanup: browserProfilesUnder(fixture).size,
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    cleanupBrowserProfiles(fixture, camo.executable, profiles, evidenceDir)
    await page.close()
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

async function runBB05(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB05')
  mkdirSync(evidenceDir, { recursive: true })
  const agents = [workProviderId, browserCaseReceiver, browserIntruder]
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb05', agentAuthEnv([browserIntruder]))
  const camo = resolveCamo(evidenceDir)
  const searchExecutable = resolveExecutable('rg', evidenceDir)
  provisionBrowserRuntime(fixture, evidenceDir)
  let lifecycle
  let result
  try {
    writeWorkFixture(fixture)
    initializeInstalledConfig(fixture, evidenceDir, 'bb05')
    const config = browserCaseConfigText(searchExecutable, {
      camoExecutable: camo.executable,
      browser: { context: 1, slot: 1 },
      allowedConsumers: [browserCaseReceiver],
      receivers: [
        { id: browserCaseReceiver, capability: 'file-search' },
        { id: browserIntruder, capability: 'file-search', label: 'BB-Intruder' },
      ],
    })
    writeCaseConfig(fixture, evidenceDir, 'bb05', config)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb05', agents)
    const provider = lifecycle.parsed.endpoints.find(endpoint => endpoint.agentId === workProviderId)
    assert(provider?.presence === 'online', `the provider is not online: ${JSON.stringify(lifecycle.parsed.endpoints)}`)
    const generation = provider.generation
    const ledgerBefore = providerLedger(fixture).snapshot ?? emptyProviderLedger
    const requestsBefore = ledgerBefore.requests.length
    const activeAllocationsBefore = ledgerBefore.allocations.filter(allocation => allocation.state !== 'released').length
    assert(activeAllocationsBefore === 0, `the rejection fixture started with active allocations: ${JSON.stringify(ledgerBefore.allocations)}`)

    const openArgs = (receiver, overrides = {}) => ['work', 'open', '--config', fixture.configPath, '--receiver', receiver,
      ...browserBinding(overrides.generation ?? generation, 'file-search', overrides.operation ?? 'search'),
      ...(overrides.provider === undefined ? [] : ['--provider', overrides.provider]),
      '--demands', browserSearchDemands, '--payload', '{"query":"marker-alpha"}']

    // (1) An agent that is neither an allowed consumer nor an allowed manager.
    const unauthorized = runWorkReceipt(fixture, evidenceDir, 'bb05-unauthorized',
      openArgs(browserIntruder))
    assert(unauthorized.receipt.status === 'failed', `an unauthorized consumer was admitted: ${JSON.stringify(unauthorized.receipt)}`)
    assert(unauthorized.receipt.control.error?.code === 'FORBIDDEN',
      `the unauthorized consumer refusal was not FORBIDDEN: ${JSON.stringify(unauthorized.receipt.control.error)}`)

    // (2) An operation the provider does not declare.
    const undeclared = runWorkReceipt(fixture, evidenceDir, 'bb05-undeclared-operation',
      openArgs(browserCaseReceiver, { operation: 'not-a-real-operation' }))
    assert(undeclared.receipt.status === 'failed', `an undeclared operation was admitted: ${JSON.stringify(undeclared.receipt)}`)
    assert(undeclared.receipt.control.error?.code === 'UNSUPPORTED_OPERATION',
      `the undeclared operation refusal was not UNSUPPORTED_OPERATION: ${JSON.stringify(undeclared.receipt.control.error)}`)

    // (3) A stale provider generation.
    const stale = runWorkReceipt(fixture, evidenceDir, 'bb05-stale-generation',
      openArgs(browserCaseReceiver, { generation: generation + 1000 }))
    assert(stale.receipt.status === 'failed', `a stale generation was admitted: ${JSON.stringify(stale.receipt)}`)
    assert(stale.receipt.control.error?.code === 'STALE_GENERATION',
      `the stale generation refusal was not STALE_GENERATION: ${JSON.stringify(stale.receipt.control.error)}`)

    // (4) A provider target that does not exist.
    const wrongTarget = runWorkReceipt(fixture, evidenceDir, 'bb05-wrong-target',
      openArgs(browserCaseReceiver, { provider: 'bb-ghost' }))
    assert(wrongTarget.receipt.status === 'failed', `a wrong target was admitted: ${JSON.stringify(wrongTarget.receipt)}`)
    assert(wrongTarget.receipt.control.error?.code === 'NOT_FOUND',
      `the wrong target refusal was not NOT_FOUND: ${JSON.stringify(wrongTarget.receipt.control.error)}`)

    const rejections = [unauthorized, undeclared, stale, wrongTarget]
    for (const rejection of rejections) {
      assert(rejection.receipt.business === undefined, `a rejected request returned a business result: ${JSON.stringify(rejection.receipt)}`)
      assert(typeof rejection.receipt.control.error?.message === 'string' && rejection.receipt.control.error.message.length > 0,
        `a rejected request carried no explicit message: ${JSON.stringify(rejection.receipt.control)}`)
      assert(rejection.output.status !== 0, `a rejected request exited 0: ${JSON.stringify(rejection.receipt.control)}`)
    }

    // The real provider shows no new execution or resource side effect.
    const ledgerAfter = providerLedger(fixture).snapshot ?? emptyProviderLedger
    assert(ledgerAfter.requests.length === requestsBefore,
      `a rejected request created provider execution: ${JSON.stringify(ledgerAfter.requests)}`)
    assert(ledgerAfter.allocations.filter(allocation => allocation.state !== 'released').length === activeAllocationsBefore,
      `a rejected request created a resource allocation: ${JSON.stringify(ledgerAfter.allocations)}`)
    const intruderWork = ledgerAfter.works.find(work => work.consumerAgentId === browserIntruder)
    assert(intruderWork?.state === 'rejected', `the unauthorized proposal was not recorded as rejected: ${JSON.stringify(intruderWork)}`)
    assert(browserProfilesUnder(fixture).size === 0, 'a rejected request created a real browser context')
    const sideEffects = {
      requests_before: requestsBefore,
      requests_after: ledgerAfter.requests.length,
      active_allocations_before: activeAllocationsBefore,
      active_allocations_after: ledgerAfter.allocations.filter(allocation => allocation.state !== 'released').length,
      unauthorized_work_state: intruderWork?.state,
      browser_processes: browserProfilesUnder(fixture).size,
    }

    // A legal request still succeeds afterwards.
    const legal = completedWorkReceipt(runWork(fixture, evidenceDir, 'bb05-legal-submit',
      ['work', 'submit', '--config', fixture.configPath, '--receiver', browserCaseReceiver, '--payload', '{"query":"marker-alpha"}'],
      { expectStatus: 0 }))
    assert(legal.control.requestState === 'succeeded' && legal.control.workClosure === 'closed',
      `the legal request did not close a succeeded request: ${JSON.stringify(legal.control)}`)
    assertMatchedSearch(legal, './a.txt')

    await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb05')
    lifecycle = undefined
    fixture.cleanup()
    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        commands: ['agentteams init', 'agentteams start', 'agentteams status',
          'agentteams work open (unauthorized consumer)', 'agentteams work open (undeclared operation)',
          'agentteams work open (stale generation)', 'agentteams work open (wrong target)',
          'agentteams work submit (legal)', 'agentteams stop --generation <generation>'],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        camo,
        advertised_capabilities: provider.capabilities,
        rejections: rejections.map(rejection => ({
          exit_status: rejection.output.status,
          status: rejection.receipt.status,
          control: publicJson(rejection.receipt.control),
        })),
        side_effects: sideEffects,
        legal: { control: publicJson(legal.control), business: publicJson(legal.business) },
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

/**
 * BB06i round 12: the provider's typed capacity refusal must be readable from the
 * public receipt alone. The host projects the typed output ARC `control.reply.error`
 * into the existing `control.error`; this assertion never reads the provider's
 * private ledger, so a refusal that stays only in the ledger fails here.
 */
function assertCapacityRefusal(receipt, label, expected) {
  const control = receipt.control
  assert(receipt.status === 'completed', `${label}: the refusal receipt was not completed: ${JSON.stringify(receipt)}`)
  assert(receipt.business === undefined,
    `${label}: an over-capacity receipt returned a business result: ${JSON.stringify(receipt.business)}`)
  assert(control.requestState === 'failed' && control.workClosure === 'retained',
    `${label}: the over-capacity Work was not retained as a failed request: ${JSON.stringify(control)}`)
  assert(control.error?.code === 'RESOURCE_EXHAUSTED',
    `${label}: the public receipt did not carry the typed capacity refusal: ${JSON.stringify(control.error)}`)
  assert(/capacity exhausted|is occupied/u.test(String(control.error?.message ?? '')),
    `${label}: the typed capacity refusal carried no provider resource reason: ${JSON.stringify(control.error)}`)
  assert(control.workId === expected.workId, `${label}: the refusal lost the original workId: ${JSON.stringify(control)}`)
  assert(typeof control.requestId === 'string' && control.requestId.length > 0,
    `${label}: the refusal carried no request identity: ${JSON.stringify(control)}`)
  if (expected.previousRequestId !== undefined) {
    assert(control.requestId !== expected.previousRequestId,
      `${label}: the refusal replayed the previous request identity: ${JSON.stringify(control)}`)
  }
  assert(control.providerAgentId === expected.providerAgentId && control.targetGeneration === expected.targetGeneration,
    `${label}: the refusal lost the original provider/generation binding: ${JSON.stringify(control)}`)
  assert(control.capabilityId === expected.capabilityId && control.capabilityVersion === expected.capabilityVersion
    && control.operation === expected.operation,
  `${label}: the refusal lost the original capability/operation binding: ${JSON.stringify(control)}`)
  return control
}

async function runBB06(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB06')
  mkdirSync(evidenceDir, { recursive: true })
  const receivers = [browserReceiverOne, browserReceiverTwo]
  const agents = [workProviderId, ...receivers]
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb06', agentAuthEnv(receivers))
  const camo = resolveCamo(evidenceDir)
  const searchExecutable = resolveExecutable('rg', evidenceDir)
  const runtime = provisionBrowserRuntime(fixture, evidenceDir)
  const page = await startBrowserPage()
  const profiles = new Set()
  let lifecycle
  let result
  try {
    writeWorkFixture(fixture)
    initializeInstalledConfig(fixture, evidenceDir, 'bb06')
    const config = browserCaseConfigText(searchExecutable, {
      camoExecutable: camo.executable,
      browser: { context: 2, slot: 2 },
      allowedConsumers: receivers,
      receivers: receivers.map(id => ({ id, capability: 'browser' })),
    })
    writeCaseConfig(fixture, evidenceDir, 'bb06', config)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb06', agents)
    const provider = lifecycle.parsed.endpoints.find(endpoint => endpoint.agentId === workProviderId)
    assert(provider?.presence === 'online', `the provider is not online: ${JSON.stringify(lifecycle.parsed.endpoints)}`)
    const capacity = `${browserCapabilityId}@1:${browserOperations.join(',')}[browser-context:2:context,browser-slot:2:slot]`
    assert(lifecycle.status.stdout.includes(capacity),
      `the provider did not advertise the configured capacity: ${lifecycle.status.stdout.trim()}`)

    const openedOne = openBrowserContext(fixture, evidenceDir, 'bb06-open-1', browserReceiverOne, provider.generation, page.url)
    const openedTwo = openBrowserContext(fixture, evidenceDir, 'bb06-open-2', browserReceiverTwo, provider.generation, page.url)
    for (const opened of [openedOne, openedTwo]) {
      assert(opened.receipt.status === 'failed' && opened.receipt.control.error?.code === 'RESULT_UNKNOWN'
        && opened.receipt.control.deliveryState === 'unconfirmed',
      `a persistent browser create did not report an unconfirmed delivery: ${JSON.stringify(opened.receipt)}`)
    }
    const observedOne = await observeBrowserContext(fixture, evidenceDir, 'bb06-query-1', browserReceiverOne, openedOne.receipt)
    const observedTwo = await observeBrowserContext(fixture, evidenceDir, 'bb06-query-2', browserReceiverTwo, openedTwo.receipt)
    profiles.add(observedOne.business.profile)
    profiles.add(observedTwo.business.profile)
    assert(observedOne.business.contextId !== observedTwo.business.contextId,
      'two consumers shared one browser context')
    assert(observedOne.business.profile !== observedTwo.business.profile,
      'two consumers shared one browser profile')
    assert(observedOne.control.providerAgentId === workProviderId && observedTwo.control.providerAgentId === workProviderId,
      'the one-to-many work did not stay on one provider')
    const holding = browserProfilesUnder(fixture)
    assert(holding.has(observedOne.business.profile) && holding.has(observedTwo.business.profile),
      `the two real Camoufox contexts are not both alive: ${JSON.stringify([...holding.keys()])}`)
    assert(holding.size === 2, `the provider created more contexts than the configured capacity: ${JSON.stringify([...holding.keys()])}`)

    // (1) Over capacity: a third persistent Work is refused without a third context.
    const overCapacity = openBrowserContext(fixture, evidenceDir, 'bb06-open-3', browserReceiverOne, provider.generation, page.url)
    const overControl = overCapacity.receipt.control
    assertCapacityRefusal(overCapacity.receipt, 'the over-capacity open', {
      workId: overControl.workId,
      providerAgentId: workProviderId, targetGeneration: provider.generation,
      capabilityId: browserCapabilityId, capabilityVersion: '1', operation: 'context.create',
    })
    const afterRefusal = browserProfilesUnder(fixture)
    assert(afterRefusal.size === 2, `the over-capacity refusal created an extra context: ${JSON.stringify([...afterRefusal.keys()])}`)
    // The retained Work refuses the request again. The public entry reports the
    // typed provider refusal on the same receipt the caller already holds.
    const refused = runWorkReceipt(fixture, evidenceDir, 'bb06-request-over-capacity', ['work', 'request', '--config', fixture.configPath,
      '--receiver', browserReceiverOne, '--work-id', overControl.workId,
      ...browserBinding(provider.generation, browserCapabilityId, 'context.create'),
      '--demands', browserContextDemands, '--payload', JSON.stringify({ initialUrl: page.url })])
    const refusedControl = refused.receipt.control
    assertCapacityRefusal(refused.receipt, 'the retained over-capacity request', {
      workId: overControl.workId, previousRequestId: overControl.requestId,
      providerAgentId: workProviderId, targetGeneration: provider.generation,
      capabilityId: browserCapabilityId, capabilityVersion: '1', operation: 'context.create',
    })
    assert(browserProfilesUnder(fixture).size === 2,
      `the over-capacity request created an extra context: ${JSON.stringify([...browserProfilesUnder(fixture).keys()])}`)

    // (2) Confirmed release re-admits capacity.
    const closedOne = closeBrowserWork(fixture, evidenceDir, 'bb06-close-1', browserReceiverOne, openedOne.receipt)
    assert(closedOne.receipt.status === 'completed'
      || (closedOne.receipt.control.error?.code === 'RESULT_UNKNOWN' && closedOne.receipt.control.deliveryState === 'unconfirmed'),
    `the browser close was neither completed nor an unconfirmed delivery: ${JSON.stringify(closedOne.receipt)}`)
    await waitForAsync(async () => browserProfilesUnder(fixture).has(observedOne.business.profile) ? undefined : true,
      60_000, 'the first real browser context destruction')
    profiles.delete(observedOne.business.profile)

    const reopened = openBrowserContext(fixture, evidenceDir, 'bb06-open-4', browserReceiverOne, provider.generation, page.url)
    assert(reopened.receipt.status === 'failed' && reopened.receipt.control.error?.code === 'RESULT_UNKNOWN'
      && reopened.receipt.control.deliveryState === 'unconfirmed',
    `the re-admitted browser create did not report an unconfirmed delivery: ${JSON.stringify(reopened.receipt)}`)
    const observedReopened = await observeBrowserContext(fixture, evidenceDir, 'bb06-query-4', browserReceiverOne, reopened.receipt)
    profiles.add(observedReopened.business.profile)
    assert(observedReopened.business.contextId !== observedOne.business.contextId
      && observedReopened.business.contextId !== observedTwo.business.contextId,
    'the re-admitted Work reused a released context identity')
    const readmitted = browserProfilesUnder(fixture)
    assert(readmitted.has(observedReopened.business.profile),
      `the re-admitted context has no real Camoufox process: ${JSON.stringify([...readmitted.keys()])}`)

    // (3) Release the remaining contexts and confirm real destruction.
    const closedTwo = closeBrowserWork(fixture, evidenceDir, 'bb06-close-2', browserReceiverTwo, openedTwo.receipt)
    const closedReopened = closeBrowserWork(fixture, evidenceDir, 'bb06-close-4', browserReceiverOne, reopened.receipt)
    for (const closed of [closedTwo, closedReopened]) {
      assert(closed.receipt.status === 'completed'
        || (closed.receipt.control.error?.code === 'RESULT_UNKNOWN' && closed.receipt.control.deliveryState === 'unconfirmed'),
      `a browser close was neither completed nor an unconfirmed delivery: ${JSON.stringify(closed.receipt)}`)
    }
    await waitForAsync(async () => browserProfilesUnder(fixture).size === 0 ? true : undefined,
      90_000, 'every released browser context to be destroyed')
    profiles.clear()

    await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb06')
    lifecycle = undefined
    cleanupBrowserProfiles(fixture, camo.executable, new Set([observedOne.business.profile, observedTwo.business.profile, observedReopened.business.profile]), evidenceDir)
    assert(browserProfilesUnder(fixture).size === 0,
      `real browser processes remain after confirmed release: ${JSON.stringify([...browserProfilesUnder(fixture).keys()])}`)
    await page.close()
    fixture.cleanup()

    result = {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        commands: ['agentteams init', 'agentteams start', 'agentteams status',
          'agentteams work open --receiver bb-receiver-1 --operation context.create',
          'agentteams work open --receiver bb-receiver-2 --operation context.create',
          'agentteams work open (over capacity)', 'agentteams work close',
          'agentteams work open (after confirmed release)', 'agentteams stop --generation <generation>'],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        camo,
        camoufox_runtime: runtime,
        advertised_capability: capacity,
        holding: {
          first: { receiver: browserReceiverOne, control: publicJson(observedOne.control), business: publicJson(observedOne.business),
            process_pids: holding.get(observedOne.business.profile) },
          second: { receiver: browserReceiverTwo, control: publicJson(observedTwo.control), business: publicJson(observedTwo.business),
            process_pids: holding.get(observedTwo.business.profile) },
          real_contexts: holding.size,
        },
        over_capacity: {
          open: { exit_status: overCapacity.output.status, control: publicJson(overControl) },
          request: { exit_status: refused.output.status, control: publicJson(refusedControl) },
          real_contexts_after: afterRefusal.size,
        },
        release: { close: publicJson(closedOne.receipt.control), released_context: observedOne.business.contextId },
        readmitted: { control: publicJson(observedReopened.control), business: publicJson(observedReopened.business),
          process_pids: readmitted.get(observedReopened.business.profile) },
        browser_processes_after_cleanup: browserProfilesUnder(fixture).size,
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    cleanupBrowserProfiles(fixture, camo.executable, profiles, evidenceDir)
    await page.close()
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
  return result
}

function unverifiedProbe(fixture, caseDefinition, evidenceDir) {
  const args = caseDefinition.publicProbe === 'status' ? ['status'] : ['work']
  const observation = run(fixture.cli, args, {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, `${caseDefinition.publicProbe}-probe.json`),
  })
  return {
    command: [fixture.cli, ...args],
    exit_status: observation.status,
    stdout: observation.stdout,
    stderr: observation.stderr,
  }
}

function parseArgs(argv) {
  const parsed = { command: 'run', caseIds: [], receiptPath: defaultReceiptPath, packRoot: defaultPackRoot, evidenceRoot: undefined }
  if (argv.length === 0) parsed.command = 'help'
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) fail(`${argument} requires a value`)
      index += 1
      return next
    }
    if (argument === '--help' || argument === '-h') parsed.command = 'help'
    else if (argument === '--list') parsed.command = 'list'
    else if (argument === '--case') {
      const raw = value()
      parsed.caseIds = raw === 'all' ? cases.map(item => item.id) : raw.split(',').filter(Boolean)
    } else if (argument === '--receipt') {
      parsed.receiptPath = resolve(value())
    } else if (argument === '--package') {
      parsed.packRoot = resolve(value())
    } else if (argument === '--evidence-dir') {
      parsed.evidenceRoot = resolve(value())
    } else {
      fail(`unknown argument: ${argument}`)
    }
  }
  return parsed
}

function ensureCaseIds(caseIds) {
  const known = new Set(cases.map(item => item.id))
  for (const id of caseIds) {
    if (!known.has(id)) fail(`unknown case: ${id}`)
  }
}

function ensurePackRoot(packRoot, evidenceDir) {
  const packageReceiptPath = join(dirname(packRoot), 'package-receipt.json')
  if (!existsSync(packageReceiptPath) || !existsSync(join(packRoot, 'package.json'))) {
    runChecked('pnpm', ['build:governance'], {
      cwd: root,
      logPath: join(evidenceDir, 'build-governance.json'),
    })
  }
  assert(existsSync(join(packRoot, 'package.json')), `staged pack root is missing: ${packRoot}`)
  assert(existsSync(packageReceiptPath), `staged package receipt is missing: ${packageReceiptPath}`)
  const packageReceipt = readJson(packageReceiptPath)
  assert(packageReceipt.mode === 'base' || packageReceipt.mode === 'final', `unsupported package mode: ${packageReceipt.mode}`)
  validateCandidateIdentity(packageReceipt.candidate)
  const current = currentCandidateIdentity(root)
  assert(JSON.stringify(packageReceipt.candidate) === JSON.stringify(current),
    'staged package receipt belongs to another candidate; rebuild the package before acceptance')
  return {
    packRoot,
    packageReceipt,
    packageReceiptPath,
    contentSha256: packageReceipt.content_sha256,
    version: packageReceipt.version,
  }
}

async function runCases(parsed) {
  const evidenceRoot = parsed.evidenceRoot ?? join(dirname(parsed.receiptPath), `${Date.now()}-${process.pid}`)
  mkdirSync(evidenceRoot, { recursive: true })
  const caseEvidenceRoot = join(evidenceRoot, 'cases')
  const buildEvidenceDir = join(evidenceRoot, 'package')
  mkdirSync(caseEvidenceRoot, { recursive: true })
  mkdirSync(buildEvidenceDir, { recursive: true })
  const staged = ensurePackRoot(parsed.packRoot, buildEvidenceDir)
  const candidate = currentCandidateIdentity(root)
  const receipt = {
    schema_version: 1,
    driver: 'scripts/blackbox-user-mvp.mjs',
    generated_at: now(),
    candidate,
    candidate_commit: candidate.head_commit,
    candidate_tree_hash: candidate.tree_hash,
    installed_package: {
      pack_root: staged.packRoot,
      package_receipt: staged.packageReceiptPath,
      content_sha256: staged.contentSha256,
      mode: staged.packageReceipt.mode,
      version: staged.version,
    },
    cases: [],
  }
  for (const id of parsed.caseIds) {
    const definition = cases.find(item => item.id === id)
    const caseEvidenceDir = join(caseEvidenceRoot, id)
    mkdirSync(caseEvidenceDir, { recursive: true })
    if (definition.implemented === true) {
      try {
        const result = await definition.run({ candidate, packRoot: staged.packRoot, caseEvidenceRoot })
        receipt.cases.push({ case_id: id, owner: definition.owner, capability_gate: definition.gate, ...result })
      } catch (error) {
        receipt.cases.push({
          case_id: id,
          owner: definition.owner,
          capability_gate: definition.gate,
          status: 'failed',
          public_input: { case: id },
          external_observation: { error: error instanceof Error ? error.message : String(error) },
          evidence_path: caseEvidenceDir,
        })
      }
    } else {
      const fixture = installPackage(staged.packRoot, caseEvidenceDir, id.toLowerCase())
      try {
        runChecked(fixture.cli, ['init'], {
          cwd: fixture.temporaryRoot,
          env: fixture.env,
          logPath: join(caseEvidenceDir, 'init.json'),
        })
        const observation = unverifiedProbe(fixture, definition, caseEvidenceDir)
        receipt.cases.push({
          case_id: id,
          owner: definition.owner,
          capability_gate: definition.gate,
          status: 'unverified',
          public_input: observation.command,
          external_observation: {
            missing_capability: definition.missingCapability,
            probe: observation,
          },
          evidence_path: caseEvidenceDir,
        })
      } catch (error) {
        receipt.cases.push({
          case_id: id,
          owner: definition.owner,
          capability_gate: definition.gate,
          status: 'failed',
          public_input: { case: id },
          external_observation: { error: error instanceof Error ? error.message : String(error) },
          evidence_path: caseEvidenceDir,
        })
      } finally {
        try {
          fixture.cleanup()
        } catch {
          // BB14 records cleanup obligations. Other cases preserve their primary observation.
        }
      }
    }
  }
  const failed = receipt.cases.some(item => item.status === 'failed')
  const unverified = receipt.cases.some(item => item.status === 'unverified')
  receipt.exit = {
    code: failed ? exitCode.failed : unverified ? exitCode.unverified : exitCode.passed,
    failed: receipt.cases.filter(item => item.status === 'failed').map(item => item.case_id),
    unverified: receipt.cases.filter(item => item.status === 'unverified').map(item => item.case_id),
  }
  writeJson(parsed.receiptPath, receipt)
  return receipt
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed.command === 'help') {
      process.stdout.write(`${usage()}\n`)
      return
    }
    if (parsed.command === 'list') {
      for (const item of cases) {
        const state = item.implemented === true ? 'implemented' : 'unverified'
        process.stdout.write(`${item.id} owner=${item.owner} gate=${item.gate} status=${state}\n`)
      }
      return
    }
    ensureCaseIds(parsed.caseIds)
    if (parsed.caseIds.length === 0) fail('at least one --case is required')
    const receipt = await runCases(parsed)
    process.stdout.write(`${JSON.stringify({
      receipt: parsed.receiptPath,
      cases: receipt.cases.map(item => ({ case_id: item.case_id, status: item.status })),
      exit_code: receipt.exit.code,
    })}\n`)
    process.exitCode = receipt.exit.code
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = exitCode.failed
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main()
}

export {
  Bb10SourceError,
  bb10LaunchEnv,
  bb09ConfigText,
  canonicalSessionConfigText,
  cases,
  parseArgs,
  parseCanonicalProviderSource,
  parseFlatSecretKey,
  parseRccServerSource,
  readDeclaredSecretKey,
  redactCredential,
}
