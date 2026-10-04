# 4e04166 Relay admitted-link lifetime implementation

- 2026-10-04 / baseline | inherited design patch is staged; HEAD and base
  are `47e14005ab61b9ce53cc7f4ab8987ac47c6aae33`; indexed source tree is
  `70b94b09076f7085b3b8b708e2d76d41677dd6fb`, matching the independent design
  review r2 PASS source tree. Own implementation paths are clean.
  | `git status --short --branch`, `git rev-parse HEAD`, `git write-tree`;
  design review receipt
  `/Volumes/Intel/playground/agentteams/4e04166-relay-lifetime-design-20261004/.agent-collab/review/4e04166-relay-lifetime-design-20261004-r2/`
  | node 22.22.2, external playground worktree | establish red public WSS proof.
- 2026-10-04 / scope | owner is `RelayServer` in `server/relay.ts`;
  existing `grants` map plus `sourceData/targetData.opened` flags remain the only
  lifetime truth. Pending expiry and opened-pair revocation remain separate
  transitions. No new registry, RPC, TTL extension, replay, or config field.
  | `docs/design/teams-relay-link-lifetime.md`,
  `docs/design/dagpipe/graphs/relay-link.graph.json`,
  `server/relay.ts` | inherited design PASS | write red test, then minimal
  source fix and focused public behavior checks.
- 2026-10-04 / red | changed only the existing opened-expiry regression
  to require both-direction opaque delivery after the admission deadline. The
  real TLS/WSS test times out against unchanged `server/relay.ts` because
  `forwardData` closes the grant at the old deadline. Exit 1.
  | `red-opened-after-deadline.log`,
  `red-opened-after-deadline.exit` in
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/4e04166-relay-lifetime-impl-20261004/`
  | node 22.22.2, vitest 4.1.11, base source tree
  `70b94b09076f7085b3b8b708e2d76d41677dd6fb` | apply minimal owner fix.
- 2026-10-04 / green | `grantOpened` reuses the two socket `opened`
  flags. Pair completion clears the admission timer; `forwardData`,
  `purgeExpiredGrants`, and a queued `expireGrant` leave opened pairs alone.
  Pending/half-open deadline checks and every existing revocation path remain.
  The focused delayed public test passes. | `green-opened-after-deadline.log`,
  `green-opened-after-deadline.exit` | same candidate | run full Relay public
  regression.
- 2026-10-04 / verify | `server/relay.spec.ts` passes 20/20. New checks
  cover half-open deadline rejection plus capacity reclaim, duplicate and
  cross-scope/stale data opens, opened-pair generation replacement, data
  disconnect capacity release, and opened links after the deadline. Existing
  pending expiry, maxGrants, backpressure, and no-control-JSON checks remain.
  | `relay-spec.log`, `relay-spec.exit` | node 22.22.2, vitest 4.1.11 |
  run mapped focused tests, typecheck, build, graph gate, AppSDK and smoke.
- 2026-10-04 / docs | service contract, Relay process documentation and
  the five existing server-owned map entries now bind the admitted model and
  its public behavior. No U4 or shared-map entry was changed.
  | `docs/design/teams-service-contracts-r1.md`, `server/relay-process.md`,
  `docs/architecture/*.json`, `docs/design/teams-relay-link-lifetime.md` |
  current implementation candidate | validate generated governance.
- 2026-10-04 / verify | focused Relay suite passed 3 files / 47 tests;
  `pnpm typecheck`, `pnpm build`, `dagpipe graph validate` + `inspect`,
  `appsdk guide compile`, `appsdk compile`, `pnpm smoke`, and
  `pnpm smoke:installed` all exited 0. An initial AppsSDK compile failed only
  because the owned product changes were unstaged; the original failure and its
  exit are retained as `appsdk-compile-unstaged-failure.*`, and the staged
  retry passed. | receipts `focused-relay.*`, `typecheck.*`, `build.*`,
  `graph-gate.*`, `appsdk-guide-compile.*`, `appsdk-compile.*`, `smoke.*`,
  `smoke-installed.*` | staged candidate tree
  `77b527681936a735a72d496bd0efa8c18cb99b01`, base/HEAD
  `47e14005ab61b9ce53cc7f4ab8987ac47c6aae33` | run mapped regression,
  enumerate any suite failure, and freeze hashes.
- 2026-10-04 / regression | first `pnpm test` attempt exited 1 because
  one unstaged design-document correction made the package-install suite reject
  the live candidate identity; all 512 executed tests passed and only that
  suite's 16 tests were skipped. After staging the owned correction, `pnpm test`
  passed: 79 test files, 528 tests, no skipped tests. |
  `full-test.log`, `full-test.exit`; `generated/validation/regression.json` |
  node 22.22.2, current staged tree | freeze final source hashes and hand off
  to the primary.
- 2026-10-04 / candidate | the final working/indexed tree is frozen in
  the external receipt `freeze-tree.txt` after the last evidence note edit, so
  the source note itself never creates a self-referential tree hash.
  Changed source hashes:

```text
a88da66904a9ca1b4f8e74b59382473eee270d2ae8963ea71738426644218d4e  server/relay.ts
aa975ef71e9a2a6806f953a4ff05ff343357e196c95ea5a661e2454fd67c1d98  server/relay.spec.ts
2fa2bee773ae1824bdfdcae9b13612ed89fdda42f2ce372abf129d352df0406e  docs/design/teams-service-contracts-r1.md
62b240ede284e551756639e456b9bf0d8e4dedda1b3c95a5303467c78e5a06f7  server/relay-process.md
49ba7168d99b267f264faea3b7ab78ff43ffc6dbc11a959ecaa202eafbd3d0ec  docs/design/teams-relay-link-lifetime.md
9c3db07645748ea27c5b9da19549617e649e572376952a8972635429c7a5b586  docs/design/dagpipe/graphs/relay-link.graph.json
e947afdf543cc525253a5413ebfb026ff292f4e9e4f2daec2ade4aecb0568f4b  docs/architecture/function-map.json
fa0708654ef7889824affb6148d3582fdd4c90042a9aa3cfe1e9037759085d1a  docs/architecture/mainline-call-map.json
df4a51c5fe1c782da5d9eb7d87c5ba27084bc79fb2eac1b53cf6834a834997a9  docs/architecture/module-registry.json
add2b96e84e26a780b30a258bdf995c95cfcbbf858dcf0e5bed20584e77b84b9  docs/architecture/resource-map.json
06133e0680634bf185ab04d800ce6515d180c681e1c01b7e6c96272f4fb06033  docs/architecture/verification-map.json
```

  Evidence receipts are at
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/4e04166-relay-lifetime-impl-20261004/`.
  No network, client, runtime, config, CLI, package, lifecycle, U3, U4 or SDK
  source changed. No shared service, foreign worktree, process, temporary file
  or generated evidence was removed. Final stop: handoff retained for primary
  architecture review, commit, integration, push, memory and source cleanup.

- 2026-10-04 / primary handoff | the author's time-of-day labels were ahead
  of the actual host UTC clock and are removed. Original notes remain in
  `author-notes-original.md` beside the raw event stream. The date, source
  hashes and observed test results are retained. Author final source tree is
  `0f7df9a1557af15adeac24f380d2a3d367a81d32`; this correction changes notes
  only. Current exact candidate, bounded test reuse and refreshed public
  compiled/installed receipts are at
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/4e04166-relay-lifetime-impl-20261004/primary-candidate-receipt.json`.
  Dynamic results are written there after this source freeze. Design PASS and
  author public behavior are separate from implementation review/integration,
  which remain pending. Full U3 browser/U4/installed user MVP is not claimed.

- 2026-10-04 / implementation review r1 FAIL | the prior implementation
  candidate failed independent review with P1 finding at `server/relay.ts:546`:
  an opened pair was still checked against the admission deadline before
  duplicate/participant guards, so a later duplicate or cross-scope
  `relay.open` could close the live pair. Historical result:
  `review.final.md` plus `status.json` (`verdict: fail`, `blocking_findings`) at
  `/Volumes/Intel/playground/agentteams/4e04166-relay-lifetime-impl-20261004/.agent-collab/review/4e04166-relay-lifetime-impl-20261004-r1/`.
  | base `47e14005ab61b9ce53cc7f4ab8987ac47c6aae33` | fix the single expiry
  guard after a public red test.
- 2026-10-04 / duplicate-open fix | the public TLS/WSS regression proves the
  old guard closes the original pair, then proves the guarded code returns
  CONFLICT for a duplicate source open and FORBIDDEN for an invalid participant
  while the original pair remains open and forwards both directions. Raw red
  and green logs are in the current receipt directory. The only product change
  is `!grantOpened(stored)` on the existing admission-deadline condition.
  | `red-duplicate-cross-scope.*`, `green-duplicate-cross-scope.*` in
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/4e04166-relay-duplicate-open-20261004/`
  | current worktree | run focused Relay/network, typecheck, build, graph, SDK
  compile, smoke, installed smoke, and freeze.
- 2026-10-04 / current candidate pointer | the stable exact current receipt is
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/4e04166-relay-duplicate-open-20261004/candidate-receipt.json`.
  This stage owns only `server/relay.ts`, `server/relay.spec.ts`, and this note
  file. The note does not freeze its own tree hash. Primary retains independent
  review, commit, integration, push, memory, and source cleanup.
