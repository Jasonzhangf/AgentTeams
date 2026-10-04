# 4b6c377 u4-persistent-design-r5-20261004 - run notes

## Scope and binding

- Worktree: `/Volumes/Intel/playground/agentteams/u4-persistent-design-r5-20261004`
- Branch: `codex/u4-persistent-design-r5-20261004`
- HEAD/base: `07006d69f574fe23dbf2df517d51e15429dd82a1`
- Mode: fresh GCM author, independent Desktop worker. Design-only correction of the
  single r4 P1. No product edits, no commit/merge/push/install, no memory writes, no
  Collab/AGY/child agents, no runtime PASS claims.
- Inherited staged input index tree before r5 edits: `c0eacaac1e1a81534f2fc08701921eb9cf019c9f`.
  The final handoff index tree is reported once in the final handoff, after these
  notes are staged, to avoid a self-referential hash field.

## Reviewer input

Read-only: `.agent-collab/review/...` was NOT added. The exact independent reviewer
findings were read from the r4 review artifact
`/Volumes/Intel/playground/agentteams/u4-persistent-design-r4-20261004/.agent-collab/review/u4-persistent-design-20261004-r5/review.final.md`.
The single P1: persistent Work observation/recovery `work query` was fixed to the
existing endpoint selection with only workId/requestId, so multiple matching
providers, an unfixed open target or a later connect change let query re-select a
provider by current config/directory and fail to reach the original provider ledger;
a capability-only provider had no endpoint query contract at all.

## Node notes

| time (UTC) | node | conclusion/state | evidence | next |
|---|---|---|---|---|
| 2026-10-04T06:12Z | read | Read AGENTS.md, the five architecture maps, both design docs, `work-query.graph.json`, the r4 run notes and reviewer findings. Read-only traced `AgentWorkClient.findProvider/open`, `WorkHost.get/request/close`, and `agent/work-resource` generation rules to avoid guessing. Confirmed `findProvider` selects by current directory and `WorkHost.get` only reads that provider's own ledger. | local read-only commands | apply r5 correction |
| 2026-10-04T06:18Z | edit-design | `teams-local-work-entry-v1.md`: r5 revision header; query CLI adds `--service-selection/--provider/--provider-generation/--link-generation/--capability-id/--capability-version/--operation` with explicit binding; typed IPC adds the capability query frame; QueryIntent/receipt identity; new §11.4 persistent-query contract (linkGeneration separate from targetGeneration); §11.7 generation rules; §11.8 map/query rows; §2/§4/§6 consistent | git diff | edit contracts |
| 2026-10-04T06:22Z | edit-contracts | `teams-behavior-contracts.md`: B8 event row, QueryIntent/WorkObservationReceipt ARC rows, B8 query contract (explicit serviceSelection; one-shot endpoint baseline unchanged; capability mode pins original provider; linkGeneration separate), resolve/observation node rows, and B8 classification row | git diff | edit maps |
| 2026-10-04T06:26Z | edit-maps | `mainline-call-map.json` `work-query-user-entry-v1`; `function-map.json` `work_graph_execution`; `resource-map.json` `work-graph-execution`; `verification-map.json` `teams-behavior-dag-topology` all state the same one query graph/runner with an explicit serviceSelection discriminator and the persistent binding, keeping all five graphs the single contract. | git diff | validate |
| 2026-10-04T06:30Z | validate | JSON parse, diff check, relative links, balanced fences and the mapped five static graph validate commands all pass (see below). Repeated the exact five-graph command used by `teams-behavior-dag-topology`. | command output | stage |

## Corrected P1 (single)

Persistent Work query now binds explicitly to the original observation target using
the same typed `serviceSelection` extension owned by `AgentWorkClient.findProvider` and
the existing `work-query` graph/runner:

- CLI, typed IPC and QueryIntent carry the original provider, original Work
  generation, capability/version and operation from the open/request control receipt.
- `serviceSelection: capability` matches the original provider capability declaration;
  it never reads Endpoint, never re-selects from mutable config/directory, and never
  falls back to another matching provider. A capability-only provider is reachable.
- The query establishes a **current authorized** link generation (`linkGeneration`)
  separate from the original Work `targetGeneration`; it never overwrites the original
  generation or promotes unknown/retained to known. Provider restart and provider
  ledger authority are explicit; `WorkHost.get` reads the provider's own ledger by
  authenticated consumer + original `workId`.
- One-shot query keeps the existing endpoint selection and its fixed operation/endpoint
  policy; the two modes are discriminated by an explicit field, not a second resolver,
  ledger, query scheduler, or graph.
- Receiver config changes never silently retarget Work observation and never grant new
  authority; request/close keep their explicit original-generation `STALE_GENERATION`
  checks. No control binding enters business payload/metadata and no truth is
  reconstructed from logs.

BB06c and BB06e now supply explicit binding; BB07 covers one-shot baseline plus
persistent capability query; new BB06g covers two-matching-providers, connect-changed
and capability-only cases, each asserting the original ledger is reached with no
propose/request/close and no resource release.

## Files changed by this r5 correction

- `docs/design/teams-local-work-entry-v1.md`
- `docs/design/teams-behavior-contracts.md`
- `docs/architecture/function-map.json`
- `docs/architecture/resource-map.json`
- `docs/architecture/mainline-call-map.json`
- `docs/architecture/verification-map.json`
- `docs/evidence/4b6c377-u4-persistent-design-r5-20261004/run-notes.md`

`docs/design/dagpipe/graphs/work-query.graph.json` was inspected and required no edit:
the query contract change is carried by typed QueryIntent control, not by graph
topology, so `work-query@1` stays unchanged.

## Validation commands (actual)

```sh
$ jq empty docs/architecture/function-map.json docs/architecture/resource-map.json \
    docs/architecture/mainline-call-map.json docs/architecture/verification-map.json
json-ok
$ git diff --check && git diff --cached --check
(rc=0)
$ grep -c '^```' docs/design/teams-local-work-entry-v1.md
20
$ dagpipe graph validate docs/design/dagpipe/graphs/agent-work.graph.json && \
  dagpipe graph validate docs/design/dagpipe/graphs/work-open.graph.json && \
  dagpipe graph validate docs/design/dagpipe/graphs/work-request.graph.json && \
  dagpipe graph validate docs/design/dagpipe/graphs/work-close.graph.json && \
  dagpipe graph validate docs/design/dagpipe/graphs/work-query.graph.json
valid DAG: agentteams.agent-work@2 (5 nodes, 4 edges, 5 waves)
valid DAG: agentteams.work-open@1 (5 nodes, 4 edges, 5 waves)
valid DAG: agentteams.work-request@1 (4 nodes, 3 edges, 4 waves)
valid DAG: agentteams.work-close@1 (3 nodes, 2 edges, 3 waves)
valid DAG: agentteams.work-query@1 (4 nodes, 3 edges, 4 waves)
```

Relative links `teams-behavior-model.md` and `../goals/teams-user-delivery-plan.md`
both resolve; markdown fences are balanced. `dagpipe graph validate` is static
topology/operator-binding validation only: it is not SDK compile, project `compile()`,
runtime, install, or product black-box evidence.

## PENDING (not claimed by this design change)

- All new product adapters/operators remain PENDING: `teams.return-held-work@1`,
  `teams.continue-provider-work@1`, `teams.close-provider-work@1` are not registered;
  `teams-work-sdk-installed` stays required and pending.
- The `AgentWorkClient.findProvider` `serviceSelection` extension and the persistent
  query binding are PENDING typed contracts; the capability query frame/receipt fields
  are PENDING implementation contract.
- Pack manifest fingerprints for `work-open@1`/`work-request@1`/`work-close@1` and
  `scripts/blackbox-user-mvp.mjs` remain future implementation obligations.
- BB06/BB07 commands were not executed; no runtime PASS is claimed.
