import { expect, it, vi } from 'vitest'
import { createConsoleIngress } from './console-ingress.ts'

function setup(allowed = true) {
  const client = {
    readProjection: vi.fn(async () => ({ version: 1 as const, agents: [], sessions: [], notifications: [], configs: [] })),
    command: vi.fn(async () => ({ ok: true as const })),
    sendSession: vi.fn(async () => ({ ok: true as const })),
  }
  const authorize = vi.fn(() => allowed)
  const ingress = createConsoleIngress({ agentId: 'target', generation: () => 2, client, authorize },
    { accountId: 'account', scopeId: 'scope', agentId: 'console' })
  return { ingress, client, authorize }
}
it('checks generation, target and independent management authorization before owner calls', async () => {
  const denied = setup(false)
  const request = { kind: 'console.command' as const, correlationId: 'r', targetGeneration: 2, command: { kind: 'config.apply' as const, agentId: 'target' } }
  expect(await denied.ingress(request)).toMatchObject({ kind: 'console.result', correlationId: 'r', result: { ok: false, error: { code: 'FORBIDDEN' } } })
  expect(denied.client.command).not.toHaveBeenCalled()
  const live = setup()
  expect(await live.ingress({ ...request, targetGeneration: 1 })).toMatchObject({ result: { error: { code: 'STALE_GENERATION' } } })
  expect(await live.ingress({ ...request, command: { ...request.command, agentId: 'other' } })).toMatchObject({ result: { error: { code: 'FORBIDDEN' } } })
  expect(live.authorize).not.toHaveBeenCalled()
  expect(live.client.command).not.toHaveBeenCalled()
})
it('passes authenticated principal to policy and preserves Session business content', async () => {
  const { ingress, client, authorize } = setup()
  const payload = [{ metadata: { generation: 'business' }, command: 'text' }]
  const request = { kind: 'console.session' as const, correlationId: 'r', targetGeneration: 2, agentId: 'target', sessionId: 's', payload }
  expect(await ingress(request)).toEqual({ kind: 'console.result', correlationId: 'r', result: { ok: true } })
  expect(authorize).toHaveBeenCalledWith({ accountId: 'account', scopeId: 'scope', agentId: 'console' }, { kind: 'session', agentId: 'target', sessionId: 's' })
  expect(client.sendSession).toHaveBeenCalledWith({ agentId: 'target', sessionId: 's' }, payload)
  expect(client.command).not.toHaveBeenCalled()
})
it('does not convert an unknown owner failure into a successful reply', async () => {
  const { ingress, client } = setup()
  client.command.mockRejectedValueOnce(new Error('outcome unknown'))
  await expect(ingress({ kind: 'console.command', correlationId: 'r', targetGeneration: 2,
    command: { kind: 'config.apply', agentId: 'target' } })).rejects.toThrow('outcome unknown')
  expect(client.command).toHaveBeenCalledTimes(1)
})
