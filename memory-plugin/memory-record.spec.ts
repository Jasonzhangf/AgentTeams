import { describe, expect, it } from 'vitest'
import { exportMemoryRecord, loadMemoryRecord, saveMemoryRecord, summarizeSessionMemory } from './memory-record.ts'

describe('Teams memory plugin', () => {
  const input = { memoryId: 'mem-1', machineId: 'm1', agentId: 'a1', sessionId: 's1', title: 'Plan', summary: 'Runtime boundary', keywords: ['runtime'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }
  it('keeps draft distinct through save, load, and export', () => {
    const draft = summarizeSessionMemory(input)
    expect(draft.state).toBe('pending-save')
    const saved = saveMemoryRecord(draft)
    expect(loadMemoryRecord(saved).state).toBe('loaded')
    expect(exportMemoryRecord(saved).state).toBe('exported')
  })
  it('does not load an unsaved draft', () => expect(() => loadMemoryRecord(summarizeSessionMemory(input))).toThrow(/not saved/))
})
