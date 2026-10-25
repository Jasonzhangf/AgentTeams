# AgentTeams 本地用户 MVP 交付计划

修订：2026-10-24。本文件拥有本地 Work MVP 的用户目标、实施边界和 BB01–BB14 验收。
本轮删除过期 worker/worktree 库存、重复进度表和提交身份包装要求，保留用户能力与失败验收。
旧执行轨迹留在 Git 历史和原始证据中，不再作为当前派单指令。

## 目标和当前事实

普通用户安装 AgentTeams，编辑用户配置，启动本地 bridge、provider 和 receiver，连续提交
新的 Work 并获得真实结果。Console 可用于发现、观察和配置；关闭 Console 后 Agent Work
继续成立。具备 Session 能力的 Agent 支持真实消息、工具、权限与取消。重启保留配置，
旧代次明确拒绝，未确认的外部副作用保留责任。不能为对齐实现删减这些义务。

以下是 2026-10-24 的证据快照，不是自动更新的任务状态表：

| 能力 | 已有证据 | 尚不能据此声称 |
| --- | --- | --- |
| 安装和本地 CLI Work | `f759ecc` 安装包经 init/start/submit/query/stop 回放；第三次 gamma 请求与查询有原始响应 | 全 BB01–BB14、浏览器完整任务或自动多 agent 协作已通过 |
| Work 结果 | alpha/beta 有结果记录；gamma 原始响应可核对同一 Work/request 与真实文件结果 | 前两次 stdout 有逐字归档；所有失败/容量/重启用例已重跑 |
| Console | 认证页面可打开；显式测试授权后 projection 有 provider/receiver 和真实 Work | 默认启用即可工作：默认 manager policy 下出现不透明 502；UI 未呈现 Work；本地 History owner 未绑定 |
| ACP/DSH | 安装入口能启动真实引擎、session/new 并注册 online | 该次回放证明真实推理、工具调用或多 agent Session；其他历史证据仍只覆盖原声明范围 |
| 实时观察 | 真实 SSE 与发现页回放 | 无业务变化不重绘：observedAt 每次变化会使去重失效，已归档相邻帧 |
| 群聊增量 | 第一批 hub/CLI/通道已有源码与测试；WebUI 候选正在集成 | 本地 Vikunja 替身等于真实实例；fixture/HTTP 测试等于群聊可用交付 |

当前用户路径证据位于证据提交 `e644b1c` 的
`docs/evidence/user-path-verify-20261024/notes.md` 及同目录原始回执。
模块拆分的已交付证据见 `docs/evidence/modular-monorepo-r3-20261024/validation.md`。
前者结论是 CLI Work 有限验收通过、Console/ACP 整体可用性仍需修复；不否定模块拆分交付。
证据尚未合入本分支时从该 Git 对象读取，不把不存在的工作目录当入口。

代码任务由项目 master 编排、按模块 owner 分工；任务号和最新进度在现有任务系统维护。
本文件不保存会过期的 worker 名单、PID、活动树或另一个恢复状态机。

## 三个范围分别验收

| 范围 | 唯一行为契约 | 完成边界 |
| --- | --- | --- |
| 保留的本地 Work MVP | 本文件、`teams-behavior-contracts.md` 和既有 Work 图 | 同一交付包满足 BB01–BB14；不是一次成功查询 |
| ACP/LAN/控制端增量 | `teams-acp-daemon-config-v4.md`、长程任务引用的 ACP 计划 | 按该计划实际入口验收；不能用 Work 成功代替 |
| 首个群聊 WebUI | `teams-group-messaging-v1.md` 第 18 节第一批、`teams-group-webui-design.md` | 人工可操作 issue/action 闭环及真实浏览器/Vikunja；模型执行按第二批另验 |

同一个用户包可包含三者，但能力状态分开。公网 Relay/NAT/STUN、中心部署、移动端产品、
自动 provider failover 不成为本地 MVP 前置。窄屏回放不冒充移动端产品交付。

## 最小实施顺序与唯一 owner

| 增量 | 用户得到什么 | 实施与验收边界 |
| --- | --- | --- |
| 可执行 Work | 安装后连续提交新请求，查询原结果且不重放 | runtime/Work owner；复用现有 CLI 和 DAGpipe consumer，按 BB02/04/05/07/08/11 补缺口 |
| 可用 Console | 发现真实能力、看 Work 结果、理解拒绝并恢复 | Console HTTP owner 保留 typed 错误；UI 只消费投影；History 按 Work/connection/Session 各自 owner 接入 |
| 配置与 Session | accepted/effective 明确，真实消息/工具/审批/取消 | config 单一意图源、Agent/adapter 执行准入；按 BB10/12 补适用证据 |
| 同包收口 | 上述行为可从交付包复现，失效重入与资源清理成立 | master 集成；各 owner 提供用例，统一 driver 只调度，不拥有第二份业务状态 |

先安排阻断用户路径的 ready 工作；前端、错误映射和状态投影可在契约稳定且不重叠的范围并行。
同一文件只有一个 writer。群聊现有候选不因本轮审计重建或重复派单。
新问题先去重，记录具体触发、证据、owner、最小修复与失败反例，再交 Jenny 安排。
只暂停实际依赖失败的工作，不等待整份审计完成。

## 用户路径的反馈规则

安装/启动显示可访问入口、可用能力或具体失败原因。能力声明不等于能调用。
配置提交只显示已接受；读到生效状态才显示已生效。连接意图接收不显示已连接。
Work/Session 提交原位显示等待或执行，完成后直接给业务结果；无需再点确认已读。
拒绝显示原因和可操作的恢复位置，不自动放宽 policy。未知保留原请求并提供只读查询，
不创建新身份重发。观察更新不清草稿、不抢焦点、不把时间戳变化播报成业务进展。
停止请求和确认停止分开。详细协议、ID 和原始日志留在诊断，不占据主任务反馈。
群聊的逐阶段表、卡片、关闭和重开行为只在 WebUI 设计维护，不在这里复制。

## 必需黑盒验收 BB01–BB14

以下用例保留原范围，表中列的是完成条件。未有有效回执的用例保持未验收。
从源码树外的安装副本、隔离 HOME/端口和公开 CLI/API/真实浏览器触发；不调用私有函数
或改内部账本冒充通过。凭据从当时配置引用，证据不得含秘密。

| 用例 / owner | 真实输入 | 结果与副作用断言 |
| --- | --- | --- |
| BB01 / package | pack 安装、init、启动、查询、打开 Console、停止 | 无开发目录依赖；CLI/runtime/UI 齐备；缺依赖显式失败；本轮 children/listener 收口 |
| BB02 / config/runtime | 只改用户 config.toml，启动 bridge/provider/receiver | 无须编辑内部材料；两个独立 daemon，经本地真实 socket 注册、发现、广播和协商；派生配置不变第二真源 |
| BB03 / capability | 禁用/缺失 browser CLI，再启用；查询与请求 Work | 不可用能力不宣告/匹配，无执行副作用；启用后真实 browser 创建/销毁，真实文件搜索 |
| BB04 / Work | 两个不同标记的新请求，再查询原请求 | 不同请求返回各自真实结果；查询以新 execution/attempt 保留原 Work/request 身份，无新增执行，不读 startup receipt 冒充 |
| BB05 / admission | 未授权 consumer/manager、未声明 operation、旧 generation、错误 target | 明确拒绝且无服务/资源副作用；合法请求仍成功 |
| BB06 / capability/Work | 两 receiver 占用真实 browser，超容量请求，释放后再申请 | 一对多成立；超容量拒绝且不额外创建；确认释放后可接纳 |
| BB07 / Work | 执行中断开自有 socket/provider，重新授权查询，恢复或停止 | failed/unknown 如实；查询不 propose/request；不重发/假释放；外部资源保留责任，销毁确认有终态 |
| BB08 / config/Work | apply 服务/provider/model 配置，重启，用旧/新代次请求 | accepted/effective 与用户配置持久；新代次可用，旧代次拒绝；不丢旧资源责任、不建第二份 editable JSON |
| BB09 / Console | 浏览器发现/配置/观察；auth/origin 拒绝；关闭 Console 后发新 Work | 真实 daemon/服务可见；配置进唯一 owner；未授权不可管理；Console 不参与 Agent Work 数据转发 |
| BB10 / config/Session | 显式选择当前 RCC provider/model，再显式切换另一 provider；空 catalog、冲突、无效凭据 | 两 provider 各有真实调用；accepted/effective 可读；空目录允许显式模型；CAS/鉴权失败明确，无自动 failover |
| BB11 / DAGpipe/Work | 安装 CLI 新 Work/查询；隔离候选缺 Operator、ARC 契约或 effects | 实际 graph/SDK/registry/CompiledGraph/journal 可关联；查询无执行副作用；缺契约编译失败且无业务副作用；typed boundary 验字段，不用 SDK demo 代替 |
| BB12 / Session | Console→Agent→OpenCode 消息、工具、真实 permission 批准/拒绝、取消；passive Agent 请求 | 保留消息/tool ID/参数/结果意义；批准/拒绝副作用正确；取消保留基座接纳并等待相关终结或保留 unknown，abort 不等于最终取消；passive 明确拒绝；不固定模型随机文本 |
| BB13 / lifecycle | 令一个阶段失败后恢复；分别改变源/图/registry/配置/产物或移除必需证据 | 有效阶段复用；首个失效节点及真实依赖重跑；变化不能复用失效 PASS；沿已有 stage store，不新增缓存/指纹包装 |
| BB14 / resource owner | 自有启动失败、stop 与交付 cleanup | 不停别人进程；自有资源清理且证据保留；dirty/活动资源记录 owner、原因和解除动作，未收口不称完成 |

用例负责人维护可重复的命令、实际输入、结果、副作用与资源收尾。测试先绑定失败模式；
单测辅助定位，真实入口验收验证用户行为。输入未变的有效证据直接引用，缺失或冲突才补验。
最终同包检查保留；不能把来自不同包的零散通过记录拼成最终通过。

## 开发与交付

受影响 DAG 与五张架构 map 定义 owner 和边界。沿
[开发管控](../development-governance.md) 选测，在完整 milestone 的自检和实际入口验收后
做一次独立整体 review；finding 修复只复核受影响项。纯文档修改做定向检查。

交付记录只保留实际入口/包版本、配置 revision、必要环境、输入结果、副作用、失败边界
及原始证据位置。不为日常开发、派单、审查或清理主动计算 SHA/checksum、冻结快照，
不让身份包装成为验收替身。既有工具生成的记录按其真实边界保留，改实现由其 owner 处理。
业务结果与控制回执分开，不能从 journal 重建业务决策。

master 合并、推送并确认远端，记录实际部署/运行范围；回收本任务资源，保留有责任的对象。
阶段记忆沿用户已授权的长程合同执行，不再复制审批链。
全 MVP 仅在 BB01–BB14、适用独立审查、远端交付与资源收尾齐备后完成。
设计完成、图校验通过、测试通过、安装通过和产品可用分别报告。
