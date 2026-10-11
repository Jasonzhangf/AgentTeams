# D02 `--serve opencode` 用户入口 + 治理绑定 — receipt

日期：2026-10-11，America/Los_Angeles。
候选分支：`codex/acp-d02-serve-20261010`。
Base：`origin/main@48ce0c9`（D00 + D01 + D01 绑定）。
合并输入：`codex/acp-d02-worker-20261010@1d4df3a`（D02 OpenCode adapter 候选，fast-forward 合入，未改其库级语义）。
Worktree：`/Volumes/Intel/playground/agentteams/acp-d02-serve-20261010`（clean、独占）。
Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d02-serve-20261010/`。

本 receipt 的目标是回答一个问题：**用户入口 `agentteams --serve opencode` 是否真的启动
一个 daemon 加一个引擎子进程，并跑通真实 prompt / cancel / permission，然后按显式 PID 停止。**
答案：**是**。源码树入口和本地 `npm pack` + `npm install` 的安装副本
（`node_modules/.bin/agentteams`）两条路径都通过真实进程黑盒。它 **不覆盖** D03/D04/D05，
也不是发布产物或 AppSDK 生命周期回执。因此 `teams-acp-serve-entry` 与
`teams-acp-d02-opencode` 都保持 `partial`。

## 1. 绑定的提交

| 提交 | 角色 |
| --- | --- |
| `1d4df3a` | D02 OpenCode adapter 功能提交（已合并输入，本增量不改其语义） |
| `b470270` | `--serve opencode` 入口接线 + D02/入口治理绑定 + 黑盒驱动 |
| `1af8fe5` | 取消用例去竞态；黑盒驱动支持 `AGENTTEAMS_CLI` 安装副本 |

`b470270` 的父提交是 `1d4df3a`，`1d4df3a` 的父提交是 `48ce0c9`；`1af8fe5` 是本 receipt
绑定的候选树（源码 + 测试 + 驱动）。分支未 push、未合并 main、未改写历史。本 receipt 由
`1af8fe5` 之后的 docs-only 提交携带。

## 2. 变更文件与 owner

| 文件 | owner | 变更 |
| --- | --- | --- |
| `runtime/acp-serve.ts`（新增） | runtime | 唯一 `--serve` 入口：读/编译 v4 agent intent、typed 拒绝、启动单 daemon + 单引擎、readiness 取自引擎 `session/new`、loopback 监听、显式信号停止 |
| `runtime/acp-serve.spec.ts`（新增） | runtime | 入口定向 spec：9 条无引擎语义 + 2 条真实引擎用例（prompt/cancel 与 permission） |
| `cli/agentteams.mjs` | runtime | `--serve/--ip/--port/--config` 解析、dispatch、typed fault code、`acp-serve` 编译产物加载 |
| `cli/agentteams.spec.ts` | runtime | `--serve` 参数解析、dispatch 与 typed fault 透传共 4 条 |
| `agent-host/acp-host.ts` | agent-host | 导出既有 `rpcErrorFrame`，作为唯一 ACP JSON-RPC 错误信封 |
| `config/daemon-intent.ts` | config | 导出既有 `isAgentIntent` 判定 |
| `tsconfig.runtime.json` | runtime | 编译闭包加入 `runtime/acp-serve.ts` 与 `opencode-adapter/src/acp-engine.ts` |
| `docs/architecture/verification-map.json` | 治理 | 新 gate `teams-acp-d02-opencode`；`teams-acp-serve-entry` design → partial；修正两条过期陈述 |
| `docs/architecture/function-map.json` | 治理 | 新函数绑定 `acp_engine_adapter_opencode`、`acp_serve_entry`；`acp_host_session_semantics` 增 `rpcErrorFrame`；替换"无 adapter 编译 launch spec"陈述 |
| `docs/architecture/mainline-call-map.json` | 治理 | `acp-serve-entry-v1` design → partial 并新增步骤/边/绑定；替换三条过期陈述 |
| `docs/architecture/module-registry.json` | 治理 | `opencode-adapter` 与 `runtime` 条目说明其唯一 owner 与 gate |
| `docs/development-governance.md` | 治理 | D02 与 serve-entry gate 行，以及 `--serve dsh` 未接线的说明 |
| `docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs`（新增） | 证据 | 真实 CLI 进程黑盒驱动 |
| `docs/evidence/acp-d02-integration-20261010/notes.md` | 证据 | 本文件 |

未改：`opencode-adapter/**` 任何文件、`runtime/agent-process.ts`、`runtime/acp-daemon.ts`、
`acp-adapter/**`、`.appsdk/**`。

## 3. 设计要点（唯一 owner，无第二路径）

1. **唯一入口**：`runtime/acp-serve.ts` 是 `--serve` 的唯一实现。`cli/agentteams.mjs` 只做
   flag 解析、dispatch 和编译产物加载，不含 ACP/引擎语义。
2. **唯一 launch spec 编译器**：`openCodeAcpAdapter.compileLaunch`。入口不自行拼 OpenCode
   配置，也不新增第二个配置编译器。
3. **唯一错误信封**：`rpcErrorFrame`（agent-host 导出）。入口对 host 拒绝的帧用它回
   JSON-RPC error，不定义第二种错误形状。
4. **唯一引擎帧传输**：`createStdioAcpDuplex`（D01）。入口的每个 loopback 连接就是一个
   ACP channel，复用同一 newline-delimited JSON 编解码，不新增帧协议。
5. **readiness 诚实**：入口自己捕获唯一一次真实 `session/new` 响应，把它交给
   `verifyEffective`；只有引擎返回的 `modelTarget` 非空时才报 `model=<provider/model>`，
   否则报 `model=unverified`。入口不猜测模型。
6. **绑定缺失即失败**：接受的配置若没有该 agent 的 provider/model 绑定，入口以 typed
   `UNSUPPORTED_CONFIGURATION` 失败并指名 `binding=model.primary`，绝不启动引擎后依赖引擎
   默认模型。这是入口层要求，adapter 库级行为未变。
7. **单 daemon**：一个 v4 文件仍只声明一个 daemon；入口只启动该 daemon 和它的一个引擎
   子进程，不启动隐式 control/registry。
8. **`--serve dsh` 显式拒绝**：本增量未交付组合 DSH adapter 的 serve 接线（D03 adapter 已在
   源码层存在，见 `dsh-adapter/**`），入口返回 typed `UNSUPPORTED_CONFIGURATION`，不 fallback
   到 opencode。集成提交修正了该消息文本，使其陈述真实原因（见 §11.4）。
9. **监听只 loopback**：非回环监听以 typed fault 拒绝，而不是无 TLS/无准入地服务。
   跨 agent 准入与协商属于 D05。

## 4. 源码与定向测试证据

命令均在 worktree 根目录执行。

| 面 | 命令 | 结果 |
| --- | --- | --- |
| D02 adapter（gate `teams-acp-d02-opencode`） | `pnpm exec vitest run opencode-adapter --no-file-parallelism` | 4 files / **65 passed**，含 4 条真实引擎用例（对已安装 `opencode 1.18.23` + 本地 stub provider） |
| D01 focused（gate `teams-acp-d01-host`） | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts --no-file-parallelism` | 4 files / **53 passed** |
| 入口（gate `teams-acp-serve-entry`） | `pnpm exec vitest run runtime/acp-serve.spec.ts --no-file-parallelism` | **11 passed**（9 条无引擎 + 2 条真实引擎）；连续 3 次 11/11，并在 `pnpm build` 并发下再跑一次 11/11 |
| CLI 入口 | `pnpm exec vitest run cli/agentteams.spec.ts --no-file-parallelism` | **28 passed**（含 `--serve` 4 条） |
| 配置 gate | `pnpm exec vitest run config/daemon-intent.spec.ts config/acp-policy.spec.ts --no-file-parallelism` | **35 passed** |
| 安装包 gate | `pnpm exec vitest run cli/package-install.spec.ts --no-file-parallelism` | **24 passed**（真实 `pnpm pack` + 安装） |
| 受影响套件合并跑 | `pnpm exec vitest run cli opencode-adapter runtime acp-adapter agent-host/acp-host.spec.ts --no-file-parallelism` | **42 files / 494 passed, 0 failed**（clean tree，`1af8fe5`） |

`cli/package-install.spec.ts` 内含 `scripts/receipt-identity.mjs` 的候选身份检查：它要求
工作树 clean，且不接受未跟踪的产品路径。**未提交的脏树或未跟踪文件必然失败**
（`receipt identity: staged product does not match the recorded index` 或
`generated/modules/teams-source/package-receipt.json` 缺失），提交后通过。这是候选状态
检查，不是内容不匹配。本增量两次在测试运行期间写入未提交文件，两次都复现该失败，也两次
在提交后消失。

真实引擎的 cancel 用例曾出现一次竞态失败：旧断言收到任意 `session/update` 后就发
`session/cancel`，因此取消可能早于 provider 请求本身，引擎会以 error frame 回应
`prompt-1`，而不是 `cancelled`。现在改为等待 stub provider 的 `PROBE-START` 分片（证明
请求已在飞行中）并把慢分支窗口放宽到 30s，断言同时打印整个 frame。这是测试竞态，不是入口
语义缺陷：入口转发的是引擎自己的响应，未做任何改写。

入口 spec 覆盖的语义（`runtime/acp-serve.spec.ts`）：

- quick-start（无 `--config`）以 typed fault 指名缺失 `model.primary`；
- 无 `--config` 时缺 `--ip`/`--port`、只给 `--ip` 均拒绝；
- `--serve dsh` 以 `--serve dsh is not delivered in this increment` 拒绝（集成提交后的消息，
  见 §11.4）；
- 控制 daemon 配置被拒（`requires an agent daemon config`）；
- 无 `[model.primary]` 的配置以 `agent <id> has no provider/model binding` 拒绝；
- 非回环监听被拒；不可读配置文件被拒；
- `--ip/--port` 覆盖生效并可从同一 intent 读回；
- 可执行文件解析顺序：配置绝对路径 → `AGENTTEAMS_OPENCODE_EXECUTABLE`/`OPENCODE_EXECUTABLE`
  → `PATH`；非绝对路径与找不到时报错；
- 真实引擎：一个 daemon + 一个引擎子进程、readiness 报 `probe/probe-model`
  （`session/new configOptions`）、真实 prompt 到达 stub provider、真实 cancel 得
  `stopReason=cancelled`、真实 `session/request_permission` 回调经监听器往返并释放工具、
  停止返回真实 `EngineStopResult`。

## 5. typecheck / build

| 面 | 命令 | 结果 |
| --- | --- | --- |
| 全量 typecheck | `pnpm typecheck` | exit 0（根 `tsc --noEmit` + adapter/console-host/ui typecheck） |
| 运行时构建 | `pnpm build:runtime` | exit 0，产出 `generated/runtime-lib/runtime/acp-serve.js` 与 `generated/runtime-lib/opencode-adapter/src/acp-engine.js` |

## 6. 真实用户入口黑盒（源码树与安装副本）

### 6.1 源码树入口

驱动：`docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs`
（`node docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs`）。
它自己起一个本地 OpenAI 兼容 stub provider，写一份 v4 agent 配置，然后以真实子进程运行
用户入口：

```
node cli/agentteams.mjs --serve opencode --ip 127.0.0.1 --port <free> --config <agent.toml>
```

结果 **BLACK-BOX PASS**。关键输出（一次真实运行）：

```
serving agent=reasoner-a engine=opencode engineInstance=opencode-reasoner-a-28d4a4a4-... enginePid=52252 daemonPid=52237 listener=127.0.0.1:63313 dataDirectory=.../state config=.../agent.toml model=probe/probe-model modelVerification=session/new configOptions effectiveRevision=1
stopped agent=reasoner-a enginePid=52252 engine=exited code=null signal=SIGTERM channels=1
```

黑盒断言（全部通过，逐条打印 `ok:`）：

1. 入口报 `engine=opencode`，`model=probe/probe-model`，`modelVerification=session/new configOptions`；
2. 入口报的 `daemonPid` 就是真实 CLI 进程 pid；
3. 引擎 pid 是活进程，`ps` 命令行为 `<opencode 路径> acp --pure`；
4. daemon **恰好一个**子进程，且就是它报的引擎 pid；
5. `initialize` 返回真实结果，`session/new` 返回真实 `ses_...` session；
6. 真实 prompt 触发真实 `session/request_permission`，选项为 `once,always,reject`；
   回复 `once` 后工具真正执行，prompt 以 `end_turn` 结束；
7. stub provider 确实收到 `model=probe-model` 的请求；
8. 第二个 prompt 被真实 `session/cancel` 结束，`stopReason=cancelled`；
9. 对显式 pid `kill -TERM` 后入口打印 `engine=exited` 停止回执，引擎 pid 消失，daemon
   无残留子进程，CLI 以 **exit code 0** 退出；
10. `dataDirectory/acp-history.json` 含 `request.dispatched` 与 `result.received`。

真实 CLI 层的 typed 拒绝也直接验证过（真实进程，非 mock）：

```
$ node cli/agentteams.mjs --serve opencode --ip 127.0.0.1 --port <free>
UNSUPPORTED_CONFIGURATION: agent agent has no provider/model binding: the quick-start config declares no [model.primary]; ...
exit=1
$ node cli/agentteams.mjs --serve dsh --ip 127.0.0.1 --port <free>
UNSUPPORTED_CONFIGURATION: --serve dsh is not delivered: no DSH engine adapter exists in this increment, only --serve opencode
exit=1
```

> 上面两条 `--serve dsh` 原文是候选 `1af8fe5` 的真实输出。该消息的前提（"no DSH engine
> adapter exists"）在集成时已过期：D03 adapter 已在 `main` 源码层存在。集成提交只改消息
> 文本、保留 typed 拒绝，修正后的输出见 §11.4。

### 6.2 安装副本入口（B1 的安装证据）

同一驱动通过 `AGENTTEAMS_CLI` 可以驱动另一份入口副本。安装步骤（在 clean 候选树上）：

```
pnpm build
node scripts/package-artifact.mjs --mode base        # -> generated/modules/teams-source/lib
npm pack generated/modules/teams-source/lib --pack-destination "$WORK" --json
mkdir -p "$WORK/app" && cd "$WORK/app" && npm init -y && npm install "$WORK/agentteams-0.1.0.tgz"
```

基础包回执：`package artifact base agentteams@0.1.0
e70b9c15f2bfeb91770cca771b8a3e1a660f123caeefba42b35ffa674810aa83`。
tarball 确实包含新产物：`package/generated/runtime-lib/runtime/acp-serve.js` 与
`package/generated/runtime-lib/opencode-adapter/src/acp-engine.js`（打包按
`package.json` 的 `files` 复制整个 `generated/runtime-lib`，无需改 `.appsdk` 准入）。

然后用安装后的用户入口（`node_modules/.bin/agentteams`，即 `bin` 字段指向的 CLI）重跑同一
黑盒：

```
AGENTTEAMS_CLI="$WORK/app/node_modules/.bin/agentteams" \
  node docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs
```

结果 **BLACK-BOX PASS**，与源码树同一条断言集全部 `ok:`。关键输出：

```
cli=/tmp/d02-installed-3jRAdp/app/node_modules/.bin/agentteams
serving agent=reasoner-a engine=opencode engineInstance=opencode-reasoner-a-6e934905-ecad-4a39-8799-bf54ca9f0710 enginePid=8311 daemonPid=8299 listener=127.0.0.1:64858 dataDirectory=.../d02-serve-blackbox-NDE0qx/state config=.../d02-serve-blackbox-NDE0qx/agent.toml model=probe/probe-model modelVerification=session/new configOptions effectiveRevision=1
  ok: the reported engine pid 8311 is a live process: 8311  8299 /Users/fanzhang/.opencode/bin/opencode acp --pure
  ok: the daemon has exactly one child process (8311:/Users/fanzhang/.opencode/bin/opencode acp --pure)
  ok: the one child is the reported engine pid
  ok: the entry served a real initialize result
  ok: the entry created a real engine session (ses_ed59e287dffeJsYO5anlNkK9G6)
  ok: the permission callback offered the real options (once,always,reject)
  ok: the permission reply released the tool and the prompt completed (end_turn)
  ok: the stub provider really received a request for the accepted model
  ok: the cancel notification ended the in-flight prompt (cancelled)
stopped agent=reasoner-a enginePid=8311 engine=exited code=null signal=SIGTERM channels=1
  ok: the engine pid 8311 is gone after the stop
  ok: the daemon left no child process behind
  ok: the entry exited cleanly by explicit PID (code=0 signal=null)
  ok: the daemon wrote its durable execution history

BLACK-BOX PASS: one daemon + one engine child, verified model, prompt, permission callback, cancel, explicit-PID stop.
{"daemonPid":8299,"enginePid":8311,"sessionId":"ses_ed59e287dffeJsYO5anlNkK9G6","providerCalls":4,"model":"probe/probe-model","modelVerification":"session/new configOptions","stop":"stopped agent=reasoner-a enginePid=8311 engine=exited code=null signal=SIGTERM channels=1"}
```

安装副本的 typed 拒绝同样直接验证：

```
$ node node_modules/agentteams/cli/agentteams.mjs --serve opencode --ip 127.0.0.1 --port 63999
UNSUPPORTED_CONFIGURATION: agent agent has no provider/model binding: ...   (exit 1)
$ node node_modules/agentteams/cli/agentteams.mjs --serve dsh --ip 127.0.0.1 --port 63999
UNSUPPORTED_CONFIGURATION: --serve dsh is not delivered: ...               (exit 1)
```

> 同上：该文本是候选 `1af8fe5` 的原始输出，集成提交已把消息改为陈述真实原因（§11.4）。

### 6.3 停止路径上修掉的一个真实缺陷

黑盒期间发现并修掉一个真实缺陷：停止时入口只 destroy 传输 socket，没有关闭 host 侧
channel，而 host 的 `read` 对已关闭 channel 仍返回空页，导致投递循环每 5ms 轮询一次、
进程永不退出。修法在入口自己的 owner 内：停止时对每个活 channel 调用
`daemon.host.close(ref)`，且投递循环以入口自己的 channel map 作为存活判据。修后黑盒与
spec 均通过。host 的该不对称（`receive` 拒绝已关闭 channel，`read` 不拒绝）记录为
advisory，未改 D01 源码。

## 7. 治理绑定与 map 校验

- 新 gate `teams-acp-d02-opencode`（owner opencode-adapter，`partial`，可执行命令
  `pnpm exec vitest run opencode-adapter --no-file-parallelism`），note 说明它是源码 +
  真实引擎证据、该 adapter gate 命令本身不含安装副本、不含 D03（安装副本证据在入口 gate
  与第 6.2 节）。
- `teams-acp-serve-entry`（owner runtime）从 `design` 升为 `partial`，`planned_command`
  换成真实 `command`（`pnpm exec vitest run runtime/acp-serve.spec.ts cli/agentteams.spec.ts
  --no-file-parallelism`），note 指名仍缺的部分（D03/D04/D05、仅 loopback），并记录安装
  副本证据及其边界（本地 base 包安装，不是发布产物或 AppSDK 生命周期回执）。
- `teams-acp-d01-host` 与 `teams-acp-daemon-intent` 的过期陈述已替换（不再声称 `--serve`
  未接线、D02 adapter 不存在）。
- 同一变更内绑定 owner、路径与 gate：`function-map` 新增 `acp_engine_adapter_opencode` 与
  `acp_serve_entry`，`mainline-call-map` 新增 `acp-serve-entry-v1` 的三条边与三条
  planned_binding，并把"无 engine adapter 编译 launch spec"、"无 CLI `--serve` caller"
  三处陈述替换为事实。

校验命令（只读）：

```
python3 - <<'PY'   # 见 run notes 同名脚本
# 1) 五个 docs/architecture/*.json 用 object_pairs_hook 解析，重复键即抛错
# 2) function-map 与 mainline-call-map 的所有 required_gates 必须存在于 verification-map
# 3) edges/planned_bindings 引用的 chain_id 必须已声明
PY
```

结果：五个 map 全部解析通过、无重复键；`required_gates` 无悬挂；ACP 五个 gate 都有可执行
命令。唯一未通过的子检查是两条 **本变更之前就存在** 的 chain 引用
（`endpoint-discovery-admission-v1`、`session-control-v1` 被边引用但未在 `chains` 声明），
在 `HEAD`（`1d4df3a`）上完全相同，本增量未触碰，作为 advisory 留给主集成。

## 8. 明确 NOT proven（不得从前一层推断）

1. **安装副本证据的边界**：安装副本证据是本地 `npm pack` + `npm install` 的 base 产物，
   由 `node_modules/.bin/agentteams` 驱动（第 6.2 节）。它不是发布/registry 产物，不是
   `pnpm smoke:installed` 的 AppSDK 生命周期回执，也未做 restart 重放。
2. **无 AppSDK compile/verify**：仍被既有 pin 不匹配（`0.1.0014` / `0.1.0013`）阻塞。
   本增量未改 `.appsdk/**`，也未宣称 SDK 生命周期状态变化。
3. **无 `--serve dsh`**：DSH adapter 在源码层存在（D03），但组合它的 serve 接线不在本增量；
   `--serve dsh` 是 typed 拒绝，不是可用路径。
4. **无 D04/D05**：没有注册/心跳就绪，也没有 Teams 连接协商。监听器只服务回环，channel
   principal 取 daemon 自身身份；跨 agent 准入与协商未实现。
5. **无网络/UI/历史读取入口**：D06 历史读取、Console/UI 显示均未实现。
6. **无全量回归**：本增量只跑受影响 focused 套件（含合并跑 42 files / 494 passed）、
   `pnpm typecheck` 与 `pnpm build:runtime`，不宣称全量 `pnpm test` 或 `pnpm verify` 通过
   （`pnpm verify` 含被 pin 阻塞的 `appsdk compile/verify`）。
7. **旧 Work 入口未变**：`runtime/agent-process.ts` 仍是 Work 入口，`--serve` 没有替换它，
   也没有共享它的路径。

## 9. 资源与清理

- 独占 worktree：`/Volumes/Intel/playground/agentteams/acp-d02-serve-20261010`，owner = 本
  worker，保留到主集成完成 review/merge/远端回执后回收。
- Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d02-serve-20261010/`
  （含黑盒日志 `black-box-serve.log`）。
- 黑盒自起的 stub provider、引擎子进程与临时目录由驱动在 `finally` 中按显式 PID 清理；
  运行中一次驱动失败曾留下 3 个残留进程，已用显式 PID（`5286`、`71316`、`78055`/`78060`）
  停止，无 `pkill`/`killall`。当前无残留 `agentteams --serve` 或 `opencode acp` 进程。
- 未删除或改动他人 worktree、旧 ACP 材料或共享 base。
- 安装副本证据使用临时目录（`/tmp/d02-installed-*`：pack 输出 + `npm install` 目标）与
  驱动的临时 `mktemp` 目录；两者都是本 worker 自建，记录路径后删除。
- 本增量未改 `.appsdk/**`；AppSDK 的 pin 不匹配属于既有环境状态，本 worker 未尝试绕过。

## 10. 记录给主集成的 advisory（本增量未修）

1. **host 的 read/close 不对称**（D01 owner）：`agent-host/acp-host.ts` 的 `close()` 只把
   channel 标记为 closed，`read()` 仍对已关闭 channel 返回空页（`receive()` 则拒绝
   `CONFLICT`）。后果是任何投递循环必须在自己的存活判据上结束，否则空转。本增量在入口
   owner 内处理，未改 D01 源码。
2. **adapter 的真实引擎 spec 会静默 skip**（D02 owner，review A4）：
   `opencode-adapter/tests/acp-engine.real.spec.ts` 用 `skipIf` 在缺少已安装 opencode 时
   跳过，gate 输出只显示 skipped，不显示原因。建议后续让 skip 打印原因，或在 gate 命令
   上要求真实引擎存在。
3. **真实引擎 spec 绑定固定版本**（D02 owner，review A3）：真实用例针对已安装
   `opencode 1.18.23` 编写，升级引擎需要复核断言与声明的 method/policy 集合。
4. **端到端只证明 `read` 工具**（D02 owner，review A6）：本 receipt 的 permission 回调
   只覆盖 `read`（经 `/etc/hosts`）这一个工具的执行路径；其他工具未端到端证明。
5. **`index` 与 `acp-engine` 的循环导入**（D02 owner，review A7）：仍在，未在本增量处理。
6. **两条既有 chain 引用未声明**：`mainline-call-map.json` 的
   `endpoint-discovery-admission-v1`、`session-control-v1` 被边/绑定引用但不在 `chains`；
   在 `1d4df3a` 上同样存在，本增量未触碰。

## 11. 集成回执（merge `codex/acp-d02-serve-20261010` → 最新 main）

本节由 D02 集成 worker（shared-surface 单 writer）追加，记录把已 review 的 D02 候选并入
最新 `origin/main` 的结果。上面 §1–§10 是 D02 候选自己的 receipt，保持原样；本节只记录
集成边界的事实。

### 11.1 绑定的集成候选

| 项 | 值 |
| --- | --- |
| 集成分支 | `codex/acp-d02-merge-20261010` |
| 集成 worktree | `/Volumes/Intel/playground/agentteams/acp-d02-merge-20261010`（独占、clean、从 `origin/main` 新建） |
| 集成 base | `origin/main@dec2cbd`（D00 + D01 + D01 绑定 + D04 + D04 绑定 + D03 DSH adapter 核心 + D03 绑定） |
| 被合并的已 review 候选 | `codex/acp-d02-serve-20261010@9436aae`（base `48ce0c9`；提交 `1d4df3a` adapter、`b470270` serve 入口 + 绑定、`a91af7f`/`1af8fe5`/`9436aae` 证据与 cancel 竞态修复） |
| 合并方式 | 单一 merge commit（未 push、未合并 main、未改写历史） |
| 集成 merge commit | `PENDING_MERGE_HASH`（由紧随其后的 docs-only 提交记录，原因同 §1：receipt 不能活在它所绑定的提交里） |
| Run notes / 日志 | `/Volumes/Intel/playground/agentteams/.worker-runs/acp-d02-merge-20261010/`（`black-box-serve.log`、`five-map-validation.log`） |

### 11.2 review 历史（集成输入）

1. **第一次 milestone review：FAIL**，两个 finding：
   - 真实引擎 cancel 用例存在竞态：旧断言收到任意 `session/update` 就发 `session/cancel`，
     取消可能早于 provider 请求本身，引擎以 error frame 回应 `prompt-1` 而不是 `cancelled`；
   - receipt 过度声明：安装副本证据被写得比实际更强。
2. **修复**：`1af8fe5`（cancel 用例改为等待 stub provider 的 `PROBE-START` 分片以证明请求
   已在飞行中，慢分支窗口放宽到 30s 并打印完整 frame；黑盒驱动支持 `AGENTTEAMS_CLI`
   安装副本）与 `9436aae`（记录安装副本回执与 advisory，收敛 receipt 声明）。
3. **聚焦 re-review：PASS**：独立复现 **10/10** 次 `runtime/acp-serve.spec.ts` 运行与
   **4/4** 次黑盒运行通过。

### 11.3 冲突解决（union，两侧事实都不丢）

`git merge` 报告 7 个冲突文件；`cli/agentteams.spec.ts` 自动合并（两侧用例都在）。

| 文件 | 解决 |
| --- | --- |
| `cli/agentteams.mjs` | 3 处机械 hunk 全部 union：`usage()` 同时列出 `registry start\|status\|stop` 与 `--serve <opencode\|dsh>` 两行，并保留 `serveUsage()`；`parseArgs` 同时保留 `registry` 与 `--serve`/`--serve=` 两条 dispatch；`defaultRuntime` 同时 import `acpServe` 与 `registryProcess` 并合并两者导出（`{ localConfig, localWorkControl, ...acpServe, ...localProcess, ...registryProcess }`） |
| `tsconfig.runtime.json` | `include` 取并集：保留 main 全部条目（D01 `network/wss-connection.ts`、`agent-host/**`、`runtime/acp-*`、`acp-adapter/stdio.ts`，D04 `network/registration-client.ts`、`server/registry-intent.ts`、`runtime/registry-process.ts`、`runtime/registry-registration.ts`，D03 `dsh-adapter/index.ts`、`dsh-adapter/native-config.ts`），加入 D02 的 `runtime/acp-serve.ts` 与 `opencode-adapter/src/acp-engine.ts`；无重复、无丢失 |
| `docs/architecture/function-map.json` | 保留 main 的 D01/D03/D04 行；新增 D02 的 `acp_engine_adapter_opencode` 与 `acp_serve_entry`；`acp_host_session_semantics` 增 `rpcErrorFrame`；修正 `engine_adapter_port`、`acp_stdio_duplex_transport`、`acp_daemon_child_wiring`、`daemon_intent_compilation` 四条声称 OpenCode adapter / `--serve` 调用方不存在的陈述 |
| `docs/architecture/mainline-call-map.json` | `acp-serve-entry-v1` design → partial（取 D02 的 steps/note 并修正 DSH 措辞）；新增 D02 的 3 条边与 3 条 `acp-serve-entry-v1` planned_binding + 1 条 `acp-host-wiring-v1` opencode-adapter binding；保留 main 的 D03/D04 链、边与绑定；修正 `acp-host-wiring-v1`/`acp-dsh-engine-v1`/`acp-registry-v1` 的过期措辞 |
| `docs/architecture/module-registry.json` | runtime 条目并集（D02 的 serve 句 + main 的 D04 registry 句）；新增 opencode-adapter 条目说明；修正 cli-facade、agent-host、acp-adapter、dsh-adapter 四条过期陈述 |
| `docs/architecture/verification-map.json` | 保留 main 的 D01/D03/D04 gate 行；新增 `teams-acp-d02-opencode`；`teams-acp-serve-entry` design → partial（可执行 `command` 取代 `planned_command`）；修正 `teams-acp-daemon-intent`、`teams-acp-d01-host`、`teams-acp-d04-registry` 三条过期 note |
| `docs/development-governance.md` | gate 表保留 D01/D03/D04 行并新增 D02 与 serve-entry partial 行；恢复 D02 的两段说明与 D01 段落中的 D02 句；修正 D03/D04 段落的过期措辞 |
| `docs/architecture/resource-map.json` | 非冲突，但 `daemon-intent-config` 的 note 重复"`--serve` 未接线、OpenCode adapter 缺失"这一过期前提，按同一事实修正 |
| `docs/design/teams-acp-daemon-config-v4.md` | 非冲突；§10 的"`--serve` 保持未接线"改为 opencode 已接线、DSH serve 接线未交付 |
| `AGENTS.md` | 非冲突；D00 段落的"`--serve` runtime wiring … stay pending"改为列出 D01–D04 已在源码层交付，仅 DSH serve 接线、网络协商与 UI 仍 pending |

`git merge` 期间有两个**非冲突**区域被 3-way merge 自动合入 D02 内容
（`mainline-call-map.json` 的 `planned_bindings` 4 条改动、`development-governance.md` 的
preamble 句与 D01 段落 D02 句）。解析冲突时先按 main 侧重置这 5 个文件，因此这些自动
合入的内容已在上表条目中显式重建，未丢失。

**reviewed 内容存活证明**（在修正 `--serve dsh` 消息之前执行）：

```
$ git diff --stat 9436aae -- runtime/acp-serve.ts runtime/acp-serve.spec.ts opencode-adapter/src/acp-engine.ts opencode-adapter/src/index.ts opencode-adapter/tests/
（空输出）
```

即 D02 的 adapter、入口、spec 与 `opencode-adapter/tests/**` 与已 review 候选 `9436aae`
逐字节一致。之后的唯一改动是 §11.4 的消息修正（`runtime/acp-serve.ts` 1 行、
`runtime/acp-serve.spec.ts` 2 行），不涉及 adapter 与测试目录。

### 11.4 `--serve dsh` 消息修正（原前提已过期）

`runtime/acp-serve.ts` 保留 typed 拒绝（serve 入口不组合 DSH），但不再声称 DSH adapter
不存在。修正后的真实输出：

```
UNSUPPORTED_CONFIGURATION: --serve dsh is not delivered in this increment: the DSH engine adapter exists at source level (dsh-adapter/**), but the serve wiring that composes it is not delivered; a follow-up increment wires --serve dsh. Only --serve opencode is wired.
```

同步修正：`runtime/acp-serve.spec.ts` 的用例名与断言；`docs/design/teams-acp-daemon-config-v4.md`
§10；`docs/architecture/{function,mainline-call,module-registry,verification,resource}-map.json`
与 `docs/development-governance.md` 中重复该前提的 note；根 `AGENTS.md` 的 D00 段落。
本增量**未实现** `--serve dsh`。

### 11.5 合并树上的验证（本轮实测）

| # | 命令 | 结果 | 预期 |
| --- | --- | --- | --- |
| 1 | `pnpm exec vitest run opencode-adapter runtime/acp-serve.spec.ts --no-file-parallelism` | **5 files / 76 passed**（含 4 条真实引擎用例，对已安装 opencode 1.18.23 + 本地 stub provider） | 5 files / 76 ✓ |
| 2 | `pnpm exec vitest run --no-file-parallelism cli/agentteams.spec.ts` | **1 file / 30 passed** | 28 ✗（见下） |
| 3 | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts --no-file-parallelism` | **4 files / 53 passed** | 53 ✓ |
| 4 | `pnpm exec vitest run dsh-adapter --no-file-parallelism` | **2 files / 28 passed** | 28 ✓ |
| 5 | `pnpm exec vitest run --no-file-parallelism server/relay.spec.ts network/relay-client.spec.ts network/registration-client.spec.ts server/registry-intent.spec.ts runtime/registry-process.spec.ts runtime/registry-registration.spec.ts` | **6 files / 73 passed** | 73 ✓ |
| 6 | `pnpm typecheck` | exit **0**（根 `tsc --noEmit` + opencode-adapter/console-host/ui typecheck） | exit 0 ✓ |
| 7 | `pnpm build:runtime` | exit **0**，产出 `generated/runtime-lib/runtime/acp-serve.js`、`generated/runtime-lib/opencode-adapter/src/acp-engine.js`、`generated/runtime-lib/dsh-adapter/index.js`、`generated/runtime-lib/runtime/registry-process.js` | exit 0 ✓ |
| 8 | `node docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs` | **BLACKBOX_EXIT=0**，BLACK-BOX PASS：单 daemon + 单引擎子进程、`model=probe/probe-model`（`session/new configOptions`）、真实 prompt、真实 permission 回调、真实 `session/cancel` → `cancelled`、对显式 PID `kill -TERM` 后引擎退出且 daemon 无残留子进程、CLI exit 0（`enginePid=99571`） | BLACKBOX_EXIT=0 ✓ |
| 9 | 五图校验（parse + 重复键 + `required_gates` 悬挂） | 5 个 map 全部解析、无重复键；73 个 gate；`required_gates` 无悬挂；`function_id`/`module_id` 无重复 | ✓ |

**第 2 项偏离说明（30 ≠ 28）**：预期 28 是 D02 分支自己的数字。并集合并后
`cli/agentteams.spec.ts` 必须同时包含两侧用例：base `48ce0c9` 有 24 条，main `dec2cbd`
经 D04 增加 2 条 registry 用例（`registry start/status/stop` 路由、registry 参数拒绝），
D02 增加 4 条 `--serve` 用例（24 + 2 + 4 = 30）。30/30 通过即两侧事实都在；若为 28 反而
说明 D04 的 registry 用例被丢弃。

### 11.6 明确 NOT proven（本轮集成同样不证明）

1. **无发布产物/安装 tarball 回执**：本轮**未**重跑 `npm pack` + `npm install` 安装副本黑盒。
   D02 receipt §6.2 的安装副本证据来自候选 `1af8fe5`，是本地 base 包安装、由
   `node_modules/.bin/agentteams` 驱动，不是 registry/发布产物，也不是
   `pnpm smoke:installed` 的 AppSDK 生命周期回执，且未做 restart 重放。
2. **无外部 LLM 推理**：本轮黑盒与真实引擎用例都打到本地 OpenAI 兼容 stub provider；
   没有真实外部 LLM 供应商调用，也没有 live provider replay。
3. **无 `--serve dsh`**：DSH adapter 在源码层存在（D03），但组合它的 serve 接线不在本增量，
   `--serve dsh` 仍是 typed 拒绝。
4. **AppSDK pin 仍阻塞**：`.appsdk/**` 本轮未改动；`appsdk compile/verify` 仍被既有
   `0.1.0014`/`0.1.0013` pin mismatch 阻塞，因此未运行 `pnpm verify`，也不宣称 SDK 生命周期
   状态变化。
5. **未重跑全量 `pnpm test`**：本轮只跑受影响 focused 套件（第 1–5 项）、`pnpm typecheck`、
   `pnpm build:runtime` 与提交的黑盒；未跑 `pnpm test`
   （`pnpm build:runtime && opencode-adapter build && node scripts/regression.mjs`）、
   `pnpm smoke` 或 `pnpm smoke:installed`。
6. **未 push、未合并 main**：本轮只产出集成分支上的 merge commit；远端回执、main 集成与
   worktree 回收由主集成 owner 执行。
7. **D02 receipt §10 的 advisory 未修**：host `read`/`close` 不对称、真实引擎 spec 静默 skip、
   真实用例绑定固定 opencode 版本、端到端只证明 `read` 工具、`index`/`acp-engine` 循环导入、
   两条既有未声明 chain 引用（`endpoint-discovery-admission-v1`、`session-control-v1`）。

### 11.7 资源与清理

- 集成 worktree `/Volumes/Intel/playground/agentteams/acp-d02-merge-20261010` 为本次独占创建，
  owner = 本集成 worker，保留到主集成完成 review/merge/远端回执后回收。
- 依赖用 `pnpm install --frozen-lockfile` 装入（788ms，走本地 store）；未改动 lockfile。
- 黑盒自起的 stub provider、引擎子进程与临时目录由驱动在 `finally` 中按显式 PID 清理；
  运行后 `ps` 无残留 `agentteams`/`opencode acp` 进程。全程只用显式 PID，无
  `pkill`/`killall`。
- 未删除或改动他人 worktree、旧 ACP 材料或共享 base。
