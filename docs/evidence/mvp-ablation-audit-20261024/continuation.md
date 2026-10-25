# 消融审计继续执行记录

用户要求直接完成前序任务，使用 Astra worker 协作，常规开发交 peer。

## 协作与证据

- 独立 CLI worker：`codex exec --profile oauth --model gpt-6-astra -c 'model_reasoning_effort="high"' --sandbox read-only`。
- 实际启动回执：model `gpt-6-astra`、provider `oauth`、effort `high`、session
  `01a17152-ef4c-75e0-9b0f-f4968e3addf6`。退出码 0，完整结果归档为 `astra-analysis.md`。
- worker 只读分析提交 `3b77ef7` 与文档 `b9d9e27`，没有修改产品或运行测试；不是最终 reviewer。
  可选 MCPX 连接失败不影响本次文件读取。没有以工具初始化成功代替任务完成。
- Alice 抽查 `submitAction`、`delegate`、`reportOrRefuse` 与通信协议，确认所列调用顺序和
  状态缺口，已追加原 issue `8dde877` 并交 Jenny。公开入口反例由原实现 owner 补红测和修复。

## 已纠正的安排

Jenny 起初计划将身份切换、未知保留和旧议题恢复放在首次浏览器回放之后补做。Alice 明确
这三项是合入前 P1；Jenny 已接受，沿原任务由 Bob/Carol 完成后再做整体产品验收。
普通列表成功不能消除写操作未知；只有与原操作关联的权威读取可收敛。
恢复旧议题需要按群鉴权的只读 IssueSession 列表，不能要求用户手填 ID 或自动执行 reference。

新增人工后端闭环缺口统一交 GroupHub 单 writer：外部操作终态持久化与只读恢复、提交前
终态校验、人工报告原因/证据、关闭/外部关闭收口与状态未知时的新 action 准入。
`28f8373` 的项目冗余与 SDK 强制字段边界见 Astra 分析；不允许伪造 SDK records。
`805b950` 已追加验收边界：可恢复的 unavailable 文案只关闭错误反馈子问题，不能替代 Work 可见性。

常规开发仍由 peer：Bob UI，Carol 后端/协议，Jenny 集成与真实 Chrome 验收；生命周期
消融由 Jenny 指派独立 owner。Alice 不与这些 writer 同时修改产品代码。

## 设计已修正

WebUI 文档与原型直接修复：blocked 补资料只保留原记录并准备关联新 action，须显式发送；
首版导航不依赖 ACP Session；显式关闭委托保留为已确认能力，缺服务端有效委托时不提供
伪成功入口；操作者选择器明确为受授权的 daemon 代理上下文，不冒充独立登录用户。

Ego 浏览器真实操作原型：模拟阻塞 → 补充信息 → 原 blocked 仍可见且无自动新 action →
显式发送 → 新一轮 pending，旧 blocked 仍保留。测试空间已关闭。此为原型行为证据，
不是产品 API、真实登录权限或 Vikunja 证据。未变的布局检查沿前次结果复用。

当前活动树的真实 owner/Vikunja 回执比首次审计增加了证据，但明确 `--skip-browser`；
不升级成 WebUI 完整验收。文档集成与实现集成分别等待各自真实回执，不因消息入队宣布完成。
