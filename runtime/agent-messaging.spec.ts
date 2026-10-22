import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentDeclaration, ServiceError } from '../control-protocol/agent-services.ts'
import type { ExternalOpReply, GroupWireReply, GroupWireRequest } from '../control-protocol/group-wire.ts'
import {
  createAgentMessaging,
  type AgentMessaging,
  type AgentMessagingChannel,
  type AgentMessagingPush,
} from './agent-messaging.ts'
import { sendLocalMessageRequest } from './local-message-socket.ts'

/**
 * Unit coverage for the injected-channel composition. The transport is a fake
 * channel, so these cases prove forwarding, op execution and typed failures
 * without opening a relay socket. The Vikunja stand-in is a local HTTP server.
 */

const directories: string[] = []
const messaging: AgentMessaging[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(messaging.splice(0).map(instance => instance.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error === undefined ? resolveClose() : rejectClose(error))
  })))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function declaration(agentId: string): AgentDeclaration {
  return {
    identity: { hostId: agentId, machineId: agentId, agentId, accountId: 'account', agentKind: 'custom', label: agentId },
    scopeId: 'scope',
    revision: 1,
    capabilities: [],
    routes: [],
  }
}

async function socketRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-messaging-'))
  directories.push(directory)
  return directory
}

interface FakeChannel {
  readonly channel: AgentMessagingChannel
  readonly requests: GroupWireRequest[]
  readonly sent: ExternalOpReply[]
  deliver(push: AgentMessagingPush): void
  detached(): number
}

function fakeChannel(
  respond: (frame: GroupWireRequest) => GroupWireReply | Promise<GroupWireReply> =
    frame => ({ kind: 'group.list', requestId: frame.requestId, groups: [] }),
): FakeChannel {
  const requests: GroupWireRequest[] = []
  const sent: ExternalOpReply[] = []
  const listeners = new Set<(push: AgentMessagingPush) => void>()
  let detached = 0
  return {
    channel: {
      request: async frame => {
        requests.push(frame)
        return await respond(frame)
      },
      send: async frame => { sent.push(frame) },
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener); detached += 1 }
      },
    },
    requests,
    sent,
    deliver: push => { for (const listener of [...listeners]) listener(push) },
    detached: () => detached,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function vikunjaStub(): Promise<{ baseUrl: string; calls: string[] }> {
  const calls: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      calls.push(`${request.method ?? ''} ${request.url ?? ''}`)
      if (request.method === 'PUT' && /\/api\/v1\/projects\/[^/]+\/tasks$/u.test(request.url ?? '')) {
        const parsed = JSON.parse(body) as { readonly title?: string; readonly description?: string }
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 7, title: parsed.title, description: parsed.description, done: false }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'not found' }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Vikunja stub did not bind a port')
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls }
}

it('forwards a CLI group request to the injected channel and returns its reply verbatim', async () => {
  const directory = await socketRoot()
  const socketPath = join(directory, 'message.sock')
  const fake = fakeChannel()
  const instance = await createAgentMessaging({ channel: fake.channel, declaration: declaration('agent-a'), socketPath })
  messaging.push(instance)
  await instance.start()

  const reply = await sendLocalMessageRequest({ socketPath, request: { kind: 'group.list', requestId: 'cli-1' }, timeoutMs: 1_000 })

  expect(reply).toEqual({ kind: 'group.list', requestId: 'cli-1', groups: [] })
  expect(fake.requests).toEqual([{ kind: 'group.list', requestId: 'cli-1' }])
  await instance.close()
  expect(fake.detached()).toBe(1)
})

it('executes an issue.create push against Vikunja and returns exactly one confirmed receipt', async () => {
  const directory = await socketRoot()
  const socketPath = join(directory, 'message.sock')
  const vikunja = await vikunjaStub()
  const fake = fakeChannel()
  const instance = await createAgentMessaging({
    channel: fake.channel,
    declaration: declaration('agent-a'),
    socketPath,
    vikunja: { baseUrl: vikunja.baseUrl, token: 'token-a' },
  })
  messaging.push(instance)
  await instance.start()

  fake.deliver({
    kind: 'op.execute',
    opId: 'op-1',
    opKind: 'issue.create',
    params: { commitId: 'commit-9', vikunjaProjectId: 'project-1', title: 'ship it', body: 'please ship' },
  })
  await waitFor(() => fake.sent.length > 0)
  await new Promise<void>(resolve => setTimeout(resolve, 20))

  expect(fake.sent).toEqual([{
    kind: 'op.confirmed',
    opId: 'op-1',
    commitId: 'commit-9',
    result: { issueId: '7' },
  }])
  expect(vikunja.calls).toEqual(['PUT /api/v1/projects/project-1/tasks'])
  await instance.close()
})

it('rejects the CLI request with a typed channel failure instead of a success', async () => {
  const directory = await socketRoot()
  const socketPath = join(directory, 'message.sock')
  const failure: ServiceError = { code: 'FORBIDDEN', message: 'only an admin may invite' }
  const fake = fakeChannel(() => {
    throw Object.assign(new Error(failure.message), { code: failure.code, serviceError: failure })
  })
  const instance = await createAgentMessaging({ channel: fake.channel, declaration: declaration('agent-a'), socketPath })
  messaging.push(instance)
  await instance.start()

  await expect(sendLocalMessageRequest({ socketPath, request: { kind: 'group.list', requestId: 'cli-2' }, timeoutMs: 1_000 }))
    .rejects.toMatchObject({ code: 'FORBIDDEN', message: failure.message, serviceError: failure })
  expect(instance.lastError()).toEqual(failure)
  await instance.close()
})
