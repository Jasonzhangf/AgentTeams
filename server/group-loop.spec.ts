import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthenticatedAgent, AgentDeclaration } from '../control-protocol/agent-services.ts'
import { createGroupHub, type GroupHubSnapshot } from './group-hub.ts'
import { createRelayServer, type RelayServer } from './relay.ts'
import { createAgentMessaging, localSocketPathFor } from '../runtime/agent-messaging.ts'

/**
 * Batch-1 black-box loop: a real relay with the real hub, two real agent
 * messaging daemons, the real CLI over real Unix sockets, and a real local HTTP
 * Vikunja stand-in. Vikunja itself is the only stand-in, and it is labeled here.
 */

interface Recorded { readonly method: string; readonly path: string; readonly body: string; readonly auth: string }

function startVikunjaStub(): { readonly baseUrl: string; readonly issues: Map<string, { done: boolean; comments: string[] }>; readonly calls: Recorded[]; close(): void } {
  const issues = new Map<string, { done: boolean; comments: string[] }>()
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
        issues.set(id, { done: false, comments: [] })
        send(201, { id: Number(id), title: parsed.title, description: parsed.description, done: false })
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
        send(200, { id: Number(id), title: 't', done: issue.done })
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

let directory: string
let relay: RelayServer | undefined
let vikunja: Awaited<ReturnType<typeof startVikunjaStub>> | undefined

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'group-loop-'))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath, '-days', '1'], { stdio: 'ignore' })
  writeFileSync(join(directory, 'key.pem'), readFileSync(keyPath))
})

afterAll(async () => {
  await relay?.close()
  vikunja?.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('the batch-1 issue/action loop', () => {
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
    const a = await createAgentMessaging({
      relayUrl: relay.url, credential: 'Bearer agent-a', declaration: declaration('agent-a'),
      socketPath: localSocketPathFor(join(directory, 'a')), vikunja: { baseUrl: vikunja.baseUrl, token: 'token-a' },
    })
    const c = await createAgentMessaging({
      relayUrl: relay.url, credential: 'Bearer agent-c', declaration: declaration('agent-c'),
      socketPath: localSocketPathFor(join(directory, 'c')), vikunja: { baseUrl: vikunja.baseUrl, token: 'token-c' },
    })
    const b = await createAgentMessaging({
      relayUrl: relay.url, credential: 'Bearer agent-b', declaration: declaration('agent-b'),
      socketPath: localSocketPathFor(join(directory, 'b')), vikunja: { baseUrl: vikunja.baseUrl, token: 'token-b' },
    })
    await a.start()
    await b.start()
    await c.start()
    try {
      const created = await cli(a.socketPath, ['group', 'create', 'release'])
      const groupId = (created.group as { groupId: string }).groupId
      await cli(a.socketPath, ['group', 'invite', groupId, 'agent-b', 'peer'])
      await cli(b.socketPath, ['group', 'accept', groupId])
      // One explicit mastersOf edge makes C the assigning master over B.
      await cli(a.socketPath, ['group', 'invite', groupId, 'agent-c', 'master', '--masters', 'agent-b'])
      await cli(c.socketPath, ['group', 'accept', groupId])

      const session = await cli(c.socketPath, ['issue', 'create', groupId, 'p1', 'ship it', 'please ship'])
      const sessionId = (session.session as { sessionId: string }).sessionId
      expect(vikunja.issues.size).toBe(1)

      const action = await cli(c.socketPath, ['action', 'create', sessionId, 'agent-b', 'review', 'check the plan', 'a verdict', '--reply'])
      const actionId = (action.action as { actionId: string }).actionId

      await cli(b.socketPath, ['action', 'submit', actionId, 'looks good'])
      expect([...vikunja.issues.values()][0].comments.length).toBe(1)

      const listed = await cliViaAgentteams(a.socketPath, ['group', 'list'])
      expect((listed.groups as readonly unknown[]).length).toBe(1)

      // The initiator closes in Vikunja; Teams converges on the next read.
      await cli(c.socketPath, ['issue', 'close', sessionId, 'done', 'shipped'])
      const queried = await cli(c.socketPath, ['issue', 'query', sessionId])
      expect((queried.session as { state: string }).state).toBe('closed')
      expect([...vikunja.issues.values()][0].done).toBe(true)
    } finally {
      await a.close()
      await b.close()
      await c.close()
    }
  }, 60_000)
})
