# AgentTeams 开发管控

本次按用户“reset appsdk，从头开始建立 appsdk 开发管控”重建。目标是当前独立
仓库的可执行质量基线，保留已经确认的产品架构。不是运行时发布或旧证据续期。

## 唯一归属

- 产品约束：根 `AGENTS.md`；需求/下一步：`docs/goals/`；协议与配置：`docs/design/`。
- 产品 resource/function/mainline/module/verification：`docs/architecture/` 五个 map。
- SDK 实现契约：官方初始化的 `.appsdk/contracts/`、`.appsdk/maps/`、SDK resources/lock。
- 本项目交付单元：`.appsdk/project.json` 的 `teams-source`，绑定现有源码与真实库产物。
  这是统一构建/准入边界，不替代 network、server、config 等语义 owner。
- 根 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` 是依赖与命令入口。
  源码哈希使用源码/配置路径，不把 node_modules 符号链接或 lib 构建输出当源码。

## 每个开发里程碑

1. 获取最新 origin/main，在 `/Volumes/Intel/playground/agentteams/<unit>` 下创建独立
   clean worktree；保持主线只读。
2. 绑定受影响 feature/owner/路径/调用边/验收。先定位真源，比较删除、复用与直接实现。
3. 关键行为先红测后最小修改；同步受影响 maps。探索与验证写本任务独占 run notes。
4. 新 worktree 或依赖输入变化时，在根目录安装 `pnpm install --frozen-lockfile`；
   依赖未变且已可用时复用。先执行当前阶段需要的定向验证，再按重入规则决定
   是否需要全量 `pnpm verify`。
5. 完成适用实际入口证据，再按本目标已获用户选择的独立 Codex exact review 路由
   审查精确候选；AGY Review 不属于本目标的 review gate。变更后重跑受影响验证和 review。
6. commit、push、合并、安装、发布分别按授权执行；review PASS 不等于这些动作完成。

`pnpm verify` 顺序执行全量测试、类型检查、Guidance compile、AppSDK compile、编译
产物 HTTP smoke、AppSDK verify；任何命令失败即停止。它是新候选、依赖/契约漂移或
无法证明证据仍有效时的全量门禁，不是每次恢复或每个阶段都必须重复执行的固定步骤。
`pnpm test` 先构建被依赖的 OpenCode adapter，再运行现有全部测试文件。SDK
project contract 声明的 `minimum_test_count` 继续强制（当前项目声明为 304），
并拒绝 skip、TODO 和 `.only`。该计数门禁的语义变更属于 SDK upstream owner，
本项目不删除、降低或绕过。报告落在 `generated/validation/`。

## 阶段证据与复用

每个 delivery unit 在现有任务 run notes 中维护阶段状态：
`pending → running → passed | blocked`；输入漂移时标记 `invalidated`，有效复用可记为
`reused`。阶段记录只需保存该阶段实际消费的输入、命令/入口和原始 evidence
receipt；只对相关 stage inputs 做 fingerprint，不要求每个阶段重复哈希全部 map、
device、build 和 environment。

恢复或进入下游前先读现有任务笔记和原始 receipt。相关输入未变时，笔记可以直接
引用原始 receipt 并说明复用 gate；不需要另建第二套 reuse 记录。main、remote、
runtime、device 或 environment 等可变状态在依赖它的动作边界刷新。

未受影响的 gate 保留 `passed/reused`。变更只重跑受影响的最小定向命令；只有跨模块
契约、依赖、map、构建入口、产物或全量回归约束变化时才执行 `pnpm verify`。已验证
candidate 与 integrated main 的相关输入等价时，复用已有有效 tests、build、admission
和 review；复用不绕过缺失、失效或冲突证据。阶段失败只阻断依赖它的后续阶段。
由 lifecycle adapter 生成的后续 evidence 仍按其契约标记
`execution.mode=executed|reused` 并引用原始 receipt。

增加功能时补测试并按真实基线更新门槛，不靠降低门槛消除回归。

## 命令、证据与选择粒度

| 阶段 | 入口 | 证据 | 选择条件 |
| --- | --- | --- | --- |
| 定向测试 | `pnpm exec vitest run --config vitest.config.ts <file>` | 命令输出 | 受影响文件或行为 |
| 类型检查 | `pnpm typecheck` | 退出码 | 源码或类型入口变化 |
| 构建 | `pnpm build` | 构建输出 | 构建入口或产物变化 |
| 全量回归 | `node scripts/regression.mjs` | `generated/validation/regression.json` | 候选、依赖或契约漂移 |
| 编译库 smoke | `pnpm smoke` | 命令输出 | 编译产物或 Console 静态资源变化 |
| 安装副本 smoke | `pnpm smoke:installed` | 命令输出 | 安装、重启或公开入口变化 |
| 生命周期准入 | `pnpm lifecycle:admission` | `.appsdk/records/`、`.appsdk-control/lifecycle-adapter/` | 正式阶段记录或发布准入 |
| 全量门禁 | `pnpm verify` | 各阶段输出与 `generated/validation/regression.json` | 发布范围，或无法证明既有证据仍有效 |
| 集成与回执 | `git push`，再核对远端 | `git ls-remote origin refs/heads/main` | 授权集成 |

普通变更按风险选测；提交动作本身不触发整套测试。只有发布范围或证据失效才跑全量门禁。

## 阻塞回报

阻塞结论必须给出：第一个失败的 gate、保留的状态、重试策略、owner，以及一条可执行的
下一步动作。来源验证、安装/live 验收、review、merge、远端回执与资源清理分别汇报，
不用前一级推断后一级。

类型检查覆盖核心源码、Console/OpenCode 与独立 UI workspace。独立 UI 测试文件进入
全量回归，根 build 编译真实 UI，产物 smoke 从打包副本导入 UI 入口及其
client 依赖。旧宿主 UI 与空壳准入文件已移除；浏览器 fixture 与真实 daemon/手机
实际回放分别留证，构建和模块导入不替代产品运行验收。

## 产物与证据边界

`appsdk compile` 调用真实包构建，将 `.mjs`、声明和 Console 静态资源放入
`generated/modules/teams-source/lib`，由 AppSDK 生成 module-artifact 与哈希。
产物是有外部依赖的库集合，不是独立部署包。打包前只清理本 producer 独占的输出目录。
HTTP smoke 校验编译库与打包文件字节一致，使用已安装依赖执行编译后的 Console，
检查认证、静态文件、新 API、旧路由已移除以及 Session JSON 保真；不调用模型、不冒充跨设备产品验收。

本模块已包含 Relay 进程入口，`deployment_operations: ["install", "restart"]` 声明
服务交付必需的安装与重启。基础包已有真实 installed lifecycle gates：npm tarball
安装、installed CLI/Console 入口，以及 installed Relay 加两个 Agent 的 start/restart。
普通源码测试和库 smoke 不能替代这些安装副本证据。超出该基础包范围的 Agent daemon
与 managed OpenCode 部署仍需各自适用的服务验收，不可用 Relay 单一进程回放替代；
正式服务准入在对应证据齐备前保持未完成。
AppSDK review admission、freeze/Active 发布保留正式证据门禁，本轮不生成假候选、
假 review record、假部署 receipt。普通 compile/verify 与发布准入是不同证据。

首次/最终完整源码基线、发布准入或受影响生命周期需要正式记录时，在候选提交后
运行 `pnpm lifecycle:admission`。文档和测试整理按上述阶段适用性验证；提交动作本身
不触发整套测试和安装重启。该 adapter 不接收 hash 参数：它从
当前 clean worktree 和 Git 对象计算候选身份，按候选 fingerprint 读取自己的阶段状态；
同一候选已经通过且原始日志、产物和环境指纹仍有效的阶段写 reuse receipt 并跳过，
只有缺失或失效的阶段才执行 `pnpm verify`、隔离安装副本的 Relay/Agent 进程启动、
Agent 重启与信号关闭。只有命令真实通过且源码未变化
才生成 `.appsdk/records/` 的 fix-candidate、whitebox、install、restart、blackbox 和
pre-review 记录；完整命令输出保存在 `.appsdk-control/lifecycle-adapter/`。这些本地
记录不代表公网/NAT、managed OpenCode、跨设备或发布验收。

Phase 1 Local Network MVP 的必需 live gates 是：从 `~/.agentteams/config.toml` 启动多个
独立 daemon，经真实本地 socket 完成注册、发现、能力匹配、原子容量、一对多 Work、
restart/generation/idempotency，以及 Console 全关闭后的 Agent-to-Agent Work；多 provider
apply/readback 也必须绑定真实入口证据。它们在真实证据齐备前保持 open，基础测试通过不能
升级这些状态。公网 Relay、真实 NAT 出站、STUN/ICE、NAT-to-NAT、direct、手机蜂窝和完整
UI 属于 post-MVP，由对应的 `*-public-nat` 或后续 delivery gate 收集，不进入本轮 closeout。

Guidance 使用声明的项目 AGENTS 和官方治理 Skill，保持 advisory；它帮助计划，
不重复保存质量 PASS。独立开发不要求 Collab 注册。

## ACP/LAN/WebUI 增量（D00 起）

产品目标与 D00–D08 任务边界由 ACP 交付计划定义。该计划树是外部受控输入，由计划
owner 持有，尚未入库；此处以标题和任务编号引用，不建立死链。D00 的 schema/ABI
决策、迁移说明、示例配置和下游输入版本见
[teams-acp-daemon-config-v4.md](design/teams-acp-daemon-config-v4.md)。

D00 只冻结声明：`config/daemon-intent.ts`、`config/acp-policy.ts` 与
`control-protocol/{acp,engine,teams-connection,teams-state}.ts`。这些文件的声明与
拒绝测试是可执行的定向 gate；它们不证明真实引擎、stdio ACP、网络、注册或 UI 已可用。
`--serve` 的 runtime 启动依赖 D01（stdio ACP adapter）和 D02/D03（引擎 adapter 与
CLI 实际入口）；配置指向注册服务器时还依赖 D04。opencode 与 DSH 两条路径都已接线：同一
`runtime/acp-serve.ts` 的 `engineAdapterFor` 按配置的 engine kind 选择 D02 OpenCode adapter
或 D03 DSH adapter，复用同一 daemon/host/stdio/readiness/stop 代码，不新增只编译不启动的
伪入口。D02 有真实 CLI 黑盒证据，D03 有真实安装 DSH 0.2.0-rc.2 的 `--serve dsh` 黑盒证据。

| gate | owner | 状态 | 入口 | 覆盖 |
| --- | --- | --- | --- | --- |
| `teams-acp-daemon-intent` | config | partial | `pnpm exec vitest run --config vitest.config.ts config/daemon-intent.spec.ts config/acp-policy.spec.ts && pnpm exec tsc --noEmit && pnpm build:runtime` | 单 daemon 编译、CLI 覆盖与生效读回、v3 与多 daemon 拒绝；不含 runtime 启动 |
| `teams-acp-public-contract` | control-protocol | partial | `pnpm exec vitest run --config vitest.config.ts control-protocol/acp.spec.ts control-protocol/teams-connection.spec.ts control-protocol/teams-state.spec.ts` | ACP frame/fault、engine adapter port、Teams 协商 frame 与连接状态 DTO 的形状与拒绝 |
| `teams-acp-d01-host` | agent-host | partial | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts` | D01 已合并候选 75a6cf4 的引擎无关 stdio ACP 传输、host 的 Session/policy/history 语义与 runtime 子进程接线（标注 test peer，53/53 通过）；本命令本身无真实引擎推理、无安装/live 证据（真实引擎证据属于 `teams-acp-d02-opencode` 与 `teams-acp-d03-dsh`） |
| `teams-acp-d02-opencode` | opencode-adapter | partial | `pnpm exec vitest run opencode-adapter --no-file-parallelism` | 已合并候选 1d4df3a（修复 1af8fe5/9436aae）的 OpenCode adapter：compileLaunch 唯一编译 launch spec、verifyEffective 只报引擎 session/new 返回的模型、真实 prompt/cancel/permission/黑名单（本地 stub provider + 已安装 opencode，65/65）；非安装副本证据，不含 D03 |
| `teams-acp-d03-dsh` | dsh-adapter | partial | `pnpm exec vitest run dsh-adapter runtime/acp-serve.spec.ts --no-file-parallelism` | D03 冻结候选 60bf76b 的 DSH adapter：launch 编译、policy-before-side-effect、native config 派生与 effectiveness 读回，加上本候选的 `--serve dsh` 接线（`engineAdapterFor` 分发、`DSH_HOME` 隔离、stop/失败路径清理 engine home、adapter 自持 `enforceablePolicies` 且入口不替换为 `declaredMethods`）；dsh-adapter 31/31 通过；两个本地非 CI driver 覆盖真实 dsh 0.2.0-rc.2：adapter driver 18/18，`--serve dsh` 黑盒（真实 prompt/cancel/显式 PID stop）PASS；仍无安装副本证据、AppSDK 仍阻塞 |
| `teams-acp-d04-registry` | runtime | partial | `pnpm exec vitest run --no-file-parallelism server/relay.spec.ts network/relay-client.spec.ts network/registration-client.spec.ts server/registry-intent.spec.ts runtime/registry-process.spec.ts runtime/registry-registration.spec.ts` | D04 已合并候选 953d952 的 registry daemon 生命周期、TLS-only intent 映射、presence 租约与客户端注册/心跳/重连（已按当前候选复验 75/75 通过；候选黑盒 14/14 经 review 独立复现）；无安装副本/live `--serve` 证据、AppSDK 仍阻塞 |
| `teams-acp-d05-network` | network | partial | `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts network/teams-egress.spec.ts runtime/serve-egress.spec.ts control-protocol/teams-connection.spec.ts` | D05 连接层与入口组合：冻结 frame 上的协商执行（唯一 agreement 来源、typed 拒绝、R3 整数 acceptedRevision）、认证 ACP session（本地分配 ref、收包边界重写 generation/engineInstanceId、payload 原样透传）、ingress/status 端口、kind=connection 历史、membership 视图与 R4 增量发布面（103/103 通过，含 network/teams-egress 8 与 runtime/serve-egress 5）；D00 amendment A3 让响应方在 context 帧发布自身实时 engineInstanceId，发起方据此命名 `acp.open` 的必需 ref，接收方原有的 STALE_GENERATION 拒绝不变；A3 现已被消费：发起方 session 的 `open()` 开出通道、命名目标 engineInstanceId、采纳 ack ref 作为 peer ref，host 面 ref 保留本侧 generation/engineInstanceId，任何失败路径（含 ack 前传输断开）都释放本地 host 通道，并与真实响应方 session 完成双侧握手；L9 交付生产发起方组合器 network/teams-egress.ts：复用 createTeamsFrameTransport、TeamsConnectionLedger、runTeamsNegotiation 与 createTeamsSession.open()，在真实 openTeamsIngress 响应方、真实双侧 session 与真实 AcpHost 上验证（host 面只见到本侧 localRef，线上 acp.open 命名目标 engineInstanceId，永不发送 acp.open_ack）；仍无 installed-copy/restart/deployed/cross-device 证据，且 runtime/acp-serve.ts 现组合 runtime/serve-egress.ts（L9 command-side）：入口在 listener 与 registration 就绪后按已接受 intent 声明的 peer 自行拨出，未知 peer、无显式 endpoint/admissionRef/tlsTrustRef 与重复连接分别是 typed 拒绝，无法拨出的 peer 记录 typed 失败而不崩溃、不静默跳过，handle 暴露 live rows/failures，stop 先关 egress 再关 host；targetCapabilitiesRevision 来自既有 D04 目录读回，expectedTargetGeneration 用入口自身发布的 listener 常量（目录只携带 relay login generation，属不同值，故不逐 peer 猜测）；隔离传输观测脚本在真实 TLS 回环 direct-WSS listener 上跑通真实准入、hello 握手与 ACP 帧往返（23 项）；D05 closure driver 覆盖两真实引擎 LAN、registry outage 存活、降级报告与无 control 进程；L9 command-side 黑盒 docs/evidence/acp-l9-command-side-20261013/black-box-self-dial.mjs 以两个真实 `--serve opencode` daemon、真实 registry 与真实 TLS LAN listener 运行 exit 0，拨出方自身 durable history 记录与声明 peer 的协商 agreement，双侧记录同一 agreement 与已打开 ACP 通道，且 driver 从未向任一 daemon 开 socket；仍无 installed-copy/restart/deployed/cross-device 证据 |
| `teams-acp-serve-entry` | runtime | partial | `pnpm exec vitest run runtime/acp-serve.spec.ts cli/agentteams.spec.ts --no-file-parallelism` | 用户入口真实启动：单 daemon + 单引擎子进程、绑定缺失/控制 daemon/非回环无 discovery 的 typed 拒绝、`engineAdapterFor` 单点分发 opencode 与 dsh、readiness 只取引擎 session/new、显式信号停止并返回真实 EngineStopResult、stop 与失败路径清理自有 engine home、只接受 adapter 自己声明的 `enforceablePolicies`（缺失即 typed 失败，不回退 `declaredMethods`）；D04 注册与 D05 LAN negotiation 已接入该入口；两条真实 CLI 黑盒：opencode 见 `docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs`，dsh 见 `docs/evidence/acp-d03-serve-20261010/black-box-serve-dsh.mjs`；仍无 DSH installed-copy 回放、restart、deployed-entrypoint 与 cross-device 回执 |
| `teams-acp-d06-control` | runtime | partial | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | D06 控制守护进程：唯一控制进程生命周期（单 PID、单 WebUI listener、自有 state/data 目录、显式 PID 停止、typed `ALREADY_RUNNING`/`STALE_GENERATION`/`STALE_OWNER`/`PORT_OCCUPIED`/`CREDENTIAL_UNAVAILABLE`/`INVALID_STATUS`）、CLI `control start\|status\|stop`、D00 amendment A2 增量线面（闭合 history 路由与真实 SSE 快照、新增闭合命令种类、permission options 与 reply `optionId`）、A2.7 真实 D05 网络状态端口绑定（`createTeamsStatusPort` 唯一注入点、真实 `connections` 投影、真实 `kind=connection` 持久历史与分页、未注入时 typed 缺席）、A2.6 引擎侧 permission option 投影与回复裁决（optionId 必须来自引擎真实集合，缺失/过期回调不自动批准）；两条真实黑盒：`docs/evidence/acp-d06-control-20261011/black-box-control.mjs`（PART 1，10/10）与 `docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs`（PART 2 真实端口绑定与真实历史行，7/7）。仍为 partial：无 installed-copy 回放、无 restart、无 deployed-entrypoint、无 cross-device 回执；本门禁自身无浏览器回放（源级浏览器证据在 `docs/evidence/acp-d08-browser-20261011/`，属不同证据层，不关闭本门禁）；`GET /api/v1/history?kind=request` 由 D05 连接历史 owner 拒绝（非第二历史源），`kind=connection` 之外的请求分页未交付。本条增量原先作为独立 D09 单元承载（2026-10-11，base 8cb0238），现已折入 D06：无单独 D09 单元、无单独 D09 门禁、无单独 D09 证据目录。该增量补齐投影半边：`createControlNetworkStatus` 用 `RegistrationClient.directorySnapshot` 读真实 D04 目录、经唯一 `directoryAgentObservation` 映射为真实 Console agent 行，并经已声明的 `ControlProjectionSource` watch 流式输出；门禁 117→118（runtime/control-process 16→17），真实黑盒 `docs/evidence/acp-d06-part2-20261011/black-box-control-directory-projection.mjs`（9/9） |
| `teams-acp-d07-webui` | ui/teams-console | partial | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism ui/teams-console/tests/api.spec.ts ui/teams-console/tests/boundary.spec.ts ui/teams-console/tests/contract-compat.spec.ts ui/teams-console/tests/controller.spec.ts ui/teams-console/tests/drafts.spec.ts ui/teams-console/tests/focus-dom.spec.ts ui/teams-console/tests/live-client.spec.ts ui/teams-console/tests/locale.spec.ts ui/teams-console/tests/model.spec.ts ui/teams-console/tests/observation.spec.ts ui/teams-console/tests/page-networking.spec.ts ui/teams-console/tests/render.spec.ts ui/teams-console/tests/render-d07.spec.ts` | D07 WebUI：四个页面（发现、组网、交互、历史）只消费 owner 投影/历史/SSE 数据（UI 只声明 additive `TeamsConsoleClientV1` 扩展，不修改 `console-api.ts` DTO）；`render-d07.spec.ts` 在真实 Chrome DOM 中逐页验证冻结标记 `data-team-page`/`data-team-page-view`/`data-team-band`/`data-band-state`/`data-team-observation`/`data-team-cancel`/`data-permission-option`/`data-team-refused`/`data-team-error-code`/`data-team-draft`/`data-team-accepted`/`data-history-*`，并断言引擎未给 options 时不伪造任何权限按钮、owner 丢失时观察带进入 `stale`；`live-client.spec.ts` 覆盖 additive 历史分页、`kind=request` typed 拒绝与 SSE 快照订阅/取消；真实黑盒 `docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs`（15/15）走真实 `control start\|status\|stop` 与认证 HTTP，逐一走到 served `/ui/` 模块图的 D07 标记、`/api/v1/history` 页面与拒绝、`/api/v1/events` 的 `{seq, projection}` 快照、三条写入命令的 typed 拒绝（`connection.connect`/`network.membership.apply` 为 `UNSUPPORTED_OPERATION`，`permission.reply` 因控制 daemon 无 Session owner 而拒绝）、冻结词汇之外 payload 的 400 parser 拒绝、匿名访问的 `401 Basic` challenge；仍为 partial：无 installed-copy replay、无 restart、无 deployed-entrypoint replay、无 cross-device receipt、无通过 serve entry 的 live registry composition、无 mobile claim；headless Chrome 无法向同源 `fetch`/`EventSource` 提供 HTTP Basic 凭据这一早先结论是错的：CDP `Network.setExtraHTTPHeaders` 能在网络层注入凭据，真实 live-browser DOM 证据见 `docs/evidence/acp-d08-browser-20261011/`（14 checks / 1 gap），冻结 DOM 契约仍以真实 Chrome 渲染测试为准；A3 的发起方通道打开原语已在 network/teams-session.ts 的 `open()` 交付（103/103），生产发起方组合器 network/teams-egress.ts 与 runtime/serve-egress.ts 亦已交付，且 runtime/acp-serve.ts 在 listener 与 registration 就绪后经 runtime/serve-egress.ts 自行拨出已接受配置声明的每个 peer（真实黑盒见 docs/evidence/acp-l9-command-side-20261013/：两个真实 --serve daemon + 真实 registry + 真实 LAN listener，无 driver 代开的 socket），但 `connection.connect`/`connection.disconnect`/`network.membership.apply`/`permission.reply` 与 Session owner 仍未交付：Console 只能发起到控制 daemon，而控制 daemon 仍以 typed UNSUPPORTED_OPERATION 拒绝，且当前不存在「控制 CAS 写、agent 观察」的持久 relations-intent 存储，因此 discovery→connect 与 master/peer apply 在本 unit 不能完成 |
| `teams-acp-d08-acceptance` | integration | partial | `node docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs` | D08 最终验收：用项目自身 producer 打最终包并隔离安装 tarball，全部 daemon 从 installed CLI 入口启动（两个 agent：opencode + dsh，一个 control，一个 registry），在真实 LAN 地址 `192.168.0.3` 上跑通 A01–A11。2026-10-12 07:56 PST 运行 45 checks / 3 gaps / 2 个非缺陷观察，exit 0，278s（graceful stop+start 复用 generation 1，无需求约束该行为；A11 回执经读取校验而非重放流量）。这些运行发现并修复四个真实缺陷：`44d82f7`（stop 现在关闭自身 listener 连接，live WebUI SSE 客户端不再把 daemon 拖过调用方的有界 stop 等待）、`146824a`（stop 现在保留 durable data directory，连接 history 因而跨 stop+start 存活，满足 D06 的「restart 观察和 history 恢复」）、`d8f5cd1`（A02 的 DSH prompt 对上游瞬时 503 做指数回退重试，不再因首次拒绝即终止，从而跑完 A03–A11）与 `d05f3a0`（第二类上游形态 `turn failed: Connection error` 归类为瞬时；仅在 engine 进程仍存活时重试无响应超时，engine 已死则立即失败）。保留三个未收口缺口且不从任何 PASS 推断，均属 A07：A07 真实事件驱动动画（仅目录半边已交付：投影携带真实 D04 目录行且真实注册推进 SSE `seq`，但无 Session/permission/notification 事件可推进，因为未绑定 owner）、A07 WebUI 定向交互（shipped control daemon 未绑定 Console/Session owner，D06 要求的 connect/disconnect、`network.membership.apply`、Session owner 与定向 ACP ingress 尚未交付，属未满足需求而非证据边界；D06 的目录投影增量——原作为独立 D09 单元承载，现已折入 D06——已交付 discovery query 与 membership 的**读侧投影**（经 `ControlProjectionSource` watch 输出真实目录行），故二者移出本缺口；但 `network.membership.apply` 这条**写侧命令**仍未交付，仍在上述未交付清单内）、A07 live-browser DOM 与截图（本 driver 不驱动浏览器，故 installed-artifact 层无 DOM 或截图证据）。A07 live-browser DOM 的旧理由是「headless Chrome 无法提供 HTTP Basic 凭据」，该结论已被推翻：`docs/evidence/acp-d08-browser-20261011/` 用真实 Chrome + CDP 网络层凭据 + 干净 origin URL 驱动 shipped entry，得到真实认证 fetch、页面自身的 `/api/v1/events` 订阅与 `/api/v1/history` 读取、以及真实 PNG 截图（14 checks / 1 gap）；该证据发现并修复三个真实缺陷（origin 发 `event: projection` 而客户端订阅 `snapshot`、产品从不调用 `startObservation()`、history 视图无首次读取）。但源级浏览器运行不能关闭本门禁的 installed-artifact 层缺口，且该 driver 不驱动浏览器。A11 跨设备回执已收口：A11 单元（`869aff8`）已合入本候选，driver 现校验其回执（19 checks / 0 gaps，两个不同的非 loopback 主机 Macstudio.local 与 jennys-macbook-air.anoa-buri.ts.net），因此跨设备结论经已集成证据成立；该回执由读取校验而非重放流量得出，故记为 finding 而非 gap。事件驱动动画与 WebUI 定向交互仍需 Console/Session owner；缺口消除前总目标保持 INCOMPLETE |

D02 交付 OpenCode 引擎 adapter（`opencode-adapter/src/acp-engine.ts`）与 `--serve`
用户入口（`runtime/acp-serve.ts` + `cli/agentteams.mjs` 的 flag/dispatch）。
`teams-acp-d02-opencode` 在合并候选 `1d4df3a` 上可执行并通过（65/65，含 4 个真实引擎
用例）；`teams-acp-serve-entry` 在本候选上可执行并通过（runtime/acp-serve.spec.ts 26/26、
CLI spec 30/30，另有两条真实 CLI 进程黑盒：opencode 与真实安装 DSH 0.2.0-rc.2；opencode
黑盒在本地 `npm pack` + `npm install` 的安装副本 `node_modules/.bin/agentteams` 上重跑也
通过），但它仍是 partial：DSH 黑盒是本地 live 运行、没有安装副本回放，监听仅 loopback，
注册（D04）与连接协商（D05）已由本 closure 接入该入口（真实 LAN 黑盒 PASS 前须外部 DSH provider 可用）；该安装副本是本地基础包安装，不是发布产物或
AppSDK 生命周期回执。D03 的 `--serve dsh` 接线在 `runtime/acp-serve.ts` 的同一
`engineAdapterFor` 分发点落地，daemon/host/stdio/readiness/stop 代码不重复。adapter 的
库级语义未被本增量修改；`runtime/agent-process.ts` 仍是旧 Work 入口，未被 `--serve` 替换。

D01 只交付引擎无关的 ACP 传输与 host/runtime 接线：`acp-adapter/stdio.ts`、
`agent-host/{acp-host,acp-history}.ts`、`runtime/{acp-daemon,acp-history-store}.ts`。
`teams-acp-d01-host` 在合并候选 `75a6cf4` 上可执行并通过（53/53），但它只证明标注
test peer 下的传输与 host 语义，不证明真实引擎、安装副本或 live daemon，因此保持
partial，不升级为 passed/implemented。D02 之后 `--serve opencode` 用户入口已接线，
`teams-acp-serve-entry` 从 design 升为 partial，并在同一变更内绑定 D02 adapter 与
入口的 owner、路径和 gate。`.appsdk/project.json` 的 `teams-source` 现在声明
`acp-adapter/**` 与 `cli/**` 为 owned/regression 输入，`minimum_test_count` 未改动；
本增量未新增 `.appsdk` 准入路径，因为 `runtime/**`、`cli/**`、`opencode-adapter/src/**`
与 `docs/**` 已在其中。

D03 只交付 DSH 引擎 adapter：`dsh-adapter/index.ts`、`dsh-adapter/native-config.ts` 与
已提交的证据 driver `dsh-adapter/real-engine-evidence.mjs`。它把已接受的 Teams 配置派生为
DSH 原生 profile patch（`teams-<providerInstanceId>` pi-ai 路由 + `acp` provider/model 行），
在写文件或 spawn 之前断言 policy，并只用真实 initialize 结果与真实 `session/new` 的 `model`
选项读回证明 effectiveness；unsupported DSH 能力在 adapter 边界显式拒绝。`teams-acp-d03-dsh`
在冻结候选 `60bf76b` 上可执行并通过（dsh-adapter 31/31）。本候选把 `--serve dsh` 接到
`runtime/acp-serve.ts` 的唯一 `engineAdapterFor` 分发点，与 `--serve opencode` 共用
daemon/host/stdio/readiness/stop 代码，遵守 `DSH_HOME` 隔离、派生 profile patch、
`DSH_PERMISSION_MODE` 与 telemetry 关闭，并在 stop 与启动失败路径删除自有 engine home；
adapter 同时按自己的 `dshHasPolicyEnforcementOwner` 规则声明 `enforceablePolicies`（覆盖
`capability:`/`client-capability:` 等 D01 host 真正执行的类别），入口只要求该声明、缺失即以
typed fault 指名 adapter 失败，绝不回退到 `declaredMethods`；
真实安装 DSH 0.2.0-rc.2 的 `--serve dsh` 黑盒（真实派生配置、真实 prompt、cancel、显式 PID
stop、零泄漏 engine home）见 `docs/evidence/acp-d03-serve-20261010/`。它仍保持 partial，
不升级为 passed/implemented：DSH 黑盒是本地 live 运行、没有安装副本回放，
AppSDK compile/verify 仍被既有 0.1.0014 pin mismatch 阻塞。两个真实行为带 owner
保留：真实 DSH initialize 广告 `embeddedContext: false`，与冻结 policy 对 `resource_link`
提示要求 `capability:/promptCapabilities/embeddedContext` 冲突（Lead 的 policy 决策）；
`session/list` 在会话仍打开时返回 `[]`（DSH 引擎行为；D05/D06/D07 消费者不得把它当作
live-session 目录）。`.appsdk/project.json` 的 `teams-source` 现在把 `dsh-adapter/**` 纳入
owned/regression 输入，`minimum_test_count` 保持 304。

D04 只交付注册 daemon 与自动注册：`server/registry-intent.ts`、`server/relay.ts` 的
presence 租约、`network/registration-client.ts`、`runtime/registry-process.ts` 与
`runtime/registry-registration.ts`，以及 `agentteams registry start|status|stop` 入口。
`teams-acp-d04-registry` 在本候选上已复验并通过（75/75），它证明源码层
的 registry 生命周期、TLS-only intent 映射、租约与客户端注册/心跳/重连。D05 closure 已把注册路径接入 `--serve` 组合，但 D04 gate 本身仍不证明安装副本、restart、deployed-entrypoint 或 cross-device 证据；AppSDK compile/verify 仍因既有 0.1.0014 pin mismatch 阻塞，因此保持 partial，不升级为 passed/implemented。D04 的四个新
文件与 `cli/**` 已由 `teams-source` 的 owned/regression 路径覆盖，`.appsdk/project.json`
无需改动，`minimum_test_count` 保持 304。

D05 交付网络连接层（协商、会话、连接历史、membership、ingress/status 与增量发布面），并接线 runtime
serve 入口：`network/teams-negotiation.ts` 在冻结的 context/propose/accept/reject/confirm/ready
frame 上执行协商，身份只来自已认证的传输事实，`negotiatedAgreement` 是唯一 agreement
来源；`network/teams-session.ts` 把一个已认证连接桥接到注入的 `AcpHost`，在收包边界分配
本侧 connectionId/channelId 并把 targetGeneration/engineInstanceId 重写为本地值；
`network/teams-connection-history.ts` 以 kind=connection 写入/读取冻结的 HistoryRecord；
`network/teams-membership.ts` 从目录/路由/注册三个既有面组装 per-remote-agent
`TeamsConnectionStatus`。`teams-acp-d05-network` 在本候选上可执行并通过（103/103，含新增 ingress/status/control-protocol parser specs、A3 engineInstanceId 用例、发起方 `open()` 双侧握手用例、独立 review 发现的两条 host 释放测试、L9 的 network/teams-egress 8 条真实双侧组合用例与 L9 command-side 的 runtime/serve-egress 5 条真实 TLS 回环拨出用例），另有隔离观测脚本
`docs/evidence/acp-d05-network-20261010/isolated-transport-observation.mjs` 在真实 TLS
回环 direct-WSS listener 上跑通真实准入、真实 hello 握手与真实 ACP 帧往返（23 项）。
它保持 partial，不升级为 passed/implemented：隔离观测中的 peer 引擎仍是进程内脚本 duplex；closure driver 已覆盖两真实引擎 LAN（`--serve opencode` 与 `--serve dsh`）、真实 registry、真实 negotiation、method blacklist 无引擎调用/无 dispatch 记录、registry outage 存活、降级注册报告与无 control 进程；L9 command-side 已把生产发起方组合器 `runtime/serve-egress.ts` 接入 `runtime/acp-serve.ts`，daemon 在 listener 与 registration 就绪后自行拨出已接受 intent 声明的 peer，并有真实入口黑盒 `docs/evidence/acp-l9-command-side-20261013/black-box-self-dial.mjs`（两个真实 `--serve opencode` daemon + 真实 registry + 真实 TLS LAN listener，exit 0，拨出方 durable history 记录与声明 peer 的协商 agreement）；但没有 installed-copy、restart、deployed-entrypoint 或 cross-device 回执。R4 的发布
面是加性的：`RegistrationClient.publish` 复用 D04 注册路径与同样的 online 守卫，
`runtime/registry-registration.ts` 只新增两个纯函数（`listenerRouteCandidates`、
`declarationWithPublishedSurfaces`），没有第二个 registry/directory/发布路径。R4 helper
所在文件由 D05 gate 命令显式纳入（`runtime/registry-registration.spec.ts`），因此 R4 发布面
不会只依赖 D04 gate 覆盖。D05 的四个新
文件与 `runtime/registry-registration.ts` 的加性改动已由 `teams-source` 的 owned/regression
路径覆盖（`network/**`、`runtime/**`、`docs/**`），`.appsdk/project.json` 无需改动，
`minimum_test_count` 保持 304。

D06 交付控制守护进程：`runtime/control-process.ts` 是唯一控制运行时（一个 PID、一个
WebUI listener、自有 state/data 目录，从不启动引擎子进程、registry 或第二个 daemon），
`cli/agentteams.mjs` 新增 `control start|status|stop`，`control-protocol/console-api.ts` 与
`console-host/src/http-api.ts` 承载 D00 amendment A2 的增量线面（闭合 history 路由、真实 SSE
快照流、新增闭合命令种类、permission `options`/`optionId`）。PART 2 把 A2.7 的真实 D05
网络状态端口接到唯一注入点：`createTeamsStatusPort`（`network/teams-status.ts`）由控制进程
自己的真实事实组合（真实 ledger、真实持久连接历史、真实 D04 注册状态、诚实的未确认本地目录
快照），`connections` 投影与 `kind=connection` 历史因此是真实 owner 读；依赖未注入时
`createControlOwner`/`createControlHistoryReader` 仍以 typed 缺席失败，绝不伪造连接状态，
也绝不从 history 推断在线或执行状态。A2.6 的引擎侧投影与回复裁决落在 permission 语义 owner
`agent-host/acp-host.ts`：引擎真实 `session/request_permission` 的 `options` 在 owner 边界
投影为冻结 `ConsolePermissionOption`（畸形集合显式拒绝），回复只能选择引擎真实提供的
`optionId`，缺失或过期回调一律不自动批准。`teams-acp-d06-control` 绑定上述 spec 与两条真实
黑盒（`docs/evidence/acp-d06-control-20261011/black-box-control.mjs` 10/10、
`docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs` 7/7）。两条控制黑盒的 stop
与 failed-start 期望已按 durable 数据目录语义更新并在本候选上重跑（仍为 10/10 与 7/7）：D08
验收运行发现的 `146824a` 让 stop 保留数据目录（连接历史存放在那里，D06 要求它跨重启存活），
旧断言「stop 删除自有数据目录」因此被纠正，而不是放宽。它保持 partial，
不升级为 passed/implemented：D06 自身没有 installed-copy 回放、restart 或
deployed-entrypoint 回放；控制守护进程当前只服务 `kind=connection` 的连接历史，
`kind=request` 由同一 owner 显式拒绝而不是引入第二个历史源。此前这里还写着「没有
cross-device 回执或浏览器证据」，该表述已失效：浏览器证据由本单元的
`docs/evidence/acp-d08-browser-20261011/` 提供（真实 Chrome/CDP，14 checks / 1 gap，
exit 0，属 source 层），cross-device 回执由 A11 单元
`codex/acp-a11-crossdevice-20261011`@`869aff8` 提供（两台物理机，19 checks / 0 gaps，
exit 0，属 remote receipt 层）。两者都不改变 D06 的 partial：它们属于其他证据层，
不替代 D06 自己的 installed-copy/restart/deployed-entrypoint 证据。D06 的改动文件
（`runtime/**`、`agent-host/**`、`control-protocol/**`、`console-host/**`、`cli/**`、
`network/teams-status.ts` 的消费）已由 `teams-source` 的 owned/regression 路径覆盖，
`.appsdk/project.json` 无需改动，`minimum_test_count` 保持 304。

D07 交付 WebUI 的四页真实 owner 投影绑定：`ui/teams-console` 只读消费
`control-protocol/console-api.ts` 的 Console DTO、认证后的 `GET /api/v1/projection`、
`GET /api/v1/history` 与 `GET /api/v1/events`（UI 只声明 additive
`TeamsConsoleClientV1` 扩展，不修改冻结 DTO），并在真实 Chrome 渲染测试
`ui/teams-console/tests/render-d07.spec.ts` 中逐页验证
`nav.teams-tabs`、四个 `[data-team-page]`、`[data-team-page-view]`、
`[data-team-band]`/`[data-band-state]`、`[data-team-observation]`、
`[data-team-cancel]`、`[data-permission-option]`、`[data-team-refused]` 与
`[data-team-error-code]`，并断言引擎未给 options 时不伪造任何权限按钮、owner
丢失时观察带进入 `stale`；通知列表单独复核，因为冻结通知 DTO 不含选项集，所以它必须
按 owner 的 pending `sessionEvents` 事件查选项，缺事件、空选项或已 resolve 时只渲染
`[data-permission-options-unavailable]`，绝不补出批准按钮。真实黑盒
`docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs`（15/15）走真实
`control start|status|stop` 与认证 HTTP。早先记录的浏览器证据边界是错误结论：它把
「headless Chrome 不能把 HTTP Basic 凭据交给同源 `fetch`/`EventSource`、带凭据的 URL 被
`fetch` 自身拒绝」当作原因，这两条都不能成立——CDP 的 `Network.setExtraHTTPHeaders`
能在网络层注入凭据，配合干净 origin URL 即可驱动真实浏览器。真实 live-browser DOM 证据见
`docs/evidence/acp-d08-browser-20261011/`（14 checks / 1 gap）：真实 control daemon、真实
Chrome、真实认证 fetch 与真实 SSE 订阅。该证据发现并修复了三个真实缺陷——origin 发
`event: projection` 而两个 UI 客户端订阅 `snapshot`（不匹配的具名事件被静默丢弃）、产品
任何位置都不调用 `startObservation()`（页面从不打开 `/api/v1/events`）、history 视图无首次
读取且唯一触发器在读到数据前保持禁用。冻结 DOM 契约仍以真实 Chrome 渲染测试为准。
D07 明确不声明 installed-copy replay、restart、deployed-entrypoint replay、
cross-device receipt、通过 serve entry 的 live registry composition 或 mobile claim；
`connection.connect`、`network.membership.apply` 与 `permission.reply` 在本 unit 仍为
真实 typed 拒绝（前两者为 `UNSUPPORTED_OPERATION`，`permission.reply` 因控制 daemon
未绑定 Session owner 而拒绝，冻结词汇之外的 payload 由 parser 以 400 拒绝），因此
discovery→connect 与 master/peer apply 不能完成。history `kind=request` 的拒绝按观测到的
真实边界记录：D06 拥有的 history 路由只对 owner absence 保留 503 类型码，非 absence
owner 失败落为无 code 的裸 502，所以黑盒断言该裸 502 与 `code` 缺失，并明确 UI 的
typed-code 渲染只是单元级证据，不由黑盒证明。
声明真实输入：`.appsdk/project.json` 的 `teams-source` owned/regression 路径现在含
`acp-adapter/**`、`cli/**` 与 `dsh-adapter/**`（此前 `teams-source` 未准入 `cli/**`，
也未准入 `dsh-adapter/**`），`minimum_test_count` 未改动；`.appsdk` 生命周期状态不由本增量修改。
安装副本、restart、live 与浏览器证据由各交付在真实入口存在后收集。

## 历史重置溯源

以下内容只记录 reset 历史，不是当前执行指令；历史 receipts 保持原样。

基线 `origin/main@57c3dc422c0dd999e8abac13c54e351884bf7f68`，工作树
`playground/appsdk-reset-20260906`。原控制数据先归档到
`/tmp/agentteams-governance-before-reset-20260906.tgz`，SHA256
`5e138ffd55f2be942a1f0c21ecf97a19277e7ccd7825b4e761b73884c21d3d30`。

官方 reset 命令遇到历史 reset record 返回 already applied，没有实际重置。
按本次明确授权，将旧 `.appsdk` 整体移到
`/tmp/agentteams-appsdk-rebuild-20260906/old-control-after-resource-refresh`，
再执行官方 `appsdk init`。不改历史 record/hashes 冒充 reset 成功。
移除旧 preparation 和错误生命周期 producer；旧记录仍在归档中。
归档位于本机临时目录，不能当长期发布档案。

reset 当时保留了旧设计工作树并转入已确认的架构修订；当时尚未 commit、push 或
merge，AppSDK 0.1.6 也未提供 `verify-git-main-protection` 操作。这些是迁移时的
历史事实，不说明当前 Git、worktree、工具版本或 hook 状态。当前状态从实际工具
与任务节点笔记读取，工作树边界由当前开发合同执行。
