# AgentTeams 行为 DAG 与生命周期模型 v1

本模型定义本地用户 MVP 的目标行为。审计基线与实现偏离见 [现状审计](teams-behavior-audit-20261002.md)。
graph JSON 是拓扑真源；以下中文图解释业务语义，映射表用于连接现有 owner，不是第二个执行图。
`teams.*@1` 是项目设计 binding。Work 五图使用的 10 个 Operator（`teams.admit-provider-work@1`、
`teams.open-work-link@1`、`teams.request-provider-work@1`、`teams.return-held-work@1`、
`teams.continue-provider-work@1`、`teams.close-provider-work@1`、`teams.settle-provider-work@1`、
`teams.resolve-peer-service@1`、`teams.query-provider-request@1`、
`teams.return-work-observation@1`）**已注册为 DAGpipe SDK Operator** 并由五图编译绑定；其余
`teams.*@1` 仍是设计 binding，尚未注册。目前实现由 TS 模块承担；缺失边明确标为待实现。
事件、具体 ARC、公开边界、宿主接入及执行分类见 [行为契约](teams-behavior-contracts.md)。SDK 的 Object 不证明字段契约已校验。

## 角色、对象与边界

- 用户：选择运行端点、提供或消费的服务、资源容量及模型。用户只编辑 config.toml。
- provider Agent：声明服务，独立决定匹配、权限及资源 admission，执行请求并管理 Work 资源。
- receiver Agent：按显式 target/service/operation 提交协作请求，不拥有 provider 的容量或权限。
- runtime：进程、启动归属、内部配置投影；network：链路、generation、连接与未知传输结果；server：目录与连接 admission。
- Console：可选观察/配置/Session 客户端；关闭它只关闭它自己的连接，不终止 provider Work。
- config：用户 provider/model 意图与版本提交；adapter：推导执行基座配置及保留 Session/工具/审批语义。

每次 graph 执行绑定 project/graph/version/execution/attempt；进程启动另绑定 owner token 和 generation。图无跨节点回边；生命周期可以产生下一次执行。
调用方选择重试必须遵守该对象语义：观察可重新查询，配置需重新读取 revision，未确认业务执行不得自动重放。

## 行为图

### B1 一次启动

文件：`dagpipe/graphs/daemon-start.graph.json`。输入 start.intent，输出 start.receipt。

```mermaid
flowchart LR
  A[编译用户运行意图] --> B[取得本轮进程归属]
  B --> C[启动本地通信桥]
  C --> D[接纳独立智能体登录]
  D --> E[发布已启用服务与资源]
  E --> F[确认端点可发现并回报就绪]
```

完成条件：bridge 和两个不同 PID daemon 在线，目录包含实际可用的 enabled 服务；不是仅进程存活或 HTTP health。
启动失败后停止本轮已启动的 children、撤销目录/监听并写失败 receipt；该失败由 runtime 调用 B6 收尾，不通过继续成功图隐藏错误。
启动不隐式完成用户 Work。已有 configured startup task 必须明确标为启动任务，不能替代用户提交。

### B2 一次 Agent Work

文件：`dagpipe/graphs/agent-work.graph.json`。输入 work.intent，输出 work.receipt。

```mermaid
flowchart LR
  A[查询目标的服务声明] --> B[验证目标并建立通信]
  B --> C[由能力方接纳本次协作]
  C --> D[由能力方接纳请求并执行及确认结果]
  D --> E[关闭已确认协作或保留未知责任并返回结果]
```

每次用户发起使用新 Work/request identity；相同幂等标识可查询原回执，但必须明确“已执行结果”。禁止把旧成功当新执行。
能力方决定容量与政策，provider/receiver 均允许一对多。超过容量、无权限、旧 generation、未声明 operation 均返回明确拒绝。
业务结果来自执行 payload；控制状态、route、generation、权限和执行诊断放 typed control/error chain，绝不镜像进业务 metadata。
资源结束条件：request allocation 经确认执行结束才释放；Work context 经 destroy 确认才释放。unknown 进入保留状态，不能沿成功 close 边假释放。
B2 v2 的 request 节点使用真实公开 request 契约，allocation/executor/record 留在 provider 内部；不假设存在三个可独立调度的远端 API。异常收尾由持有 typed ownership/dispatch facts 的宿主执行，不能从 journal 重建控制真相。

### B3 一次配置应用

文件：`dagpipe/graphs/provider-config.graph.json`。输入 config.intent，输出 config.receipt。

```mermaid
flowchart LR
  A[确认配置修改权限] --> B[按版本接受并保存用户意图]
  B --> C[推导执行基座配置]
  C --> D[应用本次配置版本]
  D --> E[读回生效版本并回报]
```

用户 TOML 表达 provider 实例、显式模型、绑定与 credential env reference；内部 TOML 表达发现的 catalog、accepted/effective revision、resolved 进程/路径及错误。
Console 修改必须进入同一 config owner 的版本事务，不新增第二份 editable JSON。迁移前当前 JSON store 是已有 durable owner，不可直接删除。
接受 revision 不等于生效。失败保留 accepted revision 与 apply error；无 silent fallback。empty catalog 可以显式添加模型，不猜模型。
字段级原子写入、两个 TOML 的并发责任及崩溃恢复需在配置 delivery unit 细化；不能凭图给不存在的事务保证。

### B4 一次 Console 观察

文件：`dagpipe/graphs/console-observe.graph.json`。输入 console.intent，输出 console.receipt。

```mermaid
flowchart LR
  A[验证观察入口身份和来源] --> B[发现可见端点]
  B --> C[读取授权端点状态]
  C --> D[生成观察视图]
  D --> E[返回页面所需状态]
```

目录负责 presence/generation/capability；Agent 管理入口负责 Session/config/Work 投影；Console 不重建运行真相。
目录离线行可显示但不能发送管理指令；Manager permission 拒绝与链路 unavailable 不能伪装成空成功。
取消/关闭只释放 Console listener、registration 和自身连接。此次观察结束不改变 Agent Work。

### B5 一次 Session 请求

文件：`dagpipe/graphs/session-request.graph.json`。输入 session.intent，输出 session.receipt。

```mermaid
flowchart LR
  A[由智能体确认会话操作权限] --> B[取得已生效的执行基座]
  B --> C[授予 prompt operation]
  C --> D[提交本次会话请求]
  D --> E[观察消息工具和审批结果]
  E --> F[返回真实会话结果]
```

source 契约已交付：daemon 在 dispatch 前登记唯一 prompt operation，并把 create/open/cancel 变体投影到 Console。live Console backend binding 与真浏览器会话回放仍待验证。
成功要保留消息、tool call identity/arguments/result、权限请求与回复的语义；approval pending 是进行中，不是完成。
取消经 Agent adapter 确认并收取最终状态；浏览器断开不等于请求已取消。被动能力 Agent 明确不支持 Session 合法，无需挂模型。

### B6 一次停止

文件：`dagpipe/graphs/daemon-stop.graph.json`。输入 stop.intent，输出 stop.receipt。

```mermaid
flowchart LR
  A[核实停止代次与进程归属] --> B[排空协作或记录未确认责任]
  B --> C[停止本轮拥有的子进程]
  C --> D[释放本轮连接监听与归属]
  D --> E[保存停止及保留责任回执]
```

generation/owner 不匹配必须拒绝，不触碰其他进程。进程 exit 不能证明外部 browser context 已销毁。
stop.receipt 可以是 stopped-clean、stopped-with-retained-obligations 或 failure；只有 stopped-clean 表示资源全收口。
unconfirmed 对象保留明确 owner/资源/恢复动作；不得无期限静默占用，也不编造回收成功。

### B7 一次版本交付

文件：`dagpipe/graphs/version-delivery.graph.json`。输入 delivery.intent，输出 delivery.receipt。

```mermaid
flowchart LR
  A[验证受影响源码与设计] --> B[构建唯一用户安装包]
  B --> C[安装并回放真实用户入口]
  C --> D[独立审查精确候选]
  D --> E[集成推送并确认远端版本]
  E --> F[回收本轮资源并交付回执]
```

用户安装包、runtime hash、安装入口及真实效果必须绑定精确候选。包内用户入口与治理安装 smoke 要验同一个对象。
代码未变不重跑全量。复用 `scripts/lifecycle-adapter.mjs` 的 stage state/fingerprint/receipt；目前其粗粒度 pnpm-verify/installed stage 不等于所有功能已有 fine-grained reuse。
失败进入项目既有阶段 blocked/invalidated；从首个失效节点重入，远端/PID/runtime 等可变边界刷新。候选改变使依赖图中受影响下游失效，不按会话重启失效。

### B8 一次 Work 查询或恢复观察

文件：`dagpipe/graphs/work-query.graph.json`。输入 work.query.intent，输出 work.observation.receipt。

```mermaid
flowchart LR
  A[查询原能力方声明] --> B[建立受权查询通信]
  B --> C[向能力方查询原请求结果]
  C --> D[返回原结果或未确认责任]
```

查询创建新的图执行身份，保留原 Work/request 身份；不重新 propose/request。连接收尾由宿主负责；query 成功不代表外部资源已销毁。后续显式清理走新的生命周期动作，unknown 返回保留责任和解除条件。BB04、BB07 验证查询不产生新业务执行。

### U5-Ua Console 启动

文件：`dagpipe/graphs/console-start.graph.json`。输入 console.start.intent，输出 console.start.receipt。
该图是静态治理产物，不是已注册的 DAGpipe SDK executable。

```mermaid
flowchart LR
  A[核验可选观察面启动请求] --> B[读取用户意图与内部观察面运行表]
  B --> C[以新代次启动唯一 Console 子进程]
  C --> D[确认监听、鉴权、注册和地址均就绪]
  D --> E[短锁写回运行事实并返回启动回执]
```

完成条件：Console 子进程已由 launcher/supervisor 拥有，listener exclusive bind、auth、registration 与实际 URL/origin 均确认，非零运行事实和 generation/startToken 已写入 `[consoleRuntime]`。Bridge、daemon 和 Work 不因本次启动改变。
成功图不表达失败拓扑。disabled、凭据缺失、asset 缺失、端口占用或资源收尾不明必须由 caller 以显式 `console.start.failed`/`console.retained` 回执结束；下一次启动是新 execution/attempt 和新的 Console generation，不能在图内回边重试。

### U5-Ub Console 停止

文件：`dagpipe/graphs/console-stop.graph.json`。输入 console.stop.intent，输出 console.stop.receipt。

```mermaid
flowchart LR
  A[核验停止代次与 Console 归属] --> B[仅停止 Console 子进程]
  B --> C[关闭自身监听、注册和连接]
  C --> D[确认进程退出与本轮资源责任]
  D --> E[短锁写回停止事实并返回停止回执]
```

完成条件：匹配 PID/startToken 的 Console 子进程、listener、registration 和自身连接均确认关闭，`[consoleRuntime]` 进入 stopped/failed/retained 的诚实状态。Bridge、daemon、Agent Work 和既有配置 slice 必须保持存活。
Console-only stop 不进入 B6 的 Work drain 节点。失败或 retained 不包装为 stopped-clean；caller 对 retained 责任发起独立恢复/清理动作，不把 B6 daemon stop 当作补偿路径。

### U5-Uc Console 状态观察

文件：`dagpipe/graphs/console-status.graph.json`。输入 console.status.intent，输出 console.status.receipt。

```mermaid
flowchart LR
  A[核验状态请求与代次] --> B[读取内部观察面运行事实]
  B --> C[只读观察子进程与 launcher 状态]
  C --> D[分类公开状态和错误]
  D --> E[返回不含秘密的状态回执]
```

完成条件：回执以 `[consoleRuntime]`、launcher generation 和实际子进程观察为事实来源；Launcher 未运行明确为 launcher=stopped，不把旧 PID/URL 显示为 online。查询不写持久事实，不授予管理权，不包含 password 值。

### U5 失败、取消与清理终点

以下端点与三张成功图分离，由 launcher/supervisor 的 lifecycle owner 调用；静态图本身不包含
回边或补偿节点。

| 当前外部动作 | 触发条件 | 外部可观察结果 | 清理/保留责任 |
|---|---|---|---|
| Console start | disabled | `outcome=failed, code=CONSOLE_DISABLED` | 无子进程/端口/状态写入 |
| Console start | 端口已被占用 | `outcome=failed, code=CONSOLE_PORT_OCCUPIED` | 只清理本轮已创建 Console 资源；既有 listener 不动 |
| Console start | credential env 缺失 | `outcome=failed, code=CONSOLE_CREDENTIAL_MISSING` | 不启动子进程 |
| Console start | asset 缺失 | `outcome=failed, code=CONSOLE_ASSET_MISSING` | 只清理本轮已创建 Console 资源 |
| Console start | generation 不匹配 | `outcome=failed, code=STALE_GENERATION` | 零状态改写 |
| Console start | 取消或启动进程结果未知 | `outcome=retained` | 保留 PID/listener/registration owner、资源与恢复动作 |
| Console stop | 无匹配进程 | `outcome=failed, code=NOT_RUNNING` | 保留当前 `[consoleRuntime]` |
| Console stop | generation/PID/startToken 不匹配 | `outcome=failed, code=STALE_GENERATION` | 零状态改写，不触碰其他进程 |
| Console stop | listener/registration/exit 无法确认 | `outcome=retained` | 保留 Console owner、资源、恢复动作；不得写 stopped-clean |
| Console status | 文件/socket/子进程观察不可读 | `outcome=failed, code=CONSOLE_STATUS_UNAVAILABLE` | 无状态写入；不虚构 online |

成功图只有一条成功出口；调用者必须在收到失败/retained 后走上述独立终点的证据流程。下一次
start/stop/status 是新的 execution/attempt 身份，最新 generation 由 launcher 决定。

## 状态机与异常终点

静态 graph 画正常的数据依赖，不表达全部条件控制流。预期业务拒绝可返回 typed outcome；未知异常由 graph execution failure 终止，owner 执行适用 teardown 并保存失败 journal/receipt。
**DAGpipe Runtime 不会自动从 state transition 发图，也不会自动运行补偿或 cleanup**。本模型把触发责任留给项目 runtime，后续适配必须验证失败终点，不能把异常塞成假成功继续运行。

```mermaid
stateDiagram-v2
  state "未运行" as Off
  state "正在启动" as Starting
  state "可发现且就绪" as Ready
  state "正在停止" as Stopping
  state "明确失败" as Failed
  state "已停止且保留责任" as Retained
  [*] --> Off
  Off --> Starting: 用户启动，创建新代次
  Starting --> Ready: 登录和实际服务发布已确认
  Starting --> Failed: 校验或启动失败，收尾回执
  Ready --> Stopping: 用户停止且归属匹配
  Ready --> Failed: 必需子进程或连接明确失败
  Failed --> Stopping: owner 执行本轮收尾
  Stopping --> Off: 本轮资源已确认释放
  Stopping --> Retained: 外部资源结果未确认
  Retained --> Off: 核实并释放保留资源
  Off --> Starting: 用户重启，使用新执行和代次
```

```mermaid
stateDiagram-v2
  state "等待能力方接纳" as Proposed
  state "已接纳协作" as Accepted
  state "正在执行请求" as Executing
  state "执行结果已确认" as Confirmed
  state "结果未知且资源保留" as Unknown
  state "正在关闭" as Closing
  state "已关闭并回收" as Closed
  state "明确拒绝" as Rejected
  [*] --> Proposed: 新协作请求
  Proposed --> Accepted: 权限能力与版本匹配
  Proposed --> Rejected: 容量权限或版本不满足
  Accepted --> Executing: 资源分配成功并发送请求
  Executing --> Confirmed: 收到真实成功或失败结果
  Executing --> Unknown: 执行或传输结果无法确认
  Executing --> Confirmed: 取消被执行方确认
  Confirmed --> Closing: 请求关闭本次协作
  Closing --> Closed: 外部资源销毁已确认
  Closing --> Unknown: 外部销毁无法确认
  Unknown --> Confirmed: 查询或恢复确认本次结果
  Closed --> [*]
  Rejected --> [*]
```

```mermaid
stateDiagram-v2
  state "待提交修改" as Editing
  state "版本冲突" as Conflict
  state "用户意图已接受" as Accepted
  state "正在应用" as Applying
  state "生效版本已确认" as Effective
  state "接受但应用失败" as Failed
  [*] --> Editing
  Editing --> Conflict: 预期版本与当前不一致
  Conflict --> Editing: 重新读取后由用户提交
  Editing --> Accepted: 权限通过且版本事务成功
  Accepted --> Applying: 显式应用请求
  Applying --> Effective: 基座读回版本与接受版本相同
  Applying --> Failed: 编译启动或读回失败
  Failed --> Applying: 明确重试，创建新尝试
  Effective --> [*]
```

```mermaid
stateDiagram-v2
  state "会话请求待接纳" as Pending
  state "正在推理与调用工具" as Running
  state "等待权限决定" as Approval
  state "会话已完成" as Done
  state "会话明确失败" as Failed
  state "会话取消已确认" as Cancelled
  state "会话结果未知" as Unknown
  [*] --> Pending
  Pending --> Failed: 无权限或没有会话能力
  Pending --> Running: 生效基座接受请求
  Running --> Approval: 基座发起真实审批
  Approval --> Running: 用户批准并由基座接受
  Approval --> Failed: 用户拒绝且执行终止
  Running --> Done: 最终消息和工具结果已确认
  Running --> Cancelled: 基座确认取消
  Running --> Unknown: 连接断开且执行未确认
  Unknown --> Done: 后续查询确认原请求结果
  Done --> [*]
  Failed --> [*]
  Cancelled --> [*]
```

## Operator 设计绑定与实现 owner

下表按图内顺序列出，每个 operator_version 均为 `1`。Work 五图使用的 10 个 Operator 已注册为 DAGpipe SDK Operator 并由五图编译绑定（见本文开头）；其余名字只表示设计绑定，不声称已有注册实现。

| 图/中文行为 | Operator binding | 唯一 owner 与源码锚点 | 当前边界 |
|---|---|---|---|
| B1 编译意图；取得归属 | compile-local-intent；claim-daemon-owner | runtime：local-config.ts、local-process.ts | 已有；简化用户配置待补 |
| B1 启通信桥 | start-local-bridge | runtime：local-supervisor.ts，使用 server/relay-process.ts | 已有；server 独占监听 admission |
| B1 接纳 daemon | admit-local-daemons | server：relay.ts/admission.ts，runtime 驱动 agent-process.ts | 已有真实 socket 历史证据 |
| B1 发布服务 | publish-enabled-services | agent-host：cli-executor.ts，runtime/capability-publication.ts 投影 | 固定声明须改为 enabled 服务 |
| B1 回报就绪 | observe-local-ready | runtime：local-supervisor.ts/local-process.ts | 已有 |
| B2 查询声明；建立通信 | resolve-peer-service；open-work-link | network：relay-client.ts/work-channel.ts，runtime/agent-work-client.ts 消费 | 已有；公开 CLI Work 入口已交付 |
| B2 接纳协作 | admit-provider-work | agent：work-resource.ts，agent-host/work-host.ts 的 propose 公开入口 | 已有账本语义，禁止 CLI 复制 |
| B2 接纳请求并执行及确认结果 | request-provider-work | agent-host：work-host.ts 的 request 公开入口，内部使用唯一 ledger/executor | 已有公开契约；真实 enabled service 与 SDK 宿主接线已交付 |
| B2 确认关闭或保留并返回结果 | settle-provider-work | runtime：agent-work-client.ts 的 close/dispose；资源销毁仍由 provider 决定 | 用户 payload 回执已暴露；unknown 不 close 假释放 |
| B8 查询原请求；返回观察 | query-provider-request；return-work-observation | agent-work-client.ts 的 get → provider WorkHost.get，runtime projection | SDK 查询图已接；观察不重放、不更改资源状态；finally 释放查询连接 |
| B3 允许修改 | authorize-config-edit | agent-host：console-ingress.ts | 已有 |
| B3 接受意图 | accept-config-revision | config：runtime-config.ts，runtime/console-config.ts | JSON durable store 已有；TOML 用户源待接 |
| B3 推导配置 | derive-opencode-config | opencode-adapter：src/index.ts、src/managed-config.ts | 已有，派生输出非 editable |
| B3 应用与读回 | apply-opencode-revision；confirm-effective-revision | runtime：managed-config-owner.ts、managed-opencode.ts | 已有；配置 owner 保存 effective 事实 |
| B4 观察身份 | authorize-console-access | console-host：src/auth.ts/server.ts | 已有；可启动用户入口缺 |
| B4 发现端点；读 Agent | discover-visible-endpoints；read-authorized-agent-state | runtime：console-hub.ts、relay-console-client.ts；server 目录真源 | 已有；Agent managers policy 独立 |
| B4 视图；返回 | project-console-view；return-console-view | console-host：src/http-api.ts，ui/teams-console/ 消费 | 已有；用户包静态资源缺 |
| B5 会话授权 | authorize-session-request | agent-host：console-ingress.ts | 接口边界已有；daemon 已挂 managed Session facade，live 接线待验证 |
| B5 取得生效基座 | resolve-effective-runtime | runtime：managed-config-owner.ts | 已有 use() 契约 |
| B5 授予 prompt operation | claim-session-operation | runtime：agent-process.ts 的 per-session prompt record | 已有；dispatch 前登记唯一 operation，第二个 prompt 冲突 |
| B5 提交；观察；结果 | dispatch-opencode-session；observe-session-outcome；return-session-result | opencode-adapter：src/index.ts；runtime/agent-process.ts 组装 | source 契约已有；live Console backend binding 待验证 |
| B6 归属校验 | verify-stop-owner | runtime：local-process.ts | 已有 generation/token 校验 |
| B6 排空或保留 | drain-or-retain-work | agent-host：work-host.ts，runtime 驱动 | unknown 必须保留责任；外部清理验收待补 |
| B6 停止；释放；回执 | stop-owned-children；release-owned-runtime；persist-stop-receipt | runtime：local-supervisor.ts/local-process.ts/local-config.ts | 已有；验证全部 own 资源终点 |
| U5-Ua 核验；投影 | verify-console-start-request；resolve-console-child-projection | runtime：local-process.ts/local-config.ts | design pending；只读 U2 `[console]` 与 `[consoleRuntime]`，不写用户 intent |
| U5-Ua 启动；就绪；回执 | start-console-child；confirm-console-readiness；persist-console-start | runtime：local-supervisor.ts/local-process.ts | design pending；U5 拥有 PID/generation/startToken/state/url/origin/identity/error，使用 U2 同锁短写 |
| U5-Ub 核验；停止；释放 | verify-console-stop-request；stop-console-child；release-console-runtime | runtime：local-process.ts/local-supervisor.ts | design pending；只触碰 Console own child，不进入 daemon Work drain |
| U5-Ub 确认；回执 | confirm-console-termination；persist-console-stop | runtime：local-process.ts/local-config.ts | design pending；retained 必须保留 owner/资源/恢复动作 |
| U5-Uc 核验；读取；观察 | verify-console-status-request；read-console-runtime-facts；observe-console-child | runtime：local-process.ts/local-config.ts | design pending；读 launcher 事实和 B4 observe，不刷新配置 revision |
| U5-Uc 分类；返回 | classify-console-state；return-console-status | runtime：local-process.ts | design pending；公开状态不含秘密，旧事实不得伪装 online |
| B7 源码；构建；回放 | verify-affected-source；build-user-package；replay-installed-entry | development-governance：scripts/lifecycle-adapter.mjs、package.json | 分阶段 reuse 已有；用户 package 同源尚缺 |
| B7 审查；远端；清理 | review-exact-candidate；integrate-and-confirm-remote；cleanup-owned-delivery | primary integration owner：独立 review、Git、资源 receipt | 按现有授权闭环，不虚构 runtime Operator |

## ARC 契约与检查

CLI schema 仅使用 `Object`，不会校验下列字段。运行接入前必须在唯一 owner 中绑定现有 typed contract；这张表是设计约束，不是当前已通过的 SDK schema gate。

| ARC 组 | 必须保留的事实 | 验收方式 |
|---|---|---|
| start.intent→config.resolved→owner.claimed | config revision、endpoint/service intent、resolved references；pid/token/generation 控制资源 | 新 HOME 配置编译；invalid intent 不启动子进程 |
| bridge.ready→daemons.admitted→services.published→start.receipt | admission identity、directory generation、enabled declarations、真实 PID readiness | 两 daemon socket discovery；未启用 browser 不可匹配 |
| work.intent→service.resolved→link.verified | 显式 target/capability/version/operation，独立 business payload，link/generation control | target mismatch、旧代次明确拒绝 |
| work.admitted→execution.outcome | provider policy revision、work/request id、原 WorkReply；allocation/execute/record 是 provider 内部职责 | 一对多与超过容量拒绝，不能超卖 |
| execution.outcome→work.receipt | succeeded/failed/unknown、原业务结果、typed error、资源 confirmed/released/retained | 两次新操作结果不同；unknown 不重放、不假释放 |
| config.intent→edit.authorized→revision.accepted | expected revision、用户 provider/model、授权主体、durable revision | CAS 冲突、凭据缺失、重启持久化 |
| substrate.configured→substrate.applied→config.receipt | 派生配置 hash、实际 runtime readback、accepted/effective/error | RCC/显式备用独立请求，无自动 fallback |
| console.intent→console.authorized→directory.observed→agents.observed→view.projected→console.receipt | auth/origin 事实、可见目录 generation、Agent state 与错误、只读 projection | 真浏览器目录发现，越权失败；Console-offline Work |
| session.intent→session.authorized→runtime.resolved→session.dispatched→session.outcome→session.receipt | session/request identity、effective revision、消息/工具/权限语义、final/unknown | Console 真消息、一次真实 tool/approval 正反路径 |
| stop.intent→stop.authorized→work.settled→children.stopped→runtime.released→stop.receipt | expected generation/owner、confirmed external destruction、retained obligation、进程退出 | 旧代次拒绝；停止后 own PID/端口消失 |
| delivery.intent→source.verified→package.built→entry.verified→candidate.reviewed→remote.confirmed→delivery.receipt | exact candidate/tree/base、输入指纹、产物/runtime hash、review、remote SHA、cleanup | 阶段故障后恢复只跑失效节点；pack 安装→真实入口→远端→资源移除 |

## 必需验证与失效边

先运行受影响 graph 的 `dagpipe graph validate` 与 `inspect`。graph binding/owner 改变同时更新已有架构 map，不增加另一套 module registry。
各功能定向测试及真实入口见 [交付计划](../goals/teams-user-delivery-plan.md)。源码、依赖、配置、图、环境或产物变化按对应 ARC 依赖传播失效；仅文档解释变化无需重建全部 runtime。
本次 graph 校验不能把“目标映射”升级成“执行已接线”；产品开发必须先让独立 design review 通过，然后在作者真实入口验收后做独立 exact architecture review。
