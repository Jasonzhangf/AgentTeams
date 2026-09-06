import { describe, expect, it } from 'vitest'
import { messages } from '../src/client/locale.ts'

describe('Chinese console copy', () => {
  it('uses Chinese labels for user-facing technical terms', () => {
    const t = messages('zh')
    expect(t.topology).toBe('智能体')
    expect(t.conversations).toBe('会话')
    expect(t.providerConfig).toBe('服务与模型')
    expect(t.selectModel).toBe('选择模型')
    expect(t.noAgentConfig).toBe('该智能体没有可用的配置数据。')
  })
})
