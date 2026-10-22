import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import type { GroupWireReply, GroupWireRequest } from '../control-protocol/group-wire.ts'
import {
  LocalMessageSocketError,
  sendLocalMessageRequest,
  startLocalMessageSocket,
  type LocalMessageSocketServer,
} from './local-message-socket.ts'

const directories: string[] = []
const sockets: LocalMessageSocketServer[] = []

afterAll(async () => {
  await Promise.all(
    sockets.splice(0).map(async listener => {
      try {
        await listener.close()
      } catch {
        // close is best-effort cleanup after an explicit failure assertion
      }
    }),
  )
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  directories.push(root)
  return root
}

async function startServer(options: {
  readonly socketPath: string
  readonly handle: (request: GroupWireRequest) => GroupWireReply | Promise<GroupWireReply>
  readonly maxFrameBytes?: number
}): Promise<LocalMessageSocketServer> {
  const server = await startLocalMessageSocket({
    socketPath: options.socketPath,
    handler: options.handle,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  })
  sockets.push(server)
  return server
}

async function socketState(path: string): Promise<{ exists: boolean; mode?: number; isSocket?: boolean }> {
  try {
    const actual = await stat(path)
    return { exists: true, mode: actual.mode & 0o777, isSocket: actual.isSocket() }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw cause
  }
}

async function rawExchange(socketPath: string, payload: string): Promise<unknown> {
  const peer = createConnection(socketPath)
  peer.setEncoding('utf8')
  let settled = false
  const reply = new Promise<string>((resolveReply, rejectReply) => {
    let buffered = ''
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      settle()
    }
    peer.on('data', chunk => {
      buffered += chunk.toString('utf8')
      const index = buffered.indexOf('\n')
      if (index >= 0) finish(() => resolveReply(buffered.slice(0, index)))
    })
    peer.once('error', cause => finish(() => rejectReply(cause)))
    peer.once('close', () => finish(() => rejectReply(new Error('raw peer closed before a reply'))))
    peer.once('connect', () => peer.write(payload))
  })
  const text = await reply
  peer.destroy()
  return JSON.parse(text)
}

function listRequest(requestId = 'r1'): GroupWireRequest {
  return { kind: 'group.list', requestId }
}

it('round-trips one validated request over a real Unix socket with private socket permissions', async () => {
  const root = await tempRoot('teams-local-message-success-')
  const socketPath = join(root, '.state', 'message.sock')
  const calls: GroupWireRequest[] = []
  const server = await startServer({
    socketPath,
    handle: request => {
      calls.push(request)
      return { kind: 'group.list', requestId: request.requestId, groups: [] }
    },
  })

  expect(await socketState(socketPath)).toEqual({ exists: true, mode: 0o600, isSocket: true })
  expect(await socketState(join(root, '.state'))).toEqual({ exists: true, mode: 0o700, isSocket: false })

  const reply = await sendLocalMessageRequest({ socketPath, request: listRequest(), timeoutMs: 1_000 })
  expect(reply).toEqual({ kind: 'group.list', requestId: 'r1', groups: [] })
  expect(calls).toEqual([{ kind: 'group.list', requestId: 'r1' }])

  await server.close()
  expect(await socketState(socketPath)).toEqual({ exists: false })
})

it('rejects malformed and extra-field inbound frames without dispatching the handler', async () => {
  const root = await tempRoot('teams-local-message-invalid-')
  const socketPath = join(root, 'message.sock')
  let calls = 0
  const server = await startServer({
    socketPath,
    handle: request => {
      calls += 1
      return { kind: 'group.list', requestId: request.requestId, groups: [] }
    },
  })

  const extraField = await rawExchange(socketPath, `${JSON.stringify({
    kind: 'group.list', requestId: 'r-extra', target: 'broadcast',
  })}\n`)
  expect(extraField).toMatchObject({
    kind: 'relay.error', requestId: 'r-extra', error: { code: 'INVALID_INPUT' },
  })

  const malformed = await rawExchange(socketPath, '{not json}\n')
  expect(malformed).toMatchObject({ kind: 'relay.error', error: { code: 'INVALID_INPUT' } })
  expect((malformed as { readonly requestId?: string }).requestId).toBeUndefined()
  expect(calls).toBe(0)

  await server.close()
  expect(await socketState(socketPath)).toEqual({ exists: false })
})

it('maps a handler failure to a relay.error frame and rejects the client with that ServiceError', async () => {
  const root = await tempRoot('teams-local-message-handler-error-')
  const socketPath = join(root, 'message.sock')
  const server = await startServer({
    socketPath,
    handle: () => {
      throw new LocalMessageSocketError({ code: 'FORBIDDEN', message: 'only an admin may invite' })
    },
  })

  const wire = await rawExchange(socketPath, `${JSON.stringify(listRequest('r-wire'))}\n`)
  expect(wire).toMatchObject({
    kind: 'relay.error', requestId: 'r-wire',
    error: { code: 'FORBIDDEN', message: 'only an admin may invite' },
  })

  await expect(sendLocalMessageRequest({ socketPath, request: listRequest('r-client'), timeoutMs: 1_000 }))
    .rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'only an admin may invite',
      serviceError: { code: 'FORBIDDEN', message: 'only an admin may invite' },
    })

  await server.close()
  expect(await socketState(socketPath)).toEqual({ exists: false })
})

it('fails the client explicitly when the handler does not answer before the deadline', async () => {
  const root = await tempRoot('teams-local-message-timeout-')
  const socketPath = join(root, 'message.sock')
  let release = (): void => undefined
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  let handled = false
  const server = await startServer({
    socketPath,
    handle: async request => {
      handled = true
      await gate
      return { kind: 'group.list', requestId: request.requestId, groups: [] }
    },
  })

  await expect(sendLocalMessageRequest({ socketPath, request: listRequest('r-slow'), timeoutMs: 30 }))
    .rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
      serviceError: { code: 'RESULT_UNKNOWN' },
    })
  expect(handled).toBe(true)

  release()
  await server.close()
  expect(await socketState(socketPath)).toEqual({ exists: false })
})

it('removes only its own socket on close and makes close idempotent', async () => {
  const root = await tempRoot('teams-local-message-close-')
  const socketPath = join(root, '.state', 'message.sock')
  const server = await startServer({
    socketPath,
    handle: request => ({ kind: 'group.list', requestId: request.requestId, groups: [] }),
  })

  expect(await socketState(socketPath)).toMatchObject({ exists: true, isSocket: true })
  await server.close()
  await server.close()
  expect(await socketState(socketPath)).toEqual({ exists: false })
})

it('refuses to replace an existing regular file at the socket path', async () => {
  const root = await tempRoot('teams-local-message-regular-file-')
  const socketPath = join(root, 'message.sock')
  await writeFile(socketPath, 'owned-by-another\n', { mode: 0o600 })

  await expect(startServer({
    socketPath,
    handle: request => ({ kind: 'group.list', requestId: request.requestId, groups: [] }),
  })).rejects.toMatchObject({ code: 'CONFLICT' })

  expect(await readFile(socketPath, 'utf8')).toBe('owned-by-another\n')
  expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
})

it('does not disturb a live server already listening on the socket path', async () => {
  const root = await tempRoot('teams-local-message-live-')
  const socketPath = join(root, 'message.sock')
  const owner = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    owner.once('error', rejectListen)
    owner.listen(socketPath, () => resolveListen())
  })

  try {
    await expect(startServer({
      socketPath,
      handle: request => ({ kind: 'group.list', requestId: request.requestId, groups: [] }),
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(owner.listening).toBe(true)
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      owner.close(error => error === undefined ? resolveClose() : rejectClose(error))
    })
  }
  await rm(socketPath, { force: true })
})

it('reclaims a stale socket left by a crashed server', async () => {
  const root = await tempRoot('teams-local-message-stale-')
  const socketPath = join(root, 'message.sock')
  const script = [
    "const { createServer } = require('node:net')",
    'const server = createServer()',
    `server.listen(${JSON.stringify(socketPath)}, () => process.exit(0))`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', code => code === 0 ? resolveExit() : rejectExit(new Error(`stale socket child exited with ${code}`)))
  })
  expect(await socketState(socketPath)).toMatchObject({ exists: true, isSocket: true })

  const server = await startServer({
    socketPath,
    handle: request => ({ kind: 'group.list', requestId: request.requestId, groups: [] }),
  })
  const reply = await sendLocalMessageRequest({ socketPath, request: listRequest('r-stale'), timeoutMs: 1_000 })
  expect(reply).toEqual({ kind: 'group.list', requestId: 'r-stale', groups: [] })

  await server.close()
  expect(await socketState(socketPath)).toEqual({ exists: false })
})
