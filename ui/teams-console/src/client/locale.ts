export const NS = 'teams' as const

export type TeamsKey =
  | 'entry'
  | 'topology'
  | 'conversations'
  | 'notifications'
  | 'search'
  | 'memory'
  | 'settings'
  | 'open'
  | 'close'
  | 'expand'
  | 'collapse'
  | 'back'
  | 'currentSession'
  | 'sessions'
  | 'notificationsCount'
  | 'noCurrentSession'
  | 'sessionUnavailable'
  | 'sessionHandoff'
  | 'drawerHint'
  | 'machine'
  | 'online'
  | 'attention'
  | 'active'
  | 'history'
  | 'searchPlaceholder'
  | 'memoryStatus'
  | 'fixtureNotice'

export const en: Record<TeamsKey, string> = {
  entry: 'Teams',
  topology: 'Topology',
  conversations: 'Conversations',
  notifications: 'Notifications',
  search: 'Search',
  memory: 'Memory',
  settings: 'Settings',
  open: 'Open',
  close: 'Close',
  expand: 'Full screen',
  collapse: 'Restore',
  back: 'Back',
  currentSession: 'Current session',
  sessions: 'sessions',
  notificationsCount: 'notifications',
  noCurrentSession: 'No current session',
  sessionUnavailable: 'Session unavailable',
  sessionHandoff: 'Session focus is delegated to the DSH Conversation owner in Slice 2.',
  drawerHint: 'Drag the header up to expand or down to close.',
  machine: 'Machine',
  online: 'Online',
  attention: 'Attention',
  active: 'Active',
  history: 'History',
  searchPlaceholder: 'Search sessions, notifications, memory',
  memoryStatus: 'Memory plugin boundary',
  fixtureNotice: 'Static vertical slice',
}

export const zh: Record<TeamsKey, string> = {
  entry: 'Teams',
  topology: '拓扑',
  conversations: '对话',
  notifications: '通知',
  search: '搜索',
  memory: '记忆',
  settings: '配置',
  open: '打开',
  close: '关闭',
  expand: '全屏',
  collapse: '恢复',
  back: '返回',
  currentSession: '当前 Session',
  sessions: '个 sessions',
  notificationsCount: '条通知',
  noCurrentSession: '没有当前 Session',
  sessionUnavailable: 'Session 当前不可用',
  sessionHandoff: 'Session 将在 Slice 2 交给 DSH Conversation owner。',
  drawerHint: '上拉 header 全屏，下拉 header 关闭。',
  machine: '机器',
  online: '在线',
  attention: '待处理',
  active: '活跃',
  history: '历史',
  searchPlaceholder: '搜索 sessions、通知、记忆',
  memoryStatus: '记忆插件边界',
  fixtureNotice: '静态 vertical slice',
}
