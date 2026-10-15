# L12 门禁按证据升级与地图收口 —— 设计（2026-10-15）

## 目标（来自总目标）

按证据升级 `teams-acp-*` 门禁并收口五张 map 与 governance。
本单元是 gate-evidence + map/governance 收口单元，不重新论证代码。

## 语义不变量

任何门禁在其未闭合项消除前不得升级。本单元只做三件事：

1. 用最新 `origin/main` 候选 4d3ffe5 全量重跑每个 `teams-acp-*` 门禁自身命令并记录；
2. 把每门禁本次实测与未闭合项写进它自己的 note（行内 2026-10-15 标记）；
3. 按 L9 notes §11 的 7 条 advisory 收紧五张 map、两份 design 与三处历史证据的措辞。

不把其他门禁/单元的引用当作本门禁自己的证据（D01 约定，同 L10/L11）。

## 关键决策

### 决策 1：门禁全部保留 `partial`

14 个门禁在候选 4d3ffe5 上按其自身命令重跑，13 个通过。一个通过只证明
命令在新树上仍绿，不消除该门禁自己声明的未闭合项（installed-copy /
restart / deployed-entrypoint / cross-device 回执、真实引擎推理、A07 事件
驱动动画、L10 的 sessionEvents 与 permission 身份等）。因此没有门禁状态被
升级。L10/L11 已按 D01 约定把其他门的证据留作本门的引用，本单元沿用。

### 决策 2：D08 黑盒因外部限流停止，如实记为未闭合

D08 黑盒在 A02 的 DSH prompt 处被远端 provider 网关拒绝
（HTTP 400 `model_unavailable`，`model_blocked: 13 account(s) cooling down
this model; earliest unblock at 2026-10-16T02:00:01+08:00`）。A03–A11
未执行。其 2026-10-12 的 45 checks / 3 gaps / exit 0 结果仍作为本门禁
自己的记录，本次重跑既不抬高也不降低它。L11 已建立「D08-browser producer
不运行时 gate note 引用它」的惯例，本单元沿用并显式写出。

### 决策 3：构建前置补记（不是缺陷）

新 worktree 若缺少 `console-host/static` 与 `ui/teams-console` 的编译产物，
任何 spawn 出的 control 子进程都会在写 state 前于 `presentationRoots()` 抛错，
父进程因此一直读到 `starting` 并最终 `START_TIMEOUT`。`pnpm build` 退出码 0
后同一条命令恢复 27/27。这已记入 recon 与 D06 门禁 note，并把构建前置写进
governance 段落。这是环境前置，不是缺陷。

### 决策 4：门禁计数按新树纠正，不回溯旧数

L9/L10 的 session 增量把 `runtime/control-process.spec.ts` 从 17 → 23 → 27、
`agent-host/acp-host.spec.ts` 从 23 → 27。旧记录里的 53/53（d01）、119/119
与 135/135（d06）、77/77（l9-write）在新树上变成 61、143、81。本单元在各自
note 里记「当前计数 = 同一命令对更大树」，不把旧数字改写成新数字，也不把新
数字当成新范围。

## 范围（本单元要改的文件）

- `docs/architecture/verification-map.json`：14 个门禁 note 追加 2026-10-15 标记。
- `docs/development-governance.md`：追加 L12 收口段（含构建前置）。
- `docs/architecture/resource-map.json`：`acp-frame-contract` note 收紧。
- `docs/architecture/mainline-call-map.json`：`provider-config-v1` master-host edge
  与 `acp-host-wiring-v1` chain note 收紧。
- `docs/design/teams-agent-relation-communication-v1.md`、
  `docs/design/teams-control-protocol-v2-master-agent-host.md`：状态段更正。
- `docs/evidence/acp-d05-network-20261010/notes.md` 第 2/4/5/6 项、
  `docs/evidence/acp-d08-acceptance-20261011/verification.json` `.gaps[2].reason`、
  `docs/evidence/acp-d07-webui-20261011/notes.md:122`：行内 2026-10-14 标记。
- 新增 L12 证据：recon.md、design.md、notes.md、review.md、verification.json、
  resource-inventory.md、gate-*.log。

## 验收

- 14 个门禁按自身命令可执行且结果入日志；
- 五张 map 与 governance 在同一变更内同步；
- 独立 reviewer 用 `openai-codex/gpt-6.1-sol` 审本单元；
- 集成到 `origin/main` 用编号提交 + `--no-ff` + 树等价 + 回执 + push + ls-remote。
