# Teams WebUI 设计说明

交付文件: `docs/design/teams-group-webui-design.html`

页面:
- Relay 服务器: 添加、配置、连接/断开服务器，管理目录发现、推送、补拉、群组路由及连接限制。
- 发现: 按服务器列出 Agent；展示登录、健康、心跳、在线、能力与资源；支持多选批量邀请。
- 新建: 新建群聊与新建单聊；群聊成员接受后为每个 Agent 建立独立 session。
- 成员与角色: owner/admin/master/peer、权限矩阵、唯一 `mastersOf` 有向边。
- 单聊: 在线推送、离线补拉、watermark、sending/delivered/read/unknown 状态。
- 群聊: 可重命名；每个 Agent 独立 session；按 turn 展示输入、回复要求、最新进度卡和历史补发。
- 设置: 当前 relay/TLS、scope、per-group 数据位置和未核验提示。

交互效果:
- 左侧导航切换页面，并支持 `#servers` / `#discover` / `#group` 等深链接。
- Relay 配置、能力限制、重命名、历史管理、批量邀请使用模态框，支持关闭和 Escape。
- 发现页支持搜索、能力筛选、只看在线、跨服务器多选 Agent。
- 当前身份切换为 peer 后，邀请和角色保存显示 `FORBIDDEN`。
- 群聊每次发送创建一个 turn；@Agent 标记必答，其余 session 显示无需回复；每个 Agent 有独立进度卡。
- 发送消息本地演示 `sending → sent → delivered → read`；历史管理显示各 session 已同步/待补发轮次。
- 在线/离线、healthy/stale/degraded、unknown、空态和未核验状态均有展示。

真实能力映射:
- `relay` 配置与连接复用 `RelayServerOptions` 的连接数、授权数、payload 与 TTL 边界；群组消息仍走注册连接。
- `group.create/invite/respond/leave/list`
- `issue.create/reference/query/close/reopen`
- `action.create/submit/report/refuse/list`
- `message.send/page`，按成员 session 分发 turn 与历史

会话模型:
- 群聊与单聊都是独立会话空间，群聊改名不迁移 session 或历史。
- 群聊为每个成员开一个独立 session；每次更新是一个 turn，并按 session 分别输入。
- `@agent` 表示要求该 session 必须回复；未提及的 session 只同步、不要求回复。
- 每个 session 卡片显示最新执行进度与 turn 条；离线 session 保留待补发历史。

验证:
- Chrome headless 1440px 截图检查通过：服务器、发现、群聊、设置页面布局与文字可读。
- 通过 CDP 实际操作验证：跨服务器多选 2 个 Agent、批量邀请弹窗与发送、peer 身份下 FORBIDDEN 拒绝、
  relay 连接状态切换、群聊改名、带 @ 与不带 @ 的 turn 写入、历史管理补发入口。
- HTML 无外部网络资源，`file://` 直接打开样式完整；`node --check` 检查内嵌 JavaScript 通过。
- `git diff --check` 通过。
- 这是交互设计稿，不连接真实 daemon。真实 Vikunja 与 webhook 签名仍未核验。
- 前端设计 AGY worker 因配额 429 未执行；本稿由主 Agent 按 `frontend-ui-reference` 与 `ux-audit` 原则完成。
