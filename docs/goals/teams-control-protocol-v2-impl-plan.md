# Control Protocol v2 历史组件基线

当前实施顺序和验收见[用户交付计划](teams-user-delivery-plan.md)。
下表仅记录迁移时的组件分类，不维护当前执行状态或第二份实施计划。

## 已有源码基线

| 历史阶段 | 已有组件 | 未证明内容 |
|---|---|---|
| A | typed frames、channel state machine | 真实网络 ingress |
| B | Agent 注册函数、server directory | 公网注册与活跃服务 |
| C | directory snapshot、显式 route plan | 实际路径连接与账号安全 |
| D | target 状态、Session channel registry | socket/relay I/O 与 Agent-to-Agent |
| E | Agent Host 配置与 OpenCode facade binding | 独立 daemon、被动能力/CLI adapter |
| Console 原型 | 多 OpenCode HTTP endpoint、审批动作 | 可离线 Console 的协作架构、实时完整管理 |

迁移基线 `57c3dc4` 的 57 项根配置测试通过，但完整工程回归有旧路径缺口。
历史 OpenCode/Camo 记录不替代当前 commit 的安装、重启与真实双设备回放。

## 当前设计修正

Console 只观察和配置，不是必经 master/relay。Agent 可被动提供 capability/resource；
Host Agent 匹配后请求，能力方执行，在资源容量内支持双方一对多。
OpenCode 仅用于推理型 Agent；Teams 独立管理多 LLM provider，参考 OpenMinis
配置接口。Phase 1 验证本地网络 bridge 与 Console 离线后的 Agent Work；公网/NAT/relay
属于后续阶段。

不沿旧 Phase 字母把纯状态组件记作网络完成。当前任务依赖、真实入口验收与
后续公网范围均由用户交付计划维护；本历史基线不要求执行旧 P0/I1/V1 顺序。
