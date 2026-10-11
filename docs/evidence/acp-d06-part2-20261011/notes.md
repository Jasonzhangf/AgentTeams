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
| `docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | PART 1 期望更新为真实端口绑定后的线面（`UNSUPPORTED_OPERATION`、真实空页） |
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
连接变更拒绝码为 `UNSUPPORTED_OPERATION`、`kind=connection` 返回真实空页。

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
