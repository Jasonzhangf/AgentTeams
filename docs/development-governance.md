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
4. 根目录安装 `pnpm install --frozen-lockfile`；先执行当前阶段需要的定向验证，再按
   重入规则决定是否需要全量 `pnpm verify`。
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

旧设计工作树保留；其已确认的架构修订转入当前工作树。主线未修改，未 commit、
push 或 merge。当前安装的 AppSDK 0.1.6 没有可用的 `verify-git-main-protection`
操作；本轮不声称已安装或验证 Git hooks，工作树边界由上述开发合同执行。
