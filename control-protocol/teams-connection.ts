import type { AuthenticatedAgent, JsonValue } from './agent-services.ts'
import type { AcpChannelRef, AcpFrame, AcpFault } from './acp.ts'
import { AcpError, parseAcpFault, parseAcpFrame } from './acp.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'

/** A relation is bilateral: master/peer or peer/peer. No subordinate alias exists. */
export type RelationRole = 'master' | 'peer'

export interface TeamsAgreement {
  readonly connectionId: string
  /** A new connection starts this value at 1. */
  readonly relationRevision: number
  readonly source: AuthenticatedAgent
  readonly target: AuthenticatedAgent
  readonly sourceRole: RelationRole
  readonly targetRole: RelationRole
  readonly sourceGeneration: number
  readonly targetGeneration: number
  readonly sourceCapabilitiesRevision: string
  readonly targetCapabilitiesRevision: string
  readonly sourcePolicyRevision: number
  readonly targetPolicyRevision: number
  /** Capabilities explicitly admitted for this connection. */
  readonly capabilities: readonly string[]
}

export interface TeamsConnectionPropose {
  readonly version: 1
  readonly kind: 'teams.connection.propose'
  readonly requestId: string
  readonly connectionId: string
  readonly sourceGeneration: number
  readonly targetGeneration: number
  readonly sourceCapabilitiesRevision: string
  readonly targetCapabilitiesRevision: string
  /** The proposer's own role for the relation. */
  readonly requestedRole: RelationRole
  /** The role the proposer intends the responder to take; peer is not a guess. */
  readonly requestedPeerRole: RelationRole
  readonly requestedCapabilities: readonly string[]
}

/**
 * Transport-owner context the responder sends after the existing auth/hello
 * exchange. `connectionId` is the responder's real transport owner ID, which
 * `hello_ack` does not carry, so the initiator can name it before proposing.
 */
export interface TeamsConnectionContext {
  readonly version: 1
  readonly kind: 'teams.connection.context'
  readonly connectionId: string
  readonly targetGeneration: number
  readonly capabilitiesRevision: string
}

export interface TeamsConnectionAccept {
  readonly version: 1
  readonly kind: 'teams.connection.accept'
  readonly requestId: string
  readonly agreement: TeamsAgreement
}

export interface TeamsConnectionReject {
  readonly version: 1
  readonly kind: 'teams.connection.reject'
  readonly requestId: string
  readonly connectionId: string
  readonly error: AcpFault
}

export interface TeamsConnectionConfirm {
  readonly version: 1
  readonly kind: 'teams.connection.confirm'
  readonly requestId: string
  readonly agreement: TeamsAgreement
}

export interface TeamsConnectionReady {
  readonly version: 1
  readonly kind: 'teams.connection.ready'
  readonly requestId: string
  readonly agreement: TeamsAgreement
}

export interface TeamsAcpOpen {
  readonly version: 1
  readonly kind: 'acp.open'
  readonly ref: AcpChannelRef
}

export interface TeamsAcpOpenAck {
  readonly version: 1
  readonly kind: 'acp.open_ack'
  readonly ref: AcpChannelRef
}

export interface TeamsAcpFrame {
  readonly version: 1
  readonly kind: 'acp.frame'
  readonly ref: AcpChannelRef
  readonly frame: AcpFrame
}

export interface TeamsAcpClose {
  readonly version: 1
  readonly kind: 'acp.close'
  readonly ref: AcpChannelRef
}

export interface TeamsAcpError {
  readonly version: 1
  readonly kind: 'acp.error'
  readonly ref: AcpChannelRef
  readonly error: AcpFault
}

export type TeamsConnectionFrame =
  | TeamsConnectionContext
  | TeamsConnectionPropose
  | TeamsConnectionAccept
  | TeamsConnectionReject
  | TeamsConnectionConfirm
  | TeamsConnectionReady
  | TeamsAcpOpen
  | TeamsAcpOpenAck
  | TeamsAcpFrame
  | TeamsAcpClose
  | TeamsAcpError

const RELATION_ROLES: readonly RelationRole[] = ['master', 'peer']

/** Only these ordered role pairs are bilateral. subordinate/master-master never exist. */
const ALLOWED_ROLE_PAIRS: readonly (readonly [RelationRole, RelationRole])[] = [
  ['master', 'peer'],
  ['peer', 'master'],
  ['peer', 'peer'],
]

function fail(message: string): never {
  throw new AcpError('INVALID_ACP_FRAME', message)
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertText(value: JsonValue | undefined, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)
}

function assertPositiveInteger(value: JsonValue | undefined, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${path} must be a positive finite integer`)
}

function assertRole(value: JsonValue | undefined, path: string): asserts value is RelationRole {
  if (typeof value !== 'string' || !RELATION_ROLES.includes(value as RelationRole)) {
    fail(`${path} must be master or peer`)
  }
}

function assertRolePair(sourceRole: RelationRole, targetRole: RelationRole): void {
  if (!ALLOWED_ROLE_PAIRS.some(([source, target]) => source === sourceRole && target === targetRole)) {
    fail(`${sourceRole}/${targetRole} relation is not allowed`)
  }
}

function assertIdentity(value: JsonValue | undefined, path: string): AuthenticatedAgent {
  if (!isRecord(value)) fail(`${path} must be an object`)
  assertEnvelopeKeys(value, ['accountId', 'scopeId', 'agentId'], path)
  assertText(value.accountId, `${path}.accountId`)
  assertText(value.scopeId, `${path}.scopeId`)
  assertText(value.agentId, `${path}.agentId`)
  return value as unknown as AuthenticatedAgent
}

function assertCapabilities(value: JsonValue | undefined, path: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail(`${path} must be an array of non-empty strings`)
  }
}

function assertAgreement(value: JsonValue | undefined, path: string): TeamsAgreement {
  if (!isRecord(value)) fail(`${path} must be an object`)
  assertEnvelopeKeys(value, [
    'connectionId',
    'relationRevision',
    'source',
    'target',
    'sourceRole',
    'targetRole',
    'sourceGeneration',
    'targetGeneration',
    'sourceCapabilitiesRevision',
    'targetCapabilitiesRevision',
    'sourcePolicyRevision',
    'targetPolicyRevision',
    'capabilities',
  ], path)
  assertText(value.connectionId, `${path}.connectionId`)
  assertPositiveInteger(value.relationRevision, `${path}.relationRevision`)
  const source = assertIdentity(value.source, `${path}.source`)
  const target = assertIdentity(value.target, `${path}.target`)
  if (source.accountId === target.accountId && source.scopeId === target.scopeId && source.agentId === target.agentId) {
    fail(`${path} cannot name the same source and target identity`)
  }
  assertRole(value.sourceRole, `${path}.sourceRole`)
  assertRole(value.targetRole, `${path}.targetRole`)
  assertRolePair(value.sourceRole, value.targetRole)
  assertPositiveInteger(value.sourceGeneration, `${path}.sourceGeneration`)
  assertPositiveInteger(value.targetGeneration, `${path}.targetGeneration`)
  assertText(value.sourceCapabilitiesRevision, `${path}.sourceCapabilitiesRevision`)
  assertText(value.targetCapabilitiesRevision, `${path}.targetCapabilitiesRevision`)
  assertPositiveInteger(value.sourcePolicyRevision, `${path}.sourcePolicyRevision`)
  assertPositiveInteger(value.targetPolicyRevision, `${path}.targetPolicyRevision`)
  assertCapabilities(value.capabilities, `${path}.capabilities`)
  return value as unknown as TeamsAgreement
}

function assertChannelRef(value: JsonValue | undefined, path: string): AcpChannelRef {
  if (!isRecord(value)) fail(`${path} must be an object`)
  assertEnvelopeKeys(value, ['connectionId', 'channelId', 'targetGeneration', 'engineInstanceId'], path)
  assertText(value.connectionId, `${path}.connectionId`)
  assertText(value.channelId, `${path}.channelId`)
  assertPositiveInteger(value.targetGeneration, `${path}.targetGeneration`)
  assertText(value.engineInstanceId, `${path}.engineInstanceId`)
  return value as unknown as AcpChannelRef
}

function parseTeamsConnectionFrameValue(value: unknown): TeamsConnectionFrame {
  try {
    assertJsonValue(value, 'Teams connection frame')
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Teams connection frame must contain JSON values')
  }
  if (!isRecord(value)) fail('Teams connection frame must be an object')
  if (value.version !== 1) fail('Teams connection frame.version must equal 1')
  if (typeof value.kind !== 'string') fail('Teams connection frame.kind must be a string')

  const common = ['version', 'kind']
  switch (value.kind) {
    case 'teams.connection.context': {
      assertEnvelopeKeys(value, [
        ...common,
        'connectionId',
        'targetGeneration',
        'capabilitiesRevision',
      ], 'Teams connection context')
      assertText(value.connectionId, 'context.connectionId')
      assertPositiveInteger(value.targetGeneration, 'context.targetGeneration')
      assertText(value.capabilitiesRevision, 'context.capabilitiesRevision')
      break
    }
    case 'teams.connection.propose': {
      assertEnvelopeKeys(value, [
        ...common,
        'requestId',
        'connectionId',
        'sourceGeneration',
        'targetGeneration',
        'sourceCapabilitiesRevision',
        'targetCapabilitiesRevision',
        'requestedRole',
        'requestedPeerRole',
        'requestedCapabilities',
      ], 'Teams connection propose')
      assertText(value.requestId, 'propose.requestId')
      assertText(value.connectionId, 'propose.connectionId')
      assertPositiveInteger(value.sourceGeneration, 'propose.sourceGeneration')
      assertPositiveInteger(value.targetGeneration, 'propose.targetGeneration')
      assertText(value.sourceCapabilitiesRevision, 'propose.sourceCapabilitiesRevision')
      assertText(value.targetCapabilitiesRevision, 'propose.targetCapabilitiesRevision')
      assertRole(value.requestedRole, 'propose.requestedRole')
      assertRole(value.requestedPeerRole, 'propose.requestedPeerRole')
      assertRolePair(value.requestedRole, value.requestedPeerRole)
      assertCapabilities(value.requestedCapabilities, 'propose.requestedCapabilities')
      break
    }
    case 'teams.connection.accept': {
      assertEnvelopeKeys(value, [...common, 'requestId', 'agreement'], 'Teams connection accept')
      assertText(value.requestId, 'accept.requestId')
      assertAgreement(value.agreement, 'accept.agreement')
      break
    }
    case 'teams.connection.reject': {
      assertEnvelopeKeys(value, [...common, 'requestId', 'connectionId', 'error'], 'Teams connection reject')
      assertText(value.requestId, 'reject.requestId')
      assertText(value.connectionId, 'reject.connectionId')
      parseAcpFault(value.error)
      break
    }
    case 'teams.connection.confirm': {
      assertEnvelopeKeys(value, [...common, 'requestId', 'agreement'], 'Teams connection confirm')
      assertText(value.requestId, 'confirm.requestId')
      assertAgreement(value.agreement, 'confirm.agreement')
      break
    }
    case 'teams.connection.ready': {
      assertEnvelopeKeys(value, [...common, 'requestId', 'agreement'], 'Teams connection ready')
      assertText(value.requestId, 'ready.requestId')
      assertAgreement(value.agreement, 'ready.agreement')
      break
    }
    case 'acp.open':
      assertEnvelopeKeys(value, [...common, 'ref'], 'ACP open')
      assertChannelRef(value.ref, 'open.ref')
      break
    case 'acp.open_ack':
      assertEnvelopeKeys(value, [...common, 'ref'], 'ACP open ack')
      assertChannelRef(value.ref, 'open_ack.ref')
      break
    case 'acp.frame': {
      assertEnvelopeKeys(value, [...common, 'ref', 'frame'], 'ACP frame')
      assertChannelRef(value.ref, 'frame.ref')
      parseAcpFrame(value.frame)
      break
    }
    case 'acp.close':
      assertEnvelopeKeys(value, [...common, 'ref'], 'ACP close')
      assertChannelRef(value.ref, 'close.ref')
      break
    case 'acp.error':
      assertEnvelopeKeys(value, [...common, 'ref', 'error'], 'ACP error')
      assertChannelRef(value.ref, 'error.ref')
      parseAcpFault(value.error)
      break
    default:
      fail(`unsupported Teams connection frame kind ${value.kind}`)
  }
  return value as unknown as TeamsConnectionFrame
}

export function parseTeamsConnectionFrame(value: unknown): TeamsConnectionFrame {
  try {
    return parseTeamsConnectionFrameValue(value)
  } catch (error) {
    if (error instanceof AcpError) throw error
    throw new AcpError('INVALID_ACP_FRAME', error instanceof Error ? error.message : 'Teams connection frame is invalid')
  }
}
