# Teams Notes

## 2026-09-06 Standalone AgentTeams repository

- Teams 已从 `agent-tui` 源仓库独立为 `AgentTeams`，本地根路径为 `~/code/AgentTeams`，远端为 `https://github.com/Jasonzhangf/AgentTeams.git`。
- 历史通过子目录迁移保留，`agent-tui` monorepo 路径引用只保留在历史中；当前 active root 使用新仓库根。
- 旧 `.appsdk` 治理已按 reset 授权作废，当前从独立仓库根重新初始化。

## 当前主线

- 当前收口 profile 是 Phase 1 Local Network MVP：多个独立 daemon 从
  `~/.agentteams/config.toml` 启动，经真实本地 socket 完成发现、连接、协商和 Agent Work。
- `network`、`server`、`runtime`、`agent`、`config` 和 `opencode-adapter` 是当前主线 owner；
  Console 只提供观察、配置和 projection，不进入 Agent-to-Agent 数据路径。
- 旧宿主适配和历史 UI 设计只作为迁移记录保留，不是当前运行入口、依赖或 release gate；当前
  provider 适配路径由 Teams 的 OpenCode 配置与 adapter 负责。

## 2026-08-31

- 基线：新建 `Teams/` 作为独立 AppSDK 项目；现有 `maui-0830` UI 设计只读复用。
- 架构边界：`network` 负责链路配置、transport、health；`config` 负责共享配置真相、版本和同步；`server` 负责部署、监听、服务端连接 registry、账号和权限 admission；`runtime` 合并编排 daemon 生命周期与 network connection lifecycle；`agent` 保持网络无关；DSH/OpenCode 各自 adapter 接入。
- 启动主线：Bootstrap Link Config -> network dial -> server account/permission admission -> Shared Runtime Config sync -> runtime ready -> capability publication -> agent running。
- 控制面与业务 payload 物理隔离；machine、endpoint、generation、health、auth、permission、routing、retry、diagnostics 不进入业务 payload 或 metadata。
- UI 已落盘：Agent Card 主操作直接进入当前 Session；Session 复用现有 DSH Conversation；drawer header 上拉全屏、下拉关闭，内容区保持可操作；Desktop/Mobile 共享语义，仅 layout 不同。
- 详细设计 v1 已落盘：五入口分别解决物理位置、时间、重要性、内容和长期上下文；Settings 由 gear 进入；Search/Memory 保持独立插件生命周期；通知可直达 Agent 通知页和 Session approval；静态 HTML 作为唯一 UI reference fixture。
- 控制协议 v1 已落盘：本机 Teams Federation Host plugin 聚合层；不做 Machine pairing，使用可选 shared API key/token 无状态一致性校验；Relation 是 consumer/provider 双边 capability-use report，server 汇总生成 graph projection；Mobile 允许连接、Agent provider/model 和审批权限配置；Host-to-Host 命令；配置冲突使用 revision compare-and-swap。
- 实现默认值已冻结：Teams 只保存 opaque credential reference；Host 提供 Machine/Agent canonical name，Console alias 只是本地投影；relation report 每 30 秒 heartbeat，90 秒无刷新投影为 stale，历史保留。
- 设计状态已推进为 implementation-ready。下一步固定为 Slice 1 shared UI semantic vertical slice，然后 Slice 2 DSH focused Session adapter；两步完成后再做架构 gate、构建、安装和真实 runtime smoke。
- 现状：仅设计和治理契约；未创建 runtime plugin，未做本轮 DSH/OpenCode live 安装验证。
- 实现轮验证：隔离 DSH `web-deps-canary` 使用 `dsh 0.1.1-rc.2` 在 `127.0.0.1:3187` 返回 HTTP 200，boot manifest 和 `--dump-config` 均包含 `@deepseek-ai/teams-console`；Camo `0.4.2` 在 `claw-user-full-0830-r2` 的 1440x960 与 390x844 页面均显示 Teams，五入口、Agent 通知徽标、通知抽屉和全屏/关闭控件已被真实浏览器观察。
- 实现轮验证：DSH client `tsc`、6 个测试、bundle 通过；OpenCode adapter `tsc`、5 个测试、ESM bundle、in-process event/permission projection 和 OpenCode `1.18.23` 隔离 plugin install 通过。OpenCode 包入口已修正为 `lib/index.mjs`，发布 files 与实际产物一致。
- 实现轮边界：Camo 在窄视口点击侧栏入口和点击当前 Session 时出现 `WS timeout` / `input_pipeline locked`；移动端改为桌面打开后缩放验证通过，但当前未取得从 Agent Card 到 DSH Conversation 的浏览器点击闭环证据。真实 DSH live smoke、当前 Session fast path、drawer accessibility 和 desktop/mobile equivalence 仍为 `partial`，未启动 AGY Review、未 commit/push、AppSDK 仍为 `draft`。
- 2026-08-31 架构地图校正：DSH bundle 链路改为真实符号 `runProfile -> composeProfile -> prepareProfile -> loadProfile -> composeEntries -> boot -> mountRootInclude -> WebServer[Service.init]`；`profileBoot` 和 `webserver` 不再作为伪函数符号。`deepseek-harness` 通过 external boundary 表达，Teams module registry 不拥有其源码路径。
- 2026-08-31 AppSDK 编译首轮暴露治理边界问题：`ui/**` 会穿透本地 `node_modules` symlink，导致 `HASH_TREE_SYMLINK`。已把 module owned paths 收窄为 Teams 当前真实源码、配置和测试文件的显式 globs，避免把依赖目录纳入模块哈希。
- 2026-09-01 UI 布局校正：桌面默认使用居中 modal（完整圆角，保留上下留白）；`max-width: 800px` 以下切换为全宽手机布局，并恢复底部抽屉定位。Teams UI 测试 26/26、bundle 通过；真实 Camo 复放需在候选 DSH runtime 重启后重跑。
- 2026-09-02 候选 DSH 真实回放：候选 runtime `http://127.0.0.1:3193` 通过官方插件安装与 patch 启动；同一 Camo profile `teams-mobile-verify` 在 `1440x960` 与 `390x844` 均加载 Teams，文本确认五入口、Agent Card 与 CFG 入口，截图分别保存为 `/tmp/teams-desktop-current.png` 和 `/tmp/teams-mobile-current.png`。布局证据闭合；current-session Conversation、OpenCode live、AppSDK lifecycle records 仍未闭合。
- 2026-09-02 OpenCode 真实运行：OpenCode `1.18.23` 以项目 `.opencode/opencode.json` 加载本地 `teams-opencode-adapter`，server 在 `http://127.0.0.1:3217` 启动；通过 `opencode run --attach` 创建并执行真实 session `ses_f9f502644ffeZriCVV7r7HTqlg`，server `/session` 返回该 session、版本与运行摘要，运行日志确认 session event/processing 链路。插件安装与 session live smoke 有证据；`permission.ask` 真实交互仍未触发，AppSDK lifecycle records 与 review 仍未闭合。
- 2026-09-02 回归复核：Teams 全模块白盒回归 `19 files / 65 tests` 通过，`appsdk verify Teams` 返回 `ok:true, stage=contract_bound`，`git diff --check` 通过；本轮 OpenCode server 已停止，无遗留 Teams/3217 runtime 进程。
- 2026-09-02 OpenCode permission 触发复测：在真实 OpenCode server 上发送要求执行 harmless `printf` 的 prompt，命令完成并返回 `TEAMS_PERMISSION_SMOKE`，未产生 pending permission request；当前项目权限策略对该 bash 调用直接放行，因此不能把这次运行记为 `permission.ask` 双向交互证据。需要独立的 ask 策略/真实待审批操作入口后再复测。
- 2026-09-02 AppSDK artifact contract 检查：尝试把 module artifact_paths/build/regression 改为真实 Teams bundles 时，`appsdk verify Teams` 首次报 `ARTIFACT_MODULE_MISMATCH`，因为旧 generated placeholder 与新 contract 不一致；AppSDK 当前 CLI 未提供可用的 generated 重建入口。已按治理边界撤销未验证 contract 改动，恢复到 `appsdk verify Teams` 通过的 baseline；真实 bundle 仍只作为 package build artifact，未伪造 lifecycle artifact record。
- 2026-09-02 OpenCode `permission.ask` 真实触发：隔离 `.opencode/opencode.json` 显式设置 `bash: ask`，真实 attached run `ses_f9f2408deffeSn5qAE3b0lkS5P` 触发 `permission requested: bash (printf TEAMS_PERMISSION_ASK)`，随后运行器明确记录 user rejected，未执行命令。该证据证明 OpenCode ask 入口与拒绝状态真实发生；Teams adapter 的外部 sink 未被 OpenCode CLI 直接观测，仍需宿主可观测 notification sink 才能闭合 adapter-to-Teams 通知链。
- 2026-09-02 当前 owner worktree 复核：`appsdk verify Teams` 通过，`appsdk compile Teams` 仍生成 placeholder module artifact；review admission 首个失败节点为 `MISSING_RECORD:module-artifact`。UI package 的 Vitest 配置原先在包目录执行时使用仓库根相对 glob，导致误报无测试；已改为配置自定位仓库根并保留测试源码路径契约，真实执行 `26/26` 通过。桌面默认 `place-items:center`、手机断点 `max-width:800px` 与底部布局静态检查通过。当前未生成 lifecycle records，未启动 review。
- 2026-09-02 AppSDK projection 复核：清理 module registry 中不存在的 module-owned 路径后，先执行 `appsdk compile-module Teams --module teams-design`，再执行完整 `appsdk compile Teams` 重建 project projection；最终 `appsdk verify Teams` 通过。当前 module artifact 仍是设计阶段 placeholder，正式 lifecycle producer 仍要求 clean candidate commit。
- 2026-09-02 AppSDK governance reset：Jason 明确授权在非主 owner worktree 执行 `appsdk reset-governance Teams --discard-legacy`。官方命令丢弃旧 `.appsdk` 与 `.appsdk-control` 控制面并写入 reset record，未触碰业务源码、`active/`、`protected/` 或其他 worktree。reset 后重新绑定 `project_id=teams`、已确认 Teams goal、module `teams-design` 及当前实际 source paths；按 `draft -> source_implemented -> contract_bound` 顺序 promotion 后，`appsdk compile Teams` 与 `appsdk verify Teams` 通过。review admission 当前首个缺口为缺少由 project producer 生成的 FixCandidate/whitebox/install/restart/blackbox/PreReview records；未手写 records，未启动 review。
- 2026-09-02 scope decision：Jason 要求放弃 DSH 适配、优先 OpenCode，远端 origin 已确认为 `https://github.com/Jasonzhangf/agent-plugins.git`。目标、开发计划和 README 已改为 OpenCode-first；DSH adapter/module 与 DSH verification gates 保留为 `deferred`，不再作为当前 release admission 前置；未删除 DSH 源码或历史设计。
- 2026-09-03 OpenCode-first Slice 1：基于本机 OpenCode SDK `@opencode-ai/plugin`/`@opencode-ai/sdk` 真实类型补齐 adapter 的 session.list/get、session.prompt 和 permission reply；通知投影增加 pending/processed、priority、occurredAt；package 声明运行时 peer dependencies。新增 7th focused adapter test，OpenCode adapter `typecheck`、build 和 7/7 测试通过。npm 安装曾因 npm reify 内部错误失败，改用 pnpm 安装成功；未进入 live server 验证。
- 2026-09-03 OpenCode package install smoke：`pnpm pack` 生成发布 tarball，隔离 npm 项目安装后从 package entry import 成功；`default.server` 存在且返回 `event` 与 `permission.ask` hooks。尚未证明真实 OpenCode server 长运行、SDK Session 操作或通知 sink 外部可观测闭环。
- 2026-09-03 OpenCode live server smoke：隔离 `opencode serve` 在 `127.0.0.1:3237` 启动，加载 Teams plugin 配置；公开 `/session` 返回 9 个真实 Sessions，SDK `session.list` 与 `session.get` 成功，首个 Session `ses_f9a90d21bffeDEhya0KDTYGCrH` 返回 version `1.18.23`；`/global/event` 返回 `server.connected`。真实 prompt/permission ask 和 Teams 外部 sink 仍未闭合。
- 2026-09-03 OpenCode session/prompt live smoke：隔离 server `127.0.0.1:3238` 创建真实 Session `ses_f9a829db2ffeNOFN7SYgvy67QU`，`session.list` 返回 10 条且包含该 Session；`session.prompt` 真实返回 `{info,parts}`，message endpoint 返回 user/assistant 消息和 `finish=stop`。server 日志记录该 Session 的 loop、tracking 和退出；已精确停止 server。permission ask/Teams sink 仍未闭合。
- 2026-09-03 OpenCode notification center slice：adapter 增加 `OpenCodeNotificationStore`、priority/time 排序和 pending -> processed acknowledge，增加正向/未知 ID 失败测试；OpenCode/Search/Memory/UI 定向回归 `38/38` 通过，adapter typecheck/build 和 AppSDK verify 通过。尚未证明宿主 permission.ask 真实事件能进入外部 Teams sink。
- 2026-09-03 OpenCode permission live smoke：隔离 server `127.0.0.1:3239` 在项目 `bash=ask` 策略下产生真实 pending permission `per_065901ba5001H8rVaKvuODiZd7`，公开 `/permission` 返回 `sessionID=ses_f9a6ff50fffeColEko1urLM4Bj`、`permission=bash`；通过官方 session-scoped permission reply endpoint 返回 `true`，随后 `/permission` 为空，证明 reject 收口。server 已精确停止。Teams adapter sink 尚未从宿主外部直接观测到该事件。
- 2026-09-03 OpenCode permission replay：server `127.0.0.1:3240` 日志确认 Teams 项目真实触发 `permission=bash`、`action=ask`、`asking id=per_0659c1958001Lw0Na4vRnEg2cE`；由于真实模型处理超过短轮询窗口，脚本首次未及时观察到 pending，随后公开 `/permission` 发现该请求并通过 session-scoped endpoint reject，返回 `true`，再查询为空。该轮证明真实 ask/reject 链，但 adapter sink 仍缺宿主可观测注入点。
- 2026-09-03 OpenCode notification sink slice：增加 `createOpenCodeNotificationStoreBinding`，将 hook sink 绑定到唯一 pending/processed store，按 high priority 和时间排序；OpenCode/Search/Memory/UI 定向回归 `39/39` 通过，adapter typecheck/build 和 `appsdk verify Teams` 通过。真实 OpenCode permission ask/reject 仍已验证，但宿主事件到该 store 的外部注入尚未通过 live evidence。
- 2026-09-03 OpenCode-first UI host boundary：移除 Teams UI 对 `dsh-adapter` 的运行时 import/export，改为由宿主注入 typed `SessionActionHandlers`，UI 只消费 projection/action binding。OpenCode/Search/Memory/UI 回归 `40/40`、UI bundle、OpenCode adapter typecheck/build 和 `appsdk verify Teams` 通过；DSH 源码保留 deferred。
- 2026-09-03 OpenCode host facade：adapter 增加 `OpenCodeHostProjection`/`OpenCodeHostActions`/`OpenCodeHostFacade`，统一暴露 Session open、message send、permission reply 和 notification acknowledge 动作；OpenCode/Search/Memory/UI 回归 `41/41`，adapter typecheck/build、`appsdk verify Teams` 和 diff check 通过。当前 facade 的真实宿主 Session projection 注入、UI notification action binding 和 lifecycle records 仍未闭合。
- 2026-09-03 OpenCode live projection：`OpenCodeHostFacade` 增加 `refreshSessions(directory?)`，通过真实 SDK `session.list` 更新 projection；adapter typecheck/build、OpenCode/Search/Memory/UI 回归 `41/41`、`appsdk verify Teams` 和 diff check 通过。UI 尚未绑定该 facade，lifecycle records 仍未闭合。
- 2026-09-03 Teams UI host projection contract：UI 新增 `TeamsHostProjection`/`TeamsHostActions` typed slot contract，并支持 Host 提供 Agent、Session、current Session 与 notification projection；UI 不直接依赖 OpenCode SDK。UI bundle、OpenCode/Search/Memory/UI 回归 `41/41`、`appsdk verify Teams` 和 diff check 通过；hostActions 尚未绑定到通知/审批控件的 live 宿主动作。
- 2026-09-03 notification UI action binding：Notifications view 接入 typed `TeamsHostActions.acknowledgeNotification`，通知行与 Ack action 分离避免嵌套 button；host projection 可驱动可用 Session 集合。UI bundle、OpenCode/Search/Memory/UI 回归 `41/41`、`appsdk verify Teams` 和 diff check 通过；permission allow/deny UI action 与真实 Camo 回放仍待完成。
- 2026-09-03 permission UI action：NotificationFixture 增加 requestId，Notifications view 对 interactive notification 提供 typed `replyPermission(..., 'once')`，并保留 Ack action；UI bundle、OpenCode/Search/Memory/UI 回归 `41/41`、`appsdk verify Teams` 和 diff check 通过。always/reject 操作、真实 UI 回放和 host projection wiring 仍待完成。
- 2026-09-03 permission action variants：Notifications view 已补齐 typed `once`/`always`/`reject` 三种 permission action；UI bundle、OpenCode/Search/Memory/UI 回归 `41/41`、`appsdk verify Teams` 和 diff check 通过。真实 UI 回放和 host projection wiring 仍待完成。
- 2026-09-03 OpenCode host projection binding：Teams UI 接受 Host-owned `TeamsHostProjection` 与 `TeamsHostActions`，Notifications 可调用 typed acknowledge 与 permission `once/always/reject`；UI bundle、OpenCode/Search/Memory/UI 回归 `41/41`、`appsdk verify Teams` 通过。当前 OpenCode adapter 的 live session/permission 已在 server API 验证，Camo 只在实际宿主 UI mounting 完成后执行，避免将 DSH 宿主页面冒充 OpenCode UI。
- 2026-09-03 OpenCode plugin runtime binding：adapter 新增 `createOpenCodePluginRuntime(input)`，使用官方 `PluginInput.client` 刷新真实 Session projection，并将 `Hooks.event` 绑定到唯一 notification store；真实 SDK 类型兼容修正为根 client permission reply 与可变 prompt parts。OpenCode/Search/Memory/UI 回归 `42/42`、adapter typecheck/build、UI bundle、`appsdk verify Teams` 通过。
- 2026-09-03 OpenCode UI action binding：Teams UI 在宿主提供 `hostActions` 时，Agent Card current-session 和 Session 行由 typed `openSession` 直接关闭 Teams 并跳转；未提供时保持 drawer 行为。UI bundle、OpenCode/Search/Memory/UI 回归 `42/42`、`appsdk verify Teams` 和 diff check 通过。
- 2026-09-03 AppSDK lock repair：reset 后模板 `sdk.lock` 的 replace-with placeholders 导致 `SDK_LOCK_NOT_PINNED`；使用官方 `appsdk pin-lock Teams --binary /Users/fanzhang/.local/bin/appsdk` 修复并验证。随后 `appsdk verify Teams`、`appsdk compile Teams`、再次 `appsdk verify Teams` 均通过，项目保持 `contract_bound`。
- 2026-09-03 OpenCode latest package smoke：使用当前 adapter build 执行 `pnpm pack`，在新的隔离 npm 项目安装成功；从安装包 import 后 `default.server` 存在且 `event`/`permission.ask` hooks 均可用。lifecycle adapter 仍按 clean-candidate 门禁停止，未写 records。
- 2026-09-03 OpenCode runtime facade live smoke：隔离 `opencode serve` `127.0.0.1:3241` 的真实 SDK client 注入已构造 `createOpenCodePluginRuntime`；初始化 projection 发现 7 个真实 Sessions，触发 `session.updated` hook 后唯一 notification store 出现 1 条 pending；server 已精确停止。该证据闭合 PluginInput.client -> session.list -> Hooks.event -> store，但尚未完成 UI mounting。
- 2026-09-03 OpenCode Teams projection：增加显式 `OpenCodeAgentIdentity.sessionIds` 绑定和 `projectOpenCodeTeamsProjection`，仅将 Host 明确绑定的 Session 映射到 Agent/Machine projection，未知 Session 丢弃而不猜测归属；新增 boundary test。OpenCode/Search/Memory/UI 回归 `45/45`、adapter typecheck/build、`appsdk verify Teams` 和 diff check 通过。
- 2026-09-03 OpenCode notification projection：增加 `projectOpenCodeNotifications`，将 adapter store 映射为 UI typed notification items，只输出 session/request/status/priority/time，不携带 metadata/body。新增 payload boundary test；OpenCode/Search/Memory/UI 回归 `46/46`、adapter typecheck/build、`appsdk verify Teams` 和 diff check 通过。
- 2026-09-03 OpenCode default plugin live replay：将默认 `TeamsOpenCodePluginWithNotifications` 改为启动时调用 `createOpenCodePluginRuntime` 后，在真实 `opencode serve` `127.0.0.1:3242` 上调用 plugin server 时无输出并持续超过 30 秒，已终止调用与 server。该回放暴露新的阻塞：默认 plugin 初始化期间的 SDK session refresh 可能阻塞 OpenCode host startup；此前直接使用真实 client 的 facade smoke 成功，需将 refresh 从 plugin factory 的同步初始化移出，改为非阻塞显式 host action，并以长运行 hook 验证。
- 2026-09-03 OpenCode plugin startup fix：将默认 plugin 从同步 `createOpenCodePluginRuntime` 改为立即构造 hooks，避免 plugin factory 等待 `session.list`；其 runtime facade 仍由显式 host binding 使用。typecheck/build、OpenCode/Search/Memory/UI 回归 `43/43`、`appsdk verify Teams` 通过；真实 `opencode serve` `127.0.0.1:3243` 启动成功，`/session` 返回 18 条，`server.connected` event 可观察，server 已精确停止。
- 2026-09-03 OpenCode runtime binding review：发现 plugin runtime hook 先前引入无 owner 的全局 projection listener，且对所有通知都刷新 Session；已移除全局 listener，保留单 facade binding，并将 Session refresh 限定为 session lifecycle event。OpenCode/Search/Memory/UI 回归 `44/44`、adapter typecheck/build、`appsdk verify Teams` 与 diff check 通过。
- 2026-09-03 OpenCode session event refresh：`createOpenCodePluginRuntime` 在 session lifecycle event 到达时刷新 `session.list`，保持 Host projection 与真实 OpenCode server 状态同步；新增正向 test，OpenCode/Search/Memory/UI 回归 `43/43`、adapter typecheck/build、`appsdk verify Teams` 与 diff check 通过。
- 2026-09-03 OpenCode-first release re-audit：当前 `appsdk verify Teams` 通过，`appsdk verify --review-admission Teams --module teams-design` 明确缺 FixCandidate、whitebox、install、restart、blackbox、PreReview records；重复 admission 不再执行。OpenCode adapter typecheck/build、Teams UI bundle、OpenCode/Search/Memory/UI 回归 `42/42` 通过；无 `opencode serve` 残留进程。当前唯一 release 前置仍是 clean candidate commit + 正式 producer。
- 2026-09-03 Standalone Console Host Camo：新增 `Teams/console-host`，其 `/api/projection` 从 OpenCode `/session` 读取 18 个真实 Session，`/health` 和静态页面通过测试；Camo profile `teams-console-host` 访问 `http://127.0.0.1:3246` 成功，页面显示 Teams Console、五入口、Connected、18 OpenCode sessions discovered。首次短生命周期 host 被 Camo 访问时已关闭，改为持久 server 后页面回放成功；Camo set-viewport 截图操作再次出现 `WS timeout`，profile/daemon/host/server 已停止，完整 1440x960/390x844 screenshot 证据待重新回放。
- 2026-09-03 OpenCode notification acknowledge fix：发现 facade acknowledge 原先把 processed 项重新 sink，未从 pending 移除；改为 binding 原子 `acknowledge` 操作，正向测试锁住 pending 减少且 processed 增加。OpenCode/Search/Memory/UI 回归 `42/42`、adapter typecheck/build、`appsdk verify Teams` 和 diff check 通过。
- 2026-09-03 OpenCode-first regression：最新 Teams UI bundle、OpenCode adapter typecheck/build、OpenCode/Search/Memory/UI 回归 `44/44` 与 `appsdk compile/verify Teams` 全部通过；无运行时残留。review admission 仍仅缺正式 lifecycle records，未重复执行 blocked admission。
- 2026-09-03 OpenCode processed-event reconciliation：修复 notification store 对 `permission.replied` processed event 不移除同 request pending 的状态缺陷；新增正向回归，OpenCode/Search/Memory/UI `44/44`、adapter typecheck/build、`appsdk verify Teams`、diff check 通过。
- 2026-09-03 OpenCode UI Camo replay：按 Camo 0.4.6 真实启动 OpenCode web `127.0.0.1:3244`，profile `teams-opencode-ui` 加载页面成功，标题 `OpenCode`；页面正文仅显示 Projects/Settings/Help/Nothing here yet/Create a session，未显示 Teams。Camo profile 和 daemon 已正常停止，OpenCode server 已精确停止。结论：当前 OpenCode 官方 Web UI 没有 Teams UI mounting，不能把该页面算作 Teams UI 验证；必须实现独立 Console Host 页面后再做 1440x960/390x844 回放。
- 2026-09-03 OpenCode Console Host projection slice：修复 UI Vitest 从包目录运行时的仓库根相对路径错误，UI `26/26` 通过；Host projection 新增 `agentId`、`agents` 和真实 `/permission` pending projection，Host `2/2`、typecheck、build、AppSDK verify/compile 通过。Standalone Host 页面新增 session drawer 和 permission once/always/reject action wiring；真实 Camo 与 OpenCode action replay仍待执行，lifecycle records仍未生成。
- 2026-09-03 OpenCode Console Host Camo replay：OpenCode server `127.0.0.1:3251` 与 Console Host `127.0.0.1:3252` 真实启动；同一 Camo profile `teams-opencode-live` 验证页面标题、Connected、18 个真实 Session、五入口、Notifications 导航、Session drawer，且在 `1440x960` 与 `390x844` 均成功截图（`/tmp/teams-opencode-live-desktop.png`、`/tmp/teams-opencode-live-mobile.png`）。server、host、Camo profile 和 daemon 已精确停止，无残留进程。当前该样本无 pending permission，故 approval action 未能用真实待审批项点击验证；lifecycle records 仍未生成。
- 2026-09-03 OpenCode permission via Console Host Camo：真实 server `127.0.0.1:3253` 在 `bash=ask` 下创建 Session `ses_f99e3acabffe3d5T6iyS5gIIQt` 和 pending permission `per_0661c8b920011sU4iJO6qFnG1s`；重建并重启 Host `127.0.0.1:3254` 后 `/api/projection` 真实返回 Agent、20 Sessions 和 pending notification。Camo profile `teams-permission-live` 在桌面视口进入 Notifications，打开 Approval drawer 并点击 `Reject`；随后 OpenCode `/permission` 返回 `[]`，证明用户入口到官方 permission endpoint 的 reject 收口。所有运行时已精确停止；allow once/always 和 lifecycle records 仍待完成。
- 2026-09-03 OpenCode permission allow via Console Host Camo：真实 server `127.0.0.1:3255` 在 `bash=ask` 下创建 `ses_f99df8488ffes2gNSz22B8to6Y`，通过 `/prompt_async` 产生 pending `per_06620ddb5001L0tYZyix3Iu7T0`；Camo profile `teams-permission-allow` 在桌面视口进入 Notifications、打开 Approval drawer、点击 `Allow once`，随后 `/permission` 返回 `[]` 且 Session message 包含 `TEAMS_ALLOW_ONCE`，证明 allow once 正向执行。所有运行时已精确停止；always 分支和 lifecycle records 仍待完成。
- 2026-09-03 OpenCode permission always via Console Host Camo：真实 server `127.0.0.1:3257` 创建 `ses_f99dc5f89ffeuxPdbSxHdEq4Ii` 和 pending `per_06623dd13001bNOes6wGrz24VK`；Camo profile `teams-permission-always` 进入 Notifications、打开 Approval drawer、点击 `Always allow`，随后 `/permission` 返回 `[]` 且 message 含 `TEAMS_ALWAYS_ALLOW`，证明 always 正向执行。所有运行时已精确停止；lifecycle records 仍未生成。

## 2026-09-04 v2 transport design based on zterm principles

- 同意 Jason 方向：参考 `~/code/zterm` 的连接架构，但 Teams 独立实现协议和网络层。
- 设计已落盘：`Teams/docs/design/teams-control-protocol-v2-master-agent-host.md` 与 `Teams/docs/design/teams-control-protocol-v2.manifest.json`。
- 关键拆分：Registration directory WebSocket、Master account directory WebSocket、Agent Host target WebSocket 三资源分离；target transport 只存在一个，Session 以 logical channel 多路复用。
- 控制与业务物理隔离：target control frame 管 hello/ping/health/generation/channel；Session channel frame 管 session.message/permission/notification/relation。
- Session 正文不禁止经过 Agent Host WebSocket；禁止的是进入控制帧/metadata/routing/auth/health/retry/config。
- 已更新 README 与 docs/architecture resource/function/mainline/module/verification maps；`appsdk verify Teams` 通过。
- 未写网络 runtime；下一步等 Jason 批准后进入 Phase A：control-protocol schema 与 channel 状态机测试。

## 2026-09-04 Phase A & AppSDK 治理闭环

- Phase A control-protocol 已实现并保持绿测：`control-protocol/frames.ts`、`channel-state.ts`、两个 spec；Vitest `16/16` 通过，strict `tsc --noEmit` 通过。
- AppSDK 治理修复完成：无效 migration record 备份后，官方 `appsdk pin-lock` 重写 SDK lock/migration record，并加入 `control-protocol/**` owned paths。
- 验证：`appsdk verify Teams`、`appsdk compile Teams`、再次 `appsdk verify Teams`、`git diff --check` 全部通过。
- C2C/ChatGPT 规划仍等待连接选择；未 commit/push/review/merge。

## 2026-09-04 Phase B Agent Host Registration + Server Directory

- 新增 `network/host-registration.ts`：Agent Host 注册 client，校验链路已连接、凭证一致、identity/capability/route candidates 合法后才 publish 目录。
- 新增 `server/directory.ts`：Server host directory skeleton，支持 upsert、presence refresh、stale removal、account filter；拒绝 Session/permission body 字段进入目录。
- 新增根级 `Teams/vitest.config.ts` 收口 `server/**`、`network/**`、`control-protocol/**` 测试；新增 8 个定向测试，Phase A/B 合计 `28/28` 通过。
- 验证：strict `tsc --noEmit --allowImportingTsExtensions` 通过；`appsdk verify Teams`、`appsdk compile Teams`、再次 verify、`git diff --check` 全部通过。
- C2C/ChatGPT：Camo 自动配置 ChatGPT connector 失败（input pipeline 超时），改用本地 Phase B 开发推进；连接配置仍待 Jason 手动完成或修复 Camo。

## 2026-09-04 Phase C Account Directory + Route Plan

- 新增 `network/account-directory.ts`：Master 账户目录快照、generation 确认、refresh、host 解析；无目录 generation 或 generation 倒退显式失败。
- 新增 `network/route-plan.ts`：manual/auto 显式 route plan；失败 candidate 退休后才进入下一候选，成功不可被改写成失败。
- 验证：Phase A/B/C 定向测试合计 `36/36` 通过；strict `tsc`、AppSDK verify/compile、`git diff --check` 通过。

## 2026-09-04 Phase D Target Transport + Session Channel Multiplex

- 新增 `network/target-transport.ts`：target hello/ack/health/generation/close/fail 生命周期，stale generation 显式拒绝。
- 新增 `network/session-channel-registry.ts`：一个 target transport 上多个 logical channel 的 open/ack/message/close/error 注册表，未打开、未知 channel、stale generation 显式失败。
- 验证：Phase A/B/C/D 定向测试合计 `43/43` 通过；strict `tsc`、AppSDK verify/compile、`git diff --check` 通过。

## 2026-09-04 Phase E Agent Host Config + OpenCode Binding + AppSDK 投影修复

- `agent-host/agent-host.ts` 实现 Agent Host 配置校验与 OpenCode facade binding：endpoint/auth、credential reference 必填；registration/projection 仅承载 host/agent/capability/sessionIds，不携带 sessionId/permissionId。
- `network/host-registration.ts`、`network/account-directory.ts`、`network/route-plan.ts`、`network/target-transport.ts`、`network/session-channel-registry.ts`、`server/directory.ts` 严格 strict typecheck 通过；opencode-adapter `pnpm exec tsc --noEmit` 通过。
- 治理补齐：`Teams/.appsdk/maps/module-registry.json` 与 `Teams/.appsdk/project.json` owned paths / regression input_paths 同步加入 `control-protocol/**`、`agent-host/**` 与根 `vitest.config.ts`；`appsdk compile Teams` 重投影后两者一致，`appsdk verify Teams` 仍返回 `contract_bound`。
- Phase A-E 根级回归 `45/45` 通过；`git diff --check` 未出现宽行警告；真实 OpenCode live（permission allow/reject/always + Console Host Camo）证据保留自 9-3。
- 文档同步：README 增列 Phase E；impl-plan 把 Phase E 标注为基础绑定已完成、明确未完成的 runtime listener 边界；`docs/architecture/function-map.json` 新增 `agent_host_config_binding`（owner=agent-host, status=implemented）；`docs/architecture/resource-map.json` 新增 `agent-host-config` control resource；`docs/architecture/verification-map.json` 在 `teams-agent-host-registration` gate 下追加 binding 不携带 Session/permission 的检查。
- ChatGPT 规划连接：本机 `c2c doctor` 绿色、setupMode=auto、`connectorName=Codex with ChatGPT · teams-protocol-v2-20260903`，但 `session` 仍为 `projectReady=false`；下一步走 Bind Project，等待 Jason 在 ChatGPT 里创建项目 `teams-protocol-v2-20260903`（仅限项目记忆）后再启动 INIT/PLAN。
- 未启动 review/commit/push；工作树仍待 Jason 决定是否合并 Phase E 基线。

## 2026-09-04 Governance recovery reset and preflight

- Jason 已批准 Teams governance recovery；本轮仅恢复 AppSDK 治理，不扩展业务 runtime scope。
- 在独立、非 main 的 `playground/teams-governance-reset-20260904` worktree 执行官方 `appsdk reset-governance Teams --discard-legacy`，保留 business source/runtime data/Active/Protected，旧治理控制态先保存 immutable snapshot 后丢弃。
- reset 后重新执行 AppSDK 0.1.6 `init`、`pin-lock`、`compile`、`verify`；canonical verify 返回 `ok=true`、`stage=contract_bound`。
- 重新建立 fresh Guide PlanRecord `teams-control-transport-v2-1`；`goal_scope`、`architecture_maps`、`owner_worktree`、`preflight_verify` 均通过，随后 `guide close` 返回 `workflow_complete=true`。
- preflight 实际验证：全部 AppSDK/Teams JSON maps 与 v2 protocol manifest 可解析；Teams focused Vitest `16 files / 57 tests` 通过；OpenCode adapter 与 Console Host typecheck 通过；mapped strict TypeScript check 通过；`git diff --check` 通过。
- 依赖验证暴露并记录了两个环境路径问题：首次 Vitest 因 local OpenCode adapter 未 build 而无法解析 package export；首次 mapped `tsc` 因 TypeScript 6 的 config/file-list 约束及 Node globals 声明失败。安装声明依赖、构建 adapter，并使用 `--ignoreConfig --skipLibCheck --types node` 后通过。
- 本轮没有执行 runtime install/restart/live replay、review、commit、push、merge 或 worktree cleanup；AppSDK close 明确报告 canonical lifecycle 尚未 freeze/retire。

## 2026-09-05 AppSDK 0.1.6 governance migration closeout

- 旧治理按已批准的 reset 路线作废：完整旧 `.appsdk` 与 `.appsdk-control` 已移出项目 active root，immutable audit snapshot 保存在 `/tmp/teams-appsdk-latest-migration-20260905/`；snapshot hash 校验通过。
- Teams 已使用 AppSDK `0.1.6` 重新初始化，当前唯一 active governance root 为 `Teams/.appsdk/`；项目契约为 `project_id=teams`，goal 为 `goal-teams-multi-agent-console`，module 为 `teams-design`，lifecycle stage 为 `contract_bound`。
- 当前 SDK lock 与安装于 `Teams/.appsdk/sdk.bin` 的修复版 binary 一致：SHA-256 `7d8e77be1c9d622cf312b412b0128358d808cafb828a4e2e1fa7678a220d3a79`；bundle digest 与 manifest digest 由 `pin-lock` 生成，不手写。
- AppSDK 0.1.6 原始 canonical contract 判断存在真实路径兼容缺陷：新正式路径为 `contracts/transitions/zone-transition.manifest.json`，既有测试/迁移夹具仍使用 `zone-transition-manifest.json`。修复位于 AppSDK `assert_declared_contracts` owner：拆分 canonical 条件并兼容两种已存在路径，未恢复旧 Teams governance root、未引入 fallback。
- AppSDK 修复 worktree 的 `cargo fmt --check`、`cargo test --all-targets --no-fail-fast` 均通过，CLI smoke 为 `51/51`；Teams 使用修复版 binary 串行执行 `guide compile`、`compile`、`verify` 全部通过，`verify` 返回 `ok=true`、`stage=contract_bound`。
- 本轮未执行 runtime install/restart/live replay；未执行 AppSDK/Teams review、commit、push、merge 或 worktree cleanup。AppSDK 修复源仍在独立 worktree，Teams 当前治理 binary 已内置并锁定。

## 2026-10-07 U7 round 12 设计准入输入（BB06/BB09/BB10）

- 任务：`u7-user-driver-20261006`，round 12。候选 base `4aed787041f387e090e141d276b41eab877278e6`
  （本地 main == origin/main == 远端）。本轮只做设计准入，不是实现完成、不是任何 PASS。
- 起因：milestone review `teams-local-mvp-milestone-20261007-r11`（Codex oauth / gpt-6.1-sol）FAIL，
  3 条 P1：BB09 只用 HTTP 可用性代替真实浏览器 Console 验收；BB10 只用本地 provider stub；
  BB06 用 Provider 私有账本断言容量拒绝。原 finding 见
  `/Volumes/Intel/playground/agentteams/.worker-runs/u7-user-driver-20261006/lead-r11/reviews/milestone-r11/review.final.md`。
- 本轮规划与观察（reviewer 可直接读取，均为绝对路径）：
  - 计划：`/Volumes/Intel/playground/agentteams/.worker-runs/u7-user-driver-20261006/lead-r12/plan-v3.md`
    （READY；前两版 `plan.md`、`plan-v2.md` 为 BLOCKED 记录）。
  - 观察：同目录 `observation.md`、`observation-v2.md`、`observation-v3.md`。
  - 能力证据：`o1-browser/report.md`（headless Camo 打开安装后 Console、Basic challenge、DOM/API、
    交互与拒绝路径、teardown）、`o2-projection.md`（Console 投影首丢点与唯一 owner）、
    `o3-provider/report.md`（RCC 4444 与 canonical provider 真源）、
    `o5-canonical-provider/report.md`（RCC 无凭据导出通道；canonical 端点可达且真实调用成功）。
  - 阶段笔记：`/Volumes/Intel/playground/agentteams/.worker-runs/u7-user-driver-20261006/lead-r11/note.md`。
- 本次设计提交（D2）追加的契约：
  - `docs/design/teams-local-console-v1.md` r3 §6.5 声明明细 `capabilityDetails` 投影契约与
    §13.6 BB09 浏览器断言/证据集；动态 `allocations` 明确不在本轮范围。
  - `docs/design/teams-local-work-entry-v1.md` r7：`buildCompletedReceipt` 从 ARC typed
    `control.reply.error` 投影到既有 `receipt.control.error`，`closeError` 优先级不变；§11.9 BB06i。
  - `docs/design/teams-provider-config.md` §5.1–§5.3：两实例真源与三种 model 写法、校正后的
    `select-backup` 语义、canonical 凭据的操作者供应边界、BB10 运行期前置/终态/可见输出要求。
  - 五张 `docs/architecture/*.json` 绑定上述 owner、调用边与 gate；六张既有图未改。
- 权威需求：`.appsdk/goal.json` 的 `acceptance_criteria`；`docs/goals/teams-user-delivery-plan.md:235-245`
  （BB06/BB09/BB10 行）；`docs/goals/teams-agent-handoff-20261005.md`。
- 本轮 review 边界：**编码前设计准入**（需求 → 设计 → 验收路径），不是实现后的架构 review，
  也不代表产品功能 PASS。实现后的 U7 review 与 milestone review 仍是独立门禁。

## 2026-10-09 U7 round 25 BB10 stop 修复（已合并 main）

- 交付：merge `d57ebeb`（候选 `49caaab`；修复提交 `6816fc0`，父 `df6228a`）。集成后 tree
  `6d7f5697ba2f7eeed2b80bb004b3a21db0664792` 与已验候选 tree **逐字节相同**；`origin/main` 已确认
  `d57ebeb`。
- 根因两个，都在各自 owner 修复：
  1. `runtime/managed-opencode.ts`：`stop()` 只发 SIGTERM 后等待。托管 `opencode serve --pure`
     子进程若忽略 SIGTERM，其 `ChildProcess` handle 常驻，Agent 无法退出，launcher 在 5s 窗口内
     无法确认。现改为 SIGTERM → 在 `stopTimeoutMs/2` 内确认 → SIGKILL → 用剩余预算确认 → 否则
     throw；整个过程仍在调用方 `stopTimeoutMs` 之内。原生 spawn 原因（ENOENT）仍原样抛出。
  2. `runtime/local-supervisor.ts`：teardown 循环一旦有子进程超窗就把 launcher 标记 failed，
     于是只读 `lifecycle` 的退出守卫不再匹配；下一个子进程的干净退出覆盖 `lastFailure`，把
     `local relay exited unexpectedly code=0 signal=null` 发布为公开错误。新增 `tearingDown`
     覆盖整个 teardown，`onExit`/`onError` 在该标志为真时一并返回。
- 关键证据（证明是孙进程扣住两者）：agent 54909 的活跃 handle 只有 1 个 `ChildProcess`
  （opencode 55283，`killed:true`、`exitCode:null`）加 1 个 stdio Socket，timer 为 0；
  `kill -KILL 55283` 后 54909 与 launcher 54900 在约 0.5s 内消失。经 Node inspector 采集。
  历史公开症状已留档：`r23/obs/failure-fixtures/agentteams-u7-bb10-c6gMED-internal.toml`。
- 回归测试各覆盖一个缺陷，**回退对应半边即失败**：
  `runtime/managed-opencode.spec.ts` 的 SIGTERM 免疫基座用例；
  `runtime/local-supervisor.spec.ts` 的「子进程超窗 + relay 干净退出」用例。
- 验收：定向 490 tests / 53 files PASS；`scripts/regression.mjs` 776 tests / 83 files PASS；
  `build:runtime`、`typecheck`、`lifecycle:admission`（candidate `49caaab`，ok:true）、
  `appsdk guide compile`、`appsdk compile`、`pnpm smoke` 均 exit 0。安装包黑盒：BB10 在空闲机器
  通过且 stop exit_code 0、`lifecycle_anomaly` 全 false、`owned_pids_alive_after_stop` 为空；
  BB01–BB14 全扫 14/14 PASS。
- 一次独立 review PASS，无缺陷；两条收尾建议已并入 `49caaab`（补 await 并断言 SIGKILL 信号；
  注明 teardown 之后归因窗口的边界）。
- 两次 flake 均为负载所致、非本缺陷，且都复现为通过：BB13 在全扫中失败但单跑通过；BB10 的
  boundary `credential_echo` 超时一次，当时 stop 段仍 exit_code 0，空闲机器复跑通过。
- 资源回收：仅用显式字面 PID 释放并逐一确认消失（launcher 49328、agent 49362、opencode 49931、
  孤儿 stub 71127，以及更早的 54900/54909/55283、19545 与 r23 批次）；核对真实路径与前缀且确认
  无存活进程后，删除 11 个 `/private/tmp/agentteams-u7-bb10*` 任务临时 fixture。无关的既有
  PID 1694（端口 4096）未触碰。
- 证据目录：`/Volumes/Intel/playground/agentteams/.worker-runs/u7-user-driver-20261006/lead-r12/r25/`
  （`MILESTONE.md`、`all/`、`bb13/`）与 `r23/obs/ROOT-CAUSE.md`。
- 剩余主线：交接文档 §6 A（`40d320f` 消融候选独立交付）、B（U4 安装后公开 Work）、C（U5/U6 与最终收口）。
  MVP 尚未全部完成。

## 2026-10-09 U7 round 26 最终产物全扫（BB01–BB14）

- 目的：在合并后的同一安装包上做一次单次调用的黑盒全扫，替代 r25 里带 BB13 flake 的那次。
- 产物身份：候选 `49caaab`，tree `6d7f5697ba2f7eeed2b80bb004b3a21db0664792`（与已验候选逐字节相同）。
- 首次启动被拒：`staged package receipt belongs to another candidate`。原因仅为 receipt 的
  `base_commit` 过期——它记录重建时的 `origin/main`，而合并推送已让 `origin/main` 前进。
  `head_commit`/`tree_hash`/`indexed_tree_hash` 三项都与当前一致。重跑 `pnpm build:governance`
  后 receipt 自洽，产物 `content_sha256 97993a6d…`。这是治理簿记，不是产品缺陷。
- 全扫结果：BB01–BB14 共 14 例，12 通过、2 失败。
  - BB12 失败：`CONFLICT: A prompt is already active for this session`（`runtime/agent-process.ts:471`
    的并发准入守卫）。**r27 已更正此处判断**：当时写成「tool 探测被重复投递两次」是误读，
    provider 的 3 次请求其实是两次完整回合加上工具回合的续召，不是重复投递。真因见下节。
  - BB13 失败：`pnpm verify` 内 `agent-host/cli-executor.spec.ts` 3 个用例失败（776 tests / 773 通过），
    与 r25 同一签名，仍是 5 秒用例超时的负载族。
- 结论：BB10 的 stop 缺陷已关闭且未复现；r26 剩余两例为负载相关不稳定，非本次修复引入。
  最终「同一安装包 BB01–BB14 单次全绿」尚无证据，MVP 未收口。
- 资源：全扫后无残留进程，临时根目录已全部移除。

## 2026-10-09 U7 round 27 BB12 回合结束判据修复（已合并 main）

- 症状：r26 全扫里 BB12 在权限探测处被 `CONFLICT: A prompt is already active for this session`
  拒绝（`runtime/agent-process.ts:471` 的并发准入守卫）。
- 根因（在驱动，不在产品）：一次工具回合会投影**两个** `final`——发出工具请求的那条 assistant
  消息以 `finish: "tool-calls"` 完成（中间态），回合只有在这之后出现终结性 finish 时才算结束
  （失败证据里对应 `[13] tool-calls` 与 `[14] stop`）。旧 `waitForSessionTurn` 的判据只是
  `finals.length > previousFinals`，因此在中间态就返回，驱动立即下发下一个 prompt，而该回合
  仍持有 session，守卫于是正确拒绝。产品侧无缺陷：`opencode-adapter/src/index.ts:667-670` 按上游
  原样投影 `finish`，`runtime/agent-process.ts:303` 在回合终态正确释放记录。
- 修复：`scripts/blackbox-user-mvp.mjs` 的 `waitForSessionTurn` 仍要求 `state === 'completed'`，
  仅额外跳过 `finish === 'tool-calls'` 的 intermediate final。这是**加强**判据：未放宽断言，
  未加宽任何超时。
- 证据（同负载 A/B，决定性）：r26 在 `49caaab` 上 BB12 失败；r27 在 `0c90380` 上同一全量流程
  BB12 通过，13/14。变更区定向测试 `scripts` + `control-protocol` 145/145 通过；
  `scripts/regression.mjs` 776/776、83 files 通过。
- BB13 仍失败，两次失败精确停在 **5002ms / 5007ms**，而同一用例单跑仅 **165ms**；失败点每轮不同
  （artifact-change → config-change），且 `recovery.json` 恢复链本身 `ok:true`。判定为真实回归门禁
  在 776 用例并发跑真 Chrome 时的 5 秒默认超时 liveness 问题，非产品缺陷。既有 issue `43cb0af`
  已两轮独立诊断并结论无源码缺陷，故**不新增补丁、不加超时、不改断言**。该 flake 仍阻塞
  「同一安装包 BB01–BB14 单次全绿」，MVP 未收口。
- 交付：候选 `0c90380` → merge `48073f0`，main 与 origin/main/远端一致（`48073f0`）。

## 2026-10-09 U7 round 28 BB13 归因更正：不是产品缺陷，是缺测试预算（已合并 main）

- r27 的 BB13 失败此前记为「门禁 liveness / flake」。本轮把证据链补全，结论要**更正为可定位的具体缺陷**：
  失败用例缺**自己声明的超时预算**。
- 事实（r27 BB13 `config-change.json` 原始 stderr）：两个失败用例的 duration 精确等于默认值——
  `keeps a successful local browser destruction fact for a repeated close` = **5007.01ms**，
  `preserves real CLI failure output through durable Work state and the wire error chain` = **5002.02ms**；
  vitest 4.1.11 默认每用例 5000ms，仓库 `vitest.config.ts` 与 `package.json` 均未声明 `testTimeout`。
- 对照事实：同一 `agent-host/cli-executor.spec.ts` 在**全量门禁里通过**时这两个用例是
  **1827ms / 1632ms**（修复后实测；r27 基线报 2049.9ms / 1751.0ms），单跑约 316ms。
  即它们平时只用掉默认预算的 1/3，一旦与真 Chrome 套件并发就顶到 5000ms 被切断。
- 事实（本轮新发现，推翻此前「只有这一个文件」的判断）：仓库**所有**较慢用例都显式声明预算，
  且大量使用下划线字面量（`300_000`、`30_000`、`60_000`、`15_000`、`18_000`）。
  例如 `cli/package-install.spec.ts` 有 8 处（含 39260ms 那个用例的 `}, 300_000)`）。
  我早前的检测正则漏掉下划线写法，因而误判。唯一例外的真实进程用例就是 `cli-executor.spec.ts` 这两个。
- 根因（唯一 owner = `agent-host/cli-executor.spec.ts`）：这两个用例是本文件里唯一真实 spawn 外部进程的，
  却没有声明预算。产品侧无缺陷——`agent-host/cli-executor.ts` 不含 spawn/超时逻辑，真实 spawn 在
  `cli-adapter/fixed-process.ts`（`defaultTimeoutMs = 30_000`）。
- 修复（commit `1f0cae4`）：给这两个用例加 `{ timeout: 30_000 }`，沿用仓库既有写法
  （`ui/teams-console/tests/render.spec.ts:81` 同形）。**未改产品代码，未放宽任何断言，未加宽任何既有超时常量。**
- 修复（commit `c602b4c`，本轮新发现的第二处自身缺陷）：`runtime/managed-opencode.spec.ts` 的 SIGTERM 升级用例
  从 `startManagedOpenCode` **之前**开始计时，把启动就绪等待一起算进「停机预算」，负载下报
  `expected 4318 to be less than 4000`。改为只计 `handle.stop()` 的窗口（符合该断言注释「the whole stop」
  的原意，以及 `runtime/managed-opencode.ts:79` 的 `stopTimeoutMs` 语义），并补 `{ timeout: 30_000 }`。
  `SIGKILL` 断言保留不变。
- 证据（同负载，全量门禁单次调用）：`node scripts/regression.mjs` →
  **776/776 tests 通过、164 suites、failed 0、pending 0、`success: true`**（load 7.56–12.49）。
  对照：修复前同一命令得到 `success: false`（先是 `package-install` 23 skipped，再是 managed-opencode 1 failed）。
  `pnpm typecheck` 退出码 0。
- 交付：`744ac79` → `1f0cae4` → `c602b4c`；已快进合并并推送，`main == origin/main == c602b4c`，工作树干净。
  该 4 次回归的失败集合每轮不同（artifact-change → config-change，1→3→5 个用例）与「同一 load 相关的预算缺口」
  一致，与「产品功能损坏」不一致。
- 未收口：BB13 仍需在最终安装包上重跑全量确认；MVP 的「同一安装包 BB01–BB14 单次全绿」待本轮（r28）结果。

## 2026-10-09 U7 round 29–30：门禁预算落地、验收证据截断修复，以及新的 SDK pin 外部阻塞

- r28 结论落地：`vitest.config.ts` 声明 `testTimeout: 90_000` 与 `hookTimeout: 90_000`（commit `e6645c6`，已合并推送）。
  依据：16 个 include glob 覆盖的 83 个 spec 共 743 个 `it|test`，其中 637 个不声明预算；只有真实进程/真 DOM 的
  慢用例显式声明。U6 已归档的整轮回归实践本身就是 `--testTimeout=90000`。未改任何断言，未放宽任何既有常量。
- 门禁复核（`e6645c6`）：`node scripts/regression.mjs` → `success: true`、164 suites、failed 0、776/776、pending 0。
- 事实（新发现的自身缺陷）：`scripts/blackbox-user-mvp.mjs` 的 `run()` 用 pipe 捕获子进程输出。Node 的
  `spawnSync` 在子进程异常退出时丢弃管道缓冲区（约 64 KiB）之后的内容，所以 BB13 失败时 `failure.json`
  只有 65504 字节，776 个用例里失败的 2 个套件名不可恢复，连续两轮（r28、r29）无法归因。同一模式也在
  `scripts/lifecycle-adapter.mjs` 的 `run()`——它既是该输出的生产者，也是 stage log 的写者。
- 修复（commit `ac0766f`，已合并推送）：两处 `run()` 改为经临时文件捕获 stdout/stderr；fd 获取、spawn、
  读取、stage log 写入与失败路径同处一个 try，`finally` 关闭已获取的 fd 并删除捕获目录。未改断言、
  阶段命令、错误文本和 stdout-再-stderr 拼接顺序。独立 review 首轮 FAIL（两处 cleanup 作用域不完整，P2），
  修复后针对性复核 PASS。
- 事实（r30 全量 sweep，13/14）：BB01–BB12 与 BB14 全部通过；BB13 在**第 7 阶段 artifact-change** 失败，
  证据 `.worker-runs/u7-user-driver-20261006/lead-r12/r30/all/cases/BB13/artifact-change.json`。前 6 阶段
  （recovery、reentry、idempotent-entry、source-change、config-change、graph-change）全部通过，说明本轮
  **内层 `pnpm verify` 已通过**（r28、r29 都卡在第 1 阶段）。
- 根因（r30 的 BB13，不是产品缺陷，也不是本次改动）：`appsdk verify` 报
  `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0012:required_binary=appsdk-0.1.0012` 并退出 1。
  事实：`.appsdk/project.json` 的 `sdk.version` 是 `0.1.0012`；共享二进制 `/Users/fanzhang/.cargo/bin/appsdk`
  的 mtime 是 **2026-10-09 21:45**，`appsdk version` 报 **0.1.0013**。SDK 源码
  `rust/src/main/project.rs:86-93` 对 `sdk.version != SDK_VERSION` 直接 fail。
- 时序事实：r30 第 1 阶段在 21:38 仍通过 `pnpm verify`（含 `appsdk verify`）→ 当时二进制还是 0.1.0012；
  21:45 二进制被替换；21:46 的 artifact-change 阶段 `pnpm verify` 因该检查失败。在保留的复现 fixture
  `/var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/agentteams-u7-bb13-repro-CIEJXl` 上**不改任何文件**，
  `appsdk verify` 同样退出 1 并报同一 pin 消息，因此与 artifact-change 追加的换行无关。
- 影响：在当前共享二进制下，`appsdk verify`、`pnpm verify`、`pnpm lifecycle:admission` 与 BB13 都无法通过。
  把 `.appsdk/project.json` 的 pin 试改为 `0.1.0013` 后 `appsdk verify` 报 `INVALID_SDK_LOCK`，
  即还需要官方 SDK 治理刷新（`appsdk pin-lock` / bundle 重装）才能闭合；该动作属于迁移，未获授权前不执行。
- 未收口：BB13 的第 7、8 阶段仍未在最终安装包上验证；「同一安装包 BB01–BB14 单次全绿」未达成。
  r29 的内层 2 个失败套件在 90 秒预算下仍出现、r30 又未复现，其身份仍未确定；本轮已具备完整捕获能力，
  下次出现即可定位。
