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
| 读侧 watch | `runtime/acp-serve.ts` + `runtime/session-intent-watch.spec.ts` | 11 tests |
| 控制侧三条命令 | `runtime/control-process.ts` + `.spec.ts` | 24 tests（原 23，+1） |
| **本单元门禁** | `pnpm exec vitest run --no-file-parallelism config/session-intent-store.spec.ts runtime/session-intent-watch.spec.ts runtime/control-process.spec.ts agent-host/acp-host.spec.ts` | **70 passed / 4 files**，退出码 0（`gate-d06-l9.log`） |
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
| `teams-acp-l9-intent-side` | 4 个 spec 文件 | **69/69**（10+8+24+27） |
| `teams-acp-d07-webui` | `TEAMS_CONSOLE_REAL_DOM=1` + 13 个 spec 文件 | **66/66**，`gate-d07-webui.log` |

D06 与 L9 intent-side 两个门禁的文件集合之并一次跑完为 **167/167**（10 个文件），
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

因此本单元按映射门禁 + 类型检查 + 构建 + 真实入口黑盒判定，并在集成后重跑全量回归；
不把这次 `exit 1` 说成通过，也不把它说成本单元的回归。`pnpm verify` 仍**未运行**：它是先于
本单元的 BLOCKED 基线（`PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014`）。

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