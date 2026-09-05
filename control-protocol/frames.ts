import { AgentMessage, validateAgentMessage } from './agent-message.ts'
import { RelationReport, validateRelationReport } from './relation-report.ts'

export type AgentKind = 'opencode' | 'acp' | 'custom'
export type HealthState = 'starting' | 'ready' | 'error'
export type RouteKind = 'lan' | 'tailscale' | 'ipv6' | 'ipv4' | 'gateway' | 'relay-ws' | 'relay-webrtc'
export type PermissionAction = 'once' | 'always' | 'reject'
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical'
export type NotificationStatus = 'pending' | 'processed'
export type SessionRole = 'user' | 'assistant' | 'system' | 'tool'

export interface HostIdentity {
  hostId: string
  machineId: string
  agentId: string
  accountId: string
  agentKind: AgentKind
  label: string
}

export interface RouteCandidate {
  candidateId: string
  kind: RouteKind
  endpoint?: string
  port?: number
  authRequired: boolean
  lastSeenAt: string
}

export interface SessionRef {
  hostId: string
  agentId: string
  sessionId: string
}

export interface SessionSummary {
  sessionId: string
  title?: string
  status: string
  updatedAt: string
  unreadNotifications: number
}

export interface PermissionRequestRef {
  hostId: string
  agentId: string
  sessionId: string
  permissionId: string
}

export interface NotificationModel {
  notificationId: string
  hostId: string
  agentId: string
  sessionId?: string
  permissionId?: string
  priority: NotificationPriority
  status: NotificationStatus
  occurredAt: string
}

export interface HostDiscoveryRoute {
  kind: 'manual' | 'auto'
  candidates: readonly RouteCandidate[]
  generation: number
  confirmedAt: string
}

export interface TargetControlFrameMap {
  'transport.hello': {
    kind: 'transport.hello'
    targetGeneration: number
    protocolVersion: number
    hostId: string
    agentId: string
    capabilitiesRevision: string
  }
  'transport.hello_ack': {
    kind: 'transport.hello_ack'
    targetGeneration: number
  }
  'transport.ping': {
    kind: 'transport.ping'
    targetGeneration: number
    nonce: string
  }
  'transport.pong': {
    kind: 'transport.pong'
    targetGeneration: number
    nonce: string
  }
  'transport.health': {
    kind: 'transport.health'
    targetGeneration: number
    health: HealthState
  }
  'transport.generation': {
    kind: 'transport.generation'
    targetGeneration: number
  }
  'transport.capability': {
    kind: 'transport.capability'
    targetGeneration: number
    capabilitiesRevision: string
    capabilities: readonly string[]
  }
  'transport.route_info': {
    kind: 'transport.route_info'
    targetGeneration: number
    route: HostDiscoveryRoute
  }
  'transport.error': {
    kind: 'transport.error'
    targetGeneration: number
    code: string
    message: string
  }
  'channel.open': {
    kind: 'channel.open'
    targetGeneration: number
    channelId: string
    sessionRef: SessionRef
  }
  'channel.open_ack': {
    kind: 'channel.open_ack'
    targetGeneration: number
    channelId: string
  }
  'channel.close': {
    kind: 'channel.close'
    targetGeneration: number
    channelId: string
    reason: string
  }
  'channel.close_ack': {
    kind: 'channel.close_ack'
    targetGeneration: number
    channelId: string
  }
  'channel.error': {
    kind: 'channel.error'
    targetGeneration: number
    channelId: string
    code: string
    message: string
  }
}

export type TargetControlFrame = TargetControlFrameMap[keyof TargetControlFrameMap]

export interface SessionChannelFrameMap {
  'session.list': {
    kind: 'session.list'
    targetGeneration: number
    channelId: string
    requestId: string
  }
  'session.list_result': {
    kind: 'session.list_result'
    targetGeneration: number
    channelId: string
    requestId: string
    sessions: readonly SessionSummary[]
  }
  'session.current': {
    kind: 'session.current'
    targetGeneration: number
    channelId: string
    requestId: string
  }
  'session.open': {
    kind: 'session.open'
    targetGeneration: number
    channelId: string
    requestId: string
    sessionId: string
  }
  'session.message': {
    kind: 'session.message'
    targetGeneration: number
    channelId: string
    sessionId: string
    correlationId: string
    role: SessionRole
    body: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
  'session.message_delta': {
    kind: 'session.message_delta'
    targetGeneration: number
    channelId: string
    sessionId: string
    correlationId: string
    delta: unknown
  }
  'permission.ask': {
    kind: 'permission.ask'
    targetGeneration: number
    channelId: string
    requestId: string
    permissionRequest: PermissionRequestRef
  }
  'permission.reply': {
    kind: 'permission.reply'
    targetGeneration: number
    channelId: string
    requestId: string
    permissionId: string
    action: PermissionAction
  }
  'notification.upsert': {
    kind: 'notification.upsert'
    targetGeneration: number
    channelId: string
    notification: NotificationModel
  }
  'notification.ack': {
    kind: 'notification.ack'
    targetGeneration: number
    channelId: string
    requestId: string
    notificationId: string
  }
  'agent.message': {
    kind: 'agent.message'
    targetGeneration: number
    channelId: string
    message: AgentMessage
  }
  'relation.report': {
    kind: 'relation.report'
    targetGeneration: number
    channelId: string
    report: RelationReport
  }
}

export type SessionChannelFrame = SessionChannelFrameMap[keyof SessionChannelFrameMap]

const forbiddenBusinessKeys = new Set([
  'machineId',
  'endpoint',
  'route',
  'generation',
  'targetGeneration',
  'health',
  'authGrant',
  'permissionDecision',
  'config',
  'routing',
  'retry',
  'diagnostics',
  'authToken',
  'apiKey',
  'bearer',
  'password',
  'token',
])

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${label} is invalid`)
  }
  return value as T
}

function assertIsoDate(value: unknown, label: string): void {
  const parsed = stringValue(value, label)
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${label} must be an ISO date`)
  }
}

function assertBusinessSafe(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertBusinessSafe(entry, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenBusinessKeys.has(key)) {
      throw new Error(`${path} contains forbidden control field ${key}`)
    }
    assertBusinessSafe(entry, `${path}.${key}`)
  }
}

function assertSessionRef(value: unknown): SessionRef {
  const input = record(value, 'sessionRef')
  return {
    hostId: stringValue(input.hostId, 'sessionRef.hostId'),
    agentId: stringValue(input.agentId, 'sessionRef.agentId'),
    sessionId: stringValue(input.sessionId, 'sessionRef.sessionId'),
  }
}

function assertPermissionRequest(value: unknown): PermissionRequestRef {
  const input = record(value, 'permissionRequest')
  return {
    hostId: stringValue(input.hostId, 'permissionRequest.hostId'),
    agentId: stringValue(input.agentId, 'permissionRequest.agentId'),
    sessionId: stringValue(input.sessionId, 'permissionRequest.sessionId'),
    permissionId: stringValue(input.permissionId, 'permissionRequest.permissionId'),
  }
}

function assertNotification(value: unknown): NotificationModel {
  const input = record(value, 'notification')
  const result: NotificationModel = {
    notificationId: stringValue(input.notificationId, 'notification.notificationId'),
    hostId: stringValue(input.hostId, 'notification.hostId'),
    agentId: stringValue(input.agentId, 'notification.agentId'),
    priority: enumValue(input.priority, ['low', 'normal', 'high', 'critical'], 'notification.priority'),
    status: enumValue(input.status, ['pending', 'processed'], 'notification.status'),
    occurredAt: stringValue(input.occurredAt, 'notification.occurredAt'),
  }
  assertIsoDate(result.occurredAt, 'notification.occurredAt')
  if (input.sessionId !== undefined) result.sessionId = stringValue(input.sessionId, 'notification.sessionId')
  if (input.permissionId !== undefined) result.permissionId = stringValue(input.permissionId, 'notification.permissionId')
  return result
}

function assertChannelId(input: Record<string, unknown>): string {
  return stringValue(input.channelId, 'channelId')
}

export function parseTargetControlFrame(value: unknown): TargetControlFrame {
  const input = record(value, 'target control frame')
  const kind = stringValue(input.kind, 'kind') as keyof TargetControlFrameMap
  if (!(kind in targetControlValidators)) {
    throw new Error(`unknown target control frame: ${kind}`)
  }
  targetControlValidators[kind](input)
  return input as TargetControlFrame
}

const targetControlValidators: {
  [K in keyof TargetControlFrameMap]: (input: Record<string, unknown>) => void
} = {
  'transport.hello': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    positiveInteger(input.protocolVersion, 'protocolVersion')
    stringValue(input.hostId, 'hostId')
    stringValue(input.agentId, 'agentId')
    stringValue(input.capabilitiesRevision, 'capabilitiesRevision')
  },
  'transport.hello_ack': (input) => positiveInteger(input.targetGeneration, 'targetGeneration'),
  'transport.ping': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    stringValue(input.nonce, 'nonce')
  },
  'transport.pong': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    stringValue(input.nonce, 'nonce')
  },
  'transport.health': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    enumValue(input.health, ['starting', 'ready', 'error'], 'health')
  },
  'transport.generation': (input) => positiveInteger(input.targetGeneration, 'targetGeneration'),
  'transport.capability': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    stringValue(input.capabilitiesRevision, 'capabilitiesRevision')
    if (!Array.isArray(input.capabilities) || input.capabilities.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error('capabilities must be a non-empty string array')
    }
  },
  'transport.route_info': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    const route = record(input.route, 'route')
    enumValue(route.kind, ['manual', 'auto'], 'route.kind')
    positiveInteger(route.generation, 'route.generation')
    assertIsoDate(route.confirmedAt, 'route.confirmedAt')
    if (!Array.isArray(route.candidates)) throw new Error('route.candidates must be an array')
    route.candidates.forEach(assertRouteCandidate)
  },
  'transport.error': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    stringValue(input.code, 'code')
    stringValue(input.message, 'message')
  },
  'channel.open': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    assertSessionRef(input.sessionRef)
  },
  'channel.open_ack': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
  },
  'channel.close': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.reason, 'reason')
  },
  'channel.close_ack': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
  },
  'channel.error': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.code, 'code')
    stringValue(input.message, 'message')
  },
}

function assertRouteCandidate(value: unknown): void {
  const candidate = record(value, 'route.candidates[]')
  stringValue(candidate.candidateId, 'route.candidates[].candidateId')
  enumValue(candidate.kind, ['lan', 'tailscale', 'ipv6', 'ipv4', 'gateway', 'relay-ws', 'relay-webrtc'], 'route.candidates[].kind')
  if (candidate.endpoint !== undefined) stringValue(candidate.endpoint, 'route.candidates[].endpoint')
  if (candidate.port !== undefined) {
    const port = positiveInteger(candidate.port, 'route.candidates[].port')
    if (port > 65535) throw new Error('route.candidates[].port is invalid')
  }
  booleanValue(candidate.authRequired, 'route.candidates[].authRequired')
  assertIsoDate(candidate.lastSeenAt, 'route.candidates[].lastSeenAt')
}

export function parseSessionChannelFrame(value: unknown): SessionChannelFrame {
  const input = record(value, 'session channel frame')
  const kind = stringValue(input.kind, 'kind') as keyof SessionChannelFrameMap
  if (!(kind in sessionChannelValidators)) {
    throw new Error(`unknown session channel frame: ${kind}`)
  }
  sessionChannelValidators[kind](input)
  return input as SessionChannelFrame
}

const sessionChannelValidators: {
  [K in keyof SessionChannelFrameMap]: (input: Record<string, unknown>) => void
} = {
  'session.list': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.requestId, 'requestId')
  },
  'session.list_result': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.requestId, 'requestId')
    if (!Array.isArray(input.sessions)) throw new Error('sessions must be an array')
  },
  'session.current': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.requestId, 'requestId')
  },
  'session.open': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.requestId, 'requestId')
    stringValue(input.sessionId, 'sessionId')
  },
  'session.message': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.sessionId, 'sessionId')
    stringValue(input.correlationId, 'correlationId')
    enumValue(input.role, ['user', 'assistant', 'system', 'tool'], 'role')
    const body = record(input.body, 'body')
    assertBusinessSafe(body, 'body')
    if (input.metadata !== undefined) {
      const metadata = record(input.metadata, 'metadata')
      assertBusinessSafe(metadata, 'metadata')
    }
  },
  'session.message_delta': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.sessionId, 'sessionId')
    stringValue(input.correlationId, 'correlationId')
    assertBusinessSafe(input.delta, 'delta')
  },
  'permission.ask': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.requestId, 'requestId')
    assertPermissionRequest(input.permissionRequest)
  },
  'permission.reply': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.requestId, 'requestId')
    stringValue(input.permissionId, 'permissionId')
    enumValue(input.action, ['once', 'always', 'reject'], 'action')
  },
  'notification.upsert': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    assertNotification(input.notification)
  },
  'notification.ack': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    stringValue(input.requestId, 'requestId')
    stringValue(input.notificationId, 'notificationId')
  },
  'agent.message': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    validateAgentMessage(input.message)
  },
  'relation.report': (input) => {
    positiveInteger(input.targetGeneration, 'targetGeneration')
    assertChannelId(input)
    validateRelationReport(input.report)
  },
}
