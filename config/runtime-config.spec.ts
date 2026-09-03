import { describe, expect, it } from 'vitest'
import { saveAgentRuntimeConfig, syncSharedRuntimeConfig } from './runtime-config.ts'

describe('Teams config owner', () => {
  const config = { revision: 3, agents: {} }

  it('syncs after admission and saves one agent config with CAS', () => {
    const synced = syncSharedRuntimeConfig(config, true)
    const saved = saveAgentRuntimeConfig(synced, 'planner', { provider: 'rcc', model: 'deepseek-v4' }, 3)
    expect(saved).toMatchObject({ revision: 4, agents: { planner: { provider: 'rcc', model: 'deepseek-v4' } } })
  })

  it('rejects pre-admission sync and stale revisions', () => {
    expect(() => syncSharedRuntimeConfig(config, false)).toThrow(/before server admission/)
    expect(() => saveAgentRuntimeConfig(config, 'planner', { provider: 'rcc', model: 'deepseek-v4' }, 2)).toThrow(/revision conflict/)
  })
})
