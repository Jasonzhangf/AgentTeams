收口分析已完成。本报告交给 Alice 作为开发指引，不构成最终 review。当前最小缺口集中在人工 issue/action 的后端闭环。无需等待模型第二批，也无需重做群聊架构。

结论基于以下边界：

- Alice 文档采用 b9d9e27。该树读取时无未提交修改。
- 实现采用 3b77ef7 的 Git 对象。Bob/Carol 活动树的 UI、测试和新增回执有未提交内容，本报告未用这些内容推导交付状态。
- 用户路径证据读取自 `e644b1c:docs/evidence/user-path-verify-20261024/notes.md`。未查询其中临时目录、进程或端口。
- 已读指定规则、三份输入文档和五张架构 map。对 12 张受影响群业务图及 version-delivery 图做了只读结构检查：均为单入口、单出口、无环，无悬空边。问题在节点语义和实现接线，不能由拓扑通过消除。
- 未修改文件、运行服务或测试、调用模型、派工、发消息或清理资源。下列“公开入口反例”是交给实现者的验收输入，本轮没有执行。

1. 当前提交仍缺的最小跨 owner 链路

以下各项应补入现有工作范围，由 Jenny 去重并安排。不要为它们复制已有问题编号。

（1）外部操作的失败、未知和恢复没有在 hub 闭合。已确认源码缺口。

事实及位置：

- `3b77ef7:server/group-hub.ts:236–262` 校验操作回执并唤醒 waiter，但不持久化回执终态。
- 同文件 `delegate():743–788` 仅在 confirmed 分支调用 `authenticateExternalOpReceipt` 更新 ledger。failed、unknown 分支只保存现有 ledger。因此真实委派链上的确定失败仍可能留为 inflight；重启后再被转成 unknown。
- 同文件 `createIssue():434–440` 和 `delegate():753–756` 对未确认操作要求“先回读”，但没有接通这个恢复动作。
- `runtime/vikunja-sync.ts:489–529` 已有按稳定引用查 issue/comment 的能力。提交内检索表明，它们只有测试调用，没有生产恢复调用。
- `runtime/agent-messaging.ts:142–197` 处理创建、开闭、结果写入和 issue 状态查询，没有按原 commit/resultCommit 恢复 issue/comment 的分支。
- unknown 在部分 hub 分支变成 `UPSTREAM_ERROR`；`queryIssue():509–525` 又会在外部读取失败后返回旧 session 的成功响应。

影响：

用户可能已经写入真实 Vikunja，却只能长期停在未知。确定的权限拒绝也可能变成未知。前端即使修好了“列表成功不能清除未知”，仍没有可靠恢复入口。旧 issue 列表恢复也不能解决“创建成功但 issueId 回执丢失”。

最小处理：

由 hub 统一保存已鉴权的 confirmed、failed、unknown 结果，保留原错误码。接通现有稳定引用查找能力，让恢复只读原操作，并将确认结果落回原 op、session 和 action。未找到或顺序不明仍保留 unknown，不换标识重写。issue 状态读取失败须显式返回未确认，不能把旧投影包装成新鲜成功。

实现 owner：

`server/group-hub.ts` 拥有操作状态与收敛；`runtime/agent-messaging.ts`、`runtime/vikunja-sync.ts` 拥有委派执行与真实读取；确需增加公开恢复帧时由 `packages/shared/src/group-wire.ts` 拥有帧形状。Bob 只消费结果。

公开入口反例：

通过 Console group HTTP 或 CLI 创建 issue、提交结果，让真实 Vikunja 已写入但回执丢失。恢复后只能得到原 issue/comment，数量不增加。另用无权限 token 触发确定拒绝，重启 hub 后仍须显示确定失败，不能变成 inflight/unknown。读取服务不可达时，不得返回“已确认打开”。

（2）人工 action 的报告、结果提交和终态检查仍有断点。已确认源码缺口。

事实及位置：

- `server/group-hub.ts:695–715` 将 `action.report` 直接交给 `reportAction`。
- `server/action-registry.ts:215–221` 只执行状态转换；当前 wire 没有人工 accept/start 入口，而新 action 是 pending。
- `packages/shared/src/group-wire.ts:671–688` 不允许 pending → blocked/failed。因此人工收到指派后直接报告阻塞或失败会被拒绝。
- `reportOrRefuse` 没有保存请求中的报告原因和 evidence；当前 Action 类型也没有相应报告字段。
- `server/group-hub.ts:656–687` 先委派 comment 写入，后检查 action 能否完成。已经 completed 的 action 若使用另一个 resultCommitId 再提交，可能先追加真实 comment，再因终态转换失败而返回错误。

影响：

首版用户无法完整报告“现在做不了及原因”。更严重的是，接口拒绝可能发生在外部写入之后。前端隐藏按钮不能保护公开接口，也不能消除迟到提交。

最小处理：

在 hub 的外部写入前完成 action 状态、原结果标识和当前权限检查。原标识重复提交返回原结果；终态上的新提交在写入前拒绝。明确人工报告 pending action 的合法转换，并持久保存原因和证据。沿用 action 的现有真源，不另建 UI 报告账本。

实现 owner：

server 的 action 生命周期 owner；必要的字段和转换由 shared wire owner 配套调整。人工报告不需要模型执行器。

公开入口反例：

新建人工 action 后立即报告 blocked，刷新后仍能看到原因及证据。完成 action 后用不同 resultCommitId 再提交，必须明确拒绝，且 Vikunja comment 数量不变。同一 resultCommitId 重交返回同一结果。

（3）本地关闭、外部关闭和 action 收口没有汇合。已确认源码缺口。

事实及位置：

- `issue-close.graph.json` 已声明 `cancel-queued → dispose-inflight → close-vikunja → readback-confirm`。
- `server/group-hub.ts:573–619` 的关闭实现只记录 issue 操作、执行 Vikunja 开闭和更新 session，没有处置 actions。
- `queryIssue():518–523` 发现外部状态变化后只调用 `reconcileIssueSession`。
- `server/action-registry.ts:228–255` 已有取消、停止确认和停止未知能力，但 GroupHub 未接入这些能力。
- `createAction():622–653` 只检查本地 `session.state`。没有执行协议 §13.1 要求的命令前刷新，也没有新鲜度未知的准入判断。
- `confirmRead():551–552` 将外部读取错误收成 undefined，随后 query 返回旧 session。

影响：

issue 可以显示已关闭，但 pending action 仍保留可执行状态。外部已经关闭或读取失效时，旧 open 投影仍可能接纳新 action。人工首版也受影响，不能全部归到第二批模型取消。

最小处理：

在 hub 复用一个会话收口动作，供本地关闭和外部关闭共同调用。先停止新准入，再取消未开始 action；对已开始或副作用未知的行动保留责任和停止事实。接通协议已有的状态读取周期与命令前检查。读取超出契约窗口时拒绝新 action。第二批只增加真实模型取消与终结回执，不另建收口真源。

实现 owner：

server 拥有准入和 action 收口；runtime 执行只读状态查询及将来的执行器停止。UI 分别展示 issue 开闭和执行停止事实。

公开入口反例：

创建两个 pending action 后关闭 issue，两项不能继续可执行。直接在 Vikunja 关闭 issue，再从产品创建 action，必须按契约收敛并拒绝。断开状态读取后不得沿旧 open 放行。重开原 issue 不复活旧 action。

（4）身份链已有基础，但不能把“选 daemon”当成“切换已认证用户”。部分已确认，部分待验证。

事实及位置：

- `runtime/control-process.ts:814–845` 根据已声明 peer 的 account/scope/agentId 读取 endpoint，再转发到该 daemon。
- `console-host/src/http-api.ts:219、266–277` 先做 Console 认证，再按请求中的 agentId 转发。
- `runtime/local-message-socket.ts:13–20` 明确依靠本地用户和私有 socket 权限，不增加第二层认证。
- 所以 hub 看到的 actor 是被选 daemon 的认证身份，不是浏览器用户身份。
- `runtime/agent-messaging.ts:170–174` 写结果时只传 resultBody 和 resultCommitId；`vikunja-sync.ts:472–484` 只添加稳定提交引用，没有添加可直接识别的 agent 身份。
- 协议 §15、§19 已要求同账户 token 下用稳定引用标注 agent 身份。

影响：

单一受信本机操作者可以代理多个 daemon，这需要明确产品语义。若验收按“两个独立用户”理解身份切换，当前证据不够。Vikunja 中也不能仅凭共同 token 的作者判断哪个 agent 提交了结果。

最小处理：

首版文档明确“当前代表哪个 daemon 操作”，并说明可代理集合的授权来源。不要用前端选择器制造用户隔离。结果身份标注由已认证 daemon 的 declaration 生成，不接受浏览器自报 actor。若本次产品确实要求多个独立 Console 用户，先补具体授权契约，再由权限 owner 接线；不能自行新增一套 ACL，也不能直接宣布越权漏洞已复现。

实现 owner：

Console/runtime 拥有代理入口和目标绑定；Agent 侧拥有可信身份；Vikunja adapter 只负责约定格式的写入。

公开入口反例：

未声明目标必须被拒绝。篡改正文中的 actor 不能改变可信署名。两个 agent 经同账户 token 提交后，Vikunja 中应能区分责任人。不同 Console 用户是否允许代理相同 daemon，按明确授权契约验证。

旧议题恢复仍沿 `8dde877` 原项处理。补充一个后端事实即可：`issue-session.ts:199–202` 已有 session 列举能力，但当前公开 wire 只有按已知 sessionId 的 `issue.query`，没有按群恢复议题列表的入口。Bob 的本地选择状态不能补这个缺口。由原后端 owner 将授权后的列表暴露出来，并验证“无消息、无 action 的旧议题”也能恢复；不要另起任务。

3b77ef7 的 `receipt-group-api.json` 记录了 53 项真实通道检查，覆盖 daemon、endpoint、建群、消息及错误路径。它没有覆盖真实 issue 创建、结果 comment、未知恢复和关闭收口。可以直接复用已证明的通道，不能把这些检查扩展解释为完整群聊验收。

2. 28f8373 的最小消融边界

结论是：保留现有 stage store 和行为失效机制，删除项目重复包装；SDK 强制字段需要由 SDK 契约 owner 处理。不能只删 hash 函数，也不能把所有校验整体保留为“SDK 必需”。

事实及位置：

- `scripts/lifecycle-adapter.mjs:73–110` 为阶段计算候选、lockfile、工具和治理输入的复合指纹。
- 同文件 `291–369` 又检查日志 hash、产物 hash、候选相等、工具版本、治理 hash，并创建独立 reuse receipt。
- `388–399` 计算整段 Git diff 和 scope hash；`448` 起还有一套最终 validation 复用检查。
- `scripts/blackbox-user-mvp.mjs:5889–6165` 的 BB13 直接依赖这些 fingerprint、reuseReceipts 和具体失效原因字符串。
- 当前 SDK schema 确实有强制字段：`fix-candidate-record.schema.json:5`、`pre-review-validation-record.schema.json:5`，以及 `evidence-record.schema.json` 的 required 和 deployed_blackbox 约束。不能用空串、常量或改历史记录满足它们。
- BB13 当前变更矩阵包含源、图、配置、产物和证据删除；没有看到独立 registry 变更场景。用户计划 BB13 已明确要求这一项。

最小处理顺序：

- 沿用 `.appsdk-control/lifecycle-adapter/stages/teams-lifecycle-admission.json`。保留阶段结果、原始 receipt、实际输入、失效原因和依赖。不建立第二个缓存、快照或复用账本。
- 先移除重复复核：同一次阶段复用只判定一次；直接引用原 receipt，不再为“复用”生成另一份包装 receipt。工具和环境仅在确实影响该阶段时参与判断。
- 将日常复用判断落到实际消费的输入及其可靠变化依据。源和图使用受影响路径，配置使用真实 revision，产物使用生产者记录及其有效性结论。没有可靠变化依据的产物，从其生产节点补验；不能仅凭版本名、mtime 或“文件存在”认定未变。
- 对 SDK 正式准入仍强制的字段，交 SDK owner 确认正式替代契约。当前读取到的 schema 不支持“直接删除这些字段仍合规”的结论。项目可先消除重复计算与重复记录；完整去除强制包装的收口依赖 SDK 正式能力，不能伪造 PASS。
- 将 BB13 改成行为断言：失败后只重跑失败阶段及其依赖；未变化重入不执行；有效阶段引用原证据；源、图、registry、配置、产物变化不能复用受影响 PASS；必需证据缺失只失效相关链。删除对 fingerprint 值、专用原因字符串和新增 reuse receipt 数量的绑定。
- 真实安装仍走现有 package/installed smoke。保留包外安装、公开 CLI、真实 Relay 与两 Agent、实际重启代次、安装入口路径、结果和自有资源收口。`lifecycle-adapter.mjs:133–160` 的这些行为检查不能随身份包装一并删除。

实现 owner 是 map 中的 `development_artifact_packaging / development-governance`，范围覆盖 lifecycle adapter、package producer/consumer 和 BB13 driver。SDK schema 与准入语义由 SDK owner 负责。不要顺手改 Work DAG 编译契约或运行权限。

公开入口反例：

通过现有 lifecycle 公共入口，让 installed smoke 一次确定失败。恢复时 verify 不重跑，smoke 重跑。随后分别改变受影响输入、删除必需证据，确认只有正确的依赖链失效。最后使用真实安装副本完成适用验收。减少重复检查后的全绿输出本身不是 BB13 证据。

3. Alice 文档中需要立即修正的行为矛盾

只列会改变实现或验收的三处。其余样式和措辞不在本次范围。

| 事实及位置 | 影响 | 最小处理与唯一文档 owner | 公开入口反例 |
|---|---|---|---|
| `teams-group-webui-design.md:102、153` 写“补充资料恢复原行动”；协议 `teams-group-messaging-v1.md:242` 要求原 blocked/failed 保留，由 master 新建 action；当前 wire 也没有 blocked 的恢复边 | Bob 可能实现 UI 私自复活原 action，或提交时先写 comment 再被状态机拒绝 | Alice 在 WebUI 设计中改为“补充信息后，由有权限者创建关联的新 action，原记录保留”。如确需原地恢复，须先由协议 owner 改行为契约，不能只改 UI | blocked 后补资料，旧 action 不变；新 action 有独立标识并关联旧记录 |
| WebUI `:78` 无条件禁止非发起者改 issue；协议 `:275、932` 保留“发起者可显式委托”；现有实现只认原 initiator | 设计与已确认权限决定不一致；也可能被误解为前端传一个 delegate 就能放权 | 协议 owner 先明确显式委托如何记录和验证。Alice 的 UI 文档保留该已确认能力，同时明确“未有服务端有效委托时不提供成功入口”。不能通过 UI 删除该决定，也不能把 role/grant 当作关闭授权 | 无委托成员关闭被拒；有真实有效委托时按契约执行，伪造请求字段无效 |
| WebUI `:7` 承认 ACP Session 映射尚待第二批定案，但 `:62` 又以确定规则写“每个 issue 会话在各 agent 上映射自己的本地 ACP Session” | 实现者可能把人工首版导航绑定到 ACP Session，或提前固化第二批方案 | Alice 将 `:62` 标为第二批候选映射。首版导航只依赖 group、IssueSession 和 action；协议 §19 继续拥有映射决定 | 未启动模型、未创建 ACP Session，也能恢复议题、人工交结果、关闭和重开 |

另有一个权限说明缺口，应在第一项身份工作内补齐，不新增任务：WebUI 的“两个身份”应说明是两个受授权 daemon 上下文，还是两个独立登录用户。这直接决定隔离验收，不能留给 Bob 猜。

真实 Vikunja 还有一个定向待验证项。3b77ef7 已修复 close/reopen 清掉 title、description 和稳定引用的问题，不应重报旧缺陷。但其 `preserveOnFullUpdate` 只保留这些有限字段。该提交的说明确认目标 API 使用全量更新；其他已有业务字段是否保留，本轮没有运行证据。Carol 应在原真实写入验收中，用带非默认字段的原 issue 做关闭/重开前后对照。若发现丢失，再修 `runtime/vikunja-sync.ts`；目前不能宣称已经发生数据丢失。

4. 可立即推进的并行项与真实依赖

| Ready 工作 | 可立即处理的内容 | 真正依赖 |
|---|---|---|
| Alice 文档收口 | 修正 blocked 恢复、Session 映射和操作者身份表述；对齐委托权限 | 显式委托的记录与验证语义由协议 owner 明确 |
| 原 Bob 前端工作 | 继续既有五项、上下文隔离、多 action 展示和真实入口接入 | 旧议题列表、未知恢复和 action 结果必须有服务端契约；不能用 UI 状态补真源 |
| 后端人工闭环 | 外部操作终态持久化、只读恢复、提交前检查、人工报告、关闭收口 | 这些工作共享 GroupHub，必须由一个 writer 串行整合；runtime adapter 可按稳定接口配合 |
| 28f8373 原 owner | 项目重复包装消融、BB13 改为行为断言、保留安装路径 | 删除 SDK 强制字段依赖官方契约支持；不阻断无关产品修复 |
| 真实 Vikunja/浏览器验收 | 准备同账户多 agent、回执丢失、权限拒绝、旧议题、关闭重开用例 | 完整成功验收须等待上述人工后端闭环；已通过的通道检查直接复用 |

模型 Session 映射、queue/steer、真实 prompt、引擎 permission 和模型取消仍属第二批。人工首版的结果写回、unknown 恢复、权限、外部关闭和未完成责任不能推迟到第二批。

本次分析没有新增资源或待清理事项。剩余工作由 Jenny 在现有任务中安排；Alice 按实际产品入口验收。当前最先需要补的是外部操作状态与恢复，以及 action 提交前的状态检查。这两处直接决定用户能否安全结束一次人工协作。

