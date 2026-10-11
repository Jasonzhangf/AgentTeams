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
CLI 实际入口）；配置指向注册服务器时还依赖 D04。D02 之后 opencode 路径已接线并有真实
CLI 黑盒证据，DSH 路径仍未接线：`--serve dsh` 以 typed 拒绝退出，不新增只编译不启动的
伪入口。

| gate | owner | 状态 | 入口 | 覆盖 |
| --- | --- | --- | --- | --- |
| `teams-acp-daemon-intent` | config | partial | `pnpm exec vitest run --config vitest.config.ts config/daemon-intent.spec.ts config/acp-policy.spec.ts && pnpm exec tsc --noEmit && pnpm build:runtime` | 单 daemon 编译、CLI 覆盖与生效读回、v3 与多 daemon 拒绝；不含 runtime 启动 |
| `teams-acp-public-contract` | control-protocol | partial | `pnpm exec vitest run --config vitest.config.ts control-protocol/acp.spec.ts control-protocol/teams-connection.spec.ts control-protocol/teams-state.spec.ts` | ACP frame/fault、engine adapter port、Teams 协商 frame 与连接状态 DTO 的形状与拒绝 |
| `teams-acp-d01-host` | agent-host | partial | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts` | D01 已合并候选 75a6cf4 的引擎无关 stdio ACP 传输、host 的 Session/policy/history 语义与 runtime 子进程接线（标注 test peer，53/53 通过）；本命令本身无真实引擎推理、无安装/live 证据 |
| `teams-acp-d02-opencode` | opencode-adapter | partial | `pnpm exec vitest run opencode-adapter --no-file-parallelism` | 已合并候选 1d4df3a 的 OpenCode adapter：compileLaunch 唯一编译 launch spec、verifyEffective 只报引擎 session/new 返回的模型、真实 prompt/cancel/permission/黑名单（本地 stub provider + 已安装 opencode，65/65）；非安装副本证据，不含 D03 |
| `teams-acp-serve-entry` | runtime | partial | `pnpm exec vitest run runtime/acp-serve.spec.ts cli/agentteams.spec.ts --no-file-parallelism` | 用户入口真实启动：单 daemon + 单引擎子进程、绑定缺失/控制 daemon/非回环/`--serve dsh` 的 typed 拒绝、readiness 只取引擎 session/new、显式信号停止并返回真实 EngineStopResult；真实 CLI 黑盒见 `docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs`（源码树与本地 `npm pack` + `npm install` 的 `node_modules/.bin/agentteams` 两条路径均通过）；仅 loopback 与 opencode，无 D04/D05 |

D02 交付 OpenCode 引擎 adapter（`opencode-adapter/src/acp-engine.ts`）与 `--serve`
用户入口（`runtime/acp-serve.ts` + `cli/agentteams.mjs` 的 flag/dispatch）。
`teams-acp-d02-opencode` 在合并候选 `1d4df3a` 上可执行并通过（65/65，含 4 个真实引擎
用例）；`teams-acp-serve-entry` 在本候选上可执行并通过（runtime spec 11/11、CLI spec
28/28，另有真实 CLI 进程黑盒；同一黑盒在本地 `npm pack` + `npm install` 的安装副本
`node_modules/.bin/agentteams` 上重跑也通过），但它仍是 partial：只交付 opencode
（`--serve dsh` 显式拒绝）、监听仅 loopback、无注册就绪与连接协商；该安装副本是本地
基础包安装，不是发布产物或 AppSDK 生命周期回执。adapter 的库级语义未被本增量修改；
`runtime/agent-process.ts` 仍是旧 Work 入口，未被 `--serve` 替换。

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

planned/design gate 不标 implemented/passed，也不因声明测试通过而升级。AppSDK 绑定只
声明真实输入：`.appsdk/project.json` 的 `teams-source` owned/regression 路径现在含
`acp-adapter/**` 与 `cli/**`（此前 `teams-source` 未准入 `cli/**`），
`minimum_test_count` 未改动；`.appsdk` 生命周期状态不由本增量修改。
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
