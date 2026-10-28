# P0 第一阶段详细设计与任务拆分：WebUI 会话完整闭环（MVP-01 + OBS-01）及 r2 (`c031972`) 架构把关

- **文档版本**: v1.0 (2026-10-27)
- **作者**: `David` (`architect` peer)
- **接收方 (Master)**: `Jenny`
- **关联审计项**:
  - `MVP-01`: v4 Control Daemon 未绑定 `owner` 且目录投影 `kind: 'directory'`，导致 WebUI 无法创建/切换会话、消息输入框与发送按钮永久禁用
  - `OBS-01`: `readObservedSessionProjection` 未投影 `sessionEvents` 与权限 `options`，导致会话时间线恒显示 `Activity is unavailable`、权限请求显示 `Permission options unavailable`（无审批按钮）
  - 兼顾 `UX-01`（Session 输入框受控化防清空）与 `UX-02`（`Interaction` 页支持点击切换不同 Session 及新建 Session）

---

## 第一部分：`28f8373 r2` 候选 (`c031972`) 架构把关结论

针对 `Jenny` 关于 `28f8373 r2` 收口与提交 `c031972` 的三项架构把关问题，核查 `git show c031972` 后的正式结论如下：

### 1. 是否接受 `c031972` 的测试本地预算推导？
- **结论**：**PASS（完全接受）**。
- **依据**：
  1. `c031972` 仅修改了 2 个测试文件（`runtime/managed-opencode-session.spec.ts` 与 `runtime/managed-opencode.spec.ts`，共 `+8/-4` 行），**零产品代码改动、零业务断言放宽**。
  2. 预算调整基于 3 轮隔离实测的最坏耗时（高负载下真实子进程启动最坏 `4.7s`、首条消息往返 `2.4s`、假进程启动 `3.0s`），按约 4 倍安全裕度推导为：启动 `20s`/`12s`、创建会话 `5s`、首条消息 `20s`、单测上限 `60s`。
  3. 关键生命周期底线未退让：`runtime/managed-opencode.spec.ts` 中 `stopTimeoutMs: 2000` 以及“忽略 SIGTERM 的子进程必须在 4s 内被 SIGKILL 升级回收”的核心断言完全保持原样。

### 2. 当前负载（约 15/21/20，`qemu` 已退、`obscura` 仍在）是否现在启动完整 `BB13`？
- **结论**：**可以立即启动完整 `BB13`**。
- **执行约束**：跑完整 `BB13` 期间保持单飞（Single-Flight），不要在同一机器并行跑额外的构建、其他 worktree 测试或重 IO 任务，避免人为叠加进程派生抖动。

### 3. 若 `BB13` 再出现其他计时失败，按同类补预算还是换方案？
- **结论**：**严格区分失败性质，设一次上限，不无限追涨单测 timeout**：
  1. **严禁上调停止/取消/回收类 SLA 断言**（如 `stopTimeoutMs`、心跳失效窗口、SIGTERM 升级窗口）。此类超时若发生，属于产品生命周期退化或事件循环饥饿，必须查根因。
  2. **若仍是真实外部子进程（OpenCode/DSH/Chrome）冷启动或首包 IPC 在全量并发下的排队超时**：
     - 先单独复跑该失败 spec 1 次确认非功能回归；
     - 若确认是 Vitest 多 worker 并发争抢 CPU/磁盘导致的子进程冷启动排队，**不再逐个文件零敲碎打涨 timeout**，而是统一收敛到测试运行器并发控制（例如对真实派生引擎/浏览器的重型集成测试限制并发度或串行分组执行），从根源消除全量并发下的进程派生风暴。

---

## 第二部分：P0 第一阶段详细设计（WebUI 会话闭环：合并 `MVP-01` + `OBS-01`）

### 1. 目标与范围定义

#### 1.1 核心交付目标
在不引入 Control-to-Agent 网络直连通道、不破坏现有 L9（`session-intent-store`）与 L10（`session-observation-store`）单写者文件契约、不破坏 Legacy `runtime/agent-process.ts` 路径的前提下，打通 v4 Control WebUI 的端到端会话闭环：
1. **可操作性激活与会话创建/切换（解决 `MVP-01` + `UX-02` 子集）**：
   - 在线且已发布 `session-observation.json` 的受管 Agent 在 Control 投影中具备真实的运行时会话状态（`kind: 'runtime'`、`sessionCapable: true`、`sessionAvailability: 'current' | 'no-current'`），使 WebUI 的 `canOperateSession(agent)` 自然返回 `true`。
   - 支持从 WebUI 发起 `session.create`（通过 `session-intent.json` 触发目标 Agent 在受管通道上执行 `session/new`）与 `session.open`（切换并校验当前活动 Session）。
   - `Interaction` 页面支持点击切换 `projection.sessions` 中的任意会话，并提供 `Create Session` 按钮。
2. **消息发送格式对齐与防丢字（解决 `MVP-01` 隐藏断层 + `UX-01` 会话输入子集）**：
   - 修复 WebUI `renderSessionDrawer` 发送 `{ text: string }` 而 ACP `session/prompt` 要求 Content Block 数组 `[{ type: 'text', text: string }]` 的协议断层。
   - 将 `renderSessionDrawer` 的消息输入框绑定到 `ConsoleState.messageDraft` 并赋予稳定 `data-focus-key="session:composer"`，防止 SSE 刷新清空用户正在输入的文字。
3. **会话时间线与权限选项完整投影（解决 `OBS-01`）**：
   - Agent Daemon 将当前活动会话的真实事件流（用户消息、助手流式/完成文本块、工具调用状态、待审批/已决权限请求及其真实 `options`、完成/失败终态）写入 `session-observation.json`。
   - Control Daemon 的 `readObservedSessionProjection` 将其映射为 `ConsoleProjectionV1.sessionEvents`，使 WebUI 会话抽屉展示完整对话时间线，且待处理权限请求渲染出真实的 `Allow once / Always allow / Reject` 按钮并可点击完成审批。

#### 1.2 非目标（Out of Scope for Phase 1，留待后续批次）
- 不在本阶段重做跨主机非共享 `$HOME` 的网络控制通道（`MVP-03`）。
- 不在本阶段修改 Provider Config 抽屉的远端动态改写（`config.*` 在 v4 Control 下保持显式边界，不在本阶段混入）。
- 不在本阶段改动 Group Messaging Phase 2（`MVP-04`）。

---

### 2. 端到端数据流与六个精确断点设计（Six Architectural Breakpoints）

```
Browser (WebUI)
  │ 1. POST /api/v1/command { kind: 'session.create' | 'session.open' | 'permission.reply' | 'session.cancel' }
  │    POST /api/v1/session-message { target: { agentId, sessionId }, payload }
  ▼
Control Daemon (runtime/control-process.ts)
  │ 2. Writes SessionIntent to <home>/.agentteams/sessions/<account>/<scope>/<agent>/session-intent.json
  ▼
Agent Daemon (runtime/acp-serve.ts -> createSessionIntentWatch)
  │ 3. Reconciles intent -> dispatches session/new, session/prompt, session/cancel, or permission response to AcpHost
  │    + drains internal console/readiness channel deliveries
  ▼
AcpHost (agent-host/acp-host.ts) & SessionObservationPublisher (runtime/session-observation-publisher.ts)
  │ 4. Projects openedSessions, pendingPermissions (with options!), and sessionEvents snapshot
  │    -> CAS writes <home>/.agentteams/sessions/<account>/<scope>/<agent>/session-observation.json
  ▼
Control Daemon (runtime/control-process.ts -> readObservedSessionProjection)
  │ 5. Reads session-observation.json -> projects runtime-capable ConsoleAgentObservationV1 + sessions + notifications + sessionEvents
  ▼
Browser (ui/teams-console/src/components/render.ts)
  │ 6. Renders clickable session list, enabled composer, live activity timeline, and clickable permission option buttons
```

---

#### 断点 1：`session.create` 与 `session.open` 意图扩展及 `prompt` 载荷适配
- **唯一 Owner**: `config/session-intent-store.ts`（存储契约）、`runtime/control-process.ts`（写侧）、`runtime/acp-serve.ts`（读侧执行）
- **现状问题**：
  1. `config/session-intent-store.ts:43-70, 82-85` 的 `SessionIntent` / `SessionIntentChange` 仅支持 `'permission.reply' | 'session.cancel' | 'session.message'`，不支持 `'session.create'`。
  2. `runtime/control-process.ts:560-566, 732-734` 对 `session.create` 和 `session.open` 直接检查 `if (owner === undefined) return UNSUPPORTED_OPERATION`。
  3. `ui/teams-console/src/components/render.ts:578` 发送的 `payload` 是 `{ text: textarea.value }`，而 `runtime/acp-serve.ts:1233` 直接把 `prompt: intent.payload` 传给 ACP `session/prompt`（ACP 引擎要求 `prompt: [{ type: 'text', text: '...' }]`）。
- **详细修改设计**：
  1. **`config/session-intent-store.ts`**：
     - 在 `SessionIntent` 与 `SessionIntentChange` 联合类型中新增 `session.create` 分支：
       ```ts
       | {
           readonly intentId: string
           readonly kind: 'session.create'
           readonly agentId: string
           readonly title?: string
         }
       ```
       （在 `SessionIntentChange` 中对应 `{ readonly op: 'session.create'; readonly agentId: string; readonly title?: string }`，`sessionId` 对 `session.create` 不适用，其余三种操作仍校验非空 `sessionId`）。
  2. **`runtime/control-process.ts`**：
     - 当 `owner === undefined` 时：
       - `command.kind === 'session.create'`：校验 `command.agentId` 属于已声明 `peers`，调用 `serializeSessionWrite` 向目标 Agent 的 `session-intent.json` 写入 `{ op: 'session.create', agentId: command.agentId, ...(command.title === undefined ? {} : { title: command.title }) }`，返回 `{ ok: true, result: { acceptedRevision } }`。
       - `command.kind === 'session.open'`：校验 `command.agentId` 与 `command.sessionId` 非空且属于已声明 `peers`，读取该 peer 的 `session-observation.json` 确认 `sessionId` 存在（若不存在返回 `NOT_FOUND`），存在则返回 `{ ok: true, result: { agentId: command.agentId, sessionId: command.sessionId } }`。
  3. **`runtime/acp-serve.ts` (`createSessionIntentWatch`)**：
     - 为 Agent Daemon 自身持有的受管通道（`readinessRef`，或命名为 `managedConsoleRef`）提供后台 delivery drain 循环（消费 `daemon.host.read(readinessRef, ...)`），防止该通道在执行多次 `session/new` 或 `session/prompt` 后填满 `DEFAULT_MAX_DELIVERY_BACKLOG (1024)`。
     - 当消费到 `intent.kind === 'session.create'` 时：通过 `input.host.receive` 在该受管通道上发送 `{ jsonrpc: '2.0', id: 'session-intent-' + intent.intentId, method: 'session/new', params: { cwd: workspace, mcpServers: [] } }`。引擎返回新 `sessionId` 后，`AcpHost` 自动将其记入 `channel.sessions`，随后 `sessionObservation.publish()` 自动将其发布到 `session-observation.json`。
     - 当消费到 `intent.kind === 'session.message'` 时：编写纯函数 `toAcpPromptBlocks(payload: JsonValue): JsonValue`：
       - 若 `Array.isArray(payload)` 为 `true`（如 L9 黑盒与现有单测传入的 `[{ type: 'text', text: '...' }]`），原样透传；
       - 若 `payload` 是形如 `{ text: string }` 的单键对象（WebUI `renderSessionDrawer` 发送的格式），转换为 `[{ type: 'text', text: payload.text }]`；
       - 其余情况原样透传，由引擎侧做 schema 裁决。这样既 100% 兼容所有既有 L9 单测/黑盒，又让浏览器端发送的消息被真实 OpenCode / DSH 引擎接受！

---

#### 断点 2：`AcpHost` 会话事件采集与 `session-observation-store.ts` 扩展（解决 `OBS-01`）
- **唯一 Owner**: `agent-host/acp-host.ts`（事件真源）、`config/session-observation-store.ts`（观测存储契约）、`runtime/session-observation-publisher.ts`（发布器）
- **现状问题**：
  1. L10 遗留项指出：`ConsoleSessionEventView` 的 pending `permission` 分支要求 `messageId: string`，且 `session-observation.json` 未携带 `options` 与 `events`。
  2. `render.ts` 的 `permissionOptionsFor` 仅从 `projection.sessionEvents` 查找匹配 `permissionId` 的 pending `permission` 事件上的 `options`。
- **详细修改设计**：
  1. **`agent-host/acp-host.ts`**：
     - `AcpHost` 已经是所有进出引擎 ACP 帧的唯一必经边界（`handlePrompt`、`handleEngineNotification`、`handleEngineCallback`、`receiveClientResponse`、`handleEngineResponse`、`receiveClientNotification`）。
     - 在 `AcpHost` 内部为每个活动 Session（`channel.sessions`）维护有序的只读 `ConsoleSessionEventView[]` 投影缓冲（随 `releaseSessions(channel)` 一并清理，不跨已关闭通道残留），并暴露只读方法 `sessionEvents(): readonly ConsoleSessionEventView[]`：
       - **用户消息 (`kind: 'message', role: 'user'`)**：当 `handlePrompt` 收到 `session/prompt`（记 prompt 的 `messageId = 'msg-' + entry.recordId`）时，写入 `{ eventId: 'evt-user-' + entry.recordId, agentId, sessionId, occurredAt, kind: 'message', state: 'completed', messageId, role: 'user' }`，并将用户文本提取为一条 `{ kind: 'part', state: 'completed', messageId, partId: 'part-user-' + entry.recordId, partType: 'text', text }`。同时在 `channel.activePrompt` 上记录当前助手回复关联的 `assistantMessageId = 'msg-asst-' + entry.recordId`。
       - **流式更新 (`session/update`)**：在 `handleEngineNotification` 中解析 `params.update`：
         - `sessionUpdate === 'agent_message_chunk'` 或文本增量：聚合/更新当前 `assistantMessageId` 下的文本 `part`（`kind: 'part', partType: 'text', state: 'pending' | 'completed', text`）；
         - `sessionUpdate === 'agent_thought_chunk'`：聚合为 `partType: 'reasoning'`；
         - `sessionUpdate === 'tool_call'` / `'tool_call_update'`：映射为 `kind: 'tool'`（`state: 'pending' | 'running' | 'completed' | 'error'`）。
       - **权限回调 (`session/request_permission`)**：
         - 在 `handleEngineCallback` 中生成 pending `permission` 事件：
           ```ts
           {
             eventId: `permission:${outwardId}`,
             agentId,
             sessionId,
             occurredAt: entry.occurredAt,
             kind: 'permission',
             state: 'pending',
             permissionId: outwardId,
             messageId: target.activePrompt?.assistantMessageId ?? `prompt:${outwardId}`,
             title: extractPermissionTitle(frame) ?? 'Permission request',
             metadata: (isRecord(frame.params) ? frame.params : {}) as JsonValue,
             ...(permissionOptions === undefined || permissionOptions.length === 0 ? {} : { options: permissionOptions }),
           }
           ```
           注意：这里 `messageId` 直接取自 `target.activePrompt.assistantMessageId`（有真实在途 prompt）或稳定的 callback 关联 ID，**完全满足冻结的 `ConsoleSessionEventView` 必填 `messageId: string` 契约，无需破坏 `packages/shared/src/console-api.ts` 的类型定义**！
         - 当 `receiveClientResponse` 收到该权限的回复时，将该事件原地更新为 `{ kind: 'permission', state: 'resolved', permissionId: pending.outwardId, decision }`。
       - **回合结束 (`handleEngineResponse` for `session/prompt`)**：
         - 将当前 `assistantMessageId` 的 `part` 标为 `completed`，追加 `{ kind: 'message', state: 'completed' | 'failed', messageId: assistantMessageId, role: 'assistant' }` 与 `{ kind: 'final', state: 'completed' | 'failed', messageId: assistantMessageId }`。
  2. **`config/session-observation-store.ts` & `runtime/session-observation-publisher.ts`**：
     - 在 `SessionObservationPermission` 中增加可选字段 `readonly options?: readonly ConsolePermissionOption[]`（校验每个 option 的 `optionId`、`name`、`kind`）。
     - 在 `SessionObservationSnapshot` / `SessionObservationRecord` 中增加可选字段 `readonly sessionEvents?: readonly ConsoleSessionEventView[]`（校验每条事件的 `sessionId` 必须属于同一快照的 `sessions` 集合，保持与 `permissions` 相同的闭合性不变量）。
     - `runtime/session-observation-publisher.ts` 的 `observe()` 从 `input.host.sessionEvents?.() ?? []` 与 `input.host.pendingPermissions()` 采集快照并写入 `session-observation.json`。

---

#### 断点 3：Control Daemon 投影合成（激活 `canOperateSession` 并输出 `sessionEvents`）
- **唯一 Owner**: `runtime/control-process.ts`
- **现状问题**：
  1. `control-process.ts:1037` 将所有目录节点映射为 `directoryAgentObservation`（`kind: 'directory'`），且无注册表（`[discovery]` 未启用）时 `agents` 为空数组 `[]`。
  2. `readObservedSessionProjection` 未返回 `sessionEvents` 和已观测 Agent 的运行时会话就绪态。
- **详细修改设计**：
  1. 在 `readObservedSessionProjection`（`runtime/control-process.ts:922-962`）中：
     - 除返回 `sessions` 和 `notifications` 外，一并返回：
       - `sessionEvents: ConsoleSessionEventView[]`（汇总各在线 peer 的 `record.sessionEvents`；若某条 `record.permissions` 含 `options` 且 `record.sessionEvents` 中尚未包含对应 `permissionId` 的事件，则保底合成对应的 pending permission event，确保 `permissionOptionsFor` 100% 能查到 `options`）；
       - `observedAgents: ReadonlyMap<string, { revision: number; sessions: readonly SessionObservationSession[] }>`（记录每个实际发布了有效 `session-observation.json` 的在线 peer）。
  2. 在 `readProjection`（`runtime/control-process.ts:1035-1044`）合成 `agents` 列表时：
     - 对目录中的每个 `peer`：
       - 若 `observed.observedAgents.has(peerId)`（说明该 Agent Daemon 正在运行且发布了真实的会话观测记录）：将其投影为 `kind: 'runtime'` 分支：
         ```ts
         {
           ...directoryAgentObservation(peer),
           kind: 'runtime',
            presence: 'online',
           sessionCapable: true,
           sessionAvailability: obs.sessions.length > 0 ? 'current' : 'no-current',
           ...(obs.sessions[0] === undefined ? {} : { currentSessionId: obs.sessions[0].sessionId }),
           sessionEffectiveRevision: obs.revision,
         }
         ```
       - 若 `observed.observedAgents` 中没有该 `peer`（仅在目录注册、未发布会话观测）：保持原有的 `directoryAgentObservation(peer)`（`kind: 'directory'`）。
     - 若某个在 `intent.peers` 中声明的 peer 发布了有效的 `session-observation.json`，但当前未启用 `[discovery]`（故不在 `peers` 目录列表中）：为其在 `agents` 中投影一条诚实的本地运行时观测行（`kind: 'runtime', agentId: peer.agentId, label: peer.agentId, machineId: peer.hostId, presence: 'online', capabilities: ['acp'], sessionCapable: true, sessionAvailability: obs.sessions.length > 0 ? 'current' : 'no-current', ...`）。
  3. **架构收益**：
     - 无需修改 `ui/teams-console/src/state/model.ts` 中 `canOperateSession` 的核心判据（`ui/teams-console/tests/model.spec.ts:44` 对纯 `kind: 'directory'` 返回 `false` 的既有单测 100% 保持通过）！
     - 一旦 Agent Daemon 启动并发布 `session-observation.json`，不管是否开启 Registry，WebUI 中该 Agent 的 `canOperateSession(agent)` 立即为 `true`，消息框与 Send 按钮自动解锁！

---

#### 断点 4：WebUI `Interaction` 页面会话切换、新建会话与受控输入框（解决 `UX-01`/`UX-02` 会话阻塞）
- **唯一 Owner**: `ui/teams-console/src/components/render.ts` + `ui/teams-console/src/state/controller.ts`
- **现状问题**：
  1. `renderInteraction`（`render.ts:993-1011`）将会话列表渲染为纯文本 `<li>`，无法点击切换会话，且下方固定只渲染 `projection.sessions[0]`。
  2. `renderInteraction` 没有 `Create Session` 按钮。
  3. `renderSessionDrawer`（`render.ts:552`）中的 `<textarea>` 未绑定 `state.messageDraft`，SSE 每次推送都会清空用户输入。
- **详细修改设计**：
  1. **`renderInteraction` (`ui/teams-console/src/components/render.ts:993-1011`)**：
     - 在顶部动作区为每个在线可操作 Agent（或当前选中的 Agent）渲染 `Create Session` 按钮（调用 `controller.createSession(agent.agentId)`）。
     - 将会话列表中的每个 `session` 项渲染为可点击的会话选择按钮（附带 `data-session-select="${session.agentId}:${session.sessionId}"`），点击时调用 `controller.openSession(session.agentId, session.sessionId)`。
     - 当前活动会话优先取 `projection.sessions.find(s => s.sessionId === state.selectedSessionId && (state.selectedAgentId === undefined || s.agentId === state.selectedAgentId)) ?? projection.sessions[0]`，再传给 `renderSessionDrawer`。
  2. **`renderSessionDrawer` (`ui/teams-console/src/components/render.ts:552-586`)**：
     - 将 `textarea.value = state.messageDraft` 初始化为受控状态，并赋予 `textarea.setAttribute('data-focus-key', 'session:composer')`。
     - 监听 `textarea.addEventListener('input', () => controller.setMessageDraft(textarea.value))`（在 `controller.ts` 中 `setMessageDraft` 仅更新草稿字段，或在 `mount.ts` 中对当前 `activeElement` 的 `data-focus-key` 与光标位置做无损恢复，确保打字与后台 SSE 刷新均不丢字、不失焦）。
     - 发送成功后调用 `controller.setMessageDraft('')` 清空草稿。
  3. **`renderInteraction` 内嵌待处理权限提示**：
     - 由于 Live 模式下顶栏不单独展示 `Notifications` 页，除了在 `renderSessionDrawer` 时间线内直接渲染 pending `permission` 事件的 `Allow once / Always allow / Reject` 按钮（`render.ts:525-542` 已有该逻辑，只要 `sessionEvents` 有数据即自动生效！）外，在 `renderInteraction` 顶部若存在当前会话的 pending permission notification，也一并展示快捷审批栏。

---

### 3. 子任务拆分与依赖顺序（Task Breakdown & Execution DAG）

```
[T1: config/session-intent-store + config/session-observation-store 契约扩展与单测]
        │
        ├──────────────────────────────────────┐
        ▼                                      ▼
[T2: agent-host/acp-host +             [T3: runtime/control-process
 runtime/acp-serve +                    session.create/open 路由 +
 session-observation-publisher          readObservedSessionProjection 合成
 事件采集、create 执行与载荷适配]         runtime Agent 与 sessionEvents]
        │                                      │
        └──────────────────┬───────────────────┘
                           ▼
[T4: ui/teams-console (render.ts + controller.ts + mount.ts)
 Interaction 页会话切换/新建、输入框受控保焦与单测]
                           │
                           ▼
[T5: 五张架构地图更新 + L10/WebUI 真实进程端到端黑盒回归]
```

| 任务编号 | 归属模块 (Owner) | 修改文件清单 | 前置依赖 | 验收门禁 |
| :--- | :--- | :--- | :--- | :--- |
| **T1** | `config` | `config/session-intent-store.ts`<br>`config/session-intent-store.spec.ts`<br>`config/session-observation-store.ts`<br>`config/session-observation-store.spec.ts` | 无 | `npx vitest run config/session-intent-store.spec.ts config/session-observation-store.spec.ts` |
| **T2** | `agent-host` + `runtime` | `agent-host/acp-host.ts`<br>`agent-host/acp-host.spec.ts`<br>`runtime/session-observation-publisher.ts`<br>`runtime/session-observation-publisher.spec.ts`<br>`runtime/acp-serve.ts`<br>`runtime/session-intent-watch.spec.ts` | T1 | `npx vitest run agent-host/acp-host.spec.ts runtime/session-observation-publisher.spec.ts runtime/session-intent-watch.spec.ts` |
| **T3** | `runtime` | `runtime/control-process.ts`<br>`runtime/control-process.spec.ts` | T1 | `npx vitest run runtime/control-process.spec.ts` |
| **T4** | `ui` | `ui/teams-console/src/components/render.ts`<br>`ui/teams-console/src/state/controller.ts`<br>`ui/teams-console/src/mount.ts`<br>`ui/teams-console/tests/render.spec.ts`<br>`ui/teams-console/tests/render-d07.spec.ts` | T3 | `npx vitest run ui/teams-console/tests/model.spec.ts ui/teams-console/tests/render.spec.ts ui/teams-console/tests/render-d07.spec.ts` |
| **T5** | `docs/architecture` + `runtime` | `docs/architecture/*.json` (5 张图)<br>`docs/evidence/acp-l10-session-projection-20261015/black-box-session-projection.mjs` | T2, T3, T4 | 1. `pnpm typecheck && pnpm build`<br>2. 真实入口黑盒脚本（Control + Agent + 浏览器/HTTP 全链路）通过 |

---

### 4. 黑盒验收标准（Black-Box Verification Criteria）

在完全不依赖模拟 Owner 的真实进程环境下（启动 `agentteams control start` + `agentteams --serve opencode`）：
1. **初始投影可操作性**：`GET /api/v1/projection` 返回的 `agents` 包含在线的受管 Agent（`kind: 'runtime'`, `sessionCapable: true`, `sessionAvailability: 'current'`），WebUI `Interaction` 页面中会话消息 `<textarea>` 与 `Send` 按钮处于**未禁用 (`disabled === false`)** 状态。
2. **新建与切换会话**：在 WebUI 点击 `Create Session`（或调用 `POST /api/v1/command { kind: 'session.create', agentId }`），Agent Daemon 自动执行 `session/new` 并将新 `sessionId` 发布到 `projection.sessions`；在 WebUI 点击不同会话项可切换当前活动会话。
3. **发送消息与时间线可观测性**：在 WebUI 输入框填入文本并点击 `Send`（发送 `{ text: "..." }`），Agent Daemon 将其转为合法 ACP `session/prompt` 送达引擎；`projection.sessionEvents` 实时出现 `user` 消息、工具调用或 `assistant` 回复文本块，WebUI 时间线不再显示 `Activity is unavailable`。
4. **权限审批闭环**：当引擎触发 `session/request_permission` 时，`projection.sessionEvents` 包含带真实 `options`（`once` / `always` / `reject`）的 pending `permission` 事件；WebUI 渲染出 `[data-permission-option]` 按钮（不再显示 `data-permission-options-unavailable`），点击 `Allow once` 后引擎完成工具调用并输出最终回复。
