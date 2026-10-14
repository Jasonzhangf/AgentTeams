# L9 intent-side: the agent daemon reacts to the desired-relations record

日期：2026-10-14。分支 `codex/acp-l9-intent-side-20261014`。

## 1. 目标与结论

`connection.connect` 之所以能真正执行，是因为 **agent daemon 自己观察 desired-relations 变化**。
控制 daemon 只做一件事：把「想要的 relations」按 CAS 写进一份持久记录。不存在新的
control→agent 通道，Console 也不是数据中转。

本次交付把这条链在源码层闭环，并用真实入口黑盒证明：控制 daemon 的认证 HTTP
`/api/v1/command` 收到命令后写入记录，随后 agent daemon 因为这次 intent 变化而重新拨出。

## 2. 落点：intent 文件路径与推导

`<home>/.agentteams/relations/<accountId>/<scopeId>/relations-intent.json`

- 拥有者：`config/relations-intent-store.ts`（`relationsIntentScopeDirectory` / `relationsIntentScopePath`）。
- 写入者：控制 daemon。它从**自己已接受的 `peers`** 里取目标 agent 的 `accountId`/`scopeId`。
- 读取者：agent daemon。它从**自己的 `daemon.accountId` / `daemon.scopeId`** 取同一对值（`runtime/acp-serve.ts` 的 `agentRelationsIntentPath(home, daemon)`）。
- 两侧都用既有的 `~/.agentteams` 本地根，因此不需要新增 config key，也没有引入第二条真源。

**窄化（必须一并引用）**：冻结的 v4 `PeerIntent`（`config/daemon-intent.ts:108-117`）只带
`agentId/hostId/accountId/scopeId/endpoint?/admissionRef?/credentialRef/tlsTrustRef?`，**不带** peer 的
`dataDirectory`。所以记录路径不可能是「对端自己的 `daemon.dataDirectory`」；它是**每个 account+scope
一份**的期望成员集合，而不是每个 agent 一份文件。因此：

- 同一 account+scope 下的多个 agent daemon 读同一份文件；
- 只有在该文件里声明的 peer 同时出现在某个 daemon 自己的 `peers` 里时，那个 daemon 才会拨出；
- 其他 daemon 会为同一个 agentId 记一条 typed `FORBIDDEN`，不拨、不崩。

## 3. 源码改动与计数（实测）

| 交付 | 落点 | 实测 |
| --- | --- | --- |
| CAS 存储（前序 worker 提交 `6091ca1` / `320cb79`） | `config/relations-intent-store.ts` + `.spec.ts` | 10 tests |
| 控制 daemon 单写者（提交 `320cb79`） | `runtime/control-process.ts` + `.spec.ts` | 22 tests |
| agent daemon 单读者（提交 `afbb99b`） | `runtime/acp-serve.ts` + `runtime/relations-intent-watch.spec.ts` | 27 / 8 tests |
| 本单元 gate | `pnpm exec vitest run --no-file-parallelism config/relations-intent-store.spec.ts runtime/relations-intent-watch.spec.ts runtime/control-process.spec.ts runtime/acp-serve.spec.ts` | **67 passed / 4 files** |
| serve-entry gate 现命令 | `pnpm exec vitest run runtime/acp-serve.spec.ts runtime/relations-intent-watch.spec.ts cli/agentteams.spec.ts --no-file-parallelism` | 27+8+33 = **68 passed / 3 files** |
| `pnpm typecheck` | 根 + console-host + ui/teams-console | 退出码 0 |
| `pnpm build:runtime` | rm `generated/runtime-lib` + `tsc -p tsconfig.runtime.json` | 退出码 0 |

agent 侧新增导出：`RELATIONS_INTENT_POLL_INTERVAL_MS`(500)、`RelationsIntentWatchFailure`、
`RelationsIntentWatchInput`、`RelationsIntentWatch`、`createRelationsIntentWatch(input)`、
`agentRelationsIntentPath(home, daemon)`；`AcpServeHandle` 增加 `relationsIntent: { path, failures() }`。

语义要点：

- 起始行为不变：入口仍按已接受 intent 拨完每个已声明 peer。记录只是**之后**的期望 overlay，
  所以 D00 的「intent 只在启动读一次」没有被削弱。
- 记录缺失 = 纯 no-op；记录损坏 = typed 拒绝且保留所有 live row；两者都不抛到 daemon 之外。
- 记录里的 `role` **不覆盖**本 daemon 自己的 `relations.allowed`，角色仍由
  `runtime/serve-egress.ts:259-260` 唯一推导。否则外来文件可越权授予 `master`。
- `stop()` 第一步 `clearInterval`，先停观察再关它驱动的 egress；定时器 `unref()`。

## 4. 变异与复原（红先）

基线 `runtime/acp-serve.ts` md5 `95b122435fd3e1da6c24f33e67e7a05d`。

| 变异 | 内容 | 转红用例 | 复原 |
| --- | --- | --- | --- |
| M1 | 删掉差量里的 `if (wanted.has(row.agentId)) continue`（把想要的 peer 也断开） | `dials a declared peer only once the record desires it`、`disconnects a live peer the record no longer desires`（2 failed / 6 passed） | `git checkout` 后 md5 `95b122435fd3e1da6c24f33e67e7a05d`，与基线 `diff` 为空 |
| M2 | 把 `if (live.has(agentId)) continue` 反转为 `if (!live.has(agentId)) continue`（永不拨出） | 8 例中 3 red（connect-on-appear、disconnect-on-remove、redial） | 同上，md5 一致 |
| M3 | 去掉 `refuse` 的去重 | `records one repeated refusal once instead of growing every poll`（1 failed / 7 passed） | 同上，md5 一致 |

复原后 `runtime/relations-intent-watch.spec.ts` 重新 8/8 绿，`git status` 对该文件为空。

## 5. 真实入口黑盒

`black-box-intent-side.mjs`（本目录），运行日志 `black-box-intent-side.log`（`DRIVER_EXIT=0`），
回执 `receipt.json`（53 checks / 17 receipts）。

组成全部是真实入口：真实 `registry start`、真实 `control start --config`、两个真实
`agentteams --serve opencode --ip <lan> --port <port> --config` daemon（observer 与 responder），
真实 LAN 地址、真实 openssl TLS、真实 HTTP 准入。所有 daemon 子进程的 `HOME` 指向临时 home，
因此记录落在受控路径而不是操作者真实 home。**driver 从不向任何一个 agent daemon 开 socket**；
它只调用控制 daemon 的认证 HTTP `/api/v1/command` 并读取 daemon 自己的 durable history。

证明的行为（每条都有 ok 行）：

1. 起始拨出时记录**不存在**（`relations-intent.json` 不存在），所以基线来自已接受 config 而不是 overlay。
2. 双方 history 记录同一条 wire connection；observer 侧 `sourceRole=peer` / `targetRole=master`，
   `targetCapabilitiesRevision` 等于 responder 自己发布的 readiness 值。
3. `connection.connect{l9-responder}` → 记录 revision 1、`peers=[{l9-responder,master}]`，
   结果只报 `acceptedRevision`，不含任何连接状态；Console projection 与写前逐字节相同。
4. 记录已存在且 peer 已连时，重复 connect 不重拨（`connection.negotiated` 仍为 1，无 `channel.closed`）。
5. `connection.disconnect{l9-responder}` → 记录 revision 2、`peers=[]`；
   **observer 自己的 history 记下 `channel.closed`（同一条 connectionId）**，responder 侧记下同一条 wire
   connection 结束；空转 3.5s 后 `connection.negotiated` 仍为 1，**没有自愈重拨**。
6. 再 `connection.connect{l9-responder}` → 记录 revision 3；observer 拨出**新的 agreement connectionId**，
   并开出属于新连接的 ACP channel，responder 记下第二条不同的 wire connection。
7. 拒绝路径：未声明的 agentId = `FORBIDDEN`；过期 `expectedRevision` = `REVISION_CONFLICT`；
   `network.membership.apply` 里跨 account/scope 的成员 = `FORBIDDEN`；三者之后记录 revision 不变。
8. 无认证的 Console 命令 = 401，且不产生记录。
9. 成功的 `network.membership.apply` 以已接受 revision 为 CAS 基准替换期望集合（revision 4），
   成员不变时不产生新拨出。

这个 driver **不能**证明：安装副本回放、restart、deployed-entrypoint、跨设备/跨账号；它跑的是
worktree 的 `generated/runtime-lib` + 源码 CLI，并且用本地 OpenAI 兼容 stub provider 提供引擎模型。

复现：

```
pnpm build:runtime
node docs/evidence/acp-l9-intent-side-20261014/black-box-intent-side.mjs
```

## 6. 未交付 / 已知问题

- `docs/development-governance.md` **不是我改的**：它在本单元期间一直被另一个会话持续编辑（D03/D07 行）。
  我没有触碰该文件以避免覆盖他人未提交的改动；其中 D07 行的 relations 叙述需要该文件 owner 与本次实测计数核对。
- `docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs` 在本单元期间被另一个会话编辑过（把旧的
  `UNSUPPORTED_OPERATION` 断言改成新的 typed 拒绝）。我中途看到过一次它的语法破坏，14:02 复检
  `node --check` 已通过；该文件不是我的，我未修改。
- 记录是「每个 account+scope 一份期望成员集合」，不是「每个 agent 一份」，见第 2 节窄化。
- 记录里的 `role` 目前只由控制 daemon 记账（agent 侧不消费），这是有意的安全选择，见第 3 节。
- AppSDK gate 仍按既有阻塞 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014` 停住；本单元未运行 `pnpm verify`。
