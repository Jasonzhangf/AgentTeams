# L9 session-write-side: the Console Session writes really reach the engine

日期：2026-10-14。分支 `codex/acp-l9-session-write-side-20261014`。base `origin/main`
`d531d242550c5588b0c59483776c0ab3115f0eaf`（L11 已合入）。

## 1. 目标与结论

本单元交付**冻结的 Session 写侧命令**：`permission.reply`、`session.cancel`，以及
`ConsoleClientV1.sendSession` 的专用 Session body 入口。此前它们在 control daemon 上被
统一以 typed `UNSUPPORTED_OPERATION` 拒绝，因此「Console 发起的 Session 写」从未真正到达引擎。

结论：**已交付并用真实入口黑盒证明**。协议未改——冻结的 `ConsoleCommandV1` 本来就带这三个
命令，本次只补上施加点。机制复用 2026-10-14 用户对 `connection.connect` 记录的决策：控制
daemon 只做一次持久 CAS 写，agent daemon 自己观察并自行施加，**不新增 control→agent 通道，
Console 不作数据中继**。

未交付的部分照旧明确列出，不从任何一层证据推断：Session/notification **投影**仍未交付
（控制 daemon 仍回 `sessions: []` 与 `notifications: []`），`session.create`/`session.open`
仍为 typed `UNSUPPORTED_OPERATION`，本单元是 source-tree 证据层，没有 installed-copy、
restart、deployed-entrypoint 或跨设备回执。

## 2. 决策依据与被否决的候选（A4）

`docs/design/teams-acp-daemon-config-v4.md` 新增第 14 节 amendment A4，它把该决策写进
设计契约并列出被否决的两个候选，使选择可审计：

1. **进程内 `ControlOwnerBinding` 委托**：需要一条 control→agent 传输，而这条通道不存在。
2. **直接 control→agent ACP 传输**：正是该决策禁止的「新通道」。
3. **复用持久 intent 记录**：A4 采用的唯一候选。

`docs/architecture/mainline-call-map.json` 新增 chain `acp-session-write-v1` 把整条路径的
每一步写成可核对的顺序事实，并更正了 `acp-webui-v1` 里「`permission.reply` 走
`POST /api/v1/command` 直接送引擎 optionId」这一已经过期的描述：命令携带的是 Console 的
`decision`，由拥有该 Session 的 agent daemon 解析出引擎 optionId。

## 3. 记录形状、路径与所有权

`config/session-intent-store.ts`（version 1）承载**事件**记录，形状与已交付的
`config/relations-intent-store.ts` 同族：单调 revision 上的一道 CAS 栅栏、mode `0o600`
临时文件 + 原子 rename、临时写失败记 `failed`、rename 失败记 `uncertain` 并给出真实
栅栏而不是猜测结果、记录损坏抛 typed 错误而绝不覆写。

A4 与关系记录有一处**必要**差异：关系是期望状态，重读安全；Session 写是事件，重复施加
不安全。因此记录携带有序窗口（上限 `SESSION_INTENT_WINDOW = 256`）与 `oldestRevision`，
读侧把自己的 consumed watermark 存在**自己的 data directory**，一条记录只有一道 CAS 栅栏。
读侧落在窗口之外时报告诚实的 `behind` 拒绝，而不是静默跳过——永久无法施加的一条写最终会
把读者推过 256 的窗口，届时缺口以诚实拒绝暴露，而不是被悄悄吞掉。

路径为每个目标 agent 一份：

```
<home>/.agentteams/sessions/<accountId>/<scopeId>/<agentId>/session-intent.json
```

写侧从自己 accepted 的 `peers` 解析目标身份、account 与 scope，读侧取自己的
`daemon.id`/`daemon.accountId`/`daemon.scopeId`；冻结的 `PeerIntent` 不携带 peer 的
dataDirectory，故按约定共享根推导，**不新增配置键**。一条记录对应一个目标 agent 的理由是
「一把钥匙一把锁」：一个写者、一道栅栏、一个读者，因此一个 daemon 的失败不会阻塞另一个
agent 的记录。未声明的 agentId 以 `FORBIDDEN` 拒绝且**不写记录、不猜路径**。

## 4. 施加映射与 A2.6 未被削弱

`runtime/acp-serve.ts` 新增 `createSessionIntentWatch`，在既有 500ms 具名 interval 上轮询
并把写入施加到**本 daemon 自己的 host**。三种映射就是引擎自己的 ACP 帧：

- `permission.reply` → 对引擎待决 `session/request_permission` 回调的 JSON-RPC 响应，
  `id` 用控制器收到该请求时的 callback id。Console 的 `decision` 选中 **projected kind
  相同的引擎选项**，引擎未提供的 decision 以 `INVALID_ACP_FRAME` 拒绝，绝不发明 optionId。
- `session.cancel` → 该 Session 的 `session/cancel` 通知。
- Session body → `session/prompt`，body 原样透传（不解析、不改写、不裁剪）。

按 revision 顺序施加，遇到第一条无法施加的写就停止且**不推进水位**，因此顺序被保留、没有
写被静默跳过。读侧不知道、也无法发明两件事实，所以 `agent-host/acp-host.ts` 暴露两个只读面：

- `pendingPermissions()`：每个仍未收到控制器回复的引擎回调，带 ref、Session、控制器可见的
  permission 身份和引擎真实选项集；
- `channelForSession(sessionId)`：拥有该 Session 的 host-facing ref；**已关闭的 channel 不
  被报告为 owner**（它无法接收任何写）。

A2.6 未被削弱：过期、缺席或歧义的回调一律 typed 拒绝，绝不变成批准。host 自身 history 的
record id 仍是独立的持久审计身份，两者在 `AcpPendingPermission` 里被明确区分。

## 5. 源码改动与计数（实测）

| 交付 | 落点 | 实测 |
| --- | --- | --- |
| 事件记录存储 | `config/session-intent-store.ts` + `.spec.ts` | 11 tests |
| host 两个只读面 | `agent-host/acp-host.ts` + `.spec.ts` | 24 tests（原 23，+1） |
| 读侧 watch | `runtime/acp-serve.ts` + `runtime/session-intent-watch.spec.ts` | 12 tests |
| 控制侧三条命令 | `runtime/control-process.ts` + `.spec.ts` | 24 tests（原 23，+1） |
| **本单元门禁** | `pnpm exec vitest run --no-file-parallelism config/session-intent-store.spec.ts runtime/session-intent-watch.spec.ts runtime/control-process.spec.ts agent-host/acp-host.spec.ts` | **71 passed / 4 files**，退出码 0（`gate-d06-l9.log`） |
| `pnpm typecheck` | 根 + opencode-adapter + console-host + ui | 退出码 0（`typecheck.log`） |
| `pnpm build` | 全量（opencode-adapter + console-host + ui + build:runtime） | 退出码 0（`build.log`） |

`network/teams-ingress.ts` 与 `network/teams-egress.ts` 的 `observingHost` 包装器转发这两个
新读面，注释写明理由：包装器观察 channel 生命周期，不得隐藏它包裹的东西。

agent 侧新增导出：`SessionIntentWatchFailure`、`SessionIntentWatchInput`、
`SessionIntentWatch`、`createSessionIntentWatch(input)`、`agentSessionIntentPath(home, daemon)`；
`AcpServeHandle` 增加 `sessionIntent: { path, watermarkPath, failures() }`；`stop()` 在关闭
relations 观察的 egress 之前先 `clearInterval` Session 观察。

## 6. 既有门禁的回归（同一候选）

| 门禁 | 命令（verification-map 原命令） | 结果 |
| --- | --- | --- |
| `teams-acp-d01-host` | `acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts` | **58/58**，`gate-d01-host.log` |
| `teams-acp-d05-network` | 11 个 spec 文件 | **103/103**，`gate-d05-network.log` |
| `teams-acp-serve-entry` | `runtime/acp-serve.spec.ts runtime/relations-intent-watch.spec.ts cli/agentteams.spec.ts` | **68/68**，`gate-serve-entry.log` |
| `teams-acp-d06-control` | 7 个 spec 文件 | **137/137**（control-process 24、relations-intent-store 10、acp-host 24、acp-serve 27、agentteams 33、http-api 7、console-api 12） |
| `teams-acp-l9-session-write-side` | 4 个 spec 文件（修复后复测） | **71/71** |
| `teams-acp-l9-intent-side` | 4 个 spec 文件 | **69/69**（10+8+24+27） |
| `teams-acp-d07-webui` | `TEAMS_CONSOLE_REAL_DOM=1` + 13 个 spec 文件 | **66/66**，`gate-d07-webui.log` |

D06 与 L9 intent-side 两个门禁的文件集合之并一次跑完为 **168/168**（10 个文件），
逐文件计数见上（`gate-d06-l9.log`）。

`teams-acp-d07-webui` 的既有证据 `docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs`
**未重跑**：它证明的是那套 config 与那组断言，本单元没有改它断言的任何断言点，且本次对该
门禁的影响只由源码门禁覆盖。重跑该 driver 会得到与本单元无关的结论，故不计入证据层。

## 7. 真实入口黑盒

`black-box-session-write.mjs`（本目录）：一个真实 `control start` 控制 daemon、一个真实
`--serve opencode` agent daemon、一个真实 OpenCode 引擎进程、一个真实的
`session/request_permission` 回调，以及一条 raw-TCP newline-JSON ACP 控制器连接（**只**用
来开 Session 与驱动引擎，不用它回答回调）。stub provider 的真实规则是「一个会话只在还没有
tool 结果时给出 tool_call」。

driver 全程只经控制 daemon 的**认证** HTTP 面提交写入，从不经自己的 ACP 连接回答回调：

| 步骤 | 断言 | 结论 |
| --- | --- | --- |
| a | 三条 Session 写是一次 CAS 写，结果只回 `acceptedRevision`，记录路径为 `<home>/.agentteams/sessions/local/local/l9sw-agent/session-intent.json`，不产生任何 Session 状态 | 写侧真实 |
| b | Console 的 `permission.reply` 之后，driver 从未向引擎回答过回调，而**driver 发出的 prompt 完成**；agent daemon 自己的 durable history 记下它回复的正是引擎真实 dispatch 的 `callback.dispatched`，`callback.reply` 的 `frame.result.outcome = {outcome:'selected', optionId:'once'}`，选的正是引擎真实提供的 optionId；水位推进到 1 | 读侧真实，且是引擎真实选项 |
| c | Console Session body → daemon 以自己的 `id=session-intent-<uuid>` 发出真实 `session/prompt`（history 有 `request.dispatched`），引擎收到的文本含 driver 独有的标记 `l9sw-body-1` | body 原样到达引擎 |
| d | 新 `session/new` 得到真实 sessionId → body（revision 3）→ 真实权限回调（**driver 从未发送该 prompt**）→ `session.cancel`（revision 4）→ daemon 发出的 prompt 以 `stopReason: cancelled` 结束；水位到 4 | cancel 真实生效 |
| e | 新 `session/new` → body（revision 5）→ 权限 pending → 发明一个引擎从未等待的 `permissionId` 再 `permission.reply`（revision 6）→ **记录前进到 6 而水位停在 5**，且该 prompt 在 6 秒内不结束 | 过期权限不产生批准，控制 daemon 不代答 |
| f | 未声明的 agentId 对两条命令与 Session body 均 typed `FORBIDDEN`，且记录未被触碰 | 路径不猜 |
| g | 无凭据时 `/api/v1/command` 与 `/api/v1/projection` 均 401 | 认证未被绕过 |
| h | 认证后的投影可读，且控制 daemon 报告 `sessions: []` | 不伪造 Session |

实测 **49 checks / exit 0**，`receipt.json` 记录了 control/agent/engine 三个真实 pid、
引擎实例 id、记录路径、水位与各步骤的原始事实。

## 8. 记录的证据范围限制

- 本单元是 **source-tree** 证据层：黑盒经源码 CLI 入口启动（worktree 的
  `generated/runtime-lib`），不是安装产物；installed-artifact 层留给 L12。
- 引擎用的是本地 OpenAI-compatible **stub provider**，不是上游真实模型；因此本单元证明
  「写入真实到达引擎并被引擎真实接受」，不证明任何模型质量或推理正确性。
- 无 restart、无 deployed-entrypoint、无跨设备、无多账户证据。
- 单 agent / 单记录；「一个 daemon 的失败不阻塞另一个 agent 的记录」由设计推导与存储层
  测试承载（记录按 agent 分片），未由多 daemon 黑盒并列证明。

## 9. 全量回归的状态（不作为本单元结论，也不作为「已通过」）

三次运行按同一命令 `scripts/regression.mjs` 完成，均为同一根因的抖动，不是本单元的回归：

| 运行 | 工作树 | total / passed / failed / skipped |
| --- | --- | --- |
| 工作树未提交候选 | 未提交 | 1172 / 1146 / 3 / 23 |
| base `d531d24` 独立 worktree | 未改一行 | 1149 / 1146 / 3 / 0 |
| **已提交候选 `fb35e73`**（第 1 次） | 干净 | **1173 / 1172 / 1 / 0** |
| **已提交候选 `fb35e73`**（第 2 次，同一内容） | 干净 | **1173 / 1167 / 6 / 0** |

日志：`regression-committed-candidate.log`（候选）、`baseline-origin-main-regression.log`（base）。
可判读的事实有四条：

1. `cli/package-install.spec.ts` 的 23 条 skipped 在**已提交**候选上消失（23→0），
   因为 `scripts/receipt-identity.mjs` 不再拒绝这个候选。这正是预期的：该门禁只在已提交候选上运行。
2. 三次运行唯一的共同失败是
   `agentteams CLI direct node entry avoids source TS parameter properties…`，
   而该文件单独跑 33/33 通过，隔离后也 3/3 通过。base 上它以**同一根因**失败。
   根因是 `scripts/regression.mjs` 不传 `--no-file-parallelism`，而
   `cli/agentteams.spec.ts` 与 `cli/package-install.spec.ts` 的 `beforeAll` 都会重建同一份
   `generated/runtime-lib`；并行跑时 `agentteams.mjs init`/`status` 读到半份产物，
   于是第二次 `init` 不报预期的 `already exists` 而报底层错误。
3. 未提交候选那次还失败的 `executes remote Work…` 与 `sends one real OpenCode Session request…`
   在已提交候选上通过，base 那次失败的 `D07 four-page DOM` 与 `declared capability rendering`
   在本单元的 D07 门禁（`TEAMS_CONSOLE_REAL_DOM=1`，13 个文件）里同样 66/66 通过——
   这四条是真实进程/真实 Chrome/真实引擎的负载抖动，不是固定回归。
   **同一份已提交内容再跑一次得到 6 条失败**（1 → 6），新增的 5 条全部是真实
   Work agent、真实 OpenCode Session 与真实 Chrome DOM 的超时用例，只有 CLI 直入那条两次都在。
   这直接证明失败集合由环境负载决定，而不是由本单元的代码决定。
4. 因此这些失败**不是**由本单元引入：本单元没有改 CLI 装配、`generated/runtime-lib` 的构建
   或 DOM 渲染路径；D01/D05/D06/D07/serve-entry 六个门禁命令在候选上全部通过。

`scripts/regression.mjs` 在本候选上 **exit 1**；在**未改一行的 base `origin/main` `d531d24`**
的独立 worktree 上同样 **exit 1**。两者都不是本单元引入的回归，证据如下：

| | 候选 | base `d531d24` |
| --- | --- | --- |
| total / passed / failed / skipped | 1172 / 1146 / 3 / 23 | 1149 / 1146 / 3 / 0 |
| 失败用例 | CLI 直入 `direct node entry`；`executes remote Work in an actual Agent process`；`sends one real OpenCode Session request through the selected managed provider` | CLI 直入 `direct node entry`；`D07 four-page DOM contract`；`declared capability rendering` |

两个日志：`regression-full-suite.log`（候选）、`baseline-origin-main-regression.log`（base）。
可判读的事实有三条：

1. **CLI 直入用例在 base 上以同一根因失败**：`cli/agentteams.spec.ts` 的 `beforeAll` 与
   `cli/package-install.spec.ts` 的 `beforeAll`（后者跑 `pnpm build`）都会删改同一份
   `generated/runtime-lib`，而 `scripts/regression.mjs` 不传 `--no-file-parallelism`，
   vitest 默认并行跑 spec 文件，于是 `agentteams.mjs status` 读不到 `generated/runtime-lib/...`
   而失败。候选里该文件单独跑 33/33 通过（`gate-d06-l9.log`），隔离后三连通过。
2. **其余失败是真实进程 / 真实 Chrome / 真实引擎的超时用例**，两次运行各自失败集合不同，
   属于负载敏感的抖动，不是固定回归。
3. 候选报告里 `skipped=23` 的 23 条全部来自 `cli/package-install.spec.ts` 的
   `beforeAll`：它跑 `scripts/package-artifact.mjs --mode base`，而
   `scripts/receipt-identity.mjs` 拒绝**未提交/有未跟踪文件**的候选（`staged product does
   not match the recorded index`）。这是工作流事实，不是代码缺陷：`package-install` 门禁按
   设计只在**已提交**候选上运行。本单元的集成提交完成后重跑该门禁即可闭合此项。

因此本单元按映射门禁 + 类型检查 + 构建 + 真实入口黑盒判定，并把这三次运行的差异如实记录；
不把任何一次 `exit 1` 说成通过，也不把它们说成本单元的回归。`pnpm verify` 仍**未运行**：它是
先于本单元的 BLOCKED 基线（`PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014`）。

## 11. 第二次 review：FAIL 与三个 BLOCKING 修复（2026-10-15）

第二次独立 review（`subagent`，只回文本、同样未落盘）给出 **FAIL**，三个 BLOCKING finding。
本单元 owner 逐条独立核对，**三条全部为真**，已全部修复并各附红先证据。该 review 同时**驳回了**
上一轮的三条论点（F1 假、F2 继承、F3 假），与本单元 owner 的核对一致。

### 11.1 F1（BLOCKING）冻结契约的 `permission.reply.optionId` 被丢弃

- 证据：`control-protocol/console-api.ts:424-426` 的冻结命令带 `readonly optionId?: string`
  （注释：Engine option chosen from the pending event's option set），parser 在 `:506-510` 校验它；
  shipped Console 确实发送它（`ui/teams-console/src/client/controller.ts:499-500`、
  `render.ts:410`/`:563`）。
- 缺陷：`runtime/control-process.ts` 构造记录变更时**没有带 `optionId`**，store 类型也没有该字段，
  于是 `runtime/acp-serve.ts` 的读侧用 `row.options.find(candidate => candidate.kind === intent.decision)`
  **按 kind 猜第一个**。当引擎提供两个同 kind 选项时，引擎收到的是与操作者点击**不同**的真实 optionId，
  而 Console 无法察觉（结果只回 `acceptedRevision`，投影属 L10）。这违反项目不变量
  「Unsupported or lossy protocol, parameter, or network mapping fails explicitly at the owning adapter boundary」。
- 修复：`optionId` 作为可选字段贯通 store 类型、校验、`parseIntent`、意图构造与 `control-process`；
  读侧**优先使用**写侧命名的引擎选项，命名选项不存在或与 `decision` 矛盾时以 `INVALID_ACP_FRAME` 拒绝
  （不猜），只有未命名时才回退到 kind。
- 红先证据：`runtime/session-intent-watch.spec.ts` 新增用例用两个同 kind 选项
  （`allow-always-a`/`allow-always-b`）并命名第二个。把命名分支改成 `if (false)` 即转红：
  `- "optionId": "allow-always-b"` / `+ "optionId": "allow-always-a"`。复原后 15/15 通过。
- 真实入口证据：黑盒现在在 `permission.reply` 里发送引擎真实 `optionId: 'once'`，并断言
  **durable 记录原样携带**它（50 checks、PASS）。该引擎的 optionId 恰好等于 projected kind，
  故黑盒这一步**不能**区分「命名」与「按 kind 猜」；这个区分由上面的 spec 证明。此边界已在黑盒注释写明。

### 11.2 F2（BLOCKING）500ms interval 的两次 pass 可以重叠

- 缺陷：`startAcpServe` 用 `setInterval(..., 500)` 调用 `void sessionWatch.reconcile()`，没有 in-flight 保护。
  一次 pass 超过 500ms（慢引擎 + 文件 IO）时两次 pass 会同时读到同一个 watermark，从而**重复施加**
  同一条 `session.message`（引擎收到两次 `session/prompt`）。`void` 还会把抛出的 rejection 变成
  unhandled rejection，可能拖垮 daemon。
- 修复：`createSessionIntentWatch` 增加 in-flight 守卫（重叠的那次直接返回），并把整个 pass 包在
  `try/catch` 里，异常记为 typed refusal 而不是逃出 interval 回调。
- 红先证据：新增用例让 host 的 `receive` 阻塞在 gate 上，等第一次 pass 卡住后再发起第二次 pass，
  再放行。去掉守卫即转红：`expected [ … ] to have a length of 1 but got 2`。复原后通过。
  （注：第一版用例依赖 microtask 顺序，去掉守卫仍然通过，属无效用例；已改为显式等待使其确定性转红。）

### 11.3 F3（BLOCKING）一次 CAS 栅栏是 check-then-act，可丢写且双方都报成功

- 缺陷：`sessionWrite` 先 `readSessionIntentRecord` 再 `writeSessionIntentRecord(path, current.revision, …)`，
  而 store 内部的 CAS 也是「先读、后 rename」。两个并发 Console 命令可以**都读到 revision N**，
  随后**都 rename**：后者的 rename 覆盖前者，一条 intent 丢失，而**两条命令都返回 `ok: true`**。
- 修复：控制 daemon 是该记录设计上的唯一写者，故把本 daemon 自己的写入串行化
  （`serializeSessionWrite` 的 promise 链）。并发第二次写入因此读到前一次的结果并 CAS 成功。
- 红先证据：新增用例用 `Promise.all` 并发提交两条 `session.cancel`。去掉串行化即转红：
  `expected 1 to be 2`（记录 revision 为 1，即丢了一条），而两条命令都报 `ok: true`。复原后通过。
- 未收口（advisory，非本单元引入）：`config/relations-intent-store.ts` 的同形 check-then-act
  在已合入的 relations 写路径上仍然存在；本单元只修自己这条记录。

### 11.4 已处理的 advisory

| finding | 处理 |
| --- | --- |
| F4 复制了原子 temp+rename / watermark 实现 | 未修，记为保留义务。`config/session-intent-store.ts` 与已合入的 `config/relations-intent-store.ts` 在 `fail`/`decode`/`discard`/`uncertainty`/`persist` 上同形；抽公共 helper 需要同时改动已合入代码，故不在本增量做。 |
| F5 `verification.json` 身份过期 | 已修：`candidate_head`/`candidate_tree`/`candidate_commits` 更新到最终提交；并修掉 `gate_tests` 与 `gate_result` 不一致。 |
| F6 门禁 check 数与被跑文件数不符 | 已核对：`checks` 是**断言条目**（11 条），`command` 是 4 个 spec 文件，`note` 记录实测通过数；已把 note 的数字更新为修复后的实测值。 |
| F7 A4 末尾写了错误的门禁名 | 已修：`docs/design/teams-acp-daemon-config-v4.md` 末尾由 `teams-acp-d05-network` 改为 `teams-acp-l9-session-write-side`，并保留一行说明与日期。 |
| F8 D07 行/check 仍断言被取代的拒绝 | 已修两处：`docs/architecture/verification-map.json` 的 D07 check 文本、以及 `docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs` 的断言。该黑盒原先断言 `permission.reply` 回 `UNSUPPORTED_OPERATION`；在本单元的无 `peers` 配置下它现回 `FORBIDDEN`（同一条目标规则，且在写入前拒绝）。更新后重跑：**15 checks、exit 0**。 |
| F9 记录缺少 span 校验与记录身份 | span 已修：`parseRecord` 现在要求 `intents.length === revision - oldestRevision + 1`，否则 typed `INVALID_INPUT`。此前一条手写 `{revision:10, oldestRevision:1, intents:[5 条]}` 会被正常读取，读侧把 watermark 推到 10 并**静默跳过** revision 6..10。红先证据见 `config/session-intent-store.spec.ts` 新增用例（去掉校验即转红）。**未修**：记录文件被删除/重建后 watermark 高于新记录 revision 的场景需要记录 generation id，记为保留义务。 |

### 11.5 修复后复测（同一冻结源码）

| 检查 | 结果 |
| --- | --- |
| 本单元门禁（4 文件） | **77/77** |
| D06 门禁（7 文件） | **139/139** |
| L9 intent-side 门禁（4 文件） | **71/71** |
| D01 host（3 文件） | **58/58** |
| D05 network（11 文件） | **103/103** |
| serve-entry（3 文件） | **68/68** |
| D07 WebUI 黑盒 | **15 checks / PASS** |
| L9 session-write-side 黑盒 | **50 checks / PASS** |
| `pnpm typecheck` / `pnpm build` | exit 0 / exit 0 |

## 10. Review 轮次与修复（2026-10-15）

### 10.1 review 尝试的诚实记录

本单元共发起三次独立 review，**三次都没有产出 review 文件**：两次 `subagent` 与一次复用既有
teammate 都只回了散文式结论，没有落盘。`review-1.md` 不存在（`ls` 与 `git status` 均为空）。
因此**本单元没有可引用的独立 review PASS 回执**，这一点必须明说，不能用散文结论顶替。

第一次 review 的结论是 PASS，且**自相矛盾**：它把 F1 标为 BLOCKING，随后又写「All findings are
ADVISORY」。第二次 review 的「Measurements」里出现了不存在的输出（把 receipt 的 `verdict` 写成
`applied`，实际是 `PASS`），说明它没有真正运行黑盒。因此两次结论都**不可采信**。

### 10.2 对 review 论点的独立核对（由本单元 owner 实测）

| review 论点 | 核对结果 |
| --- | --- |
| F1「`sessionWrite` 在 `uncertain`/`failed` 时仍返回成功」 | **假**。`runtime/control-process.ts:640` 是 `return relationsWriteResult(await writeSessionIntentRecord(...))`，而 `relationsWriteResult` 只在 `status === 'applied'` 时回 `{ok:true}`，`uncertain`/`failed` 都回 typed 错误。reviewer 误读了控制流。 |
| F2「`sessionWrite` 把目标 account/scope 泄漏给控制 daemon」 | **不是本单元引入**：写侧从**自己 accepted 的 `peers`** 推导路径，与已合入并 review PASS 的 relations 记录同一条规则；peer 声明写错时 agent daemon 只是读不到，不会读到别人的记录。记为继承性质。 |
| F3「handler 接受任意 `ConsoleCommandV1`，未来 `session.open` 会落到 Session 分支」 | **假**。`sessionCommand` 只在 `kind === 'permission.reply' \|\| kind === 'session.cancel'` 时被调用，其余 kind 仍走原有分支。 |
| A1「watermark 保存失败时下一轮会重复施加」 | **真，且是本单元的真实缺陷**，见 10.3。 |

### 10.3 已修复的真实缺陷

review 的 A1 论点指向一条真实路径：watermark 保存失败（或进程崩溃）后，下一轮会**再次**施加同一条
`session.message`，于是引擎收到**第二次 `session/prompt`**，Console 用户看到重复消息。原代码注释
「the apply path above is what refuses an already-satisfied write」只对 `permission.reply` 成立
（回调已消费故被拒），对 `session.message` 与 `session.cancel` **不成立**。

修复（`runtime/acp-serve.ts` `createSessionIntentWatch`）：

1. 新增进程内高水位 `appliedThrough`，`base = max(durableWatermark, appliedThrough ?? 0)`；
   每成功施加一条就把 `appliedThrough` 推到该条的 revision。**本进程内已施加的写绝不重复施加**，
   即使 durable watermark 保存失败。
2. watermark 改为保存 `appliedThrough ?? base`，即**部分进度也落盘**，durable watermark 不再落后于
   已经到达引擎的写。
3. 修掉一处错误类型被抹平：watermark 保存失败原先经 `refuseError` 变成 `ENGINE_UNAVAILABLE`
   （引擎明明是好的），现改为与读记录失败同一条 `configFault` 通道。冻结的 `AcpFaultCode` 词表
   没有 `UNAVAILABLE`，故两者都落在 `UNSUPPORTED_CONFIGURATION`，并在测试里写明理由。
4. 更正 `apply` 的注释：`true` 只表示「真的到达了引擎」，不再声称拒绝也返回 true（代码里拒绝返回 false）。

红先证据（`runtime/session-intent-watch.spec.ts` 新增用例
`never re-applies a write it already applied when the watermark cannot be saved`）：
用 `chflags uchg` 把 watermark 目录置为不可变，使读成功（ENOENT→0）而写失败。

| 变异 | 结果 |
| --- | --- |
| 把 `base` 改回只读 durable watermark（即修复前行为） | 该用例转红：`expected [ {…}, {…} ] to have a length of 1 but got 2`，即引擎真的收到两次 prompt |
| 把 `appliedThrough = base + index + 1` 改为 `appliedThrough = base` | 该用例转红（内存高水位失效） |
| 复原 | `diff` 与原文件逐字节相同，`runtime/session-intent-watch.spec.ts` **12/12** 通过 |

修复后复测：本单元门禁 **71/71**、D01 **58/58**、D05 **103/103**、serve-entry **68/68**、
D06+L9 并集 **168/168**、`pnpm typecheck` exit 0、`pnpm build` exit 0、真实入口黑盒
**49 checks / PASS**（receipt `controlPid=41166`、`agentPid=41279`）。
D07 门禁复用修复前的 **66/66**：该修复只改 `runtime/acp-serve.ts`，UI 侧输入未变。

### 10.4 剩余的真实边界（不因修复而消失）

崩溃/重启后，最后一次成功落盘的 watermark 之后的写仍会**至少一次**地重新施加，因此
`session.message` 在崩溃窗口内仍可能重复。这是该记录形态能提供的最强保证（at-least-once），
已在代码注释与本节写明，不宣称 exactly-once。

## 10. 保留义务（不属本增量，交接给后续阶段）

1. **L10**：真实 Session / permission / notification 事件驱动 SSE；控制 daemon 仍回
   `sessions: []` 与 `notifications: []`；Console 可见的 permission 身份尚未进入投影。
2. **`session.create` / `session.open`**：仍 typed `UNSUPPORTED_OPERATION`，因为二者必须
   返回真实引擎数据（新的 `sessionId`、transcript），单向记录无法承载响应。
3. **L11/L12**：按证据升级门禁并收口五张 map 与 governance。11 个 `teams-acp-*` gate 全部
   仍为 `partial`，任何门禁在其未闭合项消除前不得升级。
4. **L9 intent-side §11 遗留的 7 条 advisory 证据范围措辞**（`resource-map.json` 的
   `acp-frame-contract` note、`mainline-call-map.json` 的 `provider-config-v1` edge、
   两份 design 文档的早期状态段，以及三处缺行内 2026-10-14 标记的历史证据）随 L12 一起处理。
5. **未合入的 `codex/acp-l9-egress-20261013`** 不属本单元范围。