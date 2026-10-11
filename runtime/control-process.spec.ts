import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { processAlive } from './local-ownership.ts'
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
import type { HistoryQuery, TeamsConnectionStatus } from '../control-protocol/teams-state.ts'

let directory: string
const startedConfigs: string[] = []
const PASSWORD_ENV = 'TEAMS_CONTROL_TEST_PASSWORD'
const PASSWORD = 'control-secret'

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-control-process-'))
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

interface ControlConfigOptions {
  readonly port?: number
  readonly kind?: 'control' | 'registry'
  readonly dataDirectory?: string
  readonly auth?: boolean
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
allowed = ["master", "peer"]
`
  writeFileSync(configPath, `version = 4

[daemon]
kind = "${kind}"
id = "control-a"
hostId = "control-host"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(options.dataDirectory ?? join(directory, `state-${port}`))}
${body}`)
  return configPath
}

function track(configPath: string): string {
  startedConfigs.push(configPath)
  return configPath
}

const env = { [PASSWORD_ENV]: PASSWORD }
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
  // The real D05 read port is bound, so the command reaches it and is refused with the typed
  // "the frozen read port declares no mutation" outcome instead of a fabricated result.
  expect(await acceptedShape.json()).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })

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
  // The owned directory and pid record are removed on stop.
  expect(existsSync(started.dataDirectory!)).toBe(false)
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
  expect(frames[0]).toBe('event: projection\ndata: {"seq":1,"projection":{"version":1,"agents":[],"sessions":[],"notifications":[],"configs":[]}}')
  expect(JSON.parse(frames[1].split('data: ')[1]!)).toMatchObject({ seq: 2 })
  expect(JSON.parse(frames[frames.length - 1].split('data: ')[1]!)).toMatchObject({ state: 'lost', reason: 'stream-ended' })
  expect((await stopControlDaemon(configPath)).state).toBe('stopped')
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
    expect(existsSync(join(directory, `state-${port}`))).toBe(false)
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

it('keeps the connection projection absent and connection commands typed when the port is unbound', async () => {
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
  expect(await bound.command({ kind: 'connection.connect', agentId: 'b' }))
    .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
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

  // A connection mutation has no owner on the frozen read port: typed refusal, never faked.
  const command = await fetch(origin + '/api/v1/command', {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'connection.connect', agentId: 'peer-b' }),
  })
  expect(command.status).toBe(200)
  expect(await command.json()).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })

  expect((await stopControlDaemon(configPath)).state).toBe('stopped')
  expect(existsSync(dataDirectory)).toBe(false)
})
