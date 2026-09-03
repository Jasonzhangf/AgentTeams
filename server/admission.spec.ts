import { describe, expect, it } from 'vitest'
import { registerRuntimeConnection } from './admission.ts'

describe('Teams server admission', () => {
  const config = { endpoint: 'https://hub.test', authMode: 'shared-token' as const, credentialRef: 'cred:hub' }
  const link = { endpoint: config.endpoint, status: 'connected' as const, generation: 1 }

  it('admits matching credentials and grants observe permission', () => {
    expect(registerRuntimeConnection(link, config, {
      machineId: 'machine-a', authMode: 'shared-token', configuredCredential: 'opaque', presentedCredential: 'opaque',
    })).toMatchObject({ admitted: true, permission: 'granted' })
  })

  it('denies mismatched credentials without confusing transport state', () => {
    expect(registerRuntimeConnection(link, config, {
      machineId: 'machine-a', authMode: 'shared-token', configuredCredential: 'opaque', presentedCredential: 'wrong',
    })).toMatchObject({ admitted: false, permission: 'denied' })
    expect(link.status).toBe('connected')
  })
})
