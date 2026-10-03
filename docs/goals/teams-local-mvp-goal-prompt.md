# AgentTeams 建模、DAGpipe 与用户 MVP `/goal` 提示词

本文件是可复制执行入口；具体任务、依赖、写入边界和 BB01–BB14 由
[teams-user-delivery-plan.md](teams-user-delivery-plan.md) 唯一维护。
它替换旧版本的接手进度和公网优先排序，不创建 goal 或 subscription。

```text
/goal
目标：完成 AgentTeams 本地用户 MVP 的行为建模、实际 DAGpipe 改造和安装后黑盒交付。
普通用户安装一个包，只编辑 ~/.agentteams/config.toml，启动本地 bridge 和两个独立 daemon；
provider 声明真实服务/资源，receiver 按配置发现、匹配、连接、协商并反复提交新 Work，
取得真实结果。internal.toml 保存需要系统配置、无需用户编辑的内部材料。
Console 是可选观察/配置/Session 面，关闭后新的 Agent Work 仍成功。
有 Session 能力的 Agent 使用受管 OpenCode；被动能力 Agent 不要求模型。

依据：
- AGENTS.md 与 docs/development-governance.md
- docs/goals/teams-user-delivery-plan.md（当前任务顺序、范围与黑盒验收真源）
- docs/design/teams-behavior-model.md
- docs/design/teams-behavior-contracts.md（D1 精确事件/ARC/公开接口契约；未准入候选先复核）
- docs/design/dagpipe/graphs/（项目 graph 拓扑真源）
- docs/design/teams-behavior-audit-20261002.md（审计偏离，启动时确认当前实现）
- docs/goals/teams-long-running-delivery.md（适用交付与阶段记忆约束）

身份与调度：当前 Desktop 主任务是本目标唯一编排者，负责架构/建模、依赖、派单、证据审核、
独立 review、集成、推送、进度与自有资源管理。读取当前 codex-orchestrator、dagpipe-runtime、
coding-principals 和项目适用技能。需要实现 worker 时新建 codex exec --profile gcm，
只传当前任务合同，不 resume/fork 或使用父 transcript；不核究 gcm 的底层路由模型。
不依赖外部 TUI Master，也不为独立开发建立 Collab 身份。不存在可用 worker 时独立推进主线。
实现者和 reviewer 必须不同；不使用 AGY；milestone 使用 Codex Review oauth + gpt-6.1-sol。

启动：读取现有任务笔记/issue/receipts，核对实际 main、origin/main、worktrees、worker 和自有进程。
从第一个尚未完成或证据失效的节点接手；先处理既有 D1 review FAIL/issue 的修订、D2 探针复核
和 U2 窄设计，不覆盖或重复派发仍在写入的任务树。已有图只证明静态校验，尚无产品 SDK 执行证明。
本轮先完成本地用户路径，不根据旧提示词转去公网/NAT 阶段。不得重复建目标、订阅或 bug。

执行顺序：
1. 按计划 D1 补事件、守卫、具体 typed ARC、真实公开接口、唯一 owner 和成功/失败/取消/
   unknown/清理终点；修订现有图，运行 dagpipe graph validate/inspect，不新增第二套图骨架。
   B2 提交与 B8 原请求查询是两条独立 DAG；查询保留原 Work/request identity，不 propose/request
   重放，不把查询成功写成资源释放。topology gate 的覆盖声明必须等于实际验证图范围。
2. 按 D2 核实当前 SDK 与 Node/TS 宿主接入能力；已知 Rust SDK 不等于存在 TS SDK。
   用隔离真实 consumer 验证最小支持边界及打包；取得独立精确设计 PASS 后编写产品代码。
3. 按依赖派发 U1 安装包、U2 配置真源，再做 U3 服务声明与 D3/U4 按需 Work。
   D3/U4 是同一 worker 的单元：用户安装入口真正走 registered Operators → SDK compile →
   immutable CompiledGraph → Runtime → 消费真实结果。远端 Agent 仍拥有 admission/资源，
   不虚构远端 API，不新增账本/daemon/调度器，不以 demo 或 journal 代替用户结果。
   Node 已运行宿主启动单次 Rust runner，以 typed host.call 回调现有公开 owner；不增加常驻
   Rust 服务或 Node 第二套图排序。SDK Object 只证形状，字段契约由 typed port/decoder 验证。
4. 接通 U5 可选 Console 和 U6 OpenCode Session；重叠 runtime 路径串行，UI 可在固定契约下独占并行。
5. D4/U7 复用现有 lifecycle stage store，明确其他图 executable/static-governed 分类，
   实现计划中的黑盒 driver 和 BB01–BB14；统一验证最终同一用户安装包。

每个实现单元：从当时最新 origin/main 建独占 clean worktree，位于
/Volumes/Intel/playground/agentteams/<unit>，唯一 codex/ branch、owner、allowed/forbidden paths、
精确命令和证据目录。根 main 不开发，其他 dirty state 不覆盖。
可复现缺陷先 AppSDK bug 查重建档；按范围做最小红测、根因修复和重复实现消融。
作者完成 focused/regression、适用 typecheck/build/AppSDK gate、候选包安装及真实黑盒，
再独立架构 review；缺证据不得进入 review 或宣称完成。
随后组合最新 main 并复验受影响项，逐单元合入 clean main、push origin main、核对远端 SHA。
候选变更使受影响测试和 review 失效；禁止绕过 hook、force-push 或用旧证据充数。

重入与等待：节点结论及证据立即写入当前任务独占 run notes；恢复先读笔记。
按 source/config/graph/registry/contracts/effects/SDK/environment/artifact 指纹复用有效阶段，
只从首失效节点及依赖后继重跑；main/远端/PID/runtime 可变边界刷新。
有安全独立任务时继续派单；worker 等待使用有界等待，超时检查状态与阻塞，不忙轮询、只 ACK
或干等。阻塞记录首偏离、owner、解除条件和具体恢复动作，不切换到无关治理工作。

收尾：逐单元保留证据，确认停止写入后回收自有 child/daemon/listener、临时 HOME/包/日志、
worktree 和 branch，核对 worktree list 与路径不存在。stale 资源先查归属和内容，再按已有
核销授权处理；dirty、其他 owner 或唯一证据不得强删。保留责任列清 owner/路径/解除动作。
Primary 统一按项目官方 memory 命令写阶段记忆；复核事实标 ai-reviewed、human-unreviewed，
不得把测试、merge、push 写成安装或真实使用完成。

完成 iff：D1/D2 设计准入、真实 Work 提交及原请求查询的 SDK compile/run/用户结果、其余图覆盖分类、U1–U7、
最终安装包 BB01–BB14、独立 milestone PASS、远端 main receipt、适用阶段记忆和自有清理
全部齐备，main clean。公网 Relay、NAT/STUN、手机、coder2new、多 profile、关系治理及
provider 自动 failover 留到后续。直接执行本目标，不再生成新的提示词。
```
