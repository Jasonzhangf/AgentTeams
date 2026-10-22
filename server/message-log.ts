import type { Message, MessageWatermark } from '../control-protocol/group-wire.ts'
import { parseGroupMessage } from '../control-protocol/group-wire.ts'

/**
 * Append-only group message log for the group messaging increment.
 *
 * The log assigns the group sequence, deduplicates by `commitId`, keeps one
 * forward-only watermark per member, and reports a retention gap explicitly.
 * Duplicates return the original record; a conflicting body under the same
 * commit or a sequence rollback is an error, never a silent overwrite.
 */

export const DEFAULT_MESSAGE_PAGE_LIMIT = 100

export interface MessageLogState {
  readonly groupId: string
  readonly messages: readonly Message[]
  readonly revision: number
  /** First sequence still retained; everything below it is an explicit gap. */
  readonly retentionStartSequence: number
  readonly watermarks: ReadonlyMap<string, MessageWatermark>
}

export interface AppendMessageInput {
  readonly commitId: string
  readonly groupId: string
  readonly sessionId?: string
  readonly actionId?: string
  readonly fromAgentId: string
  readonly targetAgentIds: readonly string[]
  readonly replyRequired: boolean
  readonly replyRequiredReason?: string
  readonly body: string
  readonly sentAt: string
  readonly inReplyToMessageId?: string
}

export interface MessagePageInput {
  readonly cursor?: number
  readonly limit?: number
}

export interface MessagePage {
  readonly messages: readonly Message[]
  readonly revision: number
  readonly hasMore: boolean
  readonly gapBeforeSequence?: number
}

export interface AdvanceWatermarkInput {
  readonly agentId: string
  readonly upToSequence: number
}

export interface RestoreMessageLogInput {
  readonly groupId: string
  readonly messages: readonly Message[]
  readonly retentionStartSequence?: number
  readonly watermarks?: readonly MessageWatermark[]
}

function fail(message: string): never {
  throw new Error(`message-log: ${message}`)
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return value
}

function requireOrdinal(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`)
  return value
}

function requirePositiveOrdinal(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`)
  return value
}

function timestampOf(value: string, label: string): number {
  requireText(value, label)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) fail(`${label} must be an ISO timestamp`)
  return parsed
}

function lastSequenceOf(state: MessageLogState): number {
  const last = state.messages[state.messages.length - 1]
  return last === undefined ? 0 : last.sequence
}

/** Last sequence ever allocated, including a range trimmed out of retention. */
function tailSequenceOf(state: MessageLogState): number {
  return Math.max(state.retentionStartSequence - 1, lastSequenceOf(state))
}

function sameTargets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(target => rightSet.has(target))
}

function sameAppend(message: Message, input: AppendMessageInput): boolean {
  return message.groupId === input.groupId
    && message.sessionId === input.sessionId
    && message.actionId === input.actionId
    && message.fromAgentId === input.fromAgentId
    && sameTargets(message.targetAgentIds, input.targetAgentIds)
    && message.replyRequired === input.replyRequired
    && message.replyRequiredReason === input.replyRequiredReason
    && message.body === input.body
    && message.inReplyToMessageId === input.inReplyToMessageId
}

function gapFor(state: MessageLogState, cursor: number): number | undefined {
  return cursor < state.retentionStartSequence - 1 ? state.retentionStartSequence : undefined
}

function selectPage(state: MessageLogState, cursor: number, limit: number): MessagePage {
  const remaining = state.messages.filter(message => message.sequence > cursor)
  const messages = remaining.slice(0, limit)
  const gap = gapFor(state, cursor)
  return {
    messages,
    revision: state.revision,
    hasMore: remaining.length > messages.length,
    ...(gap === undefined ? {} : { gapBeforeSequence: gap }),
  }
}

export function createMessageLog(groupId: string): MessageLogState {
  return {
    groupId: requireText(groupId, 'groupId'),
    messages: [],
    revision: 1,
    retentionStartSequence: 1,
    watermarks: new Map(),
  }
}

/**
 * Appends one message and assigns the next sequence. A repeated commit with the
 * same semantic content returns the original record; different content under an
 * existing commit or message id is a conflict.
 */
export function appendMessage(
  state: MessageLogState,
  input: AppendMessageInput,
): { readonly state: MessageLogState; readonly message: Message } {
  const groupId = requireText(input.groupId, 'groupId')
  if (groupId !== state.groupId) fail(`message group ${groupId} does not match log group ${state.groupId}`)
  const commitId = requireText(input.commitId, 'commitId')
  requireText(input.fromAgentId, 'fromAgentId')
  requireText(input.body, 'body')
  timestampOf(input.sentAt, 'sentAt')
  if (!Array.isArray(input.targetAgentIds)) fail('targetAgentIds must be an array')
  for (const target of input.targetAgentIds) requireText(target, 'targetAgentId')
  if (new Set(input.targetAgentIds).size !== input.targetAgentIds.length) fail('targetAgentIds must not repeat an id')
  const existingCommit = state.messages.find(message => message.commitId === commitId)
  if (existingCommit) {
    if (sameAppend(existingCommit, input)) return { state, message: existingCommit }
    fail(`commitId ${commitId} conflicts with an existing message`)
  }
  const messageId = `message:${groupId}:${commitId}`
  if (state.messages.some(message => message.messageId === messageId)) {
    fail(`messageId ${messageId} already exists with a different commit`)
  }
  const message: Message = {
    messageId,
    commitId,
    sequence: tailSequenceOf(state) + 1,
    groupId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
    fromAgentId: input.fromAgentId,
    targetAgentIds: [...input.targetAgentIds],
    replyRequired: input.replyRequired,
    ...(input.replyRequiredReason === undefined ? {} : { replyRequiredReason: input.replyRequiredReason }),
    body: input.body,
    sentAt: input.sentAt,
    ...(input.inReplyToMessageId === undefined ? {} : { inReplyToMessageId: input.inReplyToMessageId }),
  }
  return {
    state: {
      ...state,
      messages: [...state.messages, message],
      revision: state.revision + 1,
    },
    message,
  }
}

/** Returns messages after the cursor and exposes any retention gap before it. */
export function pageMessages(state: MessageLogState, input: MessagePageInput = {}): MessagePage {
  const cursor = input.cursor === undefined ? 0 : requireOrdinal(input.cursor, 'cursor')
  const limit = input.limit === undefined ? DEFAULT_MESSAGE_PAGE_LIMIT : requirePositiveOrdinal(input.limit, 'limit')
  return selectPage(state, cursor, limit)
}

/** Backlog has the same selection rules as a page; it never jumps over a gap silently. */
export function backlogSince(
  state: MessageLogState,
  sinceSequence: number,
  limit: number = DEFAULT_MESSAGE_PAGE_LIMIT,
): MessagePage {
  return pageMessages(state, { cursor: requireOrdinal(sinceSequence, 'sinceSequence'), limit })
}

/** Advances one member watermark. A lower value is rejected, so it can only move forward. */
export function advanceWatermark(
  state: MessageLogState,
  input: AdvanceWatermarkInput,
  now: string,
): MessageLogState {
  const agentId = requireText(input.agentId, 'agentId')
  const upToSequence = requireOrdinal(input.upToSequence, 'upToSequence')
  timestampOf(now, 'now')
  if (upToSequence > tailSequenceOf(state)) fail('watermark cannot pass the last appended sequence')
  const previous = state.watermarks.get(agentId)
  if (previous && upToSequence < previous.upToSequence) {
    fail(`watermark for ${agentId} cannot move backward`)
  }
  const watermarks = new Map(state.watermarks)
  watermarks.set(agentId, {
    agentId,
    groupId: state.groupId,
    upToSequence,
    updatedAt: now,
  })
  return { ...state, watermarks }
}

export function watermarkFor(state: MessageLogState, agentId: string): MessageWatermark | undefined {
  return state.watermarks.get(agentId)
}

/** Unread means retained messages after the member watermark. */
export function unreadCount(state: MessageLogState, agentId: string): number {
  const watermark = state.watermarks.get(agentId)
  const since = watermark === undefined ? 0 : watermark.upToSequence
  return state.messages.filter(message => message.sequence > since).length
}

/**
 * Moves the retention start forward. Watermarks may stay behind it; page and
 * backlog then report the missing range as `gapBeforeSequence`.
 */
export function trimMessages(state: MessageLogState, upToSequence: number): MessageLogState {
  const target = requireOrdinal(upToSequence, 'upToSequence')
  if (target > tailSequenceOf(state)) fail('cannot trim past the last appended sequence')
  const retentionStartSequence = Math.max(state.retentionStartSequence, target + 1)
  if (retentionStartSequence === state.retentionStartSequence) return state
  return {
    ...state,
    messages: state.messages.filter(message => message.sequence >= retentionStartSequence),
    retentionStartSequence,
    revision: state.revision + 1,
  }
}

/**
 * Rebuilds the log from persisted complete records. Sequences must strictly
 * increase, identity keys must be unique, and every record must be inside the
 * declared retention window.
 */
export function restoreMessageLog(input: RestoreMessageLogInput): MessageLogState {
  const groupId = requireText(input.groupId, 'groupId')
  if (!Array.isArray(input.messages)) fail('messages must be an array')
  const retentionStartSequence = input.retentionStartSequence === undefined
    ? 1
    : requirePositiveOrdinal(input.retentionStartSequence, 'retentionStartSequence')
  const messages: Message[] = []
  const messageIds = new Set<string>()
  const commitIds = new Set<string>()
  let previousSequence = 0
  for (const record of input.messages) {
    let message: Message
    try {
      message = parseGroupMessage(record)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'unknown decode failure'
      fail(`invalid message record: ${reason}`)
    }
    if (message.groupId !== groupId) fail(`message ${message.messageId} belongs to another group`)
    if (message.sequence <= previousSequence) fail('message sequences must strictly increase')
    if (message.sequence < retentionStartSequence) fail(`message ${message.messageId} precedes the retention start`)
    if (messageIds.has(message.messageId)) fail(`duplicate messageId ${message.messageId}`)
    if (commitIds.has(message.commitId)) fail(`duplicate commitId ${message.commitId}`)
    messages.push(message)
    messageIds.add(message.messageId)
    commitIds.add(message.commitId)
    previousSequence = message.sequence
  }
  const lastSequence = Math.max(retentionStartSequence - 1, previousSequence)
  const watermarks = new Map<string, MessageWatermark>()
  for (const watermark of input.watermarks ?? []) {
    const agentId = requireText(watermark.agentId, 'watermark agentId')
    if (watermark.groupId !== groupId) fail(`watermark for ${agentId} belongs to another group`)
    requireOrdinal(watermark.upToSequence, 'watermark upToSequence')
    timestampOf(watermark.updatedAt, 'watermark updatedAt')
    if (watermark.upToSequence > lastSequence) fail(`watermark for ${agentId} passes the last appended sequence`)
    if (watermarks.has(agentId)) fail(`duplicate watermark for ${agentId}`)
    watermarks.set(agentId, { ...watermark })
  }
  return {
    groupId,
    messages,
    revision: messages.length + 1,
    retentionStartSequence,
    watermarks,
  }
}
