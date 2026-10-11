import type { ConsoleProjectionV1, ConsolePermissionOption, ConsoleSessionEventView } from './protocol.ts'
import { projectSessionFlow, canOperateSession } from './model.ts'
import type { SessionFlowRow } from './model.ts'

export interface InteractionView {
  readonly sessions: readonly { readonly agentId: string; readonly sessionId: string; readonly title?: string }[]
  readonly flow: readonly SessionFlowRow[]
  readonly pendingPermissions: readonly (SessionFlowRow & { readonly kind: 'permission'; readonly state: 'pending' })[]
  readonly operable: boolean
}

export function projectInteraction(projection: ConsoleProjectionV1, agentId: string | undefined, sessionId: string | undefined): InteractionView {
  const sessions = projection.sessions.filter(session => agentId === undefined || session.agentId === agentId)
  const selected = sessionId !== undefined
    ? sessions.find(session => session.sessionId === sessionId)
    : sessions[0]
  const flow = selected === undefined ? [] : projectSessionFlow(projection, selected.agentId, selected.sessionId)
  const pendingPermissions = flow.filter((event): event is SessionFlowRow & { readonly kind: 'permission'; readonly state: 'pending' } =>
    event.kind === 'permission' && event.state === 'pending')
  const agent = projection.agents.find(candidate => candidate.agentId === (selected?.agentId ?? agentId))
  return {
    sessions,
    flow,
    pendingPermissions,
    operable: agent !== undefined && canOperateSession(agent),
  }
}

/** Choices come from the owner event only; absent options never fabricate a choice. */
export function permissionOptions(event: SessionFlowRow): readonly ConsolePermissionOption[] {
  if (event.kind !== 'permission' || event.state !== 'pending') return []
  return event.options ?? []
}
