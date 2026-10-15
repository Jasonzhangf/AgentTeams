# L10 Session/permission/notification 投影 —— 侦察结论（2026-10-15）

本文件记录 L10 开工前的 DAG 侦察，供后续轮次直接接续。**尚未开始实现，目录内除本文件外无改动。**

## 目标（来自总目标）

真实 Session/permission/notification 事件驱动 SSE；并在 Console 投影中发布 permission 身份。
当前缺口：控制 daemon 的投影硬编码 `sessions: []`、`notifications: []`
（`runtime/control-process.ts:590` 与 `:863`），Console 因而看不到自己写入的 Session，
也无法从投影得知 permission 身份（L9 notes §11.1 已记录该边界）。

## 关键事实（已读代码，非推断）

| 事实 | 位置 |
| --- | --- |
| 冻结投影形状：`sessions[] = {agentId, sessionId, title?}`；`notifications[] = {agentId, notificationId, sessionId?, kind:'notice'\|'permission', state:'pending'\|'resolved', title, permissionId?, priority?, occurredAt?, detail?}`；另有 additive 的 `sessionEvents?: ConsoleSessionEventView[]`，其 `permission` 变体带 `permissionId` 与 `messageId` | `control-protocol/console-api.ts:377-399`、`:85-175` |
| Agent daemon **已经**有真实 Session 投影：`sessionHost.projectionSessions()` 走真实 owner handle 列 Session；`sessionHost.sessionEvents()` 返回真实事件（含 permission 事件） | `runtime/agent-process.ts:138-139`、`:573-574`、`consoleClient.readProjection` at `:1082` |
| Agent daemon 的 `notifications` 仍硬编码 `[]` | `runtime/agent-process.ts:1089` |
| Agent daemon 有真实 pending permission 集合（L9 交付） | `agent-host/acp-host.ts` 的 `pendingPermissions()`；`AcpServeHandle.sessionIntent` |
| 控制 daemon 的投影 = D04 目录 readback + D05 连接行；`sessions`/`notifications` 硬编码空 | `runtime/control-process.ts:789`（`createControlNetworkStatus`）、`:862-863` |
| SSE 订阅者按**投影变化**发帧（轮询 1s，编码后比较），故投影一变就会推进真实 `seq` | `runtime/control-process.ts:876-898`（`createPollingProjectionSubscriber`）、`DIRECTORY_PROJECTION_INTERVAL_MS = 1_000` |
| Agent→Console 的定向 ingress 已存在且有授权：`console.projection` 走 `client.readProjection()`，授权为 `allowedManagers` + 同 account/scope | `agent-host/console-ingress.ts:12-37`；`runtime/agent-process.ts:1127` |
| Console Hub **已有**「逐 agent 组装投影并按 `agentId` 校验不越界」的实现，可直接复用其形状 | `runtime/console-hub.ts:47-100` |

## 两个候选方案

### 方案 A：控制 daemon 通过定向 Console ingress 读各 agent 的投影

控制 daemon 用已有 `console.projection` 请求逐个在线 peer 读 `readProjection()`，
只取 `sessions`/`notifications`/`sessionEvents`（不取 Session 业务内容），再按 `console-hub.ts` 的
同一形状合并并校验 `agentId` 不越界。

- 优点：复用已交付的 ingress 与授权；控制 daemon 仍是**投影**（不含 message 正文），不是数据中继。
- 风险：控制 daemon 需要一条到各 agent 的**数据通道**。D05 ledger 只暴露连接状态
  （`TeamsStatusPort.connections()/history()`），目前**没有**控制 daemon 主动发起 console 请求的通道。
  新增通道会触碰「不加新 control→agent 通道」的收紧口径，需要先确认这是不是 owner 期望的边。

### 方案 B：agent daemon 写一份**观察记录**，控制 daemon 读（与 L9 写入记录严格对称）

L9 已确立的约定是「控制 daemon 写 pending-write 记录，目标 agent daemon 读」。
对称地：agent daemon 把自身真实的 Session/permission/notification **观察**写成一份 durable 记录，
控制 daemon 读它并组装投影。

- 优点：与 L9 同构，路径约定可复用 `sessionIntentScopePath` 的 `<home>/.agentteams/sessions/<accountId>/<scopeId>/<agentId>/`；
  不新增 control→agent 通道；不把 Console 变成中继；每个事实只有一个 owner（agent daemon 写、控制 daemon 读）。
- 风险：多一份记录需要 CAS/watermark 语义（L9 已解决该形状，可复用）；记录只承载**投影行**，
  绝不能承载 Session 业务正文，否则违反「不做 Console 数据中继」。

## 建议

先按**方案 B** 做，理由是它与 L9 完全同构、不新增通道、且 owner 边界最窄。
方案 A 需要在设计中先确认「控制 daemon 主动向 agent 发起 console.projection」是否被允许；
该确认本身就是一个需要证据的结论，不应在实现里默认成立。

## 下一步（可执行）

1. 读 `.appsdk/requirements.json` 与 `docs/design/teams-acp-daemon-config-v4.md` 的 A2/A4，确认投影读侧归属。
2. 定 `config/session-observation-store.ts` 的记录形状（只含投影行：sessions、notifications、
   含 `permissionId` 的 permission 事件），并写 store spec。
3. agent daemon 写侧：由真实 `projectionSessions()`、`sessionEvents()`、`pendingPermissions()` 生成记录。
4. 控制 daemon 读侧：`readProjection` 合并各 peer 的观察记录到 `sessions` + `notifications`。
5. 真实黑盒：起真实 agent daemon + 真实控制 daemon，制造一次真实 permission 回调，
   断言 `/api/v1/events` 的 SSE 帧里出现该 Session 与带 `permissionId` 的 pending 通知，且 `seq` 真的推进。
