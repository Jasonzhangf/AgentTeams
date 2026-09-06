# Agent 能力、资源与 Agent Work 协作

状态：design，替代 Console 必经 relay 的旧设计。本文拥有 capability、resource、
work 配对与关系语义；传输以 [v2 协议](teams-control-protocol-v2-master-agent-host.md)
为准。当前源码尚未实现本协议。

## 1. Agent 与角色

Agent 是通过 daemon 声明能力和资源的服务单元，不要求主动推理、LLM 或 OpenCode。
浏览器 Agent 可以只提供 CLI 操作。调用方称 Host/consumer Agent，能力方称
provider Agent；Host 不是 Console Host，一个 Agent 也可同时承担两种角色。

提供方可在资源容量内服务多个 Host；Host 可同时连接多个能力方、使用不同能力。
能力与请求必须适配到相同版本的接口；不能因名字相似而猜测协议兼容。

## 2. 主线

daemon 首先按本地配置登录 relay 服务，再通过该服务发布声明、订阅广播和
查询目录；无需 Console 代为发现或连接。Relay 服务启动与穿透边界见 v2 协议。

```text
能力方声明 capability + resource descriptor
  -> 经目录发布/广播，Host 发现
  -> Host 检查本地 adapter 与能力版本并发起匹配
  -> 能力方校验身份、policy、接口与资源，接受/拒绝
  -> 建立 Agent Work 配对
  -> Host 发起 request
  -> 能力方原子分配资源并执行
  -> result / explicit error 返回 Host
  -> 释放本次 allocation，配对继续或显式关闭
```

发布不等于授权或资源预留，匹配不等于无限执行权。目录只展示声明和 freshness；
资源可用性与实际准入始终以能力方为准。首版声明中的广播指 authenticated
directory publication/subscription，不要求 LAN multicast、gossip 或广播风暴。

## 3. Typed control resources

| 对象 | 最小字段 | 唯一 owner |
|---|---|---|
| CapabilityDescriptor | capabilityId、version、interfaceId、operations/schema、resourceIds | 提供方 Agent |
| ResourceDescriptor | resourceId、unit、capacity、revision、sharing、allocationScope=`request/work` | 提供方 Agent |
| AgentWork | workId、consumerAgentId、providerAgentId、capability/version、policyRevision、state | 能力方保存接受的 work；Host 保存自己的引用 |
| ResourceAllocation | allocationId、workId、requestId?、resourceId、amount、state | 提供方 resource owner |
| WorkRequestControl | workId、requestId、operation、targetGeneration、allocationRef | 已授权的 Agent Host channel |

提供方保留自己的资源台账；Host 不得凭目录缓存减自己的“可用资源”镜像后绕过
准入。多个 Host 的资源申请原子校验，超过 capacity 返回 RESOURCE_EXHAUSTED。
无状态操作按 request 分配；需要跨请求保持的浏览器 context 按 work 分配，
同一 work 的后续请求复用已授权 allocation。scope 必须由能力方声明，不能由
调用方猜测。超额明确拒绝，不新增隐藏队列或自动换 provider。
独占资源至多一个活动 allocation；共享资源的活动 amount 总量不超过 capacity。
首版资源契约限定可回收的并发槽位/context，不把 LLM token 数当作通用资源。
消耗型余额、时间补充配额需声明不同 accounting 契约，首版显式 unsupported，
不能在完成请求时错误地“归还”已消耗余额。

不在业务 payload 中携带 auth、generation、allocation 或关系权限。业务数据允许
合法 JSON 对象/数组；不能仅因业务字段名叫 config/token/resource 就判控制污染。
浏览器句柄等业务资源操作引用可以出现在接口定义的输入中；配额台账和授权仍留在
control resource，不从这些引用重建权限。

## 4. 匹配、请求与失败

work 状态：proposed → accepted → closing → closed，或 proposed → rejected。
能力版本不兼容、未授权、资源配置不可满足分别显式失败。撤销阻止新请求；正在
执行的请求按能力声明的取消策略处理，不能伪造已停止。

requestId 在 work 内唯一。重复请求返回已知状态/结果或明确不可重放；不得重复
执行。请求断线后可查询状态；调用方超时不等于执行结束。request allocation 仅在
执行确认完成、失败或确认取消后释放；work allocation 在 work 关闭且实际 context
确认销毁后释放，不能在一次 navigate 完成后归还仍被占用的 context。
daemon 重启后必须核对实际 CLI/子进程再回收资源，
不能因内存台账为空就重新分配仍被占用的资源。

初版不要求通用租约/调度框架；必须具备相称的持久化 request/allocation 标识和
恢复验证。响应结果未知时显式保留 unknown，禁止自动转给其他能力方重复执行。

CLI 是能力实现的一种接口，不是任意 shell 权限。提供方声明受支持 operation
及输入输出 schema，由本地 adapter 映射到固定 executable/argv，校验权限与路径。
不拼接远端输入为 shell 命令，不静默裁剪输出，不将非零退出码包装成功。

## 5. 关系组织

consumer/provider 是每个 work 的方向，不等同于全局 master/slave。
master/slave 是 Agent policy 授权的协调关系，peer 可由双向已接受的 work 组成。
一个 Agent 可同时为别人的 provider、另一些能力的 consumer。
能力 report 与资源 report 由各自 Agent 发布，Console 只读图投影。

同一 work 的双方报告按 Agent pair、capability/version、revision 检查；缺一侧
显示单侧状态，矛盾显示 conflict，旧 revision 不覆盖新状态。graph 不授予权限。
Console 不拥有持久化关系、资源或工作台账；全部 Console 离线不影响协作。
master Agent 离线显式影响它的 work，不自动把其他 Agent/Console 升为 master。

## 6. 浏览器例子

浏览器 B 声明 `browser/v1`，操作如 open/navigate/snapshot/close，由 CLI adapter
实现；声明 `browser-context` 资源 capacity=2、allocationScope=work。Host A、
Host C 分别建立 work，首次 open 各占一个 context，navigate/snapshot 复用各自
context；第三个申请明确资源不足。work 关闭并确认销毁 context 后释放槽位，
另一 Host 才可使用。capacity=2 是验收例子，不是产品默认值。

Host A 同时与浏览器 B、搜索 S 建立两个独立 work。B 可同时服务 A/C；A 可同时
消费 B/S。浏览器 B 不需要模型，也不需要有主动规划能力。

## 7. 验收

- 被动浏览器 CLI Agent 与推理型 Host 匹配、请求、完成，不要求 Console 在线。
- 不兼容接口、未授权、旧 revision/generation、未知 work/request 明确拒绝。
- 两个 Host 并发使用同一能力；第三个超容量拒绝；释放后可再申请。
- 一个 Host 同时使用两类能力；资源与错误彼此隔离。
- direct 与 NAT relay 各自回放；断线、取消、重复 request 与 daemon 重启不超卖。
- peer 与 master/slave 图可在另一 Console 重开后观察，关系分类不改变权限。
