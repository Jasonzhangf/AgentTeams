# U3 services-design 20261003 run notes

本文件是 `9b84aaa` 候选设计阶段的节点笔记，不创建 bug/goal/memory，不等待外部 Master。base：`c3aa36fc637e2da4ac821d1b26d587eadbbf1268`；branch：`codex/u3-services-design-20261003`。

## Primary r1 consumption and bounded correction

Author 35234 与 reviewer 95278/95253 均 ESRCH。r1 controller 为 protocol_failure/review_output_schema_invalid、exit0（scope.commit 缩写），不是 PASS。仍消费其中两项具体问题：browser 任意 operation 子集缺 context 生命周期；cancelled 终点与当前 unsupported cancellation 不符。仅在两允许文档修订：browser MVP 必须完整四 operation、子集发布前拒绝并列公开反向用例；当前仅 succeeded/failed/unknown，cancel 返回 unsupported；状态机不冒充 SESE。组合已推送 origin/main 71094ac，不改产品/既有图/maps。下一步定向文档/图检查、freeze，链接原 protocol failure 的新独立 r2 审查。尚无产品或安装 BB03/06。

| 时间（PDT） | 节点 | 结论/状态 | 来源/证据路径 | 输入版本及必要环境 | 下一步 |
|---|---|---|---|---|---|
| 2026-10-03T04:50 | worktree/baseline | 已确认 | `git status --short --branch` 为空；`git rev-parse HEAD` 返回 base；目标文件均不存在 | cwd `/Volumes/Intel/playground/agentteams/u3-services-design-20261003` | 读取任务路由与真实 owner 边界 |
| 2026-10-03T04:54 | scope/facts | 已确认 | 只允许改 `docs/design/teams-local-services-v1.md` 与 `docs/evidence/u3-services-design-20261003/run-notes.md`；产品/tests/graphs/maps/goals 只读；无 commit/push/install/shared daemon mutation | AGENTS 项目契约与用户任务约束 | 写最小设计候选 |
| 2026-10-03T04:56 | U2 boundary | 已确认 | U2 proposed `services.{version,operations,resources}` 只是用户意图，不是线上 `CapabilityDeclaration`；U3 编译 schema/cancellation 并保留 adapter semantics | `/Volumes/Intel/playground/agentteams/u2-config-design-20261003/docs/design/teams-local-config-v3.md` | 建立唯一 compiler/executor 合同 |
| 2026-10-03T04:59 | current topology | 已确认 | B1 `publish-services` 与 B2 `admit/request/settle` 已有对象边；U3 不需第二拓扑 | `docs/design/dagpipe/graphs/daemon-start.graph.json`、`agent-work.graph.json`、`docs/design/teams-behavior-contracts.md` | 设计验证并记录 exact pending/blocker |
| 2026-10-03T05:12 | design draft | 已写，待独立 review | `docs/design/teams-local-services-v1.md`；明确 U2 intent/U3 compiler/provider ledger/D3-U4 seam、SESE 与 PENDING 黑盒计划 | base `c3aa36fc637e2da4ac821d1b26d587eadbbf1268` | 运行文档与图检查并 stage 两文档 |
| 2026-10-03T05:16 | design checks | PASS（设计检查） | `git diff --check` 与 `git diff --cached --check` 空；Markdown fence 平衡；两 graph validate 输出 `valid DAG` | 无依赖安装、无 build、无 daemon/browser、无全 suite | 复核 staged scope 与 tree receipt |
| 2026-10-03T05:20 | black-box plan | 已补精确入口 | 现有命令绑定 `runtime/local-two-agent.spec.ts`、`runtime/agent-process.spec.ts` 与 agent-host/ledger tests；installed BB03/BB06 driver 明标待实现 | 本次不执行这些用例 | stage、tree receipt |
| 2026-10-03T05:24 | candidate freeze | 待写 | staged scope 仅两文档；设计 152 行；等待最终 `git diff --cached --check` 与 `git write-tree` 回填 | base `c3aa36fc637e2da4ac821d1b26d587eadbbf1268` | primary 独立 design review |

## Primary r2 consumption, 2026-10-03T20:38 PDT

上面的 r1 protocol failure 与两处修订保留为历史，不改写成 PASS。r2 新增消费两点：

- P1：设计改为绑定 frozen U2 source producer 的 exact `runtime/local-config.ts` `LocalServiceIntent`、`localServiceIntent()` 投影、staged tree `b068173695c9183f8748850bc8dc903e0635c11f` 和 public consumer receipt；明确 `sdkAdmission=false`、`architectureReview=false`、`installedMvp=false`，并指出当前 `runtime/agent-process.ts` decoder 还不接受 `endpoint.services`，consumer seam 属于 U3 implementation。
- P2：现有 U2/focused/mapped 与 base regression 入口只列为 prerequisite/regression；service compile、disabled/receiver、capacity、public installed 用例单列 PENDING，使用 exact test/file/driver 名称，不允许零匹配 filter、fixture discovery 或 mock ledger 替代 provider admission。BB06 明确依赖 U4 persistent request lifecycle，不能被 one-shot 或 file-search-only 替代。
