# AgentTeams 项目行为与用户交付审计

日期：2026-10-02。源码基线：`5496e1e925e4bbe612d509488368003bd78880d6`，已 fetch 确认远端。
本次交付为审计、设计图及计划，不修改产品运行逻辑，不宣称重新完成真实网络/浏览器验收。

## 结论

项目具备本地 Agent 协作的工程底座和历史真实 socket 回放；尚不能按当前入口承诺一个普通用户可安装、可反复提交新任务、可只编辑 config.toml、可打开 Console 使用 OpenCode 的完整 MVP。
差距集中在用户入口与已有 owner 之间的接线，不需要推倒网络、账本或 OpenCode adapter 重写。

先交付一台机器上的本地 bridge、两个独立 daemon、一次次真正的新 Work、可选择的服务、可选 Console 和可用 OpenCode Session。公网/NAT、手机、第二部署环境不进入这次本地 MVP 的完成条件。

## 已确认的工程现状

| 面 | 当前实现与证据 | 用户交付判断 |
|---|---|---|
| 本地主线 | CLI init/start/status/work/stop；supervisor 启 bridge 和独立子进程；内网 wss/socket 目录、能力发布、provider admission/资源账本已接线 | 已有工程实现；尚非新用户完整交付 |
| 真实协作 | 9 月 14 日 CLI disposable HOME 回放，generation 1→2、旧 generation stop 拒绝、Console 未启动仍可 Work | 历史入口证据有效于原版本，不代表 10 月 2 日当前部署 |
| Work | receiver 启动时 runConfiguredWork；CLI work 等待 internal.configuredWork，匹配 generation/workId/requestId 后输出成功 | 同一 generation 重复调用会读同一回执；不能承诺每次命令执行新任务，也不展示业务搜索结果 |
| 能力和资源 | provider executor 固定 browser/file-search 两种能力及容量 2；receiver 不发布能力 | 用户不能选择服务或资源容量；默认 /missing/camo 仍会声明 browser，声明与实际可用能力不一致 |
| 用户配置 | config.toml v2 编译 internal.toml，再投影 child JSON；PID/generation 有 ownership 校验 | 配置分层已有基础，但默认 TOML 暴露 leasePort、TLS/路径和较多运行参数；bridge 初始配置还要 relay.json |
| 多 provider | config owner、catalog、CAS、accepted/effective revision、OpenCode 派生配置和受管 runtime 已实现 | 真实配置经 openCode.configFile 独立 JSON store；用户 TOML 不是 provider/model 意图的完整唯一源 |
| Console | 独立进程、Basic auth/origin 检查、Agent-side managers policy；agentIds=[] 时目录发现；Work 只读投影 | 需要独立 JSON、relay credential 和静态资源路径；CLI 不启动/开放 Console 用户入口 |
| LLM Session | adapter 和受管 OpenCode 有真实派发历史证据 | 当前 agent-process 的 sendSession 返回 UNSUPPORTED_OPERATION，配置 OpenCode 不自动等于可通过 Console 发消息 |
| 安装包 | root package bin 指向 CLI；files 仅 cli 和 generated/runtime-lib。另有 governance artifact 收集 UI/static | 当前 npm pack dry-run 132 files 未包含 Console 静态入口；installed-runtime-smoke 测的是另一个 artifact，不是用户 CLI 安装包完整路径 |
| 治理 | AppSDK compile/verify、maps、lifecycle producer 均有实现 | verify 记录 development_ready=true，delivery_assessed=false、delivery_verified=false；不得升级成产品交付通过 |
| 可重入 gate | 有 lifecycle adapter 与阶段记录设计，pnpm verify 仍串全量命令 | 需针对本次变更审计已有 record 的有效性和失效传播，不能通过新增第二套 PASS 缓存解决 |
| 文档进度 | README、user MVP brief 和 maps 仍有早期未实现/旧 dirty worktree 描述，note/evidence 又宣称已收口 | 文档状态漂移；以源码、入口和 exact receipt 判断，旧笔记保留为历史 |

源码锚点：`cli/agentteams.mjs` 的 DEFAULT_CONFIG_TEXT、agentteamsCommand；`runtime/local-process.ts` 的 runLocalConfiguredWork；`runtime/agent-process.ts` 的 runConfiguredWork、startAgentProcess、consoleClient；`agent-host/cli-executor.ts` 的 createCliWorkExecutor；`runtime/local-config.ts` 的 endpointConfig/loadLocalConfig；`runtime/console-config.ts`；`runtime/console-process.md`；`package.json`；`scripts/package-artifact.mjs`；`scripts/installed-runtime-smoke.mjs`。

历史证据：`docs/evidence/af5c167-local-mvp-rerun-20260914/replay-receipt.md`；`docs/evidence/c5708f3-current-syah-live-20260914/candidate-receipt.md`；`docs/evidence/af5c167-phase1-current-20260914/candidate-receipt.md`。RCC empty catalog 不阻止用户显式添加模型；备用 provider 是显式选择，不引入自动 fallback。

## 最小 DAGpipe 改造边界

先建立项目自有行为图并接入定向 topology gate，再按图补实际入口。保留 TypeScript owner 与运行结构；不为静态图治理引入 Rust daemon、FFI、第二 scheduler、第二配置数据库或第二任务账本。

图真源位于 `docs/design/dagpipe/graphs/`；语义、契约和实现映射见 [行为模型](teams-behavior-model.md)。七条 graph 分别建模一次启动、一次 Work、一次配置应用、一次 Console 观察、一次 Session 请求、一次停止、一次版本交付。每条有一个输入 ARC 和一个输出 ARC。它们是目标设计，不是已执行的 DAGpipe Operators。

`dagpipe graph validate` 只验证静态 SESE、无环和 bindings 名称。Operator 注册、类型/效果授权、执行 journal 和真实行为没有接入 Rust SDK；不宣称 SDK compile/runtime PASS。第一阶段先采用现有 TS runtime 作为行为实现与验收对象；若需要 DAGpipe 实际执行，先确认当前 SDK/语言边界，独立设计最小运行适配，不能凭图校验通过假装调度已改造。

单次 graph 不包含重试回边。重连/重启是 lifecycle 事件，下一次执行使用新 execution/attempt，generation 由 network/runtime 唯一 owner 管理。Work transmission unknown 必须保留资源与未确认责任，不自动重放或释放。

## 消融与奥卡姆剃刀决策

1. 保留网络 transport、Work ledger、provider admission、配置 CAS 和 OpenCode adapter；这些拥有不同真实语义，不因目录多就删除。
2. 将“启动时自动任务”与“用户提交任务”明确分开。用户 work 复用 consumer channel/ledger 发起新请求；不在 CLI 重建 Work 状态机。
3. 用户 intent 统一 config.toml；internal.toml 保存 runtime resolve/revision/catalog/state。旧 provider JSON、Console JSON、relay.json 只能在 verified migration 后成为派生投影并删除失效输入引用，不能双向同步成双真源。
4. 能力声明由实际 enabled adapter 及用户容量投影；无可执行 browser 时显式不可用，不广播可匹配的假可用能力。
5. 统一用户安装生成物与 smoke 对象；governance artifact 可以保留其审计用途，但不能再充当另一套用户运行产品。
6. 历史 state-only daemon/network 路径是否重复，须按调用、测试与保留契约查证。本次只记录，不能凭同名/旧描述直接删源文件。
7. gate 复用项目已有权威 lifecycle record，仅在输入/source/artifact/env 变化时重跑受影响下游。AppSDK 未评估 delivery 显式报告，不以 exit 0 判断交付通过。

## 交付计划

新的用户里程碑与并发范围在 [本地用户交付计划](../goals/teams-user-delivery-plan.md)。旧网络优先长程合同继续规定质量闭环；本计划接替其中的本地 MVP 产品任务顺序，不创建第二个 goal/subscription，也不提前实现后续公网需求。
