import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityDeclaration } from '../control-protocol/agent-services.ts'
import { createRelationStore, matchCapability, projectCapabilityUseGraph, reportCapabilityUseByConsumer, reportCapabilityUseByProvider, revokeRelation, setRelationAvailability, updateRelation } from './relation-graph.ts'

const base = { relationId: 'rel-1', consumer: 'planner', provider: 'reviewer', capabilityId: 'review', capabilityVersion: '1.0.0', relationPermission: 'granted' as const, reportedAt: '2026-09-01T17:00:00Z', reportRevision: 1 }

function withRelationStore<T>(run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'agent-relation-'))
  try { return run(join(directory, 'relations.json')) } finally { rmSync(directory, { recursive: true, force: true }) }
}

const relation = { relationId: 'rel-1', consumer: 'planner', provider: 'reviewer', classification: 'peer' as const, capabilityId: 'review', capabilityVersion: '1.0.0', permission: 'granted' as const, availability: 'online' as const, revision: 0 }

describe('Teams capability-use graph', () => {
  it('matches an exact capability version and declared operation', () => {
    const capability: CapabilityDeclaration = {
      capabilityId: 'browser',
      version: '1.0.0',
      operations: [{ operation: 'open', inputSchema: {}, outputSchema: {}, cancellation: 'cooperative' }],
      resources: [],
    }
    expect(matchCapability([capability], { capabilityId: 'browser', capabilityVersion: '1.0.0', operation: 'open' })).toEqual({ capability, operation: capability.operations[0] })
    expect(() => matchCapability([capability], { capabilityId: 'browser', capabilityVersion: '2.0.0', operation: 'open' })).toThrow(/UNSUPPORTED_VERSION/)
    expect(() => matchCapability([capability], { capabilityId: 'browser', capabilityVersion: '1.0.0', operation: 'close' })).toThrow(/UNSUPPORTED_OPERATION/)
  })
  it('projects a matched two-sided relation without granting extra authority', () => {
    const graph = projectCapabilityUseGraph(
      [reportCapabilityUseByConsumer({ ...base, state: 'using' })],
      [reportCapabilityUseByProvider({ ...base, state: 'using' })],
      'peer',
    )
    expect(graph[0]).toMatchObject({ consistency: 'matched', classification: 'peer', relationPermission: 'granted' })
    expect(graph[0]).not.toHaveProperty('permission')
  })

  it('retains consumer-only and conflicting reports visibly', () => {
    const graph = projectCapabilityUseGraph(
      [
        { ...base, state: 'requested' },
        { ...base, relationId: 'rel-2', state: 'using' },
      ],
      [{ ...base, relationId: 'rel-2', state: 'denied' }],
      'master-slave',
    )
    expect(graph).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationId: 'rel-1', consistency: 'consumer-only' }),
      expect.objectContaining({ relationId: 'rel-2', consistency: 'conflict' }),
    ]))
  })

  it('keeps capability versions separate and ignores older reports', () => {
    const versionSplit = projectCapabilityUseGraph(
      [{ ...base, capabilityVersion: '1.0.0', state: 'using' }],
      [{ ...base, capabilityVersion: '2.0.0', state: 'using' }],
      'peer',
    )
    expect(versionSplit).toHaveLength(2)
    expect(versionSplit).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityVersion: '1.0.0', consistency: 'consumer-only' }),
      expect.objectContaining({ capabilityVersion: '2.0.0', consistency: 'provider-only' }),
    ]))

    const newest = projectCapabilityUseGraph(
      [{ ...base, state: 'using', reportRevision: 2 }, { ...base, state: 'requested', reportRevision: 1 }],
      [{ ...base, state: 'using', reportRevision: 2 }],
      'master-slave',
    )
    expect(newest).toMatchObject([{ consumerState: 'using', providerState: 'using', consistency: 'matched', reportRevision: 2 }])
  })

  it('persists agent-owned relation state and reports revision and pair conflicts', () => {
    withRelationStore(path => {
      const store = createRelationStore(path)
      expect(updateRelation(store, relation)).toMatchObject({ relationId: 'rel-1', revision: 1 })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ revision: 1, relations: [{ relationId: 'rel-1' }] })
      expect(() => updateRelation(store, { ...relation, relationId: 'rel-2' })).toThrow(/PAIR_CONFLICT/)
      expect(() => store.save(0, { version: 1, revision: 1, relations: [] })).toThrow(/REVISION_CONFLICT/)
    })
  })

  it('records explicit revoke and offline transitions without changing relation identity', () => {
    withRelationStore(path => {
      const store = createRelationStore(path)
      updateRelation(store, relation)
      expect(revokeRelation(store, 'rel-1')).toMatchObject({ relationId: 'rel-1', permission: 'revoked', revision: 2 })
      expect(setRelationAvailability(store, 'rel-1', 'offline')).toMatchObject({ relationId: 'rel-1', permission: 'revoked', availability: 'offline', revision: 3 })
      expect(store.load()?.relations).toHaveLength(1)
    })
  })
})
