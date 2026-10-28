# AgentTeams 开发管控

本次按用户“reset appsdk，从头开始建立 appsdk 开发管控”重建。目标是当前独立
仓库的可执行质量基线，保留已经确认的产品架构。不是运行时发布或旧证据续期。

## 唯一归属

- 产品约束：根 `AGENTS.md`；需求/下一步：`docs/goals/`；协议与配置：`docs/design/`。
- 项目开发步骤：[agentteams-development](../.agents/skills/agentteams-development/SKILL.md)。
  本文拥有命令、gate 适用性与证据复用，不再复制一套开发流程。
- 产品 resource/function/mainline/module/verification：`docs/architecture/` 五个 map。
- SDK 实现契约：官方初始化的 `.appsdk/contracts/`、`.appsdk/maps/`、SDK resources/lock。
- 本项目交付单元：`.appsdk/project.json` 的 `teams-source`，绑定现有源码与真实库产物。
  这是统一构建/准入边界，不替代 network、server、config 等语义 owner。
- 根 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` 是依赖与命令入口。
  源码、构建输出和安装副本分别报告；日常交付不新增哈希清单或候选身份包装。

## 每个开发里程碑

按项目本地 Skill 的“开发与验收”推进。复杂任务的独立规划、worker 与 reviewer 路由
沿当前宿主编排 Skill；这里不另定模型或复制角色规则。纯文档/Skill 修改只做定向检查，
不为落盘文档启动服务、安装产品或增加独立审批。

`pnpm verify` 顺序执行全量测试、类型检查、Guidance compile、AppSDK compile、编译
产物 HTTP smoke、AppSDK verify；任何命令失败即停止该检查链。它用于适用首次/最终基线、依赖/契约漂移或
无法证明证据仍有效时的全量门禁，不是每次恢复或每个阶段都必须重复执行的固定步骤。
`pnpm test` 先构建被依赖的 OpenCode adapter，再运行现有全部测试文件。SDK
project contract 声明的 `minimum_test_count` 继续强制（当前项目声明为 304），
并拒绝 skip、TODO 和 `.only`。该计数门禁的语义变更属于 SDK upstream owner，
本项目不删除、降低或绕过。报告落在 `generated/validation/`。

## 阶段证据与复用

每个 delivery unit 在现有任务 run notes 中维护阶段状态：
`pending → running → passed | blocked`；输入漂移时标记 `invalidated`，有效复用可记为
`reused`。阶段记录只需保存实际消费的输入、命令/入口和原始回执。
依据受影响文件、配置版本和实际运行条件判断证据是否仍适用；不为记笔记、恢复、
派单或 review 主动计算指纹、冻结快照或重复验证候选身份。普通 Git 输出的提交标识可引用。

恢复或进入下游前先读现有任务笔记和原始 receipt。相关输入未变时，笔记可以直接
引用原始 receipt 并说明复用 gate；不需要另建第二套 reuse 记录。main、remote、
runtime、device 或 environment 等可变状态在依赖它的动作边界刷新。

未受影响的 gate 保留 `passed/reused`。变更只重跑受影响的最小定向命令；只有跨模块
契约、依赖、map、构建入口、产物或全量回归约束变化时才执行 `pnpm verify`。已验证
candidate 与 integrated main 的相关输入等价时，复用已有有效 tests、build、admission
和 review；复用不绕过缺失、失效或冲突证据。阶段失败只阻断依赖它的后续阶段。
由 lifecycle adapter 生成的后续 evidence 仍按其契约标记
`execution.mode=executed|reused` 并引用原始 receipt。

测试绑定具体失败模式，按风险补齐；不为增加测试数量制造重复断言，也不降低必要验收。

## 最小交互与交接

每个交互阶段只保留会改变用户决定、执行动作或恢复路径的反馈。产品的具体展示由
对应交互设计拥有；协议回执不逐条转成用户通知。成功直接展示结果，失败说明影响和
下一动作，未知保留原操作责任。ACK、心跳、查询成功不等于业务完成。

协作交接在现有任务中记录问题、owner、结果/证据和下一责任人；有实际 action 才请求
处理或答复。结果回复不附加“请确认收到”，不因 ACK、提醒或状态未变自动再发一轮。
需要追问时明确新问题和原因。问题已解决后由发起者按原 issue 关闭，不另建完成议题。

已有任务、run notes 和原始回执足以交接时，不另建平行进度表、身份清单或重复报告。
权限、安全、真实入口验收、失败原错与资源责任仍须保留。交付不能用简短措辞掩盖缺项。

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
AppSDK 发布准入保留其适用的真实证据门禁，不生成假候选、假 review record 或假部署
receipt。普通 compile/verify 与发布准入是不同证据；不把发布包装扩成日常前置。

首次/最终完整源码基线、发布准入或受影响生命周期需要正式记录时，在候选提交后
运行 `pnpm lifecycle:admission`。文档和测试整理按上述阶段适用性验证；提交动作本身
不触发整套测试和安装重启。当前 `scripts/lifecycle-adapter.mjs` 仍包含候选/指纹包装，
这是实现现状，不是本轮新增的流程要求；其消融由 bug `28f8373` 的生命周期 owner 处理。
不得手改 SDK 记录或伪造通过来绕开契约。有效原始回执应直接复用；缺失或失效时只执行
受影响的验证与实际入口。完整输出沿现有 `.appsdk-control/lifecycle-adapter/` 留存，
记录按 SDK 契约生成。这些本地记录不代表公网/NAT、managed OpenCode、跨设备或发布验收。

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
`packages/shared/src/{acp,engine,teams-connection,teams-state}.ts`。这些文件的声明与
拒绝测试是可执行的定向 gate；它们不证明真实引擎、stdio ACP、网络、注册或 UI 已可用。
`--serve` 的 runtime 启动依赖 D01（stdio ACP adapter）和 D02/D03（引擎 adapter 与
CLI 实际入口）；配置指向注册服务器时还依赖 D04。opencode 与 DSH 两条路径都已接线：同一
`runtime/acp-serve.ts` 的 `engineAdapterFor` 按配置的 engine kind 选择 D02 OpenCode adapter
或 D03 DSH adapter，复用同一 daemon/host/stdio/readiness/stop 代码，不新增只编译不启动的
伪入口。D02 有真实 CLI 黑盒证据，D03 有真实安装 DSH 0.2.0-rc.2 的 `--serve dsh` 黑盒证据。

| gate | owner | 状态 | 入口 | 覆盖 |
| --- | --- | --- | --- | --- |
| `teams-acp-daemon-intent` | config | partial | `pnpm exec vitest run --config vitest.config.ts config/daemon-intent.spec.ts config/acp-policy.spec.ts && pnpm exec tsc --noEmit && pnpm build:runtime` | 单 daemon 编译、CLI 覆盖与生效读回、v3 与多 daemon 拒绝；不含 runtime 启动 |
| `teams-acp-public-contract` | packages/shared | partial | `pnpm exec vitest run --config vitest.config.ts packages/shared/src/acp.spec.ts packages/shared/src/teams-connection.spec.ts packages/shared/src/teams-state.spec.ts` | ACP frame/fault、engine adapter port、Teams 协商 frame 与连接状态 DTO 的形状与拒绝 |
| `teams-acp-d01-host` | agent-host | partial | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts` | D01 已合并候选 75a6cf4 的引擎无关 stdio ACP 传输、host 的 Session/policy/history 语义与 runtime 子进程接线（标注 test peer，53/53 通过）；本命令本身无真实引擎推理、无安装/live 证据（真实引擎证据属于 `teams-acp-d02-opencode` 与 `teams-acp-d03-dsh`） |
| `teams-acp-d02-opencode` | opencode-adapter | partial | `pnpm exec vitest run opencode-adapter --no-file-parallelism` | 已合并候选 1d4df3a（修复 1af8fe5/9436aae）的 OpenCode adapter：compileLaunch 唯一编译 launch spec、verifyEffective 只报引擎 session/new 返回的模型、真实 prompt/cancel/permission/黑名单（本地 stub provider + 已安装 opencode，65/65）；非安装副本证据，不含 D03 |
| `teams-acp-d03-dsh` | dsh-adapter | partial | `pnpm exec vitest run dsh-adapter runtime/acp-serve.spec.ts --no-file-parallelism` | D03 冻结候选 60bf76b 的 DSH adapter：launch 编译、policy-before-side-effect、native config 派生与 effectiveness 读回，加上本候选的 `--serve dsh` 接线（`engineAdapterFor` 分发、`DSH_HOME` 隔离、stop/失败路径清理 engine home、adapter 自持 `enforceablePolicies` 且入口不替换为 `declaredMethods`）；dsh-adapter 31/31 通过；两个本地非 CI driver 覆盖真实 dsh 0.2.0-rc.2：adapter driver 18/18，`--serve dsh` 黑盒（真实 prompt/cancel/显式 PID stop）PASS；仍无安装副本证据、AppSDK 仍阻塞 |
| `teams-acp-d04-registry` | runtime | partial | `pnpm exec vitest run --no-file-parallelism server/relay.spec.ts network/relay-client.spec.ts network/registration-client.spec.ts server/registry-intent.spec.ts runtime/registry-process.spec.ts runtime/registry-registration.spec.ts` | D04 已合并候选 953d952 的 registry daemon 生命周期、TLS-only intent 映射、presence 租约与客户端注册/心跳/重连（已按当前候选复验 75/75 通过；候选黑盒 14/14 经 review 独立复现）；registry start 对同一 config 的旧 live 代次按显式 PID SIGTERM→SIGKILL 收敛，STALE_OWNER/STALE_GENERATION/STOP_TIMEOUT 保持 typed；无安装副本/live `--serve` 证据、AppSDK 仍阻塞 |
| `teams-acp-d05-network` | network | partial | `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts network/teams-egress.spec.ts runtime/serve-egress.spec.ts packages/shared/src/teams-connection.spec.ts` | D05 连接层与入口组合：冻结 frame 上的协商执行（唯一 agreement 来源、typed 拒绝、R3 整数 acceptedRevision）、认证 ACP session（本地分配 ref、收包边界重写 generation/engineInstanceId、payload 原样透传）、ingress/status 端口、kind=connection 历史、membership 视图与 R4 增量发布面（103/103 通过，含 network/teams-egress 8 与 runtime/serve-egress 5）；D00 amendment A3 让响应方在 context 帧发布自身实时 engineInstanceId，发起方据此命名 `acp.open` 的必需 ref，接收方原有的 STALE_GENERATION 拒绝不变；A3 现已被消费：发起方 session 的 `open()` 开出通道、命名目标 engineInstanceId、采纳 ack ref 作为 peer ref，host 面 ref 保留本侧 generation/engineInstanceId，任何失败路径（含 ack 前传输断开）都释放本地 host 通道，并与真实响应方 session 完成双侧握手；L9 交付生产发起方组合器 network/teams-egress.ts：复用 createTeamsFrameTransport、TeamsConnectionLedger、runTeamsNegotiation 与 createTeamsSession.open()，在真实 openTeamsIngress 响应方、真实双侧 session 与真实 AcpHost 上验证（host 面只见到本侧 localRef，线上 acp.open 命名目标 engineInstanceId，永不发送 acp.open_ack）；仍无 installed-copy/restart/deployed/cross-device 证据，且 runtime/acp-serve.ts 现组合 runtime/serve-egress.ts（L9 command-side）：入口在 listener 与 registration 就绪后按已接受 intent 声明的 peer 自行拨出，未知 peer、无显式 endpoint/admissionRef/tlsTrustRef 与重复连接分别是 typed 拒绝，无法拨出的 peer 记录 typed 失败而不崩溃、不静默跳过，handle 暴露 live rows/failures，stop 先关 egress 再关 host；targetCapabilitiesRevision 来自既有 D04 目录读回，expectedTargetGeneration 用入口自身发布的 listener 常量（目录只携带 relay login generation，属不同值，故不逐 peer 猜测）；隔离传输观测脚本在真实 TLS 回环 direct-WSS listener 上跑通真实准入、hello 握手与 ACP 帧往返（23 项）；D05 closure driver 覆盖两真实引擎 LAN、registry outage 存活、降级报告与无 control 进程；L9 command-side 黑盒 docs/evidence/acp-l9-command-side-20261013/black-box-self-dial.mjs 以两个真实 `--serve opencode` daemon、真实 registry 与真实 TLS LAN listener 运行 exit 0，拨出方自身 durable history 记录与声明 peer 的协商 agreement，双侧记录同一 agreement 与已打开 ACP 通道，且 driver 从未向任一 daemon 开 socket；仍无 installed-copy/restart/deployed/cross-device 证据 |
| `teams-acp-serve-entry` | runtime | partial | `pnpm exec vitest run --no-file-parallelism runtime/acp-serve.spec.ts runtime/acp-serve-retained.spec.ts runtime/relations-intent-watch.spec.ts cli/agentteams.spec.ts` | 用户入口真实启动：单 daemon + 单引擎子进程、绑定缺失/控制 daemon/非回环无 discovery 的 typed 拒绝、`engineAdapterFor` 单点分发 opencode 与 dsh、readiness 只取引擎 session/new、显式信号停止并返回真实 EngineStopResult、stop 与失败路径清理自有 engine home、只接受 adapter 自己声明的 `enforceablePolicies`（缺失即 typed 失败，不回退 `declaredMethods`）；P0 单实例收敛：同一 dataDirectory 在启动期持有跨进程互斥锁（`agent-serve-state.lock`，owner PID + dead-owner 回收 + 60s 等待上限 + typed `ENGINE_UNAVAILABLE` 拒绝），锁覆盖整个启动（收敛旧 owner、建 engine home、起引擎、写状态、开 listener），所以第二个启动等锁后收敛持有者发布的状态，绝不从陈旧读创建第二个引擎；进程内旧 handle 在确认引擎退出前不删本进程 map 条，保留引擎 home 与 `agent-serve-state.json`；显式 PID SIGTERM→同 PID SIGKILL 收敛旧的 daemon 与残留 engine，超时 typed `ENGINE_UNAVAILABLE`/`STOP_TIMEOUT`；stop 与失败路径只在引擎确认退出后删 engine home 与状态记录；失败启动若 `EngineStopResult` 为 retained，则把该存活引擎以 `daemonPid=0` 写入一份 ownership 记录（不含 serving daemon），后续启动据此收敛该 PID 而非新建第二个引擎；真实替换黑盒 `docs/evidence/daemon-single-instance-p0/black-box-serve-replacement.mjs` 跑两个真实 `--serve opencode` 实例（不同 dataDirectory），替换 dataA 并验证旧 dataA daemon/engine 退出、替换服务真实 ACP、dataB 存活、显式 PID stop 清除状态/engine home/子进程；D04 注册与 D05 LAN negotiation 已接入该入口；`runtime/acp-serve.ts` 在 2026-10-14 intent-side 增量中新增 `createRelationsIntentWatch`：入口按已接受 intent 声明的 peer 自行拨出后，又以固定间隔读取控制 daemon 写的同一份 `config/relations-intent-store.ts` 记录并让 live egress 行与其一致（未声明的 agentId 拒绝拨出，缺失/损坏记录是 typed 缺席或 no-op，不崩溃；`stop()` 先停观察再关 egress）；两条真实 CLI 黑盒：opencode 见 `docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs`，dsh 见 `docs/evidence/acp-d03-serve-20261010/black-box-serve-dsh.mjs`；仍无 DSH installed-copy 回放、restart、deployed-entrypoint 与 cross-device 回执，且项目级「每配置单 daemon」仍与 David/user 待决议的项目级单 daemon 冲突分离（本 P0 只修 per-config 这一层） |
| `teams-acp-d06-control` | runtime | partial | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts config/relations-intent-store.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts packages/shared/src/console-api.spec.ts` | D06 控制守护进程：唯一控制进程生命周期（单 PID、单 WebUI listener、自有 state/data 目录、显式 PID 停止、control start 对同一 config 的旧 live 代次按显式 PID SIGTERM→SIGKILL 收敛、typed `STALE_GENERATION`/`STALE_OWNER`/`STOP_TIMEOUT`/`PORT_OCCUPIED`/`CREDENTIAL_UNAVAILABLE`/`INVALID_STATUS`）、CLI `control start\|status\|stop`、D00 amendment A2 增量线面（闭合 history 路由与真实 SSE 快照、新增闭合命令种类、permission options 与 reply `optionId`）、A2.7 真实 D05 网络状态端口绑定（`createTeamsStatusPort` 唯一注入点、真实 `connections` 投影、真实 `kind=connection` 持久历史与分页、未注入时 typed 缺席）、A2.6 引擎侧 permission option 投影与回复裁决（optionId 必须来自引擎真实集合，缺失/过期回调不自动批准）；两条真实黑盒：`docs/evidence/acp-d06-control-20261011/black-box-control.mjs`（PART 1，10/10）与 `docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs`（PART 2 真实端口绑定与真实历史行，7/7）。仍为 partial：无 installed-copy 回放、无 restart、无 deployed-entrypoint、无 cross-device 回执；本门禁自身无浏览器回放（源级浏览器证据在 `docs/evidence/acp-d08-browser-20261011/`，属不同证据层；2026-10-14 更正（L11）：installed-artifact 层已由 `docs/evidence/acp-l11-installed-browser-20261014/` 交付——从安装包执行 `control start` 并用真实 Chrome 驱动该安装副本 origin，18 checks、退出码 0；本门禁命令自身仍不驱动浏览器，restart、deployed-entrypoint 与 cross-device 仍未交付）；`GET /api/v1/history?kind=request` 由 D05 连接历史 owner 拒绝（非第二历史源），`kind=connection` 之外的请求分页未交付。本条增量原先作为独立 D09 单元承载（2026-10-11，base 8cb0238），现已折入 D06：无单独 D09 单元、无单独 D09 门禁、无单独 D09 证据目录。该增量补齐投影半边：`createControlNetworkStatus` 用 `RegistrationClient.directorySnapshot` 读真实 D04 目录、经唯一 `directoryAgentObservation` 映射为真实 Console agent 行，并经已声明的 `ControlProjectionSource` watch 流式输出；门禁 117→118（runtime/control-process 16→17）；2026-10-14 intent-side 增量：三条 A2.4 关系命令不再是 typed `UNSUPPORTED_OPERATION` 拒绝，改为经 `config/relations-intent-store.ts` 的一次 CAS 写入，结果只回 `acceptedRevision`、永不回连接状态；记录路径是两个 daemon 各自推导的同一条共享约定路径 `<home>/.agentteams/relations/<accountId>/<scopeId>/relations-intent.json`（写侧从自己 accepted 的 `peers` 取目标 account/scope，读侧取自己的 `daemon.accountId`/`daemon.scopeId`，因为冻结的 `PeerIntent` 不携带 peer 的 dataDirectory，且不新增配置键）；一条记录只有一道 CAS 栅栏，故 `network.membership.apply` 在写入前拒绝不属于该 account/scope 的成员，并原样透传调用方的 `expectedRevision`，而 `connection.connect`/`connection.disconnect` 以已接受记录的 revision 作为 CAS 基准；未声明的 agentId 以 `FORBIDDEN` 拒绝且不猜路径、不猜角色；本门禁命令现含 `config/relations-intent-store.spec.ts`，实测 135/135 通过（runtime/control-process 23、config/relations-intent-store 10、agent-host/acp-host 23、runtime/acp-serve 27、cli/agentteams 33、console-host/tests/http-api 7、packages/shared/src/console-api 12）；`permission.reply` 与 Session owner 仍未绑定，真实黑盒 `docs/evidence/acp-d06-part2-20261011/black-box-control-directory-projection.mjs`（9/9）。2026-10-14 更正（L9 session-write-side）：上句已不成立。`permission.reply`、`session.cancel` 与专用 Session body 入口现由本门禁 owner 绑定：`createControlOwner` 从自己 accepted 的 `peers` 解析目标 agent 身份、account 与 scope，经 `config/session-intent-store.ts` 做一次 CAS 写入 pending-Session-write 记录，结果仍只回 `acceptedRevision`、不回 Session 状态；`session.create`/`session.open` 仍为 typed `UNSUPPORTED_OPERATION`，因为二者必须返回真实引擎数据，单向记录无法承载响应。真实入口证据见 `docs/evidence/acp-l9-session-write-side-20261014/`（49 checks、退出码 0） |
| `teams-acp-l9-intent-side` | runtime | partial | `pnpm exec vitest run --no-file-parallelism config/relations-intent-store.spec.ts runtime/relations-intent-watch.spec.ts runtime/control-process.spec.ts runtime/acp-serve.spec.ts` | L9 intent-side：控制 daemon 是该 desired-relations 记录的唯一写者、agent daemon 是唯一读者，存储由 `config/relations-intent-store.ts` 承载，本门禁命令实测 68/68 通过（runtime/acp-serve 27、runtime/control-process 23、config/relations-intent-store 10、runtime/relations-intent-watch 8，2026-10-14 实测，退出码 0）。`connection.connect`/`connection.disconnect`/`network.membership.apply` 不再是 typed `UNSUPPORTED_OPERATION` 拒绝，而是经该存储做一次 CAS 写入，结果只回 `acceptedRevision`、永不回连接状态；`connection.connect` 复用 `runtime/serve-egress.ts` 的唯一角色推导，`network.membership.apply` 原样透传调用方 `expectedRevision` 并在写入前拒绝不属于同一 account/scope 的成员，未声明的 agentId 以 `FORBIDDEN` 拒绝且不猜关系、不猜路径。`runtime/acp-serve.ts` 的 `createRelationsIntentWatch` 以 500ms 具名 interval 轮询该记录并把差量应用到已建好的 `ServeEgressOwner`（新期望的已声明 peer 拨出、不再期望的 live row 断开），记录里未声明的 agentId 只记 typed `FORBIDDEN` 且绝不拨，记录缺失是 no-op，记录损坏是 typed 拒绝并保留 live rows，`stop()` 先 `clearInterval` 再关 egress。记录是每个 account+scope 一份期望成员集合，路径为 `<home>/.agentteams/relations/<accountId>/<scopeId>/relations-intent.json`：写侧从自己 accepted 的 `peers` 取目标 account/scope，读侧取自己的 `daemon.accountId`/`daemon.scopeId`（冻结的 `PeerIntent` 不携带 peer 的 dataDirectory，故按约定共享根推导，且不新增配置键）；记录里的期望 `role` 不覆盖本 daemon 已接受的 `relations.allowed`，角色仍由 `runtime/serve-egress.ts` 唯一推导，外来文件不得越权授予 master（副作用：该字段目前只被控制 daemon 记账）。真实黑盒 `docs/evidence/acp-l9-intent-side-20261014/black-box-intent-side.mjs`（53 checks / 17 receipts，退出码 0）：真实 registry + 真实 `control start` + 两个真实 `--serve opencode` daemon，真实 LAN/TLS 与真实准入；Console 命令走控制 daemon 真实的认证 `/api/v1/command`，driver 从不向任一 agent daemon 开 socket；`connection.disconnect` 后 observer 自己的 durable history 记 `channel.closed` 且不自愈重拨，再次 `connection.connect` 后它拨出新的 agreement connectionId 并开出属于新连接的 ACP channel。仍为 partial：无 installed-copy、restart、deployed-entrypoint、跨设备证据；`permission.reply` 与 Session owner 仍未交付；AppSDK 仍被既有 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014` 阻塞。2026-10-14 更正（L9 session-write-side）：`permission.reply`、`session.cancel` 与 Session body 写侧已交付，见 `teams-acp-l9-session-write-side`；仍未交付的是 Session/notification 投影（本门禁的 agent 侧读侧不受影响，其读路径、500ms 轮询与停止顺序均未变） |
| `teams-acp-d07-webui` | ui/teams-console | partial | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism ui/teams-console/tests/api.spec.ts ui/teams-console/tests/boundary.spec.ts ui/teams-console/tests/contract-compat.spec.ts ui/teams-console/tests/controller.spec.ts ui/teams-console/tests/drafts.spec.ts ui/teams-console/tests/focus-dom.spec.ts ui/teams-console/tests/live-client.spec.ts ui/teams-console/tests/locale.spec.ts ui/teams-console/tests/model.spec.ts ui/teams-console/tests/observation.spec.ts ui/teams-console/tests/page-networking.spec.ts ui/teams-console/tests/render.spec.ts ui/teams-console/tests/render-d07.spec.ts` | D07 WebUI：四个页面（发现、组网、交互、历史）只消费 owner 投影/历史/SSE 数据（UI 只声明 additive `TeamsConsoleClientV1` 扩展，不修改 `console-api.ts` DTO）；`render-d07.spec.ts` 在真实 Chrome DOM 中逐页验证冻结标记 `data-team-page`/`data-team-page-view`/`data-team-band`/`data-band-state`/`data-team-observation`/`data-team-cancel`/`data-permission-option`/`data-team-refused`/`data-team-error-code`/`data-team-draft`/`data-team-accepted`/`data-history-*`，并断言引擎未给 options 时不伪造任何权限按钮、owner 丢失时观察带进入 `stale`；`live-client.spec.ts` 覆盖 additive 历史分页、`kind=request` typed 拒绝与 SSE 快照订阅/取消；真实黑盒 `docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs`（15/15）走真实 `control start\|status\|stop` 与认证 HTTP，逐一走到 served `/ui/` 模块图的 D07 标记、`/api/v1/history` 页面与拒绝、`/api/v1/events` 的 `{seq, projection}` 快照、写入命令的 typed 边界（`permission.reply` 因控制 daemon 无 Session owner 而拒绝；`connection.connect`/`connection.disconnect`/`network.membership.apply` 在 2026-10-14 之前返回 `UNSUPPORTED_OPERATION`，本 driver 运行时的这一部分已被后续 intent-side 增量取代，其断言限于本 driver 自身的取证时点）、冻结词汇之外 payload 的 400 parser 拒绝、匿名访问的 `401 Basic` challenge；仍为 partial：无 installed-copy replay、无 restart、无 deployed-entrypoint replay、无 cross-device receipt、无通过 serve entry 的 live registry composition、无 mobile claim；headless Chrome 无法向同源 `fetch`/`EventSource` 提供 HTTP Basic 凭据这一早先结论是错的：CDP `Network.setExtraHTTPHeaders` 能在网络层注入凭据，真实 live-browser DOM 证据见 `docs/evidence/acp-d08-browser-20261011/`（14 checks / 1 gap），冻结 DOM 契约仍以真实 Chrome 渲染测试为准；A3 的发起方通道打开原语已在 network/teams-session.ts 的 `open()` 交付（103/103），生产发起方组合器 network/teams-egress.ts 与 runtime/serve-egress.ts 亦已交付，且 runtime/acp-serve.ts 在 listener 与 registration 就绪后经 runtime/serve-egress.ts 自行拨出已接受配置声明的每个 peer（真实黑盒见 docs/evidence/acp-l9-command-side-20261013/：两个真实 --serve daemon + 真实 registry + 真实 LAN listener，无 driver 代开的 socket），但 `permission.reply` 与 Session owner 仍未交付：Console 只能发起到控制 daemon，而控制 daemon 对二者分别以 typed `UNSUPPORTED_OPERATION` 与「无 Session owner 绑定」拒绝；在 2026-10-14 的 intent-side 增量之前 `connection.connect`/`connection.disconnect`/`network.membership.apply` 同样以 `UNSUPPORTED_OPERATION` 拒绝，该增量已把这三条改成经 `config/relations-intent-store.ts` 的真实 CAS 写入，Console 仍是发起方但不承载数据路径；`runtime/acp-serve.ts` 的 relations 观察侧使 agent daemon 自行按记录拨出与断开，因此 discovery→connect 与 master/peer apply 在源级可用，但尚无安装副本回放、restart、deployed-entrypoint 与跨设备证据 2026-10-14 installed-copy 更正：本门禁的 installed-copy 项已在 WebUI DOM 层关闭，证据为 docs/evidence/acp-l11-installed-browser-20261014/（18 checks / 0 gaps，退出码 0）。生产者用 `pnpm build:governance` 产出 final 包（mode=final、release_eligible=false、content_sha256=ea3145e6c5c1e484cc1308f0b07ba7222cdbeff5fd1826b5a3bea837327dfe1b、263 个文件），`npm pack` 后把 tarball 装到源码树之外的隔离 prefix，再由 INSTALLED CLI 启动 registry、真实 `--serve opencode` agent daemon（真实引擎子进程）与 control daemon；运行中的 daemon 由自身命令行与 control 自身 state 的 entryPath 证明来自安装副本，浏览器收到的 document 与全部 18 个 `/ui/` 模块与安装包内文件逐字节相同。随后真实 Chrome 以 CDP `Network.setExtraHTTPHeaders` 注入凭据并访问无 userinfo 的干净 origin：页面自身 fetch、自身 EventSource 快照（seq=1）、四个冻结视图与真实目录中的 agent 行 data-agent-id=reasoner-a 均被观测，并留下真实 PNG 截图。本次只关闭 installed-artifact 浏览器 DOM 这一层：restart、deployed-entrypoint replay、cross-device 回执与 mobile 仍未交付，且 `data-team-cancel`/`data-permission-option` 仍不渲染，因为控制 daemon 未绑定 Session owner，故本门禁保持 partial。2026-10-15 更正（L9 session-write-side）：`data-team-cancel`/`data-permission-option` 仍不渲染这一观察不变，但原因已不是「控制 daemon 未绑定 Session owner」——Session 写侧（`permission.reply`、`session.cancel` 与 Session body）现已交付。真正原因仍是 Session/notification **投影**未交付（控制 daemon 仍回 `sessions: []`/`notifications: []`，UI 因而没有 sessionEvents 可渲染），属 L10。同次更正：本门禁黑盒 `docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs` 原先断言 `permission.reply` 回 `UNSUPPORTED_OPERATION`，该期望已被本次交付取代；在该无 `peers` 配置下它现回 `FORBIDDEN`（与 `connection.connect`、`network.membership.apply` 同一条目标规则，且在写入前拒绝）。断言已更新并重跑通过：15 checks、exit 0。旧期望记为被取代，不计为通过。 |
| `teams-acp-l9-session-write-side` | runtime | partial | `pnpm exec vitest run --no-file-parallelism config/session-intent-store.spec.ts runtime/session-intent-watch.spec.ts runtime/control-process.spec.ts agent-host/acp-host.spec.ts` | L9 session-write-side：绑定 D00 amendment A4，交付冻结的 Session 写侧命令（`permission.reply`、`session.cancel` 与专用 Session body 入口）且不改协议。机制复用 2026-10-14 `connection.connect` 已记录的决策：agent daemon 自行反应，控制 daemon 只写 intent，不新增 control→agent 通道、Console 不作中继；被否决的两个候选也记录在案（进程内 `ControlOwnerBinding` 需要一条不存在的 control→agent 传输；直接 control→agent ACP 传输正是该决策禁止的新通道）。存储由 `config/session-intent-store.ts` 承载：每个目标 agent 一条记录，路径 `<home>/.agentteams/sessions/<accountId>/<scopeId>/<agentId>/session-intent.json`，写侧从自己 accepted 的 `peers` 取目标身份/account/scope，读侧取自己的 `daemon.id`/`daemon.accountId`/`daemon.scopeId`，不新增配置键；未声明的 agentId 以 `FORBIDDEN` 拒绝且不写记录、不猜路径。A4 与关系记录的必要差异：关系是期望状态可重复读取，Session 写是事件、重复施加不安全，故记录携带有序事件窗口（上限 256）与 `oldestRevision`，读侧把自己的 consumed watermark 存在自己的 data directory，一条记录只有一道 CAS 栅栏；读侧落在窗口之外时报告诚实的 `behind` 拒绝而不是跳过。施加映射即引擎自己的 ACP 帧：`permission.reply` 成为对引擎待决 `session/request_permission` 回调的 JSON-RPC 响应（Console `decision` 选中 projected kind 相同的引擎选项，引擎未提供的 decision 以 `INVALID_ACP_FRAME` 拒绝，绝不发明 optionId）；`session.cancel` 成为 `session/cancel` 通知；Session body 成为 `session/prompt` 且 body 原样透传。`runtime/acp-serve.ts` 的 `createSessionIntentWatch` 按 revision 顺序施加、遇到第一条无法施加即停止（保序且不静默跳过），并把拒绝记在 handle 的 `sessionIntent.failures()` 上；`agent-host/acp-host.ts` 新增两个只读面 `pendingPermissions()` 与 `channelForSession()`，因为该 host 是 A2.6 的 permission owner、也是唯一知道每个 Session 属于哪个 open channel 的地方，A2.6 因此未被削弱。真实黑盒 `docs/evidence/acp-l9-session-write-side-20261014/black-box-session-write.mjs`（49 checks、退出码 0）：一个真实 `control start` + 一个真实 `--serve opencode` agent daemon + 真实引擎 + 真实 permission 回调，driver 全程只经控制 daemon 的认证 HTTP 面提交写入、从不经自己的 ACP 连接回答回调；证据含 driver 发送的 prompt 完成、daemon 自身 durable history 记下它回复的正是引擎真实 dispatch 的回调且选中引擎真实 optionId、Console body 以 daemon 自己的 id 成为真实 `session/prompt` 且引擎收到原样文本、`session.cancel` 使 daemon 发出的 prompt 以 `cancelled` 结束、引擎从未等待的 permission 被拒绝（记录 revision 前进而 watermark 停住、该 prompt 保持 pending）。仍为 partial：控制 daemon 仍回 `sessions: []` 与 `notifications: []`，Session/notification 投影与 Console 可见的 permission 身份属 L10；`session.create`/`session.open` 仍为 typed `UNSUPPORTED_OPERATION`；本单元为 source-tree 证据，无 installed-copy、restart、deployed-entrypoint 与跨设备回执；AppSDK 仍被既有 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014` 阻塞。2026-10-15 修复：review 的 A1 论点指向一条真实缺陷——watermark 保存失败后下一轮会**再次**施加同一条 `session.message`，引擎因而收到第二次 `session/prompt`；现在 `createSessionIntentWatch` 用进程内高水位 `appliedThrough` 保证本进程内已施加的写绝不重复施加，watermark 改为保存部分进度，并把 store 故障的 code 从被抹平的 `ENGINE_UNAVAILABLE` 改回与读记录失败同一条 `configFault` 通道；红先证据为 `runtime/session-intent-watch.spec.ts` 的 `never re-applies a write it already applied when the watermark cannot be saved`（变异回旧行为即转红，实测引擎收到 2 次），修复后本门禁 71/71、D01 58/58、D05 103/103、serve-entry 68/68、D06+L9 并集 168/168、typecheck 与 build exit 0、真实黑盒 49 checks/PASS。崩溃窗口内仍是 at-least-once，不宣称 exactly-once |
| `teams-acp-d08-acceptance` | integration | partial | `node docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs` | D08 最终验收：用项目自身 producer 打最终包并隔离安装 tarball，全部 daemon 从 installed CLI 入口启动（两个 agent：opencode + dsh，一个 control，一个 registry），在真实 LAN 地址 `192.168.0.3` 上跑通 A01–A11。2026-10-12 07:56 PST 运行 45 checks / 3 gaps / 2 个非缺陷观察，exit 0，278s（graceful stop+start 复用 generation 1，无需求约束该行为；A11 回执经读取校验而非重放流量）。这些运行发现并修复四个真实缺陷：`44d82f7`（stop 现在关闭自身 listener 连接，live WebUI SSE 客户端不再把 daemon 拖过调用方的有界 stop 等待）、`146824a`（stop 现在保留 durable data directory，连接 history 因而跨 stop+start 存活，满足 D06 的「restart 观察和 history 恢复」）、`d8f5cd1`（A02 的 DSH prompt 对上游瞬时 503 做指数回退重试，不再因首次拒绝即终止，从而跑完 A03–A11）与 `d05f3a0`（第二类上游形态 `turn failed: Connection error` 归类为瞬时；仅在 engine 进程仍存活时重试无响应超时，engine 已死则立即失败）。保留三个未收口缺口且不从任何 PASS 推断，均属 A07：A07 真实事件驱动动画（仅目录半边已交付：投影携带真实 D04 目录行且真实注册推进 SSE `seq`，但无 Session/permission/notification 事件可推进，因为未绑定 owner）、A07 WebUI 定向交互（shipped control daemon 未绑定 Console/Session owner，D06 要求的 connect/disconnect、`network.membership.apply`（2026-10-14 更正：该写侧命令已由 L9 intent-side 交付，见 `teams-acp-l9-intent-side`；本条只对 Session owner 与定向 ACP ingress 仍然成立）、Session owner 与定向 ACP ingress 尚未交付，属未满足需求而非证据边界；D06 的目录投影增量——原作为独立 D09 单元承载，现已折入 D06——已交付 discovery query 与 membership 的**读侧投影**（经 `ControlProjectionSource` watch 输出真实目录行），故二者移出本缺口；但 `network.membership.apply` 这条写侧命令已在 2026-10-14 由 L9 intent-side 交付，本驱动对它的断言已更新但未重跑）、A07 live-browser DOM 与截图（本 driver 不驱动浏览器，故 installed-artifact 层无 DOM 或截图证据）；2026-10-14 更正（L11）：installed-artifact 层的 DOM 与截图证据已由 `docs/evidence/acp-l11-installed-browser-20261014/` 交付（18 checks、退出码 0），故此处“installed-artifact 层无 DOM 或截图证据”不再成立；本 driver 自身不驱动浏览器这一点不变，D06 写侧半边仍未交付。A07 live-browser DOM 的旧理由是「headless Chrome 无法提供 HTTP Basic 凭据」，该结论已被推翻：`docs/evidence/acp-d08-browser-20261011/` 用真实 Chrome + CDP 网络层凭据 + 干净 origin URL 驱动 shipped entry，得到真实认证 fetch、页面自身的 `/api/v1/events` 订阅与 `/api/v1/history` 读取、以及真实 PNG 截图（14 checks / 1 gap）；该证据发现并修复三个真实缺陷（origin 发 `event: projection` 而客户端订阅 `snapshot`、产品从不调用 `startObservation()`、history 视图无首次读取）。但源级浏览器运行不能关闭本门禁的 installed-artifact 层缺口，且该 driver 不驱动浏览器。A11 跨设备回执已收口：A11 单元（`869aff8`）已合入本候选，driver 现校验其回执（19 checks / 0 gaps，两个不同的非 loopback 主机 Macstudio.local 与 jennys-macbook-air.anoa-buri.ts.net），因此跨设备结论经已集成证据成立；该回执由读取校验而非重放流量得出，故记为 finding 而非 gap。事件驱动动画与 WebUI 定向交互仍需 Console/Session owner；缺口消除前总目标保持 INCOMPLETE。2026-10-14 更正（L9 session-write-side）：`connect`/`disconnect`、`network.membership.apply`、`permission.reply`、`session.cancel` 与 Console Session body 入口均已交付，故「Session owner 尚未交付」不再整体成立；仍然成立的是 Session/notification **投影**未交付（控制 daemon 仍回 `sessions: []` 与 `notifications: []`，Console 因而看不到自己写入的 Session，也无法从投影得知 permission 身份），该项属 L10；`session.create`/`session.open` 仍为 typed `UNSUPPORTED_OPERATION`。本行其余断言未变 |

2026-10-15 L12 门禁收口：上述 14 个 `teams-acp-*` 门禁在最新 `origin/main` 候选
`4d3ffe5` 上按各自身命令全量重跑，13 个通过（daemon-intent 35/2、public-contract 17/3、
d01-host 61/4、d02-opencode 65/4、d03-dsh 58/3、d04-registry 75/6、d05-network 103/11、
d06-control 143/7、d07-webui 66/13、serve-entry 68/3、l9-intent-side 72/4、
l9-session-write-side 81/4、l10-session-projection 86/6，均退出码 0），同一树 `pnpm build`
退出码 0、`pnpm exec tsc --noEmit` 退出码 0，日志在
`docs/evidence/acp-l12-gate-closure-20261015/gate-*.log`。d07-webui 的 66/13 是
**收窄后修正**：首次 L12 只跑了记录命令 13 个文件中的 6 个（29 用例），漏掉 7 个
快速非 DOM spec（controller、model、live-client、observation、page-networking、
drafts、locale），该 6/29 不是本门禁结果；已用完整记录命令重跑得 66/66，并把收窄
记入门禁 note 与 verification.json，不留作未披露的缩减。同表其余门禁计数与记录一致。
按「任何门禁在其未闭合项消除前
不得升级」这一不变量，14 个门禁**全部保留 `partial`**：一个通过的复跑只证明命令在新树上
仍绿，不消除该门禁自己声明的未闭合项（installed-copy / restart / deployed-entrypoint /
cross-device 回执、真实引擎推理、A07 事件驱动动画、L10 的 sessionEvents 与 permission 身份
等）。因此没有门禁状态被升级，也没有把别的单元的引用当作本门禁自己的证据。
`teams-acp-d08-acceptance` 的黑盒重跑在 A02 的 DSH prompt 处被远端 provider 网关拒绝
（HTTP 400 `model_unavailable`，`model_blocked: 13 account(s) cooling down this model;
earliest unblock at 2026-10-16T02:00:01+08:00`），A03–A11 未执行，退出码 1；同一 run 的
install 段与 A01 六项、A02 的 OpenCode 真实 prompt 均 PASS，证明被验链路本身可用，阻塞
是外部限流。其 2026-10-12 的 45 checks / 3 gaps / exit 0 结果仍作为本门禁自己的记录，
本次重跑既不抬高也不降低它，门禁保持 `partial`。
L12 还确立一条构建前置：从 `origin/main` 新开的工作树若缺少 `console-host/static` 与
`ui/teams-console` 的编译产物，任何 spawn 出的 control 子进程都会在写 state 前于
`presentationRoots()` 抛错，父进程因此一直读到 `starting` 并最终 `START_TIMEOUT`；
`pnpm build` 退出码 0 后同一条命令恢复 27/27。这是环境前置，不是缺陷，已记入
`docs/evidence/acp-l12-gate-closure-20261015/recon.md` 与 `teams-acp-d06-control` 门禁 note。
本目录 `pnpm verify` 仍被既有的 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014` 阻塞，未变化。

D02 交付 OpenCode 引擎 adapter（`opencode-adapter/src/acp-engine.ts`）与 `--serve`
用户入口（`runtime/acp-serve.ts` + `cli/agentteams.mjs` 的 flag/dispatch）。
`teams-acp-d02-opencode` 在合并候选 `1d4df3a` 上可执行并通过（65/65，含 4 个真实引擎
用例）；`teams-acp-serve-entry` 在本候选上可执行并通过（runtime/acp-serve.spec.ts 27/27、runtime/relations-intent-watch.spec.ts 8/8、
CLI spec 33/33，另有两条真实 CLI 进程黑盒：opencode 与真实安装 DSH 0.2.0-rc.2；opencode
黑盒在本地 `npm pack` + `npm install` 的安装副本 `node_modules/.bin/agentteams` 上重跑也
通过），但它仍是 partial：DSH 黑盒是本地 live 运行、没有安装副本回放，当时监听仅 loopback（2026-10-14 更正：D05 closure 之后 `runtime/acp-serve.ts` 会按 `classifyServeListener` 绑定已认证的 direct-WSS LAN 通道；本行其余 partial 理由不变），
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
`cli/agentteams.mjs` 新增 `control start|status|stop`，`packages/shared/src/console-api.ts` 与
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
（`runtime/**`、`agent-host/**`、`packages/shared/src/**`、`console-host/**`、`cli/**`、
`network/teams-status.ts` 的消费）已由 `teams-source` 的 owned/regression 路径覆盖，
`.appsdk/project.json` 无需改动，`minimum_test_count` 保持 304。

D07 交付 WebUI 的四页真实 owner 投影绑定：`ui/teams-console` 只读消费
`packages/shared/src/console-api.ts` 的 Console DTO、认证后的 `GET /api/v1/projection`、
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
2026-10-14 更正（L11）：installed-copy replay 已在 WebUI DOM 层关闭，证据为
`docs/evidence/acp-l11-installed-browser-20261014/`（18 checks、退出码 0）；restart、
deployed-entrypoint replay、cross-device receipt、通过 serve entry 的 live registry composition
与 mobile claim 仍未交付；
2026-10-14 更正（L11）：该段所述 D06 自身无 installed-copy 回放的边界已由 `docs/evidence/acp-l11-installed-browser-20261014/` 在 console-DOM 层关闭（从安装包执行 `control start`，真实 Chrome 驱动该安装副本 origin，18 checks、退出码 0）；本门禁命令自身仍不驱动浏览器。
2026-10-14 更正（L9 intent-side）：`connection.connect` 与 `network.membership.apply` 已不再是
`UNSUPPORTED_OPERATION` 拒绝——本 unit 的门禁命令不声明任何 `[peers]`，所以两者现在是目标不可解析的
typed `FORBIDDEN` 拒绝，驱动已按新期望更新并在本候选上重跑（15 checks、退出码 0）。
`permission.reply` 仍为真实 typed `UNSUPPORTED_OPERATION`（控制 daemon 未绑定 Session owner），
冻结词汇之外的 payload 仍由 parser 以 400 拒绝。因此本 unit 里 discovery→connect 与 master/peer apply
仍不能完成，但原因已从「无写侧」变成「该配置未声明可解析的目标」。history `kind=request` 的拒绝按观测到的
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
