import type { CapabilityDeclaration, OperationDeclaration } from '../control-protocol/agent-services.ts'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type CapabilityUseState = 'discovered' | 'requested' | 'allowed' | 'denied' | 'using' | 'stopped' | 'expired'
export type RelationClassification = 'master-slave' | 'peer'
export type RelationAvailability = 'online' | 'offline'

export interface CapabilityMatchRequest {
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
}

export interface CapabilityMatch {
  readonly capability: CapabilityDeclaration
  readonly operation: OperationDeclaration
}

export interface CapabilityUseReport {
  readonly relationId: string
  readonly consumer: string
  readonly provider: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly state: CapabilityUseState
  readonly relationPermission: 'requested' | 'granted' | 'revoked'
  readonly reportedAt: string
  readonly reportRevision: number
}

export interface AgentRelation {
  readonly relationId: string
  readonly consumer: string
  readonly provider: string
  readonly classification: RelationClassification
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly permission: 'requested' | 'granted' | 'revoked'
  readonly availability: RelationAvailability
  readonly revision: number
}

export interface RelationSnapshot {
  readonly version: 1
  readonly revision: number
  readonly relations: readonly AgentRelation[]
}

export interface RelationStore {
  load(): RelationSnapshot | undefined
  save(expectedRevision: number, snapshot: RelationSnapshot): void
}

export interface RelationConflict {
  readonly code: 'REVISION_CONFLICT' | 'PAIR_CONFLICT'
  readonly expectedRevision?: number
  readonly actualRevision?: number
  readonly relationId?: string
}

function relationError(conflict: RelationConflict): Error {
  const error = new Error(`${conflict.code}: relation update rejected`)
  Object.defineProperty(error, 'conflict', { value: conflict, enumerable: true })
  return error
}

export function createRelationStore(filePath: string): RelationStore {
  return {
    load: () => {
      try { return JSON.parse(readFileSync(filePath, 'utf8')) as RelationSnapshot }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    },
    save: (expectedRevision, snapshot) => {
      const current = (() => { try { return JSON.parse(readFileSync(filePath, 'utf8')) as RelationSnapshot } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } })()
      const actualRevision = current?.revision ?? 0
      if (actualRevision !== expectedRevision || snapshot.revision !== expectedRevision + 1) {
        throw relationError({ code: 'REVISION_CONFLICT', expectedRevision, actualRevision })
      }
      mkdirSync(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${process.pid}.tmp`
      const fd = openSync(temporary, 'w', 0o600)
      try { writeSync(fd, JSON.stringify(snapshot)); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, filePath)
    },
  }
}

export function updateRelation(store: RelationStore, relation: AgentRelation): AgentRelation {
  const current = store.load() ?? { version: 1 as const, revision: 0, relations: [] }
  const pair = current.relations.find(item => item.consumer === relation.consumer && item.provider === relation.provider && item.capabilityId === relation.capabilityId && item.capabilityVersion === relation.capabilityVersion && item.relationId !== relation.relationId)
  if (pair !== undefined) throw relationError({ code: 'PAIR_CONFLICT', relationId: pair.relationId })
  const relations = current.relations.filter(item => item.relationId !== relation.relationId)
  const next = { version: 1 as const, revision: current.revision + 1, relations: [...relations, { ...relation, revision: current.revision + 1 }] }
  store.save(current.revision, next)
  return next.relations[next.relations.length - 1]
}

export function revokeRelation(store: RelationStore, relationId: string): AgentRelation {
  const current = store.load()
  const relation = current?.relations.find(item => item.relationId === relationId)
  if (relation === undefined) throw new Error(`agent: relation ${relationId} not found`)
  return updateRelation(store, { ...relation, permission: 'revoked' })
}

export function setRelationAvailability(store: RelationStore, relationId: string, availability: RelationAvailability): AgentRelation {
  const current = store.load()
  const relation = current?.relations.find(item => item.relationId === relationId)
  if (relation === undefined) throw new Error(`agent: relation ${relationId} not found`)
  return updateRelation(store, { ...relation, availability })
}

export interface CapabilityUseGraphEdge {
  readonly relationId: string
  readonly consumer: string
  readonly provider: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly classification: RelationClassification
  readonly relationPermission: CapabilityUseReport['relationPermission']
  readonly consumerState?: CapabilityUseState
  readonly providerState?: CapabilityUseState
  readonly consistency: 'matched' | 'consumer-only' | 'provider-only' | 'conflict'
  readonly lastReportedAt: string
}

function key(report: CapabilityUseReport): string {
  return JSON.stringify([report.relationId, report.consumer, report.provider, report.capabilityId, report.capabilityVersion])
}

function isMatched(consumer: CapabilityUseState, provider: CapabilityUseState): boolean {
  return consumer === provider || (consumer === 'allowed' && provider === 'using') || (consumer === 'using' && provider === 'allowed')
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`agent: ${label} is required`)
  return value
}

export function matchCapability(capabilities: readonly CapabilityDeclaration[], request: CapabilityMatchRequest): CapabilityMatch {
  if (!Array.isArray(capabilities)) throw new Error('agent: capability declarations must be an array')
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('agent: capability match request must be an object')
  const capabilityId = requiredText(request.capabilityId, 'capabilityId')
  const capabilityVersion = requiredText(request.capabilityVersion, 'capabilityVersion')
  const operationId = requiredText(request.operation, 'operation')
  const capability = capabilities.find(candidate => candidate.capabilityId === capabilityId)
  if (capability === undefined) throw new Error(`agent: NOT_FOUND capability ${capabilityId}`)
  if (capability.version !== capabilityVersion) throw new Error(`agent: UNSUPPORTED_VERSION capability ${capabilityId}/${capabilityVersion}`)
  const operation = capability.operations.find((candidate: OperationDeclaration) => candidate.operation === operationId)
  if (operation === undefined) throw new Error(`agent: UNSUPPORTED_OPERATION ${operationId} for ${capabilityId}`)
  return { capability, operation }
}

export function reportCapabilityUseByConsumer(report: CapabilityUseReport): CapabilityUseReport {
  if (report.consumer.length === 0 || report.provider.length === 0 || report.capabilityId.length === 0 || report.capabilityVersion.length === 0) {
    throw new Error('agent: relation report requires consumer, provider, and capability')
  }
  return report
}

export function reportCapabilityUseByProvider(report: CapabilityUseReport): CapabilityUseReport {
  return reportCapabilityUseByConsumer(report)
}

export function reconcileCapabilityUseReports(
  consumerReport: CapabilityUseReport | undefined,
  providerReport: CapabilityUseReport | undefined,
  classification: RelationClassification,
): CapabilityUseGraphEdge {
  const source = consumerReport ?? providerReport
  if (source === undefined) throw new Error('server: cannot project an empty relation')
  if (consumerReport !== undefined && providerReport !== undefined && key(consumerReport) !== key(providerReport)) {
    throw new Error('agent: relation reports identify different capability uses')
  }
  if (consumerReport === undefined) return { ...source, classification, consistency: 'provider-only', providerState: providerReport?.state, lastReportedAt: source.reportedAt }
  if (providerReport === undefined) return { ...source, classification, consistency: 'consumer-only', consumerState: consumerReport.state, lastReportedAt: source.reportedAt }
  return {
    ...source,
    classification,
    consumerState: consumerReport.state,
    providerState: providerReport.state,
    consistency: isMatched(consumerReport.state, providerReport.state) ? 'matched' : 'conflict',
    lastReportedAt: consumerReport.reportedAt > providerReport.reportedAt ? consumerReport.reportedAt : providerReport.reportedAt,
  }
}

export function projectCapabilityUseGraph(
  consumerReports: readonly CapabilityUseReport[],
  providerReports: readonly CapabilityUseReport[],
  classification: RelationClassification,
): readonly CapabilityUseGraphEdge[] {
  const reports = new Map<string, { consumer?: CapabilityUseReport; provider?: CapabilityUseReport }>()
  for (const report of consumerReports) {
    const reportKey = key(report)
    const current = reports.get(reportKey)
    reports.set(reportKey, { ...current, consumer: current?.consumer !== undefined && current.consumer.reportRevision >= report.reportRevision ? current.consumer : report })
  }
  for (const report of providerReports) {
    const reportKey = key(report)
    const current = reports.get(reportKey)
    reports.set(reportKey, { ...current, provider: current?.provider !== undefined && current.provider.reportRevision >= report.reportRevision ? current.provider : report })
  }
  return [...reports.values()].map(pair => reconcileCapabilityUseReports(pair.consumer, pair.provider, classification))
}
