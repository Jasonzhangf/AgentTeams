# Teams 群组通信、issue 会话与 action 执行 v1(修订版)

状态:design 修订版(revision 10)。本文件替代原 `teams-group-messaging-v1.md` 的群内消息、会话、action、
注入、关闭、投递语义。审计反馈和用户确认的决定已落实到对象模型、线协议、权限、投递、
Session 映射、关闭和分批。本文件是唯一 owner;不并存两套契约。受影响架构映射已同步:模块归属登记在
`docs/architecture/module-registry.json` 的 `group-messaging` 条目,实现后按
`group-wire`、`group-registry`、`issue-session`、`action-registry`、`message-log`、
`message-router`、`group-channel`、`agent-messaging`、`local-message-socket`、`vikunja-sync`、
`vikunja-intent` 拆分为独立 owner。

owner:`control-protocol/group-wire.ts`(帧)、`server/group-registry.ts` + `server/issue-session.ts`
+ `server/action-registry.ts` + `server/message-log.ts` + `server/message-router.ts`(hub 侧真源)、
`network/group-channel.ts`(通道)、`runtime/agent-messaging.ts`(注入与回话)、
`runtime/vikunja-sync.ts`(外部写入)。

## 1. 决策记录

用户确认的决定,本设计全部落实。

| 编号 | 决定 |
| --- | --- |
| D1 | 初始增量只做 CLI,不做 MCP 或 skill。后续用户已授权首版 WebUI;它复用同一 typed 服务入口,不另建业务真源。 |
| D2 | 星型拓扑。所有 agent 连 relay,hub 路由。本阶段不做点对点。 |
| D3 | 复用现有 agentteams WSS+TLS 通道,不新造传输。 |
| D4 | 远端消息注入本地引擎 ACP Session。只有明确行动对象的消息才启动模型。 |
| D5 | 提供 queue(空闲注入)和 steer(取消后注入)两种模式。 |
| D6 | 离线缓存放 hub 宿主机 dataDirectory,默认 `~/.agentteams`。 |
| D10 | tailscale 外部安装,agentteams 只绑定接口。 |
| D11 | 角色复用 master/peer 词表,不新建角色词汇。 |
| D12 | 群主邀请加批准。建群者为 master。 |
| D13 | 消息属于群共享空间。@ 指定行动对象,不是私聊。旁观成员收到不启动模型。 |
| D14 | 一个会话绑定一个 Vikunja issue。同一群可以有多个 issue 会话。Vikunja 是 issue 开闭状态的唯一真源。 |
| D15 | 会话发起者负责关闭和重开。关闭必须关闭原 issue,重开必须重开原 issue。action 完成不关闭会话。关闭后迟到消息只留历史。 |
| D16 | 支持讨论、comment、审计。参与者把自己的 comment/结果写回 Vikunja 后本人 action 结束,不自动往返。发起者阅读后关闭或带原因发起追问。 |
| D17 | peer 可要求 master 回复或行动,master 可带原因拒绝。master 对 peer 的有效指派,peer 不能主动拒绝,只能带证据报告缺信息、阻塞或失败。角色不能绕过系统权限与能力边界。 |
| D18 | 每个 action 有稳定 id,答复关联原 action,追问创建新 action。普通评论、进展、结果不隐式创建新责任。多人参与各自独立完成。 |

来源标注:D1 到 D18 来自用户确认。第 8 节的模块名和路径、第 9 节线协议的具体字段、第 10 节
目录布局是实现建议,评审后可调整。第 19 节区分已确认决定与仍待决定事项。本文件不声称已完成
运行验收。

revision 3 补正:执行条件改为有效 action 且当前 agent 是 assignee;外部操作指定唯一执行
owner;外部关闭收敛前移到第一批;issue/action/comment 补稳定幂等键与回读;action 与外部
操作持久恢复;注入与结果提交拆开;DAG typed outcome 传播规则;权限矩阵条件授权;成员有效
区间过滤;离群取消请求与执行停止分开。

revision 4 补正:条件授权按方向分别定义,不要求反向边;开闭操作加顺序与恢复规则,冲突或
unknown 不再重写;在飞取消改为 cancel_requested 到 cancelled 的两步,停止前结果不丢;外部
操作帧方向、回执鉴权与确定失败回执补齐。

revision 5:revision 4 通过契约复核。用户确认 5 项待决定事项(peer->peer、多 master、
Vikunja 身份、非发起者关闭与显式委托、容量与保留期),第 19 节改为已确认决定;仅 ACP
Session 映射留到第二批。

revision 6:补齐首版 WebUI 恢复旧议题所需的 `issue.list` 只读协议、SESE 图和验收。
列表读取 hub 已持久会话,不绑定外部 issue,不查询 Vikunja,不证明外部状态新鲜。
WebUI 授权沿 `teams-group-webui-design.md`;本轮只改设计,产品修复和运行证据分别验收。

revision 7:允许 pending action 直接报告 blocked/failed,新增持久 `Action.report`,并对齐
`action.report` 帧字段命名。

revision 8:新增持久 `Action.refusal`,master 拒绝 peer 请求时原因非空、不覆盖原 `reason`;
外部关闭收敛由 registry daemon 持有的唯一有界 scheduler 驱动,GroupHub 保留 issue 真源、
读取委托与共用 close settlement。读失败保持 unknown 并拒绝新 action;Console 不承担同步。

revision 9:恢复 13.1 的读取 owner 委派、命令前刷新与在飞缩短边界,并记录第一批有界
sweep 的实际实现(单轮有界并发、单读超时、30 秒窗口和 registry 状态可观测回执);离线改派
与在飞缩短列为未实现项,附最小方案与验收,不静默降需求。

revision 10:离线受信 reader 改派与在飞缩短按 13.1 的最小方案实现并验收。只读 `issue.query`
在发起者离线时换到同群当前有效的在线成员,沿用同一 op/commit 与回执鉴权;无可用受信
reader 时保持 unknown 并拒绝新 action,不静默降级。registry scheduler 仍只持有一个 timer,
按 GroupHub 暴露的真实在飞 action 会话集合缩短读取间隔,普通会话不提前读。变更类外部写
不换 owner 重写。未权威收敛的 close 意图(pending/inflight/unknown)同时封住新准入,
只有原 close 的只读恢复或更高代次的新 reopen 意图可以解封。

## 2. 被替代的旧语义

以下旧语义已废除,本文不再引用。

| 旧语义 | 修订后 |
| --- | --- |
| `target: broadcast \| {agentId}` 表达送达对象 | 消息仍在群内可见;@ 是行动对象,不改变可见性。发送参数显式给出 issue、action、行动对象、原因、预期结果、是否要求回复。 |
| 一个 group 一个会话 | 一个 Vikunja issue 一个会话。一个 group 可含多个 issue 会话。 |
| 注入完成后自动回复并再次注入 | 只有带行动责任的目标才启动处理;完成、评论、进展、关闭只更新记录。追问才创建下一项 action。 |
| Teams 与 Vikunja 双向状态覆盖 | Vikunja 是 issue 开闭状态唯一真源。Teams 只投影该状态,不维护第二套可修改状态。 |
| 一个 action 完成后隐含下一个往返 | 参与者写回后本人 action 结束。发起者显式决定关闭或追问。 |

## 3. 范围与非目标

范围:

1. CLI `join`、`group`、`issue`、`action`、`msg`、`status`。
2. hub 侧群组注册、成员准入、issue 会话、action 注册、消息持久接受、路由、水位补投。
3. daemon 侧订阅、排队、ACP 注入、回话绑定、结果写回。
4. Vikunja 最小能力:创建/引用 issue、读状态、写 comment/结果、关闭、重开、身份映射。

非目标:

- 点对点直连。egress/ingress/negotiation 保留不动。
- MCP 工具、skill。
- Console 作为数据路径。
- 公网 Relay、NAT/STUN、移动端。
- 在消息体里承载任务语义。
- Vikunja webhook 事件通知(第三批)。

## 4. 拓扑

```text
人
 |
 |  CLI: agentteams group|issue|action|msg|status
 v
本地 Unix socket
 |
 v
本地 agent daemon(acp-serve)
 |         |
 |         | session/prompt 注入,结果回送
 |         v
 |     本地引擎(OpenCode / DSH)
 |
 | WSS+TLS(现有 agentteams 通道,复用 RegistrationClient 连接)
 v
relay hub
   群组注册表、成员准入、issue 会话、action、消息 log、路由、水位
   |
   +--> agent daemon B --> 引擎 B
   +--> agent daemon C --> 引擎 C
```

发送路径:CLI -> 本地 socket -> daemon -> hub -> 目标 daemon。
接收路径:hub -> 目标 daemon -> 注入本地引擎 -> 结果写回 Vikunja -> 发起者可见。

Tailscale:relay 监听 tailscale 地址。tailscale 外部维护,agentteams 只绑定接口。

## 5. 核心对象模型

```text
Group {
  groupId, name, ownerAgentId, revision
  members: [{
    agentId,
    role: 'master'|'peer',
    admin: boolean,
    mastersOf: agentId[],      // 显式指挥边。谁指挥谁,不靠角色名推导
    state: 'invited'|'active',
    joinedAt
  }]
}

IssueSession {
  sessionId,                   // 稳定 id,1:1 绑定 vikunjaIssueId
  groupId,
  vikunjaIssueId,
  vikunjaProjectId,
  initiatorAgentId,            // 关闭/重开责任人
  state: 'open'|'closed',      // 本地投影,由 Vikunja 回读收敛
  openedAt, closedAt?, closeReason?,
  lastVerifiedAt               // 最近一次从 Vikunja 读状态的时间
}

Action {
  actionId,                    // 稳定 id
  commitId,                    // 创建操作的稳定幂等键,跨重连不变
  sessionId,
  initiatorAgentId,
  assigneeAgentId,             // 唯一责任真源。执行条件由它决定,不由 replyRequired 决定
  kind: 'reply'|'review'|'comment'|'audit'|'followup',
  reason,                      // 具体原因
  expectedResult,              // 预期结果
  replyRequired, replyRequiredReason,   // 只决定是否需面向发起者答复,不决定是否执行
  inReplyToActionId?,          // 追问关联先前 action 或评论
  state: 'pending'|'accepted'|'refused'|'blocked'|'in_progress'
        |'cancel_requested'|'completed'|'failed'|'unknown'|'cancelled',
  report?: {                   // 被指派人的持久报告,不代表结果 comment 已完成
    report: 'blocked'|'failed', reason, evidence?, reportedAt
  },
  refusal?: {                  // master 拒绝 peer 请求的持久原因;不覆盖原 reason
    reason, refusedAt
  },
  resultCommitId?,             // 结果提交操作的稳定幂等键
  resultRef?,                  // 写回 Vikunja 的 comment id
  createdAt, completedAt?
}

Message {
  messageId,
  commitId,                    // 发送方稳定幂等 id,跨重连不变
  sequence,                    // hub 分配的群内单调序号
  groupId, sessionId?, actionId?,
  fromAgentId,
  targetAgentIds: [],          // 由 action 派生或与 action 严格校验一致,不是第二责任真源
  replyRequired, replyRequiredReason,
  body,
  sentAt, inReplyToMessageId?
}

Watermark { groupId, agentId, upToSequence }

DeliveryRecord {
  messageId, targetAgentId,
  state: 'pending'|'delivered'|'acked'|'gap'|'rejected'
}
```

身份来源:成员身份取传输认证后的 agentId,不取消息体里的值。行动对象必须来自显式参数。
`Action.report` 的 `reason` 必填非空,`reportedAt` 由服务端写入,报告人取自认证身份与 assignee 校验。
它由 action.report 帧写入,只表达该 action 的执行报告,不产生也不代表 Vikunja 结果 comment。

## 6. 生命周期语义

### 6.1 发起

发起者用 `issue.create` 或 `issue.reference` 打开会话,再用 `action.create` 指派行动。
每次指派至少明确:发起人、issue、action、具体原因、行动对象、预期结果、是否要求回复及原因。
广播要求多人行动时,为每人记录独立 action;一人完成不关闭他人的 action。

action 是责任的唯一真源。消息里的 @ 由 action 派生,或多目标消息的 `targetAgentIds` 必须与
对应 action 的 assignee 集合严格一致。不一致时拒绝发送,不从正文猜测。

### 6.2 讨论、comment、审计

发起者邀请指定成员讨论、comment 或审计。参与者把自己的评论、意见或审计结果成功写入
Vikunja issue 后,本人 action 结束,不等其他参与者,也不自动继续往返。发起者阅读后可以
关闭 issue,或带具体原因向指定成员创建追问 action。

### 6.3 追问

追问是新建的显式 action,关联先前 action 或评论,不重新激活已完成的 action。

### 6.4 关闭

发起者执行 `issue.close`。关闭必须成功关闭 Vikunja issue 并读回确认。关闭前处置未完成
action:未开始的取消;在飞的进入取消或收口,已有副作用保留事实。action 完成不等于关闭。

### 6.5 重开

发起者执行 `issue.reopen`。重开必须成功重开原 issue 并记录原因。旧 action 不自动重跑。

### 6.6 迟到消息

关闭后的迟到消息只写历史,不触发行动,不自动重开。

### 6.7 action 状态转换

执行条件是存在有效 action 且当前 agent 是 `assigneeAgentId`。`replyRequired` 不参与该判断。
无须答复的行动仍要记录完成结果;comment、审计类行动以成功写入 issue 为完成条件。

| 起始 | 目标 | 触发 | 推进 owner |
| --- | --- | --- | --- |
| (新建) | pending | action.create 持久成功 | hub(action-registry) |
| pending | accepted | 被指派人确认接收 | assignee daemon |
| pending | cancelled | 会话关闭前未开始,或成员离群未开始 | hub |
| pending | refused | 仅 peer->master 请求被 master 带原因拒绝 | master |
| accepted / pending | in_progress | 开始执行 | assignee daemon |
| in_progress | completed | 结果提交 Vikunja 并读回确认;或明确无须答复且已记录完成 | 结果提交 owner |
| in_progress | blocked | 执行报告缺信息或阻塞,带证据 | assignee daemon |
| in_progress | failed | 执行失败,带证据 | assignee daemon |
| pending | blocked | 尚未开始即报告缺信息或阻塞,带证据 | assignee daemon |
| pending | failed | 尚未开始即确定失败,带证据 | assignee daemon |
| in_progress | cancel_requested | 取消请求已发出,执行状态未结束 | hub 或 assignee daemon |
| cancel_requested | cancelled | 收到执行停止确认 | 执行 owner |
| cancel_requested | unknown | 无法确认执行已停止,保留停止事实 | hub 标记,执行 owner 回读 |
| cancel_requested | completed | 停止确认前执行已实际完成,结果可确认 | 执行 owner |
| in_progress | unknown | 崩溃或外部响应丢失,结果不可确定 | hub 标记,执行 owner 回读 |

终态与推进规则:

- completed、refused、cancelled 是终态。不自动重跑,不因重开复活。
- 发出取消后先进入 cancel_requested,执行状态保持未结束;收到停止确认才进 cancelled。
  不能仅凭发出请求就把 in_progress 改成终态 cancelled。无法确认停止时保留 unknown 和停止
  事实。尚未停止执行期间到达的结果,按实际结果归入 completed 或 failed,迟到结果不丢。
- blocked 与 failed 不自动推进。由 master 决定重新指派(新 action)或调整;原 action 保持记录。
- pending 直接报告 blocked/failed 不表示执行已开始,也不改变 peer 不能拒绝 master 有效指派的规则;
  原 action 记录保留,重新指派创建新 action。
- pending 到 refused 必须有非空原因。refusal.reason 持久保存,发起者刷新 action.list 可见;
  refusal 不覆盖 action.reason。
- unknown 不是终态。由执行 owner 按 commitId 回读目标 API 收敛为 completed 或 failed。
  回读无法确定时保持 unknown 并上报,不盲目重试。
- cancelled 只证明执行已停止。issue 可以先关闭,但关闭报告中必须列出尚未确认停止的 action。

## 7. 权限与指挥权

三种权限分开:群管理权、行动指挥权、issue 关闭责任。

### 7.1 群管理权

owner 和 admin 成员可邀请、批准、移除成员、授予角色和指挥边。普通成员不能改成员表。

### 7.2 行动指挥权

指挥边是显式的 `mastersOf`,由邀请时建立,成员移除时清理。群 admin 可以在邀请时建立边、
在移除时清理边,但任何 action 指派或请求都必须存在方向正确的边:

- master -> peer 指派:该 master 的 `mastersOf` 包含该 peer。
- peer -> master 请求:目标 master 的 `mastersOf` 包含发起 peer。

两条共用同一条边,不要求双向。owner 和 admin 不因角色自动获得指挥权。指派校验针对该边:

| 方向 | 语义 |
| --- | --- |
| master -> peer | 有效指派。peer 不能主动拒绝,只能报告缺信息、阻塞或失败。 |
| peer -> master | 请求。master 可带原因拒绝。拒绝只结束该 action,不关闭 issue。 |
| peer -> peer | 无指挥边。双方经共同 master 或发起者请求。 |
| 多 master | 允许。各 master 指挥自己显式列出的 peer,不做全局仲裁。 |

角色不能绕过系统权限、安全限制或未授予能力。超出执行边界返回明确错误,不伪装成功。

### 7.3 issue 关闭责任

只有会话发起者可关闭或重开。非发起者请求关闭,发起者执行;发起者可显式委托给指定成员。

### 7.4 权限矩阵

| 操作 | owner/admin | master | peer(成员) | 非成员 | 被邀请者 |
| --- | --- | --- | --- | --- | --- |
| 建群 | 是 | 是 | 是 | 否 | 否 |
| 邀请/批准/移除/授角色 | 是 | 否 | 否 | 否 | 否 |
| 入群接受/拒绝 | 否 | 否 | 否 | 否 | 是。入群与行动接受分开 |
| 离开 | 是 | 是 | 是 | 否 | 否 |
| 发群消息 | 是 | 是 | 是 | 否 | 否 |
| 读群历史 | 是 | 是 | 是(自入群时点起) | 否 | 否 |
| 创建/引用 issue | 是 | 是 | 是 | 否 | 否 |
| 指派 peer(master->peer) | 条件授权 | 条件授权 | 否 | 否 | 否 |
| 请求 master(peer->master) | 否 | 否 | 条件授权 | 否 | 否 |
| 拒绝指派 | 否 | 仅拒绝指向自己的 peer 请求 | 否 | 否 | 否 |
| 报告阻塞/失败 | 是(限本人 action) | 是(限本人 action) | 是(限本人 action) | 否 | 否 |
| 关闭/重开 issue | 仅发起者 | 仅发起者 | 仅发起者 | 否 | 否 |

两个方向的授权分别校验,不要求双方各有一条反向指挥边:

- master -> peer 指派:校验该 master 的 `mastersOf` 包含该 peer。peer 不可主动拒绝,只能报告缺信息、阻塞或失败。
- peer -> master 请求:校验目标 master 的 `mastersOf` 包含发起 peer。master 可以带原因拒绝。

条件授权指存在一条方向正确的 `mastersOf` 边,不要求双向。仅凭 owner、admin 或 master 角色名
不构成授权。矩阵中的"是"只表示角色不额外阻挡,仍受指挥边和系统能力约束。同一对 master/peer
用同一条 `mastersOf` 边覆盖指派和请求两个方向。

peer 不能拒绝 master 的指派,不等于不能拒绝入群。受邀者可以拒绝入群。

在线推送、历史查询、离线补投使用同一成员和 scope 约束。成员记录用有效区间
`intervals: [{ joinedAt, leftAt? }]`,不是单一水位。

- 新成员只见入群后的历史。加入前消息不补投。
- 退出后访问撤销。退出期间的消息不补投给该成员。
- 重入开新区间,只补投新区间内的消息。离群期间消息不补投,不能靠保留原水位恢复全部历史。
- inReplyTo/action 引用必须属于允许访问的 issue 与群,且落在该成员某个有效区间内。

## 8. 模块设计

新增模块:

| 模块 | 路径 | owner | 职责 | 禁止路径 |
| --- | --- | --- | --- | --- |
| group-wire | `control-protocol/group-wire.ts` | control-protocol | 群组、issue、action、消息帧的唯一类型与编解码。不持有状态。 | `server/`,`network/`,`runtime/` |
| group-registry | `server/group-registry.ts` | server | 群组与成员真源。建群、邀请、准入、离开、指挥边。 | `agent/`,`ui/` |
| issue-session | `server/issue-session.ts` | server | 会话真源。会话与 Vikunja issue 的绑定、状态投影。 | `agent/`,`ui/` |
| action-registry | `server/action-registry.ts` | server | action 真源。稳定 actionId、发起人、被指派人、原因、预期结果、追问关联、终态。 | `agent/`,`ui/` |
| message-log | `server/message-log.ts` | server | 追加式消息 log、每成员水位、补投选择、保留缺口。 | `agent/`,`ui/` |
| message-router | `server/message-router.ts` | server | 群内可见路由、@ 行动对象分派、在线推送。 | `agent/`,`ui/` |
| group-channel | `network/group-channel.ts` | network | 客户端侧群组/issue/action/消息通道,跑在 RegistrationClient 同一连接上。 | `server/`,`agent/` |
| agent-messaging | `runtime/agent-messaging.ts` | runtime | daemon 侧订阅、排队、注入、回话绑定、结果写回。 | `server/`,`network/` |
| local-message-socket | `runtime/local-message-socket.ts` | runtime | CLI 到 daemon 本地通道,复用 `runtime/local-work-control.ts` 的 Unix socket 模式。 | `server/` |
| vikunja-sync | `runtime/vikunja-sync.ts` | runtime | Vikunja 最小能力:创建/引用 issue、读状态、写 comment、关闭、重开。 | `server/`,`network/` |
| vikunja-intent | `config/vikunja-intent.ts` | config | `[vikunja]` 配置意图编译和校验。 | `server/`,`runtime/` |

修改的既有模块:

| 模块 | 变更 |
| --- | --- |
| `server/relay.ts` | 接入 group-registry、issue-session、message-log、message-router 的帧分派。不新增第二个目录 store。 |
| `network/registration-client.ts` | 在现有在线连接上增加群请求/回执关联、推送订阅、重连后重建订阅。不新开 socket。 |
| `network/relay-client.ts` | 把 `relay.group.*`、`relay.issue.*`、`relay.action.*`、`relay.message.*` 纳入 `Event` 与 `Reply` 联合。这是必要条件,不是充分条件。 |
| `runtime/acp-serve.ts` | 启动时组合 agent-messaging、local-message-socket、vikunja-sync。 |
| `cli/agentteams.mjs` | 增加 `join`、`group`、`issue`、`action`、`msg`、`status` 子命令。 |
| `config/daemon-intent.ts` | 增加可选 `[vikunja]` 段,只对 agent kind 有效。这是 D00 amendment A5,单独记录。 |

边界:hub 拥有 action 授权、action 生命周期和外部操作委派记录,不解释消息正文。外部写入由
唯一执行 owner 在 daemon 侧完成。hub 记录外部操作状态并投影给其他 daemon;其他 daemon 只信
hub 投影,不各自直读 Vikunja。Console 不进数据路径。

### 8.1 外部操作执行归属

每种外部操作只有一个执行 owner。执行 owner 是该操作的责任人所在 daemon。

| 外部操作 | 唯一执行 owner | hub 职责 | 结果确认 | owner 断线后 |
| --- | --- | --- | --- | --- |
| issue.create / issue.reference | 发起者所在 daemon 的 vikunja-sync | 鉴权,写 op 记录(pending),委派,投影 | 读回 issue 后回 confirmed | op 置 unknown,按 11.2 先回读;变更操作不换 daemon 再写,只读查询可换受信读取 daemon |
| issue.close / issue.reopen | 发起者所在 daemon 的 vikunja-sync | 同上 | 读回状态后回 confirmed | 同上 |
| action.submit 结果 comment | assignee 所在 daemon;人工提交时为 CLI 所连 daemon | 写 result op 记录,委派,投影 | 读回 comment 后回 confirmed | 同上 |
| issue.query 状态读取 | 发起者所在 daemon;离线时由 hub 委派的受信读取 daemon | 委派与投影 | 读回状态后回 confirmed | 下一轮轮询重新委派,只读操作允许换 owner |
| 关闭/结果验证 | 不需要各 daemon 直读 | 只信 hub 投影 `issue.changed`、`action.changed` | hub 投影即权威 | 不适用 |

命令到持久状态的路径:

1. 客户端命令到 hub。
2. hub 鉴权,先持久化 op 记录(`pending`,含 commitId),回 accepted 回执。accepted 不是 done。
3. hub 把 op 委派给执行 owner(`op.execute`,方向 hub -> 执行 owner)。
4. 执行 owner 调 Vikunja,得到确定结果、失败或 unknown。
5. 执行 owner 回执 `op.confirmed`、`op.failed` 或 `op.unknown`,方向执行 owner -> hub。
6. hub 校验回执来自该 op 被委派的认证 owner,并匹配原 op 与 commitId。校验不通过直接丢弃,
   不改变投影。
7. hub 持久化 op 终态,更新会话或 action 投影,推 `issue.changed` 或 `action.changed`。
8. 执行 owner 断线:hub 把 in-flight op 置 unknown。变更操作恢复先回读,不因旧 owner 断线就
   让另一 daemon 再执行一次写入;只读查询单独处理,可换受信读取 daemon。

## 9. 线协议

客户端到 hub:

```text
group.create    { requestId, name }
group.invite    { requestId, groupId, agentId, role, mastersOf? }
group.respond   { requestId, groupId, accept }
group.leave     { requestId, groupId }
group.list      { requestId }
message.send    { requestId, commitId, groupId, sessionId?, actionId?,
                  targetAgentIds[], replyRequired, replyRequiredReason, body,
                  inReplyToMessageId? }
message.ack     { requestId, groupId, upToSequence }
message.page    { requestId, groupId, cursor? }
issue.create    { requestId, commitId, groupId, vikunjaProjectId, title, body }
issue.reference { requestId, commitId, groupId, vikunjaIssueId }
issue.query     { requestId, sessionId }
issue.list      { requestId, groupId }
issue.close     { requestId, commitId, sessionId, reason, conclusion, evidence }
issue.reopen    { requestId, commitId, sessionId, reason, remainingActions? }
action.create   { requestId, commitId, sessionId, assigneeAgentId, actionKind, reason,
                  expectedResult, replyRequired, replyRequiredReason,
                  inReplyToActionId? }
action.submit   { requestId, resultCommitId, actionId, resultBody, evidence }
action.report   { requestId, actionId, report:'blocked'|'failed', reason, evidence }
action.refuse   { requestId, actionId, reason }
```

每个外部变更操作都有稳定 commitId。`commitId` 是操作幂等键,由发起方生成,跨重连不变。
`requestId` 是单次关联 id,不兼任幂等键。同 commitId 同内容返回原回执;同 commitId 不同内容
显式冲突失败。`resultCommitId` 用于结果 comment 的幂等。

hub 到客户端:

```text
group.created    { requestId, group }
group.invited    { requestId, invitation }
group.member     { requestId, group }
group.changed    { group }                                   // 成员关系变化推送
group.list       { requestId, groups }
message.sent     { requestId, messageId, sequence }          // 持久接受回执
message.acked    { requestId, groupId, upToSequence }        // 水位已推进
message.received { groupId, message }                        // 投递推送
message.page     { requestId, messages, revision, hasMore, gapBeforeSequence? }
issue.changed    { sessionId, state }                        // 开闭投影变化推送
issue.session    { requestId, session }                      // create/reference/query 回执
issue.list       { requestId, sessions }                     // 按群读取已持久会话
issue.closed     { requestId, session, outcome }             // closed|conflict|failed|unknown
issue.reopened   { requestId, session, outcome }             // reopened|conflict|failed|unknown
action.created   { requestId, action }
action.updated   { requestId, action }                       // submit/report/refuse 回执
action.changed   { action }                                  // 行动状态变化推送
action.list      { requestId, actions }
op.execute       { opId, kind, params }                      // 仅发给被委派的执行 owner
relay.error      { requestId?, error }
```

每个带 requestId 的请求都有同 requestId 的回执或 relay.error;无 requestId 的帧只作推送,
不能被当成某次请求的答复。`action.report` 会把该 action 从 pending 或 in_progress
推到 blocked 或 failed,并写入持久 `report` 字段,随 `action.updated` 回执返回;该字段不代表
结果 comment 已完成。

`issue.list` 的 owner 是 hub 的 `issue-session` 持久会话账本。hub 从认证连接取得 actor,
先验证其 scope 与当前有效群成员资格,再按 groupId 读取会话。无消息、无 action、已关闭
会话均保留在列表中;授权范围内没有会话才返回空列表,未授权返回 typed 拒绝。
读取不调用 `issue.reference`、Vikunja 或外部操作委派,不修改账本,不清除未决写入的
unknown。返回的开闭状态只是最后一次持久投影;用户选中后沿 `issue.query` 刷新状态,
新 action 准入仍执行已有的新鲜状态校验。列表成功不表示某次创建或提交已经成功。

执行 owner 到 hub:

```text
op.confirmed     { opId, commitId, result }                  // 确定成功
op.failed        { opId, commitId, error }                   // 确定失败,沿用 ServiceError
op.unknown       { opId, commitId, reason }                  // 结果不可确定
```

- `op.execute` 只发往该 op 的唯一执行 owner。
- `op.confirmed`、`op.failed`、`op.unknown` 只由执行 owner 回给 hub。
- hub 只接受该 op 被委派的认证 owner 的回执,并校验 opId 与 commitId。其他成员即使知道 opId
  也不能改变 issue 或 action 投影。
- 确定失败用现有 typed error 回传并持久化,例如权限拒绝、输入无效。失败不记为成功,也不长期
  挂在 unknown。

错误沿用现有 `ServiceError` 词汇。结果未知用 `RESULT_UNKNOWN`,和 Work 协议一致。

## 10. 持久化与所有权

hub 宿主机,根为 registry 的 dataDirectory,默认 `~/.agentteams`。不用硬编码目录,避免多个
daemon 因账户相同共写同一路径。

```text
<dataDirectory>/groups/<accountId>/<scopeId>/groups.json
<dataDirectory>/groups/<accountId>/<scopeId>/<groupId>/sessions.json
<dataDirectory>/groups/<accountId>/<scopeId>/<groupId>/actions.json
<dataDirectory>/groups/<accountId>/<scopeId>/<groupId>/external-ops.json
<dataDirectory>/groups/<accountId>/<scopeId>/<groupId>/messages.jsonl
<dataDirectory>/groups/<accountId>/<scopeId>/<groupId>/watermarks/<agentId>.json
```

- `groups.json` 存成员和有效区间 `intervals`。
- `sessions.json` 存会话与 Vikunja issue 绑定及本地状态投影。
- `actions.json` 是 action 真源,含状态、commitId、resultCommitId、resultRef 和停止事实。
- `external-ops.json` 按 opId 与 commitId 记录外部操作,状态为 pending、inflight、confirmed、
  failed、unknown。开闭操作另记单调 `opSeq` 与执行 owner,供 11.2 判定先后。
- hub 重启后从 `actions.json` 恢复未完成 action,从 `external-ops.json` 恢复 in-flight op。
  恢复时 inflight 一律先置 unknown,再按 11.1 与 11.2 回读,不盲目重放。

所有权:

- Vikunja 拥有 issue 和 open/closed 状态。Teams 拥有 action、消息、执行记录和外部操作记录。
- `messages.jsonl` 单写者追加。序号恢复、尾部半行、磁盘满、持久成功边界都显式定义。
- 消息接受、水位、执行结果三种证据分开,不共用一条记录。

JSONL 纪律:每条消息一行,含 messageId、sequence、commitId。单写者由 hub 进程保证。恢复时
从最后一条完整行重建 sequence。尾部半行丢弃并记录。磁盘满时拒绝新写,返回明确错误,
不伪报接受。

## 11. 可靠投递与幂等

- hub 的 `message.sent` 回执表示消息已持久接受,不表示接收或执行成功。
- 稳定 `commitId` 跨重连不变。同 commitId 同内容返回原回执;同 commitId 不同内容显式冲突失败。
- daemon 的 ACK 接管点:本地 inbox 持久成功后 ACK。执行与结果写回另记状态。
- daemon 本地 inbox 在自身 dataDirectory 的 `groups/<accountId>/<scopeId>/inbox.json`,与 hub
  侧 log 分开。ACK 只证明本地已持久,不证明已执行。
- 补投可重复,接收方按 messageId 去重。不承诺跨任意引擎副作用的恰好一次执行。
- 累计水位只越过已安全处理或明确不适用的项。过滤、并行、重连、成员加入/退出/重入有明确规则。
- 保留上限与保留期按 scope 配置。水位落后于保留起点时显式报告历史缺口,禁止静默跳过。
- 结果未知:daemon 在执行或写回期间崩溃时,状态置 `unknown`。外部变更前必须先持久记录稳定
  操作标识,再调外部 API。响应丢失时按稳定标识回读;回读不能确定时保持 `unknown`,不盲重试。

规则明细:

| 场景 | 规则 |
| --- | --- |
| 执行条件 | 存在有效 action 且本 agent 是 `assigneeAgentId`。`replyRequired` 只决定是否需答复,不决定是否执行。 |
| 过滤 | 无 action,或 action 的 assignee 不是本 agent 时,只写本地历史并推进水位。 |
| 并行 | 同一 group 按 sequence 串行处理。不同 issue 会话各自独立队列,互不阻塞。 |
| 重连 | 从最后 ack 水位补投。重复 messageId 按去重丢弃,不回退水位。 |
| 成员加入 | 水位从加入时点开始。加入前消息不补投,历史按权限矩阵可读。 |
| 成员退出 | 停止投递。按有效区间记录,退出期间消息不补投。 |
| 重入 | 开新区间,只补投新区间内消息。离群期间不补投。 |
| 未读数 | 有效区间内、水位之后的 message 数,来源是 message-log,由 `message.page` 返回。 |

### 11.1 外部变更幂等与恢复

| 外部变更 | 稳定标识 | 变更前持久记录 | 目标 API 幂等 | 回读方式 | 不能确定时 |
| --- | --- | --- | --- | --- | --- |
| issue 创建 | commitId | external-ops 置 pending | Vikunja 不保证按 commitId 幂等 | 按 project、标题和正文稳定引用回读 | 保持 unknown |
| issue 关闭/重开 | commitId | external-ops 置 pending | 同值重复写入不保证安全,见 11.2 | 读 done 状态与外部事件顺序 | 冲突或 unknown,不再次写入 |
| 结果 comment | resultCommitId | external-ops 置 pending | Vikunja comment 无幂等键 | 按 issue comment 列表和正文稳定引用回读 | 保持 unknown,不重试 |
| action 创建 | commitId | actions.json 置 pending | hub 内按 commitId 幂等 | 按 commitId 查 actions.json | 冲突失败 |

边界说明:

- 稳定引用写在 comment 正文,格式 `[agentteams:<resultCommitId>]`,用于回读匹配。
- Vikunja comment 无幂等键。响应丢失后若已有 comment 但拿不到 resultRef,只能靠回读匹配。
- 读取不到不证明此前没有写入。回读不确定时保持 `unknown` 并上报,禁止盲重试。
- 外部操作记录在 `external-ops.json`,hub 重启后据此恢复,不重放已 confirmed 的操作。

### 11.2 开闭操作的顺序与恢复

关闭和重开不是可交换的重复写入。重复关闭或重开收敛到同一状态的假设不成立:中间可能发生
相反操作。具体反例:关闭 C 已生效但回执丢失;随后 issue 被重新打开;旧 C 恢复时若再次执行
关闭,会把已重开的会话关掉。仅回读当前 done 状态也不能证明是哪一次操作生效。

规则:

- 每个 issue 的开闭操作记录单调递增的 `opSeq`。关闭与重开交替时,opSeq 递增。
- 恢复某 op 时,先回读当前状态和最近外部事件。该 op 不是最近开闭操作,或无法确认先后时,
  不再写入,报告冲突或 unknown。
- 同一 op 已经确认生效,则只更新投影,不再次写入。
- 外部发生相反状态变化且无法确认操作先后时,报冲突或 unknown,不能通过再次写入修复成旧目标
  状态。发起者确认意图后,用新的 commitId 发起新的关闭或重开。
- 变更类操作(关闭、重开)恢复先回读,不因旧 owner 断线就换 daemon 再执行一次写入。只读查询
  单独处理,可以换受信读取 daemon。

## 12. Session 映射与注入

映射关系:group 含多个 issue 会话;每个会话映射一个本地 ACP Session;一个 action 对应一次
注入;一次注入对应一个 prompt。共享逻辑会话不等于跨 agent 共用一个 ACP Session。

- 收到消息本身不启动模型。只有存在有效 action 且本 agent 是 `assigneeAgentId` 才注入。
  `replyRequired` 只决定是否需要面向发起者答复,不决定是否注入。
- 注入前按 `sessionId` 找到本地 ACP Session。无则 `session/new` 创建,有则 `session/resume`。
- 引擎重启后重新 adopt 该 Session,能力不支持时返回明确错误。
- queue:引擎忙时等当前回合结束。steer:发 `session/cancel` 后必须等原 prompt 终结
  (`agent-host/acp-host.ts` 只在引擎终态清除 activePrompt),再注入。
- 不抢占无关人类 Session,不抢占其他 issue 的 action。

注入与结果提交的关系:

- 注入是 action 生命周期的一次执行子流,不是独立执行流。注入只返回执行结果,不提交结果。
- 结果提交只有一个 owner:action 生命周期在 `action-execute` 的 submit 节点写入 Vikunja,
  读回确认后把 action 置 completed。
- 人工提交(action.submit)走同一条 result 提交路径,不另开分支。
- 因此 `action-execute` 与 `message-inject` 不会各提交一次结果。`message-inject` 的出口是
  执行结果记录,不是提交回执。

## 13. 关闭与在飞行动

关闭顺序:

1. 未开始 action 取消。
2. 在飞 action 发取消请求,进入 `cancel_requested`。执行状态保持未结束,等停止确认后才进
   `cancelled`。取消请求发出不等于执行已停止。
3. issue 已关闭和物理执行已停止分别报告。issue 关闭不保证执行已停。关闭报告必须列出尚未确认
   停止的 action。
4. Vikunja 关闭写入并读回确认。写失败不伪报关闭,状态置 `unknown`,回读并按 11.2 处理顺序与
   冲突,不盲目重写。

重开顺序:Vikunja 重开写入并读回确认。旧 action 不自动重跑。

### 13.1 外部关闭与重开的收敛

第一批不等 webhook,用明确的状态读取机制收敛。

- 读取 owner 首选发起者所在 daemon。发起者离线时,GroupHub 从同一群当前有效且 scope 一致
  的在线成员中选一个受信 reader;只读 `issue.query` 允许换 owner,沿用同一 op/commit 与
  回执鉴权。回执 owner 必须匹配被委派 reader,不匹配即拒绝并保持 unknown。无可用受信
  reader 时保持 unconfirmed/unknown 并拒绝新 action,不静默降级。变更类外部写
  (`issue.close`、`issue.reopen`、`issue.create`、`action.result` 等)永远沿用记录 owner,
  不换 daemon 重写。读取失败时保持原投影与 action 责任,不把旧投影当新鲜状态。
- 刷新触发:定时轮询(默认 30 秒)、每条命令进入前刷新本会话、会话有在飞 action 时缩短间隔。
  第一批的定时轮询由 registry daemon 启动时创建的唯一有界 scheduler 承担;scheduler 只持有
  timer 生命周期并逐轮调用 GroupHub 的 sweep,GroupHub 保留 issue 真源、读取委派和共用
  close settlement。在飞缩短只由这一个 timer 执行:scheduler 读取 GroupHub 从现有 action
  状态派生的在飞会话集合,只对这批会话按较短间隔(默认 5 秒)触发单次 sweep;普通会话仍只按
  完整间隔(默认 30 秒)读取,不提前触发。每轮同一时刻最多一个 sweep;单轮读取用有界并发(默认 4)和单读超时
  (默认 10 秒)推进,整轮在 30 秒窗口内结束。未完成读取的会话记为 unconfirmed 并保持
  unknown,不按旧投影放行。Console 关闭不停止 scheduler,UI 不拥有轮询,也不创建第二个
  scheduler。
- 正式 stop 先清理 registry 自有的 scheduler timer,再关闭 relay;stop 只等待当前这一轮
  有界 pass 结束,不等待未完成的单读。
- 最大延迟:默认 30 秒。超过该窗口未读到状态,视为会话状态未知。
- 读取失败时的准入:会话状态未知时拒绝新 action,返回明确错误,不放行也不缓存待执行;投影与
  action 责任保持原样。每条 `action.create` 进入前刷新本会话,刷新失败即拒绝。
- 未权威收敛的关闭:最后一条有效 close 意图处于 `pending`、`inflight` 或 `unknown` 时,
  新 action 在外部读之前拒绝,已有 pending action 的结果提交同样拒绝。一次普通
  `issue.query` 读到 open 不解除该意图;只有原 close 的只读恢复给出权威读回(生效则保持
  closed,确认未生效则记录失败并允许按 open 重新准入),或更高 `opSeq` 的新 reopen 意图
  记录后取代旧意图,才解除封口。
- 外部关闭进入与本地关闭共用的收口逻辑:停止新准入、取消队列、通知在飞执行。不重复调用
  Vikunja close,但取消与收口不能跳过。只把 `state` 改成 closed 不算完成。
- webhook 是第三批的加速通道,只缩短延迟,不改变上述机制和准入规则。

已实现契约:

- `GroupHub.readExternal` 首选 session initiator;initiator 离线时从 `group-registry` 的当前
  有效成员中选第一个在线成员作为受信 reader,只换 `issue.query` 的 owner。读取沿用
  `issue.query:<sessionId>` 的 commit,并走 `confirmRead` 的回执鉴权;回执 `fromAgentId`
  必须等于被委派 reader,否则拒绝并保持 unknown。无 reader 时返回 `UNAVAILABLE`,不发起
  外部读,也不持久化新状态。
- 在飞缩短的真实触发来源是 `GroupHub.inflightIssueSessionIds()`:它只从现有 action 状态
  (`pending`、`accepted`、`in_progress`、`cancel_requested`)派生有在飞责任且仍存在的会话,
  不新增第二套账本。registry scheduler 仍只有一个 timer;在短间隔 tick 上只对这组会话调用
  `sweepIssueStates(sessionIds)`(默认 5 秒),普通会话只按完整间隔读取,不提前触发。

### 13.2 关闭与成员变更规则

| 事件 | 新 action 准入 | 队列 | 在飞 | 状态投影 |
| --- | --- | --- | --- | --- |
| 本地关闭开始 | 拒绝 | 全部取消 | 发取消请求,进入 cancel_requested,等停止确认 | 进入关闭中,尚未 closed |
| 本地关闭成功 | 拒绝 | 已取消 | 已确认停止,或保留 unknown 并列报未停止项 | closed |
| 检测到外部关闭 | 拒绝 | 全部取消 | 走同一收口,发取消请求 | closed |
| 检测到外部重开 | 允许 | 保留 | 不重跑旧 action | open |
| 成员退出 | 本人未开始 action 置 cancelled | 停止投递 | 在飞发取消请求,进入 cancel_requested,等停止确认 | 区间关闭,访问撤销 |
| 成员重入 | 允许 | 只补投新区间 | 不恢复旧 action | 新区间开启 |

已在 `cancel_requested` 期间到达的结果不丢:停止确认前执行实际完成或失败的,按真实结果归入
completed 或 failed。已进入终态后的迟到提交只留历史,不改 action 终态。重开后旧 action 保持
终态,不自动重跑;需要新行动必须显式创建新 action。关闭报告必须列出尚未确认停止的 action;
只改 `state` 不算完成。

## 14. 连接与协议真实接线

daemon 现有注册连接由 `network/registration-client.ts` 组合,已有 `publish`、
`directorySnapshot` 和单一在线守卫。群通道复用这条连接,不新开第二个 socket。

- RegistrationClient 增加群请求/回执关联、群推送订阅。
- 重连后按最后水位重建订阅,重新拉取未补投消息。
- 请求关联用 pending 表按 requestId 归因,和现有 relay-client 一致。
- 错误回执经 `relay.error` 归因到 requestId。
- 非关键群处理错误隔离,不拖掉目录和心跳;用有界队列和 typed error。

## 15. Vikunja 集成

最小能力前移:创建/引用 issue、读状态、写 comment/结果、关闭、重开、身份映射。

- 状态读取是第一批的收敛机制,见 13.1。webhook 是第三批的加速通道。
- 每种外部操作的执行 owner 见 8.1。幂等与回读见 11.1。
- API 版本化核实。状态映射、权限、webhook 签名、私网约束都以实际运行的 Vikunja 验证为准。
- 身份映射:一个账户一个 Vikunja token,comment 归属 token 用户,agent 身份用
  稳定引用标注在 comment 正文。发起者在 Vikunja 直接关闭时,Teams 需要能从 Vikunja 用户
  识别出发起者,才能按 13.1 收敛。
- webhook 签名用 `X-Vikunja-Signature`。私网地址约束不能按"绑定局域网地址即解决"当作已确认
  结论,需要真实验证。webhook 是第三批。

## 16. CLI

```text
agentteams join --remote <wss://host:port> --endpoint <ip:port> --serve <opencode|dsh> \
                [--name <agentId>] [--config <out>]
agentteams group create|invite|accept|decline|leave|list
agentteams issue create|reference|query|close|reopen
agentteams action create|submit|report|refuse|list
agentteams msg send|inbox
agentteams status
```

`join` 明确已有配置和 daemon 时的行为:验证 relay 可达,生成或更新 v4 agent 配置,以 detach
方式启动。不隐式重建或启动第二个 daemon。配置写入 owner 是 config,凭据来自 env/file 引用,
启动失败保留原状态。CLI 选择哪个 daemon 由配置路径和 identity 决定,不猜。

`msg send` 必须显式给出 action 相关字段,不从正文猜测。

## 17. DAG

十四个 SESE 图,每个图一个外部对象流。每个图须通过 `dagpipe graph validate`。每个图的出口是
typed receipt,拒绝、等待、失败、取消、未知结果都在出口收敛,不靠成功直链掩盖。

### 17.0 typed outcome 传播规则

所有图使用同一条传播规则,不逐图重复定义。

- 每个节点输出带 `status: ok | failed` 与 `outcome`。
- 节点返回 failed 后,后续副作用节点跳过。不执行创建、持久化、外部写入或提交。
- 原失败结果沿链传递到出口。出口回执写入首个失败原因和已发生的副作用,不改写成成功。
- 授权失败发生在任何写操作之前,后续节点必然跳过。外部写失败发生在写操作处,其后读回与
  确认节点跳过。
- 出口节点只做收口,不产生新副作用。

gate 约定:对每个图各注入一次失败(授权失败、外部写失败、读回失败),断言失败后续节点的
副作用计数为 0,且出口 outcome 与失败原因一致。该约定绑定 `teams-group-dag-outcome` gate。

| 图 | graph id | 文件 | 入口 | 出口(outcome 并集) |
| --- | --- | --- | --- | --- |
| 建群 | `agentteams.group-create` | `group-create.graph.json` | `group.create.intent` | created \| rejected |
| 邀请 | `agentteams.group-invite` | `group-invite.graph.json` | `group.invite.intent` | recorded \| rejected |
| 响应 | `agentteams.group-invite-response` | `group-invite-response.graph.json` | `group.invite.response` | accepted \| declined \| rejected |
| 发消息 | `agentteams.group-message-send` | `group-message-send.graph.json` | `group.message.send.intent` | accepted \| duplicate \| conflict \| rejected |
| 投递 | `agentteams.group-message-deliver` | `group-message-deliver.graph.json` | `group.delivery.tick` | delivered(水位已推进) \| offline \| timeout \| gap \| rejected |
| 创建 issue | `agentteams.issue-create` | `issue-create.graph.json` | `issue.create.intent` | created \| referenced \| unavailable \| unknown |
| 读 issue | `agentteams.issue-query` | `issue-query.graph.json` | `issue.query.intent` | open \| closed \| unavailable \| unknown |
| 列出群议题 | `agentteams.issue-list` | `issue-list.graph.json` | `issue.list.intent` | listed(可为空) \| rejected \| unavailable |
| 创建 action | `agentteams.action-create` | `action-create.graph.json` | `action.create.intent` | accepted \| refused \| invalid \| unknown |
| 执行 action | `agentteams.action-execute` | `action-execute.graph.json` | `action.execute.tick` | completed \| blocked \| failed \| unknown |
| 关闭 | `agentteams.issue-close` | `issue-close.graph.json` | `issue.close.intent` | closed \| unknown \| failed \| conflict |
| 重开 | `agentteams.issue-reopen` | `issue-reopen.graph.json` | `issue.reopen.intent` | reopened \| unknown \| failed \| conflict |
| 注入 | `agentteams.message-inject` | `message-inject.graph.json` | `group.message.received` | executed \| queued \| cancel_requested \| cancelled \| rejected \| failed \| unknown |
| webhook 收敛 | `agentteams.vikunja-webhook` | `vikunja-webhook.graph.json` | `vikunja.webhook.request` | applied \| ignored \| rejected |

### 17.1 建群

```text
group.create.intent
  -> authorize-initiator   teams.authorize-group-init
  -> create-group          teams.create-group
  -> persist-group         teams.persist-group
  -> decide-outcome        teams.decide-group-outcome
  => group.create.receipt
```

### 17.2 邀请

```text
group.invite.intent
  -> authorize-inviter     teams.authorize-group-admin
  -> record-invite         teams.record-group-invite
  -> persist-invite        teams.persist-group-invite
  -> decide-outcome        teams.decide-invite-outcome
  => group.invite.receipt
```

邀请通知的送达是独立投递事件,不在本图内等待。

### 17.3 响应

```text
group.invite.response
  -> authorize-invitee     teams.authorize-invitee
  -> validate-invite       teams.validate-group-invite
  -> apply-response        teams.apply-group-response
  -> persist-membership    teams.persist-group-membership
  -> publish-member        teams.publish-group-member
  -> decide-outcome        teams.decide-response-outcome
  => group.response.receipt
```

### 17.4 发消息

```text
group.message.send.intent
  -> authorize-sender      teams.authorize-group-member
  -> validate-references   teams.validate-message-references
  -> dedup-commit          teams.dedup-message-commit
  -> append-message        teams.append-group-message
  -> decide-outcome        teams.decide-send-outcome
  => group.message.send.receipt
```

### 17.5 投递

一次投递尝试。补投是新的 tick 事件,不回流。

```text
group.delivery.tick
  -> read-watermark        teams.read-member-watermark
  -> detect-gap            teams.detect-retention-gap
  -> select-backlog        teams.select-group-backlog
  -> deliver-push          teams.deliver-group-push
  -> await-ack             teams.await-group-ack
  -> advance-watermark     teams.advance-member-watermark
  -> decide-outcome        teams.decide-delivery-outcome
  => group.delivery.receipt
```

`advance-watermark` 校验 ack 覆盖的 sequence 并持久推进水位。成功回执不早于这个边界:
delivered 只有在 ack 且水位持久推进之后才返回。

### 17.6 创建 issue

```text
issue.create.intent
  -> authorize-initiator   teams.authorize-issue-init
  -> create-reference      teams.create-reference-vikunja
  -> readback-confirm      teams.readback-vikunja-state
  -> open-session          teams.open-issue-session
  -> decide-outcome        teams.decide-issue-create-outcome
  => issue.create.receipt
```

### 17.7 读 issue

```text
issue.query.intent
  -> authorize-reader      teams.authorize-issue-read
  -> read-vikunja          teams.read-vikunja-state
  -> project-state         teams.project-session-state
  -> decide-outcome        teams.decide-issue-query-outcome
  => issue.query.receipt
```

### 17.8 创建 action

```text
action.create.intent
  -> authorize-command     teams.authorize-action-command
  -> resolve-authority     teams.resolve-command-edge
  -> create-action         teams.create-action
  -> persist-action        teams.persist-action
  -> notify-assignee       teams.notify-action-assignee
  -> decide-outcome        teams.decide-action-create-outcome
  => action.create.receipt
```

### 17.9 执行 action

```text
action.execute.tick
  -> load-action           teams.load-action
  -> execute               teams.execute-action
  -> submit-vikunja        teams.submit-action-result
  -> readback-confirm      teams.readback-vikunja-comment
  -> close-action          teams.close-action
  -> decide-outcome        teams.decide-action-execute-outcome
  => action.execute.receipt
```

`close-action` 只按实际执行结果置 completed、failed 或 unknown。收到取消请求时不得在此处直接
置 cancelled;取消序列由 17.10 的 dispose-inflight 处理。

### 17.10 关闭

```text
issue.close.intent
  -> authorize-initiator   teams.authorize-issue-close
  -> cancel-queued         teams.cancel-queued-actions
  -> dispose-inflight      teams.dispose-inflight-actions
  -> close-vikunja         teams.close-vikunja-issue
  -> readback-confirm      teams.readback-vikunja-close
  -> decide-outcome        teams.decide-issue-close-outcome
  => issue.close.receipt
```

`dispose-inflight` 发取消请求并置 `cancel_requested`,等停止确认后才置 `cancelled`;无法确认时
保留 unknown 与停止事实。关闭回执同时报告 issue 状态和物理执行停止状态,两者分开,并列出
尚未确认停止的 action。`close-vikunja` 按 11.2 记录 opSeq;存在更新的开闭操作或先后无法确认时
报冲突或 unknown,不重写。

### 17.11 重开

```text
issue.reopen.intent
  -> authorize-initiator   teams.authorize-issue-reopen
  -> reopen-vikunja        teams.reopen-vikunja-issue
  -> readback-confirm      teams.readback-vikunja-reopen
  -> restore-session       teams.restore-issue-session
  -> decide-outcome        teams.decide-issue-reopen-outcome
  => issue.reopen.receipt
```

`reopen-vikunja` 先按 11.2 检查 opSeq:存在更新的开闭操作,或外部状态与先后无法确认时,报冲突
或 unknown,不再写入。旧 action 不复活。

### 17.12 注入

```text
group.message.received
  -> authorize-target      teams.authorize-inject-target
  -> map-session           teams.map-issue-session
  -> decide-mode           teams.decide-injection-mode
  -> await-capacity        teams.await-injection-capacity
  -> inject-prompt         teams.inject-acp-prompt
  -> collect-result        teams.collect-turn-result
  -> return-result         teams.return-inject-result
  -> decide-outcome        teams.decide-inject-outcome
  => message.inject.result
```

注入只返回执行结果,不提交结果。结果提交在 `action-execute` 的 submit 节点,由唯一 owner
完成。`await-capacity` 对 steer 先发取消并等原 prompt 终结;对 queue 等引擎空闲。注入只进入
映射到该 issue 的 Session,不抢占无关人类 Session。

### 17.13 webhook 收敛

```text
vikunja.webhook.request
  -> receive-webhook       teams.receive-vikunja-webhook
  -> verify-signature      teams.verify-vikunja-signature
  -> translate-event       teams.translate-vikunja-event
  -> project-state         teams.project-session-state
  -> decide-outcome        teams.decide-webhook-outcome
  => vikunja.webhook.receipt
```

### 17.14 列出群议题

业务路径:校验群读取权限 → 读取该群持久会话 → 返回列表或原始错误。

| 节点 | operator | owner 与验收 |
| --- | --- | --- |
| `authorize-reader` | `teams.authorize-group-issue-list` | hub 群准入;非有效成员或跨 scope 不得读取会话 |
| `read-sessions` | `teams.list-group-issue-sessions` | `issue-session`;包含空议题,不写账本或调用外部服务 |
| `decide-outcome` | `teams.decide-issue-list-outcome` | hub 回执;保留 requestId 与 typed 错误,失败不伪报空列表 |

入口 `issue.list.intent`,出口 `issue.list.receipt`。失败传播沿 17.0;鉴权失败时不得读取
会话。只读列表与外部状态查询是两个对象流,不复用 `issue-query` 的外部读取节点。

## 18. 分批与验收

### 第一批:人工可操作的 issue/action 闭环

- `group-wire`、`group-registry`、`issue-session`、`action-registry`、`message-log`、`message-router`。
- `group-channel`、`local-message-socket`。
- Vikunja 最小能力:创建/引用 issue、读状态、写 comment/结果、关闭、重开、身份映射。
- 外部关闭收敛的状态读取轮询,见 13.1。
- CLI `join`、`group`、`issue`、`action`、`msg`、`status`。

验收:

1. 群内 @B:A/B/C 都可见,只有 B 承担行动;旁观成员不产生 action 责任。
2. 讨论 issue 指定 B/C:各自写回 Vikunja 后结束;无人自动互答;发起者可追问再关闭。
3. peer 请求 master,master 可带原因拒绝;master 指派 peer,peer 不能拒绝,阻塞/失败带证据。
4. 多人 action 独立完成;一人结果不结束他人责任。
5. 发送回执丢失重试不重复入账;hub/daemon 重启不漏持久接管的消息;重复补投不重复启动。
6. 结果写 Vikunja 失败不伪报完成,不重复追加。
7. 关闭 Vikunja 失败时会话未确认关闭;成功后迟到消息不触发执行。
8. 发起者在 Vikunja 关闭/重开,Teams 经状态读取在最大延迟内收敛;重开不重跑旧 action。
9. 越权指派、跨群引用、离群历史访问被拒;能力不足不伪装成功。
10. 缓存容量或保留期造成历史缺口时显式可见。
11. `replyRequired=false` 的行动仍执行并记录完成;`replyRequired` 不阻断执行。
12. issue.create、action.create、action.submit 响应丢失重试不产生第二个 issue、action 或
    comment;回读不能确定时保持 unknown。
13. 外部关闭走共用收口:停止新准入、取消队列、通知在飞执行。只改 state 不算完成。
14. hub 重启后从 `actions.json` 和 `external-ops.json` 恢复未完成 action;in-flight 置
    unknown 并回读,不盲目重放。
15. 同一对 master/peer,用同一条 `mastersOf` 边覆盖两个方向:master 可指派该 peer,该 peer
    可向该 master 请求;反向另一对无边的组合拒绝。不要求双向边。
16. 关闭与重开交错反例:关闭 C 已生效但回执丢失,随后外部重开,再恢复 C 时不得把会话关回。
    该场景报冲突或 unknown,不通过再次写入修复成旧状态。
17. 在飞取消分三步可观察:发出取消后为 `cancel_requested` 且执行未结束;收到停止确认才
    `cancelled`;无法确认时保留 unknown 与停止事实。取消期间到达的真实结果归入 completed
    或 failed,不丢。
18. 外部操作回执鉴权:非该 op 被委派的成员提交同一 opId 不改变 issue 或 action 投影;
    确定失败(权限拒绝、输入无效)按 typed error 持久化,不长期挂在 unknown。
19. 刷新或重启后通过 `issue.list` 找回群内旧议题,包括无消息、无 action 和已关闭议题;
    非成员或跨 scope 读取被拒。列表不触发外部调用/写入,不清除 unknown,不自动创建
    会话;选中议题后查询失败时仍拒绝新 action,不得把列表中的旧 open 当成准入依据。

### 第二批:模型执行

- `agent-messaging` 的 Session 映射、queue/steer、讨论/comment/audit action 执行、结果写回、
  关闭后的取消与收口。
- `message-inject` DAG 落地。

验收:

1. 真实模型只对行动目标注入;queue 不抢占;steer 等取消终结;无关人类 Session 不受影响。
2. 结果写回 Vikunja 后 action 结束,不自动往返。
3. 关闭时队列取消,在飞收口,物理停止状态如实报告。

### 第三批:事件通知与扩展

- Vikunja webhook 收敛、部署验证、实际需要的扩展。

验收:

1. Vikunja 状态变化经 webhook 回到 daemon,签名校验生效。
2. 私网地址约束按实际运行验证,不按配置建议当结论。

## 19. 已确认决定与仍待决定事项

用户已确认的决定:

| 事项 | 决定 |
| --- | --- |
| peer->peer 权限 | 无指挥边,双方经共同 master 或发起者请求。 |
| 多 master 指挥关系 | 允许多 master,各指挥自己显式列出的 peer;冲突按 actionId 独立,不做全局仲裁。 |
| Vikunja 身份归属 | 一个账户一个 Vikunja token,comment 归属 token 用户,agent 身份用稳定引用标注在 comment 正文。 |
| 非发起者关闭权限 | 只有发起者可关闭/重开;非发起者请求,发起者执行;发起者可显式委托。 |
| 容量与保留期 | 按 scope 配置,缺口显式上报。 |

仍待决定事项(第二批前定):

| 事项 | 建议 |
| --- | --- |
| 逻辑会话到 ACP Session 映射 | 一个 issue 会话一个本地 ACP Session,按 sessionId 创建或 resume。 |

离群未完成 action 已不再列为待决定,规则见 13.2:未开始置 cancelled;在飞先发取消请求,
并区分"取消请求已发出"和"执行已停止",不直接把在飞 action 标成已取消或已完成。
