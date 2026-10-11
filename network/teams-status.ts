import type { HistoryPage, HistoryQuery, TeamsConnectionStatus } from '../control-protocol/teams-state.ts'
import type { AccountDirectorySnapshot } from './account-directory.ts'
import type { RegistrationStatus } from './registration-client.ts'
import type { TeamsConnectionHistory } from './teams-connection-history.ts'
import type { TeamsConnectionLedger } from './teams-ingress.ts'
import { projectTeamsMembership } from './teams-membership.ts'

/**
 * Teams status port (owner: network). Read-only handoff surface for D06.
 *
 * It exposes exactly the two frozen DTOs from `control-protocol/teams-state.ts`:
 * `TeamsConnectionStatus` for the live view and `HistoryPage` for the durable
 * read. The richer internal `TeamsMembershipView` (hosts, routes, registry
 * health, half-open flags) never crosses this boundary, and this module mints no
 * synonymous type.
 *
 * Live connection state comes from the injected ledger, never from history or a
 * log. `history` delegates to `createTeamsConnectionHistory`, which owns the
 * `kind: 'connection'` record vocabulary.
 */

export interface TeamsStatusPort {
  connections(): readonly TeamsConnectionStatus[]
  history(query: HistoryQuery): Promise<HistoryPage>
}

export interface CreateTeamsStatusPortInput {
  readonly ledger: TeamsConnectionLedger
  readonly localAgentId: string
  readonly directory: AccountDirectorySnapshot
  readonly registration: RegistrationStatus
  readonly history: TeamsConnectionHistory
  /** Live clock; defaults to the system clock. */
  readonly now?: () => string
}

export function createTeamsStatusPort(input: CreateTeamsStatusPortInput): TeamsStatusPort {
  const now = input.now ?? (() => new Date().toISOString())
  return {
    connections: () => projectTeamsMembership({
      localAgentId: input.localAgentId,
      directory: input.directory,
      registration: input.registration,
      channels: input.ledger.list(),
      observedAt: now(),
    }).entries.map(entry => entry.status),
    history: query => input.history.query(query),
  }
}
