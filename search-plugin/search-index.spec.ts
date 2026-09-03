import { describe, expect, it } from 'vitest'
import { connectSearchPlugin, indexSearchSources, querySearchIndex } from './search-index.ts'

describe('Teams search plugin', () => {
  const source = { resultId: 'r1', source: 'session' as const, machineId: 'm1', agentId: 'a1', title: 'Runtime plan', excerpt: 'Bootstrap config', relevance: 0.9 }
  it('indexes and queries typed sources', () => expect(querySearchIndex(indexSearchSources(connectSearchPlugin(), [source]), { query: 'bootstrap', scope: 'all' })).toEqual([source]))
  it('keeps non-ready plugin state explicit', () => expect(() => querySearchIndex(connectSearchPlugin(), { query: 'x', scope: 'all' })).toThrow(/connecting/))
})
