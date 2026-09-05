# Teams

Teams 是优先适配 OpenCode 的跨 agent 控制台项目，使用 AppSDK `0.1.6` 治理；DSH 适配延期。

当前阶段：`implementation`

入口：

- [概要设计](docs/goals/teams-overview-design.md)
- [详细设计 v1](docs/design/teams-detailed-design-v1.md)
- [控制协议 v1](docs/design/teams-control-protocol-v1.md)
- [控制协议 v2：Master Console Host + Agent Host](docs/design/teams-control-protocol-v2-master-agent-host.md)
- [控制协议 v2 manifest](docs/design/teams-control-protocol-v2.manifest.json)
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

- 独立 OpenCode v1 `{ server() }` adapter package 的白盒实现。
- 控制协议 v2 Phase A：typed target/session frames、session channel 状态机、控制面与业务 payload 隔离测试。
- 控制协议 v2 Phase B：Agent Host registration client、Server host directory skeleton、presence/stale/route candidate 正反向测试。
- 控制协议 v2 Phase C：Master account directory snapshot/generation 确认，以及 manual/auto route plan 显式选择。
- 控制协议 v2 Phase D：target transport 生命周期与 session logical channel multiplex registry。
- 控制协议 v2 Phase E：Agent Host 配置校验与 OpenCode facade binding，注册/projection 不携带 Session/permission body。

仍未完成：

- OpenCode live 回放只覆盖部分 Phase E；Master Console Host live integration 仍待 Phase F。
- Search/Memory 插件 lifecycle 与 relation graph 仍待接入。
- DSH adapter（deferred，不属于当前 release 前置）。
- 服务器部署、AppSDK lifecycle records、AGY Review、提交和发布。

v2 网络层参考 `~/code/zterm` 的连接架构原则（目录控制连接、target transport、logical channel、generation、route plan），但 Teams 独立实现自身协议和模块；不复制 zterm 终端协议或源码。
