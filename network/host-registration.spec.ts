import { describe, expect, it } from 'vitest'
import { createHostDirectory } from '../server/directory.ts'
import { registerAgentHost } from './host-registration.ts'

const config = { endpoint: 'https://hub.test', authMode: 'shared-token' as const, credentialRef: 'cred:hub' }
const link = { endpoint: config.endpoint, status: 'connected' as const, generation: 1 }

const baseRequest = {
  hostId: 'host-a',
  machineId: 'machine-a',
  agentId: 'agent-a',
  agentKind: 'opencode' as const,
  accountId: 'account-a',
  capabilitiesRevision: 'cap-1',
  authMode: config.authMode,
  routeCandidates: [
    {
      candidateId: 'candidate-1',
      kind: 'relay-ws' as const,
      endpoint: 'https://relay.test/ws',
      authRequired: true,
      lastSeenAt: '2026-09-04T00:00:00.000Z',
    },
  ],
}

describe('Teams Agent Host registration boundary', () => {
  it('publishes host presence only after a valid connected link and credentials', () => {
    const result = registerAgentHost(
      createHostDirectory(),
      link,
      config,
      { ...baseRequest, configuredCredential: 'opaque', presentedCredential: 'opaque' },
      '2026-09-04T00:00:00.000Z',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.directory.hosts.get('host-a')?.machineId).toBe('machine-a')
      expect(result.registration.routeCandidates[0].endpoint).toBe('https://relay.test/ws')
    }
  })

  it('fails explicitly on credential mismatch without changing directory', () => {
    const directory = createHostDirectory()
    const result = registerAgentHost(directory, link, config, {
      ...baseRequest,
      configuredCredential: 'opaque',
      presentedCredential: 'wrong',
    })
    expect(result).toMatchObject({ ok: false, reason: 'credential_mismatch' })
    expect(directory.hosts.size).toBe(0)
  })

  it('fails explicitly when the runtime link is not connected to the configured endpoint', () => {
    const result = registerAgentHost(createHostDirectory(), { ...link, status: 'disconnected' }, config, {
      ...baseRequest,
      configuredCredential: 'opaque',
      presentedCredential: 'opaque',
    })
    expect(result).toMatchObject({ ok: false, reason: 'link_not_connected' })
  })

  it('rejects invalid registration control payloads without writing a host', () => {
    const result = registerAgentHost(createHostDirectory(), link, config, {
      ...baseRequest,
      routeCandidates: [],
      configuredCredential: 'opaque',
      presentedCredential: 'opaque',
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_request' })
  })
})
