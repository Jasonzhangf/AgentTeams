# Teams Control Protocol v2：Agent 网络与可离线 Console

状态：design-revised。文件路径保留供链接兼容；Console 不是持久在线 master 或
必经 relay。本轮是设计变更，当前源码仅有部分状态组件与旧 Console HTTP 原型。

## 1. 身份和连接角色

每个 Agent daemon 有稳定 agentId/hostId。Agent 可为被动能力服务，不要求主动
推理。发起 capability 匹配与工作请求的 Host 是 consumer Agent；提供能力和资源
的是 provider Agent。同一 Agent 可同时承担两种角色，双方均支持一对多。

Console Host 是观察/配置客户端，可以常驻但不要求常驻。关闭 Console 后，
已授权 Agent Work 和配置继续有效。OpenCode 仅作为推理型 Agent 的执行基座。
能力、资源、匹配和 work 以 [协作协议](teams-agent-relation-communication-v1.md)
为唯一语义真源；LLM 配置以 [provider 设计](teams-provider-config.md) 为准。

## 2. Daemon 启动与 relay 服务

每个 Agent daemon 启动即从本地配置获取 relay 服务入口、身份与凭据引用，
无需 Console 在场配置连接或代为登录。启动主线固定为：

```text
load daemon bootstrap config
  -> connect configured relay service
  -> login / identity admission
  -> register identity + publish capability/resource descriptors + presence
  -> subscribe scoped broadcasts / query directory
  -> request peer connection assistance / obtain permitted candidates
  -> establish authenticated Agent-to-Agent target
  -> capability match / Agent Work
```

bootstrap 至少包含 relayServiceUrl、Agent identity、credentialRef 和显式连接
策略。初始服务地址来自 daemon 配置，不能反过来依赖尚未登录的目录寻找它自己。
network 读取和校验 bootstrap 并连接；runtime 编排启动；server 执行登录准入。
登录失败不发布声明、不伪造在线；连接状态与 Agent 本地服务状态分别呈现。

“Relay 服务”是统一的服务角色，不仅指业务流量转发器：

| 服务能力 | server 职责 | 客户端 network 职责 |
|---|---|---|
| 登录与目录 | 认证、授权可见范围、身份/能力/资源声明与 presence 索引 | 登录、注册、目录查询与 freshness 处理 |
| 广播 | 在授权范围内分发上线、下线、声明与地址变化 | 订阅并更新已确认的目录投影 |
| 连接辅助 | 对端信令/候选交换、内网穿透协调、连接授权 | 验证候选并实际建立 target |
| STUN | 提供已声明的 STUN 服务/地址 | 探测映射地址，随后验证实际双向可达性 |
| 流量 relay | 提供授权的中继路径与连接生命周期 | 通过中继建立 Agent-to-Agent 逻辑连接 |

目录/广播/连接辅助是启动服务主线。STUN、具体穿透方式和中继端点通过服务能力
声明暴露；未部署的能力明确 unavailable，不假造成功。首版公网/NAT 的中继路径
仍须交付。STUN 只辅助地址发现，不保证打洞成功，也不等于 TURN 或流量中继。
具体 STUN/穿透实现与认证方案在网络里程碑选定，当前不预设必须新增 WebRTC。

能力与资源的广播仅发布描述、版本和可见状态，不预留资源；即使目录显示空闲，
真正匹配、配额检查与执行准入仍在提供方 Agent。relay 服务不成为 Agent master，
不决定 provider/model，不拥有业务关系与资源分配台账。

## 3. 三种网络资源

| resource | owner | 用途 |
|---|---|---|
| directory connection | network；目录声明由 server 保存 | daemon 启动后登录 relay 服务，发布能力/资源/地址并查询、订阅对端 |
| target transport | network | 两个明确端点之间的逻辑通信；经 direct 或 relay 建立 |
| logical channel | network | 在 target 上复用 Session、Agent Work、观察/配置流 |

directory 刷新不关闭健康 target。一个物理 relay 出站连接可承载多个 target；
每个 target generation 下的 channel 独立校验。不能把“每对 Agent 一个 target”
理解成“一台 Agent 只能连接一个 Host”。

server 负责账号范围、身份认证、连接准入和地址/能力声明发布。目标 Agent
仍需校验 capability policy 与资源准入；网络已连通不等于获准执行。

## 4. 公网/NAT 首版路径

首版包含 direct 与 relay。直连有可达目标地址时由显式 route 发起；NAT 场景
两端主动出站 WSS 到公网 relay，relay 将已授权 target 转发至目标 Agent。
任一 Agent 都可成为发起方；Console 不在 Agent-to-Agent 请求数据路径。
relay 服务可提供 STUN 和穿透辅助；实际路径由显式策略选择并验证。
不要求所有候选路径同时竞速，不以后台静默换路掩盖失败。

route 成功必须完成身份/版本/target hello，TCP/WS open 不算 Agent ready。
切换 route 必须显式退休旧 target、创建新 generation，旧帧拒绝；不得自动
重放有副作用的 request。directory 不可用时已有授权连接可按其有效授权继续，
不能跳过过期/撤销检查来新建连接。

公网入口禁止 auth=none；本机隔离测试可以明确声明无认证模式。
凭据只在 credential owner 与认证边界解析，不能进入业务 payload/日志。
server/relay 可组合部署，但 relay 不保存 Session/message 正文、不作关系决策。

## 5. Frame 与状态边界

控制帧承载 hello、版本、身份绑定、generation、health、channel lifecycle、
work/request 关联与 allocation 引用；Session/work 业务帧承载显式 operation
对应的输入、输出、消息、工具或审批内容。

现有 `control-protocol/frames.ts` 和 `channel-state.ts` 是当前已实现的 schema/
状态组件，尚未接入真实 Agent-to-Agent ingress。新增 work 与 config 帧须在
该 owner 扩展并同步验证，不能仅靠 TypeScript cast 接受网络 JSON。

target: connecting → ready → closed/failed。
channel: idle → opening → open → closing → closed，活动阶段可显式 failed。
未知身份/channel、版本不兼容、旧 generation、非法转移在拥有边界明确拒绝。
Session channel 和 Agent Work channel 不是同一语义；不能要求浏览器请求提供
OpenCode sessionId。通用 channel 控制与各业务接口分离，不复制第二套 transport。

业务 payload 允许合法对象/数组。控制面隔离依赖 typed envelope 与使用边界，
不以递归禁止业务字段名代替。CLI 输出、错误和模型返回保持原语义。

## 6. 生命周期与可观察性

Agent daemon 独立保存 config revision、work/policy 与实际请求/资源分配状态。
Console 重新连接只订阅当前投影，不恢复或重建 Agent 协作真相。
单 target 断线不能让其他 Agent 消失或取消无关 work。
请求超时可能是结果未知，只有能力方确认完成/失败/取消才能释放实际资源；
重复 request 不重复执行。resource allocation 详细契约见协作协议。

配置 mutation 属于独立 typed control command，目标 config 校验权限与 revision；
LLM provider 配置不会作为 Session prompt 传给 OpenCode。
CLI/browser Agent 没有 LLM provider 也是合法配置。

## 7. 验证

- 没有 Console 在线时，daemon 仅凭 bootstrap 配置完成 relay 登录、声明发布、目录查询与连接。
- 广播范围遵守授权；声明变化与离线/stale 可观察，重新登录/注册不产生重复身份。
- 服务能力缺失显式报告；STUN 映射发现与实际 target 建立分别验证。
- 两个不同 NAT 的 daemon 经 relay 匹配并完成请求；direct 独立验证。
- 被动浏览器 CLI 与两个 consumer 的一对多；Host 同时连接多种 capability。
- 关闭所有 Console 后协作继续，另一设备重新连接能观察真实状态。
- 未认证、跨账号未授权、capability 不匹配、资源耗尽均显式拒绝。
- target 重建、旧 generation、未知 channel、重复 request、结果未知不伪造成功。
- 推理型 Agent 经 RCC/显式 goaichat 执行；被动 Agent 不依赖模型配置。
- 同一候选 build/install/restart/public-entrypoint evidence 与 AppSDK admission。
