# L10 实现设计（依据本轮代码侦察）

## 现场结论（与 recon.md 的差异，以此为准）

recon.md 假设的 `SessionHost` 路径**不是** `--serve opencode` 的真实路径。实测：

- `cli/agentteams.mjs:871` 的 `serve` 子命令只调 `runAcpServe` → `startAcpServe`。
- `runtime/agent-process.ts` 的 `SessionHost`、`projectionSessions()`、`sessionEvents()`
  只在 `startAgentProcess` 路径下创建（`agent-process.ts:1036`），而该入口的唯一 CLI
  使用者是 `runAgentProcess`（`--config` 旧 Work 路径，由 `local-supervisor` 拉起）。
- 因此 `--serve opencode` 的 agent daemon 里**没有** Session 事件流，只有 `AcpHost`
  （`agent-host/acp-host.ts`）持有的真实 ACP 事实。

## L10 的可投影真实事实（只读，全部已有）

`AcpHost` 已暴露两个唯一 owner 读：

| 事实 | owner | 已有 API |
| --- | --- | --- |
| 引擎 Session 打开集合（每个 open channel 的 `sessions`） | AcpHost `sessionOwners` | **无读**（`sessions`/`sessionOwners` 是内部 Map，`channelForSession` 只是正向查） |
| 引擎待回复 permission 回调 + 引擎真实选项集 + Id | AcpHost `pendingCallbacks` | `pendingPermissions()` at `acp-host.ts:1088` |

即 L10 需要**一个**新增只读 API：`AcpHost` 上的 opened-Session 读，其余全部复用。

## 决定的最小增量

1. `agent-host/acp-host.ts`：`AcpHost` 加一个只读 `openedSessions()`，返回
   `readonly { readonly sessionId: string }[]`（或 `readonly string[]`），数据取自
   `sessionOwners`，与 `pendingPermissions()` 同一纪律：closed channel 不报。
   不加第二个来源，不改 `releaseSessions`/`open`/`receive` 的语义。
2. `runtime/acp-serve.ts`：新增只读 `AcpSessionProjection` owner（不放进 `AcpHost`），
   由 `daemon.host.pendingPermissions()` + `daemon.host.openedSessions()` 组装成
   `ConsoleProjectionV1['sessions']` 与 `ConsoleProjectionV1['notifications']`。
   - `sessions`：每个 opened Session 一行；title 取不到（ACP 没有 title 回传），按
     DTO 的 `title?` 省略，不编造。
   - `notifications`：每个 pending permission 一行，`kind: 'permission'`,
     `state: 'pending'`，带真实 `permissionId`（引擎回调 id）与真实 `sessionId`。
     引擎 option 集走 `sessionEvents`，不带入通知行。
3. `runtime/acp-serve.ts` handle 上暴露 `sessionProjection()`，并挂到**已有的**
   ACP 请求面（`acp-serve.ts` 的本地/LAN 请求 handler），使 controller 能 `读`——
   **只读投影，不是新控制→agent 通道**：它与 `agent-process` 路径的 `console.projection`
   ingress 同性质，只是这一个真实入口此前没有该 handler。
4. `runtime/control-process.ts:863`：`readProjection` 从 `sessions: [], notifications: []`
   改为通过既有 D04/D05 事实能拿到的投影行。**阻塞点**：控制 daemon 当前只有 D04 目录
   + D05 连接，没有任何读 agent daemon 投影的通道。

## 未定案的关键问题（必须先答）

控制 daemon 如何拿到第 3 步的投影？三个选项：
- (i) 走一个文件记录（agent daemon 写、控制 daemon 读）—— 与 L9 对称但**新增第二份记录**；
- (ii) 控制 daemon 主动向 agent 发 `console.projection` —— 需要新通道（acp-serve 无事
  实上的 console ingress，第 3 步要新增）；
- (iii) **本单元不接**：只交付 agent daemon 侧可观测投影 + 单元/黑盒证明“真实 permission
     产生真实通知行”，控制 daemon 的 `sessions: []` 在 L10 现状里如实记录为未关闭项。

选 (iii) 是本轮的安全判断：L10 的验收是“真实事件驱动 SSE + Console 可见 permission 身份”。
SSE 在控制 daemon，Console 投影也在控制 daemon，(i)/(ii) 任一都要新增跨进程边。
在新增边之前，先把 (1)(2)(3) 交付并使它能被真实黑盒证明，边界就从“没有任何投影”
前移到“投影存在于唯一 owner 且可读”。
