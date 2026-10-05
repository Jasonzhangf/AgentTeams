# AgentTeams 本地 MVP：Agent 接手文档

状态核对：2026-10-05T10:29:37Z。交接范围是当前 Desktop 的独立开发目标。
原编排者停止新派单和产品集成；已启动的 c520894 worker 只继续其原合同。
新 Agent 通过用户提供的接手提示词成为本目标编排者。本文准备交接，不代表接收方已经接收。

## 1. 目标与完成条件

交付普通用户可用的本地 AgentTeams MVP：从源码树外安装一个包，只编辑当前
HOME 下的 `~/.agentteams/config.toml`，启动本地 socket bridge 和两个独立 daemon。
Provider 声明实际服务与资源；receiver 配置连接谁、使用什么服务。双方注册、广播、
发现、匹配、协商、连接并执行新的 Work。被动能力 Agent 无需模型。

`internal.toml` 保存系统需要、用户无需编辑的内部配置。用户意图不能另存为第二份
editable JSON。OpenCode 是执行基座；Teams 拥有 provider/model 配置与 UI。
Console 是可选观察与配置面。关闭 Console 后，新的 Agent Work 仍成功。

完整完成 iff：设计准入、安装后真实 DAGpipe Work、其余行为图覆盖分类、U1–U7、
最终同一安装包的 BB01–BB14、独立 milestone PASS、远端 main 回执、适用阶段记忆
和自有资源回收全部齐备，main clean。现在 **MVP INCOMPLETE**。

本阶段不增加公网/NAT/STUN、手机、coder2new、关系治理、自动 provider failover
或生产部署。不能用 SDK demo、静态图、health 或源码测试替代安装后的业务入口。

## 2. 必读与状态优先级

先读取以下已有文件；不新建第二套治理框架：

- [项目契约](../../AGENTS.md)。
- [开发命令、gate 适用性与证据复用](../development-governance.md)。
- [用户交付计划与 BB01–BB14](teams-user-delivery-plan.md)。
- [长期交付契约](teams-long-running-delivery.md)。
- [行为模型](../design/teams-behavior-model.md)与[行为契约](../design/teams-behavior-contracts.md)。
- [现有项目图](../design/dagpipe/graphs/)与[原行为审计](../design/teams-behavior-audit-20261002.md)。
- [resource](../architecture/resource-map.json)、[function](../architecture/function-map.json)、
  [mainline](../architecture/mainline-call-map.json)、[module](../architecture/module-registry.json)、
  [verification](../architecture/verification-map.json) 五个 owner map。

本机可恢复证据入口：

```sh
evidence_root="$HOME/.codex/task-evidence/agentteams"
cat "$evidence_root/local-mvp-active-20261003.md"
jq '.currentContinuation20261005' "$evidence_root/current-snapshot-20261003.json"
```

实时命令和实际 receipt 优先；本文是最新交接快照。计划表与笔记保留历史状态，
不能把其中的旧 `working`、旧 PID 或已删除路径当作当前状态。
snapshot 的 `currentContinuation20261005` 优先于旧字段，但其 `at`、`next` 和部分
review/worktree 字段也有历史值。发生冲突时读对应原始 receipt，并刷新受影响状态。

按需读取当前 `$HOME/.agents/skills/` 中的 `codex-orchestrator`（及 worker-contract）、
`coding-principals`、`dagpipe-runtime`、`appsdk-project-governance`、`codex-review`、
`mcpx-commit`、`project-memory`。没有名为 Luna 的实际执行者时，不宣称自己是 Luna。
不核究 GCM 的路由模型；以合同和结果验收。

## 3. 已交付事实与未交付边界

本次核对 root/main clean；本地 main、origin/main 与远端 main 都是
`7739da440b52c7335a6662e32c0bccb29b6acb7d`。

U1 final SDK package slice 已交付至该 SHA：

- Tree：`650b2b64c32b21a6421e0cd8adbdbe896f15f765`。
- 独立 review：`746dd7b-manifest-review-fix-20261005-r3`，controller completed/pass/exit0。
- 实际提交上的 admission：583 PASS、0 FAIL/skip/TODO，真实 Chrome DOM 开启。
- Artifact：`sha256:801d6df5412de338d7ce502bab39dbfaf6d5abe46c890790b4f1cdeb60319325`。
- 安装副本 CLI/Console、Relay 与两 Agent start/restart、真实 SDK rg consumer、编译负例
  与六种 graph/manifest 篡改拒绝有证据；candidate/integration tree 和分支已正常回收。
- 完整 receipt：`$evidence_root/receipts/u1-manifest-review-fix-20261005/delivery-cleanup-receipt.json`。

Issue `746dd7b` 仍 open。此交付不是完整用户包或完整 MVP。**当前 main 的公开
`agentteams work` 仍显式报未实现**；公开用户 Work 只在 U4 未交付候选中。

其他已交付基础包含 U2 v3 配置、真实服务/SDK 组件、host Work policy、源码阶段 L2、
粗粒度重入组件及前序 fixture 修复。用对应 receipt 复用；不重新派修已关闭问题。
近期关键来源：

| 事实 | 来源 |
|---|---|
| host Work policy `c38ba70` 已交付 | `receipts/c38ba70-work-request-policy-20261005/solution-receipt.json` |
| 前序 fixture `01e3223` 已交付且关闭 | `receipts/01e3223-current-main-20261005/solution-receipt.json` |
| capture reader `76ccd32` 已交付且关闭 | `receipts/76ccd32-reader-minimal-20261005/solution-receipt.json` |
| 治理文档消融 `53c6831`，净减少 212 行 | `receipts/governance-ablation-20261005/delivery-cleanup-receipt.json` |
| U5 只读审计未完成，自有审计资源已收尾 | `receipts/u5-console-entry-audit-20261005/cleanup-receipt.json` |

表中路径均相对于 `$evidence_root`。组件、配置、基础安装和局部记忆不关闭最终用户验收。

## 4. 保留 worktree 与写入归属

仓库：`/Volumes/extension/code/AgentTeams`。下表都是待交接的本目标资源。
未审候选不能因磁盘压力直接删除。先确认写入停止，再归档并组合或明确 drop。

| Worktree（位于 `/Volumes/Intel/playground/agentteams/`） | HEAD / branch | 最新状态与 owner |
|---|---|---|
| `c520894-stop-writer-20261005` | `7739da4` / `codex/c520894-stop-writer-20261005` | 唯一 live GCM author；已修改 stop owner 和测试，未完成真实公共回放 |
| `validation-residual-ablation-20261005` | `7739da4` / `codex/validation-residual-ablation-20261005` | 冻结 staged 9 路径；author 已退出；新编排者负责补证据与交付 |
| `public-work-receiver-fix-20261005` | `53c683183a0c61609d3aa9f053ff8147d700fd26` / `codex/public-work-receiver-fix-20261005` | retained dirty U4；无 live author；含 staged 与 unstaged 差异，两者都要保留 |
| `u6-session-design-20261003` | `b969e9740704977326c5054fb3afbeab8d523e36` / `codex/u6-session-design-20261003` | staged 三份设计/证据；没有独立设计 PASS |

交接文档自身使用 `agent-handoff-20261005` 临时 worktree；提交推送后由原编排者回收，
不是产品候选。其最后 SHA 和清理回执在 `receipts/agent-handoff-20261005/`。

## 5. 首先消费 c520894，禁止重复派单

Issue `c520894`：two-daemon blackbox 在 stop 后立即回收 root 时，`.agentteams/.internal`
仍被写入 `daemon-status.json`，造成 ENOTEMPTY。原全量真实失败是 576 total、575 PASS、
1 FAIL、0 pending。前序 `01e3223` 是另一类 PID fixture 问题，不应 reopen 混入。

截至本次核对：worker launcher PID `19951`、实际 Codex PID `20021`，exec session `44324`。
PID 和 session 只作历史定位；新 Agent 必须核对命令、cwd、进程身份及终态。
记录目录：

```text
/Volumes/Intel/playground/agentteams/.worker-runs/c520894-stop-writer-20261005/gcm-1/
  worker-task.md   # 已授权完整合同与精确验收
  notes.md         # 节点状态，恢复先读
  worker.jsonl     # 原始执行输出，检查 turn.completed/failed
  worker.stderr
  evidence/        # 红绿命令、日志与 exit
  codex-home/      # 仅此 worker 的隔离 HOME
```

已见局部事实：supervisor 先发布 terminal launcher state、后写最终 projection；
public stop 只等待 terminal state，未等待 launcher 的实际退出。worker 增加 projection
写失败的红绿用例，local-supervisor 7/7 PASS。**这仍不是完整根因交付**：sandbox 下
真实 relay listen EPERM，`/bin/ps` ownership 检查也被拒绝。需在宿主可执行环境补
真实 start/status/restart/stop 与立即 root 回收，确认全部自有 writer/进程结束。

worker 独占允许路径：`runtime/local-process.ts`、`runtime/local-supervisor.ts`、对应
两份 spec、`runtime/local-two-agent.spec.ts`，仅 stop completion/publication。map 改动由
编排者收口；不改 Work/config/provider/package/gate/UI。禁止 sleep、删除重试、timeout
扩大、skip、吞错或 PID 猜测。合同已将 review/commit/integration/push 留给编排者。

接手时读 notes/JSONL，确认是否仍写入。仍 active 就等待其原任务结果，不启动同 scope
worker。原会话 session 不可跨线程恢复时，用原始输出、exit 文件和实际进程证据消费。
进程失联先保留成果和日志，确认停止后，才给新 GCM worker 派精确剩余范围。

作者/宿主必须补齐以下合同命令及公共行为后，再独立 review：

```sh
pnpm build:runtime
TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run runtime/local-process.spec.ts runtime/local-supervisor.spec.ts runtime/local-two-agent.spec.ts --reporter=json
pnpm exec tsc -p tsconfig.runtime.json --noEmit
dagpipe graph validate docs/design/dagpipe/graphs/daemon-stop.graph.json
```

命令在该候选 worktree 运行，输出绑定当前候选；预期 exit0、无 skip，保留 stale generation、
foreign PID、失败与 timeout 行为。按照原合同使用实际 CLI/public consumer 验证资源终点。
首次 full failure 的状态快照在消融 receipt 目录的 `c520894-surviving-status.json`。

## 6. 依赖顺序与每项剩余工作

### A. c520894 独立交付 → 40d320f 消融

先完成 c520894 的作者验证、真实公共回放、exact 独立 review、独立 commit/main push
与自有 cleanup。再组合消融候选与最新 main，不把两项混为一个 delivery unit。

`40d320f` 冻结 tree `90c07c4c92a8e23524b42ca9b066816c3f965ac3`，9 路径、
31 insertions/135 deletions，净减少 104 行：物理移除 DSH source/spec、separator spec、
对应 Vitest/AppSDK 引用；移除 export/class 子串“纯函数”、旧 UI 文案和 renderDrawer
数量断言；保留跨 owner import、凭据、控制/payload、action 与可访问性边界。
保留 `minimum_test_count=304`，没有降阈值或 skip。

证据：`receipts/40d320f-validation-residual-ablation-20261005/` 的 `author-final-report.md`、
`author-validation.json`、`current-regression.json`、`package-focused.json`、
`recovered-regression.log`，以及候选中 29 行 `docs/evidence/40d320f-validation-residual-ablation-20261005/notes.md`。
Author affected 68/68、typecheck/graph PASS；package focused 24/24。组合 full 是
575 PASS/1 cleanup FAIL；**不能拼接多份局部结果宣称 full PASS**。状态为
candidate/awaiting-baseline-repair，未 review/commit/merge/push。

消融 author 已退出；660MB 临时 store/browser、worker HOME 与旧 run 目录已归档回收。
不要恢复旧 author。SDK-owned `.appsdk/maps/module-registry.json` 的 `dsh-adapter/**`
残留归属 glob 需通过官方 SDK map 刷新收口，不手写第二份 map 或修改历史记录。
完成该候选受影响 gate 与独立 review 后独立交付；不为消融增加摘要框架。

### B. U4 / issue 4b6c377：安装后的公开 Work

组合 retained U4 完整 diff（含 staged/unstaged）与最新 main；U1 SDK package 依赖已交付。
已有 source 90 affected PASS、macOS 默认 TMPDIR 24 PASS、typecheck0。配置 v3 漏掉
`.connection` 导致 RECEIVER_NOT_FOUND 已修；失败 receipt 已改完整 stderr/exit1。
这些只证明旧候选的 source 层，不证明新组合版本或 installed Work。

证据：`receipts/public-work-receiver-fix-20261005/`。范围按计划 U4，重点
`cli/agentteams.mjs`、`runtime/agent-process.ts`、`runtime/local-process.ts` 与 config 接缝、
测试、受影响 maps。该范围和 c520894/U5/U6 重叠，产品写入必须串行。

必须从实际安装副本走 submit/query/open/request/close，连续两次新请求返回不同真实
业务结果；get-only 查询不重复执行；Console 不启动/关闭后新 Work 成功；restart、
generation、stale 拒绝有证据。DAGpipe Operators → compile → immutable CompiledGraph
→ Runtime → 用户消费结果必须贯穿安装后入口。以当前 CLI spec 确认参数，不猜命令。
真实 rg 位于 `/opt/homebrew/bin/rg` 的前序核对不能替代 live 检查；用户 TOML 明确配置
当时验证的 binary，不给 `/usr/bin/rg` 加 silent fallback。

### C. U5 / U6 / U7 与最终收口

- U5：实现同包 Console start/status/stop、TOML 配置、真实 UI 发现两个 daemon、
  授权/拒绝及观察配置入口。已有设计与部分 UI 不等于已安装完整生命周期。
- U6：先消费 retained 三份设计/证据。五次 review 都 FAIL；第五次修订后也没有 PASS。
  不用换 task/backend 绕过原 controller 限制。按官方 review 的恢复动作处理；若需设计
  裁决，说明具体阻断和拟修订，不堵住 U4/U5。准入后再实现真实 OpenCode message、
  tool、permission approve/reject、cancel 和 restart；passive Agent 显式不支持 Session。
- U7 / `3fd009a`：已有 stage store 和成功阶段持久化；整个 `pnpm verify` 仍作为一阶段。
  拆到实际命令边界，使内部后继失败后的恢复跳过有效前置节点。复用现有 store，
  不建第二套 PASS cache。图/源码/配置/SDK/产物/环境变化只使适用节点和后继失效。
- 最终：依照用户计划的原 BB01–BB14，从最终同一安装包执行；包含真实 browser、
  provider/OpenCode、Console-offline、restart/stale、失败与资源终点。完成独立 milestone、
  适用 L2、main push 回执和 owned cleanup 后，才关闭相关 issue 与长期目标。

可以并行的准备工作：U7 的 scripts/lifecycle-adapter 独占改造，U6 设计裁决，以及 U5
UI 独占范围。先由编排者读实际依赖并给出精确合同。共享 runtime、config、package
或 map 同一范围禁止并发写；集成一次一个 unit。

## 7. 编排、验证、提交与回收操作

新编排者负责架构、依赖、scope、派单、证据审核、独立 review、集成、push、进度和资源。
实现交给有边界的全新 `codex exec --profile gcm` worker。每个 worker 使用独立 CODEX_HOME，
合同存仓库外，按当前 skill 提供 allowed/forbidden、done iff、精确命令和 evidence 路径。
不 resume/fork，不使用父 transcript，不用内置 spawn，不注册 Collab 或寻找外部 TUI Master。

先刷新实时状态并读上述节点笔记：

```sh
git -C /Volumes/extension/code/AgentTeams status --short
git -C /Volumes/extension/code/AgentTeams worktree list --porcelain
git -C /Volumes/extension/code/AgentTeams fetch origin main
git -C /Volumes/extension/code/AgentTeams rev-parse HEAD origin/main
git -C /Volumes/extension/code/AgentTeams ls-remote origin refs/heads/main
appsdk bug list --status open
```

对新问题先 `appsdk bug list -q <具体问题>` 查重；复用已有 issue。项目与 bug 命令在可信
repo 执行；不另建重复 goal、任务或 bug。当前没有本目标 subscription，不需要订阅恢复。
原 native goal 在旧线程仍 active；交接文件不能跨线程迁移它，也不能把未完成目标标 complete。
接收方管理自己的 harness goal；原会话不再推进产品工作。

新实现从最新 origin/main 建独立 clean worktree，路径仅在
`/Volumes/Intel/playground/agentteams/<unit>`；main 不开发。retained dirty 候选先审、保全
完整 diff 和证据；在新的 clean candidate 组合，确认等价后才正常回收旧资源。
依赖已安装且输入有效时不重装；新树用根 lockfile，不复制 store。

作者验证先 focused、真实公开黑盒，再适用 type/build/AppSDK。涉及契约、map、包或
全量约束变化时按 governance 跑 `pnpm verify`；实际交付准入用 `pnpm lifecycle:admission`。
恢复先读 stage notes，只补失效阶段。保存原失败，不以成功重跑覆盖原失败。
全量 DOM 用例须有真实 Chrome；现有 CHROME_BIN hook 可选真实 Chromium，不能 mock。

代码只在作者验证完整后启动独立架构 review：普通官方 Codex Review `profile:gcm`；
milestone `profile:oauth, model:gpt-6.1-sol`。不用 AGY，Astra 不做 reviewer。
review 绑定当前 candidate/base/tree/changed paths/实际证据；返回 controller PASS 才集成。
若候选变化，重跑受影响证据并重新 review。

提交前按 mcpx-commit 查询能力和 workspace。本次查询有 MCPX 能力，但没有 AgentTeams
注册 workspace；本次单文件文档使用项目 CLI/Git，不将 CLI 输出伪称 MCPX 证据。
不绕 hook；文档交接只需针对性检查，不触发产品全量验收。

每项常规交付已授权：exact 候选 commit → 最新 main 组合与适用验证/review → clean main
集成 → `git push origin main` → `git ls-remote origin refs/heads/main` 远端核对。
冲突、push 拒绝或 CI 失败保留证据并停受影响集成，不强推、不覆盖其他成果。

资源只回收本目标确认归属且已无用途的内容。先确认 worker 停写、进程/listener 结束、
证据归档和候选已远端合入或明确保留责任；再正常 `git worktree remove <owned-path>`、
`git branch -d <owned-branch>`。dirty remove 失败不能强删。核对 worktree list 不含该路径、
`test ! -e <owned-path>` 成功，并写 cleanup receipt。只用精确 PID 或项目服务动作，
禁止广泛 kill 和清除共享缓存/其他项目资源。

每个节点完成/失败/阻塞立即在独占 notes 写时间、结论、证据、输入版本、下一步。
阶段记忆仅编排者用官方 AppSDK memory/project-memory 命令查询去重、review 和晋升；
已复核事实标 `ai-reviewed,human-unreviewed`。worker 只交 notes/candidate，不自行写记忆。
缺 live、review、push、cleanup 中任一适用项，保持 candidate/awaiting-integration/
cleanup-pending，不报完整交付。没有接收方执行回执前，只能称“交接材料就绪”。
