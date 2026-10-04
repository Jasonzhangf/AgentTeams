# 4b6c377 U4 open-binding narrow design fix (single P1) - run notes

Task: `codex/u4-open-binding-design-20261004` (fresh GCM author; independent Desktop child, not Collab).
Base: `07006d69f574fe23dbf2df517d51e15429dd82a1`. Worktree:
`/Volumes/Intel/playground/agentteams/u4-open-binding-design-20261004` (own, clean at start).
Mode: design only. No implementation, no install, no review, no PASS claim, no Collab/AGY,
no commit/merge/push, no memory writes, no product code. Reuses issue `4b6c377`.
Finding: r5 final review single P1 - persistent open allows unfixed target selected by the
receiver after dispatch; provider/generation only returned in the final held-work receipt, so a
lost final receipt leaves query/close without a required binding.

Allowed writes: `docs/design/teams-local-work-entry-v1.md`,
`docs/design/teams-behavior-contracts.md`, the four `docs/architecture/*.json` maps (narrow,
only if affected), `docs/design/dagpipe/graphs/work-open.graph.json` (only if schema requires,
keep topology), `docs/evidence/4b6c377-u4-open-binding-design-20261004/**`.

## Node notes

| 时间 (UTC) | 节点 | 结论/状态 | 证据 | 下一步 |
|---|---|---|---|---|
| 作者未记录实时时间 | read | 读 r5 final finding、`teams-local-work-entry-v1.md` §2/§6/§11、`teams-behavior-contracts.md`、`work-open.graph.json`、四张 maps 现状 | 本 worktree 真源；原占位时间不是实际执行证据 | 读只读真源 |
| 作者未记录实时时间 | read-source | 只读核对 `runtime/local-supervisor.ts` `LocalDaemonEndpointProjection`/`LocalDaemonStatusProjection`（含 `generation`）与 `runtime/local-process.ts` status owner（`statusLocalProcess` 投影 endpoint generation）；CLI `status` 命令为既有 owner | 只读；由 primary 下方当前核对收口 | 定最小编辑 |

## 2026-10-04T06:57:59Z / primary architecture consumption

The author exceeded its 15-minute budget without completing validators. Primary
stopped only owned codex PID 86571 and confirmed it and wrapper 86568 ESRCH.
The wrapper exit is not an author-completion or validation claim. Original
events and the tracked frozen patch remain in the Desktop task evidence.

Primary checked the current immutable pre-dispatch target design, original Work
generation versus query link generation, and complete unconfirmed control
binding. The existing `statusLocalProcess` projects typed endpoints from
`readLocalDaemonStatusProjection`; no new status owner or generation store is
introduced. Primary corrected two CLI signature inconsistencies: open exposes
explicit capability options; target generation is mandatory in its control
frame while its argument can be omitted only when the exact selected Agent's
typed status supplies it. Request and close still require the original argument.

Current architecture and graph JSON parse, document fences, and `git diff
--check` passed. Actual `dagpipe graph validate` accepted all five graphs:
agent-work 5/4/5, work-open 5/4/5, work-request 4/3/4, work-close 3/2/3,
work-query 4/3/4 (nodes/edges/waves). This is static design evidence only.
BB06h specifies two matching providers and loss of the whole final open receipt:
the CLI already knows the complete original binding and identities, so a fresh
get can reach P1 without replay and an explicit close can release only after
provider confirmation. These are future implementation obligations, not tests
already executed. Next: latest-main composition and independent design review.
