# AgentTeams 项目整体、可测试 MVP 服务、WebUI 可观测性与 UX 交互审计报告

- **审计日期**: 2026-10-27
- **审计角色**: `David` (`architect` peer)
- **接收方 (Master)**: `Jenny`
- **基线版本**: `origin/main` (`f58e070` / `v0.2.0-internal.1`)
- **审计范围**:
  1. 当前项目架构、工程治理与交付面是否存在重大问题
  2. 整体作为 MVP 向用户提供端到端可测试服务存在哪些阻断或断层
  3. WebUI (`ui/teams-console` + `console-host` + `runtime/control-process.ts`) 可观测性与 UX 交互友好度问题

---

## 一、 核心结论摘要（Executive Summary）

当前代码库在源码单测、协议编解码、局部模块门禁（D00–D10 契约测试）层面完成度较高，但**作为面向真实用户的端到端可测试 MVP 服务，控制面（v4 Control Daemon）与 WebUI 之间存在严重“能力断层（Split-Brain）”**：

1. **MVP 可测试服务主链路在浏览器端实质不可用（4 个 P0 级阻断）**：
   - **入口分裂**：`agentteams init` 生成的是 v3 配置（`[bridge]` / `[agents.*]`），被 v4 `control start` / `registry start` / `--serve` 直接以 `UNSUPPORTED_VERSION` 拒绝；且发布包未内置示例配置与本地快速自签名引导，用户无法一键拉起可测服务。
   - **WebUI 会话输入框永久禁用 + 无法新建会话**：v4 `control-process.ts` 投影出的 Agent 固定为 `kind: 'directory'`（无 `sessionCapable` / `sessionAvailability`），而前端 `canOperateSession(agent)` 硬性要求 `agent.kind === 'runtime' && agent.sessionCapable === true && agent.sessionAvailability === 'current'`，导致真实 v4 Control WebUI 中 Session 消息输入框与 Send 按钮**永久处于 `disabled` 状态**；且 `control-process.ts` 未绑定 `owner`，导致 `session.create`、`session.open`、`config.*`、`notification.ack` 全部返回 `UNSUPPORTED_OPERATION`。
   - **会话时间线与权限审批在 WebUI 端完全空白**：`control-process.ts` 的 `readObservedSessionProjection` 只投影了 `{ agentId, sessionId }` 和无选项的 `notifications`，从未填充 `projection.sessionEvents`、`works`、`relations` 或 `configs`。导致 WebUI 打开任何会话永远显示 `Activity is unavailable`，收到权限请求永远显示 `Permission options unavailable`（无 Allow/Reject 按钮）。
   - **全量 DOM 重建导致输入态丢失**：`renderConsole` 在每次状态更新（含 SSE 推送、轮询和单字输入）时直接调用 `root.replaceChildren()`，导致用户在 Session 抽屉、Group 建单/建 Action 表单及消息框中输入的内容、焦点与滚动位置被频繁清空或打断。
2. **WebUI 可观测性存在“只写盲区”与“假状态带”**：
   - Control Daemon 的 `projection.connections` 只读取自身空账本（Control 不监听 Teams 端口），从不反映 Agent 之间的真实连接；Discovery 顶部状态带调用 `teamsStateBands(undefined, undefined, ...)` 永远硬编码显示 `registration: unknown`、`connection: disconnected`、`engine: not-applicable`。
   - 意图写入（`connect`、`membership.apply`、`sendSession`、`cancelSession`）仅返回本地文件修订号，异步拨号失败与会话投递失败不回传 WebUI；`cancelSession` 在写完意图文件瞬间即谎报 `cancelState: 'confirmed'`。
3. **UX 交互分裂且偏离已批准设计（`teams-group-webui-design.md`）**：
   - `state.live === true` 时导航栏只渲染 5 个 D07 页面（`discovery | networking | interaction | history | groups`），将原有的 `notifications`、`search`、`topology` 视图彻底孤立隐藏。
   - Group WebUI 仍停留在 Phase 1 原型：要求用户手填内部 `vikunjaProjectId`、每个 Action 行内平铺 3 个无标签输入框 + 4 个状态按钮、缺少实时消息流推送、新建 Action 未触发模型真实推理（Phase 2 未闭环）。

---

## 二、 优先级问题总表（Prioritized Issue Matrix）

| 优先级 | 编号 | 维度 | 问题简述 | 唯一 Owner 模块 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | **MVP-01** | MVP 可测试服务 / WebUI 交互 | v4 Control Daemon 未绑定 `owner` 且目录投影 `kind: 'directory'`，导致 WebUI 无法创建/切换会话、消息输入框与发送按钮永久禁用、Provider 配置抽屉全面失效 | `runtime/control-process.ts` + `ui/teams-console/src/state/model.ts` |
| **P0** | **OBS-01** | WebUI 可观测性 / 核心闭环 | `readObservedSessionProjection` 未投影 `sessionEvents` 与权限 `options`，导致会话正文时间线永远显示不可用、权限请求无 Allow/Reject 按钮 | `runtime/session-observation-store.ts` + `runtime/control-process.ts` |
| **P0** | **MVP-02** | MVP 可测试服务 / CLI 引导 | v3 (`init`/`start`/`console`) 与 v4 (`--serve`/`control`/`registry`) 架构分裂；`agentteams init` 产物被 v4 拒绝，本地启动需手工签发 TLS 证书与配置多套 TOML/环境变量 | `cli/agentteams.mjs` + `runtime/config-io.ts` |
| **P0** | **UX-01** | UX 交互友好度 / DOM 渲染 | `renderConsole` 每次状态更新执行 `root.replaceChildren()` 全量销毁 DOM，打断/清空未受控表单输入、Group 消息框焦点与页面滚动位置 | `ui/teams-console/src/components/render.ts` + `page-groups.ts` + `mount.ts` |
| **P1** | **OBS-02** | WebUI 可观测性 / 拓扑与状态 | Control Daemon 的 `connections` 恒为空账本，且 Discovery 页调用 `teamsStateBands(undefined, undefined, ...)` 导致顶部四维状态带永远显示 `unknown / disconnected` | `runtime/control-process.ts` + `ui/teams-console/src/components/render.ts` |
| **P1** | **MVP-03** | 项目架构 / 跨机 LAN 能力 | Control 与 Agent 之间依赖本地共享 `$HOME/.agentteams/` 文件系统传递关系意图、会话意图、会话观测与 Group Unix Socket，跨主机/容器 LAN 部署失效 | `runtime/control-process.ts` + `network/` |
| **P1** | **MVP-04** | MVP 可测试服务 / Group 闭环 | Group Messaging 仅完成 Phase 1（手工 CLI/UI 提交 + 内存 Vikunja 桩），派发 Action 不会触发 Agent 模型推理执行（Phase 2 缺失），且 Group 页无活动打开的群消息自动刷新 | `runtime/acp-serve.ts` + `ui/teams-console/src/state/controller.ts` |
| **P1** | **OBS-03** | WebUI 可观测性 / 意图反馈 | 意图写入（`connect`、`membership.apply`、`sendSession`、`cancelSession`）无端到端执行回执；`cancelSession` 写文件即标为 `confirmed`，异步失败对 WebUI 不可见 | `runtime/control-process.ts` + `ui/teams-console/src/state/controller.ts` |
| **P1** | **OBS-04** | WebUI 可观测性 / History & Relations | `projection.works` 与 `projection.relations` 在 v4 Control 下恒为 `undefined`；`GET /api/v1/history?kind=request` 返非结构化 502；History 列表仅渲染 `kind + outcome`，丢失时间戳与上下文 | `runtime/control-process.ts` + `console-host/src/http-api.ts` + `render.ts` |
| **P1** | **UX-02** | UX 交互友好度 / 导航与功能孤岛 | `state.live` 五页模式与非 live 五页模式分裂：真实运行态下 `Notifications`、`Search` 与富卡片 `Topology` 被彻底隐藏；`Interaction` 页会话列表不可点击切换 | `ui/teams-console/src/components/render.ts` |
| **P1** | **UX-03** | UX 交互友好度 / Networking | Networking 页 `applyMembership` 错误传入 `agents[0].generation` 作为 `relations-intent.json` 的 CAS `expectedRevision` 导致 `REVISION_CONFLICT`；草稿成员无法移除；无 Disconnect 按钮 | `ui/teams-console/src/components/render.ts` + `controller.ts` |
| **P2** | **UX-04** | UX 交互友好度 / Group 界面规范 | `page-groups.ts` 偏离 `teams-group-webui-design.md`：要求手填 `vikunjaProjectId`、Action 行内堆砌 3 个无标签输入框与 4 个按钮、新建 Action 硬编码 `reply`、确认框暴露内部 `intentKey` | `ui/teams-console/src/components/page-groups.ts` + `controller.ts` |
| **P2** | **ENG-01** | 项目工程与生命周期治理 | 主工作树 287 个脏文件污染；`control start` 停止时删除 `control-state.json` 导致重启后 `generation` 重置为 `1`；源码直接启动未预检构建产物；`dagpipe` 二进制 `LC_UUID` 漂移 | `runtime/control-process.ts` + `scripts/` |

---

## 三、 逐项详细审计与修复交接规范（Detailed Findings & Handoff Spec）

### [P0] MVP-01：v4 Control Daemon 未绑定 `owner` 且目录投影 `kind: 'directory'`，导致 WebUI 会话操作与配置全面瘫痪

- **问题类别**：整体可测试 MVP 服务 / WebUI 核心交互阻断
- **精确位置**：
  - `runtime/control-process.ts:560-566, 725-736, 1032-1044, 1225-1233`
  - `runtime/console-hub.ts:17-28` (`directoryAgentObservation`)
  - `ui/teams-console/src/state/model.ts:41-44` (`canOperateSession`)
  - `ui/teams-console/src/components/render.ts:560, 567, 577, 993-1011`
- **根因与证据**：
  1. 在 `runtime/control-process.ts:1225-1233` 中，`runControlProcess` 调用 `createControlOwner(config, { network, source, relations })` 时**从未传入 `owner`**（`owner` 恒为 `undefined`）。
  2. 因此，在 `runtime/control-process.ts:561-565` 和 `732-734` 中：
     - `session.create` 与 `session.open` 恒返回 `{ ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'no owner is bound for session.create' } }`。
     - `config.putProvider`、`config.refreshModels`、`config.bindModel`、`config.apply`、`notification.ack` 全部落入 `if (owner === undefined) return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', ... } }`。
     - `readProjection()`（`control-process.ts:1043`）硬编码返回 `configs: []`，导致点击任何 Agent 的 Settings 抽屉永远显示 `No configuration is projected for this Agent`。
  3. 更严重的是，`readProjection()`（`control-process.ts:1032`）通过 `directoryAgentObservation(peer)`（`runtime/console-hub.ts:17-28`）生成 `projection.agents`，其固定返回 `kind: 'directory'`，不包含 `sessionCapable` 或 `sessionAvailability` 字段。
  4. 而前端 `canOperateSession(agent)`（`ui/teams-console/src/state/model.ts:41-44`）判断逻辑为：
     ```ts
     export function canOperateSession(agent: ConsoleAgentObservationV1 | undefined): boolean {
       if (!agent || agent.kind !== 'runtime') return false
       return agent.sessionCapable === true && agent.sessionAvailability === 'current'
     }
     ```
     导致在 v4 Control WebUI 中，所有在线 Agent 的 `canOperateSession(agent)` **恒为 `false`**！`renderSessionDrawer`（`render.ts:560, 567, 577`）中的消息 `<textarea>` 和 `Send` 按钮永久处于 `disabled = true` 状态。
- **用户可感知影响**：
  用户拉起 Registry + Control + Agent 并在浏览器打开 WebUI 后，既不能新建会话，也不能在已有会话中输入或发送任何消息，也不能配置模型 Provider，整个 WebUI 处于“只能看目录、无法做任何交互”的半瘫痪状态。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/control-process.ts`（控制面命令路由与投影合成）与 `ui/teams-console/src/state/model.ts`（前端会话可操作性判定）。
  - **修复方向**：
    1. 将 `session.create` / `session.open` 纳入 `session-intent-store.ts`（或通过 Agent 控制端点转发），使 Control Daemon 能够在目标 Agent 上触发创建/打开 ACP 会话。
    2. 在 `control-process.ts:1032` 合成 `agents` 投影时，结合在线状态、能力声明（`acp` / `chat` capability）及 `session-observation-store` 状态，投影真实的 `sessionCapable` 与 `sessionAvailability`，或在 `canOperateSession` 中允许具备在线 ACP 会话能力的受管 Agent 进行会话输入。
    3. 明确 Provider Config 在 v4 Control Daemon 下的归属（接入 config owner 或在 v4 界面中显式收口未接入入口，不留报 `UNSUPPORTED_OPERATION` 的死按钮）。
- **黑盒验收条件**：
  在真实启动的 `registry` + `control` + `agent (--serve opencode|dsh)` 环境中打开浏览器 WebUI，能够点击创建会话、在输入框输入 prompt 并点击 Send 成功触发 Agent 执行。

---

### [P0] OBS-01：`readObservedSessionProjection` 未投影 `sessionEvents` 与权限 `options`，导致会话时间线与权限审批完全不可用

- **问题类别**：WebUI 可观测性 / 核心交互闭环阻断
- **精确位置**：
  - `runtime/control-process.ts:922-962, 1035-1044` (`readObservedSessionProjection`)
  - `runtime/session-observation-store.ts` / `runtime/acp-serve.ts`
  - `ui/teams-console/src/components/render.ts:256-271, 360-390, 502-504`
  - `docs/release/internal-mvp-install.md:171-173`（已知限制记录）
- **根因与证据**：
  1. `runtime/control-process.ts:922-962` 中的 `readObservedSessionProjection` 只从 `session-observation.json` 读取 `sessions: [{ agentId, sessionId }]` 和 `notifications`（且将通知标题硬编码为 `'Permission request'`，不含 `options`）。
  2. `control-process.ts:1043` 返回 `{ version: 1, agents, sessions, notifications, configs: [] }`，**从未返回 `sessionEvents`**（恒为 `undefined`）。
  3. 前端 `renderSessionDrawer`（`render.ts:502-504`）依赖 `projection.sessionEvents` 渲染对话历史；当 `sessionEvents === undefined` 时，永远渲染 `t.activityUnavailable`（`Activity is unavailable`）。
  4. 前端权限审批组件（`render.ts:256-271, 360-390` 的 `permissionOptionsFor`）完全依赖从 `projection.sessionEvents` 中查找 `type === 'permission'` 事件的 `options` 列表来渲染审批按钮。由于 `sessionEvents` 为 `undefined`，所有待审批权限请求全部渲染为 `[data-permission-options-unavailable]`（`Permission options unavailable`），**没有任何 Allow / Reject 按钮**，用户无法在 WebUI 中批准权限（尽管后端 `session.permission` 写意图逻辑已实现）。
- **用户可感知影响**：
  用户在 WebUI 中看不到任何提问、模型回复、流式输出、工具调用或报错；当 Agent 请求工具权限时，用户看到权限通知却没有任何按钮可以点击批准或拒绝。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/session-observation-store.ts` + `runtime/control-process.ts`
  - **修复方向**：
    1. 在 Agent Daemon 侧将 ACP 会话的 `sessionEvents`（消息、工具调用、带 `options` 的权限请求、完成/错误事件）持久化到 `session-observation-store`（或通过流式观测通道暴露）。
    2. 在 `control-process.ts` 的 `readObservedSessionProjection` 中读取并映射 `sessionEvents` 至 `ConsoleProjectionV1.sessionEvents`。
- **黑盒验收条件**：
  WebUI 打开会话可实时看到用户消息、Agent 回复内容与工具状态；触发权限请求时，WebUI 渲染出真实 `options` 按钮，点击后成功解除 Agent 阻塞并继续推理。

---

### [P0] MVP-02：v3 与 v4 CLI 入口架构分裂，首次安装无法按直觉启动可测 MVP 服务

- **问题类别**：整体可测试 MVP 服务 / 部署与上手体验阻断
- **精确位置**：
  - `cli/agentteams.mjs`
  - `docs/release/internal-mvp-install.md:39-125`
  - `docs/design/teams-acp-daemon-config-v4.md:28`
- **根因与证据**：
  1. `agentteams init` 生成的是旧版 v3 单文件配置 `~/.agentteams/config.toml`（包含 `[bridge]` 与 `[agents.*]`），仅适用于旧版 `agentteams start / status / work / console`。
  2. 当前主推的 v4 MVP 服务（`agentteams registry start`、`agentteams control start`、`agentteams --serve opencode|dsh`）要求 3 个独立的 `version = 4` 配置文件（`registry.toml`、`control.toml`、`agent.toml`），遇到 `agentteams init` 生成的配置文件直接报错 `UNSUPPORTED_VERSION`。
  3. 内部发布 tarball（`agentteams-0.2.0-internal.1.tgz`）未打包 `config/examples/`（见 `docs/release/internal-mvp-install.md:44`）。
  4. 即使在本地 `127.0.0.1` 回环地址测试，`registry start` 也强制要求 TLS（`TLS_REQUIRED`），用户必须先手动执行多条 `openssl` 命令生成 CA 与服务端证书，再手写 3 份 TOML 配置并拼装 5+ 个环境变量（`AGENTTEAMS_BOOTSTRAP_TOKEN`、`AGENTTEAMS_REGISTRY_TLS_CA_FILE`、`AGENTTEAMS_ENGINE_COMMAND` 等）才能跑通最小闭环。
- **用户可感知影响**：
  外部或内部测试人员安装 npm 包后，执行 `agentteams init` 得到的配置无法用于 v4 服务；若不对照长篇内部安装文档手动签发证书和编写 3 套 TOML，完全无法启动可测试的 MVP 环境。
- **唯一 Owner 与修复要求**：
  - **Owner**: `cli/agentteams.mjs` + `runtime/config-io.ts`
  - **修复方向**：
    1. 升级 `agentteams init`（或提供 `agentteams init --v4` / 本地快速引导子命令），自动生成配套的 `registry.toml`、`control.toml`、`agent.toml`、本地开发用自签名 TLS 证书与 bootstrap token。
    2. 将 `config/examples/` 纳入 `package.json` 的 `files` 发布白名单。
    3. 在 `--help` 与错误提示中明确区分或统一 v3 Legacy Work 入口与 v4 ACP/Control/Registry 入口。
- **黑盒验收条件**：
  新用户在空目录下仅通过 `agentteams` CLI 内置初始化命令与启动命令（无需手动跑 `openssl` 和手写 3 份 TOML），即可在 1 分钟内拉起本地可访问的 Registry + Control WebUI + Agent 服务。

---

### [P0] UX-01：`renderConsole` 每次状态更新执行 `root.replaceChildren()` 全量销毁 DOM，清空未受控输入并打断焦点

- **问题类别**：UX 交互友好度 / 前端渲染架构缺陷
- **精确位置**：
  - `ui/teams-console/src/components/render.ts:552, 602, 1091`
  - `ui/teams-console/src/components/page-groups.ts:18-44, 154, 264, 322-326, 344, 507-520, 639`
  - `ui/teams-console/src/mount.ts:38-55`
- **根因与证据**：
  1. `renderConsole`（`render.ts:1091`）在每次 `controller.subscribe` 触发时直接调用 `root.replaceChildren()`，将整个应用 DOM 树销毁重建。
  2. 页面中大量输入框是**未受控 DOM 元素**（值仅存于 DOM 节点，未同步到 `ConsoleState`）：
     - `renderSessionDrawer`（`render.ts:552`）中的会话消息 `<textarea>`；
     - `page-groups.ts` 中的新建群名称（`group-create-name`）、新建 Issue 的标题/正文/项目 ID（`issue-title`、`issue-body`、`issue-project`）、Issue 原因/结论（`issue-reason`、`issue-conclusion`）、新建 Action 的预期产出/原因（`action-expected`、`action-reason`）、每个 Action 行内的提交结果/原因/证据输入框（`action-result-*` 等）。
     只要后台 SSE 推来一次投影更新，或 4 秒一次的 `group.list` 轮询触发 `this.update(...)`，用户正在上述输入框中输入的半截文字就会被**瞬间清空**！
  3. 相反，对于受控输入框 `group:composer`（`page-groups.ts:264`）：
     ```ts
     area.addEventListener('input', () => controller.setGroupComposer(area.value))
     ```
     用户每敲击一个字符，就会触发 `controller.setGroupComposer` -> `this.update` -> `renderConsole` -> `root.replaceChildren()`。而 `mount.ts:51-53` 仅在 `restoreConsole` 或 `restoreDrawer` 为 `true`（按 Escape 关闭抽屉）时才调用 `focusByKey`，常规 `update` 根本不恢复焦点和光标位置！这意味着用户在群聊输入框**每打一个字，输入框 DOM 就被销毁重建一次并立刻失去焦点**，无法连续打字！（对比 `renderSearch` 在 `render.ts:414-420` 专门写了 hack 手动重新查询 `.teams-search input` 并恢复 `focus()` + `setSelectionRange()`，而 `group:composer` 和 `renderProviderForm` 完全没有恢复）。
- **用户可感知影响**：
  用户在群聊输入框打字时每敲一个键就失焦；在填写 Issue、Action 或 Session 表单时，后台一旦有状态刷新，已输入的内容全部消失，滚动条跳回顶部。
- **唯一 Owner 与修复要求**：
  - **Owner**: `ui/teams-console/src/mount.ts` + `ui/teams-console/src/components/render.ts` + `ui/teams-console/src/components/page-groups.ts`
  - **修复方向**：
    1. 在 `mount.ts` 的 `render()` 包装器中，每次重绘前记录当前 `document.activeElement` 的 `data-focus-key`（或表单字段标识）、`selectionStart`/`selectionEnd` 以及滚动容器的 `scrollTop`，重绘后无条件恢复焦点与光标选区。
    2. 将所有表单草稿状态收敛到 `ConsoleState`（或仅在非输入态/局部容器更新 DOM，避免高频 `input` 事件触发全树 `replaceChildren()`）。
- **黑盒验收条件**：
  在浏览器中打开 Groups 页或 Session 抽屉，连续快速输入中英文句子并同时伴随后台 SSE/轮询刷新，输入框不失焦、光标不跳动、未提交草稿不丢失。

---

### [P1] OBS-02：Control Daemon 的 `connections` 恒为空账本，且 Discovery 页顶部状态带硬编码传 `undefined`

- **问题类别**：WebUI 可观测性
- **精确位置**：
  - `runtime/control-process.ts:881-883, 973, 1034`
  - `ui/teams-console/src/components/render.ts:883-892, 912`
- **根因与证据**：
  1. `runtime/control-process.ts:973` 创建了一个空的 `ledger = createTeamsConnectionLedger()`。正如第 881 行注释所写，Control Daemon 自身不声明 Teams 监听端口，因此 `ledger.connections()` 永远为空数组 `[]`。当两个 Agent Daemon 之间通过 `connect` 建立了真实的 Teams 连接后，它们把状态写在各自 Agent 进程内存或状态里，Control Daemon 从未采集或汇总各 Agent 的真实连接账本。
  2. 在 `ui/teams-console/src/components/render.ts:912` 中，`renderDiscovery` 调用：
     ```ts
     const bands = teamsStateBands(undefined, undefined, state.observation.observation)
     ```
     第一参数 `agent` 和第二参数 `connection` 被硬编码传了 `undefined`！
  3. 对照 `teamsStateBands`（`render.ts:883-892`），当 `agent` 和 `connection` 为 `undefined` 时：
     - `registration` 恒为 `'unknown'`（除非 `observation.state !== 'live'`）
     - `connection` 恒为 `'disconnected'`
     - `engine` 恒为 `'not-applicable'`
     - `request` 恒为 `'idle'`
- **用户可感知影响**：
  即便所有 Agent 均已正常注册上线、引擎就绪且彼此建立了连接，WebUI 首页（Discovery）顶部的 4 个核心状态徽章永远显示 `unknown / disconnected / not-applicable / idle`，极易误导用户认为系统未连接或故障。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/control-process.ts` + `ui/teams-console/src/components/render.ts`
  - **修复方向**：
    1. Agent Daemon 将其活动连接快照输出至观测存储（或通过控制面查询汇报），由 Control Daemon 聚合到 `projection.connections`。
    2. `renderDiscovery` 根据当前选中（或汇总）的 Agent 与 Connection 传入真实参数计算状态带，或在单 Agent 行内展示各自的 4 维状态带。
- **黑盒验收条件**：
  Agent 注册上线并完成 `connect` 后，WebUI Discovery 页面状态带准确反映 `online`、`connected` 及对应的引擎状态。

---

### [P1] MVP-03：Control 与 Agent 依赖本地共享 `$HOME/.agentteams/` 文件系统，跨机/跨容器 LAN 部署失效

- **问题类别**：项目架构 / 真实多机 MVP 服务能力
- **精确位置**：
  - `runtime/control-process.ts:531-537, 656, 689, 814-851, 922-962, 1039`
  - `runtime/relations-intent-store.ts`
  - `runtime/session-intent-store.ts`
  - `runtime/session-observation-store.ts`
  - `runtime/local-group-endpoint-store.ts`
- **根因与证据**：
  1. 尽管项目定位为局域网（LAN）多 Agent 控制面，且 Registry 与 Agent Teams 传输均使用 TCP/TLS 网络套接字，但 Control Daemon (`control-process.ts`) 与 Agent Daemon (`acp-serve.ts`) 之间的所有控制与观测交互全部通过本地文件系统的 `homedir()/.agentteams/...` 共享文件完成：
     - `connection.connect` / `disconnect` / `network.membership.apply`：写 `<home>/.agentteams/relations/<accountId>/<scopeId>/relations-intent.json`；
     - `session-message` / `session.cancel` / `session.permission`：写 `<home>/.agentteams/sessions/<accountId>/<scopeId>/<agentId>/session-intent.json`；
     - 会话与权限通知观测：读 `<home>/.agentteams/sessions/<accountId>/<scopeId>/<agentId>/session-observation.json`；
     - Group 消息与操作转发：读 `<home>/.agentteams/groups/.../group-endpoint.json` 并连接本地 Unix Domain Socket（`control-process.ts:814-851`）。
  2. 一旦 Control Daemon 与某个 Agent Daemon 运行在同一局域网的不同物理机、虚拟机、Docker 容器或不同操作系统用户下（不共享同一个 `$HOME` 目录），上述所有控制指令、会话观测与群聊转发将 100% 失效。
- **用户可感知影响**：
  MVP 仅能在“单机同用户多进程”下演示控制面操作，无法在真实局域网多机（或容器化）环境中通过 WebUI 控制远端机器上的 Agent。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/control-process.ts` + `network/`
  - **修复方向**：
    短期在 MVP 发行说明与 WebUI 中显式标识“本地同机控制面约束”并在发现远端 `machineId` 时给出明确提示；中期将 Control-to-Agent 的意图下发、会话观测与 Group RPC 收敛到已认证的 Teams 网络控制通道（消除跨进程共享 `$HOME` 文件假设）。
- **黑盒验收条件**：
  不同 `HOME` 目录（或两个隔离容器/主机）下启动的 Control Daemon 与 Agent Daemon 能够完成 `connect`、会话收发与 Group 操作。

---

### [P1] MVP-04：Group Messaging 缺少模型自动推理执行闭环（Phase 2 未实现）且打开的群视图不自动刷新

- **问题类别**：整体可测试 MVP 服务 / WebUI 可观测性
- **精确位置**：
  - `docs/design/teams-group-messaging-v1-wiring-evidence.md:126-127`
  - `docs/design/teams-group-webui-design.md:13`
  - `ui/teams-console/src/state/controller.ts:105, 939-1003`
- **根因与证据**：
  1. 当前 Group Messaging 仅交付了 Phase 1（群路由、消息账本、本地 HTTP Vikunja 内存桩、手工 CLI/UI 提交 Action 结果）。当用户在群内创建 Issue 并向某个 Agent 指派 Action 时，目标 Agent 只完成路由入账，**不会触发底层 OpenCode / DSH 引擎创建或执行推理会话**（Phase 2 Batch 2 未开工）。测试者只能自己用 CLI 或 UI 手工替 Agent 填写 `action.submit` 结果。
  2. 在 `ui/teams-console/src/state/controller.ts:939-1003` 中，后台定时器每 4 秒仅轮询 `group.list`（更新群列表及 `lastMessageSeq`），正如第 941 行注释所写：`It never starts a follow-up page/issue/action read`。当用户正打开某个群查看聊天流、Issue 列表或 Action 状态时，即使 `lastMessageSeq` 已增加，当前打开群的消息列表、Issue 详情和 Action 状态**不会自动拉取刷新**，用户必须手动点击 Refresh 或切换群才能看到新消息。
- **用户可感知影响**：
  用户在群聊里 @ 或指派任务给 AI Agent 后，Agent 不会自己思考和回复；且多方协作时群内新消息和任务状态变化不会实时出现在屏幕上。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/acp-serve.ts`（Group Action 驱动 ACP Session 执行）+ `ui/teams-console/src/state/controller.ts`（增量刷新当前选中群）
  - **修复方向**：
    1. 在 `controller.ts` 的 `pollGroupList` 中，当检测到当前选中群（`selectedGroupId`）的 `lastMessageSeq` 或 `revision` 变化时，自动触发当前群的消息页与选中 Issue/Action 的增量刷新。
    2. 推进 Group Messaging Phase 2：当 Agent 收到指派给自己的 `action.create` 时，桥接至本地 ACP Session 执行并将推理产出通过 `action.submit` / `group.message.send` 回写群账本。
- **黑盒验收条件**：
  在 WebUI 群内向在线 Agent 指派 Action 后，无需人工代填命令，WebUI 群消息流与 Action 状态自动刷新并展示 Agent 推理生成的结果。

---

### [P1] OBS-03：意图写入缺乏端到端状态回执，`cancelSession` 写文件即谎报 `confirmed`

- **问题类别**：WebUI 可观测性 / 状态语义失真
- **精确位置**：
  - `runtime/control-process.ts:575-624, 650-723`
  - `runtime/session-intent-watch.ts` / `runtime/serve-egress.ts`
  - `ui/teams-console/src/state/controller.ts:194, 567-588`
- **根因与证据**：
  1. `control-process.ts` 处理 `connection.connect`、`network.membership.apply`、`session-message`、`session.cancel` 时，仅将请求写入本地 `*-intent.json` 文件并立即返回 `{ ok: true, result: { acceptedRevision } }`。
  2. 前端 `controller.ts:194` 直接将原始 JSON 字符串显示在底部状态栏（例如 `Connect: {"acceptedRevision":1}`），而 Agent Daemon 异步消费该意图文件时若发生拨号失败、证书校验失败、握手拒绝或引擎报错（记录在 Agent 进程的 `handle.sessionIntent.failures()` 中），**从未回写到任何可被 Control Daemon 读取的观测存储中**。
  3. 在 `ui/teams-console/src/state/controller.ts:576-580` 中：
     ```ts
     await this.client.command({ type: 'session.cancel', agentId, sessionId })
     this.update(current => ({
       ...current,
       cancelState: 'confirmed',
       actionResult: 'Session cancel confirmed',
     }))
     ```
     只要 Control Daemon 将取消意图写入磁盘文件，前端立刻将 `cancelState` 设为 `'confirmed'` 并显示 `Session cancel confirmed`，此时 Agent 甚至可能还未读取该文件或离线。这直接违反了项目架构不变量（“意图写入不代表动作已确认完成”）。
- **用户可感知影响**：
  点击 Connect 或发送/取消消息后，界面始终提示成功（或显示生硬的 `{"acceptedRevision":1}`），但后台实际连接失败或投递失败时，WebUI 没有任何错误提示；点击 Cancel 立即显示“已确认取消”，但实际上后台任务可能仍在运行。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/session-observation-store.ts` + `runtime/control-process.ts` + `ui/teams-console/src/state/controller.ts`
  - **修复方向**：
    1. 将 `sessionIntent.failures()` 与 `relations` 拨号失败结果写入观测存储，由 Control Daemon 投影到前端展示。
    2. `cancelSession` 在 `command` 返回后应保持 `'requested'`（或 `'cancelling'`），直到从 `sessionEvents` / `session-observation` 观测到真实的取消终止事件后再迁移为 `'confirmed'`。
- **黑盒验收条件**：
  对不可达 Peer 发起 Connect 或向故障引擎发送/取消会话时，WebUI 能展示明确的异步失败原因；Cancel 状态仅在引擎真实中止后变为 Confirmed。

---

### [P1] OBS-04：History、Work Records 与 Accepted Relations 观测缺失或返回非结构化 502

- **问题类别**：WebUI 可观测性
- **精确位置**：
  - `runtime/control-process.ts:1043`
  - `console-host/src/http-api.ts:230-248`
  - `ui/teams-console/src/components/render.ts:980-988, 1013-1076`
  - `ui/teams-console/src/state/controller.ts:414-430`
- **根因与证据**：
  1. `control-process.ts:1043` 的 `readProjection()` 从未返回 `works` 和 `relations`（均为 `undefined`）。导致：
     - History 页面的 Work Records 区域（`render.ts:1022-1028`）永远显示 `Work records unavailable`。
     - Networking 页面的 Accepted relations 区域（`render.ts:980-988`）永远为空，即便用户刚刚成功执行了 `Apply membership`，界面上也看不到任何已生效的 Master/Peer 关系。
  2. 请求历史接口 `GET /api/v1/history?kind=request` 被 `control-process.ts` 拒绝后，`console-host/src/http-api.ts:245` 捕获异常并返回无结构化错误码的 HTTP 502（`Console owner request failed; outcome not inferred`），吞掉了底层 `RelayProtocolError.code`。同时，前端 `controller.loadRequestHistory()`（`controller.ts:414-430`）在 `renderHistory` 中没有任何按钮或入口调用。
  3. `renderHistory`（`render.ts:1068-1073`）渲染连接历史记录时：
     ```ts
     row.textContent = `${record.kind} ${record.outcome ?? 'unknown'}`
     ```
     只输出 `connection connected` 这样的两个词，把记录中的时间戳、对端 Agent ID、序列号、错误原因全部丢弃。
- **用户可感知影响**：
  用户在 Networking 页面配置完角色关系后看不到当前生效的关系列表；在 History 页面看不到任何 Work 记录，即使有连接历史也只能看到没有时间、没有对象名称的抽象单词。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/control-process.ts` + `console-host/src/http-api.ts` + `ui/teams-console/src/components/render.ts`
  - **修复方向**：
    1. 在 `control-process.ts` 的 `readProjection()` 中投影当前已接受的 `relations`（来自 `relations-intent-store` 或已建立的关系状态）。
    2. 在 `http-api.ts` 中透传结构化 `RelayProtocolError` 错误码。
    3. 在 `renderHistory` 中展示历史记录的时间、目标 Agent、动作类型与原因详情。
- **黑盒验收条件**：
  在 Networking 页点击 Apply membership 后，Accepted relations 列表立即展示已保存的 Master/Peer 关系；History 页展示包含时间戳与目标 Agent 标识的完整记录。

---

### [P1] UX-02：Live 模式与非 Live 模式导航分裂（`Notifications` / `Search` 消失），且 `Interaction` 页无法切换会话

- **问题类别**：UX 交互友好度
- **精确位置**：
  - `ui/teams-console/src/components/render.ts:993-1011, 1118-1155`
  - `console-host/static/console-entry.js:12-65`
- **根因与证据**：
  1. 在 `render.ts:1118-1155` 中，导航栏根据 `state.live` 切换两套完全隔离的菜单：
     - 当 `state.live === true`（真实浏览器入口 `console-entry.js` 恒为 `true`）时，仅渲染 `pageEntries`（`discovery | networking | interaction | history | groups`）。
     - 当 `state.live === false`（仅单测 fixture 使用）时，才渲染 `entries`（`topology | conversations | notifications | search | memory`）。
     这导致已实现的 `renderNotifications`（通知中心与 Acknowledge 按钮）、`renderSearch`（全局搜索）以及带丰富卡片详情的 `renderTopology` 在真实 WebUI 中**完全没有入口，彻底变成死代码**！
  2. 在 `renderInteraction`（`render.ts:993-1011`）中，当前会话列表（`projection.sessions`）仅用普通 `<li>` 渲染为纯文本（`${session.agentId} · ${session.sessionId}`），**没有任何点击事件或选择按钮**（`controller.selectSessionSessionId` 在 `render.ts` 中从未被绑定），且下方的会话抽屉硬编码只读取 `projection.sessions[0]`（`const firstSession = projection.sessions[0]`）！一旦存在多个 Agent 或多个 Session，用户永远只能查看第一个 Session，无法切换到其他 Session。
- **用户可感知影响**：
  用户在真实 WebUI 中找不到通知中心和搜索功能；当有多个会话时，点击会话列表毫无反应，只能被锁定在第一个会话上。
- **唯一 Owner 与修复要求**：
  - **Owner**: `ui/teams-console/src/components/render.ts`
  - **修复方向**：
    1. 在 `renderInteraction` 中为每个 Session 列表项绑定点击切换事件（调用 `controller.openSession(session.agentId, session.sessionId)` 或 `selectSessionSessionId`），并根据 `state.selectedSessionId` 渲染对应会话，而非硬编码 `projection.sessions[0]`。
    2. 将通知列表（Notifications 徽章/抽屉或合并到 Interaction/頂栏）与搜索过滤能力整合进 Live 模式的 5 页导航体系中，消除死代码分支。
- **黑盒验收条件**：
  在真实 WebUI 的 Interaction 页面中，点击不同 Session 项可切换下方展示的会话上下文；待处理通知可在 Live 界面中直接查看与操作。

---

### [P1] UX-03：Networking 页 `applyMembership` 传错 CAS 版本号导致冲突、草稿不可删减且缺少 Disconnect 入口

- **问题类别**：UX 交互友好度 / 功能缺陷
- **精确位置**：
  - `ui/teams-console/src/components/render.ts:961-991`
  - `runtime/control-process.ts:682-723`
  - `runtime/relations-intent-store.ts`
- **根因与证据**：
  1. 在 `renderNetworking`（`render.ts:978`）中，点击 `Apply membership` 按钮调用：
     ```ts
     void controller.applyMembership(projection.agents[0]?.generation ?? 0, state.membershipDraft)
     ```
     它将第一个 Agent 的目录注册代数 `projection.agents[0]?.generation ?? 0`（通常为 `1`）作为 `expectedRevision` 传给了 `network.membership.apply`！
     而在后端 `control-process.ts:689` 中，`expectedRevision` 校验的是 `relations-intent.json` 文件自身的 CAS 修订号（初始文件不存在时 `revision` 为 `0`，每次写入自增 `1`）。因此：
     - 当 `agents[0].generation === 1` 而 `relations-intent.json` 尚未创建（`revision === 0`）时，第一次点击 `Apply membership` 就会因为 `expectedRevision: 1 !== actual: 0` 直接报 `REVISION_CONFLICT` 失败！
     - 即便碰巧第一次成功（`revision` 变为 `1`），第二次点击时 `agents[0].generation` 仍为 `1`，第三次点击时 `revision` 已变为 `2`，必然再次触发 `REVISION_CONFLICT`！
  2. 在 `renderNetworking`（`render.ts:969-975`）中，点击 `<agent> · master` 或 `<agent> · peer` 会向 `membershipDraft` 追加或修改条目，但界面上既没有展示当前 `membershipDraft` 已选列表，也没有提供“移除某成员”或“清空草稿”的按钮。
  3. 后端已实现 `connection.disconnect`（`control-process.ts:601-624`），但前端 `TeamsConsoleController` 与 `renderDiscovery` / `renderNetworking` 中没有任何 `Disconnect` 按钮。
- **用户可感知影响**：
  用户在 Networking 页面配置组网成员关系并点击 Apply membership 时频繁遭遇版本冲突报错；选错成员角色后无法从草稿中删除；建立连接后无法在界面上断开连接。
- **唯一 Owner 与修复要求**：
  - **Owner**: `ui/teams-console/src/components/render.ts` + `ui/teams-console/src/state/controller.ts` + `runtime/control-process.ts`
  - **修复方向**：
    1. `control-process.ts` 在投影中返回当前 `relations` 及其 `revision`，前端 `applyMembership` 使用真实的 `relationsRevision` 作为 `expectedRevision`。
    2. 在 `renderNetworking` 中可视化展示当前 `membershipDraft` 列表，支持切换角色、移除单项与清空草稿，并提供 `Disconnect` 按钮。
- **黑盒验收条件**：
  在 WebUI Networking 页面连续多次增删成员并点击 Apply membership 均能成功保存且无 `REVISION_CONFLICT`；可对已连接 Peer 执行 Disconnect。

---

### [P2] UX-04：已交付的 Group WebUI (`page-groups.ts`) 偏离设计规范 (`teams-group-webui-design.md`)

- **问题类别**：UX 交互友好度
- **精确位置**：
  - `ui/teams-console/src/components/page-groups.ts:326, 339-342, 506-536, 777-806, 923`
  - `ui/teams-console/src/state/controller.ts:1395`
  - `docs/design/teams-group-webui-design.md:20-76`
- **根因与证据**：
  对照已批准的 `docs/design/teams-group-webui-design.md` 与 `ux-audit` 规范，当前 `page-groups.ts` 存在明显体验退化：
  1. **暴露内部配置 ID**：新建 Issue 表单（`page-groups.ts:326`）要求用户手动输入 `vikunjaProjectId`（`inputField(t.groupIssueProject, 'issue-project')`），违反“不要求用户手填内部/配置 ID”的原则。
  2. **Action 列表控件过载且不区分权限与终态**：每个 Action 行（`page-groups.ts:506-536`）无论是否指派给当前操作者、无论是否已处于终态，都在行内直接平铺 3 个无 `<label>` 的文本输入框（`action-result-*`、`action-reason-*`、`action-evidence-*`）和 4 个操作按钮（`Submit`、`Refuse`、`Report blocked`、`Report failed`），视觉极其拥挤。
  3. **新建 Action 类型写死**：`controller.ts:1395` 在创建 Action 时将 `actionKind` 硬编码为 `'reply'`、`replyRequired` 硬编码为 `false`，未提供 `teams-group-webui-design.md:48, 68-74` 要求的 `comment | audit | execute | reply` 类型选择与 `replyRequired` 开关。
  4. **高风险确认框位置隐蔽且暴露机器码**：点击 Close issue 等操作时，确认面板 `renderConfirm`（`page-groups.ts:777-806, 923`）被渲染在整页最底部（用户视野外），且直接把内部幂等键 `Target: issue.close:ses_...` 暴露给用户。
- **用户可感知影响**：
  普通用户不知道 `vikunjaProjectId` 填什么；看到每个任务行塞满 3 个输入框和 4 个按钮不知所措；点击关闭议题后不知道页面最底部弹出了确认框。
- **唯一 Owner 与修复要求**：
  - **Owner**: `ui/teams-console/src/components/page-groups.ts` + `ui/teams-console/src/state/controller.ts`
  - **修复方向**：
    1. 默认继承群绑定的项目配置或自动分配默认 Project，隐藏或折叠高级 `vikunjaProjectId` 输入。
    2. Action 行采用渐进式展开（点击具体动作如“提交结果”或“上报受阻”后再展开对应的单个输入区），并对已完成/已拒绝的终态 Action 隐藏操作控件。
    3. 补齐新建 Action 的 `actionKind` 下拉选择与 `replyRequired` 复选框。
    4. 将 `renderConfirm` 改为就地（in-place）或居中模态确认，展示人类可读的目标名称而非内部 `intentKey`。
- **黑盒验收条件**：
  用户无需填写 `vikunjaProjectId` 即可创建 Issue；可选不同 `actionKind` 创建 Action；Action 列表整洁且仅在触发动作时展开对应输入框。

---

### [P2] ENG-01：工程与生命周期卫生问题（主树脏状态、Control 重启 `generation` 重置、构建产物预检缺失）

- **问题类别**：项目工程治理与可维护性
- **精确位置**：
  - `/Volumes/extension/code/AgentTeams`（主工作树 287 个未提交修改/删除文件）
  - `runtime/control-process.ts:345-347, 374, 472`
  - `docs/release/internal-mvp-install.md:162-165`（Finding A09）
  - `note.md:384-389`（`agentteams-dagpipe-runner` `LC_UUID` 漂移）
- **根因与证据**：
  1. 主仓库目录 `/Volumes/extension/code/AgentTeams` 存在 287 个历史遗留的 dirty 文件（含大量被删测试与旧改动），任何直接在主树运行的验证命令都会失真（必须使用 `/Volumes/Intel/playground/agentteams/` 下的独占 clean worktree）。
  2. `runtime/control-process.ts:345-347` 在 `control stop` 优雅停止时直接 `unlink(stateFilePath)` 删除了 `control-state.json`，导致下次 `control start` 读取 `previous?.generation ?? 0` 时重新从 `0 + 1 = 1` 开始编号（代数不单调递增）。
  3. 从源码 worktree 直接运行 `agentteams control start` 时，若未预先执行 `pnpm build` 生成 `ui/teams-console/dist/index.js`，进程仅以 `START_TIMEOUT` 退出，未明确提示缺少前端构建产物。
- **唯一 Owner 与修复要求**：
  - **Owner**: `runtime/control-process.ts` + 项目主集成者（清理主树存量脏状态）
  - **修复方向**：
    1. `control-state.json` 在停止时保留最后已知 `generation`（将状态标为 `stopped` 或单独持久化代数计数器），确保重启后 `generation` 单调递增。
    2. `presentationRoots` 缺失编译产物时抛出明确的构建提示错误而非泛化的 `START_TIMEOUT`。
- **黑盒验收条件**：
  连续执行 `control start` -> `control stop` -> `control start`，第二次启动的 `generation` 严格大于第一次（为 `2`）。

---

## 四、 建议修复路线图（Recommended Execution Order for Jenny）

1. **Batch 1（打通可测试 MVP 核心闭环 - P0）**：
   - 修复 **MVP-01** 与 **OBS-01**（`runtime/control-process.ts` + `session-observation-store.ts` + `ui/teams-console/src/state/model.ts`）：打通 Control WebUI 的会话创建、消息发送（解除 `canOperateSession` 死锁）、`sessionEvents` 聊天时间线投影与权限审批按钮（`options`）。
   - 修复 **UX-01**（`mount.ts` + `render.ts` + `page-groups.ts`）：在重绘周期保存并恢复焦点、光标位置与表单草稿，解决打字失焦与轮询清空输入问题。
   - 修复 **MVP-02**（`cli/agentteams.mjs`）：提供一键初始化 v4 本地可测配置与开发证书的引导命令，并在打包白名单中包含 `config/examples/`。
2. **Batch 2（补齐 WebUI 可观测性与组网交互 - P1）**：
   - 修复 **OBS-02**、**OBS-03**、**OBS-04** 与 **UX-03**：投影真实 Agent 连接状态、已生效 `relations` 及其 CAS `revision`，修复 Discovery 顶部状态带 `undefined` 传参与 Networking 页 `REVISION_CONFLICT`，补齐 `Disconnect` 按钮与异步失败反馈。
   - 修复 **UX-02**：支持在 `Interaction` 页面点击切换不同 Session，整合通知中心与搜索入口。
3. **Batch 3（Group 实时性与模型自动执行闭环 - P1/P2）**：
   - 修复 **MVP-04** 与 **UX-04**：为当前打开的 Group 视图增加增量自动刷新，按照 `teams-group-webui-design.md` 收敛 Group/Issue/Action 表单交互，并接入 Group Action 触发 ACP Session 推理（Phase 2）。

---

## 五、 WebUI UX 专项修复落地与验收回执（2026-10-28）

- **执行与审查角色**: `David` (`architect` peer，按用户授权独立完成实现、验证与集成)
- **工作树**: `/Volumes/Intel/playground/agentteams/webui-ux-fixes`（基于 `origin/main` `621f0ed`）
- **修复范围与代码归属**:
  1. **UX-01（P0 — `renderConsole` DOM 重建焦点、光标选区、滚动位置与未受控表单输入保护）**:
     - 在 `ui/teams-console/src/components/render.ts` 新增 `captureDomState` 与 `restoreDomState`：在 `root.replaceChildren()` 前后保存并恢复当前活动元素的 `data-focus-key` / `data-group-input` 焦点、`selectionStart` / `selectionEnd` 光标范围、容器滚动位置（`scrollTop` / `scrollLeft`）以及同群/同议题下的 `[data-group-input]` 未受控输入值。
     - 将 `renderSessionDrawer` 中的消息 `<textarea>`（`data-focus-key="session:message"`）绑定至 `state.messageDraft` 与 `controller.setMessageDraft`，并在 `sendSession` 成功后清空草稿。
     - 在 `ui/teams-console/src/components/page-groups.ts` 将 `inputField` 重命名为 `groupInputField`（消除经典脚本打包时与 `render.ts` `inputField` 的同名覆盖冲突），并通过 `clearGroupInputs` 仅在对应动作返回 `true`（成功）时清空表单输入，失败或拒绝时保留用户输入。
  2. **UX-02（P1 — `renderInteraction` 多会话点击切换与 Live 模式待处理通知操作）**:
     - 在 `ui/teams-console/src/components/render.ts` 的 `renderInteraction` 中为每个 `projection.sessions` 项渲染可点击切换按钮 `[data-session-select="<sessionId>"]`（带 `aria-current`），点击后调用 `controller.selectAgent` 与 `controller.selectSessionSessionId` 切换当前活动会话抽屉。
     - 在 `renderInteraction` 中渲染待处理通知列表 `[data-interaction-notifications="true"]` 及确认按钮 `[data-notification-ack="<notificationId>"]`，使 Live 模式下待处理通知可直接查看与确认。
  3. **UX-03（P1 — `renderNetworking` 草稿成员移除、`disconnectAgent` 与 `renderDiscovery` 真实状态带）**:
     - 在 `ui/teams-console/src/state/controller.ts` 接入 `removeNetworkMember(agentId)` 与 `disconnectAgent(agentId)`（发送 `connection.disconnect`）。
     - 在 `renderNetworking` 为每个 `state.membershipDraft` 项增加移除按钮 `[data-team-draft-remove="<agentId>"]`。
     - 在 `renderDiscovery` 当 `observation === 'live'` 时向 `teamsStateBands` 传入当前选中/首个 Agent 与活动连接以展示真实状态带，并为存在活动连接的 Agent 渲染 `[data-agent-disconnect="<agentId>"]` 断开按钮。
  4. **UX-04（P2 — 新建 Issue 默认 `vikunjaProjectId` 兜底）**:
     - 在 `ui/teams-console/src/state/controller.ts` 的 `createIssue` 与 `page-groups.ts` 的 `issue-project` 输入框中支持默认继承当前群已有议题的 `vikunjaProjectId` 或 `groupId`，用户留空 `issue-project` 即可直接创建议题。
- **验证证据**:
  - `pnpm typecheck && pnpm build`：Exit `0`。
  - `pnpm --dir ui/teams-console test`（`TEAMS_CONSOLE_REAL_DOM=1 vitest run --no-file-parallelism`）：`21 passed (21)` 文件，`153 passed (153)` 用例（含新增 `ui/teams-console/tests/ux-fixes-dom.spec.ts` 真 Chrome DOM 回归测试）。
  - `teams-acp-d07-webui` 门禁（14 spec files）：`14 passed (14)`，`72 passed (72)`，Exit `0`。
  - `node docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs`（真实 Control Daemon + HTTP/SSE 黑盒）：`15 checks PASS`，Exit `0`。

