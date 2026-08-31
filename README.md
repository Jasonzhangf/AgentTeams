# Teams

Teams 是跨 agent 的 DSH/OpenCode 控制台设计项目，使用 AppSDK `0.1.6` 治理。

当前阶段：`design`

入口：

- [概要设计](docs/goals/teams-overview-design.md)
- [详细设计 v1](docs/design/teams-detailed-design-v1.md)
- [控制协议 v1](docs/design/teams-control-protocol-v1.md)
- [控制协议 manifest](docs/design/teams-control-protocol-v1.manifest.json)
- [生命周期 manifest](docs/goals/teams-lifecycle.manifest.json)
- [静态 UI 原型](docs/design/multi-agent-console-prototype.html)
- [架构资源地图](docs/architecture/resource-map.json)
- [架构函数地图](docs/architecture/function-map.json)
- [架构主线调用地图](docs/architecture/mainline-call-map.json)
- [架构验证地图](docs/architecture/verification-map.json)
- [架构模块注册表](docs/architecture/module-registry.json)

AppSDK canonical maps 位于 `.appsdk/maps/`，由 AppSDK `0.1.6` 管理；Teams 业务架构地图位于 `docs/architecture/`，两者不混用。

当前已包含：

- DSH Cordis client package 的 Slice 1/2 白盒实现。
- 独立 OpenCode v1 `{ server() }` adapter package 的白盒实现。

仍未完成：

- DSH plugin profile 安装、启动和真实 WebUI smoke。
- OpenCode plugin 安装、启动和真实 hook smoke。
- 服务器部署、runtime live 验证、AGY Review、提交和发布。
