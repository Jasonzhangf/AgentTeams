import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse as parseToml } from 'toml'
import { assertCandidateIdentity, currentCandidateIdentity } from './receipt-identity.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultPackRoot = resolve(root, 'generated', 'modules', 'teams-source', 'lib')
const defaultEvidenceDir = resolve(root, 'generated', 'u1-receipts', `${Date.now()}-${process.pid}`)

function fail(message) {
  throw new Error(`package user smoke: ${message}`)
}

function parseOptions(argv) {
  const options = {
    packRoot: defaultPackRoot,
    evidenceDir: defaultEvidenceDir,
    receiptName: 'package-user-smoke.receipt.json',
    receiptPath: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) fail(`${argument} requires a value`)
      index += 1
      return next
    }
    if (argument === '--pack-root') options.packRoot = resolve(value())
    else if (argument === '--evidence-dir') options.evidenceDir = resolve(value())
    else if (argument === '--receipt-name') options.receiptName = value()
    else if (argument === '--receipt-path') options.receiptPath = resolve(value())
    else fail(`unknown argument: ${argument}`)
  }
  return options
}

function assert(condition, message) {
  if (!condition) fail(message)
}

async function run(command, args, options) {
  try {
    const result = await execFileAsync(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 })
    return { command, args, exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.stdout?.trim() || error?.message || String(error)
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Run a command that must fail, returning its combined failure output. */
async function runExpectFailure(command, args, options) {
  try {
    await execFileAsync(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    return `${error?.stderr ?? ''}${error?.stdout ?? ''}${error?.message ?? String(error)}`
  }
  fail(`${command} ${args.join(' ')} was expected to fail`)
}

function hashDirectory(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child)
      else fail(`unsupported installed entry: ${child}`)
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
  return { sha256: digest.digest('hex'), files: files.length }
}

function listFiles(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(relative(directory, child).split(sep).join('/'))
      else fail(`unsupported staged entry: ${child}`)
    }
  }
  visit(directory)
  return files.sort()
}

function hashFileSet(directory, files) {
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(join(directory, file)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`)
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForProcessesGone(pids, timeoutMs = 2_000) {
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

function fixtureConfigText(searchExecutable) {
  return `version = 3

[bridge]
enabled = true

[agents.installed-provider]
enabled = true
role = "provider"
label = "InstalledProvider"

[agents.installed-provider.identity]
hostId = "installed-local"
machineId = "installed-smoke"
accountId = "installed-local"
agentKind = "custom"
label = "InstalledProvider"

[agents.installed-provider.runtime]
scopeId = "installed-local"
dataDirectory = "data/installed-provider"
policy = { revision = 1, allowedConsumers = ["installed-receiver"], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-installed-provider" }

[agents.installed-provider.services.file-search]
version = "1"
operations = ["search"]
resources = [{ resourceId = "search-slot", capacity = 2, unit = "slot" }]

[agents.installed-receiver]
enabled = true
role = "receiver"
label = "InstalledReceiver"

[agents.installed-receiver.identity]
hostId = "installed-local"
machineId = "installed-smoke"
accountId = "installed-local"
agentKind = "custom"
label = "InstalledReceiver"

[agents.installed-receiver.runtime]
scopeId = "installed-local"
dataDirectory = "data/installed-receiver"
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = "files", profilePrefix = "teams-installed-receiver" }

[agents.installed-receiver.connect]
targetAgentId = "installed-provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
demands = [{ resourceId = "search-slot", amount = 1 }]
`
}

function lifecycleState(configPath, installedRootReal) {
  const internalPath = join(dirname(configPath), 'internal.toml')
  const internal = parseToml(readFileSync(internalPath, 'utf8'))
  const launcher = internal.launcher
  assert(launcher?.state === 'running', 'installed lifecycle internal launcher is not running')
  const daemons = internal.daemon
  const processes = ['relay', 'installed-provider', 'installed-receiver'].map(id => {
    const record = daemons?.[id]
    assert(record?.pid > 0 && Number.isSafeInteger(record.pid), `installed lifecycle ${id} pid is missing`)
    assert(record.entryPath?.startsWith(installedRootReal + sep), `installed lifecycle ${id} entry is outside the installed package: ${record.entryPath}`)
    assert(record.generation === launcher.generation, `installed lifecycle ${id} generation does not match launcher`)
    return { id, pid: record.pid, entryPath: record.entryPath, generation: record.generation, startToken: record.startToken }
  })
  const relayProjection = JSON.parse(internal.relay?.config ?? '')
  assert(relayProjection?.listen?.port > 0 && Number.isSafeInteger(relayProjection.listen.port), 'installed lifecycle relay port is not a positive safe integer')
  const daemonConfigs = Object.fromEntries(['installed-provider', 'installed-receiver'].map(id => {
    const record = daemons?.[id]
    assert(record?.config !== undefined, `installed lifecycle ${id} projection is missing`)
    return [id, JSON.parse(record.config)]
  }))
  const ports = {
    relay: relayProjection.listen.port,
    'installed-provider': daemonConfigs['installed-provider'].leasePort,
    'installed-receiver': daemonConfigs['installed-receiver'].leasePort,
  }
  for (const port of Object.values(ports)) {
    assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, `installed lifecycle port is invalid: ${port}`)
  }
  assert(new Set(Object.values(ports)).size === Object.keys(ports).length, 'installed lifecycle port allocation contains duplicates')
  const services = Object.fromEntries(['installed-provider', 'installed-receiver'].map(id => [
    id,
    daemonConfigs[id].endpoint?.services ?? [],
  ]))
  return {
    internalPath,
    launcher: { pid: launcher.pid, generation: launcher.generation, startToken: launcher.startToken },
    processes,
    ports,
    services,
  }
}

async function runInstalledLifecycle({ cli, cliEnv, configPath, installedRootReal }) {
  const rg = (await run('which', ['rg'], { cwd: dirname(configPath), env: cliEnv })).stdout.trim()
  assert(rg.startsWith('/'), `owned rg executable is not absolute: ${rg}`)
  writeFileSync(configPath, fixtureConfigText(rg), { encoding: 'utf8', mode: 0o600 })
  // The provider declares `searchRoot = "files"`, resolved beside the config.
  // Give the installed Work replay one real input so the capability must return
  // an actual match instead of an empty no-match summary.
  mkdirSync(join(dirname(configPath), 'files'), { recursive: true })
  writeFileSync(join(dirname(configPath), 'files', 'needle.txt'), 'installed work needle\n', { encoding: 'utf8' })
  writeFileSync(join(dirname(configPath), 'files', 'beta.txt'), 'installed work beta\n', { encoding: 'utf8' })

  let activeGeneration
  let lifecycle
  try {
    const start = await run(cli, ['start', '--config', configPath], { cwd: dirname(configPath), env: cliEnv })
    const startStatus = await run(cli, ['status', '--config', configPath], { cwd: dirname(configPath), env: cliEnv })
    const startParsed = parseCliStatus(startStatus.stdout)
    activeGeneration = startParsed.generation
    assert(startParsed.state === 'running' && startParsed.pid !== undefined && startParsed.generation !== undefined,
      `installed lifecycle start did not reach running: ${startStatus.stdout.trim()}`)
    assert(startParsed.endpoints.length === 2 && startParsed.endpoints.every(endpoint => endpoint.presence === 'online' && endpoint.generation >= 1),
      `installed lifecycle directory is not online: ${startStatus.stdout.trim()}`)
    const startInternal = lifecycleState(configPath, installedRootReal)
    assert(startInternal.launcher.generation === startParsed.generation, 'installed lifecycle start generation is inconsistent')
    const providerEndpoint = startParsed.endpoints.find(endpoint => endpoint.agentId === 'installed-provider')
    const receiverEndpoint = startParsed.endpoints.find(endpoint => endpoint.agentId === 'installed-receiver')
    assert(providerEndpoint !== undefined, 'installed lifecycle start did not publish the provider endpoint')
    assert(receiverEndpoint !== undefined, 'installed lifecycle start did not publish the receiver endpoint')
    assert(providerEndpoint.capabilities.some(capability => capability.startsWith('file-search@1:search[search-slot:2:slot]')),
      `installed provider did not publish file-search from public status: ${startStatus.stdout.trim()}`)
    assert(receiverEndpoint.capabilities.length === 0, `installed receiver must not publish capabilities: ${startStatus.stdout.trim()}`)
    assert(startInternal.services['installed-provider'].some(service => service.capabilityId === 'file-search' && service.version === '1'
      && service.operations.includes('search') && service.resources.some(resource => resource.resourceId === 'search-slot' && resource.capacity === 2 && resource.unit === 'slot')),
      'installed internal daemon projection does not declare the expected file-search service')
    assert(startInternal.services['installed-receiver'].length === 0, 'installed internal receiver projection must not declare services')

    // Public Work submit/query through the installed CLI. The submit must reach
    // the installed receiver daemon, run the installed DAGpipe runner, and return
    // a receipt that keeps the Work identity; the query must observe the original
    // request without executing provider work again.
    const submitA = await run(cli, ['work', 'submit', '--config', configPath, '--receiver', 'installed-receiver', '--payload', '{"query":"needle"}'], { cwd: dirname(configPath), env: cliEnv })
    const receiptA = JSON.parse(submitA.stdout)
    assert(receiptA.status === 'completed', `installed Work submit did not complete: ${submitA.stdout.trim()}`)
    assert(receiptA.control?.workId !== undefined && receiptA.control?.requestId !== undefined, 'installed Work submit did not return Work identity')
    assert(receiptA.control?.providerAgentId === 'installed-provider', `installed Work submit lost the provider identity: ${submitA.stdout.trim()}`)
    assert(receiptA.control?.capabilityId === 'file-search' && receiptA.control?.capabilityVersion === '1', `installed Work submit lost the capability identity: ${submitA.stdout.trim()}`)
    assert(receiptA.control?.requestState === 'succeeded', `installed Work submit requestState=${receiptA.control?.requestState}`)
    assert(typeof receiptA.control?.graphId === 'string' && receiptA.control.graphId.length > 0, 'installed Work submit did not run a DAGpipe graph')
    assert(receiptA.evidence?.execution === 'completed', `installed Work submit evidence=${receiptA.evidence?.execution}`)
    assert(receiptA.business?.status === 'matched' && Array.isArray(receiptA.business?.matches) && receiptA.business.matches.length > 0,
      `installed Work submit did not return a real provider match: ${submitA.stdout.trim()}`)

    const submitB = await run(cli, ['work', 'submit', '--config', configPath, '--receiver', 'installed-receiver', '--payload', '{"query":"second"}'], { cwd: dirname(configPath), env: cliEnv })
    const receiptB = JSON.parse(submitB.stdout)
    assert(receiptB.status === 'completed', `second installed Work submit did not complete: ${submitB.stdout.trim()}`)
    assert(receiptB.control.workId !== receiptA.control.workId && receiptB.control.requestId !== receiptA.control.requestId,
      'a new installed Work submit must use fresh execution identity')

    const query = await run(cli, ['work', 'query', '--config', configPath, '--receiver', 'installed-receiver', '--work-id', receiptA.control.workId, '--request-id', receiptA.control.requestId], { cwd: dirname(configPath), env: cliEnv })
    const observed = JSON.parse(query.stdout)
    assert(observed.status === 'completed', `installed Work query did not complete: ${query.stdout.trim()}`)
    assert(observed.control?.workId === receiptA.control.workId && observed.control?.requestId === receiptA.control.requestId,
      'installed Work query did not return the original Work identity')
    assert(observed.control?.observed === true, 'installed Work query did not report an observation of the original request')
    assert(observed.control?.executionId !== receiptA.control.executionId, 'installed Work query reused the submit execution identity')
    assert(JSON.stringify(observed.business) === JSON.stringify(receiptA.business), 'installed Work query business result differs from the original submit')

    // Persistent Work open/request/query/close through the same installed CLI.
    // open must fix the provider generation from the installed typed status
    // projection because no --provider-generation is passed.
    const demands = '[{"resourceId":"search-slot","amount":1}]'
    const workArgs = (...args) => ['work', ...args, '--config', configPath, '--receiver', 'installed-receiver']
    const opened = JSON.parse((await run(cli, workArgs('open', '--operation', 'search', '--demands', demands, '--payload', '{"query":"needle"}'), { cwd: dirname(configPath), env: cliEnv })).stdout)
    assert(opened.status === 'completed', `installed Work open did not complete: ${JSON.stringify(opened).slice(0, 400)}`)
    assert(opened.control?.workId !== undefined && opened.control?.requestId !== undefined, 'installed Work open did not return Work identity')
    assert(opened.control?.providerAgentId === 'installed-provider', `installed Work open lost the provider identity: ${JSON.stringify(opened.control)}`)
    assert(Number.isSafeInteger(opened.control?.targetGeneration) && opened.control.targetGeneration > 0,
      `installed Work open did not fix a real provider generation from the status projection: ${JSON.stringify(opened.control)}`)
    assert(opened.control?.capabilityId === 'file-search' && opened.control?.capabilityVersion === '1' && opened.control?.operation === 'search',
      `installed Work open did not echo the open binding: ${JSON.stringify(opened.control)}`)
    assert(opened.control?.workClosure === 'retained', `installed Work open closure=${opened.control?.workClosure}`)
    assert(opened.business?.status === 'matched' && opened.business.matches.length > 0, 'installed Work open did not return a real provider match')

    const providerGeneration = String(opened.control.targetGeneration)
    const binding = ['--provider', 'installed-provider', '--provider-generation', providerGeneration,
      '--capability-id', 'file-search', '--capability-version', '1']
    const requested = JSON.parse((await run(cli, workArgs('request', '--work-id', opened.control.workId, ...binding,
      '--operation', 'search', '--demands', demands, '--payload', '{"query":"beta"}'), { cwd: dirname(configPath), env: cliEnv })).stdout)
    assert(requested.status === 'completed', `installed Work request did not complete: ${JSON.stringify(requested).slice(0, 400)}`)
    assert(requested.control?.workId === opened.control.workId, 'installed Work request did not continue the opened Work')
    assert(requested.control?.requestId !== opened.control.requestId, 'installed Work request must use a fresh request identity')
    assert(requested.control?.workClosure === 'retained', `installed Work request closure=${requested.control?.workClosure}`)
    assert(requested.business?.status === 'matched' && requested.business.matches.length > 0, 'installed Work request did not return a real provider match')

    const persistentQuery = JSON.parse((await run(cli, workArgs('query', '--service-selection', 'capability',
      '--work-id', opened.control.workId, '--request-id', requested.control.requestId, ...binding, '--operation', 'search'),
      { cwd: dirname(configPath), env: cliEnv })).stdout)
    assert(persistentQuery.status === 'completed', `installed persistent Work query did not complete: ${JSON.stringify(persistentQuery).slice(0, 400)}`)
    assert(persistentQuery.control?.observed === true && persistentQuery.control?.workId === opened.control.workId,
      'installed persistent Work query did not observe the opened Work')

    const closed = JSON.parse((await run(cli, workArgs('close', '--work-id', opened.control.workId, ...binding, '--operation', 'search'),
      { cwd: dirname(configPath), env: cliEnv })).stdout)
    assert(closed.status === 'completed', `installed Work close did not complete: ${JSON.stringify(closed).slice(0, 400)}`)
    assert(closed.control?.workId === opened.control.workId && closed.control?.workClosure === 'closed',
      `installed Work close did not reach the closed terminal state: ${JSON.stringify(closed.control)}`)

    // An open that can resolve neither an explicit generation nor a published
    // projection must fail before any socket dispatch or provider effect.
    const missingProvider = await runExpectFailure(cli, workArgs('open', '--provider', 'missing-provider', '--operation', 'search', '--payload', '{}'),
      { cwd: dirname(configPath), env: cliEnv })
    assert(missingProvider.includes('published status projection for provider missing-provider'),
      `installed Work open with an unresolvable provider did not fail explicitly: ${missingProvider}`)

    const firstStop = await run(cli, ['stop', '--config', configPath, '--generation', String(activeGeneration)], { cwd: dirname(configPath), env: cliEnv })
    await waitForProcessesGone([startInternal.launcher.pid, ...startInternal.processes.map(process => process.pid)])
    activeGeneration = undefined
    const firstStopped = await run(cli, ['status', '--config', configPath], { cwd: dirname(configPath), env: cliEnv })
    assert(firstStopped.stdout.includes('state=stopped'), 'installed lifecycle did not stop the first generation')

    const restart = await run(cli, ['start', '--config', configPath], { cwd: dirname(configPath), env: cliEnv })
    const restartStatus = await run(cli, ['status', '--config', configPath], { cwd: dirname(configPath), env: cliEnv })
    const restartParsed = parseCliStatus(restartStatus.stdout)
    activeGeneration = restartParsed.generation
    assert(restartParsed.state === 'running' && restartParsed.pid !== undefined && restartParsed.generation !== undefined,
      `installed lifecycle restart did not reach running: ${restartStatus.stdout.trim()}`)
    assert(restartParsed.generation > startParsed.generation, 'installed lifecycle restart generation did not advance')
    const restartInternal = lifecycleState(configPath, installedRootReal)
    assert(restartInternal.launcher.generation === restartParsed.generation, 'installed lifecycle restart generation is inconsistent')
    const startPids = new Set([startInternal.launcher.pid, ...startInternal.processes.map(process => process.pid)])
    for (const pid of [restartInternal.launcher.pid, ...restartInternal.processes.map(process => process.pid)]) {
      assert(!startPids.has(pid), `installed lifecycle restart reused pid=${pid}`)
    }

    const secondStop = await run(cli, ['stop', '--config', configPath, '--generation', String(activeGeneration)], { cwd: dirname(configPath), env: cliEnv })
    await waitForProcessesGone([restartInternal.launcher.pid, ...restartInternal.processes.map(process => process.pid)])
    activeGeneration = undefined
    const secondStopped = await run(cli, ['status', '--config', configPath], { cwd: dirname(configPath), env: cliEnv })
    assert(secondStopped.stdout.includes('state=stopped'), 'installed lifecycle did not stop the restarted generation')

    lifecycle = {
      status: 'passed',
      fixture: { kind: 'v3', note: 'installed v3 user-intent fixture compiled by the installed runtime; internal ports and declarations are read back from internal.toml', ports: startInternal.ports },
      start: { ...startParsed, ...startInternal, command: { stdout: start.stdout, stderr: start.stderr } },
      stop: { generation: startParsed.generation, stdout: firstStop.stdout, stderr: firstStop.stderr },
      restart: { ...restartParsed, ...restartInternal, command: { stdout: restart.stdout, stderr: restart.stderr } },
      work: {
        submit: {
          workId: receiptA.control.workId,
          requestId: receiptA.control.requestId,
          providerAgentId: receiptA.control.providerAgentId,
          capabilityId: receiptA.control.capabilityId,
          capabilityVersion: receiptA.control.capabilityVersion,
          requestState: receiptA.control.requestState,
          graphId: receiptA.control.graphId,
          business: receiptA.business,
        },
        second_submit: { workId: receiptB.control.workId, requestId: receiptB.control.requestId },
        query: { workId: observed.control.workId, requestId: observed.control.requestId, observed: observed.control.observed, business: observed.business },
        persistent: {
          open: {
            workId: opened.control.workId,
            requestId: opened.control.requestId,
            providerAgentId: opened.control.providerAgentId,
            targetGeneration: opened.control.targetGeneration,
            targetGenerationSource: 'typed local daemon status projection',
            capabilityId: opened.control.capabilityId,
            capabilityVersion: opened.control.capabilityVersion,
            operation: opened.control.operation,
            workClosure: opened.control.workClosure,
            business: opened.business,
          },
          request: {
            requestId: requested.control.requestId,
            workId: requested.control.workId,
            workClosure: requested.control.workClosure,
            business: requested.business,
          },
          query: { workId: persistentQuery.control.workId, requestId: persistentQuery.control.requestId, observed: persistentQuery.control.observed },
          close: { workId: closed.control.workId, workClosure: closed.control.workClosure },
          unresolvable_provider_open_failed_before_dispatch: true,
        },
      },
      final_stop: { generation: restartParsed.generation, stdout: secondStop.stdout, stderr: secondStop.stderr },
    }
    return lifecycle
  } finally {
    if (activeGeneration !== undefined) {
      try {
        await run(cli, ['stop', '--config', configPath, '--generation', String(activeGeneration)], { cwd: dirname(configPath), env: cliEnv })
      } catch (error) {
        if (lifecycle === undefined) throw error
      }
    } else {
      try {
        const internalPath = join(dirname(configPath), 'internal.toml')
        const internal = parseToml(readFileSync(internalPath, 'utf8'))
        if (internal.launcher?.pid > 0 && ['running', 'starting'].includes(internal.launcher?.state)) {
          await run(cli, ['stop', '--config', configPath, '--generation', String(internal.launcher.generation)], { cwd: dirname(configPath), env: cliEnv })
        }
      } catch { /* preserve the original lifecycle failure and let the outer receipt record it */ }
    }
  }
}

function consoleScript() {
  return String.raw`
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
  command: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'smoke owner denial' } }),
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
  authorize = createConsoleAuthorization({ username: 'smoke-user', password: 'smoke-pass', origin, client })
  const authorization = 'Basic ' + Buffer.from('smoke-user:smoke-pass').toString('base64')
  const unauthorized = await fetch(origin)
  assert.equal(unauthorized.status, 401)
  assert.match(unauthorized.headers.get('www-authenticate') ?? '', /Basic/)
  const page = await fetch(origin, { headers: { authorization } })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), readFileSync(packageRoot + '/console-host/static/console.html', 'utf8'))
  const entry = await fetch(origin + '/console-entry.js', { headers: { authorization } })
  assert.equal(entry.status, 200)
  assert.equal(entry.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const browser = await fetch(origin + '/ui/browser.js', { headers: { authorization } })
  assert.equal(browser.status, 200)
  assert.equal(browser.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const icon = await fetch(origin + '/ui/assets/agentbrowser-icon.jpg', { headers: { authorization } })
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('content-type'), 'image/jpeg')
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
}

export async function runPackageUserSmoke(options = {}) {
  const packRoot = resolve(options.packRoot ?? defaultPackRoot)
  const evidenceDir = resolve(options.evidenceDir ?? defaultEvidenceDir)
  const receiptName = options.receiptName ?? 'package-user-smoke.receipt.json'
  const receiptPath = options.receiptPath ? resolve(options.receiptPath) : join(evidenceDir, receiptName)
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert(existsSync(join(packRoot, 'package.json')), `pack root is missing: ${packRoot}`)
  const packPackage = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8'))
  assert(packPackage.version === rootPackage.version, `pack root version ${packPackage.version} does not match root ${rootPackage.version}`)
  const packageReceiptPath = resolve(packRoot, '..', 'package-receipt.json')
  const packageReceipt = JSON.parse(readFileSync(packageReceiptPath, 'utf8'))
  assert(packageReceipt.mode === 'base' || packageReceipt.mode === 'final',
    `staged package receipt mode must be base or final, got ${packageReceipt.mode}`)
  assertCandidateIdentity(packageReceipt.candidate, currentCandidateIdentity(root), 'staged package')
  assert(packageReceipt.pack_root === relative(root, packRoot).split(sep).join('/'),
    `staged package receipt pack root ${packageReceipt.pack_root} does not match ${packRoot}`)
  const packContent = hashDirectory(packRoot)
  const packFiles = listFiles(packRoot)
  assert(packageReceipt.content_sha256 === packContent.sha256,
    `staged package receipt content ${packageReceipt.content_sha256} does not match pack ${packContent.sha256}`)

  // Keep the installed HOME's Unix control socket within macOS sun_path.
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'at'))
  const prefix = join(temporaryRoot, 'prefix')
  const testHome = join(temporaryRoot, 'home')
  const npmCache = join(temporaryRoot, 'npm-cache')
  const packDestination = join(temporaryRoot, 'pack')
  mkdirSync(testHome, { recursive: true })
  mkdirSync(prefix, { recursive: true })
  mkdirSync(npmCache, { recursive: true })
  mkdirSync(packDestination, { recursive: true })

  let receipt
  try {
    const npmEnv = { ...process.env, HOME: testHome, npm_config_cache: npmCache }
    const packed = await run('npm', ['pack', packRoot, '--pack-destination', packDestination, '--json'], {
      cwd: temporaryRoot,
      env: npmEnv,
    })
    const packResult = JSON.parse(packed.stdout)[0]
    const tarball = join(packDestination, packResult.filename)
    const tarballSha256 = hashFile(tarball)
    const tarballFiles = packResult.files.map(file => typeof file === 'string' ? file : file.path).sort()
    assert(!tarballFiles.some(file => file.startsWith('node_modules/')), 'tarball contains node_modules')
    assert(!tarballFiles.some(file => file.endsWith('.spec.ts')), 'tarball contains test sources')
    assert(tarballFiles.includes('generated/runtime-lib/runtime/local-process.js'), 'tarball is missing compiled runtime')
    assert(tarballFiles.includes('console-host/lib/index.mjs'), 'tarball is missing Console library')
    assert(tarballFiles.includes('ui/teams-console/index.js'), 'tarball is missing UI entry')
    const tarballContentSha256 = hashFileSet(packRoot, tarballFiles)
    assert(tarballContentSha256 === packContent.sha256,
      `tarball file content ${tarballContentSha256} does not match staged pack content ${packContent.sha256}`)

    await run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-package-lock', '--no-save', tarball], {
      cwd: temporaryRoot,
      env: npmEnv,
    })

    const installedRoot = join(prefix, 'node_modules', 'agentteams')
    const installedRootReal = realpathSync(installedRoot)
    const installedPackage = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))
    assert(installedPackage.version === rootPackage.version, 'installed package version does not match root version')
    const cli = join(prefix, 'node_modules', '.bin', 'agentteams')
    const cliRealpath = realpathSync(cli)
    assert(cliRealpath.startsWith(installedRootReal + sep), `installed CLI escaped package root: ${cliRealpath}`)
    assert(cliRealpath !== join(root, 'cli', 'agentteams.mjs'), 'installed CLI resolved to source tree')
    const installedBytes = hashDirectory(installedRoot)
    assert(installedBytes.sha256 === packContent.sha256,
      `installed content ${installedBytes.sha256} does not match staged pack content ${packContent.sha256}`)

    const cliEnv = {
      ...process.env,
      HOME: testHome,
      AGENTTEAMS_INSTALLED_PROVIDER_AUTH: 'fixture-provider',
      AGENTTEAMS_INSTALLED_RECEIVER_AUTH: 'fixture-receiver',
    }
    const init = await run(cli, ['init'], { cwd: temporaryRoot, env: cliEnv })
    const status = await run(cli, ['status'], { cwd: temporaryRoot, env: cliEnv })
    const stop = await run(cli, ['stop'], { cwd: temporaryRoot, env: cliEnv })
    assert(init.stdout.includes('initialized'), 'installed CLI init did not report initialization')
    assert(status.stdout.includes('state=stopped'), 'installed CLI status did not report stopped state')
    assert(stop.stdout.includes('state=stopped'), 'installed CLI stop did not report stopped state')
    assert(existsSync(join(testHome, '.agentteams', 'config.toml')), 'installed CLI did not create the isolated HOME config')

    const console = await run(process.execPath, ['--input-type=module', '--eval', consoleScript()], {
      cwd: temporaryRoot,
      env: { ...process.env, AGENTTEAMS_INSTALLED_PACKAGE_ROOT: installedRoot },
    })
    const consoleResult = JSON.parse(console.stdout.trim())
    assert(consoleResult.unauthorized === 401, 'Console did not reject the unauthenticated request')
    assert(consoleResult.page === 200 && consoleResult.consoleEntry === 200 && consoleResult.browser === 200 && consoleResult.icon === 200,
      'Console did not serve authenticated public assets')
    assert(consoleResult.crossSite === 401, 'Console did not reject a cross-site request')

    receipt = {
      schema_version: 1,
      mode: packageReceipt.mode,
      release_eligible: false,
      candidate: packageReceipt.candidate,
      package: { name: installedPackage.name, version: installedPackage.version, pack_root: relative(root, packRoot).split(sep).join('/') },
      pack: { root: relative(root, packRoot).split(sep).join('/'), content_sha256: packContent.sha256, files: packFiles },
      tarball: { filename: packResult.filename, sha256: tarballSha256, content_sha256: tarballContentSha256, files: tarballFiles },
      install: { prefix, cli_realpath: cliRealpath, installed_content_sha256: installedBytes.sha256, installed_files: installedBytes.files },
      cli: {
        init: { stdout: init.stdout, stderr: init.stderr },
        status: { stdout: status.stdout, stderr: status.stderr },
        stop: { stdout: stop.stdout, stderr: stop.stderr },
      },
      console: consoleResult,
      cleanup: { temporary_root: temporaryRoot, removed: false },
    }
    if (options.includeInstalledLifecycle === true) {
      receipt.lifecycle = await runInstalledLifecycle({
        cli,
        cliEnv,
        configPath: join(testHome, '.agentteams', 'config.toml'),
        installedRootReal,
      })
      receipt.lifecycle_scope = {
        entrypoint: 'installed npm tarball CLI start/status/stop',
        fixture: 'v3-user-intent-config-compiled-by-installed-runtime',
        final_user_config_evidence: false,
      }
    } else {
      receipt.lifecycle = { status: 'not_run', reason: 'base asset/CLI smoke only; no daemon start or restart was requested' }
    }
  } catch (error) {
    receipt = {
      schema_version: 1,
      mode: packageReceipt.mode,
      release_eligible: false,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      cleanup: { temporary_root: temporaryRoot, removed: false },
    }
    throw error
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
    if (receipt !== undefined) {
      receipt.cleanup.removed = !existsSync(temporaryRoot)
      writeReceipt(receiptPath, receipt)
    }
  }
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPackageUserSmoke(parseOptions(process.argv.slice(2)))
    .then(() => console.log('Package user smoke passed: installed CLI and Console consumers verified.'))
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
