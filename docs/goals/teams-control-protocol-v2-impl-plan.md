# Control Protocol v2 组件进度与当前计划入口

状态：历史阶段已重新归类。当前实施顺序唯一入口为
[teams-development-plan.md](teams-development-plan.md)。

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
配置接口。首版验证公网/NAT/relay 与 Console 离线后的 Agent Work。

不再沿旧 Phase 字母把纯状态组件记作网络完成。下一步按当前计划 M0–M5，
分别绑定源码、真实产物、适用测试、入口证据和 review。
