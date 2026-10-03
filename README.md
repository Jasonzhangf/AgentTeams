# AgentTeams

跨设备、多 Agent 管理项目。Agent 可以是被动浏览器 CLI 等能力服务，每个 Agent
对应一个 daemon。能力方声明 capability/resource，调用方匹配后请求执行；双方
支持资源容量内的一对多，可组成 peer、master/slave。Console Host 是观察面和配置面，
可以常驻但不要求常驻；关闭 Console 不终止 Agent 协作。

OpenCode 只作为推理型 Agent 的执行基座，承载 Session、消息、工具与审批执行。
Teams 拥有独立 UI 和多 LLM provider 配置；被动能力 Agent 不要求配置模型。
Phase 1 先覆盖本地网络 bridge，Console 不充当必经业务中继。公网 Relay、NAT、STUN
和移动端属于后续阶段。

每个 daemon 启动后按配置注册本地网络端点，发布能力/资源、查询目录并连接对端。
本地 bridge 可提供目录、广播和连接辅助；后续公网 Relay 可扩展 STUN、内网穿透及流量中继。

## 设计入口

- [概要与唯一 owner](docs/goals/teams-overview-design.md)
- [产品交互](docs/design/teams-detailed-design-v1.md)
- [控制协议 v2](docs/design/teams-control-protocol-v2-master-agent-host.md)
- [Agent 关系与通信](docs/design/teams-agent-relation-communication-v1.md)
- [Provider 配置与 OpenMinis 参考](docs/design/teams-provider-config.md)
- [下一步开发计划](docs/goals/teams-development-plan.md)
- [架构 maps](docs/architecture/)

## 当前进度

2026-10-02 基于远端 `5496e1e` 的审计：本地 bridge、独立 daemon、目录/能力发布、
Agent Work 资源账本、多 provider 配置和受管 OpenCode 已有实现与历史真实回放。
当前用户入口仍需收口：`work` 读取启动任务回执，服务声明固定，Console 另需 JSON，
provider/model 用户意图未统一到 TOML，daemon Session 入口尚未接通，用户包缺 Console 静态资源。
因此当前状态是本地协作工程底座，尚未完成可交给普通用户的完整 MVP。

下一步以 [项目行为审计](docs/design/teams-behavior-audit-20261002.md)、
[行为 DAG 与状态机](docs/design/teams-behavior-model.md) 和
[用户交付计划](docs/goals/teams-user-delivery-plan.md) 为当前入口。
静态图位于 `docs/design/dagpipe/graphs/`；DAGpipe topology PASS 不代表运行时已经接入 SDK。

迁移审计基线 `57c3dc4`：根配置的 57 个测试及 Console/OpenCode adapter 类型检查
通过；根回归命令缺 package 入口，扩展测试存在旧路径和外部构建配置依赖。
这是重置前基线。本次重建统一根 workspace/lockfile，修复迁移路径；全量现有
33 个测试文件、128 个测试与核心/当前包类型检查通过。AppSDK 绑定实际构建的
Console/OpenCode 库和静态资源，不再绑定占位文件。历史运行证据见 `note.md`，
不替代当前候选的实际入口验证。

## 开发管控入口

在仓库根执行 `pnpm install --frozen-lockfile`，然后 `pnpm verify`。
完整约定、适用边界与重置记录见 [开发管控](docs/development-governance.md)。
源码/治理验证通过不表示 daemon、relay、provider live 或移动端验收完成。

测试主 provider 使用 RCC 4444，goaichat 是显式备用配置。OpenMinis 仅作为配置
逻辑和接口参考，不复用其 UI，不复制其推理执行栈。
