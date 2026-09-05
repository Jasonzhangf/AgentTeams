import { describe, expect, it } from 'vitest'
import type { OpenCodeHostFacade } from '../opencode-adapter/src/index.ts'
import { createAgentHostBinding, createAgentHostConfig } from './agent-host.ts'

const facade = {
  projection: () => ({
    sessions: [{ id: 'ses-1', title: 'Session' }],
    notifications: { pending: [], processed: [] },
  }),
  actions: {
    openSession: async () => undefined,
    sendMessage: async () => undefined,
    replyPermission: async () => undefined,
    acknowledgeNotification: () => undefined,
  },
} as unknown as OpenCodeHostFacade

const config = {
  hostId: 'host-a',
  machineId: 'machine-a',
  agentId: 'agent-a',
  agentKind: 'opencode' as const,
  accountId: 'account-a',
  label: 'OpenCode A',
  endpoint: 'https://server.test',
  authMode: 'shared-token' as const,
  credentialRef: 'cred:opencode',
  capabilitiesRevision: 'cap-1',
  openCodeDirectory: '/workspace',
}

describe('Teams Agent Host config and OpenCode binding', () => {
  it('validates agent host control config', () => {
    expect(createAgentHostConfig(config).hostId).toBe('host-a')
    expect(() => createAgentHostConfig({ ...config, endpoint: 'not-a-url' })).toThrow(/endpoint/)
    expect(() => createAgentHostConfig({ ...config, credentialRef: undefined })).toThrow(/credentialRef/)
  })

  it('binds OpenCode facade actions and registration without business payload', () => {
    const binding = createAgentHostBinding(config, facade)
    expect(binding.projection().sessionIds).toEqual(['ses-1'])
    expect(binding.registration().routeCandidates[0].endpoint).toBe('https://server.test')
    expect(binding.registration()).not.toHaveProperty('sessionId')
    expect(binding.registration()).not.toHaveProperty('permissionId')
  })
})
