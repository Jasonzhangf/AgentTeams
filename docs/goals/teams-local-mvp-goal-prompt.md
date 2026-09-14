# AgentTeams Local Network MVP `/goal` 提示词

这是唯一可复制到 `/goal` 的执行提示词。详细阶段、owner、路径和 gate 以
[teams-local-mvp-execution-plan.md](teams-local-mvp-execution-plan.md) 为准；本文件不创建新的
goal、subscription 或 task graph。

```text
/goal
目标：把 AgentTeams 收口为可供用户实际运行的 Local Network MVP。用户只维护
~/.agentteams/config.toml，执行 agentteams init/start/status/work/stop；runtime 负责生成和维护
~/.agentteams/internal.toml。至少两个独立 daemon 必须经真实本地 socket bridge 完成注册、发现、
capability/resource 广播、匹配、连接、协商和一次 Agent Work；Console 只做观察与配置，关闭
Console 后 Agent-to-Agent Work 仍然成功。

依据：
- docs/goals/teams-local-mvp-execution-plan.md
- docs/goals/teams-user-mvp-delivery.md
- docs/goals/teams-long-running-delivery.md
- docs/goals/teams-development-plan.md

调度角色：当前 Desktop 主任务负责目标编译、依赖排序、issue 查重、gcm worker 派单、范围冲突、
独立 Codex review、integration、push、memory L2 和资源回收。不要依赖或冒充其他 scope 的
master。worker 只修改自己的 delivery unit，不合并、推送或删除他人资源；主任务不把产品实现
偷偷移入调度文档。不使用 AGY Review；milestone 才使用 Astra。
默认实现 worker 入口是 `codex exec --profile gcm`；每个 worker 必须有独立 clean worktree、
唯一 branch、唯一写入范围和精确验收命令。每次唤醒先检查目标/issue、root 与远端、worker、
worktree、进程/端口和最新 receipt；只从第一个失效 gate 及其下游重跑，稳定 fingerprint 的
PASS 写 reuse receipt。使用有界等待，不忙轮询；没有安全独立任务时记录等待原因。

当前接手指针（2026-09-13，必须启动时复核）：
- 上次文档刷新现场读取到的 root `main` 与 `origin/main` 均为
  `3793b83a9a3609979d82dfadb8e086922804e828`，root clean；这是历史快照，只用于解释当时的
  worktree 状态，绝不是当前或后续 delivery unit 的固定基线。每次唤醒必须重新读取 `git status`、`git rev-parse`、
  `git ls-remote origin refs/heads/main`，新 unit 从届时最新远端主线建 clean worktree。
- 当前唯一长期目标 issue 是已存在且仍 open 的 `af5c167`；本次 re-entry 记录为 AppSDK comment
  `a4f55dc`，与旧的 `docs/evidence/af5c167-mvp-closeout-20260910/` delivery 分开。不得为同一
  MVP 创建第二个 goal、subscription、task graph 或重复 issue。U0 internal.toml 真源 issue
  `159b78b` 已关闭，只复用其 receipts，不重开、不重复实现。
- runtime issue `3742b9a` 的工作树是
  `playground/3742b9a-runtime-r5-20260913`，base=`ce91c14`，仍 dirty，且相对上述历史快照已落后；
  尚无 candidate commit。它只保留为只读审计/证据源；不得继续在此树写入，必须从届时最新
  `origin/main` 建立新的 clean runtime worktree 并通过 admission。上一次
  focused run 仍有 configured Work restart 的 `START_TIMEOUT`，因此不得进入 review、integration
  或 CLI 派发。`local-two-agent`
  socket replay、full `pnpm verify`、exact review、push、memory、cleanup 均未对 r5 candidate
  成立。
- C1 issue `776fcad` 的工作树是
  `playground/776fcad-c1-r3-20260913`，base=`ce91c14`，相对上述历史快照已落后，只允许写
  `config/**` 与
  `opencode-adapter/**`。只有在重新核对当前 `origin/main`、clean 状态、owner、changed-path
  fingerprint 和 admission 通过后，才可与 runtime 并行；否则只调度 runtime。C1 必须独立完成
  focused gate、evidence、Codex review、integration、push、memory 和 cleanup。旧 r2 worktree 只作
  审计对象，不得直接集成。
- L1 issue `fdec042` 的旧 worktree `playground/fdec042-l1-cli-20260913` 仅保留红测且落后主线；
  runtime receipt 前不得使用。runtime 合并到远端后，必须从最新 `origin/main` 重建新的 L1
  worktree，再实现 `init/start/status/work/stop`，CLI 不得复制 supervisor 或 Work ledger。
- 依赖顺序保持：`3742b9a → fdec042 → W1 Agent Work → B1 fixed capability CLI → U1 Console
  projection → I1/L5 local replay`；C1 仅在自身路径内并行，U1 等 B1 和 projection contract，
  I1/L5 串行收口。

资源接手规则：旧 runtime r3/r4/rebind、C1 r2、L1 红测和所有超过 24 小时未活动的 playground
都先审计 owner、dirty 内容、唯一证据、进程、端口和 issue/review 义务；没有明确安全结论不得
删除或 reset。只回收本主任务/本 delivery unit 自己拥有的资源；残留 daemon/relay 只能按已核对
的显式 PID 或服务操作停止。每次资源处理写 cleanup receipt，root `main` 永远不作为开发树。

每个 delivery unit 必须独立完成：查重或复用 AppSDK issue → 从最新 origin/main 建立
playground/<issue>-<date> clean worktree 和唯一 branch → 最小红测 → 最小根因实现 → focused/
regression/typecheck/build/适用 AppSDK gate → 真实入口验证 → 独立 Codex exact review → candidate
commit → clean integration worktree → mainline verification → git push origin main 与
git ls-remote receipt → project-memory Level 2（ai-reviewed,human-unreviewed）→ 停止自有进程并
写 cleanup receipt → 才能关闭 issue。milestone review 使用 Astra；不使用 AGY Review。

重入规则：每次唤醒先读取本文件、execution plan、issue、worktree、branch、进程、端口和远端
main。用 candidate tree/commit、changed paths、依赖、环境和产物组成 fingerprint；只从首个失效
gate 及其下游重跑，稳定且仍有效的 PASS 写 reuse receipt。没有 receipt 或 identity 漂移时不得复用
旧证据。使用有界等待，不忙轮询，不因 worker 空闲创建无依赖任务。

资源规则：只回收本主任务或本 delivery unit 自己拥有的 worker、进程、端口、锁、临时目录、
worktree 和 branch。超过 24 小时未活动的 playground 先检查 owner、claim、未提交内容、唯一证据、
进程和 bug/review 义务，再决定合并、保留或丢弃；不得批量删除其他 unit、dirty tree 或唯一证据。
当前保留的 runtime、L1、C1 worktree 不属于本次文档刷新单元，不能删除或 reset。根 main 永远不得
作为开发工作树。

MVP 完成 iff：用户路径可在 disposable HOME 中真实执行；两个 daemon 的 socket replay 包含
discovery/broadcast/connect/negotiate/proposal/request/result/close；status 展示 endpoint、role、
generation、capability、resource；stop/start 后 generation 增长、旧 generation 被拒绝、新
generation 可重新 Work；provider 不能超卖且重复 request 不重复执行；RCC 127.0.0.1:4444 是显式
primary，goaichat-openai 是显式 backup，catalog/apply/readback 失败必须显式呈现且不得隐式
failover；UI 只读权威 directory projection；Console 离线时 Work 仍成功；所有 unit 均有 review、
integration、远端 push、L2 memory 和 cleanup receipt，根 main clean。

本阶段不做：公网 Relay、NAT/STUN、双 NAT、direct internet、手机/蜂窝、master/slave 关系治理、
完整 UI polish、browser 多 profile、生产部署或 provider 自动 failover。缺证据时保留为
open/blocked/cleanup-pending，不能把测试、merge、本地 replay 或 push 写成公网部署或完整 V1。

直接执行本目标，不再生成新的提示词。
```
