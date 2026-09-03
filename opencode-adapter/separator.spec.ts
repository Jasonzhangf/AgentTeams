import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dshAdapter = readFileSync(join('Teams/ui/teams-console/src/client/index.ts'), 'utf8')
const opencodeAdapter = readFileSync(join('Teams/opencode-adapter/src/index.ts'), 'utf8')
const dshIdentity = readFileSync(join('Teams/dsh-adapter/agent-identity.ts'), 'utf8')

describe('DSH and OpenCode adapter separation', () => {
  it('DSH adapter never imports the OpenCode adapter or its types', () => {
    expect(dshAdapter.includes('opencode-adapter')).toBe(false)
    expect(dshAdapter.includes('OpenCodePlugin')).toBe(false)
    expect(dshAdapter.includes('OpenCodeHooks')).toBe(false)
    expect(dshIdentity.includes('opencode-adapter')).toBe(false)
    expect(dshIdentity.includes('OpenCodePlugin')).toBe(false)
  })

  it('OpenCode adapter never imports the DSH client-ui runtime types', () => {
    expect(opencodeAdapter.includes('@deepseek-ai/dsh-client-runtime/client')).toBe(false)
    expect(opencodeAdapter.includes('@deepseek-ai/dsh-client-ui-slots')).toBe(false)
    expect(opencodeAdapter.includes('@deepseek-ai/dsh-client-ui-sidebar/client')).toBe(false)
    expect(opencodeAdapter.includes('@deepseek-ai/dsh-client-ui-conversation')).toBe(false)
  })

  it('OpenCode adapter uses PluginInput and Hooks shape, not ClientContext', () => {
    expect(opencodeAdapter.includes('OpenCodePluginInput')).toBe(true)
    expect(opencodeAdapter.includes('OpenCodeHooks')).toBe(true)
    expect(opencodeAdapter.includes('OpenCodeEvent')).toBe(true)
    expect(opencodeAdapter.includes('ClientContext')).toBe(false)
  })
})
