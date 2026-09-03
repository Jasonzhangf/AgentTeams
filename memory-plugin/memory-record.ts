export type MemoryState = 'summarizing' | 'pending-save' | 'saved' | 'loaded' | 'exported' | 'error'
export interface MemoryRecord { readonly memoryId: string; readonly machineId: string; readonly agentId: string; readonly sessionId: string; readonly title: string; readonly summary: string; readonly keywords: readonly string[]; readonly state: MemoryState; readonly createdAt: string; readonly updatedAt: string }

export function summarizeSessionMemory(input: Omit<MemoryRecord, 'state'>): MemoryRecord {
  if (input.sessionId.length === 0 || input.summary.trim().length === 0) throw new Error('memory: session and summary are required')
  return { ...input, state: 'pending-save' }
}

export function validateMemoryDraft(draft: MemoryRecord): MemoryRecord {
  if (draft.state !== 'pending-save') throw new Error(`memory: expected pending-save, got ${draft.state}`)
  if (draft.summary.trim().length === 0) throw new Error('memory: summary cannot be empty')
  return draft
}

export function saveMemoryRecord(draft: MemoryRecord): MemoryRecord { return { ...validateMemoryDraft(draft), state: 'saved', updatedAt: new Date().toISOString() } }
export function loadMemoryRecord(record: MemoryRecord): MemoryRecord { if (record.state !== 'saved' && record.state !== 'exported') throw new Error('memory: record is not saved'); return { ...record, state: 'loaded' } }
export function exportMemoryRecord(record: MemoryRecord): MemoryRecord { if (record.state !== 'saved' && record.state !== 'loaded') throw new Error('memory: record is not loadable'); return { ...record, state: 'exported', updatedAt: new Date().toISOString() } }
