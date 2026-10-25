---
name: agentteams-development
description: AgentTeams 项目开发、调试与验收入口；按现有架构和业务 DAG 定位唯一 owner，选择真实入口验证，落实最小反馈与交付收口。
---

# AgentTeams 本地开发

从本 Skill 所在仓库读取文件，以下路径均以仓库根为基准。不要跳到旧 checkout、
父仓库或另一 peer 的树。本文是项目步骤入口；全局编排、权限和工作树规则沿当前宿主。

## 按任务读取真源

先读根 [AGENTS.md](../../../AGENTS.md) 的架构和业务约束。存在有效
`.appsdk/requirements.json` 时读取受影响条目；不存在则不补造。

| 当前改动 | 必需设计与入口 |
| --- | --- |
| 发现、连接、能力与 Work | `docs/design/teams-agent-relation-communication-v1.md`；本地 MVP 的 `docs/goals/teams-user-delivery-plan.md`，保留 BB01–BB14 |
| 单 daemon、引擎与 Session | `docs/design/teams-acp-daemon-config-v4.md`；`runtime/acp-serve.ts` 的公共组合入口及对应引擎 adapter |
| provider/model 配置 | `docs/design/teams-provider-config.md`；config owns 用户意图，adapter 配置为派生输出 |
| 群、议题、行动与 Vikunja | `docs/design/teams-group-messaging-v1.md` 及 manifest；从 typed frame 跟到 hub、受委派 daemon 与外部结果 |
| WebUI、卡片、状态和切换 | `docs/design/teams-group-webui-design.md`；真实 Console HTTP/client，HTML 原型只作交互参考 |

业务完整字段和转换只改对应设计，不在 Skill 再造协议。当前交付状态查原任务与证据，
不要把上述入口或架构约束当作已实现。Work、ACP 与人工群聊的验收不互相替代。

## 开发与验收

1. 确定用户可观察的成功、失败和副作用。先读 `docs/design/dagpipe/graphs/` 中受影响图，
   核对入口、唯一 owner、失败出口和 SESE。群列表用 `issue-list`，外部状态刷新用
   `issue-query`，执行结果用 `action-execute`，关闭收口用 `issue-close`；不能用一条
   成功路径代替这些不同职责。纯规则编辑不改变业务拓扑时复用图，不新造业务图。
2. 用 `docs/architecture/` 的 `resource-map.json`、`function-map.json`、
   `mainline-call-map.json`、`module-registry.json`、`verification-map.json` 确认
   受影响真源、调用边和 gate。每个 mutable truth 一个 writer。Console/UI 只消费或
   提交，不在前端补账本、准入或恢复逻辑来绕过 owner。
3. 代码改动在最新远端主线派生的独占 `/Volumes/Intel/playground/agentteams/<unit>`
   工作树进行；同任务续作先关旧树再开新树。保留主树及他人修改。复杂开发先观察，
   沿宿主编排入口做独立计划。具体代码、文档、测试和集成执行统一交
   `codex exec --profile gcm` worker；peer 只保留目标编排与验收责任，不直接写
   代码；Alice 只做指导、审计和 review，不执行代码、文档、测试或集成；不使用
   Astra worker，GCM 不可用时显式报告不可用，不用 Astra 替代。
   派单明确原问题、允许文件、owner、验收、失败停止点，不因接单回执宣布完成。
4. 按正确图补受影响 gate 和能抓住具体失败的红测，再修改唯一实现。图变更沿
   `dagpipe-runtime` validate/inspect；图校验不证明 operator 已绑定或业务已运行。
   协议或 owner 变化同步适用 map，不手改 SDK 记录或用 mock success 通过准入。
5. 在根 workspace 使用现有 lockfile。新树或依赖变化时运行
   `pnpm install --frozen-lockfile`；未变依赖复用。定向测试、build、AppSDK、安装和
   真实入口的适用性按 [开发管控](../../../docs/development-governance.md) 选择，
   不每次恢复都跑全量。前端必须实际操作目标入口；fixture、窄屏桌面和移动设备证据
   分别报告。外部服务替身不能证明真实 Vikunja 或真实引擎副作用。
6. 完整产品 milestone 在作者自检、适用黑盒通过后做一次独立整体 review。修 finding
   只补受影响验证；内部节点和纯文档/Skill 编辑不另起 review。按当前授权集成、推送，
   核对远端，再清理自有树与进程。不能以分支提交、Review PASS 或消息入队代替交付。

## 最小必要反馈与反例选择

按受影响路径选择反例，不把本节当每个改动都必跑的全套检查。用户决策、执行或恢复
不变的重复提示可删除；权限、数据正确性、无障碍与真实验收不得消融。

| 受影响行为 | 需要能区分的结果 |
| --- | --- |
| 发消息或讨论 | 群共享可见，只有显式 action assignee 执行；无需答复的 action 仍记录结果；评论与 ACK 不自动互答 |
| 写结果与恢复 | 验权/终态检查早于外部写；丢回执沿原 commit 只读恢复，不能重建身份盲写；确定失败持久保留原因 |
| 关闭与重开 | 外部关闭走同一收口；停止准入、取消未开始、在飞等待停止确认；旧开闭操作不覆盖后来的相反状态 |
| 议题列表与切换 | 空议题仍可恢复；列表成功不清 unknown、不证明外部状态新鲜；旧响应不覆盖新上下文，草稿不丢 |
| agent 卡片与整体状态 | 多项未完行动不被最新项掩盖；卡片讲本人责任，汇总讲剩余工作；无变化不重绘输入或重复播报 |

报告只给已交付行为、证据位置、剩余缺口和下一 owner。详细 ID/日志留诊断，不变成
用户必填字段。问题解决才由发起者关闭原 issue；结果回复不追加“请确认收到”。
有新问题再明确 action 和原因，不因提醒、ACK 或结果通知产生下一轮任务。

过程事实写现有 run notes，项目汇总由集成 owner 维护 `note.md`，记忆沿原授权和官方
入口。不要新建平行进度表、指纹清单或第二套生命周期。此 Skill 位于项目 `.agents/`，
不得复制进 SDK 管理的 `.appsdk/skills/` 或全局同名目录。
