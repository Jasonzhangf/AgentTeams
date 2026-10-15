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

## Round 2（修复后）—— 待复核

候选：4d3ffe5..a56b04d（5 提交）。复核范围仅限 round 1 的 2 个 blocking 与 4 条
advisory 的修复是否到位，不重审未触及内容。

Round 1 结论与已确认的诚实性事实不因修复改变：其余 13 门禁计数与日志逐一对上、
计数纠正是 append-only、D08 不宣称通过、provider-config-v1 生产绑定属实、资源
盘点属实。

（reviewer 复核结论补记于此。）

