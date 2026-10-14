import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { processAlive } from './local-ownership.ts'
import { createRelayServer, type RelayServer } from '../server/relay.ts'
import { createRegistrationClient, type RegistrationClient } from '../network/registration-client.ts'
import {
  ControlProcessError,
  createControlHistoryReader,
  createControlNetworkStatus,
  createControlOwner,
  createPollingProjectionSubscriber,
  loadControlIntent,
  readControlState,
  controlStatePath,
  startControlDaemon,
  statusControlDaemon,
  stopControlDaemon,
  type ControlDaemonStatus,
} from './control-process.ts'
import { createAcpHistoryStore } from './acp-history-store.ts'
import { createTeamsConnectionHistory } from '../network/teams-connection-history.ts'
import { readRelationsIntentRecord, relationsIntentScopePath } from '../config/relations-intent-store.ts'
import type { HistoryQuery, ConsoleProjectionSnapshot, TeamsConnectionStatus } from '../control-protocol/teams-state.ts'

let directory: string
let key: string
let cert: string
let HOME: string
const startedConfigs: string[] = []
const relays: RelayServer[] = []
const registeredPeers: RegistrationClient[] = []
const PASSWORD_ENV = 'TEAMS_CONTROL_TEST_PASSWORD'
const DISCOVERY_ENV = 'TEAMS_CONTROL_TEST_DISCOVERY'
const INDEX_ENV = 'TEAMS_CONTROL_TEST_PEER_CREDENTIAL'
const PASSWORD = 'control-secret'

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-control-process-'))
  // One real TLS trust anchor for the in-process D04 registry the directory test uses.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'ca.pem')], { stdio: 'ignore' })
  key = readFileSync(join(directory, 'key.pem'), 'utf8')
  cert = readFileSync(join(directory, 'ca.pem'), 'utf8')
  // The shared record root for this spec: never the operator's real home. The daemon
  // resolves its own record root from its home, so the fixture home is what it uses.
  HOME = join(directory, 'home')
  mkdirSync(HOME, { recursive: true })
  env = { [PASSWORD_ENV]: PASSWORD, HOME }
})
afterEach(async () => {
  // Explicit PID cleanup only; never a pattern kill.
  for (const configPath of startedConfigs.splice(0)) {
    try {
      await stopControlDaemon(configPath)
    } catch {
      try {
        const state = await readControlState(controlStatePath(await loadControlIntent(configPath)))
        if (state !== undefined && state.pid > 0 && processAlive(state.pid)) process.kill(state.pid, 'SIGTERM')
      } catch { /* no persisted process for this config */ }
    }
  }
  for (const peer of registeredPeers.splice(0)) await peer.stop().catch(() => undefined)
  for (const relay of relays.splice(0)) await relay.close()
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
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

/**
 * The one shared desired-relations record path for the account and scope this
 * spec's configs declare. The writer (the control daemon) resolves the target peer's
 * account and scope from its accepted `peers`; the reader (the agent daemon) resolves
 * its own `daemon.accountId` and `daemon.scopeId`. They must agree, and this helper is
 * that shared derivation.
 *
 * Every case passes its OWN `home`, so a case never reads a record another case wrote and
 * a test never writes a record into the operator's real home.
 */
function intentRecordPath(home: string, accountId = 'local', scopeId = 'local'): string {
  return relationsIntentScopePath({ home, accountId, scopeId })
}

interface ControlConfigOptions {
  readonly port?: number
  readonly kind?: 'control' | 'registry'
  readonly dataDirectory?: string
  readonly auth?: boolean
  readonly discovery?: string
  /** Overrides the accepted `[relations].allowed`; the default is the master/peer pair. */
  readonly allowedRoles?: readonly string[]
  /** Declared accepted peers, written as one `[peers.<name>]` table each. */
  readonly peers?: readonly string[]
}

async function controlConfig(options: ControlConfigOptions = {}): Promise<string> {
  const port = options.port ?? await freePort()
  const configPath = join(directory, `control-${port}-${Math.random().toString(36).slice(2, 8)}.toml`)
  const auth = options.auth === false ? '' : `
[webui.auth]
username = "teams"
passwordEnv = "${PASSWORD_ENV}"
`
  const kind = options.kind ?? 'control'
  const body = kind === 'registry'
    // A valid v4 registry config: it parses, and the control loader must still refuse it.
    ? `
[listen]
ip = "127.0.0.1"
port = ${port}
`
    : `
[webui]
ip = "127.0.0.1"
port = ${port}
allowedOrigin = "http://127.0.0.1:${port}"
${auth}
[relations]
allowed = ${JSON.stringify(options.allowedRoles ?? ['master', 'peer'])}
${(options.peers ?? []).map((agentId, index) => `
[peers.${agentId}]
agentId = "${agentId}"
hostId = "${agentId}-host"
accountId = "local"
scopeId = "local"
credentialRef = "env:${INDEX_ENV}${index}"
`).join('')}`
  writeFileSync(configPath, `version = 4

[daemon]
kind = "${kind}"
id = "control-a"
hostId = "control-host"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(options.dataDirectory ?? join(directory, `state-${port}`))}
${body}${options.discovery ?? ''}`)
  return configPath
}

/**
 * One real in-process D04 registry over TLS. The credential carries the agent id, so the
 * authenticated identity and the published declaration identity agree.
 */
function relayServer(port: number): Promise<RelayServer> {
  return createRelayServer({
    host: '127.0.0.1', port, key, cert,
    maxPayload: 65_536, maxConnections: 8, maxGrants: 4, maxBufferedAmount: 65_536,
    maxPendingMessages: 16, maxPendingBytes: 131_072, grantTtlMs: 10_000,
    authenticate: credential => typeof credential === 'string' && credential.startsWith('Bearer ')
      ? { accountId: 'local', scopeId: 'local', agentId: credential.slice(7) } : null,
  })
}

/** Registers one real peer over a real WSS socket; the directory gains a real row. */
async function registerPeer(port: number, agentId: string): Promise<void> {
  const client = createRegistrationClient({
    declaration: {
      identity: { hostId: `${agentId}-host`, machineId: `${agentId}-host`, agentId, accountId: 'local', agentKind: 'acp', label: agentId },
      scopeId: 'local', revision: 1, capabilities: [], routes: [],
    },
    endpoint: `wss://127.0.0.1:${port}`,
    credential: `Bearer ${agentId}`,
    ca: cert,
    heartbeatIntervalMs: 15_000, admissionTimeoutMs: 5_000, requestTimeoutMs: 5_000,
    maxPendingRequests: 16, maxDataConnections: 8, connectTimeoutMs: 5_000,
    maxMessageBytes: 262_144, maxBufferedBytes: 262_144, maxPendingFrames: 64,
    reconnect: { initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 3 },
  })
  registeredPeers.push(client)
  expect((await client.start()).state).toBe('online')
}

async function waitFor(accept: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (accept()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error('timed out waiting for the real directory projection to change')
}

function track(configPath: string): string {
  startedConfigs.push(configPath)
  return configPath
}

/**
 * The daemon's environment. `HOME` points at this spec's own temporary root so a daemon
 * under test derives the shared desired-relations record there, never in the operator's
 * real home. It is assigned in `beforeAll` with the rest of the fixture.
 */
let env: Record<string, string>
const basic = `Basic ${Buffer.from(`teams:${PASSWORD}`).toString('base64')}`

async function expectFault(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ControlProcessError)
  expect((caught as ControlProcessError).code).toBe(code)
}

it('starts the production control entry, serves the authenticated WebUI and stops by explicit pid', async () => {
  const configPath = track(await controlConfig())
  const started: ControlDaemonStatus = await startControlDaemon(configPath, { env })
  expect(started).toMatchObject({ state: 'running', daemonId: 'control-a', generation: 1, listener: { ip: '127.0.0.1' } })
  expect(started.pid).toBeGreaterThan(0)
  expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(started.dataDirectory).toBe(join(directory, `state-${started.listener!.port}`))
  expect(processAlive(started.pid!)).toBe(true)

  const status = await statusControlDaemon(configPath)
  expect(status).toEqual(started)

  const origin = started.url!
  // The browser-facing entrypoint refuses without credentials and carries the exact challenge.
  const anonymous = await fetch(origin + '/')
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers.get('www-authenticate')).toBe('Basic realm="AgentTeams", charset="UTF-8"')
  // Valid credentials serve the real static bytes.
  const html = await fetch(origin + '/', { headers: { authorization: basic } })
  expect(html.status).toBe(200)
  expect(await html.text()).toContain('AgentTeams Console')
  const entry = await fetch(origin + '/console-entry.js', { headers: { authorization: basic } })
  expect(entry.status).toBe(200)
  expect(await entry.text()).toContain('/ui/browser.js')
  const browser = await fetch(origin + '/ui/browser.js', { headers: { authorization: basic } })
  expect(browser.status).toBe(200)
  expect(browser.headers.get('content-type')).toContain('javascript')
  expect((await browser.text()).length).toBeGreaterThan(0)
  expect(browser.headers.get('content-security-policy')).toContain("default-src 'self'")

  // The projection is a real v1 payload from the owner binding, plus the real D05
  // connection projection: the daemon has no established channel, so the list is honestly
  // empty and never a fabricated row.
  const projection = await fetch(origin + '/api/v1/projection', { headers: { authorization: basic } })
  expect(projection.status).toBe(200)
  expect(await projection.json()).toMatchObject({ version: 1, agents: [], sessions: [], notifications: [], configs: [], connections: [] })

  // The new command kinds are closed at the wire boundary.
  const badCommand = await fetch(origin + '/api/v1/command', { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'network.membership.apply', agentId: 'control-a', expectedRevision: 1, members: [{ agentId: 'b', role: 'owner' }] }) })
  expect(badCommand.status).toBe(400)
  const acceptedShape = await fetch(origin + '/api/v1/command', { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'connection.connect', agentId: 'control-a' }) })
  expect(acceptedShape.status).toBe(200)
  // The daemon binds its accepted intent, so the command resolves the target against the
  // declared peers. `control-a` is this daemon's own identity and the config declares no
  // peers, so the write is refused FORBIDDEN and no relation is guessed or written.
  expect(await acceptedShape.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  expect(existsSync(intentRecordPath(HOME))).toBe(false)

  // History is the real D05 connection-history owner's page: a real (empty) read, not an absence.
  const history = await fetch(origin + '/api/v1/history?version=1&limit=5', { headers: { authorization: basic } })
  expect(history.status).toBe(200)
  expect(await history.json()).toEqual({ records: [] })
  const malformed = await fetch(origin + '/api/v1/history?version=1&limit=5&kind=work', { headers: { authorization: basic } })
  expect(malformed.status).toBe(400)

  const stopped = await stopControlDaemon(configPath, 1)
  expect(stopped.state).toBe('stopped')
  expect(processAlive(started.pid!)).toBe(false)
  expect((await statusControlDaemon(configPath)).state).toBe('stopped')
  // The runtime pid record is removed on stop; the data directory is durable because the
  // daemon keeps its connection history there.
  expect(existsSync(controlStatePath(await loadControlIntent(configPath)))).toBe(false)
})

it('streams the SSE projection and closes the stream on owner loss', async () => {
  const fixturePath = join(directory, `fixture-${Math.random().toString(36).slice(2, 8)}.json`)
  writeFileSync(fixturePath, JSON.stringify({
    snapshots: [
      { delayMs: 0, seq: 1, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } },
      { delayMs: 10, seq: 2, projection: { version: 1, agents: [], sessions: [], notifications: [], configs: [] } },
    ],
    closeAfter: { delayMs: 30, reason: 'stream-ended', detail: 'owner projection ended' },
  }))
  const configPath = track(await controlConfig())
  const started = await startControlDaemon(configPath, { env: { ...env, AGENTTEAMS_CONTROL_PROJECTION_FIXTURE: fixturePath } })
  const response = await fetch(started.url + '/api/v1/events', { headers: { authorization: basic } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const body = await response.text()
  const frames = body.split('\n\n').filter(Boolean)
  expect(frames.length).toBeGreaterThanOrEqual(3)
  // The event name is the contract the UI live client subscribes to
  // (ui/teams-console/src/client/{live-client,observation}.ts listen for `snapshot`, and the
  // sink method is onSnapshot for the frozen ConsoleProjectionSnapshot). A named SSE event with
  // no matching listener is dropped silently, so this name is asserted here and in
  // console-host/tests/http-api.spec.ts.
  expect(frames[0]).toBe('event: snapshot\ndata: {"seq":1,"projection":{"version":1,"agents":[],"sessions":[],"notifications":[],"configs":[]}}')
  expect(JSON.parse(frames[1].split('data: ')[1]!)).toMatchObject({ seq: 2 })
  expect(JSON.parse(frames[frames.length - 1].split('data: ')[1]!)).toMatchObject({ state: 'lost', reason: 'stream-ended' })
  expect((await stopControlDaemon(configPath)).state).toBe('stopped')
})

it('stops by explicit pid while a live WebUI event-stream client still holds its socket open', async () => {
  const configPath = track(await controlConfig())
  const started = await startControlDaemon(configPath, { env })
  // Open the real WebUI event stream, read one frame, and deliberately leave the socket
  // open. `server.close()` only stops accepting new work; it still waits for open sockets,
  // so a correct shutdown must close its own listener connections instead of letting a
  // live keep-alive/SSE client push the daemon past the bounded stop wait.
  const response = await fetch(started.url + '/api/v1/events', { headers: { authorization: basic } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('event: snapshot')

  const stopped = await stopControlDaemon(configPath, started.generation)
  expect(stopped.state).toBe('stopped')
  expect(processAlive(started.pid!)).toBe(false)
  expect((await statusControlDaemon(configPath)).state).toBe('stopped')
  await reader.cancel().catch(() => undefined)
})

it('refuses a second start while the control generation is alive', async () => {
  const configPath = track(await controlConfig())
  const started = await startControlDaemon(configPath, { env })
  await expectFault(startControlDaemon(configPath, { env }), 'ALREADY_RUNNING')
  expect((await statusControlDaemon(configPath)).generation).toBe(started.generation)
})

it('refuses a stop from a stale generation without touching the live process', async () => {
  const configPath = track(await controlConfig())
  const started = await startControlDaemon(configPath, { env })
  await expectFault(stopControlDaemon(configPath, 7), 'STALE_GENERATION')
  expect(processAlive(started.pid!)).toBe(true)
  expect((await stopControlDaemon(configPath, started.generation)).state).toBe('stopped')
})

it('fails a start when the webui port is already taken and never reports running', async () => {
  const port = await freePort()
  const occupied = createServer()
  await new Promise<void>(resolveListen => occupied.listen(port, '127.0.0.1', resolveListen))
  try {
    const configPath = track(await controlConfig({ port }))
    // The child publishes its typed code, so the parent re-throws PORT_OCCUPIED itself.
    await expectFault(startControlDaemon(configPath, { env, startupTimeoutMs: 3_000 }), 'PORT_OCCUPIED')
    expect((await statusControlDaemon(configPath)).state).not.toBe('running')
    // A failed start removes the runtime state record. The data directory stays: it holds the
    // daemon's durable connection history, which a failed start must not destroy.
    expect(existsSync(controlStatePath(await loadControlIntent(configPath)))).toBe(false)
  } finally {
    await new Promise<void>(resolveClose => occupied.close(() => resolveClose()))
  }
})

it('refuses a start when the declared password environment variable is absent', async () => {
  const configPath = track(await controlConfig())
  await expectFault(startControlDaemon(configPath, { env: {} }), 'CREDENTIAL_UNAVAILABLE')
  expect(await readControlState(controlStatePath(await loadControlIntent(configPath)))).toBeUndefined()
})

it('rejects a non-control config as an unsupported control configuration', async () => {
  const configPath = track(await controlConfig({ kind: 'registry' }))
  await expectFault(loadControlIntent(configPath), 'UNSUPPORTED_CONFIGURATION')
})

it('reports a persisted but dead pid as failed instead of running', async () => {
  const configPath = track(await controlConfig())
  const intent = await loadControlIntent(configPath)
  const statePath = controlStatePath(intent)
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify({
    version: 1, configPath, entryPath: join(directory, 'control-process.js'), daemonId: 'control-a',
    startToken: 'dead-token', generation: 3, pid: 999_999, state: 'running',
    url: 'http://127.0.0.1:1', updatedAt: new Date().toISOString(),
  })}\n`)
  expect(await statusControlDaemon(configPath)).toMatchObject({ state: 'failed', generation: 3, error: 'control process pid is not alive' })
  // A status read must not remove the owned record; only stop does.
  await stopControlDaemon(configPath)
  expect(existsSync(statePath)).toBe(false)
})

it('refuses a persisted state whose typed error code is outside the closed vocabulary', async () => {
  const configPath = track(await controlConfig())
  const statePath = controlStatePath(await loadControlIntent(configPath))
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify({
    version: 1, configPath, entryPath: join(directory, 'control-process.js'), daemonId: 'control-a',
    startToken: 'token', generation: 1, pid: 0, state: 'failed', errorCode: 'MADE_UP', error: 'x',
    updatedAt: new Date().toISOString(),
  })}\n`)
  await expectFault(readControlState(statePath), 'INVALID_STATUS')
})

it('reads history only through the frozen port and fails typed when it is absent', async () => {
  const query: HistoryQuery = { version: 1, kind: 'connection', agentId: 'a', limit: 10 }
  const seen: HistoryQuery[] = []
  const port = {
    history: async (received: HistoryQuery) => { seen.push(received); return { records: [] } },
    connections: () => [] as readonly TeamsConnectionStatus[],
  }
  const reader = createControlHistoryReader(port)
  expect(await reader.query(query)).toEqual({ records: [] })
  expect(seen).toEqual([query])
  await expectFault(createControlHistoryReader(undefined).query(query), 'HISTORY_UNAVAILABLE')
  // The runtime never forwards a widened query; the frozen parser refuses it first.
  await expect(reader.query({ version: 1, limit: 0 })).rejects.toThrow(/limit/)
  expect(seen).toHaveLength(1)
})

it('keeps the connection projection absent and relation commands typed without the accepted intent facts', async () => {
  const owner = createControlOwner({})
  expect(await owner.readProjection()).toEqual({ version: 1, agents: [], sessions: [], notifications: [], configs: [] })
  expect(await owner.command({ kind: 'connection.connect', agentId: 'a' }))
    .toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(await owner.command({ kind: 'network.membership.apply', agentId: 'a', expectedRevision: 1, members: [] }))
    .toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(await owner.sendSession({ agentId: 'a', sessionId: 's' }, { text: 'x' }))
    .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })

  // A bound read port projects the frozen status verbatim and never mutates it.
  const status: TeamsConnectionStatus = { version: 1, remoteAgentId: 'b', state: 'negotiating', targetGeneration: 2,
    observedAt: '2026-10-11T00:00:00.000Z', role: 'peer' }
  const bound = createControlOwner({ network: { history: async () => ({ records: [] }), connections: () => [status] } })
  expect(await bound.readProjection()).toMatchObject({ connections: [{ status, halfOpen: true }] })
  // The read port is not a mutation channel: without the accepted intent facts the relation
  // commands keep the typed absence instead of writing a guessed record.
  expect(await bound.command({ kind: 'connection.connect', agentId: 'b' }))
    .toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
})

it('writes the declared peer relation from the frozen relation commands and leaves the projection unchanged', async () => {
  const port = await freePort()
  const dataDirectory = join(directory, `state-intent-${port}`)
  const configPath = await controlConfig({ port, dataDirectory, peers: ['peer-b'] })
  const intent = await loadControlIntent(configPath)
  // This case's own record root, so it never reads a record another case wrote.
  const home = join(directory, `home-intent-write-${port}`)
  const recordPath = intentRecordPath(home)
  // One real D05 status row: a desired-intent write must never add, drop or rewrite a
  // connection row, and must never report that connection state back.
  const status: TeamsConnectionStatus = { version: 1, remoteAgentId: 'peer-b', state: 'disconnected', targetGeneration: 1,
    observedAt: '2026-10-14T00:00:00.000Z', role: 'peer' }
  const owner = createControlOwner({
    network: { history: async () => ({ records: [] }), connections: () => [status] },
    relations: { peers: intent.peers, allowedRoles: intent.relations.allowed, home },
  })
  const before = await owner.readProjection()

  // The declared peer is the only legal target. The desired role follows the one derivation
  // `runtime/serve-egress.ts` applies to `requestedPeerRole`: this config's accepted relations
  // include master, so the desired role for the peer is master.
  expect(await owner.command({ kind: 'connection.connect', agentId: 'peer-b' }))
    .toEqual({ ok: true, result: { acceptedRevision: 1 } })
  expect(await readRelationsIntentRecord(recordPath)).toMatchObject({ revision: 1, peers: [{ agentId: 'peer-b', role: 'master' }] })
  // The result reports the accepted revision only, and the projection stays byte-identical.
  expect(await owner.readProjection()).toEqual(before)

  // Disconnect removes that desired relation from the same record and bumps the revision.
  expect(await owner.command({ kind: 'connection.disconnect', agentId: 'peer-b' }))
    .toEqual({ ok: true, result: { acceptedRevision: 2 } })
  expect(await readRelationsIntentRecord(recordPath)).toMatchObject({ revision: 2, peers: [] })
  expect(await owner.readProjection()).toEqual(before)
})

it('derives the desired peer role from the daemon own accepted relations', async () => {
  const port = await freePort()
  const dataDirectory = join(directory, `state-intent-role-${port}`)
  const configPath = await controlConfig({ port, dataDirectory, allowedRoles: ['peer'], peers: ['peer-c'] })
  const intent = await loadControlIntent(configPath)
  const home = join(directory, `home-intent-role-${port}`)
  const owner = createControlOwner({
    relations: { peers: intent.peers, allowedRoles: intent.relations.allowed, home },
  })
  // A daemon whose accepted relations do not include master desires `peer`, the same branch
  // the egress owner takes for `requestedPeerRole`.
  expect(await owner.command({ kind: 'connection.connect', agentId: 'peer-c' }))
    .toEqual({ ok: true, result: { acceptedRevision: 1 } })
  expect(await readRelationsIntentRecord(intentRecordPath(home)))
    .toMatchObject({ peers: [{ agentId: 'peer-c', role: 'peer' }] })
})

it('refuses an undeclared connect target with FORBIDDEN and writes no record', async () => {
  const port = await freePort()
  const dataDirectory = join(directory, `state-intent-unknown-${port}`)
  const configPath = await controlConfig({ port, dataDirectory, peers: ['peer-b'] })
  const intent = await loadControlIntent(configPath)
  const home = join(directory, `home-intent-unknown-${port}`)
  const recordPath = intentRecordPath(home)
  const owner = createControlOwner({
    relations: { peers: intent.peers, allowedRoles: intent.relations.allowed, home },
  })
  expect(await owner.command({ kind: 'connection.connect', agentId: 'agent-not-declared' }))
    .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  // Never a guessed relation or a guessed record: no record file is created at all.
  expect(existsSync(recordPath)).toBe(false)
  // A declared peer still writes through the same owner, so the refusal above is the target
  // rule and not a broken store.
  expect(await owner.command({ kind: 'connection.connect', agentId: 'peer-b' })).toMatchObject({ ok: true })
  expect(existsSync(recordPath)).toBe(true)
})

it('applies the whole desired membership set with the caller expectation and refuses a stale revision', async () => {
  const port = await freePort()
  const dataDirectory = join(directory, `state-intent-apply-${port}`)
  // Both members are declared peers of the same account and scope, so the whole set has one
  // resolvable record and one CAS fence.
  const configPath = await controlConfig({ port, dataDirectory, peers: ['peer-b', 'peer-d'] })
  const intent = await loadControlIntent(configPath)
  const home = join(directory, `home-intent-apply-${port}`)
  const recordPath = intentRecordPath(home)
  const owner = createControlOwner({
    relations: { peers: intent.peers, allowedRoles: intent.relations.allowed, home },
  })
  const members = [
    { agentId: 'peer-b', role: 'master' as const },
    { agentId: 'peer-d', role: 'peer' as const },
  ]
  // A successful apply writes the whole desired set in one CAS and reports its revision.
  expect(await owner.command({ kind: 'network.membership.apply', agentId: 'peer-b', expectedRevision: 0, members }))
    .toEqual({ ok: true, result: { acceptedRevision: 1 } })
  expect(await readRelationsIntentRecord(recordPath)).toMatchObject({ revision: 1, peers: members })

  // The caller's expectation is passed through unchanged: a stale client conflicts and the
  // durable bytes stay exactly as they were. The submitted set is itself legal, so the CAS
  // is the only reason this write is refused.
  const before = readFileSync(recordPath)
  expect(await owner.command({ kind: 'network.membership.apply', agentId: 'peer-b', expectedRevision: 0, members: [{ agentId: 'peer-b', role: 'master' }] }))
    .toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
  expect(readFileSync(recordPath).equals(before)).toBe(true)
  expect(await readRelationsIntentRecord(recordPath)).toMatchObject({ revision: 1, peers: members })

  // A member outside the record's account and scope is refused before any write, because one
  // record has one CAS fence and that member would never read this file.
  expect(await owner.command({ kind: 'network.membership.apply', agentId: 'peer-b', expectedRevision: 1, members: [{ agentId: 'peer-b', role: 'master' }, { agentId: 'agent-not-declared', role: 'peer' }] }))
    .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  expect(readFileSync(recordPath).equals(before)).toBe(true)
})

it('keeps the typed refusal when the relations record cannot be opened or saved', async () => {
  const port = await freePort()
  const dataDirectory = join(directory, `state-intent-failure-${port}`)
  const configPath = await controlConfig({ port, dataDirectory, peers: ['peer-b'] })
  const intent = await loadControlIntent(configPath)
  const home = join(directory, `home-intent-failure-${port}`)
  const recordPath = intentRecordPath(home)
  const owner = createControlOwner({
    relations: { peers: intent.peers, allowedRoles: intent.relations.allowed, home },
  })

  // A broken stored record is the store's own typed throw: the owner refuses it and the
  // broken bytes stay exactly as they were instead of being overwritten.
  const recordDirectory = dirname(recordPath)
  mkdirSync(recordDirectory, { recursive: true })
  const malformed = '{ "version": 1, "revision": 1, "peers": ['
  writeFileSync(recordPath, malformed, 'utf8')
  expect(await owner.command({ kind: 'connection.connect', agentId: 'peer-b' }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(readFileSync(recordPath, 'utf8')).toBe(malformed)

  // A record directory that cannot be written never becomes a fabricated success.
  rmSync(recordPath, { force: true })
  chmodSync(recordDirectory, 0o500)
  try {
    expect(await owner.command({ kind: 'connection.connect', agentId: 'peer-b' }))
      .toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(existsSync(recordPath)).toBe(false)
  } finally {
    chmodSync(recordDirectory, 0o700)
  }
})

it('emits a full snapshot only when the polling projection changes and reports loss on owner failure', async () => {
  let projection = { version: 1 as const, agents: [], sessions: [], notifications: [], configs: [] }
  const snapshots: number[] = []
  const health: string[] = []
  const unsubscribe = createPollingProjectionSubscriber(async () => projection, 5)({
    onSnapshot: snapshot => { snapshots.push(snapshot.seq) },
    onHealth: state => { health.push(state.state) },
  })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 40))
  expect(snapshots).toEqual([1])
  projection = { ...projection, sessions: [{ agentId: 'a', sessionId: 's' }] }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 40))
  expect(snapshots).toEqual([1, 2])
  unsubscribe()
  expect(health).toEqual([])

  const failed: string[] = []
  createPollingProjectionSubscriber(async () => { throw new Error('owner gone') }, 5)({
    onSnapshot: () => { failed.push('snapshot') },
    onHealth: state => { failed.push(state.state) },
  })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 30))
  expect(failed).toEqual(['lost'])
})

it('binds the real D05 status port from the daemon own owners and stops it explicitly', async () => {
  const configPath = track(await controlConfig())
  const intent = await loadControlIntent(configPath)
  const binding = await createControlNetworkStatus(intent, {})
  // The real owner read, never a fabricated or inferred connection state.
  expect(binding.port.connections()).toEqual([])
  expect(await binding.port.history({ version: 1, kind: 'connection', limit: 5 })).toEqual({ records: [] })
  // The frozen owner still refuses a widened query instead of rewriting it.
  await expect(binding.port.history({ version: 1, kind: 'request', limit: 5 }))
    .rejects.toThrow(/connection records only/)
  await expect(binding.stop()).resolves.toBeUndefined()
})

it('projects the real D04 registration directory and streams a frame when it changes', async () => {
  const registryPort = await freePort()
  relays.push(await relayServer(registryPort))
  await registerPeer(registryPort, 'peer-a')

  const configPath = track(await controlConfig({ discovery: `
[discovery]
serverId = "test-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:${DISCOVERY_ENV}"
tlsTrustRef = "file:${join(directory, 'ca.pem')}"
` }))
  const binding = await createControlNetworkStatus(await loadControlIntent(configPath), { [DISCOVERY_ENV]: 'Bearer control-a' })
  try {
    // The real directory readback, never the hardcoded empty snapshot: the registered peer
    // is a real directory row and a real disconnected connection row.
    expect(binding.port.connections()).toMatchObject([
      { remoteAgentId: 'peer-a', state: 'disconnected', targetGeneration: 1 },
    ])
    const client = createControlOwner({ network: binding.port, source: binding.projection })
    expect((await client.readProjection()).agents).toMatchObject([
      { kind: 'directory', agentId: 'peer-a', machineId: 'peer-a-host', presence: 'online', generation: 1, capabilities: [] },
    ])

    // The declared projection seam is the SSE feed: a real directory change advances `seq`.
    const frames: ConsoleProjectionSnapshot[] = []
    const unsubscribe = binding.projection.watch!({ onSnapshot: snapshot => { frames.push(snapshot) }, onHealth: () => undefined })
    await waitFor(() => frames.length >= 1)
    await registerPeer(registryPort, 'peer-b')
    await waitFor(() => frames.length >= 2)
    unsubscribe()
    expect(frames[frames.length - 1]!.seq).toBeGreaterThan(frames[0]!.seq)
    expect(frames[frames.length - 1]!.projection.agents.map(agent => agent.agentId)).toContain('peer-b')
  } finally {
    await binding.stop()
  }
})

it('serves the real D05 connection projection and connection history over the wire', async () => {
  const port = await freePort()
  const dataDirectory = join(directory, `state-network-${port}`)
  // One real connection-history record written through the real D05 owner, exactly the way
  // the daemon itself writes it. The wire must return that real row unchanged.
  const store = await createAcpHistoryStore({ directory: dataDirectory })
  const written = await createTeamsConnectionHistory(store).record({
    event: 'connection.negotiated',
    agentId: 'peer-b',
    occurredAt: '2026-10-11T00:00:00.000Z',
    connectionId: 'connection-1',
  })
  expect(written).toMatchObject({ kind: 'connection', sequence: 1 })

  const configPath = track(await controlConfig({ port, dataDirectory }))
  const recordPath = intentRecordPath(HOME)
  const started = await startControlDaemon(configPath, { env })
  const origin = started.url!

  const projection = await fetch(origin + '/api/v1/projection', { headers: { authorization: basic } })
  expect(projection.status).toBe(200)
  expect((await projection.json() as { readonly connections?: unknown }).connections).toEqual([])

  const page = await fetch(origin + '/api/v1/history?version=1&kind=connection&limit=5', { headers: { authorization: basic } })
  expect(page.status).toBe(200)
  expect(await page.json()).toMatchObject({
    records: [{ kind: 'connection', event: 'connection.negotiated', agentId: 'peer-b', connectionId: 'connection-1', sequence: 1 }],
  })

  // The bound history surface is the D05 connection-history owner, so a request-kind query
  // is refused by that owner instead of being rewritten into a connection page. The daemon
  // declares no second history source; the console host reports the non-absence owner
  // failure as "outcome not inferred" and never as a fabricated page.
  const requestKind = await fetch(origin + '/api/v1/history?version=1&kind=request&limit=5', { headers: { authorization: basic } })
  expect(requestKind.status).toBe(502)
  expect(await requestKind.json()).toEqual({ message: 'Console owner request failed; outcome not inferred' })

  // A relation command writes the durable desired record through the daemon's own accepted
  // intent. `peer-b` is not declared by this config, so the command is refused FORBIDDEN and
  // no relation is written; the connection history is untouched by that refusal.
  const command = await fetch(origin + '/api/v1/command', {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'connection.connect', agentId: 'peer-b' }),
  })
  expect(command.status).toBe(200)
  expect(await command.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  expect(existsSync(recordPath)).toBe(false)
  const historyAfterRefusal = await fetch(origin + '/api/v1/history?version=1&kind=connection&limit=5', { headers: { authorization: basic } })
  expect(await historyAfterRefusal.json()).toMatchObject({ records: [{ connectionId: 'connection-1', sequence: 1 }] })

  expect((await stopControlDaemon(configPath)).state).toBe('stopped')
  // The durable record written above is still on disk after the stop.
  expect(existsSync(dataDirectory)).toBe(true)
})

it('keeps the durable connection history across a control-owner restart', async () => {
  const port = await freePort()
  const dataDirectory = join(directory, `state-durable-${port}`)
  // One real connection-history record written through the real D05 owner, exactly the way
  // the daemon itself writes it. The store is declared durable, so a stop must not destroy
  // it and a restart must read it back byte-identical.
  const store = await createAcpHistoryStore({ directory: dataDirectory })
  await createTeamsConnectionHistory(store).record({
    event: 'connection.negotiated',
    agentId: 'peer-b',
    occurredAt: '2026-10-11T00:00:00.000Z',
    connectionId: 'durable-1',
  })

  const configPath = track(await controlConfig({ port, dataDirectory }))
  const started = await startControlDaemon(configPath, { env })
  const before = await (await fetch(`${started.url}/api/v1/history?version=1&kind=connection&limit=5`,
    { headers: { authorization: basic } })).json()
  expect(before).toMatchObject({ records: [{ connectionId: 'durable-1' }] })

  expect((await stopControlDaemon(configPath, started.generation)).state).toBe('stopped')
  const restarted = await startControlDaemon(configPath, { env })
  expect(restarted.pid).not.toBe(started.pid)
  const after = await (await fetch(`${restarted.url}/api/v1/history?version=1&kind=connection&limit=5`,
    { headers: { authorization: basic } })).json()
  expect(after).toEqual(before)
})
