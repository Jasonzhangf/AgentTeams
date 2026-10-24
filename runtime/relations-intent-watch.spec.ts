import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../packages/shared/src/agent-services.ts'
import type { PeerIntent } from '../config/daemon-intent.ts'
import { relationsIntentScopePath, readRelationsIntentRecord, writeRelationsIntentRecord } from '../config/relations-intent-store.ts'
import { agentRelationsIntentPath, buildQuickStartAgentIntent, createRelationsIntentWatch } from './acp-serve.ts'
import type { ServeEgressOwner, ServeEgressRow } from './serve-egress.ts'

/**
 * The agent daemon reacts to the durable desired-relations record the control
 * daemon writes. These cases bind the watch's own decisions — which declared peer
 * it dials, which live row it drops, which desired agent it refuses — against the
 * real record store (`config/relations-intent-store.ts`) as the writer.
 *
 * The real end-to-end path (a Console command on a live control daemon that makes
 * a live agent daemon dial) is the black box, not this spec.
 */

const ACCOUNT = 'local'
const SCOPE = 'local'
const HOME = '/tmp/relations-intent-home'

const PEERS: Readonly<Record<string, PeerIntent>> = {
  alpha: {
    agentId: 'agent-alpha',
    hostId: 'host-alpha',
    accountId: ACCOUNT,
    scopeId: SCOPE,
    endpoint: 'wss://127.0.0.1:1/acp',
    credentialRef: 'env:WATCH_ALPHA_CREDENTIAL',
  },
  beta: {
    agentId: 'agent-beta',
    hostId: 'host-beta',
    accountId: ACCOUNT,
    scopeId: SCOPE,
    endpoint: 'wss://127.0.0.1:2/acp',
    credentialRef: 'env:WATCH_BETA_CREDENTIAL',
  },
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined)
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'relations-intent-watch-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}

/**
 * The live-relation surface the watch drives, recorded per call. `seed` marks the
 * peers the start path already dialed, so a removal is observable.
 */
function recordingOwner(seed: readonly string[] = []): {
  readonly owner: Pick<ServeEgressOwner, 'connect' | 'disconnect' | 'list'>
  readonly connects: string[]
  readonly disconnects: string[]
} {
  const rows = new Map<string, ServeEgressRow>()
  const connects: string[] = []
  const disconnects: string[] = []
  const rowFor = (peerName: string): ServeEgressRow => {
    const peer: AuthenticatedAgent = { accountId: ACCOUNT, scopeId: SCOPE, agentId: PEERS[peerName]?.agentId ?? peerName }
    return { peerName, agentId: peer.agentId, connectionId: `conn-${peerName}`, peer, role: 'peer', state: 'ready' }
  }
  for (const peerName of seed) rows.set(rowFor(peerName).agentId, rowFor(peerName))
  return {
    connects,
    disconnects,
    owner: {
      connect: async (peerName: string): Promise<ServeEgressRow> => {
        connects.push(peerName)
        const row = rowFor(peerName)
        rows.set(row.agentId, row)
        return row
      },
      disconnect: async (agentId: string): Promise<void> => {
        disconnects.push(agentId)
        rows.delete(agentId)
      },
      list: () => [...rows.values()],
    },
  }
}

/** The real store writes the record; the watch is the only reader under test. */
async function writeRecord(path: string, peers: ReadonlyArray<{ agentId: string; role: 'master' | 'peer' }>): Promise<void> {
  // The accepted revision is the CAS base, exactly as the control daemon supplies it.
  const current = await readRelationsIntentRecord(path)
  const result = await writeRelationsIntentRecord(path, current?.revision ?? 0, { op: 'replace', peers: [...peers] })
  expect(result.status).toBe('applied')
}

describe('the agent daemon desired-relations watch', () => {
  it('dials a declared peer only once the record desires it, and stays idempotent', async () => {
    const path = join(await temporaryDirectory(), 'relations-intent.json')
    const { owner, connects, disconnects } = recordingOwner()
    const watch = createRelationsIntentWatch({ owner, recordPath: path, peers: PEERS })

    // No record yet: the start behaviour stands and nothing is dialed or dropped.
    await watch.reconcile()
    expect(connects).toEqual([])
    expect(disconnects).toEqual([])
    expect(watch.failures()).toEqual([])

    await writeRecord(path, [{ agentId: 'agent-alpha', role: 'peer' }])
    await watch.reconcile()
    expect(connects).toEqual(['alpha'])
    expect(disconnects).toEqual([])

    // The live row already satisfies the record, so the next pass dials nothing.
    await watch.reconcile()
    expect(connects).toEqual(['alpha'])
    expect(watch.failures()).toEqual([])
  })

  it('disconnects a live peer the record no longer desires', async () => {
    const path = join(await temporaryDirectory(), 'relations-intent.json')
    const { owner, connects, disconnects } = recordingOwner(['alpha', 'beta'])
    const watch = createRelationsIntentWatch({ owner, recordPath: path, peers: PEERS })

    await writeRecord(path, [{ agentId: 'agent-alpha', role: 'master' }])
    await watch.reconcile()
    expect(connects).toEqual([])
    expect(disconnects).toEqual(['agent-beta'])
    expect(owner.list().map(row => row.agentId)).toEqual(['agent-alpha'])
  })

  it('dials a declared peer again after the record drops it and then wants it', async () => {
    const path = join(await temporaryDirectory(), 'relations-intent.json')
    const { owner, connects, disconnects } = recordingOwner()
    const watch = createRelationsIntentWatch({ owner, recordPath: path, peers: PEERS })

    await writeRecord(path, [{ agentId: 'agent-alpha', role: 'peer' }])
    await watch.reconcile()
    await writeRecord(path, [])
    await watch.reconcile()
    await writeRecord(path, [{ agentId: 'agent-alpha', role: 'peer' }])
    await watch.reconcile()

    expect(connects).toEqual(['alpha', 'alpha'])
    expect(disconnects).toEqual(['agent-alpha'])
  })

  it('never dials an agent the accepted intent does not declare', async () => {
    const path = join(await temporaryDirectory(), 'relations-intent.json')
    const { owner, connects } = recordingOwner()
    const watch = createRelationsIntentWatch({ owner, recordPath: path, peers: PEERS })

    await writeRecord(path, [{ agentId: 'agent-ghost', role: 'peer' }])
    await watch.reconcile()

    expect(connects).toEqual([])
    expect(owner.list()).toEqual([])
    expect(watch.failures()).toHaveLength(1)
    expect(watch.failures()[0]).toMatchObject({ agentId: 'agent-ghost', code: 'FORBIDDEN' })
    expect(watch.failures()[0]?.message).toContain('does not declare')
  })

  it('records one repeated refusal once instead of growing every poll', async () => {
    const path = join(await temporaryDirectory(), 'relations-intent.json')
    const { owner } = recordingOwner()
    const watch = createRelationsIntentWatch({ owner, recordPath: path, peers: PEERS })

    await writeRecord(path, [{ agentId: 'agent-ghost', role: 'peer' }])
    await watch.reconcile()
    await watch.reconcile()
    await watch.reconcile()

    expect(watch.failures()).toHaveLength(1)
  })

  it('keeps the live rows and does not throw on a broken record', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'relations-intent.json')
    const { owner, connects, disconnects } = recordingOwner(['alpha'])
    const watch = createRelationsIntentWatch({ owner, recordPath: path, peers: PEERS })

    await writeFile(path, '{ "version": 1, "revision": ')
    await expect(watch.reconcile()).resolves.toBeUndefined()

    expect(owner.list().map(row => row.agentId)).toEqual(['agent-alpha'])
    expect(connects).toEqual([])
    expect(disconnects).toEqual([])
    expect(watch.failures()).toHaveLength(1)
    expect(watch.failures()[0]?.message.length).toBeGreaterThan(0)
  })

  it('refuses a record whose desired role is not a frozen relation role', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'relations-intent.json')
    const { owner, connects } = recordingOwner()
    const watch = createRelationsIntentWatch({ owner, recordPath: path, peers: PEERS })

    await writeFile(path, JSON.stringify({
      version: 1,
      revision: 1,
      peers: [{ agentId: 'agent-alpha', role: 'slave' }],
      updatedAt: new Date().toISOString(),
    }))
    await watch.reconcile()

    expect(connects).toEqual([])
    expect(watch.failures()).toHaveLength(1)
  })

  it('derives the shared record path from the daemon own account and scope', () => {
    const intent = buildQuickStartAgentIntent({ engine: 'opencode', ip: '127.0.0.1', port: 7421, home: HOME })

    expect(agentRelationsIntentPath(HOME, intent.daemon))
      .toBe(join(HOME, '.agentteams', 'relations', ACCOUNT, SCOPE, 'relations-intent.json'))
    expect(agentRelationsIntentPath(HOME, intent.daemon))
      .toBe(relationsIntentScopePath({ home: HOME, accountId: intent.daemon.accountId, scopeId: intent.daemon.scopeId }))
  })
})
