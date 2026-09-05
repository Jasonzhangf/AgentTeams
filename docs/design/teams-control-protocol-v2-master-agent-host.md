# Teams Control Protocol v2 - Master Console Host + Agent Host

状态：`design`
项目：Teams
治理：AppSDK `0.1.6`

本文件定义 Teams 的目标运行架构：由一个 Master Console Host 控制无数个 Agent Host，每个 Agent Host 包装一个独立 Agent runtime。v2 不再把 `console-host` 当作直接连接单个 OpenCode server 的垂直切片，而是把主控聚合和单 Agent 适配拆成两层可独立部署的网络节点。

## 1. 目标架构

```text
Master Console Host
  - 五入口 UI
  - 多 Agent 聚合 projection
  - Session/notification/permission 控制入口
  - Search/Memory 插件
        |
        | account + discovery + relay ticket
        v
Registration / Gateway Server
  - 账号与权限
  - Agent Host 目录
  - 网络地址、TIP、Gateway 端口
  - relay/gateway 指示
        ^
        |
  Agent Host CLI A  +---+ OpenCode Agent A
  Agent Host CLI B  +---+ ACP/Claude/自定义 Agent B
  Agent Host CLI C  +---+ 远端机器 Agent C
```

每一台 Agent Host 启动后主动向 Registration/Gateway Server 汇报自己的网络、身份、能力、Agent 状态和可达地址。Master Console Host 使用同一账号从服务器发现可用 Agent Host，然后建立控制连接。一个 Master 到一个 Agent Host 只维护一个物理 WebSocket target transport；该连接通过 typed channel multiplex 承载多个 Agent Session，避免每个 Session 重建物理连接。

## 2. 核心边界

- Agent runtime 是 Session、Conversation、Permission、Tool 结果的 truth owner。
- Agent Host 是 Agent runtime 与 Master Console Host 之间的适配节点，不替代 Agent runtime。
- Master Console Host 只持有 typed projection、连接引用、控制命令、关系图和通知索引。
- Server 只保存账号、目录、admission、relay/gateway 和遥测需要的控制字段；不保存 Session 正文、permission body、provider 密钥。
- UI 不直接连接 Agent Host、不直接读 Agent runtime 私有 API、不重建 permission 或 transcript owner。
- Directory control connection、Agent Host target transport、Session logical channel 是三个不同资源；任一资源不得代替另一个资源的生命周期 owner。
- transport control frame 与 Session business frame 使用不同的封闭类型；`auth`、`endpoint`、`route`、`generation`、`health`、`retry`、`config` 和 diagnostics 不得进入 Session message 或 metadata。
- DSH adapter 仍为 deferred，不作为 v2 当前实现 gate。

## 3. Agent Host CLI

Agent Host CLI 是每个 Agent 旁边的独立 adapter 进程，职责：

1. 发现：启动后向 Registration/Gateway Server 注册 identity、capability、agent/session 状态、网络可达入口。
2. 适配：把具体 Agent 的协议翻译成 Teams Control Protocol。
3. 控制：接收 Master 标准化命令，并翻译为 Agent runtime 真实调用。
4. 网络：维护到 Server 的注册控制连接，发布可达候选，并接受 Master 通过 direct 或 relay/gateway 建立的 target transport。

Agent Host 不实现五入口 UI，不承载 Agent 业务 truth，不保存主控侧关系图，也不自行选择 Master 的连接路线。它只消费 network owner 已建立的 typed transport，并把 Session channel 调用交给具体 Agent adapter。

## 4. Master Console Host

Master Console Host 是所有 Agent 的指挥中心，职责：

1. 使用账号登录 Registration/Gateway Server。
2. 查询并发现属于同一账号的 Agent Host。
3. 对每个 Agent Host 建立并维护一个可复用的 WebSocket target transport。
4. 聚合 Machine/Agent/Session/Notification/Relation projection。
5. 提供五入口 UI：Topology、Conversations、Notifications、Search、Memory。
6. 将 UI action dispatch 到对应 Agent Host 的 Session logical channel：open session、send message、reply permission、ack notification。
7. 管理 Search/Memory 插件生命周期。

## 5. 连接拓扑

### 5.1 Agent Host 启动

```text
Agent Host CLI start
  -> 初始化 Agent adapter
  -> 读取 Machine/Agent 身份配置
  -> 恢复稳定 hostId、machineId、agentId
  -> 建立独立的 Server registration control WebSocket
  -> 完成账号或 shared key/token admission
  -> 上报 direct endpoint / relay endpoint / TIP / Gateway port
  -> 定时发布 presence、capability 和目录 revision
  -> 监听 direct ingress，并接受 Gateway 转发的连接请求
```

### 5.2 Master 启动

```text
Master Console Host start
  -> 登录/鉴权
  -> 建立独立的 account directory control WebSocket
  -> 接收 confirmed Agent Host directory generation
  -> 选择目标 Agent Host
  -> network owner 解析显式 route plan
  -> 建立一个 Agent Host target WebSocket
  -> 完成 target hello / generation / capability 握手
  -> 按需要打开一个或多个 Session logical channel
  -> 持续接收 event 与通知
```

### 5.3 网络选择

- Server 目录发布稳定 `hostId` 及一组 typed route candidates；endpoint 变化不改变 Agent Host identity。
- `manual` 模式只尝试用户指定 candidate；失败即显式失败。
- `auto` 模式消费 Server 确认的有序 route plan。前一 candidate 失败并完成资源清理后，network owner 才能进入下一条已登记 candidate；这不是调用方 fallback，也不能静默改写成功结果。
- route directory 更新只影响下一代连接。当前健康 target transport 不因目录刷新、UI 切换、Session 切换或新增 Session 被关闭。
- 每一代 target transport 绑定 `targetGeneration`。旧 generation 的 open、message、close、error 和 heartbeat 必须被拒绝。
- 路由成功只在 WebSocket target handshake 和 protocol hello 完成后确认；TCP/WS open 不能提前投影为 Agent 可用。

### 5.4 三种连接资源

| 资源 | 生命周期 | 唯一 owner | 内容 |
|---|---|---|---|
| Registration control connection | Agent Host 进程级 | `network` | 注册、presence、endpoint、capability revision |
| Account directory control connection | Master 进程级 | `network` | 登录状态、目录 snapshot/delta、route plan revision |
| Agent Host target transport | Master 与单个 Agent Host 级 | `network` | target control frame 与 Session channel frame |

Registration/Gateway Server 只参与前两类控制连接和 relay 转发。直连成功后，Session business frame 不经过目录存储；relay 模式也只能转发加密 transport frame，不能解析或持久化 Session payload。

## 6. 协议分层

### 6.1 Bootstrap / Directory 层

使用 HTTPS/HTTP JSON 或专用 directory WebSocket，只处理注册、发现、鉴权、目录、relay ticket 与 route plan：

- `host.register`
- `host.presence`
- `host.directory.put`
- `host.directory.remove`
- `master.login`
- `master.list_hosts`
- `master.resolve_host`
- `master.route_plan`

目录 API 只返回 typed control facts：host identity、capability revision、candidate endpoint、TIP/Gateway 端口、auth 模式、route generation 和 freshness。目录响应不包含 Session 正文、permission body 或 provider/model secret。

### 6.2 Transport / WebSocket 层

Master 与 Agent Host 建立 target transport 后，先完成 target control handshake，再打开一个或多个 Session logical channel。即使一个 transport 上复用多个 Session，传输层也必须把 target control 与 Session channel 隔离为不同类型。

#### Target control frames

只允许 target 级控制语义，不携带 Session body：

- `transport.hello`
- `transport.hello_ack`
- `transport.ping`
- `transport.pong`
- `transport.health`
- `transport.generation`
- `transport.capability`
- `transport.route_info`
- `transport.error`
- `channel.open`
- `channel.open_ack`
- `channel.close`
- `channel.close_ack`
- `channel.error`

#### Session logical channel frames

Channel 建立后，channel payload 是 Agent Session 业务语义：

- `session.list`
- `session.current`
- `session.open`
- `session.message`
- `session.message_delta`
- `permission.ask`
- `permission.reply`
- `notification.upsert`
- `notification.ack`
- `relation.report`

控制字段（`machineId`、`endpoint`、`route`、`generation`、`health`、`retry`、`config`、diagnostics）只存在于 target control frame；Session channel payload 不得携带它们。

#### 连接生命周期

```text
target WS open
  -> transport.hello(hostId, agentId, targetGeneration, protocolVersion)
  -> transport.hello_ack
  -> channel.open(sessionRef)
  -> channel.open_ack(channelId)
  -> session.message / session.message_delta / permission.ask / notification.upsert
  -> channel.close / channel.close_ack
```

Master 必须保持逻辑 Session 引用稳定。target transport 断开时，已打开 channel 进入显式 disconnected/error 状态；network owner 在同一 Agent Host identity 上重建 target transport，Session owner 决定是否恢复或创建新的 Session 引用。旧 generation 的 channel 事件必须被拒绝。

## 7. 消息模型草案

```ts
interface HostIdentity {
  hostId: string
  machineId: string
  agentId: string
  accountId: string
  agentKind: "opencode" | "acp" | "custom"
  label: string
}

interface HostDiscovery {
  host: HostIdentity
  capabilities: readonly string[]
  route: {
    kind: "manual" | "auto"
    candidates: readonly RouteCandidate[]
    generation: number
    confirmedAt: string
  }
  tip?: string
  gatewayPort?: number
  health: "starting" | "ready" | "error"
  updatedAt: string
}

interface RouteCandidate {
  candidateId: string
  kind: "lan" | "tailscale" | "ipv6" | "ipv4" | "gateway" | "relay-ws" | "relay-webrtc"
  endpoint?: string
  port?: number
  authRequired: boolean
  lastSeenAt: string
}

interface TargetControlFrame {
  frame: "transport"
  targetGeneration: string
  message:
    | { type: "transport.hello"; host: HostIdentity; protocolVersion: string }
    | { type: "transport.hello_ack" }
    | { type: "transport.ping"; sentAt: string }
    | { type: "transport.pong"; sentAt: string }
    | { type: "transport.generation"; generation: string }
    | { type: "transport.route_info"; route: HostDiscovery["route"] }
    | { type: "transport.error"; code: string; message: string }
    | { type: "channel.open"; channelId: string; sessionRef: SessionRef }
    | { type: "channel.open_ack"; channelId: string }
    | { type: "channel.close"; channelId: string; reason: string }
    | { type: "channel.close_ack"; channelId: string }
    | { type: "channel.error"; channelId: string; code: string; message: string }
}

interface SessionChannelFrame {
  frame: "session"
  targetGeneration: string
  channelId: string
  message:
    | { type: "session.list"; requestId: string }
    | { type: "session.list_result"; requestId: string; sessions: SessionSummary[] }
    | { type: "session.current"; requestId: string }
    | { type: "session.open"; requestId: string; sessionId: string }
    | { type: "session.message"; requestId: string; sessionId: string; message: string }
    | { type: "session.message_delta"; sessionId: string; delta: unknown }
    | { type: "permission.ask"; requestId: string; permissionRequest: PermissionRequestRef }
    | { type: "permission.reply"; requestId: string; permissionId: string; action: "once" | "always" | "reject" }
    | { type: "notification.upsert"; notification: NotificationModel }
    | { type: "notification.ack"; requestId: string; notificationId: string }
    | { type: "relation.report"; report: unknown }
}

interface SessionSummary {
  sessionId: string
  title?: string
  status: string
  updatedAt: string
  unreadNotifications: number
}

interface SessionRef {
  hostId: string
  agentId: string
  sessionId: string
}

interface PermissionRequestRef {
  hostId: string
  agentId: string
  sessionId: string
  permissionId: string
}

interface NotificationModel {
  notificationId: string
  hostId: string
  agentId: string
  sessionId?: string
  permissionId?: string
  priority: "low" | "normal" | "high" | "critical"
  status: "pending" | "processed"
  occurredAt: string
}
```

`SessionChannelFrame.targetGeneration` 只用于 channel 归属校验，不进入 Session 业务 payload；业务请求本身只携带 `sessionId`、正文或必要引用。Session 正文只能出现在已打开 channel 的业务帧内。

控制请求可省略，改为 typed transport frames；如需保留 JSON-RPC 兼容命令层，只允许用于 target control channel 的请求/响应，不得混入 Session channel payload。

```ts
interface ControlRequest<TBody extends object> {
  jsonrpc: "2.0"
  id: string
  method: string
  params: {
    controlGeneration: string
    body: TBody
  }
}

interface ControlResponse<TResult> {
  jsonrpc: "2.0"
  id: string
  result?: TResult
  error?: {
    code: string
    message: string
    detail?: string
  }
}
```

JSON-RPC 层只处理 target control 方法，例如 `agent.current_session` 的引用查询；`send_message` 和 `reply_permission` 进入 Session channel 时才携带业务正文或 permission action。

## 8. 模块划分

| 模块 | owner | 职责 | 禁止路径 |
|---|---|---|---|
| `teams-control-protocol` | control-protocol | target frame/session frame schema、版本、错误码、channel 状态机 | 不解释业务内容 |
| `registration-server` | server | 账号、目录、admission、relay ticket、route plan | 不持有 session content |
| `control-transport` | network | directory connection、target transport、route plan、multiplex、heartbeat、重连、generation | 不翻译 agent 命令 |
| `agent-host-cli` | agent-host | 单 agent host 生命周期、注册、control ingress、channel 分发 | 不实现 UI |
| `opencode-adapter` | adapter-opencode | OpenCode 到 Agent Host channel API 的适配 | 不复制 transcript 所有权 |
| `acp-adapter` | adapter-acp | ACP 到 Agent Host channel API 的适配 | 不复制 transcript 所有权 |
| `master-console-host` | master-host | 多 host 连接、channel 聚合、action dispatch | 不直接操作 agent |
| `master-projection` | master-host | UI typed projection | 不承载权限 truth |
| `teams-ui` | ui | 五入口 UI、drawer、desktop/mobile | 不直接连接 agent host |
| `search-plugin` | search-plugin | connect/index/cache/query | 不进入控制面 |
| `memory-plugin` | memory-plugin | summarize/validate/save/load/export | 不进入控制面 |

## 9. 功能导航规划

### Topology

- 展示 Master 已连接的 Agent Host 拓扑。
- 每个 Agent Host 显示 Machine、Agent、capability、health、relation。
- Agent Card 主操作直接打开 current session。
- 点击 Agent Card 可展开抽屉，查看 Session 列表和相关属性。

### Conversations

- 聚合各 Agent Host 的活跃和近期 Session。
- 可按时间排序，支持当前 Session 快速进入。
- 消息发送由 Agent Host 转发给 Agent runtime。

### Notifications

- 唯一通知中心。
- pending/processed 区分。
- permission.ask 进入通知抽屉并可 allow/deny/reply。
- 点击通知可跳回 Agent 或 Session。

### Search

- 独立插件生命周期：connect/index/cache/query。
- 可搜索 Session、Notification、Memory 等 typed index。
- 搜索结果只返回引用和必要摘要，不返回训练/业务控制面。

### Memory

- 独立插件生命周期：summarize/validate/save/load/export。
- 每个 Session/Agent 可生成记忆记录并导出。

## 10. 实现阶段规划

### Phase A：协议与契约

- 定义 Control Protocol v2 target/session frame schema 与 channel 状态机。
- 定义 Registration/Directory API 和 route plan schema。
- 定义 WebSocket handshake、heartbeat、generation 和 multiplex 规则。
- 写 schema/error/state 测试。

### Phase B：Registration/Gateway

- 实现 Server 账号、目录、admission。
- 实现 host.register/host.ping/master.list_hosts。
- 实现 route plan、relay/ticket 控制面与目录 freshness。

### Phase C：Agent Host 基础

- 实现 Agent Host CLI。
- 实现 bootstrap 注册。
- 实现 WebSocket server、directory 控制连接与 target generation 握手。
- 实现 control/session frame multiplex 与 channel 生命周期。

### Phase D：具体 Agent 适配

- OpenCode adapter 演进为 Agent Host Session channel adapter。
- ACP adapter 作为后续通用 Agent 抽象。
- 自定义 CLI adapter 作为扩展面。

### Phase E：Master Console Host

- 实现多 Agent Host 连接管理器。
- 实现 network route plan 消费者与 target transport multiplex。
- 实现 typed projection。
- 接入五入口 UI。
- 实现 action dispatch。

### Phase F：Search/Memory 插件

- 在 Master Console Host 中接入插件生命周期。
- UI 只使用插件 projection。

### Phase G：真实验证

- 多 Agent Host 真实连接。
- 本机/远端/relay 网络验证。
- target transport 断开/重建、旧 generation 拒绝、Session logical channel 恢复规则。
- permission allow/deny/reply。
- Desktop 1440x960 / Mobile 390x844 Camo replay。
- AppSDK lifecycle records、review、effectiveness、merge/push、mainline receipt。

## 11. 治理和测试要求

- 每个 Phase 使用独立 claim、branch、worktree，位置在 main worktree 的 `playground/` 下。
- 每个模块有唯一 owner、allowed paths、forbidden paths 和 verification map。
- 控制面字段只进入 typed control resource；Session channel payload 可以承载正文，但禁止承载 routing/auth/health/retry/config/diagnostics。
- 禁止 fallback、silent strip、静默覆盖、重复 owner、伪造 lifecycle records。
- Adapter 必须有真实 Agent runtime/网络样本，不能只靠白盒 mock。
- Review 只能在安装、重启、真实入口验证完成后启动。
- DSH adapter 保持 deferred。

## 12. 验收定义

- OpenCode/ACP/custom Agent 可通过 Agent Host CLI 被发现。
- Agent Host 启动后能向 Server 注册并暴露本机或 relay 入口。
- Master 能用同一账号发现并连接多个远端 Agent Host。
- 单个 Master 到单个 Agent Host 的 WebSocket 可复用承载多个 Session logical channel。
- directory 刷新不关闭当前健康 target transport；旧 target generation 消息被显式拒绝。
- 五入口 UI 能聚合多个 Agent。
- Agent Card 能直接打开 current session。
- Session 消息、工具事件和审批由 Agent runtime owner 实际执行。
- permission.ask 可进入通知中心并完成 allow/deny/reply。
- Search/Memory 以独立插件生命周期工作。
- 桌面默认排版、手机布局、抽屉交互和五入口真实回放通过。
- AppSDK records、review、effectiveness、merge/push、远端 receipt 全部闭合。
