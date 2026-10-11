import type { HistoryRecord } from '../control-protocol/acp.ts'

/**
 * Execution-history write port owned by agent-host.
 *
 * The host appends a record before an engine effect and never implements a
 * second file-backed store. The runtime injects the durable implementation and
 * owns the read side through the frozen `HistoryReadPort` in
 * `control-protocol/teams-state.ts`, so no second read port is declared here.
 */
export interface AcpHistoryPort {
  /**
   * Append one record. The port assigns `recordId` and the monotonic
   * `sequence`; a rejected promise is a visible history-write failure.
   */
  append(record: Omit<HistoryRecord, 'recordId' | 'sequence'>): Promise<HistoryRecord>
}
