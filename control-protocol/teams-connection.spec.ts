import { describe, expect, it } from 'vitest'
import type { TeamsAgreement, TeamsConnectionFrame } from './teams-connection.ts'
import { parseTeamsConnectionFrame } from './teams-connection.ts'

const source = { accountId: 'local', scopeId: 'local', agentId: 'reasoner' }
const target = { accountId: 'local', scopeId: 'local', agentId: 'other' }

const agreement: TeamsAgreement = {
  connectionId: 'connection-1',
  relationRevision: 1,
  source,
  target,
  sourceRole: 'master',
  targetRole: 'peer',
  sourceGeneration: 3,
  targetGeneration: 4,
  sourceCapabilitiesRevision: 'caps-a',
  targetCapabilitiesRevision: 'caps-b',
  sourcePolicyRevision: 2,
  targetPolicyRevision: 5,
  capabilities: ['acp', 'method:session/prompt'],
}

const ref = { connectionId: 'connection-1', channelId: 'channel-1', targetGeneration: 4, engineInstanceId: 'engine-1' }

const frames: readonly TeamsConnectionFrame[] = [
  {
    version: 1,
    kind: 'teams.connection.propose',
    requestId: 'request-1',
    connectionId: 'connection-1',
    sourceGeneration: 3,
    targetGeneration: 4,
    sourceCapabilitiesRevision: 'caps-a',
    targetCapabilitiesRevision: 'caps-b',
    requestedRole: 'master',
    requestedPeerRole: 'peer',
    requestedCapabilities: ['acp'],
  },
  { version: 1, kind: 'teams.connection.accept', requestId: 'request-1', agreement },
  { version: 1, kind: 'teams.connection.reject', requestId: 'request-1', connectionId: 'connection-1', error: { code: 'FORBIDDEN', message: 'denied' } },
  { version: 1, kind: 'teams.connection.confirm', requestId: 'request-1', agreement },
  { version: 1, kind: 'teams.connection.ready', requestId: 'request-1', agreement },
  { version: 1, kind: 'acp.open', ref },
  { version: 1, kind: 'acp.open_ack', ref },
  { version: 1, kind: 'acp.frame', ref, frame: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [] }, extension: { keep: true } } },
  { version: 1, kind: 'acp.close', ref },
  { version: 1, kind: 'acp.error', ref, error: { code: 'CONFLICT', message: 'session owned' } },
  { version: 1, kind: 'teams.connection.context', connectionId: 'connection-1', targetGeneration: 4, capabilitiesRevision: 'caps-b' },
]

function failure(run: () => unknown): unknown {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeDefined()
  return error
}

describe('Teams connection frames', () => {
  it('parses every bilateral negotiation and ACP channel frame losslessly', () => {
    for (const frame of frames) expect(parseTeamsConnectionFrame(frame)).toBe(frame)
  })

  it('preserves the nested ACP frame including legal extensions', () => {
    const parsed = parseTeamsConnectionFrame(frames[7])
    expect(parsed).toBe(frames[7])
    if (parsed.kind === 'acp.frame') expect(parsed.frame.extension).toEqual({ keep: true })
  })

  it('carries the responder transport-owner context before proposal', () => {
    const context = { version: 1 as const, kind: 'teams.connection.context' as const, connectionId: 'connection-1', targetGeneration: 4, capabilitiesRevision: 'caps-b' }
    expect(parseTeamsConnectionFrame(context)).toBe(context)
    expect(failure(() => parseTeamsConnectionFrame({ ...context, targetGeneration: 0 }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({ ...context, extra: true }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
  })

  it('rejects invalid roles, identity, and generation values', () => {
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[1],
      agreement: { ...agreement, sourceRole: 'subordinate' },
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[1],
      agreement: { ...agreement, sourceRole: 'master', targetRole: 'master' },
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[1],
      agreement: { ...agreement, source: { ...source }, target: { ...source } },
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[1],
      agreement: { ...agreement, targetGeneration: 0 },
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
  })

  it('requires a mandatory, ordered, non-guessed role pair on proposal', () => {
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[0],
      requestedPeerRole: undefined,
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[0],
      requestedRole: 'master',
      requestedPeerRole: 'master',
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[0],
      requestedPeerRole: 'subordinate',
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(parseTeamsConnectionFrame({ ...frames[0], requestedRole: 'peer', requestedPeerRole: 'master' })).toBeDefined()
    expect(parseTeamsConnectionFrame({ ...frames[0], requestedRole: 'peer', requestedPeerRole: 'peer' })).toBeDefined()
  })

  it('rejects extra fields, stale versions, and invalid nested faults or ACP frames', () => {
    expect(failure(() => parseTeamsConnectionFrame({ ...frames[0], extra: true }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({ ...frames[0], version: 2 }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[2],
      error: { code: 'MADE_UP', message: 'no' },
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    expect(failure(() => parseTeamsConnectionFrame({
      ...frames[7],
      frame: { jsonrpc: '2.0', id: null, method: 'x' },
    }))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
  })
})
