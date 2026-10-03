# U5 窄 Console 设计 run notes

任务：U5 窄 Console 设计（design-only），feature `b0f7f3b`。
worktree：`/Volumes/Intel/playground/agentteams/u5-console-design-20261003`。
branch：`codex/u5-console-design-20261003`。
base/HEAD/origin/main：`4fc38a491089693f61b5901aa15c1c966a664338`。

产品源码只读。仅允许写本文件与 `docs/design/teams-local-console-v1.md`。
不提交/合并/推送、不移除 worktree、不安装依赖、不运行产品服务、不做推理。

---

## 证据读取（已读，真实存在）

### 规则与设计

- 项目 `AGENTS.md`；全局 `~/.agents/AGENTS.md` 路由。
- `docs/goals/teams-user-delivery-plan.md` U5、BB01/BB09/BB14、依赖表与交付收口。
- `docs/design/teams-package-delivery.md`（U1 同包安装、pack root、asset 路径、BB01）。
- `docs/design/teams-behavior-model.md`（B1–B8，B4 观察）。
- `docs/design/teams-behavior-contracts.md`（第 69–73 行 D3/U4 launcher 本地控制通道）。
- `docs/design/teams-provider-config.md`（per-daemon accepted revision）。
- 依赖 U2：`/Volumes/Intel/playground/agentteams/u2-config-design-20261003/docs/design/teams-local-config-v3.md`
  （`[console]` config v3 与 internal v2 投影、`applyState`、端口显式失败）。
- 依赖 U6：`/Volumes/Intel/playground/agentteams/u6-session-design-20261003/docs/design/teams-managed-session-v1.md`
  **不存在**；未推断其文件名或内容。

### 图与 map

- `docs/design/dagpipe/graphs/console-observe.graph.json`（B4 五节点静态 SESE）。
- `docs/design/dagpipe/graphs/daemon-start.graph.json`、`daemon-stop.graph.json`。
- 五张 architecture map：`resource-map.json`、`function-map.json`、`mainline-call-map.json`、
  `module-registry.json`、`verification-map.json`。

### 实际源码

- `cli/agentteams.mjs`（`usage`/`parseArgs`/`agentteamsCommand`，仅 init|start|status|work|stop）。
- `runtime/local-process.ts`（`startLocalProcess`/`statusLocalProcess`/`stopLocalProcess`）。
- `runtime/local-supervisor.ts`（`planLocalProcesses`/`createLocalSupervisor`）。
- `runtime/local-config.ts`（`readLocalInternalConfig`/`projectLocalChildConfigs`/
  `writeLocalInternalLauncherState`；internal 无 `[console]`）。
- `runtime/console-process.ts`（`loadConsoleProcessConfig`/`runConsoleProcess`，读用户 JSON）。
- `runtime/console-runtime.ts`（`startConsoleRuntime`）。
- `runtime/console-hub.ts`、`runtime/relay-console-client.ts`（目录发现、无重试）。
- `console-host/src/auth.ts`、`http-api.ts`、`server.ts`（auth/origin/静态/API/401/502）。
- `control-protocol/console-api.ts`（`ConsoleProjectionV1`、`ConsoleCommandV1`）。
- `agent-host/console-ingress.ts`（`createConsoleIngress`，Agent manager policy）。
- `runtime/process-config.ts`（`credential` env reference 解析）。

---

## 第一分歧（first divergence）

现有 Console 是独立进程，经 `runConsoleProcess --config <JSON>` 直接消费用户 Console JSON，
**不在** launcher/supervisor 生命周期内；`planLocalProcesses` 只启动 relay 与 enabled Agent
daemon；`internal.toml` 无 `[console]`；CLI 无 Console 子命令。因此现状无法满足
“只编辑 `config.toml` 即可启动可选 Console”“关闭 Console 不动 bridge/daemon/Work”
“系统选择端口并持久化为内部事实”。这是本设计的驱动分歧。

---

## 设计决策

唯一具体契约（非备选列表）：

- Console 成为 launcher/supervisor 拥有的可选子进程；生命周期复用 D3/U4 声明的唯一 launcher
  本地 Unix socket 控制入口，不新增第二 bus/scheduler/graph family。
- 公开 CLI：`agentteams status` + `agentteams console status|start|stop [--generation <n>]`；
  无 port/url/asset/username/password 参数，全部来自 `config.toml` + `internal.toml` 投影。
- internal `[console]` 持久化 `enabled/pid/generation/startToken/state/url/origin/identityRef/error`；
  端口为系统选择并实际绑定成功的非零值；占用即显式失败，不改端口、不杀 listener。
- Console JSON 只作派生 adapter output，永不作为第二可编辑输入。
- 停止 Console 只关闭自身 listener/registration/连接；crash/restart 用持久 intent + 新
  generation；不发明 availability 或管理权。
- Console identity ≠ 管理权：HTTP auth / Relay admission / Agent `allowedManagers` /
  U2 config CAS / U6 Session 各自独立。
- graph 契约 delta 作为对 primary 的精确请求提出；本文不改任何 graph JSON。

---

## 验证（针对性检查）

- `git diff --check`：通过（见下）。
- Markdown link/fence 检查：通过（source link 允许 `:line` 后缀）。
- `dagpipe graph validate docs/design/dagpipe/graphs/console-observe.graph.json`：见下。
- `git status --porcelain`：仅两个允许文件变化。

未做且不声称：产品实现、build、typecheck、安装、服务重启、live replay、BB09 真实浏览器
验收、full test。

## 2026-10-03 / primary dependency and model correction

- 作者 turn.completed/exit0，66589 已停止；原笔记中“U6 文件不存在”只说明错误文件名不存在，不能说明 U6 设计缺席。实际候选为 U6 tree 的 docs/design/teams-session-delivery.md，已只读核对 model owner、readiness、recover 与取消/unknown 边界；U2/U6 均待准入，不作为既有产品 API。
- 当前 U5 候选 ff组合最新origin/main c3aa36fc637e2da4ac821d1b26d587eadbbf1268，仅goal文档增量；仍只写设计/run-notes，product、graph、map未改。
- 首偏离修正：原§4.2把有循环和多终态的生命周期称为SESE graph。现明确为中文状态图，跨执行重试不伪装执行DAG；一次启动/停止/观察复用B1/B6/B4的项目graph及单收据出口。原internal运行状态样例running改为与状态表同一online值，不保留双枚举解释。
- owner修正：U2唯一拥有Console intent/schema/projection；U5 launcher只写自身生命周期事实，通过U2同一短锁重读合并，不写用户intent或daemon config。D3/U4唯一拥有launcher控制通道，U5仅扩Console动词handler。Session capability≠availability，U5只消费U6投影，recover/apply fence只归U2同一owner，Session ingress由U6 await，配置恢复不能证明Session未知结果结束。
- 下一节点：两文档links/fences/diff与原B4静态graph校验，精确tree冻结后独立设计review；未实施产品或BB09，不宣称graph delta已实现。

---

## 未决依赖（pending，非已批准契约）

- U2：`config.toml` v3 / `internal.toml` v2 `[console]` 与 `applyState` 未实现。
- D3/U4：launcher 本地控制通道未实现。
- U1：`.appsdk` artifact_paths 重绑未完成，同包等价性 `UNVERIFIED`。
- U6：实际 teams-session-delivery.md 候选已核对，尚待独立准入；Session 产品接线未实现，U5 只消费 typed readiness，不另建 API/config/recovery。

## 产品验收状态

未声称任何产品验收。BB09（真实 Camo 浏览器发现两 daemon、auth/origin/policy 拒绝、停 Console
后新 Work 成功、失败/占用端口仅清理自身、restart 新 generation）为**提案、未实现**。

## 2026-10-03 / r2 P1 窄修正

- 节点：r1 P1 修正｜结论：完成本轮编码前设计准入候选目标；当前状态 candidate/等待独立
  review｜证据：`r2-validation.md`、review.final.md、本笔记｜输入：HEAD
  c3aa36fc637e2da4ac821d1b26d587eadbbf1268，feature label b0f7f3b｜下一步：primary 对未提交候选做
  独立设计 review。
- 修正一：Console start/stop/status 拆为三张独立 SESE 静态图
  `docs/design/dagpipe/graphs/console-start.graph.json`、
  `console-stop.graph.json`、`console-status.graph.json`；每图单独通过
  `dagpipe graph validate`。Console stop 不进入 daemon Work drain，Console offline 不影响 Work。
- 修正二：内部运行事实独立为 `[consoleRuntime]` 系统表；U2 仍拥有 `[console]` projection/config、
  serializer/短锁 schema 与 typed port。U5 只通过 pending U2 port 写自身运行事实，禁止两 owner 同字段。
- maps：五张 architecture map 仅登记 U5 Console 生命周期 design/pending 绑定；未虚构已实现
  caller、测试或 Operator。
- 语义：U5 设计与行为模型补充中文业务图、失败/取消/保留责任终点、配置并发互不覆盖验收。
- 验证：`git diff --check`、`git diff --cached --check`、三新图 dagpipe validate、五 map +
  三图 JSON parse、map 引用检查、Markdown link/fence 均通过；命令与结果见
  `docs/evidence/u5-console-design-20261003/r2-validation.md`。
- 未做：未改产品代码/测试/既有 graph/goals/SDK；未运行安装、服务、BB09 或真实 Work；后续
  U2 需接纳 `[consoleRuntime]` schema 与同锁端口，该依赖保持 pending。
