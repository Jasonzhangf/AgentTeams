export type SearchState = 'connecting' | 'indexing' | 'ready' | 'stale' | 'permission-denied' | 'error'
export type SearchScope = 'all' | 'session' | 'notification' | 'memory'

export interface SearchSource {
  readonly resultId: string
  readonly source: Exclude<SearchScope, 'all'>
  readonly machineId: string
  readonly agentId: string
  readonly sessionId?: string
  readonly title: string
  readonly excerpt: string
  readonly occurredAt?: string
  readonly relevance: number
}

export interface SearchRequest { readonly query: string; readonly scope: SearchScope; readonly machineId?: string; readonly agentId?: string }
export interface SearchIndex { readonly state: SearchState; readonly sources: readonly SearchSource[] }

export function connectSearchPlugin(): SearchIndex { return { state: 'connecting', sources: [] } }

export function indexSearchSources(index: SearchIndex, sources: readonly SearchSource[]): SearchIndex {
  if (index.state === 'permission-denied' || index.state === 'error') return index
  return { state: 'ready', sources: [...sources] }
}

export function querySearchIndex(index: SearchIndex, request: SearchRequest): readonly SearchSource[] {
  if (index.state !== 'ready') throw new Error(`search: index is ${index.state}`)
  const query = request.query.trim().toLowerCase()
  if (query.length === 0) return []
  return index.sources.filter(source => {
    if (request.scope !== 'all' && source.source !== request.scope) return false
    if (request.machineId !== undefined && source.machineId !== request.machineId) return false
    if (request.agentId !== undefined && source.agentId !== request.agentId) return false
    return `${source.title} ${source.excerpt}`.toLowerCase().includes(query)
  }).sort((left, right) => right.relevance - left.relevance)
}
