#!/usr/bin/env node
/**
 * 4e04166 Public Consumer Black-Box Replay:
 * Proves through the installed AgentTeams package and public CLI (`agentteams work open/request/close`)
 * that when Relay `grantTtlMs` is 1500ms and `requestTimeoutMs` is 20000ms, a real Camoufox
 * `browser` `context.create` operation whose execution exceeds the 1500ms Relay admission grant TTL
 * is NOT terminated by the Relay deadline after both data sockets have paired: it completes
 * synchronously on the same opened Relay link (`status: "completed"`, `requestState: "succeeded"`),
 * followed by `snapshot`, `close`, provider ledger release, and full process cleanup.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = process.env.AGENTTEAMS_REPO_ROOT ?? resolve(evidenceDir, '..', '..', '..')
const packRoot = join(repoRoot, 'generated', 'modules', 'teams-source', 'lib')
const receiptPath = process.env.AGENTTEAMS_RECEIPT_PATH ?? join(evidenceDir, 'consumer-receipt.json')

const GRANT_TTL_MS = 1_500
const REQUEST_TIMEOUT_MS = 20_000
const PAGE_MARKER = '4e04166-camo-live-marker'
const PROVIDER_ID = 'bb-provider'
const RECEIVER_ID = 'bb-receiver'
const BROWSER_DEMANDS = '[{"resourceId":"browser-context","amount":1},{"resourceId":"browser-slot","amount":1}]'
const BROWSER_SLOT_DEMAND = '[{"resourceId":"browser-slot","amount":1}]'

const checks = []
function assert(condition, message) {
  checks.push({ ok: Boolean(condition), message })
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`PASS: ${message}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (options.expectStatus !== undefined && result.status !== options.expectStatus) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status} (expected ${options.expectStatus}):\n${result.stderr || result.stdout}`)
  }
  return result
}

function runAsync(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', status => {
      if (options.expectStatus !== undefined && status !== options.expectStatus) {
        rejectRun(new Error(`${command} ${args.join(' ')} exited ${status} (expected ${options.expectStatus}):\n${stderr || stdout}`))
        return
      }
      resolveRun({ status, stdout, stderr })
    })
  })
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

function browserProfilesUnder(home) {
  const result = spawnSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const roots = [join(home, '.camo', 'profiles'), join('/private', home, '.camo', 'profiles')]
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

function fixtureProcesses(home) {
  const result = spawnSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const needles = [home, join('/private', home)]
  return result.stdout.split('\n')
    .filter(line => needles.some(needle => line.includes(needle)))
    .map(line => ({ pid: Number(/^\s*(\d+)/u.exec(line)?.[1]), command: line.replace(/^\s*\d+\s+/u, '') }))
    .filter(entry => Number.isSafeInteger(entry.pid))
}

async function startPageServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<html><body><h1>${PAGE_MARKER}</h1></body></html>`)
  })
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise(resolveClose => {
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    }),
  }
}

function buildConfigToml(camoExecutable, rgExecutable) {
  return `version = 3

[bridge]
enabled = true

[agents.${PROVIDER_ID}]
enabled = true
role = "provider"
label = "BB-Provider"

[agents.${PROVIDER_ID}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "bb-account"
agentKind = "custom"
label = "BB-Provider"

[agents.${PROVIDER_ID}.runtime]
scopeId = "bb-scope"
dataDirectory = "data/${PROVIDER_ID}"
policy = { revision = 1, allowedConsumers = ["${RECEIVER_ID}"], allowedManagers = [] }
cli = { camoExecutable = ${JSON.stringify(camoExecutable)}, searchExecutable = ${JSON.stringify(rgExecutable)}, searchRoot = "files", profilePrefix = "teams-bb-provider" }

[agents.${PROVIDER_ID}.services.browser]
version = "1"
operations = ["context.create", "navigate", "snapshot", "context.destroy"]
resources = [
  { resourceId = "browser-context", capacity = 1, unit = "context" },
  { resourceId = "browser-slot", capacity = 1, unit = "slot" },
]

[agents.${RECEIVER_ID}]
enabled = true
role = "receiver"
label = "BB-Receiver"

[agents.${RECEIVER_ID}.identity]
hostId = "bb-local"
machineId = "bb-machine"
accountId = "bb-account"
agentKind = "custom"
label = "BB-Receiver"

[agents.${RECEIVER_ID}.runtime]
scopeId = "bb-scope"
dataDirectory = "data/${RECEIVER_ID}"
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(rgExecutable)}, searchRoot = "files", profilePrefix = "teams-bb-receiver" }

[agents.${RECEIVER_ID}.connect]
targetAgentId = "${PROVIDER_ID}"
capabilityId = "browser"
capabilityVersion = "1"
operation = "context.create"
demands = [{ resourceId = "browser-context", amount = 1 }, { resourceId = "browser-slot", amount = 1 }]
`
}

async function main() {
  assert(existsSync(join(packRoot, 'package.json')), `staged pack root exists at ${packRoot}`)
  const camoExecutable = run('which', ['camo'], { expectStatus: 0 }).stdout.trim()
  const rgExecutable = run('which', ['rg'], { expectStatus: 0 }).stdout.trim()
  assert(camoExecutable.startsWith('/'), `resolved camo executable (${camoExecutable})`)
  assert(rgExecutable.startsWith('/'), `resolved rg executable (${rgExecutable})`)

  const temporaryRoot = mkdtempSync('/tmp/at-4e-')
  const prefix = join(temporaryRoot, 'prefix')
  const home = join(temporaryRoot, 'home')
  const npmCache = join(temporaryRoot, 'npm-cache')
  const packDest = join(temporaryRoot, 'pack')
  mkdirSync(prefix, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(npmCache, { recursive: true })
  mkdirSync(packDest, { recursive: true })
  mkdirSync(join(home, '.agentteams', 'files'), { recursive: true })
  writeFileSync(join(home, '.agentteams', 'files', 'a.txt'), 'marker-alpha\n')

  const camoCacheSource = join(homedir(), 'Library', 'Caches', 'camoufox')
  assert(existsSync(join(camoCacheSource, 'version.json')), `machine Camoufox cache exists at ${camoCacheSource}`)
  const camoCacheTarget = join(home, 'Library', 'Caches', 'camoufox')
  mkdirSync(dirname(camoCacheTarget), { recursive: true })
  symlinkSync(camoCacheSource, camoCacheTarget)

  const env = {
    ...process.env,
    HOME: home,
    AGENTTEAMS_BB_PROVIDER_AUTH: 'bb-provider-auth',
    AGENTTEAMS_BB_RECEIVER_AUTH: 'bb-receiver-auth',
    npm_config_cache: npmCache,
  }

  const page = await startPageServer()
  const profiles = new Set()
  let cli
  let configPath
  let generation

  try {
    const packed = run('npm', ['pack', packRoot, '--pack-destination', packDest, '--json'], { cwd: temporaryRoot, env, expectStatus: 0 })
    const tarball = join(packDest, JSON.parse(packed.stdout)[0].filename)
    run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-package-lock', '--no-save', tarball], { cwd: temporaryRoot, env, expectStatus: 0 })
    const installedRoot = realpathSync(join(prefix, 'node_modules', 'agentteams'))
    cli = join(prefix, 'node_modules', '.bin', 'agentteams')
    const cliRealpath = realpathSync(cli)
    assert(cliRealpath.startsWith(installedRoot + sep) && !cliRealpath.startsWith(repoRoot + sep),
      `installed CLI resolves outside the source tree (${cliRealpath})`)

    configPath = join(home, '.agentteams', 'config.toml')
    const internalPath = join(home, '.agentteams', 'internal.toml')
    run(cli, ['init'], { cwd: temporaryRoot, env, expectStatus: 0 })
    writeFileSync(configPath, buildConfigToml(camoExecutable, rgExecutable), { mode: 0o600 })
    run(cli, ['status', '--config', configPath], { cwd: temporaryRoot, env, expectStatus: 0 })

    // Patch internal.toml JSON projections with grantTtlMs: 1500 and requestTimeoutMs: 20000
    // before starting, which compileLocalConfig preserves across start into .internal/projections/*.json.
    const initialInternal = readFileSync(internalPath, 'utf8')
    const patchedInternal = initialInternal
      .replaceAll('\\"grantTtlMs\\":5000', `\\"grantTtlMs\\":${GRANT_TTL_MS}`)
      .replaceAll('\\"requestTimeoutMs\\":1000', `\\"requestTimeoutMs\\":${REQUEST_TIMEOUT_MS}`)
    assert(patchedInternal.includes(`\\"grantTtlMs\\":${GRANT_TTL_MS}`), `internal.toml patched with grantTtlMs = ${GRANT_TTL_MS}`)
    assert(patchedInternal.includes(`\\"requestTimeoutMs\\":${REQUEST_TIMEOUT_MS}`), `internal.toml patched with requestTimeoutMs = ${REQUEST_TIMEOUT_MS}`)
    writeFileSync(internalPath, patchedInternal, { mode: 0o600 })

    await runAsync(cli, ['start', '--config', configPath], { cwd: temporaryRoot, env, expectStatus: 0 })
    const statusOut = (await runAsync(cli, ['status', '--config', configPath], { cwd: temporaryRoot, env, expectStatus: 0 })).stdout
    const status = parseCliStatus(statusOut)
    generation = status.generation
    assert(status.state === 'running' && Number.isSafeInteger(generation), `installed lifecycle running at generation=${generation}`)

    const activeInternal = readFileSync(internalPath, 'utf8')
    assert(activeInternal.includes(`\\"grantTtlMs\\":${GRANT_TTL_MS}`), `active internal.toml retains grantTtlMs = ${GRANT_TTL_MS} after start`)
    assert(activeInternal.includes(`\\"requestTimeoutMs\\":${REQUEST_TIMEOUT_MS}`), `active internal.toml retains requestTimeoutMs = ${REQUEST_TIMEOUT_MS} after start`)
    const relayProjection = JSON.parse(readFileSync(join(home, '.agentteams', '.internal', 'projections', 'relay.json'), 'utf8'))
    const receiverProjection = JSON.parse(readFileSync(join(home, '.agentteams', '.internal', 'projections', `${RECEIVER_ID}.json`), 'utf8'))
    assert(relayProjection.limits?.grantTtlMs === GRANT_TTL_MS, `live relay.json projection has grantTtlMs=${relayProjection.limits?.grantTtlMs}`)
    assert(receiverProjection.relay?.requestTimeoutMs === REQUEST_TIMEOUT_MS, `live receiver projection has requestTimeoutMs=${receiverProjection.relay?.requestTimeoutMs}`)

    const providerEndpoint = status.endpoints.find(ep => ep.agentId === PROVIDER_ID)
    assert(providerEndpoint?.presence === 'online', `provider endpoint is online at generation=${providerEndpoint?.generation}`)

    const openStartedAt = Date.now()
    const openRun = await runAsync(cli, [
      'work', 'open', '--config', configPath, '--receiver', RECEIVER_ID,
      '--provider', PROVIDER_ID, '--provider-generation', String(providerEndpoint.generation),
      '--capability-id', 'browser', '--capability-version', '1', '--operation', 'context.create',
      '--demands', BROWSER_DEMANDS, '--payload', JSON.stringify({ initialUrl: page.url }),
    ], { cwd: temporaryRoot, env, expectStatus: 0 })
    const openElapsedMs = Date.now() - openStartedAt
    const openReceipt = JSON.parse(openRun.stdout.trim())

    assert(openElapsedMs > GRANT_TTL_MS,
      `real Camoufox context.create took ${openElapsedMs}ms (> grantTtlMs ${GRANT_TTL_MS}ms)`)
    assert(openReceipt.status === 'completed' && openReceipt.control?.requestState === 'succeeded',
      `opened Relay data link survived past grantTtlMs=${GRANT_TTL_MS}ms and returned synchronous completion (status=${openReceipt.status}, requestState=${openReceipt.control?.requestState})`)

    const workId = openReceipt.control.workId
    const contextId = openReceipt.business?.contextId
    const profile = openReceipt.business?.profile
    assert(typeof workId === 'string' && workId.length > 0, `received persistent workId=${workId}`)
    assert(typeof contextId === 'string' && contextId.startsWith('browser-context-'), `received real browser contextId=${contextId}`)
    assert(typeof profile === 'string' && profile.startsWith('teams-'), `received real browser profile=${profile}`)
    profiles.add(profile)

    const runningProfiles = browserProfilesUnder(home)
    assert(runningProfiles.has(profile), `real Camoufox OS process is running for profile=${profile} (pids=${JSON.stringify(runningProfiles.get(profile))})`)

    const snapRun = await runAsync(cli, [
      'work', 'request', '--config', configPath, '--receiver', RECEIVER_ID,
      '--work-id', workId,
      '--provider', PROVIDER_ID, '--provider-generation', String(providerEndpoint.generation),
      '--capability-id', 'browser', '--capability-version', '1', '--operation', 'snapshot',
      '--demands', BROWSER_DEMANDS, '--payload', JSON.stringify({ contextId }),
    ], { cwd: temporaryRoot, env, expectStatus: 0 })
    const snapReceipt = JSON.parse(snapRun.stdout.trim())
    assert(snapReceipt.status === 'completed' && snapReceipt.control?.requestState === 'succeeded',
      `browser snapshot request succeeded on persistent Work ${workId}`)
    assert(JSON.stringify(snapReceipt.business).includes(PAGE_MARKER),
      `browser snapshot business payload contains live page marker (${PAGE_MARKER})`)

    const closeStartedAt = Date.now()
    const closeRun = await runAsync(cli, [
      'work', 'close', '--config', configPath, '--receiver', RECEIVER_ID,
      '--work-id', workId,
      '--provider', PROVIDER_ID, '--provider-generation', String(providerEndpoint.generation),
      '--capability-id', 'browser', '--capability-version', '1', '--operation', 'context.create',
    ], { cwd: temporaryRoot, env, expectStatus: 0 })
    const closeElapsedMs = Date.now() - closeStartedAt
    const closeReceipt = JSON.parse(closeRun.stdout.trim())
    assert(closeReceipt.status === 'completed' && closeReceipt.control?.workClosure === 'closed',
      `browser work close completed synchronously (elapsed=${closeElapsedMs}ms, workClosure=${closeReceipt.control?.workClosure})`)

    const ledgerPath = join(home, '.agentteams', 'data', PROVIDER_ID, 'work.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const closedWork = ledger.works.find(item => item.workId === workId)
    const allocations = ledger.allocations.filter(item => item.workId === workId)
    assert(closedWork?.state === 'closed', `provider ledger confirms workId=${workId} state=closed`)
    assert(allocations.length === 3 && allocations.every(item => item.state === 'released'),
      `provider ledger confirms all ${allocations.length} resource allocations released`)

    await runAsync(cli, ['stop', '--config', configPath, '--generation', String(generation)], { cwd: temporaryRoot, env, expectStatus: 0 })
    const stoppedGeneration = generation
    generation = undefined

    for (const prof of profiles) {
      run(camoExecutable, ['stop', '--profile', prof], { cwd: temporaryRoot, env })
      run(camoExecutable, ['daemon', 'stop', '--profile', prof], { cwd: temporaryRoot, env })
    }
    assert(browserProfilesUnder(home).size === 0, 'all Camoufox browser processes for isolated HOME are stopped')
    assert(fixtureProcesses(home).length === 0, 'all fixture daemon processes for isolated HOME are stopped')

    const receipt = {
      bugId: '4e04166',
      verifiedAt: new Date().toISOString(),
      status: 'passed',
      installedCliRealpath: cliRealpath,
      grantTtlMs: GRANT_TTL_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      openElapsedMs,
      closeElapsedMs,
      workId,
      contextId,
      profile,
      stoppedGeneration,
      openReceipt,
      snapshotReceipt: {
        status: snapReceipt.status,
        control: snapReceipt.control,
        containsMarker: JSON.stringify(snapReceipt.business).includes(PAGE_MARKER),
      },
      closeReceipt,
      providerLedgerFinal: {
        workState: closedWork?.state,
        allocations: allocations.map(a => ({ allocationId: a.allocationId, resourceId: a.resourceId, state: a.state })),
      },
      checks,
    }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    console.log(`WROTE RECEIPT: ${receiptPath} (${checks.length} checks passed)`)
  } finally {
    if (cli && configPath && generation !== undefined) {
      try { run(cli, ['stop', '--config', configPath, '--generation', String(generation)], { cwd: temporaryRoot, env }) } catch { /* best effort */ }
    }
    for (const prof of profiles) {
      try { run(camoExecutable, ['stop', '--profile', prof], { cwd: temporaryRoot, env }) } catch { /* best effort */ }
      try { run(camoExecutable, ['daemon', 'stop', '--profile', prof], { cwd: temporaryRoot, env }) } catch { /* best effort */ }
    }
    await page.close()
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
