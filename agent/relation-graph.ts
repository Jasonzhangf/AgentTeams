import type { CapabilityDeclaration, OperationDeclaration } from '../control-protocol/agent-services.ts'

export type CapabilityUseState = 'discovered' | 'requested' | 'allowed' | 'denied' | 'using' | 'stopped' | 'expired'
export type RelationClassification = 'master-slave' | 'peer'

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
