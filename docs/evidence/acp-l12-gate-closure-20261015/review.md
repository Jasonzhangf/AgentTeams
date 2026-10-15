# L12 独立 review 记录

## Round 1（修复前）—— FAIL

reviewer：独立（fresh context，read-only，DSH 宿主 `openai-codex/gpt-6.1-sol`）
候选：`85d978e` 之前 4 提交（即 4d3ffe5..d0b432a）

verdict：FAIL。2 个 blocking，均集中在 D07 门禁：

- **D07-SCOPE-CONTRADICTION（blocking）**：D07 记录的 gate 命令枚举 13 个 spec 文件
  /66 个用例，但 L12 首次只跑了 6 个文件/29 个用例，漏掉 7 个快速非 DOM spec
  （controller 17、model 8、live-client 4、observation 3、page-networking 2、
  drafts 2、locale 1），而门禁 note 却写「命令未变，29 passed / 6 files」。
  这把收窄运行当成完整门禁通过，悄悄缩小了回归范围，违反本单元自己的不变量。
  reviewer 用 `vitest list` 确认 13 文件全部存在且可收集，并用前一个 L9 单元
  自己的 D07 日志证明同一记录命令在同树上就是 13 文件/66 用例。
- **D07-NO-CORRECTION-DISCLOSED（blocking）**：notes.md 的「无需纠正」列举里
  没提 D07，使读者误以为 D07 是完整重跑。该收窄在 note、verification.json、
  计数纠正列表、governance 表都没有披露。

reviewer 同时确认：其余 13 个门禁的每文件计数与日志逐一对上；计数纠正是 append-only、
不回溯旧数；D08 的外部限流处理诚实、不宣称通过；`provider-config-v1` 的生产绑定
更正属实（`runtime/control-process.ts:1111-1120` 在 `startControlDaemon` 里构造
`createControlOwner` 并传入 `createConsoleAuthorization`）；资源盘点 12 棵树、d00
的 eba1276 与 dirty `engine.ts` 均在 origin/main 属实。

advisory：D08 清理声明应说明是运行后手动移除；D07 重跑应用完整记录命令并贴全
per-file；「6 个 failing spec」应引用 L10 的不稳定集合；design 文档里
`runtime/control-session-projection.ts` 路径不存在（投影读取器在
`runtime/control-process.ts:818`）。

## 修复（本单元 a56b04d）

- 用完整记录命令重跑 D07：66/66 通过，退出码 0，13 文件与记录基线一致。
- 29/6 收窄在四处披露：verification-map note、verification.json、notes.md、
  governance 表。D07 状态保持 partial。
- 修正 design 文档路径 `runtime/control-session-projection.ts` →
  `runtime/control-process.ts` 的 `readObservedSessionProjection`。
- recon 的 D08 清理声明补「driver 失败保留 root 之后的运行后手动移除」。
- verification.json 的 not_claimed 改为引用 L10 回归 run 1-4 的不稳定 5/3/3/6 集合。

## Round 2（修复后）—— PASS

reviewer：独立（fresh context，read-only，DSH 宿主 `openai-codex/gpt-6.1-sol`）
候选：`4d3ffe5..a56b04d`（5 提交，含 D07 修复与 review 记录）

verdict：PASS，无 blocking。

复核结论：
- d07_verified 全部为真：日志是真实 13 文件/66 用例运行，per-file 求和 66，
  `Tests 66 passed` 与 `GATE_EXIT=0` 均在，记录命令字段与 base 逐字节一致且与
  运行的文件集合一致，note 报 66/13；29/6 收窄在四个强制披露点（note 的
  Correction disclosed 段、verification.json 的 13/66 对象 + correction_disclosed
  字段、notes.md 计数纠正段与表格、governance L12 段点名 29/6）全部到位，design.md
  也披露；D07 在两个权威文件里均保持 partial，未声明任何未闭合项闭合。
- 其余 13 门禁的 measured 与日志逐文件、逐总数程序化比对全部一致；D08 如实记为
  A02 外部限流停、exit 1，不宣称通过。
- 三条 advisory 全部修复且对真实源复核：design 文档路径改为存在的
  `runtime/control-process.ts` 的 `readObservedSessionProjection`（:818）；
  recon 的 D08 清理改为运行后手动移除并解释日志中 retained root 字样的成因；
  not_claimed 引用 L10 回归 run 1-4 的 5/3/3/6 不稳定集合（L10 notes §6 核实）。
- 两个 JSON 均解析通过。

advisory（不阻断）：recon.md 调查表第 50 行还留被取代的「29 passed / 6 files | PASS」，
已在随后提交中改为 66/13 并注明收窄来源。round 2 结论记录于本文件。

（Round 2 后仅 recon.md 调查表行修正，不触及任何门禁状态或证据声明。）

