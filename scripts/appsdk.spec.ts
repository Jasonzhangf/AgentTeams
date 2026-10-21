import { describe, expect, it } from 'vitest'
import { resolveSdkBinary } from './appsdk.mjs'

/**
 * The pinned SDK binary owns the governance files `verify` rewrites. A wrong
 * binary silently changes tracked files, so the resolver must prefer the pin.
 */
describe('resolveSdkBinary', () => {
  it('uses the project pin when the pinned binary is installed', () => {
    const binary = resolveSdkBinary({
      projectRoot: '/repo',
      isExecutable: path => path === '/repo/.appsdk/sdk.bin',
    })
    expect(binary).toBe('/repo/.appsdk/sdk.bin')
  })

  it('falls back to PATH when the project has no pinned binary', () => {
    const binary = resolveSdkBinary({ projectRoot: '/repo', isExecutable: () => false })
    expect(binary).toBe('appsdk')
  })
})
