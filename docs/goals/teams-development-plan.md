# Teams 开发总计划

状态：`implementation-ready / draft`
项目：`Teams`
治理：AppSDK `0.1.6`

## 目标

优先交付可安装、可复核、可验收的 OpenCode 多 Agent 控制台：Topology 按 Machine -> Agent 定位，Agent Card 一次点击进入当前 Session，Conversation 复用 OpenCode 宿主能力，Notifications 按重要性和时间直达 Agent 或 Session，Search/Memory 作为独立插件接入，Desktop/Mobile 共享语义而仅改变排版。DSH 适配延期，不作为当前发布前置。

## 阶段顺序

1. Phase 0：候选、module registry、resource/function/mainline/verification map 与 AppSDK 绑定。
2. Phase 1：五入口 UI、current-session fast path、nested drawer、Desktop/Mobile layout。
3. Phase 2：OpenCode `PluginInput/Hooks/SDK` adapter、Session/Event/permission owner 接入。
4. Phase 3：Console Hub、network link、server admission、Shared Runtime Config、daemon lifecycle。
5. Phase 4：consumer/provider 双边 relation report、graph projection、notification center 与 approval 跳转。
6. Phase 5：Search index/cache/query 与 Memory summarize/validate/save/load/export 生命周期。
7. Phase 6：Machine connection、per-Agent provider/model、Mobile 高风险确认和权限边界。
8. Phase 7：OpenCode 长运行 hook、真实 session/permission/notification sink 闭环；DSH adapter deferred。
9. Phase 8：candidate-bound install/restart、OpenCode live smoke、1440x960 与 390x844 回放、AppSDK records、review、merge/push。

## 硬门禁

- 每个 milestone 一个 semantic claim、分支和 `playground/<issue-or-task>` worktree。
- 控制面字段、auth、permission、routing、retry、health、diagnostics 只能走 typed control resource；不得进入业务 payload 或 metadata。
- OpenCode 只走 `PluginInput/Hooks/SDK`；不得复制 Session、Conversation 或 transcript owner。DSH `ClientContext/Slots` 适配延期。
- 无 fallback、silent strip、静默覆盖或重复 owner；权限由 server truth 决定，relation label 不产生权限。
- 未完成 candidate 安装、重启、真实入口和桌面/移动浏览器回放，不启动 AGY Review，不申报发布完成。

## 当前缺口

- OpenCode 宿主 adapter 已有白盒实现；真实 session、permission、notification sink 和安装闭环仍未通过。
- Console Hub/runtime/network/config/server 尚无真实部署证据。
- OpenCode 长运行 hook、Search/Memory/Notification/Settings live evidence 尚待补齐。
- AppSDK candidate、whitebox、install、restart、blackbox、pre-review records 尚未由正式 producer 生成。

## 验收顺序

`appsdk verify Teams` -> 定向测试/typecheck/bundle -> deterministic compile -> candidate install/restart -> OpenCode live session/permission/notification smoke -> Desktop/Mobile Camo replay -> PreReviewValidation -> review -> effectiveness -> merge/mainline receipt -> promotion/freeze。

## OpenCode-first 适配审计（2026-09-02）

### 审计结论

当前 `opencode-adapter/src/index.ts` 只有事件和权限的纯投影层：它可以把 OpenCode `session.*`、`message.updated` 和 `permission.ask` 转换为 Teams notification，但还不能独立完成可用的 OpenCode 控制台适配。缺口是：真实 Session 列表/当前 Session 读取、Session 对话发送入口、审批结果回写、长运行 server hook、notification sink 与 Teams UI/Console Host 的绑定、安装后 public entrypoint 验证。

DSH adapter 不进入本阶段实现、安装、验证或 release admission。现有 DSH 源码和设计仅保留为 deferred scope，不从 worktree 删除。

### 当前必须实现的适配

1. OpenCode host adapter：以 `PluginInput`、公开 SDK 和 `Hooks` 为唯一宿主边界，提供 server/plugin 的安装入口；接收 session、message、status、permission 生命周期；投影为 typed Teams control notifications；不把 routing、permission、health 或 provider/model 控制字段混入 Session 业务 payload。
2. OpenCode Session adapter：通过 OpenCode SDK 读取 Agent/session 列表和当前 session，提供 current-session fast path；Session 对话、消息发送、工具结果和 transcript 继续由 OpenCode owner 处理，Teams 只持有引用和投影。
3. OpenCode approval adapter：将 `permission.ask` 映射为可定位到 Agent/Session 的 interactive notification；用户的 allow/deny/reply 必须经 OpenCode SDK/Hooks 回写，不能由 UI 本地改变权限 truth。
4. OpenCode notification sink adapter：建立宿主事件到 Teams notification center 的唯一 sink，支持 pending/processed、priority/time 排序、Agent badge 和直接跳回 Session；sink 不保存 Session body、tool output 或 approval body。
5. Teams Console Host adapter：把 OpenCode host connection、machine/agent identity、runtime config、relation report、search/memory plugin projection 聚合给 UI；UI 只消费 typed projections，不直接依赖 OpenCode、network、config、server 或 runtime truth modules。
6. UI layout adapter：保留现有五入口、Agent Card 当前 Session 快速入口、nested drawer、header 上拉全屏/下拉关闭；默认桌面居中 modal，`max-width:800px` 才切手机全宽底部布局。UI 不因 OpenCode-first 改变语义，只替换宿主数据和动作绑定。
7. Search/Memory plugin adapter：Search 提供 connect/index/cache/query；Memory 提供 summarize/validate/save/load/export；二者必须有独立 typed input/output 与 lifecycle，不通过 UI 临时状态冒充插件能力。

### 明确不做

- 不实现 DSH `ClientContext/Slots`、DSH Conversation mounting、DSH current-session bridge 或 DSH live smoke。
- 不让 Teams UI 成为 OpenCode transcript、permission 或 session 的第二 owner。
- 不把 OpenCode 事件直接当作业务消息 payload，也不在 UI 侧重建控制面权限。

### 适配文件范围

- `Teams/opencode-adapter/src/index.ts`：OpenCode hooks、SDK session/permission bridge、typed notification sink。
- `Teams/opencode-adapter/tests/**`：事件、session、permission、sink、生命周期和正反向边界测试。
- `Teams/ui/teams-console/src/client/**`：只补 typed host projection/action binding；保留桌面默认和手机断点布局。
- `Teams/agent/**`、`Teams/network/**`、`Teams/config/**`、`Teams/server/**`、`Teams/runtime/**`：按各自 owner 补齐 OpenCode host 所需的控制面主线，不交叉复制。
- `Teams/search-plugin/**`、`Teams/memory-plugin/**`：插件输入/输出和生命周期接入。
- `.appsdk/maps/**`、`Teams/docs/architecture/**`：同步 module、resource、function、mainline、verification map；DSH 条目保持 `deferred`。

### 验收矩阵

| 适配 | 必须证明 | 证据 |
| --- | --- | --- |
| OpenCode host | 官方 plugin shape 可安装并加载 | package typecheck/build + 安装后 import/server smoke |
| Session | 能发现 agent/session，当前 session 可直达并发送消息 | SDK live session smoke + 正反向 session tests |
| Approval | ask 可进入 Teams notification，allow/deny 真实回写 | OpenCode permission ask live smoke + sink evidence |
| Notification | event 唯一进入 notification center，pending/processed 可区分 | sink tests + live event replay |
| Console Host | machine/agent/config/relation 只走 typed control projection | boundary tests + host live smoke |
| UI | 五入口、抽屉和默认桌面/手机排版保持行为一致 | desktop `1440x960`、mobile `390x844` Camo screenshots/replay |
| Search/Memory | 独立插件可连接、查询/保存/加载/导出 | plugin lifecycle tests + live adapter evidence |
| Governance | candidate 到 pre-review evidence 绑定同一 commit/artifact | AppSDK lifecycle producer + review admission |

### 实施顺序

1. 先补 OpenCode adapter 的 Session/permission/sink contract 和白盒测试。
2. 接入 Console Host 的 typed projections 与 action dispatch，完成当前 Session fast path。
3. 接入 Search/Memory plugin lifecycle。
4. 建立隔离 OpenCode server，安装 candidate，跑真实 session、permission、notification smoke。
5. 用 Camo 回放桌面和手机尺寸，验证 UI 语义一致及默认桌面排版。
6. 运行 AppSDK lifecycle producer、review admission、架构 review、effectiveness 和发布流程。

### 完成定义

OpenCode plugin 可从发布包安装并启动；Teams 能发现多个 Machine/Agent/Session，Agent Card 可直接进入当前 Session；Session 消息和审批由 OpenCode owner 实际执行；通知可从 Agent badge、notification center 直达 Session 并完成 allow/deny；Search/Memory 通过独立插件生命周期工作；桌面默认排版、手机断点和抽屉交互真实回放通过；AppSDK records、review、merge/push 和远端 receipt 完整闭合。DSH 仍明确为 deferred，不计入本阶段完成条件。
