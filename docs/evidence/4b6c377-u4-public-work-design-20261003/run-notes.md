# U4 公开 Work 入口 — 窄设计阶段 run notes

Owner：独立 Desktop GCM child（本设计阶段）。Worktree：
`/Volumes/Intel/playground/agentteams/u4-public-work-design-20261003`；branch
`codex/u4-public-work-design-20261003`；base `b969e9740704977326c5054fb3afbeab8d523e36`。
首轮作者的允许写入仅 `docs/design/teams-local-work-entry-v1.md` 与本证据目录；r2 由 Primary 明确增加 `docs/design/teams-local-config-v3.md` 的 U4 控制资源契约附录。本阶段不实现产品代码、
不 commit/review/merge/push、不安装/重启 daemon、不修改 U2/D3 候选树。

| Time | Node | Status | Conclusion / evidence | Input version and environment | Next |
|---|---|---|---|---|---|
| 2026-10-03 | baseline | complete | worktree 干净，HEAD `b969e9740704977326c5054fb3afbeab8d523e36`，tree `b6464bbec1804ea0e3e58b0a955a4547586bb267`，仅本 branch；两个允许路径均不存在。 | `git status --short --branch`, `git rev-parse HEAD`/`^{tree}`; `ls` 两个允许路径。 | 读 D1/B2/B8/五图与源码。 |
| 2026-10-03 | source-read | complete | 已核实公开缺口：CLI `work` 调 `runLocalConfiguredWork` 只读 `internal.toml [configuredWork]`；`loadAgentProcessConfig` 要求 `endpoint.connect.payload`；child IPC 只回 ready/status；receiver 已建 `consumerWork` 但无 caller。 | `cli/agentteams.mjs:366`, `runtime/local-process.ts:473`, `runtime/agent-process.ts:117,349,406`, `runtime/local-supervisor.ts:420`。 | 读 D1 契约 + B2/B8 graph + D3 host/protocol。 |
| 2026-10-03 | contract-read | complete | B2=agent-work@2（5 节点）、B8=work-query@1（4 节点）为拓扑真源；D3 host 提供 `runWorkExecution(client, request)`，固定 Operator→operation port；U2 v3 `parseV3Connect` 只含 service 选择。 | `docs/design/teams-behavior-contracts.md`；两份 graph JSON；D3 `host.ts`；U2 `runtime/local-config.ts:1187`。 | 选定唯一最小实现并写设计。 |
| 2026-10-03 | graph-validate | complete | 两张图保持拓扑真源，只读校验通过：`agentteams.agent-work@2`（5 节点/4 边）、`agentteams.work-query@1`（4 节点/3 边），valid。 | `dagpipe graph validate docs/design/dagpipe/graphs/agent-work.graph.json` 与 `.../work-query.graph.json`；图 SHA `868eaca...`/`9903e27...`。 | 无图改动，写设计与证据。 |
| 2026-10-03 | design-written | complete | 选定唯一缺失 seam：launcher 自有 Unix socket → child IPC → receiver `AgentWorkClient` → D3 `runWorkExecution`；CLI `work submit`/`work query` 分离 identity；移除 `connect` 业务字段与 startup configuredWork 链。 | `docs/design/teams-local-work-entry-v1.md`。 | 记录依赖绑定与定向检查。 |
| 2026-10-03 | dependency-bind | complete | U2/D3 候选绑定为未合并/未安装依赖（tree/API/hash 见 `dependency-bindings.txt`）；本设计不宣称 admission 成功，不改其候选树。 | `dependency-bindings.txt`; U2 source-hashes.txt 21 项。 | 跑定向检查并冻结。 |
| 2026-10-03 | terminal-check | complete | 仅两个允许区域写入；`git diff --check`、graph validate、JSON parse 通过；无自有 probe/tmp/process 残留；停止写入。 | `git status --short --branch`, `git diff --check`, `dagpipe graph validate`, `python3 -c json.load`。 | Primary 接手独立设计 review 与后续实现。 |
| 2026-10-03 | review-p1-hash | complete | `source-hashes.txt` 旧三行是作者修订前字节，不能绑定当前 review candidate。保持旧值只作历史 provenance，稍后由最终冻结 manifest 覆盖为当前字节。 | `.agent-collab/review/u4-public-work-design-20261003-r1/review.final.md` P1 line 1。 | 冻结 design/config/evidence 后重新生成。 |
| 2026-10-03 | review-p1-owner | complete | `[workControl]` 已转成 U2 `internal.toml` 唯一 owner 的显式扩展：字段/类型/固定 socket path/exact ref、`runtime/local-config.ts` parser/serializer/locked-write primitive、启动前 admission 与 stop/failure cleanup；当前 U2 tree 明确未实现。 | `docs/design/teams-local-config-v3.md` §4.1; `docs/design/teams-local-work-entry-v1.md` §4/§8/§9。 | 对读 findings、跑 targeted checks、冻结 hash。 |
| 2026-10-03 | p1-consistency | complete | 两设计一致：`[launcher].generation/startToken` 仍是唯一真源；`[workControl]` 只参考 socket path 与 generation/startToken，无业务 receipt/payload/token 副本；provider ledger 唯一。 | 两 design 的 `[workControl]`、owner、startup/admission、stop/cleanup sections。 | 精确 changed-path、fence、hash、graph validate、diff check。 |
| 2026-10-03 | hash-observation | superseded | 作者此时记录的是尚未完成全部笔记/依赖修订的中间哈希，不能绑定最终候选。当前四文件哈希只由所有文件冻结后生成的 `source-hashes.txt` 承载；本笔记不嵌入自身最终哈希。 | 作者 r2 原始 events/final 保留在 Primary task-evidence；当前 `source-hashes.txt`。 | Primary 冻结并核对当前 manifest，再记录外部 candidate tree。 |

## Node state / cleanup

- r1 历史：Primary 消费作者30412 exit0/turn.completed/ESRCH，当时 source-hashes.txt 是修订前作者文档哈希。
  编码前补齐 typed submit/query 的四类身份、provider/SDK receipt 与错误保真、未投递失败
  不伪造 unknown/retained、既有 launcher/内部配置 caller 路径。澄清 U1 manifest 是已准入
  包设计6526667的未来产物，D3 Git tree 是基线而非 untracked source 的候选树。当前文档
  当时哈希由 Primary candidate receipt 绑定。r2 已把原作者哈希标为历史 provenance，并由当前 manifest 绑定修订文件。Primary 消费 r2 作者75918 exit0/turn.completed/ESRCH 后，仅纠正本笔记的中间哈希/阶段 scope 说明并重新冻结 manifest。下一节点：独立 review；没有产品编码、安装或 SDK/BB 完成声明。

- 本阶段未创建临时 probe、socket、进程或监听；无自有资源需回收。
- 未修改 B2/B8 graph、五张 architecture map、U2/D3 候选树或任何源码/测试。
- 保留义务：U2 与 D3/U4 候选未合并、未安装；实现前须与本设计冻结到同一候选树。

## Memory candidate

- 候选（交 Primary review，不在本 worker 晋升）：Teams 公开 Work 入口的唯一缺失接缝是
  launcher 自有的本机 Unix socket typed 控制入口；submit 每次新生成 Work/request identity，
  query 保留原 identity 但用新 execution/attempt 且只 get 不重放；`connect` 只做 service 选择。
- Evidence：`docs/design/teams-local-work-entry-v1.md`、本目录 `dependency-bindings.txt`。
- Suggested tags：`ai-reviewed`, `human-unreviewed`。
