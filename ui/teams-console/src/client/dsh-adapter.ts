import type { SessionId, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { AgentFixture } from './model.ts'

/**
 * Opens any DSH-owned session and leaves the Teams surface. Conversation
 * rendering, draft state, approvals, and transcript truth stay in
 * ui-conversation.
 */
export function openDshSession(
  sessions: ISessions,
  closeTeams: () => void,
  sessionId: string,
): void {
  sessions.open(sessionId as SessionId)
  closeTeams()
}

/** Opens the Agent's current Session through the shared DSH bridge. */
export function openCurrentAgentSession(
  sessions: ISessions,
  closeTeams: () => void,
  agent: AgentFixture,
): void {
  if (agent.currentSessionId === undefined) {
    throw new Error(`teams: agent "${agent.id}" has no current session`)
  }
  openDshSession(sessions, closeTeams, agent.currentSessionId)
}
