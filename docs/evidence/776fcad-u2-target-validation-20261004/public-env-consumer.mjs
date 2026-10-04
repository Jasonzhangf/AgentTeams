#!/usr/bin/env node
// Bounded public consumer for the frozen U2 env/path and invalid-material seams.
// It uses compiled public entrypoints, a real Relay, a real OpenCode serve, and
// a real startLocalProcess child. It does not claim full v3 service startup.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.argv[2] ?? process.cwd())
const LIB = join(ROOT, 'generated/runtime-lib')
const OPENCODE = process.env.U2_OPENCODE ?? join(process.env.HOME ?? '', '.opencode', 'bin', 'opencode')

const { createRelayServer } = await import(join(LIB, 'server/relay.js'))
const { createRelayClient } = await import(join(LIB, 'network/relay-client.js'))
const { createRelayConsoleClient } = await import(join(LIB, 'runtime/relay-console-client.js'))
const { loadLocalConfig, createTomlRuntimeConfigPersistence } = await import(join(LIB, 'runtime/local-config.js'))
const { createRuntimeConfigStore, targetIdentityFor, providerIntentFingerprint } = await import(join(LIB, 'config/runtime-config.js'))
const { startAgentProcess } = await import(join(LIB, 'runtime/agent-process.js'))
const { startLocalProcess, stopLocalProcess } = await import(join(LIB, 'runtime/local-process.js'))

const results = []
function record(caseId, name, ok, detail) {
  results.push({ case: caseId, assert: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${caseId}] ${name}${detail === undefined ? '' : ' :: ' + detail}`)
}
function assert(caseId, name, cond, detail) {
  record(caseId, name, cond === true, detail)
  if (cond !== true) throw new Error(`assertion failed [${caseId}] ${name}`)
}

async function availablePort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  await new Promise(resolvePromise => listener.close(resolvePromise))
  if (!address || typeof address === 'string') throw new Error('port missing')
  return address.port
}

async function isListening(port) {
  return await new Promise(resolvePromise => {
    const socket = new Socket()
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
    socket.once('error', () => { socket.destroy(); resolvePromise(false) })
    socket.once('timeout', () => { socket.destroy(); resolvePromise(false) })
    socket.connect(port, '127.0.0.1')
  })
}

async function setupMultiProvider(agentId, baseDir) {
  const configPath = join(baseDir, 'config.toml')
  const internalPath = join(baseDir, 'internal.toml')
  writeFileSync(configPath, 'version = 3\n')
  const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId })
  const store = createRuntimeConfigStore(persistence, { agentId })
  let view = await store.putProviderInstance(0, {
    id: 'first', label: 'First', protocol: 'openai-chat', apiBaseUrl: 'https://first.example/v1', enabled: true,
    auth: { kind: 'bearer', credentialRef: 'SHARED_CREDENTIAL' },
  })
  view = await store.putProviderInstance(view.acceptedRevision, {
    id: 'none', label: 'Auth None', protocol: 'openai-chat', apiBaseUrl: 'https://none.example/v1', enabled: true,
    auth: { kind: 'none' },
  })
  view = await store.putModelEntry(view.acceptedRevision, {
    ref: { providerInstanceId: 'none', modelId: 'none-model' },
    origin: 'manual',
    base: { label: 'Auth-none model' },
    overrides: {},
  })
  view = await store.bindAgentModel(view.acceptedRevision, agentId, { primary: { providerInstanceId: 'none', modelId: 'none-model' } })
  return { configPath, internalPath, persistence, store, view }
}

async function runPassedEnvCase(relay, consumer, scratch) {
  const caseId = 'case1-passed-env-multi-provider'
  const baseDir = join(scratch, 'passed-env')
  mkdirSync(baseDir, { recursive: true })
  const scratchHome = join(scratch, 'scratch-home')
  mkdirSync(join(scratchHome, '.agentteams'), { recursive: true })
  const decoyConfigPath = join(scratchHome, '.agentteams', 'config.toml')
  const decoyInternalPath = join(scratchHome, '.agentteams', 'internal.toml')
  writeFileSync(decoyConfigPath, 'version = 3\n# ambient decoy\n')
  writeFileSync(decoyInternalPath, 'version = 2\n# ambient decoy internal\n')
  const decoyConfigBefore = readFileSync(decoyConfigPath)
  const decoyInternalBefore = readFileSync(decoyInternalPath)

  const setup = await setupMultiProvider('public-env', baseDir)
  const configText = readFileSync(setup.configPath, 'utf8')
  assert(caseId, 'multi-provider TOML puts bearer first and auth-none second',
    configText.indexOf('[providers.first]') >= 0 &&
    configText.indexOf('[providers.first]') < configText.indexOf('[providers.none]') &&
    configText.indexOf('[providers.none]') >= 0,
    configText)
  assert(caseId, 'machine source binding targets the auth-none provider',
    setup.view.agents['public-env']?.primary.providerInstanceId === 'none',
    JSON.stringify(setup.view.agents['public-env']))

  const openCodePort = await availablePort()
  const leasePort = await availablePort()
  const agentConfigPath = join(baseDir, 'agent.json')
  writeFileSync(agentConfigPath, JSON.stringify({
    version: 1,
    identity: { hostId: 'public-env-host', machineId: 'test', agentId: 'public-env', accountId: 'account', agentKind: 'custom', label: 'public-env' },
    scopeId: 'scope',
    dataDirectory: './data',
    leasePort,
    presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [], allowedManagers: ['consumer'] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/usr/bin/grep', searchRoot: '.', profilePrefix: 'teams-u2-public-env' },
    relay: {
      endpoint: relay.url,
      credentialEnv: 'U2_AGENT_AUTH',
      caFile: join(scratch, 'cert.pem'),
      connectTimeoutMs: 1000,
      admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000,
      maxMessageBytes: 65536,
      maxBufferedBytes: 65536,
      maxPendingFrames: 16,
      maxPendingRequests: 8,
      maxDataConnections: 8,
    },
    openCode: {
      executable: OPENCODE,
      directory: './opencode',
      configFile: setup.configPath,
      port: openCodePort,
      startupTimeoutMs: 20_000,
      stopTimeoutMs: 3000,
    },
  }))
  const ambientConfig = process.env.TEAMS_LOCAL_CONFIG_PATH
  const ambientInternal = process.env.TEAMS_LOCAL_INTERNAL_PATH
  const passedEnv = {
    ...process.env,
    HOME: scratchHome,
    TEAMS_LOCAL_CONFIG_PATH: setup.configPath,
    TEAMS_LOCAL_INTERNAL_PATH: setup.internalPath,
    U2_AGENT_AUTH: 'Bearer public-env',
    SHARED_CREDENTIAL: 'first-provider-secret',
  }
  delete passedEnv.TEAMS_LOCAL_CONFIG_PATH
  delete passedEnv.TEAMS_LOCAL_INTERNAL_PATH
  passedEnv.TEAMS_LOCAL_CONFIG_PATH = setup.configPath
  passedEnv.TEAMS_LOCAL_INTERNAL_PATH = setup.internalPath

  let handle
  try {
    handle = await startAgentProcess(agentConfigPath, passedEnv)
    void handle.closed.catch(() => undefined)
    assert(caseId, 'startAgentProcess used passed env and registered daemon', handle.daemon.status().agentId === 'public-env')
    assert(caseId, 'process.env was not mutated for config path', process.env.TEAMS_LOCAL_CONFIG_PATH === ambientConfig)
    assert(caseId, 'process.env was not mutated for internal path', process.env.TEAMS_LOCAL_INTERNAL_PATH === ambientInternal)

    const consoleClient = createRelayConsoleClient(consumer, 'public-env', 8000)
    const apply = await consoleClient.command({ kind: 'config.apply', agentId: 'public-env' })
    assert(caseId, 'public Console apply succeeds for bound auth-none provider',
      apply.ok === true && apply.error === undefined, JSON.stringify(apply))
    const effective = await setup.store.readEffective()
    assert(caseId, 'public apply persisted effective revision and clean state',
      effective.effectiveRevision === setup.view.acceptedRevision && effective.applyState === 'clean',
      JSON.stringify(effective))
    assert(caseId, 'real managed OpenCode launched and is listening', await isListening(openCodePort), `port=${openCodePort}`)

    const current = await setup.store.read()
    const target = targetIdentityFor(current, current.providers.none)
    const wrong = { ...target, endpointFingerprint: 'sha256:not-the-bound-provider' }
    const internalBeforeMismatch = readFileSync(setup.internalPath)
    let mismatchCode
    try {
      await setup.persistence.withLock(() => setup.persistence.saveObservationUnlocked('public-env', {
        kind: 'target-observation', target: wrong, effectiveRevision: current.acceptedRevision, applyState: 'clean',
      }))
    } catch (error) {
      mismatchCode = error?.message ?? String(error)
    }
    assert(caseId, 'wrong fingerprint is rejected with APPLY_TARGET_MISMATCH',
      typeof mismatchCode === 'string' && mismatchCode.includes('APPLY_TARGET_MISMATCH'), String(mismatchCode))
    assert(caseId, 'wrong fingerprint leaves internal.toml byte-identical',
      readFileSync(setup.internalPath).equals(internalBeforeMismatch))
    assert(caseId, 'wrong fingerprint leaves config.toml byte-identical',
      readFileSync(setup.configPath, 'utf8') === configText)
    assert(caseId, 'ambient default config path was untouched', readFileSync(decoyConfigPath).equals(decoyConfigBefore))
    assert(caseId, 'ambient default internal path was untouched', readFileSync(decoyInternalPath).equals(decoyInternalBefore))
  } finally {
    if (handle !== undefined) {
      try { await handle.stop() } catch (error) {
        record(caseId, 'daemon stop completed', false, error instanceof Error ? error.message : String(error))
      }
    }
    assert(caseId, 'managed OpenCode stopped with the daemon', !(await isListening(openCodePort)), `port=${openCodePort}`)
  }
}

async function runCorruptMaterialCase(scratch, index) {
  const caseId = `case2-corrupt-${index}`
  const baseDir = join(scratch, `corrupt-${index}`)
  mkdirSync(baseDir, { recursive: true })
  const configPath = join(baseDir, 'config.toml')
  const internalPath = join(baseDir, 'internal.toml')
  const projectionPath = join(baseDir, '.internal', 'projections', 'relay.json')
  const marker = join(baseDir, 'child-spawned.marker')
  const configText = `version = 3

[bridge]
enabled = true

[agents.browser]
enabled = true
role = "provider"
label = "Browser"

[agents.browser.identity]
hostId = "local"
machineId = "local"
accountId = "local"
agentKind = "custom"
label = "Browser"

[agents.browser.runtime]
scopeId = "local"
dataDirectory = "data/browser"
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/grep", searchRoot = ".", profilePrefix = "teams-browser" }
`
  const relayConfig = index === 1
    ? '{not-json'
    : JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 70000 } })
  const internalText = `version = 2
sourceRevision = 0
sourceHash = "sha256:stale"
sourcePath = ${JSON.stringify(configPath)}

[relay]
projectionPath = ${JSON.stringify(projectionPath)}
config = ${JSON.stringify(relayConfig)}
`
  writeFileSync(configPath, configText)
  writeFileSync(internalPath, internalText)
  const configBefore = readFileSync(configPath)
  const internalBefore = readFileSync(internalPath)

  let loadError
  try { await loadLocalConfig(configPath) } catch (error) { loadError = error }
  assert(caseId, 'public loadLocalConfig rejects corrupt persisted material', loadError instanceof Error,
    loadError instanceof Error ? loadError.message : String(loadError))
  assert(caseId, 'config.toml unchanged after rejected load', readFileSync(configPath).equals(configBefore))
  assert(caseId, 'internal.toml unchanged after rejected load', readFileSync(internalPath).equals(internalBefore))

  const relayEntry = join(baseDir, 'relay.mjs')
  const agentEntry = join(baseDir, 'agent.mjs')
  writeFileSync(relayEntry, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
  writeFileSync(agentEntry, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'spawned\\n')\nsetInterval(() => {}, 1000)\n`)
  let startError
  try {
    await startLocalProcess(configPath, {
      relayEntry, agentEntry, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 500,
    })
  } catch (error) { startError = error }
  assert(caseId, 'public startLocalProcess rejects corrupt persisted material', startError instanceof Error,
    startError instanceof Error ? startError.message : String(startError))
  assert(caseId, 'no launcher child was spawned', !existsSync(marker))
  assert(caseId, 'config.toml unchanged after rejected start', readFileSync(configPath).equals(configBefore))
  assert(caseId, 'internal.toml unchanged after rejected start', readFileSync(internalPath).equals(internalBefore))
}

async function runLauncherPropagationCase(scratch) {
  const caseId = 'case3-launcher-env-forwarding'
  const baseDir = join(scratch, 'launcher-forwarding')
  mkdirSync(baseDir, { recursive: true })
  const configPath = join(baseDir, 'config.toml')
  const marker = join(baseDir, 'child-env.json')
  const relayPort = await availablePort()
  const leasePort = await availablePort()
  writeFileSync(join(baseDir, 'relay.json'), JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: relayPort } }))
  writeFileSync(configPath, `version = 2

[relay]
config = "relay.json"

[endpoints.browser]
role = "provider"
identity = { hostId = "browser-host", machineId = "machine", agentId = "browser", accountId = "account", agentKind = "custom", label = "Browser" }
scopeId = "scope"
dataDirectory = "data/browser"
leasePort = ${leasePort}
presenceIntervalMs = 100
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = "/usr/bin/grep", searchRoot = ".", profilePrefix = "teams-browser" }
relay = { endpoint = "wss://127.0.0.1:1", credentialEnv = "AUTH", connectTimeoutMs = 1, admissionTimeoutMs = 1, requestTimeoutMs = 1, maxMessageBytes = 1, maxBufferedBytes = 1, maxPendingFrames = 1, maxPendingRequests = 1, maxDataConnections = 1 }
`)
  const relayEntry = join(baseDir, 'relay.mjs')
  const agentEntry = join(baseDir, 'agent.mjs')
  writeFileSync(relayEntry, `console.log('relay listening wss://127.0.0.1:${relayPort}'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n`)
  writeFileSync(agentEntry, `import { writeFileSync } from 'node:fs'
const generation = Number(process.env.TEAMS_LOCAL_LAUNCHER_GENERATION ?? 1)
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  configPath: process.env.TEAMS_LOCAL_CONFIG_PATH,
  internalPath: process.env.TEAMS_LOCAL_INTERNAL_PATH,
}))
process.send?.({ kind: 'daemon.status', agentId: 'browser', generation,
  endpoint: { agentId: 'browser', identity: { hostId: 'browser-host', machineId: 'machine', agentId: 'browser', accountId: 'account', agentKind: 'custom', label: 'Browser' },
    role: 'provider', presence: 'online', state: 'online', generation, capabilities: [] } })
process.send?.({ kind: 'daemon.registered', agentId: 'browser', generation })
setInterval(() => {}, 1000)
process.once('SIGTERM', () => process.exit(0))
`)
  let started
  try {
    started = await startLocalProcess(configPath, {
      relayEntry, agentEntry, nodeArguments: ['--experimental-transform-types'], startupTimeoutMs: 3000,
    })
    assert(caseId, 'startLocalProcess reached running with the v2 fixture', started.state === 'running')
    const childEnv = JSON.parse(readFileSync(marker, 'utf8'))
    assert(caseId, 'launcher child received resolved config path', childEnv.configPath === configPath, JSON.stringify(childEnv))
    assert(caseId, 'launcher child received resolved internal path', childEnv.internalPath === started.internalPath, JSON.stringify(childEnv))
  } finally {
    if (started !== undefined) {
      try { await stopLocalProcess(configPath, started.generation) } catch { /* best effort cleanup */ }
    }
  }
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'u2-public-env-'))
  let relay
  let consumer
  try {
    const keyPath = join(scratch, 'key.pem')
    const certPath = join(scratch, 'cert.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)
    relay = await createRelayServer({
      host: '127.0.0.1', port: 0, cert, key, maxPayload: 65536, maxConnections: 16, maxGrants: 8,
      maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 10_000,
      authenticate: credential => credential.startsWith('Bearer ')
        ? { accountId: 'account', scopeId: 'scope', agentId: credential.slice(7) }
        : null,
    })
    consumer = await createRelayClient({
      transport: { endpoint: relay.url, credential: 'Bearer consumer', ca: cert, connectTimeoutMs: 1000,
        maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 },
      declaration: { identity: { hostId: 'consumer', machineId: 'test', agentId: 'consumer', accountId: 'account', agentKind: 'custom', label: 'Consumer' },
        scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
      admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxPendingRequests: 8, maxDataConnections: 8,
    })
    console.log(`IDENTITY opencode=${OPENCODE} exists=${existsSync(OPENCODE)} root=${ROOT}`)
    await runPassedEnvCase(relay, consumer, scratch)
    await runCorruptMaterialCase(scratch, 1)
    await runCorruptMaterialCase(scratch, 2)
    await runLauncherPropagationCase(scratch)
    console.log(`SUMMARY total=${results.length} pass=${results.filter(r => r.ok).length} fail=${results.filter(r => !r.ok).length}`)
    console.log('RESULT ' + JSON.stringify({ ok: results.every(r => r.ok), assertions: results.length }))
  } finally {
    try { await consumer?.close() } catch { /* best effort */ }
    try { await relay?.close() } catch { /* best effort */ }
    rmSync(scratch, { recursive: true, force: true })
    console.log('CLEANUP done dirs=1')
  }
}

let exitCode = 0
try { await main() } catch (error) {
  exitCode = 1
  console.log('FIRST_ERROR ' + JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }))
}
process.exit(exitCode)
