# U3 services-design 20261004 run notes

时间：2026-10-03T20:38 PDT / 2026-10-04T03:38Z。范围：只读 U2 frozen producer 证据与现有架构图，修订 `docs/design/teams-local-services-v1.md`；不写产品代码、不安装、不启动 daemon/browser、不跑 full gates、不 commit/merge/push。

## Inputs verified

| 事实 | 实测输出 |
|---|---|
| U2 HEAD | `73eaf0944f1a9d0c8d47009d5b9780c5ae8068d6` |
| U2 staged tree | `b068173695c9183f8748850bc8dc903e0635c11f` |
| U2 `runtime/local-config.ts` staged blob | `e6394710e6d71f8b6c700a7644c37a5f2653a57e` |
| U2 `runtime/local-config.ts` SHA256 | `7471042543dae4062d9f17b86cafe94590626dfaba29c3aa5d8d0224cf5e50d5` |
| primary receipt | `configuration-seams-author-evidence-consumed/awaiting-SDK-admission-and-review`; `focused=29`, `mappedRegression=23`, `build=0`, `typecheck=0`, `publicConsumer=true`, `sdkAdmission=false`, `architectureReview=false`, `installedMvp=false` |
| public consumer raw | U2 worktree `docs/evidence/776fcad-u2-config-seams-20261004/primary-raw/public-consumer.command.json`; `public-consumer-output.jsonl` shows `endpoint.services[0] = file-search/version "1"/operations ["search"]/resources [{resourceId:"slot",capacity:1,unit:"slot"}]` |

The exact U2 producer API is `LocalServiceIntent` in `runtime/local-config.ts`; the design now references it by exact path/type, tree/blob/hash, and distinguishes it from the admitted CONFIG DESIGN in `docs/design/teams-local-config-v3.md`. The U2 source candidate remains unmerged, uninstalled, and not architecture PASS.

## r2 corrections

- P1: removed the invented duplicate `LocalServiceIntent` shape; bound the real `capabilityId`/string `version`/`operations[]`/`resources[]` projection, the `localServiceIntent()` path, the U2 tree/blob/hash, the public consumer receipt, and the U3 consumer gap in `runtime/agent-process.ts`.
- P1 ownership: adapter schema, resource sharing/allocation, executable validation, and the compiler remain under one U3 owner; U2 remains the parser/store/lock/CAS owner; runtime consumes configuration; Agent/CLI executor does not import persistence or gain a second editable source.
- P1 failure boundary: unknown adapter/version/operation/resource, duplicates, invalid capacity/unit, and incomplete browser operations fail at adapter compile before declaration publication, process start, or ledger effect. Empty/disabled services publish no capability; receiver without provider services initializes no browser executor.
- P1 consumer gap: the current old decoder does not accept daemon JSON `endpoint.services`; the exact U3 implementation obligation is the `runtime/agent-process.ts` consumer seam and its tests. No current acceptance is claimed.
- P2 tests: existing U2/focused/mapped and base regression commands are prerequisite/regression only. Future service-compile, disabled/receiver, capacity, and public-installed cases are listed as PENDING with exact test/file/driver names and expected effects; no zero-match filters, fixture discovery, mock ledger, or private-state substitution.
- Full browser usability: BB06 requires a persistent request lifecycle across `context.create -> navigate -> snapshot -> context.destroy` and capacity-holding Work. The one-shot U4 public submit cannot satisfy that. U3 standalone harness may validate its own executor/resource behavior; final installed BB06 remains blocked on the U4 persistent request lifecycle.

## Checks actually run

| Check | Actual result |
|---|---|
| `git diff --check && git diff --cached --check` | exit 0, no output |
| Markdown fences | `docs/design/teams-local-services-v1.md` has 12 fence lines (6 balanced pairs); 20261003 run notes have none |
| JSON references | `jq empty` on primary receipt and raw public/focused/mapped command JSON: `json-ok` |
| `dagpipe graph validate docs/design/dagpipe/graphs/daemon-start.graph.json` | `valid DAG: agentteams.daemon-start@1 (6 nodes, 5 edges, 6 waves)`; operator bindings syntactically present, project compile remains authoritative |
| `dagpipe graph validate docs/design/dagpipe/graphs/agent-work.graph.json` | `valid DAG: agentteams.agent-work@2 (5 nodes, 4 edges, 5 waves)`; operator bindings syntactically present, project compile remains authoritative |
| staged scope | exact allowed paths only: `docs/design/teams-local-services-v1.md`, `docs/evidence/u3-services-design-20261003/run-notes.md`, `docs/evidence/u3-services-design-20261004/run-notes.md` |

## Status and remaining prerequisites

Design status: design-ready for independent review, not product PASS. Remaining implementation prerequisites:

1. U2 source candidate must receive its required SDK admission and architecture review, then be merged by its owner before U3 implementation starts.
2. U3 must implement the exact `runtime/agent-process.ts` `endpoint.services` consumer seam and the allowlisted compiler/tests.
3. U4 must provide the persistent request lifecycle seam before final installed BB06 can be claimed.
4. PENDING service-compile, disabled/receiver, capacity, BB03, and BB06 evidence must be produced against the exact candidate before any product-completion claim.

## Primary architecture correction after r3 FAIL

2026-10-04T04:05:32Z / design-r4｜r3 controller FAIL/code_failure，两个 P1 和一个 P2 已按真实 caller 收口｜独立 review `u3-services-design-20261004-r3` 的 final/status/exit 位于本树 `.agent-collab/review/`，primary 外部 receipt 保留｜输入 tree34281060/base73eaf09｜下一步新的独立 r4 design review。

- 完整搜索 `createCliWorkExecutor(` 的实际 caller：补 `network/relay-client.spec.ts:310` 到映射、窄 allowlist 和非零真实 CLI/socket regression；现有 executor/process tests 也必须显式提供 services，无默认空数组兼容。
- receiver-only/空服务仍由唯一 compiler 构造 capability-empty WorkExecutor，满足 WorkHost 必填依赖；不初始化 browser/search adapter，不改 WorkHost 或 ledger，不造第二 executor。
- `runtime/local-config.spec.ts` 的 v3/service 前置覆盖标为 U2 source 合并后适用，当前 HEAD 旧测试不称 U2 覆盖。
- 修改仅设计正文；`git diff --check`/cached check 实际 exit0。图文件及其绑定未改变，原 B1/B2 static validation 复用；产品 tests/build/install/BB 尚未执行，不作 PASS。
