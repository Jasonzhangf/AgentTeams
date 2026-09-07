import { expect, it } from 'vitest'
import { projectConsoleWorkObservations } from './console-work-projection.ts'

it('projects durable Work control fields without request payloads', () => {
  const work = {
    workId: 'offline-work', consumerAgentId: 'consumer', providerAgentId: 'provider',
    capabilityId: 'file-search', capabilityVersion: '1', policyRevision: 1, state: 'closed' as const,
  }
  expect(projectConsoleWorkObservations('provider', [work])).toEqual({
    works: [{ agentId: 'provider', ...work }],
    relations: [{
      agentId: 'provider', consumerAgentId: 'consumer', providerAgentId: 'provider',
      capabilityId: 'file-search', capabilityVersion: '1', relationPermission: 'granted', workId: 'offline-work',
    }],
  })
  expect(JSON.stringify(projectConsoleWorkObservations('provider', [work]))).not.toContain('payload')
  expect(projectConsoleWorkObservations('provider', [{ ...work, state: 'rejected' }]).relations[0].relationPermission).toBe('revoked')
})
