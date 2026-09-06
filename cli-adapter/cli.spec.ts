import { describe, expect, it } from 'vitest'
import { parseCliRequest, parseJsonRequestLine, parseStartupOptions } from './cli.ts'

describe('CLI JSON boundary', () => {
  it('accepts only the declared operation fields', () => {
    expect(parseCliRequest({ operation: 'navigate', contextId: 'ctx-1', url: 'https://example.com' })).toEqual({
      operation: 'navigate',
      contextId: 'ctx-1',
      url: 'https://example.com',
    })
    expect(() => parseCliRequest({ operation: 'navigate', contextId: 'ctx-1', url: 'https://example.com', generation: 3 })).toThrowError(/unsupported field generation/)
    expect(() => parseCliRequest({ operation: 'unknown' })).toThrowError(/unsupported operation unknown/)
    expect(() => parseJsonRequestLine('{not-json')).toThrowError(/invalid JSON/)
  })

  it('requires an explicitly configured profile and search root', () => {
    expect(parseStartupOptions(['--profile', 'teams-b1', '--search-root', '/tmp/root'])).toEqual({
      camoExecutable: '/opt/homebrew/bin/camo',
      searchExecutable: '/opt/homebrew/bin/rg',
      profile: 'teams-b1',
      searchRoot: '/tmp/root',
      headless: true,
    })
    expect(() => parseStartupOptions(['--profile', 'teams-b1'])).toThrowError(/searchRoot must be a non-empty string/)
    expect(() => parseStartupOptions(['--search-root', '/tmp/root'])).toThrowError(/profile must be a non-empty string/)
  })
})
