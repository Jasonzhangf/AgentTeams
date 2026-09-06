# AgentTeams 下一步开发计划

状态：设计范围更新；本轮不宣称运行时功能已实现。每个语义里程碑使用独立 clean
worktree，完成 owner 绑定、定向红绿测试、适用回归/build/live、AppSDK 和 review。

## 已确认范围

- Agent 可被动提供浏览器 CLI 等能力。OpenCode 只作推理型 Agent 执行基座；
  Teams 拥有独立 UI 和多 LLM provider 配置，非 LLM Agent 不要求 provider。
- 每 Agent daemon；配置后 Agent 直接协作，Console 只作可离线的观察/配置面。
- 首版覆盖公网、NAT、direct 和 relay；relay 不承担 Agent 协调决策。
- peer、master/slave 由 Agent policy 组织，关系标签不授予权限。
- capability/resource 声明 → Host 匹配 → work → 请求/执行；双方一对多，能力方
  原子检查容量并拥有 allocation，Console 不作为协作 Host。
- 测试主 provider 为 RCC 4444，goaichat 为显式备用配置。
- 配置逻辑/模型接口参考 OpenMinis，不复用其 UI 或推理执行栈。
- daemon 启动或附着 OpenCode 的实例所有权仍需在实现前确定。

## M0：迁移与真实治理基线

本轮已重建为根 workspace/lockfile、完整现有测试入口和真实编译库产物；执行与
证据适用性见 [开发管控](../development-governance.md)。主线集成与产品运行验收
分别收尾，不把本工作树的验证结果写成已发布。

修根级安装/构建/测试入口、旧路径和 UI 外部宿主依赖；选定唯一生产 UI。
将 AppSDK placeholder 替换为真实产物，更新调用边、测试与依赖哈希输入；producer
从独立仓库根运行。旧源码归属条目随源码拆除同步清理，不伪装旧实现已删除。
验收：干净 checkout 不依赖原仓库即可安装构建、运行完整适用回归；真实 artifact
绑定当前候选。不再次 reset 有效治理。

## M1：配置 owner 与语义修复

按 [配置设计](../design/teams-provider-config.md) 实现 provider CRUD、模型刷新/手动
模型、Agent binding、revision CAS、credential reference、OpenCode 编译与 apply。
修 adapter 错误传播、current Session 猜测和业务 payload 数组误拒绝。
验收：同协议多个 provider 独立配置；刷新不覆盖用户 override；401/403、空目录、
未支持协议和并发 revision 冲突显式呈现；RCC 与显式选择的 goaichat 分别通过真实
OpenCode 入口验证。Console 关闭后，已应用配置仍有效。

## M2：被动能力与 Agent Work 最小闭环

实现 [能力协议](../design/teams-agent-relation-communication-v1.md)：版本化 capability/
CLI 接口与 resource 声明、匹配、work、请求结果和取消/资源回收。选择一个浏览器
能力服务与 Host adapter 做真实闭环，不先新增通用调度框架。
验收：无模型浏览器 Agent、两个 Host 并发消费、超额拒绝与释放后重用；一个 Host
同时消费浏览器和另一能力；不兼容接口/未授权拒绝；关闭 Console 后执行继续。

## M3：Agent-to-Agent 与公网 relay

先实现 daemon bootstrap → relay 登录 → 声明发布/presence → 授权范围广播/目录
查询 → 对端连接辅助。没有 Console 在线也必须独立完成启动与发现。
relay 服务统一暴露目录、广播、连接协调及可用的 STUN/穿透/流量中继能力；
未实现的服务能力明确 unavailable。先验证完整中继路径，再验证 direct 和选定的
STUN/穿透方式；映射地址发现不等于实际可达。

Agent Host 同时支持发起/接受授权 target，network 实现 direct 与 relay；NAT
两侧通过主动出站连接通信。server 管连接准入，目标 Agent 管 capability 权限。
接通 target/channel，替换 Console 直接调用 OpenCode 和拼 prompt 转发的生产路径。
验收：两处 NAT daemon、direct/relay 各自实际样本、账号和目标授权拒绝、旧
generation 拒绝、健康 Agent 隔离；关闭 Console 后 request/reply 仍完成。

## M4：关系组织与多设备管理

唯一 relation reconciliation、Agent 持久化 policy/report、peer 与 master/slave
实际协作，明确授权与撤销。Teams UI 接入真实 Conversation、实时通知、审批、设置。
验收：手机蜂窝/桌面观察两处 daemon；关闭全部 Console 后继续协作，重新打开
另一设备能读回关系与配置；master Agent 离线时报告其关系状态，不把 Console
自动提升为 master；没有静默重发或权限转移。

## M5：扩展与首版交付

接入 Search/Memory 生命周期。完成当前候选安装/重启/公共入口回放、AppSDK
admission、review。commit/push/发布分别按用户授权与证据执行。

## 当前参考证据

OpenMinis `origin/main` 已获取到 `4ef29002e88db1e20e462ec2ff46916e8a7dcb45`。
RCC `GET http://127.0.0.1:4444/v1/models` 本轮 HTTP 200，但 `data/models` 均为空；
本地配置 expose_models=[gpt-5.5]，差异尚未定位。goaichat 仅核实本地配置，未调用
上游推理。这些证据不构成 provider live 或跨设备功能完成。
