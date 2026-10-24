export interface DraftPersistence {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const PREFIX = 'teams-console-draft:'
export const DRAFT_STORAGE_KEYS = {
  message: 'message',
  networking: 'networking',
  focus: 'teams-console-focus',
  page: 'teams-console-page',
} as const

export function createSessionStorageDrafts(storage: Storage): DraftPersistence {
  return storage
}

export function readDraft<T>(persistence: DraftPersistence | undefined, key: string): T | undefined {
  if (persistence === undefined) return undefined
  const raw = persistence.getItem(PREFIX + key)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function writeDraft(persistence: DraftPersistence | undefined, key: string, value: unknown): void {
  persistence?.setItem(PREFIX + key, JSON.stringify(value))
}

export function readFocus(persistence: DraftPersistence | undefined): string | undefined {
  const value = readDraft<string>(persistence, DRAFT_STORAGE_KEYS.focus)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function writeFocus(persistence: DraftPersistence | undefined, focusKey: string | undefined): void {
  if (focusKey === undefined || focusKey.length === 0) return
  writeDraft(persistence, DRAFT_STORAGE_KEYS.focus, focusKey)
}

export function readPage(persistence: DraftPersistence | undefined, allowed: readonly string[]): string | undefined {
  const value = readDraft<string>(persistence, DRAFT_STORAGE_KEYS.page)
  return allowed.includes(value ?? '') ? value : undefined
}

export function writePage(persistence: DraftPersistence | undefined, page: string): void {
  writeDraft(persistence, DRAFT_STORAGE_KEYS.page, page)
}
