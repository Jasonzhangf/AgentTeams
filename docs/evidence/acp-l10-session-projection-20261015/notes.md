# L10 session-projection: the Console projection carries the real Session and the real permission identity

日期：2026-10-15。分支 `codex/acp-l10-session-projection-20261015`。base `origin/main`
`83496b7`（"docs(evidence): record the L9 session-write-side integration receipt"）。

## 1. 目标与结论

本单元只交付一件事：控制 daemon 的**真实 Console 投影**不再是空的，它携带 agent daemon
自己引擎里真实存在的 Session，以及真实的 permission 身份。

L9 的验证门把这一项写成 retained obligation：控制 daemon 当时仍回
`sessions: []` 与 `notifications: []`。L10 关闭它。

结论：**已交付，并用真实入口黑盒证明**。协议未改。选择仍然沿用「无 control→agent 通道」
这一既有约束下唯一自洽的形状：**agent daemon 把自己 host 里的事实写成一条持久记录，控制
daemon 读那条记录**。由此：

- Session 与 permission 的真源仍在拥有它们的 agent daemon 的 `AcpHost` 里；
- Console 不进入数据路径，只从控制 daemon 自己的投影读；
- 不新增 control→agent 通道，不新增 relay，不新增协议字段；
- `session.create` / `session.open` 仍是 typed `UNSUPPORTED_OPERATION`。

未交付的部分照旧明确列出，不从任何一层证据推断：`sessionEvents` 仍未投影（因此 Console 的
approve 按钮仍不可用），notification 的 title 是固定的 Console 标签而不是引擎给出的主题，
投影里还会出现 daemon 自身 readiness 通道持有的 Session，硬崩溃（无 SIGTERM）后最后一次
观测会继续被投影。本单元是 **source-tree 证据层**：没有 installed-copy、restart、
deployed-entrypoint replay 或跨设备回执。

## 2. 决策依据与被否决的候选

约束是既有的、已核验的拓扑事实：`agentteams --serve opencode` 起的 agent daemon 没有
Session 事件流，只有 `AcpHost` 事实；控制 daemon 不声明任何 Teams listener，因此不存在
control→agent 通道。

1. **控制 daemon 直接向 agent daemon 查询**：需要一条 control→agent 通道，而它不存在，
   新建它正是被否决的形状。
2. **Console 作为中继**：Console 是可选、非永久的观察/配置客户端，不能成为必需的 data path。
3. **agent daemon 发布持久观测记录**：本单元采用的唯一候选，它是「无新通道」约束下唯一
   自洽的形状：写者拥有事实，读者拥有投影。

被否决的候选记录在 `docs/evidence/acp-l10-session-projection-20261015/design.md`，并由
`docs/architecture/mainline-call-map.json` 的新 chain/edge `acp-session-observation-v1`
写成可核对的顺序事实；`acp-session-write-v1` 的备注同时更正为「L10 通过观测读路径交付该
身份，而不是通过写路径」。

## 3. 记录形状、路径与所有权

`config/session-observation-store.ts`（version 1）承载投影行快照：

```
<home>/.agentteams/sessions/<accountId>/<scopeId>/<agentId>/session-observation.json
```

与 L9 的 pending-Session-write 记录同级同布局，因此两侧都从自己 accepted 的身份解析路径，
**不新增配置键**。两条记录是兄弟而不是一个 store：它们的写者、读者与失败语义不同。

记录只装投影行：`sessions[].sessionId` 与
`permissions[]{notificationId, sessionId, permissionId}`。它**不装**transcript、permission
option set 或任何凭据。`permissionId` 就是 controller 收到的那个 callback id；
`notificationId` 由它派生（`permission:<permissionId>`），不引入第二套身份。

校验按最小充分原则：重复的 `sessionId`、重复的 `notificationId`、空身份，以及「permission
指向同一份快照未报告的 Session」都被 typed 拒绝；损坏或版本不支持的记录是 typed throw，
绝不修复、绝不覆写。

## 4. 实现要点

- `agent-host/acp-host.ts`：新增只读 `openedSessions()`，报告**仍然打开的通道**真正持有的
  Session id；`pendingPermissions()` 早已是 permission 事实的唯一 owner。两个 wrapper
  （`network/teams-ingress.ts`、`network/teams-egress.ts`）同步转发。
- `runtime/session-observation-publisher.ts`：按命名间隔轮询这一个 host，去重排序 Session，
  丢弃 host 已不再报告的 Session 的 permission，**只在观测真的变化时写**（一次轮询不是一次
  心跳）；另一 agent 的字节以 `FORBIDDEN` 拒绝且不覆写；`REVISION_CONFLICT` 时回到
  `seeded=false` 重新对齐而不是猜测覆盖。
- `runtime/control-process.ts`：`readObservedSessionProjection` 为每个声明的 peer 解析一条
  路径并映射成投影行，`agentId` 用真正拥有该行的那个 agent。directory readback 报告为
  **非 online** 的 peer 不贡献行；directory **未报告**的 peer 不被当作 offline（没有
  registry 的部署没有 liveness 真源，而 agent daemon 会在自己的 `stop()` 里发布空观测）。
  一条损坏或归属错误的记录只跳过并报告，不阻塞其它 peer。
- `runtime/acp-serve.ts`：在既有命名间隔上运行 publisher，并在 `stop()` 里 `host.close()`
  之后发布一次空观测，因此停掉的 agent 行会消失，**不需要超时启发式**。
- `config/durable-record.ts`：把原子写收敛成一份实现（mode `0o600` 临时文件 + rename，
  以及 `applied` / `failed` / `uncertain` 三种结果）。intent store、它的 watermark、本
  store **与 relations intent store** 共用它，**L9 记录的 F4「重复的持久写 helper」由此关闭**：
  `config/relations-intent-store.ts` 里自己那份 `persist` / `uncertainty` / `discard` 已删除。

## 4a. 独立 review 的两个 minor 与修法

独立 reviewer（`openai-codex/gpt-6.1-sol`，全新上下文，未运行任何测试）对本候选给出
**2 minor + 4 advisory**。两条 minor 都已修复并重新取证，4 条 advisory 全部按证据收口。

1. **minor：stop 时空观测可被轮询写抢走**。`publish()` 原本没有重入保护，而轮询 tick 与
   `stop()` 的发布共用同一个 publisher；`clearInterval` 不能取消一个已经开始的 pass。若 tick 的
   写在 `stop()` pass 读到同一 revision 之后、store 内部读旧内容之前落盘，`stop()` pass 会得到
   `REVISION_CONFLICT` 并直接返回，停掉 daemon 的非空观测就留在盘上继续被投影。
   修法：publisher 改为**一次只跑一个 pass**，后到的调用串到在飞的那个 pass 后面（与既有
   `createPollingProjectionSubscriber` 的 `running` 惯例一致），因此 `stop()` 的 pass 一定跟在
   在飞的轮询 pass 之后；`stop()` 处不再 `.catch()`——publisher 的 pass 本身永不 reject。
   新 spec（`runtime/session-observation-publisher.spec.ts`「serializes overlapping
   passes」）以「第一次读有 Session、第二次读没有」的假 host 绑定：去掉串行化后该用例从
   `revision=2 / sessions=[]` 退回 `revision=1 / sessions=[ses-1]`，红测成立。
2. **minor：F4 只关了一半**。`config/relations-intent-store.ts` 仍保留自己一份字节级相同的
   原子写，而 notes、`verification.json` 与两张地图都宣称 F4 已关闭。修法：迁移到
   `writeRecordAtomically`，删除该文件里的 `discard` / `uncertainty` / `persist` 三处重复实现。
   `config/relations-intent-store.spec.ts` 与 `runtime/relations-intent-watch.spec.ts`
   **18/18 passed，exit 0**，证明行为未变（`gate-l10-review-fixes-relations.log`）。

四条 advisory 的收口：`verification.json` 里 `sessionEvents` 的断言归属改为黑盒与控制 daemon
组装投影的真实位置；`verification-map.json` 的 L10 门补上引擎结束通道这一**真的用例**
（`agent-host/acp-host.spec.ts` 新增）；单 home / 单 account / 单 scope 限制写进 gaps 与
retained；`failures()` 只被 handle 暴露、没有生产读者这件事写进 retained，`acp-serve.ts` 的
注释随之改为「pass 永不 reject，拒绝记录在 handle 上供读者读」。


## 5. 证据分层（每层只证明自己）

**source**：本 worktree，base `83496b7`，提交见第 9 节。

**test（模块与相邻套件，均 exit 0）**：

| 证据 | 结果 |
| --- | --- |
| L10 门命令 6 文件 | 85 passed / 6 files |
| `config/session-observation-store.spec.ts` | 8 |
| `runtime/session-observation-publisher.spec.ts` | 7 |
| `runtime/control-session-projection.spec.ts` | 5 |
| `config/session-intent-store.spec.ts` | 12 |
| `agent-host/acp-host.spec.ts` | 26 |
| `runtime/control-process.spec.ts` | 27 |
| F4 迁移受影响的两个 spec | 18 passed / 2 files |
| `pnpm typecheck` | exit 0 |

红测（mutation）证据按项记录：去掉 store 的跨 Session 校验与 CAS 校验 → 3 个失败；去掉
publisher 的无变化早退与跨 Session 丢弃 → 2 个失败；去掉 publisher 的 pass 串行化 → 1 个
失败；去掉投影的 online 闸门与归属校验 → 2 个失败；去掉 `releaseSessions` 里
`channel.sessions.clear()` → **2 个**失败（关闭通道与引擎结束两个用例）。全部恢复后重新跑绿。

消融证据：`openedSessions()` 里对 `closed` 的过滤被证明无法改变任何行为（mutation 不失败），
因为两条关闭路径都在标记 `closed` 之前跑 `releaseSessions`，因此该过滤被删除——忘记 Session
的 owner 只有 `releaseSessions` 一条规则，不再有第二份。

**build**：`pnpm build`（含 opencode-adapter）exit 0。

**真实入口黑盒**：`docs/evidence/acp-l10-session-projection-20261015/black-box-session-projection.mjs`，
**31/31 checks，exit 0**，receipt 见同目录 `receipt.json`。它同时起真实 control daemon 与真实
`--serve opencode` agent daemon（各自真实 loopback listener 与真实 engine 子进程），用真实
OpenAI 兼容 stub provider 触发真实的 `session/request_permission`，并作为 controller 持有真实
ACP 连接。它证明的关键事实：

- 任何 Session 之前，观测记录**不存在**（诚实的缺席，而不是空占位）；
- 记录里的 `sessionId` 是引擎真实返回的那个；permission 行的 `permissionId` 是 controller
  真实收到的 callback id，`notificationId` 由它派生；
- 无变化时 revision 不变（约 5 秒静默窗口内两次读一致）；
- 控制 daemon 的真实 `/api/v1/projection` 携带 Session 行与 pending notification 行
  （`kind=permission`、`state=pending`、真实 `permissionId`/`sessionId`、非空 title）；
- 真实 `/api/v1/events` SSE 快照携带同样的行（快照由 owner 的投影驱动，不是 driver 造帧）；
- 未带声明凭据的投影读被 401 拒绝；
- 控制 daemon 的 data directory 里没有观测记录（单写者）；
- driver 通过 ACP 回答 callback 后，permission 行在更晚的 revision 消失，Session 行保留；
- 关闭 controller 通道后，**该通道自己的 Session** 消失，其它仍打开的通道持有的 Session
  仍在（真实发现：daemon 自己的 readiness 通道持有它自己的 Session）；
- SIGTERM 真实 agent daemon 后，**由它自己**发布的空观测让两个投影行都消失。

**installed artifact / restart / deployed-entrypoint replay / 跨设备**：无。本单元不改安装
产物，也没有对应回执。`sessionEvents` 不在本单元，黑盒把它当作「不存在」断言，而不是当作
已交付。

## 6. 全量回归：三跑与已证实的既有竞态

`pnpm test`（1201 tests）三次结果：

| 跑次 | 结果 | 失败项 |
| --- | --- | --- |
| 1 | 1173 passed / 5 failed | 含 `cli/agentteams.spec.ts` 与 4 个真实引擎/Work 用例 |
| 2 | 1175 passed / 3 failed | `agent-process.spec.ts`、`managed-opencode-session.spec.ts`、`cli/agentteams.spec.ts` |
| 3 | 1175 passed / 3 failed | 同上三项 |
| 4（修复后候选，1203 用例） | 1174 passed / 6 failed | 上述三项 + 三个真实 DOM 用例（`render.spec.ts`、`render-d07.spec.ts`、`focus-dom.spec.ts`） |

失败集不稳定，且**集中在与本变更无关的既有 spec**：第 4 跑的 6 个失败 spec 在本单元
`git diff 83496b7..HEAD` 中**全部为空**。其中 `cli/agentteams.spec.ts` 的
`generated/runtime-lib/.../http-api.js` ENOENT 有确定性根因：它的 `beforeAll` 跑
`pnpm build:runtime`，而同一轮并行执行的 `cli/package-install.spec.ts` 的 `beforeAll` 跑
`pnpm build`（同样删除并重建 `generated/runtime-lib`）。两个 hook 在 `origin/main` 上都已存在，
且本单元 `git diff origin/main` 对这两个文件为空——该竞态先于 L10。

把三个失败 spec 单独跑：**74/74 passed / 3 files**，全部通过。修复后候选的第 4 跑失败集换成
6 个 spec，单独跑（真实 DOM 三个用 `TEAMS_CONSOLE_REAL_DOM=1`）：**80/80 passed / 6 files**，
exit 0。因此结论是：这些失败是并发行负载、真实浏览器/真实引擎时序与既有派生产物竞态造成的
环境性失败，不是本变更引起；本单元**不宣称全量回归为绿**，只宣称 L10 门与上表模块证据为绿。

## 7. 保留义务（明确未交付）

1. **`sessionEvents` 仍未投影**。冻结的 pending-permission `ConsoleSessionEventView` 需要
   `messageId`，而 `AcpPendingPermission` 不携带消息身份，因此 Console 的 approve 按钮
   仍渲染 `data-permission-options-unavailable`。黑盒明确断言投影里没有 `sessionEvents`，
   以防该能力被误算作已交付。
2. **notification title 是固定的 Console 标签**（`Permission request`）。ACP callback 携带
   的是 options 而不是主题，本单元不编造主题，也不用 Session id 伪造。
3. **投影也包含 daemon 自身 readiness 通道的 Session**。`verifyReadiness` 在常驻通道上跑
   了一次真实 `session/new`，该 Session 真实存在并被诚实报告；「Console 是否应列出没有
   controller 的 Session」是 Console 表面的决定，本单元不做（需要一个通道归属标记）。
4. **硬崩溃后最后一次观测仍在**。没有 SIGTERM 时 daemon 来不及发布空观测，而没有 registry
   报告该 peer 时也没有 liveness 真源；本单元**没有发明超时启发式**。`agents[]` 的 presence
   仍由 registry 拓扑的真实 liveness 承载。
5. **观测路径只在同 home、同 account、同 scope 下诚实**。读侧解析
   `<home>/.agentteams/sessions/<声明 peer 的 accountId>/<scopeId>/<agentId>`，写侧用自己的
   `daemon.accountId` / `scopeId`；两者不同、或两个 daemon 不在同一台机器时，投影**静默为空**
   （与 L9 记录同一限制）。本单元没有引入第二条路径或默认值来掩盖它。
6. **`sessionObservation.failures()` 没有生产读者**。拒绝记录在 handle 上，与既有的
   `sessionIntent` / `relationsIntent` handle 同一形态；本单元没有为它新建日志面。
7. **遗留 Work 侧 obligations** 与 L9 的其它 retained 项不因本单元改变。

## 8. 治理与地图

五张地图在同一变更内更新：`function-map.json` 新增 `session_observation_projection`；
`resource-map.json` 新增 `session-observation-record`；`mainline-call-map.json` 新增 chain 与
edge `acp-session-observation-v1`；`module-registry.json` 的 `config` 与 `runtime` 追加本轮
事实；`verification-map.json` 新增 `teams-acp-l10-session-projection` 门（含黑盒真实入口）。
`pnpm verify` 仍被既有的 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014` 阻塞，与本变更无关。

review 轮次又更新了三张地图：`verification-map.json` 的 L10 门新增「publisher 一次只跑一个
pass」这条 check 并把实测数字改成 85/6 与新的 mutation 计数，`function-map.json` 与
`module-registry.json` 的 F4 陈述改成 relations store 也共用同一条纪律（并且已真的迁移）。
`verification-map.json` 的 L9 intent-side 门补记本次迁移与 72/4 的复测结果——**一次变更同时
改动两张门的语义，两张门都在同一变更内更新**。

## 9. 提交、集成与资源

待填（见 receipt 与集成回执）。
