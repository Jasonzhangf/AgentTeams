# AgentTeams

跨设备、多 Agent 管理项目。Agent 可以是被动浏览器 CLI 等能力服务，每个 Agent
对应一个 daemon。能力方声明 capability/resource，调用方匹配后请求执行；双方
支持资源容量内的一对多，可组成 peer、master/slave。Console Host 是观察面和配置面，
可以常驻但不要求常驻；关闭 Console 不终止 Agent 协作。

OpenCode 只作为推理型 Agent 的执行基座，承载 Session、消息、工具与审批执行。
Teams 拥有独立 UI 和多 LLM provider 配置；被动能力 Agent 不要求配置模型。
首版覆盖公网、NAT 与 relay，Console 不充当必经业务中继。

每个 daemon 启动后按配置登录 relay 服务，发布能力/资源、查询目录并连接对端。
relay 服务提供目录、广播和连接辅助，可扩展 STUN、内网穿透及流量中继。

## 设计入口

- [概要与唯一 owner](docs/goals/teams-overview-design.md)
- [产品交互](docs/design/teams-detailed-design-v1.md)
- [控制协议 v2](docs/design/teams-control-protocol-v2-master-agent-host.md)
- [Agent 关系与通信](docs/design/teams-agent-relation-communication-v1.md)
- [Provider 配置与 OpenMinis 参考](docs/design/teams-provider-config.md)
- [下一步开发计划](docs/goals/teams-development-plan.md)
- [架构 maps](docs/architecture/)

## 当前进度

已有协议/目录/路由/channel 状态组件、OpenCode adapter 和直接访问 OpenCode HTTP
API 的 Console 原型。独立 daemon、Agent-to-Agent transport 与公网 relay 尚未
串成主线；provider 注册、模型目录刷新与配置应用仍待实现。

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
