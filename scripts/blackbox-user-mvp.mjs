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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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
  { id: 'BB03', owner: 'U3', gate: 'real browser service lifecycle and capacity', implemented: false, missingCapability: 'U3 installed browser service and real Camo lifecycle are not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB04', owner: 'D3/U4', gate: 'installed public Work submit and query', implemented: true, run: runBB04 },
  { id: 'BB05', owner: 'U3+U4', gate: 'installed Work rejection matrix', implemented: false, missingCapability: 'U4 installed Work rejection entry and U3 service admission are not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB06', owner: 'U3+U4', gate: 'persistent browser Work capacity', implemented: false, missingCapability: 'U4 persistent Work lifecycle and U3 real browser capacity are not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB07', owner: 'D3/U4', gate: 'installed Work unknown and recovery query', implemented: true, run: runBB07 },
  { id: 'BB08', owner: 'U2+U4', gate: 'installed config generation and stale rejection', implemented: true, run: runBB08 },
  { id: 'BB09', owner: 'U5', gate: 'installed Console lifecycle and offline Work', implemented: true, run: runBB09 },
  { id: 'BB10', owner: 'U2+U6', gate: 'installed explicit provider/model session', implemented: false, missingCapability: 'U6 installed OpenCode provider/model Session entry is not delivered in this candidate', publicProbe: 'status' },
  { id: 'BB11', owner: 'D3/U4', gate: 'installed SDK Work and compile negatives', implemented: true, run: runBB11 },
  { id: 'BB12', owner: 'U6', gate: 'installed Session message tool permission cancel', implemented: false, missingCapability: 'U6 installed Session message/tool/permission/cancel entry is not delivered in this candidate', publicProbe: 'status' },
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

function parseInternal(path) {
  const internal = parseToml(readFileSync(path, 'utf8'))
  const launcher = internal.launcher
  assert(launcher?.state === 'running', 'internal launcher is not running')
  const ids = ['relay', 'bb-provider', 'bb-receiver']
  const processes = ids.map(id => {
    const record = internal.daemon?.[id]
    assert(record?.pid > 0 && Number.isSafeInteger(record.pid), `internal ${id} pid is missing`)
    assert(typeof record.entryPath === 'string' && record.entryPath.length > 0, `internal ${id} entryPath is missing`)
    assert(record.generation === launcher.generation, `internal ${id} generation does not match launcher`)
    return { id, pid: record.pid, entryPath: record.entryPath, generation: record.generation, startToken: record.startToken }
  })
  const relayProjection = JSON.parse(internal.relay?.config ?? '')
  const daemonConfigs = Object.fromEntries(['bb-provider', 'bb-receiver'].map(id => {
    const record = internal.daemon?.[id]
    assert(record?.config !== undefined, `internal ${id} projection is missing`)
    return [id, JSON.parse(record.config)]
  }))
  const ports = {
    relay: relayProjection.listen?.port,
    'bb-provider': daemonConfigs['bb-provider'].leasePort,
    'bb-receiver': daemonConfigs['bb-receiver'].leasePort,
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
    services: Object.fromEntries(['bb-provider', 'bb-receiver'].map(id => [id, daemonConfigs[id].endpoint?.services ?? []])),
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

function installPackage(packRoot, evidenceDir, label) {
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
  const configText = configFixtureText(rg, options)
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

function startAndReadLifecycle(fixture, evidenceDir, prefix) {
  const start = runChecked(fixture.cli, ['start', '--config', fixture.configPath], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
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
  assert(parsed.endpoints.length === 2 && parsed.endpoints.every(endpoint => endpoint.presence === 'online'),
    `installed lifecycle directory is not online: ${status.stdout.trim()}`)
  const internal = parseInternal(join(dirname(fixture.configPath), 'internal.toml'))
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

/**
 * Drive the installed package's exported Console lifecycle functions and read
 * back the typed error code. This is the installed public runtime surface the
 * CLI itself calls, so the typed terminal is observable without repo source.
 */
function installedConsoleTypedCall(installedRoot, configPath, env, evidenceDir, name, call) {
  const script = String.raw`
import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL(process.env.AGENTTEAMS_INSTALLED_PACKAGE_ROOT + '/generated/runtime-lib/runtime/local-process.js').href)
const fn = mod[process.env.AGENTTEAMS_CONSOLE_CALL]
try {
  await fn(process.env.AGENTTEAMS_CONFIG_PATH, { timeoutMs: 5000 })
  console.log(JSON.stringify({ ok: true }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code ?? null, message: error?.message ?? String(error) }))
}
`
  const result = run(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...env,
      AGENTTEAMS_INSTALLED_PACKAGE_ROOT: installedRoot,
      AGENTTEAMS_CONFIG_PATH: configPath,
      AGENTTEAMS_CONSOLE_CALL: call,
    },
    expectStatus: 0,
    logPath: join(evidenceDir, `${name}.json`),
  })
  return JSON.parse(result.stdout.trim())
}

async function runBB09(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB09')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb09')
  let lifecycle
  let result
  try {
    const config = ensureUserConfig(fixture, evidenceDir, { console: true })
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
    const unavailable = installedConsoleTypedCall(fixture.installedRoot, fixture.configPath, fixture.env, evidenceDir,
      'bb09-console-status-unavailable-typed', 'consoleStatusLocalProcess')
    assert(unavailable.ok === false && unavailable.code === 'CONSOLE_STATUS_UNAVAILABLE',
      `installed Console status did not return CONSOLE_STATUS_UNAVAILABLE: ${JSON.stringify(unavailable)}`)

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
    const disabled = installedConsoleTypedCall(fixture.installedRoot, fixture.configPath, fixture.env, evidenceDir,
      'bb09-console-disabled-typed', 'consoleStartLocalProcess')
    assert(disabled.ok === false && disabled.code === 'CONSOLE_DISABLED',
      `installed Console start did not return CONSOLE_DISABLED: ${JSON.stringify(disabled)}`)
    const disabledRuntime = readConsoleRuntime(disabledLifecycle.internal.internalPath)
    assert(disabledRuntime.state === 'stopped' && disabledRuntime.pid === undefined,
      `a disabled Console start wrote a live runtime row: ${JSON.stringify(disabledRuntime)}`)
    const disabledFinal = await stopAndAssertClean(fixture, disabledLifecycle, evidenceDir, 'bb09-disabled-final')
    const disabledPids = lifecyclePids(disabledLifecycle.internal)
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
        console_status_after_stop: { state: stopStatus.consoleState, stdout: stop.stdout.trim() },
        console_listener_gone_after_stop: consoleListenerGone(initial.url),
        work_without_console: offlineWork.control,
        console_status_after_restart: restarted,
        console_status_unavailable: { cli: unavailableCli.stderr.trim(), typed: unavailable },
        disabled_console_start: { cli: disabledCli.stderr.trim(), typed: disabled, runtime: disabledRuntime },
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

export { cases, parseArgs }
