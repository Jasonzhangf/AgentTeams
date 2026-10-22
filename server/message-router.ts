import type { Action, Group, Message } from '../control-protocol/group-wire.ts'
import { memberActiveAt } from './group-registry.ts'

/**
 * Group message routing for the group messaging increment.
 *
 * A group message stays group-visible: every member with a valid interval at
 * `sentAt` can read it. An action-linked message carries exactly the action
 * assignee in `targetAgentIds`; any other target set is rejected instead of
 * being inferred from the body. The module returns who needs a push and what is
 * a duplicate. It performs no network I/O.
 */

export interface RouteMessageInput {
  readonly group: Group
  readonly message: Message
  readonly action?: Action
  readonly onlineAgentIds: readonly string[]
  /** Message ids already delivered, used to suppress repeated backlog pushes. */
  readonly deliveredMessageIds?: readonly string[]
}

export interface RoutedMessage {
  readonly messageId: string
  readonly visibleToAgentIds: readonly string[]
  readonly pushAgentIds: readonly string[]
  readonly offlineAgentIds: readonly string[]
  readonly duplicate: boolean
}

export interface MessageBatch {
  readonly unique: readonly Message[]
  readonly duplicates: readonly Message[]
}

function fail(message: string): never {
  throw new Error(`message-router: ${message}`)
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return value
}

function requireIds(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  for (const id of value) requireText(id, label)
  return value
}

export function routeGroupMessage(input: RouteMessageInput): RoutedMessage {
  const { group, message } = input
  if (message.groupId !== group.groupId) fail(`message group ${message.groupId} does not match group ${group.groupId}`)
  requireText(message.messageId, 'messageId')
  if (!memberActiveAt(group, message.fromAgentId, message.sentAt)) {
    fail(`sender ${message.fromAgentId} is not an active member at sentAt`)
  }
  requireIds(message.targetAgentIds, 'targetAgentIds')
  if (new Set(message.targetAgentIds).size !== message.targetAgentIds.length) {
    fail('targetAgentIds must not repeat an id')
  }
  if (message.actionId === undefined) {
    if (input.action !== undefined) fail('an action was supplied for a message without actionId')
    for (const target of message.targetAgentIds) {
      if (!memberActiveAt(group, target, message.sentAt)) {
        fail(`target ${target} is not an active member at sentAt`)
      }
    }
  } else {
    const action = input.action
    if (!action) fail(`message actionId ${message.actionId} has no action record`)
    if (action.actionId !== message.actionId) fail('message actionId does not match the supplied action')
    if (message.sessionId === undefined || action.sessionId !== message.sessionId) {
      fail('action and message must belong to the same issue session')
    }
    if (message.targetAgentIds.length !== 1 || message.targetAgentIds[0] !== action.assigneeAgentId) {
      fail('targetAgentIds must exactly equal the action assignee')
    }
    if (!memberActiveAt(group, action.assigneeAgentId, message.sentAt)) {
      fail(`assignee ${action.assigneeAgentId} is not an active member at sentAt`)
    }
  }
  const visibleToAgentIds = group.members
    .filter(member => memberActiveAt(group, member.agentId, message.sentAt))
    .map(member => member.agentId)
  const online = new Set(requireIds(input.onlineAgentIds, 'onlineAgentIds'))
  const delivered = new Set(requireIds(input.deliveredMessageIds ?? [], 'deliveredMessageIds'))
  const duplicate = delivered.has(message.messageId)
  const candidates = visibleToAgentIds.filter(agentId => agentId !== message.fromAgentId)
  const pushAgentIds = duplicate ? [] : candidates.filter(agentId => online.has(agentId))
  const offlineAgentIds = candidates.filter(agentId => !online.has(agentId))
  return {
    messageId: message.messageId,
    visibleToAgentIds,
    pushAgentIds,
    offlineAgentIds,
    duplicate,
  }
}

/**
 * Deduplicates a batch by messageId, keeping the first occurrence and treating
 * already delivered ids as duplicates. Repeated backlog deliveries never push
 * the same message twice.
 */
export function dedupeMessageBatch(
  messages: readonly Message[],
  deliveredMessageIds: readonly string[] = [],
): MessageBatch {
  const seen = new Set(requireIds(deliveredMessageIds, 'deliveredMessageIds'))
  const unique: Message[] = []
  const duplicates: Message[] = []
  for (const message of messages) {
    requireText(message.messageId, 'messageId')
    if (seen.has(message.messageId)) {
      duplicates.push(message)
      continue
    }
    seen.add(message.messageId)
    unique.push(message)
  }
  return { unique, duplicates }
}
