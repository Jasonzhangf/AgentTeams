# U5 design r2 targeted validation

Status: candidate / awaiting independent design review. This evidence covers
only the allowed design/topology/map scope; it does not claim U5 or BB09
product completion.

## Baseline and scope

- Worktree: `/Volumes/Intel/playground/agentteams/u5-console-design-20261003`
- Branch: `codex/u5-console-design-20261003`
- Actual HEAD baseline: `c3aa36fc637e2da4ac821d1b26d587eadbbf1268`
- Feature label: `b0f7f3b` (the label is not a Git object in this worktree)
- Reviewer input:
  `.agent-collab/review/u5-console-design-20261003-r1/review.final.md`
- Allowed modified/added paths:
  - `docs/design/teams-local-console-v1.md`
  - `docs/design/teams-behavior-model.md`
  - `docs/evidence/u5-console-design-20261003/**`
  - `docs/design/dagpipe/graphs/console-start.graph.json` (new)
  - `docs/design/dagpipe/graphs/console-stop.graph.json` (new)
  - `docs/design/dagpipe/graphs/console-status.graph.json` (new)
  - `docs/architecture/resource-map.json`
  - `docs/architecture/function-map.json`
  - `docs/architecture/mainline-call-map.json`
  - `docs/architecture/module-registry.json`
  - `docs/architecture/verification-map.json`
- Product code, tests, existing eight graph JSON files, goals, SDK, main,
  commit, push, install and services were not modified.

## r1 P1 closure

1. Console lifecycle graph ownership:
   - start/stop/status are three independent external object flows.
   - Each new graph has exactly one declared input ARC and one output ARC and
     is validated separately by `dagpipe graph validate`.
   - `console-stop.graph.json` contains no Work drain node and does not alter
     `daemon-start.graph.json`, `daemon-stop.graph.json` or
     `console-observe.graph.json`.
   - The U5 design/behavior model owns the Chinese semantic diagrams, typed
     nodes/effects and separate failure/cancellation/retained cleanup
     endpoints.
2. Durable ownership:
   - `[console]` remains U2 projection/config.
   - U5 lifecycle facts live in the separate `[consoleRuntime]` system table.
   - The design defines the pending U2 typed patch port, allowed fields,
     omitted/`null`/value semantics, state-combination validation, and
     reload-latest -> merge-owned-fields -> atomic-rename short-lock algorithm.
   - No external process operation is held across the internal file lock.

## Commands and results

Run from the worktree root.

```sh
git diff --check
git diff --cached --check
```

Result: PASS, no output.

```sh
dagpipe graph validate docs/design/dagpipe/graphs/console-start.graph.json
```

```text
valid DAG: agentteams.console-start@1 (5 nodes, 4 edges, 5 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
```

```sh
dagpipe graph validate docs/design/dagpipe/graphs/console-stop.graph.json
```

```text
valid DAG: agentteams.console-stop@1 (5 nodes, 4 edges, 5 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
```

```sh
dagpipe graph validate docs/design/dagpipe/graphs/console-status.graph.json
```

```text
valid DAG: agentteams.console-status@1 (5 nodes, 4 edges, 5 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
```

JSON parse check:

```sh
for f in docs/architecture/resource-map.json docs/architecture/function-map.json \
  docs/architecture/mainline-call-map.json docs/architecture/module-registry.json \
  docs/architecture/verification-map.json \
  docs/design/dagpipe/graphs/console-start.graph.json \
  docs/design/dagpipe/graphs/console-stop.graph.json \
  docs/design/dagpipe/graphs/console-status.graph.json; do jq empty "$f"; done
```

Result: PASS.

Reference check: all 50 map path/file/doc references resolve after the
repo-conventional `; ` multi-path split and `:line` suffix removal. Result:
`REF_MISSES 0`.

Markdown check: changed Markdown links/fences resolve after the
repo-conventional `:line` suffix removal. Result: `MARKDOWN_OK`.

## New graph hashes

```text
72f204a72abba29cf6983beec230e3c81d2f38f30a98c27d3ed8e880e6a1bcb1  docs/design/dagpipe/graphs/console-start.graph.json
41c3b50cbf732b6a931785db47810a4eb51b4a5c392b7e073da5ddb2fda316cb  docs/design/dagpipe/graphs/console-stop.graph.json
ca974712284e9a0acbcc0ceec907c1a7948fce2df1ebd0370e763d7c8302cf55  docs/design/dagpipe/graphs/console-status.graph.json
```

## Not run / not claimed

- No product build, typecheck, test, install, service restart, live replay,
  Camo/browser acceptance or BB09 evidence was run.
- U2 `[consoleRuntime]` schema/serializer and U5 product implementation remain
  pending; their API names in the design are proposals, not existing APIs.
- No commit, merge, push, main update or product completion is claimed.
