# AgentTeams 流程、架构与最小反馈审计

日期：2026-10-24。审计者：Alice，验收 peer。授权：用户要求直接修设计/文档，代码问题
发现即交 Jenny 编排，第一 MVP 与实现现状对齐。本记录是本轮结论与交接，不是第二个任务账本。

## 结果与范围

设计和文档已直接修订。产品实现问题已交 master；不能据此宣布全产品已修复。
本轮读取主线 `f759ecc`、群聊候选的相关边界、五张架构 map、28 张业务图、用户路径
证据提交 `e644b1c` 和群通信第一批/接线证据。主树旧 checkout 及其两份未提交原型保留。
本轮在独占 `mvp-design-ablation` 文档树编辑，带入已有原型，不触碰 Bob/Carol 的实现树。
`.appsdk/requirements.json` 不存在，未补造；需求来自项目 AGENTS、既有计划及用户明确决定。

审计覆盖项目声明的主流程及其 owner/反馈/交付边界；不是逐行源码审计，也没有重新运行
所有服务。运行缺陷复用归档的真实用户路径证据，静态问题单独标记。图通过只证明静态拓扑。

## 架构与交互逐段处置

| 流程 | 保留的唯一职责/必要反馈 | 本轮处置与实现接力 |
| --- | --- | --- |
| 安装、启动、停止 | runtime 组合生命周期；显示实际入口、可用能力、失败与资源责任 | MVP 计划删过期安装/worker 状态，不删 BB01/08/14；启动成功不写成业务可用 |
| 发现、连接、关系 | server 管发现/传输准入，network 管连接，Agent 管工作准入；accepted 与 connected 分开 | 拒绝与恢复入口纳入最小反馈，禁止为消除错误自动放宽 allowedManagers；默认 Console 502 交 Jenny 去重处理 |
| 配置 | config 唯一用户意图；派生引擎配置只读；accepted/effective 分开 | 不为一次保存建立多重确认/成功通知；保留生效读回、CAS、凭据失败与显式 provider 选择 |
| Work 请求与查询 | provider 持有真实执行/资源账本；查询不重放；Console 可关闭 | 保留完整 BB04–09/11；UI 未呈现结果复用现有问题，禁止用 startup receipt 或 Session 历史代替 Work |
| ACP Session、工具与权限 | Agent/adapter 保真与准入；permission 使用引擎真实选项 | 保留 BB10/12；session/new 只证明初始化，不能升级成推理；取消请求不等于终结 |
| 群、邀请、共享消息 | 群共享可见；action 指派决定执行；群管理权不扩展为指挥权 | 一次建群/邀请后进入群；待接受就地展示；消融 ACK 往返和逐层成功提示 |
| issue、action 与关闭 | Vikunja owns 开闭；hub owns action 与操作记录；执行 owner 写回 | 保留未知、稳定提交、迟到消息、物理停止事实；参与者写回即结束，追问新建 action；不自动互答 |
| 群/议题/身份切换 | UI 仅保留相应视图状态；认证 owner 决定可见范围 | 设计明确上下文隔离、旧响应不覆盖新视图、已有议题可恢复；与原群聊任务一起落实 |
| 状态投影、卡片与动效 | 业务变化驱动对应区域；汇总与卡片有不同职责 | 原型修复评论抹掉汇总、多 action 被最新项掩盖；重复阶段 toast 删除，演示工具折叠；真实 SSE 无变化重绘交 runtime/UI owner |
| 历史与错误 | Work/connection/Session 各自读取真实 owner；错误只隔离受影响区域 | 未绑定 owner 明确不可用且有下一步，不伪造空成功；History 修复单 `805b950` |
| 图、验证、审查与交付 | maps 归属不变；真实行为验证、一次 milestone review、集成及资源收尾 | MVP 计划压缩；开发管控删除重复审查与日常指纹要求；实现残余建单 `28f8373`，不得伪造 SDK 准入 |

没有证据支持把群真源下放到 UI、把 Console 放进 Agent Work 数据路径、让日志重建状态、
合并 Work 与 ACP 历史或引入第二个同步 owner。本轮保留这些架构边界，没有为消融减少
安全、持久化、幂等和必要行为校验。13 个群图及其余 15 个图未改拓扑；本轮逐图 validate
均通过。静态节点链中的 typed outcome 契约仍需对应实现测试，不能从 SESE 推出失败无副作用。

## 已直接修改

- `docs/goals/teams-user-delivery-plan.md`：改为目标、真实现状、owner、用户反馈和 BB01–BB14。
  移除过期派单表、私人恢复入口、重复阶段名、候选/hash 清单和全量重验要求；14 项义务保留。
- `docs/goals/teams-long-running-delivery.md`：把已获授权群聊增量加入范围关系；旧 Work、ACP、
  群聊各用自身证据；不再让旧“未来自动协作”文字否定当前授权。
- `docs/development-governance.md`：一次完整 milestone review，finding 定向复核；普通文档
  定向检查；不加平行进度/身份账本；协作结果结束本轮，无 action 不自动互答。
- `docs/design/teams-group-webui-design.md`：直接规定逐阶段必要反馈、删除项、上下文隔离、
  多 action 可见性、无变化不重绘和首版真实产品验收；协议引用更新到 revision 5。
- `docs/design/teams-group-webui-design.html`：带入此前已授权原型；本轮修正汇总、卡片，
  演示控件默认折叠且操作后保持展开，移除重复阶段 toast。它仍是内存模拟。
- 全局 `ux-audit/SKILL.md`：在唯一交互审计入口补充跨阶段消融方法；删除一项不改变正确
  决策/执行/恢复时才删，不删权限、未知、停止责任、无障碍或验收。未新增 Skill 或流程模板。

本轮不改历史 receipts、不改用户需求以适配缺失实现、不写 managed memory，
不修改官方 SDK 的生成 Skill 或控制状态。

## 已发送的实现工作

| 问题/任务 | 证据与最小结果 | 接收者 |
| --- | --- | --- |
| `8dde877` 群聊既有五项 finding | unknown 被读请求清除、建群 loading、上下文迟到响应、全局 action/旧议题恢复、真实入口缺口；沿原任务复核，不重复派候选 | Jenny 已确认 Bob 前端、Carol 后端/协议，Jenny 集成与浏览器验收 |
| Work 可见性 | projection 已有 Work 而 UI 无结果；历史问题引用须核实当前原因，不能把旧“缺 projection 字段”标题直接当根因 | Jenny 去重到已有 Console 工作并安排 owner |
| `805b950` History 不可用 | 已安装入口 503；按历史种类接真实 owner，不借 Session 历史代替 | Jenny 已登记 |
| `ee3399a` SSE 无业务变化更新 | 相邻帧只变 observedAt 与 seq；保留新鲜度语义，消除输入区重建/重复播报 | Jenny 已登记 |
| `28f8373` 日常生命周期包装 | 静态确认 scripts/lifecycle-adapter.mjs 的候选/指纹复用链与当前规则冲突；先分离 SDK 必需与项目冗余；保留 BB13 和真实安装证据 | Alice 已建单并发 Jenny，待安排回执 |

主要消息：`m1792901621123-1126`、`m1792901691593-1141`、`m1792902044468-1185`。
Jenny 的安排回执为 `m1792901761207-1154`。发送持久入队不等于代码修复或最终验收。
架构五图中的旧路径/候选描述，由对应代码迁移 owner 同步适用项；本轮不覆盖活动实现者的 map。

## 本轮检查

- 28 张既有业务图：`dagpipe graph validate` 全通过；图未修改，不推导运行成功。
- MVP 文件包含 BB01–BB14，逐项对照保留成功、失败、权限、幂等、真实副作用和资源收尾。
- 文档差异通过 `git diff --check`；本轮未运行产品构建、服务或安装测试。
- Ego 浏览器操作原型：普通评论后仍显示在飞行动；同一 agent 第二项 action 显示两项未结束，
  汇总注明此前行动；演示默认折叠，推进状态后保持展开且不再重复 toast。
- 390×844 窗口：无水平溢出，输入区底部 843px；截图经过目视检查。此处是桌面浏览器窄屏，
  不是移动设备、软键盘或真实产品验收。测试 TaskSpace 已关闭。

下一步由 Jenny 接收文档提交并集成，按原任务补产品证据。Alice 对实现保持独立验收；
本次直接参与的设计修改不宣称经过自己的独立 review。实现未交付项保持开放。
