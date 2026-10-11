import { describe, expect, it } from 'vitest'
import { createSessionStorageDrafts, readDraft, readFocus, readPage, writeDraft, writeFocus, writePage } from '../src/client/drafts.ts'

function storageLike() {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
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
    const { storage, values } = storageLike()
    const persistence = createSessionStorageDrafts(storage)
    writeDraft(persistence, 'message', 'hello')
    writeDraft(persistence, 'networking', [{ agentId: 'planner', role: 'master' }])
    writeFocus(persistence, 'drawer-1')
    writePage(persistence, 'history')

    expect(readDraft<string>(persistence, 'message')).toBe('hello')
    expect(readDraft(persistence, 'networking')).toEqual([{ agentId: 'planner', role: 'master' }])
    expect(readFocus(persistence)).toBe('drawer-1')
    expect(readPage(persistence, ['discovery', 'networking', 'interaction', 'history'])).toBe('history')
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

  it('does not call storage when persistence is absent', () => {
    let calls = 0
    const persistence = { getItem: () => { calls += 1; return null }, setItem: () => { calls += 1 } }
    readDraft(persistence, 'message')
    readFocus(persistence)
    readPage(persistence, ['history'])

    expect(calls).toBe(3)
  })
})
