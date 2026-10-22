import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Action, Group, GroupInvitation, IssueSession, ExternalOp, Message } from '../control-protocol/group-wire.ts'
import type { IssueSessionOperation } from './issue-session.ts'
import {
  appendJsonLine,
  ensureDirectory,
  groupPaths,
  readJsonFile,
  readJsonLines,
  watermarkFile,
  writeJsonFile,
  type GroupPaths,
} from './group-store.ts'
import type { GroupHubSnapshot, GroupHubStore, MessageLogSnapshot } from './group-hub.ts'

/**
 * The hub's persisted truth split by group.
 *
 * One scope keeps one directory per account and scope. `groups.json` holds the
 * registry; each group keeps `sessions.json` (sessions plus open/close intents),
 * `actions.json`, `external-ops.json`, an append-only `messages.jsonl`,
 * `log.json` (the retention start) and one watermark file per agent. The hub is
 * the only writer, so a whole-file write plus rename is safe and the message log
 * only ever appends.
 */

const SCHEMA_VERSION = 1

interface GroupsDocument {
  readonly version: number
  readonly groups: readonly Group[]
  readonly invitations: readonly GroupInvitation[]
}

interface SessionsDocument {
  readonly version: number
  readonly sessions: readonly IssueSession[]
  readonly operations: readonly IssueSessionOperation[]
}

interface ActionsDocument {
  readonly version: number
  readonly actions: readonly Action[]
}

interface OpsDocument {
  readonly version: number
  readonly ops: readonly ExternalOp[]
}

interface LogDocument {
  readonly version: number
  readonly retentionStartSequence: number
}

export interface GroupFileStoreOptions {
  readonly dataDirectory: string
  readonly accountId: string
  readonly scopeId: string
}

function scopeRoot(options: GroupFileStoreOptions): string {
  return join(options.dataDirectory, 'groups', options.accountId, options.scopeId)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`group-file-store: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`group-file-store: ${label} must be an array`)
  return value
}

/**
 * The group a record belongs to. Sessions and actions name their group; an
 * external op names it directly for a create and through its session otherwise.
 */
function groupOfOp(op: ExternalOp, sessionGroups: ReadonlyMap<string, string>): string | undefined {
  const params = typeof op.params === 'object' && op.params !== null && !Array.isArray(op.params)
    ? (op.params as Record<string, unknown>)
    : {}
  if (typeof params.groupId === 'string' && params.groupId.length > 0) return params.groupId
  if (typeof params.sessionId === 'string') return sessionGroups.get(params.sessionId)
  return undefined
}

function readDocument<T>(path: string, label: string): T | undefined {
  const value = readJsonFile<unknown>(path)
  if (value === undefined) return undefined
  record(value, label)
  return value as T
}

function readMessages(paths: GroupPaths): readonly Message[] {
  const read = readJsonLines<Message>(paths.messagesFile)
  // A crash can leave a partial final line. The log owner rejects the same
  // record, so the store does not hide it: only the truncated tail is dropped.
  if (read.truncatedTail) {
    return read.records
  }
  return read.records
}

function readWatermarks(paths: GroupPaths): readonly { readonly agentId: string; readonly groupId: string; readonly upToSequence: number; readonly updatedAt: string }[] {
  if (!existsSync(paths.watermarksDir)) return []
  const watermarks: { agentId: string; groupId: string; upToSequence: number; updatedAt: string }[] = []
  for (const name of readdirSync(paths.watermarksDir)) {
    if (!name.endsWith('.json')) continue
    const value = readJsonFile<unknown>(join(paths.watermarksDir, name))
    if (value === undefined) continue
    const watermark = record(value, `watermark ${name}`)
    if (typeof watermark.agentId !== 'string' || typeof watermark.groupId !== 'string' ||
      typeof watermark.upToSequence !== 'number' || typeof watermark.updatedAt !== 'string') {
      throw new Error(`group-file-store: watermark ${name} is malformed`)
    }
    watermarks.push({ agentId: watermark.agentId, groupId: watermark.groupId, upToSequence: watermark.upToSequence, updatedAt: watermark.updatedAt })
  }
  return watermarks
}

export function createGroupFileStore(options: GroupFileStoreOptions): GroupHubStore {
  const root = scopeRoot(options)
  const groupsFile = join(root, 'groups.json')
  const orphanOpsFile = join(root, 'orphan-ops.json')
  // The highest message sequence already appended per group, so a save never
  // rewrites or renumbers an earlier record.
  let appended: Map<string, number> | undefined

  const load = (): GroupHubSnapshot | undefined => {
    const document = readDocument<GroupsDocument>(groupsFile, 'groups')
    if (document === undefined) return undefined
    const groups = list(document.groups, 'groups') as readonly Group[]
    const invitations = list(document.invitations, 'invitations') as readonly GroupInvitation[]
    const sessions: IssueSession[] = []
    const operations: IssueSessionOperation[] = []
    const actions: Action[] = []
    const logs: MessageLogSnapshot[] = []
    const ops: ExternalOp[] = []
    const sessionGroups = new Map<string, string>()
    for (const group of groups) {
      const paths = groupPaths(options.dataDirectory, options.accountId, options.scopeId, group.groupId)
      const sessionDocument = readDocument<SessionsDocument>(paths.sessionsFile, `sessions ${group.groupId}`)
      if (sessionDocument !== undefined) {
        for (const session of list(sessionDocument.sessions, 'sessions') as readonly IssueSession[]) {
          sessions.push(session)
          sessionGroups.set(session.sessionId, session.groupId)
        }
        operations.push(...list(sessionDocument.operations, 'operations') as readonly IssueSessionOperation[])
      }
      const actionDocument = readDocument<ActionsDocument>(paths.actionsFile, `actions ${group.groupId}`)
      if (actionDocument !== undefined) actions.push(...list(actionDocument.actions, 'actions') as readonly Action[])
      const opDocument = readDocument<OpsDocument>(paths.externalOpsFile, `external ops ${group.groupId}`)
      if (opDocument !== undefined) ops.push(...list(opDocument.ops, 'external ops') as readonly ExternalOp[])
      const logDocument = readDocument<LogDocument>(join(paths.root, 'log.json'), `log ${group.groupId}`)
      const messages = readMessages(paths)
      logs.push({
        groupId: group.groupId,
        messages,
        revision: messages.length + 1,
        retentionStartSequence: logDocument?.retentionStartSequence ?? 1,
        watermarks: readWatermarks(paths),
      })
    }
    const orphanDocument = readDocument<OpsDocument>(orphanOpsFile, 'orphan ops')
    if (orphanDocument !== undefined) ops.push(...list(orphanDocument.ops, 'orphan ops') as readonly ExternalOp[])
    appended = new Map(logs.map(log => {
      const last = log.messages.reduce((max, message) => Math.max(max, message.sequence), 0)
      return [log.groupId, last] as const
    }))
    return { groups, invitations, sessions, operations, actions, logs, ops }
  }

  const save = (snapshot: GroupHubSnapshot): void => {
    ensureDirectory(root)
    writeJsonFile(groupsFile, { version: SCHEMA_VERSION, groups: snapshot.groups, invitations: snapshot.invitations } satisfies GroupsDocument)
    const sessionGroups = new Map(snapshot.sessions.map(session => [session.sessionId, session.groupId] as const))
    const written = appended ?? new Map<string, number>()
    const present = new Set(snapshot.groups.map(group => group.groupId))
    const orphans = snapshot.ops.filter(op => {
      const groupId = groupOfOp(op, sessionGroups)
      return groupId === undefined || !present.has(groupId)
    })
    for (const group of snapshot.groups) {
      const paths = groupPaths(options.dataDirectory, options.accountId, options.scopeId, group.groupId)
      writeJsonFile(paths.sessionsFile, {
        version: SCHEMA_VERSION,
        sessions: snapshot.sessions.filter(session => session.groupId === group.groupId),
        operations: snapshot.operations.filter(operation => sessionGroups.get(operation.sessionId) === group.groupId),
      } satisfies SessionsDocument)
      writeJsonFile(paths.actionsFile, {
        version: SCHEMA_VERSION,
        actions: snapshot.actions.filter(action => sessionGroups.get(action.sessionId) === group.groupId),
      } satisfies ActionsDocument)
      writeJsonFile(paths.externalOpsFile, {
        version: SCHEMA_VERSION,
        ops: snapshot.ops.filter(op => groupOfOp(op, sessionGroups) === group.groupId),
      } satisfies OpsDocument)
      const state = snapshot.logs.find(log => log.groupId === group.groupId)
      if (state !== undefined) {
        writeJsonFile(join(paths.root, 'log.json'), { version: SCHEMA_VERSION, retentionStartSequence: state.retentionStartSequence } satisfies LogDocument)
        const last = written.get(group.groupId) ?? 0
        for (const message of state.messages) {
          if (message.sequence > last) appendJsonLine(paths.messagesFile, message)
        }
        written.set(group.groupId, state.messages.reduce((max, message) => Math.max(max, message.sequence), last))
        const expected = new Set<string>()
        for (const watermark of state.watermarks) {
          const path = watermarkFile(paths, watermark.agentId)
          expected.add(path)
          writeJsonFile(path, watermark)
        }
        // A dropped watermark must not come back on the next load.
        if (existsSync(paths.watermarksDir)) {
          for (const name of readdirSync(paths.watermarksDir)) {
            if (!name.endsWith('.json')) continue
            const path = join(paths.watermarksDir, name)
            if (!expected.has(path)) rmSync(path)
          }
        }
      }
    }
    if (orphans.length === 0) {
      if (existsSync(orphanOpsFile)) rmSync(orphanOpsFile)
    } else {
      writeJsonFile(orphanOpsFile, { version: SCHEMA_VERSION, ops: orphans } satisfies OpsDocument)
    }
    appended = written
  }

  return { load, save }
}
