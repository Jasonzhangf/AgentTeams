import { describe, expect, it } from 'vitest'
import { AcpError } from '../control-protocol/acp.ts'
import type { VersionedRuntimeConfig } from '../config/runtime-config.ts'
import { compileDshNativeConfig, dshProviderRoute } from './native-config.ts'

function config(overrides: Partial<VersionedRuntimeConfig> = {}): VersionedRuntimeConfig {
  return {
    revision: 4,
    acceptedRevision: 4,
    providers: {
      primary: {
        id: 'primary',
        label: 'Primary',
        protocol: 'openai-chat',
        apiBaseUrl: 'https://primary.example/v1',
        enabled: true,
        auth: { kind: 'bearer', credentialRef: 'PRIMARY_KEY' },
      },
      backup: {
        id: 'backup',
        label: 'Backup',
        protocol: 'openai-responses',
        apiBaseUrl: 'https://backup.example/v1',
        enabled: true,
        auth: { kind: 'none' },
      },
    },
    catalogs: {
      primary: {
        state: 'ready',
        entries: [
          { ref: { providerInstanceId: 'primary', modelId: 'model-a' }, origin: 'manual', base: { label: 'Model A' }, overrides: {} },
          { ref: { providerInstanceId: 'primary', modelId: 'model-b' }, origin: 'discovered', base: {}, overrides: {} },
          { ref: { providerInstanceId: 'primary', modelId: 'model-c' }, origin: 'discovered', base: {}, overrides: {}, availability: 'unavailable' },
        ],
      },
      backup: {
        state: 'ready',
        entries: [
          { ref: { providerInstanceId: 'backup', modelId: 'model-z' }, origin: 'manual', base: {}, overrides: {} },
        ],
      },
    },
    agents: {},
    ...overrides,
  }
}

describe('dsh native config derivation', () => {
  it('names the engine route after the Teams provider instance so it cannot collide with a shipped route', () => {
    expect(dshProviderRoute('deepseek-official')).toBe('teams-deepseek-official')
    expect(dshProviderRoute('gateway')).toBe('teams-gateway')
  })

  it('derives both bound routes, keeps the declared catalog and drops unavailable entries', () => {
    const native = compileDshNativeConfig({
      accepted: config(),
      binding: {
        primary: { providerInstanceId: 'primary', modelId: 'model-a' },
        backup: { providerInstanceId: 'backup', modelId: 'model-z' },
      },
    })
    expect(native.providerRoute).toBe('teams-primary')
    expect(native.modelId).toBe('model-a')
    expect(native.modelTargets).toEqual([
      { providerInstanceId: 'primary', modelId: 'model-a' },
      { providerInstanceId: 'backup', modelId: 'model-z' },
    ])
    expect(native.credentialEnvRefs).toEqual({ TEAMS_DSH_CREDENTIAL_0: 'PRIMARY_KEY' })
    const providers = native.patch[0].config.providers
    expect(Object.keys(providers)).toEqual(['teams-primary', 'teams-backup'])
    expect(providers['teams-primary'].models).toEqual([
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'model-b' },
    ])
    expect(providers['teams-backup'].api).toBe('openai-responses')
    expect(providers['teams-backup'].apiKeyEnv).toBeUndefined()
    expect(native.patch[1]).toEqual({ id: 'acp', config: { provider: 'teams-primary', model: 'model-a' } })
  })

  it('is a valid YAML 1.2 patch list because JSON is a YAML subset', () => {
    const native = compileDshNativeConfig({
      accepted: config(),
      binding: { primary: { providerInstanceId: 'primary', modelId: 'model-a' } },
    })
    expect(native.patchContent).toBe(JSON.stringify(native.patch))
    expect(JSON.parse(native.patchContent)).toBeInstanceOf(Array)
  })

  it('rejects a disabled provider, an unready catalog and an undeclared bound model', () => {
    const disabled = config()
    expect(() => compileDshNativeConfig({
      accepted: { ...disabled, providers: { primary: { ...disabled.providers.primary, enabled: false } } },
      binding: { primary: { providerInstanceId: 'primary', modelId: 'model-a' } },
    })).toThrow(AcpError)

    expect(() => compileDshNativeConfig({
      accepted: { ...disabled, catalogs: { primary: { state: 'empty', entries: [] } } },
      binding: { primary: { providerInstanceId: 'primary', modelId: 'model-a' } },
    })).toThrow(AcpError)

    expect(() => compileDshNativeConfig({
      accepted: disabled,
      binding: { primary: { providerInstanceId: 'primary', modelId: 'model-c' } },
    })).toThrow(/model-c/)
  })

  it('rejects a provider that declares no serviceable model at all', () => {
    const source = config()
    expect(() => compileDshNativeConfig({
      accepted: {
        ...source,
        catalogs: {
          primary: {
            state: 'ready',
            entries: [{ ref: { providerInstanceId: 'primary', modelId: 'model-a' }, origin: 'manual', base: {}, overrides: {}, availability: 'unavailable' }],
          },
        },
      },
      binding: { primary: { providerInstanceId: 'primary', modelId: 'model-a' } },
    })).toThrow(AcpError)
  })
})
