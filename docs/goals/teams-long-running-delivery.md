# AgentTeams 长程开发与交付任务

授权：用户要求主任务主导完成整个 AgentTeams，监督/分配子任务，负责进度、冲突、
协作、提交合并、工作树关闭和资源清理；每阶段执行记忆管理、二级审核并更新 AppSDK memory。
主任务：`01a07497-8e08-7e90-be56-c9f69d72bb26`。本文件定义执行责任和收尾条件，
阶段依赖参考 [开发计划](teams-development-plan.md)；当前 MVP 收口的唯一验收入口是本文件
的 MVP profile。不另建重复任务图。

## 当前收口 profile：MVP relay-first

当前长期目标只执行这一份最小 MVP 收口 profile，不创建第二个 goal 或第二个
subscription。该 profile 保留 AgentTeams 的控制面和扩展边界，但把首个可用版本收敛
为一条能在公网和 NAT 环境工作的 relay-first Agent-to-Agent 纵向闭环。Direct、完整
Endpoint E1/E2、复杂关系治理、完整 Console/UI 和真实移动端扩展保留在同一目标的
post-MVP backlog，不得混入本轮 live acceptance；受影响源码仍必须通过既有 mapped
regression gates。

MVP 的传输选择是显式 relay：daemon 从配置登录公网 Relay，发布 capability/resource，
consumer 从目录发现 provider，建立 Agent-to-Agent Work，并在 Console 完全退出时继续
执行。这样同时覆盖公网入口与 NAT 出站路径；direct listener 和 route contract 可以
继续保留并通过单元测试维护，但 direct 实际回放不属于本轮 MVP 的必要条件。

### MVP 完成条件

以下条件全部满足才允许关闭本轮 profile；任何单项缺失都保留为 open 或
cleanup-pending：

1. **真实 Relay/daemon 主链**：同一集成候选在 Claw Relay 和第二环境启动两个 daemon；
   至少一端处于真实 NAT 出站网络。两端完成登录、身份/代际建立、目录查询、能力与
   resource 广播、匹配、Work proposal/request/close 和重新登录。不能用 mock、loopback、
   HTTP health、Tailscale-only 或历史日志替代。
2. **最小被动能力**：至少一个 passive capability Agent 声明能力和容量，并通过固定
   CLI operation 完成一次真实请求。MVP 采用固定目录 `file-search` 作为确定性验收能力；
   browser capability/adapter 必须保持可编译和受测试，真实多 profile 浏览器回放列入
   post-MVP。
3. **资源与幂等**：provider 的容量分配不能超卖；重复 request 不重复执行；成功、取消
   或确认销毁后释放 allocation；provider 重启后旧 generation 明确拒绝，新 generation
   重新发现并完成 Work。至少保留一对多容量的 focused regression，真实回放至少覆盖
   两次独立 Work。
4. **Provider 配置最小闭环**：Teams 自己保存多个 provider instance、模型目录、accepted
   revision 和 effective revision。RCC `127.0.0.1:4444` 是主 provider，canonical instance
   `goaichat-openai`（来自 `goaichat_openai` 配置）是显式 backup provider；两者都通过真实 OpenCode 入口完成 catalog/apply/readback 和
   重启读回。不得加入隐式 failover，凭据不得进入业务 payload、metadata 或声明。
5. **Console 退出不影响 Work**：Console 只观察和配置，不进入 Agent-to-Agent 数据路径。
   所有 Console 进程关闭后 Work 仍完成；重新打开一个 Console 能读回 accepted/effective
   config、Work 状态和 allocation 结果。UI 视觉增强、关系图和移动布局不属于本轮门禁。
6. **工程交付闭环**：每个 delivery unit 具备 issue、独立 worktree/branch、candidate
   测试、独立 exact review、integration SHA、mainline 验证、远端 push receipt、memory
   Level 2（`ai-reviewed`,`human-unreviewed`）和 cleanup receipt。目标关闭前根树干净，
   自有工作树、进程、监听、临时目录和 branch 均已安全回收。

### 明确的 post-MVP backlog

- direct route 的真实公网回放、STUN/ICE、NAT-to-NAT direct 和 direct/relay 自动候选编排；
- Endpoint E1/E2 完整注册、发现、AppSDK admission 和 Work 绑定；
- master/slave 与关系治理、撤销、离线关系投影；
- browser 多 profile、真实桌面/手机蜂窝回放和更完整 CLI 能力；
- Console 完整 UI 可访问性、移动布局和关系/Work 深度投影；
- provider 自动 failover、复杂模型策略、组织/计费和生产平台能力。

## 范围与完成定义

推进上述 MVP profile 所需的公共契约、relay、daemon/network、provider/OpenCode、
Agent Work/资源、最小 passive CLI 和 Console 离线读回。原有 direct、Endpoint、关系、
移动端和完整 UI 的 live acceptance 保留为 post-MVP backlog；它们不能被 MVP receipt
伪装成已完成，但适用的 source regression gate 仍然执行。
MVP 完成必须同时具备：

- 已确认 MVP 功能逐项通过当前候选的适用测试、构建、部署/重启和真实入口验收；公网
  Relay 与真实 NAT 出站路径留证，Console 全离线后 Agent Work 继续。
- 主任务审核、用户选择的独立 Codex exact review（本目标不使用 AGY Review）、集成候选验证通过，已授权提交与合并具有远端
  主线 receipt。
- 每阶段的有效结论经过 memory Level 2 审核并由官方 memory CLI 更新/verify。
- 本任务及子任务拥有的工作树、临时服务/端口、锁和协作claim已逐项安全收尾；保留对象
  必须有明确用途和后续责任，不能把仍有保留义务的资源写成已清理。
- 当前进度、未完成与残留资源有准确交接。全部满足后才将长期目标标为完成并停止监督。

范围按既有首版计划收敛，不自动扩展为任意未来插件或生产平台。真实设备、网络、凭据
不足时先完成不依赖它们的工作，再提出具体所需环境；不能用mock、health或历史回放补票。

## 主任务与三个长期辅助session

| owner | session | 独占实施范围 |
|---|---|---|
| 主任务 | `01a07497-8e08-7e90-be56-c9f69d72bb26` | 公共协议、N2、Agent Host装配、公共maps/产物绑定、集成与最终审核 |
| N1 Luna/max | `01a074db-feaf-7010-9f58-cd56208afc06` | `server/**`；本轮临时独占根package/lock的ws依赖变更 |
| C1 Luna/max | `01a074db-feaf-7010-9f58-cd4763fc3837` | `config/**`、`opencode-adapter/**` |
| W1 Luna/max | `01a074db-feaf-7010-9f58-cd8e8e3ef7cf` | `agent/**` |

这些已有辅助 session 只按当前 MVP delivery unit 复用，不创建新的 goal/subscription；B1/U1/R1
等后续波次不属于本轮收口。
主任务使用紧凑状态查询和结果通知检查进度，优先解决首次阻断，不反复让辅助任务全仓探索。
分屏查看使用已有独立任务入口；创建/显示界面与实际执行状态分别核实。

并发写入必须有路径归属。公共接口变更先由主任务决定并统一通知；冲突交由主任务协调，
禁止双方各加fallback或兼容层。不能覆盖其他worker修改。无tmux/Collab时明确pending，
只允许已经隔离的独立写入；不得伪造登记/claim，依赖共享锁的操作等待可靠协调。

## 每阶段闭环

1. 查当前主线、阶段依赖、已有L2记忆和实际子任务状态；绑定owner、路径、工作树、验收。
2. 从最新origin/main建立clean工作树。实现前读受影响maps；红测→最小实现→定向验证。
3. 补齐适用回归、typecheck/build和真实入口。服务验证前声明实际部署操作。
4. 主任务审查候选、证据真伪和消融；用户选择的独立 Codex exact review 通过后，执行精确集成候选验证；本目标不使用 AGY Review。
5. 候选稳定后，主任务从worker run notes提取最小阶段记忆，去重并写为L3；主任务复核
   实际测试及来源证据后通过官方promote升为L2，标记AI已复核、尚未经人类复核并verify。
   无需另一个agent审核；代码review不自动等于memory事实复核。
6. 提交、推送、PR合并并确认远端receipt；新增/修订集成状态记忆另经L2审核，不预写成功。
7. 归档必要证据，确认没有唯一未合并改动/未跟踪工作，停本任务服务、释放claim和工作树。
   有依赖时先保留并记录，实际移除后才记closed；完成清理记忆后阶段才closed。

代码/依赖/配置/产物/环境相同可复用有效证据；改变后只重跑受影响门禁。每个 delivery unit
按阶段记录 `pending/running/passed/reused/invalidated/blocked`，并用基线、候选
commit/tree、changed paths、lockfile/工具、maps/契约、配置/环境/入口和产物组成
evidence fingerprint。恢复时先重算指纹：完全相同且原始 receipt 仍有效，写
`reuse receipt` 并跳过该 gate；任何字段漂移只使依赖该字段的 gate 失效，其他阶段
保持原状态。跳过没有 receipt、指纹不完整或环境有效性未经复核时，一律按未执行处理。
阶段收尾记忆可作为独立小提交，不为增加一条已核实的 receipt 重复整个产品运行回放。

阶段性门禁采用最小验证集：源码/测试变更重跑受影响 focused/regression、typecheck、
build 和 exact review；依赖、maps、契约或治理规则变更才扩大到 AppSDK compile/verify
或 `pnpm verify`；网络、凭据、设备、安装或服务漂移只重跑对应 live/install/restart
入口。未受影响且 fingerprint 未变的 gate 通过 `reuse receipt` 保留，不能因为恢复
任务、切换阶段名称或重新打开 Console 就全量重跑。

## 每阶段 AppSDK memory / Level 2

项目 `memory/{plan,path,knowledge,lesson}.jsonl` 是记忆事件真源，Markdown/index/SQLite
由官方CLI生成。统一由主任务汇总写入；worker只写自己run notes并提交候选，避免并发
写同一个memory库。本项目每阶段的memory流程由用户明确选为收尾要求，替代默认可选策略。

使用 `project-memory`（AppSDK memory独立入口）或当前官方 `appsdk memory`，不手改
事件/级别/哈希。每条归入一个category并附任务、基线/候选、证据引用、适用边界与剩余问题。
至少记录本阶段验证结果/收尾；新增可复用经验才另建lesson，不为数量制造重复记忆。

执行顺序：query去重→entry或review --run写L3→主任务审核记忆内容与所引事实证据→
promote --id <id> --level 2 --evidence <真实审核引用>→verify/get核实级别与内容。
使用 `ai-reviewed`、`human-unreviewed` 标签明确审核主体；只有实际人类复核后才声明该状态。
已执行并有证据的测试可以由主任务复核后晋升，不等待另一个agent或人类审批。
先有审核证据才升级。若发现来源失效、混淆测试/部署/合并/清理，修正后重审。
阶段失败/未知同样可以形成经核实的L2结论；不得通过promote把未完成改成已完成。
全局Codex memory不自动写入；本授权的目标是当前项目AppSDK memory。

## 提交与资源管理

主任务管理候选提交和PR合并队列；辅助任务先交付已验证候选，收到明确安排后才commit。
合并不使用保护绕过或强推。主线保持代码开发只读，允许已授权集成同步和验证。
不自动清理其他项目、其他任务、含唯一工作或仍被引用的目录。临时证据在删除前转存到
任务可保留的证据目录，不能仅留下/tmp路径后宣布清理完成。服务停止仅按明确PID/服务名。
Collab记录只能由记录owner更新，主任务通知原owner关闭，不冒充其身份。

当前工作树库存需逐个核实：治理/设计/P0、主开发、三条Luna实施，以及应用自动创建的
三个旧阅读工作树。已合并不等于可删：先检查未跟踪证据、unique commits、session绑定
和活跃进程。当前设计工作树的未提交差异需证明已被基准完整收录后再决定归档/关闭。

## 持续监督与中断恢复

以本任务的长期goal为执行目标；线程heartbeat用于恢复检查和监督，不另起第二个主开发者。
每次恢复先查goal、最新阶段/记忆、子任务状态、Git和资源实际状态，再执行下一可做动作。
无变化不重复发状态。里程碑完成、实质失败、需要用户输入或全部完成时通知用户。
停止/暂停用户指令立即生效；自动运行不扩大已授权的生产、凭据或设备操作范围。
