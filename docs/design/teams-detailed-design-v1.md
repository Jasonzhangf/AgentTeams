# AgentTeams 产品交互与执行边界

状态：设计。部署与 owner 以 [概要设计](../goals/teams-overview-design.md) 为准；
provider 以 [配置设计](teams-provider-config.md) 为唯一真源。

## 用户入口

| 入口 | 内容与动作 |
|---|---|
| Topology | Machine/Agent summary、明确连接状态、peer/master-slave；主动作进入 current Session |
| Conversations | 按 Agent/时间浏览 Session，展示消息、工具事件，发送与取消 |
| Notifications | pending/processed、priority/time、Agent badge，定位到对应 Session 的审批 |
| Search | 插件 connect/index/cache/query，结果携带来源引用和必要摘要 |
| Memory | 插件 summarize/validate/save/load/export，区分未保存草稿与已保存记录 |
| Settings | provider 实例、模型、Agent binding、关系策略与连接设置 |

Console 可以离线；再次打开时从 Agent 获取当前 accepted/effective revision、
状态和关系 report。UI 不把自己的选择、缓存或连接存活当作 Agent 状态。
master/slave 由 Agent 关系 policy 决定，Console 只展示和提交授权配置。

## Conversation 与抽屉

Teams 自己呈现 Conversation，OpenCode 拥有持久化和实际执行。UI 不复制 transcript
真源，不从标签、消息内容或关系分类推导权限。不支持的映射在 adapter 明确失败。

- Desktop 默认居中 modal，完整圆角并保留上下留白；800px 以下手机全宽底部抽屉。
- 共享语义组件。实体抽屉可追加多层；关闭返回来源并恢复焦点。
- header 上拉全屏、下拉关闭；内容滚动、选择不触发拖动关闭。
- dialog、焦点陷阱、Escape 关闭顶层、触屏目标、缩放、reduced motion 必须验证。
- 审批显示 Agent、Session、请求内容和动作；按钮状态不代替实际执行结果。
- current Session 来自执行基座明确状态，不用列表第一条猜测。

## 实时与失败

连接区分 connecting、connected、stale、reconnecting、disconnected、unauthorized、
error。通知发生时间来自事件 owner；审批依据实际结果更新。拒绝、冲突、超时、
结果未知分别显示。一个 Agent 离线，其他 Agent 保持可操作。

仅选中 Session 后订阅其完整流；全局只订阅 summary。Session 正文、工具输入输出
不裁剪。UI 不从 render、日志或业务 payload 重建连接、配置与权限真相。
Search/Memory 未接通前明确显示不可用，不使用“已连接”占位文案。

## 验收

桌面 1440×960、手机 390×844 验证布局，真实手机蜂窝网络验证跨设备入口。
同一候选覆盖卡片 → current Session → 消息/工具/审批 → 通知收口，抽屉嵌套与
焦点恢复，以及关闭 Console 后 Agent 协作继续、另一 Console 读回最新状态。
OpenMinis UI 不在复用范围；旧宿主依赖的工程拆除作为迁移工作实施。
