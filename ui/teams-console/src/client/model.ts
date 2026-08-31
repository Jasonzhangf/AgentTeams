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
  readonly title: string
  readonly detail: string
  readonly priority: 'high' | 'medium'
  readonly interactive: boolean
  readonly processed: boolean
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
  },
]
