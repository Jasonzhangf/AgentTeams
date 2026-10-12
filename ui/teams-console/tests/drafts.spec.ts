import { describe, expect, it } from 'vitest'
import { createSessionStorageDrafts, readDraft, readFocus, readPage, writeDraft, writeFocus, writePage } from '../src/client/drafts.ts'

function storageLike() {
  const values = new Map<string, string>()
  let reads = 0
  return {
    values,
    storageReads: () => reads,
    storage: {
      getItem: (key: string) => { reads += 1; return values.get(key) ?? null },
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => { values.clear() },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size },
    } as unknown as Storage,
  }
}

describe('Teams Console draft persistence', () => {
  it('uses the injected session storage only for drafts, focus, and page state', () => {
    const { storage, values, storageReads } = storageLike()
    const persistence = createSessionStorageDrafts(storage)
    writeDraft(persistence, 'message', 'hello')
    writeDraft(persistence, 'networking', [{ agentId: 'planner', role: 'master' }])
    writeFocus(persistence, 'drawer-1')
    writePage(persistence, 'history')

    expect(readDraft<string>(persistence, 'message')).toBe('hello')
    expect(readDraft(persistence, 'networking')).toEqual([{ agentId: 'planner', role: 'master' }])
    expect(readFocus(persistence)).toBe('drawer-1')
    expect(readPage(persistence, ['discovery', 'networking', 'interaction', 'history'])).toBe('history')
    // Each read touches the injected storage exactly once, and no read writes.
    expect(storageReads()).toBe(4)
    expect([...values.keys()]).toEqual([
      'teams-console-draft:message',
      'teams-console-draft:networking',
      'teams-console-draft:teams-console-focus',
      'teams-console-draft:teams-console-page',
    ])
  })

  it('ignores invalid JSON and rejects an unknown page without throwing', () => {
    const { storage } = storageLike()
    storage.setItem('teams-console-draft:message', '{bad')
    storage.setItem('teams-console-draft:teams-console-focus', '"drawer-1"')
    storage.setItem('teams-console-draft:teams-console-page', '"not-a-page"')
    const persistence = createSessionStorageDrafts(storage)

    expect(readDraft<string>(persistence, 'message')).toBeUndefined()
    expect(readFocus(persistence)).toBe('drawer-1')
    expect(readPage(persistence, ['history'])).toBeUndefined()
  })
})
