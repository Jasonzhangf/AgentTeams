# Teams Control Protocol v1

状态：`design`

本文件是 Teams runtime implementation 前的协议级设计。它继承 [Teams 详细设计 v1](./teams-detailed-design-v1.md)，定义控制面资源、无状态鉴权、权限、配置同步和跨 Host 命令的边界。它不实现网络协议，也不定义 Session 业务 payload。

## 1. 协议原则

### 1.1 单一连接入口

默认部署为本机 Teams Federation Host plugin，文中简称 Console Hub：

```text
Browser
  -> local authenticated Console connection
      -> local Teams Federation Host plugin
          -> remote Machine connector
              -> remote DSH/OpenCode Host
```

Console Hub 不是云服务，也不是必须单独部署的服务器进程；它是本机插件里的多 Machine 聚合和控制投影层。Browser 不直接维护多个远程 Host 的 Cookie、WebSocket、CORS 或 Session stream。

### 1.2 控制面与业务面分离

控制协议只传输：

```text
identity
machine address
machine auth mode
connection generation
health
credential reference
permission decision
config revision
capability summary
command status
error classification
```

Session 的 prompt、assistant content、tool input/output、approval body、memory summary 和 Conversation event 不属于控制协议。它们由对应的 Agent/Session owner 通过既有业务接口处理。

禁止：

- 把 `machineId`、`endpoint`、`generation`、`health`、`routing` 或 `permission` 写入 Session `metadata`。
- 用 UI navigation state 伪造权限或连接成功。
- 用通知、Search 或 Memory projection 反向生成控制状态。
- 让 Console UI 作为跨 Machine 业务消息中继。

### 1.3 错误显式传播

控制错误必须进入显式 error chain：

```text
network-error
  -> auth-error
  -> permission-error
  -> config-error
  -> runtime-error
  -> projection-error
```

中间错误不能被压成空列表、`inactive` Agent 或业务成功。

## 2. v1 推荐决策

以下是 v1 实现默认值。全部决策已冻结；本文件不再保留 runtime implementation
前的业务审批阻塞项。

| 决策 | v1 推荐值 | 状态 |
|---|---|---|
| Console Hub | 本机 Teams Federation Host plugin 聚合层 | 已确定 |
| Machine authentication | 可选 shared API key/token；无 pairing | 已确定 |
| Account admission | v1 不做账号登录、pairing 或 grant | 已确定 |
| Permission | 显式 capability policy，默认拒绝 | 推荐 |
| Credential lifetime | 由 credential owner 管理；协议不创建 grant | 已确定 |
| Relation truth | A/B 双边能力使用报告；server 汇总生成 graph projection | 已确定 |
| Master/slave | 关系标签，不自动授予权限 | 推荐 |
| Cross-Machine command | Host-to-Host，UI 不中继 | 推荐 |
| Mobile mutation | 允许连接、Agent、审批权限配置；高风险操作二次确认 | 已确定 |
| Display name | Host 提供 canonical name；Console 只保存本地 alias | 已确定 |
| Bootstrap secret | Teams 只保存 opaque credential reference；secret 由外部 credential owner 保存；允许显式 no-auth | 已确定 |
| Config conflict | revision compare-and-swap；冲突显式返回，禁止覆盖 | 已确定 |
| Relation report lease | report 每 30 秒 heartbeat；90 秒无刷新标记 stale；历史 report 不删除 | 已确定 |

## 3. 身份和地址

### 3.1 标识

```ts
type ConsoleDeviceId = Branded<string, "ConsoleDeviceId">;
type MachineId = Branded<string, "MachineId">;
type AgentId = Branded<string, "AgentId">;
type SessionId = Branded<string, "SessionId">;
type CredentialRef = Branded<string, "CredentialRef">;
```

所有跨 Host ID 都是 opaque branded ID。UI 显示名不能替代 ID。

### 3.2 Relation 参与方

Relation 表示能力使用关系，不是装饰性的拓扑连线：

```text
A / consumer
  -> 读取 B 发布的 capability
  -> 向 B 申请使用
  -> 获准后使用 B
  -> A 报告读取、申请、使用和停止状态

B / provider
  -> 发布 capability
  -> 收到 A 的申请
  -> 允许或拒绝 A
  -> B 报告当前哪些 consumer 使用自己的 capability
```

A 和 B 可以位于同一 Machine 或不同 Machine。`master-slave`、`peer` 只作为 graph 的关系分类，不能替代 `consumer`、`provider`、`capability` 和报告状态。

### 3.3 Relation report freshness

Relation report 是带租约的观察事实，不是永久在线状态：

```text
report accepted
  -> heartbeat every 30s
  -> expire after 90s without refresh
  -> graph current state = stale
  -> historical report remains inspectable
```

Server 只根据 report 的 `observedAt` 和 `expiresAt` 计算当前 graph
projection；不替 consumer 或 provider 补写报告，不因过期删除历史，不把
`stale` 投影为 `stopped`、`denied` 或 `disconnected`。恢复时必须收到新的
真实 report，不能由 UI 或 server 自动恢复为 `using`。

### 3.3 Relation 双边报告

```ts
type CapabilityUseState =
  | "discovered"
  | "requested"
  | "allowed"
  | "denied"
  | "using"
  | "stopped"
  | "expired";

interface ConsumerUseReport {
  relationId: string;
  consumer: AgentAddress;
  provider: AgentAddress;
  capabilityId: string;
  relationPermission: "requested" | "granted" | "revoked";
  state: CapabilityUseState;
  reportedAt: string;
  reportRevision: number;
}

interface ProviderUseReport {
  relationId: string;
  provider: AgentAddress;
  consumer: AgentAddress;
  capabilityId: string;
  relationPermission: "requested" | "granted" | "revoked";
  state: "requested" | "allowed" | "denied" | "using" | "stopped" | "expired";
  reportedAt: string;
  reportRevision: number;
}

interface CapabilityUseGraphEdge {
  relationId: string;
  consumer: AgentAddress;
  provider: AgentAddress;
  capabilityId: string;
  classification: "master-slave" | "peer";
  relationPermission: "requested" | "granted" | "revoked";
  consumerState: CapabilityUseState;
  providerState: ProviderUseReport["state"];
  consistency: "matched" | "consumer-only" | "provider-only" | "conflict";
  lastReportedAt: string;
}
```

A 持有“使用 B capability”的关系权限，并报告自己的 `discovered`、`requested`、`allowed`、`using`、`stopped` 或 `expired` 状态。B 作为 capability provider 决定是否授予这条使用关系，并报告收到谁的请求、是否允许、当前谁在使用以及何时停止。Server 不替任何一方补写报告；它只按 `relationId + consumer + provider + capabilityId` 关联两份报告并生成 graph projection。

Graph 必须保留单边和冲突状态：

```text
consumer-only  -> 只收到 A 的报告
provider-only  -> 只收到 B 的报告
conflict       -> 双方 state 不一致
matched        -> 双方 state 可对应
```

Relation graph 不等于权限表。Graph 可以显示 A 使用 B，但不能据此新增 `approve.session`、`manage.agent-config` 或其他 capability。

### 3.4 地址解析

```ts
interface MachineAddress {
  machineId: MachineId;
  endpointRef: string;
  connectorKind: "dsh-host" | "opencode-host";
}

interface AgentAddress {
  machineId: MachineId;
  agentId: AgentId;
}

interface SessionAddress {
  machineId: MachineId;
  agentId: AgentId;
  sessionId: SessionId;
}
```

解析顺序固定：

```text
MachineId
  -> MachineConnection control resource
  -> optional shared credential validation
  -> capability policy
  -> host adapter
  -> Agent/Session business API
```

`SessionAddress` 只用于寻址；寻址信息不写入业务消息正文和 `metadata`。

## 4. Machine 无状态鉴权

### 4.1 鉴权前提

Machine 必须先拥有：

- server endpoint。
- machine identity。
- credential reference。
- connector kind。
- transport profile。

这些属于 `bootstrap-link-config` 和 `remote-machine-connection-config`，由 network/server owner 管理。v1 不创建 pairing challenge、pairing code 或 pairing grant。

### 4.2 鉴权流程

```text
User opens Settings
  -> enters endpoint and transport
  -> optional shared API key/token is loaded from credential reference
  -> receiver compares the configured credential
  -> server evaluates requested capabilities
  -> network connector establishes generation 1
  -> discovery projection becomes visible
```

v1 不创建 pairing challenge、pairing code 或 pairing grant。shared API key/token 只用于无状态一致性校验，不承载 Session 内容、权限结论或业务正文。

### 4.3 鉴权状态

```ts
type MachineAuthMode = "none" | "shared-api-key" | "shared-token";

interface MachineAuthConfig {
  mode: MachineAuthMode;
  credentialRef?: CredentialRef;
}
```

状态转换：

```text
unconfigured
  -> configured
  -> invalid-config
configured
  -> authenticated
  -> credential-mismatch
  -> disconnected
```

`none`、credential mismatch、invalid credential reference 和 transport failure 必须保持可区分；UI 不能显示为同一个 disconnected 状态。

### 4.4 鉴权失败

| 失败 | owner | UI 投影 |
|---|---|---|
| endpoint 无法解析 | network | `network-error` |
| transport 建连失败 | network | `connection-error` |
| credential 不一致 | network/server | `auth-error` |
| credential reference 无效 | config | `credential-config-error` |
| capability 不允许 | server | `permission-error` |
| Host adapter 不兼容 | adapter | `adapter-error` |

失败必须可重试，但不能自动切换到另一个 endpoint、credential 或权限集合。

## 5. 账号和权限

### 5.1 Owner

```text
network
  -> transport and health
server
  -> capability policy
  -> permission decision
runtime
  -> capability publication
UI
  -> renders decision
  -> submits typed command
```

Network 不拥有账号真相，UI 不拥有授权真相，Agent 不直接执行账号或权限判断。

### 5.2 能力集合

v1 能力按风险分组：

```ts
type Capability =
  | "observe.machine"
  | "observe.agent"
  | "observe.session"
  | "send.session"
  | "approve.session"
  | "cancel.session"
  | "manage.relation"
  | "manage.agent-config"
  | "manage.approval-policy"
  | "manage.machine-connection";
```

推荐默认 capability policy：

```text
observe.machine
observe.agent
observe.session
```

`send.session`、`approve.session`、`cancel.session`、`manage.relation`、`manage.agent-config`、`manage.approval-policy` 和 `manage.machine-connection` 必须由 server 的显式 capability policy 授予。Mobile 可以请求这些 capability；设备类型不自动改变授权结果。

### 5.3 权限判断输入

```ts
interface PermissionRequest {
  actor: ConsoleDeviceId;
  capability: Capability;
  target: MachineAddress | AgentAddress | SessionAddress;
  reason: "read" | "mutation" | "approval" | "configuration";
}

interface PermissionDecision {
  decision: "allow" | "deny";
  capability: Capability;
  target: string;
  expiresAt?: string;
  denialCode?: "missing-policy" | "expired" | "revoked" | "scope-mismatch";
}
```

目标和能力必须由 server 重新校验。UI 传来的 label、drawer 层级和关系类型不能成为授权依据。

## 6. Host-to-Host 命令

### 6.1 路由

```text
Console UI
  -> local Console Host
      -> server permission check
      -> selected MachineConnection
      -> DSH/OpenCode host adapter
      -> remote Host policy
      -> business owner
```

UI 不连接远端 Session API，不转发业务消息，不重试业务命令。

### 6.2 命令 envelope

Envelope 是控制资源，不是 Session 业务 payload：

```ts
interface HostCommand {
  commandId: string;
  target: MachineAddress;
  capability: Capability;
  operation:
    | "observe"
    | "open-current-session"
    | "send-session"
    | "approve-session"
    | "cancel-session"
    | "save-agent-config"
    | "update-relation";
  requestedAt: string;
}

interface HostCommandResult {
  commandId: string;
  status: "accepted" | "completed" | "rejected" | "failed";
  target: MachineAddress;
  errorCode?: string;
}
```

`HostCommand` 不嵌入 prompt、approval answer、tool input 或其他业务正文。业务正文由 adapter 按 operation 的业务 owner 单独提交。

### 6.3 幂等和重试

控制命令必须拥有稳定 `commandId`。network 可以重建连接，但不能在未知结果时自动重放 mutation。

```text
observe:
  connection retry allowed
mutation:
  result unknown -> explicit unknown/error
  no automatic replay
```

不得通过“再发一次”把审批、取消或配置保存变成隐式重复操作。

## 7. 配置同步和冲突

### 7.1 配置层次

```text
Bootstrap Link Config
  owner: network
  purpose: connect server

Shared Runtime Config
  owner: config
  purpose: versioned runtime policy and shared capability

Agent Local Runtime Config
  owner: config
  purpose: per-agent provider/model and attachments
```

Bootstrap Link Config 不参与 Agent provider/model 合并；Agent runtime config 不负责 endpoint 建连。

### 7.2 Agent 配置

```ts
interface AgentRuntimeConfig {
  machineId: MachineId;
  agentId: AgentId;
  provider: string;
  model: string;
  adapterProfile?: string;
  notificationEnabled: boolean;
  memoryEnabled: boolean;
  revision: number;
}
```

`provider` 与 `model` 是 required，并且以 `(machineId, agentId)` 为唯一配置地址。不得使用跨 Agent 隐式默认模型。

### 7.3 Compare-and-swap

```ts
interface SaveConfigRequest {
  target: "machine-connection" | "agent-runtime";
  machineId: MachineId;
  agentId?: AgentId;
  expectedRevision: number;
  value: unknown;
}

type SaveConfigResult =
  | { status: "saved"; revision: number }
  | {
      status: "conflict";
      expectedRevision: number;
      actualRevision: number;
      currentValue: unknown;
    }
  | { status: "rejected"; errorCode: string };
```

冲突处理：

```text
edit -> save(expectedRevision)
  -> saved
  -> conflict -> show current value + local draft
                  -> explicit reload or merge
```

Server/config owner 不覆盖用户新值，不静默合并，不把冲突降级为 saved。

## 8. Notification 与 approval

Notification 是业务 owner 的 projection，但“是否允许执行”仍经过 server permission。

```text
NotificationProjection
  -> target SessionAddress
  -> Console resolves MachineConnection
  -> server checks approve.session
  -> adapter focuses existing Conversation
  -> user submits answer
  -> remote business owner records result
  -> notification projection updates processed
```

UI 不直接设置 `processed`。业务结果未返回时，通知必须保持 pending。

## 9. Mobile 权限和高风险确认

Mobile 和 Desktop 共享同一个 `Capability` 和 `HostCommand` 语义。差异只在 layout 和 confirmation presentation。

Mobile v1 允许配置：

```text
manage.machine-connection
manage.agent-config
manage.approval-policy
```

高风险操作：

```text
approve.session
cancel.session
manage.agent-config
manage.approval-policy
manage.machine-connection
manage.relation
```

Mobile 必须在执行前显示：

- Machine。
- Agent。
- Session 或配置目标。
- 具体操作。
- 当前授权状态。
- 明确的确认和取消动作。

确认卡不是权限来源；它只是 UI 对 server 已返回的 permission decision 的显式呈现。

## 10. DSH/OpenCode adapter 边界

### DSH

```text
Teams typed control command
  -> DSH ClientContext/Slots
  -> existing Connection/Session Controller
  -> existing Conversation renderer
```

DSH adapter 可以复用当前 WebUI 的 Session、Conversation、approval 和 composer owner，不复制 transcript assembler。

### OpenCode

```text
Teams typed control command
  -> OpenCode PluginInput
  -> Promise<Hooks>
  -> OpenCode session/event SDK
  -> Teams typed projection
```

OpenCode adapter 不假设 DSH 的 `ClientContext`、Slot registry 或 root renderer。两个 adapter 共享领域类型和 error vocabulary，不共享 host mounting protocol。

## 11. 配置、鉴权和关系状态机

### Machine connection

```text
unconfigured
  -> editing
  -> syncing
      -> connected
      -> error
connected
  -> stale
  -> reconnecting
      -> connected
      -> disconnected
  -> revoked
```

### Agent runtime config

```text
loaded
  -> editing
  -> saving
      -> saved
      -> conflict
      -> error
saved
  -> applying
      -> applied
      -> apply-error
```

### Machine authentication

```text
unconfigured
  -> configured
  -> invalid-config
configured
  -> authenticated
  -> credential-mismatch
  -> disconnected
```

### Capability policy

```text
configured
  -> applied
  -> rejected
  -> conflict
```

### Capability-use relation

```text
discovered
  -> requested
      -> allowed
          -> using
              -> stopped
              -> expired
      -> denied
consumer/provider reports
  -> matched
  -> consumer-only
  -> provider-only
  -> conflict
```

`consumer-only`、`provider-only` 和 `conflict` 是 graph 的真实观测状态，不是成功或失败的替代词。

每个状态必须有真实 owner 和可观察 evidence；不能用 UI 的 optimistic state 替代 owner result。

## 12. 实现前 gate

### 协议

- 不创建 pairing code、challenge 或 grant。
- `none`、`shared-api-key`、`shared-token` 三种鉴权模式显式区分。
- 发送方和接收方的 shared credential 不一致时拒绝连接。
- Machine endpoint 和 connector kind 在 dial 前完成解析。
- Server 独占 capability policy 和 permission decision；不代替 Agent 发送 Relation report。
- Consumer Agent 和 Provider Agent 各自负责自己的 capability-use report。
- Graph projection 只关联双方 report，不从单边事实伪造另一边。
- Mutation 在 unknown result 时不自动重放。
- Config save 使用 revision compare-and-swap。
- Agent provider/model 以 Agent 为粒度独立保存。

### 边界

- Agent 无 network/config/server 直接依赖。
- UI 无 network/config/server/session truth。
- Search 不写 Memory。
- Memory 不写 Session metadata。
- Host command 不嵌入业务 payload。
- DSH/OpenCode adapter 不互相假设宿主协议。

### UX

- 五入口保持可见和可切换。
- Agent card 主动作仍是 current Session。
- Notification approval 仍直达 Conversation。
- Drawer header 上拉全屏、下拉关闭。
- Mobile/desktop 只改变 layout。
- 连接、授权、配置冲突和插件错误必须可见。

## 13. 进入 runtime implementation 的条件

以下条件已全部成立，项目从 design 进入 implementation：

1. Jason 已确定：不做 Machine pairing，使用可选 shared API key/token，无 credential 时显式 no-auth。
2. Jason 已确定：Relation 是 A/B 双边能力使用报告，server 汇总生成 graph projection。
3. Jason 已确定：Mobile 允许连接、Agent 和审批权限配置。
4. Console Hub v1 作为本机 Teams Federation Host plugin 的聚合层，不新增云服务。
5. `teams-control-protocol-v1.manifest.json` 与 resource/function/mainline/verification maps 一致。
6. DSH 与 OpenCode adapter 的真实宿主入口已分别验证。
7. Control payload 与 Session business payload 的边界有静态 gate 和反向测试。
8. Machine auth、permission、relation graph、config conflict、notification approval 至少有正向和反向测试设计。
9. 静态原型回放继续作为 UI reference fixture，不被 runtime 试验替换。
10. Host canonical name 是跨设备显示名真相；Console alias 仅是本地投影。
11. credential secret 不落 Teams 配置，只保存 opaque reference；无 reference
    时只能显式使用 `none`。
12. Relation report 使用 30 秒 heartbeat、90 秒 freshness TTL；过期只产生
    `stale` projection，历史 report 保留。
