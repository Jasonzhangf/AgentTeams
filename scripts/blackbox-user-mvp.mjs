#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
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
// The password value is registered with the evidence boundary so no evidence
// sink can persist it; only the user name, env name and length stay recordable.
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
  // Every thrown driver error passes through here, so any subprocess text a
  // caller embedded is replaced by the safe substitute before it becomes an
  // `Error.message`. A clean message is returned unchanged.
  throw new Error(`blackbox-user-mvp: ${safeSubprocessText(String(message), 'thrown-error')}`)
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

// ---------------------------------------------------------------------------
// Single evidence boundary. One run-level, in-memory registry of the sensitive
// values this run provisioned, plus one detection/rejection implementation that
// every evidence sink funnels through. The registry is never serialized and the
// values are only ever used for exact containment checks.
// ---------------------------------------------------------------------------

const EVIDENCE_BOUNDARY_PREFIX = 'blackbox-user-mvp: evidence boundary rejected'

// Auth-field JSON keys are matched case-insensitively with `_`/`-`/space
// variants collapsed. These name a material value; public references such as
// `auth.kind`, `credentialRef`, `auth_alias`, `secret_key`, `secret_file` and
// `credential_env` are deliberately absent and stay recordable.
const evidenceAuthFieldKeys = new Set([
  'authorization',
  'proxyauthorization',
  'xapikey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'password',
  'clientsecret',
  'credentialvalue',
  'authorizationheader',
])

// `Basic`/`Bearer` followed by a token-shaped literal of at least 12 characters
// that contains at least one digit or symbol. Real tokens (JWT, base64, API key)
// carry a `-`/`_`/`.`/`+`/`/`/`=` or a digit; an English word such as
// `authentication` or a bare challenge phrase such as `Basic realm="..."` does
// not, so neither is mistaken for authentication material.
const evidenceAuthValuePattern = /(?:\bBasic[ \t\r\n]+|\bBearer[ \t\r\n]+)([A-Za-z0-9\-._~+/=]{12,})/gu
const evidenceAuthValueShapePattern = /[0-9\-._~+/=]/u
// A quoted JSON scalar (`:"value"`) or a bare unquoted scalar (`:value`) where
// `value` starts with an alphanumeric or a `$`/`_`/`.`. Unquoted matches stop at
// whitespace or a structural character, so an auth-kind string is not a value.
const evidenceJsonAuthFieldPattern = /"([^"\\]*)"[ \t\r\n]*:[ \t\r\n]*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9$_.][A-Za-z0-9$_.\-+/=]*))/gu

const evidenceSecretRegistry = new Set()

/** Register one provisioned sensitive value. Only non-empty strings count, and a registered value can never be withdrawn. */
function registerEvidenceSecret(value) {
  if (typeof value === 'string' && value.length > 0) evidenceSecretRegistry.add(value)
}

function normalizeEvidenceAuthKey(key) {
  return key.toLowerCase().replace(/[_\-\s]/gu, '')
}

function evidenceAuthFieldViolation(text) {
  for (const match of text.matchAll(evidenceJsonAuthFieldPattern)) {
    if (!evidenceAuthFieldKeys.has(normalizeEvidenceAuthKey(match[1]))) continue
    const value = match[2] !== undefined ? match[2] : match[3]
    if (value !== undefined && value !== '') return 'auth-field'
  }
  return undefined
}

function evidenceAuthValueViolation(text) {
  for (const match of text.matchAll(evidenceAuthValuePattern)) {
    if (match[1].length >= 12 && evidenceAuthValueShapePattern.test(match[1])) return 'auth-value'
  }
  return undefined
}

/**
 * Return a safe violation category for one text blob, or `undefined` when the
 * text is clean. Only the category is ever returned: never the offending value.
 */
function findEvidenceViolation(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  for (const secret of evidenceSecretRegistry) {
    if (text.includes(secret)) return 'registered-credential'
  }
  return evidenceAuthFieldViolation(text) ?? evidenceAuthValueViolation(text)
}

/** Recursively collect the string form of every key and value, so nested arrays/objects are covered. */
function collectEvidenceStrings(value, sink) {
  if (typeof value === 'string') {
    sink.push(value)
    return
  }
  if (value === null || value === undefined || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceStrings(item, sink)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    sink.push(key)
    collectEvidenceStrings(item, sink)
  }
}

function evidenceBoundaryRejection(sink, caseId, category) {
  const suffix = [category, sink, caseId].filter(part => typeof part === 'string' && part.length > 0).join(' ')
  const error = new Error(`${EVIDENCE_BOUNDARY_PREFIX}: ${suffix}`)
  error.evidenceBoundaryRejected = true
  error.evidenceCategory = category
  error.evidenceSink = sink
  if (typeof caseId === 'string') error.evidenceCaseId = caseId
  return error
}

function activeEvidenceCaseId() {
  return evidenceBoundaryContext?.caseId
}

/** Reject a JSON value that carries a registered value or auth material before any file is created or replaced. */
function ensureEvidenceWritability(_path, value, options = {}) {
  const sink = options.sink ?? 'writeJson'
  const caseId = options.caseId ?? activeEvidenceCaseId()
  // Scan the serialized structure so object/array keys and values are covered in
  // their real JSON shape (`"authorization": "..."`, nested `Bearer <token>`).
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = undefined
  }
  if (typeof serialized === 'string') {
    const category = findEvidenceViolation(serialized)
    if (category !== undefined) throw evidenceBoundaryRejection(sink, caseId, category)
  }
  // Scan each raw string too, so a registered value carrying JSON-special
  // characters (which serialization escapes) is still an exact containment hit.
  const strings = []
  collectEvidenceStrings(value, strings)
  for (const text of strings) {
    const category = findEvidenceViolation(text)
    if (category !== undefined) throw evidenceBoundaryRejection(sink, caseId, category)
  }
}

/**
 * Guard text that would otherwise be embedded in an up-thrown error message or
 * passed upward. On a hit the caller keeps its own control flow; the offending
 * text is replaced by a fixed, safe substitute that names only sink/case/category.
 */
function safeSubprocessText(text, sink, caseId = activeEvidenceCaseId()) {
  const category = findEvidenceViolation(text)
  if (category === undefined) return text
  return `<evidence boundary rejected ${[category, sink, caseId].filter(Boolean).join(' ')}>`
}

/**
 * Fail a runner path with a fixed, safe boundary error when the candidate text
 * carries sensitive material; otherwise fail with the given message. The
 * original text never reaches the thrown Error.
 */
function failGuarded(message, text, sink) {
  const category = findEvidenceViolation(text)
  if (category !== undefined) throw evidenceBoundaryRejection(sink, activeEvidenceCaseId(), category)
  fail(message)
}

/**
 * Which evidence sink/case currently owns writes. `runCases` sets the case
 * before invoking a case runner; nothing here inspects or mutates case state.
 */
let evidenceBoundaryContext

async function withEvidenceCase(caseId, run) {
  const previous = evidenceBoundaryContext
  evidenceBoundaryContext = caseId === undefined ? undefined : { caseId }
  try {
    return await run()
  } finally {
    evidenceBoundaryContext = previous
  }
}

/**
 * Reduce any thrown value to a safe message string. A message that carries a
 * registered value or auth material is replaced by the fixed boundary text so
 * the original content can never reach a receipt, terminal or log.
 */
function safeErrorMessage(value, sink = 'propagated-error', caseId = activeEvidenceCaseId()) {
  const text = value instanceof Error ? value.message : String(value)
  const category = findEvidenceViolation(text)
  if (category === undefined) return text
  return `${EVIDENCE_BOUNDARY_PREFIX}: ${[category, sink, caseId].filter(Boolean).join(' ')}`
}

// The driver's own generated Console Basic password is registered once, before
// any BB09/BB10/BB12 fixture starts, and stays registered for the run.
registerEvidenceSecret(consolePassword)

function writeJson(path, value) {
  ensureEvidenceWritability(path, value)
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
    failGuarded(`${command} ${args.join(' ')} exited ${result.status}; expected ${options.expectStatus}\n${result.stderr || result.stdout || ''}`,
      result.stderr || result.stdout || '', 'run-failure-detail')
  }
  if (options.expectNonZero === true && (result.status === 0 || result.status === null)) {
    failGuarded(`${command} ${args.join(' ')} unexpectedly succeeded\n${result.stdout ?? ''}${result.stderr ?? ''}`,
      `${result.stdout ?? ''}${result.stderr ?? ''}`, 'run-failure-detail')
  }
  return output
}

function runChecked(command, args, options = {}) {
  return run(command, args, { ...options, expectStatus: 0 })
}

/**
 * Start one public command without blocking the driver. The BB07 fault
 * sub-scenario must inject a provider failure while the installed CLI request
 * is still in flight, so this runner only records the exact command result.
 */
function runAsync(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  const result = new Promise(resolve => {
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', error => {
      settled = true
      const output = { command, args, status: null, signal: null, stdout, stderr, error: error.message }
      if (options.logPath !== undefined) writeJson(options.logPath, output)
      resolve(output)
    })
    child.once('close', (status, signal) => {
      settled = true
      const output = { command, args, status, signal, stdout, stderr }
      if (options.logPath !== undefined) writeJson(options.logPath, output)
      resolve(output)
    })
  })
  return { child, result, isSettled: () => settled }
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

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function processCommandLine(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  const command = result.status === 0 ? result.stdout.trim() : ''
  return command.length === 0 ? undefined : command
}

function processParentPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const parent = Number(result.status === 0 ? result.stdout.trim() : '')
  return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined
}

/** Split one `ps` command line without invoking a shell. */
function splitProcessCommand(command) {
  const args = []
  let current = ''
  let quote
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\' && quote !== "'") {
      escaped = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/u.test(character)) {
      if (current.length > 0) args.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (escaped) current += '\\'
  if (current.length > 0) args.push(current)
  return args
}

function commandOwnsInstalledEntry(command, entryPath, configPath, startToken) {
  if (command === undefined) return false
  const args = splitProcessCommand(command)
  const entryIndex = args.findIndex(argument => resolve(argument) === resolve(entryPath))
  return entryIndex >= 0 && args[entryIndex + 1] === '--config' && args[entryIndex + 2] === resolve(configPath) &&
    args[entryIndex + 3] === '--launcher-start-token' && args[entryIndex + 4] === startToken
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
    return {
      id,
      pid: record.pid,
      entryPath: record.entryPath,
      projectionPath: record.projectionPath,
      generation: record.generation,
      startToken: record.startToken,
    }
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

function stagedPackageContentSha256() {
  const receipt = readJson(defaultPackageReceiptPath)
  assert(typeof receipt.content_sha256 === 'string' && receipt.content_sha256.length > 0,
    `the staged package receipt has no content hash: ${defaultPackageReceiptPath}`)
  return receipt.content_sha256
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

/**
 * Install a transparent search executable. It records every launch, waits for a
 * driver-owned release marker, then starts the real `rg` with the same argv and
 * forwards its real exit, stdout and stderr. It never synthesizes a search result.
 */
function installSearchBarrier(fixture, evidenceDir, realSearchExecutable, label) {
  const controlRoot = join(fixture.temporaryRoot, `search-barrier-${label}`)
  const executable = join(controlRoot, 'search-wrapper.mjs')
  const binary = join(controlRoot, 'search-wrapper')
  const recordPath = join(controlRoot, 'launch.json')
  const releasePath = join(controlRoot, 'release')
  mkdirSync(controlRoot, { recursive: true })
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const recordPath = process.env.BB07_BARRIER_RECORD
const releasePath = process.env.BB07_BARRIER_RELEASE
const realExecutable = process.env.BB07_REAL_SEARCH
const argv = process.argv.slice(2)
const startedAt = new Date().toISOString()
const record = {
  at: startedAt,
  wrapper_pid: process.pid,
  real_executable: realExecutable,
  argv,
}
appendFileSync(recordPath, JSON.stringify(record) + '\\n')

let released = existsSync(releasePath)
while (!released) {
  await new Promise(resolve => setTimeout(resolve, 10))
  released = existsSync(releasePath)
}

const child = spawn(realExecutable, argv, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
})
process.kill(child.pid, 'SIGSTOP')
appendFileSync(recordPath, JSON.stringify({
  ...record,
  real_pid: child.pid,
  real_started_at: new Date().toISOString(),
  real_held_state: 'SIGSTOP',
}) + '\\n')
child.stdin.end()
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.once('error', error => {
  console.error(JSON.stringify({ code: 'SEARCH_WRAPPER_SPAWN_FAILED', message: error.message }))
  process.exitCode = 127
})
child.once('close', (code, signal) => {
  appendFileSync(recordPath, JSON.stringify({
    ...record,
    real_pid: child.pid,
    real_exit: code,
    real_signal: signal,
    at: new Date().toISOString(),
  }) + '\\n')
  if (signal !== null) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
`, { encoding: 'utf8', mode: 0o700 })
  symlinkSync(executable, binary)
  const wrapperEnv = {
    ...fixture.env,
    BB07_BARRIER_RECORD: recordPath,
    BB07_BARRIER_RELEASE: releasePath,
    BB07_REAL_SEARCH: realSearchExecutable,
  }
  return {
    executable: binary,
    recordPath,
    releasePath,
    env: wrapperEnv,
    release() { writeFileSync(releasePath, `${new Date().toISOString()}\n`, { encoding: 'utf8' }) },
    launches() {
      if (!existsSync(recordPath)) return []
      return readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    },
    executionCount() {
      return new Set(this.launches()
        .map(record => record.real_pid)
        .filter(pid => Number.isSafeInteger(pid) && pid > 0)).size
    },
  }
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
    const executionFailure = await runBB07ExecutionFailure(context)
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
        execution_failure: executionFailure,
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

async function stopFaultLifecycle(fixture, lifecycle, evidenceDir, prefix) {
  const pids = lifecyclePids(lifecycle.internal)
  // The injected provider fault can make the supervisor report that failure from
  // the stop command. Tolerate a nonzero stop only when the persisted launcher
  // still reaches a terminal state and every owned process/port is gone.
  const stop = run(fixture.cli, ['stop', '--config', fixture.configPath, '--generation', String(lifecycle.parsed.generation)], {
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
  const parsed = parseCliStatus(status.stdout)
  assert(parsed.state === 'stopped' || parsed.state === 'failed',
    `the fault fixture did not reach a terminal launcher state: ${status.stdout.trim()}`)
  assertPortsClosed(lifecycle.internal.ports)
  return { stop, status, parsed, pids }
}

async function waitForAsyncResult(run, timeoutMs, label) {
  return await waitForAsync(() => run.isSettled() ? run.result : undefined, timeoutMs, label)
}

// The provider drain and its failed-state ledger write follow the consumer-side
// link break, so the driver must wait for the real terminal state. 20 s is a
// bounded margin above the drain (the in-flight execution is already
// terminated); a longer absence means the provider genuinely never persisted.
const bb07ProviderTerminalWaitMs = 20_000

/**
 * BB07's execution-interruption sub-scenario. The installed provider's search
 * executable is a transparent wrapper around real `rg`. The wrapper records the
 * exact launch and waits behind a driver-controlled barrier. The driver then
 * stops only the provider PID, proves the real search child ownership, explicitly
 * terminates that child, and verifies the provider owner persists a real failed
 * result before the public restart query reads it back.
 */
async function runBB07ExecutionFailure(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB07-execution-failure')
  mkdirSync(evidenceDir, { recursive: true })
  const realSearchExecutable = resolveExecutable('rg', evidenceDir)
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb07-failure')
  let lifecycle
  let restarted
  let barrier
  let openRun
  try {
    barrier = installSearchBarrier(fixture, evidenceDir, realSearchExecutable, 'bb07')
    fixture.env = barrier.env
    const config = ensureUserConfig(fixture, evidenceDir, {
      buildConfigText: () => configFixtureText(barrier.executable),
    })
    writeWorkFixture(fixture)
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb07-failure')
    const provider = lifecycle.internal.processes.find(process => process.id === workProviderId)
    assert(provider !== undefined, 'the fault fixture did not publish the provider process record')
    const providerCommand = processCommandLine(provider.pid)
    assert(typeof provider.projectionPath === 'string' && provider.projectionPath.length > 0,
      `the provider process record has no projectionPath: pid=${provider.pid}`)
    assert(commandOwnsInstalledEntry(providerCommand, provider.entryPath, provider.projectionPath, provider.startToken),
      `the provider PID does not match its installed lifecycle record: pid=${provider.pid} command=${providerCommand ?? 'missing'}`)

    const binding = ['--provider', workProviderId, '--provider-generation', String(provider.generation),
      '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search']
    openRun = runAsync(fixture.cli, ['work', 'open', '--config', fixture.configPath,
      '--receiver', workReceiverId, ...binding, '--demands', workDemands,
      '--payload', '{"query":"marker-alpha"}'], {
      cwd: fixture.temporaryRoot,
      env: fixture.env,
      logPath: join(evidenceDir, 'bb07-fault-open.json'),
    })

    const launch = await waitForAsync(() => {
      const records = barrier.launches()
      return records.find(record => record.real_pid === undefined)
    }, 10_000, 'the BB07 search wrapper launch record')
    assert(openRun.isSettled() === false, 'the BB07 CLI finished before the wrapper barrier was established')
    assert(Number.isSafeInteger(launch.wrapper_pid) && processAlive(launch.wrapper_pid),
      `the BB07 wrapper PID is not active: ${JSON.stringify(launch)}`)

    barrier.release()
    const real = await waitForAsync(() => {
      const records = barrier.launches()
      return records.find(record => Number.isSafeInteger(record.real_pid) && record.real_pid > 0)
    }, 10_000, 'the BB07 real search process record')
    assert(openRun.isSettled() === false, 'the BB07 CLI finished before the real search process was active')
    assert(processAlive(real.real_pid), `the BB07 real search PID is not active: ${JSON.stringify(real)}`)
    assert(processAlive(launch.wrapper_pid), 'the BB07 search wrapper exited before fault injection')

    const wrapperCommand = processCommandLine(launch.wrapper_pid)
    const realCommand = processCommandLine(real.real_pid)
    assert(wrapperCommand?.includes(barrier.executable) === true,
      `the BB07 wrapper PID does not own the installed search wrapper: ${wrapperCommand ?? 'missing'}`)
    assert(realCommand?.includes(realSearchExecutable) === true,
      `the BB07 real search PID does not own real rg: ${realCommand ?? 'missing'}`)
    assert(processParentPid(launch.wrapper_pid) === provider.pid,
      `the BB07 wrapper is not a direct child of the provider: wrapper=${launch.wrapper_pid} parent=${processParentPid(launch.wrapper_pid)} provider=${provider.pid}`)
    assert(processParentPid(real.real_pid) === launch.wrapper_pid,
      `the BB07 real search process is not a direct child of the wrapper: real=${real.real_pid} parent=${processParentPid(real.real_pid)} wrapper=${launch.wrapper_pid}`)
    const externalStateBefore = processState(real.real_pid)
    assert(externalStateBefore !== undefined && externalStateBefore.startsWith('T'),
      `the BB07 real search process is not held active: pid=${real.real_pid} state=${externalStateBefore ?? 'missing'}`)
    const launchCountBefore = barrier.executionCount()

    const providerFault = {
      pid: provider.pid,
      generation: provider.generation,
      start_token: provider.startToken,
      entry_path: provider.entryPath,
      projection_path: provider.projectionPath,
      command: providerCommand,
      signal: 'SIGTERM',
      at: now(),
    }
    process.kill(provider.pid, 'SIGTERM')
    const externalExecution = {
      pid: real.real_pid,
      wrapper_pid: launch.wrapper_pid,
      provider_pid: provider.pid,
      owner: 'provider Work owner (bb-provider)',
      fixture_owner: 'driver BB07 execution-failure fixture',
      state_before_release: externalStateBefore,
      responsibility: 'driver must explicitly terminate this still-active external execution and retain the provider ledger failure',
      release_action: 'SIGTERM to the exact real rg PID after provider stop admission',
    }
    assert(openRun.isSettled() === false, 'the BB07 CLI finished before the provider fault was injected')
    assert(processAlive(real.real_pid), 'the BB07 real search process exited during provider drain')
    process.kill(real.real_pid, 'SIGTERM')
    process.kill(real.real_pid, 'SIGCONT')
    await waitForProcessesGone([real.real_pid, launch.wrapper_pid])

    const openOutput = await waitForAsyncResult(openRun, 30_000, 'the BB07 original CLI terminal result')
    const originalReceipt = workReceipt(openOutput)
    assert(originalReceipt.control.workId !== undefined && originalReceipt.control.requestId !== undefined,
      `the original BB07 CLI result lost its Work identity: ${JSON.stringify(originalReceipt.control)}`)
    assert(originalReceipt.control.targetGeneration === provider.generation,
      `the original BB07 CLI result lost its target generation: ${JSON.stringify(originalReceipt.control)}`)
    assert(originalReceipt.status === 'failed' || originalReceipt.control.requestState === 'failed' || originalReceipt.control.deliveryState === 'unconfirmed',
      `the original BB07 CLI result did not record failure or unconfirmed delivery: ${JSON.stringify(originalReceipt)}`)

    // The consumer CLI settles the request as soon as the link breaks, which can
    // happen before the provider's drain finishes persisting the failed terminal
    // state. Wait (bounded) for that real terminal state instead of sampling the
    // ledger once. A timeout keeps the last observation and fails: an
    // unpersisted failure is a real product/orchestration divergence.
    let lastFaultLedger
    const faultLedger = await waitForAsync(() => {
      const current = providerLedger(fixture)
      lastFaultLedger = current
      if (current.snapshot === undefined) return undefined
      const request = current.snapshot.requests.find(candidate => candidate.control.workId === originalReceipt.control.workId &&
        candidate.control.requestId === originalReceipt.control.requestId)
      if (request?.state !== 'failed') return undefined
      // `search-slot` is a request-scoped resource, so the provider ledger must
      // hold exactly this request's allocation and it must be released on failure.
      const allocations = current.snapshot.allocations
        .filter(allocation => allocation.requestId === originalReceipt.control.requestId)
      if (allocations.length === 0 || allocations.some(allocation => allocation.state !== 'released')) return undefined
      return { path: current.path, failedRequest: request, failedRequestAllocations: allocations }
    }, bb07ProviderTerminalWaitMs, 'the provider to persist the real failed request and release its allocation')
      .catch(error => {
        if (error?.absentObservation === true) {
          fail(`the provider owner did not persist the real failed request within ${bb07ProviderTerminalWaitMs} ms: ${JSON.stringify(lastFaultLedger ?? null)}`)
        }
        throw error
      })
    const providerLedgerAfterFault = { path: faultLedger.path }
    const failedRequest = faultLedger.failedRequest
    const failedRequestAllocations = faultLedger.failedRequestAllocations

    const faultStop = await stopFaultLifecycle(fixture, lifecycle, evidenceDir, 'bb07-failure')
    lifecycle = undefined
    const generationBeforeRestart = faultStop.parsed.generation
    restarted = startAndReadLifecycle(fixture, evidenceDir, 'bb07-failure-restart')
    assert(restarted.parsed.generation > generationBeforeRestart,
      `the fault restart did not advance the launcher generation: ${generationBeforeRestart} -> ${restarted.parsed.generation}`)

    const queryArgs = ['work', 'query', '--config', fixture.configPath, '--receiver', workReceiverId,
      '--service-selection', 'capability', '--work-id', originalReceipt.control.workId,
      '--request-id', originalReceipt.control.requestId, ...binding]
    const recoveredOutput = runWork(fixture, evidenceDir, 'bb07-fault-query', queryArgs)
    // A failed request readback can arrive as a completed graph receipt that
    // carries `control.requestState: 'failed'`, so parse the general receipt and
    // then require the failed request state explicitly.
    const recovered = workReceipt(recoveredOutput)
    assert(recovered.control.workId === originalReceipt.control.workId && recovered.control.requestId === originalReceipt.control.requestId,
      'the BB07 fault recovery query did not preserve the original Work/request identity')
    assert(recovered.control.targetGeneration === provider.generation,
      `the BB07 fault recovery query lost the original target generation: ${JSON.stringify(recovered.control)}`)
    assert(recovered.control.requestState === 'failed' || recovered.status === 'failed',
      `the BB07 fault recovery query did not read a failed request: ${JSON.stringify(recovered)}`)
    assert(recovered.control.error?.code !== undefined && recovered.control.error.code.length > 0,
      `the BB07 fault recovery query did not expose a typed error: ${JSON.stringify(recovered.control.error)}`)
    assert(recovered.evidence?.hostOperations?.includes('agentWork.get') === true,
      `the BB07 fault recovery query did not read the provider ledger: ${JSON.stringify(recovered.evidence?.hostOperations)}`)
    assert(!recovered.evidence.hostOperations.includes('agentWork.request') && !recovered.evidence.hostOperations.includes('agentWork.propose'),
      `the BB07 fault recovery query re-executed business work: ${JSON.stringify(recovered.evidence.hostOperations)}`)
    const launchCountAfterQuery = barrier.executionCount()
    assert(launchCountAfterQuery === launchCountBefore,
      `the BB07 recovery query started external search work: before=${launchCountBefore} after=${launchCountAfterQuery}`)

    const final = await stopAndAssertClean(fixture, restarted, evidenceDir, 'bb07-failure-final')
    const allPids = lifecyclePids(restarted.internal)
    const restartedGeneration = restarted.parsed.generation
    restarted = undefined
    const finalWrapperRecords = barrier.launches()
    const finalRealRecord = finalWrapperRecords.at(-1)
    fixture.cleanup()
    return {
      status: 'passed',
      public_input: {
        package: context.packRoot,
        receiver: workReceiverId,
        commands: [
          'agentteams work open --provider bb-provider --provider-generation <g> --operation search ...',
          'SIGTERM to the exact provider PID from internal.toml',
          'SIGTERM to the exact still-active real rg PID from the wrapper record',
          'agentteams stop --generation <g>',
          'agentteams start',
          'agentteams work query --service-selection capability --work-id <W> --request-id <R> ...',
          'agentteams stop --generation <g2>',
        ],
      },
      external_observation: {
        installed_content_sha256: fixture.installedContentSha256,
        config_sha256: config.configSha256,
        search_wrapper: {
          executable: barrier.executable,
          real_executable: realSearchExecutable,
          launch_count_before_query: launchCountBefore,
          launch_count_after_query: launchCountAfterQuery,
          final_record: finalRealRecord,
        },
        provider_fault: providerFault,
        external_execution: {
          ...externalExecution,
          exit_confirmed: !processAlive(real.real_pid) && !processAlive(launch.wrapper_pid),
          wrapper_exit_observed: !processAlive(launch.wrapper_pid),
          real_exit_observed: !processAlive(real.real_pid),
        },
        original_cli: { status: openOutput.status, signal: openOutput.signal, stdout: openOutput.stdout.trim(), stderr: openOutput.stderr.trim(), receipt: originalReceipt },
        provider_ledger_after_fault: { path: providerLedgerAfterFault.path, failed_request: failedRequest },
        fault_stop: { stdout: faultStop.stop.stdout, stopped_stdout: faultStop.status.stdout, pids: faultStop.pids },
        restart_generation: { from: generationBeforeRestart, to: restartedGeneration },
        recovered,
        final_stop_stdout: final.stop.stdout,
        final_stopped_stdout: final.status.stdout,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
  } finally {
    stopFixtureIfNeeded(fixture, restarted?.parsed.generation ?? lifecycle?.parsed.generation)
    // Release the barrier so a still-waiting wrapper cannot hang, then close the
    // driver-owned async CLI handle if a pre-injection assertion failed.
    if (barrier !== undefined) {
      try { barrier.release() } catch { /* release marker may already exist */ }
    }
    if (openRun !== undefined && !openRun.isSettled()) {
      openRun.child.kill('SIGTERM')
    }
    try {
      fixture.cleanup()
    } catch {
      // The case result records the primary observation.
    }
  }
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
const bb09RefreshSuccessNotice = 'Refresh models: accepted by Agent'

function bb09RefreshCompletion(state) {
  return state.selectedAgent === workProviderId
    && Array.isArray(state.models)
    && state.models.includes(bb09StubModelId)
    && state.liveRegion === bb09RefreshSuccessNotice
    && state.refreshDisabled === false
    && state.liveRegionIsError === false
}

/**
 * The BB09 user `config.toml`. Both daemons are real and both explicitly
 * authorize `__console`; a local OpenAI-compatible stub provider gives the
 * Console a real provider/model row to configure. The refusal scenario reuses
 * this text with an empty manager list.
 */
function bb09ConfigText(spec) {
  const managerList = `[${spec.allowedManagers.map(id => JSON.stringify(id)).join(', ')}]`
  const staticBinding = spec.agentIds === undefined ? '' : `agentIds = ${JSON.stringify(spec.agentIds)}\n`
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
${staticBinding}`
}

/**
 * The accepted config revision an Agent durably owns. The management policy of
 * the refusal scenario denies the Console's observation too, so the revision
 * non-advance is read from the Agent's own durable internal store.
 */
function readAcceptedConfigRevision(internalPath, agentId) {
  let text
  try {
    text = readFileSync(internalPath, 'utf8')
  } catch (cause) {
    fail(`the daemon durable internal store could not be read: ${internalPath}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let internal
  try {
    internal = parseToml(text)
  } catch (cause) {
    fail(`the daemon durable internal store is not valid TOML: ${internalPath}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const slice = internal.configRuntime?.accepted?.[agentId]
  if (slice === undefined) return undefined
  assert(typeof slice.acceptedRevision === 'number' && Number.isSafeInteger(slice.acceptedRevision),
    `the daemon durable accepted slice for ${agentId} has no valid acceptedRevision`)
  return slice.acceptedRevision
}

function agentPolicyRefusalExpectedRevision(before) {
  if (before === undefined) return 0
  assert(before === 0,
    `the refusal fixture already has an accepted config revision: ${before}; the Agent-policy refusal precondition requires an unaccepted durable store`)
  return 0
}

/** Read the accepted primary/backup refs from the daemon's durable internal store. */
function readAcceptedBinding(internalPath, agentId) {
  const internal = parseToml(readFileSync(internalPath, 'utf8'))
  const slice = internal.configRuntime?.accepted?.[agentId]
  assert(slice !== undefined && typeof slice.snapshot === 'string',
    `the daemon durable store has no accepted snapshot for ${agentId}`)
  let snapshot
  try {
    snapshot = JSON.parse(slice.snapshot)
  } catch {
    fail(`the daemon durable accepted snapshot for ${agentId} is not valid JSON`)
  }
  const binding = snapshot?.agents?.[agentId]
  assert(binding?.primary?.providerInstanceId !== undefined && binding?.primary?.modelId !== undefined,
    `the daemon durable accepted snapshot has no primary binding for ${agentId}`)
  return {
    accepted_revision: slice.acceptedRevision,
    primary: {
      providerInstanceId: binding.primary.providerInstanceId,
      modelId: binding.primary.modelId,
    },
    backup: binding.backup === undefined ? null : {
      providerInstanceId: binding.backup.providerInstanceId,
      modelId: binding.backup.modelId,
    },
  }
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

/**
 * The post-hoc audit that complements the pre-write boundary: fail the case if
 * any recorded evidence file carries a registered credential value or any
 * auth-field/auth-value material. The explicit `secrets` list is checked in
 * addition to the run-level registry, so a caller can name values it owns.
 */
function assertNoSecretInEvidence(directory, secrets) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      assertNoSecretInEvidence(path, secrets)
      continue
    }
    const text = readFileSync(path, 'utf8')
    for (const secret of secrets) {
      if (typeof secret !== 'string' || secret.length === 0) continue
      assert(!text.includes(secret), `evidence ${path} contains a provisioned credential value`)
    }
    const category = findEvidenceViolation(text)
    assert(category === undefined, `evidence ${path} carries ${category} material`)
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
  if (options.assertProjection !== undefined) options.assertProjection(projection)

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
  // the settings toolbar selects a real Agent, a real click refreshes the catalog
  // observation, and a real click binds a catalog model. Catalog refresh is
  // observation-only; the bind operation owns the accepted revision advance.
  if (options.skipConfigInteraction !== true) {
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
  camoClick(fixture, camo, evidenceDir, 'browser-config-refresh-action', profile,
    'article.teams-provider-card .teams-provider-actions button:nth-of-type(2)')
  const refreshedCatalog = await waitForAsync(async () => {
    const current = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-refreshed-dom', profile,
      `JSON.stringify({ catalog: document.querySelector('article.teams-provider-card .teams-catalog-state')?.textContent ?? null, models: [...document.querySelectorAll('article.teams-provider-card select.teams-select option')].map(option => option.value), selectedAgent: document.querySelector('div.teams-config-toolbar select.teams-select')?.value ?? null, liveRegion: document.querySelector('.teams-live-region')?.textContent ?? null, liveRegionIsError: document.querySelector('.teams-live-region')?.classList.contains('is-error') ?? false, refreshDisabled: document.querySelector('article.teams-provider-card .teams-provider-actions button:nth-of-type(2)')?.disabled ?? null })`))
    if (current.liveRegionIsError === true) {
      writeJson(join(evidenceDir, 'browser-config-refresh-error.json'), current)
      fail(`the Console catalog refresh reported an error: ${JSON.stringify(current)}`)
    }
    return bb09RefreshCompletion(current) ? current : undefined
  }, 60_000, 'the refreshed provider catalog to complete successfully')
  assert(bb09RefreshCompletion(refreshedCatalog),
    `the settings panel did not show the completed provider refresh: ${JSON.stringify(refreshedCatalog)}`)
  const refreshReadback = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-refresh-after',
    profile, `fetch('/api/v1/projection').then(r => r.json()).then(j => JSON.stringify({ configs: j.configs }))`))
  const refreshRow = refreshReadback.configs.find(row => row.agentId === workProviderId)
  assert(refreshRow.acceptedRevision === beforeRow.acceptedRevision,
    `the catalog refresh advanced the accepted revision: ${JSON.stringify([beforeRow.acceptedRevision, refreshRow.acceptedRevision])}`)
  const bindPreclick = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-bind-select', profile,
    `JSON.stringify((() => { const select = document.querySelector('article.teams-provider-card select.teams-select'); if (select === null) return { selectValue: null, bindDisabled: null, liveRegion: null, liveRegionIsError: null }; select.value = ${JSON.stringify(bb09StubModelId)}; select.dispatchEvent(new Event('change', { bubbles: true })); return { selectValue: select.value, bindDisabled: document.querySelector('article.teams-provider-card .teams-model-row .teams-button-primary')?.disabled ?? null, liveRegion: document.querySelector('.teams-live-region')?.textContent ?? null, liveRegionIsError: document.querySelector('.teams-live-region')?.classList.contains('is-error') ?? null } })())`))
  writeJson(join(evidenceDir, 'browser-config-bind-preclick.json'), bindPreclick)
  assert(bindPreclick.selectValue === bb09StubModelId,
    `the settings panel did not select the catalog model: ${JSON.stringify(bindPreclick)}`)
  assert(bindPreclick.bindDisabled === false,
    `the bind button was not enabled before the real click: ${JSON.stringify(bindPreclick)}`)
  assert(bindPreclick.liveRegion === bb09RefreshSuccessNotice && bindPreclick.liveRegionIsError === false,
    `the bind click did not follow the completed refresh notice: ${JSON.stringify(bindPreclick)}`)
  camoClick(fixture, camo, evidenceDir, 'browser-config-actions', profile,
    'article.teams-provider-card .teams-model-row .teams-button-primary')
  const bindDiagScript = `JSON.stringify({ liveRegion: document.querySelector('.teams-live-region')?.textContent ?? null, drawer: document.querySelector('.teams-drawer')?.textContent ?? null, errorPanel: document.querySelector('.teams-error-panel')?.textContent ?? null, fieldHints: [...document.querySelectorAll('.teams-field-hint')].map(node => node.textContent), bindDisabled: document.querySelector('article.teams-provider-card .teams-model-row .teams-button-primary')?.disabled ?? null, selectValue: document.querySelector('article.teams-provider-card select.teams-select')?.value ?? null })`
  writeJson(join(evidenceDir, 'browser-config-bind-diag-click.json'),
    JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-bind-diag-click', profile, bindDiagScript)))
  let after
  try {
    after = await waitForAsync(async () => {
      const current = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-after',
        profile, `fetch('/api/v1/projection').then(r => r.json()).then(j => JSON.stringify({ configs: j.configs }))`))
      const row = current.configs.find(candidate => candidate.agentId === workProviderId)
      return row !== undefined && row.acceptedRevision > beforeRow.acceptedRevision ? current : undefined
    }, 60_000, 'the Console provider operation to advance the accepted revision')
  } catch (error) {
    try {
      writeJson(join(evidenceDir, 'browser-config-bind-diag.json'),
        JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-bind-diag', profile, bindDiagScript)))
    } catch { /* preserve the primary failure */ }
    throw error
  }
  writeJson(join(evidenceDir, 'browser-config-after.json'), after)
  const afterRow = after.configs.find(row => row.agentId === workProviderId)
  assert(afterRow.acceptedRevision === beforeRow.acceptedRevision + 1,
    `the Console bind operation advanced the accepted revision by ${afterRow.acceptedRevision - beforeRow.acceptedRevision}: ${JSON.stringify(afterRow)}`)
  const afterCard = JSON.parse(await camoEvaluate(fixture, camo, evidenceDir, 'browser-config-after-dom', profile,
    `JSON.stringify({ catalog: document.querySelector('article.teams-provider-card .teams-catalog-state')?.textContent ?? null, models: [...document.querySelectorAll('article.teams-provider-card select.teams-select option')].map(option => option.value) })`))
  const boundModel = afterRow.providers.find(provider => provider.id === bb09StubProviderId)?.models
    .find(model => model.id === bb09StubModelId)
  assert(boundModel?.id === bb09StubModelId,
    `the projection did not retain the bound provider model: ${JSON.stringify(afterRow)}`)
  const otherAfter = after.configs.find(row => row.agentId === workReceiverId)
  assert(JSON.stringify(otherAfter ?? null) === JSON.stringify(otherBefore ?? null),
    `the Console provider operation changed another Agent's config: ${JSON.stringify([otherBefore, otherAfter])}`)
  camoClick(fixture, camo, evidenceDir, 'browser-config-close', profile,
    '.teams-drawer .teams-header-actions button:nth-of-type(2)')
  observed.config = {
    agent: workProviderId,
    operation: 'config.bindModel',
    provider: bb09StubProviderId,
    model: bb09StubModelId,
    accepted_before: beforeRow.acceptedRevision,
    accepted_after: afterRow.acceptedRevision,
    refresh_accepted_revision: refreshRow.acceptedRevision,
    provider_card_catalog: afterCard.catalog,
    other_agent_unchanged: otherAfter === undefined,
  }
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
    const expectedRevision = agentPolicyRefusalExpectedRevision(before)
    const command = { kind: 'config.refreshModels', agentId: workProviderId, expectedRevision, providerId: bb09StubProviderId }
    const refusal = await consoleHttp(console.url, console.authorization, '/api/v1/command', {
      body: command,
    })
    assert(refusal.status === 200 && refusal.body?.ok === false && refusal.body.error?.code === 'FORBIDDEN',
      `the public management entry did not refuse an unauthorized manager: ${refusal.status} ${refusal.text.slice(0, 300)}`)
    const after = readAcceptedConfigRevision(lifecycle.internal.internalPath, workProviderId)
    assert(after === before, `the refused management command advanced the Agent config revision: ${before} -> ${after}`)
    writeJson(join(refusalDir, 'agent-policy-refusal.json'), {
      command,
      http_status: refusal.status,
      result: publicJson(refusal.body),
      accepted_revision_before: before ?? null,
      accepted_slice_present_before: before !== undefined,
      accepted_revision_after: after ?? null,
      accepted_slice_present_after: after !== undefined,
      accepted_revision_observation_source: 'target Agent durable internal store',
      view_semantics_revision: 0,
      view_semantics_note: 'derived from the product initial-view rule, not an HTTP readback',
      console_config_sha256: config.configSha256,
    })
    const stopped = await stopAndAssertClean(fixture, lifecycle, refusalDir, 'bb09-refusal-final')
    lifecycle = undefined
    return { command,
      http_status: refusal.status, error: publicJson(refusal.body.error),
      accepted_revision_before: before ?? null, accepted_slice_present_before: before !== undefined,
      accepted_revision_after: after ?? null, accepted_slice_present_after: after !== undefined,
      accepted_revision_observation_source: 'target Agent durable internal store',
      stop_stdout: stopped.stop.stdout }
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    try {
      fixture.cleanup()
    } catch {
      // The refusal observation is the primary record.
    }
  }
}

/**
 * The installed static-binding sub-scenario. It reuses the same package and
 * browser helpers as the directory-discovery scenario, but its isolated
 * `[console].agentIds` binding owns the admitted target set. It deliberately
 * does not repeat the main scenario's config, Work, or Session interactions.
 */
async function bb09StaticBindingScenario(context) {
  const evidenceDir = join(context.caseEvidenceRoot, 'BB09', 'static-binding')
  mkdirSync(evidenceDir, { recursive: true })
  const fixture = installPackage(context.packRoot, evidenceDir, 'bb09-static')
  const camo = resolveCamo(evidenceDir)
  const stub = createSessionProviderStub({ models: [bb09StubModelId] })
  const profiles = new Set()
  const profile = `bb09-static-${process.pid}`
  const noCredentialProfile = `bb09-static-nocred-${process.pid}`
  let lifecycle
  let failure
  let cleaned = false
  const cleanup = {
    stop_stdout: null,
    stopped_stdout: null,
    pids: [],
    pids_alive_after_stop: [],
    browser_profiles: [],
    temporary_root_removed: false,
  }
  const recordCleanup = () => {
    cleanup.temporary_root_removed = !existsSync(fixture.temporaryRoot)
    writeJson(join(evidenceDir, 'cleanup.json'), publicJson(cleanup))
  }
  try {
    provisionBrowserRuntime(fixture, evidenceDir)
    const stubUrl = await listenProviderStub(stub)
    const config = ensureUserConfig(fixture, evidenceDir, {
      buildConfigText: searchExecutable => bb09ConfigText({
        stubBaseUrl: stubUrl,
        searchExecutable,
        allowedManagers: ['__console'],
        agentIds: [workProviderId, workReceiverId],
      }),
    })
    lifecycle = startAndReadLifecycle(fixture, evidenceDir, 'bb09-static')
    const initial = assertConsoleOnline(parseCliConsole(lifecycle.status.stdout), 'installed static-binding Console after start')
    const authorization = `Basic ${Buffer.from(`${consoleUsername}:${consolePassword}`).toString('base64')}`
    const browser = await bb09BrowserAcceptance({
      fixture, camo, evidenceDir, profiles, profile, noCredentialProfile,
      initial, statusStdout: lifecycle.status.stdout, configText: config.configText, authorization,
      skipConfigInteraction: true,
      assertProjection: projection => {
        const rowsById = new Map(projection.agents.map(row => [row.agentId, row]))
        assert(rowsById.size === 2 && rowsById.has(workProviderId) && rowsById.has(workReceiverId),
          `the static-binding projection did not contain exactly the explicit IDs: ${JSON.stringify([...rowsById.keys()])}`)
        const provider = rowsById.get(workProviderId)
        const receiver = rowsById.get(workReceiverId)
        assert(provider.presence === 'online' && receiver.presence === 'online',
          `the static-binding projection did not report both peers online: ${JSON.stringify(projection.agents)}`)
        assert(provider.label === 'BB09-Provider' && provider.machineId === 'bb-machine'
          && receiver.label === 'BB09-Receiver' && receiver.machineId === 'bb-machine',
        `the static-binding projection lost a card identity: ${JSON.stringify(projection.agents)}`)
        assert(provider.capabilities.includes('file-search') && receiver.capabilities.length === 0,
          `the static-binding projection carried the wrong capability IDs: ${JSON.stringify(projection.agents)}`)
        assert(JSON.stringify(provider.capabilityDetails) === JSON.stringify([{
          capabilityId: 'file-search', version: '1', operations: ['search'],
          resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }],
        }]), `the static-binding projection carried the wrong provider declaration: ${JSON.stringify(provider.capabilityDetails)}`)
        assert(JSON.stringify(receiver.capabilityDetails) === '[]',
          `the static-binding receiver carried an unexpected declaration: ${JSON.stringify(receiver.capabilityDetails)}`)
      },
    })
    const providerCard = browser.agents.find(row => row.agentId === workProviderId)
    const receiverCard = browser.agents.find(row => row.agentId === workReceiverId)
    assert(providerCard !== undefined && receiverCard !== undefined,
      `the static-binding browser did not render both cards: ${JSON.stringify(browser.agents)}`)
    assert(providerCard.label === 'BB09-Provider' && receiverCard.label === 'BB09-Receiver'
      && providerCard.machineId === 'bb-machine' && receiverCard.machineId === 'bb-machine',
    `the static-binding browser cards did not match the declarations: ${JSON.stringify(browser.agents)}`)
    camoClick(fixture, camo, evidenceDir, 'browser-receiver-detail-action', profile,
      `button[data-focus-key="agent:${workReceiverId}:details"]`)
    const receiverDetail = await camoEvaluate(fixture, camo, evidenceDir, 'browser-receiver-detail-dom', profile,
      `document.querySelector('.teams-drawer')?.textContent ?? ''`)
    assert(typeof receiverDetail === 'string' && receiverDetail.includes('BB09-Receiver') && receiverDetail.includes('bb-machine'),
      `the static-binding receiver drawer did not show its card identity: ${String(receiverDetail).slice(0, 400)}`)
    camoClick(fixture, camo, evidenceDir, 'browser-receiver-detail-close', profile,
      '.teams-drawer .teams-header-actions button:nth-of-type(2)')
    const explicitAgentIds = [workProviderId, workReceiverId]
    const observedAgentIds = browser.agents.map(row => row.agentId).sort()
    assert(JSON.stringify(observedAgentIds) === JSON.stringify([...explicitAgentIds].sort()),
      `the static-binding projection did not contain exactly the explicit IDs: ${JSON.stringify(observedAgentIds)}`)
    const stopped = await stopAndAssertClean(fixture, lifecycle, evidenceDir, 'bb09-static-final')
    const pids = lifecyclePids(lifecycle.internal)
    cleanup.stop_stdout = stopped.stop.stdout
    cleanup.stopped_stdout = stopped.status.stdout
    cleanup.pids = pids
    cleanup.pids_alive_after_stop = pids.filter(processAlive)
    lifecycle = undefined
    const browserCleanup = camoTeardown(fixture, camo, evidenceDir, profiles, 'browser-cleanup')
    profiles.clear()
    cleanup.browser_profiles = browserCleanup
    writeJson(join(evidenceDir, 'browser-cleanup.json'), { profiles: browserCleanup })
    fixture.cleanup()
    cleaned = true
    recordCleanup()
    const observation = {
      explicit_agent_ids: explicitAgentIds,
      installed_content_sha256: fixture.installedContentSha256,
      cleanup: publicJson(cleanup),
      projection: { agents: browser.agents, config_interaction: 'not-run' },
      evidence_path: evidenceDir,
    }
    writeJson(join(evidenceDir, 'static-binding.json'), observation)
    return observation
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { if (lifecycle !== undefined) stopFixtureIfNeeded(fixture, lifecycle.parsed.generation) } catch { /* preserve the primary failure */ }
    try {
      if (profiles.size > 0) {
        const browserCleanup = camoTeardown(fixture, camo, evidenceDir, profiles, 'browser-cleanup')
        profiles.clear()
        cleanup.browser_profiles = browserCleanup
        writeJson(join(evidenceDir, 'browser-cleanup.json'), { profiles: browserCleanup })
      }
    } catch { /* preserve the primary failure */ }
    try { await closeProviderStub(stub) } catch { /* preserve the primary failure */ }
    try { if (!cleaned && existsSync(fixture.temporaryRoot)) fixture.cleanup() } catch { /* preserve the primary failure */ }
    recordCleanup()
    if (failure !== undefined) {
      writeJson(join(evidenceDir, 'static-binding.json'), {
        explicit_agent_ids: [workProviderId, workReceiverId],
        installed_content_sha256: fixture.installedContentSha256,
        cleanup: publicJson(cleanup),
        failure: failure.message,
        evidence_path: evidenceDir,
      })
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
    const staticBinding = await bb09StaticBindingScenario(context)

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
          'camo evaluate article.teams-provider-card select.teams-select (select bb-console-model)',
          'camo click article.teams-provider-card .teams-model-row .teams-button-primary (bind model)',
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
        static_binding: staticBinding,
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
  const inferenceResponses = []
  const catalogRequests = []
  const state = { fail: false, catalog401: options.catalog401 === true }
  const models = options.models ?? []
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      const status = state.catalog401 ? 401 : 200
      catalogRequests.push({ method: 'GET', path: request.url, status })
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bb session provider stub catalog rejection' } }))
        return
      }
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
      let input
      try { input = JSON.parse(body) } catch { input = {} }
      const requestModel = typeof input.model === 'string' ? input.model : undefined
      const messages = Array.isArray(input.messages) ? input.messages : []
      const newest = messages[messages.length - 1]
      const promptText = typeof newest?.content === 'string' ? newest.content : JSON.stringify(newest?.content ?? '')
      if (state.fail) {
        const failureBody = state.failBody ?? options.failBody
          ?? { error: { message: 'bb session provider stub failure', type: 'api_error' } }
        inferenceResponses.push({ model: requestModel, prompt: promptText, status: 500 })
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify(failureBody))
        return
      }
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
      inferenceResponses.push({ model: requestModel, prompt: promptText, status: 200 })
      writeSessionChatResponse(response, body, input, call)
    })
  })
  return { server, requests, held, inferenceResponses, catalogRequests, state }
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

async function applySessionConfigAndWait(client, agentId, evidenceDir, prefix, onReply) {
  const applied = await client.command({ kind: 'config.apply', agentId })
  const reply = publicJson(applied.body)
  writeJson(join(evidenceDir, `${prefix}-config-apply.json`), reply)
  onReply?.(reply)
  assert(applied.body.ok === true, `config.apply failed for ${agentId}: ${JSON.stringify(applied.body)}`)
  const agent = await waitForAsync(async () => {
    const row = (await readInstalledProjection(client, undefined, 'apply')).agents.find(candidate => candidate.agentId === agentId)
    return row?.sessionCapable === true && row.sessionAvailability === 'current' ? row : undefined
  }, 180_000, `the installed ${agentId} Session runtime to become current`)
  return { applied: reply, agent: publicJson(agent) }
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

/**
 * Combine only the accepted-side facts available before config.apply. The
 * accepted binding and revision come from the same public config row; the
 * public effective slice and running Agent fields do not exist until apply.
 */
function boundaryAcceptedBindingSnapshot(projection, agentId) {
  const config = projection.configs.find(row => row.agentId === agentId)
  assert(config !== undefined, `the installed projection published no config row for ${agentId}`)
  assert(typeof config.acceptedRevision === 'number' && Number.isSafeInteger(config.acceptedRevision),
    `the installed config row for ${agentId} has no acceptedRevision`)
  const acceptedBinding = config.acceptedBinding
  assert(acceptedBinding !== null && typeof acceptedBinding === 'object'
    && typeof acceptedBinding.primary?.providerInstanceId === 'string'
    && typeof acceptedBinding.primary?.modelId === 'string',
  `the public config row for ${agentId} has no accepted primary provider/model`)
  return {
    config: {
      acceptedRevision: config.acceptedRevision,
      effectiveRevision: config.effectiveRevision ?? null,
      applyState: config.applyState ?? null,
    },
    binding: { primary: acceptedBinding.primary, backup: acceptedBinding.backup ?? null },
  }
}

/**
 * Combine the accepted binding, effective revision and running Agent row from
 * one installed Console projection response. Provider catalog observations are
 * deliberately omitted because a rejected catalog refresh may update them while
 * accepted/effective/binding stay fixed.
 */
function boundaryBindingSnapshot(projection, agentId) {
  const config = projection.configs.find(row => row.agentId === agentId)
  assert(config !== undefined, `the installed projection published no config row for ${agentId}`)
  assert(typeof config.acceptedRevision === 'number' && Number.isSafeInteger(config.acceptedRevision),
    `the installed config row for ${agentId} has no acceptedRevision`)
  assert(config.effectiveRevision !== undefined, `the installed config row for ${agentId} has no effectiveRevision`)
  const acceptedBinding = config.acceptedBinding
  assert(acceptedBinding !== null && typeof acceptedBinding === 'object'
    && typeof acceptedBinding.primary?.providerInstanceId === 'string'
    && typeof acceptedBinding.primary?.modelId === 'string',
  `the public config row for ${agentId} has no accepted primary provider/model`)
  const agent = projection.agents.find(row => row.agentId === agentId)
  assert(agent !== undefined, `the installed projection published no runtime row for ${agentId}`)
  return {
    config: {
      acceptedRevision: config.acceptedRevision,
      effectiveRevision: config.effectiveRevision,
      applyState: config.applyState ?? null,
    },
    agent: {
      providerId: agent.providerId ?? null,
      modelId: agent.modelId ?? null,
      sessionEffectiveRevision: agent.sessionEffectiveRevision ?? null,
    },
    binding: { primary: acceptedBinding.primary, backup: acceptedBinding.backup ?? null },
  }
}

/** Read the public binding snapshot; private durable snapshots remain diagnostics only. */
function installedBindingSnapshot(projection, agentId) {
  return boundaryBindingSnapshot(projection, agentId)
}

/** A turn passes only when the public final completed and carried assistant text. */
function bb10TurnPass(turn) {
  return turn?.final?.state === 'completed'
    && typeof turn.text === 'string' && turn.text.trim() !== ''
}

/** Real acceptance: two real turns, the exact public binding, cleanup, package hash. */
function bb10RealAcceptancePass(real) {
  if (real?.status !== 'passed') return false
  if (!bb10TurnPass(real.rcc_turn) || !bb10TurnPass(real.canonical_turn)) return false
  const identity = real.installed_identity
  if (identity?.installed_content_sha256 === undefined
    || identity.installed_content_sha256 !== identity.expected_content_sha256) return false
  const primary = real.explicit_selection?.primary
  if (primary?.providerInstanceId === undefined || primary?.modelId === undefined) return false
  const readback = real.readback
  if (readback?.agent?.providerId !== primary.providerInstanceId || readback?.agent?.modelId !== primary.modelId) return false
  if (readback?.config?.effectiveRevision !== readback?.config?.acceptedRevision) return false
  const cleanup = real.cleanup
  return cleanup?.console_listener_gone === true
    && Array.isArray(cleanup?.owned_pids_alive_after_stop) && cleanup.owned_pids_alive_after_stop.length === 0
    && cleanup?.temporary_root_removed === true
}

/** Boundary (1): an empty catalog still allows an explicit manual selection. */
function bb10ManualSelectionPass(selection) {
  if (selection === undefined) return false
  if (selection.refresh?.ok !== true) return false
  if (selection.catalog_state !== 'empty' || selection.model_count !== 0) return false
  if (selection.accepted_revision_before !== 1) return false
  if (selection.accepted_revision_after !== selection.accepted_revision_before + 2) return false
  if (selection.put_model?.ok !== true || selection.bind_model?.ok !== true) return false
  if (selection.restarted_accepted_revision !== selection.accepted_revision_after) return false
  const beforeRestart = selection.effective_before_restart
  if (beforeRestart?.config?.acceptedRevision !== selection.accepted_revision_before + 1
    || beforeRestart.config.effectiveRevision !== selection.accepted_revision_before) return false
  if (beforeRestart.agent?.providerId !== sessionPrimaryProviderId
    || beforeRestart.agent.modelId !== sessionPrimaryModel) return false
  if (beforeRestart.binding?.primary?.providerInstanceId !== sessionPrimaryProviderId
    || beforeRestart.binding.primary.modelId !== sessionPrimaryModel
    || beforeRestart.binding.backup?.providerInstanceId !== sessionBackupProviderId
    || beforeRestart.binding.backup?.modelId !== sessionBackupModel) return false
  const beforeApply = selection.effective_before_apply
  if (beforeApply?.config?.acceptedRevision !== selection.accepted_revision_before + 2
    || beforeApply.config.effectiveRevision !== selection.accepted_revision_before) return false
  if (beforeApply.agent?.providerId !== sessionPrimaryProviderId
    || beforeApply.agent.modelId !== sessionPrimaryModel) return false
  if (beforeApply.binding?.primary?.providerInstanceId !== sessionManualProviderId
    || beforeApply.binding.primary.modelId !== sessionManualModel
    || beforeApply.binding.backup?.providerInstanceId !== sessionBackupProviderId
    || beforeApply.binding.backup?.modelId !== sessionBackupModel) return false
  const stages = selection.sampling_stages
  if (stages?.effective_before_restart?.after !== 'config.model.put'
    || stages.effective_before_restart.before !== 'manual config.bindModel'
    || stages.effective_before_apply?.after !== 'manual config.bindModel'
    || stages.effective_before_apply.before !== 'installed restart and explicit config.apply') return false
  const afterApply = selection.effective_after_apply
  if (afterApply?.providerId !== sessionManualProviderId || afterApply?.modelId !== sessionManualModel) return false
  if (afterApply?.sessionEffectiveRevision !== selection.accepted_revision_after) return false
  if (!bb10TurnPass(selection.turn)) return false
  if (selection.provider_request_model !== sessionManualModel) return false
  if (selection.primary_requests !== selection.primary_requests_before) return false
  return selection.backup_requests === selection.backup_requests_before
}

/** Boundary (2): a stale Console revision is refused and changes nothing. */
function bb10StaleCasPass(stale) {
  if (stale === undefined) return false
  if (stale.reply?.ok !== false || stale.reply?.error?.code !== 'REVISION_CONFLICT') return false
  if (stale.stale_revision !== 1 || stale.current_revision !== 3) return false
  return JSON.stringify(stale.before) === JSON.stringify(stale.after)
}

/** Boundary (3): a rejected catalog credential is a typed UNAUTHENTICATED refusal. */
function bb10InvalidCredentialPass(invalid) {
  if (invalid === undefined) return false
  if (invalid.refresh?.ok !== false || invalid.refresh?.error?.code !== 'UNAUTHENTICATED') return false
  if (invalid.refresh?.error?.providerInstanceId !== sessionPrimaryProviderId) return false
  if (!Array.isArray(invalid.catalog_requests) || invalid.catalog_requests.length === 0) return false
  if (!invalid.catalog_requests.some(request => request?.status === 401)) return false
  if (JSON.stringify(invalid.before) !== JSON.stringify(invalid.after)) return false
  if (invalid.before?.config?.acceptedRevision !== 4 || invalid.before.config.effectiveRevision !== 4
    || invalid.before.config.applyState !== 'clean') return false
  if (invalid.before.binding?.primary?.providerInstanceId !== sessionManualProviderId
    || invalid.before.binding.primary.modelId !== sessionManualModel
    || invalid.before.binding.backup?.providerInstanceId !== sessionBackupProviderId
    || invalid.before.binding.backup?.modelId !== sessionBackupModel) return false
  if (invalid.before.agent?.providerId !== sessionManualProviderId || invalid.before.agent.modelId !== sessionManualModel
    || invalid.before.agent.sessionEffectiveRevision !== 4) return false
  if (invalid.manual_inference_requests_after !== invalid.manual_inference_requests_before) return false
  return invalid.backup_inference_requests_after === invalid.backup_inference_requests_before
}

/** Boundary (4): the bound provider fails and no implicit failover happens. */
function bb10NoImplicitFailoverPass(noFailover) {
  if (noFailover === undefined) return false
  const final = noFailover.failed_final
  if (final?.kind !== 'final' || final?.state !== 'failed') return false
  if (final?.error?.name !== 'APIError' || final?.error?.data?.statusCode !== 500) return false
  if (noFailover.bound_provider_request?.status !== 500) return false
  if (noFailover.bound_provider_request?.model !== sessionManualModel) return false
  if (typeof noFailover.failed_finals_after !== 'number'
    || noFailover.failed_finals_after <= noFailover.failed_finals_before) return false
  if (noFailover.primary_inference_requests_after !== noFailover.primary_inference_requests_before) return false
  if (noFailover.backup_inference_requests_after !== noFailover.backup_inference_requests_before) return false
  if (!(noFailover.manual_inference_requests_after > noFailover.manual_inference_requests_before)) return false
  if (noFailover.accepted_revision_before !== noFailover.effective_revision_before) return false
  if (noFailover.accepted_revision_after !== noFailover.effective_revision_after) return false
  if (noFailover.accepted_revision_before !== 4 || noFailover.accepted_revision_after !== 4) return false
  if (noFailover.snapshot_before?.binding?.primary?.providerInstanceId !== sessionManualProviderId
    || noFailover.snapshot_before.binding.primary.modelId !== sessionManualModel
    || noFailover.snapshot_before.binding.backup?.providerInstanceId !== sessionBackupProviderId
    || noFailover.snapshot_before.binding.backup?.modelId !== sessionBackupModel) return false
  return JSON.stringify(noFailover.snapshot_before) === JSON.stringify(noFailover.snapshot_after)
}

/** The accepted baseline is part of the boundary receipt, not an unrecorded fixture step. */
function bb10BaselinePass(baseline) {
  if (baseline?.discovery?.acceptedRevision !== 0) return false
  if (baseline.discovery.manual_catalog_state !== 'empty' || baseline.discovery.manual_model_count !== 0) return false
  const bind = baseline.bind_model
  if (bind?.request?.kind !== 'config.bindModel' || bind.request.agentId !== sessionAgentId
    || bind.request.expectedRevision !== 0 || bind.request.providerId !== sessionPrimaryProviderId
    || bind.request.modelId !== sessionPrimaryModel || bind.reply?.ok !== true) return false
  const accepted = baseline.accepted_after_bind
  if (accepted?.public?.acceptedRevision !== 1) return false
  if (accepted.binding?.primary?.providerInstanceId !== sessionPrimaryProviderId
    || accepted.binding.primary.modelId !== sessionPrimaryModel
    || accepted.binding.backup?.providerInstanceId !== sessionBackupProviderId
    || accepted.binding.backup?.modelId !== sessionBackupModel) return false
  const apply = baseline.apply
  if (apply?.request?.kind !== 'config.apply' || apply.request.agentId !== sessionAgentId || apply.reply?.ok !== true) return false
  if (apply.agent?.providerId !== sessionPrimaryProviderId || apply.agent.modelId !== sessionPrimaryModel
    || apply.agent.sessionEffectiveRevision !== 1) return false
  const settled = baseline.settled
  if (settled?.config?.acceptedRevision !== 1 || settled.config.effectiveRevision !== 1
    || settled.config.applyState !== 'clean') return false
  if (settled.agent?.providerId !== sessionPrimaryProviderId || settled.agent.modelId !== sessionPrimaryModel
    || settled.agent.sessionEffectiveRevision !== 1) return false
  return settled.binding?.primary?.providerInstanceId === sessionPrimaryProviderId
    && settled.binding.primary.modelId === sessionPrimaryModel
    && settled.binding.backup?.providerInstanceId === sessionBackupProviderId
    && settled.binding.backup?.modelId === sessionBackupModel
}

/** A boundary PASS receipt must disclose where each asserted fact came from. */
function bb10BoundarySourcesPass(sources) {
  return ['binding', 'config', 'agent', 'provider_requests', 'session_terminal', 'combination']
    .every(key => typeof sources?.[key] === 'string' && sources[key].trim() !== '')
}

/** Boundary section: four named results plus installed identity and cleanup. */
function bb10BoundaryResultPass(boundary) {
  if (boundary?.status !== 'passed') return false
  if (!bb10BaselinePass(boundary.baseline) || !bb10BoundarySourcesPass(boundary.sources)) return false
  const identity = boundary.installed_identity
  if (identity?.installed_content_sha256 === undefined
    || identity.installed_content_sha256 !== identity.expected_content_sha256) return false
  const cleanup = boundary.cleanup
  if (cleanup?.stopped !== true || cleanup?.console_listener_gone !== true) return false
  if (!Array.isArray(cleanup?.owned_pids_alive_after_stop) || cleanup.owned_pids_alive_after_stop.length !== 0) return false
  if (cleanup?.temporary_root_removed !== true) return false
  const results = boundary.results
  return bb10ManualSelectionPass(results?.manual_selection)
    && bb10StaleCasPass(results?.stale_cas)
    && bb10InvalidCredentialPass(results?.invalid_credential)
    && bb10NoImplicitFailoverPass(results?.no_implicit_failover)
}

/** The single owner of the BB10 PASS judgment: both sections must pass. */
function bb10PassVerdict(realAcceptance, boundary) {
  return bb10RealAcceptancePass(realAcceptance) && bb10BoundaryResultPass(boundary)
}

/**
 * A successful boundary Session turn has the same public meaning as a real
 * turn: a completed final and a non-empty assistant text part on the exact
 * Session. The provider request itself is asserted from the stub counter.
 */
async function boundarySuccessfulTurn(client, sessionId, prompt, label) {
  const events = async () => readSessionEvents(
    await readInstalledProjection(client, undefined, 'boundary-events'), sessionAgentId, sessionId)
  const finalsBefore = (await events()).filter(event => event.kind === 'final').length
  const sent = await client.sessionMessage(sessionAgentId, sessionId, { text: prompt })
  assert(sent.body.ok === true, `${label} dispatch failed: ${JSON.stringify(sent.body)}`)
  const final = await waitForSessionTurn(events, finalsBefore, label)
  assert(final.state === 'completed', `${label} did not complete successfully: ${JSON.stringify(final)}`)
  const parts = (await events()).filter(event => event.kind === 'part' && event.partType === 'text'
    && typeof event.text === 'string' && event.text.trim() !== '')
  assert(parts.length > 0, `${label} produced no non-empty assistant text: ${JSON.stringify(await events())}`)
  return { dispatch: publicJson(sent.body), final: publicJson(final), text: parts.at(-1).text.trim() }
}

/**
 * The boundary section is a separate installed fixture. It owns its HOME, data
 * directory, dynamic ports and prefix so the real acceptance fixture is fully
 * stopped and removed before this section starts.
 */
async function runBB10Boundary(context, evidenceDir) {
  // The boundary's own synthetic credential is registered before the fixture
  // starts so no boundary evidence sink can persist it, including the polluted
  // provider-error object this section deliberately constructs.
  registerEvidenceSecret(bb10BoundarySyntheticCredentialValue)
  const boundaryRoot = join(evidenceDir, 'boundary')
  mkdirSync(boundaryRoot, { recursive: true })
  const fixture = installPackage(context.packRoot, boundaryRoot, 'bb10-boundary')
  const primary = createSessionProviderStub({ models: [sessionPrimaryModel] })
  const backup = createSessionProviderStub({ models: [sessionBackupModel] })
  const manual = createSessionProviderStub({ models: [] })
  const invalidCredentialStub = createSessionProviderStub({ models: [], catalog401: true })
  let lifecycle
  let console
  let client
  let cleanupEvidence
  const results = {}
  const snapshotSources = {
    binding: 'installed Console /api/v1/projection config row acceptedBinding',
    config: 'installed Console /api/v1/projection config row',
    agent: 'installed Console /api/v1/projection Agent row',
    provider_requests: 'boundary provider stub external request records',
    session_terminal: 'installed Console /api/v1/projection Session events',
    combination: 'config acceptedBinding and effective revision from one projection response; Agent row validated under the same public read',
  }
  try {
    const primaryUrl = await listenProviderStub(primary)
    const backupUrl = await listenProviderStub(backup)
    const manualUrl = await listenProviderStub(manual)
    const invalidCredentialUrl = await listenProviderStub(invalidCredentialStub)
    const config = ensureUserConfig(fixture, boundaryRoot, {
      buildConfigText: searchExecutable => sessionConfigFixtureText(
        { primary: primaryUrl, backup: backupUrl, manual: manualUrl }, searchExecutable),
    })
    assert(config.configText.includes(sessionManualProviderId) && config.configText.includes(sessionPrimaryProviderId),
      'the boundary fixture config omitted its stub providers')
    lifecycle = startAndReadLifecycle(fixture, boundaryRoot, 'bb10-boundary')
    console = startInstalledSessionConsole(fixture, boundaryRoot, 'bb10-boundary')
    client = sessionConsoleClient(console.url, console.authorization)
    const launchEnvironment = fixture.env

    // (0) Establish an accepted/effective baseline before the four sub-scenarios.
    // Discovery reads no durable accepted binding: the first accept must happen
    // through the public command path below.
    const discovery = await readInstalledProjection(client, boundaryRoot, 'boundary-discovery')
    const discoveryConfig = discovery.configs.find(row => row.agentId === sessionAgentId)
    assert(discoveryConfig !== undefined && discoveryConfig.acceptedRevision === 0,
      `the boundary fixture did not start at accepted revision 0: ${JSON.stringify(discoveryConfig)}`)
    const manualCatalog = discoveryConfig.providers.find(provider => provider.id === sessionManualProviderId)
    assert(manualCatalog?.catalogState === 'empty' && manualCatalog.models.length === 0,
      `the boundary manual provider catalog was not empty: ${JSON.stringify(manualCatalog)}`)
    const baselineReceipt = {
      discovery: {
        acceptedRevision: discoveryConfig.acceptedRevision,
        manual_catalog_state: manualCatalog.catalogState,
        manual_model_count: manualCatalog.models.length,
      },
    }
    results.baseline = baselineReceipt
    writeJson(join(boundaryRoot, 'baseline.json'), baselineReceipt)
    const baselineBindRequest = { kind: 'config.bindModel', agentId: sessionAgentId,
      expectedRevision: discoveryConfig.acceptedRevision,
      providerId: sessionPrimaryProviderId, modelId: sessionPrimaryModel }
    const baselineBind = await client.command(baselineBindRequest)
    baselineReceipt.bind_model = { request: baselineBindRequest, reply: publicJson(baselineBind.body) }
    writeJson(join(boundaryRoot, 'baseline.json'), baselineReceipt)
    assert(baselineBind.body.ok === true,
      `the boundary baseline accept failed: ${JSON.stringify(baselineBind.body)}`)
    // Before apply there is no effective slice, so step 3 checks only the
    // accepted binding from the public config row.
    const afterBaselineBind = await readInstalledProjection(client, boundaryRoot, 'boundary-baseline-bind')
    const acceptedAfterBind = readAcceptedBinding(lifecycle.internal.internalPath, sessionAgentId)
    writeJson(join(boundaryRoot, 'baseline-durable-diagnostic.json'), acceptedAfterBind)
    const baselineBinding = boundaryAcceptedBindingSnapshot(afterBaselineBind, sessionAgentId)
    baselineReceipt.accepted_after_bind = {
      public: baselineBinding.config,
      binding: baselineBinding.binding,
      durable_accepted_revision_diagnostic: acceptedAfterBind.accepted_revision,
      effective_revision_reason: baselineBinding.config.effectiveRevision === null
        ? 'the public effective revision is not published before config.apply'
        : null,
    }
    writeJson(join(boundaryRoot, 'baseline.json'), baselineReceipt)
    assert(baselineBinding.config.acceptedRevision === 1,
      `the boundary baseline bind did not create public accepted revision 1: ${JSON.stringify(baselineBinding.config)}`)
    assert(acceptedAfterBind.accepted_revision === baselineBinding.config.acceptedRevision,
      `the private baseline diagnostic disagrees with the public accepted revision: ${JSON.stringify({
        durable: acceptedAfterBind.accepted_revision, public: baselineBinding.config.acceptedRevision,
      })}`)
    assert(baselineBinding.binding.primary.providerInstanceId === sessionPrimaryProviderId
      && baselineBinding.binding.primary.modelId === sessionPrimaryModel,
    `the boundary baseline bind changed the primary binding: ${JSON.stringify(baselineBinding.binding)}`)
    assert(baselineBinding.binding.backup?.providerInstanceId === sessionBackupProviderId
      && baselineBinding.binding.backup?.modelId === sessionBackupModel,
    `the boundary baseline bind did not preserve the existing backup: ${JSON.stringify(baselineBinding.binding)}`)

    // (1) Apply the accepted baseline, then exercise empty-catalog explicit
    // manual model selection, installed restart, and one successful Session.
    const baselineApplyRequest = { kind: 'config.apply', agentId: sessionAgentId }
    const firstApply = await applySessionConfigAndWait(client, sessionAgentId, boundaryRoot, 'boundary-initial',
      reply => { baselineReceipt.apply = { request: baselineApplyRequest, reply }; writeJson(join(boundaryRoot, 'baseline.json'), baselineReceipt) })
    assert(firstApply.agent.providerId === sessionPrimaryProviderId && firstApply.agent.modelId === sessionPrimaryModel,
      `the boundary initial primary binding was not effective: ${JSON.stringify(firstApply.agent)}`)
    const baselineProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-baseline')
    const baseline = installedBindingSnapshot(baselineProjection, sessionAgentId)
    assert(baseline.config.acceptedRevision === 1 && baseline.config.effectiveRevision === 1
      && baseline.config.applyState === 'clean' && baseline.agent.sessionEffectiveRevision === 1,
      `the boundary baseline is not settled: ${JSON.stringify(baseline.config)}`)
    baselineReceipt.apply.agent = firstApply.agent
    baselineReceipt.settled = baseline
    writeJson(join(boundaryRoot, 'baseline.json'), baselineReceipt)
    assert(primary.requests.length === 0 && backup.requests.length === 0 && manual.requests.length === 0,
      `the boundary baseline bind/apply sent an inference request: ${JSON.stringify({
        primary: primary.requests.length, backup: backup.requests.length, manual: manual.requests.length,
      })}`)

    const refresh = await client.command({ kind: 'config.refreshModels', agentId: sessionAgentId,
      expectedRevision: baseline.config.acceptedRevision, providerId: sessionManualProviderId })
    assert(refresh.body.ok === true, `the boundary manual catalog refresh failed: ${JSON.stringify(refresh.body)}`)
    const afterRefresh = await readInstalledProjection(client, boundaryRoot, 'boundary-refresh')
    const refreshedRow = afterRefresh.configs.find(row => row.agentId === sessionAgentId)
    const refreshedManual = refreshedRow.providers.find(provider => provider.id === sessionManualProviderId)
    assert(refreshedManual?.catalogState === 'empty' && refreshedManual.models.length === 0,
      `the boundary manual catalog refresh was not observed as empty: ${JSON.stringify(refreshedManual)}`)
    const refreshedAgent = afterRefresh.agents.find(row => row.agentId === sessionAgentId)
    assert(refreshedRow.acceptedRevision === baseline.config.acceptedRevision
      && refreshedRow.effectiveRevision === baseline.config.effectiveRevision
      && refreshedAgent?.providerId === sessionPrimaryProviderId
      && refreshedAgent.modelId === sessionPrimaryModel
      && refreshedAgent.sessionEffectiveRevision === 1,
      `the boundary manual catalog refresh advanced accepted: ${JSON.stringify(refreshedRow)}`)
    const manualEntry = { ref: { providerInstanceId: sessionManualProviderId, modelId: sessionManualModel },
      origin: 'manual', base: { label: 'BB Boundary Manual Model' }, overrides: {} }
    const putModel = await client.command({ kind: 'config.model.put', agentId: sessionAgentId,
      expectedRevision: baseline.config.acceptedRevision, entry: manualEntry })
    assert(putModel.body.ok === true, `the boundary manual model put failed: ${JSON.stringify(putModel.body)}`)
    const afterPut = await readInstalledProjection(client, boundaryRoot, 'boundary-manual-put')
    const putRow = afterPut.configs.find(row => row.agentId === sessionAgentId)
    assert(putRow.acceptedRevision === baseline.config.acceptedRevision + 1,
      `the boundary manual model put did not advance accepted by one: ${JSON.stringify(putRow)}`)
    const beforeSelection = installedBindingSnapshot(afterPut, sessionAgentId)
    assert(beforeSelection.config.acceptedRevision === baseline.config.acceptedRevision + 1
      && beforeSelection.config.effectiveRevision === baseline.config.effectiveRevision
      && beforeSelection.agent.providerId === sessionPrimaryProviderId
      && beforeSelection.agent.modelId === sessionPrimaryModel
      && beforeSelection.agent.sessionEffectiveRevision === baseline.agent.sessionEffectiveRevision
      && beforeSelection.binding.primary.providerInstanceId === sessionPrimaryProviderId
      && beforeSelection.binding.primary.modelId === sessionPrimaryModel
      && beforeSelection.binding.backup?.providerInstanceId === sessionBackupProviderId
      && beforeSelection.binding.backup?.modelId === sessionBackupModel,
    `the boundary put changed the running Agent binding before restart: ${JSON.stringify(beforeSelection.agent)}`)
    const primaryRequestsBeforeSelection = primary.requests.length
    const backupRequestsBeforeSelection = backup.requests.length
    const bindModel = await client.command({ kind: 'config.bindModel', agentId: sessionAgentId,
      expectedRevision: baseline.config.acceptedRevision + 1, providerId: sessionManualProviderId, modelId: sessionManualModel })
    assert(bindModel.body.ok === true, `the boundary manual model bind failed: ${JSON.stringify(bindModel.body)}`)
    const afterBind = await readInstalledProjection(client, boundaryRoot, 'boundary-manual-bind')
    const bindRow = afterBind.configs.find(row => row.agentId === sessionAgentId)
    assert(bindRow.acceptedRevision === baseline.config.acceptedRevision + 2,
      `the boundary manual model bind did not advance accepted by one: ${JSON.stringify(bindRow)}`)
    const beforeRestart = installedBindingSnapshot(afterBind, sessionAgentId)
    assert(beforeRestart.config.acceptedRevision === baseline.config.acceptedRevision + 2
      && beforeRestart.config.effectiveRevision === baseline.config.effectiveRevision
      && beforeRestart.agent.providerId === sessionPrimaryProviderId
      && beforeRestart.agent.modelId === sessionPrimaryModel
      && beforeRestart.agent.sessionEffectiveRevision === baseline.agent.sessionEffectiveRevision
      && beforeRestart.binding.primary.providerInstanceId === sessionManualProviderId
      && beforeRestart.binding.primary.modelId === sessionManualModel
      && beforeRestart.binding.backup?.providerInstanceId === sessionBackupProviderId
      && beforeRestart.binding.backup?.modelId === sessionBackupModel,
    `the boundary bind changed the running Agent before restart: ${JSON.stringify(beforeRestart.agent)}`)
    const generationBeforeSwitch = lifecycle.parsed.generation
    await stopSessionFixture(fixture, lifecycle, boundaryRoot, 'bb10-boundary-switch')
    lifecycle = startAndReadLifecycle(fixture, boundaryRoot, 'bb10-boundary-switch', defaultAgentIds, { launchEnv: launchEnvironment })
    assert(lifecycle.parsed.generation > generationBeforeSwitch,
      `the boundary installed restart did not advance the launcher generation: ${generationBeforeSwitch} -> ${lifecycle.parsed.generation}`)
    console = startInstalledSessionConsole(fixture, boundaryRoot, 'bb10-boundary-switch')
    client = sessionConsoleClient(console.url, console.authorization)
    const restartedProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-restarted')
    const restartedConfig = restartedProjection.configs.find(row => row.agentId === sessionAgentId)
    assert(restartedConfig.acceptedRevision === baseline.config.acceptedRevision + 2,
      `the boundary accepted revision did not survive restart: ${JSON.stringify(restartedConfig)}`)
    const switchedApply = await applySessionConfigAndWait(client, sessionAgentId, boundaryRoot, 'boundary-switch')
    assert(switchedApply.agent.providerId === sessionManualProviderId && switchedApply.agent.modelId === sessionManualModel,
      `the boundary manual selection did not become effective: ${JSON.stringify(switchedApply.agent)}`)
    const switchedProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-switch-effective')
    const switchedConfig = switchedProjection.configs.find(row => row.agentId === sessionAgentId)
    assert(switchedConfig.acceptedRevision === 3 && switchedConfig.effectiveRevision === 3,
      `the boundary apply did not settle effective at accepted: ${JSON.stringify(switchedConfig)}`)
    assert(switchedApply.agent.sessionEffectiveRevision === switchedConfig.acceptedRevision,
      `the boundary Agent session revision does not match accepted: ${JSON.stringify(switchedApply.agent)}`)
    const switchedSession = await createAndOpenSession(client, 'BB10 boundary manual selection', boundaryRoot, 'boundary-switch')
    const manualPrompt = 'bb10 boundary manual selection probe'
    const manualTurn = await boundarySuccessfulTurn(client, switchedSession.sessionId, manualPrompt, 'the boundary manual turn')
    const manualRequest = await waitForAsync(async () => manual.requests.map(text => JSON.parse(text))
      .find(request => JSON.stringify(request.messages ?? '').includes(manualPrompt)), 120_000,
    'the boundary manual provider stub to receive the Session prompt')
    assert(manualRequest.model === sessionManualModel,
      `the boundary manual turn used model ${manualRequest.model}, not ${sessionManualModel}`)
    assert(primary.requests.length === primaryRequestsBeforeSelection && backup.requests.length === backupRequestsBeforeSelection,
      `the boundary manual turn used a non-selected provider: ${JSON.stringify({
        primary: primary.requests.length, backup: backup.requests.length,
      })}`)
    const manualSelection = {
      refresh: publicJson(refresh.body),
      catalog_state: refreshedManual.catalogState,
      model_count: refreshedManual.models.length,
      accepted_revision_before: baseline.config.acceptedRevision,
      put_model: publicJson(putModel.body),
      bind_model: publicJson(bindModel.body),
      accepted_revision_after: bindRow.acceptedRevision,
      effective_before_restart: beforeSelection,
      effective_before_apply: beforeRestart,
      sampling_stages: {
        effective_before_restart: {
          after: 'config.model.put',
          before: 'manual config.bindModel',
          accepted_revision: beforeSelection.config.acceptedRevision,
          effective_revision: beforeSelection.config.effectiveRevision,
        },
        effective_before_apply: {
          after: 'manual config.bindModel',
          before: 'installed restart and explicit config.apply',
          accepted_revision: beforeRestart.config.acceptedRevision,
          effective_revision: beforeRestart.config.effectiveRevision,
        },
      },
      restarted_accepted_revision: restartedConfig.acceptedRevision,
      effective_after_apply: publicJson(switchedApply.agent),
      turn: manualTurn,
      provider_request_model: manualRequest.model,
      primary_requests_before: primaryRequestsBeforeSelection,
      backup_requests_before: backupRequestsBeforeSelection,
      primary_requests: primary.requests.length,
      backup_requests: backup.requests.length,
      manual_requests: manual.requests.length,
    }
    results.manual_selection = manualSelection
    writeJson(join(boundaryRoot, 'manual-selection.json'), manualSelection)

    // (2) A stale Console revision is refused without moving accepted,
    // effective, binding, or the running Agent.
    const staleBeforeProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-stale-before')
    const staleBefore = installedBindingSnapshot(staleBeforeProjection, sessionAgentId)
    const staleRevision = baseline.config.acceptedRevision
    assert(staleRevision === baseline.config.acceptedRevision
      && staleBefore.config.acceptedRevision === baseline.config.acceptedRevision + 2
      && staleBefore.config.effectiveRevision === baseline.config.acceptedRevision + 2
      && staleRevision < staleBefore.config.acceptedRevision,
    `the boundary stale revision is not strictly older: ${JSON.stringify({
      staleRevision, current: staleBefore.config.acceptedRevision,
      effective: staleBefore.config.effectiveRevision,
    })}`)
    const staleRequest = { kind: 'config.bindModel', agentId: sessionAgentId, expectedRevision: staleRevision,
      providerId: sessionPrimaryProviderId, modelId: sessionPrimaryModel }
    const staleReply = await client.command(staleRequest)
    assert(staleReply.body.ok === false && staleReply.body.error?.code === 'REVISION_CONFLICT',
      `the boundary stale revision was not refused as REVISION_CONFLICT: ${JSON.stringify(staleReply.body)}`)
    const staleAfterProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-stale-after')
    const staleAfter = installedBindingSnapshot(staleAfterProjection, sessionAgentId)
    assert(JSON.stringify(staleAfter) === JSON.stringify(staleBefore),
      `the boundary stale refusal mutated the accepted/effective binding: ${JSON.stringify({ before: staleBefore, after: staleAfter })}`)
    const staleCas = { stale_revision: staleRevision, current_revision: staleBefore.config.acceptedRevision,
      request: staleRequest, reply: publicJson(staleReply.body), before: staleBefore, after: staleAfter }
    results.stale_cas = staleCas
    writeJson(join(boundaryRoot, 'stale-cas.json'), staleCas)

    // (3) A synthetic bearer credential whose provider answers 401 maps to
    // UNAUTHENTICATED while the configured binding stays unchanged.
    const invalidBeforeProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-invalid-before')
    const invalidBefore = installedBindingSnapshot(invalidBeforeProjection, sessionAgentId)
    assert(invalidBefore.config.acceptedRevision === 3 && invalidBefore.config.effectiveRevision === 3,
      `the boundary invalid-credential precondition was not settled at revision 3: ${JSON.stringify(invalidBefore.config)}`)
    const invalidCatalogRequestsBefore = invalidCredentialStub.catalogRequests.length
    const manualInferenceBeforeInvalid = manual.requests.length
    const backupInferenceBeforeInvalid = backup.requests.length
    const putInvalidProvider = await client.command({ kind: 'config.putProvider', agentId: sessionAgentId,
      expectedRevision: invalidBefore.config.acceptedRevision,
      provider: { id: sessionPrimaryProviderId, label: 'BB Boundary Invalid Credential', protocol: 'openai-chat',
        apiBaseUrl: `${invalidCredentialUrl}/v1`, enabled: true,
        auth: { kind: 'bearer', credentialRef: bb10BoundarySyntheticCredentialEnv } } })
    assert(putInvalidProvider.body.ok === true, `the boundary invalid provider replacement failed: ${JSON.stringify(putInvalidProvider.body)}`)
    const invalidAccepted = await readInstalledProjection(client, boundaryRoot, 'boundary-invalid-provider')
    const invalidAcceptedConfig = invalidAccepted.configs.find(row => row.agentId === sessionAgentId)
    assert(invalidAcceptedConfig.acceptedRevision === invalidBefore.config.acceptedRevision + 1,
      `the boundary invalid provider replacement did not advance accepted: ${JSON.stringify(invalidAcceptedConfig)}`)
    const generationBeforeInvalidRestart = lifecycle.parsed.generation
    await stopSessionFixture(fixture, lifecycle, boundaryRoot, 'bb10-boundary-invalid')
    lifecycle = startAndReadLifecycle(fixture, boundaryRoot, 'bb10-boundary-invalid', defaultAgentIds,
      { launchEnv: { ...fixture.env, [bb10BoundarySyntheticCredentialEnv]: bb10BoundarySyntheticCredentialValue } })
    assert(lifecycle.parsed.generation > generationBeforeInvalidRestart,
      `the boundary invalid-credential restart did not advance generation: ${generationBeforeInvalidRestart} -> ${lifecycle.parsed.generation}`)
    console = startInstalledSessionConsole(fixture, boundaryRoot, 'bb10-boundary-invalid')
    client = sessionConsoleClient(console.url, console.authorization)
    const invalidRestarted = await readInstalledProjection(client, boundaryRoot, 'boundary-invalid-restarted')
    const invalidRestartedConfig = invalidRestarted.configs.find(row => row.agentId === sessionAgentId)
    assert(invalidRestartedConfig.acceptedRevision === 4,
      `the boundary invalid provider accepted revision did not survive restart: ${JSON.stringify(invalidRestartedConfig)}`)
    const invalidApply = await applySessionConfigAndWait(client, sessionAgentId, boundaryRoot, 'boundary-invalid-apply')
    assert(invalidApply.agent.providerId === sessionManualProviderId && invalidApply.agent.modelId === sessionManualModel,
      `the boundary invalid-credential restart changed the effective manual binding: ${JSON.stringify(invalidApply.agent)}`)
    const invalidAppliedProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-invalid-applied')
    const invalidApplied = installedBindingSnapshot(invalidAppliedProjection, sessionAgentId)
    assert(invalidApplied.config.acceptedRevision === invalidBefore.config.acceptedRevision + 1
      && invalidApplied.config.effectiveRevision === invalidBefore.config.acceptedRevision + 1
      && invalidApplied.config.applyState === 'clean',
      `the boundary invalid-credential apply changed accepted unexpectedly: ${JSON.stringify(invalidApplied.config)}`)
    assert(invalidApply.agent.sessionEffectiveRevision === invalidBefore.config.acceptedRevision + 1,
      `the boundary invalid-credential apply changed the Agent session revision: ${JSON.stringify(invalidApply.agent)}`)
    const refreshInvalid = await client.command({ kind: 'config.refreshModels', agentId: sessionAgentId,
      expectedRevision: invalidApplied.config.acceptedRevision, providerId: sessionPrimaryProviderId })
    assert(refreshInvalid.body.ok === false && refreshInvalid.body.error?.code === 'UNAUTHENTICATED',
      `the boundary invalid credential was not refused as UNAUTHENTICATED: ${JSON.stringify(refreshInvalid.body)}`)
    assert(refreshInvalid.body.error?.providerInstanceId === sessionPrimaryProviderId,
      `the boundary invalid credential refusal did not identify the probed provider: ${JSON.stringify(refreshInvalid.body)}`)
    const invalidAfterProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-invalid-after')
    const invalidAfter = installedBindingSnapshot(invalidAfterProjection, sessionAgentId)
    assert(JSON.stringify(invalidAfter) === JSON.stringify(invalidApplied),
      `the boundary invalid-credential refusal mutated accepted/effective/binding: ${JSON.stringify({ before: invalidApplied, after: invalidAfter })}`)
    assert(invalidCredentialStub.catalogRequests.length >= invalidCatalogRequestsBefore + 1
      && invalidCredentialStub.catalogRequests.some(request => request.status === 401),
    `the boundary invalid credential did not reach the stub as a 401 catalog request: ${JSON.stringify(invalidCredentialStub.catalogRequests)}`)
    assert(manual.requests.length === manualInferenceBeforeInvalid
      && backup.requests.length === backupInferenceBeforeInvalid,
    `the boundary invalid credential probe touched a bound inference provider: ${JSON.stringify({
      manual: manual.requests.length, backup: backup.requests.length,
    })}`)
    const invalidCredential = {
      synthetic_credential_env: bb10BoundarySyntheticCredentialEnv,
      credential_length: bb10BoundarySyntheticCredentialValue.length,
      put_provider: publicJson(putInvalidProvider.body),
      restarted: publicJson(invalidRestartedConfig),
      apply: publicJson(invalidApply.agent),
      refresh: publicJson(refreshInvalid.body),
      catalog_requests: publicJson(invalidCredentialStub.catalogRequests),
      manual_inference_requests_before: manualInferenceBeforeInvalid,
      manual_inference_requests_after: manual.requests.length,
      backup_inference_requests_before: backupInferenceBeforeInvalid,
      backup_inference_requests_after: backup.requests.length,
      before: invalidApplied,
      after: invalidAfter,
    }
    results.invalid_credential = invalidCredential
    writeJson(join(boundaryRoot, 'invalid-credential.json'), invalidCredential)

    // (4) The bound manual provider fails with HTTP 500; the public Session
    // must show a new failed final and the backup must receive no new request.
    // A fresh Session on the post-restart child first receives one successful
    // manual turn, so both the counter and event baselines are on one live child.
    const noFailoverSession = await createAndOpenSession(client, 'BB10 boundary no implicit failover',
      boundaryRoot, 'boundary-no-failover')
    const warmupPrompt = 'bb10 boundary manual warmup probe'
    const warmupTurn = await boundarySuccessfulTurn(client, noFailoverSession.sessionId, warmupPrompt,
      'the boundary manual warm-up turn')
    await waitForAsync(async () => manual.requests.map(text => JSON.parse(text))
      .find(request => JSON.stringify(request.messages ?? '').includes(warmupPrompt)), 120_000,
    'the boundary manual provider to receive the warm-up prompt')
    const noFailoverBeforeProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-no-failover-before')
    const noFailoverBefore = installedBindingSnapshot(noFailoverBeforeProjection, sessionAgentId)
    assert(noFailoverBefore.config.acceptedRevision === 4 && noFailoverBefore.config.effectiveRevision === 4
      && noFailoverBefore.agent.sessionEffectiveRevision === 4
      && noFailoverBefore.binding.primary.providerInstanceId === sessionManualProviderId
      && noFailoverBefore.binding.primary.modelId === sessionManualModel
      && noFailoverBefore.binding.backup?.providerInstanceId === sessionBackupProviderId
      && noFailoverBefore.binding.backup?.modelId === sessionBackupModel,
    `the boundary no-failover baseline was not settled at revision 4: ${JSON.stringify(noFailoverBefore)}`)
    const eventsBefore = readSessionEvents(noFailoverBeforeProjection, sessionAgentId, noFailoverSession.sessionId)
    const failedFinalsBefore = eventsBefore.filter(event => event.kind === 'final' && event.state === 'failed').length
    const primaryInferenceBeforeFailover = primary.requests.length
    const backupInferenceBeforeFailover = backup.requests.length
    const manualInferenceBeforeFailover = manual.requests.length
    manual.state.fail = true
    const noFailoverPrompt = 'bb10 boundary no implicit failover probe'
    const noFailoverDispatch = await client.sessionMessage(sessionAgentId, noFailoverSession.sessionId,
      { text: noFailoverPrompt }, bb10DispatchTimeoutMs).then(
      response => ({ ok: true, response }), error => ({ ok: false, error }))
    const failedManualRequest = await waitForAsync(async () => manual.inferenceResponses
      .slice(manualInferenceBeforeFailover)
      .find(response => response.prompt.includes(noFailoverPrompt) && response.status === 500), 120_000,
    'the boundary failing manual provider to receive the probe and return 500')
    const failedFinal = await waitForAsync(async () => {
      const failures = readSessionEvents(await readInstalledProjection(client, undefined, 'boundary-no-failover-events'),
        sessionAgentId, noFailoverSession.sessionId)
        .filter(event => event.kind === 'final' && event.state === 'failed')
      return failures.length > failedFinalsBefore ? failures.at(-1) : undefined
    }, 120_000, 'the boundary failed Session final')
    assert(failedFinal.error?.name === 'APIError' && failedFinal.error?.data?.statusCode === 500,
      `the boundary failed final did not carry the upstream APIError statusCode=500: ${JSON.stringify(failedFinal)}`)
    assert(failedFinal.messageId !== undefined && failedFinal.sessionId === noFailoverSession.sessionId,
      `the boundary failed final did not preserve Session/message identity: ${JSON.stringify(failedFinal)}`)
    const noFailoverAfterProjection = await readInstalledProjection(client, boundaryRoot, 'boundary-no-failover-after')
    const noFailoverAfter = installedBindingSnapshot(noFailoverAfterProjection, sessionAgentId)
    const failedFinalsAfter = readSessionEvents(noFailoverAfterProjection, sessionAgentId, noFailoverSession.sessionId)
      .filter(event => event.kind === 'final' && event.state === 'failed').length
    assert(JSON.stringify(noFailoverAfter) === JSON.stringify(noFailoverBefore),
      `the boundary failed turn mutated accepted/effective/binding: ${JSON.stringify({ before: noFailoverBefore, after: noFailoverAfter })}`)
    assert(primary.requests.length === primaryInferenceBeforeFailover
      && backup.requests.length === backupInferenceBeforeFailover,
    `the boundary failed manual turn silently failed over: ${JSON.stringify({
      primary: primary.requests.length, backup: backup.requests.length,
    })}`)
    const noImplicitFailover = {
      prompt: noFailoverPrompt,
      session: noFailoverSession.created,
      warmup: warmupTurn,
      dispatch: noFailoverDispatch.ok ? publicJson(noFailoverDispatch.response.body) : String(noFailoverDispatch.error),
      bound_provider_request: publicJson(failedManualRequest),
      failed_final: publicJson(failedFinal),
      failed_finals_before: failedFinalsBefore,
      failed_finals_after: failedFinalsAfter,
      accepted_revision_before: noFailoverBefore.config.acceptedRevision,
      effective_revision_before: noFailoverBefore.config.effectiveRevision,
      accepted_revision_after: noFailoverAfter.config.acceptedRevision,
      effective_revision_after: noFailoverAfter.config.effectiveRevision,
      snapshot_before: noFailoverBefore,
      snapshot_after: noFailoverAfter,
      primary_inference_requests_before: primaryInferenceBeforeFailover,
      primary_inference_requests_after: primary.requests.length,
      backup_inference_requests_before: backupInferenceBeforeFailover,
      backup_inference_requests_after: backup.requests.length,
      manual_inference_requests_before: manualInferenceBeforeFailover,
      manual_inference_requests_after: manual.requests.length,
    }
    results.no_implicit_failover = noImplicitFailover
    writeJson(join(boundaryRoot, 'no-failover.json'), noImplicitFailover)

    // (5) Provider error-body echo: the bound provider's HTTP 500 body carries
    // the boundary's own synthetic credential and an auth field. Only this
    // boundary env supplies the value. The original observation assertions above
    // are already complete; this named sub-scenario records the EXPECTED boundary
    // rejection and never persists the raw provider error.
    const echoSession = await createAndOpenSession(client, 'BB10 boundary credential echo',
      boundaryRoot, 'boundary-echo')
    manual.state.failBody = { error: { message: `upstream rejected ${bb10BoundarySyntheticCredentialValue}`,
      authorization: `Bearer ${bb10BoundarySyntheticCredentialValue}` } }
    const echoDispatch = await client.sessionMessage(sessionAgentId, echoSession.sessionId,
      { text: 'bb10 boundary credential echo probe' }, bb10DispatchTimeoutMs).then(
      response => ({ ok: true, response }), error => ({ ok: false, error }))
    const echoFailedFinal = await waitForAsync(async () => {
      const failures = readSessionEvents(await readInstalledProjection(client, undefined, 'boundary-echo-events'),
        sessionAgentId, echoSession.sessionId)
        .filter(event => event.kind === 'final' && event.state === 'failed')
      return failures.length > 0 ? failures.at(-1) : undefined
    }, 120_000, 'the boundary credential-echo failed Session final')
    // Prove the substrate really propagated the polluted body to a public face.
    const propagated = JSON.stringify(echoFailedFinal).includes(bb10BoundarySyntheticCredentialValue)
    manual.state.failBody = undefined
    let echoRejection
    try {
      writeJson(join(boundaryRoot, 'credential-echo.json'), {
        provider_error: publicJson(echoFailedFinal),
        dispatch: echoDispatch.ok ? publicJson(echoDispatch.response.body) : null,
      })
    } catch (error) {
      echoRejection = error
    }
    if (propagated) {
      assert(echoRejection?.evidenceBoundaryRejected === true,
        `the boundary did not reject a provider error that echoed the synthetic credential: ${String(echoRejection)}`)
    }
    const credentialEcho = {
      status: propagated ? 'propagated_and_rejected' : 'not_propagated',
      synthetic_credential_env: bb10BoundarySyntheticCredentialEnv,
      synthetic_credential_length: bb10BoundarySyntheticCredentialValue.length,
      session: echoSession.created,
      dispatch_ok: echoDispatch.ok,
      failed_final_observed: echoFailedFinal !== undefined,
      failed_final_error_name: echoFailedFinal.error?.name ?? null,
      failed_final_status_code: echoFailedFinal.error?.data?.statusCode ?? null,
      provider_error_stored: false,
      expected_rejection: propagated
        ? { required: true, observed: echoRejection?.evidenceBoundaryRejected === true,
            category: echoRejection?.evidenceCategory ?? null, sink: echoRejection?.evidenceSink ?? null }
        : { required: false, observed: false, reason: 'the substrate did not propagate the synthetic value to a public Session final' },
    }
    results.credential_echo = credentialEcho
    writeJson(join(boundaryRoot, 'credential-echo-observation.json'), credentialEcho)

    const finalStop = await stopSessionFixture(fixture, lifecycle, boundaryRoot, 'bb10-boundary')
    const finalPids = lifecyclePids(lifecycle.internal)
    const consoleGone = consoleListenerGone(console.url)
    assert(consoleGone, `the boundary Console endpoint survived stop: ${console.url}`)
    assert(finalPids.every(pid => !processAlive(pid)),
      `the boundary owned processes remain after stop: ${finalPids.filter(processAlive).join(', ')}`)
    lifecycle = undefined
    fixture.cleanup()
    cleanupEvidence = {
      stopped: true,
      stop_stdout: finalStop.stop.stdout,
      stopped_stdout: finalStop.status.stdout,
      console_listener_gone: consoleGone,
      owned_pids_after_stop: finalPids,
      owned_pids_alive_after_stop: finalPids.filter(processAlive),
      temporary_root_removed: !existsSync(fixture.temporaryRoot),
    }
    writeJson(join(boundaryRoot, 'cleanup.json'), cleanupEvidence)
    const boundaryResult = {
      status: 'passed',
      baseline: publicJson(results.baseline),
      sources: publicJson(snapshotSources),
      installed_identity: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        expected_content_sha256: stagedPackageContentSha256(),
      },
      results: publicJson(results),
      cleanup: cleanupEvidence,
      evidence_path: boundaryRoot,
    }
    assert(boundaryResult.installed_identity.installed_content_sha256
      === boundaryResult.installed_identity.expected_content_sha256,
    `the boundary fixture installed content does not match the frozen package hash: ${JSON.stringify(boundaryResult.installed_identity)}`)
    writeJson(join(boundaryRoot, 'boundary-result.json'), boundaryResult)
    // Post-hoc audit of the whole boundary tree, covering both the real and the
    // synthetic credential. This complements the pre-write boundary.
    assertNoSecretInEvidence(evidenceDir,
      [bb10BoundarySyntheticCredentialValue, consolePassword])
    return boundaryResult
  } catch (error) {
    const partial = {
      status: 'failed',
      stage: 'boundary',
      error: error instanceof Error ? error.message : String(error),
      baseline: publicJson(results.baseline ?? null),
      sources: publicJson(snapshotSources),
      results: publicJson(results),
      evidence_path: boundaryRoot,
    }
    writeJson(join(boundaryRoot, 'boundary-result.json'), partial)
    try {
      const stopped = lifecycle === undefined
        ? undefined
        : await stopSessionFixture(fixture, lifecycle, boundaryRoot, 'bb10-boundary-failure')
      lifecycle = undefined
      const pids = stopped?.pids ?? []
      const consoleGone = console === undefined ? true : consoleListenerGone(console.url)
      fixture.cleanup()
      cleanupEvidence = {
        stopped: stopped !== undefined,
        console_listener_gone: consoleGone,
        owned_pids_after_stop: pids,
        owned_pids_alive_after_stop: pids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      }
    } catch (cleanupError) {
      cleanupEvidence = { stopped: false, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }
    }
    writeJson(join(boundaryRoot, 'cleanup.json'), cleanupEvidence)
    throw error
  } finally {
    stopFixtureIfNeeded(fixture, lifecycle?.parsed.generation)
    await closeProviderStub(primary)
    await closeProviderStub(backup)
    await closeProviderStub(manual)
    await closeProviderStub(invalidCredentialStub)
    try {
      fixture.cleanup()
    } catch {
      // The boundary result records the primary observation.
    }
  }
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
const bb10BoundarySyntheticCredentialEnv = 'AGENTTEAMS_BB10_BOUNDARY_SYNTHETIC_KEY'
const bb10BoundarySyntheticCredentialValue = `bb10-boundary-${randomUUID()}`

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
  // Register the real canonical credential with the run-level evidence boundary
  // before any BB10 evidence is written and before the launcher is started.
  registerEvidenceSecret(credentialValue)
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
  const protocolFor = (protocol, label) => {
    if (protocol === 'openai-chat' || protocol === 'openai-responses') return protocol
    fail(`${label} protocol is missing or unsupported: ${JSON.stringify(protocol)}`)
  }
  // Teams joins `/models` and the endpoint selected by this declared protocol
  // onto `apiBaseUrl`, so the source base URL (already ending in `/v1`) is
  // persisted as-is and every provider keeps its own protocol.
  const provider = (id, label, baseUrl, protocol, credentialEnv) => `
[providers.${id}]
protocol = ${JSON.stringify(protocolFor(protocol, `${label} provider`))}
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
${provider(rccProviderId, 'RCC 4444', spec.rccBaseUrl, spec.rccProtocol)}
${provider(canonicalProviderId, 'GoAIChat OpenAI', spec.canonicalBaseUrl, spec.canonicalProtocol, canonicalCredentialEnv)}

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
  // The real provider precondition is missing, so the deterministic boundary
  // section never starts: it is explicitly `not_run`, never a substitute pass.
  const realAcceptance = {
    status: 'unverified',
    missing_capability: missingCapability,
    error: message,
    detail: publicJson(detail),
    cleanup,
  }
  const boundary = {
    status: 'not_run',
    reason: 'the real acceptance precondition was not satisfied; the boundary fixture was not started',
    missing_capability: missingCapability,
  }
  writeJson(join(evidenceDir, 'bb10-unverified.json'), {
    missing_capability: missingCapability, message, detail: publicJson(detail), cleanup,
    real_acceptance: realAcceptance, boundary,
  })
  return {
    status: 'unverified',
    missing_capability: missingCapability,
    public_input: { package: context.packRoot, case: 'BB10' },
    external_observation: {
      missing_capability: missingCapability, error: message, detail: publicJson(detail), cleanup,
      real_acceptance: realAcceptance, boundary,
    },
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
        rccProtocol: preconditions.rcc.protocol,
        canonicalBaseUrl: preconditions.canonical.baseUrl,
        canonicalProtocol: preconditions.canonical.protocol,
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

    // (d) Explicitly switch the canonical provider to primary, then retain the
    // original RCC primary as the backup reference through the Console config
    // entry, then apply it through the installed restart.
    const beforeSelection = (await readInstalledProjection(client, undefined, 'bb10-selection-before'))
      .configs.find(row => row.agentId === sessionAgentId)
    const selectionRevision = beforeSelection.acceptedRevision
    const bindModel = await client.command({ kind: 'config.bindModel', agentId: sessionAgentId,
      expectedRevision: selectionRevision, providerId: canonicalProviderId, modelId: preconditions.canonical.defaultModel })
    assert(bindModel.body.ok === true, `the explicit primary selection failed: ${JSON.stringify(bindModel.body)}`)
    const acceptedPrimary = (await readInstalledProjection(client, evidenceDir, 'bb10-selection-primary-accepted'))
      .configs.find(row => row.agentId === sessionAgentId)
    assert(acceptedPrimary.acceptedRevision === selectionRevision + 1,
      `the explicit primary selection did not advance by one: ${JSON.stringify(acceptedPrimary)}`)
    const selectBackup = await client.command({ kind: 'config.agent.select-backup', agentId: sessionAgentId,
      expectedRevision: selectionRevision + 1,
      backup: { providerInstanceId: rccProviderId, modelId: rccSelectedModelToken } })
    assert(selectBackup.body.ok === true, `the explicit backup selection failed: ${JSON.stringify(selectBackup.body)}`)
    const acceptedSelection = (await readInstalledProjection(client, evidenceDir, 'bb10-selection-accepted'))
      .configs.find(row => row.agentId === sessionAgentId)
    assert(acceptedSelection.acceptedRevision === selectionRevision + 2,
      `the accepted revision did not advance with the explicit selection: ${JSON.stringify(acceptedSelection)}`)
    const acceptedBinding = acceptedSelection.acceptedBinding
    assert(acceptedBinding !== null && typeof acceptedBinding === 'object',
      `the public config row did not publish an accepted binding: ${JSON.stringify(acceptedSelection)}`)
    assert(acceptedBinding.primary.providerInstanceId === canonicalProviderId
      && acceptedBinding.primary.modelId === preconditions.canonical.defaultModel,
    `the public accepted binding did not make canonical primary: ${JSON.stringify(acceptedBinding)}`)
    assert(acceptedBinding.backup?.providerInstanceId === rccProviderId
      && acceptedBinding.backup.modelId === rccSelectedModelToken,
    `the public accepted binding did not retain RCC as backup: ${JSON.stringify(acceptedBinding)}`)
    const acceptedBindingDiagnostic = readAcceptedBinding(lifecycle.internal.internalPath, sessionAgentId)
    writeJson(join(evidenceDir, 'bb10-selection-binding-diagnostic.json'), acceptedBindingDiagnostic)
    assert(acceptedBindingDiagnostic.accepted_revision === acceptedSelection.acceptedRevision,
      `the private accepted binding diagnostic disagrees with the public accepted revision: ${JSON.stringify({
        durable: acceptedBindingDiagnostic.accepted_revision, public: acceptedSelection.acceptedRevision,
      })}`)

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
    const restartedBinding = restartedRow.acceptedBinding
    assert(restartedBinding !== null && typeof restartedBinding === 'object'
      && restartedBinding.primary.providerInstanceId === canonicalProviderId
      && restartedBinding.primary.modelId === preconditions.canonical.defaultModel
      && restartedBinding.backup?.providerInstanceId === rccProviderId
      && restartedBinding.backup.modelId === rccSelectedModelToken,
    `the public accepted primary/backup selection did not survive restart: ${JSON.stringify(restartedBinding)}`)
    const restartedBindingDiagnostic = readAcceptedBinding(lifecycle.internal.internalPath, sessionAgentId)
    writeJson(join(evidenceDir, 'bb10-switch-binding-diagnostic.json'), restartedBindingDiagnostic)
    assert(restartedBindingDiagnostic.accepted_revision === restartedRow.acceptedRevision,
      `the private accepted binding diagnostic disagrees with the public accepted revision after restart: ${JSON.stringify({
        durable: restartedBindingDiagnostic.accepted_revision, public: restartedRow.acceptedRevision,
      })}`)
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
    const realAcceptance = {
      status: 'passed',
      installed_identity: {
        installed_content_sha256: fixture.installedContentSha256,
        installed_tarball_sha256: fixture.tarballSha256,
        cli_realpath: fixture.cliRealpath,
        expected_content_sha256: stagedPackageContentSha256(),
      },
      rcc_turn: publicJson(rccTurn),
      canonical_turn: publicJson(canonicalTurn),
      explicit_selection: {
        accepted_revision_before: selectionRevision,
        accepted_revision_after: restartedRow.acceptedRevision,
        primary: { providerInstanceId: canonicalProviderId, modelId: preconditions.canonical.defaultModel },
        backup: { providerInstanceId: rccProviderId, modelId: rccSelectedModelToken },
      },
      restart: {
        launcher_generation_before: generationBefore,
        launcher_generation_after: lifecycle.parsed.generation,
        accepted_revision_after_restart: restartedRow.acceptedRevision,
      },
      readback: { config: publicJson(readbackConfig), agent: publicJson(readbackAgent) },
      cleanup: {
        stopped: true,
        console_listener_gone: consoleGone,
        owned_pids_after_stop: allPids,
        owned_pids_alive_after_stop: allPids.filter(processAlive),
        temporary_root_removed: !existsSync(fixture.temporaryRoot),
      },
      evidence_path: evidenceDir,
    }
    assert(realAcceptance.installed_identity.installed_content_sha256
      === realAcceptance.installed_identity.expected_content_sha256,
    `the real fixture installed content does not match the frozen package hash: ${JSON.stringify(realAcceptance.installed_identity)}`)
    assert(realAcceptance.cleanup.console_listener_gone && realAcceptance.cleanup.owned_pids_alive_after_stop.length === 0
      && realAcceptance.cleanup.temporary_root_removed,
    `the real fixture cleanup was not confirmed before the boundary section: ${JSON.stringify(realAcceptance.cleanup)}`)
    // Post-hoc audit of the real segment: no file under BB10 (including any
    // boundary directory written later) may carry a registered value or auth
    // material. This complements, and never replaces, the pre-write boundary.
    assertNoSecretInEvidence(evidenceDir,
      [preconditions.credentialValue, bb10BoundarySyntheticCredentialValue, consolePassword])
    const boundary = await runBB10Boundary(context, evidenceDir)
    assert(bb10PassVerdict(realAcceptance, boundary),
      `the BB10 two-section conjunction did not pass: ${JSON.stringify({
        real: bb10RealAcceptancePass(realAcceptance), boundary: bb10BoundaryResultPass(boundary),
      })}`)
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
          'POST /api/v1/command {"kind":"config.bindModel","providerId":"goaichat-openai"}',
          'POST /api/v1/command {"kind":"config.agent.select-backup","backup":{"providerInstanceId":"rcc-4444"}}',
          'agentteams stop --config <isolated-home>/.agentteams/config.toml --generation <G>',
          'agentteams start --config <isolated-home>/.agentteams/config.toml',
          'agentteams console start --config <isolated-home>/.agentteams/config.toml',
          'POST /api/v1/command {"kind":"config.apply","agentId":"bb-provider"} (canonical binding)',
          'POST /api/v1/session-message?agentId=bb-provider&sessionId=<S2> {"text":"<visible task>"} (real canonical provider)',
          'agentteams stop --generation <generation>',
        ],
      },
      external_observation: {
        real_acceptance: realAcceptance,
        boundary,
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
        explicit_selection: { accepted_revision_before: selectionRevision, bind_model: publicJson(bindModel.body),
          select_backup: publicJson(selectBackup.body), accepted_revision_after: acceptedSelection.acceptedRevision,
          accepted_row: publicJson(acceptedSelection), accepted_binding: acceptedBinding },
        switch_apply: { launcher_generation_before: generationBefore, launcher_generation_after: lifecycle.parsed.generation,
          accepted_after_restart: publicJson(restartedRow), effective_after_switch: publicJson(switchedApply.agent),
          restarted_binding: restartedBinding, session: switchedSession.created },
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

/**
 * A legal, input-preserving reorder of the real Work graph: node IDs, operators,
 * versions, ARCs, selectors and the edge list stay identical; only the node array
 * order changes. The real graph parser and the real lifecycle compile/gate still
 * consume it, so the change is a genuine graph input rather than an arbitrary
 * documentation field.
 */
function reorderWorkGraphNodes(sourceText) {
  const graph = JSON.parse(sourceText)
  assert(Array.isArray(graph.nodes) && graph.nodes.length > 1,
    'the BB13 graph fixture has no node array to reorder')
  const before = graph.nodes.map(node => ({
    id: node.id, operator: node.operator, operator_version: node.operator_version,
    inputs: node.inputs, output: node.output, iterator: node.iterator,
  }))
  graph.nodes = [graph.nodes.at(-1), ...graph.nodes.slice(0, -1)]
  const after = graph.nodes.map(node => ({
    id: node.id, operator: node.operator, operator_version: node.operator_version,
    inputs: node.inputs, output: node.output, iterator: node.iterator,
  }))
  const signature = nodes => JSON.stringify([...nodes].sort((left, right) => left.id.localeCompare(right.id)))
  assert(signature(before) === signature(after),
    'the BB13 graph reorder changed node identity, operator, version or ARC')
  return JSON.stringify(graph, null, 2) + '\n'
}

/** The two governed stages this matrix observes, reduced to their execution identity. */
function stageExecutionSummary(state) {
  return Object.fromEntries(['pnpm-verify', 'pnpm-smoke-installed'].map(stageId => {
    const stage = state?.stages?.[stageId]
    return [stageId, stage === undefined ? null : {
      status: stage.status ?? null,
      fingerprint: stage.fingerprint ?? null,
      receiptId: stage.receiptId ?? null,
      receiptPath: stage.receiptPath ?? null,
      reuseReceiptId: stage.reuseReceiptId ?? null,
      invalidationReason: stage.invalidationReason ?? null,
      evidenceIds: Array.isArray(stage.evidenceIds) ? stage.evidenceIds : [],
      logPath: stage.logPath ?? null,
    }]
  }))
}

/**
 * Reduce one lifecycle invocation to the increment since its `before` capture.
 * Only `history.slice(historyStart)` and the new reuse receipts are inspected, so
 * a record left by an earlier phase can never satisfy this phase's assertion.
 */
function bb13PhaseDelta(before, after) {
  return {
    history: after.state.invalidationHistory.slice(before.historyLength),
    newReuseReceipts: after.state.reuseReceipts.slice(before.reuseLength),
    counts: {
      verify: after.counts.verify - before.counts.verify,
      smokeInstalled: after.counts.smokeInstalled - before.counts.smokeInstalled,
    },
    stages: stageExecutionSummary(after.state),
  }
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

    // Uniform capture/assert vocabulary: every phase snapshots candidate identity,
    // input hashes, history/reuse lengths, invocation counts and both stage
    // fingerprints before running the real adapter once, then asserts on the
    // increment after that invocation only.
    const capture = (label, inputHashes) => {
      const store = readLifecycleState(fixtureRoot)
      return {
        label,
        candidate: currentCandidateIdentity(fixtureRoot),
        input_hashes: inputHashes,
        historyLength: store.state.invalidationHistory.length,
        reuseLength: store.state.reuseReceipts.length,
        counts: pnpmInvocationCounts(proofDir),
        stages: stageExecutionSummary(store.state),
        storePath: store.path,
      }
    }
    const inputHashes = paths => Object.fromEntries(paths.map(path => [path, sha256File(join(fixtureRoot, path))]))
    const runPhase = (name, before) => {
      const run = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, `${name}.json`))
      assert(run.status === 0, `BB13 ${name} invocation did not pass: ${run.stdout}${run.stderr}`)
      store = readLifecycleState(fixtureRoot)
      const after = { state: store.state, counts: pnpmInvocationCounts(proofDir) }
      const delta = bb13PhaseDelta(before, { state: store.state, counts: after.counts })
      observations.push({
        phase: name,
        before: { candidate: before.candidate, input_hashes: before.input_hashes,
          history_length: before.historyLength, reuse_length: before.reuseLength,
          counts: before.counts, stages: before.stages },
        invocation: { exit: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() },
        delta,
        after: { stages: delta.stages, counts: after.counts },
      })
      return { run, store, delta }
    }
    const expectDelta = (phase, delta, expected) => {
      assert(delta.counts.verify === expected.verify,
        `BB13 ${phase} verify increment was ${delta.counts.verify}, expected ${expected.verify}`)
      assert(delta.counts.smokeInstalled === expected.smoke,
        `BB13 ${phase} smoke increment was ${delta.counts.smokeInstalled}, expected ${expected.smoke}`)
    }
    const expectInvalidated = (phase, delta, stageId, reason) => {
      const entry = delta.history.find(item => item.stage_id === stageId)
      assert(entry !== undefined, `BB13 ${phase} recorded no invalidation for ${stageId}`)
      assert(entry.reason === reason,
        `BB13 ${phase} ${stageId} invalidation reason was ${entry.reason}, expected ${reason}`)
      return entry
    }
    const expectExecuted = (phase, delta, stageId, requireInvalidation = true) => {
      const stage = delta.stages[stageId]
      assert(stage.status === 'passed', `BB13 ${phase} ${stageId} did not settle passed: ${stage.status}`)
      // A stage recovering from a blocked failure has no prior passed/reused
      // fingerprint to invalidate, so this invocation records no invalidation.
      if (requireInvalidation) {
        assert(delta.history.some(entry => entry.stage_id === stageId),
          `BB13 ${phase} ${stageId} has no invalidation in this invocation`)
      }
      assert(stage.receiptId !== null && stage.receiptPath !== null && existsSync(stage.receiptPath),
        `BB13 ${phase} ${stageId} has no fresh receipt`)
      assert(delta.newReuseReceipts.every(receipt => receipt.stage_id !== stageId),
        `BB13 ${phase} ${stageId} reused instead of executing`)
      return stage
    }
    const expectReused = (phase, delta, stageId) => {
      const stage = delta.stages[stageId]
      assert(stage.status === 'reused', `BB13 ${phase} ${stageId} was not reused: ${stage.status}`)
      const reuse = delta.newReuseReceipts.find(receipt => receipt.stage_id === stageId)
      assert(reuse !== undefined, `BB13 ${phase} ${stageId} recorded no new reuse receipt`)
      assert(reuse.original_receipt?.receipt_id !== undefined && existsSync(reuse.original_receipt.path),
        `BB13 ${phase} ${stageId} reuse does not reference an existing valid receipt`)
      assert(reuse.original_receipt.receipt_id === stage.receiptId,
        `BB13 ${phase} ${stageId} reuse references ${reuse.original_receipt.receipt_id}, not ${stage.receiptId}`)
      return stage
    }

    const graphRelPath = 'docs/design/dagpipe/graphs/work-request.graph.json'
    const graphPath = join(fixtureRoot, graphRelPath)
    assert(existsSync(graphPath), `BB13 real Work graph is missing: ${graphPath}`)
    const graphOriginal = readFileSync(graphPath, 'utf8')

    const failure = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'failure.json'))
    assert(failure.status !== 0, 'BB13 injected smoke failure unexpectedly succeeded')
    let store = readLifecycleState(fixtureRoot)
    assert(store.state.stages['pnpm-verify']?.status === 'passed', 'verify stage did not persist before smoke failure')
    assert(store.state.stages['pnpm-smoke-installed']?.status === 'blocked', 'smoke stage did not record the deterministic failure')
    observations.push({ phase: 'failure', counts: pnpmInvocationCounts(proofDir),
      stages: stageExecutionSummary(store.state), failure_exit: failure.status,
      smoke_error: readJson(join(evidenceDir, 'failure.json')).stderr.trim().split('\n').at(-1) })

    // (1) Deterministic smoke failure recovery: verify reuses, only the first
    // failing node's dependent smoke stage re-executes.
    {
      const before = capture('recovery', inputHashes([graphRelPath]))
      const { delta } = runPhase('recovery', before)
      expectDelta('recovery', delta, { verify: 0, smoke: 1 })
      expectReused('recovery', delta, 'pnpm-verify')
      expectExecuted('recovery', delta, 'pnpm-smoke-installed', false)
    }

    // (2) Unchanged input re-entry with the completed validation record intact is
    // idempotent and executes nothing.
    {
      const before = capture('idempotent-entry', inputHashes([graphRelPath]))
      const run = runLifecycleAdapter(fixtureRoot, shimEnv, join(evidenceDir, 'idempotent-entry.json'))
      assert(run.status === 0, 'BB13 idempotent re-entry did not pass')
      assert(/"idempotent":true/u.test(run.stdout),
        `BB13 idempotent re-entry did not return the completed validation: ${run.stdout.trim()}`)
      const storeNow = readLifecycleState(fixtureRoot)
      const delta = bb13PhaseDelta(before, { state: storeNow.state, counts: pnpmInvocationCounts(proofDir) })
      expectDelta('idempotent-entry', delta, { verify: 0, smoke: 0 })
      assert(delta.history.length === 0 && delta.newReuseReceipts.length === 0,
        'BB13 idempotent re-entry mutated the completed stages')
      observations.push({
        phase: 'idempotent-entry',
        before: { candidate: before.candidate, input_hashes: before.input_hashes,
          history_length: before.historyLength, reuse_length: before.reuseLength, counts: before.counts, stages: before.stages },
        invocation: { exit: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() },
        delta, after: { stages: delta.stages, counts: pnpmInvocationCounts(proofDir) },
      })
    }

    // (3) Interrupted recovery re-entry: the validation record is gone while stage
    // state and receipts survive, so both unchanged stages reuse their original
    // valid receipts instead of re-executing.
    {
      const before = capture('reentry', inputHashes([graphRelPath]))
      const removedValidationRecords = removeValidationRecords(fixtureRoot)
      assert(removedValidationRecords.length > 0, 'BB13 interrupted-recovery step found no validation record to remove')
      const { delta } = runPhase('reentry', before)
      expectDelta('reentry', delta, { verify: 0, smoke: 0 })
      const verifyReuse = expectReused('reentry', delta, 'pnpm-verify')
      expectReused('reentry', delta, 'pnpm-smoke-installed')
      observations.at(-1).removed_validation_records = removedValidationRecords
      observations.at(-1).reused_receipts = delta.newReuseReceipts.map(receipt => ({
        stage_id: receipt.stage_id, original_receipt_id: receipt.original_receipt?.receipt_id,
      }))
      assert(verifyReuse.receiptId !== null, 'BB13 reentry verify lost its original receipt id')
    }

    // (4) Source change: both stages invalidate on this invocation's fingerprint
    // change and both execute; the reuse path is not taken.
    {
      const sourcePath = 'network/relay-client.ts'
      writeFileSync(join(fixtureRoot, sourcePath), `${readFileSync(join(fixtureRoot, sourcePath), 'utf8')}\n// BB13 source invalidation fixture\n`)
      commitFixtureChange(fixtureRoot, 'bb13 source change')
      const before = capture('source-change', inputHashes([sourcePath, graphRelPath]))
      const { delta } = runPhase('source-change', before)
      expectDelta('source-change', delta, { verify: 1, smoke: 1 })
      expectInvalidated('source-change', delta, 'pnpm-verify', 'fingerprint_changed')
      expectInvalidated('source-change', delta, 'pnpm-smoke-installed', 'fingerprint_changed')
      expectExecuted('source-change', delta, 'pnpm-verify')
      expectExecuted('source-change', delta, 'pnpm-smoke-installed')
    }

    // (5) Graph input change: the real Work graph nodes are legally reordered
    // (identity, operator, version, ARC and edges unchanged), so the real parser
    // and compile/gates consume a changed graph and both stages re-execute.
    {
      writeFileSync(graphPath, reorderWorkGraphNodes(graphOriginal))
      commitFixtureChange(fixtureRoot, 'bb13 graph change')
      const before = capture('graph-change', inputHashes([graphRelPath]))
      const { delta } = runPhase('graph-change', before)
      expectDelta('graph-change', delta, { verify: 1, smoke: 1 })
      expectInvalidated('graph-change', delta, 'pnpm-verify', 'fingerprint_changed')
      expectInvalidated('graph-change', delta, 'pnpm-smoke-installed', 'fingerprint_changed')
      expectExecuted('graph-change', delta, 'pnpm-verify')
      expectExecuted('graph-change', delta, 'pnpm-smoke-installed')
      observations.at(-1).graph_reorder = {
        path: graphRelPath,
        node_ids: JSON.parse(graphOriginal).nodes.map(node => node.id),
        reordered_node_ids: JSON.parse(readFileSync(graphPath, 'utf8')).nodes.map(node => node.id),
      }
    }

    // (6) Config change: both stages invalidate on this invocation's fingerprint
    // change and both execute.
    {
      const configPath = 'pnpm-workspace.yaml'
      writeFileSync(join(fixtureRoot, configPath), `${readFileSync(join(fixtureRoot, configPath), 'utf8')}\n# BB13 config invalidation fixture\n`)
      commitFixtureChange(fixtureRoot, 'bb13 config change')
      const before = capture('config-change', inputHashes([configPath, graphRelPath]))
      const { delta } = runPhase('config-change', before)
      expectDelta('config-change', delta, { verify: 1, smoke: 1 })
      expectInvalidated('config-change', delta, 'pnpm-verify', 'fingerprint_changed')
      expectInvalidated('config-change', delta, 'pnpm-smoke-installed', 'fingerprint_changed')
      expectExecuted('config-change', delta, 'pnpm-verify')
      expectExecuted('config-change', delta, 'pnpm-smoke-installed')
    }

    // (7) Artifact change: the verify-required compiled artifact input is
    // invalidated, so verify re-executes and the dependent smoke re-executes; the
    // smoke reason is read from this invocation's own fingerprint comparison.
    {
      const artifactPath = 'generated/modules/teams-source/module.compiled.json'
      writeFileSync(join(fixtureRoot, artifactPath), `${readFileSync(join(fixtureRoot, artifactPath), 'utf8')}\n`)
      const before = capture('artifact-change', inputHashes([artifactPath, graphRelPath]))
      const { delta } = runPhase('artifact-change', before)
      expectDelta('artifact-change', delta, { verify: 1, smoke: 1 })
      expectInvalidated('artifact-change', delta, 'pnpm-verify', 'receipt_or_required_input_invalid')
      const smokeEntry = expectInvalidated('artifact-change', delta, 'pnpm-smoke-installed', 'fingerprint_changed')
      observations.at(-1).smoke_reason_fingerprint_change =
        smokeEntry.previous_fingerprint !== delta.stages['pnpm-smoke-installed'].fingerprint
      expectExecuted('artifact-change', delta, 'pnpm-verify')
      expectExecuted('artifact-change', delta, 'pnpm-smoke-installed')
    }

    // (8) Deleted smoke-required evidence: the independent verify stage reuses,
    // and only the dependent smoke stage re-executes with a fresh receipt and
    // freshly present evidence. This and the failure-recovery phase prove "first
    // invalidated node and dependent successors" without a second lifecycle stage.
    {
      const smoke = latestSmokeReceipt(store.state)
      const evidenceId = smoke.receipt.evidence_ids[0]
      const evidenceRelPath = `.appsdk/records/evidence/teams-source/${evidenceId}.json`
      const evidencePath = join(fixtureRoot, evidenceRelPath)
      assert(existsSync(evidencePath), `BB13 evidence file is missing: ${evidencePath}`)
      const before = capture('evidence-delete', inputHashes([graphRelPath]))
      rmSync(evidencePath)
      const { delta } = runPhase('evidence-delete', before)
      expectDelta('evidence-delete', delta, { verify: 0, smoke: 1 })
      expectReused('evidence-delete', delta, 'pnpm-verify')
      const smokeStage = expectExecuted('evidence-delete', delta, 'pnpm-smoke-installed')
      const regenerated = latestSmokeReceipt(store.state)
      assert(regenerated.receipt.receipt_id !== smoke.receipt.receipt_id,
        'BB13 evidence deletion reused the stale smoke receipt instead of re-executing')
      assert(smokeStage.receiptId === regenerated.receipt.receipt_id,
        'BB13 evidence deletion did not publish the regenerated smoke receipt as the stage receipt')
      const evidenceRoot = join(fixtureRoot, '.appsdk', 'records', 'evidence', 'teams-source')
      assert(regenerated.receipt.evidence_ids.length > 0 &&
        regenerated.receipt.evidence_ids.every(id => existsSync(join(evidenceRoot, `${id}.json`))),
        'BB13 deleted required evidence was not regenerated as fresh present records')
      observations.at(-1).deleted_evidence = evidenceId
    }

    result = {
      status: 'passed',
      public_input: {
        lifecycle_adapter: 'node scripts/lifecycle-adapter.mjs',
        store: '.appsdk-control/lifecycle-adapter/stages/teams-lifecycle-admission.json',
        fault: 'one-shot smoke:installed exit 86',
        mutations: ['source', 'real Work graph node reorder', 'config', 'artifact', 'required evidence file deletion'],
        graph_input: graphRelPath,
      },
      external_observation: {
        fixture_root: fixtureRoot,
        outer_worktree_status: worktreeStatus.stdout,
        fixture_candidate: currentCandidateIdentity(fixtureRoot),
        store_path: store.path,
        phases: observations.map(observation => ({
          phase: observation.phase,
          counts: observation.counts ?? observation.after?.counts ?? undefined,
          before: observation.before,
          invocation: observation.invocation,
          delta: observation.delta,
          after: observation.after,
          failure_exit: observation.failure_exit,
          smoke_error: observation.smoke_error,
          removed_validation_records: observation.removed_validation_records,
          reused_receipts: observation.reused_receipts,
          graph_reorder: observation.graph_reorder,
          smoke_reason_fingerprint_change: observation.smoke_reason_fingerprint_change,
          deleted_evidence: observation.deleted_evidence,
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
        const result = await withEvidenceCase(id,
          () => definition.run({ candidate, packRoot: staged.packRoot, caseEvidenceRoot }))
        receipt.cases.push({ case_id: id, owner: definition.owner, capability_gate: definition.gate, ...result })
      } catch (error) {
        receipt.cases.push({
          case_id: id,
          owner: definition.owner,
          capability_gate: definition.gate,
          status: 'failed',
          public_input: { case: id },
          external_observation: { error: safeErrorMessage(error, 'case-receipt', id) },
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
          external_observation: { error: safeErrorMessage(error, 'case-receipt', id) },
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
    process.stderr.write(`${safeErrorMessage(error, 'terminal-stderr')}\n`)
    process.exitCode = exitCode.failed
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main()
}

export {
  Bb10SourceError,
  EVIDENCE_BOUNDARY_PREFIX,
  agentPolicyRefusalExpectedRevision,
  bb10BoundaryResultPass,
  bb10BaselinePass,
  bb10BoundarySourcesPass,
  bb10InvalidCredentialPass,
  bb10LaunchEnv,
  bb10ManualSelectionPass,
  bb10NoImplicitFailoverPass,
  bb10PassVerdict,
  bb10RealAcceptancePass,
  bb10StaleCasPass,
  bb09ConfigText,
  bb09RefreshCompletion,
  canonicalSessionConfigText,
  cases,
  closeProviderStub,
  findEvidenceViolation,
  createSessionProviderStub,
  listenProviderStub,
  parseArgs,
  parseCanonicalProviderSource,
  parseFlatSecretKey,
  parseRccServerSource,
  boundaryAcceptedBindingSnapshot,
  boundaryBindingSnapshot,
  readAcceptedConfigRevision,
  readDeclaredSecretKey,
  redactCredential,
  registerEvidenceSecret,
  run,
  safeErrorMessage,
  sessionBackupModel,
  sessionBackupProviderId,
  sessionManualModel,
  sessionManualProviderId,
  sessionPrimaryModel,
  sessionPrimaryProviderId,
  writeJson,
}
