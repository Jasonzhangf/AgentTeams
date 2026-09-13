# AgentTeams Local MVP 执行计划

状态：执行指针，非新的 goal、subscription 或 task graph。

本计划绑定现有长程目标 [teams-long-running-delivery.md](teams-long-running-delivery.md)，
产品路径见 [teams-user-mvp-delivery.md](teams-user-mvp-delivery.md)，阶段依赖见
[teams-development-plan.md](teams-development-plan.md)。三者仍是设计、治理和阶段顺序的真源；
本文件只把下一次 `/goal` 的执行范围收敛成可重入的调度合同。

对应 AppSDK issue：`8aeb3fa`。当前正在执行的实现单元是 `159b78b`；本计划不得创建第二个
goal、第二个 subscription 或第二套任务图。

## 目标

把 AgentTeams 收口为一个用户可执行的本地网络 MVP：用户只维护
`~/.agentteams/config.toml`，运行 `agentteams init/start/status/work/stop`，多个独立
daemon 通过真实本地 socket bridge 完成注册、发现、能力/资源广播、匹配、连接、协商和一次
Agent Work；Console 只做观察与配置，关闭 Console 后 Agent-to-Agent Work 仍然可完成。

## 当前基线与已知状态

- 基线主线：目标建立时的 `origin/main`；启动本计划时为 `3447fc43314d2a517601e988df644660f862eca9`。
- 已有 `288af52`：本地双 daemon、bridge、directory、capability/resource、一次 Work、
  `internal.toml` 生命周期状态和重启基础证据已合并；它不等于完整用户入口或完整 MVP。
- 当前执行单元 `159b78b`：将 `internal.toml` 变成 runtime-owned 的非用户配置真源；worker
  只能修改其合同内的 runtime、测试和 evidence，并提交 map-binding candidate；公共 maps 由
  integration owner 在集成 worktree 单写，必须先红测、再实现、再回报候选。
- 根 `main` 必须保持 clean；任何实现只能在 `playground/<issue-or-task>` 独立 worktree。

## 交付顺序与并发边界

每一项都是独立 delivery unit，绑定一个 issue、一个 owner、一个 branch/worktree、一个基线
commit、唯一写入范围和精确验收命令。实现 worker 与 reviewer 必须不同；主任务负责调度、依赖、
冲突、集成、推送、记忆和资源回收。

1. **U0 Internal Config Compiler（当前 `159b78b`）**
   - `config.toml` 只保留用户意图。
   - `internal.toml` 原子保存 resolved endpoint/Relay、child 启动投影、端口/证书/凭据引用、
     PID、generation、revision、state、错误和恢复信息。
   - child JSON 若仍需要，只能从 `internal.toml` 派生，不能反向成为第二真源。
   - 先形成受影响 architecture-map 的绑定候选，由 integration owner 单写公共 maps，再改 runtime；需有迁移、原子写入、重启和错误路径测试。

2. **U1 用户 CLI**（U0 exact review/integration PASS 后）
   - 提供 `init/start/status/work/stop` 稳定入口。
   - 用户不调用 `generated/runtime-lib`，不手写 child JSON、Relay JSON、PID、动态端口或证书路径。
   - CLI 只调用已绑定的 runtime owner，不复制配置或网络台账。

3. **U2 Provider/Receiver 与 OpenCode adapter 产品检查点**（按 owner 拆为两个 delivery unit；遵循 canonical L2/L3 依赖）
   - **U2a Agent Work owner**：`agent/**`；必要的 `agent-host/**` 或
     `runtime/agent-process.ts` 变更必须另建对应 owner 的 delivery unit，不能由 U2a 越界代改。
     U2a 在 L1 配置入口 receipt 后开始。
   - provider 是可被动提供 capability/resource 的 Agent；receiver 声明连接意图并请求 Work。
   - provider 负责 admission、容量分配和释放；重复 request、超卖、取消和旧 generation 必须显式处理。
   - **U2b Config/OpenCode owner**：`config/**`、`opencode-adapter/**`；不得写 `agent/**`、
     `network/**` 或 UI 台账。
     U2b 在公共 config contract 稳定后即可开始，可与 U1/U2a 并行。
   - 支持多个 provider instance；RCC `127.0.0.1:4444` 为主 provider，`goaichat-openai` 为显式
     backup provider。backup 不等于隐式 failover；catalog/apply/readback 必须走真实 OpenCode 入口。

4. **U4 Console daemon discovery**
   - UI 只读取权威 directory projection：identity、presence、generation、capability、resource。
   - UI 不拥有 runtime/network 台账，不经 Console 转发 Agent-to-Agent payload。
   - 依赖 L2 projection contract 和 L3 review PASS；UI polish、关系图和移动布局不阻断本地 MVP。

5. **U3 本地真实回放与重启隔离**（U4/L4 review PASS 后的 L5 串行收口）
   - 在干净临时 home 中从用户配置启动两个独立 daemon 和 bridge。
   - 真实 socket 完成 register、directory、broadcast、connect、negotiate、Work proposal/request/
     result/close；Console 关闭时仍成功。
   - stop/start 后 `generation` 增长，旧 generation 被拒绝，新 generation 可重新完成 Work；
     resource allocation、幂等和释放均留证。

U0 未通过时，不并发修改共享 `runtime/` 或 child-config 边界。U1、U2a、U2b 在各自依赖满足、
owner 路径明确且不共享写入时并行；U4 在 L2 projection contract 和 L3 review PASS 后收口；
U3 是等 U4/L4 review PASS 后的 L5 串行集成点。任何跨 owner 的语义冲突退回原 owner，主任务只在独立 integration worktree 解决
机械冲突和装配，不新增兼容层。

这些 U 编号只是本产品路径的 delivery-unit 标签，不是第二套阶段图：U0/U1 映射 canonical
`G0/L1`，U2a 映射 `L2`，U2b 映射 `L3`，U4 映射 `L4`，U3 映射 `L5`。阶段 gate、owner
和关闭条件仍以 canonical 文档为准。

### Owner、路径和首个 gate

| unit | 唯一 owner | 允许写入 | 禁止写入 | 首个 focused gate |
| --- | --- | --- | --- | --- |
| U0 | runtime | `runtime/local-config.ts`、`runtime/local-supervisor.ts`、`runtime/local-process.ts`、必要的 `runtime/agent-process.ts` projection、对应 specs、`docs/evidence/159b78b-*/`；architecture-map 变更只作为候选绑定提交给集成 owner | `network/**`、`server/**`、`agent/**` 语义、`config/**`、`docs/architecture/**` 公共真源、UI、package/lock | `pnpm exec vitest run runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-two-agent.spec.ts` |
| U1 | cli-adapter | `cli-adapter/**` 及对应 CLI evidence；需要 runtime API 时另建 runtime unit | `runtime/**`、`agent/**`、`network/**`、`config/**`、UI | `pnpm exec vitest run cli-adapter/cli.spec.ts cli-adapter/fixed-process.spec.ts` |
| U2a | agent | `agent/**` 及对应 Work/resource specs；跨 `agent-host/**` 或 `runtime/**` 需另建 unit | `network/**`、`config/**`、`opencode-adapter/**`、UI | `pnpm exec vitest run agent/**/*.spec.ts runtime/agent-work-client.spec.ts` |
| U2b | config + opencode-adapter | `config/**`、`opencode-adapter/**` 及对应 specs/evidence | `agent/**`、`network/**`、UI；不把 RCC/goaichat 结果写进业务 payload | `pnpm exec vitest run runtime/managed-config-owner.spec.ts runtime/managed-config-live.spec.ts runtime/managed-opencode-session.spec.ts` |
| U4 | ui | `ui/teams-console/**`；必要的 `console-host/**` projection adapter 需单独绑定 owner | `runtime/**` 台账、`network/**` 真相、Agent Work payload、provider ledger | `pnpm exec vitest run runtime/console-hub.spec.ts runtime/console-runtime.spec.ts control-protocol/console-wire.spec.ts ui/teams-console/tests/api.spec.ts ui/teams-console/tests/model.spec.ts` |
| U3 | 主任务 integration owner | 独立 integration worktree、受影响 integration specs、`docs/architecture/**` 公共 maps、`docs/evidence/<unit>/`；语义修复退回原 owner | 直接覆盖 worker 语义、dirty main、他人 worktree/branch | `pnpm exec vitest run runtime/local-relay-bridge.spec.ts runtime/local-two-agent.spec.ts`，随后编译候选真实回放 |

表中的命令是首个 focused gate；每个 unit 仍须按受影响 map 补齐 regression、typecheck/build、
AppSDK compile/verify、真实入口和 exact review。U2 产品检查点的两个 unit 可以并行，不能由一
个 worker 跨越两行的禁止路径。

表中 focused gate 的跨模块 spec 只是只读验证输入，不授予该 unit 修改对应 owner 路径的权限。
如果跨模块 spec 失败且需要语义修改，必须新建/复用对应 owner 的 delivery unit；当前 unit
保留为 blocked 或 awaiting-integration，不得越界修测试来取得绿色。

## 调度、审核与资源规则

- 默认 worker：新的 `codex exec --profile gcm`；不依赖外部 master，不冒充其他 task/peer。
- 普通 exact review 使用独立 Codex Review；milestone review 使用 Astra；本计划不使用 AGY Review。
- 每次唤醒先读取本计划、当前 goal 状态、worker/task/worktree、Git 和资源状态。根据
  evidence fingerprint 只从首个失效 gate 重跑，下游随依赖失效；没有漂移的 PASS 写 reuse receipt，
  不做无意义全量重跑。
- worker 只交候选、run notes 和 evidence，不直接扩大范围、合并或删除他人资源。范围外问题新建
  issue；不得用 fallback、silent repair、兼容旁路或手工覆盖隐藏冲突。
- 每个 unit 固定闭环：bug/feature 建档 → clean worktree → 红测/实现/验证 → exact review PASS
  → candidate commit → 独立 integration worktree → mainline 验证 → 按项目保护流程合并到 main →
  `git push origin main` 与 `git ls-remote origin refs/heads/main` → memory L2 → cleanup receipt
  → 才能关闭 issue。若仓库保护要求 PR，必须保留 PR merge receipt；不得用直接 push 绕过保护。
- 只有主任务写 project memory；已验证事实可晋升 Level 2，但必须标记 `ai-reviewed`、
  `human-unreviewed`，不能把测试通过写成部署完成，也不能把 merge 写成 push 完成。
- 清理只处理本任务拥有且已停止写入的 worker、进程、监听、锁、claim、worktree 和 branch；唯一证据
  必须先转存到 `docs/evidence/<unit>/`。根 `main`、远端 receipt 和保留责任必须可复核。

## 五段 Loop 与每轮顺序

- **Trigger**：读取当前计划、issue、候选、receipt、进程和 worktree；找到首个未完成或失效 unit。
- **Work**：按唯一 owner 派一个边界清晰的 gcm worker；主任务保留架构、冲突、集成和最终验收。
- **Gate**：focused 红绿测试 → mapped regression → typecheck/build → AppSDK compile/verify（仅在
  maps/治理受影响时）→ 真实入口回放 → 独立 exact review。
- **State**：写 candidate/review/integration/push/memory/cleanup receipts；状态只能是
  `pending/running/passed/reused/invalidated/blocked/awaiting-integration/cleanup-pending`。
- **Stop**：仅当远端 main SHA、当前候选的适用验证、L2 memory 和自有资源清理齐备时关闭 unit；
  所有 MVP unit 完成后才关闭长期目标。

每轮顺序固定为：`Discover → Hand off → Verify → Persist → Schedule`。等待使用有界等待；worker
未终态前不重复派发同一 unit，不因 gcm warning 重启或宣称完成。

## MVP 退出条件与非目标

### 必须全部满足

- `config.toml`/`internal.toml` owner 分离真实成立，child projection 无第二真源。
- 稳定 CLI 完成 init/start/status/work/stop；两个独立 daemon 和本地 bridge 可重启。
- provider/receiver 的 capability/resource、matching、admission、幂等、旧 generation 隔离和一次
  file-search Work 均有当前候选的真实 socket 证据。
- RCC 主 provider 与显式 goaichat backup 的真实 OpenCode catalog/apply/readback 可复核；无隐式 failover。
- Console 只读 directory projection，Console-offline Work 成功。
- 每个 unit 有 issue、exact review、integration、远端 push、L2 memory 和 cleanup receipt；根树干净。

### 明确不属于本轮

公网 Relay、STUN/ICE、双 NAT、direct internet、direct/relay 候选编排、手机/蜂窝、多机公网部署、
Endpoint E1/E2 完整注册/发现/AppSDK admission/Work 绑定、master/slave 关系治理/撤销/离线投影、
Console 完整无障碍/移动布局/关系深度投影、browser 多 profile、完整 Search/Memory 插件、
自动主节点选举、消耗型余额、更完整 CLI、复杂模型策略、provider 自动 failover、组织/计费和生产
发布继续留在 post-MVP，不能用本地 replay receipt 推断已支持。

## 目标提示词

```text
/goal
目标：按现有 AgentTeams Local Network MVP 合同，完成用户可执行的本地双 daemon 路径：用户只维护 ~/.agentteams/config.toml，运行 agentteams init/start/status/work/stop；runtime 由 internal.toml 管理内部真源；两个独立 daemon 经真实本地 socket bridge 完成发现、广播、连接、协商和一次 Agent Work；Console 仅观察/配置且离线不阻断 Agent-to-Agent Work。

说明：本任务不再生成新的提示词，直接按实现文档执行。当前 Desktop 会话负责调度、依赖、worker、review、integration、push、memory 和资源回收；不依赖外部 master，不创建第二个 goal、subscription 或 task graph。

实现文档：
docs/goals/teams-local-mvp-execution-plan.md
docs/goals/teams-long-running-delivery.md
docs/goals/teams-user-mvp-delivery.md
docs/goals/teams-development-plan.md

执行规范：
- 每次唤醒先检查当前 goal、issue、worker、worktree、branch、进程、端口和远端 main；从当前 origin/main 为每个 delivery unit 建立独立 clean worktree。
- 默认使用新的 codex exec --profile gcm worker；worker 只改合同范围。普通 exact review 用独立 Codex Review，milestone 用 Astra，不使用 AGY Review。
- 先完成 U0 internal.toml 真源；U1 CLI、U2a provider/receiver Work、U2b 多 provider/OpenCode 按各自依赖并行；随后完成 U4 Console directory projection，最后由 U3 完成本地真实回放/重启隔离与 L5 收口。
- 遵守红测→最小修复→适用 regression/typecheck/build/AppSDK gate→真实入口→exact review→独立 integration→push→memory L2→cleanup 闭环；根据 fingerprint 只重跑首个失效 gate及其下游。
- 禁止 fallback、silent repair、第二配置真源、Console 数据转发、直接修改 dirty main、复用旧候选证据或删除他人资源。公网 Relay/NAT/手机/关系治理属于 post-MVP。

完成标准：
- 所有 MVP 退出条件、每个 delivery unit 的 review/integration/push/memory/cleanup receipt 全部齐备；远端 main SHA 已核实，根 main clean，自有 worker/进程/监听/worktree/branch 已安全回收。
- 不能把测试、merge 或本地 replay写成公网部署、push 或完整 V1；缺证据时保留为 open/blocked/cleanup-pending 并写明解除条件。
```
