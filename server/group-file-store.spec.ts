import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Action, ExternalOp, Group, IssueSession, Message } from '../control-protocol/group-wire.ts'
import type { IssueSessionOperation } from './issue-session.ts'
import { createGroupFileStore } from './group-file-store.ts'
import { createGroupHub, type GroupHubSnapshot } from './group-hub.ts'
import { restoreMessageLog } from './message-log.ts'

const directories: string[] = []

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'group-file-store-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const group: Group = {
  groupId: 'g1',
  name: 'pair',
  ownerAgentId: 'agent-a',
  createdAt: '2026-10-22T00:00:00.000Z',
  members: [
    { agentId: 'agent-a', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-22T00:00:00.000Z' }] },
    { agentId: 'agent-b', role: 'peer', mastersOf: [], intervals: [{ joinedAt: '2026-10-22T00:00:00.000Z' }] },
  ],
}

const session: IssueSession = {
  sessionId: 's1',
  groupId: 'g1',
  vikunjaProjectId: 'p1',
  vikunjaIssueId: '42',
  initiatorAgentId: 'agent-a',
  state: 'open',
  openedAt: '2026-10-22T00:00:00.000Z',
  lastOpSeq: 1,
}

const operation: IssueSessionOperation = {
  opId: 'op-close',
  commitId: 'c-close',
  sessionId: 's1',
  kind: 'close',
  state: 'unknown',
  targetState: 'closed',
  opSeq: 1,
  reason: 'done',
  conclusion: 'shipped',
  createdAt: '2026-10-22T00:01:00.000Z',
  updatedAt: '2026-10-22T00:01:00.000Z',
}

const action: Action = {
  actionId: 'a1',
  commitId: 'c-action',
  sessionId: 's1',
  initiatorAgentId: 'agent-a',
  assigneeAgentId: 'agent-b',
  kind: 'review',
  reason: 'look',
  expectedResult: 'a review',
  replyRequired: false,
  state: 'accepted',
  createdAt: '2026-10-22T00:02:00.000Z',
}

function message(sequence: number): Message {
  return {
    messageId: `m${sequence}`,
    commitId: `mc${sequence}`,
    sequence,
    groupId: 'g1',
    fromAgentId: 'agent-a',
    targetAgentIds: ['agent-b'],
    replyRequired: false,
    body: `body ${sequence}`,
    sentAt: `2026-10-22T00:0${sequence}:00.000Z`,
  }
}

const createOp: ExternalOp = {
  opId: 'op-create',
  commitId: 'commit-create',
  kind: 'issue.create',
  state: 'confirmed',
  ownerAgentId: 'agent-a',
  params: { groupId: 'g1', commitId: 'commit-create', vikunjaProjectId: 'p1', title: 't' },
  result: { issueId: '42' },
  updatedAt: '2026-10-22T00:03:00.000Z',
}

const closeOp: ExternalOp = {
  opId: 'op-close',
  commitId: 'c-close',
  kind: 'issue.close',
  state: 'unknown',
  ownerAgentId: 'agent-a',
  opSeq: 1,
  params: { sessionId: 's1', commitId: 'c-close', vikunjaIssueId: '42' },
  updatedAt: '2026-10-22T00:04:00.000Z',
}

function snapshot(messages: readonly Message[]): GroupHubSnapshot {
  return {
    groups: [group],
    invitations: [{ groupId: 'g1', agentId: 'agent-b', role: 'peer', mastersOf: ['agent-b'], invitedByAgentId: 'agent-a', state: 'accepted', createdAt: '2026-10-22T00:00:00.000Z' }],
    sessions: [session],
    operations: [operation],
    actions: [action],
    logs: [{
      groupId: 'g1',
      messages,
      revision: messages.length + 1,
      retentionStartSequence: 1,
      watermarks: [{ agentId: 'agent-b', groupId: 'g1', upToSequence: messages.at(-1)?.sequence ?? 1, updatedAt: '2026-10-22T00:05:00.000Z' }],
    }],
    ops: [createOp, closeOp],
  }
}

describe('group file store', () => {
  it('writes one directory per account and scope and reloads the whole snapshot', () => {
    const directory = workspace()
    const store = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    expect(store.load()).toBeUndefined()
    store.save(snapshot([message(1), message(2)]))
    const root = join(directory, 'groups', 'acct', 'scope')
    expect(readdirSync(root).sort()).toEqual(['g1', 'groups.json'])
    const groupRoot = join(root, 'g1')
    expect(readdirSync(groupRoot).sort()).toEqual(['actions.json', 'external-ops.json', 'log.json', 'messages.jsonl', 'sessions.json', 'watermarks'])
    const loaded = store.load()
    expect(loaded?.groups).toEqual([group])
    expect(loaded?.sessions).toEqual([session])
    expect(loaded?.operations).toEqual([operation])
    expect(loaded?.actions).toEqual([action])
    expect(loaded?.logs[0]?.messages).toEqual([message(1), message(2)])
    expect(loaded?.logs[0]?.watermarks).toEqual([{ agentId: 'agent-b', groupId: 'g1', upToSequence: 2, updatedAt: '2026-10-22T00:05:00.000Z' }])
    // A create op carries its group; a close op is attributed through its session.
    expect(loaded?.ops.map(op => op.opId).sort()).toEqual(['op-close', 'op-create'])
    // A fresh instance reads the same truth, so a restart recovers it.
    const reopened = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    expect(reopened.load()?.sessions).toEqual([session])
  })

  it('appends only new messages and never rewrites an earlier record', () => {
    const directory = workspace()
    const store = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    store.save(snapshot([message(1)]))
    const path = join(directory, 'groups', 'acct', 'scope', 'g1', 'messages.jsonl')
    const first = readFileSync(path, 'utf8')
    store.save(snapshot([message(1), message(2)]))
    const second = readFileSync(path, 'utf8')
    expect(second.startsWith(first)).toBe(true)
    expect(second.trimEnd().split('\n')).toHaveLength(2)
    // Saving the same snapshot twice must not duplicate a record.
    store.save(snapshot([message(1), message(2)]))
    expect(readFileSync(path, 'utf8')).toBe(second)
  })

  it('drops a watermark file that is no longer in the snapshot', () => {
    const directory = workspace()
    const store = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    store.save(snapshot([message(1)]))
    const watermarks = join(directory, 'groups', 'acct', 'scope', 'g1', 'watermarks')
    expect(readdirSync(watermarks)).toEqual(['agent-b.json'])
    const without = snapshot([message(1)])
    store.save({ ...without, logs: [{ ...without.logs[0]!, watermarks: [] }] })
    expect(readdirSync(watermarks)).toEqual([])
    expect(store.load()?.logs[0]?.watermarks).toEqual([])
  })

  it('keeps an op with no attributable group instead of dropping it', () => {
    const directory = workspace()
    const store = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    const orphan: ExternalOp = { ...createOp, opId: 'op-lost', params: { commitId: 'nobody' } }
    const base = snapshot([message(1)])
    store.save({ ...base, ops: [...base.ops, orphan] })
    expect(store.load()?.ops.map(op => op.opId).sort()).toEqual(['op-close', 'op-create', 'op-lost'])
    expect(readdirSync(join(directory, 'groups', 'acct', 'scope')).includes('orphan-ops.json')).toBe(true)
  })

  it('repairs a crash-truncated tail so the next append stays on a record boundary', () => {
    const directory = workspace()
    const store = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    store.save(snapshot([message(1), message(2)]))
    const path = join(directory, 'groups', 'acct', 'scope', 'g1', 'messages.jsonl')
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"messageId":"m3"`)
    const loaded = store.load()
    expect(loaded?.logs[0]?.messages.map(entry => entry.messageId)).toEqual(['m1', 'm2'])
    // The partial line is gone from the file, not only from memory.
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
    // Appending after the repair must not merge into the dropped bytes.
    store.save(snapshot([message(1), message(2), message(3)]))
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(3)
    expect(createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' }).load()?.logs[0]?.messages.map(entry => entry.messageId))
      .toEqual(['m1', 'm2', 'm3'])
    // The repair is recorded rather than silent.
    expect(JSON.parse(readFileSync(join(directory, 'groups', 'acct', 'scope', 'g1', 'log.json'), 'utf8'))).toMatchObject({ repairedTails: 1 })
    // One record appended to a truncated tail cannot be lost.
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"messageId":"m4"`)
    const again = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' }).load()
    expect(again?.logs[0]?.messages.map(entry => entry.messageId)).toEqual(['m1', 'm2', 'm3'])
  })

  it('keeps a trimmed log trimmed across a restart and lets the hub start', async () => {
    const directory = workspace()
    const store = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    store.save(snapshot([message(1), message(2), message(3)]))
    const trimmed = snapshot([message(1), message(2), message(3)])
    store.save({ ...trimmed, logs: [{ ...trimmed.logs[0]!, messages: [message(2), message(3)], retentionStartSequence: 2 }] })
    // The exact state a crash before the rewrite leaves: the retention start is
    // already past record 1 while the file still holds it.
    const groupRoot = join(directory, 'groups', 'acct', 'scope', 'g1')
    writeFileSync(join(groupRoot, 'log.json'), `${JSON.stringify({ version: 1, retentionStartSequence: 2 })}\n`)
    writeFileSync(join(groupRoot, 'messages.jsonl'), `${[message(1), message(2), message(3)].map(entry => JSON.stringify(entry)).join('\n')}\n`)
    const reopened = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    const loaded = reopened.load()
    // The trimmed record does not come back from the file.
    expect(loaded?.logs[0]?.messages.map(entry => entry.messageId)).toEqual(['m2', 'm3'])
    expect(loaded?.logs[0]?.retentionStartSequence).toBe(2)
    expect(readFileSync(join(directory, 'groups', 'acct', 'scope', 'g1', 'messages.jsonl'), 'utf8').trimEnd().split('\n')).toHaveLength(2)
    // A hub built from this snapshot starts, and the gap stays explicit: the
    // watermark that predates the retained window is reported, not silently moved.
    const hub = createGroupHub({ store: reopened, isOnline: () => true, now: () => new Date('2026-10-22T00:00:00.000Z'), idFactory: () => 'id-1' })
    const page = await hub.handle({ agentId: 'agent-a', accountId: 'acct', scopeId: 'scope' }, { kind: 'message.page', requestId: 'p1', groupId: 'g1' })
    if (!page.ok) throw new Error(page.error.message)
    expect(() => restoreMessageLog({
      groupId: 'g1',
      messages: loaded?.logs[0]?.messages ?? [],
      retentionStartSequence: loaded?.logs[0]?.retentionStartSequence,
      watermarks: loaded?.logs[0]?.watermarks ?? [],
    })).not.toThrow()
  })

  it('appends inside a retained window without rewriting the surviving records', () => {
    const directory = workspace()
    const store = createGroupFileStore({ dataDirectory: directory, accountId: 'acct', scopeId: 'scope' })
    const base = snapshot([message(1), message(2), message(3)])
    store.save({ ...base, logs: [{ ...base.logs[0]!, messages: [message(2), message(3)], retentionStartSequence: 2 }] })
    const path = join(directory, 'groups', 'acct', 'scope', 'g1', 'messages.jsonl')
    const before = readFileSync(path, 'utf8')
    const next = snapshot([message(2), message(3), message(4)])
    store.save({ ...next, logs: [{ ...next.logs[0]!, messages: [message(2), message(3), message(4)], retentionStartSequence: 2 }] })
    const after = readFileSync(path, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.trimEnd().split('\n')).toHaveLength(3)
  })
})
