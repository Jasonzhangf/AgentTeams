# Teams 本地公开 Work 入口 v1（设计）

状态：设计候选，未实现、未安装、未 review。本文只闭合「公开 CLI → receiver 已授权
network client → 已装 DAGpipe host」缺失的接缝，不改 graph 拓扑，不新增 scheduler、
ledger、fallback 或第二套控制真源。写入范围仅本文件与
`docs/evidence/4b6c377-u4-public-work-design-20261003/**`。U4 只获准在 U2
`docs/design/teams-local-config-v3.md` 增加 `[workControl]` 控制资源契约附录；该文件其余
内容及其实现仍归 U2 config owner，实际 parser/serializer 由 U2 在 U4 seam 顺序实施时
分配，U4 不与 U2 共享写入。

## 0. 目标与已证实缺口

目标：用户只用正式 CLI 与 `config.toml`，即可在不启动 Console 的情况下提交一次新的
Work、拿到真实业务结果，并在之后用原 Work/request 身份显式查询该结果；查询不重放业务
副作用。

当前真源已证实的缺口：

- `cli/agentteams.mjs` 的 `work` 命令调用 `runLocalConfiguredWork`，只轮询
  `internal.toml [configuredWork]` 启动回执，不发起新执行。
- `runtime/agent-process.ts` 的 `loadAgentProcessConfig` 仍要求
  `endpoint.connect.payload`，`parseV3Connect` 已不接受该字段，故新 v3 默认配置启动直接
  失败 `endpoint.connect.payload is required`。
- 现有 child IPC 只有 ready/status 回传（`local-supervisor.ts` 的 `waitForReady` 只处理
  `daemon.registered`/`daemon.status`），没有 CLI → 运行中 receiver 的新请求入口。
- D3/U4 候选中的 graph Operator 与 `AgentWorkClient` 公开方法存在，但尚未安装，也没有公开
  caller 把一次 submit/query 接到它们。

本设计选定**唯一**最小实现：launcher 自有的本机 Unix socket 控制入口，转发到 receiver
child IPC，再由 receiver 现有的 `AgentWorkClient` + D3/U4 `runWorkExecution` 执行。
Console 不是数据路径。除该 socket 外不引入新的公开 API 或第二个 daemon。

## 1. 输入依赖与准入条件（不是已接受 commit）

| 依赖 | 身份 | 状态 | 对本设计的约束 |
|---|---|---|---|
| 本候选基线 | branch `codex/u4-public-work-design-20261003`，HEAD `b969e9740704977326c5054fb3afbeab8d523e36`，tree `b6464bbec1804ea0e3e58b0a955a4547586bb267` | 已核实 | graph/CLI/runtime 读取真源 |
| U2 配置候选 | worktree `/Volumes/Intel/playground/agentteams/u2-config-impl-20261003`，HEAD `b969e9740704977326c5054fb3afbeab8d523e36`，tree `7cf779b6f2f6b729ce9eac60377927b974848a1a`，staged 未提交 | **未合并、未安装** | 当前 tree 已有 v3 service-selection `connect`，但 `internal.toml` 尚无 `[workControl]` parser/serializer；本文 §4 的 U4 控制资源附录是未来 U2 owner 实现契约，不是可用接口 |
| D3/U4 runner 候选 | worktree `/Volumes/Intel/playground/agentteams/d3-u4-work-20261003`，HEAD `de099b79f153e6fd220b98d5ee89f4777b7cfb53`，tree `c8ec9ba3d97d922f6c13262009aa71295cd0075c`，untracked | **未合并、未安装** | 提供 `runWorkExecution(client, request)` 与 typed runner protocol；10/10 socket harness 属作者证据，不等于产品安装验收 |

准入条件（全部满足前不得实现产品代码）：

1. 本设计与 U2 `teams-local-config-v3.md` 的 `connect` 契约一致（无 Work 业务字段），且
   §4 的 `[workControl]` 字段/生命周期已由 U2 config owner 纳入同一 internal schema 与
   parser/serializer；当前未实现；
2. D3/U4 `host.ts`/`protocol.ts` 接口与本文 §5 一致，且 U1 pack manifest 形状与本文一致；
3. 本文通过独立设计 review；
4. 上述候选集成到同一候选树后，公开入口才有可执行对象。

任一条件不满足时停在设计/能力确认，不用 mock 成功，不假装 admission 已通过。

## 2. 公开 CLI 合同

`work` 成为带子命令的父命令。提交与查询是两个独立语义，不共享 identity 生成。

```text
agentteams work submit --config <path> --payload <json> [--receiver <agentId>] [--generation <n>]
agentteams work query  --config <path> --work-id <id> --request-id <id> [--receiver <agentId>] [--generation <n>]
```

- `--config`：可选；缺省 `$HOME/.agentteams/config.toml`。
- `--payload`：submit 必填；单个 JSON 值（对象/数组/标量均可），CLI 原样解析为
  `JsonValue`，不做字段白名单、不改写、不裁剪。空字符串、非法 JSON 为 `INVALID_INPUT`。
- `--work-id`/`--request-id`：query 必填；原样透传，不做猜测补全。
- `--receiver`：可选；显式选择 receiver Agent ID。
- `--generation`：可选；显式要求当前 launcher generation，仅用于陈旧调用拒绝。
- `submit` 不读 `internal.toml` 的 `[configuredWork]`，不读任何启动回执；每次调用生成新的
  `workId`/`requestId`（见 §6）。
- `query` 不携带业务 payload，不生成新 Work/request ID。

stdout 只输出一行 JSON 结果，stderr 输出显式错误；错误时退出码非 0。

成功（submit/query 同形，业务值原样保留、与控制回执物理分离）：

```json
{
  "status": "completed",
  "control": {
    "projectId": "agentteams-local-work",
    "graphId": "agentteams.agent-work",
    "graphVersion": "2",
    "executionId": "<fresh>",
    "attemptId": "<fresh>",
    "workId": "<workId>",
    "requestId": "<requestId>",
    "providerAgentId": "<provider>",
    "targetGeneration": 1,
    "requestState": "succeeded",
    "workClosure": "closed"
  },
  "business": "<original JsonValue>",
  "cleanup": { "channelsOpened": 1, "channelsDisposed": 1 },
  "evidence": {
    "execution": "completed",
    "graphId": "agentteams.agent-work",
    "graphVersion": "2",
    "nodeSchedule": ["resolve-service", "open-link", "admit-work", "request-work", "settle-work"],
    "nodeCompletion": ["resolve-service", "open-link", "admit-work", "request-work", "settle-work"],
    "hostOperations": ["agentWork.findProvider", "agentWork.open", "agentWork.propose", "agentWork.request", "agentWork.close", "agentWork.dispose"]
  }
}
```

query 成功与 submit 同形，但 `graphId` 为 `agentteams.work-query`、`graphVersion` 为 `1`、
`nodeSchedule` 为 `resolve-service/open-link/query-request/return-observation`、
`control.observed` 为 `true`，且 `workId`/`requestId` 是原值；`executionId`/`attemptId` 是新值。
`status` 为 `completed` 表示宿主得到明确观察终态，不表示资源被释放。

失败输出：

```json
{ "status": "failed", "error": { "code": "<CODE>", "message": "<message>" }, "control": { "executionId": "<fresh>", "attemptId": "<fresh>", "workId": "<id>", "requestId": "<id>", "requestState": "unknown", "workClosure": "retained" } }
```

执行后的结果直接保留 D3/U4 `ProjectExecutionReceipt` 的全部字段，包括 `control.error`、
`business`、`cleanup` 与 `evidence`；不投影成一个会丢字段的 CLI 简化结果。上面的失败例
仅说明确实报告 unknown/retained 的情况，不是所有失败的默认状态。未调用 provider 的输入、
编译、runner 校验失败不生成 `requestState` 或 `workClosure`；本地投递后未收到终态时只报告
`deliveryState: unconfirmed` 与已生成的身份，不能推定 provider 已分配资源。之后显式 query
取得 provider 的权威状态。CLI 在 socket 断连的非零退出回执中保留这些身份，便于用户查询。

本地错误码包括（上游 provider/SDK 原错误码及错误链同样保留，不归一化为这些本地码）：`INVALID_INPUT`、
`LOCAL_CONTROL_UNAVAILABLE`、`STALE_GENERATION`、`RECEIVER_NOT_FOUND`、`NOT_AUTHORIZED`、
`DAGPIPE_RUNNER_MISSING`、`UNSUPPORTED_PLATFORM`、`GRAPH_HASH_MISMATCH`、
`RUNNER_HASH_MISMATCH`、`EXECUTION_FAILED`、`HOST_PROTOCOL`、`RESULT_UNKNOWN`。

## 3. 配置：service 选择 vs 启动 Work 兼容/移除

- `[agents.<receiver>.connect]` 继续只描述 service 选择：`targetAgentId`、`capabilityId`、
  `capabilityVersion`、`operation`、`demands`。它是 target/service 意图，不是一次执行的
  identity，也不是业务 payload。
- `workId`/`requestId`/`payload` **移除**出用户配置。Work 输入归公开请求路径（U4），
  每次 `work submit` 携带。
- `endpoint.connect.payload is required` 及其 receiver 连接解析一并移除；receiver 只要求
  存在 `connect`（service 选择），不要求业务字段。
- 启动不再执行配置业务：删除 `runConfiguredWork` 启动编排、`internal.toml [configuredWork]`
  写入，以及 CLI 读 `configuredWork` 冒充新执行的整条链。`start` 只发现/连接 service 并
  发布 status；没有任何自动 replay、startup receipt 或旧链 fallback。
- `internal.toml` 仍只保存派生运行事实（launcher、daemon、control socket 及其对既有
  launcher generation/startToken 的 typed ref），不复制 generation/token 真源，不保存
  Work 业务结果真源；durable 结果仍归 provider ledger。

receiver 选择规则（无隐式多路）：

1. 显式 `--receiver`：匹配该 enabled agent 的声明 `agentId`。
2. 缺省：恰好一个 enabled receiver/hybrid 且带 `connect` 时选它。
3. 缺省且存在多个候选：显式失败 `RECEIVER_NOT_FOUND`（消息要求 `--receiver`），不任选、
   不轮询、不 fallback。

## 4. 本地控制接缝：唯一缺失 seam 与 typed IPC

选定的唯一缺失 seam：launcher 在启动时创建**本机 Unix domain socket**。socket 相对
`internal.toml` 所在目录的固定路径为 `.internal/work-control.sock`；launcher 生成并只写
以下 typed 扩展到 U2 唯一 internal owner：

```toml
[workControl]
socketPath = "<absolute path resolved from internal.toml dir>/.internal/work-control.sock"
launcherGeneration = 4
launcherStartToken = "<equal to [launcher].startToken>"
```

字段类型固定为 `socketPath: string`、`launcherGeneration: integer`、
`launcherStartToken: string`；无 token 副本。`[launcher].generation` 与
`[launcher].startToken` 仍是唯一生命周期真源，`[workControl]` 的两个字段必须是其启动时
exact ref；不符即 `HOST_PROTOCOL`/`STALE_GENERATION` 显式失败。U2 config owner 的
`runtime/local-config.ts` 扩展 `LocalInternalConfig`、closed parser 与 serializer，
提供同内部锁的 `writeLocalInternalWorkControl` / `readLocalInternalWorkControl` 和
cleanup primitive；U4 launcher 调用该端口，不直接解析/改写 TOML。所有写必须在
`withLocalInternalConfigLock` 内 read-modify-write，保留现有一切
`configRuntime/launcher/daemon/consoleRuntime` 字段。

CLI 连接 socket 后，launcher 校验 `socketPath`、`launcherGeneration` 与
`launcherStartToken` 后经现有 child IPC 转发给 receiver；receiver 用自身已注册身份执行。
socket 文件 `0600`，目录 `0700`，用户不可配置、不编辑。启动顺序固定为：launcher 先取
`.launcher.lock`，再取 internal lock 写 `[workControl]`；socket `listen` 成功且回读
exact ref 后才发布 `running` 并开放 admission/CLI submit；任一失败关闭 listener、移除
部分 `[workControl]` 项并进入现有失败清理，且此窗口内不得接受 Work。`stop` 在任何
terminal/error path 上先停止 admission、关闭 socket，再在同一 internal lock 内删除
`[workControl]`，不删除 `[launcher]` ownership 或任何其他 section。
不新增公开网络 API、不让 Console 转发、不让 CLI 用 Agent 身份再次登录目录或抢占 generation。

传输边界（封闭 typed union，一次连接一次请求）：

```text
CLI → launcher:  { "kind": "work.submit", "requestId": "<local-correlation>", "control": { "receiverAgentId": "<id>", "expectedLauncherGeneration": <n>, "startToken": "<token>", "executionId": "<fresh>", "attemptId": "<fresh>", "workId": "<fresh>", "requestId": "<fresh>" }, "business": "<JsonValue>" }
CLI → launcher:  { "kind": "work.query",  "requestId": "<local-correlation>", "control": { "receiverAgentId": "<id>", "expectedLauncherGeneration": <n>, "startToken": "<token>", "executionId": "<fresh>", "attemptId": "<fresh>", "workId": "<original>", "requestId": "<original>" } }
launcher → CLI:  { "kind": "work.result", "requestId": "<local-correlation>", "receipt": "<ProjectExecutionReceipt>" }
launcher → CLI:  { "kind": "work.error",  "requestId": "<local-correlation>", "error": { "code": "<CODE>", "message": "<message>" } }
```

launcher → receiver child 沿用现有 Node IPC channel，新增同一 typed union（带
`localCorrelation`、`receiverAgentId`、`expectedLauncherGeneration`、`expectedAgentGeneration`），
receiver 回 `work.result`/`work.error`。未知 kind、字段缺失、correlation 不匹配均为
`HOST_PROTOCOL` 显式错误并只结束该次请求，不静默跳过、不当作成功。

归属与校验边界：

- launcher 拥有 socket 生命周期及 `[workControl]` 的写入/清理由 U4 caller 发起；U2
  `runtime/local-config.ts` 是 `internal.toml` 的唯一 parser/serializer/lock owner。
  `[launcher].generation/startToken` 是生命周期与 start-ownership 唯一真源，
  `[workControl]` 只保存其 exact ref。
- receiver 拥有 Work 执行与 `AgentWorkClient` 调用；它按自身注册身份（`accountId/scopeId/
  agentId`）发起，不从 payload/metadata 重建控制状态。
- provider 拥有 admission/policy/resource ledger。receiver 的 `allowedConsumers` 只是
  预过滤，不是 grant；最终授权与资源分配仍在 provider。
- generation 校验：launcher 比对 `expectedLauncherGeneration` 与持久化 launcher generation；
  receiver 比对 `expectedAgentGeneration` 与自身 network generation。两者都来自各自运行
  投影，不从日志/snapshot/payload 重建。陈旧代次拒绝 `STALE_GENERATION`。
- auth 校验：start token 沿用 launcher 启动时生成的 `[launcher].startToken`，不产生第二份
  `[workControl]` token；CLI 从 `internal.toml` 读取该 ref 与 matching generation 后
  提交，任一不符为 `NOT_AUTHORIZED` 或 `STALE_GENERATION`。socket 目录/文件权限限当前用户。
- 控制事实只走该 typed control resource 与 error chain，不写入业务 payload 或 metadata。

## 5. 执行接线：已装 runner + 精确 graph + 已注册 SDK

receiver 内的唯一执行入口为 `executeProjectWork(controlFrame)`，其返回
`ProjectExecutionReceipt`，并调用 D3/U4 `runWorkExecution(client, request)`：

- `graphPath`：submit 用 `agentteams.agent-work@2`，query 用 `agentteams.work-query@1`；
  取自安装 pack 内 `runtime/dagpipe/graphs/`，不读源码目录、不查 `process.cwd()`。
- `runnerPath`：安装 pack 内 `runtime/dagpipe/bin/darwin-arm64/agentteams-dagpipe-runner`，
  由 pack root 派生，`spawn` 直接执行，不经 shell、不查 `PATH`。
- 执行前核对 pack `runtime/dagpipe/manifest.json`：runner 文件 SHA-256 == `runner.sha256`；
  两 graph 文件 SHA-256 == 对应 `graphs[].sha256`。任一不符在**任何业务副作用前**显式失败
  （`RUNNER_HASH_MISMATCH`/`GRAPH_HASH_MISMATCH`）；缺 runner 或架构不符
  `DAGPIPE_RUNNER_MISSING`/`UNSUPPORTED_PLATFORM`。
- SDK 注册边界：`dagpipe sdk path` 只在构建期由 `runtime/dagpipe/build.mjs` 使用，把
  `pipeline_runtime@0.1.1` 的身份与聚合输入 hash 冻结进 manifest/build receipt。运行期
  **不**读取 `$HOME/.local/share/dagpipe/sdk`、不依赖源码 worktree。运行期只需已装 runner
  binary + 两 graph + manifest；runner 内的 Operator registry 由该 binary 自带。
- `projectId` 固定 `agentteams-local-work`；`executionId`/`attemptId` 每次调用新生成
  （§6）。`intent.control` 携带 receiver/provider/capability/operation/work/request/policy
  facts；业务 `JsonValue` 只作为 `intent.business` 原样交给 runner。
- host 只按 runner 给定的 node 顺序 dispatch 固定 typed port（`findProvider/open/propose/
  request/get/close/dispose`），不自行排序、不重跑 graph、不复制 provider 状态。

## 6. submit vs query 事实

| 事实 | `work submit` | `work query` |
|---|---|---|
| graph | `agentteams.agent-work@2` | `agentteams.work-query@1` |
| workId/requestId | 每次调用**新生成** | **保留原值** |
| executionId/attemptId | 每次调用新生成 | 每次调用新生成（新 B8 execution/attempt） |
| 业务 payload | 用户输入，原样 | 不携带 |
| 对 provider 的 effect | propose + request（真实执行） | 仅 get（观察） |
| 重放 | 不适用 | **禁止** propose/request 重放 |
| 结果 | 真实业务结果 + 收尾 | 原 provider 回执，不新增业务执行 |
| Console | 不需要 | 不需要 |

`workId`/`requestId` 由 CLI 在本地入口生成（UUIDv4 或等价随机、唯一、非派生），经 typed
control 帧传递，不经配置、不从启动回执读取。

## 7. unknown / failed / retained 与公开结果保真

- provider 拥有 policy 与资源 ledger；receiver/CLI 不持有第二份资源账本，不从 journal/
  snapshot/日志重建控制状态。
- `unknown`（含 `RESULT_UNKNOWN`）保留 provider 资源责任：`requestState: "unknown"`、
  `workClosure: "retained"`，携带明确 owner 与恢复动作（后续显式 query）。不自动重发、
  不假释放、不把断线当完成。
- `failed`：仅当 provider 确认 failed/cancelled 才 close；close 失败保留业务结果与
  `cleanupError`，`status` 变 `failed`，不写成完整成功。
- 公开结果无损：`business` 为原始 `JsonValue`，不做截断/改写/字段裁剪；control receipt 与
  business 物理分离；execution journal 只作执行证据，业务决策不得从日志重建。

## 8. launcher / daemon 清理语义

- CLI 连接断开**不**取消 provider Work：请求已提交后 receiver 继续持有，结果归 provider
  ledger；之后用原 identity 显式 query 观察。不自动 cancel/retry。
- launcher `stop` 关闭 control socket、经 U2 `writeLocalInternalWorkControl(undefined)`
  在同一 internal lock 内删除 `[workControl]`、停止 receiver child；不删除 provider
  ledger 中的业务结果。仅移除本轮自有资源。
- receiver child 退出时 `consumerWork.dispose()` 释放连接；未终态 Work 由 provider 保留。
- provider 端未终态 Work 在 daemon stop 时按现有 `WorkHost`/ledger 语义处理；进程消失不
  等于完成，也不等于释放。
- 缺失 runner/架构不符/hash 不符时，除显式错误回执外不产生业务副作用，也不遗留子进程；
  失败清理必须可核验（无残留 runner 进程、无未关闭 channel）。

## 9. 未来 caller 与测试范围（待实现，非现有 PASS）

未来实现的最小 caller/owner 与测试文件（写作用途，最终由 Primary 与对应 unit owner 定稿）：

| 范围 | 未来文件 | 断言 |
|---|---|---|
| CLI 语法/JSON/错误 | `cli/agentteams.mjs`、`cli/agentteams.spec.ts` | `work submit`/`work query` 解析、stdout JSON 形状、显式错误码 |
| launcher socket 与 typed frame | U4：`runtime/local-work-control.ts`、`runtime/local-work-control.spec.ts`、`runtime/local-supervisor.ts`、`runtime/local-process.ts` 及其 tests。U2 顺序实施：`runtime/local-config.ts` 的 `[workControl]` schema/parser/serializer/locked-write primitive 与 `runtime/local-config.spec.ts` | token/generation/receiver 校验、correlation、未知 kind、断连不取消；launcher 实际创建/转发/关闭；U2 测试先证明 preserve/reload/start/stop/unclean-exit/stale-ref |
| receiver 执行接线 | `runtime/agent-process.ts`（去 configuredWork）、`runtime/agent-process.spec.ts` | 提交新 identity、query 不重放、runner/graph hash 校验 |
| runner 执行 | D3/U4 `runtime/dagpipe/host.ts`、`runtime/dagpipe-work.spec.ts` | 精确 graph、identity 隔离、host 不重排 |

未来黑盒命令序列（安装后的正式 CLI；本轮**未执行**，不是 PASS）：

```sh
# 前置：独立临时 HOME + 独立 npm prefix；config.toml 只含 provider/receiver/connect；
# provider searchRoot 下创建 A/B 两个不同标记 fixture。
export HOME="$test_home"; CLI="$prefix/node_modules/.bin/agentteams"
"$CLI" start

# BB04：submit A、submit B，再显式 query 原请求
"$CLI" work submit --config "$cfg" --payload '{"query":"marker-A"}' > "$ev/submit-a.json"
"$CLI" work submit --config "$cfg" --payload '{"query":"marker-B"}' > "$ev/submit-b.json"
work_a=$(node -e 'console.log(require(process.argv[1]).control.workId)' "$ev/submit-a.json")
req_a=$(node -e 'console.log(require(process.argv[1]).control.requestId)' "$ev/submit-a.json")
"$CLI" work query --config "$cfg" --work-id "$work_a" --request-id "$req_a" > "$ev/query-a.json"
# 断言：A/B workId/requestId 互异；submit-a 与 submit-b business 分别命中对应 fixture；
# query-a business == submit-a business，control.workId/requestId 原值，executionId/attemptId 新值；
# query 未新增 provider 执行。

# BB05：未授权 consumer / 未声明 operation / 旧 generation / 错误 target
"$CLI" work submit --config "$cfg_bad_op" --payload '{"query":"x"}'; test $? -ne 0
# 断言：各自显式错误、无新增 provider 执行/资源副作用、不表现为空结果或成功。

# BB07：提交后断开本地 socket 或停止自有 provider，再经新授权连接查询
"$CLI" work query --config "$cfg" --work-id "$work_a" --request-id "$req_a" > "$ev/query-after-disconnect.json"
# 断言：failed/unknown 与事实一致；get 不调用 propose/request、不新增业务执行；
# unknown 不自动重发/假释放；retained owner/状态/恢复动作明确；确认销毁后有最终回执。

# BB11：安装 CLI 真实提交与查询，再以隔离候选做 compile 负例
"$CLI" work submit --config "$cfg" --payload '{"query":"marker-A"}' > "$ev/bb11-submit.json"
"$CLI" work query --config "$cfg" --work-id "$work_a" --request-id "$req_a" > "$ev/bb11-query.json"
# 断言：submit/query 分别关联精确 graph、SDK、registry、CompiledGraph 与 journal；
# query 无新增业务执行；未注册 Operator / ARC 契约错误 / 缺 effects 的 compile 显式失败且无副作用；
# Object 字段约束由 typed boundary 验证，不冒充 SDK Record schema。
```

上述命令的 expected 结果以 §2 的 JSON 形状与 §6 的 identity 事实为准；黑盒 receipt 必须
绑定 candidate commit/tree、安装包版本/hash、runner/graph/manifest 指纹、配置 revision、
公开请求与结果、实际副作用、失败终点和资源收尾。

## 10. 保留的依赖义务与集成条件

- U2、D3/U4 候选均**未合并、未安装**；本文不宣称 admission 成功，不修改其候选树。
- 实现前必须把本文接缝与 U2 `connect`、D3/U4 `host.ts`/`protocol.ts`、U1 pack manifest
  冻结到同一候选树，再运行 §9 的未来测试与项目契约要求的适用验证。
- 已有 B2 `agent-work.graph.json` 与 B8 `work-query.graph.json` 保持拓扑真源，不改写、不新增
  第二套图；本文只声明公开 caller 与 typed IPC 边界。

## Primary 设计消费澄清

作者30412 exit0/turn.completed 后已停写。Primary 补齐 submit/query 帧中 CLI 生成身份的完整
传递，明确原 SDK receipt/错误保真、未投递/未收到终态不冒充 provider unknown/资源保留，
并列出缺失的既有 launcher/内部配置 caller。以上为编码前契约修订，不是实现证据。
`runtime/dagpipe/manifest.json` 和包布局引用 U1 已准入的
`docs/design/teams-package-delivery.md`（设计 main6526667），是最终包要求；U1 当前基础包
尚未生成该 runner manifest，故不能写成已可运行的安装对象。D3 依赖表中的 tree 是其
基线 Git tree，不包含未跟踪的 runner 源码；这些源码身份以 dependency-bindings.txt 中
独立的完整文件哈希绑定，不冒充已提交候选树。
