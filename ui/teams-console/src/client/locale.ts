export type Locale = 'en' | 'zh'

type MessageKey =
  | 'brand' | 'topology' | 'conversations' | 'notifications' | 'search' | 'memory' | 'settings'
  | 'refresh' | 'close' | 'back' | 'details' | 'currentSession' | 'noCurrentSession' | 'openSession'
  | 'configure' | 'agents' | 'sessions' | 'pending' | 'resolved' | 'permission' | 'notice'
  | 'allowOnce' | 'alwaysAllow' | 'reject' | 'acknowledge' | 'send' | 'message' | 'empty'
  | 'loading' | 'retry' | 'projectionError' | 'searchPlaceholder' | 'memoryUnavailable'
  | 'providerConfig' | 'selectAgent' | 'acceptedRevision' | 'effectiveRevision' | 'notApplied'
  | 'addProvider' | 'editProvider' | 'providerId' | 'providerLabel' | 'protocol' | 'apiBaseUrl'
  | 'enabled' | 'authKind' | 'noAuth' | 'bearer' | 'credentialRef' | 'saveProvider'
  | 'cancel' | 'refreshModels' | 'bindModel' | 'selectModel' | 'noModels' | 'catalogError'
  | 'catalogReady' | 'catalogEmpty' | 'catalogStale' | 'applyConfig' | 'applied' | 'notConfigured'
  | 'notSelected' | 'actionFailed' | 'actionSucceeded' | 'fixtureLabel' | 'unknownAgent'
  | 'noResults' | 'sessionUntitled' | 'online' | 'offline' | 'unknown' | 'capabilities'

const en: Record<MessageKey, string> = {
  brand: 'Teams Console', topology: 'Agents', conversations: 'Sessions', notifications: 'Notifications', search: 'Search', memory: 'Memory', settings: 'Provider configuration',
  refresh: 'Refresh', close: 'Close', back: 'Back', details: 'Details', currentSession: 'Current session', noCurrentSession: 'No current session', openSession: 'Open session',
  configure: 'Configure', agents: 'agents', sessions: 'sessions', pending: 'Pending', resolved: 'Resolved', permission: 'Permission', notice: 'Notice',
  allowOnce: 'Allow once', alwaysAllow: 'Always allow', reject: 'Reject', acknowledge: 'Acknowledge', send: 'Send', message: 'Message', empty: 'Nothing to show yet.',
  loading: 'Loading projection…', retry: 'Try again', projectionError: 'The host projection could not be loaded.', searchPlaceholder: 'Search sessions and notifications', memoryUnavailable: 'Memory projection is not available from this host.',
  providerConfig: 'Provider and model', selectAgent: 'Select an Agent', acceptedRevision: 'Accepted revision', effectiveRevision: 'Effective revision', notApplied: 'Not applied',
  addProvider: 'Add provider', editProvider: 'Edit provider', providerId: 'Provider ID', providerLabel: 'Label', protocol: 'Protocol', apiBaseUrl: 'API base URL', enabled: 'Enabled', authKind: 'Auth', noAuth: 'None', bearer: 'Credential reference', credentialRef: 'Credential reference', saveProvider: 'Save provider',
  cancel: 'Cancel', refreshModels: 'Refresh models', bindModel: 'Bind model', selectModel: 'Select a model', noModels: 'No models published', catalogError: 'Catalog error', catalogReady: 'Ready', catalogEmpty: 'Empty', catalogStale: 'Stale', applyConfig: 'Apply configuration', applied: 'Applied', notConfigured: 'Not configured', notSelected: 'Model not selected', actionFailed: 'Action failed', actionSucceeded: 'Action complete', fixtureLabel: 'Browser fixture — host projection only', unknownAgent: 'Unknown Agent',
  noResults: 'No matching results.', sessionUntitled: 'Untitled session', online: 'Online', offline: 'Offline', unknown: 'Unknown', capabilities: 'Capabilities',
}

const zh: Record<MessageKey, string> = {
  brand: 'Teams 控制台', topology: 'Agents', conversations: 'Sessions', notifications: '通知', search: '搜索', memory: '记忆', settings: 'Provider 配置',
  refresh: '刷新', close: '关闭', back: '返回', details: '详情', currentSession: '当前 Session', noCurrentSession: '没有当前 Session', openSession: '打开 Session',
  configure: '配置', agents: '个 Agent', sessions: '个 Session', pending: '待处理', resolved: '已处理', permission: '权限', notice: '通知',
  allowOnce: '允许一次', alwaysAllow: '始终允许', reject: '拒绝', acknowledge: '确认', send: '发送', message: '消息', empty: '暂时没有内容。',
  loading: '正在读取 projection…', retry: '重试', projectionError: '无法读取 host projection。', searchPlaceholder: '搜索 Session 和通知', memoryUnavailable: '当前 host 没有提供记忆 projection。',
  providerConfig: 'Provider 与 Model', selectAgent: '选择 Agent', acceptedRevision: '已接受 revision', effectiveRevision: '生效 revision', notApplied: '尚未生效',
  addProvider: '新增 Provider', editProvider: '编辑 Provider', providerId: 'Provider ID', providerLabel: '名称', protocol: '协议', apiBaseUrl: 'API base URL', enabled: '启用', authKind: '鉴权', noAuth: '无', bearer: '凭据引用', credentialRef: '凭据引用', saveProvider: '保存 Provider',
  cancel: '取消', refreshModels: '刷新模型', bindModel: '绑定 Model', selectModel: '选择 Model', noModels: '没有可用 Model', catalogError: '目录错误', catalogReady: '就绪', catalogEmpty: '空', catalogStale: '过期', applyConfig: '应用配置', applied: '已生效', notConfigured: '未配置 Provider', notSelected: '未选择 Model', actionFailed: '操作失败', actionSucceeded: '操作完成', fixtureLabel: '浏览器 fixture — 仅 host projection', unknownAgent: '未知 Agent',
  noResults: '没有匹配结果。', sessionUntitled: '未命名 Session', online: '在线', offline: '离线', unknown: '未知', capabilities: '能力',
}

export function messages(locale: Locale): Record<MessageKey, string> {
  return locale === 'zh' ? zh : en
}

export type { MessageKey }
