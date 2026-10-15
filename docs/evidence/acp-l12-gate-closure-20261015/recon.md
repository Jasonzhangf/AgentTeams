# L12 ACP 门禁按证据升级 —— 侦察结论（2026-10-15）

本文件记录 L12 开工前的盘点，供后续轮次直接接续。

## 目标（来自总目标）

按证据升级 14 个 `teams-acp-*` 门禁并收口五张 map 与 governance。
语义不变量（AGENTS）：**任何门禁在其未闭合项消除前不得升级**。

## 基线与环境

| 项 | 值 |
| --- | --- |
| base | `origin/main` = `4d3ffe5`（L10 已集成；L11 已在 `193201b`） |
| worktree | `/Volumes/Intel/playground/agentteams/acp-l12-gate-closure-20261015` |
| branch | `codex/acp-l12-gate-closure-20261015` |
| frozen install | `pnpm install --frozen-lockfile`，INSTALL_EXIT=0 |
| node / pnpm | v22.22.2 / 10.31.0 |

## 一项必须先记录的环境事实（不是代码回归）

首跑 `teams-acp-d06-control` 时 8/27 个 `runtime/control-process.spec.ts` 用例失败，
报 `START_TIMEOUT`。隔离单跑同样失败，**手动起一个真实 control 子进程后确认**：

```
control process failed: INVALID_CONFIG console-host static assets and the compiled UI
are missing beside the control entry: <tree>/runtime/control-process.ts; run pnpm build first
```

原因：新 worktree 没有 `console-host/static` 与 `ui/teams-console` 的编译产物，子进程在
`presentationRoots()` 抛错，**该抛错发生在 try 块之外**，因此子进程不写 `failed` state，
父进程一直读到 `starting`，最终 START_TIMEOUT。L10 门禁当时通过，是因为 L10 树里已有构建产物。

处理：`pnpm build`（BUILD_EXIT=0）后重跑，`runtime/control-process.spec.ts` 27/27 全过。
这不是缺陷修复，是 L12 树缺失构建产物。`docs/development-governance.md` 第 4 步已要求
"从最新 origin/main 建树并 `pnpm install --frozen-lockfile`"，但未要求构建；本次补记。

## 14 个门禁的实测（同一树、同一 base 4d3ffe5）

| gate | 命令记录 base | 本次实测 | 结果 |
| --- | --- | --- | --- |
| teams-acp-daemon-intent | 83496b7 | 35 passed / 2 files，exit 0 | PASS |
| teams-acp-public-contract | 83496b7 | 17 passed / 3 files，exit 0 | PASS |
| teams-acp-d01-host | 75a6cf4 | 61 passed / 4 files，exit 0 | PASS |
| teams-acp-d02-opencode | 1d4df3a | 65 passed / 4 files，exit 0 | PASS |
| teams-acp-d03-dsh | 83496b7 | 58 passed / 3 files，exit 0 | PASS |
| teams-acp-d04-registry | 953d952 | 75 passed / 6 files，exit 0 | PASS |
| teams-acp-d05-network | 83496b7 | 103 passed / 11 files，exit 0 | PASS |
| teams-acp-d06-control | 83496b7 | 143 passed / 7 files，exit 0 | PASS |
| teams-acp-d07-webui | 83496b7 | 29 passed / 6 files，exit 0 | PASS |
| teams-acp-serve-entry | 83496b7 | 68 passed / 3 files，exit 0 | PASS |
| teams-acp-l9-intent-side | 83496b7 | 72 passed / 4 files，exit 0 | PASS |
| teams-acp-l9-session-write-side | d531d24 | 81 passed / 4 files，exit 0 | PASS |
| teams-acp-l10-session-projection | 83496b7 | 86 passed / 6 files，exit 0 | PASS |
| teams-acp-d08-acceptance | 83496b7 | **FAIL，见下** | 未闭合 |

per-file 明细见本目录各 `gate-*.log`。

## D08 黑盒重跑：到远端 provider 限流为止的实测

`node docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs`，exit 1。

已通过（11 项子断言，全部 PASS）：

- install：`pnpm build:governance` 出 final 包（271 files，content sha `60cba7c0…`）、
  tarball 1557425 bytes 装进树外 prefix、installed 副本暴露编译后 Teams 模块。
- A01 六项：一 config 一 daemon、身份独立、存储独立、IP/port 独立、
  **installed CLI 读回每个 daemon**（registry pid=31602 gen=1；control pid=37427 listener 127.0.0.1:64933）、
  一 config 绝不启第二个 daemon。
- A02 两项：两个引擎都是 installed CLI daemon 的真实子进程；
  **OpenCode 完成真实 prompt/process/reply**（session=ses_ebf49b306f…，permission options
  once/always/reject，stopReason=end_turn）。

失败点：A02 的 DSH prompt。

```
D08 acceptance FAIL [A02 dsh prompt]: the real DSH prompt failed:
{"code":-32603,"message":"Internal error: turn failed: teams-workbuddy API error (400):
{"code":"model_unavailable","gateway_hint":"model_blocked: 13 account(s) cooling down
this model; earliest unblock at 2026-10-16T02:00:01+08:00; ...
```

**这是远端 provider 网关对 `wb-deepseek-v4.1-flash` 的账号级限流**（13 个账号冷却中，
最早 2026-10-16 02:00 UTC+8 解锁），不是 AgentTeams 代码缺陷。A02-opencode 在同一 run
里用同一套代码完成真实 prompt，证明被验链路本身可用。

后果：A03–A11 未执行。按证据边界，D08 **不得升级**，保留 partial，并把本次重跑与失败原因
记进它自己的 note。已清理：owned temp root `/var/folders/.../T/d08-acc-RjzpQa` 已删除，
所有 owned pid 已退出（ps 复核 0 个残留）。该清理是 driver 失败保留 root 之后的一次
运行后手动移除（driver 自身在 A02 失败路径上保留 root 供检查），移除后用只读 `ps`
复核 0 残留；`gate-teams-acp-d08-acceptance.log` 末尾因此仍留 "Retained owned temp root"
字样，反映的是 driver 失败时的保留行为，不是清理未发生。

## 五张 map 与 governance 的待办

1. `docs/architecture/verification-map.json`：14 个 `teams-acp-*` gate 全部保留 `partial`，
   每条 note 追加行内 2026-10-15 标记，写明 L12 本次实测结果与其未闭合项。
2. `docs/development-governance.md`：门禁表与 prose 同步（补构建前置要求）。
3. L9 notes §11 的 7 条 advisory 措辞（resource-map `acp-frame-contract`、
   mainline `provider-config-v1`、两份 design 的状态段、三处行内 2026-10-14 标记）。

## 资源盘点

worktree 清单与 10 个 PROTECTED_HOLD 未见变化；L12 未新增 worktree，未动他人资源。
