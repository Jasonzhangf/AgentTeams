#!/usr/bin/env node
// Real startup-recovery blackbox for the frozen U2 candidate.
// Uses the compiled public startAgentProcess entry, real OpenCode serve, real
// TOML config persistence and the real Relay console ingress. No product mocks
// and no internal-ledger assertions.
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
const { createTomlRuntimeConfigPersistence } = await import(join(LIB, 'runtime/local-config.js'))
const { createRuntimeConfigStore, targetIdentityFor } = await import(join(LIB, 'config/runtime-config.js'))
const { createManagedConfigOwnerPersistence } = await import(join(LIB, 'runtime/managed-config-owner.js'))
const { startAgentProcess } = await import(join(LIB, 'runtime/agent-process.js'))

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
  await new Promise(r => listener.close(r))
  if (!address || typeof address === 'string') throw new Error('port missing')
  return address.port
}

async function isListening(port) {
  return await new Promise(resolvePromise => {
    const socket = new Socket()
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
    socket.once('error', () => { socket.destroy(); resolvePromise(false) })
    socket.once('timeout', () => { socket.destroy(); resolvePromise(false) })
    socket.connect(port, '127.0.0.1')
  })
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

async function spawnRealOpenCode(port, directory) {
  const password = randomBytes(16).toString('hex')
  const authorization = 'Basic ' + Buffer.from(`teams:${password}`).toString('base64')
  mkdirSync(directory, { recursive: true })
  const child = spawn(OPENCODE, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory, stdio: 'ignore',
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_CONTENT: '{}',
      OPENCODE_SERVER_USERNAME: 'teams', OPENCODE_SERVER_PASSWORD: password },
  })
  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('old OpenCode exited before readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(400) })
      if (response.ok) { ready = true; break }
    } catch { /* connection refused before listen is expected */ }
    await new Promise(r => setTimeout(r, 75))
  }
  if (!ready) { child.kill('SIGKILL'); throw new Error('old OpenCode startup deadline') }
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
    }
  }
  return { child, pid: child.pid, port, authorization, stop }
}

async function setupCase(baseDir, agentId) {
  mkdirSync(baseDir, { recursive: true })
  const configPath = join(baseDir, 'config.toml')
  const internalPath = join(baseDir, 'internal.toml')
  writeFileSync(configPath, 'version = 3\n')
  const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId })
  const store = createRuntimeConfigStore(persistence, { agentId })
  await store.putProviderInstance(0, { id: 'probe', label: 'Probe', protocol: 'openai-chat',
    apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' } })
  await store.refreshProviderModels(1, 'probe', { listModels: async () => [{ modelId: 'probe-model', metadata: { label: 'probe-model' } }] })
  await store.bindAgentModel(1, agentId, { primary: { providerInstanceId: 'probe', modelId: 'probe-model' } })
  const current = await store.read()
  const target = targetIdentityFor(current, current.providers.probe)
  return { baseDir, agentId, configPath, internalPath, persistence, store, current, target }
}

function fenceFor(target, acceptedRevision, operationId, kind, pid) {
  return { target, operation: { operationId, kind },
    error: { code: 'RESULT_UNKNOWN', message: `prior ${kind} outcome unknown` },
    substrate: { pid, effectiveRevision: acceptedRevision, effectiveHandleFingerprint: `${operationId}-handle` } }
}

async function writeAgentConfig(baseDir, agentId, relayUrl, openCodePort, configPath) {
  mkdirSync(join(baseDir, 'search'), { recursive: true })
  writeFileSync(join(baseDir, 'search', 'sample.txt'), 'x\n')
  const leasePort = await availablePort()
  writeFileSync(join(baseDir, 'cert.pem'), certPem)
  const config = {
    version: 1,
    identity: { hostId: `${agentId}-host`, machineId: 'test', agentId, accountId: 'account', agentKind: 'custom', label: agentId },
    scopeId: 'scope', dataDirectory: './data', leasePort, presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: ['consumer'], allowedManagers: ['consumer'] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/usr/bin/grep', searchRoot: './search', profilePrefix: 'teams-u2-recover' },
    relay: { endpoint: relayUrl, credentialEnv: 'U2_AGENT_AUTH', caFile: './cert.pem', connectTimeoutMs: 1000,
      admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536,
      maxPendingFrames: 16, maxPendingRequests: 8, maxDataConnections: 8 },
    openCode: { executable: OPENCODE, directory: './opencode', configFile: configPath, port: openCodePort,
      startupTimeoutMs: 20_000, stopTimeoutMs: 3000 },
  }
  const path = join(baseDir, 'agent.json')
  writeFileSync(path, JSON.stringify(config))
  return path
}

const cleanup = { children: [], handles: [], directories: [], consumer: undefined, relay: undefined }
let certPem = ''
async function runCase1(relay, consumer, scratch) {
  const caseId = 'case1-dead-fence-restart'
  const baseDir = join(scratch, 'case1')
  const setup = await setupCase(baseDir, 'recover-a')
  const oldPort = await availablePort()
  const old = await spawnRealOpenCode(oldPort, join(baseDir, 'old-substrate'))
  cleanup.children.push(old)
  assert(caseId, 'old OpenCode substrate is a real owned process', typeof old.pid === 'number' && pidAlive(old.pid), `pid=${old.pid} port=${oldPort}`)
  await setup.persistence.withLock(() => setup.persistence.saveObservationUnlocked('recover-a', {
    kind: 'target-observation', target: setup.target, lastApplyError: { code: 'UPSTREAM_ERROR', message: 'stale apply error' } }))
  const fence = fenceFor(setup.target, setup.current.acceptedRevision, 'recover-a-op', 'apply', old.pid)
  await setup.persistence.withLock(() => setup.persistence.saveObservationUnlocked('recover-a', { kind: 'owner-fence', uncertain: fence }))
  const fenced = await setup.store.readEffective()
  assert(caseId, 'durable fence persisted via typed TOML persistence', fenced.applyState === 'uncertain', JSON.stringify(fenced))
  const rawBefore = readFileSync(setup.internalPath, 'utf8')
  assert(caseId, 'fence and stale error present in internal.toml', rawBefore.includes('recover-a-op') && rawBefore.includes('stale apply error'))
  await old.stop()
  assert(caseId, 'explicitly-owned old substrate confirmed exited', !pidAlive(old.pid), `pid=${old.pid}`)

  const openCodePort = await availablePort()
  const agentConfig = await writeAgentConfig(baseDir, 'recover-a', relay.url, openCodePort, setup.configPath)
  process.env.TEAMS_LOCAL_CONFIG_PATH = setup.configPath
  process.env.TEAMS_LOCAL_INTERNAL_PATH = setup.internalPath
  const handle = await startAgentProcess(agentConfig, { ...process.env, U2_AGENT_AUTH: 'Bearer recover-a' })
  cleanup.handles.push(handle)
  void handle.closed.catch(() => undefined)
  assert(caseId, 'compiled daemon entry registered the agent', handle.daemon.status().agentId === 'recover-a')
  const after = await setup.store.readEffective()
  assert(caseId, 'config readback clean (accepted==effective)', after.applyState === 'clean' && after.effectiveRevision === after.acceptedRevision,
    JSON.stringify(after))
  assert(caseId, 'no stale lastApplyError remains', after.lastApplyError === undefined, JSON.stringify(after))
  const rawAfter = readFileSync(setup.internalPath, 'utf8')
  assert(caseId, 'no remaining uncertainty fence in internal.toml', !rawAfter.includes('recover-a-op') && !rawAfter.includes('stale apply error'))
  assert(caseId, 'real new OpenCode substrate launched on configured port', await isListening(openCodePort), `port=${openCodePort}`)
  const projection = await createRelayConsoleClient(consumer, 'recover-a', 8000).readProjection()
  assert(caseId, 'public Console projection reports clean applyState with no fence',
    projection.configs[0]?.applyState === 'clean' && projection.configs[0]?.effectiveRevision === 2 && projection.configs[0]?.lastApplyError === undefined,
    JSON.stringify(projection.configs[0]))
  await handle.stop()
  cleanup.handles.pop()
  assert(caseId, 'new substrate stopped with daemon', !(await isListening(openCodePort)), `port=${openCodePort}`)
}

async function runCase2(relay, consumer, scratch) {
  const caseId = 'case2-live-fence-blocked'
  const baseDir = join(scratch, 'case2')
  const setup = await setupCase(baseDir, 'recover-b')
  const oldPort = await availablePort()
  const old = await spawnRealOpenCode(oldPort, join(baseDir, 'old-substrate'))
  cleanup.children.push(old)
  const fence = fenceFor(setup.target, setup.current.acceptedRevision, 'recover-b-op', 'use-session', old.pid)
  await setup.persistence.withLock(() => setup.persistence.saveObservationUnlocked('recover-b', { kind: 'owner-fence', uncertain: fence }))

  const openCodePort = await availablePort()
  const agentConfig = await writeAgentConfig(baseDir, 'recover-b', relay.url, openCodePort, setup.configPath)
  process.env.TEAMS_LOCAL_CONFIG_PATH = setup.configPath
  process.env.TEAMS_LOCAL_INTERNAL_PATH = setup.internalPath
  const handle = await startAgentProcess(agentConfig, { ...process.env, U2_AGENT_AUTH: 'Bearer recover-b' })
  cleanup.handles.push(handle)
  void handle.closed.catch(() => undefined)
  assert(caseId, 'daemon still registers while recovery obligation is explicit', handle.daemon.status().agentId === 'recover-b')
  const state = await setup.store.readEffective()
  assert(caseId, 'uncertain is retained, not cleared', state.applyState === 'uncertain', JSON.stringify(state))
  const raw = readFileSync(setup.internalPath, 'utf8')
  assert(caseId, 'exact fence retained in internal.toml', raw.includes('recover-b-op'))
  assert(caseId, 'live old substrate still alive', pidAlive(old.pid), `pid=${old.pid}`)
  assert(caseId, 'no second substrate launched', !(await isListening(openCodePort)), `port=${openCodePort}`)
  const consoleClient = createRelayConsoleClient(consumer, 'recover-b', 8000)
  const command = await consoleClient.command({ kind: 'config.apply', agentId: 'recover-b' })
  assert(caseId, 'config ingress reports explicit CONFLICT recovery obligation',
    command.ok === false && command.error?.code === 'CONFLICT', JSON.stringify(command))
  const rawAfter = readFileSync(setup.internalPath, 'utf8')
  assert(caseId, 'fence still exact after ingress conflict', rawAfter.includes('recover-b-op'))
  try { await handle.stop() } catch (error) {
    record(caseId, 'daemon stop surfaces retained uncertainty (expected typed conflict)', true, error instanceof Error ? error.message : String(error))
  }
  cleanup.handles.pop()
  await old.stop()
  cleanup.children.pop()
  assert(caseId, 'owned old substrate confirmed exited in finally', !pidAlive(old.pid), `pid=${old.pid}`)
}

async function runCase3(scratch) {
  const caseId = 'case3-multi-fence-identity'
  const baseDir = join(scratch, 'case3')
  const setup = await setupCase(baseDir, 'recover-c')
  await setup.persistence.withLock(() => setup.persistence.saveObservationUnlocked('recover-c', {
    kind: 'target-observation', target: setup.target, lastApplyError: { code: 'UPSTREAM_ERROR', message: 'retain me' } }))
  const first = fenceFor(setup.target, setup.current.acceptedRevision, 'first-op', 'apply', 999_991)
  const second = fenceFor(setup.target, setup.current.acceptedRevision, 'second-op', 'use-session', 999_992)
  await setup.persistence.withLock(() => setup.persistence.saveObservationUnlocked('recover-c', { kind: 'owner-fence', uncertain: first }))
  await setup.persistence.withLock(() => setup.persistence.saveObservationUnlocked('recover-c', { kind: 'owner-fence', uncertain: second }))
  const port = createManagedConfigOwnerPersistence({ agentId: 'recover-c', internalPath: setup.internalPath, persistence: setup.persistence })
  await port.clearUncertainty({ expectedFence: first, effectiveRevision: setup.current.acceptedRevision, currentTarget: setup.target })
  const afterFirst = await setup.store.readEffective()
  assert(caseId, 'removing one fence keeps the other and its error',
    afterFirst.applyState === 'uncertain' && afterFirst.lastApplyError?.code === 'UPSTREAM_ERROR', JSON.stringify(afterFirst))
  const rawFirst = readFileSync(setup.internalPath, 'utf8')
  assert(caseId, 'only the exact cleared operation removed',
    !rawFirst.includes('first-op') && rawFirst.includes('second-op'))
  const bytesBeforeMismatch = readFileSync(setup.internalPath)
  const mismatched = { ...second, substrate: { ...second.substrate, pid: second.substrate.pid + 1 } }
  let mismatchCode
  try { await port.clearUncertainty({ expectedFence: mismatched, effectiveRevision: setup.current.acceptedRevision, currentTarget: setup.target }) }
  catch (error) { mismatchCode = error.code }
  assert(caseId, 'same operationId / full-identity mismatch rejected', mismatchCode === 'CONFLICT', `code=${mismatchCode}`)
  const bytesAfterMismatch = readFileSync(setup.internalPath)
  assert(caseId, 'TOML bytes and state not mutated on mismatch', bytesBeforeMismatch.equals(bytesAfterMismatch))
  const afterMismatch = await setup.store.readEffective()
  assert(caseId, 'fence/error retained after mismatch', afterMismatch.applyState === 'uncertain' && afterMismatch.lastApplyError?.code === 'UPSTREAM_ERROR')
  await port.clearUncertainty({ expectedFence: second, effectiveRevision: setup.current.acceptedRevision, currentTarget: setup.target })
  const final = await setup.store.readEffective()
  assert(caseId, 'last clear yields clean with no stale error', final.applyState === 'clean' && final.lastApplyError === undefined, JSON.stringify(final))
  const rawFinal = readFileSync(setup.internalPath, 'utf8')
  assert(caseId, 'no fence records remain', !rawFinal.includes('first-op') && !rawFinal.includes('second-op'))
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'u2-recovery-live-'))
  cleanup.directories.push(scratch)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdio: 'ignore' })
  const cert = readFileSync(join(scratch, 'cert.pem'))
  const key = readFileSync(join(scratch, 'key.pem'))
  certPem = cert
  const relay = await createRelayServer({ host: '127.0.0.1', port: 0, cert, key, maxPayload: 65536, maxConnections: 16,
    maxGrants: 8, maxBufferedAmount: 65536, maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 10_000,
    authenticate: credential => credential.startsWith('Bearer ')
      ? { accountId: 'account', scopeId: 'scope', agentId: credential.slice(7) } : null })
  cleanup.relay = relay
  const consumer = await createRelayClient({
    transport: { endpoint: relay.url, credential: 'Bearer consumer', ca: cert, connectTimeoutMs: 1000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 },
    declaration: { identity: { hostId: 'consumer', machineId: 'test', agentId: 'consumer', accountId: 'account', agentKind: 'custom', label: 'Consumer' },
      scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
    admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxPendingRequests: 8, maxDataConnections: 8 })
  cleanup.consumer = consumer
  console.log(`IDENTITY opencode=${OPENCODE} exists=${existsSync(OPENCODE)} root=${ROOT}`)
  await runCase1(relay, consumer, scratch)
  await runCase2(relay, consumer, scratch)
  await runCase3(scratch)
  console.log(`SUMMARY total=${results.length} pass=${results.filter(r => r.ok).length} fail=${results.filter(r => !r.ok).length}`)
  console.log('RESULT ' + JSON.stringify({ ok: results.every(r => r.ok), assertions: results.length }))
}

let exitCode = 0
try { await main() } catch (error) {
  exitCode = 1
  console.log('FIRST_ERROR ' + JSON.stringify({ message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }))
} finally {
  for (const handle of cleanup.handles) { try { await handle.stop() } catch { /* retained uncertainty may reject */ } }
  for (const child of cleanup.children) { try { await child.stop() } catch { /* best effort */ } }
  try { await cleanup.consumer?.close() } catch { /* ignore */ }
  try { await cleanup.relay?.close() } catch { /* ignore */ }
  for (const dir of cleanup.directories) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  console.log('CLEANUP done children=' + cleanup.children.length + ' dirs=' + cleanup.directories.length)
}
process.exit(exitCode)
