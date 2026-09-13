# AgentTeams Local MVP 执行计划

状态：唯一可重入执行指针，非新的 goal、subscription 或 task graph。

本计划绑定现有长程目标 [teams-long-running-delivery.md](teams-long-running-delivery.md)，
产品路径见 [teams-user-mvp-delivery.md](teams-user-mvp-delivery.md)，阶段依赖见
[teams-development-plan.md](teams-development-plan.md)。三者仍是设计、治理和阶段顺序的真源；
本文件只把下一次 `/goal` 的执行范围收敛成可重入的调度合同。

对应 AppSDK issue：`2cbc522`（本次目标指针刷新）。上一轮文档刷新 `8186534` 已关闭；上一轮治理 `c4387e4` 已关闭；U0 `159b78b` 已关闭；当前首个待调度单元是 runtime
`3742b9a`，随后按 canonical receipt 在 `L1-CLI/W1/C1/B1/U1/I1` 中取首个未完成项。
本计划不得创建第二个 goal、第二个 subscription 或第二套任务图。

## 当前接手状态（启动时必须复核）

- Desktop 主任务是本项目当前唯一的调度与资源管理 owner：负责拆分、依赖、worker 派单、独立
  review、integration、push、memory 和自有资源回收；不把调度权转交外部 master，也不把
  worker 的实现范围扩大到主任务。
- 根 `main` 的事实必须在每次唤醒时重新读取 `git status`、`git rev-parse`、`git ls-remote`。
  本次文档刷新观察到的输入基线是 `7e82b8a749409a19316ef5f389881848f9436b4b`；这个 SHA
  只是现场快照，不能替代下一轮启动时的现场检查。任何实现单元都必须从届时最新的
  `origin/main` 建立候选。
- U0 `159b78b` 的 exact review、集成、远端 push、L2 memory 和 cleanup 均已有 receipt；不得
  重复派单或复用旧候选。其唯一保留 advisory 已另建 issue `b17014`，不阻断 U1。
- 本轮文档候选从 `7e82b8a` 建立；此前 U0 worktree/branch 已回收，每次恢复仍须重读现场。
  L1-CLI issue `fdec042`
  的 worker 已停止写入并回报了明确的 runtime API 缺口：候选 worktree
  `playground/fdec042-l1-cli-20260913` 只保留未跟踪红测 `cli/agentteams.spec.ts`，没有 candidate
  commit；不得把它标记为完成或删除其红测。
- 根据该发现已建立独立 runtime delivery unit `3742b9a`，负责 detached launcher、持久 supervisor
  ownership/status/stop 和复用现有 configured Work 的显式调用；CLI 不得复制这些真相。当前可见
  的 `playground/3742b9a-runtime-rebind-r2-20260913` 仍 dirty，HEAD 与 `7e82b8a` 相同，尚无
  candidate commit；必须先确认唯一 owner 停止写入，再从最新 `origin/main` 形成 clean candidate，
  重跑 focused/full gate、完成独立 Codex review 后才可集成，不能把旧 `546e77f` 或 dirty tree
  当作当前 candidate，也不能重派同一 runtime unit。
- C1 issue `776fcad` 保留在独立 worktree `playground/776fcad-c1-20260913`、branch
  `codex/776fcad-c1-20260913` 上，当前 worktree 基线仍是旧的 `a71615a` 且有 dirty 修改。它只
  修改 `config/runtime-config.ts` 与 `config/runtime-config.spec.ts`，不得由本单元覆盖或删除；它只
  拥有 `config/**` 与 `opencode-adapter/**`，不得修改 runtime lifecycle；下一次恢复必须先从当前
  最新 `origin/main` rebase 或重建 worktree，再重新验证 candidate fingerprint，不能直接复用
  旧基线的测试、review 或集成证据。

### 当前资源与处理动作

| 资源 | 当前事实 | 调度动作 |
|---|---|---|
| `playground/3742b9a-runtime-rebind-r2-20260913` | dirty，HEAD=`7e82b8a`，无 candidate commit | 先确认 owner 停止写入并从最新 `origin/main` 形成 clean candidate，再跑 focused/full gate 与独立 Codex review |
| `playground/3742b9a-runtime-rebind-20260913` | clean，旧 candidate `546e77f`，基于旧 main | 只作历史参考；不得直接集成或 reset |
| `playground/3742b9a-runtime-20260913` | clean，旧 candidate `d040885` | 只作历史参考；不得直接集成或 reset |
| `playground/fdec042-l1-cli-20260913` | 仅保留未跟踪红测 `cli/`，无 candidate commit | runtime receipt 后从最新 main 重建；红测迁移前不删除 |
| `playground/776fcad-c1-20260913` | dirty，基线 `a71615a`，仅属 config/OpenCode | 由其 owner 从最新 main 重建后恢复；不得碰 runtime/network |

这些资源均不属于本次目标文档刷新单元；调度主任务只清理自己创建的 worktree。任何超过 24 小时未
活动的资源，先核对 owner、claim、证据和未提交内容，再决定保留、合并或丢弃。

## 当前交付指针

- **已关闭**：U0 Internal Config Compiler（`159b78b`）。
- **下一单元**：继续推进 runtime issue `3742b9a` 的 rebind candidate 验证，解除 L1-CLI 的跨进程生命周期/API
  blocker；C1 Config/OpenCode 只有在自身 worktree 从最新 main 重建后才可并行。runtime
  receipt 后重新绑定 L1-CLI；取得 L1 receipt 后才推进 W1，
  再推进 B1；不得用 CLI 自己实现第二套 supervisor 或 Work ledger。
  每项先查重/复用 AppSDK issue，再从最新 `origin/main` 建立
  `playground/<issue-or-task>-<date>` 的独立 clean worktree。
- **可并发**：runtime unit 与 C1 可并发；runtime receipt 后的 L1-CLI 与 C1 可并发；`W1` 在 L1
  receipt 后开始；`B1` 依赖 W1 接口稳定；`U1` Console
  必须等待 B1 receipt、projection contract 和 L3 review；`I1/L5` 最终串行收口。
- **资源基线**：本任务只回收自己启动的 worker、进程、端口、锁、临时目录、worktree 和
  branch；根 `main` 必须始终 clean。U0 的证据已转存到
  `docs/evidence/159b78b-internal-config-20260913/`，可供后续复核，不依赖已删除的 worktree。
- **N1/N2 边界**：`teams-development-plan.md` 中 relay-first 表的 N1/N2 是公网 Relay/NAT
  后续参考，不是本地 MVP 的前置，也没有被本计划伪装成已完成。Phase 1 使用 canonical
  `L1` 本地 launcher 与 `L2` 本地 bridge/daemon；I1/L5 只消费本地 L1-L4 receipts。

## 本轮 goal 编译（给 `/goal` 的唯一输入）

本轮只交付 Local Network MVP，不扩展公网 Relay、NAT/STUN、手机或关系治理。主任务的职责是
调度和资源管理：维护唯一 delivery 指针，查重 issue，按依赖为每个 unit 建立 clean worktree，
派发 gcm worker，审查 exact candidate，执行 integration/push，写 memory L2，并回收自己拥有的
worker、进程、端口、锁、worktree 和 branch。worker 只改合同范围，不得合并、推送或删除他人资源。

当前顺序为 `runtime-3742b9a → L1-CLI → W1 → B1`，`C1` 只有在从最新 main 重建后才可与 runtime/L1 在自身路径不重叠时并行，`U1` 等待 B1 与
projection review，`I1/L5` 最后串行收口。每个 unit 均执行红测、最小实现、适用 gate、真实入口、
独立 Codex exact review、candidate commit、clean integration、远端 push、memory L2、cleanup；
只从第一个失效 gate 重跑，稳定 fingerprint 的证据写 reuse receipt。

## 目标

把 AgentTeams 收口为一个用户可执行的本地网络 MVP：用户只维护
`~/.agentteams/config.toml`，运行 `agentteams init/start/status/work/stop`，多个独立
daemon 通过真实本地 socket bridge 完成注册、发现、能力/资源广播、匹配、连接、协商和一次
Agent Work；Console 只做观察与配置，关闭 Console 后 Agent-to-Agent Work 仍然可完成。

### 用户配置与 endpoint 边界

- `~/.agentteams/config.toml` 只保存用户意图：machine/endpoint 标识、endpoint role、要连接的
  target/service、provider 暴露的 capability/operation/resource、provider/model 绑定、凭据环境变量
  引用和用户选择的本地 bridge。它不保存 PID、generation、动态端口、resolved child JSON 或运行状态。
- `~/.agentteams/internal.toml` 是 runtime-owned 真源：resolved endpoint/bridge、child 启动投影、实际
  监听信息、PID、generation、config revision、online/stopped/failed、错误和恢复状态。child JSON 如有
  需要只能从它临时派生，不能反向覆盖 `config.toml`。
- 每个 endpoint 都同时表达“接收端”与“提供端”边界：接收端声明要连接的 endpoint/service/operation
  和业务需求；提供端声明 capability、operation 和 resource 容量。匹配、admission、分配和释放归
  provider Agent；Console 只读取 projection，不转发业务 payload。

## 当前基线与已知状态

- 基线主线：每个 delivery unit 都从当时最新的 `origin/main` 建立；本轮接手时观察到
  `origin/main=7e82b8a749409a19316ef5f389881848f9436b4b`，下一 unit 仍须重新读取远端。
- 已有 `288af52`：本地双 daemon、bridge、directory、capability/resource、一次 Work、
  `internal.toml` 生命周期状态和重启基础证据已合并；它不等于完整用户入口或完整 MVP。
- 已交付 U0 `159b78b`：将 `internal.toml` 变成 runtime-owned 的非用户配置真源；候选、review、
  集成、远端推送、memory 与 cleanup 证据位于
  `docs/evidence/159b78b-internal-config-20260913/`。
- 根 `main` 必须保持 clean；任何实现只能在 `playground/<issue-or-task>` 独立 worktree。

## 交付顺序与并发边界

每一项都是独立 delivery unit，绑定一个 issue、一个 owner、一个 branch/worktree、一个基线
commit、唯一写入范围和精确验收命令。实现 worker 与 reviewer 必须不同；主任务负责调度、依赖、
冲突、集成、推送、记忆和资源回收。

1. **U0 Internal Config Compiler（已关闭：`159b78b`）**
   - `config.toml` 只保留用户意图。
   - `internal.toml` 原子保存 resolved endpoint/Relay、child 启动投影、端口/证书/凭据引用、
     PID、generation、revision、state、错误和恢复信息。
   - child JSON 若仍需要，只能从 `internal.toml` 派生，不能反向成为第二真源。
   - 已完成受影响 architecture-map 绑定、迁移、原子写入、重启和错误路径测试；后续不得把
     U0 的证据当作 U1 或完整 MVP 的证据。

2. **L1-CLI 用户入口**（U0 exact review/integration PASS 后）
   - 提供 `init/start/status/work/stop` 稳定入口。
   - 用户不调用 `generated/runtime-lib`，不手写 child JSON、Relay JSON、PID、动态端口或证书路径。
   - CLI 只调用已绑定的 runtime owner，不复制配置或网络台账。
   - 入口与 packaging 必须由本单元拥有；测试必须在 disposable home 中真实调用五个命令，并覆盖
     stop/start 后的 status/generation 变化。runtime API 缺失时另建 runtime unit，不在 CLI 单元越界修复。

3. **W1/C1 Provider/Receiver 与 OpenCode 产品检查点**（两个 canonical delivery unit）
   - **W1 Agent Work owner**：`agent/**`；必要的 `agent-host/**` 或
     `runtime/agent-process.ts` 变更必须另建对应 owner 的 delivery unit，不能由 W1 越界代改。
     W1 在 L1 配置入口 receipt 后开始。
   - provider 是可被动提供 capability/resource 的 Agent；receiver 声明连接意图并请求 Work。
   - provider 负责 admission、容量分配和释放；重复 request、超卖、取消和旧 generation 必须显式处理。
   - **C1 Config/OpenCode owner**：`config/**`、`opencode-adapter/**`；不得写 `agent/**`、
     `network/**` 或 UI 台账。
     C1 在公共 config contract 稳定后即可开始，可与 W1 并行。
   - 支持多个 provider instance；RCC `127.0.0.1:4444` 为主 provider，`goaichat-openai` 为显式
     backup provider。backup 不等于隐式 failover；catalog/apply/readback 必须走真实 OpenCode 入口。

   - **B1 固定能力 CLI**：`cli-adapter/**`；依赖 W1 接口稳定，提供 file-search/browser 等固定
     operation/argv/schema，不执行任意远端 shell。

4. **U1 Console daemon discovery**（B1 receipt、projection contract 和 L3 review PASS 后）
   - UI 只读取权威 directory projection：identity、presence、generation、capability、resource。
   - UI 不拥有 runtime/network 台账，不经 Console 转发 Agent-to-Agent payload。
   - 依赖 B1 receipt、L2 projection contract 和 L3 review PASS；UI polish、关系图和移动布局不阻断本地 MVP。

5. **I1/L5 本地真实回放与重启隔离**（U1/L4 review PASS 后的串行收口）
   - 在干净临时 home 中从用户配置启动两个独立 daemon 和 bridge。
   - 真实 socket 完成 register、directory、broadcast、connect、negotiate、Work proposal/request/
     result/close；Console 关闭时仍成功。
   - stop/start 后 `generation` 增长，旧 generation 被拒绝，新 generation 可重新完成 Work；
     resource allocation、幂等和释放均留证。

U0 已通过，不再阻断后续阶段。L1-CLI 先产生配置入口 receipt；C1 在自身公共 config contract 稳定后可并行；
W1 只在 L1 receipt 后开始；
B1 依赖 W1 接口稳定；U1 只有在 B1 receipt、L2 projection contract 和 L3 review PASS 后收口；I1/L5 是等
U1/L4 review PASS 后的串行集成点。任何跨 owner 的语义冲突退回原 owner，主任务只在独立 integration worktree 解决
机械冲突和装配，不新增兼容层。

这些标签直接复用 canonical delivery-unit：U0 对应 `G0/L1`，W1 对应 `L2`，C1 对应 `L3`，
B1 是 W1 之后的固定能力 CLI，U1 对应 `L4`，I1 对应 `L5`；`L1-CLI` 是 L1 阶段的用户
入口 delivery slice。阶段 gate、owner 和关闭条件仍以
canonical 文档为准。

### Owner、路径和首个 gate

| unit | 唯一 owner | 允许写入 | 禁止写入 | 首个 focused gate |
| --- | --- | --- | --- | --- |
| U0 | runtime | `runtime/local-config.ts`、`runtime/local-supervisor.ts`、`runtime/local-process.ts`、必要的 `runtime/agent-process.ts` projection、对应 specs、`docs/evidence/159b78b-*/`；architecture-map 变更只作为候选绑定提交给集成 owner | `network/**`、`server/**`、`agent/**` 语义、`config/**`、`docs/architecture/**` 公共真源、UI、package/lock | `pnpm exec vitest run runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-two-agent.spec.ts` |
| 3742b9a | runtime local-launcher owner | `runtime/local-config.ts`、`runtime/local-process.ts`、`runtime/local-supervisor.ts`、必要的 `runtime/agent-process.ts` projection、对应 specs/evidence | `network/**`、`agent/**` 语义、`config/**` 真源、UI、CLI dispatch、package/lock | `pnpm exec vitest run runtime/local-process.spec.ts runtime/local-supervisor.spec.ts runtime/local-two-agent.spec.ts`；必须证明跨进程 status/stop 与 configured Work 复用 |
| L1-CLI | CLI owner | `cli/agentteams.mjs`、`cli/agentteams.spec.ts`、root `package.json` 的 `bin` 绑定、对应 evidence | `runtime/**`、`network/**`、`agent/**`、`config/**` 真源、UI、`cli-adapter/**` capability implementation、generated output | `pnpm exec vitest run cli/agentteams.spec.ts runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-process.spec.ts`；其中 CLI spec 必须真实执行 `init/start/status/work/stop`；runtime API 缺失时另建或复用 runtime unit |
| B1 | cli-adapter | `cli-adapter/**` 及对应 CLI evidence；需要 runtime API 时另建 runtime unit | `runtime/**`、`agent/**`、`network/**`、`config/**`、UI | `pnpm exec vitest run cli-adapter/cli.spec.ts cli-adapter/fixed-process.spec.ts` |
| W1 | agent | `agent/**` 及对应 Work/resource specs；跨 `agent-host/**` 或 `runtime/**` 需另建 unit | `network/**`、`config/**`、`opencode-adapter/**`、UI | `pnpm exec vitest run agent/**/*.spec.ts runtime/agent-work-client.spec.ts` |
| C1 | config + opencode-adapter | `config/**`、`opencode-adapter/**` 及对应 specs/evidence | `agent/**`、`network/**`、UI；不把 RCC/goaichat 结果写进业务 payload | `pnpm exec vitest run runtime/managed-config-owner.spec.ts runtime/managed-config-live.spec.ts runtime/managed-opencode-session.spec.ts` |
| U1 | ui + console-host projection owner | `ui/teams-console/**`、限定的 `console-host/src/**` directory-projection adapter、对应 `console-host/tests/**` 与 evidence | `runtime/**` 台账、`network/**` 真相、Agent Work payload、provider ledger、非 projection 的 console-host server/auth 行为 | B1 receipt + projection contract + L3 review PASS；`pnpm exec vitest run runtime/console-hub.spec.ts runtime/console-runtime.spec.ts control-protocol/console-wire.spec.ts console-host/tests/http-api.spec.ts ui/teams-console/tests/api.spec.ts ui/teams-console/tests/model.spec.ts` |
| I1/L5 | 主任务 integration owner | 独立 integration worktree、受影响 integration specs、`docs/architecture/**` 公共 maps、`docs/evidence/<unit>/`；语义修复退回原 owner | 直接覆盖 worker 语义、dirty main、他人 worktree/branch | `pnpm exec vitest run runtime/local-relay-bridge.spec.ts runtime/local-two-agent.spec.ts`，随后编译候选真实回放 |

表中的命令是首个 focused gate；每个 unit 仍须按受影响 map 补齐 regression、typecheck/build、
AppSDK compile/verify、真实入口和 exact review。当前只允许 L1-CLI 与 C1 在各自路径不重叠时并行；W1
必须等 L1-CLI receipt，B1 必须等 W1 接口 receipt，U1 与 I1/L5 继续受其余前置 receipt 传递约束，不能由一
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
  当前只可派首个满足依赖的 L1-CLI/C1；没有 L1 receipt 时不得派 W1，没有 W1 receipt 时不得派 B1；
  没有 B1 receipt 时不得派 U1；U1 Console 与 I1/L5 等前置 receipt 不齐时不得提前共享写入。
  公网 relay-first N1/N2 不在本轮调度。
- **Gate**：focused 红绿测试 → mapped regression → typecheck/build → AppSDK compile/verify（仅在
  maps/治理受影响时）→ 真实入口回放 → 独立 exact review。
- **State**：写 candidate/review/integration/push/memory/cleanup receipts；状态只能是
  `pending/running/passed/reused/invalidated/blocked/awaiting-integration/cleanup-pending`。
- **Stop**：仅当远端 main SHA、当前候选的适用验证、L2 memory 和自有资源清理齐备时关闭 unit；
  所有 MVP unit 完成后才关闭长期目标。

每轮顺序固定为：`Discover → Hand off → Verify → Persist → Schedule`。等待使用有界等待；worker
未终态前不重复派发同一 unit，不因 gcm warning 重启或宣称完成。

## 当前调度快照（2026-09-13）

| unit | issue | 当前状态 | 下一动作 |
| --- | --- | --- | --- |
| U0 internal config compiler | `159b78b` | closed；receipt 可复用 | 不重开、不重复派发 |
| runtime local launcher | `3742b9a` | r2 worktree dirty，HEAD=`7e82b8a`，无 candidate commit；旧 `546e77f` 基于旧 main | 先形成最新 `origin/main` 上的 clean candidate，再重跑 focused/full gate → Codex review → candidate receipt → integration/push |
| L1 CLI | `fdec042` | awaiting-runtime-unit；仅有红测，无 candidate | runtime receipt 后 rebase 到最新 main，再实现 `init/start/status/work/stop` |
| C1 provider/OpenCode | `776fcad` | retained；旧基线 dirty worktree | 先从最新 `origin/main` rebase/重建，再继续 config/opencode focused gate；不碰 runtime/network |
| W1/B1/U1/I1-L5 | canonical downstream | pending | 按依赖顺序启动，禁止提前共享写入 |

本次文档刷新 worktree 是 `playground/2cbc522-goal-refresh-20260913`，只拥有
`docs/goals/**` 与本单元 evidence；runtime、L1 红测和 C1 worktree 属于各自 delivery unit，
不删除、不覆盖。任何 worker 结束后先确认停止写入、证据已转存和远端候选责任，再回收其自有进程、
端口、锁、worktree 与 branch；根 `main` 始终保持 clean。

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

可直接复制的唯一 `/goal` 输入已独立落盘于
[teams-local-mvp-goal-prompt.md](teams-local-mvp-goal-prompt.md)。本计划只维护执行指针，避免在
计划正文复制第二份提示词。
