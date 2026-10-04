# 本地 MVP 行为契约与 DAGpipe 宿主边界

状态：D1/D2 设计候选，尚未独立准入；不是产品实现或黑盒 PASS。
输入源码：20051913b8145d176d50afdae563adb6737d2779。
拓扑唯一真源仍为 `dagpipe/graphs/`；中文业务图与生命周期见 [行为模型](teams-behavior-model.md)，任务与黑盒见 [交付计划](../goals/teams-user-delivery-plan.md)。

## 对象、触发事件与状态守卫

事件由拥有状态的模块产生；调用方收到结果才推进自己的状态，不从日志、payload 或 journal 重建控制真相。一个事件可以触发下一次 graph execution，但不能回写上一执行的上游节点。

| 对象 / graph | 入口事件、生产者 → 消费者 | 守卫与关联 | 成功、失败、取消及责任终点 |
|---|---|---|---|
| 本轮进程组 / B1 | 用户启动：CLI → runtime launcher | 配置可编译；launcher reservation/owner 匹配；新 startToken、launcher generation、各 Agent generation | 两 daemon 登录及真实 enabled 服务可发现才 ready；启动失败由 launcher 调 B6 清理本轮 children/listener；启动期间停止为 cancelled，仍等待 teardown receipt |
| 一次 Work / B2（one-shot baseline） | 用户提交：CLI → launcher 本地控制 → receiver daemon；配置的启动任务是单独、显式入口 | `agent-work@2`；消费角色与 target/service/operation 已配置；本地控制归属和代次匹配；新 execution/attempt/work/request identity | 一次 Work/request 的 succeeded/failed/cancelled 由 provider 确认后，由本图 `settle-provider-work` close+dispose；unknown/running/cancel_requested 保留 provider 资源责任；网络关闭只释放连接 |
| 持久 Work open / B2p-open | 用户 `work open`：CLI → launcher 本地控制 → receiver daemon | `work-open@1`（DESIGN）；显式 capability selection，只匹配**已固定** provider 的 capability declaration，不选 Endpoint；caller 在 dispatch 前固定 provider/generation/capability/version 并显式携带，receiver 不后选 provider；binding 不完整即无副作用失败；initial operation 与完整 demands 显式 | propose 新 Work 后执行 initial request；`return-held-work` 只 dispose 连接，Work 与 Work-scoped allocation 保留；unknown/transport-unconfirmed 只报告已生成身份，未确认 `control` 仍含 dispatch 前固定的原 binding，可无重放 query/显式 close，不冒充成功或释放 |
| 持久 Work request / B2p-request | 用户 `work request`：CLI → launcher 本地控制 → receiver daemon | `work-request@1`（DESIGN）；保留原 workId 与 provider/generation/capability/version 绑定，新 requestId/execution/attempt；本次 operation/完整 demands 显式，无初始 demands 默认值；connect 只提供 initial open 意图，其单值 operation/demands 不限制后续 request；本次操作按原 provider capability declaration/policy/ledger 裁决；结构上无 propose/admit | `continue-provider-work` 在 provider ledger 已接纳 Work 上请求；provider 确认后只返回 request 结果并保留 Work；不 close，不自动 replay |
| 持久 Work close / B2p-close | 用户 `work close`：CLI → launcher 本地控制 → receiver daemon | `work-close@1`（DESIGN）；保留原 workId、provider/generation/capability/version 与 open 捕获的 operation；无 request/demands | `close-provider-work` 调 provider-authoritative close+dispose；只有 `confirmWorkDestroyed` 后 closed/释放；close failure 或 transport unconfirmed 保留责任 |
| 一次 Work 查询 / B8 | 用户查询或显式恢复观察：CLI/资源 owner → receiver → provider | 保留原 workId/requestId/target；新 query execution/attempt identity；显式 `serviceSelection` 区分 one-shot endpoint 基线与持久 Work capability 观察；capability 模式必须携原 provider/generation/capability/version/operation，禁止按当前 config/目录重选 provider；当前授权连接代次与原 Work generation 分开；禁止 propose/request 重放 | get 返回原 provider ledger 记录；确认终态、unknown 或明确 NOT_FOUND/FORBIDDEN/UNAVAILABLE 都显式；宿主释放查询连接，不把观察成功写成资源释放；后续显式 cleanup 是 B6 的新生命周期动作 |
| 一次配置应用 / B3 | 用户 TOML 修改或 Console 配置命令：用户/Console → config owner | 管理权限、expectedRevision 与源文件指纹/CAS；credential 引用可解析；accepted revision 是意图，effective 是运行确认 | durable accepted 后显式 apply/readback；冲突没有写入副作用；apply 失败保留 accepted/effective/error；重试是新 attempt；活动或 uncertain Session 禁止替换基座 |
| 一次 Console 观察 / B4 | 页面打开/刷新：浏览器 → Console HTTP → 目录和 Agent 公开管理接口 | Basic auth/origin；目录 scope；Agent managers policy；读取当前 generation | 返回真实 online/offline/error projection；拒绝和 unavailable 显式；页面关闭只收尾 Console 自己的连接，不取消 Work/Session |
| 一次 Session / B5 | 用户发送消息：Console 独立业务入口 → Agent → adapter | Agent 管理权限、session identity、effective runtime；被动 Agent 明确不支持 | 消息/工具最终结果完成；真实 permission pending 是进行中，批准/拒绝进入 adapter；cancel 必须取得执行基座确认；链路失联为 unknown，不自动重放 |
| 本轮停止 / B6 | 用户停止或启动/运行失败：launcher → 各自有 child owner | expected generation、PID/startToken、已确认的本轮归属；不停止其他 owner | drained/confirmed destruction 后 stopped-clean；未确认外部资源为 stopped-with-retained-obligations；停止失败为 failure；不得将 exit 当外部资源销毁 |
| 一次交付 / B7 | 单元候选就绪：primary → 既有 lifecycle adapter / review / Git | 当前候选与最新 main、输入指纹、产物和真实入口匹配 | 验证→review→集成→push→cleanup 全齐才 delivered；失败只阻断依赖后继；取消也须核销自有资源；待清理或保留责任不是 delivered |

对 unknown 的恢复事件必须来自 provider 的公开查询或有执行证据的 trusted recovery；没有证据时返回 retained obligation。主动恢复能力若尚未实现，显式返回 repair-required，并列 owner/对象/解除动作，不能伪装成恢复成功。
公开查询使用独立 B8 graph，不在 B2/B2p 制造回边。B8 只观察；one-shot `agent-work@2` 仍在本图确认终态后 close+dispose，持久 Work 的 confirmed 之后只能由资源 owner 经独立 `work-close@1` 显式发起并确认销毁；仍 unknown 时不 close，保留 owner/资源/恢复动作。

## Work 的公开边界与节点

原 B2 将 provider 内部的 allocation/execute/record 切成独立节点，但其真实公开边界是 `AgentWorkChannel.request`，没有三个远端 API。B2 v2 保留同一业务语义，将该原子 owner 操作收为一个节点。内部 ledger/WorkHost 状态机保持在 provider，receiver 或 SDK 不分配资源。

| 节点 / Operator@1 | 真实公开接口 / 唯一 owner | 输入 → 输出契约 | effects / replay / 失败 |
|---|---|---|---|
| 查询服务 / teams.resolve-peer-service | AgentWorkClient.findProvider / runtime 使用 network 目录 | WorkIntent(serviceSelection) → ResolvedService | directory.read / replayable；capability selection 只匹配 provider capability declaration、在 Endpoint admission 前返回不带 Endpoint 的 AgentWorkTarget；endpoint selection 保持既有 Endpoint binding 与固定 operation；两种模式无 fallback |
| 建立通信 / teams.open-work-link | AgentWorkClient.open / network | ResolvedService → OpenWorkLink | network.connect / requires_confirmation；grant/generation 由 network 验证；断线不表示 Work 完成 |
| 接纳协作 / teams.admit-provider-work | AgentWorkChannel.propose → provider WorkHost.propose / agent | OpenWorkLink → AdmittedWork | agent.work.propose / requires_confirmation；身份、policy、Endpoint revision 检查失败为 error；无接纳证据不能声称 accepted |
| 执行请求并确认结果 / teams.request-provider-work | AgentWorkChannel.request → WorkHost.request / agent-host + agent | AdmittedWork → WorkOutcome | agent.work.request / requires_confirmation；唯一 provider 完成 allocation、executor、durable result；原始业务 payload 不被改写；unknown 不自动重发 |
| 收尾并返回 / teams.settle-provider-work | AgentWorkChannel.close / dispose / receiver runtime | WorkOutcome → WorkReceipt | agent.work.close、network.close / requires_confirmation；只有已确认终态才 close；unknown 输出 retained；close 失败保留业务结果与清理错误，不变成完整成功 |
| 保留并返回 / teams.return-held-work（PENDING） | AgentWorkChannel.dispose / receiver runtime | WorkOutcome → HeldWorkReceipt | network.close / requires_confirmation；只 dispose 连接，绝不 close；Work 与 Work-scoped allocation 保留；unknown/unconfirmed owner 与恢复动作显式 |
| 继续请求 / teams.continue-provider-work（PENDING） | AgentWorkChannel.request → WorkHost.request / agent-host + agent | WorkRequestLink → WorkOutcome | agent.work.request / requires_confirmation；无 propose/admit；provider ledger 以原 workId/consumer 为接纳真源；provider/generation/capability/version 保持，本次 operation/demands 显式；unknown 不自动重发 |
| 显式关闭 / teams.close-provider-work（PENDING） | AgentWorkChannel.close / dispose / provider + receiver runtime | WorkCloseIntent → WorkCloseReceipt | agent.work.close、network.close / requires_confirmation；无 request/demands；只有 provider `confirmWorkDestroyed` 才 closed/释放；close failure 或 unknown 保留责任 |

SDK effect strings 只做授权/审计，不是资源锁或沙箱。Compile 必须拒绝未注册 Operator、类型不兼容和缺 effects；具体字段由宿主 typed port 与项目 decoder 验证。SDK 0.1.1 的 ValueType 仅支持 Object/Array 等形状，没有 Record 字段 schema；graph JSON 的 Object 不能冒充字段验证。

### Work ARC 的字段契约

以下是公开边界的数据结构约束，不是另一份可编辑图或资源账本。每个 ARC 为 `{control: <typed control>, business: <原始业务值>}`；control 与 business 分字段承载，business 原样转入现有 WorkRequest.payload，不注入 route、auth、generation 或诊断。连接 handle 只在本执行宿主的控制资源表持有，不在业务 payload 或 journal 中恢复。

| ARC 类型 | control 必需事实 | business / 所属真源 |
|---|---|---|
| WorkIntent / work.intent | receiverAgentId、targetAgentId?、capabilityId/version、serviceSelection（capability 或 endpoint）、operation、workId、requestId、policyRevision、demands；execution/attempt 在独立 SDK identity | 用户输入 JsonValue；target 和服务来自用户 config，由 runtime 校验；不携带秘密 |
| ResolvedService / service.resolved | 上述请求控制 + AgentWorkTarget（providerAgentId、generation、capabilityId/version；capability selection 不带 endpoint，endpoint selection 保留 WorkEndpointReference 与固定 operation） | 原输入；target 来自当前目录和 findProvider，不由模型或日志猜测；selection 在 Endpoint admission 前确定，无 fallback |
| OpenWorkLink / link.verified | 上述控制 + 本 execution 的 channelRef；持久 Work 保留 provider/generation/capability/version | 原输入；宿主持有实际 AgentWorkChannel；ref 无跨执行复用权 |
| AdmittedWork / work.admitted | 上述控制 + provider 返回的 AgentWork accepted；operation 只在本次 request 固定 | 原输入；accepted 来自 provider；不生成自己的资源分配状态 |
| WorkOutcome / execution.outcome | 上述关联 + 原 WorkReply.control，或公开错误/结果未知责任；结果必须匹配 workId/requestId；持久 Work 的 operation 是 request-scoped | 原 WorkReply.payload（可缺省）原样保留；不复制输入冒充输出 |
| WorkReceipt / work.receipt | one-shot `agent-work@2`：work/request identity、provider/代次、requestState、workClosure（closed/retained/close-failed）、显式 error/retained obligations；独立 execution receipt 引用 journal | 原服务结果；confirmed failed/cancelled 仍是业务失败，不因清理成功改成 succeeded |
| HeldWorkReceipt / work.held.receipt | `work-open@1`/`work-request@1`：workId、requestId、providerAgentId、targetGeneration、capabilityId/version、本次 operation；providerAgentId/targetGeneration 回显 caller 在 open dispatch 前已固定的绑定，非后选；provider 明确回执时 workClosure=retained；transport unconfirmed 时只写 deliveryState=unconfirmed，但 control 仍保留该原绑定与生成的 work/request/execution/attempt identity，不推定 requestState/workClosure | 原业务结果；**PENDING** producer `teams.return-held-work` 只 dispose，不 close；Endpoint 不进入该 receipt |
| WorkCloseReceipt / work.close.receipt | `work-close@1`：workId、providerAgentId、targetGeneration、capabilityId/version、open 捕获的 operation；provider 确认销毁后 workClosure=closed，明确 close failure 为 close-failed；transport unconfirmed 时只写 deliveryState=unconfirmed | 无 request business；**PENDING** producer `teams.close-provider-work` 只有在 provider 确认销毁后返回 closed |
| QueryIntent / work.query.intent | serviceSelection（endpoint | capability）、receiverAgentId、workId、requestId；capability 模式另需原 providerAgentId、原 Work targetGeneration、capabilityId/version、operation、可选当前 linkGeneration；execution/attempt 在独立 SDK identity | 无业务输入；one-shot endpoint 模式保持既有基线；capability 模式只观察原 provider ledger，不重放、不释放、不回写 Work 状态 |
| WorkObservationReceipt / work.observation.receipt | serviceSelection、workId/requestId、providerAgentId、targetGeneration（原 Work）、linkGeneration（本次受权连接）、capabilityId/version、operation、observed、显式 error/retained obligation | 原 WorkReply.control/payload 原样保留；NOT_FOUND/FORBIDDEN/UNAVAILABLE 显式；观察不释放资源 |

Graph Runtime 的异常输出是 ExecutionFailure，并非正常 output ARC。项目宿主始终消费它，使用自己持有的 typed ownership/dispatch facts 完成连接 teardown、必要的已确认 Work close 或 retained receipt，再返回唯一 ProjectExecutionReceipt。不能从 journal 日志猜测请求是否已发出。业务 unknown 是上述 outcome union 的正常可表示终点；unexpected exception 是 graph failure，不沿假成功 ARC 继续。`return-held-work` 与 `close-provider-work` 的 owner 边界固定为：前者只释放本 execution 的 channel，后者在 provider-authoritative close 确认后才释放；transport unconfirmed 只记录未确认投递，不推定 provider unknown/retained，也不自动 replay/close/release。

### B8 查询与恢复观察公开契约

`work-query.graph.json` 的输入 QueryIntent 使用原请求 control（receiver/provider、capability/version/operation、workId、requestId），不需要重发业务输入；输出 WorkObservationReceipt 原样保留 provider WorkReply.control/payload。查询的 execution/attempt 是新的，原 work/request identity 不变。查询成功不修改原请求状态、不替 provider trusted recovery、不重放服务。QueryIntent 用**显式** `serviceSelection` discriminator 区分两种模式，复用同一 `work-query@1` graph/runner：one-shot 查询保持既有 `endpoint` selection 与其固定 operation/endpoint policy 不变；持久 Work 的观察/恢复查询使用 `capability` selection，**必须**携 open/request control receipt 的原 `providerAgentId`、原 Work `targetGeneration`、`capabilityId`/`capabilityVersion` 与本次观察的 `operation`，由 `findProvider` capability selection 在原 provider 的 capability declaration 上解析（不读 Endpoint），禁止按当前 `[agents.<receiver>.connect]`、目录或另一匹配 provider 重选；capability-only provider 因此可达。查询新连接使用**当前受权代次** `linkGeneration`（与 receipt 的 `targetGeneration` 分开记录，绝不覆盖原 Work generation，也不把 unknown/retained 提升为已知）；provider 重启后的 get 仍以 provider durable ledger 为权威，`WorkHost.get` 按已认证 consumer + 原 `workId` 读取，request/close 保留原 `targetGeneration` 的显式 `STALE_GENERATION` 校验。不得新增第二个 query resolver/ledger/scheduler，也不得让控制 binding 进入业务 payload/metadata 或从日志重建。

| 节点 / Operator@1 | 真实接口 / owner | effects、终点与验收 |
|---|---|---|
| 查询服务 / teams.resolve-peer-service | AgentWorkClient.findProvider / runtime-network | directory.read / replayable；one-shot endpoint 模式保持基线；capability 模式按 serviceSelection + 原 provider 解析，只显式所选 provider，不猜替代 target、不 fallback |
| 建立查询通信 / teams.open-work-link | AgentWorkClient.open / network | network.connect / requires_confirmation；新的受权连接，原请求身份不变 |
| 查询原请求 / teams.query-provider-request | AgentWorkChannel.get → WorkHost.get / agent | agent.work.get / replayable；返回原 WorkReply，NOT_FOUND/拒绝/断线保留明确错误，不隐式 request |
| 返回观察 / teams.return-work-observation | receiver runtime 的 typed result projection | 无业务 effect / replayable；control 与原 business 结果分离，unknown 显示 retained owner及明确解除动作 |

查询连接的 dispose 由宿主 finally 执行，成功/失败都收尾；dispose 失败单独保留连接责任。BB04 显式查询不重复执行，BB06c/BB06e/BB07 断线恢复后查询结果；持久 Work 的查询必须显式绑定原 provider/capability/version/operation，两匹配 provider、connect 改变与 capability-only provider 都必须到达原 provider ledger，必须断言真实服务没有新增 propose/request/close、执行副作用或资源释放。provider 重启后仍有 unknown allocation 且未有 trusted recovery 时，本地 MVP 返回 repair-required，列 provider Agent、work/request/resource、核实执行终止及外部销毁后再 trusted recovery 的解除条件；不编造自动恢复。

## 用户提交与 daemon 归属

当前有 launcher→Agent 的 Node IPC，只有 ready/status 回传，没有 CLI→运行中的 receiver 的新请求入口。D3/U4 增加 launcher 自有本地 Unix socket 控制入口，监听位置/认证引用和当前 generation 保存在 internal.toml，目录/文件权限限当前用户；用户不配置 socket、token 或端口。

CLI 将新 request control 与独立 business payload 提交 launcher；launcher 核对自己的 active generation/owner、configured receiver/target/service，按 receiver 的既有 child IPC 分发。receiver 使用现有 AgentWorkClient 和自身已登录身份发起 Work。不得由 CLI 用同一 Agent identity 再次登录目录、抢占 generation；不得让 Console 充当 Work 数据转发。

本地控制和 child IPC 使用封闭的 typed union（submit/query/open/request/close/result/error），带 correlation、receiverAgentId 和预期 launcher/Agent generation；service admission 仍由 provider 控制。持久 open 在 dispatch 前固定并显式携带 provider/generation/capability/version/initial operation binding；request/close 保留 provider/generation/capability/version；request 另带本次 operation，close 带 open operation。get 是明确查询既有 provider 回执，不以新执行身份读旧 receipt。IPC/send 被接受不等于业务已执行；发出后客户端断开时，Work 不自动取消或重试，明确可通过原 identity 查询结果；open 最终回执丢失时，未确认 control 已含该固定 binding，故查询不需要最终回执或 open.json。

本地 receiver 入口、SDK runner 和现有 configured startup path 最终调用同一 Work execution owner。验证等价后删除旧 startup orchestration 及 CLI 读 configuredWork 冒充新执行的路径；不保留双执行链作为 fallback。internal.toml 不存 Work 业务结果真源；durable 结果仍由 provider ledger 提供。

## SDK 宿主接入候选与生成物

D2 实验验证按次启动的 project-owned Rust runner，使用已安装 SDK；生产目录候选为 `runtime/dagpipe/`。它不是常驻服务。Runner 接收 graph/identity/input，注册固定版本项目 Operators，compile 后仅将 CompiledGraph 交给 Runtime；通过 stdio JSON-lines typed port 请求 Node 宿主调用上表公开接口。

Node 只派发明确 host operation、持有本 execution 的 channel 与 owner facts、校验返回关联和执行收尾；节点顺序由 SDK Runtime 决定，不在 Node 再跑一份图。未知 host kind、错误关联、EOF、compile/run 错误必须显式终止；不静默退回旧 TS orchestration。stdio 控制使用专用管道，stderr 诊断不参加业务决策。

产品依赖不得提交机器私有 home path。D2 确認 SDK 实际分发方式后，在候选构建时从 dagpipe sdk path 解析并绑定 SDK 内容 hash，保留准确 dependency/lock；生成按平台的 runner binary 与 graph，纳入同一用户安装包，运行只从稳定安装位置派生。若无法从已安装 SDK 构建或目标架构不支持，安装/启动显式失败，不源码路径回退。当前尚无产品二进制、安装或 portable dependency 证据。

## 其他对象的契约与运行分类

| 图 / 本地 MVP 分类 | typed 输入 → 输出、真实边界 | 当前缺边与验收 |
|---|---|---|
| B1 static-governed | LocalConfig + launcher ownership → ready/stopped/failure receipt；loadLocalConfig、createLocalSupervisor、startAgentProcess、directory | U2/U3 简化 intent 与真实服务发布；BB01–BB03。Supervisor 的异步多进程生命周期有现成 owner，本轮不改为 SDK 常驻调度 |
| B2 executable（待接入） | `agent-work@2` 的 WorkIntent → WorkReceipt / ProjectExecutionReceipt；持久 `work-open@1`/`work-request@1`/`work-close@1` 为 DESIGN，PENDING Operator 未注册 | D3/U4 SDK 执行及新用户入口；BB04–BB07、BB11；持久图必须分别覆盖 open 保留、request-without-propose、close/dispose owner 边界 |
| B8 executable（待接入） | QueryIntent → WorkObservationReceipt / ProjectExecutionReceipt；AgentWorkChannel.get、WorkHost.get | D3/U4 使用同一 runner/registry、独立查询图；显式 serviceSelection 区分 one-shot endpoint 与持久 capability 观察；BB04/BB06c/BB06e/BB07 的结果观察、原 provider 绑定和无重放/无释放证据 |
| B3 static-governed | expectedRevision + provider/model intent → acceptedRevision/effectiveRevision/error；RuntimeConfigStore、ConsoleConfigBinding、ManagedConfigOwner.apply/use | U2 单一 TOML persistence 和锁/CAS 设计须在其编码前准入；用户意图只在 config.toml；内部事实保存 internal.toml，派生 JSON 不回写用户源；BB08、BB10 |
| B4 static-governed | 授权主体/观察目标 → ConsoleProjectionV1/error；Console server、目录、Agent Console ingress | U1/U5 同包入口；BB01、BB09。页面刷新/推送已有异步 owner，不新增 SDK 观察状态存储 |
| B5 static-governed | Session target + 独立 payload → Session/tool/permission/final/error；ConsoleClientV1、ManagedConfigOwner.use、OpenCode adapter | U6 接 wire→managed Session，并补当前缺少的 cancel/新建 Session 控制契约；先审该窄变更，不能用业务 payload 夹带动作；BB12 |
| B6 static-governed | expected generation/owner + stop intent → stopped-clean/retained/failure；supervisor.stop、child.stop、WorkHost.close | 适用关闭与资源保留证据；BB07、BB08、BB14。资源回收不依赖失败的 SDK runner继续存活 |
| B7 static-governed | candidate 与 stage 指纹 → delivered/blocked/cleanup-pending；既有 lifecycle adapter、独立 reviewer、Git | U7 引入 graph/registry/SDK 指纹依赖与同包黑盒；BB13–BB14。人类/外部 review、Git 操作不包装成虚构产品 Operator |

这些分类缩小实际 SDK 改造面，不缩小用户行为验收；五张 Work graph（`agent-work@2`、`work-open@1`、`work-request@1`、`work-close@1`、`work-query@1`）与其余对象图全部受静态治理，全部公开用户路径仍要经过黑盒。分类更改先修模型/graph 和受影响 maps，并审边界，不将 static-governed 写成 SDK 执行完成。

## 准入与收口

D1 的证据是公开接口核对、修改图静态验证、typed 契约及终点覆盖；D2 的证据是实际 SDK consumer 正反执行及支持边界。当前文档、图和实验精确候选必须取得独立 design PASS，之后才能启动涉及其边界的产品编码。U2 persistence 与 U6 cancel/session-control 窄契约仍须在各自 unit 编码前补齐并审，不以本文件预授不存在 API。

作者开发测试、真实安装/运行与黑盒通过后，才进行实现后的独立架构 review。候选变化只使受影响证据失效；最终安装包必须实际包含 runner、graph、runtime 与 UI。所有证据、main/remote、阶段记忆和自有资源清理齐备后按计划结束，当前图校验或实验不能关闭整个 goal。
