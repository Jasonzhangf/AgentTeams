# P0 服务接口冻结 r1

本文件冻结 N1/C1/W1 开发需要的最小接口，不宣称网络或资源台账已实现。
公共类型唯一入口：`control-protocol/agent-services.ts`，沿用控制协议 v2。
既有 Session 协议不被本文件替换。实现者遇到接口缺口须由主任务修改公共契约。

## 身份、relay 与 opaque 数据

`AuthenticatedAgent` 必须来自服务端认证结果。AgentDeclaration 中的 account/scope/agent
须与认证结果一致；不能从客户端自称的字段建立权限。登录前不注册、不广播。
identity 的 hostId/machineId 仍复用现有 HostIdentity。连接 generation 由服务器分配，
同一账号/作用域/Agent 重连替换旧连接，旧连接关闭事件不能注销新连接。

N1 使用 createRelayServer(options) 创建可关闭的 TLS/WSS 服务。options 由 server
owner 定义，注入 authenticate(credential) 与允许的目标策略，不导入 network 类型。
认证凭据只走握手 Authorization，不进入目录、日志或广播；TLS 默认验证证书。
部署所需证书/身份源由运行环境提供，不默认公网 auth=none。

控制连接使用 RelayClientControl/RelayServerControl；目录和广播范围仅来自认证上下文。
directory 的 subscribe=true 后推送 relay.changed；revision 由服务端单调递增。
publish declaration revision 必须递增；routes 仅是候选，不是可达证明。

relay.connect 核对双方身份、scope、generation 后签发有限有效期 RelayGrant。
发起端收到 relay.grant，对端收到 relay.offer；二者只有显式接受后才建立数据连接。
两端分别在专用 WSS 数据连接握手鉴权，再发送 relay.open；均匹配 grant 后打开双工转发。
grant 只绑定这一对连接，每端至多一条；过期、撤销、重连、未知 grant 明确拒绝。
控制连接仍可发关闭/错误通知；数据连接打开后的帧是 opaque bytes，服务端只转发，
不解析 Session/Work，也不从字节内容推断路由。任一侧退出关闭对应数据通道。
N1 可选择成熟 ws 包；根依赖变更由主任务处理。限制帧大小/连接数须显式配置和报错。

## Work/资源核心

W1 实现持久化 store，输入 AuthenticatedAgent 与本地 provider 身份/当前 generation，
不得以 WorkProposal.consumerAgentId 自称值代替授权身份。provider policy 注入，
其 revision 与 work 绑定；撤销阻止新请求。accepted work 本身不占资源。

核心操作：proposeWork、requestWork、getRequest、requestCancellation、completeRequest、
closeWork、confirmWorkDestroyed、recover。命名可按模块已有方式实现；输入输出使用公共类型。
requestWork 返回执行许可和 allocation 或已有请求状态；同 requestId 不重复执行，
参数不一致返回 CONFLICT。结果未知返回 unknown，不自动重新执行。
completeRequest 仅由本地可信执行 adapter 调用，consumer 不得自行声明完成以释放容量。

资源只支持可回收 slot/context；容量与 amount 均为正整数。exclusive capacity=1。
声明决定 allocationScope，consumer 不能覆盖；request-scoped 完成/确认取消后释放，
work-scoped 在 closeWork 且实际销毁确认后释放。跨请求复用 work allocation，
不能重复计费；需求变化显式拒绝。多项资源原子准入，不能部分分配后留下占用。
执行前持久化 reservation/request 身份；进程崩溃后对账，无法确认结束保持 unknown/held。
store 可由 agent owner 使用最小文件持久化实现，但必须防并发写入和崩溃撕裂；不得静默
以空状态覆盖损坏文件，也不把日志当资源真源。实际CLI子进程恢复由 runtime/I1装配。

## C1 config 与 OpenCode

模型及接口直接采用 `teams-provider-config.md` 第3/4节，由 config 目录独占定义，
不把 provider 模型复制到 control-protocol。runtime 调用 config 导出的 store 接口；
OpenCode adapter 接收明确输入，不能反向修改 config 的 accepted 真源。
模块必须报告 acceptedRevision/effectiveRevision 和结构化 apply error；写CAS原子持久化。
SDK {error} 和非成功状态不得变为空列表/undefined成功；只有已验证协议可启用。
Provider CRUD/模型刷新不实现推理请求栈；凭据通过独立 owner 注入解析器，引用为不透明标识。

## 开工与归属

主任务：公共类型/协议验证、legacy payload 数组/字段误拒绝、Session 明确选择、N2、集成。
三个 Luna：N1 server、C1 config/opencode-adapter、W1 agent，互不修改目录。
类型冻结只允许先并行实现各模块本地核心；跨模块/真实产品验收仍须P0其余语义修复和I1。
改根依赖、公共maps和生产入口需交给主任务，不能另开第二条共享写路径。
