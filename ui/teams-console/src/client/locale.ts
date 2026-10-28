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
  | 'invalidNotificationTarget' | 'createSession' | 'cancelSession' | 'directoryRow'
  | 'availabilityChanging' | 'availabilityStopped' | 'availabilityNoCurrent' | 'availabilityUncertain'
  | 'availabilityNotApplicable' | 'availabilityCurrent' | 'observationDegraded' | 'observationLost'
  | 'declaredServices' | 'capabilityDetailUnavailable' | 'capabilityDetailEmpty' | 'noDeclaredResources'
  | 'declaredCapacity' | 'operations'
  | 'pageDiscovery' | 'pageNetworking' | 'pageInteraction' | 'pageHistory'
  | 'connect' | 'disconnect' | 'removeDraftMember' | 'draft' | 'accepted' | 'master' | 'peer' | 'applyMembership'
  | 'historyPrev' | 'historyRequest' | 'historyUnavailable' | 'permissionOptionsUnavailable'
  | 'workRecords' | 'workRecordsUnavailable' | 'workRecordsEmpty' | 'workRefresh' | 'connectionHistory' | 'historyRetry'
  | 'workAccepted' | 'workClosing' | 'workClosed' | 'workRejected'
  | 'cancelRequested' | 'cancelConfirmed' | 'cancelUnknown'
  | 'pageGroups' | 'groupList' | 'groupSelected' | 'groupMembers' | 'groupMessages' | 'groupComposer'
  | 'groupSend' | 'groupCreate' | 'groupName' | 'groupInvite' | 'groupInviteAgent' | 'groupInviteRole' | 'groupActionAssigneeEmpty' | 'groupActionAssigneeEmptyHint' | 'groupInviteAgentEmpty' | 'groupGrant' | 'groupGrantHint'
  | 'groupIssue' | 'groupIssueNone' | 'groupIssueCreate' | 'groupIssueTitle' | 'groupIssueBody'
  | 'groupIssueProject' | 'groupIssueClose' | 'groupIssueReopen' | 'groupIssueReason' | 'groupIssueConclusion'
  | 'groupIssueList' | 'groupIssueListEmpty' | 'groupIssueListHint' | 'groupIssueOpen'
  | 'groupManage' | 'groupInvitationPending' | 'groupInvitationAccepted' | 'groupInvitationDeclined' | 'groupInvitationRevoked'
  | 'groupActionUnfinished' | 'groupActionFinished' | 'groupActionDiagnostics' | 'groupActionNoIssue' | 'groupActionNoIssueHint' | 'groupReadFailed'
  | 'groupActions' | 'groupActionsNone' | 'groupActionCreate' | 'groupActionAssignee' | 'groupActionReason'
  | 'groupActionResult' | 'groupActionSubmit' | 'groupActionRefuse' | 'groupActionReport'
  | 'groupActionReportKind' | 'groupActionReportReason' | 'groupActionReportEvidence'
  | 'groupActionRefusalReason' | 'groupActionRefusedAt'
  | 'groupActionReportBlocked' | 'groupActionReportFailed'
  | 'groupPhaseLoading' | 'groupPhaseEmpty' | 'groupPhaseLive'
  | 'groupNotConfigured' | 'groupUnreachable' | 'groupRefused' | 'groupUnknown' | 'groupFailed'
  | 'groupRetry' | 'groupConfirm' | 'groupConfirmAccept' | 'groupConfirmCancel' | 'groupNoMessages'
  | 'groupTarget' | 'groupOutcomeSucceeded' | 'groupOutcomePending' | 'groupOutcomeIdle'
  | 'groupActor' | 'groupNoActor' | 'groupChooseActor' | 'groupChooseActorHint'
  | 'groupCloseImpact' | 'groupStopReport' | 'groupStopPending' | 'groupStopAccepted'
  | 'groupStopInProgress' | 'groupStopCancelRequested' | 'groupStopBlocked' | 'groupStopFailed'
  | 'groupStopCompleted' | 'groupStopRefused' | 'groupStopCancelled' | 'groupStopUnknown'

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
  createSession: 'Create session', cancelSession: 'Cancel session', directoryRow: 'Directory only',
  availabilityChanging: 'Session runtime changing', availabilityStopped: 'Session runtime stopped', availabilityNoCurrent: 'Session runtime not applied', availabilityUncertain: 'Session runtime uncertain',
  availabilityNotApplicable: 'No Session owner', availabilityCurrent: 'Session ready', observationDegraded: 'Session observation degraded', observationLost: 'Session observation lost',
  declaredServices: 'Declared services', capabilityDetailUnavailable: 'Service and resource detail is unavailable.', capabilityDetailEmpty: 'This Agent declares no services.',
  noDeclaredResources: 'No declared resources', declaredCapacity: 'Declared capacity', operations: 'Operations',
  pageDiscovery: 'Discover', pageNetworking: 'Network', pageInteraction: 'Interact', pageHistory: 'History',
  connect: 'Connect', disconnect: 'Disconnect', removeDraftMember: 'Remove', draft: 'Draft', accepted: 'Accepted', master: 'Master', peer: 'Peer', applyMembership: 'Apply membership',
  historyPrev: 'Previous page', historyRequest: 'Request history is refused by the owner.', historyUnavailable: 'History is unavailable.', permissionOptionsUnavailable: 'Permission choices are unavailable from the engine callback.',
  workRecords: 'Work records', workRecordsUnavailable: 'This connection does not provide Work records.', workRecordsEmpty: 'No Work records.', workRefresh: 'Refresh Work records', connectionHistory: 'Connection history', historyRetry: 'Retry connection history',
  workAccepted: 'Accepted', workClosing: 'Closing', workClosed: 'Closed', workRejected: 'Rejected',
  cancelRequested: 'Cancel requested', cancelConfirmed: 'Cancel confirmed', cancelUnknown: 'Cancel outcome unknown',
  pageGroups: 'Groups', groupList: 'Groups', groupSelected: 'Selected group', groupMembers: 'Members', groupMessages: 'Messages', groupComposer: 'Message the group',
  groupSend: 'Send message', groupCreate: 'Create group', groupName: 'Group name', groupInvite: 'Invite member', groupInviteAgent: 'Agent ID', groupInviteRole: 'Role',
  groupInviteAgentEmpty: 'No invitee available', groupActionAssigneeEmpty: 'No assignable member', groupActionAssigneeEmptyHint: 'You hold no command edge yet. Allow the group to assign work to a member first.', groupGrant: 'Allow assigning work', groupGrantHint: 'Only the group owner can widen these edges.',
  groupIssue: 'Issue', groupIssueNone: 'No issue is bound to this group.', groupIssueCreate: 'Create issue', groupIssueTitle: 'Issue title', groupIssueBody: 'Issue body',
  groupIssueProject: 'Vikunja project ID', groupIssueClose: 'Close issue', groupIssueReopen: 'Reopen issue', groupIssueReason: 'Reason', groupIssueConclusion: 'Conclusion',
  groupIssueList: 'Issues in this group', groupIssueListEmpty: 'No issue belongs to this group yet.', groupIssueListHint: 'The issue list could not be read. You can still create an issue below.', groupIssueOpen: 'Open issue',
  groupManage: 'Manage group', groupInvitationPending: 'Pending', groupInvitationAccepted: 'Accepted', groupInvitationDeclined: 'Declined', groupInvitationRevoked: 'Revoked',
  groupActionUnfinished: 'Unfinished', groupActionFinished: 'Finished', groupActionDiagnostics: 'Diagnostics', groupActionNoIssue: 'No issue is open in this group', groupActionNoIssueHint: 'Actions belong to an issue. Create or open an issue first; a group-wide action list is never shown as this issue’s work.', groupReadFailed: 'This section could not be read',
  groupActions: 'Actions', groupActionsNone: 'No action is recorded for this group.', groupActionCreate: 'Create action', groupActionAssignee: 'Assignee agent ID', groupActionReason: 'Reason',
  groupActionResult: 'Result body', groupActionSubmit: 'Submit result', groupActionRefuse: 'Refuse action', groupActionReport: 'Report blocked or failed',
  groupActionReportKind: 'Report', groupActionReportReason: 'Reported reason', groupActionReportEvidence: 'Evidence',
  groupActionRefusalReason: 'Refusal reason', groupActionRefusedAt: 'Refused at',
  groupActionReportBlocked: 'Report blocked', groupActionReportFailed: 'Report failed',
  groupPhaseLoading: 'Loading groups…', groupPhaseEmpty: 'No group exists yet. Create one to start a conversation.', groupPhaseLive: 'Group workspace',
  groupNotConfigured: 'The group endpoint is not configured on this Console host.', groupUnreachable: 'The group endpoint exists but the agent is unreachable.',
  groupRefused: 'The group owner refused this request.', groupUnknown: 'The owner outcome is unknown. Retry with the same commit.', groupFailed: 'The group workspace could not be loaded.',
  groupRetry: 'Retry', groupConfirm: 'Confirm this action', groupConfirmAccept: 'Confirm', groupConfirmCancel: 'Cancel', groupNoMessages: 'No message has been exchanged in this group yet.',
  groupTarget: 'Target', groupOutcomeSucceeded: 'Owner accepted the request', groupOutcomePending: 'Waiting for the group owner', groupOutcomeIdle: 'Ready',
  groupActor: 'Acting as', groupNoActor: 'No projected agent can act for groups; the Console control owner never acts.',
  groupChooseActor: 'Choose the agent', groupChooseActorHint: 'Several agents can act for a group. Choose the one this Console speaks as; the group list loads as soon as you do.',
  groupCloseImpact: 'Close impact: these actions are not confirmed stopped.',
  groupStopReport: 'Close report: actions not confirmed stopped.',
  groupStopPending: 'queued, cancelled by the close', groupStopAccepted: 'accepted, not confirmed stopped',
  groupStopInProgress: 'in progress, not confirmed stopped', groupStopCancelRequested: 'stop requested, not confirmed stopped',
  groupStopBlocked: 'blocked, not confirmed stopped', groupStopFailed: 'failed',
  groupStopCompleted: 'completed', groupStopRefused: 'refused',
  groupStopCancelled: 'stop confirmed', groupStopUnknown: 'outcome unknown, not confirmed stopped',
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
  createSession: '新建会话', cancelSession: '取消会话', directoryRow: '仅目录',
  availabilityChanging: '会话运行环境切换中', availabilityStopped: '会话运行环境已停止', availabilityNoCurrent: '会话运行环境未生效', availabilityUncertain: '会话运行环境不确定',
  availabilityNotApplicable: '无会话所有者', availabilityCurrent: '会话就绪', observationDegraded: '会话观察降级', observationLost: '会话观察丢失',
  declaredServices: '已声明服务', capabilityDetailUnavailable: '服务与资源明细不可用。', capabilityDetailEmpty: '该智能体未声明任何服务。',
  noDeclaredResources: '未声明资源', declaredCapacity: '声明容量', operations: '操作',
  pageDiscovery: '发现', pageNetworking: '组网', pageInteraction: '交互', pageHistory: '历史',
  connect: '连接', disconnect: '断开连接', removeDraftMember: '移除', draft: '草稿', accepted: '已接受', master: '主节点', peer: '对等节点', applyMembership: '提交组网草稿',
  historyPrev: '上一页', historyRequest: '请求历史被所有者拒绝。', historyUnavailable: '历史不可用。', permissionOptionsUnavailable: '引擎回调未提供权限选择。',
  workRecords: 'Work 记录', workRecordsUnavailable: '当前连接未提供 Work 记录。', workRecordsEmpty: '暂无 Work 记录。', workRefresh: '刷新 Work 记录', connectionHistory: '连接历史', historyRetry: '重试连接历史',
  workAccepted: '已接纳', workClosing: '关闭中', workClosed: '已关闭', workRejected: '已拒绝',
  cancelRequested: '已请求取消', cancelConfirmed: '取消已确认', cancelUnknown: '取消结果未知',
  pageGroups: '群组', groupList: '群组', groupSelected: '当前群组', groupMembers: '成员', groupMessages: '消息', groupComposer: '向群组发送消息',
  groupSend: '发送消息', groupCreate: '创建群组', groupName: '群组名称', groupInvite: '邀请成员', groupInviteAgent: '智能体 ID', groupInviteRole: '角色',
  groupInviteAgentEmpty: '暂无可邀请的智能体', groupActionAssigneeEmpty: '暂无可指派成员', groupActionAssigneeEmptyHint: '你还没有向成员指派工作的权限，请先允许群组向该成员指派。', groupGrant: '允许向其指派', groupGrantHint: '只有群组 owner 可以扩展这项权限。',
  groupIssue: '议题', groupIssueNone: '当前群组还没有议题。', groupIssueCreate: '创建议题', groupIssueTitle: '议题标题', groupIssueBody: '议题内容',
  groupIssueProject: 'Vikunja 项目 ID', groupIssueClose: '关闭议题', groupIssueReopen: '重新打开议题', groupIssueReason: '原因', groupIssueConclusion: '结论',
  groupIssueList: '群组议题', groupIssueListEmpty: '当前群组还没有议题。', groupIssueListHint: '无法读取议题列表。你仍可在下方创建议题。', groupIssueOpen: '打开议题',
  groupManage: '管理群组', groupInvitationPending: '待接受', groupInvitationAccepted: '已接受', groupInvitationDeclined: '已拒绝', groupInvitationRevoked: '已撤销',
  groupActionUnfinished: '未结束', groupActionFinished: '已完成', groupActionDiagnostics: '诊断', groupActionNoIssue: '当前群组还没有打开的议题', groupActionNoIssueHint: '行动属于议题。请先创建或打开议题；不会把全局行动列表当作本议题的工作。', groupReadFailed: '本区域读取失败',
  groupActions: '行动', groupActionsNone: '当前群组还没有行动记录。', groupActionCreate: '创建行动', groupActionAssignee: '负责智能体 ID', groupActionReason: '原因',
  groupActionResult: '结果内容', groupActionSubmit: '提交结果', groupActionRefuse: '拒绝行动', groupActionReport: '上报阻塞或失败',
  groupActionReportKind: '上报', groupActionReportReason: '上报原因', groupActionReportEvidence: '证据',
  groupActionRefusalReason: '拒绝原因', groupActionRefusedAt: '拒绝时间',
  groupActionReportBlocked: '上报阻塞', groupActionReportFailed: '上报失败',
  groupPhaseLoading: '正在加载群组…', groupPhaseEmpty: '还没有群组。创建一个群组即可开始对话。', groupPhaseLive: '群组工作区',
  groupNotConfigured: '当前控制台没有配置群组入口。', groupUnreachable: '群组入口存在，但无法连接到对应智能体。',
  groupRefused: '群组所有者拒绝了这次请求。', groupUnknown: '所有者结果未知。请用同一个提交重试。', groupFailed: '无法加载群组工作区。',
  groupRetry: '重试', groupConfirm: '确认这次操作', groupConfirmAccept: '确认', groupConfirmCancel: '取消', groupNoMessages: '该群组还没有消息。',
  groupTarget: '对象', groupOutcomeSucceeded: '所有者已接受请求', groupOutcomePending: '等待群组所有者处理', groupOutcomeIdle: '就绪',
  groupActor: '当前以', groupNoActor: '没有可作为群组身份的项目智能体；控制台控制端不参与群组。',
  groupChooseActor: '请选择智能体', groupChooseActorHint: '有多个智能体可以作为群组身份。请选择控制台要使用的那个，选择后立即加载群组列表。',
  groupCloseImpact: '关闭影响：这些行动尚未确认停止。',
  groupStopReport: '关闭报告：尚未确认停止的行动。',
  groupStopPending: '排队中，关闭时取消', groupStopAccepted: '已接管，尚未确认停止',
  groupStopInProgress: '执行中，尚未确认停止', groupStopCancelRequested: '停止请求已发出，尚未确认停止',
  groupStopBlocked: '阻塞，尚未确认停止', groupStopFailed: '失败',
  groupStopCompleted: '已完成', groupStopRefused: '已拒绝',
  groupStopCancelled: '已确认停止', groupStopUnknown: '结果未知，尚未确认停止',
}

export function messages(locale: Locale): Record<MessageKey, string> {
  return locale === 'zh' ? zh : en
}

export type { MessageKey }
