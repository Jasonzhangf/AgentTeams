# Teams 多 Agent 控制台概要设计

状态：`design`。项目名：`Teams`。本文件用于概要审批；审批前不创建运行时 package，不修改 DSH/OpenCode 源码，不改变现有 WebUI 行为。

## 0. 设计冻结边界

Teams 是跨 agent 的观察、协作和控制入口。它不是新的 agent runtime，也不是控制服务器中的 Session 数据仓库。

```text
DSH Host / OpenCode Host
  -> daemon runtime
      -> network plugin + link lifecycle
          -> Teams control server
              -> Teams Console UI
```

模块唯一 owner：

| 模块 | 唯一职责 | 禁止职责 |
|---|---|---|
| `bootstrap` | 首次启动所需的服务器地址、设备身份、凭据引用、transport mode | 共享运行时配置、业务 Session |
| `network` | 链路配置、transport、健康、连接/重连状态 | agent 任务、配置真相、账号权限决定 |
| `config` | Shared Runtime Config 真相、版本、同步和冲突 | endpoint 建连、业务 Session |
| `server` | 服务器部署、监听、服务端连接 registry、账号 admission、权限判定 | 客户端 agent 业务、UI drawer 状态 |
| `runtime` | daemon 生命周期与 network connection 生命周期合并编排、配置应用、能力发布 | 直接实现 agent 任务语义 |
| `agent` | task、Session、tool、协作和上层 runtime 抽象 | 直接依赖 network/config/server |
| `dsh-adapter` | DSH ClientContext/Slots 与既有 Conversation/Session 接入 | OpenCode host hook |
| `opencode-adapter` | OpenCode PluginInput/Hooks 与 Session/Event SDK 接入 | DSH Slot/UI 协议 |
| `ui` | Fleet、Topology、Activity、drawer、layout adapter | transport、权限和业务真相 |

DSH 和 OpenCode 共享 typed domain/core 与 federation model，但不共享一个 host UI bundle：DSH 走 `package.json.dsh.client`、`ClientContext/slots`；OpenCode 走 `PluginInput -> Promise<Hooks>`。两端各有 adapter。

配置分两层，避免启动循环：

```text
Bootstrap Link Config  [network owner]
  -> dial control server
  -> server admission: account + permission
  -> Shared Runtime Config sync  [config owner]
  -> daemon runtime ready
  -> agent running
```

控制服务器只保存 identity、permission、discovery、shared config、audit 和 routing key；不保存 Session 消息、tool 结果或 approval body。

## 1. 目标与边界

目标是为 DSH 提供一个 Cordis 插件化的手机/Desktop 共用控制台。控制台复用现有 WebUI 的 Session、Conversation、Subagent、Workspace、主题和连接能力，并新增多机器、多 live agent、跨 agent 关系、统一监控和协作入口。

控制台的核心对象不是单个对话，而是一个可绑定多个机器和 agent 的观察与操作设备：

```text
Console Device
  -> Machines
       -> live Agents
            -> Sessions
                 -> Conversation / tools / approvals / tasks
  -> Relations
       -> 主从（master-slave）
       -> peer-to-peer
```

本阶段只确定产品信息架构、静态页面、交互动画、资源边界、推荐架构和审批问题。以下内容是设计目标，不是已存在的运行时能力。

非目标：

- 不重写 DSH agent-loop、Session 日志或现有 Conversation 投影。
- 不把 `machineId`、连接状态、重试、健康、调试信息写入业务 request/response `metadata`。
- 不把 UI 做成 agent-to-agent 消息中继。
- 不把 Session 的父子 lineage 直接解释成跨 agent 协作关系。
- 不在 UI 中伪造运行状态、进度、推理或健康结论。
- 不要求一次渲染所有 agent 的完整 transcript；完整内容按选择懒加载。

## 2. DSH 现有能力与可复用边界

DSH 是全 Cordis 插件架构。浏览器侧由 `dsh-client-web` 启动 Client Cordis tree，`dsh-client-modules` 加载带 `dsh.client` 声明的插件，`dsh-client-ui-renderer` 通过 `dsh-client-ui-slots` 渲染 root。

可直接复用：

| 现有能力 | 当前 owner | 控制台用途 |
|---|---|---|
| 单 Host Connection、generation、重连和 `/api` carrier | `client/connection`、`api/gateway` | 连接状态和单 Host 传输基线 |
| Session list、selection、history、follow、page、prompt、cancel、fork | `api/session-controller` | 任意 agent 的 Session 浏览和操作 |
| Conversation event assembly 与 Chat/Trajectory renderer | `client/ui-conversation`、`client/ui-chat`、`client/ui-trajectory` | 选中 Session 的完整对话视图 |
| Subagent direct-child catalog 与 addressed navigation | `client/ui-subagent`、`api/session-controller` | Session 内部 lineage 查看 |
| Team roster、任务 DAG、消息和 Team Remote | `experimental/agent-team` | 单 Host 内已有协作语义和 task board |
| Slot registry、scope adapter、React binding | `client/ui-slots`、`client/ui-renderer` | 新 UI 作为插件接入 |
| 三栏布局、主题 token、字体和 reduced-motion 基线 | `client/ui-layout`、`client/ui-theme` | Desktop/mobile 共用视觉语言 |

关键限制：

1. `ConnectionController` 当前代表一个 Host endpoint；`ctx.sessions`、`ctx.remote` 和 Session scope 也按单连接设计。
2. 现有 `SessionSummary` 已有 `parentSessionId`/`origin: 'subagent'`，但这只表达 Session lineage，不表达跨 agent relation。
3. 现有 Agent Team 是单 Team、单 Lead Session 的实验能力，不能直接当成跨机器 federation graph。
4. 当前浏览器认证和 trust 检查是 Host-owned 的同源浏览器会话模型，多机器直连需要新的授权与传输设计。

结论：新控制台需要独立的 federation/control projection 层；不能在现有 Session payload 上添加机器路由字段，也不能在 React 组件内部复制连接和 Session 状态。

OpenCode 只在 adapter 层接入 plugin hooks 与公开 SDK；其没有 DSH `ClientContext/Slot` UI 挂载协议，因此共享的是领域模型和控制语义，不是 UI 宿主机制。

## 3. 产品信息架构

### 3.1 顶层区域

```text
Multi-Agent Console
├── Fleet
│   ├── Machines
│   ├── connection health
│   └── live agent counts
├── Topology
│   ├── agent cards
│   ├── relationship edges
│   ├── attention filters
│   └── machine grouping
├── Sessions
│   ├── selected agent's session list
│   ├── any-agent session search
│   └── focused WebUI conversation
└── Activity
    ├── approvals
    ├── tasks
    ├── messages
    ├── errors
    └── connection events
```

默认入口是 `Topology`，不是单个 Session。用户首先看到机器和 live agent 的总体关系，再进入一个 agent、Session、task 或 approval。

### 3.2 核心用户路径

```text
添加/选择机器
  -> 查看机器下的 live agents
  -> 过滤 running / waiting / error / disconnected
  -> 点击 agent card
  -> 打开 Agent drawer
  -> 查看 Sessions / Activity / Relations
  -> 进入某个 Session
  -> 复用现有 Conversation UI
  -> 从 drawer 返回 topology，焦点回到原 card
```

用户可以从任意 agent 开始，因此入口不绑定某个固定 lead，也不依赖 master/worker 身份。

## 4. 静态页面设计

### 4.1 Desktop

Desktop 保持高密度、可扫描的工作台结构。页面 section 使用完整布局带，不把整个页面套成卡片；card 仅表示机器、agent、task 等重复实体。

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ DSH Console     3 machines · 8 live agents     connected 2 · attention 3  │
│ [search] [filter] [add machine]                              [theme] [menu] │
├───────────────┬─────────────────────────────────────────────┬───────────────┤
│ FLEET         │ TOPOLOGY                                    │ ACTIVITY      │
│               │                                             │               │
│ machine-a  ●  │  machine-a                                 │ Needs review  │
│  ├ agent-1 ●  │  ┌────────────┐       ┌────────────┐         │ approval      │
│  ├ agent-2 ◌  │  │ agent-1    │──────▶│ agent-2    │         │ task          │
│               │  │ running    │ peer │ waiting    │         │ error         │
│ machine-b  ◌  │  └────────────┘       └────────────┘         │               │
│  ├ agent-3 !  │                                             │ Recent        │
│               │  machine-b                                 │ session rows  │
│ machine-c  ●  │  ┌────────────┐                             │               │
│  └ agent-4 ●  │  │ agent-3    │                             │               │
│               │  │ disconnected│                            │               │
├───────────────┴─────────────────────────────────────────────┴───────────────┤
│ selected: agent-1  running · 2 sessions · 1 pending approval · last event … │
└─────────────────────────────────────────────────────────────────────────────┘
```

Desktop区域职责：

- 左侧 Fleet：机器分组、连接状态、agent 数量和 attention 摘要。
- 中央 Topology：机器分组下的 agent cards 和关系边。默认按机器分组，支持关系筛选。
- 右侧 Activity：跨机器的待处理事件列表。它是活动投影，不拥有业务真相。
- 底部 status rail：显示当前选择和全局 attention，不放高风险操作。

Topology 不使用强制自动布局作为产品真相。布局可由 projection 给出；关系变化只更新边和标签，避免大量 card 自动跳动造成阅读丢失。

### 4.2 Mobile

Mobile 与 Desktop 共享实体、状态、操作和组件语义，只改变 layout adapter：

```text
┌─────────────────────────────┐
│ DSH Console        ●  3/8   │
│ [search]             [menu] │
├─────────────────────────────┤
│ Topology                    │
│ machine-a                   │
│ ┌─────────────────────────┐ │
│ │ agent-1  ● running      │ │
│ │ 2 sessions · attention  │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ agent-2  ◌ waiting      │ │
│ │ peer: agent-1           │ │
│ └─────────────────────────┘ │
│ machine-b                   │
│ ┌─────────────────────────┐ │
│ │ agent-3  ! disconnected  │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ [Topology] [Activity]       │
│ [Sessions]  [Settings]      │
└─────────────────────────────┘
```

Mobile 规则：

- 一次只保留一个主要焦点。
- 横向关系改为 card 内关系摘要和垂直连接线；复杂图通过 filter 和 drawer 查看。
- 底部导航切换顶层工作区，不作为实体详情的返回机制。
- 44px 以上触摸目标；所有 icon button 有可读 label/tooltip。
- 不在窄屏同时展示完整 Conversation 与 topology；进入 Session 后使用 focused mode。

### 4.3 Agent card

Agent card 是最小可识别实体，不承载完整 transcript：

```text
┌─────────────────────────────────┐
│ ● agent-1                  ⋯    │
│ machine-a · model-x             │
│ running · 2 sessions            │
│ ↔ peer agent-2   ! approval     │
└─────────────────────────────────┘
```

必须显示：

- `machineId` 对应的显示名。
- agent 的稳定 id/label。
- live status：`running`、`idle`、`inactive`、`disconnected`、`error`。
- Session 数量和 attention 摘要。
- 与其他 agent 的关系摘要。

状态不能只靠颜色表达。每个状态使用 icon、文字和语义颜色三者中的至少两种。

## 5. Drawer 与无限分层

用户提出的“无限分层抽屉”实现为数据驱动的 `DrawerEntry[]`，不是递归创建不可控 DOM。每层是一个可寻址实体详情：

```ts
interface DrawerEntry {
  entity: 'machine' | 'agent' | 'session' | 'task' | 'message' | 'approval' | 'relation'
  entityId: string
  parentAddress?: string
  title: string
  sourceFocusId?: string
  state: 'loading' | 'ready' | 'error'
}
```

典型路径：

```text
Topology
  -> Agent drawer
      -> Sessions drawer
          -> Session drawer
              -> Task / approval / message drawer
```

行为规则：

- 点击 card 从底部打开第一层 drawer。
- drawer 内点击实体追加一层，保留上一层上下文。
- 返回只弹出最上层；关闭根层回到触发 card。
- drawer 初始为半屏；拖动 header 向上进入全屏，向下关闭。桌面使用鼠标 pointer，移动端使用触摸 pointer；header 外的内容区保持直接可操作。
- 全屏 Session drawer 继续保留 conversation feed、composer 和发送路径，不因布局切换丢失输入焦点或内容。
- header 提供可见 grab handle；点击 handle 可在半屏/全屏间切换，Escape 仍关闭当前层。
- 每层有 breadcrumb 和实体类型，不依赖颜色区分层级。
- 内容 loading、业务 error、disconnected 均在所属层明确显示。
- stack 长度只受可用 viewport 和浏览器性能约束；产品语义不设固定层数。
- 在 Desktop 上 drawer 可限制最大高度并保留背景 topology；在 Mobile 上默认 full-width bottom sheet。
- stack 不拥有 remote/session 数据；只保存导航与焦点恢复状态。

## 6. 交互动画概念

动画只表达状态变化、空间关系和操作结果。

| 场景 | 动画 | 约束 |
|---|---|---|
| Agent card 选择 | border/selection ring 在 100–200ms 内切换 | 不移动其他 cards |
| Card → drawer | `translateY` 从底部进入，backdrop 只改变 opacity | 不使用 `transition: all` |
| Nested drawer | 新层由底部进入，旧层保留标题和 breadcrumb | 不做大幅 parallax |
| Drawer header drag | 半屏向上拖至阈值后 snap 到全屏；向下拖至阈值后关闭 | 拖动期间只变更 `transform`；按钮、输入和内容滚动不被劫持 |
| Drawer close | 反向退出，焦点恢复到原 card | 触发源已移除时显式转到 topology |
| Agent running | 状态 icon 轻微 pulse | reduced-motion 下保持静态 |
| Connection change | icon + label + text swap | 不用颜色单独表达 |
| Relation update | 边和 relation label 淡入/淡出 | 不自动重排全部 topology |
| Activity arrival | 列表顶部插入时使用短的 opacity/translate | 不强制滚动用户当前阅读位置 |
| Task/approval result | icon swap 或 success/error state | 不做 fake progress |

`prefers-reduced-motion: reduce` 时移除位移动画和 pulse，只保留即时状态切换、焦点管理和可读状态文本。

## 7. 架构候选与推荐

### 方案 A：浏览器侧多 Connection Registry

每个机器对应一个 Client `ConnectionController`，浏览器直接连接多台 DSH Host，控制台在浏览器内聚合。

优点：

- 无常驻 hub。
- 机器路由离用户设备近。
- 连接失败可以按机器独立显示。

问题：

- 当前 `ctx.remote`、`ctx.sessions`、Session scope 和 renderer 是单连接语义，需要重构为 connection-keyed object layer。
- 现有浏览器 auth/trust 是单 Host 同源模型，多机器认证、CORS、Cookie、跨站 WebSocket 和 secret 生命周期都要重做。
- 同时维护多个 Session follow stream 会放大移动端内存、连接和渲染开销。

结论：不作为第一实现路径。

### 方案 B：本地 Federation Hub，推荐

浏览器只连接一个本地 Console Host。Console Host 通过独立的 typed Federation Control API 连接多个 DSH Host，维护 machine/agent/session projection，再向浏览器提供一个单一同源控制台入口。

```text
Browser
  -> one local authenticated Connection
      -> Console Federation Host plugin
          -> machine-a control connector
          -> machine-b control connector
          -> machine-c control connector
              -> typed machine/agent/session projections
                  -> Console UI slots
```

优点：

- 保留当前 WebUI 的单 Connection、单 `ctx.remote`、单 `ctx.sessions` 假设，选中 agent 时复用现有 Conversation。
- 认证、浏览器 trust、Cookie 和 WebSocket 仍由一个本地 Host 负责。
- 多机器健康和 reconnect 属于独立 connection resource，不污染业务 payload。
- 所有跨机器 mutation 可由 Host-side policy 统一审计和授权。
- 移动端只接收所有机器的轻量 summary；完整 transcript 按选择加载。

代价：

- 需要新增 Host-to-Host Federation Control API 和远端 connector。
- Hub 成为新的安全边界和可用性依赖，必须有清晰的连接 generation、权限、审计和错误链。
- 远端 DSH Host 需要安装对应的 federation plugin/profile。

结论：与现有 DSH 架构最一致，推荐作为 v1。

### 方案 C：Host-to-Host P2P Federation

每台机器的 DSH Host 直接建立 peer graph，UI 只连接 graph 中一个节点并查询网络。

优点：

- 关系和协作更接近运行时。
- 不依赖一个中心 hub。

问题：

- 需要发现、信任、拓扑一致性、权限传播和断网分区协议。
- 复杂度远超 UI 目标。
- 容易把 UI 观察关系和 agent runtime 角色混为一谈。

结论：保留为后续 federation protocol 方向，不进入 v1。

### 推荐决策

采用方案 B：本地 Federation Hub + 单浏览器 Connection + 选中 agent 的 focused WebUI。

这是“复用 WebUI 大部分能力”和“多机器多 agent 控制台”同时成立的最低复杂度路径。多机器能力进入独立控制层，而非强行把现有单 Host Client model 改成隐式多租户对象。

## 8. 资源与数据边界

### 8.1 资源模型

八类运行资源的 owner 固定如下：

| resource_id | owner | 真相 / 用途 |
|---|---|---|
| `bootstrap-link-config` | `network` | 控制服务器地址、设备身份、凭据引用、transport mode |
| `shared-runtime-config` | `config` | agent preset、runtime policy、relation binding、feature switch、capability |
| `account-permission` | `server` | 账号认证、权限 admission、授权决定 |
| `server-listener` | `server` | 部署、监听和服务端连接 registry |
| `link-state` | `network` | connecting、connected、health、reconnecting、error |
| `runtime-lifecycle` | `runtime` | bootstrap、sync、ready、running、stopped |
| `agent-capability` | `runtime` | 对上层 agent 暴露的 typed capability |
| `discovery-projection` | `server` | machine、agent、capability 的控制面发现投影 |

Network 与 daemon runtime 的“合并”只表示同一 runtime host 中统一编排生命周期；`Agent` 仍只依赖 runtime 暴露的上层抽象。

控制面与业务 payload 物理隔离：

```text
typed control side-channel:
  machineId endpoint generation health authGrant permissionDecision
  retry reconnect routingKey diagnostics lifecycle

business payload:
  user prompt assistant content tool input/output approval body
  session event and conversation projection
```

上述 control 字段不得进入 request/response `metadata`，业务 payload 也不得反向重建控制状态。

```text
MachineConnection
  control truth:
    machineId, endpoint identity, auth grant reference, generation, health

AgentNode
  business projection:
    machineId, agentId, display label, live status, capabilities, session refs

AgentRelation
  durable business truth when explicitly enabled:
    relationId, source, target, kind, policy, revision

SessionRef
  address only:
    machineId, sessionId, parentSessionId?, origin?

ConsoleNavigation
  UI-only:
    drawer stack, selected machine, selected agent, selected session, focus id
```

`machineId` 是 federation control/resource address。它不能通过 `metadata` 混入现有 Session、Remote request 或 response。UI 先解析 `SessionRef` 到唯一 `MachineConnection`，再调用该机器已有的 Session API。

### 8.2 数据路径

Daemon 启动主线：

```text
bootstrap link config
  -> network dial
  -> server account admission
  -> permission decision
  -> config version handshake
  -> shared runtime config sync
  -> runtime ready
  -> capability publication
  -> agent running
```

合并状态机：

```text
bootstrap -> connecting -> authenticating -> syncing -> ready -> running
     ^                                                        |
     +------------- reconnecting <----------------------------+

connecting/authenticating/syncing/running
  -> unauthorized | config-error | network-error | stopped
```

轻量监控：

```text
remote Host agent/status + session summary
  -> Federation Control API
  -> Machine/Agent projection
  -> topology/activity UI
```

完整 Session：

```text
selected AgentNode
  -> resolved MachineConnection
  -> existing Session Controller
  -> existing Conversation event/presentation pipeline
  -> focused drawer/page
```

跨 agent 协作：

```text
explicit UI action
  -> typed Federation/Team command
  -> owning Host policy
  -> durable event or explicit live control result
  -> projection stream
```

UI 不直接写 Session 日志，不直接推断 live 状态，不把中间 transport error 投影为业务成功。

### 8.3 Relation 语义

v1 建议将主从和 peer-to-peer 定义为显式 `AgentRelation.kind`：

- `master-slave`：有方向的关系标签，`source` 指向控制侧，`target` 指向被协调侧。
- `peer`：对等关系，边无主从方向。

v1 默认只把 relation 当作可见、可筛选、可导航的业务关系，不自动赋予权限、调度或控制权。若主从需要实际控制语义，必须另行定义 policy/capability 和授权事件，不能从 label 推断。

Session lineage 单独保留：

- `parentSessionId` 表示 Session 创建关系。
- `origin: 'subagent'` 表示既有 subagent 来源。
- `AgentRelation` 表示跨 agent 协作关系。

两者允许同时存在，但不互相派生。

## 9. Cordis 插件组成

详细设计阶段建议按模块 owner 拆分；本阶段不创建 package：

```text
dsh-console-federation-host
  owns MachineConnection, Host-to-Host control, auth/policy, projection stream

dsh-console-federation-client
  owns browser-facing typed control model and one Console connection adapter

dsh-console-ui
  owns topology, machine/agent cards, activity, relation filters, drawer stack

dsh-console-layout
  owns shared semantic layout adapter for desktop/mobile

dsh-console-session-focus
  owns selection bridge into existing Session/Conversation UI
```

建议 authoring 目录：

```text
bootstrap/ network/ config/ server/ runtime/ agent/
dsh-adapter/ opencode-adapter/ ui/
```

runtime 只能消费通过 discover -> validate -> compile 生成的 deterministic manifest；不得宽松扫描 authoring 目录临时拼能力。

这些是能力边界草案，不代表现在就创建五个 package。最小实现可以先由一个独立 plugin package 承载，内部保持 host/client/ui 三个清晰层次；只有真实出现独立生命周期或重复调用方时再拆包。

插件接入原则：

- Browser bundle 使用 `dsh.client` manifest 和现有 module table。
- UI 通过 Slots 注册，不能绕过 root renderer。
- React 组件只消费 typed props、standard hooks、store actions 和 injected callbacks。
- connection、session、projection、navigation、render 分层。
- control stream、business payload、error chain 物理分离。
- 现有 `ui-theme` token 是颜色 authority；不引入第二套 UI framework、icon system 或 CSS design system。

## 10. 状态、性能、安全与无障碍

状态必须显式区分：

```text
connecting | connected | stale | reconnecting | disconnected | unauthorized | error
```

禁止把 `reconnecting` 伪装成 `inactive` agent；禁止把无权限、远端不存在和网络失败合并成一个空列表。

性能基线：

- 所有机器只订阅轻量 machine/agent summary。
- 选中 agent 后才打开 Session list。
- 选中 Session 后才打开 history/follow。
- 多层 drawer 共享同一 projection，不复制同一 transcript。
- topology card 使用稳定尺寸，stream 更新不改变布局。
- activity 和 topology 使用增量 projection，不在 render 中扫描完整 event window。

安全基线：

- 远端 machine 的授权引用属于 control resource，不进入业务 payload。
- 每个 Host-to-Host command 有明确 caller、target、权限和错误结果。
- UI 不能因为“关系是 master-slave”自动获得高风险操作权限。
- 高风险操作必须显示目标 machine、agent、Session 和具体动作。
- audit/event 由唯一 Host owner 产生，UI 只展示。

无障碍基线：

- drawer 使用 dialog/bottom-sheet 语义、焦点陷阱和关闭后焦点恢复。
- topology card 使用 button/list/tree 等正确角色；关系边不能是唯一信息来源。
- live region 只播报用户需要知道的状态变化，不播报每个 streaming chunk。
- 支持键盘打开、返回、关闭和 card 间移动。
- 支持 `prefers-reduced-motion`、缩放和文本增长。

## 11. 前端参考登记

这些参考只用于选择结构和交互模式，最终实现继续服从 DSH 的 token、locale、Slot 和 renderer owner。

| 来源 | 采用模式 | 本产品适配 |
|---|---|---|
| shadcn/ui Drawer/Sheet | dialog、focus、dismiss、sheet 结构 | drawer stack 的语义和焦点管理 |
| `https://beui.dev/components/motion/bottom-sheet` | bottom sheet、snap point、拖拽关闭概念 | Mobile 根 drawer 的高度阶段；不复制 glass 视觉 |
| `https://beui.dev/components/motion/file-tree` | 分层实体、展开、键盘导航 | Fleet/关系层级的导航语义；不直接复制组件 |
| `https://beui.dev/components/motion/drawer` | panel reveal、Esc、body scroll lock | Desktop 辅助 drawer 的交互参考 |
| `https://transitions.dev/` | 精确属性 transition、reduced motion | card selection、drawer enter/exit、状态 swap |

设计取舍：采用 shadcn/beUI 的结构和 motion 经验，不引入它们的 Tailwind、Motion 或第二套 token。当前 DSH 已有 CSS Modules、`--dsw-*` token、`--ds-ease-in-out` 和 `--ds-transition-duration-*`。

## 12. 详细设计前必须审批的业务决策

以下问题影响权限、协议、持久化或用户可见语义，不能由实现阶段自行猜测：

1. 机器添加方式：手动 endpoint + 显式授权、二维码/短码，还是仅允许本地已配对机器。
2. `AgentRelation` 是否持久化：只保存 UI 绑定，还是写入 Host-owned durable event。
3. 主从关系：仅为关系标签，还是带调度、消息、审批或控制权限。
4. 跨机器消息：由 Host-to-Host 直连完成，还是允许 UI 作为显式中继。
5. 移动端权限：允许完整 mutation，还是只读、审批和低风险控制。
6. Console Hub 的部署方式：随本地 DSH profile 启动，还是独立的 Console profile。
7. 机器和 agent 的显示名是否由 Host durable owner 提供，还是允许 Console 本地别名。
8. Bootstrap Link Config 的持久化位置：DSH/OpenCode 用户配置目录、独立 Teams 配置目录，还是受平台密钥存储保护的引用。
9. Shared Runtime Config 的冲突策略：版本拒绝、显式合并，还是 server owner 覆盖。
10. account/permission admission 是否支持临时 grant、过期和撤销事件。

推荐默认值：

```text
Hub: local Console profile
machine discovery: explicit user-added pairing
relation: durable only when explicitly enabled; otherwise observation relation
master-slave: label first, no implied authority
cross-machine collaboration: Host-to-Host, UI observes and invokes
mobile: same semantic actions, high-risk actions require explicit confirmation
full Session stream: selected agent/session only
```

## 13. 审批后阶段

```text
概要审批
  -> resource registry + function map + mainline call map + verification map
  -> Host-to-Host control protocol detailed design
  -> Console projection and relation event detailed design
  -> shared drawer/layout component detailed design
  -> static topology vertical slice
  -> single-agent focused Session reuse
  -> second-machine federation
  -> live multi-agent smoke and browser mobile/desktop verification
```

实现前置验证：

- 现有 `client/connection` 的 browser auth/trust 与 Node/Host connector 的可复用边界。
- Session Controller 是否能在 Console focused mode 下复用而不创建第二套 Session model。
- Agent Team 的 durable event、Remote、授权和生命周期是否足以支撑 relation 需求。
- 远端 agent/session status 的最小 typed control stream。
- Desktop/mobile 同一组件语义和 drawer stack 的 a11y/reduced-motion 测试设计。

验收信号不是“页面能渲染”，而是：

1. 一个 Console UI 能显示两台机器的 live agent summary，连接失败和无权限状态可区分。
2. 任意 agent card 能打开 Sessions，并进入现有 Conversation 语义。
3. master-slave 与 peer relation 的显示、筛选、导航不混淆 Session lineage。
4. drawer 可连续追加和关闭多个实体层，焦点正确恢复。
5. 不同机器的 connection/control 状态没有进入业务 Session payload。
6. Desktop 与 Mobile 共享业务组件和状态语义，仅 layout 不同。
