# D03 `--serve dsh` serve 接线 — receipt

日期：2026-10-11，America/Los_Angeles。
候选分支：`codex/acp-d03-serve-20261010`（不 push、不合并 main）。
Base：`origin/main@f5d53e4`（D00 + D01 + D01 bindings + D04 + D04 bindings + D03 DSH adapter
core/bindings + D02 `--serve opencode`）。
Worktree：`/Volumes/Intel/playground/agentteams/acp-d03-serve-20261010`（clean、独占）。
Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d03-serve-20261010/`。

本 receipt 是本次交付的一部分，因此它所在的提交**不**包含它自己的 commit hash；hash 由主集成
在 review/merge 后回填。

## 1. 目标与唯一阻塞

D03 的 DSH adapter core/bindings 已交付并经独立验证（`createDshEngineAdapter()` 在
`dsh-adapter/index.ts:407`，`compileLaunch` :413，`verifyEffective` :438；真实 DSH
0.2.0-rc.2 推理 18/18 已独立复现）。唯一剩余的 D03 closure blocker 是
`runtime/acp-serve.ts` 在 `:246-251` 以 typed 拒绝拒绝 `--serve dsh`。本次变更只做这一件事：
把 `--serve dsh` 接到**同一个** serve 入口，不新增第二个 session/host/stdio 路径，不新增第二个
config compiler，不新增重复入口。

## 2. 唯一的 dispatch 变更（source）

`runtime/acp-serve.ts`：

- 删除 `readAcpServeIntent` 里的 `--serve dsh` typed 拒绝分支（原 `:246-251`）。
- 新增**唯一**分发点 `engineAdapterFor(kind)`：`opencode -> openCodeAcpAdapter`、
  `dsh -> createDshEngineAdapter()`，`default` 用 `const unhandled: never = kind` 让类型系统
  证明穷尽；D00 冻结的 kind 集合是 `opencode|dsh`，所以该 default 对配置解析器可产生的任何值
  都不可达。
- `startAcpServe` 只调用一次 `engineAdapterFor(engine.kind)`；之后 executable 解析、
  `adapter.compileLaunch`、`startAcpAgentDaemon`、`adapter.declaredMethods`/`enforceablePolicies`、
  readiness 的 `adapter.verifyEffective`、stop 全部复用同一段代码，没有第二份 session/host/stdio
  plumbing。（N2 后 `enforceablePolicies` 由 adapter 自己声明，入口经 `requireEnforceablePolicies`
  显式要求、缺失即 typed 失败，见 §11.2。）
- `EngineLaunchInput.kind` 现在传真实的 `engine.kind`（原为硬编码 `'opencode'`），
  `engineInstanceId` 前缀也随 kind。
- 新增 `resolveDshExecutable`，与 `resolveOpenCodeExecutable` 共用同一个
  `resolveEngineExecutable` 实现（config path -> `AGENTTEAMS_DSH_EXECUTABLE`/`DSH_EXECUTABLE`
  -> PATH）；OpenCode 的解析语义不变。
- readiness 的 engine kind 从 `AcpServeReadiness` 移到 `AcpServeHandle.engineKind`（真实 union
  值），`formatAcpServeReady` 打印 `engine=${handle.engineKind}`，不再硬编码 `engine=opencode`。

DSH 启动事实由 adapter 拥有、本入口如实执行：`DSH_HOME` 指向 daemon 自有目录（绝不触碰真实
`~/.dsh`）、`--profile acp --patch <ownedDirectory>/teams-dsh-acp.patch.json`（派生 patch）、
`DSH_PERMISSION_MODE=workspace-write`、`DSH_TELEMETRY_DISABLED=1`。`initialize` 仍显式带
`{ protocolVersion: 1, clientCapabilities: {} }`；强制 model-binding 拒绝、凭据解析、单子进程
不变量与显式 stop 路径都保持不变。

**engine home 清理（本候选新增的入口级收口）**：入口创建的 engine-owned 目录
（`<dataDirectory>/engine`，即 `DSH_HOME`，含派生 patch 与 DSH session store）在**每条退出路径**
被删除——正常 stop、`startAcpServe` 的 catch、以及 `startAcpAgentDaemon` 返回 `failed` 的路径。
daemon data directory、durable history 与 workspace 保留。D03 的 adapter 级 evidence driver
（`dsh-adapter/real-engine-evidence.mjs`）已有自己的清理漏斗；本候选补的是**用户入口**这一层的
清理，二者不重复、不互相替代。

`dsh-adapter/index.ts` 唯一改动：`verifyEffective` 的 evidence 增加
`modelVerification: 'session/new configOptions'`，与 OpenCode adapter 的 readiness 词汇一致
（`:473`）。这是语义等价的证据字段补充，不改变 adapter 的任何判定逻辑。

## 3. 证据面（分开，命令均在候选 worktree 根目录执行）

| 证据面 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装 | `pnpm install --frozen-lockfile` | exit 0（pnpm 10.31.0，node v22.22.2） |
| 定向 suite（serve + 两个 adapter） | `pnpm exec vitest run runtime/acp-serve.spec.ts dsh-adapter opencode-adapter --no-file-parallelism` | **116/116 PASS**，7 files（acp-serve 20、dsh index 26、dsh native-config 5、opencode 65）（`ae85312` 为 109/109：acp-serve 16、dsh index 23；N2 后 115/115，N3 再加 1 个 failed-outcome 用例后 116/116） |
| CLI suite | `pnpm exec vitest run --no-file-parallelism cli/agentteams.spec.ts` | **30/30 PASS** |
| D01 定向 suite | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts --no-file-parallelism` | **53/53 PASS**，4 files |
| 类型检查 | `pnpm typecheck` | exit 0（root tsc + opencode-adapter build/typecheck + console-host + ui/teams-console） |
| runtime 构建 | `pnpm build:runtime` | exit 0 |
| 真实 DSH 引擎（经用户入口） | `pnpm build:runtime && node docs/evidence/acp-d03-serve-20261010/black-box-serve-dsh.mjs` | **BLACK-BOX PASS**，exit 0；真实 `/opt/homebrew/bin/dsh` 0.2.0-rc.2、真实 D03 provider route、真实凭据、真实 prompt/cancel/显式 PID stop、零泄漏 |
| 真实 OpenCode 引擎（经用户入口，回归） | `node docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs` | **BLACK-BOX PASS**，exit 0（未回归） |
| 五张 map 校验 | `python3 .worker-runs/acp-d03-serve-20261010/validate-maps.py` | **PASS**：五张 map parse OK、duplicate_keys=none、无悬空 `required_gates`；新 gate 恰好 1 次；两条 gate 命令覆盖检查通过 |
| AppSDK compile/verify | `appsdk compile` / `appsdk verify` | **BLOCKED（环境，未运行）**：沿用 D01/D04/D03 记录的既有 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014`（本机 appsdk 0.1.8） |

完整黑盒日志保留在 run notes：`evidence/black-box-dsh.log`、`evidence/black-box-opencode.log`。

### 3.1 真实 DSH 入口输出（关键行）

```
serving agent=reasoner-dsh engine=dsh engineInstance=dsh-reasoner-dsh-<uuid> enginePid=73484 daemonPid=73474 \
  listener=127.0.0.1:<port> dataDirectory=<work>/state config=<work>/agent.toml \
  model=workbuddy/wb-deepseek-v4.1-flash modelVerification=session/new configOptions effectiveRevision=1
  ok: the engine child really runs `dsh --profile acp`
  ok: the daemon has exactly one child process (73484:node /opt/homebrew/bin/dsh --profile)
  ok: the patch selects the derived route {"provider":"teams-workbuddy","model":"wb-deepseek-v4.1-flash"}
  ok: the real DSH engine materialized its acp profile inside the owned home
  ok: the engine identity is the real DSH ACP server (deepseek-harness-acp)
  ok: the engine's own session/new reports the derived route (["teams-workbuddy","wb-deepseek-v4.1-flash"])
  ok: the engine streamed real assistant text ("DSH-SERVE-OK")
  ok: the real provider reply matched the prompt ("DSH-SERVE-OK")
  ok: the cancel notification ended the in-flight prompt (cancelled)
stopped agent=reasoner-dsh enginePid=73484 engine=exited code=0 signal=null channels=1
  ok: the engine pid 73484 is gone after the stop
  ok: the owned DSH home <work>/state/engine was removed on stop
  ok: the derived patch file was removed with the owned home
BLACK-BOX PASS: one daemon + one real DSH engine child, verified derived route, real prompt, real cancel, explicit-PID stop, owned DSH home removed.
```

真实 DSH 运行复用 D03 已提交 driver 的**同一** route/credential 事实：
`dsh-adapter/real-engine-evidence.mjs` 用的 `openai-responses` proxy route
（`https://api.xyxl1225.online/8318/v1`，`wb-deepseek-v4.1-flash`）与真实 DSH 凭据库
`~/.dsh/.credentials.yaml` 的 `DEEPSEEK_FLASH_API_KEY`；driver 把凭据值经环境变量传给入口，
入口用自己的 `resolveCredentialReference` 解析，凭据值不打印、不落盘。没有用 OpenCode 引擎
跑 dsh case，没有 stub 伪造成功：DSH 的 prompt 是真实 provider 调用（回复文本
`DSH-SERVE-OK`），cancel 与显式 PID stop 都是真实进程行为。

### 3.2 安装副本 vs 源码树入口

- 源码树入口：本次 DSH 与 OpenCode 黑盒都以 `node cli/agentteams.mjs --serve ...` 驱动真实
  CLI 进程（`AGENTTEAMS_CLI` 未设置时即源码树路径）。
- 安装副本入口：**DSH 分支尚无**。OpenCode 分支的本地 `npm pack` + `npm install` 安装副本
  replay 来自 D02 receipt，未在本候选重跑，因此不当作本候选证据。
- driver 支持 `AGENTTEAMS_CLI=<installed>/cli/agentteams.mjs`，但本次未执行安装副本 DSH replay。

## 4. 测试变更（`runtime/acp-serve.spec.ts`）

- 删除旧的 `refuses --serve dsh because the DSH serve wiring is not delivered` 用例（该断言已
  被本变更证伪），替换为两个新用例：`accepts the dsh engine and dispatches it to the DSH adapter`
  与 `refuses a dsh config whose agent has no [model.primary] binding`（后者断言 binding 拒绝仍然
  生效，code/message/detail 三条都断言）。
- 新增 `resolves the installed DSH executable from the config, the environment and PATH`。
- 新增 describe `--serve dsh entry with a local fake DSH ACP engine`，4 个用例：
  1. dispatch + 单子进程 + readiness：断言子进程参数是真实的
     `--profile acp --patch <ownedDirectory>/teams-dsh-acp.patch.json`、`DSH_HOME` 在
     daemon-owned 目录内且在 `tmpdir()` 下、`DSH_PERMISSION_MODE`/`DSH_TELEMETRY_DISABLED`
     已设、fake engine 记录的 pid 与入口报告的 `enginePid` 一致、只有一个 pid 记录、readiness
     model 来自引擎自己的 `session/new` 且该值由引擎从**入口真实写出的派生 patch** 读回、真实
     ACP client 经入口监听器完成 initialize/session/new/prompt、显式 PID stop 后子进程不存在且
     owned engine home 已删除而 durable history 保留。
  2. cancel：真实 `session/cancel` notification 使 in-flight prompt 以
     `stopReason: cancelled` 结束；stop 后 owned home 删除。
  3. 启动失败清理（readiness 失败，outer catch）：引擎对 `session/new` 回错误帧，入口以 typed
     `AcpError` 失败，且 owned engine home 已删除、daemon data directory 与 durable history 保留。
  4. N3 新增：`removes the owned DSH home when startAcpAgentDaemon returns a failed outcome`——
     引擎对 `initialize` 回错误帧，使 `startAcpAgentDaemon` 自身返回 failed outcome，直接覆盖
     `outcome.kind === 'failed'` 清理分支（见 §11.3）。
- fake engine 是本地 ACP server 进程，**不是**真实 DSH、不宣称真实推理；真实引擎由 §3 的
  black-box driver 覆盖。fake engine 从自己的 `DSH_HOME` 读注入行为文件，因为它必须只依赖
  真实子进程环境（见 §6 的既有事实）。
- 既有 opencode 用例全部保留、未放宽任何断言。`runtime/acp-serve.spec.ts` 20/20（`ae85312` 16/16，
  N2 后 19/19），CLI spec 30/30。
- N2 新增的 3 个入口级用例见 §11.2：adapter 未声明 `enforceablePolicies` 时 typed 失败、DSH 入口接受
  `capability:`/`client-capability:` blacklist、无 enforcement owner 的 key 在 spawn 前被拒。

## 5. 绑定（同一变更）

| 文件 | 变更 |
| --- | --- |
| `docs/architecture/verification-map.json` | `teams-acp-d03-dsh` command 改为 `pnpm exec vitest run dsh-adapter runtime/acp-serve.spec.ts --no-file-parallelism`，checks 增 serve dispatch/DSH launch facts/清理与 `--serve dsh` 非 CI 黑盒，note 重写；`teams-acp-serve-entry` checks 覆盖两个引擎与单点 dispatch，note 重写；两条 gate 保持 `partial` |
| `docs/architecture/mainline-call-map.json` | `acp-serve-entry-v1` steps 增 `engineAdapterFor` 单点分发、note 覆盖两引擎；`acp-dsh-engine-v1` steps 从 FUTURE 改为已接线并增入口级清理，note 重写；`daemon-config-compile-v1`、`acp-host-wiring-v1`（chain+edge）、`acp-d04-registry` chain 与 `acp-host-wiring-v1` 的 edge note 修正为两引擎 |
| `docs/architecture/function-map.json` | `acp_serve_entry` 增 `engineAdapterFor`/`resolveDshExecutable` 符号并重写 note；`engine_adapter_port`、`daemon_intent_compilation`、`acp_daemon_child_wiring` 的过期 note 修正。未新增 binding：`engineAdapterFor` 是 `acp_serve_entry` 的组成部分，按“同一事实不跨 map 重复”不另建条目 |
| `docs/architecture/module-registry.json` | **勘误（N1，closure re-review 第 2 轮）**：`ae85312` 的 `module-registry.json` diff 实际改到 4 个模块 note 的过期“DSH serve wiring 未交付/拒绝 dsh”措辞——`cli-facade`、`acp-adapter`、`dsh-adapter`（更新为已接线，仍 partial）与 `runtime`（“an engine whose serve wiring is not delivered with a typed fault” 一句被删除）。本行原先只把 `acp-adapter`、`cli-facade`、`runtime` 计为“三处”，既不完整也掩盖了真正的缺口：第 5 处 **`agent-host` 模块 note** 仍写着 “the network channel (D05) and the DSH serve wiring do not”，未被 `ae85312` 修正。该 `agent-host` 处是 N1 的 must-fix，已由后续修复提交改为已交付事实（两个引擎都经同一 `--serve` 入口，仅 D05 网络通道与安装副本证据仍缺） |
| `docs/architecture/resource-map.json` | 只修正 `daemon-intent-config` 一处被本变更证伪的措辞；不新增资源、不改 owner |
| `docs/development-governance.md` | 段首 `--serve` 说明、`teams-acp-d03-dsh` 行、`teams-acp-serve-entry` 行、D02 段与 D03 段更新；两条 gate 仍 partial |
| `docs/design/teams-acp-daemon-config-v4.md` §10 | `--serve dsh` 改为已接线，写明 `engineAdapterFor` 单点分发、DSH 启动事实、入口级清理与 D03 黑盒证据 |
| `AGENTS.md` | 删除“`--serve dsh` serve wiring 仍 pending”的表述，改为 D03 同时交付 DSH adapter 与 `--serve dsh` 入口，并写明单点 dispatch |

`.appsdk/project.json` 无需改动：`teams-source` 已准入 `dsh-adapter/**`、`runtime/**`、
`cli/**` 与 `docs/**`，`minimum_test_count` 保持 304（本次新增用例只会增加实际数量）。
`resource-map.json` 未新增 D03 资源：沿用 D03 绑定提交的理由，DSH 派生/读回事实已由
function-map 与 mainline-call-map 各记录一次。

五张 map 校验（`validate-maps.py`，含重复键 hook、悬空 `required_gates` 交叉解析与本次新增的
gate 命令覆盖检查）：

```
function-map.json: parse OK, duplicate_keys=none
mainline-call-map.json: parse OK, duplicate_keys=none
module-registry.json: parse OK, duplicate_keys=none
resource-map.json: parse OK, duplicate_keys=none
verification-map.json: parse OK, duplicate_keys=none
required_gates dangling: none
edges with an undeclared chain_id (advisory, pre-existing): ['endpoint-discovery-admission-v1', 'session-control-v1']
teams-acp-d03-dsh occurrences in verification-map: 1
RESULT: PASS
```

- 既有悬空（非本次引入，未修复）：`edges` 中 2 个 chain_id 只在边里出现、未在 `chains` 声明
  （`endpoint-discovery-admission-v1`、`session-control-v1`）。修复涉及 endpoint/session-control
  owner，超出本次范围。

## 6. 早期 D03 清理缺陷历史（记录，不复现）

D03 第 1 轮 adapter evidence driver 在 `fail()` 里先 `finish(1)`，而 `resource.cleanup` 块在脚本
末尾，因此只有成功路径执行清理：每次失败或中断的真实引擎运行都会泄漏真实 DSH engine home，
并可能留下引擎子进程。共**六个真实 engine home 泄漏**（`E6uDSS`、`ZaKDzo`、`aPy9qs`、
`l8sxb9`、`qN4B2O`、`u3BEcz`）。第 2 轮（`60bf76b`）把它修成单一 `finish()` 漏斗，并把
`SIGINT`/`SIGTERM`/`SIGHUP`、`uncaughtException`、`unhandledRejection` 都接入同一漏斗。
详见 `docs/evidence/acp-d03-integration-20261010/notes.md` §6；六个泄漏 home 已按显式路径
核对后删除。

本次变更不重复该缺陷，并在**用户入口**这一层补上同类清理：`--serve dsh` 的 owned engine home
在 stop、`startAcpServe` catch 与 daemon 启动失败三条路径都被删除。§3.1 的真实黑盒在 stop 后
断言 owned home 与 patch 文件都不存在。

**既有事实（本候选的 fake-engine 用例据此设计）**：DSH adapter 的 launch 环境来自
`process.env`（真实 CLI 子进程语义），不是 `startAcpServe(options.env)`。因此 spec 的 fake engine
通过自己的 `DSH_HOME` 控制文件注入行为，而不是依赖注入的 `options.env`。这既是真实语义，也是
black-box 用真实 CLI 子进程驱动的原因。

## 7. 两个已知行为与 owner（仍开放，不静默）

- **KB-1 — DSH `embeddedContext:false` 与 `resource_link` 冻结策略冲突。** 真实 DSH
  `initialize` 广告 `promptCapabilities.embeddedContext = false`；冻结 D01 策略
  `assertPromptModalities` 对 `resource_link` 提示要求
  `capability:/promptCapabilities/embeddedContext`，因此 `resource_link` 提示在真实 DSH 上不被
  准入。**owner：Lead（policy 决策）；DSH engine（广告值）**。本次未改
  `config/acp-policy.ts`（冻结且不在允许路径内）。
- **KB-2 — `session/list` 在会话仍打开时返回 `[]`。** DSH 的 `session/list` 分页的是已持久化、
  可 resume 的 root session。**owner：DSH engine（行为）；D05/D06/D07 消费者（不得把它当作
  live-session 目录）；Lead（集成说明）**。

两个行为在本次真实 `--serve dsh` 运行中仍存在，未被本次变更触碰或掩盖。

## 8. 明确 NOT proven（不得从前一层推断）

1. **DSH 安装副本 / live 产品证据不存在。** DSH 黑盒是源码树入口的真实 CLI 进程 + 真实引擎 +
   真实 provider，但**不是** `npm pack`/`npm install` 安装副本，也不是发布产物或 AppSDK 生命周期
   回执。OpenCode 的安装副本 replay 来自 D02 receipt，未在本候选重跑。
2. **AppSDK compile/verify 被环境阻断**（既有 0.1.0014 pin mismatch），本次不记为通过。
3. **未跑全量 `pnpm test`。** 本次只跑受影响定向 gates（§3）；既有 load-sensitive 失败集合
   （`runtime/agent-process.spec.ts`、`runtime/managed-opencode-session.spec.ts`）不在本次声明范围。
4. **真实 DSH 证据覆盖一个 provider 协议与一个 route**（`openai-responses` 经 proxy route）。
   `openai-chat` -> `openai-completions` 映射由 focused spec 覆盖，未由真实引擎运行覆盖。
5. **DSH 真实引擎的 permission callback 未在 `--serve dsh` 黑盒中触发。** 黑盒的 prompt 是纯文本
   回复；真实 `session/request_permission` 回调门控由 D03 adapter driver（`native.policy` gate）
   覆盖，不由本入口黑盒覆盖。
6. **两个已知行为仍开放**（§7）。
7. **2 个既有悬空 chain_id 仍未修复**（§5）。
8. **gate 仍为 partial**：`teams-acp-d03-dsh` 与 `teams-acp-serve-entry` 都不升级为
   passed/implemented。
9. **黑盒的 `~/.dsh` 断言（N4 后）只覆盖引擎自持的 `DSH_HOME` 与派生 patch 缺席。** 它用
   `ps -E` 读运行中的引擎子进程真实环境，断言 `DSH_HOME` 是 owned home 而非真实 `~/.dsh`，
   并断言真实 home 下没有本轮的 `teams-dsh-acp.patch.json`。它**不**递归快照真实 home 的全部
   内容：真实 `~/.dsh` 同时被本机 DSH harness 持续写入（会话缓存等），整树快照会误报，故未采用。

## 9. 资源与清理

- 独占 worktree：`/Volumes/Intel/playground/agentteams/acp-d03-serve-20261010`，branch
  `codex/acp-d03-serve-20261010`，owner = 本 worker；保留到主集成完成 review/merge/远端
  receipt 后回收。
- Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d03-serve-20261010/`
  （`validate-maps.py`、`evidence/black-box-{dsh,opencode}.log`）。
- 进程清理只用显式 PID：黑盒 driver 以 `process.kill(daemonPid, 'SIGTERM')` 停止自己启动的入口，
  finally 里只对自己 spawn 的 entry 做 SIGTERM->SIGKILL 升级；未使用 `pkill`/`killall`。
- 运行后扫描（命令与结果）：
  - `ls -d /var/folders/*/*/T/d03-serve-blackbox-*` -> 无
  - `ls -d /var/folders/*/*/T/dsh-home* /tmp/dsh-home*` -> 无
  - `ls -d /var/folders/*/*/T/d03-real-engine-*` -> 无
  - `ps -axo pid=,command= | grep -E "bin/agentteams.mjs --serve|dsh --profile acp|fake-dsh"` -> 无
  - `~/.dsh` mtime 当时保持 `Oct 10 23:20`，未写真实 `~/.dsh`（`DSH_HOME` 隔离成立）。第 2 轮
    改用更强、可判别的断言（运行中引擎子进程的真实 `DSH_HOME`，见 §11.4）；真实 `~/.dsh` 现在
    同时被本机 DSH harness 持续写入，所以 mtime 不再是有效证据。
- **既有泄漏（非本次产生，未删除）**：`/var/folders/.../T/d02-serve-blackbox-{QV86m0,Vo54mr,ceazOb,jhH8j7,pMMgSy}`
  来自 01:47–01:59 的其他 D02 运行，早于本任务；按“只移除本任务创建的资源”保留未动，在此显式记录。
- 未删除或改动他人 worktree、他人 run notes 与共享 base（含冻结分支
  `codex/acp-d03-worker-20261010`）。

## 10. 未完成绑定 / 缺口与下一步

1. DSH 分支缺安装副本 replay 与 AppSDK 回执（§8.1、§8.2）。
2. `teams-acp-d03-dsh` 与 `teams-acp-serve-entry` 保持 `partial`。
3. 两个已知行为（§7）待 Lead policy 决策与 D05/D06/D07 消费约束。
4. 既有 2 个悬空 `chain_id` 仍未修复（§5）。
5. 未 push、未合并 main；由主集成编排决定 review/merge。

## 11. Closure re-review 第 2 轮（N1–N5）

`ae85312` 的 D03 closure re-review 结论为 PASS，带 2 条 must-fix（N1、N2）与 3 条 advisory
（N3、N4、N5）。本提交在同一分支、同一 worktree 上完成全部 5 条；`ae85312` 未被改写
（无 amend/rebase/force/push/merge）。

### 11.1 N1 — 语义 owner map 如实（must fix）

- `docs/architecture/mainline-call-map.json:76`（edge `acp-serve-entry-v1`）：caller 改为
  `agentteams --serve opencode / agentteams --serve dsh`，callee 增 `engineAdapterFor(kind)` 与
  `createDshEngineAdapter().compileLaunch (D03)`，path 增 `dsh-adapter/index.ts`；note 结尾不再
  声称 DSH serve wiring pending，只保留真正未交付的 D04 入口内注册组合与 D05 协商。
- `docs/architecture/module-registry.json:66`（`agent-host` 模块 note）：删除
  “the network channel (D05) and the DSH serve wiring do not [exist]”，改为两个引擎都经同一
  `--serve` 入口、已由真实 D02/D03 黑盒经真实 CLI 进程验证，仅 D05 网络通道与安装副本/发布
  证据仍缺。
- receipt 勘误：§5 表格 `module-registry.json` 行改为与 `ae85312` 实际 diff 一致——该提交改到
  4 个模块 note（`cli-facade`、`acp-adapter`、`dsh-adapter`、`runtime`），漏掉第 5 处
  `agent-host`，即本 N1。

### 11.2 N2 — enforceablePolicies 归 adapter 所有（must fix）

Lead ruling：adapter 拥有“自己能执行哪些 policy”。修复落在 owner，不落在 call site。

- `dsh-adapter/index.ts`：新增 `dshEnforceablePolicyKeys()`，把
  `DSH_ADAPTER_CAPABILITIES` + `DSH_ENGINE_DECLARED_CAPABILITIES` + `DSH_UNSUPPORTED_FEATURES`
  的全部 key 经同一个 `dshHasPolicyEnforcementOwner` 规则过滤（`acp` / `method:` / `capability:` /
  `client-capability:` / `callback:`；`feature:` 标签与 `internal-tool:` 不在其中）；
  `DshEngineAdapter` 接口新增 `enforceablePolicies`，`createDshEngineAdapter()` 返回该集合。
- `runtime/acp-serve.ts`：删除 `adapter.enforceablePolicies ?? adapter.declaredMethods`；新增
  `requireEnforceablePolicies(adapter)` 并在 executable 解析、建目录、`compileLaunch`、spawn
  **之前**调用。adapter 未声明 enforceable set 时抛 typed
  `AcpError('UNSUPPORTED_CONFIGURATION')`，message 指名 `adapter.kind`，绝不回退到别的集合。
  opencode adapter 语义与它的 `enforceablePolicies` 未改。
- `runtime/acp-daemon.ts:344` 的 `input.policy.enforceablePolicies ?? supported` 未改：那是
  `AcpDaemonPolicyInput` 文档化的库级默认（`Defaults to supported`），不是入口对 adapter 声明的
  替换。本入口现在总是显式传入 adapter 自持集合，所以 DSH 分支不再落到任何默认值。
- 新增 focused spec：`dsh-adapter/index.spec.ts` 的
  `derives the enforceable set from the one enforcement-owner rule over the declared surface`、
  `admits a blacklist for the capability and client-capability classes the declared-method set over-refused`
  （同时断言旧 `declaredMethods` 替换对这些 key 会抛 `AcpError`）、
  `still refuses a blacklist key with no enforcement owner`；`runtime/acp-serve.spec.ts` 的
  `fails explicitly when an engine adapter declares no enforceable-policy set`、
  `accepts a blacklist for the capability and client-capability classes the DSH adapter enforces`、
  `refuses a blacklist key with no enforcement owner before it spawns the engine`。
- reviewer 复现的 over-refusal 已消除：`capability:/promptCapabilities/image`、
  `capability:/mcpCapabilities/http`、`client-capability:/fs/readTextFile` 现在被接受
  （未 advertise 的 key 不会进 effective，但不再被拒）；`internal-tool:dsh:bash` 仍在 spawn 前以
  `UNSUPPORTED_POLICY: ACP blacklist key has no enforcement owner` 拒绝，且 fake engine 没有
  pid 记录。

### 11.3 N3 — failed-outcome 清理分支直接用例（advisory，已修）

`runtime/acp-serve.ts` 的 `outcome.kind === 'failed'` 清理分支原先只被 “engine fails to start”
用例间接覆盖，而那个用例实际走 outer catch。新增直接用例：fake engine 支持
`failInitialize`，让 `startAcpAgentDaemon` 自身返回 failed outcome；断言抛出的 typed fault 带
`ENGINE_UNAVAILABLE` 且 message 为 `engine start failed: engine initialize failed...`（该形状
只有 failed-outcome 分支会产生），并断言 fake engine 已写进 owned home 的 record/pid 文件随
owned home 一起被删除。原用例更名为
`removes the owned DSH home when the readiness session/new fails`，如实描述它走的是 outer catch。
`verification-map.json` 的 `teams-acp-d03-dsh` check 同步写明两条启动失败路径。

### 11.4 N4 — 黑盒 `~/.dsh` 断言可判别（advisory，已修）

删除 `assert(ownedHome !== REAL_DSH_HOME)`（`ownedHome` 是 tmpdir 子路径，恒真）。改为用
`ps -E` 读**运行中的引擎子进程**真实环境，断言其 `DSH_HOME` 等于 owned home、且不等于真实
`~/.dsh`，并断言真实 home 下没有本轮的 `teams-dsh-acp.patch.json`。本机 `DSH_HOME` 环境变量
本来就指向 `/Users/fanzhang/.dsh`，所以该断言真正检验了 adapter 的 `DSH_HOME` 覆盖；若覆盖
失效，断言会失败而不是恒真。本轮真实运行输出：
`ok: the live engine child's own DSH_HOME is the owned home (...)`、
`ok: the live engine child's DSH_HOME is not the real ~/.dsh (/Users/fanzhang/.dsh)`。
整树 mtime 快照未采用，原因见 §8.9。

### 11.5 N5 — `ServeEngineAdapter` 收窄（advisory，已修）

原先它在 `EngineAdapter` 之上重复声明了一份与 port 完全相同的 `verifyEffective` 形状，成为
第三个结构型 adapter 类型。现收窄为
`EngineAdapter & { declaredMethods: readonly string[]; enforceablePolicies?: readonly string[] }`，
并在类型注释与 receipt 说明它是“入口的 dispatcher 视图”：只补 port 缺的两个 adapter 自持集合，
不声明自己的 `compileLaunch`/`verifyEffective`。`EngineHandle` 因此从 `runtime/acp-serve.ts`
的 import 中移除。

### 11.6 本轮复验（2026-10-11 第 2 轮，命令均在 worktree 根目录）

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run runtime/acp-serve.spec.ts dsh-adapter opencode-adapter --no-file-parallelism` | **116/116 PASS**，7 files（acp-serve 20、dsh index 26、dsh native-config 5、opencode 65） |
| `pnpm exec vitest run --no-file-parallelism cli/agentteams.spec.ts` | **30/30 PASS** |
| `pnpm typecheck` | exit 0 |
| `pnpm build:runtime` | exit 0 |
| `node docs/evidence/acp-d03-serve-20261010/black-box-serve-dsh.mjs` | **BLACK-BOX PASS**，exit 0；真实 DSH 0.2.0-rc.2 + 真实 provider route + 真实 prompt/cancel/显式 PID stop；新增的 live-child `DSH_HOME` 断言通过 |
| `node docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs` | **BLACK-BOX PASS**，exit 0（opencode 未回归） |
| `python3 /Volumes/Intel/playground/agentteams/.worker-runs/acp-d03-serve-20261010/validate-maps.py` | **PASS**：五张 map parse OK、duplicate_keys=none、无悬空 `required_gates`；`teams-acp-d03-dsh` 恰好 1 次；两条 gate 命令覆盖检查通过 |
| AppSDK compile/verify | 仍 **BLOCKED**（既有 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014`），本轮未运行 |

本轮 DSH 黑盒关键行（新增断言）：

```
  ok: the live engine child's own DSH_HOME is the owned home (/var/folders/.../d03-serve-blackbox-<id>/state/engine)
  ok: the live engine child's DSH_HOME is not the real ~/.dsh (/Users/fanzhang/.dsh)
  ok: the derived patch was never written into the real ~/.dsh
  ok: the owned DSH home /var/folders/.../d03-serve-blackbox-<id>/state/engine was removed on stop
BLACK-BOX PASS: one daemon + one real DSH engine child, verified derived route, real prompt, real cancel, explicit-PID stop, owned DSH home removed.
```

本轮进程/资源清理（只用显式 PID，未用 `pkill`/`killall`）：

- 两条黑盒都由 driver 自己 `process.kill(daemonPid, 'SIGTERM')` 停止其 spawn 的入口，finally
  只对自己 spawn 的 entry 升级 SIGTERM->SIGKILL。
- 运行后扫描：`ls -d /var/folders/*/*/T/d03-serve-blackbox-* /var/folders/*/*/T/dsh-home* /tmp/dsh-home*`
  -> 无；`ps -axo pid=,command= | grep -E "agentteams.mjs --serve|dsh --profile acp|fake-dsh"`
  -> 无。
- 真实 `~/.dsh` 未被本轮运行当作 engine home；本轮运行没有在真实 `~/.dsh` 下创建
  `teams-dsh-acp.patch.json`（黑盒断言）。

### 11.7 本轮仍未收口

- `teams-acp-d03-dsh` 与 `teams-acp-serve-entry` 仍为 `partial`；DSH 安装副本 replay 与
  AppSDK 回执仍缺（§8.1、§8.2）。
- §8.9 的“真实 home 整树未被写”仍只是间接/局部证据（引擎 `DSH_HOME` + 派生 patch 缺席），
  不是整树快照。
