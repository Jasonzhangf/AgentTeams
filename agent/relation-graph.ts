export type CapabilityUseState = 'discovered' | 'requested' | 'allowed' | 'denied' | 'using' | 'stopped' | 'expired'
export type RelationClassification = 'master-slave' | 'peer'

export interface CapabilityUseReport {
  readonly relationId: string
  readonly consumer: string
  readonly provider: string
  readonly capabilityId: string
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
  readonly classification: RelationClassification
  readonly relationPermission: CapabilityUseReport['relationPermission']
  readonly consumerState?: CapabilityUseState
  readonly providerState?: CapabilityUseState
  readonly consistency: 'matched' | 'consumer-only' | 'provider-only' | 'conflict'
  readonly lastReportedAt: string
}

function key(report: CapabilityUseReport): string {
  return `${report.relationId}:${report.consumer}:${report.provider}:${report.capabilityId}`
}

function isMatched(consumer: CapabilityUseState, provider: CapabilityUseState): boolean {
  return consumer === provider || (consumer === 'allowed' && provider === 'using') || (consumer === 'using' && provider === 'allowed')
}

export function reportCapabilityUseByConsumer(report: CapabilityUseReport): CapabilityUseReport {
  if (report.consumer.length === 0 || report.provider.length === 0 || report.capabilityId.length === 0) {
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
  for (const report of consumerReports) reports.set(key(report), { ...reports.get(key(report)), consumer: report })
  for (const report of providerReports) reports.set(key(report), { ...reports.get(key(report)), provider: report })
  return [...reports.values()].map(pair => reconcileCapabilityUseReports(pair.consumer, pair.provider, classification))
}
