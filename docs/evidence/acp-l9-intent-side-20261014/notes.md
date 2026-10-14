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
4. 记录已存在且 peer 已连时，观察侧下一轮轮询不重拨（`connection.negotiated` 仍为 1，无 `channel.closed`）；驱动此处不再发第二条 `connection.connect`，所以这条只证明 reconcile 幂等，不证明重复命令的幂等（后者由 `runtime/relations-intent-watch.spec.ts` 与 `runtime/control-process.spec.ts` 覆盖）。
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

## 7. 独立 review（2026-10-14）与 finding 修复

首次独立 review 的结论是 **FAIL**，三条 blocking finding 都成立，已全部修复并在本候选上重测：

- **B1（硬）**：本改动把三条 A2.4 关系命令的拒绝码从 `UNSUPPORTED_OPERATION` 改成
  「目标不可解析的 typed `FORBIDDEN` / 真实 CAS 写入」，但 D06 门禁自己的两个真实黑盒仍断言旧码，
  两者都变红（`docs/evidence/acp-d06-control-20261011/black-box-control.mjs`、
  `docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs`），而 governance 与 map 仍声称它们通过。
  两个驱动已按新期望更新并**重跑**：PART 1 **10/10**、PART 2 **7/7**，退出码均为 0。
  同类过时断言一并更新：`docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs`（未重跑，
  它是 installed-tarball 层，见下）；`docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs` 早在本次修复前已更新并重跑。
- **B2**：`network.membership.apply` 的 account/scope 成员校验没有独立用例——reviewer 的细粒度变异
  （保留 `peer === undefined`、去掉 account/scope 比较）**22/22 全绿**。已新增用例
  `refuses a declared peer that lives in another account and scope as a record member`（在 `runtime/control-process.spec.ts`），
  并新增 `foreignPeers` 测试夹具（声明在 `other-account`/`other-scope` 的真实 peer）。
  同一变异现在**只**让该新用例转红（1 failed | 22 passed），`runtime/control-process.ts` md5 复原为
  `618317fba6b9013be61222f70f449d0e`。该用例同时记录一个真实不对称：`connection.connect` 对外域 peer
  **不是**拒绝，而是写到该 peer 自己的 account/scope 记录（写侧按目标解析路径），本地记录保持不变——
  这正是 `membership.apply` 必须拒绝外域成员的原因。
- **B3**：`docs/architecture/verification-map.json` 的 D06 note 仍写 `119/119 across 6 files`
  （改为明确的「intent-side 增量之前」历史计数），D06 的 `checks[3]` 仍写「connection mutation 被
  `UNSUPPORTED_OPERATION` 拒绝」（改为新的目标规则），D07 的 checks 里同样的旧码一并更正。
  新增用例后重测计数：D06 门禁 **135/135 / 7 files**（runtime/control-process 23、config/relations-intent-store 10、
  agent-host/acp-host 23、runtime/acp-serve 27、cli/agentteams 33、console-host/tests/http-api 7、
  control-protocol/console-api 12）；本单元门禁 **68/68 / 4 files**（27+23+10+8）；
  `teams-acp-serve-entry` **68/68 / 3 files**（27+8+33）。governance 与 map 已按这三个实测值同步。

### advisory finding 的处理

- **A1**：驱动头部与本节第 4 条的措辞声称「重复 `connection.connect` 不重拨」，但驱动从不发第二条
  connect。已把两处改成「记录不变时的下一轮轮询不重拨」，并显式说明该条只证明 reconcile 幂等；
  重复命令的幂等由 `runtime/relations-intent-watch.spec.ts` 与 `runtime/control-process.spec.ts` 覆盖。
- **A2**：`docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs:1595` 的旧断言已更新为
  `FORBIDDEN`/`FORBIDDEN`/`UNSUPPORTED_OPERATION`，并在该单元的 `verification.json` 里加了带日期的
  `refused_commands_correction`，明确写明**该驱动本次未重跑**（它属于 installed-tarball 跨设备层，
  需要自己的 replay），并列出本候选上同规则的实测旁证（D07 驱动与两个 D06 控制黑盒）。
- **A3**：并发关系命令可产生一次可重试的 `REVISION_CONFLICT`（读后 CAS、无串行化）。这是**已知限制**，
  没有数据损坏，也没有并发用例；记录在此，不当作已证明行为。
- **A4**：按声明命令运行黑盒会重写被跟踪的 `receipt.json`（默认 `L9_RECEIPT_PATH`）。本文件是生成产物，
  已在本轮重跑后重新提交；只读复核建议 `L9_RECEIPT_PATH=/tmp/...`。
- **A5**：每个 account+scope 一份记录是该范围内的共享语义，已在第 2 节记录为真实窄化。

### 历史证据记录的更正方式

对**已归档的过往运行记录**（`acp-d06-part2-20261011/verification.json`、`acp-d07-webui-20261011/verification.json`、
`acp-d08-acceptance-20261011/verification.json`）不重写原文，而是加带日期的 `corrections` /
`refused_commands_correction` 标记，说明旧值属于哪一次运行、现在的新期望是什么。
`docs/evidence/acp-d06-part2-20261011/notes.md`、`docs/evidence/acp-d07-webui-20261011/notes.md`、
`docs/evidence/acp-l8-initiator-open-20261013/notes.md` 里的现在时陈述同样加了带日期的更正。

## 8. 文档扫描轮次（2026-10-14，第 2–6 次独立复核）

首次 review 之后，独立复核只问一个问题：**是否还有文档把已被本增量改变的旧行为当成现状陈述**。
这个问题问了五轮，每轮都发现新的同类残留，每轮都已修复；修复全部采用「保留原句 + 带日期更正」或
「标注 SUPERSEDED」，不重写历史记录。逐轮事实如下。

| 轮次 | 被审 HEAD | 结论 | 发现并已修复 |
| --- | --- | --- | --- |
| 2 | `cf62050` | B1/B2 FIXED；B3 整体未修完 | 三处现在时陈述漏扫：`acp-l9-egress-20261013/notes.md`、`acp-d06-part2-20261011/notes.md` §8.6、`development-governance.md` D08 行；另两条 advisory 一并处理 |
| 3 | `979175b` | INCOMPLETE | `mainline-call-map.json` 的 `acp-webui-v1` step 5 仍写两条命令返回 `UNSUPPORTED_OPERATION`（blocking）；`acp-control-daemon-v1` step 6 与 note；`acp-relations-intent-v1` note 里 spec 计数 22→23；L8/L7 note 与 A3.7 段落的 initiator 残留 |
| 4 | `e2dee5b` | COMPLETE 但不干净 | `function-map.json` 的 `teams_status_port` note 仍写「refuses every connection mutation typed」；L9 egress note 的 §7 收尾段；`acp-serve-entry-v1` 的 step 6/7 与 note（该轮 patch 因脚本先失败而未落到文件，见第 5 轮） |
| 5 | `57ae689` | INCOMPLETE | `acp-serve-entry-v1` 的 step 7/8、note、edge callee 与 edge note 仍写 D04/D05 未组合、监听仅 loopback；`acp-registry-v1` note 与 `module-registry.json` 的 runtime note 同类；`governance` D03 行的 loopback 句 |
| 6 | `bb45e03` | COMPLETE 但不干净 | 12 条 F3 现在时陈述（serve entry 不组合 D04/D05、监听仅 loopback、无 live `--serve` 守护进程）散布在五张 map 的 chain/edge/function/resource/gate 记录里，另有 1 条同类与 4 条 advisory |
| 终审 | `0539297` | **PASS** | 无 blocking；F1/F2/F3 问题关闭 |

第 6 轮修复的 12 条里有 10 条属于**本单元之外的早期单元残留**（D01–D05 的 map 记录没有随它们之后的交付更新），
本增量一并更正并在每条里保留原句与日期。这一点在此显式记录，避免把「修正他人历史陈述」算作本单元的交付范围。

## 9. 集成回执（2026-10-14）

- **集成前远端**：`git ls-remote origin main` = `2ab7a8978cbea1e14715b8fb90d852849fa51736`。
- **review 前置条件**：被审候选 `0539297` 的 `git status --porcelain -uall` 为空；终审 reviewer 自测
  `git rev-parse HEAD` = `053929713a452f08290f6c41462edd3f939a6d34`，结论 **PASS**（无 blocking finding）。
- **合并**：在从 `origin/main` 新建的独占集成工作树 `acp-l9-intent-side-merge-20261014`（分支
  `codex/acp-l9-intent-side-merge-20261014`）上执行 `git merge --no-ff`，得合并提交
  `e1e62422ec6bfd49aea194e3978726604e7b4903`，信息 `merge(acp): integrate the reviewed L9 intent-side candidate`。
- **树等价证明**：`0539297^{tree}` = `e1e6242^{tree}` = `4af33d4cf546cdb663c068fd5233a99d0d371e5e`，
  与 `build:governance` 产物回执里的 `tree_hash` 一致。因此第 10 节在 `0539297` 上实测的门禁结果
  对合并结果同样成立，不需要在集成工作树里重跑（合并是纯 fast-forward 等价，base 未移动）。
- **推送**：`git push origin HEAD:main` 返回 `2ab7a89..e1e6242  HEAD -> main`。
- **回执复核**：推送后 `git ls-remote origin main` = `e1e62422ec6bfd49aea194e3978726604e7b4903`，
  与合并提交一致。
- **回收前置条件**：本节与 `docs/evidence/acp-l9-intent-side-20261014/` 的保留副本都在已推送的树里，
  满足「先有回执与保留证据，再回收工作树」。单元工作树与集成工作树在本节提交推送后回收。

## 10. 冻结候选上的最终实测（`0539297`，树 `4af33d4c`）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| D06 门禁 | 7 个 spec 文件（verification-map 原命令） | **135/135**（7 files passed） |
| L9 intent-side 门禁 | `config/relations-intent-store.spec.ts`、`runtime/relations-intent-watch.spec.ts`、`runtime/control-process.spec.ts`、`runtime/acp-serve.spec.ts` | **68/68**（4 files passed） |
| serve-entry 门禁 | `runtime/acp-serve.spec.ts`、`runtime/relations-intent-watch.spec.ts`、`cli/agentteams.spec.ts` | **68/68**（3 files passed） |
| D05 门禁 | 11 个 spec 文件 | **103/103**（11 files passed） |
| D07 门禁 | `TEAMS_CONSOLE_REAL_DOM=1` + 13 个 spec 文件 | **66/66**（13 files passed） |
| 类型检查 | `pnpm typecheck` | exit 0 |
| 运行时构建 | `pnpm build:runtime` | exit 0 |
| L9 真实入口黑盒 | `L9_RECEIPT_PATH=/tmp/... node docs/evidence/acp-l9-intent-side-20261014/black-box-intent-side.mjs` | 53 ok checks，`outcome = PASS`，exit 0 |
| D06 PART 1 黑盒 | `node docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | 10 checks PASS，exit 0 |
| D06 PART 2 黑盒 | `node docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs` | 7 checks PASS，exit 0 |
| D07 WebUI 黑盒 | `node docs/evidence/acp-d07-webui-20261011/black-box-webui.mjs` | 15 checks PASS，exit 0 |
| 治理构建 | `pnpm build:governance` | exit 0；回执 `head_commit=0539297`、`base_commit=2ab7a89`、`tree_hash=4af33d4c`、`content_sha256=c3c9383e7d513c0269321c91c8b2a07d51876a490bedb72595237349f73b1e46`、`mode=final`、`release_eligible=false` |
| 工作树 | `git status --porcelain -uall` | 空 |

`pnpm verify` 仍未运行：它是**先于本增量的 BLOCKED 基线**（`PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014`），
不作为本增量的回归结论。

## 11. 保留义务（不属本增量，交接给后续阶段）

终审 review 的 7 条 advisory 都是**证据范围措辞**，不是正确性问题，因此不重开已 PASS 的候选；
它们连同 L9 写侧剩余部分一起交给后续增量：

1. `docs/architecture/resource-map.json` 的 `acp-frame-contract` note「no installed or live transport is proven」
   与 `mainline-call-map.json` 的 `acp-host-wiring-v1` note「no installed-copy engine inference is proven
   through a product entry yet」需要按各自 gate 的范围收紧（同类句子已在 D01/D04 gate 与 agent-host 模块更正）。
2. `mainline-call-map.json` 的 `provider-config-v1` edge「production daemon binding remains pending」
   与 `runtime/control-process.ts`、`runtime/console-runtime.ts` 的实际绑定不一致。
3. `docs/design/teams-agent-relation-communication-v1.md`、`docs/design/teams-control-protocol-v2-master-agent-host.md`
   的状态段仍是早期「尚未实现」措辞，未随交付更新。
4. `docs/evidence/acp-d05-network-20261010/notes.md` 的第 2/4/5/6 项、
   `docs/evidence/acp-d08-acceptance-20261011/verification.json` 的 `.gaps[2].reason`、
   `docs/evidence/acp-d07-webui-20261011/notes.md:122` 缺少行内 2026-10-14 标记（各自文件里已有更正块覆盖）。
5. **L9 写侧剩余**：`permission.reply` 与 Session send/cancel 仍绑定在 control daemon 的
   typed `UNSUPPORTED_OPERATION` 上，因为 control daemon 不绑定 Session owner。
6. **L10/L11/L12**：真实 Session/permission/notification 事件驱动 SSE；安装产物 live-browser DOM 证据；
   按证据升级门禁并收口五张 map 与 governance。11 个 `teams-acp-*` gate 全部仍为 `partial`。
