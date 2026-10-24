export type RelationReportRole = 'consumer' | 'provider'
export type RelationState = 'discovered' | 'requested' | 'allowed' | 'denied' | 'using' | 'stopped' | 'revoked' | 'expired'

export interface RelationReport {
  readonly relationId: string
  readonly reporterAgentId: string
  readonly subjectAgentId: string
  readonly capabilityId: string
  readonly role: RelationReportRole
  readonly state: RelationState
  readonly reportRevision: number
  readonly reportedAt: string
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`relation-report: ${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`relation-report: ${label} must be a positive integer`)
  return value
}

function isoDate(value: unknown, label: string): string {
  const parsed = stringValue(value, label)
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`relation-report: ${label} must be an ISO date`)
  return parsed
}

export function validateRelationReport(value: unknown): RelationReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('relation-report: report must be an object')
  const input = value as Record<string, unknown>
  const role = stringValue(input.role, 'role')
  if (role !== 'consumer' && role !== 'provider') throw new Error('relation-report: role must be consumer or provider')
  const state = stringValue(input.state, 'state')
  if (!['discovered', 'requested', 'allowed', 'denied', 'using', 'stopped', 'revoked', 'expired'].includes(state)) {
    throw new Error('relation-report: unsupported state')
  }
  const reporterAgentId = stringValue(input.reporterAgentId, 'reporterAgentId')
  const subjectAgentId = stringValue(input.subjectAgentId, 'subjectAgentId')
  if (reporterAgentId === subjectAgentId) throw new Error('relation-report: self relation is not allowed')
  return {
    relationId: stringValue(input.relationId, 'relationId'),
    reporterAgentId,
    subjectAgentId,
    capabilityId: stringValue(input.capabilityId, 'capabilityId'),
    role: role as RelationReportRole,
    state: state as RelationState,
    reportRevision: positiveInteger(input.reportRevision, 'reportRevision'),
    reportedAt: isoDate(input.reportedAt, 'reportedAt'),
  }
}
