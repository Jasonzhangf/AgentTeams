# L12 资源盘点（存量 worktree 核销）

日期 2026-10-15。盘点范围：`/Volumes/Intel/playground/agentteams/` 下所有 worktree。
盘点方法：对每个 worktree 取 `git status --porcelain`、`git rev-list --count
origin/main..HEAD`（ahead）、`git merge-base --is-ancestor HEAD origin/main`
（是否已合入），并用 `ps` 复核是否有活动进程。不用 `pkill`、`killall` 或
`kill $(...)`；只用只读 `ps` 复核。

## 当前工作树清单（12 个，含主树）

| worktree | 分支 | ahead/behind | 合入 main | dirty | 分类 |
| --- | --- | --- | --- | --- | --- |
| `/Volumes/extension/code/AgentTeams` | main | 0/0 | — | 0 | 主树，只读 |
| `acp-l12-gate-closure-20261015` | codex/acp-l12-gate-closure-20261015 | 0/0（本单元候选） | 待集成 | 有 | 本单元，集成后回收 |
| `acp-console-20261010` | codex/acp-console-20261010 | 0/160 | MERGED | 11 | 可回收 |
| `acp-core-20261010` | codex/acp-core-20261010 | 0/160 | MERGED | 9 | 可回收 |
| `acp-d00-contract-20261010` | codex/acp-d00-contract-20261010 | 1/160 | not-merged | 1 | 已核销，见下 |
| `acp-d05-closure-20261011` | codex/acp-d05-closure-20261011 | 0/130 | MERGED | 1 | 可回收 |
| `acp-daemon-network-20261010` | codex/acp-daemon-network-20261010 | 0/160 | MERGED | 20 | 可回收 |
| `acp-execution-plan-20261010` | codex/acp-execution-plan-20261010 | 0/160 | MERGED | 4 | 可回收 |
| `acp-host-20261010` | codex/acp-host-20261010 | 0/160 | MERGED | 10 | 可回收 |
| `acp-intent-20261010` | codex/acp-intent-20261010 | 0/160 | MERGED | 2 | 可回收 |
| `acp-network-20261010` | codex/acp-network-20261010 | 0/160 | MERGED | 2 | 可回收 |
| `acp-ui-20261010` | codex/acp-ui-20261010 | 0/160 | MERGED | 4 | 可回收 |

`ps` 复核：0 个进程与这些 worktree 相关，无活动 daemon、无子进程。

## 核销结论

- 主树 `/Volumes/extension/code/AgentTeams`：保持只读，不回收。
- 本单元 `acp-l12-gate-closure-20261015`：按 SESE，集成并拿到远端回执与保留证据
  后才 `git worktree remove` + `prune` + 确认 `test ! -e`。
- 10 个 MERGED worktree（acp-console / acp-core / acp-d05-closure / acp-daemon-network /
  acp-execution-plan / acp-host / acp-intent / acp-network / acp-ui）：分支已合入
  `origin/main`（ahead=0，merge-base 是 HEAD 祖先）。它们的 dirty 内容分两类：
  1. 已被 `origin/main` 吸收的改动（如 acp-core 的 `config/acp-policy.ts`、
     `control-protocol/acp.ts`、`acp-adapter/stdio.ts`；acp-host 的
     `agent-host/acp-host.ts`；acp-intent 的 `config/daemon-intent.ts`；
     acp-console 的同名文件——逐一 `git cat-file -e origin/main:<path>` 确认为
     present）。
  2. 未跟踪的早期计划/设计文档（acp-execution-plan 的
     `docs/design/teams-acp-daemon-v1.md`、`docs/goals/teams-acp-network-execution-prompt.md`
     等），其意图已被 D00 合同与已交付的 v4 设计取代，无独立保留价值。
     少数早期原型文件（`network/discovery-client.ts`、
     `ui/teams-console/src/client/acp.ts`）在 `origin/main` 无同名文件，但其语义
     已由交付 owner 取代：discovery/registration 语义在
     `runtime/registry-registration.ts` + `network/registration-client.ts`，UI 的
     连接/请求状态类型在 `control-protocol/console-api.ts` 与
     `control-protocol/acp.ts`。这些是历史原型，不是待交付内容。
  结论：RECYCLABLE_CLEAN 等价（内容已吸收或已被取代），可回收。

- `acp-d00-contract-20261010`（not-merged，ahead=1，1 dirty 文件）——逐文件核销：
  - 未合并提交 `eba1276 feat: establish ACP daemon contract foundations` 的 11 个
    文件（acp-adapter/stdio.ts、config/acp-policy.ts、config/daemon-intent.ts、
    control-protocol/acp.ts、control-protocol/teams-connection.ts 及其 spec）
    全部 `git cat-file -e origin/main:<path>` 确认为 present，即内容已进 mainline。
    该提交未走 merge（可能是 cherry-pick 或 rebase 入 main），不构成缺口。
  - 唯一 dirty 文件 `control-protocol/engine.ts`：工作树把 `AcpDuplex` 从 import
    改为内联接口声明。已比对 `origin/main:control-protocol/engine.ts` 完全包含该
    内联声明，即该改动已被 mainline 吸收。
  结论：EXTRACT_THEN_CLOSE 已核销（无可提取的未合入内容），可回收。

## 清理计划（本单元交付后执行）

主树之外 11 个存量 worktree + 本单元树共 12 个。执行顺序：

1. 本单元集成到 `origin/main`，拿到 push 回执与 `git ls-remote` 复核。
2. `git worktree remove` 本单元树 → `git worktree prune` → `test ! -e <path>` 确认。
3. 对 10 个 MERGED 树 + d00 树执行 `git worktree remove --force`
   （内容是已吸收或已被取代的 dirty/untracked，无活动进程），然后
   `git worktree prune`，逐个 `test ! -e` 确认。
4. 删除对应本地分支（已合入，无 ahead）。
5. 复核 `git worktree list` 只剩主树。

所有删除只用显式路径与 `git worktree remove`，不用脚本批量删除、不用
`pkill`/`killall`/`kill $(...)`。每步只读复核后进入下一步。
