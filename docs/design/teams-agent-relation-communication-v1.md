# Teams Agent Relation and Communication Protocol v1

状态：`design`
项目：Teams
治理：AppSDK `0.1.6`

## 1. 目标

本协议定义同一 Teams 账号下多个独立 Agent Host 之间的关系建立、关系汇报、消息通信和 Master Console graph projection。

一个 Agent Host 只负责它本地 Agent 的适配与执行。Master Console Host 负责发现、路由、连接复用、关系图投影和跨 Agent 控制入口。Server 负责账号范围内的 admission、relation report 汇总和 graph projection。

## 2. 核心决策

### 2.1 一个 Agent 对另一个 Agent 的使用关系

关系由建立方发起：

```text
A 读取 B capability
  -> A 发送 consumer relation report
  -> B 接收使用请求并作出 capability decision
  -> B 发送 provider relation report
  -> Server 以同一 relationId 关联两侧 report
  -> Master 投影 relation graph
```

- A 是 `consumer`，B 是 `provider`。
- A 的 report 说明“我申请/正在使用 B 的 capability”。
- B 的 report 说明“谁正在使用我的 capability，以及当前 provider 状态”。
- 只有 capability permission owner 才能产生 `granted` 或 `revoked`；relation graph 不产生权限。
- 单侧 report 必须保留为 `consumer-only` 或 `provider-only`，不能猜测另一侧状态。
- 双侧状态不一致必须显示为 `conflict`，不能静默合并。

### 2.2 master/slave 与 peer

关系的事实模型永远是 capability consumer/provider，不直接保存“master/slave”权限语义。

- `master-slave` 是 graph 的显示分类：一个 Agent 以 capability 使用者身份依赖另一个 Agent。
- `peer` 是两个 Agent 之间存在双向 capability-use legs 的显示分类。
- peer 不是额外权限，也不绕过 server admission。
- 不允许通过 UI、关系分类或抽屉状态推导 authority。

### 2.3 Agent-to-Agent 通信

Agent-to-Agent 通信复用 Master 到每个 Agent Host 的 target WebSocket 和 logical channel registry：

```text
Master -> target transport(A) -> pair channel -> A
Master -> target transport(B) -> pair channel -> B
```

Master 是第一版唯一 relay owner。Agent Host 不直接发现或连接另一个 Agent Host，也不创建第二套 socket。

- relation report 决定通信请求的业务上下文，但不授予通信权限。
- pair channel 的 `fromAgentId`、`toAgentId`、`relationId` 和 `targetGeneration` 只存在于 typed channel-control resource。
- pair channel business message 只包含 typed message kind、correlation id 和业务 payload。
- business payload 禁止包含 routing、auth、health、generation、retry、config、diagnostics 或 permission decision。
- unknown agent、unknown relation、stale target generation、未打开 channel 和非法状态都必须显式失败。

## 3. Relation report contract

```ts
type RelationReportRole = "consumer" | "provider"
type RelationState =
  | "discovered"
  | "requested"
  | "allowed"
  | "denied"
  | "using"
  | "stopped"
  | "revoked"
  | "expired"

interface RelationReport {
  relationId: string
  reporterAgentId: string
  subjectAgentId: string
  capabilityId: string
  role: RelationReportRole
  state: RelationState
  reportRevision: number
  reportedAt: string
}
```

字段约束：

- `reporterAgentId` 是真实报告方；`subjectAgentId` 是关系另一端。
- consumer report 的 `reporterAgentId` 必须是使用方，provider report 的 `reporterAgentId` 必须是能力提供方。
- 两侧必须使用同一 `relationId`、`capabilityId` 和 Agent pair。
- report 不携带 Session 正文，不携带 permission body，不携带 credential。
- `reportedAt` 和 `reportRevision` 只用于 Server reconciliation，不用于客户端推导权限。

Server graph projection：

```ts
interface RelationGraphEdge {
  relationId: string
  consumerAgentId: string
  providerAgentId: string
  capabilityId: string
  classification: "master-slave" | "peer"
  consistency: "matched" | "consumer-only" | "provider-only" | "conflict"
  consumerState?: RelationState
  providerState?: RelationState
  lastReportedAt: string
}
```

`classification` 只由 graph projector 根据已确认的双边 capability legs 生成；它不是 admission result。

## 4. Pair channel contract

### 4.1 Channel control

Pair channel open 使用独立的 control resource：

```ts
interface AgentPairChannelRef {
  channelId: string
  relationId: string
  fromAgentId: string
  toAgentId: string
  targetGeneration: number
}
```

`AgentPairChannelRef` 只能出现在 `channel.open` / `channel.open_ack` / `channel.close` / `channel.error` 等控制帧中。

### 4.2 Business message

```ts
type AgentMessageKind =
  | "request.capability"
  | "reply.capability"
  | "task.result"
  | "notify"
  | "error"

interface AgentMessage {
  kind: AgentMessageKind
  correlationId: string
  payload: Readonly<Record<string, unknown>>
}
```

`messageId`、`relationId`、发送方、接收方、channel、generation 和路由状态属于外层 typed transport/channel control，不属于 `payload`。

### 4.3 消息顺序

```text
relation.requested
  -> pair channel.open
  -> pair channel.open_ack
  -> agent.message(request.capability)
  -> agent.message(reply.capability)
  -> agent.message(task.result | notify)
  -> pair channel.close
  -> pair channel.close_ack
```

消息 correlation 只关联一次请求与响应；不得生成 ACK loop、heartbeat message 或隐式 continuation。

## 5. 失败与生命周期

- relation report 失败不重写 Agent permission truth。
- pair channel 失败不伪造 relation revoked；两者分别回写各自 owner 的 error resource。
- target transport 重建后，旧 generation 的 pair channel frame 全部显式拒绝。
- Master route plan 只决定物理 target transport，不进入 pair channel business payload。
- relay 只能转发已建立 channel 的 typed frame，不持久化 Session 正文或 Agent message payload。
- 关系历史保留；presence stale 不等于 relation revoked。

## 6. 模块边界

| 模块 | owner | 责任 | 禁止 |
|---|---|---|---|
| `agent-relation` | `agent` | 生成 consumer/provider report，提供纯 graph 输入 | 不授予权限，不连接网络 |
| `agent-communication` | `control-protocol` | pair channel frame 与 business message schema | 不选择路由，不保存 transcript |
| `master-host` | `master-host` | pair channel 建立、relay、消息投影与 action dispatch | 不改 Agent permission truth |
| `network` | `network` | target transport、generation、route、channel lifecycle | 不解释 Agent message payload |
| `server` | `server` | 同账号 admission、report 汇总、graph projection | 不保存 Session/message 正文 |
| `agent-host` | `agent-host` | 将 pair message 分发到本地 adapter | 不直接连接 peer host |

## 7. 验收标准

- 两个不同路径、同一机器的真实 Agent Host 可分别注册为两个 Agent。
- Master Console Host 可同时发现两个 Agent，并为每个 Agent 保持独立 target transport。
- consumer/provider 双边 report 可以投影为 `matched` graph edge。
- 单边 report、冲突 report 和 stale generation 都保持显式状态。
- A 发往 B 的 capability request 经 Master relay 到达 B，B 的 reply 返回 A。
- A/B pair channel 复用既有 target transport，不创建每个消息一个 socket。
- 消息业务 payload 不包含 routing/auth/generation/control 字段。
- Camo 桌面与手机都能查看 graph、relation 状态和 pair message 结果。
- AppSDK verify/compile、定向正反测试、真实双 Agent replay 和 review evidence 全部闭合。
