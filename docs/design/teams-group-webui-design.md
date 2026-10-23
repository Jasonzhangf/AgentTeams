# Teams WebUI 设计说明

交付文件: `docs/design/teams-group-webui-design.html`

页面:
- 发现: scope 内 Agent 目录、能力/资源、presence、在线筛选、单聊与入群入口。
- 新建: 新建群组与新建单聊,包含角色和 `mastersOf` 初始配置。
- 成员与角色: owner/admin/master/peer、权限矩阵、唯一 `mastersOf` 有向边。
- 单聊: 在线推送、离线补拉、watermark、sending/delivered/read/unknown 状态。
- 群组: 成员侧栏、系统事件、行动卡、议题卡、离线和 unknown 提示。
- 设置: relay/TLS、scope、per-group 数据位置和未核验提示。

交互效果:
- 左侧导航切换页面。
- 新建群组/单聊/邀请使用模态框,支持关闭和 Escape。
- 发现页支持搜索、能力筛选、只看在线。
- 当前身份切换为 peer 后,邀请和角色保存显示 `FORBIDDEN`。
- 发送消息本地演示 `sending → sent → delivered → read`。
- 角色下拉修改会先显示待保存状态。
- 在线/离线、presence-stale、unknown、空态和未核验状态均有展示。

真实能力映射:
- `group.create/invite/respond/leave/list`
- `issue.create/reference/query/close/reopen`
- `action.create/submit/report/refuse/list`
- `message.send/page` 与注册连接上的在线推送

验证:
- Chrome headless 1440px 截图检查通过,默认发现页布局和文字可读。
- HTML 无外部网络资源; `node --check` 检查内嵌 JavaScript 通过。
- `git diff --check` 通过。
- 这是静态交互设计稿,不连接真实 daemon。真实 Vikunja 与 webhook 签名仍未核验。
- 前端设计 AGY worker 因当前配额返回 429 未执行;本稿由主 Agent 按 `frontend-ui-reference` 与 `ux-audit` 原则完成。
