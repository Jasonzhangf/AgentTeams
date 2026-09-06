import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'

export type AgentMessageKind = 'request.capability' | 'reply.capability' | 'task.result' | 'notify' | 'error'

export interface AgentMessage {
  readonly kind: AgentMessageKind
  readonly correlationId: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface AgentPairChannelRef {
  readonly channelId: string
  readonly relationId: string
  readonly fromAgentId: string
  readonly toAgentId: string
  readonly targetGeneration: number
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`agent-message: ${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`agent-message: ${label} must be a positive integer`)
  return value
}

export function validateAgentMessage(value: unknown): AgentMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('agent-message: message must be an object')
  const input = value as Record<string, unknown>
  assertEnvelopeKeys(input, ['kind', 'correlationId', 'payload'], 'agent-message')
  const kind = stringValue(input.kind, 'kind') as AgentMessageKind
  if (!['request.capability', 'reply.capability', 'task.result', 'notify', 'error'].includes(kind)) {
    throw new Error(`agent-message: unsupported kind ${kind}`)
  }
  if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) throw new Error('agent-message: payload must be a JSON object')
  assertJsonValue(input.payload, 'agent-message.payload')
  return {
    kind,
    correlationId: stringValue(input.correlationId, 'correlationId'),
    payload: input.payload as Readonly<Record<string, unknown>>,
  }
}

export function validateAgentPairChannelRef(value: unknown): AgentPairChannelRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('agent-pair: channel ref must be an object')
  const input = value as Record<string, unknown>
  const fromAgentId = stringValue(input.fromAgentId, 'fromAgentId')
  const toAgentId = stringValue(input.toAgentId, 'toAgentId')
  if (fromAgentId === toAgentId) throw new Error('agent-pair: self-target channel is not allowed')
  return {
    channelId: stringValue(input.channelId, 'channelId'),
    relationId: stringValue(input.relationId, 'relationId'),
    fromAgentId,
    toAgentId,
    targetGeneration: positiveInteger(input.targetGeneration, 'targetGeneration'),
  }
}

export function buildAgentPairChannelId(agentA: string, agentB: string): string {
  if (agentA === agentB) throw new Error('agent-pair: cannot build self channel')
  return [agentA, agentB].sort().join(':') + ':agent-pair'
}
