import { describe, expect, it } from 'vitest'
import { historyQueryFor, isRequestKindRefusal } from '../src/client/page-history.ts'

describe('history page projection', () => {
  it('queries connection history and pages before a sequence', () => {
    expect(historyQueryFor('connection', 12)).toEqual({ version: 1, kind: 'connection', limit: 20, beforeSequence: 12 })
    expect(historyQueryFor('connection', undefined)).toEqual({ version: 1, kind: 'connection', limit: 20 })
  })

  it('keeps a request-kind refusal a real typed state', () => {
    expect(isRequestKindRefusal({ code: 'INVALID_ACP_FRAME', message: 'refused' })).toBe(true)
    expect(isRequestKindRefusal(null)).toBe(false)
    expect(isRequestKindRefusal({ code: 'HISTORY_UNAVAILABLE', message: 'unbound' })).toBe(false)
  })
})
