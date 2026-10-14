# D06 PART 2 证据（2026-10-11）

任务：`task-10`，D06 控制守护进程 PART 2。工作树
`/Volumes/Intel/playground/agentteams/acp-d06-part2-20261011`，分支
`codex/acp-d06-part2-20261011`，基线 `448813a`（`origin/main` 合并点 `cf551b1`）。
本次未 merge、未 push、未改动其它工作树。

## 1. 交付文件

| 文件 | 交付内容 |
| --- | --- |
| `runtime/control-process.ts` | 删除本地 `ControlNetworkStatusPort` 别名，在唯一注入点改用 D05 owner `createTeamsStatusPort`；新增 `createControlNetworkStatus(intent, env)` 组合真实 ledger / history / registration / membership |
| `agent-host/acp-host.ts` | 新增引擎侧 permission option 决策路径：`projectPermissionOptions` 投影引擎真实 `options`，`adjudicatePermissionReply` 按真实 `optionId` 裁决，拒绝时落一条持久 `callback.denied` |
| `runtime/control-process.spec.ts` | 真实端口绑定的红绿测试（真实投影、真实历史、显式停止） |
| `agent-host/acp-host.spec.ts` | A2.6 决策路径测试（投影、裁决、端到端、畸形集合） |
| `runtime/acp-serve.spec.ts` | 线面回执断言更新为真实 option 集合与 `optionId` |
| `docs/design/teams-acp-daemon-config-v4.md` | 原样带入 D00 amendment A2 条文；D06/D07 行改为真实交付与交接面 |
| `docs/architecture/*.json` | `function-map`、`mainline-call-map`、`module-registry`、`verification-map` 增量更新 |
| `docs/development-governance.md` | `teams-acp-d06-control` 门禁条目 |
| `docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | PART 1 期望更新为真实端口绑定后的线面（未声明目标的 `FORBIDDEN` 拒绝、真实空页） |
| `docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs` | PART 2 真实端口绑定黑盒（7 检查） |
| `docs/evidence/acp-d06-part2-20261011/black-box-permission-option.mjs` | PART 2 真实 permission `optionId` 黑盒（10 检查） |

## 2. 真实黑盒

### 2.1 `black-box-permission-option.mjs`（10/10 PASS，exit 0）

真实入口：`agentteams --serve opencode` 真实 CLI 入口 + 真实已安装 OpenCode 引擎
（`/Users/fanzhang/.opencode/bin/opencode`）+ 本地 OpenAI 兼容 stub provider + 真实
ACP 客户端（loopback listener）。**未使用任何 mock 引擎或 mock 控制面。**

| 检查 | 观测事实 |
| --- | --- |
| 真实入口就绪 | `daemonPid`/`enginePid` 均为真实子进程，`model=probe/probe-model` |
| 真实引擎会话 | `session/new` 返回真实 `sessionId` |
| 引擎真实 option 集合 | `once/allow_once,always/allow_always,reject/reject_once`（真实 ACP `kind`） |
| 冻结词表投影逐字一致 | `ids=[once,always,reject] projected=[once,always,reject]`，未铸造同义词 |
| 外来 `optionId` 被拒 | `optionId=option-the-engine-never-offered` 未转发给引擎、未发 `cancelled`、prompt 仍 pending |
| 拒绝是持久事实 | 持久历史出现一条 `callback.denied`（`sequence=15`），无对应 `callback.reply` |
| 同一回调仍可应答 | 引擎自己的 `optionId=once` 被原样转发，工具真实执行，`stopReason=end_turn` |
| 批准是持久事实 | `callback.reply`（`sequence=16`），`denials=1`（未追加第二次拒绝） |
| 新会话仍会询问 | 拒绝后新会话仍收到真实 permission 回调 `once,always,reject` |
| 缺失/过期回调不批准 | 伪造 `callback-id-no-pending-callback-holds` 未释放 prompt，无对应 `callback.reply` |
| 显式 PID 停止 | `code=0 signal=null engineAlive=false` |

关键实测语义（由真实引擎行为决定，非推断）：被拒的回复既不转发给引擎，也不代引擎补发
`cancelled`。因此引擎侧回调保持等待，同一个 pending 回调仍可被引擎自己的 `optionId` 正确应答。

### 2.2 `black-box-control-part2.mjs`（7/7 PASS，exit 0）

真实 `control start|status|stop` CLI + 真实绑定端口。证明真实 D05 owner 写入持久行、
真实端口投影与真实分页、连接变更被 typed 拒绝、显式 PID 清理。

### 2.3 `black-box-control.mjs`（PART 1，10/10 PASS，exit 0）

绑定真实端口后，PART 1 线面期望同步更新：投影必须带真实 `connections` 数组（无通道时为空）、
连接变更被 typed 拒绝、`kind=connection` 返回真实空页。

2026-10-14 更正：该配置声明 `[relations].allowed` 但不声明任何 `[peers]`，所以三条 A2.4 关系命令
（`connection.connect`、`connection.disconnect`、`network.membership.apply`）现在是目标不可解析的 typed
`FORBIDDEN` 拒绝，不再是 `UNSUPPORTED_OPERATION`；两个控制黑盒已按新期望更新并在本候选上重跑通过
（PART 1 10/10、PART 2 7/7，退出码 0）。

## 3. 定向门禁（真实命令与结果）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 根 `tsc --noEmit` + `ui/teams-console` 均通过 |
| `pnpm build` | 0 | 含 `build:runtime`、console-host 资源与 UI 编译 |
| `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | 0 | `Test Files 6 passed (6)`，`Tests 115 passed (115)`（acp-serve 26、control-process 14、cli/agentteams 33、acp-host 23、http-api 7、console-api 12） |
| D05 定向门禁（`network/teams-negotiation`、`teams-session`、`teams-connection-history`、`teams-membership`、`registration-client`、`runtime/registry-registration`、`teams-ingress`、`teams-status`、`control-protocol/teams-connection`） | 0 | `Test Files 9 passed (9)`，`Tests 73 passed (73)` |
| `node docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | 0 | 10 检查 PASS |
| `node docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs` | 0 | 7 检查 PASS |
| `node docs/evidence/acp-d06-part2-20261011/black-box-permission-option.mjs` | 0 | 10 检查 PASS |

## 4. 红绿证据（每项新增运行时/边界行为）

### 4.1 A2.6 回复裁决（单元级）

- 红：临时把 `receiveClientResponse` 的 `adjudicatePermissionReply(...)` 替换为直接透传 `frame`。
  命令 `pnpm exec vitest run --no-file-parallelism agent-host/acp-host.spec.ts -t 'permission option decision path'`
  → `RED_EXIT=1`，`Tests 1 failed | 3 passed | 19 skipped`，失败断言为
  `AssertionError: promise resolved "undefined" instead of rejecting`（外来 `optionId` 被当成批准转发）。
- 绿：恢复裁决后同一命令 → `GREEN_EXIT=0`，`Tests 4 passed | 19 skipped`。

### 4.2 A2.6 拒绝的持久事实（边界级）

- 红：临时删除 `receiveClientResponse` 中拒绝分支的持久 `callback.denied` 写入，
  重新 `pnpm build:runtime` 后运行 `black-box-permission-option.mjs` → `RED_BB_EXIT=1`，
  失败信息为 `the refusal left no durable callback.denied fact`，并打印出真实历史事件序列
  （`...callback.dispatched` 之后无任何拒绝记录）。
- 绿：恢复写入并重新构建后 → `GREEN_BB_EXIT=0`，10/10 PASS。

### 4.3 A2.7 真实 D05 端口绑定（运行时级）

红绿在 `runtime/control-process.spec.ts` 内完成：未注入端口时投影保持类型化缺席；
注入真实 owner 后投影带真实 `connections` 数组、`kind=connection` 返回真实冻结 `HistoryPage`、
`kind=request` 由同一 owner 拒绝。两条新增测试
（`binds the real D05 status port from the daemon own owners and stops it explicitly`、
`serves the real D05 connection projection and connection history over the wire`）
在 `runtime/control-process.spec.ts` 的 14 项全绿中覆盖。

## 5. 架构图变更（最小 diff）

| 图 | 变更 |
| --- | --- |
| `docs/architecture/function-map.json` | 追加 `control_process_lifecycle`、`permission_option_decision_path` 两条函数记录；`teams_status_port` 注记补充 D06 PART 2 单点消费；函数数 104 → 106 |
| `docs/architecture/mainline-call-map.json` | 追加 `acp-control-daemon-v1` 链与 4 条边；链 27 → 28，边 57 → 61 |
| `docs/architecture/module-registry.json` | 仅改 `runtime` 与 `agent-host` 两条 `note` 值，未整体重排格式 |
| `docs/architecture/verification-map.json` | 追加 `teams-acp-d06-control` 门禁（真实 spec 绑定，6 文件 / 115 测试）；门禁数 74 → 75 |
| `docs/architecture/resource-map.json` | 未改动（资源所有权未变） |

## 6. D07 交接面

D07 只消费 `control-protocol/console-api.ts` 的 Console DTO（含 `ConsolePermissionOption`
与 permission reply 形状），以及认证后的 `GET /api/v1/projection`、`GET /api/v1/history`、
`GET /api/v1/events`（真实 SSE，`text/event-stream` + `no-store`，事件携带完整
`{seq, projection}` owner 快照）。D07 不得自建第二历史源、不得自建第二个连接端口、
不得从 history 反推在线或执行状态。

## 7. 明确未交付 / 非声明（非目标）

以下均为**未做**，不得由本轮任何结果推断：

- 无 installed-copy 回放（未对已安装副本执行 `--serve` 或控制入口）。
- 无 restart（未执行任何守护进程重启通道）。
- 无 deployed-entrypoint 回放（未在部署产物入口验证）。
- 无 cross-device 回执（未做跨设备或 LAN 双端验收）。
- 无浏览器证据（未对 WebUI 做真实浏览器渲染或截图）。
- 门禁状态保持 `partial`，不宣称 `implemented`/`passed`。
- 未 merge、未 push；本轮只在上述分支产生一个提交。

## 8. 目录投影增量（原 D09，2026-10-11 折入 D06）

**归属声明：本条增量原先作为独立 “D09” 单元承载（提交 `0adc57f`，分支
`codex/acp-d09-discovery-projection-20261011`）。它现在属于 D06：没有单独的 D09 单元、
没有单独的 D09 门禁、没有单独的 D09 证据目录。** 原目录
`docs/evidence/acp-d09-discovery-projection-20261011/` 已整体删除，内容迁入本目录（D06
PART 2）。`0adc57f` 及其提交信息一字未改，作为历史事实保留在自己的分支上。

选本目录（PART 2）而非 `acp-d06-control-20261011/`（PART 1）的理由：`createControlNetworkStatus`
由 PART 2 引入，PART 2 先把 D05 端口接上、目录仍是静态空值；本条增量正是把该目录变成真实
D04 回读，属同一注入点的直接延续。PART 1 只交付守护进程本体与线面，且本目录是本 unit 唯一
带结构化 `verification.json` 的目录。

迁入与重命名：

| 原路径 | 现路径 |
| --- | --- |
| `docs/evidence/acp-d09-discovery-projection-20261011/notes.md` | 本节 |
| `docs/evidence/acp-d09-discovery-projection-20261011/verification.json` | 合并进本目录 `verification.json` |
| `docs/evidence/acp-d09-discovery-projection-20261011/black-box-discovery-projection.mjs` | `docs/evidence/acp-d06-part2-20261011/black-box-control-directory-projection.mjs` |

驱动内与单元身份相关的标识符一并改为中性名：`D09_EVIDENCE_OUT`→`TEAMS_CONTROL_PROJECTION_EVIDENCE_OUT`、
`D09_CONTROL_PASSWORD`→`TEAMS_CONTROL_BLACKBOX_PASSWORD`、`D09_CRED_*`→`TEAMS_CRED_*`、
`D09_PROBE_KEY`→`TEAMS_PROBE_KEY`、`D09_STEP_TIMEOUT_MS`→`TEAMS_STEP_TIMEOUT_MS`、
registry daemon id `d09-registry`→`teams-registry`、stub provider label、临时根前缀与报告文件名。
驱动头部保留一句 “previously carried as a separate "D09" unit” 的历史事实说明。

### 8.1 交付文件与调用边

| 文件 | 变更（含 file:line） |
| --- | --- |
| `runtime/control-process.ts` | `CreateControlOwnerOptions.source?: ControlProjectionSource`（:487-494）；`createControlOwner.read` 优先用 source 的完整读（:500-503）；`ControlNetworkStatusBinding.projection`（:539-546）；`DIRECTORY_PROJECTION_INTERVAL_MS = 1_000`（:549）；`createControlNetworkStatus.refreshDirectory` 真实目录回读（:595-619）、`observe` 先刷新目录（:620-627）、每读新建 D05 port（:647）、`readProjection`（:648-652）；`runControlProcess` 绑定 owner 与真实 SSE watch（:818、:824-826） |
| `network/registration-client.ts` | `RegistrationClient.directorySnapshot(subscribe)`（:80 接口）；唯一 online guard `onlineRelay()` 与实现（:286） |
| `runtime/console-hub.ts` | 抽出唯一目录行映射 `directoryAgentObservation(peer)`（:17），`createConsoleHub` 改为调用它 |
| `runtime/control-process.spec.ts` | 新增红绿用例 `projects the real D04 registration directory and streams a frame when it changes` 与真实 in-process registry/peer helper |

调用边：`runControlProcess` → `createControlNetworkStatus` → `RegistrationClient.directorySnapshot`
（`network/registration-client.ts`）→ `refreshRelayDirectory`（`network/account-directory.ts`）→
`projectTeamsMembership`（`network/teams-membership.ts`）→ `createTeamsStatusPort`
（`network/teams-status.ts`）；`createControlNetworkStatus.readProjection` →
`directoryAgentObservation`（`runtime/console-hub.ts`）；`createControlOwner` →
`ControlProjectionSource.read/watch`。**没有**第二个具名 listener、**没有**第二条历史源、
**没有**从 history 推断在线或执行状态。

### 8.2 红绿证据（原 D09 记录，事实不变）

- 红：`pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts -t 'projects the real D04 registration directory'`
  → `Tests 1 failed | 16 skipped (17)`，失败断言
  `AssertionError: expected [] to match object [ { remoteAgentId: 'peer-a', state: 'disconnected', targetGeneration: 1 } ]`。
  原因正确：目录仍是硬编码空快照，真实注册 peer 不出现在 `connections()`。
- 绿：同一命令 → `Tests 1 passed | 16 skipped (17)`。

红绿使用真实 in-process registry（`createRelayServer`，真实 TLS、真实 admission）与两个真实
`createRegistrationClient` peer；第二个 peer 真实注册触发目录 revision 变化，不是定时器造帧。

### 8.3 真实黑盒（`black-box-control-directory-projection.mjs`）

真实入口：`agentteams registry start|stop`（真实 registry daemon，真实 openssl TLS、真实
admission）、`agentteams --serve opencode` 两次（两个真实注册 agent daemon，真实 OpenCode
引擎）、`agentteams control start|stop`（被测真实控制守护进程）、真实认证 HTTP
`GET /api/v1/projection` 与 `GET /api/v1/events`。全部凭据只经环境变量传入，脚本不打印秘密值。
清理只用显式 PID 或项目自身 `control stop` / `registry stop`；脚本不含 `pkill`/`killall`/`kill $(...)`。

折入后从新路径复跑（2026-10-11，exit 0，**9 checks PASS / 0 gaps**）：

```
node docs/evidence/acp-d06-part2-20261011/black-box-control-directory-projection.mjs
registry start: started ... daemon=teams-registry pid=35238 url=wss://127.0.0.1:63127
PASS real registry daemon is running
PASS real agent A registered with the registry — reasoner-a registration=online
control start: started ... daemon=control-a pid=35502 url=http://127.0.0.1:63149
PASS real control daemon is running
PASS projection carries the real registered agent row — {"kind":"directory","agentId":"reasoner-a","machineId":"reasoner-a-host","generation":1,"presence":"online","capabilities":["acp"]}
PASS projection carries the same real directory peer as a connection row — {"remoteAgentId":"reasoner-a","state":"disconnected","targetGeneration":1}
PASS SSE emitted a real projection frame — seq=1 agents=reasoner-a
PASS real agent B registered with the registry — reasoner-b registration=online
PASS SSE seq advanced on the real directory change — seq 1 -> 3 agents=reasoner-a,reasoner-b
PASS HTTP projection now carries both real registered agents
ALL 9 CHECKS PASS
```

关键实测语义（非推断）：投影 agents 行来自真实目录（`kind:"directory"`、`presence:"online"`、
真实 `machineId`/`generation`/`capabilities`）；投影 connections 行是同一目录 peer 且
`state:"disconnected"`（控制守护进程不声明 Teams listener，ledger 诚实为空）；第二个 agent 真实
注册使 SSE `seq` 由 1 前进到 3，最后一帧同时含两个 agent；控制守护进程自身的注册行被过滤
（与 `runtime/console-runtime.ts` 的 discovery 约定一致），投影只显示远端 peer。

机器报告（含 pid 与临时路径，不写入仓库）：
`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d06-directory-projection-20261011/black-box-control-directory-projection.report.json`。

### 8.4 折入后复跑（本轮，真实命令与结果）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | 0 | `Test Files 6 passed (6)`，`Tests 118 passed (118)`（改动前 117；runtime/control-process 16 → 17） |
| `pnpm exec vitest run --no-file-parallelism network/registration-client.spec.ts` | 0 | `Test Files 1 passed (1)`，`Tests 7 passed (7)` |
| `pnpm exec vitest run --no-file-parallelism runtime/console-hub.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-status.spec.ts` | 0 | `Test Files 4 passed (4)`，`Tests 28 passed (28)`（被改动的 owner 直接回归） |
| `pnpm typecheck` | 0 | 根 `tsc --noEmit` + console-host + opencode-adapter + `ui/teams-console` 全通过 |
| `pnpm build` | 0 | 含 `build:runtime`（CLI 依赖的 `generated/runtime-lib`） |
| `node docs/evidence/acp-d06-part2-20261011/black-box-control-directory-projection.mjs` | 0 | 9 checks PASS / 0 gaps |

注：首次运行门禁时未先 `pnpm build`，8 个用例以 `START_TIMEOUT: control did not report running
within 10000ms` 失败；构建后同一命令 118/118 通过。这是构建前置条件，不是本改动的缺陷。

### 8.5 诚实边界（逐条核实，折入后仍成立）

1. **目录刷新是真实 ~1s WSS 轮询，不是 `relay.changed` 推送。** 依据：`RegistrationClient`
   接口（`network/registration-client.ts:68-89`）只声明 `closed`/`status`/`start`/`directory`/
   `directorySnapshot`/`publish`/`stop`，**没有**变更事件；`runtime/control-process.ts:549`
   定义 `DIRECTORY_PROJECTION_INTERVAL_MS = 1_000`，`:655` 用它构造
   `createPollingProjectionSubscriber(readProjection, DIRECTORY_PROJECTION_INTERVAL_MS)`，而
   `:663-694` 的实现是 `setInterval(tick, intervalMs)`，每次 tick 做一次真实
   `directorySnapshot` 读。因此目录变化的最坏可见延迟约等于该间隔。
2. **读失败保留上一次真实回读，不伪造空目录。** 依据：`runtime/control-process.ts:599-606`，
   `directorySnapshot` 抛错时只打印诊断并 `return`，不修改 `directory`/`peers`；只有真实成功
   的 revision（`:607` 要求 `>= 1`）才经 `refreshRelayDirectory` 写入（`:613-614`）。
3. **控制守护进程不声明 Teams listener，连接行是目录事实而非已建立通道。** 依据：
   `ControlDaemonIntent`（`config/daemon-intent.ts:142-150`）只有 `webui`，**没有**
   `listen: ListenIntent`（agent/registry intent 才有）；控制 daemon 允许的顶层字段
   （`config/daemon-intent.ts:723`）为 `['version','daemon','webui','relations','admissions',
   'discovery','peers']`，声明 `[listen]` 会被拒。`runtime/control-process.ts:586` 建空 ledger，
   全文件只在 `:624` 读 `ledger.list()`、`:647` 传入 port，没有任何写入点；因此
   `projectTeamsMembership` 对目录已知但无通道的远端给出 `state: 'disconnected'`
   （`network/teams-membership.ts:133-137`）。

### 8.6 D08 A07 缺口前提的核对（只答问题，不扩大声明）

D08 验收驱动记的缺口原文把两件事合成一句：“the shipped control daemon binds no Console
owner, so /api/v1/projection is a constant empty snapshot and no real event can advance the SSE
stream”。折入后逐半核对：

- **“constant empty snapshot / no real event can advance the SSE stream” 已不成立。**
  真实黑盒（§8.3）显示 `/api/v1/projection` 带真实 `kind:'directory'` agent 行，且第二个 agent
  真实注册使 SSE `seq` 由 1 推进到 3。该半句的前提已过时。
- **“binds no Console owner” 仍然成立。** `runtime/control-process.ts:818` 是唯一生产调用点：
  `createControlOwner({ network: network.port, source: network.projection })`，**没有** `owner`
  绑定；`ControlOwnerBinding`（`:77`）只有接口声明，没有任何生产构造点。控制守护进程仍**未**
  绑定 Session owner，也没有定向 ACP ingress。

  2026-10-14 更正（L9 intent-side）：这段里的 `connection.connect`/`connection.disconnect`/
  `network.membership.apply` 已经不再属于「未交付」。三条 A2.4 关系命令现在经
  `config/relations-intent-store.ts` 做一次 CAS 写入，目标不可解析时为 typed `FORBIDDEN`；
  控制 daemon 仍不拨号、不协商、不报告连接状态。仍然成立的部分是：没有 Session owner、
  没有定向 ACP ingress、SSE 后面没有 Session/permission/notification 事件流。

因此结论必须分两句说：**“投影现在带真实目录行”为真（本改动范围内，已用真实入口证明）；
“绑定了真实 Session owner”为假（不在本改动范围）。** A07 的“真实事件驱动动画”因此只被解锁
一半：目录变化可以驱动真实 SSE 帧推进，Session/permission/notification 事件仍不能，因为
不存在 Session owner。该缺口不应整体关闭，应改写为“目录变化已可驱动；Session 事件驱动仍缺
Session owner”。

### 8.7 本轮明确未做 / 非声明

以下均为**未做**，不得由本轮任何结果推断：

- 无 installed-copy 回放、无 restart、无 deployed-entrypoint 回放、无 cross-device 回执、
  无浏览器证据。
- 未新增第二个具名 listener、第二条历史源或第二个目录源。
- 未改 `control-protocol/**`（冻结契约）。
- 未 merge、未 push；未改写 `0adc57f` 及其提交信息；未触碰其它工作树。
- 门禁状态保持 `partial`，不宣称 `implemented`/`passed`。
