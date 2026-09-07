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
  | 'provider' | 'model' | 'unknownModel' | 'credentialHint' | 'messageRequired' | 'noAgentConfig'
  | 'noResults' | 'sessionUntitled' | 'online' | 'offline' | 'unknown' | 'capabilities'
  | 'expand' | 'collapse' | 'activity' | 'activityUnavailable' | 'activityEmpty'
  | 'invalidNotificationTarget'

const en: Record<MessageKey, string> = {
  brand: 'Teams Console', topology: 'Agents', conversations: 'Sessions', notifications: 'Notifications', search: 'Search', memory: 'Memory', settings: 'Provider configuration',
  refresh: 'Refresh', close: 'Close', back: 'Back', details: 'Details', currentSession: 'Current session', noCurrentSession: 'No current session', openSession: 'Open session',
  configure: 'Configure', agents: 'agents', sessions: 'sessions', pending: 'Pending', resolved: 'Resolved', permission: 'Permission', notice: 'Notice',
  allowOnce: 'Allow once', alwaysAllow: 'Always allow', reject: 'Reject', acknowledge: 'Acknowledge', send: 'Send', message: 'Message', empty: 'Nothing to show yet.',
  loading: 'Loading projection…', retry: 'Try again', projectionError: 'The host projection could not be loaded.', searchPlaceholder: 'Search sessions and notifications', memoryUnavailable: 'Memory projection is not available from this host.',
  providerConfig: 'Provider and model', selectAgent: 'Select an Agent', acceptedRevision: 'Accepted revision', effectiveRevision: 'Effective revision', notApplied: 'Not applied',
  addProvider: 'Add provider', editProvider: 'Edit provider', providerId: 'Provider ID', providerLabel: 'Label', protocol: 'Protocol', apiBaseUrl: 'API base URL', enabled: 'Enabled', authKind: 'Auth', noAuth: 'None', bearer: 'Credential reference', credentialRef: 'Credential reference', saveProvider: 'Save provider',
  cancel: 'Cancel', refreshModels: 'Refresh models', bindModel: 'Bind model', selectModel: 'Select a model', noModels: 'No models published', catalogError: 'Catalog error', catalogReady: 'Ready', catalogEmpty: 'Empty', catalogStale: 'Stale', applyConfig: 'Apply configuration', applied: 'Applied', notConfigured: 'Not configured', notSelected: 'Model not selected', actionFailed: 'Action failed', actionSucceeded: 'Action complete', fixtureLabel: 'Browser fixture — host projection only', unknownAgent: 'Unknown Agent',
  provider: 'Provider', model: 'Model', unknownModel: 'Unknown model', credentialHint: 'Use a host-owned credential reference. Do not paste a credential value here.', messageRequired: 'Message is required.', noAgentConfig: 'This Agent has no projected configuration.',
  noResults: 'No matching results.', sessionUntitled: 'Untitled session', online: 'Online', offline: 'Offline', unknown: 'Unknown', capabilities: 'Capabilities',
  expand: 'Expand', collapse: 'Collapse', activity: 'Session activity', activityUnavailable: 'Session activity is not projected by this host.', activityEmpty: 'No activity has been projected for this session.',
  invalidNotificationTarget: 'This interactive notification has no existing Session target.',
}

const zh: Record<MessageKey, string> = {
  brand: 'Teams 控制台', topology: '智能体', conversations: '会话', notifications: '通知', search: '搜索', memory: '记忆', settings: '服务配置',
  refresh: '刷新', close: '关闭', back: '返回', details: '详情', currentSession: '当前会话', noCurrentSession: '暂无当前会话', openSession: '打开会话',
  configure: '配置', agents: '个智能体', sessions: '个会话', pending: '待处理', resolved: '已处理', permission: '权限', notice: '通知',
  allowOnce: '允许一次', alwaysAllow: '始终允许', reject: '拒绝', acknowledge: '确认', send: '发送', message: '消息', empty: '暂时没有内容。',
  loading: '正在加载数据…', retry: '重试', projectionError: '无法加载控制台数据。', searchPlaceholder: '搜索会话和通知', memoryUnavailable: '当前环境未提供记忆数据。',
  providerConfig: '服务与模型', selectAgent: '选择智能体', acceptedRevision: '已接受版本', effectiveRevision: '生效版本', notApplied: '尚未应用',
  addProvider: '新增服务', editProvider: '编辑服务', providerId: '服务 ID', providerLabel: '名称', protocol: '协议', apiBaseUrl: '接口地址', enabled: '启用', authKind: '鉴权方式', noAuth: '无', bearer: '凭据引用', credentialRef: '凭据引用', saveProvider: '保存服务',
  cancel: '取消', refreshModels: '刷新模型', bindModel: '绑定模型', selectModel: '选择模型', noModels: '暂无可用模型', catalogError: '加载失败', catalogReady: '已加载', catalogEmpty: '暂无模型', catalogStale: '已过期', applyConfig: '应用配置', applied: '已应用', notConfigured: '未配置服务', notSelected: '未选择模型', actionFailed: '操作失败', actionSucceeded: '操作完成', fixtureLabel: '浏览器演示 — 仅展示主机数据，不连接实际服务', unknownAgent: '未知智能体',
  provider: '服务', model: '模型', unknownModel: '未知模型', credentialHint: '请填写主机中的凭据引用，不要粘贴凭据值。', messageRequired: '请输入消息。', noAgentConfig: '该智能体没有可用的配置数据。',
  noResults: '没有匹配结果。', sessionUntitled: '未命名会话', online: '在线', offline: '离线', unknown: '未知', capabilities: '能力',
  expand: '展开', collapse: '收起', activity: '会话动态', activityUnavailable: '当前主机未提供会话动态。', activityEmpty: '该会话暂无动态。',
  invalidNotificationTarget: '该交互通知没有可用的会话目标。',
}

export function messages(locale: Locale): Record<MessageKey, string> {
  return locale === 'zh' ? zh : en
}

export type { MessageKey }
