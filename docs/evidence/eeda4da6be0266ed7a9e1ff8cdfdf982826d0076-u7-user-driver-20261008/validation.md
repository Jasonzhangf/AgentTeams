# U7 user-driver acceptance — round 12 candidate (v7)

This directory is the tree-bound evidence for the round-12 U7 user-driver candidate.
Every number below was produced by the primary integration owner on this exact
candidate and this exact installed package. The driver receipt in
`u7-user-driver.receipt.json` is the machine record.

It supersedes `docs/evidence/533cb7d0670a42dcd91f88345aab6555401b27e0-u7-user-driver-20261008/`,
whose BB10 case no longer covers the deterministic boundary results that the
independent round-12 review required (finding P1 in
`.agent-collab/review/u7-user-driver-20261006-r12-v6-main/review.final.md`).

## Candidate identity

| item | value |
|---|---|
| head commit | `4aeaf50465978ef724d60b9bd251a249a8a7b8f1` |
| tree | `eeda4da6be0266ed7a9e1ff8cdfdf982826d0076` |
| base commit | `4aed787041f387e090e141d276b41eab877278e6` (`origin/main`) |
| source state | `committed` |
| worktree | `/Volumes/Intel/playground/agentteams/u7-user-driver-20261006` |
| installed package | `generated/modules/teams-source/lib` |
| package mode | `final` |
| package files | 191 |
| package `content_sha256` | `da4850c281e5b09c70bf57d0da090fd24d17bf30920e8750192f118431efd49d` |

`git status --porcelain` in the candidate worktree held only the allowed untracked
`.appsdk/records/` entry. `candidate.indexed_tree_hash` equals `candidate.tree_hash`,
so the receipt binds a committed source state.

## Round-12 fixes carried by this candidate

1. **I5 — `observedAcceptedSourceHash` serialization.** `runtime/local-config.ts`
   no longer publishes an empty-string `observedAcceptedSourceHash` for an
   unaccepted provider observation; four real-TOML tests cover the case.
2. **I6G — BB09 config-interaction completion and BB10 primary/backup order.**
   BB09 now waits, inside one poll, for the refresh success notice, the re-enabled
   Refresh action, no live-region error, the selected Agent and the visible model,
   then proves the bind action is enabled before the real click. BB10 now switches
   the canonical provider to primary first and keeps the RCC binding as the
   distinct backup, preserving the `+2` accepted revision.
3. **I6H — BB09 Agent-policy refusal precondition.** An Agent that never accepted
   config has no durable accepted slice while its config view still reports
   revision 0. The refusal scenario now sends `expectedRevision: 0` explicitly and
   compares the raw durable slice presence and revision before and after, instead
   of requiring a pre-existing accepted slice.
4. **I6I — deterministic BB10 boundary coverage restored.** BB10 is again one
   installed case with two sections. The real section keeps the two-provider
   acceptance and must clean up first; a separate stub boundary fixture then runs
   four sub-scenarios inside the same case: empty-catalog explicit manual model
   selection, a stale-revision CAS refusal, a catalog-401 credential refusal, and
   no implicit failover on a provider HTTP 500. BB10 passes only when both
   sections pass, and the receipt separates `real_acceptance` from `boundary`.
5. **I6J — BB10 boundary accepted baseline and dual-source snapshots.** The
   boundary fixture first accepts the current primary/model through the public
   `config.bindModel` and then `config.apply`, so the settled baseline has a
   durable accepted slice at revision 1; `config.refreshModels` stays
   observation-only and the baseline sends no inference request. The snapshot
   helper was renamed `boundaryBindingSnapshot`, documents that its two reads are
   sequential and not atomic, and cross-checks the durable accepted revision
   against the public config revision before joining them.
6. **I6K — BB10 baseline snapshot narrowed to the accepted side.** Before `apply`
   there is no effective slice, so step 3 checks only the public accepted revision
   and the durable accepted binding; the strict dual-source helper still fails
   explicitly on the pre-apply shape and is still used at every post-apply point.

## Mapped gates on this candidate

| gate | command summary | result |
|---|---|---|
| `teams-provider-config-effective` | 8 spec files incl. `runtime/managed-config-owner`, `managed-config-live`, `managed-opencode-session`, `agent-process`, `console-config`, `local-config`, `control-protocol/console-api`, `scripts/blackbox-user-mvp` | 8 files, **151 tests passed**, exit 0 |
| `teams-console-directory-discovery` | 7 spec files incl. `console-hub`, `console-runtime`, `console-wire`, `blackbox-user-mvp`, `ui/teams-console/tests/{api,model,render}` | 7 files, **86 tests passed**, plus `pnpm typecheck`, `pnpm build:runtime`, `pnpm smoke`, exit 0 |

`pnpm verify` ran on the committed, clean candidate and exited 0 (83 test files
passed, no skipped or TODO tests).

Raw logs: `gates-build-admission.log`.

## Packaging and lifecycle admission

| step | result |
|---|---|
| `pnpm build:governance` | exit 0 |
| `pnpm lifecycle:admission` | exit 0, `{"ok":true,"candidate":"4aeaf50465978ef724d60b9bd251a249a8a7b8f1","artifact_hash":"sha256:cf66e735bdf6a48d9c2eabedad5a1429437cb5396f865227ba93571962f207f5"}` |

The package receipt was read **after** admission. It reports `mode=final`,
`source_state=committed`, head `4aeaf504…`, tree `eeda4da6…`, 191 files, and
`content_sha256 = da4850c2…`.

## Installed black-box acceptance

Both runs used the same installed package directory listed above, and the package
was not rebuilt between them.

| run | command | window | result |
|---|---|---|---|
| focused | `--case BB06,BB09,BB10` | 14:15:26 → 14:18:36 | BB06 passed, BB09 passed, BB10 passed, exit 0 |
| full | `--case all` | 14:20:47 → 14:34:56 | **BB01–BB14 all passed**, exit 0 |

Machine receipt (`u7-user-driver.receipt.json`):

```
candidate      {head_commit 4aeaf504…, base_commit 4aed7870…, tree_hash eeda4da6…,
                indexed_tree_hash eeda4da6…, source_state committed}
installed_package {content_sha256 da4850c2…, mode final, version 0.1.0}
cases          14
exit           {code 0, failed [], unverified []}
```

Focused logs: `focused/focused.log`, `focused/focused.receipt.json`.

### BB10 evidence of interest

- `cases/BB10/boundary/boundary-result.json` — `status: "passed"` with results
  `baseline`, `manual_selection`, `stale_cas`, `invalid_credential`,
  `no_implicit_failover`, plus the recorded source map for each asserted fact.
- `cases/BB10/boundary/baseline.json` — discovery at accepted revision 0 with an
  empty manual catalog, public `config.bindModel` reply `ok: true`,
  `accepted_after_bind.public.acceptedRevision: 1` with `effectiveRevision: null`
  and its reason, the durable binding, and the settled post-`apply` baseline.
- `cases/BB10/boundary/manual-selection.json` — `accepted_revision_before: 1`,
  `catalog_state: "empty"`, `model_count: 0`, `config.model.put` then manual
  `config.bindModel`, `accepted_revision_after: 3`, and
  `effective_before_restart` pinned at accepted 2 / effective 1 / original binding.
- `cases/BB10/boundary/stale-cas.json` — `stale_revision: 1`,
  `current_revision: 3`, `REVISION_CONFLICT expected=1 current=3`, and the
  unchanged post-`apply` snapshot.
- `cases/BB10/boundary/invalid-credential.json` — synthetic credential env name
  and length only (no value), `config.putProvider` accepted 3 → 4, restart at
  revision 4, catalog HTTP 401 refusal, unchanged binding and Agent row.
- `cases/BB10/boundary/no-failover.json` — new Session and successful manual
  warmup, then the manual provider HTTP 500, a new public failed final carrying
  `APIError`/`statusCode=500`, and counters read after the fixture stopped.
- `cases/BB10/boundary/cleanup.json` — `stopped: true` with the stop/status
  records and the owned PID.
- `cases/BB10/bb10-canonical-turn.json`, `cases/BB10/bb10-switch-session.json` —
  the real two-provider acceptance turns.

### BB09 evidence of interest

- `cases/BB09/browser-config-bind-preclick.json` —
  `{"selectValue":"bb-console-model","bindDisabled":false,"liveRegion":"Refresh models: accepted by Agent","liveRegionIsError":false}`.
- `cases/BB09/browser-config-before.json` accepted revision `0` →
  `cases/BB09/browser-config-after.json` accepted revision `1`.
- `cases/BB09/agent-policy-refusal/agent-policy-refusal.json` — real public command
  with `expectedRevision: 0`, HTTP `200`, `ok: false`, `error.code: FORBIDDEN`,
  `accepted_revision_before/after: null`, `accepted_slice_present_before/after: false`,
  observation source `target Agent durable internal store`.
- `cases/BB09/static-binding/` — the isolated static-binding sub-scenario ran and
  produced its own start, projection, browser and cleanup records.

## Residual gaps and out-of-scope findings

- The BB10 real section exercises the real canonical provider. If that provider is
  unavailable at run time the whole case reports `unverified` with
  `boundary.status: "not_run"`; this run did not take that branch, so no stub
  result is standing in for the real acceptance.
- Binding non-advance is proved from two sources: the target daemon durable
  accepted snapshot supplies the primary/backup references, and the public
  projection supplies revision, `applyState` and the running Agent fields. The
  public config row does not publish the binding, so the joined snapshot is a
  cross-checked pair of sequential reads, not an atomic cross-source snapshot.
- Product gaps observed while driving U7 but not fixed in this round: the default
  relay `requestTimeoutMs` is 1000 ms against a real `camo start` of roughly 4 s;
  `agentteams status` prints capabilities comma-separated; a second `config.apply`
  against a live managed OpenCode child fails and is masked as
  `config: owner fence record already exists`. These are recorded as findings, not
  as accepted behaviour.

## Scope statement

This evidence covers the source-level and installed-black-box acceptance of the
round-12 candidate. It does not replace the independent architecture review, the
milestone review, or the phase-memory closeout for the round.
