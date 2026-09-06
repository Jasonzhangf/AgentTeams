import { describe, expect, it } from 'vitest'
import { parseConsoleCommand } from './console-api.ts'

describe('Console control ingress', () => {
  it('admits each frozen command without changing it', () => {
    const commands = [
      { kind: 'session.open', agentId: 'a', sessionId: 's' },
      { kind: 'permission.reply', agentId: 'a', sessionId: 's', permissionId: 'p', decision: 'reject' },
      { kind: 'notification.ack', agentId: 'a', notificationId: 'n' },
      { kind: 'config.refreshModels', agentId: 'a', expectedRevision: 0, providerId: 'p' },
      { kind: 'config.bindModel', agentId: 'a', expectedRevision: 1, providerId: 'p', modelId: 'm' },
      { kind: 'config.apply', agentId: 'a' },
      { kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: {
        id: 'p', label: 'P', protocol: 'openai-responses', apiBaseUrl: 'https://example.test/v1', enabled: true,
        auth: { kind: 'bearer', credentialRef: 'provider/p' },
      } },
    ]
    for (const command of commands) expect(parseConsoleCommand(command)).toEqual(command)
  })

  it('rejects unknown commands, fields and invalid identities or revisions', () => {
    for (const command of [
      null, [], { kind: 'session.delete', agentId: 'a' },
      { kind: 'session.open', agentId: 'a', sessionId: '' },
      { kind: 'config.apply', agentId: 'a', payload: { text: 'business' } },
      { kind: 'config.apply', agentId: 'a', metadata: {} },
      { kind: 'config.bindModel', agentId: 'a', expectedRevision: -1, providerId: 'p', modelId: 'm' },
      { kind: 'config.refreshModels', agentId: 'a', expectedRevision: 0.5, providerId: 'p' },
      { kind: 'permission.reply', agentId: 'a', sessionId: 's', permissionId: 'p', decision: 'yes' },
    ]) expect(() => parseConsoleCommand(command)).toThrow()
  })

  it('rejects inline credentials and surplus nested provider fields', () => {
    const provider = { id: 'p', label: 'P', protocol: 'openai-chat', apiBaseUrl: 'https://example.test/v1', enabled: true }
    for (const auth of [{ kind: 'none', token: 'secret' }, { kind: 'bearer', apiKey: 'secret' }, { kind: 'bearer', credentialRef: '' }]) {
      expect(() => parseConsoleCommand({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: { ...provider, auth } })).toThrow()
    }
    expect(() => parseConsoleCommand({ kind: 'config.putProvider', agentId: 'a', expectedRevision: 0, provider: { ...provider, auth: { kind: 'none' }, payload: {} } })).toThrow()
  })
})
