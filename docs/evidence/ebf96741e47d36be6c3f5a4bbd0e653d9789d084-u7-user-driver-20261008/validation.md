# U7 user-driver acceptance — round-12 candidate (v8)

This directory is the tree-bound evidence for the round-12 U7 user-driver candidate
after the fixes that closed the round-12 milestone review findings. Every number
below was produced by the primary integration owner on this exact candidate and
this exact installed package. `u7-user-driver.receipt.json` is the machine record.

It supersedes `docs/evidence/eeda4da6be0266ed7a9e1ff8cdfdf982826d0076-u7-user-driver-20261008/`,
whose BB07, BB10 and BB13 coverage no longer meets the independent round-12
milestone review (`teams-local-mvp-milestone-20261008-r12-v7-r1`, 4 findings).

## Candidate identity

| item | value |
|---|---|
| head commit | `3bb440df74e5cf61d95b95de01eb633bf0854b34` |
| tree | `ebf96741e47d36be6c3f5a4bbd0e653d9789d084` |
| base commit | `ef37e52d6b54c2f1c08c3387aa5fe4f7b2280837` (`origin/main`) |
| source state | `committed` |
| worktree | `/Volumes/Intel/playground/agentteams/u7-user-driver-20261006` |
| installed package | `generated/modules/teams-source/lib` |
| package mode | `final` |
| package files | 191 |
| package `content_sha256` | `5442d61ac6eb6d44658067ba946bb7d569c6b9c6ee508fc77d46bac5866596a2` |

`git status --porcelain` in the candidate worktree held only the allowed untracked
`.appsdk/records/` entry. The package receipt records `indexed_tree_hash` equal to
`tree_hash`, so the receipt binds a committed source state.

## Round-12 fixes carried by this candidate

The four findings of the independent milestone review
(`.agent-collab/review/teams-local-mvp-milestone-20261008-r12-v7-r1/review.final.md`)
are closed as follows.

1. **P1-1 — BB07 never interrupted an in-flight execution.** `scripts/blackbox-user-mvp.mjs`
   now carries a second BB07 sub-scenario. It holds the real search process with
   `SIGSTOP`, sends `SIGTERM` to the exact provider PID from `internal.toml`, then
   releases the still-active real `rg` PID with `SIGTERM`+`SIGCONT`. The evidence
   records the provider PID, generation, start token, entry path and projection
   path, the wrapper and real PIDs with their parent chain, the pre-release process
   state, the original CLI terminal result, the provider ledger terminal state and
   the allocation release, then a restart and a read-only recovery query.
2. **P1-2 — BB13's graph change was vacuous.** BB13 now reorders the nodes of the
   real Work graph `docs/design/dagpipe/graphs/work-request.graph.json` with node
   ids, operators, versions, ARCs, selectors and the edge list unchanged, and
   asserts per-invocation deltas instead of a cumulative history.
3. **P1-3 — BB10's binding evidence was private.** `control-protocol/console-api.ts`
   and `control-protocol/console-wire.ts` project `acceptedBinding`
   (`null`, or `{primary, backup?}` of `{providerInstanceId, modelId}`) from the
   same accepted config view as `acceptedRevision`; `runtime/console-config.ts`
   reads the store once and fails explicitly as `UNAVAILABLE` when a present
   accepted revision has no binding. BB10 reads the binding back through the public
   projection.
4. **P1-4 — the declared protocol was not projected.** `bb10ProtocolFromSource`
   maps the declared provider type, and the canonical Session config text uses the
   projected protocol instead of a hard-coded `openai-chat`.

Four further defects were found by the primary's own installed replay while
closing the above, and are fixed in this candidate:

5. `parseInternal` required `projectionPath` on the relay record, but the relay
   projection lives under `internal.relay`, not `internal.daemon.relay`; the
   requirement is now scoped to the provider record actually used for the PID
   ownership check.
6. BB13's `expectExecuted` required an invalidation record in the failure-recovery
   phase, where the previous stage status is `blocked` and the lifecycle adapter
   writes no invalidation. The requirement is now an explicit parameter: the five
   passed/reused phases keep it, and the recovery phase still requires a fresh
   receipt and no reuse.
7. BB13's `runPhase` shadowed the outer lifecycle store, so the evidence-delete
   phase read the state from before the deterministic failure.
8. BB07 read the provider ledger once after the consumer CLI settled, which races
   the provider drain; it now waits, bounded at 20 s, for the real terminal state
   (request `failed` and its allocation `released`) and fails with the last
   observation if that state never appears.

## Acceptance run

One `--case all` run of `scripts/blackbox-user-mvp.mjs` against the frozen package:
**BB01–BB14 all passed**, `exit_code: 0`, `failed: []`, `unverified: []`,
20:13:28 → 20:27:43. `--list` reports 14 cases, so the case count did not change.

| case | files | case | files |
|---|---|---|---|
| BB01 | 9 | BB08 | 17 |
| BB02 | 8 | BB09 | 114 |
| BB03 | 27 | BB10 | 80 |
| BB04 | 12 | BB11 | 14 |
| BB05 | 17 | BB12 | 13 |
| BB06 | 29 | BB13 | 13 |
| BB07 | 16 | BB14 | 11 |

The BB07 execution-failure sub-scenario writes its own record directory
`cases/BB07-execution-failure/` (14 files). It is a sub-scenario of case BB07, not
a fifteenth case: the receipt lists 14 cases and `--list` prints 14.

## Evidence of interest

| item | observation |
|---|---|
| BB07 real in-flight failure | original CLI `status: 1`; provider ledger request `state: failed` with `allocation-35113ec9-…`; recovery query is a new execution/attempt with `requestState: failed`, `observed: true`, `hostOperations: [agentWork.findProvider, agentWork.open, agentWork.get, agentWork.dispose]` and no request operation; restart generation advanced; no owned PID alive after stop; temporary root removed |
| BB09 installed browser | real Camo profile, static-binding sub-scenario, Agent-policy refusal, credential-free Console navigation, Console cleanup |
| BB10 real section | installed package identity equals the frozen package hash; a real RCC dispatch completes, the canonical binding is explicitly switched, and the original binding is retained as the distinct backup; restart, `config.apply` and a real canonical Session turn read back the same primary/backup |
| BB10 boundary section | empty catalog with an explicit manual model selection, stale-revision CAS refusal, catalog-401 credential refusal and no implicit failover; the baseline accepted binding is read from the public `acceptedBinding` projection, and the receipt separates `real_acceptance` from `boundary` |
| BB13 per-invocation deltas | failure → recovery (`verify` reused, `smoke` executed) → idempotent entry (nothing) → re-entry (two reuses) → source change, real graph reorder and config change (each `+1 verify`, `+1 smoke`) → artifact change → deleted smoke evidence (`verify` reused, `smoke` executed) |

## Mapped gates on this candidate

| gate | command summary | result |
|---|---|---|
| `teams-provider-config-effective` | 8 spec files incl. `runtime/managed-config-owner`, `managed-config-live`, `managed-opencode-session`, `agent-process`, `console-config`, `local-config`, `control-protocol/console-api`, `scripts/blackbox-user-mvp` | 8 files, **154 tests passed**, exit 0 |
| `teams-console-directory-discovery` | 7 spec files incl. `console-hub`, `console-runtime`, `console-wire`, `blackbox-user-mvp`, `ui/teams-console/tests/{api,model,render}` | 7 files, **90 tests passed**, plus `pnpm typecheck`, `pnpm build:runtime`, `pnpm smoke`, exit 0 |
| `teams-agent-work-capacity` / DAGpipe Work | `runtime/dagpipe-work.spec.ts`, `ui/teams-console/tests/contract-compat.spec.ts` | 26 tests passed, exit 0 |

`pnpm verify` ran on the committed, clean candidate and exited 0 (83 test files
passed, no skipped or TODO tests). Raw logs: `gates-build-admission.log`.

## Packaging and lifecycle admission

`pnpm lifecycle:admission` ran on the same clean candidate and exited 0:
attempt `attempt-1791513055195-2e60c83d-6027-4869-8bb4-114b8d71dd5f`, candidate
`3bb440df74e5cf61d95b95de01eb633bf0854b34`, `artifact_hash`
`sha256:fe7fc48ad0f16ab1bf888b5e0145a4401c590f08bddab4ef7c0bbd04aadabb75`.

The `pnpm smoke:installed` stage builds the final package
(`pnpm smoke:installed` = `pnpm build:governance && …`), so the ordering used here
is `pnpm verify` → `pnpm lifecycle:admission` → acceptance run on the resulting
package, with no further build afterwards. `package-receipt.json` is that package
receipt, and the acceptance receipt in `u7-user-driver.receipt.json` records the
same `content_sha256`. The package content hash covers the packaged DAGpipe runner
binary, whose embedded build directory changes on every rebuild, so a rebuild
would change the hash without changing product source; the acceptance run was
therefore performed after the last build.

## Transient provider timeout and retry

The first acceptance attempt on this package (19:47 → 20:01) failed BB10 with
`The operation was aborted due to timeout` after `session.create` and the session
open succeeded. The RCC endpoint answered `/v1/models` with HTTP 200 in 2.8 ms at
that moment, and the same single case passed alone at 20:07:49 → 20:10:40. The
120 s dispatch boundary is the contract value and was not changed. The full
`--case all` run was then repeated on the same package and candidate and passed
all 14 cases. Raw records: `retries/`.

## Companion records

| path | content |
|---|---|
| `u7-user-driver.receipt.json` | machine receipt for the `--case all` run (candidate identity, installed package hash, per-case status, exit summary) |
| `package-receipt.json` | frozen `final` package receipt read after lifecycle admission |
| `run.log` | `--case all` stdout and window |
| `gates-build-admission.log` | mapped gates, `pnpm verify`, `pnpm build:governance` and `pnpm lifecycle:admission` |
| `focused/` | focused replays that verified individual driver fixes before the final run: the BB07 execution-failure case on this candidate and the four-case replay on the previous candidate |
| `retries/` | the transient BB10 timeout receipt, its log, and the successful single-case probe |
| `evidence-index.md` | per-case file index |

## Open items

- This candidate does not change the product version; no version promotion was
  performed in this round.
- The `docs/architecture/verification-map.json` gate statuses stay `partial`. The
  installed acceptance above is evidence for the behaviour those gates cover; the
  remaining pending scope of each gate is listed in its own `checks`.
