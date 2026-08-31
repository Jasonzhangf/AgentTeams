# Teams 详细设计 v1

状态：`implementation-ready`

本文件把 [概要设计](../goals/teams-overview-design.md) 转换为可实现的页面、交互、数据和插件契约。当前静态实现 [multi-agent-console-prototype.html](./multi-agent-console-prototype.html) 是视觉和交互参考基线，不是 runtime 实现，也不是新的业务真相。

设计状态：v1 implementation-ready。协议、权限、显示名、凭据引用和
relation freshness 默认值已冻结。

## 1. 设计目标

Teams 是一个跨机器、跨 Agent 的观察、协作和控制入口。

用户必须能够：

1. 通过物理拓扑定位 Machine 和 Agent。
2. 从 Agent 卡片一次点击直接进入该 Agent 的 current Session。
3. 在同一个 focused Conversation 中继续使用 DSH 当前的消息、工具、审批和输入能力。
4. 按重要性和时间处理所有 Agent 的通知。
5. 以对话时间线查看 pinned、active、recent 和 history Session。
6. 通过 Search plugin 搜索 Session、Notification 和 Memory 的公开结果。
7. 通过 Memory plugin 对每个 Session 进行总结、保存、加载、检索和导出。
8. 在配置入口中配置远程 Machine 连接，并进入该 Machine 下每个 Agent 的独立 `provider` 与 `model` 配置。

非目标：

- 不重写 DSH 的 Agent loop、Session persistence 或 Conversation renderer。
- 不把控制服务器变成 Session 消息、工具结果或审批内容仓库。
- 不让 UI 直接管理 network、config、server 或 Session truth。
- 不从 `master-slave` 标签推导权限、调度或控制权。
- 不为 OpenCode 伪造 DSH `ClientContext` / Slot 挂载能力。

## 2. 参考基线与设计状态

### 2.1 参考实现

唯一静态参考：

```text
Teams/docs/design/multi-agent-console-prototype.html
```

已纳入参考基线的行为：

- Desktop 和 Mobile 共用五个语义入口：通讯录、对话、通知、搜索、记忆。
- Topology 中 Agent card 的主点击直接进入 current Session。
- Agent card 的详情通过右上角菜单进入，Session list 是详情中的次级路径。
- Session 页面复用 DSH Conversation 语义：消息流、工具事件、审批卡、composer 和发送。
- Notification badge 可以直接打开 Agent 的通知页；需要交互的通知可以直接进入对应 Session。
- Drawer 支持嵌套、header 上拉全屏、下拉关闭，内容区域仍可直接操作。
- 配置通过 topbar gear 进入，不增加第六个移动底部入口。
- Machine 配置 drawer 内可以进入该 Machine 下的 Agent 配置 drawer。
- 每个 Agent 显示独立的 `provider` 与 `model`。

### 2.2 设计态与实现态

```text
当前：设计文档 + 静态 HTML 原型 + AppSDK 0.1.6 治理记录 + OpenCode adapter 白盒包
未开始：真实 control server、DSH/OpenCode plugin 安装和 live adapter smoke
```

文档中的接口名是详细设计阶段的 typed contract 名称。它们在 runtime 实现前必须进入 function map、mainline call map 和 verification map，不能把设计符号当成已存在代码。

## 3. 信息架构

### 3.1 五个主入口

| 入口 ID | 中文 | 解决的问题 | 默认排序/组织 | 首要动作 |
|---|---|---|---|---|
| `console.topology` | 通讯录 | Agent 在哪台 Machine、处于什么关系 | Machine -> Agent -> Relation | 点击 Agent 进入 current Session |
| `console.conversations` | 对话 | 最近正在处理什么 | pinned -> active -> recent -> history | 打开 Session Conversation |
| `console.notifications` | 通知 | 现在什么最重要 | pending/interactive 优先，再按时间倒序 | 处理通知或进入 Session |
| `console.search` | 搜索 | 内容在哪里 | plugin 返回的 relevance + 时间 | 打开 Session、Notification 或 Memory |
| `console.memory` | 记忆 | 哪些上下文需要长期保留 | pending-save -> saved -> exported | 加载、保存、搜索或导出记录 |

配置不是第六个入口。它由 topbar 的 gear 进入 `console.settings`，Mobile 和 Desktop 均保持同一语义。

### 3.2 五个定位维度

```text
物理位置  -> Topology / 通讯录
时间      -> Conversations / 对话
重要性    -> Notifications / 通知
内容      -> Search plugin / 搜索
长期上下文 -> Memory plugin / 记忆
```

任何页面都不能单独承担其他维度的全部职责。例如，Topology 可以显示 attention 摘要，但不能替代 Notifications 的排序和处理状态。

### 3.3 入口状态模型

```ts
type ConsoleView =
  | "topology"
  | "conversations"
  | "notifications"
  | "search"
  | "memory"
  | "settings";

interface ConsoleNavigationState {
  view: ConsoleView;
  machineId?: string;
  agentId?: string;
  sessionId?: string;
  drawerStack: DrawerAddress[];
  sourceContext?: SourceContext;
}

interface SourceContext {
  view: ConsoleView;
  query?: string;
  filters?: Record<string, string>;
  scrollAnchor?: string;
}
```

`ConsoleNavigationState` 只属于 UI。它不能被序列化到 Session request、response 或 `metadata`，也不能被当成控制面 truth。

## 4. 页面详细设计

## 4.1 通讯录 / Topology

### Desktop

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Teams        3 machines · 8 agents       connected 2 · attention 3  ⚙      │
│ [global search] [status filter] [relation filter]                          │
├───────────────┬─────────────────────────────────────────────┬──────────────┤
│ MACHINE RAIL  │ TOPOLOGY                                    │ ACTIVITY     │
│               │                                             │              │
│ machine-a     │ machine-a                                   │ Needs review │
│  ├ planner    │  [planner card] ── peer ── [builder card]   │ approval     │
│  ├ builder     │                                             │ task         │
│ machine-b     │ machine-b                                   │              │
│  └ reviewer    │  [reviewer card] ─ master ─ [test-runner]  │ Recent       │
└───────────────┴─────────────────────────────────────────────┴──────────────┘
```

职责：

- Machine rail：Machine 名称、连接状态、live Agent 数量、attention 总数。
- Topology board：Machine zone、Agent card、关系边和筛选结果。
- Activity rail：跨 Machine 的待处理投影，点击后保存来源上下文并跳转。

Agent card 必须显示：

- Machine display name。
- Agent 稳定 ID 和 display label。
- `running`、`waiting`、`idle`、`disconnected`、`error` 状态。
- Session 数量。
- 未处理通知数量和最高重要性。
- 关系摘要。
- current Session 是否存在。

主点击行为：

```text
Agent card -> resolve current Session -> open Conversation
```

current Session 不存在时必须显示真实的空状态或错误状态，不能偷偷改成 Agent detail 或伪造新 Session。创建新 Session 是独立的显式动作。

### Mobile

Mobile 使用 Machine 分组下的纵向 Agent card，不在窄屏强行展示完整关系图：

```text
┌───────────────────────────┐
│ Teams                 ⚙   │
│ [搜索]              ● 8/3 │
├───────────────────────────┤
│ machine-a                 │
│ ┌───────────────────────┐ │
│ │ planner  ● running    │ │
│ │ 4 sessions  ! 2       │ │
│ └───────────────────────┘ │
│ ┌───────────────────────┐ │
│ │ builder  ◌ waiting    │ │
│ │ peer: planner         │ │
│ └───────────────────────┘ │
├───────────────────────────┤
│ 通讯录 对话 通知 搜索 记忆 │
└───────────────────────────┘
```

关系通过 card 内摘要、筛选和 Agent drawer 查看；实体和操作语义与 Desktop 完全相同。

## 4.2 对话 / Conversations

对话页是按时间组织的 Session 汇总，不是 Topology 的另一种渲染。

```text
Pinned
  Session row: title · agent · machine · notification badge · updated time
Active
Recent
History
```

Session row 必须支持：

- 直接打开 Conversation。
- 置顶/取消置顶。
- 显示 Agent、Machine、状态和最近更新时间。
- 显示通知数量；存在 interactive notification 时使用不同图标和文本。
- 从 Search、Notification 或 Memory 返回时恢复来源上下文。

Conversation focused mode：

- Desktop：保留可见的 Session header、消息区、工具事件和 composer；Topology 可作为背景或被 drawer 覆盖。
- Mobile：全宽 focused page/drawer；底部导航不抢占 Session 内 composer。
- 发送、取消、审批、工具结果和流式更新继续由 DSH Conversation owner 处理。
- 不在 Teams 中新建第二套 transcript assembler。

## 4.3 通知 / Notifications

通知中心分为 `pending` 与 `processed`，默认先按重要性，再按发生时间倒序：

```text
priority: interactive > error > task-complete > informational
within priority: occurredAt descending
```

通知类型：

| 类型 | 例子 | 主动作 |
|---|---|---|
| `task-complete` | 任务完成 | 查看结果或进入 Session |
| `approval-required` | ask / 双向确认 | 直接进入 Session 的确认位置 |
| `error` | Agent 或任务失败 | 查看错误上下文 |
| `message` | Agent 间或系统消息 | 查看消息来源 |
| `connection` | Machine 连接变化 | 打开 Machine 状态或配置 |

通知状态：

```ts
type NotificationState = "pending" | "processed";
type NotificationPriority =
  | "interactive"
  | "error"
  | "task-complete"
  | "informational";

interface NotificationProjection {
  notificationId: string;
  machineId: string;
  agentId: string;
  sessionId?: string;
  kind: NotificationKind;
  priority: NotificationPriority;
  state: NotificationState;
  title: string;
  summary: string;
  occurredAt: string;
  requiresInput: boolean;
  target: "session" | "agent" | "machine" | "notification";
}
```

通知在 Topology 的呈现：

- Agent card 旁显示 notification icon + count。
- 有新 pending notification 时 icon 做一次短的 opacity/translate 提示。
- `prefers-reduced-motion` 下只更新 icon、文本和 count。
- 不使用 pulse、颜色或边缘动画作为唯一状态信息。

交互路径：

```text
Topology Agent notification icon
  -> Agent Notifications
  -> notification row
  -> session target
  -> focused Conversation at approval/message anchor
```

如果通知没有 Session target，必须打开对应 Agent 或 Machine detail，并明确显示不能直接进入 Session 的原因。

## 4.4 搜索 / Search plugin

Search 是独立插件，不是 UI 对 Machine/Agent 名称的本地过滤。

生命周期：

```text
connect
  -> discover sources
  -> build/update index
  -> cache status
  -> query
  -> typed SearchResult[]
```

页面必须显示插件状态：

```text
connecting | indexing | ready | stale | permission-denied | error
```

搜索范围：

- `session`
- `notification`
- `memory`
- 默认 `all`

```ts
interface SearchRequest {
  query: string;
  scope: "all" | "session" | "notification" | "memory";
  machineId?: string;
  agentId?: string;
  state?: string;
}

interface SearchResult {
  resultId: string;
  source: "session" | "notification" | "memory";
  machineId: string;
  agentId: string;
  sessionId?: string;
  title: string;
  excerpt: string;
  occurredAt?: string;
  relevance: number;
  target: "session" | "notification" | "memory";
}
```

Search result 打开实体时保存 `SourceContext`。关闭详情或 Conversation 后恢复关键词、范围、筛选和滚动锚点。

索引失败、缓存过期和权限不足不能投影为空列表。必须分别显示错误、stale 或 permission-denied。

## 4.5 记忆 / Memory plugin

Memory 是独立插件，拥有自己的记录、保存和导出流程。

生命周期：

```text
connect
  -> summarize Session
  -> validate draft
  -> save MemoryRecord
  -> load/search
  -> export
```

触发方式：

- 手动：用户在 Session 或 Memory 页面点击总结/保存。
- 自动：由配置启用的 session lifecycle 事件触发。

自动触发不能绕过验证和权限；生成草稿后必须明确显示 `pending-save`。

```ts
type MemoryState =
  | "summarizing"
  | "pending-save"
  | "saved"
  | "loaded"
  | "exported"
  | "error";

interface MemoryRecord {
  memoryId: string;
  machineId: string;
  agentId: string;
  sessionId: string;
  title: string;
  summary: string;
  keywords: string[];
  state: MemoryState;
  createdAt: string;
  updatedAt: string;
}
```

Memory 页面必须提供：

- 当前 Session summary 状态。
- 草稿与已保存记录区分。
- Load、Save、Search、Export 操作。
- plugin connection、permission 和 error 状态。
- 导出目标和结果。

Memory 记录不能写入 Session `metadata`；Search 可以索引 Memory 的公开输出，但不能修改 Memory truth。

## 4.6 配置 / Settings

Settings 由 topbar gear 进入，使用与其他实体相同的 nested drawer 协议。

第一层：远程 Machine 连接配置，owner 为 `network` / `server` 投影。

```text
Machine
  ├── endpoint
  ├── transport
  ├── auth reference
  ├── health
  ├── generation
  ├── reconnect policy
  └── local Agents
```

第二层：该 Machine 下单个 Agent 的本地 runtime 配置，owner 为 `config`。

```text
Agent
  ├── provider       required
  ├── model          required
  ├── adapter/profile
  ├── visibility
  ├── notification attachment
  └── memory attachment
```

`provider` 与 `model` 是每个 Agent 独立的核心配置，不使用跨 Agent 隐式默认值。配置保存后必须显示：

```text
editing -> syncing -> saved
                    └-> error
```

配置页面只发 typed command，不直接修改 Session、Notification 或业务 payload。

## 5. Drawer 交互协议

### 5.1 地址模型

```ts
type DrawerEntity =
  | "machine"
  | "agent"
  | "session"
  | "notification"
  | "task"
  | "message"
  | "approval"
  | "memory"
  | "settings";

interface DrawerAddress {
  entity: DrawerEntity;
  entityId: string;
  parentAddress?: string;
  sourceFocusId?: string;
}
```

Drawer stack 是 UI navigation resource，不缓存业务 truth：

```text
Topology
  -> Agent drawer
      -> Session list drawer
          -> Session / Conversation
              -> Approval or Task drawer
```

### 5.2 Header 手势

- 初始状态：半屏。
- header 向上拖动超过阈值：进入全屏。
- header 向下拖动超过阈值：关闭当前层。
- 点击 grab handle：半屏/全屏切换。
- `Escape`：关闭当前层。
- 只有 header 是拖拽区；内容区、输入框、滚动区保持原生操作。
- 关闭后焦点回到触发 card、通知 row、搜索结果或配置行。
- 背景 topology 不因 drawer stack 自动重排。

### 5.3 动画约束

只动画可合成属性：

```css
transform
opacity
```

禁止 `transition: all`。必须支持：

```css
@media (prefers-reduced-motion: reduce) {
  /* remove movement and pulse; retain state changes and focus */
}
```

动画语义：

| 状态 | 动画 |
|---|---|
| card selected | border/selection ring |
| drawer open/close | translateY + opacity |
| nested drawer | 新层进入，旧层保留上下文 |
| running | 轻微状态提示；无障碍模式静态 |
| notification arrival | 一次短提示，不抢夺滚动焦点 |
| save/approval result | icon swap + 文本状态 |

## 6. 共享组件和布局

### 6.1 共享语义组件

首版只定义一套组件语义：

```text
ConsoleShell
Topbar
PrimaryNavigation
MachineGroup
AgentCard
AgentStatus
AttentionBadge
NotificationRow
ConversationSurface
SearchResultRow
MemoryRecordRow
SettingsMachineRow
SettingsAgentRow
DrawerStack
DrawerHeader
FocusRestore
```

Desktop 和 Mobile 通过 layout adapter 选择排列方式，不复制业务组件和状态机。

### 6.2 响应式约束

Desktop：

- `machine rail + topology + activity rail` 三栏。
- Conversation 可以作为 focused drawer 或 focused page。
- 关系边可见，card 使用稳定尺寸。

Mobile：

- 单主焦点。
- Machine -> Agent 纵向分组。
- 五入口固定底部导航。
- Settings 通过 gear 进入，不增加底部入口。
- Conversation 全宽。
- 触摸目标不小于 44px。

两端必须保持：

- 同一实体 ID。
- 同一状态词。
- 同一主动作。
- 同一错误和权限语义。
- 同一 drawer push/pop/close 规则。

## 7. Runtime 和插件架构

### 7.1 推荐部署形态

采用本地 Federation Hub：

```text
Browser
  -> one local authenticated connection
      -> Teams Federation Host plugin
          -> Machine connector A
          -> Machine connector B
          -> Machine connector C
              -> typed control projections
                  -> Teams UI
```

浏览器只连接一个 Console Host，避免把现有 DSH 单连接模型隐式改造成多连接 Session 模型。

### 7.2 启动主线

```text
Bootstrap Link Config
  -> network resolve/dial
  -> server authenticate/account admission
  -> server permission decision
  -> config version handshake/sync
  -> runtime ready
  -> capability publication
  -> agent running
```

Network 与 daemon runtime 合并编排生命周期，但职责仍分开：

```text
network: link config, transport, health, reconnect
config: shared config truth, version, sync, apply
server: deployment, listener, connection registry, account, permission
runtime: daemon lifecycle + network lifecycle composition
agent: task/session abstraction, network-agnostic
```

### 7.3 DSH 与 OpenCode adapter

共享：

- typed federation domain model。
- Machine、Agent、SessionRef、Relation、Notification、SearchResult、MemoryRecord。
- 控制面错误分类和权限语义。
- UI semantic components 和 layout adapter。

DSH adapter：

```text
package.json dsh.client
  -> ClientContext
  -> client slots/module registry
  -> existing Session Controller
  -> existing Conversation renderer
```

OpenCode adapter：

```text
PluginInput
  -> Promise<Hooks>
  -> OpenCode session/event SDK
  -> Teams typed projection adapter
```

当前 OpenCode `1.18.15` v1 plugin contract 通过默认导出 `{ server() }` 提供
`PluginInput -> Promise<Hooks>`。可用的交互 hook 是 `permission.ask`；当前 `Hooks`
没有 `question.asked`，因此 Teams 适配器不伪造问题事件。Session 事件从
`sessionID` 或 `properties.info.id` 解析 Session identity，只输出 identity、kind、
request identity 和 interactive 标记，不转发事件业务属性。

白盒包提供 `createTeamsOpenCodePlugin(sink)` 供 OpenCode Host runtime 注入真实
report sink；默认安装导出只提供合法 `{ server() }` 形状，不伪造未接入的控制通道。
包内边界类型与已核实的 OpenCode `PluginInput/Hooks` 结构一致，但不直接编译
OpenCode 源码树，避免把宿主的开发依赖带入 Teams package。

两端不共享一个 host mounting bundle。共享的是 domain/core 和 typed adapter contract。

## 8. 控制面、业务面和错误链

### 8.1 控制资源

```text
machineId
endpoint
generation
health
authGrant
permissionDecision
routing
retry
reconnect
diagnostics
runtimeLifecycle
```

这些字段只允许进入 typed control side-channel、control resource 或 error chain。

### 8.2 业务 payload

```text
user prompt
assistant content
tool input/output
approval body
session event
conversation projection
memory summary
```

控制字段禁止写入业务 request/response `metadata`。业务 payload 也不得反向推断 Machine connection、权限或 runtime health。

### 8.3 错误分类

```text
network-error
auth-error
permission-error
config-error
runtime-error
projection-error
session-error
plugin-index-error
plugin-memory-error
ui-navigation-error
```

UI 必须保留错误分类和目标地址，不能把错误投影为空列表、成功状态或“Agent inactive”。

## 9. 关键主线

### 9.1 Agent current Session 快速路径

```text
AgentCard primary click
  -> resolve AgentNode currentSessionRef
  -> resolve MachineConnection by machineId
  -> call existing Session Controller
  -> focus existing Conversation surface
  -> restore source focus on close
```

Session list 是 secondary detail action，不得成为进入 current Session 的必经层。

### 9.2 Notification approval 路径

```text
notification icon
  -> Agent notification page
  -> pending approval row
  -> resolve sessionId + message/approval anchor
  -> focus Conversation
  -> user submits explicit answer
  -> Host-owned result
  -> notification becomes processed
  -> activity/topology counts update
```

UI 不直接把 approval body 写入通知数据库，也不自行标记完成；状态由业务 owner 的结果投影驱动。

### 9.3 Search / Memory 路径

```text
SearchRequest
  -> Search plugin index/cache
  -> SearchResult
  -> target drawer
  -> optional Session focus
  -> close
  -> restore SourceContext
```

```text
Session events
  -> Memory summarize
  -> validate draft
  -> save MemoryRecord
  -> Search index observes public record
  -> load/export
```

## 10. 实现切片

按风险和可验证性分阶段：

### Slice 1：共享 UI 语义和静态 vertical slice

- 固化五入口、Agent current Session 快速路径和 Drawer stack。
- 继续使用当前 HTML 作为 reference fixture。
- 不接真实 Machine 或 Session。

### Slice 2：DSH focused Session adapter

- 接入 `dsh.client` 和现有 Conversation owner。
- 一个 Machine、多个 Agent。
- 验证 current Session、消息发送、审批和 focus restore。

### Slice 3：本地 Federation Hub 与第二台 Machine

- Bootstrap link config、network connection、server admission、config sync。
- 两台 Machine 的 summary、权限和连接错误可区分。

### Slice 4：通知中心

- Notification projection、pending/processed、priority/time 排序。
- Topology badge 到 Agent notification 到 Session approval 的闭环。

### Slice 5：Search 与 Memory plugin

- Search index/cache/query typed output。
- Memory summarize/save/load/search/export。
- 搜索和记忆页面的来源上下文恢复。

### Slice 6：OpenCode adapter

- OpenCode v1 `{ server() }` package shape。
- PluginInput/Hooks 接入。
- Session/event projection 和 `permission.ask` 交互通知。
- 未暴露的 `question.asked` 能力不伪造。
- 不引入 DSH Slot 假设。

## 11. 验证设计

### 页面和交互

- Desktop `1440x960`。
- Mobile `390x844`。
- 五入口全部可见且可切换。
- Agent card 一次点击进入 current Session。
- Activity、Notification、Search、Memory 打开目标后可返回原来源上下文。
- Drawer 嵌套 push/pop。
- Header 上拉全屏、下拉关闭。
- 内容区输入、滚动和按钮操作不被拖拽机制劫持。
- Escape、关闭按钮和焦点恢复。
- 无横向溢出、缩放和文本增长不遮挡。

### 状态和反向验证

- `connected`、`stale`、`reconnecting`、`disconnected`、`unauthorized`、`error` 分开显示。
- Agent 无 current Session 时不伪造 Session。
- Notification 没有 Session target 时不伪造 Conversation。
- Search indexing/error/permission-denied 不变成空结果。
- Memory pending-save 未保存时不能显示 saved。
- 保存失败不能显示成功。
- 审批取消、失败和完成不能混淆。
- `prefers-reduced-motion` 下仍能识别所有状态和结果。

### 架构和插件

- Agent 不直接 import network、config、server。
- UI 不拥有 network/config/server/Session truth。
- Search 不写 Memory truth。
- Memory 不拥有 Session transcript truth。
- DSH adapter 只使用 DSH ClientContext/Slots。
- OpenCode adapter 只使用 PluginInput/Hooks/SDK。
- 控制字段不进入业务 payload 或 `metadata`。
- 机器地址解析先于 Session API 调用。

## 12. 已冻结的实现默认值

以下决定已进入 v1 实现契约：

1. Machine authentication 只提供显式 `none`、`shared-api-key`、
   `shared-token`；不做 pairing。配置服务器可执行最小一致性验证。
2. `master-slave` 和 `peer` 只是 graph 分类；实际控制必须由独立
   capability policy 授权，关系本身不自动授权。
3. 跨 Machine 业务命令只走 Host-to-Host；UI 不作为业务中继。
4. Machine/Agent 的跨设备 canonical display name 由 Host 提供；Console
   可保存本地 alias，但 alias 不改变 Host truth。
5. Teams 只保存 opaque credential reference；secret 由外部 credential
   owner 保存，不进入 Teams 配置、业务 payload 或 metadata。
6. Shared Runtime Config 使用 revision compare-and-swap；冲突显式返回，
   禁止 server 静默覆盖或合并。
7. Relation report 每 30 秒 heartbeat，90 秒无刷新进入 `stale`；历史
   report 保留，恢复必须由真实新 report 驱动。

实现默认值摘要：

```text
local Teams Federation Host plugin
optional shared API key/token; no pairing
relation is a consumer/provider capability-use graph
master-slave and peer labels have no implicit authority
Host-to-Host collaboration
mobile high-risk actions require explicit confirmation
full transcript only for selected Session
```

## 13. 实现入口和完成标准

以下条件已满足，允许进入 runtime implementation：

1. 五入口、Settings、Drawer、Conversation、Notification、Search、Memory 页面契约冻结。
2. current Session 快速路径和来源上下文恢复冻结。
3. network/config/server/runtime/agent owner 与控制面隔离通过 map 审查。
4. DSH/OpenCode adapter 的宿主差异写入实现契约。
5. 资源地图、函数地图、主线调用地图、验证地图同步到同一版本。
6. 静态原型作为浏览器 fixture，桌面和移动回放证据可复现。
7. 协议、权限、显示名、凭据引用和 relation freshness 默认值已冻结。

下一步固定为：

```text
Slice 1: shared UI semantic vertical slice
  -> Slice 2: DSH focused Session adapter
  -> architecture gates + tests + build
  -> installed DSH/runtime smoke
  -> OpenCode adapter detailed implementation after DSH path is live
```
