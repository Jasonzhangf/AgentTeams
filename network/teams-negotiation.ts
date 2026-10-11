import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpFault } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type {
  RelationRole,
  TeamsAgreement,
  TeamsConnectionAccept,
  TeamsConnectionConfirm,
  TeamsConnectionContext,
  TeamsConnectionFrame,
  TeamsConnectionPropose,
  TeamsConnectionReady,
  TeamsConnectionReject,
} from '../control-protocol/teams-connection.ts'
import { parseTeamsConnectionFrame } from '../control-protocol/teams-connection.ts'

/**
 * Teams negotiation state machine (owner: network).
 *
 * It carries ACP setup over the frozen D00 Teams frames only
 * (`teams.connection.context|propose|accept|reject|confirm|ready`). It declares
 * no second envelope, adds no field to `transport.hello`/`hello_ack`, and never
 * reaches an engine: the only way to obtain an agreement is the terminal
 * `agreed` state.
 *
 * Identity is never read from a frame. `self` and `peer` are the authenticated
 * transport identities the caller already established; a frame that names a
 * role, generation, capability revision or capability outside this daemon's
 * accepted facts is refused with a typed `AcpFault`, never downgraded.
 *
 * R3 (D00 amendment A1): `sourcePolicyRevision`/`targetPolicyRevision` are the
 * integer accepted config revision (`config/runtime-config.ts`
 * `acceptedRevision`). They are NOT `AcpPolicySnapshot.revision`, which is a
 * sha256 string; nothing is hashed or truncated here, and a non-integer value is
 * refused as an invalid input. The responder no longer takes the peer revision
 * as an unauthenticated caller input: the initiator's own revision arrives in
 * `propose.sourcePolicyRevision` and the responder's own revision arrives in
 * `context.policyRevision`. The initiator records the context revision as
 * `state.targetPolicyRevision` and requires the accept agreement to echo it.
 */

export type TeamsNegotiationSide = 'initiator' | 'responder'

export type TeamsNegotiationStateName =
  | 'awaiting-context'
  | 'awaiting-propose'
  | 'awaiting-accept'
  | 'awaiting-confirm'
  | 'awaiting-ready'
  | 'agreed'
  | 'rejected'

export interface TeamsInitiatorOptions {
  readonly side: 'initiator'
  /** This side's transport-scoped connection id. */
  readonly connectionId: string
  readonly self: AuthenticatedAgent
  readonly peer: AuthenticatedAgent
  readonly selfGeneration: number
  readonly selfCapabilitiesRevision: string
  /** Integer accepted config revision (`acceptedRevision`), not a policy snapshot hash. */
  readonly selfPolicyRevision: number
  /** `RelationsIntent.allowed` for this daemon. */
  readonly allowedRoles: readonly RelationRole[]
  readonly requestedRole: RelationRole
  readonly requestedPeerRole: RelationRole
  readonly requestedCapabilities: readonly string[]
  readonly requestId: string
  /** The target generation learned from the directory/route; a context must match it. */
  readonly expectedTargetGeneration: number
  readonly expectedTargetCapabilitiesRevision: string
}

export interface TeamsResponderOptions {
  readonly side: 'responder'
  /** This side's transport-scoped connection id; a propose must name it. */
  readonly connectionId: string
  readonly self: AuthenticatedAgent
  readonly peer: AuthenticatedAgent
  readonly selfGeneration: number
  readonly selfCapabilitiesRevision: string
  /** Integer accepted config revision (`acceptedRevision`), not a policy snapshot hash. */
  readonly selfPolicyRevision: number
  readonly allowedRoles: readonly RelationRole[]
  /** Capabilities this daemon admits for one connection. */
  readonly admittedCapabilities: readonly string[]
}

export type TeamsNegotiationOptions = TeamsInitiatorOptions | TeamsResponderOptions

export interface TeamsNegotiationState {
  readonly side: TeamsNegotiationSide
  readonly state: TeamsNegotiationStateName
  readonly options: TeamsNegotiationOptions
  readonly self: AuthenticatedAgent
  readonly peer: AuthenticatedAgent
  readonly connectionId: string
  readonly selfGeneration: number
  readonly requestId?: string
  /** The responder's transport connection id, learned from the context frame. */
  readonly targetConnectionId?: string
  readonly targetGeneration?: number
  readonly targetCapabilitiesRevision?: string
  /**
   * The responder's integer accepted config revision, learned from
   * `context.policyRevision`. The accept agreement must echo it.
   */
  readonly targetPolicyRevision?: number
  readonly agreement?: TeamsAgreement
  readonly fault?: AcpFault
}

export interface TeamsNegotiationStep {
  readonly state: TeamsNegotiationState
  readonly outbound?: TeamsConnectionFrame
}

export interface TeamsNegotiationPort {
  read(): Promise<unknown>
  send(frame: TeamsConnectionFrame): Promise<void>
}

const ROLES: readonly RelationRole[] = ['master', 'peer']
const ROLE_PAIRS: readonly (readonly [RelationRole, RelationRole])[] = [
  ['master', 'peer'],
  ['peer', 'master'],
  ['peer', 'peer'],
]

function fail(code: AcpFault['code'], message: string): never {
  throw new AcpError(code, message)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_ACP_FRAME', `teams-negotiation: ${label} must be a non-empty string`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail('INVALID_ACP_FRAME', `teams-negotiation: ${label} must be a positive safe integer`)
  }
  return value as number
}

function role(value: unknown, label: string): RelationRole {
  if (typeof value !== 'string' || !ROLES.includes(value as RelationRole)) {
    fail('INVALID_ACP_FRAME', `teams-negotiation: ${label} must be master or peer`)
  }
  return value as RelationRole
}

function capabilityList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail('INVALID_ACP_FRAME', `teams-negotiation: ${label} must be an array of non-empty strings`)
  }
  return value as readonly string[]
}

function identity(value: AuthenticatedAgent, label: string): AuthenticatedAgent {
  text(value?.accountId, `${label}.accountId`)
  text(value?.scopeId, `${label}.scopeId`)
  text(value?.agentId, `${label}.agentId`)
  return value
}

function sameIdentity(left: AuthenticatedAgent, right: AuthenticatedAgent): boolean {
  return left.accountId === right.accountId && left.scopeId === right.scopeId && left.agentId === right.agentId
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameAgreement(left: TeamsAgreement, right: TeamsAgreement): boolean {
  return left.connectionId === right.connectionId
    && left.relationRevision === right.relationRevision
    && sameIdentity(left.source, right.source)
    && sameIdentity(left.target, right.target)
    && left.sourceRole === right.sourceRole
    && left.targetRole === right.targetRole
    && left.sourceGeneration === right.sourceGeneration
    && left.targetGeneration === right.targetGeneration
    && left.sourceCapabilitiesRevision === right.sourceCapabilitiesRevision
    && left.targetCapabilitiesRevision === right.targetCapabilitiesRevision
    && left.sourcePolicyRevision === right.sourcePolicyRevision
    && left.targetPolicyRevision === right.targetPolicyRevision
    && sameCapabilities(left.capabilities, right.capabilities)
}

function step(state: TeamsNegotiationState, outbound?: TeamsConnectionFrame): TeamsNegotiationStep {
  return outbound === undefined ? { state } : { state, outbound }
}

function assertRolePair(sourceRole: RelationRole, targetRole: RelationRole): void {
  if (!ROLE_PAIRS.some(([source, target]) => source === sourceRole && target === targetRole)) {
    fail('INVALID_ACP_FRAME', `teams-negotiation: ${sourceRole}/${targetRole} relation is not allowed`)
  }
}

function assertCommonOptions(options: TeamsNegotiationOptions): void {
  text(options.connectionId, 'connectionId')
  identity(options.self, 'self')
  identity(options.peer, 'peer')
  if (sameIdentity(options.self, options.peer)) {
    fail('INVALID_ACP_FRAME', 'teams-negotiation: self and peer must be different authenticated agents')
  }
  positiveInteger(options.selfGeneration, 'selfGeneration')
  text(options.selfCapabilitiesRevision, 'selfCapabilitiesRevision')
  positiveInteger(options.selfPolicyRevision, 'selfPolicyRevision')
  if (!Array.isArray(options.allowedRoles) || options.allowedRoles.length === 0) {
    fail('INVALID_ACP_FRAME', 'teams-negotiation: allowedRoles must name at least one role')
  }
  for (const allowed of options.allowedRoles) role(allowed, 'allowedRoles[]')
}

export function startTeamsNegotiation(options: TeamsNegotiationOptions): TeamsNegotiationStep {
  assertCommonOptions(options)
  if (options.side === 'responder') {
    capabilityList(options.admittedCapabilities, 'admittedCapabilities')
    const state: TeamsNegotiationState = {
      side: 'responder',
      state: 'awaiting-propose',
      options,
      self: options.self,
      peer: options.peer,
      connectionId: options.connectionId,
      selfGeneration: options.selfGeneration,
    }
    const context: TeamsConnectionContext = {
      version: 1,
      kind: 'teams.connection.context',
      connectionId: options.connectionId,
      targetGeneration: options.selfGeneration,
      capabilitiesRevision: options.selfCapabilitiesRevision,
      // D00 amendment A1: this responder's own authenticated revision.
      policyRevision: options.selfPolicyRevision,
    }
    return step(state, context)
  }

  positiveInteger(options.expectedTargetGeneration, 'expectedTargetGeneration')
  text(options.expectedTargetCapabilitiesRevision, 'expectedTargetCapabilitiesRevision')
  text(options.requestId, 'requestId')
  const requestedRole = role(options.requestedRole, 'requestedRole')
  const requestedPeerRole = role(options.requestedPeerRole, 'requestedPeerRole')
  assertRolePair(requestedRole, requestedPeerRole)
  if (!options.allowedRoles.includes(requestedRole) || !options.allowedRoles.includes(requestedPeerRole)) {
    fail('FORBIDDEN', 'teams-negotiation: the requested relation roles are outside this daemon accepted relations')
  }
  capabilityList(options.requestedCapabilities, 'requestedCapabilities')
  return step({
    side: 'initiator',
    state: 'awaiting-context',
    options,
    self: options.self,
    peer: options.peer,
    connectionId: options.connectionId,
    selfGeneration: options.selfGeneration,
    requestId: options.requestId,
  })
}

function rejectPropose(state: TeamsNegotiationState, requestId: string, fault: AcpFault): TeamsNegotiationStep {
  const reject: TeamsConnectionReject = {
    version: 1,
    kind: 'teams.connection.reject',
    requestId,
    connectionId: state.connectionId,
    error: fault,
  }
  return step({ ...state, state: 'rejected', requestId, fault }, reject)
}

function validatePropose(
  state: TeamsNegotiationState,
  options: TeamsResponderOptions,
  propose: TeamsConnectionPropose,
): AcpFault | undefined {
  if (propose.connectionId !== options.connectionId) {
    return { code: 'CONFLICT', message: 'teams-negotiation: propose names a different transport connection' }
  }
  if (propose.targetGeneration !== options.selfGeneration) {
    return { code: 'STALE_GENERATION', message: 'teams-negotiation: propose names a stale target generation' }
  }
  if (propose.targetCapabilitiesRevision !== options.selfCapabilitiesRevision) {
    return { code: 'CONFLICT', message: 'teams-negotiation: propose names a different target capability revision' }
  }
  if (!options.allowedRoles.includes(propose.requestedRole) || !options.allowedRoles.includes(propose.requestedPeerRole)) {
    return { code: 'FORBIDDEN', message: 'teams-negotiation: the requested relation roles are outside this daemon accepted relations' }
  }
  const denied = propose.requestedCapabilities.filter(capability => !options.admittedCapabilities.includes(capability))
  if (denied.length > 0) {
    return { code: 'CAPABILITY_DENIED', message: `teams-negotiation: capability is not admitted for this connection: ${denied.join(', ')}` }
  }
  return undefined
}

function acceptPropose(state: TeamsNegotiationState, propose: TeamsConnectionPropose): TeamsNegotiationStep {
  const options = state.options as TeamsResponderOptions
  const fault = validatePropose(state, options, propose)
  if (fault !== undefined) return rejectPropose(state, propose.requestId, fault)
  const agreement: TeamsAgreement = {
    connectionId: options.connectionId,
    relationRevision: 1,
    source: options.peer,
    target: options.self,
    sourceRole: propose.requestedRole,
    targetRole: propose.requestedPeerRole,
    sourceGeneration: propose.sourceGeneration,
    targetGeneration: propose.targetGeneration,
    sourceCapabilitiesRevision: propose.sourceCapabilitiesRevision,
    targetCapabilitiesRevision: propose.targetCapabilitiesRevision,
    // R3 (A1): integer accepted config revisions, never the sha256 policy
    // snapshot revision. Both come from the frames, not from caller options.
    sourcePolicyRevision: propose.sourcePolicyRevision,
    targetPolicyRevision: options.selfPolicyRevision,
    capabilities: [...propose.requestedCapabilities],
  }
  const accept: TeamsConnectionAccept = { version: 1, kind: 'teams.connection.accept', requestId: propose.requestId, agreement }
  return step({
    ...state,
    state: 'awaiting-confirm',
    requestId: propose.requestId,
    targetConnectionId: propose.connectionId,
    targetGeneration: propose.targetGeneration,
    targetCapabilitiesRevision: propose.targetCapabilitiesRevision,
    agreement,
  }, accept)
}

function acceptContext(state: TeamsNegotiationState, context: TeamsConnectionContext): TeamsNegotiationStep {
  const options = state.options as TeamsInitiatorOptions
  if (context.targetGeneration !== options.expectedTargetGeneration) {
    fail('STALE_GENERATION', 'teams-negotiation: stale target generation in the connection context')
  }
  if (context.capabilitiesRevision !== options.expectedTargetCapabilitiesRevision) {
    fail('CONFLICT', 'teams-negotiation: target capability revision does not match the expected revision')
  }
  const propose: TeamsConnectionPropose = {
    version: 1,
    kind: 'teams.connection.propose',
    requestId: options.requestId,
    connectionId: context.connectionId,
    sourceGeneration: options.selfGeneration,
    targetGeneration: context.targetGeneration,
    sourceCapabilitiesRevision: options.selfCapabilitiesRevision,
    targetCapabilitiesRevision: context.capabilitiesRevision,
    // D00 amendment A1: this initiator's own authenticated revision.
    sourcePolicyRevision: options.selfPolicyRevision,
    requestedRole: options.requestedRole,
    requestedPeerRole: options.requestedPeerRole,
    requestedCapabilities: [...options.requestedCapabilities],
  }
  return step({
    ...state,
    state: 'awaiting-accept',
    targetConnectionId: context.connectionId,
    targetGeneration: context.targetGeneration,
    targetCapabilitiesRevision: context.capabilitiesRevision,
    targetPolicyRevision: context.policyRevision,
  }, propose)
}

function assertAgreementEcho(state: TeamsNegotiationState, options: TeamsInitiatorOptions, agreement: TeamsAgreement): void {
  const echoed = agreement.connectionId === state.targetConnectionId
    && agreement.relationRevision === 1
    && sameIdentity(agreement.source, options.self)
    && sameIdentity(agreement.target, options.peer)
    && agreement.sourceRole === options.requestedRole
    && agreement.targetRole === options.requestedPeerRole
    && agreement.sourceGeneration === options.selfGeneration
    && agreement.targetGeneration === state.targetGeneration
    && agreement.sourceCapabilitiesRevision === options.selfCapabilitiesRevision
    && agreement.targetCapabilitiesRevision === state.targetCapabilitiesRevision
    && agreement.sourcePolicyRevision === options.selfPolicyRevision
    && agreement.targetPolicyRevision === state.targetPolicyRevision
    && sameCapabilities(agreement.capabilities, options.requestedCapabilities)
  if (!echoed) fail('CONFLICT', 'teams-negotiation: accept agreement does not echo the proposal')
}

function acceptAgreement(state: TeamsNegotiationState, accept: TeamsConnectionAccept): TeamsNegotiationStep {
  const options = state.options as TeamsInitiatorOptions
  if (accept.requestId !== options.requestId) {
    fail('CONFLICT', 'teams-negotiation: accept correlation does not match the propose requestId')
  }
  assertAgreementEcho(state, options, accept.agreement)
  const confirm: TeamsConnectionConfirm = {
    version: 1,
    kind: 'teams.connection.confirm',
    requestId: options.requestId,
    agreement: accept.agreement,
  }
  return step({ ...state, state: 'awaiting-ready', agreement: accept.agreement }, confirm)
}

function acceptConfirm(state: TeamsNegotiationState, confirm: TeamsConnectionConfirm): TeamsNegotiationStep {
  if (confirm.requestId !== state.requestId) {
    fail('CONFLICT', 'teams-negotiation: confirm correlation does not match the propose requestId')
  }
  if (state.agreement === undefined || !sameAgreement(state.agreement, confirm.agreement)) {
    fail('CONFLICT', 'teams-negotiation: confirm agreement does not echo the accepted agreement')
  }
  const ready: TeamsConnectionReady = {
    version: 1,
    kind: 'teams.connection.ready',
    requestId: confirm.requestId,
    agreement: state.agreement,
  }
  return step({ ...state, state: 'agreed' }, ready)
}

function acceptReady(state: TeamsNegotiationState, ready: TeamsConnectionReady): TeamsNegotiationStep {
  const options = state.options as TeamsInitiatorOptions
  if (ready.requestId !== options.requestId) {
    fail('CONFLICT', 'teams-negotiation: ready correlation does not match the propose requestId')
  }
  if (state.agreement === undefined || !sameAgreement(state.agreement, ready.agreement)) {
    fail('CONFLICT', 'teams-negotiation: ready agreement does not echo the confirmed agreement')
  }
  return step({ ...state, state: 'agreed' })
}

function unexpected(state: TeamsNegotiationState, kind: string): never {
  fail('INVALID_ACP_FRAME', `teams-negotiation: unexpected ${kind} while ${state.state}`)
}

export function receiveTeamsNegotiationFrame(state: TeamsNegotiationState, frame: unknown): TeamsNegotiationStep {
  const parsed: TeamsConnectionFrame = parseTeamsConnectionFrame(frame)
  switch (state.state) {
    case 'awaiting-context':
      if (parsed.kind !== 'teams.connection.context') unexpected(state, parsed.kind)
      return acceptContext(state, parsed)
    case 'awaiting-propose':
      if (parsed.kind !== 'teams.connection.propose') unexpected(state, parsed.kind)
      return acceptPropose(state, parsed)
    case 'awaiting-accept':
      if (parsed.kind === 'teams.connection.accept') return acceptAgreement(state, parsed)
      if (parsed.kind === 'teams.connection.reject') {
        if (parsed.requestId !== state.requestId) {
          fail('CONFLICT', 'teams-negotiation: reject correlation does not match the propose requestId')
        }
        return step({ ...state, state: 'rejected', fault: parsed.error })
      }
      return unexpected(state, parsed.kind)
    case 'awaiting-confirm':
      if (parsed.kind !== 'teams.connection.confirm') unexpected(state, parsed.kind)
      return acceptConfirm(state, parsed)
    case 'awaiting-ready':
      if (parsed.kind !== 'teams.connection.ready') unexpected(state, parsed.kind)
      return acceptReady(state, parsed)
    default:
      fail('CONFLICT', `teams-negotiation: the negotiation is already ${state.state}`)
  }
}

export function timeoutTeamsNegotiation(state: TeamsNegotiationState, message?: string): TeamsNegotiationState {
  if (state.state === 'agreed' || state.state === 'rejected') {
    fail('CONFLICT', `teams-negotiation: cannot time out an already ${state.state} negotiation`)
  }
  return {
    ...state,
    state: 'rejected',
    fault: { code: 'RESULT_UNKNOWN', message: message ?? 'teams-negotiation: the peer did not complete the negotiation' },
  }
}

/** The one agreed connection. Refuses every state that is not `agreed`. */
export function negotiatedAgreement(state: TeamsNegotiationState): TeamsAgreement {
  if (state.state !== 'agreed' || state.agreement === undefined) {
    fail('AUTHENTICATION_REQUIRED', `teams-negotiation: no agreed connection exists (state ${state.state})`)
  }
  return state.agreement
}

export function negotiationFault(state: TeamsNegotiationState): AcpFault {
  if (state.state !== 'rejected' || state.fault === undefined) {
    fail('CONFLICT', `teams-negotiation: the negotiation is not rejected (state ${state.state})`)
  }
  return state.fault
}

export interface RunTeamsNegotiationInput {
  readonly options: TeamsNegotiationOptions
  readonly port: TeamsNegotiationPort
  readonly timeoutMs: number
}

/**
 * Drives one handshake over an authenticated read/send port. A silent or
 * one-sided peer becomes a typed `RESULT_UNKNOWN` fault; a structurally invalid
 * frame still throws the frozen `INVALID_ACP_FRAME` fault.
 */
export async function runTeamsNegotiation(input: RunTeamsNegotiationInput): Promise<TeamsNegotiationState> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647) {
    fail('INVALID_ACP_FRAME', 'teams-negotiation: timeoutMs must be a positive safe integer')
  }
  let current = startTeamsNegotiation(input.options)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), input.timeoutMs) })
  try {
    if (current.outbound !== undefined) await input.port.send(current.outbound)
    while (current.state.state !== 'agreed' && current.state.state !== 'rejected') {
      let frame: unknown
      try {
        const next = await Promise.race([
          input.port.read().then(value => ({ kind: 'frame' as const, frame: value })),
          deadline.then(() => ({ kind: 'timeout' as const })),
        ])
        if (next.kind === 'timeout') return timeoutTeamsNegotiation(current.state)
        frame = next.frame
      } catch (error) {
        return timeoutTeamsNegotiation(current.state, error instanceof Error ? error.message : undefined)
      }
      current = receiveTeamsNegotiationFrame(current.state, frame)
      if (current.outbound !== undefined) await input.port.send(current.outbound)
    }
    return current.state
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
