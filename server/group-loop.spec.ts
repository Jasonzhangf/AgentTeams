import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthenticatedAgent, AgentDeclaration } from '../packages/shared/src/agent-services.ts'
import { createGroupHub, type GroupHubSnapshot } from './group-hub.ts'
import { createRelayServer, type RelayServer } from './relay.ts'
import { groupPaths, readJsonFile } from './group-store.ts'
import {
  loadRegistryIntent,
  readRegistryState,
  registryStatePath,
  startRegistryDaemon,
  stopRegistryDaemon,
} from '../runtime/registry-process.ts'
import { processAlive } from '../runtime/local-ownership.ts'
import type { GroupChannel } from '../network/group-channel.ts'
import {
  createRegistrationGroupChannel,
  forwardRegistrationStatus,
  startGroupAgentMessaging,
} from '../runtime/group-messaging.ts'
import { createRegistrationClient, type RegistrationClient } from '../network/registration-client.ts'
import type { AgentMessaging } from '../runtime/agent-messaging.ts'

/**
 * Batch-1 black-box loop: a real relay with the real hub, two real agent
 * messaging daemons, the real CLI over real Unix sockets, and a real local HTTP
 * Vikunja stand-in. Vikunja itself is the only stand-in, and it is labeled here.
 */

interface Recorded { readonly method: string; readonly path: string; readonly body: string; readonly auth: string }

/** Vikunja reports a project as a number; a non-numeric id stays a string. */
function projectIdValue(projectId: string): number | string {
  return /^\d+$/.test(projectId) ? Number(projectId) : projectId
}

function startVikunjaStub(): { readonly baseUrl: string; readonly issues: Map<string, { done: boolean; comments: string[]; projectId: string }>; readonly calls: Recorded[]; close(): void } {
  const issues = new Map<string, { done: boolean; comments: string[]; projectId: string }>()
  // An issue that existed before this group: referencing it must read its project.
  issues.set('99', { done: true, comments: [], projectId: 'p9' })
  const calls: Recorded[] = []
  let nextId = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      calls.push({ method: req.method ?? '', path: req.url ?? '', body, auth: String(req.headers.authorization ?? '') })
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.method === 'PUT' && /\/api\/v1\/projects\/[^/]+\/tasks$/.test(req.url ?? '')) {
        const id = String(++nextId)
        const parsed = JSON.parse(body)
        const projectId = req.url!.split('/')[4] ?? ''
        issues.set(id, { done: false, comments: [], projectId })
        send(201, { id: Number(id), title: parsed.title, description: parsed.description, done: false, project_id: projectIdValue(projectId) })
        return
      }
      if (req.method === 'PUT' && /\/api\/v1\/tasks\/[^/]+\/comments$/.test(req.url ?? '')) {
        const id = req.url!.split('/')[4]
        const parsed = JSON.parse(body)
        issues.get(id)?.comments.push(parsed.comment)
        send(201, { id: 1, comment: parsed.comment })
        return
      }
      const match = req.url?.match(/\/api\/v1\/tasks\/(\d+)/)
      if (req.method === 'POST' && match) {
        const id = match[1]
        const parsed = JSON.parse(body)
        const issue = issues.get(id)
        if (issue) issue.done = parsed.done === true
        send(200, { id: Number(id), done: issue?.done ?? parsed.done })
        return
      }
      if (req.method === 'GET' && match) {
        const id = match[1]
        const issue = issues.get(id)
        if (!issue) { send(404, { message: 'not found' }); return }
        send(200, { id: Number(id), title: 't', done: issue.done, project_id: projectIdValue(issue.projectId) })
        return
      }
      send(404, { message: `unhandled ${req.method} ${req.url}` })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        issues,
        calls,
        close: () => server.close(),
      })
    })
  })
}

function declaration(agentId: string): AgentDeclaration {
  return {
    identity: { hostId: `h-${agentId}`, machineId: `m-${agentId}`, agentId, accountId: 'account-a', agentKind: 'custom', label: agentId },
    scopeId: 'scope-a', revision: 1, capabilities: [], routes: [],
  }
}

const execFileAsync = promisify(execFile)

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createPortServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPort(new Error('no free port'))
        return
      }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('timed out waiting for the group loop sweep')
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error('timed out waiting for the asynchronous group loop condition')
}

/**
 * Runs the real CLI. It must not block this process: the relay, the hub and both
 * daemons live in it, so a synchronous child would wait on a frozen event loop.
 */
async function cli(socketPath: string, args: readonly string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, ['cli/group.mjs', ...args, '--socket', socketPath], { encoding: 'utf8', cwd: process.cwd(), timeout: 20_000 })
  return JSON.parse(stdout.trim()) as Record<string, unknown>
}

/** The same surface through the `agentteams` entry, to prove the dispatch. */
async function cliViaAgentteams(socketPath: string, args: readonly string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, ['cli/agentteams.mjs', ...args, '--socket', socketPath], { encoding: 'utf8', cwd: process.cwd(), timeout: 20_000 })
  return JSON.parse(stdout.trim()) as Record<string, unknown>
}

/**
 * Composes one daemon over its registration connection: the group channel rides
 * the registration client, and agent-messaging consumes that channel. This is
 * the real batch-2 wiring the CLI exercises below.
 */
async function startMessaging(options: {
  readonly agentId: string
  readonly dataDirectory: string
  readonly ca: Buffer
  readonly endpoint?: string
  readonly vikunja: { readonly baseUrl: string; readonly token: string }
}): Promise<{ readonly messaging: AgentMessaging; readonly registration: RegistrationClient; readonly channel: GroupChannel; close(): Promise<void> }> {
  let channel: GroupChannel | undefined
  const registration = createRegistrationClient({
    declaration: declaration(options.agentId),
    endpoint: options.endpoint ?? relay!.url,
    credential: `Bearer ${options.agentId}`,
    ca: options.ca,
    heartbeatIntervalMs: 5_000,
    admissionTimeoutMs: 1_000,
    requestTimeoutMs: 5_000,
    maxPendingRequests: 16,
    maxDataConnections: 4,
    connectTimeoutMs: 1_000,
    maxMessageBytes: 1_048_576,
    maxBufferedBytes: 1_048_576,
    maxPendingFrames: 32,
    reconnect: { initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 20 },
    onStatus: status => forwardRegistrationStatus(channel, status),
  })
  channel = createRegistrationGroupChannel(registration, { requestTimeoutMs: 15_000, maxPendingRequests: 16 })
  const groupChannel = channel
  await registration.start()
  // The same composition the daemon uses: local socket on the shared channel.
  const messaging = await startGroupAgentMessaging({
    registration,
    channel: groupChannel,
    declaration: declaration(options.agentId),
    dataDirectory: options.dataDirectory,
    vikunja: options.vikunja,
  })
  return {
    messaging,
    registration,
    channel: groupChannel,
    close: async () => {
      await messaging.close()
      groupChannel.close()
      await registration.stop()
    },
  }
}

let directory: string
let relay: RelayServer | undefined
let vikunja: Awaited<ReturnType<typeof startVikunjaStub>> | undefined

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'group-loop-'))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath, '-days', '1'], { stdio: 'ignore' })
  writeFileSync(join(directory, 'key.pem'), readFileSync(keyPath))
})

afterAll(async () => {
  await relay?.close()
  vikunja?.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('the batch-1 issue/action loop', () => {
  it('settles an external close through the real registry timer with no console query', async () => {
    vikunja = await startVikunjaStub()
    const cert = readFileSync(join(directory, 'cert.pem'))
    const registryData = join(directory, 'r5-registry-data')
    const port = await freePort()
    const configPath = join(directory, `r5-registry-${port}.toml`)
    const credentialPaths = new Map<string, string>()
    for (const agentId of ['agent-a', 'agent-b', 'agent-c']) {
      const credentialPath = join(directory, `r5-credential-${agentId}.txt`)
      writeFileSync(credentialPath, `Bearer ${agentId}\n`)
      credentialPaths.set(agentId, credentialPath)
    }
    writeFileSync(configPath, `version = 4

[daemon]
kind = "registry"
id = "r5-registry"
hostId = "r5-registry-host"
accountId = "account-a"
scopeId = "scope-a"
dataDirectory = ${JSON.stringify(registryData)}

[listen]
ip = "127.0.0.1"
port = ${port}
tlsCertRef = "file:${join(directory, 'cert.pem')}"
tlsKeyRef = "file:${join(directory, 'key.pem')}"

[[admissions]]
admissionRef = "agent-a"
agentId = "agent-a"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-a')}"

[[admissions]]
admissionRef = "agent-b"
agentId = "agent-b"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-b')}"

[[admissions]]
admissionRef = "agent-c"
agentId = "agent-c"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-c')}"
`)

    const started = await startRegistryDaemon(configPath)
    expect(started.state).toBe('running')
    expect(started.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/)
    const a = await startMessaging({
      agentId: 'agent-a', dataDirectory: join(directory, 'r5-a'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-a' },
    })
    const b = await startMessaging({
      agentId: 'agent-b', dataDirectory: join(directory, 'r5-b'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-b' },
    })
    const c = await startMessaging({
      agentId: 'agent-c', dataDirectory: join(directory, 'r5-c'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-c' },
    })
    try {
      const created = await cli(a.messaging.socketPath, ['group', 'create', 'release'])
      const groupId = (created.group as { groupId: string }).groupId
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-b', 'peer'])
      await cli(b.messaging.socketPath, ['group', 'accept', groupId])
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-c', 'master', '--masters', 'agent-b'])
      await cli(c.messaging.socketPath, ['group', 'accept', groupId])

      const session = await cli(c.messaging.socketPath, ['issue', 'create', groupId, 'p1', 'release', 'please', '--commit', 'r5-issue'])
      const sessionId = (session.session as { sessionId: string }).sessionId
      const action = await cli(c.messaging.socketPath, ['action', 'create', sessionId, 'agent-b', 'review', 'check', 'verdict', '--commit', 'r5-action'])
      const actionId = (action.action as { actionId: string }).actionId
      const paths = groupPaths(registryData, 'account-a', 'scope-a', groupId)
      const writesBeforeClose = vikunja.calls.filter((entry) => entry.method === 'POST').length
      const readsBeforeClose = vikunja.calls.filter((entry) => entry.method === 'GET' && /\/api\/v1\/tasks\/\d+$/.test(entry.path)).length

      // External close while no Console is running and no issue query or action
      // create is sent. Only the registry-owned timer may drive the convergence.
      vikunja.issues.get('1')!.done = true
      await waitUntil(() => {
        const sessions = readJsonFile<{ sessions: readonly { sessionId: string; state: string }[] }>(paths.sessionsFile)
        const actions = readJsonFile<{ actions: readonly { actionId: string; state: string }[] }>(paths.actionsFile)
        const storedSession = sessions?.sessions.find((entry) => entry.sessionId === sessionId)
        const storedAction = actions?.actions.find((entry) => entry.actionId === actionId)
        return storedSession?.state === 'closed' && storedAction?.state === 'cancelled'
      }, 40_000)
      const sweepReads = vikunja.calls
        .filter((entry) => entry.method === 'GET' && /\/api\/v1\/tasks\/\d+$/.test(entry.path))
        .slice(readsBeforeClose)
      expect(sweepReads.length).toBeGreaterThan(0)
      // The initiator is the elected read owner; every timer read uses its
      // Vikunja credential, not the owner peer or the assignee.
      expect(sweepReads.every((entry) => entry.auth === 'Bearer token-c')).toBe(true)
      expect(vikunja.calls.filter((entry) => entry.method === 'POST')).toHaveLength(writesBeforeClose)

      const stopped = await stopRegistryDaemon(configPath)
      expect(stopped.state).toBe('stopped')
      expect(processAlive(started.pid!)).toBe(false)
      const readsAtStop = vikunja.calls.filter((entry) => entry.method === 'GET' && /\/api\/v1\/tasks\/\d+$/.test(entry.path)).length
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
      expect(vikunja.calls.filter((entry) => entry.method === 'GET' && /\/api\/v1\/tasks\/\d+$/.test(entry.path))).toHaveLength(readsAtStop)
      expect((await readRegistryState(registryStatePath(await loadRegistryIntent(configPath))))?.state).toBe('stopped')
    } finally {
      const state = await readRegistryState(registryStatePath(await loadRegistryIntent(configPath))).catch(() => undefined)
      if (state !== undefined && state.pid > 0 && processAlive(state.pid)) {
        await stopRegistryDaemon(configPath).catch(() => {
          try { process.kill(state.pid, 'SIGTERM') } catch { /* preserve the original failure */ }
        })
      }
      await a.close().catch(() => undefined)
      await b.close().catch(() => undefined)
      await c.close().catch(() => undefined)
    }
  }, 90_000)

  it('creates a group, runs an issue and an action, writes to Vikunja, and closes', async () => {
    vikunja = await startVikunjaStub()
    const cert = readFileSync(join(directory, 'cert.pem'))
    const key = readFileSync(join(directory, 'key.pem'))
    const agents = new Map<string, AuthenticatedAgent>()
    for (const id of ['agent-a', 'agent-b', 'agent-c']) agents.set(`Bearer ${id}`, { accountId: 'account-a', scopeId: 'scope-a', agentId: id })
    const hubState = join(directory, 'hub.json')
    relay = await createRelayServer({
      host: '127.0.0.1', port: 0, key, cert,
      maxPayload: 1024 * 1024, maxConnections: 16, maxGrants: 2,
      maxBufferedAmount: 4 * 1024, maxPendingMessages: 8, maxPendingBytes: 16 * 1024, grantTtlMs: 60_000,
      authenticate: (credential) => (credential === undefined ? null : agents.get(credential) ?? null),
      groupScope: { accountId: 'account-a', scopeId: 'scope-a' },
      groupHub: (bridge) => createGroupHub({
        store: {
          load: () => { try { return JSON.parse(readFileSync(hubState, 'utf8')) as GroupHubSnapshot } catch { return undefined } },
          save: (snapshot) => writeFileSync(hubState, JSON.stringify(snapshot)),
        },
        sendToAgent: bridge.send,
        isOnline: bridge.isOnline,
        externalOpTimeoutMs: 15_000,
      }),
    })
    const a = await startMessaging({
      agentId: 'agent-a', dataDirectory: join(directory, 'a'), ca: cert,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-a' },
    })
    const c = await startMessaging({
      agentId: 'agent-c', dataDirectory: join(directory, 'c'), ca: cert,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-c' },
    })
    const b = await startMessaging({
      agentId: 'agent-b', dataDirectory: join(directory, 'b'), ca: cert,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-b' },
    })
    try {
      const created = await cli(a.messaging.socketPath, ['group', 'create', 'release'])
      const groupId = (created.group as { groupId: string }).groupId
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-b', 'peer'])
      await cli(b.messaging.socketPath, ['group', 'accept', groupId])
      // One explicit mastersOf edge makes C the assigning master over B.
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-c', 'master', '--masters', 'agent-b'])
      await cli(c.messaging.socketPath, ['group', 'accept', groupId])

      const session = await cli(c.messaging.socketPath, ['issue', 'create', groupId, 'p1', 'ship it', 'please ship', '--commit', 'cli-retry-1'])
      const sessionId = (session.session as { sessionId: string }).sessionId
      // One issue was created here; issue 99 existed before this group.
      expect([...vikunja.issues.keys()].sort()).toEqual(['1', '99'])
      // A CLI retry that reuses its commit id must not open a second issue.
      const retried = await cli(c.messaging.socketPath, ['issue', 'create', groupId, 'p1', 'ship it', 'please ship', '--commit', 'cli-retry-1'])
      expect((retried.session as { sessionId: string }).sessionId).toBe(sessionId)
      expect(vikunja.issues.size).toBe(2)

      const action = await cli(c.messaging.socketPath, ['action', 'create', sessionId, 'agent-b', 'review', 'check the plan', 'a verdict', '--reply'])
      const actionId = (action.action as { actionId: string }).actionId

      await cli(b.messaging.socketPath, ['action', 'submit', actionId, 'looks good'])
      expect(vikunja.issues.get('1')?.comments.length).toBe(1)

      const listed = await cliViaAgentteams(a.messaging.socketPath, ['group', 'list'])
      expect((listed.groups as readonly unknown[]).length).toBe(1)

      // Referencing an issue this group never created binds the project and state
      // the read reports; both come from Vikunja, not from a placeholder.
      const referenced = await cli(c.messaging.socketPath, ['issue', 'reference', groupId, '99'])
      const reference = referenced.session as { vikunjaProjectId: string; vikunjaIssueId: string; state: string }
      expect(reference.vikunjaIssueId).toBe('99')
      expect(reference.vikunjaProjectId).toBe('p9')
      expect(reference.state).toBe('closed')
      // Referencing the issue this group already created keeps its session.
      const same = await cli(c.messaging.socketPath, ['issue', 'reference', groupId, '1'])
      expect((same.session as { sessionId: string }).sessionId).toBe(sessionId)

      // The initiator closes in Vikunja; Teams converges on the next read.
      await cli(c.messaging.socketPath, ['issue', 'close', sessionId, 'done', 'shipped'])
      const queried = await cli(c.messaging.socketPath, ['issue', 'query', sessionId])
      expect((queried.session as { state: string }).state).toBe('closed')
      expect(vikunja.issues.get('1')?.done).toBe(true)
    } finally {
      await a.close()
      await b.close()
      await c.close()
    }
  }, 60_000)

  it('converges an offline initiator through a trusted reader with no console', async () => {
    vikunja = await startVikunjaStub()
    const cert = readFileSync(join(directory, 'cert.pem'))
    const registryData = join(directory, 'r5-offline-registry-data')
    const port = await freePort()
    const configPath = join(directory, `r5-offline-registry-${port}.toml`)
    const credentialPaths = new Map<string, string>()
    for (const agentId of ['agent-a', 'agent-b', 'agent-c']) {
      const credentialPath = join(directory, `r5-offline-credential-${agentId}.txt`)
      writeFileSync(credentialPath, `Bearer ${agentId}\n`)
      credentialPaths.set(agentId, credentialPath)
    }
    writeFileSync(configPath, `version = 4

[daemon]
kind = "registry"
id = "r5-offline-registry"
hostId = "r5-offline-registry-host"
accountId = "account-a"
scopeId = "scope-a"
dataDirectory = ${JSON.stringify(registryData)}

[listen]
ip = "127.0.0.1"
port = ${port}
tlsCertRef = "file:${join(directory, 'cert.pem')}"
tlsKeyRef = "file:${join(directory, 'key.pem')}"

[[admissions]]
admissionRef = "agent-a"
agentId = "agent-a"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-a')}"

[[admissions]]
admissionRef = "agent-b"
agentId = "agent-b"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-b')}"

[[admissions]]
admissionRef = "agent-c"
agentId = "agent-c"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-c')}"
`)

    const started = await startRegistryDaemon(configPath)
    expect(started.state).toBe('running')
    const a = await startMessaging({
      agentId: 'agent-a', dataDirectory: join(directory, 'r5-offline-a'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-a' },
    })
    const b = await startMessaging({
      agentId: 'agent-b', dataDirectory: join(directory, 'r5-offline-b'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-b' },
    })
    const c = await startMessaging({
      agentId: 'agent-c', dataDirectory: join(directory, 'r5-offline-c'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-c' },
    })
    try {
      const created = await cli(a.messaging.socketPath, ['group', 'create', 'release'])
      const groupId = (created.group as { groupId: string }).groupId
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-b', 'peer'])
      await cli(b.messaging.socketPath, ['group', 'accept', groupId])
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-c', 'master', '--masters', 'agent-b'])
      await cli(c.messaging.socketPath, ['group', 'accept', groupId])

      const session = await cli(c.messaging.socketPath, ['issue', 'create', groupId, 'p1', 'release', 'please', '--commit', 'r5-offline-issue'])
      const sessionId = (session.session as { sessionId: string }).sessionId
      const issueId = (session.session as { vikunjaIssueId: string }).vikunjaIssueId
      const action = await cli(c.messaging.socketPath, ['action', 'create', sessionId, 'agent-b', 'review', 'check', 'verdict', '--commit', 'r5-offline-action'])
      const actionId = (action.action as { actionId: string }).actionId
      const paths = groupPaths(registryData, 'account-a', 'scope-a', groupId)
      const taskReads = () => vikunja!.calls.filter((entry) => entry.method === 'GET' && entry.path === `/api/v1/tasks/${issueId}`)

      // While the initiator daemon is online, it is the elected read owner. The
      // command-before-refresh read on action create already proves this.
      expect(taskReads().some((entry) => entry.auth === 'Bearer token-c')).toBe(true)

      // The initiator daemon goes offline; its data directory is preserved.
      await c.close()
      await waitUntilAsync(async () => {
        const peers = await a.registration.directory(false)
        return peers.some((peer) => peer.declaration.identity.agentId === 'agent-c' && peer.presence === 'offline')
      }, 10_000)

      // The registry now reassigns the read-only query to the first active,
      // online member that is neither the initiator nor the assignee.
      await waitUntil(() => taskReads().some((entry) => entry.auth === 'Bearer token-a'), 15_000)
      const readsWindowStart = taskReads().length
      const writesBeforeClose = vikunja!.calls.filter((entry) => entry.method === 'POST').length

      // External Vikunja closes the issue. No console, issue query, or action
      // create runs here: only the registry-owned timer may converge.
      const closedAt = Date.now()
      vikunja!.issues.get(issueId)!.done = true
      await waitUntil(() => {
        const sessions = readJsonFile<{ sessions: readonly { sessionId: string; state: string }[] }>(paths.sessionsFile)
        const actions = readJsonFile<{ actions: readonly { actionId: string; state: string }[] }>(paths.actionsFile)
        const storedSession = sessions?.sessions.find((entry) => entry.sessionId === sessionId)
        const storedAction = actions?.actions.find((entry) => entry.actionId === actionId)
        return storedSession?.state === 'closed' && storedAction?.state === 'cancelled'
      }, 20_000)
      const convergenceMs = Date.now() - closedAt

      const sweepReads = taskReads().slice(readsWindowStart)
      expect(sweepReads.length).toBeGreaterThan(0)
      expect(sweepReads.every((entry) => entry.auth === 'Bearer token-a')).toBe(true)
      expect(sweepReads.some((entry) => entry.auth === 'Bearer token-c')).toBe(false)
      expect(sweepReads.some((entry) => entry.auth === 'Bearer token-b')).toBe(false)
      expect(vikunja!.calls.filter((entry) => entry.method === 'POST')).toHaveLength(writesBeforeClose)

      // The registry process itself settled the state, independent of the
      // initiator daemon; its persisted sweep receipt names the change.
      const receipt = await readRegistryState(registryStatePath(await loadRegistryIntent(configPath)))
      expect(receipt?.sweep?.changed).toBeGreaterThanOrEqual(1)
      expect(processAlive(started.pid!)).toBe(true)

      const stopped = await stopRegistryDaemon(configPath)
      expect(stopped.state).toBe('stopped')
      expect(processAlive(started.pid!)).toBe(false)
      const readsAtStop = taskReads().length
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))
      expect(taskReads()).toHaveLength(readsAtStop)
      expect((await readRegistryState(registryStatePath(await loadRegistryIntent(configPath))))?.state).toBe('stopped')
      console.log(`R5 offline reader: convergence=${convergenceMs}ms reads=${sweepReads.length} auth=token-a posts=${vikunja!.calls.filter((entry) => entry.method === 'POST').length}`)
    } finally {
      const state = await readRegistryState(registryStatePath(await loadRegistryIntent(configPath))).catch(() => undefined)
      if (state !== undefined && state.pid > 0 && processAlive(state.pid)) {
        await stopRegistryDaemon(configPath).catch(() => {
          try { process.kill(state.pid, 'SIGTERM') } catch { /* preserve the original failure */ }
        })
      }
      await a.close().catch(() => undefined)
      await b.close().catch(() => undefined)
      await c.close().catch(() => undefined)
    }
  }, 90_000)

  it('shortens only the in-flight session poll inside the single registry timer', async () => {
    vikunja = await startVikunjaStub()
    const cert = readFileSync(join(directory, 'cert.pem'))
    const registryData = join(directory, 'r5-inflight-registry-data')
    const registryStartedAt = Date.now()
    const port = await freePort()
    const configPath = join(directory, `r5-inflight-registry-${port}.toml`)
    const credentialPaths = new Map<string, string>()
    for (const agentId of ['agent-a', 'agent-b', 'agent-c']) {
      const credentialPath = join(directory, `r5-inflight-credential-${agentId}.txt`)
      writeFileSync(credentialPath, `Bearer ${agentId}\n`)
      credentialPaths.set(agentId, credentialPath)
    }
    writeFileSync(configPath, `version = 4

[daemon]
kind = "registry"
id = "r5-inflight-registry"
hostId = "r5-inflight-registry-host"
accountId = "account-a"
scopeId = "scope-a"
dataDirectory = ${JSON.stringify(registryData)}

[listen]
ip = "127.0.0.1"
port = ${port}
tlsCertRef = "file:${join(directory, 'cert.pem')}"
tlsKeyRef = "file:${join(directory, 'key.pem')}"

[[admissions]]
admissionRef = "agent-a"
agentId = "agent-a"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-a')}"

[[admissions]]
admissionRef = "agent-b"
agentId = "agent-b"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-b')}"

[[admissions]]
admissionRef = "agent-c"
agentId = "agent-c"
accountId = "account-a"
scopeId = "scope-a"
credentialRef = "file:${credentialPaths.get('agent-c')}"
`)

    const started = await startRegistryDaemon(configPath)
    expect(started.state).toBe('running')
    const a = await startMessaging({
      agentId: 'agent-a', dataDirectory: join(directory, 'r5-inflight-a'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-a' },
    })
    const b = await startMessaging({
      agentId: 'agent-b', dataDirectory: join(directory, 'r5-inflight-b'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-b' },
    })
    const c = await startMessaging({
      agentId: 'agent-c', dataDirectory: join(directory, 'r5-inflight-c'), ca: cert, endpoint: started.url,
      vikunja: { baseUrl: vikunja.baseUrl, token: 'token-c' },
    })
    try {
      const created = await cli(a.messaging.socketPath, ['group', 'create', 'release'])
      const groupId = (created.group as { groupId: string }).groupId
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-b', 'peer'])
      await cli(b.messaging.socketPath, ['group', 'accept', groupId])
      await cli(a.messaging.socketPath, ['group', 'invite', groupId, 'agent-c', 'master', '--masters', 'agent-b'])
      await cli(c.messaging.socketPath, ['group', 'accept', groupId])

      const sessionA = await cli(c.messaging.socketPath, ['issue', 'create', groupId, 'p1', 'inflight', 'body', '--commit', 'r5-inflight-issue-a'])
      const sessionAId = (sessionA.session as { sessionId: string }).sessionId
      const issueAId = (sessionA.session as { vikunjaIssueId: string }).vikunjaIssueId
      const sessionB = await cli(c.messaging.socketPath, ['issue', 'create', groupId, 'p1', 'ordinary', 'body', '--commit', 'r5-inflight-issue-b'])
      const sessionBId = (sessionB.session as { sessionId: string }).sessionId
      const issueBId = (sessionB.session as { vikunjaIssueId: string }).vikunjaIssueId
      // Session A has a real in-flight action; session B has none.
      await cli(c.messaging.socketPath, ['action', 'create', sessionAId, 'agent-b', 'review', 'check', 'verdict', '--commit', 'r5-inflight-action'])
      const paths = groupPaths(registryData, 'account-a', 'scope-a', groupId)
      const readsFor = (id: string) => vikunja!.calls.filter((entry) => entry.method === 'GET' && entry.path === `/api/v1/tasks/${id}`)
      const sessionState = (sessionId: string) => {
        const sessions = readJsonFile<{ sessions: readonly { sessionId: string; state: string }[] }>(paths.sessionsFile)
        return sessions?.sessions.find((entry) => entry.sessionId === sessionId)?.state
      }

      // The registry timer targets the in-flight session before both issues are
      // closed; the ordinary session must not be read during that same window.
      await waitUntil(() => readsFor(issueAId).length > 0 && readsFor(issueBId).length === 0, 20_000)

      const flipAt = Date.now()
      const readsAtFlip = readsFor(issueAId).length
      vikunja!.issues.get(issueAId)!.done = true
      vikunja!.issues.get(issueBId)!.done = true
      await waitUntil(() => sessionState(sessionAId) === 'closed', 20_000)
      const convergenceMs = Date.now() - flipAt
      expect(convergenceMs).toBeLessThan(15_000)
      expect(readsFor(issueAId).slice(readsAtFlip).length).toBeGreaterThan(0)

      // During the shortened window, B stays open and is never read early. The
      // observation ends before the 30s full pass so it stays inside one window.
      const observationEnd = Date.now() + 4_000
      while (Date.now() < observationEnd) {
        expect(sessionState(sessionBId)).toBe('open')
        expect(readsFor(issueBId)).toHaveLength(0)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      }
      expect(Date.now() - registryStartedAt).toBeLessThan(25_000)

      // The single registry timer also owns the ordinary session's later full
      // read: it converges only on the full window, never on the shortened one.
      await waitUntil(() => sessionState(sessionBId) === 'closed', 45_000)
      const fullWindowMs = Date.now() - flipAt
      expect(fullWindowMs).toBeGreaterThan(15_000)
      expect(readsFor(issueBId).length).toBeGreaterThan(0)

      // One timer, one process: stopping the registry stops every read.
      const stopped = await stopRegistryDaemon(configPath)
      expect(stopped.state).toBe('stopped')
      expect(processAlive(started.pid!)).toBe(false)
      const readsAtStop = readsFor(issueAId).length + readsFor(issueBId).length
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))
      expect(readsFor(issueAId).length + readsFor(issueBId).length).toBe(readsAtStop)
      expect((await readRegistryState(registryStatePath(await loadRegistryIntent(configPath))))?.state).toBe('stopped')
      console.log(`R5 in-flight: convergence=${convergenceMs}ms full=${fullWindowMs}ms aReads=${readsFor(issueAId).length} bReads=${readsFor(issueBId).length}`)
    } finally {
      const state = await readRegistryState(registryStatePath(await loadRegistryIntent(configPath))).catch(() => undefined)
      if (state !== undefined && state.pid > 0 && processAlive(state.pid)) {
        await stopRegistryDaemon(configPath).catch(() => {
          try { process.kill(state.pid, 'SIGTERM') } catch { /* preserve the original failure */ }
        })
      }
      await a.close().catch(() => undefined)
      await b.close().catch(() => undefined)
      await c.close().catch(() => undefined)
    }
  }, 90_000)
})
