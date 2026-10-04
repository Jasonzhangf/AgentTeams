# 4b6c377 U4 persistent Work lifecycle design r2 - run notes

Task: `codex/u4-persistent-design-20261004` (fresh GCM design author, r2 primary architecture correction).
Base: `73eaf0944f1a9d0c8d47009d5b9780c5ae8068d6`. Worktree:
`/Volumes/Intel/playground/agentteams/u4-persistent-design-20261004` (own, clean at start).
Mode: design only. No implementation, no install, no review, no PASS claim, no Collab/AGY,
no commit/merge/push, no memory writes. Allowed writes only:

- `docs/design/teams-local-work-entry-v1.md`
- `docs/design/dagpipe/graphs/agent-work.graph.json` (restored to `@2`, version only)
- `docs/design/dagpipe/graphs/work-open.graph.json` (new)
- `docs/design/dagpipe/graphs/work-request.graph.json` (new)
- `docs/design/dagpipe/graphs/work-close.graph.json`
- `docs/evidence/4b6c377-u4-persistent-design-20261004/**`

`work-query.graph.json` is read-only/unchanged. `agent-host/cli-executor.ts` and
`cli-adapter/cli.ts` were read as blackbox input contracts only.

## Node notes

| 时间 (UTC) | 节点 | 结论/状态 | 证据 | 下一步 |
|---|---|---|---|---|
| 2026-10-04T03:53Z | read | 读 `docs/design/teams-local-work-entry-v1.md`、`agent-work/work-query` graph、`teams-behavior-model.md`、`runtime/agent-work-client.ts`、`agent-host/work-host.ts`、`agent-host/work-ingress.ts`、`control-protocol/work-wire.ts`、`network/work-channel.ts`、`docs/goals/teams-user-delivery-plan.md` (BB06) | 本 worktree 真源 | 读 D3 候选 + U2 receipt |
| 2026-10-04T03:56Z | read | 读 D3 候选 `/Volumes/Intel/playground/agentteams/d3-u4-work-20261003` 的 `runtime/dagpipe/{host.ts,protocol.ts,runner/src/bin/runner.rs}`（只读）；确认 `settle-work` 固定映射 `agentWork.close`+`agentWork.dispose`，即每次 submit 必 close；`AgentWorkChannel` 无 continue 语义 | D3 候选只读 | 定最小扩展 |
| 2026-10-04T03:57Z | read | 读 U2 frozen receipt `~/.codex/task-evidence/agentteams/receipts/u2-config-seams-20261004/primary-consumption-receipt.json`：`LocalServiceIntent` projected 字段与 `workControl` 为 tested-unmerged candidate，未安装、未 review；`sdkAdmission=false`、`architectureReview=false` | receipt | 引用而非依赖 PASS |
| 2026-10-04T03:57Z | baseline-validate | `dagpipe graph validate` 基线：`agentteams.agent-work@2` (5 nodes) 与 `agentteams.work-query@1` (4 nodes) 均 valid DAG，rc=0 | 命令输出 | 写修订 |
| 2026-10-04T03:59Z | edit-graphs | `agent-work.graph.json` version `2 -> 3`（拓扑/节点/operator 绑定不变）；新增 `work-close.graph.json`（`agentteams.work-close@1`，3 节点，单输入单输出，复用既有 operator 端口） | git diff | validate |
| 2026-10-04T04:00Z | edit-doc | 追加 `teams-local-work-entry-v1.md` §11（持久 Work 生命周期：admission/closure typed 控制、continue 不 repropose、显式 close 独立图、unknown/retained、断连/重启/generation、未来文件/maps/tests、BB06 黑盒用例）；更新 §6/§10 版本一致性 | git diff | fence/diff check |
| 2026-10-04T04:01Z | validate-r1 | `dagpipe graph validate` agent-work@3 / work-close@1 / work-query@1 全部 rc=0；`git diff --check` rc=0（r1 结果，已被 r2 取代） | r1 命令输出 | r2 纠正 |
| 2026-10-04T04:05Z | read-r2 | 读 primary 纠正要求 + `cli-adapter/cli.ts`、`agent-host/cli-executor.ts`：`context.create` payload 是 `{}`/`{initialUrl}`（无 `profile`）；`navigate`/`snapshot`/`context.destroy` 需返回的 `business.contextId`；`browser-context` 容量 2（work scope） | 本 worktree 真源 | 重写 §11 |
| 2026-10-04T04:07Z | edit-graphs-r2 | `agent-work.graph.json` version `3 -> 2`（仅版本，恢复原始一次性语义）；`work-close.graph.json` close 节点 operator `teams.settle-provider-work -> teams.close-provider-work`；新增 `work-open.graph.json`（`@1`，5 节点，末节点 `teams.return-held-work`）与 `work-request.graph.json`（`@1`，4 节点，无 admit 节点） | git diff | validate |
| 2026-10-04T04:09Z | edit-doc-r2 | §11 重写：独立 SESE graph 结构表达 open/request/close（无 Operator 内部 route-skip）；删除 `admission`/`closure` 控制；区分 `--generation`(launcher) 与 `--provider-generation`(provider)；修 §11.9 黑盒 payload（`{}` + `business.contextId` + 显式 `context.destroy`）；§5/§6/§10 版本一致性 | git diff | validate |
| 2026-10-04T04:11Z | validate-r2 | `dagpipe graph validate` agent-work@2 / work-open@1 / work-request@1 / work-close@1 / work-query@1 全部 rc=0；`git diff --check` rc=0；fence 计数（见下） | 见下 | stage |

## Validation commands (actual)

```sh
$ dagpipe graph validate docs/design/dagpipe/graphs/agent-work.graph.json
valid DAG: agentteams.agent-work@2 (5 nodes, 4 edges, 5 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
$ dagpipe graph validate docs/design/dagpipe/graphs/work-open.graph.json
valid DAG: agentteams.work-open@1 (5 nodes, 4 edges, 5 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
$ dagpipe graph validate docs/design/dagpipe/graphs/work-request.graph.json
valid DAG: agentteams.work-request@1 (4 nodes, 3 edges, 4 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
$ dagpipe graph validate docs/design/dagpipe/graphs/work-close.graph.json
valid DAG: agentteams.work-close@1 (3 nodes, 2 edges, 3 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
$ dagpipe graph validate docs/design/dagpipe/graphs/work-query.graph.json
valid DAG: agentteams.work-query@1 (4 nodes, 3 edges, 4 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
$ git diff --check
(rc=0)
$ grep -c '^```' docs/design/teams-local-work-entry-v1.md
20
```

Note: `dagpipe graph validate` is **static topology/operator-binding** validation only. It is
**not** SDK execution, not compile(), not runtime, not install evidence.

## Changed paths and content hashes (sha256, at 2026-10-04T04:12Z)

| path | status | sha256 |
|---|---|---|
| `docs/design/dagpipe/graphs/agent-work.graph.json` | modified then restored to `@2` (net: version only, matches base semantics) | `868eaca31896dff5d260fe0a5d87a8d1c0f005f7a378a7703f747fdda4a3f974` |
| `docs/design/dagpipe/graphs/work-open.graph.json` | added (`agentteams.work-open@1`) | `a31a356c5f2b22e3ced58213b3e3723e73304b4fd9ff0fe1c148d8c6db6843f6` |
| `docs/design/dagpipe/graphs/work-request.graph.json` | added (`agentteams.work-request@1`) | `eff7d273bc1dfecc279e2c6eabbc47a1c4c15bfb43f3a53a3e92bbf3cd445d2f` |
| `docs/design/dagpipe/graphs/work-close.graph.json` | added (`agentteams.work-close@1`, close operator) | `0682d0937d504b9daa66b91133348089289716df62abfbee41bbce004896d34f` |
| `docs/design/teams-local-work-entry-v1.md` | modified (r2 §11 rewrite) | `e7a9e1ae0f2693f6b4698458e26d6817515f7f8da2cc2ca492d0352987a0a05d` |
| `docs/evidence/4b6c377-u4-persistent-design-20261004/run-notes.md` | added/updated | (self; hash changes on edit, recorded last) |

## Remaining implementation dependencies (not done here)

- D3/U4 runner `host.ts` `OPERATOR_OPERATIONS`, runner Operator registry and project `compile()`
  must register two **new** Operators: `teams.return-held-work` (host: `agentWork.dispose`
  only, `workClosure: retained`) and `teams.close-provider-work` (host: `agentWork.close` +
  `agentWork.dispose`, provider-authoritative). No `admission`/`closure` WorkIntent fields.
- Pack must ship and fingerprint `work-open@1`, `work-request@1`, `work-close@1` (plus existing
  `agent-work@2`, `work-query@1`) in `runtime/dagpipe/manifest.json` `graphs[]`.
- U2 config owner must land `[workControl]` schema/parser/serializer; U2 candidate remains
  tested-unmerged/uninstalled.
- Maps (`verification-map.json` `teams-behavior-dag-topology`, `mainline-call-map.json`,
  `resource-map.json`, `function-map.json`, `.appsdk/maps/**`) must be re-bound to
  `agent-work@2` / `work-open@1` / `work-request@1` / `work-close@1` / `work-query@1` in the
  implementing unit (integration owner).
- `scripts/blackbox-user-mvp.mjs` is pending; §11.9 commands were **not** executed.
- Independent design review and integration are owned by the parent, not this author.
