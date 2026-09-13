import { expect, it, vi } from 'vitest'
import type { AgentWorkClient } from './agent-work-client.ts'
import { runConfiguredWork, type AgentConnectionIntent } from './agent-process.ts'

const intent: AgentConnectionIntent = {
  targetAgentId: 'provider', capabilityId: 'file-search', capabilityVersion: '1', operation: 'search',
  workId: 'work', requestId: 'request', demands: [{ resourceId: 'search-slot', amount: 1 }], payload: { query: 'x' },
}

it('closes an accepted Work after a confirmed failed request before surfacing the error', async () => {
  const close = vi.fn(async () => ({ workId: 'work', state: 'closed' }))
  const channel = {
    propose: vi.fn(async () => ({ workId: 'work' })),
    request: vi.fn(async () => ({ control: { state: 'failed', error: { code: 'UPSTREAM_ERROR', message: 'search failed' } } })),
    close,
    dispose: vi.fn(async () => undefined),
  }
  const client = { findProvider: vi.fn(async () => ({ providerAgentId: 'provider', generation: 1, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' })),
    open: vi.fn(async () => channel) } as unknown as AgentWorkClient
  await expect(runConfiguredWork(client, intent, 1)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
  expect(close).toHaveBeenCalledWith('work')
  expect(channel.dispose).toHaveBeenCalledOnce()
})
