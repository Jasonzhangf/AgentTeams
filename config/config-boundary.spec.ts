import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const config = readFileSync(join('Teams/config/runtime-config.ts'), 'utf8')
const ui = readFileSync(join('Teams/ui/teams-console/src/client/TeamsOverlay.tsx'), 'utf8')

describe('Per-Agent provider/model boundary', () => {
  it('config owns save/apply for agent runtime config with revision CAS', () => {
    expect(config.includes('export function saveAgentRuntimeConfig')).toBe(true)
    expect(config.includes('expectedRevision')).toBe(true)
    expect(config.includes('config.revision + 1')).toBe(true)
    expect(config.includes('provider.length === 0')).toBe(true)
    expect(config.includes('model.length === 0')).toBe(true)
  })

  it('sync is blocked before server admission', () => {
    expect(config.includes('cannot sync before server admission')).toBe(true)
    expect(config.includes('syncSharedRuntimeConfig')).toBe(true)
    expect(config.includes('admitted')).toBe(true)
  })

  it('Teams UI never writes provider or model directly', () => {
    expect(ui.includes('config.saveAgentRuntimeConfig')).toBe(false)
    expect(ui.includes('provider.length === 0')).toBe(false)
    expect(ui.includes('model.length === 0')).toBe(false)
  })
})
