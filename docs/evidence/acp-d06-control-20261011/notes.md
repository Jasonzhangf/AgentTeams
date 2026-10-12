# D06 控制守护进程 PART 1 — receipt

日期：2026-10-11，America/Los_Angeles。
候选分支：`codex/acp-d06-control-20261011`（不 push、不合并 main）。
Base：`origin/main@cf551b1`。
Worktree：`/Volumes/Intel/playground/agentteams/acp-d06-control-20261011`（clean、独占）。
分支：`codex/acp-d06-control-20261011`（未 push）。提交哈希见 run notes：本 receipt 由它所在的提交携带，
因此不能包含该提交自身的哈希。
Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d06-control-20261011/run-notes.md`。

PART 1 只交付控制守护进程本体、CLI 入口与增量线面。Teams/连接投影绑定、五张
`docs/architecture/*.json` map、`docs/design/**`、`docs/development-governance.md`
与 D07 交接面属于 PART 2，本轮一字未改。

## 1. 交付文件

| 文件 | 变更 |
| --- | --- |
| `runtime/control-process.ts` | 新增。控制守护进程父子生命周期（`startControlDaemon`/`statusControlDaemon`/`stopControlDaemon`）、真实 WebUI listener、owner binding、history reader、轮询与 fixture 投影订阅者、子进程入口 `runControlProcess` |
| `runtime/control-process.spec.ts` | 新增。11 个定向用例：真实入口 + 认证 + 静态字节 + 关闭校验 + SSE + 显式 PID 停止、ALREADY_RUNNING、STALE_GENERATION、PORT_OCCUPIED、CREDENTIAL_UNAVAILABLE、UNSUPPORTED_CONFIGURATION、dead pid、history 端口、owner 缺席、订阅者行为 |
| `control-protocol/console-api.ts` | 增量 DTO：`ConsolePermissionOption`/`ConsolePermissionOptionKind`、pending permission 的 `options?`、agent 行 `engine?`/`lastSeenAt?`、`ConsoleConnectionView` + `connections?`、`connection.connect`/`connection.disconnect`/`network.membership.apply` 命令、`permission.reply.optionId?`、`parseConsoleProjection`、`parsePermissionOptions`、`parsePermissionReplyResult` |
| `control-protocol/console-wire.ts` | `projection()` 委托 `parseConsoleProjection`；`commandResult` 委托 `parsePermissionReplyResult`；删除被取代的本地 helper |
| `control-protocol/teams-state.ts` | 增量：`ConsoleProjectionSnapshot`/`ConsoleProjectionSink`/`ConsoleProjectionSubscriber`、`parseConsoleProjectionSnapshot`、`HISTORY_QUERY_FIELDS`、唯一的 HTTP query 映射 `historyQueryFromSearchParams` |
| `console-host/src/http-api.ts` | 新增 `GET /api/v1/history` 与 `GET /api/v1/events`；query 拒绝只为 history 放宽；owner 缺席以类型化 503 表达；SSE 帧 `event: snapshot` / `event: health`（`snapshot` 与两个 UI live 客户端订阅的事件名一致；不匹配的具名事件会被静默丢弃），owner 丢失即收流 |
| `console-host/tests/http-api.spec.ts` | 新增 3 个用例：history 关闭解析与放宽范围、缺席 503、真实 SSE 帧与收流 |
| `control-protocol/console-api.spec.ts` | 新增 4 个用例：新命令闭合、permission option 集合、agent 增量字段与 connection 行 |
| `cli/agentteams.mjs` | 新增 `agentteams control start\|status\|stop --config <file>`（`--generation` 只被 `control stop` 接受）与 `controlProcess` runtime artifact |
| `cli/agentteams.spec.ts` | 新增 3 个用例：路由与状态行、类型化失败码透出、参数严格性 |
| `ui/teams-console/src/client/api.ts`、`src/client/protocol.ts` | 增量消费：`PROJECTION_KEYS` 加 `connections`、connection 行闭合校验、`permission.reply` 结果校验；重导出增量类型 |
| `tsconfig.runtime.json` | `include` 加 `runtime/control-process.ts` 与 `console-host/src/{auth,http-api,server}.ts` |
| `docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | 新增。真实黑盒（9 项） |
| `docs/evidence/acp-d06-control-20261011/notes.md` | 本 receipt |

## 2. 真实黑盒（`black-box-control.mjs`，10/10 PASS）

真实入口：`node cli/agentteams.mjs control start|status|stop --config <tmp>/control.toml`，
配置声明 `kind="control"`、`webui.ip=127.0.0.1`、随机空闲端口、
`webui.auth.passwordEnv="TEAMS_CONTROL_BLACKBOX_PASSWORD"`，密码只经环境变量传入。

1. `control start` 绑定声明 listener，回读 `pid`/`generation`/`listener`/`daemon`/`data`，且输出不含密码值。
2. `control status` 回读同一持久 generation 与 pid。
3. 匿名 `GET /` → 401 且 `WWW-Authenticate: Basic realm="AgentTeams", charset="UTF-8"` 精确匹配。
4. 有效凭据下 `console.html`/`console-entry.js`/`ui/browser.js` 字节与冻结源逐字节一致，CSP 含 `default-src 'self'`。
5. `/api/v1/projection` 为真实 v1 payload；network 端口未绑定，故无 `connections` 键。
6. 新命令种类在线面闭合：5 个非法形状 400；3 个合法形状 200 且带 `error.code="UNAVAILABLE"` 的类型化拒绝。
7. history 关闭解析：9 个非法 query 400，合法 query 得 503 `HISTORY_UNAVAILABLE`；放宽只限该路由（projection/events 带 query 仍 400）。
8. SSE 真实流：`text/event-stream`、`cache-control: no-store`、3 帧（projection seq1、projection seq2、health lost/stream-ended），服务端自行收流，且未伪造 `live` 健康态。
9. `control stop --generation <n>` 干净停止：pid 消失、`127.0.0.1:<port>` 拒绝连接、owner 数据目录与状态记录被删除、`control status` 报 `stopped`。
10. 端口被占时真实 CLI 以 exit 1 与 `PORT_OCCUPIED: ...` 类型化失败；未留下 owner 数据目录，`control status` 不报 `running`。

子进程把类型化失败写入状态记录的 `errorCode`（闭合词表校验），父进程据此重新抛出真实错误码，
而不是把一切压成 `START_TIMEOUT`；`error` 字段只存纯消息，避免调用方重复打印错误码。

清理只用显式 PID（`process.kill(pid,'SIGTERM')`）与 CLI stop；脚本不含 `pkill`/`killall`/`kill $(...)`。
确定性投影缝为 `AGENTTEAMS_CONTROL_PROJECTION_FIXTURE`：它是运维显式提供的闭合输入，
传输、帧与 socket 均为真实；`runtime/control-process.spec.ts` 另有默认轮询路径的真实帧断言。

`AGENTTEAMS_CLI=<staged cli>` 可把同一黑盒指向已暂存打包入口；上表两条均 PASS，
证明交付物本身而不只是源码树。打包布局的 UI 根是 `ui/teams-console/`，
源码布局是 `ui/teams-console/lib/`；`presentationRoots` 同时接受两者，缺失时以
`INVALID_CONFIG` 显式失败。

## 3. 定向门禁（真实命令与结果）

| 命令 | 结果 |
| --- | --- |
| `node_modules/.bin/vitest run --config vitest.config.ts runtime/control-process.spec.ts` | 12/12 PASS |
| `node_modules/.bin/vitest run --config vitest.config.ts console-host/tests` | 9/9 PASS |
| `node_modules/.bin/vitest run --config vitest.config.ts control-protocol cli/agentteams.spec.ts ui/teams-console/tests` | 25 文件 185/185 PASS |
| `pnpm typecheck` | PASS（含 console-host 与 ui/teams-console 子包） |
| `pnpm build` | PASS（含 `build:runtime`） |
| `git add -A && node scripts/package-artifact.mjs --mode base` | PASS，`755b257d524ddc6b0dfead86f90ec0d0030e698001a81c37c34aa663b1176b10` |
| `pnpm smoke` | PASS（Packaged Console smoke + Packaged runtime smoke） |
| `node docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | 10/10 PASS（源码入口） |
| `AGENTTEAMS_CLI=generated/modules/teams-source/lib/cli/agentteams.mjs node docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | 10/10 PASS（已暂存打包入口） |
| `node_modules/.bin/vitest run --config vitest.config.ts cli/package-install.spec.ts` | 24/24 PASS（要求索引干净：`git add -A` 后运行） |
| `node_modules/.bin/vitest run --config vitest.config.ts`（全量） | 104/106 文件 PASS；2 个失败为环境依赖：`cli/package-install.spec.ts`（npm 安装 + receipt identity 要求索引干净）与 `runtime/managed-opencode-session.spec.ts`（需真实 OpenCode/provider），与本次改动无调用关系 |

黑盒报告写入 run notes 目录（`black-box-control.report.json`），不写入仓库：报告含 pid 与临时路径，
每次运行都会变化；写入仓库会让索引在每次运行后变脏并触发 receipt identity 门禁。

## 4. D00 amendment A2 原文

以下为 PART 2 必须原样带入 `docs/design/teams-acp-daemon-config-v4.md`、
`docs/architecture/*.json` 与 `docs/development-governance.md` 的增量条文。

> **D00 amendment A2（生效 2026-10-11，由 D06 控制守护进程提出）**
>
> A2.1 控制守护进程的线面只作**增量扩展**，不提升 frame version。既有的 v1 payload
> 继续有效，且未知键仍按闭合契约拒绝。控制守护进程不得为 Teams 连接声明第二个具名
> 端口，也不得复制 network 模块。
>
> A2.2 `GET /api/v1/history?version=1&kind=request|connection&agentId&sessionId&limit&beforeSequence`
> 返回冻结的 `HistoryPage`。这是唯一放宽"任何 query 参数即拒绝"的路由；其余路由的拒绝
> 语义逐字不变。
>
> A2.3 `GET /api/v1/events` 是真实 SSE 流（`content-type: text/event-stream`、
> `cache-control: no-store`）。每个事件携带完整 owner 投影快照 `{seq, projection}`，
> 客户端不维护 delta 存储。同一端点另发一条健康事件，复用冻结的
> `SessionObservationState` 词表（`live|degraded|lost`）。owner 丢失时服务端关闭流，
> 且不得伪造存活状态。
>
> A2.4 新增闭合命令种类，沿用既有 `expectedRevision` CAS 模式：
> `connection.connect{agentId}`、`connection.disconnect{agentId}`、
> `network.membership.apply{expectedRevision, members:[{agentId, role}]}`，其中 `role`
> 复用冻结的 `RelationRole`。未知种类仍失败。
>
> A2.5 增量可选投影字段只从既有 owner 真源投影：agent 行可带 `engine?` 与
> `lastSeenAt?`；投影可带一个复用冻结 `TeamsMembershipView`（或冻结
> `TeamsConnectionStatus` 列表 + `halfOpen` + 可选 `localRole`）的 connection 字段。
> 不得铸造同义词。
>
> A2.6 pending permission 事件可带引擎提供的
> `options: readonly {optionId, name, kind}[]`，回复可携带所选引擎 `optionId`。
> 不得伪造 option 集合，也不得为缺失或过期的回调自动批准。
>
> A2.7 控制运行时**结构性地**消费网络状态端口，仅使用冻结类型
> `{ history(query: HistoryQuery): Promise<HistoryPage>; connections(): readonly TeamsConnectionStatus[] }`。
> 该依赖未注入时必须以类型化错误显式失败；不得伪造连接状态，也不得从 history 推断
> 在线或执行状态。

## 5. PART 1 未交付 / 待 PART 2

- Teams/连接投影绑定：`ControlNetworkStatusPort` 目前只在测试与调用点注入；未接 D05 网络状态端口。
- 权限 option 决策：`options?`/`optionId?` 已在 DTO 与校验层闭合，但尚无引擎侧投影与回复裁决路径。
- 五张 `docs/architecture/*.json` map、`docs/design/**`、`docs/development-governance.md` 与 gate 绑定。
- D07 交接面。
- 验收项 A07/A08/A09 在本轮仍未被证明。
