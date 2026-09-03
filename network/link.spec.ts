import { describe, expect, it } from 'vitest'
import { closeLink, connectLink, resolveBootstrapLinkConfig } from './link.ts'

describe('Teams network link boundary', () => {
  it('requires an opaque credential reference for authenticated links', () => {
    expect(() => resolveBootstrapLinkConfig({ endpoint: 'https://hub.test', authMode: 'shared-token' })).toThrow(/credentialRef/)
    expect(resolveBootstrapLinkConfig({ endpoint: 'https://hub.test', authMode: 'none' }).endpoint).toBe('https://hub.test')
  })

  it('increments connection generation and closes explicitly', () => {
    const first = connectLink({ endpoint: 'https://hub.test', authMode: 'none' })
    const second = connectLink({ endpoint: first.endpoint, authMode: 'none' }, first)
    expect(second.generation).toBe(2)
    expect(closeLink(second).status).toBe('disconnected')
  })
})
