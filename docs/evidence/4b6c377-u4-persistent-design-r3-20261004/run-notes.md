# 4b6c377 U4 persistent design r3 - run notes

Task: `codex/u4-persistent-design-r3-20261004`
Worktree: `/Volumes/Intel/playground/agentteams/u4-persistent-design-r3-20261004`
Base HEAD: `d056b772bcce5e5adf2c45c6faf1548e756a2f84`
Base tree: `9b5b1c8e10fea9940cdc6af46217fd0df8e62f78`
Observed UTC: `2026-10-04T04:39:54Z`

## Scope

This r3 correction is docs/design only. It fixes the four primary-verified gaps from the
invalid r1 review protocol result: five-graph design admission, mandatory open/request
`business`, explicit original service binding for request/close, and a distinct PENDING
continuation contract with provider-authoritative responsibility.

Allowed staged paths:

- `docs/design/teams-local-work-entry-v1.md`
- `docs/design/dagpipe/graphs/work-open.graph.json`
- `docs/design/dagpipe/graphs/work-request.graph.json`
- `docs/design/dagpipe/graphs/work-close.graph.json`
- `docs/evidence/4b6c377-u4-persistent-design-r3-20261004/**`
- `docs/architecture/function-map.json` only the existing `work_graph_execution` entry
- `docs/architecture/verification-map.json` only the existing
  `teams-behavior-dag-topology` entry

## Node notes

| time (UTC) | node | conclusion/state | evidence | next |
|---|---|---|---|---|
| 2026-10-04T04:39Z | read | Read the staged r2 candidate, five graph artifacts, the two affected map entries, `teams-behavior-contracts.md` Work ARC rows, D3 runner `RequestProviderWork`/`business_required`, D3 `host.ts` close/failure handling, `WorkHost.close`, and U2 `connect`/`workControl` contract snippets | local read-only commands | apply r3 correction |
| 2026-10-04T04:39Z | edit | `work-request.graph.json` now binds PENDING `teams.continue-provider-work@1`; open/request `business` is mandatory including explicit `null`; request/close carry original provider, generation, capability/version, operation; close/continue responsibility is derived from provider typed reply or transport-unconfirmed, never local propose | `git diff` | validate |
| 2026-10-04T04:39Z | map-admission | `function-map.json` `work_graph_execution` lists all five design graph paths; `verification-map.json` `teams-behavior-dag-topology` validates the same five paths and explicitly leaves `teams-work-sdk-installed` and new Operator registration PENDING | `jq empty`, diff | validate |
| 2026-10-04T04:39Z | validate | The same mapped five-graph command passed: `agent-work@2`, `work-open@1`, `work-request@1`, `work-close@1`, `work-query@1` are valid static DAGs; JSON parse and `git diff --check` passed | command output below | stage exact allowlist |
| 2026-10-04T04:43Z | final-check | Re-ran the five-graph command, JSON parse, optional-payload absence check, and staged diff check after the PENDING CLI/receipt wording correction; all passed | final command output | stop |

## Validation commands (actual)

```sh
$ date -u '+%Y-%m-%dT%H:%M:%SZ'
2026-10-04T04:39:54Z

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

$ jq empty docs/architecture/function-map.json docs/architecture/verification-map.json \
  docs/design/dagpipe/graphs/work-open.graph.json \
  docs/design/dagpipe/graphs/work-request.graph.json \
  docs/design/dagpipe/graphs/work-close.graph.json
json-ok

$ git diff --check && git diff --cached --check
(rc=0)

$ rg -c '^```' docs/design/teams-local-work-entry-v1.md
20
```

`dagpipe graph validate` is static topology/operator-binding validation only. It is not
SDK compile, project `compile()`, runtime, install, or product black-box evidence.

## PENDING (not claimed by this design change)

- `teams.return-held-work@1`, `teams.continue-provider-work@1`, and
  `teams.close-provider-work@1` are not registered; `teams-work-sdk-installed` remains
  required and pending.
- `teams-behavior-contracts.md` must be updated at the implementing unit to describe the
  `work.request.link` continuation contract and close contract; this docs phase does not
  claim the new Operator exists.
- Pack manifest fingerprints for `work-open@1`, `work-request@1`, and `work-close@1` are
  future implementation obligations.
- Product tests, build, install, runner execution, and real entrypoint replay were not run
  because this task is design-only and those gates are not applicable to this allowlist.

## Primary protocol-failure consumption and design corrections

2026-10-04T05:03:46.312458+00:00 / r2 review produced no final JSON and exit1 (connection failure); no PASS. Raw log findings were independently checked. BB06b reused the wrong Work and omitted required close flags; fixed to consume all fields from its own cfgA open. Explicit pending receipt projection capabilityId/version/operation and generation propagation through host/runner ARCs added. Original target constructs immutable channel and grant admission rechecks generation; no rebind/fallback. Design only; no product or installed evidence. Complete failed review externally archived; repeat static docs checks then independent review of new exact candidate.
