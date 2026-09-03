export type ConsoleEntry = 'topology' | 'conversations' | 'notifications' | 'search' | 'memory'
export type AgentStatus = 'running' | 'waiting' | 'idle' | 'error'

export interface AgentFixture {
  readonly id: string
  readonly label: string
  readonly machine: string
  readonly status: AgentStatus
  readonly provider: string
  readonly model: string
  readonly currentSessionId?: string
  readonly currentSessionTitle?: string
  readonly sessionCount: number
  readonly notificationCount: number
  readonly attention: 'high' | 'medium' | 'none'
  readonly relation?: string
}

export interface SessionFixture {
  readonly id: string
  readonly agentId: string
  readonly title: string
  readonly state: 'active' | 'history'
  readonly updated: string
  readonly preview: string
}

export interface NotificationFixture {
  readonly id: string
  readonly agentId: string
  readonly sessionId?: string
  readonly requestId?: string
  readonly title: string
  readonly detail: string
  readonly priority: 'high' | 'medium'
  readonly interactive: boolean
  readonly processed: boolean
  readonly createdAt: string
}

export interface TeamsNotificationProjection {
  readonly state: 'ready' | 'stale' | 'error' | 'permission-denied'
  readonly items: readonly NotificationFixture[]
}

export interface TeamsSearchProjection {
  readonly state: 'connecting' | 'indexing' | 'ready' | 'stale' | 'permission-denied' | 'error'
  readonly results: readonly {
    readonly resultId: string
    readonly source: 'session' | 'notification' | 'memory'
    readonly agentId: string
    readonly sessionId?: string
    readonly title: string
    readonly excerpt: string
    readonly relevance: number
  }[]
}

export interface TeamsMemoryProjection {
  readonly state: 'connecting' | 'summarizing' | 'pending-save' | 'saved' | 'loaded' | 'exported' | 'error'
  readonly records: readonly {
    readonly memoryId: string
    readonly agentId: string
    readonly sessionId: string
    readonly title: string
    readonly summary: string
    readonly state: Exclude<TeamsMemoryProjection['state'], 'connecting' | 'summarizing'>
  }[]
}

export interface LiveSessionProjection {
  readonly id: string
  readonly title?: string
  /** Host-provided identity binding; UI must not infer this from selection or title. */
  readonly agentId?: string
  readonly running: boolean
}

/** Host-owned data surface; UI receives projections and actions, never SDK truth. */
export interface TeamsHostProjection {
  readonly agents: readonly AgentFixture[]
  readonly sessions: readonly LiveSessionProjection[]
  readonly currentSessionId?: string
  readonly notifications: TeamsNotificationProjection
}

export interface TeamsHostActions {
  readonly openSession: (sessionId: string) => void
  readonly acknowledgeNotification: (notificationId: string) => void
  readonly replyPermission: (sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject') => void
}

export interface DshSessionProjection {
  readonly id: string
  readonly title?: string
  readonly agentPreset?: string
  readonly running: boolean
}

export interface AgentPresetBinding {
  readonly agentId: string
  readonly agentPreset: string
}

export function projectDshSessions(
  sessions: readonly DshSessionProjection[],
  agentPresetToId: Readonly<Record<string, string>>,
): readonly LiveSessionProjection[] {
  return sessions.map(session => ({
    id: session.id,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.agentPreset === undefined || agentPresetToId[session.agentPreset] === undefined
      ? {}
      : { agentId: agentPresetToId[session.agentPreset] }),
    running: session.running,
  }))
}

/** Converts the DSH global session seat without importing the runtime owner. */
export function projectDshSessionList(
  snapshot: {
    readonly current?: string
    readonly byId: Readonly<Record<string, DshSessionProjection>>
  },
  bindings: readonly AgentPresetBinding[],
): readonly LiveSessionProjection[] {
  const sessions = Object.values(snapshot.byId)
  const projected = projectDshSessions(sessions, projectAgentPresetBindings(bindings))
  return projected.map(session => session.id === snapshot.current ? { ...session } : session)
}

export function projectAgentPresetBindings(
  bindings: readonly AgentPresetBinding[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const binding of bindings) {
    if (binding.agentId.length === 0 || binding.agentPreset.length === 0) {
      throw new Error('teams: agent preset binding requires agentId and agentPreset')
    }
    if (result[binding.agentPreset] !== undefined) {
      throw new Error(`teams: agent preset "${binding.agentPreset}" has multiple Agent owners`)
    }
    result[binding.agentPreset] = binding.agentId
  }
  return result
}

export function projectAgentCurrentSessions(
  sourceAgents: readonly AgentFixture[],
  liveSessions: readonly LiveSessionProjection[],
  currentSessionId?: string,
): readonly AgentFixture[] {
  return sourceAgents.map(agent => {
    const current = liveSessions.find(session => session.agentId === agent.id
      && (session.running || session.id === currentSessionId))
    if (current === undefined) {
      const { currentSessionId: _currentSessionId, currentSessionTitle: _currentSessionTitle, ...withoutCurrent } = agent
      return withoutCurrent
    }
    return {
      ...agent,
      currentSessionId: current.id,
      ...(current.title === undefined && agent.currentSessionTitle === undefined
        ? {}
        : { currentSessionTitle: current.title ?? agent.currentSessionTitle }),
    }
  })
}

export function referenceProjections(): {
  readonly notifications: TeamsNotificationProjection
  readonly search: TeamsSearchProjection
  readonly memory: TeamsMemoryProjection
} {
  return {
    notifications: { state: 'ready', items: notifications },
    search: {
      state: 'ready',
      results: [{
        resultId: 'search-runtime',
        source: 'session',
        agentId: 'planner',
        sessionId: 'planner-current',
        title: 'Plan Teams runtime',
        excerpt: 'Runtime bootstrap and host admission are mapped.',
        relevance: 0.94,
      }],
    },
    memory: {
      state: 'saved',
      records: [{
        memoryId: 'memory-runtime',
        agentId: 'planner',
        sessionId: 'planner-current',
        title: 'Runtime boundary',
        summary: 'Bootstrap, admission, and config sync precede readiness.',
        state: 'saved',
      }],
    },
  }
}

export const agents: readonly AgentFixture[] = [
  {
    id: 'planner',
    label: 'Planner',
    machine: 'Mac Studio',
    status: 'running',
    provider: 'rcc',
    model: 'deepseek-v4',
    currentSessionId: 'planner-current',
    currentSessionTitle: 'Plan Teams runtime',
    sessionCount: 4,
    notificationCount: 2,
    attention: 'high',
    relation: 'peer: Reviewer',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    machine: 'Mac Studio',
    status: 'waiting',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    currentSessionId: 'reviewer-current',
    currentSessionTitle: 'Review adapter boundary',
    sessionCount: 3,
    notificationCount: 1,
    attention: 'medium',
    relation: 'master -> Reviewer',
  },
  {
    id: 'release-bot',
    label: 'Release Bot',
    machine: 'Build Mac',
    status: 'idle',
    provider: 'opencode',
    model: 'claude-sonnet-4',
    sessionCount: 2,
    notificationCount: 0,
    attention: 'none',
    relation: 'peer: Planner',
  },
]

export const sessions: readonly SessionFixture[] = [
  {
    id: 'planner-current',
    agentId: 'planner',
    title: 'Plan Teams runtime',
    state: 'active',
    updated: '2m',
    preview: 'Runtime bootstrap and host admission are mapped.',
  },
  {
    id: 'reviewer-current',
    agentId: 'reviewer',
    title: 'Review adapter boundary',
    state: 'active',
    updated: '8m',
    preview: 'DSH Slot and OpenCode Hooks remain separate.',
  },
  {
    id: 'planner-history',
    agentId: 'planner',
    title: 'Define notification flow',
    state: 'history',
    updated: 'Yesterday',
    preview: 'Notification target resolution was documented.',
  },
]

export const notifications: readonly NotificationFixture[] = [
  {
    id: 'approval-1',
    agentId: 'planner',
    sessionId: 'planner-current',
    title: 'Approval required',
    detail: 'Planner needs confirmation before applying the runtime boundary.',
    priority: 'high',
    interactive: true,
    processed: false,
    createdAt: '2026-09-01T17:02:00Z',
  },
  {
    id: 'complete-1',
    agentId: 'reviewer',
    sessionId: 'reviewer-current',
    title: 'Task completed',
    detail: 'Adapter boundary review finished.',
    priority: 'medium',
    interactive: false,
    processed: false,
    createdAt: '2026-09-01T16:58:00Z',
  },
]
