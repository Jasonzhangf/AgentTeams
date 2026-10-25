import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PeerIntent } from '../config/daemon-intent.ts'
import {
  localGroupEndpointScopePath,
  removeLocalGroupEndpointRecord,
  writeLocalGroupEndpointRecord,
} from '../config/local-group-endpoint-store.ts'
import { mkdir } from 'node:fs/promises'
import { createControlGroupForwarder } from './control-process.ts'
import { startLocalMessageSocket, type LocalMessageSocketServer } from './local-message-socket.ts'
import type { GroupWireReply, GroupWireRequest } from '../packages/shared/src/group-wire.ts'

/**
 * The control daemon's one group hop, against real local sockets and real record files.
 *
 * The group owner here is a real `startLocalMessageSocket` server, so these cases bind the
 * transport facts the Console depends on: a reply travels back verbatim, an owner refusal keeps
 * its own code, a published-but-silent endpoint is `unreachable`, and an undeclared agent is a
 * bad input rather than a missing endpoint. Group business semantics stay in the hub and are
 * out of this spec.
 */

const PEER: PeerIntent = {
  agentId: 'agent-alpha',
  hostId: 'host-1',
  accountId: 'local',
  scopeId: 'local',
  credentialRef: 'credential-1',
}

const roots: string[] = []
const servers: LocalMessageSocketServer[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close().catch(() => undefined)
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function root(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'control-group-'))
  roots.push(home)
  return home
}

function endpointPath(home: string): string {
  return localGroupEndpointScopePath({ home, accountId: 'local', scopeId: 'local', agentId: PEER.agentId })
}

async function publish(home: string, socketPath: string): Promise<void> {
  const result = await writeLocalGroupEndpointRecord(endpointPath(home), 0, {
    agentId: PEER.agentId,
    groupEndpoint: { kind: 'local-socket', socketPath },
  })
  expect(result.status).toBe('applied')
}

async function serve(socketPath: string, handler: (request: GroupWireRequest) => GroupWireReply | Promise<GroupWireReply>): Promise<LocalMessageSocketServer> {
  const server = await startLocalMessageSocket({ socketPath, handler })
  servers.push(server)
  return server
}

function forwarder(home: string, timeoutMs?: number) {
  return createControlGroupForwarder({
    peers: { [PEER.agentId]: PEER },
    home,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

const REQUEST: GroupWireRequest = { kind: 'group.list', requestId: 'req-1' }

describe('control group forwarder', () => {
  it('forwards the closed frame over the real socket and returns the owner reply verbatim', async () => {
    const home = await root()
    const socketPath = join(home, 'agent-messaging.sock')
    const seen: GroupWireRequest[] = []
    const reply: GroupWireReply = { kind: 'group.list', requestId: 'req-1', groups: [] }
    await serve(socketPath, request => { seen.push(request); return reply })
    await publish(home, socketPath)

    const outcome = await forwarder(home).forward({ agentId: PEER.agentId, request: REQUEST })

    expect(outcome).toEqual({ outcome: 'reply', reply })
    expect(seen).toEqual([REQUEST])
  })

  it('keeps the group owner own code and message for a relay.error reply', async () => {
    const home = await root()
    const socketPath = join(home, 'agent-messaging.sock')
    await serve(socketPath, () => ({
      kind: 'relay.error',
      requestId: 'req-1',
      error: { code: 'FORBIDDEN', message: 'agent-alpha is not an active member of the group' },
    }))
    await publish(home, socketPath)

    const outcome = await forwarder(home).forward({ agentId: PEER.agentId, request: REQUEST })

    expect(outcome).toEqual({
      outcome: 'owner-error',
      error: { code: 'FORBIDDEN', message: 'agent-alpha is not an active member of the group' },
    })
  })

  it('reports a declared peer with no published endpoint as not-configured', async () => {
    const home = await root()
    const outcome = await forwarder(home).forward({ agentId: PEER.agentId, request: REQUEST })
    expect(outcome).toEqual({
      outcome: 'not-configured',
      message: `agent ${PEER.agentId} has published no local group endpoint, so its group surface is not reachable from this control daemon`,
    })
  })

  it('reports an agent this daemon does not declare as a bad target, not as a missing endpoint', async () => {
    const home = await root()
    const outcome = await forwarder(home).forward({ agentId: 'agent-zeta', request: REQUEST })
    expect(outcome).toEqual({
      outcome: 'invalid-target',
      message: "agentId agent-zeta is not declared by this control daemon's accepted peers",
    })
  })

  it('reports a published endpoint with no listener as unreachable without retrying', async () => {
    const home = await root()
    const socketPath = join(home, 'released.sock')
    await serve(socketPath, () => ({ kind: 'group.list', requestId: 'req-1', groups: [] }))
    await publish(home, socketPath)
    // The socket is gone but the record still names it: the endpoint is published and silent.
    await servers.pop()!.close()

    const outcome = await forwarder(home).forward({ agentId: PEER.agentId, request: REQUEST })

    expect(outcome.outcome).toBe('unreachable')
    expect(outcome.outcome === 'unreachable' ? outcome.error.code : undefined).toBe('GROUP_ENDPOINT_UNREACHABLE')
  })

  it('reports a silent owner as unreachable and keeps the do-not-replay message', async () => {
    const home = await root()
    const socketPath = join(home, 'silent.sock')
    // The owner answers far later than the forwarder's own deadline, so the forwarder sees a
    // real timeout while the socket still closes cleanly in teardown.
    await serve(socketPath, async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return { kind: 'group.list', requestId: 'req-1', groups: [] }
    })
    await publish(home, socketPath)

    const outcome = await forwarder(home, 40).forward({ agentId: PEER.agentId, request: REQUEST })

    expect(outcome.outcome).toBe('unreachable')
    expect(outcome.outcome === 'unreachable' ? outcome.error.code : undefined).toBe('GROUP_ENDPOINT_UNREACHABLE')
    expect(outcome.outcome === 'unreachable' ? outcome.error.message : '').toContain('timed out')
  })

  it('reports a broken published record as an unusable endpoint instead of guessing one', async () => {
    const home = await root()
    const path = endpointPath(home)
    await mkdir(join(home, '.agentteams', 'sessions', 'local', 'local', PEER.agentId), { recursive: true })
    await writeFile(path, '{"version":1,"agentId":"agent-alpha","revision":1,"updatedAt":"t","groupEndpoint":{"kind":"local-socket","socketPath":"relative.sock"}}', 'utf8')

    const outcome = await forwarder(home).forward({ agentId: PEER.agentId, request: REQUEST })

    expect(outcome.outcome).toBe('unreachable')
    expect(outcome.outcome === 'unreachable' ? outcome.error.code : undefined).toBe('GROUP_ENDPOINT_UNREACHABLE')
    expect(outcome.outcome === 'unreachable' ? outcome.error.message : '').toContain('not usable')
  })

  it('reads not-configured again once the agent withdraws its endpoint on stop', async () => {
    const home = await root()
    const socketPath = join(home, 'agent-messaging.sock')
    await serve(socketPath, () => ({ kind: 'group.list', requestId: 'req-1', groups: [] }))
    await publish(home, socketPath)
    expect((await forwarder(home).forward({ agentId: PEER.agentId, request: REQUEST })).outcome).toBe('reply')

    await removeLocalGroupEndpointRecord(endpointPath(home))
    expect((await forwarder(home).forward({ agentId: PEER.agentId, request: REQUEST })).outcome).toBe('not-configured')
  })
})
