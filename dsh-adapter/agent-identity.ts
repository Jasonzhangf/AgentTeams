export interface HostAgentIdentity {
  readonly agentId: string
  readonly agentPreset: string
}

export interface HostSessionIdentity {
  readonly sessionId: string
  readonly agentPreset?: string
  readonly running: boolean
  readonly current: boolean
  readonly title?: string
}

export interface HostSessionListSnapshot {
  readonly currentSessionId?: string
  readonly items: readonly HostSessionIdentity[]
}

export interface DshAgentSessionProjection {
  readonly sessionId: string
  readonly agentId: string
  readonly title?: string
  readonly running: boolean
  readonly current: boolean
}

export function projectHostSessionIdentities(
  sessions: readonly HostSessionIdentity[],
  identities: readonly HostAgentIdentity[],
): readonly DshAgentSessionProjection[] {
  const owners = new Map<string, string>()
  for (const identity of identities) {
    if (identity.agentId.length === 0 || identity.agentPreset.length === 0) throw new Error('dsh-adapter: Agent identity requires agentId and agentPreset')
    if (owners.has(identity.agentPreset)) throw new Error(`dsh-adapter: duplicate Agent preset ${identity.agentPreset}`)
    owners.set(identity.agentPreset, identity.agentId)
  }
  return sessions.flatMap(session => {
    if (session.sessionId.length === 0 || session.agentPreset === undefined) return []
    const agentId = owners.get(session.agentPreset)
    if (agentId === undefined) return []
    return [{ sessionId: session.sessionId, agentId, ...(session.title === undefined ? {} : { title: session.title }), running: session.running, current: session.current }]
  })
}

export function projectDshAgentSessionList(
  snapshot: HostSessionListSnapshot,
  identities: readonly HostAgentIdentity[],
): readonly DshAgentSessionProjection[] {
  return projectHostSessionIdentities(
    snapshot.items.map(session => ({
      ...session,
      current: session.current || session.sessionId === snapshot.currentSessionId,
    })),
    identities,
  )
}
