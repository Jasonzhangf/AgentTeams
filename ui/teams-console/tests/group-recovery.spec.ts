import { describe, expect, it } from 'vitest'
import { TeamsConsoleController } from '../src/state/controller.ts'
import { createGroupRequestClient, withGroupRequests } from '../src/client/group-client.ts'
import type { GroupWireRequest } from '../../../packages/shared/src/group-wire.ts'

/**
 * R1 recovery counterexample through the real group client, controller and the shipped
 * HTTP envelope mapping. `fetchImpl` returns real `Response` values exactly as the Console
 * group endpoint does, so the status/ok/error-code separation exercised here is the same
 * mapping the browser uses. It counts one external issue write and drops that write's
 * receipt, then proves a retry reuses the original commit without a second external write.
 */

const projection = {
  version: 1 as const,
  agents: [
    { kind: 'runtime' as const, agentId: 'agent-a', label: 'Agent A', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const },
  ],
  sessions: [],
  notifications: [],
  configs: [],
}

const group = {
  groupId: 'g1', name: 'Alpha', ownerAgentId: 'agent-a', createdAt: '2026-10-20T00:00:00.000Z',
  members: [{ agentId: 'agent-a', role: 'master' as const, mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] }],
}

const session = {
  sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1',
  initiatorAgentId: 'agent-a', state: 'open' as const, openedAt: 'now', lastOpSeq: 1,
}

function envelope(issueResponse: 'unknown' | 'forbidden') {
  const commits = new Set<string>()
  let externalWrites = 0
  const frames: GroupWireRequest[] = []
  const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { readonly requestId: string; readonly frame: GroupWireRequest }
    const frame = body.frame
    frames.push(frame)
    switch (frame.kind) {
      case 'group.list':
        return ok({ ok: true, reply: { kind: 'group.list', requestId: frame.requestId, groups: [group] } })
      case 'issue.create':
        if (issueResponse === 'forbidden') return ok({ ok: false, error: { code: 'FORBIDDEN', message: 'not permitted' } })
        if (commits.has(frame.commitId)) {
          return ok({ ok: true, reply: { kind: 'issue.session', requestId: frame.requestId, session } })
        }
        commits.add(frame.commitId)
        externalWrites += 1
        return ok({ ok: false, error: { code: 'RESULT_UNKNOWN', message: 'owner wrote, receipt lost' } })
      case 'message.page':
        return ok({ ok: true, reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } })
      case 'issue.list':
        return ok({ ok: true, reply: { kind: 'issue.list', requestId: frame.requestId, sessions: [session] } })
      case 'action.list':
        return ok({ ok: true, reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } })
      default:
        return ok({ ok: true, reply: { kind: 'group.list', requestId: frame.requestId, groups: [group] } })
    }
  }) as typeof fetch
  const base = {
    readProjection: async () => projection,
    command: async () => ({ ok: true as const, kind: 'connection.connect' as const }),
    sendSession: async () => ({ ok: true as const }),
  }
  const controller = new TeamsConsoleController(
    withGroupRequests(base, createGroupRequestClient({ fetchImpl })) as never,
    { initialPage: 'groups' },
  )
  return {
    controller,
    externalWrites: () => externalWrites,
    issueRequests: () => frames.filter(entry => entry.kind === 'issue.create'),
  }
}

describe('group write recovery through the shipped client envelope', () => {
  it('keeps an unknown issue.create retryable and reuses its original commit without a second external write', async () => {
    const harness = envelope('unknown')
    await harness.controller.refresh()
    await harness.controller.loadGroups()
    expect(await harness.controller.createIssue('Lost receipt', 'body', 'p1')).toBe(false)

    const unknown = harness.controller.getSnapshot().group
    expect(unknown.outcome.kind).toBe('unknown')
    expect(unknown.retryable).not.toBeNull()
    const first = harness.issueRequests().at(-1)
    expect(first).toBeDefined()

    expect(await harness.controller.retryGroupMutation()).toBe(true)
    const retried = harness.issueRequests().at(-1)
    expect(harness.externalWrites()).toBe(1)
    expect(retried?.commitId).toBe(first?.commitId)
    expect(retried?.requestId).toBe(first?.requestId)
    expect(harness.controller.getSnapshot().group.outcome.kind).toBe('succeeded')
  })

  it('keeps an ordinary FORBIDDEN issue.create as a definite refusal', async () => {
    const harness = envelope('forbidden')
    await harness.controller.refresh()
    await harness.controller.loadGroups()
    expect(await harness.controller.createIssue('Forbidden', 'body', 'p1')).toBe(false)
    const state = harness.controller.getSnapshot().group
    expect(state.outcome).toMatchObject({ kind: 'refused', code: 'FORBIDDEN' })
    expect(state.retryable).toBeNull()
  })
})
