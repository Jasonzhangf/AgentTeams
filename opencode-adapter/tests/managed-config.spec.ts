import { expect, it } from 'vitest'
import { createOpenCodeLaunchConfig } from '../src/managed-config.ts'

it('derives a primary and explicit backup without putting credential values in config', () => {
  const result = createOpenCodeLaunchConfig({ agentId: 'a', acceptedRevision: 3,
    primary: { provider: 'rcc', model: 'primary', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:4444/v1', credentialRef: 'rcc-ref' },
    backup: { provider: 'backup', model: 'other', protocol: 'openai-responses', baseUrl: 'https://example.test/v1', credentialRef: 'backup-ref' } })
  expect(result.config.model).toBe('rcc/primary')
  expect(result.config.enabled_providers).toEqual(['rcc', 'backup'])
  expect(result.config.provider.rcc.npm).toBe('@ai-sdk/openai-compatible')
  expect(result.config.provider.backup.npm).toBe('@ai-sdk/openai')
  expect(result.config.provider.rcc.options.apiKey).toBe('{env:TEAMS_PROVIDER_0}')
  expect(result.credentialReferences).toEqual({ TEAMS_PROVIDER_0: 'rcc-ref', TEAMS_PROVIDER_1: 'backup-ref' })
  expect(JSON.stringify(result.config)).not.toContain('backup-ref')
})

it('combines two selected models under the same provider and keeps no-auth explicit', () => {
  const primary = { provider: 'local', model: 'one', protocol: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:4444/v1' }
  const result = createOpenCodeLaunchConfig({ agentId: 'a', acceptedRevision: 0, primary, backup: { ...primary, model: 'two' } })
  expect(Object.keys(result.config.provider.local.models)).toEqual(['one', 'two'])
  expect(result.credentialReferences).toEqual({})
  expect(result.config.provider.local.options.apiKey).toBeUndefined()
  expect(result.config.provider.local.env).toEqual([])
})

it('rejects two models for one provider when credential references disagree', () => {
  expect(() => createOpenCodeLaunchConfig({ agentId: 'a', acceptedRevision: 0,
    primary: { provider: 'same', model: 'one', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:4444/v1', credentialRef: 'first' },
    backup: { provider: 'same', model: 'two', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:4444/v1', credentialRef: 'second' },
  })).toThrow(/disagree/)
})
