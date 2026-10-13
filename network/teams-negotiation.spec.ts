import { describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../control-protocol/agent-services.ts'
import type { AcpFault } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'
import type { TeamsAgreement, TeamsConnectionFrame } from '../control-protocol/teams-connection.ts'
import { parseTeamsConnectionFrame } from '../control-protocol/teams-connection.ts'
import {
  negotiatedAgreement,
  negotiationFault,
  receiveTeamsNegotiationFrame,
  runTeamsNegotiation,
  startTeamsNegotiation,
  timeoutTeamsNegotiation,
  type TeamsInitiatorOptions,
  type TeamsNegotiationState,
  type TeamsResponderOptions,
} from './teams-negotiation.ts'

const A: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-a' }
const B: AuthenticatedAgent = { accountId: 'account-1', scopeId: 'scope-1', agentId: 'agent-b' }

function initiator(overrides: Partial<TeamsInitiatorOptions> = {}): TeamsInitiatorOptions {
  return {
    side: 'initiator',
    connectionId: 'conn-a',
    self: A,
    peer: B,
    selfGeneration: 11,
    selfCapabilitiesRevision: 'cap-a',
    selfPolicyRevision: 3,
    allowedRoles: ['master', 'peer'],
    requestedRole: 'master',
    requestedPeerRole: 'peer',
    requestedCapabilities: ['method:session/prompt'],
    requestId: 'req-1',
    expectedTargetGeneration: 22,
    expectedTargetCapabilitiesRevision: 'cap-b',
    ...overrides,
  }
}

function responder(overrides: Partial<TeamsResponderOptions> = {}): TeamsResponderOptions {
  return {
    side: 'responder',
    connectionId: 'conn-b',
    self: B,
    peer: A,
    selfGeneration: 22,
    selfCapabilitiesRevision: 'cap-b',
    selfPolicyRevision: 7,
    allowedRoles: ['master', 'peer'],
    admittedCapabilities: ['method:session/prompt', 'method:session/new'],
    engineInstanceId: 'engine-b',
    ...overrides,
  }
}

function proposeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: 'teams.connection.propose',
    requestId: 'req-1',
    connectionId: 'conn-b',
    sourceGeneration: 11,
    targetGeneration: 22,
    sourceCapabilitiesRevision: 'cap-a',
    targetCapabilitiesRevision: 'cap-b',
    sourcePolicyRevision: 3,
    requestedRole: 'master',
    requestedPeerRole: 'peer',
    requestedCapabilities: [],
    ...overrides,
  }
}

function thrownCode(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof AcpError ? error.code : undefined
  }
  return undefined
}

interface Handshake {
  readonly initiator: TeamsNegotiationState
  readonly responder: TeamsNegotiationState
  /** The genuine accept frame the responder produced. */
  readonly accept: TeamsConnectionFrame
}

/** Drives the frozen context -> propose -> accept -> confirm -> ready exchange. */
function handshake(
  initiatorOptions: TeamsInitiatorOptions = initiator(),
  responderOptions: TeamsResponderOptions = responder(),
): Handshake {
  const responderStart = startTeamsNegotiation(responderOptions)
  let responderState = responderStart.state
  let initiatorState = startTeamsNegotiation(initiatorOptions).state

  const proposed = receiveTeamsNegotiationFrame(initiatorState, responderStart.outbound!)
  initiatorState = proposed.state
  const accepted = receiveTeamsNegotiationFrame(responderState, proposed.outbound!)
  responderState = accepted.state
  const confirmed = receiveTeamsNegotiationFrame(initiatorState, accepted.outbound!)
  initiatorState = confirmed.state
  const ready = receiveTeamsNegotiationFrame(responderState, confirmed.outbound!)
  responderState = ready.state
  initiatorState = receiveTeamsNegotiationFrame(initiatorState, ready.outbound!).state
  return { initiator: initiatorState, responder: responderState, accept: accepted.outbound! }
}

describe('Teams negotiation state machine', () => {
  it('produces one identical agreement with both roles, generations, capability and integer policy revisions', () => {
    const { initiator: i, responder: r } = handshake()
    expect(i.state).toBe('agreed')
    expect(r.state).toBe('agreed')
    const agreement = negotiatedAgreement(i)
    expect(negotiatedAgreement(r)).toEqual(agreement)
    expect(agreement).toMatchObject({
      connectionId: 'conn-b',
      relationRevision: 1,
      source: A,
      target: B,
      sourceRole: 'master',
      targetRole: 'peer',
      sourceGeneration: 11,
      targetGeneration: 22,
      sourceCapabilitiesRevision: 'cap-a',
      targetCapabilitiesRevision: 'cap-b',
      sourcePolicyRevision: 3,
      targetPolicyRevision: 7,
      capabilities: ['method:session/prompt'],
    })
  })

  it('carries the integer accepted config revision, never a hashed policy snapshot revision', () => {
    const agreement = negotiatedAgreement(handshake().initiator)
    expect(Number.isSafeInteger(agreement.sourcePolicyRevision)).toBe(true)
    expect(Number.isSafeInteger(agreement.targetPolicyRevision)).toBe(true)
    expect(agreement.sourcePolicyRevision).toBe(3)
    expect(agreement.targetPolicyRevision).toBe(7)
    // A sha256 AcpPolicySnapshot.revision is a string and is refused, never truncated.
    expect(() => startTeamsNegotiation(initiator({ selfPolicyRevision: 0 })))
      .toThrow(/selfPolicyRevision/)
  })

  it('refuses a non-integer or absent sourcePolicyRevision on the propose frame instead of defaulting it', () => {
    const state = startTeamsNegotiation(responder()).state
    for (const invalid of ['a'.repeat(64), 0, -1, 1.5, null]) {
      expect(() => receiveTeamsNegotiationFrame(state, proposeFrame({ sourcePolicyRevision: invalid })))
        .toThrow(/sourcePolicyRevision/)
    }
    const absent = proposeFrame()
    delete absent.sourcePolicyRevision
    expect(() => receiveTeamsNegotiationFrame(state, absent)).toThrow(/sourcePolicyRevision/)
  })

  it('refuses a context frame without an authenticated integer policy revision', () => {
    const state = startTeamsNegotiation(initiator()).state
    // engineInstanceId is present so this case isolates the policy revision only.
    const context = { version: 1, kind: 'teams.connection.context', connectionId: 'conn-b', targetGeneration: 22, capabilitiesRevision: 'cap-b', engineInstanceId: 'engine-b' }
    expect(thrownCode(() => receiveTeamsNegotiationFrame(state, context))).toBe('INVALID_ACP_FRAME')
    expect(thrownCode(() => receiveTeamsNegotiationFrame(state, { ...context, policyRevision: 0 }))).toBe('INVALID_ACP_FRAME')
    expect(thrownCode(() => receiveTeamsNegotiationFrame(state, { ...context, policyRevision: '7' }))).toBe('INVALID_ACP_FRAME')
  })

  it('publishes the responder engine instance so the initiator can name it on acp.open (D00 amendment A3)', () => {
    const start = startTeamsNegotiation(responder())
    const context = start.outbound as { kind: string; engineInstanceId?: string }
    expect(context.kind).toBe('teams.connection.context')
    expect(context.engineInstanceId).toBe('engine-b')

    const { initiator: i } = handshake()
    expect(i.targetEngineInstanceId).toBe('engine-b')

    // The recorded value is exactly what the frozen acp.open channel ref requires.
    // Without this field the initiator cannot build a ref the parser accepts, and
    // createTeamsSession refuses a different value with STALE_GENERATION.
    const ref = {
      connectionId: 'conn-b',
      channelId: 'channel-1',
      targetGeneration: 22,
      engineInstanceId: i.targetEngineInstanceId,
    }
    const open = { version: 1, kind: 'acp.open', ref }
    expect(parseTeamsConnectionFrame(open)).toBe(open)
    // The same frame without the engine instance is refused, so the value is
    // load-bearing rather than decorative.
    expect(thrownCode(() => parseTeamsConnectionFrame({ ...open, ref: { ...ref, engineInstanceId: undefined } })))
      .toBe('INVALID_ACP_FRAME')
  })

  it('refuses a context frame without a non-empty engine instance', () => {
    const state = startTeamsNegotiation(initiator()).state
    const context = { version: 1, kind: 'teams.connection.context', connectionId: 'conn-b', targetGeneration: 22, capabilitiesRevision: 'cap-b', policyRevision: 7 }
    expect(thrownCode(() => receiveTeamsNegotiationFrame(state, context))).toBe('INVALID_ACP_FRAME')
    expect(thrownCode(() => receiveTeamsNegotiationFrame(state, { ...context, engineInstanceId: '' }))).toBe('INVALID_ACP_FRAME')
    expect(thrownCode(() => receiveTeamsNegotiationFrame(state, { ...context, engineInstanceId: 7 }))).toBe('INVALID_ACP_FRAME')
  })

  it('refuses a responder start without an engine instance instead of publishing a placeholder', () => {
    expect(thrownCode(() => startTeamsNegotiation(responder({ engineInstanceId: '' })))).toBe('INVALID_ACP_FRAME')
  })

  it('refuses an unknown protocol version instead of downgrading', () => {
    const state = startTeamsNegotiation(responder()).state
    expect(() => receiveTeamsNegotiationFrame(state, proposeFrame({ version: 2 })))
      .toThrow(/version must equal 1/)
  })

  it('refuses an unknown frame kind', () => {
    const state = startTeamsNegotiation(responder()).state
    expect(() => receiveTeamsNegotiationFrame(state, { version: 1, kind: 'teams.connection.downgrade' }))
      .toThrow(/unsupported Teams connection frame kind/)
  })

  it('refuses an illegal role pair and a subordinate role', () => {
    const state = startTeamsNegotiation(responder()).state
    // This inbound propose is rejected by the frozen parser's own role-pair
    // guard (control-protocol/teams-connection.ts), not by this module's guard.
    expect(() => receiveTeamsNegotiationFrame(state, proposeFrame({ requestedRole: 'master', requestedPeerRole: 'master' })))
      .toThrow(/master\/master relation is not allowed/)
    expect(() => receiveTeamsNegotiationFrame(state, proposeFrame({ requestedRole: 'subordinate', requestedPeerRole: 'peer' })))
      .toThrow(/must be master or peer/)
  })

  it('refuses an outbound master/master role pair at the initiator start boundary', () => {
    // This path builds the outbound propose locally and never parses a frame, so
    // it pins this module's own `assertRolePair` guard (teams-negotiation.ts:244).
    expect(() => startTeamsNegotiation(initiator({ requestedRole: 'master', requestedPeerRole: 'master' })))
      .toThrow(/master\/master relation is not allowed/)
    // A bilateral pair still starts, so the guard is not refusing every pair.
    expect(startTeamsNegotiation(initiator({ requestedRole: 'peer', requestedPeerRole: 'peer' })).state.state)
      .toBe('awaiting-context')
  })

  it('refuses a stale target generation and answers with a typed reject instead of an agreement', () => {
    const step = receiveTeamsNegotiationFrame(startTeamsNegotiation(responder()).state, proposeFrame({ targetGeneration: 21 }))
    expect(step.state.state).toBe('rejected')
    expect(negotiationFault(step.state)).toMatchObject({ code: 'STALE_GENERATION' })
    expect(step.outbound).toMatchObject({ kind: 'teams.connection.reject', requestId: 'req-1', connectionId: 'conn-b' })
    expect(() => negotiatedAgreement(step.state)).toThrow(AcpError)
  })

  it('refuses an unauthorized capability without downgrading the requested set', () => {
    const step = receiveTeamsNegotiationFrame(startTeamsNegotiation(responder()).state,
      proposeFrame({ requestedCapabilities: ['method:session/prompt', 'method:fs/write'] }))
    expect(step.state.state).toBe('rejected')
    expect(negotiationFault(step.state)).toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(step.outbound).toMatchObject({ kind: 'teams.connection.reject' })
  })

  it('refuses a capability revision conflict and a propose that names another connection', () => {
    const staleRevision = receiveTeamsNegotiationFrame(startTeamsNegotiation(responder()).state,
      proposeFrame({ targetCapabilitiesRevision: 'cap-other' }))
    expect(negotiationFault(staleRevision.state)).toMatchObject({ code: 'CONFLICT' })

    const wrongConnection = receiveTeamsNegotiationFrame(startTeamsNegotiation(responder()).state,
      proposeFrame({ connectionId: 'conn-forged' }))
    expect(negotiationFault(wrongConnection.state)).toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a relation role outside the daemon accepted relations', () => {
    const step = receiveTeamsNegotiationFrame(startTeamsNegotiation(responder({ allowedRoles: ['peer'] })).state, proposeFrame())
    expect(negotiationFault(step.state)).toMatchObject({ code: 'FORBIDDEN' })
    expect(step.outbound).toMatchObject({ kind: 'teams.connection.reject' })
  })

  it('refuses a stale context generation and capability revision at the initiator boundary', () => {
    const state = startTeamsNegotiation(initiator()).state
    // engineInstanceId is present in both cases so each isolates its own failure.
    expect(() => receiveTeamsNegotiationFrame(state, {
      version: 1,
      kind: 'teams.connection.context',
      connectionId: 'conn-b',
      targetGeneration: 21,
      capabilitiesRevision: 'cap-b',
      policyRevision: 7,
      engineInstanceId: 'engine-b',
    })).toThrow(/stale target generation/)
    expect(() => receiveTeamsNegotiationFrame(state, {
      version: 1,
      kind: 'teams.connection.context',
      connectionId: 'conn-b',
      targetGeneration: 22,
      capabilitiesRevision: 'cap-other',
      policyRevision: 7,
      engineInstanceId: 'engine-b',
    })).toThrow(/target capability revision/)
  })

  it('refuses a frame that does not belong to the current negotiation state', () => {
    const state = startTeamsNegotiation(initiator()).state
    const { accept } = handshake()
    expect(() => receiveTeamsNegotiationFrame(state, {
      version: 1,
      kind: 'teams.connection.ready',
      requestId: 'req-1',
      agreement: (accept as { agreement: TeamsAgreement }).agreement,
    })).toThrow(/unexpected teams.connection.ready/)
  })

  it('refuses an accept whose agreement does not echo the proposal', () => {
    const { accept } = handshake()
    const genuine = (accept as { agreement: TeamsAgreement }).agreement
    const tampered: TeamsAgreement = { ...genuine, capabilities: ['method:fs/write'] }
    let state = startTeamsNegotiation(initiator()).state
    state = receiveTeamsNegotiationFrame(state, startTeamsNegotiation(responder()).outbound!).state
    expect(() => receiveTeamsNegotiationFrame(state, {
      version: 1,
      kind: 'teams.connection.accept',
      requestId: 'req-1',
      agreement: tampered,
    })).toThrow(/does not echo the proposal/)
    expect(() => receiveTeamsNegotiationFrame(state, {
      version: 1,
      kind: 'teams.connection.accept',
      requestId: 'req-other',
      agreement: genuine,
    })).toThrow(/correlation/)
  })

  it('refuses a tampered target policy revision in the accept agreement with CONFLICT', () => {
    const { accept } = handshake()
    const genuine = (accept as { agreement: TeamsAgreement }).agreement
    // The responder authenticated `context.policyRevision` (7) as its own fact.
    // An accept that echoes a different target revision is a conflict, not trust.
    const tampered: TeamsAgreement = { ...genuine, targetPolicyRevision: genuine.targetPolicyRevision + 1 }
    const state = receiveTeamsNegotiationFrame(
      startTeamsNegotiation(initiator()).state,
      startTeamsNegotiation(responder()).outbound!,
    ).state
    expect(state.targetPolicyRevision).toBe(7)
    expect(thrownCode(() => receiveTeamsNegotiationFrame(state, {
      version: 1,
      kind: 'teams.connection.accept',
      requestId: 'req-1',
      agreement: tampered,
    }))).toBe('CONFLICT')
  })

  it('produces a typed fault on timeout or a one-sided handshake and never an agreement', () => {
    const timedOut = timeoutTeamsNegotiation(startTeamsNegotiation(initiator()).state)
    expect(timedOut.state).toBe('rejected')
    expect(negotiationFault(timedOut)).toMatchObject({ code: 'RESULT_UNKNOWN' })
    expect(() => negotiatedAgreement(timedOut)).toThrow(AcpError)
    expect(() => timeoutTeamsNegotiation(handshake().initiator)).toThrow(AcpError)
    expect(() => negotiationFault(handshake().initiator)).toThrow(AcpError)
  })

  it('surfaces a peer reject as a typed fault and never opens ACP', () => {
    let state = startTeamsNegotiation(initiator()).state
    state = receiveTeamsNegotiationFrame(state, startTeamsNegotiation(responder()).outbound!).state
    const fault: AcpFault = { code: 'CAPABILITY_DENIED', message: 'capability refused' }
    const step = receiveTeamsNegotiationFrame(state, {
      version: 1,
      kind: 'teams.connection.reject',
      requestId: 'req-1',
      connectionId: 'conn-b',
      error: fault,
    })
    expect(step.state.state).toBe('rejected')
    expect(negotiationFault(step.state)).toEqual(fault)
    expect(step.outbound).toBeUndefined()
    expect(() => negotiatedAgreement(step.state)).toThrow(AcpError)
  })

  it('runs a full handshake over a read/send port and reports a typed fault when the peer goes silent', async () => {
    const responderOptions = responder()
    const initiatorOptions = initiator()
    let responderState = startTeamsNegotiation(responderOptions).state
    const inbound: TeamsConnectionFrame[] = []
    const initiatorPort = {
      read: async (): Promise<unknown> => inbound.shift() ?? await new Promise(() => undefined),
      send: async (frame: TeamsConnectionFrame): Promise<void> => {
        if (frame.kind === 'teams.connection.propose') {
          const accepted = receiveTeamsNegotiationFrame(responderState, frame)
          responderState = accepted.state
          inbound.push(accepted.outbound!)
        } else if (frame.kind === 'teams.connection.confirm') {
          const ready = receiveTeamsNegotiationFrame(responderState, frame)
          responderState = ready.state
          inbound.push(ready.outbound!)
        }
      },
    }
    inbound.push(startTeamsNegotiation(responderOptions).outbound!)
    const agreed = await runTeamsNegotiation({ options: initiatorOptions, port: initiatorPort, timeoutMs: 500 })
    expect(agreed.state).toBe('agreed')
    expect(responderState.state).toBe('agreed')
    expect(negotiatedAgreement(agreed)).toEqual(negotiatedAgreement(responderState))

    const silent = await runTeamsNegotiation({
      options: initiator({ requestId: 'req-silent' }),
      port: { read: async () => await new Promise(() => undefined), send: async () => undefined },
      timeoutMs: 20,
    })
    expect(silent.state).toBe('rejected')
    expect(negotiationFault(silent)).toMatchObject({ code: 'RESULT_UNKNOWN' })
  })
})
