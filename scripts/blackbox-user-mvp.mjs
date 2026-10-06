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

const cases = [
  { id: 'BB01', owner: 'U1+U5+U7', gate: 'installed package lifecycle and Console assets', implemented: true, run: runBB01 },
  { id: 'BB02', owner: 'U2+U7', gate: 'config.toml-only two-daemon bridge discovery', implemented: true, run: runBB02 },
  { id: 'BB03', owner: 'U3', gate: 'real browser service lifecycle and capacity', implemented: false, missingCapability: 'U3 installed browser service and real Camo lifecycle are not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB04', owner: 'D3/U4', gate: 'installed public Work submit and query', implemented: false, missingCapability: 'U4 installed public Work submit/query entry is not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB05', owner: 'U3+U4', gate: 'installed Work rejection matrix', implemented: false, missingCapability: 'U4 installed Work rejection entry and U3 service admission are not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB06', owner: 'U3+U4', gate: 'persistent browser Work capacity', implemented: false, missingCapability: 'U4 persistent Work lifecycle and U3 real browser capacity are not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB07', owner: 'D3/U4', gate: 'installed Work unknown and recovery query', implemented: false, missingCapability: 'U4 installed Work recovery/query entry is not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB08', owner: 'U2+U4', gate: 'installed config generation and stale rejection', implemented: false, missingCapability: 'U4 installed Work generation rejection is not delivered in this candidate', publicProbe: 'work' },
  { id: 'BB09', owner: 'U5', gate: 'installed Console lifecycle and offline Work', implemented: false, missingCapability: 'U5 installed Console lifecycle and discovery entry are not delivered in this candidate', publicProbe: 'status' },
  { id: 'BB10', owner: 'U2+U6', gate: 'installed explicit provider/model session', implemented: false, missingCapability: 'U6 installed OpenCode provider/model Session entry is not delivered in this candidate', publicProbe: 'status' },
  { id: 'BB11', owner: 'D3/U4', gate: 'installed SDK Work and compile negatives', implemented: false, missingCapability: 'U4 installed public Work SDK entry is not delivered in this candidate', publicProbe: 'work' },
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

function configFixtureText(searchExecutable) {
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
`
}

function installPackage(packRoot, evidenceDir, label) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `agentteams-u7-${label}-`))
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
      else fail(`unsupported directory entry: ${child}`)
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

function ensureUserConfig(fixture, evidenceDir) {
  runChecked(fixture.cli, ['init'], {
    cwd: fixture.temporaryRoot,
    env: fixture.env,
    logPath: join(evidenceDir, 'init.json'),
  })
  const rg = runChecked('which', ['rg'], { env: fixture.env, logPath: join(evidenceDir, 'which-rg.json') }).stdout.trim()
  assert(rg.startsWith('/'), `rg executable is not absolute: ${rg}`)
  const configText = configFixtureText(rg)
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
    assert(existsSync(evidencePath), 'BB13 deleted evidence file was not regenerated')
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
