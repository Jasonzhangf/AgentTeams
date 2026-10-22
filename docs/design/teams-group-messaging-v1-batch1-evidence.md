# 第一批验收证据(设计文档第 18 节)

本文件只记录证据,不改需求。设计正文仍是 `teams-group-messaging-v1.md` revision 5。

证据分层:

- 单元/模块:直接调用模块函数,不经过网络。
- hub:经过 `GroupHub.handle`,装配真源模块与真实回执鉴权。
- 黑盒:真实 CLI 子进程、真实 TLS relay、真实 daemon 进程内组合、真实 Unix 套接字、本地 HTTP Vikunja 替身。
- Vikunja 一层目前只有本地 HTTP 替身(`server/group-loop.spec.ts` 里的 `startVikunjaStub`),真实实例未核验。

## 18 条

| # | 证据 | 层次 |
| --- | --- | --- |
| 1 | `server/message-router.spec.ts` keeps a group message visible to all active members and pushes online members;accepts exactly the action assignee as the target set。`server/action-registry.spec.ts` creates a pending action with the assignee as the only responsibility source | 单元 |
| 2 | `server/group-acceptance.spec.ts` item 2 ends the action at its own result and never auto-answers | hub |
| 3 | `server/group-hub.spec.ts` refuses an action change from a member that is not the assignee(peer 拒绝 master 指派被拒、master 拒绝 peer 请求成立) | hub |
| 4 | `server/group-acceptance.spec.ts` item 4 keeps two assignees independent | hub |
| 5 | `server/message-log.spec.ts` returns the original record for a repeated commit and rejects different content;rebuilds from increasing records。`server/group-hub.spec.ts` reloads the last snapshot so a restart keeps groups and messages | 单元 + hub |
| 6 | `server/group-acceptance.spec.ts` item 6 does not report completion when the result write fails | hub |
| 7 | `server/group-acceptance.spec.ts` item 7 does not confirm a close whose external write failed | hub |
| 8 | `server/issue-session.spec.ts` applies a readback only when the state matches and the ordinal confirms the intent。`server/group-acceptance.spec.ts` item 8 does not rerun a completed action after a reopen | 单元 + hub |
| 9 | `server/group-acceptance.spec.ts` item 9 denies a cross-group reference and an unauthorised assignment。`network/group-channel.spec.ts` rejects the matching waiter with the relay ServiceError instead of resolving a success | hub + 单元 |
| 10 | `server/message-log.spec.ts` reports a retention gap explicitly after trimming;does not report a gap when the cursor already covers the missing range | 单元 |
| 11 | `server/action-registry.spec.ts` still executes when replyRequired is false。`server/group-acceptance.spec.ts` item 11 executes an action whose replyRequired is false | 单元 + hub |
| 12 | `server/group-external-ops.spec.ts` records an operation before the call and returns the stored record on repeat。`server/group-acceptance.spec.ts` item 12 creates one session for a repeated issue.create commit;item 6 覆盖结果写失败不完成 | 单元 + hub |
| 13 | `server/group-external-ops.spec.ts` lists actions whose stop was not confirmed;`server/issue-session.spec.ts` keeps the projection alone when a confirmation is unknown or conflicted。第一批没有执行队列,取消队列属第二批 | 单元 |
| 14 | `server/group-external-ops.spec.ts` exposes pending and inflight as unknown and leaves confirmed alone。`server/group-hub.spec.ts` reloads the last snapshot so a restart keeps groups and messages | 单元 + hub |
| 15 | `server/group-registry.spec.ts` uses one directional edge for assignment and request。`server/group-acceptance.spec.ts` item 15 covers both directions with one edge and rejects an unrelated pair | 单元 + hub + 黑盒(loop 的 `--masters` 建边) |
| 16 | `server/group-acceptance.spec.ts` counter-example 16: a stale close never overwrites a newer reopen;counter-example 16 at the hub: an unconfirmable close is unknown, not closed。`server/group-external-ops.spec.ts` reports conflict for a stale close after a newer reopen | hub + 单元 |
| 17 | `server/group-acceptance.spec.ts` counter-example 17: cancel is observable in three steps and a real result is kept。`server/action-registry.spec.ts` never moves in_progress directly to cancelled;keeps unknown non-terminal and records the unconfirmed stop fact | hub 边界 + 单元 |
| 18 | `server/group-acceptance.spec.ts` counter-example 18: a forged receipt cannot move the projection。`server/group-hub.spec.ts` rejects a receipt that does not come from the delegated owner。`server/group-external-ops.spec.ts` rejects a receipt from a member that is not the delegated owner;rejects a receipt naming a different commit id | hub + 单元 |

## 三个反例的明确位置

1. 旧关闭不得覆盖重开:`decideExternalConvergence` 在 `opSeq < lastOpSeq` 返回 conflict;hub 在外部读回无法确认时保持 open。
2. 取消期间结果不丢:`cancel_requested → completed` 是合法边;`applyCancelConfirmation` 只在收到停止确认时改为 cancelled,否则 unknown。
3. 伪造操作回执被拒绝:回执必须来自被委派 owner 且 `commitId` 一致,否则抛错且投影不变。

## 黑盒闭环

`server/group-loop.spec.ts`:真实 `cli/group.mjs` 子进程 + 真实 TLS relay + 真实 `agent-messaging` daemon + 真实 Unix 套接字 + 本地 HTTP Vikunja 替身。断言:建群、两个邀请、接受、issue 创建(PUT 建任务)、指派、提交结果(PUT 写 comment,数量为 1)、关闭(POST done,替身侧为完成)。同一测试还经过 `agentteams group list` 入口,证明 `cli/agentteams.mjs` 的分派。

`cli/join.spec.ts`:真实 TLS 服务替身完成握手后写 v4 配置;已有别的身份时拒绝重写;relay 不可达时保留原配置。`--no-start` 下不启动 daemon。

## 未覆盖

- 真实 Vikunja 实例:verb、路径、字段、权限与 webhook 签名都未在真实实例核验。
- `issue.reference` 的 `vikunjaProjectId` 仍是占位值 `referenced`,未回读目标 issue 是否存在。
- `join` 的 detach 启动路径只实现未测;测试一律用 `--no-start` 验证配置与可达性,未启动生产 daemon。
- 第一批没有执行队列与物理停止,第 13 条的队列部分留到第二批。
