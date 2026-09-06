# AgentTeams 开发计划与依赖审查

状态：待用户审批；本文件不授权功能实现。治理基准提交：
`fdb907f2c23fad142ddbb2000d14031dc1a9a932`，分支 `codex/appsdk-reset-20260906`。
基准已本地提交，未 push/合并。正式开发前须先按授权把基准及获批计划集成到主线，
随后每个实现任务从最新 origin/main 建立独立 clean worktree。

## 审查结论

原 M1→M2→M3 串行方案存在四个依赖问题，改为“公共契约→并行模块→统一装配→真实验收”：

1. daemon/relay 放在第三阶段太晚：所有 Agent 启动、发现和跨设备 work 都依赖它。
   网络主线提前，与 provider/config 和能力执行并行，禁止先以 Console 转发拼出闭环。
2. provider 与能力服务没有必然先后关系：无模型浏览器必须独立可用。
   配置、工作/资源台账分开 owner；OpenCode 只进入推理型 Agent 路径。
3. UI 与关系组织混在同一阶段容易让 Console 再次拥有状态：Agent 先保存 work/policy，
   Console 后接只读投影和授权配置命令；master/slave 不进入网络路由决策。
4. 完整 Search/Memory 插件不应阻挡首版：验收一对多只需第二种真实能力。
   首版用固定目录只读文件检索 CLI；完整索引/记忆生命周期延期。

保留现有 typed frame、directory、route/channel 状态组件及 OpenCode SDK adapter。
删除旧生产绕路在新主线通过验收的同一集成任务中完成，不双写、不自动回退旧链。
不新增通用调度框架、全局配置同步、自动 provider 切换或第二套证据系统。

## 待批准的实施选择

- 一个 Agent 对应一个 daemon 和稳定身份。推理型 Agent 首版由 daemon 独占启动/停止
  自己的 OpenCode 子进程及派生配置目录；附着任意外部实例延期，避免进程/配置双 owner。
- 先打通显式 WSS 流量 relay，随后实现可达地址的 direct。跨 NAT 先以双方出站 relay
  满足首版；STUN/打洞声明真实支持状态，不把映射成功当直连成功。选成熟实现后才启用
  穿透能力；不可用时显式 unavailable。route plan 预先授权候选切换，不重放未知结果请求。
- 单一账号/项目作用域内的多设备先行，保留身份、目标授权、撤销与隔离；首版不建组织
  计费/复杂角色系统。relay 管连接准入，能力方独立管 work 和资源授权。
- 首版包含 browser CLI、固定目录只读文件检索 CLI 和 OpenCode 推理 Agent；不包含
  完整 Search/Memory 插件、自动主节点选举、消耗型余额与全局调度。

以上收敛不改变公网/NAT/relay、双方一对多、Console 可离线和多 provider 要求。

## 顺序与可并发任务

| 波次/任务 | 交付与 owner | 允许修改范围 | 前置依赖 | 可并发 |
|---|---|---|---|---|
| P0 公共契约 | 协议负责人：固定 identity、capability/resource、work/request、config、错误与版本契约 | `control-protocol/`、受影响设计/maps | 主线具备获批基准 | 此任务先串行完成 |
| N1 relay 服务 | server owner：TLS 登录、目录、限定范围广播、连接辅助、流量 relay | `server/` 及所属测试/部署配置 | P0 | N2、C1、W1 |
| N2 daemon 与网络 | runtime/network 集成 owner：启动、身份持久化、出站连接、注册/订阅、target/channel、实际收发 | `network/`、`runtime/`、`agent-host/` | P0；联调需要 N1 | N1、C1、W1 |
| C1 provider 与 OpenCode | config owner：实例/模型目录、凭据引用、durable CAS、accepted/effective；adapter owner 同任务负责 apply/错误传播 | `config/`、`opencode-adapter/` | P0；服务级 apply 联调需要 N2 | N1、N2、W1 |
| W1 Work 与资源 | agent owner：匹配、授权、持久化 work/request/allocation、原子容量、取消/恢复 | `agent/` | P0 | N1、N2、C1 |
| B1 真实 CLI 能力 | CLI adapter owner：浏览器 context 与文件检索固定 operation/argv/schema | 新 `cli-adapter/` 及所属测试，P0 绑定 map 后创建 | W1 接口稳定 | U1；C1 未完成时也可推进 |
| U1 独立 Console | presentation owner：独立构建、投影订阅、配置、真实 Session/审批入口、手机布局 | `ui/`；不写 runtime、网络或配置台账 | P0 投影/命令契约稳定 | B1；可提前开发契约组件，真实联调依赖 I1 |
| I1 主线装配 | 唯一集成 owner：接通 N1/N2/C1/W1/B1/U1，Console HTTP 原型退出生产主线 | `runtime/`、`agent-host/`、`console-host/`、集成测试；跨模块修复回原 owner | 相关模块验证与 review 通过 | 同一集成候选串行 |
| R1 关系与观测 | agent owner：持久化授权关系、report revision/pair 冲突、撤销与离线状态；UI 仅投影 | `agent/`；UI 配套由 U1 owner 单独提交 | I1 已证明独立 Agent Work | N3，前提文件 claim 不重叠 |
| N3 direct 与网络韧性 | network owner：direct 路径、显式连接策略、断线重登、旧 generation 拒绝与连接隔离 | `network/`、`server/`、所属网络测试 | relay 主线 I1 | R1 |
| V1 首版验收 | 集成负责人：双设备/双 NAT、手机蜂窝、部署重启、失败与恢复证据 | 集成/部署测试及 maps/evidence | I1、R1、N3 | 独立环境的场景可并行；最终候选串行收口 |

P0 同时修业务 JSON 数组误拒绝，并定义当前 Session 的明确选择/未知状态契约。
C1 修 SDK 错误传播；I1 移除 Console 猜测首个 Session 的路径，不把不相干修复混进配置 store。
P0 不实现通用框架，只固化各并行任务真正共享的接口、控制/业务物理边界和失败样本。

建议第一波最多四个 worker（N1/N2/C1/W1）。N1/N2 可以先按同一协议写各自测试，
只有连上真实服务才算网络验收。B1/U1 在对应接口稳定后进入，不为凑并行提前实现不确定接口。
表中的模块内验证不替代 I1/V1 的跨模块与真实环境证据。

## 各波次退出条件

**P0：** 版本不兼容、未授权、重复 request、旧 generation、资源不足、CAS 冲突、
结果未知有明确类型；业务数组和合法字段保真。目录不保存 Session 正文；relay 不授予
work 权限。持久化与重启恢复策略明确，测试绑定唯一 owner。

**第一波模块：** N1/N2 两个真实 daemon 在无 Console 条件下登录、发现、请求/响应；
拒绝错误身份、越权目标、过期连接。C1 同协议多实例隔离、刷新保留 overrides、空目录和
401/403 明确；accepted/effective 分离且重启可读回。W1 并发分配不超卖，重复请求不
重复执行，超时不伪装取消，执行/销毁确认前不释放资源。

**B1/I1：** 真实浏览器 Agent 无模型运行；两个 consumer 各占一个 context，navigate/
snapshot 复用，第三个申请拒绝，work 关闭并销毁后可重用。一个 consumer 同时消费浏览器
与固定目录检索。CLI 不执行任意远端 shell；非零退出和输出语义保真。N2 统一装配所有
adapter，模块 worker 不另写第二套 daemon。关闭全部 Console 后 work 继续。

**C1/I1 推理链：** RCC 4444 和显式选择的 goaichat 分别通过真实 OpenCode 入口；
无隐式 failover。RCC 模型目录为空的既有异常须先按当时真源定位，不能以配置 expose_models
代替实际目录或推理证据。远端 daemon 的 localhost 不等于 Console 所在设备。

**R1/N3/V1：** 两处 NAT 的显式 relay、可达地址 direct 各自留证；真实手机蜂窝与桌面
观察同一组 Agent。Console 全关闭、另一设备重开后能读回 config/work/relation；master
离线不自动选举或提权。撤销、进程崩溃、断网、重复请求、重启对账均不超卖/重复副作用。
NAT-to-NAT 直连只在实际穿透实现与回放通过后宣称支持。

## 并发与集成规则

- 模块 worker 自动通过 Collab 注册任务/工作树/路径 claim；无可靠协调时只暂停冲突写入。
  每个文件只有一个写 owner。`runtime/` 和 `agent-host/` 始终由 N2/I1 顺序移交。
- P0 完成后冻结本波接口 revision。接口变化由协议 owner 提出并统一更新消费者；不让各
  worker 私自增加兼容分支。`AGENTS.md`、根依赖/lockfile、公共 maps 由集成 owner 单写，
  各 worker 提交明确的绑定变更需求，在同次集成中落实。
- 每个任务定向红绿测试→适用回归/typecheck/build→真实入口→review；新服务在验证前
  绑定安装/重启操作，不能继承当前库模块的空部署操作来跳过服务验收。
- 合并按依赖排队；集成候选变更后重跑受影响验证。只有候选、产物、依赖、环境相同的
  证据可复用。不以 mock 网络测试、HTTP health 或测试数量代替产品验收。

## 审批与执行边界

本次仅提交治理基准、修订并审查计划。用户审批以上范围和顺序后才创建实现任务。
基准/计划的 push 与主线集成尚未执行；开发前需要相应授权和主线验证。
公网地址、两处 NAT 设备、手机、测试凭据在 V1 前绑定实际环境；当前文档不假定可用。
审批不自动授权生产变更、外部发布或任意凭据读取。
