# AgentTeams 长程开发与交付任务

授权：用户要求主任务主导完成整个 AgentTeams，监督/分配子任务，负责进度、冲突、
协作、提交合并、工作树关闭和资源清理；每阶段执行记忆管理、二级审核并更新 AppSDK memory。
主任务：`01a07497-8e08-7e90-be56-c9f69d72bb26`。本文件定义执行责任和收尾条件，
当前产品范围、阶段依赖与黑盒完成条件以 [用户交付计划](teams-user-delivery-plan.md) 为准。
本文件只维护长程责任和阶段记忆要求，不另建任务图或验收清单。

## 当前收口 profile：Phase 1 Local Network MVP

当前长期目标只执行这一份 Local Network MVP profile，不创建第二个 goal 或第二个
subscription。第一阶段先收口本机真实网络桥接：多个独立 daemon 从
`~/.agentteams/config.toml` 启动，通过真实 TCP/WebSocket socket 完成发现、广播、连接、
协商和 Agent-to-Agent Work。Console Host 只做观察、配置和 daemon projection，不进入
Agent-to-Agent 数据路径。

本阶段可以使用本地 Relay/bridge 进程辅助目录和连接建立，但它不是公网服务，也不能替代
Agent 之间的数据路径。公网 Relay、NAT/STUN、双 NAT、direct transport、移动端、关系治理
和完整 UI polish 都是后续阶段；受影响源码仍必须通过既有 mapped regression gates。
本阶段的 mapped live gates 是 `teams-peer-work-execution` 和 `teams-console-offline-work`；
公网/NAT 证据只由对应的 `*-public-nat` 后续 gates 收集，不得成为本地 profile 的隐含前置。

产品完成以用户交付计划中的 BB01–BB14 和最终收口条件为准。本文件不另列较窄的
“一次 Work”验收或过期的 Endpoint/browser backlog，避免把组件通过当成用户 MVP 完成。

## 主任务与实施 worker

Desktop 主任务负责架构、依赖、派单、验收、集成、推送和自有资源管理。
按当前 `codex-orchestrator` 为独立实施范围新建 `codex exec --profile gcm`；只传当前
任务合同。worker 身份、范围和状态从本任务笔记与实际执行结果读取，不复用旧 session 表。

并发写入必须有路径归属。公共接口变更先由主任务决定并统一通知；冲突交由主任务协调，
禁止双方各加fallback或兼容层。不能覆盖其他worker修改。已隔离的独立开发不依赖
Collab 或 tmux；不得伪造登记/claim，确实依赖共享锁的操作等待可靠协调。

## 每阶段闭环

工程交付遵循项目 `AGENTS.md` 所引用的交付闭环与
[开发管控](../development-governance.md)。阶段状态与证据复用由开发管控维护；
本文件不再另列实现、验证、review 和集成步骤。适用的工程证据、下述阶段 L2 与
自有资源收尾齐备后才关闭阶段；有保留责任时明确记录，不预写完成。
阶段收尾记忆可作为独立小提交，不为增加一条已核实的 receipt 重复整个产品运行回放。

## 每阶段 AppSDK memory / Level 2

项目 `memory/{plan,path,knowledge,lesson}.jsonl` 是记忆事件真源，Markdown/index/SQLite
由官方CLI生成。统一由主任务汇总写入；worker只写自己run notes并提交候选，避免并发
写同一个memory库。本项目每阶段的memory流程由用户明确选为收尾要求，替代默认可选策略。

使用 `project-memory`（AppSDK memory独立入口）或当前官方 `appsdk memory`，不手改
事件/级别/哈希。每条归入一个category并附任务、基线/候选、证据引用、适用边界与剩余问题。
至少记录本阶段验证结果/收尾；新增可复用经验才另建lesson，不为数量制造重复记忆。

执行顺序：query去重→entry或review --run写L3→主任务审核记忆内容与所引事实证据→
promote --id <id> --level 2 --evidence <真实审核引用>→verify/get核实级别与内容。
使用 `ai-reviewed`、`human-unreviewed` 标签明确审核主体；只有实际人类复核后才声明该状态。
已执行并有证据的测试可以由主任务复核后晋升，不等待另一个agent或人类审批。
先有审核证据才升级。若发现来源失效、混淆测试/部署/合并/清理，修正后重审。
阶段失败/未知同样可以形成经核实的L2结论；不得通过promote把未完成改成已完成。
全局Codex memory不自动写入；本授权的目标是当前项目AppSDK memory。

## 提交与资源管理

主任务管理候选提交和集成队列；worker 的 commit、merge 和 push 范围由任务合同明确。
合并不使用保护绕过或强推。主线保持代码开发只读，允许已授权集成同步和验证。
不自动清理其他项目、其他任务、含唯一工作或仍被引用的目录。临时证据在删除前转存到
任务可保留的证据目录，不能仅留下/tmp路径后宣布清理完成。服务停止仅按明确PID/服务名。
本目标独立执行，不把 Collab 身份、注册或外部 Master 作为前置。
资源库存从任务笔记与 `git worktree list --porcelain` 读取，不在本合同保存会过期的
工作树名单。按项目 `AGENTS.md` 的资源规则核销；保留对象必须记录 owner、用途和解除条件。

## 持续监督与中断恢复

以本任务的 active goal 为执行目标。恢复先读当前节点笔记，再刷新当前动作依赖的
goal、worker、Git 或资源状态；不因唤醒重查所有未变对象。
无变化不重复发状态。里程碑完成、实质失败、需要用户输入或全部完成时通知用户。
停止/暂停用户指令立即生效；自动运行不扩大已授权的生产、凭据或设备操作范围。
