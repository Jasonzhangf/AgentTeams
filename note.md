# Teams Notes

## 2026-08-31

- 基线：新建 `Teams/` 作为独立 AppSDK 项目；现有 `maui-0830` UI 设计只读复用。
- 架构边界：`network` 负责链路配置、transport、health；`config` 负责共享配置真相、版本和同步；`server` 负责部署、监听、服务端连接 registry、账号和权限 admission；`runtime` 合并编排 daemon 生命周期与 network connection lifecycle；`agent` 保持网络无关；DSH/OpenCode 各自 adapter 接入。
- 启动主线：Bootstrap Link Config -> network dial -> server account/permission admission -> Shared Runtime Config sync -> runtime ready -> capability publication -> agent running。
- 控制面与业务 payload 物理隔离；machine、endpoint、generation、health、auth、permission、routing、retry、diagnostics 不进入业务 payload 或 metadata。
- UI 已落盘：Agent Card 主操作直接进入当前 Session；Session 复用现有 DSH Conversation；drawer header 上拉全屏、下拉关闭，内容区保持可操作；Desktop/Mobile 共享语义，仅 layout 不同。
- 详细设计 v1 已落盘：五入口分别解决物理位置、时间、重要性、内容和长期上下文；Settings 由 gear 进入；Search/Memory 保持独立插件生命周期；通知可直达 Agent 通知页和 Session approval；静态 HTML 作为唯一 UI reference fixture。
- 控制协议 v1 已落盘：本机 Teams Federation Host plugin 聚合层；不做 Machine pairing，使用可选 shared API key/token 无状态一致性校验；Relation 是 consumer/provider 双边 capability-use report，server 汇总生成 graph projection；Mobile 允许连接、Agent provider/model 和审批权限配置；Host-to-Host 命令；配置冲突使用 revision compare-and-swap。
- 实现默认值已冻结：Teams 只保存 opaque credential reference；Host 提供 Machine/Agent canonical name，Console alias 只是本地投影；relation report 每 30 秒 heartbeat，90 秒无刷新投影为 stale，历史保留。
- 设计状态已推进为 implementation-ready。下一步固定为 Slice 1 shared UI semantic vertical slice，然后 Slice 2 DSH focused Session adapter；两步完成后再做架构 gate、构建、安装和真实 runtime smoke。
- 现状：仅设计和治理契约；未创建 runtime plugin，未做本轮 DSH/OpenCode live 安装验证。
- 实现轮验证：隔离 DSH `web-deps-canary` 使用 `dsh 0.1.1-rc.2` 在 `127.0.0.1:3187` 返回 HTTP 200，boot manifest 和 `--dump-config` 均包含 `@deepseek-ai/teams-console`；Camo `0.4.2` 在 `claw-user-full-0830-r2` 的 1440x960 与 390x844 页面均显示 Teams，五入口、Agent 通知徽标、通知抽屉和全屏/关闭控件已被真实浏览器观察。
- 实现轮验证：DSH client `tsc`、6 个测试、bundle 通过；OpenCode adapter `tsc`、5 个测试、ESM bundle、in-process event/permission projection 和 OpenCode `1.18.23` 隔离 plugin install 通过。OpenCode 包入口已修正为 `lib/index.mjs`，发布 files 与实际产物一致。
- 实现轮边界：Camo 在窄视口点击侧栏入口和点击当前 Session 时出现 `WS timeout` / `input_pipeline locked`；移动端改为桌面打开后缩放验证通过，但当前未取得从 Agent Card 到 DSH Conversation 的浏览器点击闭环证据。真实 DSH live smoke、当前 Session fast path、drawer accessibility 和 desktop/mobile equivalence 仍为 `partial`，未启动 AGY Review、未 commit/push、AppSDK 仍为 `draft`。
- 2026-08-31 架构地图校正：DSH bundle 链路改为真实符号 `runProfile -> composeProfile -> prepareProfile -> loadProfile -> composeEntries -> boot -> mountRootInclude -> WebServer[Service.init]`；`profileBoot` 和 `webserver` 不再作为伪函数符号。`deepseek-harness` 通过 external boundary 表达，Teams module registry 不拥有其源码路径。
- 2026-08-31 AppSDK 编译首轮暴露治理边界问题：`ui/**` 会穿透本地 `node_modules` symlink，导致 `HASH_TREE_SYMLINK`。已把 module owned paths 收窄为 Teams 当前真实源码、配置和测试文件的显式 globs，避免把依赖目录纳入模块哈希。
