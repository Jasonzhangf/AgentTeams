# AgentTeams 概要设计

状态：设计更新；当前源码存在旧调用路径，本文不宣称实现完成。

## 已确认的产品边界

Agent 是能力/资源服务单元，不要求主动推理。浏览器可通过 daemon 声明浏览器
能力和 CLI 接口，无需 LLM 或 OpenCode。每 Agent 对应一个 daemon 身份与生命周期。
推理型 Agent 可使用 OpenCode 承载执行循环、Session、消息、工具和审批。
Teams 拥有自己的 UI、管理协议与 LLM provider 配置。

Console Host 是观察面和配置面，可常驻但不要求常驻。配置被目标 Agent 接受后，
Agent 之间直接建立通信关系，继续各自任务与 peer/master-slave 协作。
Console 关闭、换设备或断线不撤销 Agent 的配置、关系和已授权协作。
Console 与 relation 中的 master 是不同概念；master 是一个 Agent 的协调角色。

能力方发布 capability/resource → Host/consumer Agent 适配接口并发起匹配 →
能力方准入 → 建立 Agent Work → Host 请求 → 能力方分配资源、执行与完成。
能力方可在容量内服务多个 Host，Host 可同时使用多个不同能力。
协议唯一设计见 [Agent Work](../design/teams-agent-relation-communication-v1.md)。

## 首版公网、NAT 与 relay

每个 daemon 启动即按本地配置连接 relay 服务、登录、发布能力/资源声明和 presence，
再通过广播订阅、目录查询发现对端并请求连接辅助。此流程无需 Console 在线。
relay 服务是目录、广播和辅助连接服务，可提供 STUN、内网穿透与流量 relay。
详细启动、服务能力与失败边界以 [v2 协议](../design/teams-control-protocol-v2-master-agent-host.md) 为准。

Agent Host 既能接受授权的目标连接，也能主动连接另一 Agent Host。
有可达地址时使用显式 direct route；NAT 无入站可达性时，两侧主动出站到公网
relay，再建立 Agent-to-Agent 逻辑 target/channel。Console 不在该数据路径中。
其中流量 relay 只转发授权流量；目录和连接辅助同属 relay 服务，但不承担任务
调度、provider 选择或 relation 决策。

物理连接与逻辑 target 分离。每对通信身份在一代连接中复用 target/channel；
多个 Session 或协作 channel 不分别创建 socket。首版可先验证 relay 路径，
随后验证 direct；按服务声明验证 STUN/穿透能力，不要求 WebRTC 或透明自动切换。
所有路由选择显式，切换前结束旧 target 并更换 generation。
公网入口必须真实认证、校验目标授权；未收到 mutation 结果不得自动重放。

## 唯一 owner

| owner | 职责 |
|---|---|
| server | relay 服务登录、目录/广播、连接辅助、STUN/穿透服务声明和中继会话授权 |
| network | Agent/Console 实际连接、direct/relay、target/channel、健康与恢复 |
| config | 每 daemon 持久化 provider 实例、模型目录、Agent binding 和 accepted revision |
| runtime | daemon 启停、已接受配置的应用、执行基座生命周期 |
| agent | capability/resource 声明、work/policy、资源准入与分配、关系 report、实际协作 |
| agent-host | 单 Agent 协议入口、调用 policy 并分发到 adapter |
| opencode-adapter | SDK/Hooks、配置编译与生效读回、错误语义适配 |
| console-host | 按需观察投影与提交配置/用户动作，不保存执行真相 |
| ui | 导航、Conversation 呈现、抽屉及桌面/手机布局 |

server 的连接准入不替代目标 Agent 的业务 capability 授权。关系事实来自关系
两端 Agent；graph 是 report 的派生视图，不能推导 authority。纯 reconciliation
只有一个实现，可被投影消费者调用，不成为第二份可编辑关系真相。
这些是代码责任边界，不要求分别部署成微服务。

## 配置与多设备

LLM 配置唯一设计见 [Provider Config](../design/teams-provider-config.md)。被动能力
Agent 不要求 provider/model；其接口参数与容量同样由本地 config/资源 owner 管理。
Console → typed config command → 目标 daemon 的 config CAS → durable accepted
revision → runtime/adapter apply → effective revision 读回。
两个 Console 并发修改同一 Agent 时由其 revision 拒绝冲突，不在浏览器合并。
离线 Agent 的修改显示未应用；首版不实现隐式离线队列。

## 用户语义

Topology 展示 Machine/Agent summary、关系和连接状态。卡片主动作进入明确的
current Session；列表顺序不能推导 current。Conversations 展示真实消息、工具、
审批和 composer。Notifications 保留 pending/processed、优先级和事件发生时间。
Settings 按 config/network owner 分发，Search/Memory 接入后才显示可用。

手机和桌面共享动作与投影，只改变布局。抽屉支持嵌套、返回来源、Escape、焦点
恢复、键盘、触屏、缩放和 reduced motion；header 拖动不干扰内容区。
一个 Agent 不可用不使其他健康 Agent 的操作消失；结果未知不得显示成功。

## 验收与尚未决定事项

必须验证两个不同 NAT 的 daemon、direct 与 relay、手机蜂窝网络、桌面、权限
允许/拒绝、旧 generation 拒绝、配置生效，以及关闭 Console 后继续协作并在
另一设备重新观察。历史截图或 HTTP health 不替代该证据。

各 adapter 必须声明启动受管服务还是附着已有服务，避免两个 owner 管同一实例。
OpenCode adapter 的具体启动模式仍待确定；浏览器能力以明确 CLI/service contract
为准。当前源码缺口和顺序见 [开发计划](teams-development-plan.md)。
