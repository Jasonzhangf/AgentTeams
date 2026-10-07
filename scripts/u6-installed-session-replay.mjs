import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { currentCandidateIdentity } from './receipt-identity.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const defaultPackRoot = resolve(root, 'generated', 'modules', 'teams-source', 'lib')
const defaultEvidenceDir = resolve(root, 'generated', 'u6-session-replay', `${Date.now()}-${process.pid}`)
const providerSentinel = 'managed-provider-ok'
const consoleUsername = 'u6-console'
const consolePasswordEnv = 'AGENTTEAMS_U6_CONSOLE_PASSWORD'
const consolePassword = 'u6-console-pass'
const openCodeExecutable = '/Users/fanzhang/.opencode/bin/opencode'
// Local relay admission credentials. The v3 projection derives these env names from
// the agent id (`runtime/local-config.ts:1267`) and the Console uses its own fixed
// name; the values only exist in this process environment and the isolated HOME.
const relayCredentials = {
  AGENTTEAMS_SESSION_AGENT_AUTH: 'u6-session-agent-credential',
  AGENTTEAMS_PASSIVE_AGENT_AUTH: 'u6-passive-agent-credential',
  AGENTTEAMS_CONSOLE_AUTH: 'u6-console-credential',
}

function fail(message) {
  throw new Error(`installed Session replay: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
  return digest.digest('hex')
}

function parseOptions(argv) {
  const options = { packRoot: defaultPackRoot, evidenceDir: defaultEvidenceDir, receiptPath: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${argument} requires a value`)
      index += 1
      return next
    }
    if (argument === '--pack-root') options.packRoot = resolve(value())
    else if (argument === '--evidence-dir') options.evidenceDir = resolve(value())
    else if (argument === '--receipt-path') options.receiptPath = resolve(value())
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

async function run(command, args, options = {}, allowFailure = false) {
  try {
    const result = await execFileAsync(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 })
    return { command, args, exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const result = {
      command,
      args,
      exitCode: error?.code ?? 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
      error: error?.message ?? String(error),
    }
    if (allowFailure) return result
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || result.error}`)
  }
}

function parseCliStatus(stdout) {
  const field = name => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, 'u').exec(stdout)?.[1]
  return {
    state: field('state'),
    generation: Number(field('generation')),
    pid: Number(field('pid')),
  }
}

function parseCliConsole(stdout) {
  const fields = {}
  for (const token of stdout.trim().split(/\s+/u)) {
    const equals = token.indexOf('=')
    if (equals > 0) fields[token.slice(0, equals)] = token.slice(equals + 1)
  }
  return fields
}

async function httpResponse(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, headers: Object.fromEntries(response.headers), body, text }
}

async function httpJson(url, options = {}, expectedStatus = 200) {
  const response = await httpResponse(url, options)
  assert(response.status === expectedStatus,
    `${options.method ?? 'GET'} ${url} returned ${response.status}, expected ${expectedStatus}: ${response.text.slice(0, 400)}`)
  return response
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = () => {
      try {
        const value = predicate()
        if (value !== undefined) return resolvePromise(value)
        if (Date.now() >= deadline) return rejectPromise(new Error(`installed Session replay: timed out waiting for ${label}`))
        setTimeout(poll, 50)
      } catch (error) { rejectPromise(error) }
    }
    poll()
  })
}

async function waitForAsync(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) fail(`timed out waiting for ${label}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
}

/** Like waitForAsync, but a timeout is an observable absence rather than a failure. */
async function optionalWait(probe, timeoutMs) {
  try { return await waitForAsync(probe, timeoutMs, 'an optional observation') } catch { return undefined }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function readInternal(configPath) {
  const text = readFileSync(join(dirname(configPath), 'internal.toml'), 'utf8')
  return text
}

function internalDaemonPids(configPath) {
  const parsed = readInternal(configPath)
  const section = parsed.match(/\[daemon\.([^\]]+)\]([\s\S]*?)(?=\n\[|$)/gu) ?? []
  return section.flatMap(match => {
    const id = /\[daemon\.([^\]]+)\]/u.exec(match)?.[1]?.replaceAll('"', '')
    const pid = Number(/pid\s*=\s*(\d+)/u.exec(match)?.[1])
    if (id === undefined || !Number.isSafeInteger(pid) || pid <= 0) return []
    return [{ id, pid }]
  })
}

function fixtureConfigText(providerBaseUrl) {
  return `version = 3

[bridge]
enabled = true

[agents.session-agent]
enabled = true
role = "provider"
label = "U6 Session Agent"

[agents.session-agent.identity]
hostId = "u6-host"
machineId = "u6-machine"
accountId = "local"
agentKind = "custom"
label = "U6 Session Agent"

[agents.session-agent.runtime]
scopeId = "local"
dataDirectory = "data/session-agent"
policy = { revision = 1, allowedConsumers = [], allowedManagers = ["__console"] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-u6-session-agent" }

[agents.passive-agent]
enabled = true
role = "provider"
label = "U6 Passive Agent"

[agents.passive-agent.identity]
hostId = "u6-host"
machineId = "u6-machine"
accountId = "local"
agentKind = "custom"
label = "U6 Passive Agent"

[agents.passive-agent.runtime]
scopeId = "local"
dataDirectory = "data/passive-agent"
policy = { revision = 1, allowedConsumers = [], allowedManagers = ["__console"] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/rg", searchRoot = "files", profilePrefix = "teams-u6-passive-agent" }

[console]
enabled = true
username = ${JSON.stringify(consoleUsername)}
passwordEnv = ${JSON.stringify(consolePasswordEnv)}
agentIds = ["session-agent", "passive-agent"]

[providers.u6-local]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(`${providerBaseUrl}/v1`)}
label = "U6 Local Provider"
enabled = true

[[models]]
provider = "u6-local"
id = "u6-model"
label = "U6 Model"

[agents.session-agent.model]
primary = { provider = "u6-local", model = "u6-model" }
`
}

// The cancel case needs one genuinely active request, so a prompt carrying this
// marker is answered by an intentionally open response the replay ends by itself.
const holdPromptMarker = 'u6-hold-open'
const toolPromptMarker = 'u6-tool-probe'

function createProviderStub() {
  const requests = []
  const held = []
  const server = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404)
      response.end()
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(body)
      const input = JSON.parse(body)
      if (body.includes(holdPromptMarker)) {
        held.push(response)
        return
      }
      const toolCall = { index: 0, id: 'call_u6_probe', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'printf u6-tool-probe-ran' }) } }
      if (body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (body.includes(toolPromptMarker)) {
          response.write(`data: ${JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion.chunk', created: 1, model: input.model,
            choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion.chunk', created: 1, model: input.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
        } else {
          response.write(`data: ${JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion.chunk', created: 1, model: input.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: providerSentinel }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion.chunk', created: 1, model: input.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
        }
        response.end('data: [DONE]\n\n')
      } else if (body.includes(toolPromptMarker)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion', created: 1, model: input.model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion', created: 1, model: input.model,
          choices: [{ index: 0, message: { role: 'assistant', content: providerSentinel }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
    })
  })
  return { server, requests, held }
}

function createInstalledReplay() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'u6rs-'))
  const testHome = join(temporaryRoot, 'home')
  const npmCache = join(temporaryRoot, 'npm-cache')
  const packDestination = join(temporaryRoot, 'pack')
  const prefix = join(temporaryRoot, 'prefix')
  mkdirSync(testHome, { recursive: true, mode: 0o700 })
  mkdirSync(npmCache, { recursive: true, mode: 0o700 })
  mkdirSync(packDestination, { recursive: true, mode: 0o700 })
  mkdirSync(prefix, { recursive: true, mode: 0o700 })
  return { temporaryRoot, testHome, npmCache, packDestination, prefix }
}

async function installPackage(packRoot, paths) {
  const npmEnv = { ...process.env, HOME: paths.testHome, npm_config_cache: paths.npmCache }
  const packed = await run('npm', ['pack', packRoot, '--pack-destination', paths.packDestination, '--json'], {
    cwd: paths.temporaryRoot,
    env: npmEnv,
  })
  const packResult = JSON.parse(packed.stdout)[0]
  const tarball = join(paths.packDestination, packResult.filename)
  const tarballSha256 = hashFile(tarball)
  await run('npm', ['install', '--prefix', paths.prefix, '--no-audit', '--no-fund', '--no-package-lock', '--no-save', tarball], {
    cwd: paths.temporaryRoot,
    env: npmEnv,
  })
  const installedRoot = join(paths.prefix, 'node_modules', 'agentteams')
  const installedRootReal = realpathSync(installedRoot)
  return {
    tarball,
    tarballSha256,
    installedRoot,
    installedRootReal,
    installedContentSha256: hashDirectory(installedRoot),
    cli: join(paths.prefix, 'node_modules', '.bin', 'agentteams'),
    files: packResult.files.map(file => typeof file === 'string' ? file : file.path).sort(),
  }
}

function createConsoleClient(consoleUrl, authorization) {
  const request = (path, body, method = 'POST') => httpJson(`${consoleUrl}${path}`, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    request,
    projection: () => request('/api/v1/projection', undefined, 'GET'),
    command: command => request('/api/v1/command', command),
    sessionMessage: (agentId, sessionId, payload) =>
      request(`/api/v1/session-message?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`, payload),
  }
}

function readEvents(projection, agentId, sessionId) {
  return projection.sessionEvents?.filter(event => event.agentId === agentId && event.sessionId === sessionId) ?? []
}

function cancelConfirmed(result) {
  return result?.ok === true && result.result?.kind === 'session.cancel' && result.result.finalState === 'cancelled'
}

function cancelUnknown(result) {
  return result?.ok === false && result.error?.code === 'RESULT_UNKNOWN'
    && result.error.detail?.kind === 'session.cancel' && result.error.detail.finalState === 'unknown'
}

function publicReceiptJson(value) {
  return JSON.parse(JSON.stringify(value))
}

export async function runInstalledSessionReplay(options = {}) {
  const packRoot = resolve(options.packRoot ?? defaultPackRoot)
  const evidenceDir = resolve(options.evidenceDir ?? defaultEvidenceDir)
  const receiptPath = resolve(options.receiptPath ?? join(evidenceDir, 'u6-installed-session-replay.receipt.json'))
  mkdirSync(evidenceDir, { recursive: true })
  const packageReceiptPath = resolve(packRoot, '..', 'package-receipt.json')
  const packageReceipt = JSON.parse(readFileSync(packageReceiptPath, 'utf8'))
  const candidate = currentCandidateIdentity(root)
  assert(packageReceipt.pack_root === relative(root, packRoot).split(sep).join('/'),
    `staged package receipt pack_root ${packageReceipt.pack_root} does not match ${relative(root, packRoot).split(sep).join('/')}`)
  assert(packageReceipt.candidate?.head_commit === candidate.head_commit
    && packageReceipt.candidate?.tree_hash === candidate.tree_hash,
  `staged package receipt does not bind the current candidate: ${JSON.stringify(packageReceipt.candidate)}`)

  const paths = createInstalledReplay()
  const provider = createProviderStub()
  const receipt = {
    kind: 'u6-installed-session-replay',
    version: 1,
    status: 'failed',
    candidate: { ...candidate },
    package: {
      pack_root: relative(root, packRoot).split(sep).join('/'),
      content_sha256: packageReceipt.content_sha256,
    },
    install: {},
    provider: { base_url: '', sentinel: providerSentinel },
    cases: {},
    pids: {},
    cleanup: {},
  }
  let started = false
  let cli
  let cliEnv
  let configPath
  try {
    const installed = await installPackage(packRoot, paths)
    cli = installed.cli
    assert(installed.installedContentSha256 === packageReceipt.content_sha256,
      `installed content ${installed.installedContentSha256} does not match staged package ${packageReceipt.content_sha256}`)
    assert(installed.files.includes('generated/runtime-lib/runtime/local-process.js'), 'tarball is missing compiled runtime')
    assert(!installed.files.some(file => file.endsWith('.spec.ts')), 'tarball contains test sources')
    receipt.install = {
      prefix: paths.prefix,
      home: paths.testHome,
      cli: installed.cli,
      installed_root: installed.installedRoot,
      installed_root_real: installed.installedRootReal,
      installed_content_sha256: installed.installedContentSha256,
    }
    receipt.package.tarball_sha256 = installed.tarballSha256
    receipt.package.tarball = relative(paths.temporaryRoot, installed.tarball).split(sep).join('/')

    await new Promise((resolveListen, rejectListen) => provider.server.listen(0, '127.0.0.1', error => error ? rejectListen(error) : resolveListen()))
    const providerAddress = provider.server.address()
    assert(providerAddress && typeof providerAddress === 'object', 'provider stub did not bind a loopback port')
    const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}`
    receipt.provider.base_url = providerBaseUrl

    cliEnv = {
      ...process.env,
      HOME: paths.testHome,
      AGENTTEAMS_OPENCODE_EXECUTABLE: openCodeExecutable,
      [consolePasswordEnv]: consolePassword,
      ...relayCredentials,
    }
    configPath = join(paths.testHome, '.agentteams', 'config.toml')
    const initialized = await run(cli, ['init'], { cwd: paths.temporaryRoot, env: cliEnv })
    writeFileSync(configPath, fixtureConfigText(providerBaseUrl), { encoding: 'utf8', mode: 0o600 })
    const configShaBefore = hashFile(configPath)
    receipt.cases.initialization = {
      status: 'passed',
      stdout: initialized.stdout.trim(),
      config_path: configPath,
      config_sha256_before_start: configShaBefore,
    }

    const start = await run(cli, ['start', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv })
    started = true
    const status = parseCliStatus((await run(cli, ['status', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv })).stdout)
    assert(status.state === 'running' && status.pid > 0, `installed start/status is not running: ${JSON.stringify(status)}`)
    const daemonPids = internalDaemonPids(configPath)
    receipt.pids = { launcher: status.pid, daemons: daemonPids }
    receipt.cases.lifecycle = { status: 'passed', generation: status.generation, stdout: start.stdout.trim(), daemonPids }

    const consoleStartRaw = (await run(cli, ['console', 'start', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv })).stdout
    const consoleStatus = parseCliConsole(consoleStartRaw)
    assert(consoleStatus.consoleState === 'online' && typeof consoleStatus.consoleUrl === 'string',
      `installed console did not start online: ${consoleStartRaw.trim()}`)
    const consoleUrl = consoleStatus.consoleUrl
    const consolePid = Number(consoleStatus.consolePid)
    receipt.pids.console = consolePid
    const authorization = 'Basic ' + Buffer.from(`${consoleUsername}:${consolePassword}`).toString('base64')
    const client = createConsoleClient(consoleUrl, authorization)

    const unauthenticated = await httpResponse(consoleUrl)
    const crossSite = await httpResponse(consoleUrl, { headers: { authorization, 'sec-fetch-site': 'cross-site' } })
    assert(unauthenticated.status === 401 && crossSite.status === 401, 'installed Console auth/origin gate did not return 401')
    receipt.cases.console = { status: 'passed', url: consoleUrl, pid: consolePid, unauthenticated: unauthenticated.status, crossSite: crossSite.status }

    const projection = (await client.projection()).body
    const sessionAgent = projection.agents.find(agent => agent.agentId === 'session-agent')
    const passiveAgent = projection.agents.find(agent => agent.agentId === 'passive-agent')
    assert(sessionAgent?.kind === 'runtime' && sessionAgent.sessionCapable === true,
      `session-agent is not sessionCapable: ${JSON.stringify(sessionAgent)}`)
    assert(passiveAgent?.kind === 'runtime' && passiveAgent.sessionCapable === false,
      `passive-agent is not passive: ${JSON.stringify(passiveAgent)}`)
    receipt.cases.discovery = { status: 'passed', sessionAgent: publicReceiptJson(sessionAgent), passiveAgent: publicReceiptJson(passiveAgent) }

    const created = await client.command({ kind: 'session.create', agentId: 'session-agent', title: 'U6 installed replay' })
    assert(created.body.ok === true && created.body.result?.kind === 'session.create'
      && typeof created.body.result.sessionId === 'string',
    `session.create did not return a typed Session result: ${JSON.stringify(created.body)}`)
    const sessionId = created.body.result.sessionId
    receipt.cases['session.create'] = { status: 'passed', result: publicReceiptJson(created.body) }

    const opened = await client.command({ kind: 'session.open', agentId: 'session-agent', sessionId })
    assert(opened.body.ok === true, `session.open failed: ${JSON.stringify(opened.body)}`)
    const hydrated = (await client.projection()).body
    assert(hydrated.sessions.some(session => session.agentId === 'session-agent' && session.sessionId === sessionId),
      'session.open did not hydrate the bounded projection')
    receipt.cases['session.open'] = {
      status: 'passed',
      result: publicReceiptJson(opened.body),
      sessions: publicReceiptJson(hydrated.sessions.filter(session => session.agentId === 'session-agent')),
    }

    // (d) One real message round trip through the installed Console HTTP ingress,
    // the Agent relay, the real ManagedConfigOwner and the managed OpenCode child.
    const sent = await client.sessionMessage('session-agent', sessionId, { text: 'u6 probe request' })
    assert(sent.body.ok === true, `session.send failed: ${JSON.stringify(sent.body)}`)
    const assistantPart = await waitForAsync(async () => readEvents((await client.projection()).body, 'session-agent', sessionId)
      .find(event => event.kind === 'part' && event.partType === 'text' && typeof event.text === 'string' && event.text.includes(providerSentinel)),
    120_000, 'the managed OpenCode assistant text part')
    assert(provider.requests.some(body => body.includes('u6 probe request')),
      'the managed OpenCode child never reached the local provider stub')
    receipt.cases['session.send'] = {
      status: 'passed',
      result: publicReceiptJson(sent.body),
      provider_requests: provider.requests.length,
      assistant_part: publicReceiptJson(assistantPart),
    }

    // (e) A real tool request, then approve/reject on a real permission when the
    // managed child surfaces one. Absence is recorded as unverified, never faked.
    const toolSent = await client.sessionMessage('session-agent', sessionId, { text: `u6 tool request ${toolPromptMarker}` })
    assert(toolSent.body.ok === true, `tool probe send failed: ${JSON.stringify(toolSent.body)}`)
    const toolEvent = await optionalWait(async () => readEvents((await client.projection()).body, 'session-agent', sessionId)
      .find(event => event.kind === 'tool'), 60_000)
    const pendingPermission = await optionalWait(async () => readEvents((await client.projection()).body, 'session-agent', sessionId)
      .find(event => event.kind === 'permission' && event.state === 'pending'), 30_000)
    const permissionReceipt = { status: 'unverified', tool_event: toolEvent === undefined ? null : publicReceiptJson(toolEvent),
      reason: 'the managed OpenCode child surfaced no pending permission for the probe tool call' }
    if (pendingPermission !== undefined) {
      const approved = await client.command({ kind: 'permission.reply', agentId: 'session-agent', sessionId,
        permissionId: pendingPermission.permissionId, decision: 'once' })
      assert(approved.body.ok === true, `permission approve failed: ${JSON.stringify(approved.body)}`)
      const resolved = await waitForAsync(async () => readEvents((await client.projection()).body, 'session-agent', sessionId)
        .find(event => event.kind === 'permission' && event.state === 'resolved'
          && event.permissionId === pendingPermission.permissionId), 60_000, 'the resolved permission event')
      assert(resolved.decision === 'once', `approved permission resolved with ${String(resolved.decision)}`)
      permissionReceipt.status = 'passed'
      permissionReceipt.approved = publicReceiptJson(resolved)
      delete permissionReceipt.reason
    } else {
      // The typed refusal boundary still has to be observable on the same entry.
      const fabricated = await client.command({ kind: 'permission.reply', agentId: 'session-agent', sessionId,
        permissionId: 'u6-missing-permission', decision: 'once' })
      assert(fabricated.body.ok === false && typeof fabricated.body.error?.code === 'string',
        `permission.reply on an unknown permission was not a typed refusal: ${JSON.stringify(fabricated.body)}`)
      permissionReceipt.unknown_permission_refusal = publicReceiptJson(fabricated.body)
    }
    receipt.cases.permission = permissionReceipt

    // (f) Cancel a genuinely active request; the base acceptance plus the correlated
    // final/unknown must be preserved and abort=true must never be written as final.
    const heldSend = await client.sessionMessage('session-agent', sessionId, { text: `u6 held prompt ${holdPromptMarker}` })
    assert(heldSend.body.ok === true, `held send failed: ${JSON.stringify(heldSend.body)}`)
    await waitForAsync(async () => provider.requests.some(body => body.includes(holdPromptMarker)) ? true : undefined,
      60_000, 'the held prompt to reach the local provider stub')
    const cancelled = await client.command({ kind: 'session.cancel', agentId: 'session-agent', sessionId })
    assert(cancelConfirmed(cancelled.body) || cancelUnknown(cancelled.body),
      `session.cancel was neither a confirmed cancel nor a typed unknown: ${JSON.stringify(cancelled.body)}`)
    receipt.cases['session.cancel'] = {
      status: 'passed',
      variant: cancelConfirmed(cancelled.body) ? 'confirmed' : 'unknown',
      result: publicReceiptJson(cancelled.body),
    }
    for (const response of provider.held.splice(0)) { try { response.destroy() } catch { /* the child is already gone */ } }

    // (g) A passive Agent must refuse Session explicitly instead of degrading.
    const passiveCreate = await client.command({ kind: 'session.create', agentId: 'passive-agent' })
    assert(passiveCreate.body.ok === false && passiveCreate.body.error?.code === 'UNSUPPORTED_OPERATION',
      `passive Agent session.create was not a typed refusal: ${JSON.stringify(passiveCreate.body)}`)
    const passiveSend = await client.sessionMessage('passive-agent', sessionId, { text: 'u6 passive probe' })
    assert(passiveSend.body.ok === false && passiveSend.body.error?.code === 'UNSUPPORTED_OPERATION',
      `passive Agent session.send was not a typed refusal: ${JSON.stringify(passiveSend.body)}`)
    receipt.cases['passive-refusal'] = { status: 'passed', create: publicReceiptJson(passiveCreate.body), send: publicReceiptJson(passiveSend.body) }

    // (h) A payload outside the closed Session envelope fails at the boundary.
    const unsupported = await client.sessionMessage('session-agent', sessionId, { bogus: 'field' })
    assert(unsupported.body.ok === false && unsupported.body.error?.code === 'INVALID_INPUT',
      `unsupported Session payload was not a typed refusal: ${JSON.stringify(unsupported.body)}`)
    receipt.cases['unsupported-payload'] = { status: 'passed', result: publicReceiptJson(unsupported.body) }

    // (j) Console is optional: stopping it must not disturb the Agent lifecycle.
    await run(cli, ['console', 'stop', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv })
    let consoleReachable = true
    try { await fetch(consoleUrl, { signal: AbortSignal.timeout(3000) }) } catch { consoleReachable = false }
    assert(!consoleReachable, 'the installed Console still answered after console stop')
    const offlineStatus = parseCliStatus((await run(cli, ['status', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv })).stdout)
    assert(offlineStatus.state === 'running' && offlineStatus.pid === status.pid,
      `the Agent lifecycle did not survive Console shutdown: ${JSON.stringify(offlineStatus)}`)
    const offlineDaemons = internalDaemonPids(configPath)
    assert(offlineDaemons.length === daemonPids.length && offlineDaemons.every(daemon => processAlive(daemon.pid)),
      `owned daemons did not survive Console shutdown: ${JSON.stringify(offlineDaemons)}`)
    receipt.cases['console-offline'] = { status: 'passed', console_reachable: consoleReachable,
      launcher_state: offlineStatus.state, daemon_pids: offlineDaemons }

    // (i) A stale launcher generation must be refused and user intent must survive restart.
    const stopped = await run(cli, ['stop', '--config', configPath, '--generation', String(status.generation)],
      { cwd: paths.temporaryRoot, env: cliEnv })
    assert(stopped.exitCode === 0, `stop at the active generation failed: ${stopped.stderr.trim()}`)
    await run(cli, ['start', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv })
    const restarted = parseCliStatus((await run(cli, ['status', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv })).stdout)
    assert(restarted.generation > status.generation, `restart did not advance the generation: ${JSON.stringify(restarted)}`)
    const stale = await run(cli, ['console', 'stop', '--config', configPath, '--generation', String(status.generation)],
      { cwd: paths.temporaryRoot, env: cliEnv }, true)
    assert(stale.exitCode !== 0 && /stale launcher generation/u.test(`${stale.stderr}${stale.stdout}`),
      `a stale launcher generation was not refused: exit=${stale.exitCode} out=${stale.stderr.trim()}${stale.stdout.trim()}`)
    assert(hashFile(configPath) === configShaBefore, 'config.toml changed across the restart; user intent was not the only editable source')
    receipt.cases['stale-generation'] = { status: 'passed', previous_generation: status.generation, generation: restarted.generation,
      stale_refusal: (stale.stderr || stale.stdout).trim(), config_sha256_after_restart: hashFile(configPath) }

    // (k) Clean stop: every owned process exits and the user config is untouched.
    const finalStop = await run(cli, ['stop', '--config', configPath, '--generation', String(restarted.generation)],
      { cwd: paths.temporaryRoot, env: cliEnv })
    assert(finalStop.exitCode === 0, `final stop failed: ${finalStop.stderr.trim()}`)
    const ownedPids = [status.pid, ...daemonPids.map(daemon => daemon.pid)]
    await waitForAsync(async () => ownedPids.every(pid => !processAlive(pid)) ? true : undefined, 20_000, 'owned processes to exit')
    assert(!processAlive(consolePid), 'the Console process outlived stop')
    assert(hashFile(configPath) === configShaBefore, 'config.toml changed across the replay')
    receipt.cases['clean-stop'] = { status: 'passed', stopped: ownedPids, console_pid: consolePid,
      config_sha256_before_start: configShaBefore, config_sha256_after_stop: hashFile(configPath) }
    receipt.status = 'passed'
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error)
  } finally {
    for (const response of provider.held.splice(0)) { try { response.destroy() } catch { /* already closed */ } }
    try { await new Promise(resolveClose => provider.server.close(() => resolveClose())) } catch { /* already closed */ }
    if (started) {
      try { await run(cli, ['stop', '--config', configPath], { cwd: paths.temporaryRoot, env: cliEnv }, true) } catch { /* best effort */ }
    }
    const leaked = [...(receipt.pids.daemons ?? []).map(daemon => daemon.pid), receipt.pids.launcher, receipt.pids.console]
      .filter(pid => processAlive(pid))
    receipt.cleanup = { temporary_root: paths.temporaryRoot, leaked_pids: leaked, config_sha256: configPath === undefined ? undefined : hashFile(configPath) }
    try { rmSync(paths.temporaryRoot, { recursive: true, force: true }) } catch { /* the receipt records the primary result */ }
    receipt.cleanup.temporary_root_removed = !existsSync(paths.temporaryRoot)
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8' })
  }
  return receipt
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const receipt = await runInstalledSessionReplay(parseOptions(process.argv.slice(2)))
  console.log(`u6-installed-session-replay ${receipt.status}`)
  console.log(JSON.stringify({ status: receipt.status, error: receipt.error, cases: Object.keys(receipt.cases) }))
  process.exitCode = receipt.status === 'passed' ? 0 : 1
}
