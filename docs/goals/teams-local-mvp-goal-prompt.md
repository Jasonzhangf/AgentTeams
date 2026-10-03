# AgentTeams 建模、DAGpipe 与用户 MVP `/goal` 提示词

本文件是可复制执行入口；具体任务、依赖、写入边界和 BB01–BB14 由
[teams-user-delivery-plan.md](teams-user-delivery-plan.md) 唯一维护。
它替换旧版本的接手进度和公网优先排序，不创建 goal 或 subscription。当前已有 active goal 时，用本文件修订接手依据，从现有节点继续，不另建重复目标。

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
- docs/design/teams-behavior-contracts.md（已准入 D1 精确事件/ARC/公开接口契约）
- docs/design/teams-package-delivery.md（已交付 U1 窄安装设计）
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
计划更新输入为 main/origin/main 6526667c。D1 94b4633 和 D2 35ca32b 已独立 PASS、推送、清理，
阶段记忆分别在 1b492fb/78fa8bc。读取 receipts 后复用，不重开已关闭的 ed0bada/8981687。
从首个尚未完成或失效节点接手：U1 设计 r6-main PASS 已在 6526667c 推送，精确 tree 1eb7afa2，
审查归档、设计树/branch 已回收；阶段 memory 待 primary 收口。746dd7b 基础 package
只证 assets/auth 和 CLI init/status/stop，须完成实际 daemon start/restart 或显式 fail-closed，
不能让基础 smoke 生成 restart evidence；继续同一 owner，不重复 writer。
U2 776fcad 的 r1 FAIL 三项 P1，r4 已派独占修订；U6 83a8bd1 的 r1 FAIL 六项 P1，
r2 已派独占修订。两者新设计 PASS 后才产品实现，不按旧状态重新派作者。
4b6c377 D3/U4 r3 turn.completed，作者报告 10/10、build/typecheck/图验证通过及三旧失败文件
串行通过；核实包装终态、exact evidence 和 scope。全量并发因果未证，安装 BB11 未完成，
AppSDK 准入仍阻塞。U7 两个实验树已归档回收，不再接管这些旧路径。
852c3ac prerequisite open，canonical pin-lock 返回 INVALID_SDK_MIGRATION_RECORD；
upstream a7cc2a4 在独立 AppSDK 树只读诊断/设计中，先独立设计审再修。
前置阻塞不等于重入缺陷已复现；禁止用旧 binary 或伪造锁/历史 receipt 解门禁。
精确候选与状态见交付计划及各单元 notes/receipts，启动时刷新。
核对实际 worker/终态再收口，不重复 writer，不删除未交付候选。
八图静态与 SDK 探针能力已证实；尚无安装后的产品 SDK Work 执行证明。
本轮先完成本地用户路径，不根据旧提示词转去公网/NAT 阶段。不得重复建目标、订阅或 bug。

执行顺序：
1. 复用 D1 事件、守卫、typed ARC、真实公开接口、owner 与各终点；仅对改变的契约修订现有图，
   运行 dagpipe graph validate/inspect，不新增第二套图骨架。
   B2 提交与 B8 原请求查询是两条独立 DAG；查询保留原 Work/request identity，不 propose/request
   重放，不把查询成功写成资源释放。topology gate 的覆盖声明必须等于实际验证图范围。
2. 复用 D2 实际 Rust SDK/Node 宿主 consumer 准入；不能当作产品安装/黑盒。
   U2 必须区分 machine source revision 与每 daemon durable accepted/effective；catalog 刷新不
   推进用户意图 revision。固定 async persistence/CAS/锁与显式迁移，不批准全机 accepted 替代
   daemon accepted，不宣称已有双文件原子保证。新接缝先窄设计 PASS 再实现。
3. 复用已交付 U1 设计，修基础安装行为/证据；消费 U2/U6 已派修订并独立审新设计。
   U2 先持久化 pending migration 再替换 config，固定恢复顺序；锁只覆盖 capture/reconcile，
   外部 provider/OpenCode 操作不持锁；uncertain 有 typed projection 与 startup/reconcile owner。
   U6 修订固定模型意图归 U2，禁止 Session 第二配置源；
   Console JsonValue 保真，adapter 显式验证映射；事件必填身份/结果，cancel 保留基座接纳和最终
   unknown，明确失败不能永久污染 ManagedConfigOwner，readiness 由 owner 观察。新设计独立 PASS
   后再实施产品。每份新接缝交付角色/事件、中文 SESE 与状态图、typed ARC/错误、公开接口及
   Operator/owner/effects、成功/失败/unknown/取消/恢复/清理证据和精确黑盒命令。
   既有 U1 package、D3/U4 实现与独立设计/SDK前置调查可并行，不重复 writer。
   现有 D3/U4 同一 owner 先做
   已准入 SDK/公开 Work 范围，修 typed stdio 控制/业务分离与当前失败路径，重验精确候选。
   U1/U2 准入后派独占产品实现，配置接缝冻结后推进 U3 与 D3/U4 CLI/receiver 接线。
   D3/U4 是同一 worker 的单元：用户安装入口真正走 registered Operators → SDK compile →
   immutable CompiledGraph → Runtime → 消费真实结果。远端 Agent 仍拥有 admission/资源，
   不虚构远端 API，不新增账本/daemon/调度器，不以 demo 或 journal 代替用户结果。
   Node 已运行宿主启动单次 Rust runner，以 typed host.call 回调现有公开 owner；不增加常驻
   Rust 服务或 Node 第二套图排序。SDK Object 只证形状，字段契约由 typed port/decoder 验证。
4. 接通 U5 可选 Console 和 U6 OpenCode Session；重叠 runtime 路径串行，UI 可在固定契约下独占并行。
5. 按计划 P1 本地协作、P2 观察/能力、P3 模型 Session、P4 完整交付逐阶段收口。
   D4/U7 复用现有 lifecycle stage store，明确其他图 executable/static-governed 分类，
   实现黑盒 driver 与 BB01–BB14；同包最终验收含端口隔离、runner identity 拒绝和无副作用证明。
   U7 先以官方非破坏 pin/migration 修复 prerequisite，保留历史 evidence；不复制旧 binary、手写
   digest/receipt 或削弱 gate。upstream 根因仍待真实正反证据；前置恢复后同入口验证后阶段失败
   和恢复，不用静态推断冒充已复现。已回收诊断不重建，保留未交付候选；按当前归属清理资源。

每个实现单元：从当时最新 origin/main 建独占 clean worktree，位于
/Volumes/Intel/playground/agentteams/<unit>，唯一 codex/ branch、owner、allowed/forbidden paths、
精确命令和证据目录。根 main 不开发，其他 dirty state 不覆盖。
可复现缺陷先 AppSDK bug 查重建档；按范围做最小红测、根因修复和重复实现消融。
作者完成 focused/regression、适用 typecheck/build/AppSDK gate、候选包安装及真实黑盒，
再独立架构 review；缺证据不得进入 review 或宣称完成。
每个 unit 随实现交付公开 consumer/黑盒，不等最后才补；U7 driver 汇总已有用例，不重建业务
owner。资产/health/stopped status、SDK 探针和 journal 不能代替启动/重启/业务结果的事实。
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
